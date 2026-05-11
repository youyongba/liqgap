'use strict';

/**
 * GET /api/liquidations/heatmap
 *
 * 清算热力图 (Liquidation Heatmap) 数据接口。
 * 把 [from, to] 时间窗内 Binance Futures 的强平推送，按 (时间桶, 价格桶)
 * 聚合成 2D 矩阵，分 long / short 两个矩阵返回。每格存"该桶内累计 USDT
 * 名义额"——累加而不是峰值，因为这里看的是"该价位被洗了多少筹码"。
 *
 * 查询参数 (Query):
 *   symbol      默认 'BTCUSDT'
 *   market      'futures'，目前只支持合约（spot 无杠杆故无强平）
 *   from, to    毫秒时间戳。默认 to=now, from=now-1h。
 *   bucketMs    时间桶宽（毫秒）。默认 60_000；范围 [60_000, 3_600_000]。
 *   priceBucket 价格桶宽（USDT）。默认按 mid 自适应（约 mid * 0.0002 圆整）。
 *   priceRange  价格上下窗（小数比例）。默认 'auto' = 用强平事件实际价差。
 *
 * 响应 (Response):
 *   { success:true, data: {
 *       symbol, market,
 *       fromMs, toMs, bucketMs, priceBucket, priceRange, autoRange,
 *       midPrice, priceMin, priceMax,
 *       times:[T], prices:[P],
 *       longMatrix:[T][P]  (USDT, long 被强平),
 *       shortMatrix:[T][P] (USDT, short 被强平),
 *       maxValue, p50, p95,
 *       totalLong, totalShort, eventCount,
 *       generatedAt, empty, reason?
 *   }}
 *
 * 数据回放窗口受 liqRecorder 保留时长限制（默认 25h）。
 */

const express = require('express');
const recorder = require('../services/liquidationRecorder');
const { BinanceService } = require('../services/binance');
const { normalizeKlines } = require('../indicators/klineIndicators');

const router = express.Router();
const ONE_HOUR_MS = 3600_000;
const ONE_MIN_MS = 60_000;

// 根据回放窗口宽度选 K 线粒度（与 predictiveLiquidations 保持一致的体感）
function _chooseCandleInterval(spanMs) {
  if (spanMs <=       ONE_HOUR_MS) return { interval: '1m',  ms: ONE_MIN_MS };
  if (spanMs <=   4 * ONE_HOUR_MS) return { interval: '1m',  ms: ONE_MIN_MS };
  if (spanMs <=  12 * ONE_HOUR_MS) return { interval: '5m',  ms: 5 * ONE_MIN_MS };
  if (spanMs <=  24 * ONE_HOUR_MS) return { interval: '5m',  ms: 5 * ONE_MIN_MS };
  if (spanMs <=  48 * ONE_HOUR_MS) return { interval: '5m',  ms: 5 * ONE_MIN_MS };
  if (spanMs <=  72 * ONE_HOUR_MS) return { interval: '15m', ms: 15 * ONE_MIN_MS };
  if (spanMs <=   7 * 24 * ONE_HOUR_MS) return { interval: '15m', ms: 15 * ONE_MIN_MS };
  if (spanMs <=  14 * 24 * ONE_HOUR_MS) return { interval: '30m', ms: 30 * ONE_MIN_MS };
  if (spanMs <=  21 * 24 * ONE_HOUR_MS) return { interval: '1h',  ms: 60 * ONE_MIN_MS };
  return                                       { interval: '1h',  ms: 60 * ONE_MIN_MS };
}

