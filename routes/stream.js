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
const { getRateLimitState } = require('../services/binance');

const router = express.Router();

router.get('/stream/status', (_req, res) => {
  try {
    const hubs = getStreamStatus();
    res.json({
      success: true,
      data: {
        hubCount: hubs.length,
        now: Date.now(),
        hubs,
        rateLimit: getRateLimitState()
      }
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// 订单簿 SSE 推送的节流窗口 (ms)。订单簿事件可能 5-10 Hz，10 Hz 推 200 档
// 单连接上行 ~100 KB/s，对 1-2 个客户端没问题；但开浏览器同时 10 个 tab
// 就会过载。所以默认 100ms 节流，最多 10 fps。
const BOOK_THROTTLE_MS = 100;

// 起始 padding 大小：某些反代 / CDN 在缓冲区填满前不会向客户端 flush
// 第一次响应 chunk。塞满 ~2KB 注释行可以强制立即 flush headers + 首条事件。
// (Force CDN/proxy to flush right away by sending ~2KB of comment padding.)
const INIT_PADDING_BYTES = 2048;
const PADDING_LINE = ': ' + 'x'.repeat(INIT_PADDING_BYTES) + '\n\n';

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

  // 立即写入一段 padding 注释，强制反代 / 浏览器把首字节推给客户端，
  // 否则一些代理会等到 buffer 填满（4-8KB）才向下游 flush，
  // 导致 snapshot 之后的每条小事件长时间卡在中间层。
  res.write(PADDING_LINE);
  if (typeof res.flush === 'function') {
    try { res.flush(); } catch (_) { /* noop */ }
  }

  const hub = getHub(symbol, market);
  const connStartedAt = Date.now();
  const connTag = `[sse ${symbol}/${market}/${interval}]`;
  // eslint-disable-next-line no-console
  console.info(`${connTag} open · klineLimit=${klineLimit} depth=${depth} aggLimit=${aggLimit}`);

  function flushSafe() {
    if (typeof res.flush === 'function') {
      try { res.flush(); } catch (_) { /* noop */ }
    }
  }
  function send(eventName, payload) {
    if (res.writableEnded) return;
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    flushSafe();
  }
  function sendComment(text) {
    if (res.writableEnded) return;
    res.write(`: ${text}\n\n`);
    flushSafe();
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
  let klineCount = 0;
  let bookCount = 0;
  let firstKlineLogged = false;

  const onKline = (evt) => {
    if (evt.interval !== interval) return; // 这条 SSE 只关心当前 interval
    klineCount += 1;
    if (!firstKlineLogged) {
      firstKlineLogged = true;
      // eslint-disable-next-line no-console
      console.info(`${connTag} first kline pushed @ ${Date.now() - connStartedAt}ms after connect`);
    }
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
        bookCount += 1;
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

  // 4) keep-alive ping (10s)，避免反代 / 浏览器关掉空闲连接
  // 同时附带轻量统计，浏览器通过 EventSource 默认忽略注释行，但日志可通过
  // server-side console / 网络抓包看到。
  const pingTimer = setInterval(() => {
    sendComment(`ping t=${Date.now()} k=${klineCount} b=${bookCount}`);
  }, 10_000);

  // 5) 客户端断开 / server.end → 清理
  function cleanup() {
    clearInterval(pingTimer);
    if (bookTimer) { clearTimeout(bookTimer); bookTimer = null; }
    hub.off('kline', onKline);
    hub.off('book', onBook);
    hub.off('trade', onTrade);
    // eslint-disable-next-line no-console
    console.info(
      `${connTag} close · uptime=${Date.now() - connStartedAt}ms `
      + `klineEvents=${klineCount} bookEvents=${bookCount}`
    );
    if (!res.writableEnded) res.end();
  }
  req.on('close', cleanup);
  req.on('error', cleanup);
});

module.exports = router;
