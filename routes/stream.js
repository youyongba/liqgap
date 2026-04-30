'use strict';

/**
 * 流式 / 实时端点 (Streaming / real-time endpoints)
 *
 *   GET /api/stream/status   → 当前所有 WS hub 的健康状态（调试用）
 *   GET /api/stream/sse      → Server-Sent Events 实时推送
 *
 * SSE 事件 (Event types):
 *   - snapshot : 首次连接时一次性发送完整快照
 *                  { symbol, market, interval, depth,
 *                    klines: [...], book: {bids, asks, lastUpdateId},
 *                    aggTrades: [...] }
 *   - kline    : K 线增量推送（每秒可能多次，包括正在形成中的最后一根）
 *                  { interval, candle: {openTime, open, high, low, close,
 *                    volume, takerBuyBase, isFinal, ...} }
 *   - book     : 订单簿增量推送，已在服务端做 100ms 节流
 *                  { bids, asks, lastUpdateId }
 *   - trade    : 聚合成交逐笔推送 (aggTrade)
 *                  { a, p, q, T, m, ... }
 *   - error    : 不可恢复错误（连接初始化失败时）
 *   - 注释行 ": ping\n\n" 每 15s 一次用作 keep-alive
 */

const express = require('express');
const { getStreamStatus } = require('../services/binanceLive');
const { getHub } = require('../services/binanceStream');

const router = express.Router();

router.get('/stream/status', (_req, res) => {
  try {
    const hubs = getStreamStatus();
    res.json({
      success: true,
      data: { hubCount: hubs.length, now: Date.now(), hubs }
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// 订单簿 SSE 推送的节流窗口 (ms)。订单簿事件可能 5-10 Hz，10 Hz 推 200 档
// 单连接上行 ~100 KB/s，对 1-2 个客户端没问题；但开浏览器同时 10 个 tab
// 就会过载。所以默认 100ms 节流，最多 10 fps。
const BOOK_THROTTLE_MS = 100;

router.get('/stream/sse', async (req, res) => {
  const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
  const market = req.query.market === 'spot' ? 'spot' : 'futures';
  const interval = String(req.query.interval || '1h');
  const klineLimit = Math.min(Math.max(Number(req.query.limit) || 200, 10), 1500);
  const maxDepth = market === 'spot' ? 5000 : 1000;
  const depth = Math.min(Math.max(Number(req.query.depth) || 50, 5), maxDepth);
  // Binance REST aggTrades 限定 ≤1000；缓存 buffer 可更多但 seed 不能超
  const aggLimit = Math.min(Math.max(Number(req.query.aggLimit) || 200, 1), 1000);

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // nginx / 反代场景下禁缓冲
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const hub = getHub(symbol, market);

  function send(eventName, payload) {
    if (res.writableEnded) return;
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
  function sendComment(text) {
    if (res.writableEnded) return;
    res.write(`: ${text}\n\n`);
  }

  // 1) 触发订阅 + seed 三类缓存
  let initialKlines, initialBook, initialAgg;
  try {
    [initialKlines, initialBook, initialAgg] = await Promise.all([
      hub.getKlines(interval, klineLimit),
      hub.getOrderBook(depth),
      hub.getAggTrades(aggLimit)
    ]);
  } catch (err) {
    send('error', { message: 'init failed: ' + err.message });
    res.end();
    return;
  }

  // 2) 首次推送完整 snapshot
  send('snapshot', {
    symbol,
    market,
    interval,
    depth,
    klineLimit,
    aggLimit,
    klines: initialKlines,
    book: {
      bids: initialBook.bids.slice(0, depth),
      asks: initialBook.asks.slice(0, depth),
      lastUpdateId: initialBook.lastUpdateId
    },
    aggTrades: initialAgg
  });

  // 3) 注册事件监听
  let bookTimer = null;
  let bookDirty = false;

  const onKline = (evt) => {
    if (evt.interval !== interval) return; // 这条 SSE 只关心当前 interval
    send('kline', evt);
  };
  const onBook = () => {
    bookDirty = true;
    if (bookTimer) return;
    bookTimer = setTimeout(async () => {
      bookTimer = null;
      if (!bookDirty) return;
      bookDirty = false;
      try {
        const book = await hub.getOrderBook(depth);
        send('book', {
          bids: book.bids.slice(0, depth),
          asks: book.asks.slice(0, depth),
          lastUpdateId: book.lastUpdateId
        });
      } catch (_) { /* swallow; next event will retry */ }
    }, BOOK_THROTTLE_MS);
  };
  const onTrade = (t) => {
    send('trade', t);
  };

  hub.on('kline', onKline);
  hub.on('book', onBook);
  hub.on('trade', onTrade);

  // 4) keep-alive ping (15s)，避免反代 / 浏览器关掉空闲连接
  const pingTimer = setInterval(() => sendComment('ping ' + Date.now()), 15_000);

  // 5) 客户端断开 / server.end → 清理
  function cleanup() {
    clearInterval(pingTimer);
    if (bookTimer) { clearTimeout(bookTimer); bookTimer = null; }
    hub.off('kline', onKline);
    hub.off('book', onBook);
    hub.off('trade', onTrade);
    if (!res.writableEnded) res.end();
  }
  req.on('close', cleanup);
  req.on('error', cleanup);
});

module.exports = router;