router.get('/liquidations/heatmap', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || 'BTCUSDT').toUpperCase();
    const market = req.query.market === 'spot' ? 'spot' : 'futures';

    const now = Date.now();
    let toMs = Number(req.query.to);
    if (!Number.isFinite(toMs) || toMs <= 0) toMs = now;
    let fromMs = Number(req.query.from);
    if (!Number.isFinite(fromMs) || fromMs <= 0) fromMs = toMs - ONE_HOUR_MS;
    if (toMs <= fromMs) {
      return res.status(400).json({ success: false, error: 'to must be > from' });
    }

    let bucketMs = Number(req.query.bucketMs);
    if (!Number.isFinite(bucketMs) || bucketMs < 60_000) bucketMs = 60_000;
    if (bucketMs > ONE_HOUR_MS) bucketMs = ONE_HOUR_MS;

    const MAX_T_BUCKETS = 600;
    let tCount = Math.ceil((toMs - fromMs) / bucketMs);
    if (tCount > MAX_T_BUCKETS) {
      bucketMs = Math.ceil((toMs - fromMs) / MAX_T_BUCKETS / 60_000) * 60_000;
      tCount = Math.ceil((toMs - fromMs) / bucketMs);
    }

    const events = recorder.findRange(symbol, market, fromMs, toMs);

    // 中价：取当前价（强平价格分布通常围绕当前价）
    let midPrice = NaN;
    try { midPrice = await BinanceService.getCurrentPrice(symbol, market); }
    catch (_) { midPrice = NaN; }
    if (!Number.isFinite(midPrice) && events.length > 0) {
      // 退化用最近一条强平价
      midPrice = Number(events[events.length - 1].price);
    }

    if (!Number.isFinite(midPrice) || midPrice <= 0 || events.length === 0) {
      // 把 recorder 真实状态告诉前端，方便用户判断"是没数据还是录盘没起来"
      let recStatus = null;
      try {
        const s = recorder.getStatus();
        const memBuf = (s.memBuffers || {})[symbol] || {};
        recStatus = {
          started: !!s.started,
          uptimeMs: s.uptimeMs || 0,
          subscribeOk: !!s.subscribeOk,
          subscribeError: s.subscribeError,
          subscribeAttempts: s.subscribeAttempts || 0,
          totalEventsSinceStart: s.totalEventsSinceStart || 0,
          totalMemEvents: memBuf.memCount || 0,
          totalFiles: (s.files || []).length,
          latestEvent: memBuf.latest || null,
          msSinceLastEvent: s.msSinceLastEvent
        };
      } catch (_) { /* noop */ }
      const reason = (() => {
        if (events.length !== 0) return '价格无法确定 / mid price unknown';
        if (!recStatus) return '该窗口内尚无强平事件（recorder 状态不可用）';
        const upMin = Math.floor((recStatus.uptimeMs || 0) / 60_000);
        if (!recStatus.started) return '录盘未启动 / recorder not started · 检查 server 启动日志';
        if (!recStatus.subscribeOk) {
          return `订阅失败 / Subscribe failed (尝试 ${recStatus.subscribeAttempts} 次): `
            + `${recStatus.subscribeError || 'unknown'} · 30s 后会自动重试`;
        }
        // 订阅成功但本 symbol 无事件
        const total = recStatus.totalEventsSinceStart;
        if (total === 0) {
          return `该窗口内尚无强平事件 — 录盘运行 ${upMin} 分钟，全市场已收 0 条 ` 
            + `(可能 Binance 全市场都很平静，或网络中断) · 建议先切 "预测 / Predicted"`;
        }
        return `该窗口内 ${symbol} 无强平 — 录盘运行 ${upMin} 分钟，全市场已收 ${total} 条 `
          + `(${symbol} 单 symbol 在该窗口内未触发强平) · 建议先切 "预测 / Predicted"`;
      })();
      return res.json({
        success: true,
        data: {
          symbol, market,
          fromMs, toMs, bucketMs,
          midPrice: midPrice || null,
          priceMin: null, priceMax: null, priceBucket: null,
          priceRange: null, autoRange: true,
          times: [], prices: [],
          longMatrix: [], shortMatrix: [],
          maxValue: 0, p50: 0, p95: 0,
          totalLong: 0, totalShort: 0, eventCount: 0,
          snapshotCount: 0,
          generatedAt: now,
          empty: true,
          recorderStatus: recStatus,
          reason
        }
      });
    }

    // 价格窗
    const priceRangeRaw = req.query.priceRange;
    let priceRange = NaN;
    let autoRange = false;
    if (priceRangeRaw === undefined || priceRangeRaw === '' || priceRangeRaw === 'auto') {
      autoRange = true;
    } else {
      priceRange = Number(priceRangeRaw);
      if (!Number.isFinite(priceRange) || priceRange <= 0) autoRange = true;
      else if (priceRange > 0.5) priceRange = 0.5;
    }

    let priceMin, priceMax;
    if (autoRange) {
      let lo = Infinity, hi = -Infinity;
      for (const e of events) {
        if (e.price < lo) lo = e.price;
        if (e.price > hi) hi = e.price;
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
        priceRange = 0.005;
        const half = midPrice * priceRange;
        priceMin = midPrice - half;
        priceMax = midPrice + half;
      } else {
        const pad = (hi - lo) * 0.05 + midPrice * 0.0005; // 5% 边距 + 0.05% 兜底
        const half = Math.max(midPrice - lo, hi - midPrice) + pad;
        priceMin = midPrice - half;
        priceMax = midPrice + half;
        priceRange = half / midPrice;
      }
    } else {
      const half = midPrice * priceRange;
      priceMin = midPrice - half;
      priceMax = midPrice + half;
    }

    let priceBucket = Number(req.query.priceBucket);
    if (!Number.isFinite(priceBucket) || priceBucket <= 0) {
      const targetBuckets = 200;
      const raw = (priceMax - priceMin) / targetBuckets;
      const exp = Math.pow(10, Math.floor(Math.log10(raw)));
      const norm = raw / exp;
      let factor;
      if (norm < 1.5) factor = 1;
      else if (norm < 3.5) factor = 2;
      else if (norm < 7.5) factor = 5;
      else factor = 10;
      priceBucket = Math.max(0.01, factor * exp);
    }

    const matrix = recorder.buildLiquidationHeatmap(events, {
      fromMs, toMs, bucketMs, priceMin, priceMax, priceBucket
    });

    // P50 / P95
    let p50 = 0, p95 = 0;
    {
      const flat = [];
      for (let i = 0; i < matrix.longMatrix.length; i += 1) {
        const r = matrix.longMatrix[i];
        for (let j = 0; j < r.length; j += 1) if (r[j] > 0) flat.push(r[j]);
      }
      for (let i = 0; i < matrix.shortMatrix.length; i += 1) {
        const r = matrix.shortMatrix[i];
        for (let j = 0; j < r.length; j += 1) if (r[j] > 0) flat.push(r[j]);
      }
      if (flat.length) {
        flat.sort((a, b) => a - b);
        p50 = flat[Math.floor(flat.length * 0.5)];
        p95 = flat[Math.floor(flat.length * 0.95)];
      }
    }

    // 叠加 K 线（与预测模式行为一致；CoinGlass 风格）。即便没事件也尝试拉，
    // 让用户至少能看到价格走势，避免出现"空热图"。失败不影响主响应。
    let slimCandles = [];
    let candleInterval = null;
    try {
      const span = toMs - fromMs;
      const pick = _chooseCandleInterval(span);
      candleInterval = pick.interval;
      const needed = Math.ceil(span / pick.ms) + 5;
      const limit = Math.min(needed, 1500);
      // realized 模式只对 futures 生效，但即便 spot 也能拉 K 线
      const raw = await BinanceService.getKlines(symbol, candleInterval, limit, market);
      slimCandles = normalizeKlines(raw)
        .filter((c) => c.openTime >= fromMs - pick.ms && c.openTime <= toMs)
        .map((c) => ({ t: c.openTime, o: c.open, h: c.high, l: c.low, c: c.close }));
    } catch (_) {
      slimCandles = [];
    }

    res.json({
      success: true,
      data: {
        symbol, market,
        fromMs, toMs, bucketMs,
        midPrice, priceMin, priceMax, priceBucket, priceRange, autoRange,
        times: matrix.times,
        prices: matrix.prices,
        longMatrix: matrix.longMatrix,
        shortMatrix: matrix.shortMatrix,
        maxValue: matrix.maxValue,
        p50, p95,
        totalLong: matrix.totalLong,
        totalShort: matrix.totalShort,
        eventCount: matrix.eventCount,
        candles: slimCandles,
        candleInterval,
        generatedAt: now,
        empty: matrix.eventCount === 0
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/liquidations/recorder/status', (_req, res) => {
  res.json({ success: true, data: recorder.getStatus() });
});

module.exports = router;
