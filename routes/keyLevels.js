'use strict';

/**
 * GET /api/key-levels
 *
 * 多周期关键价位聚合 (Multi-timeframe key price levels)：
 *   • 每个周期 (15m / 1h / 4h / 1d)：
 *       - 最近的看涨 FVG / 看跌 FVG 区间（lower ~ upper）
 *       - POC（成交量分布主峰价位区间）
 *       - VWAP（该周期窗口的最新值）
 *   • 每个清算热图窗口 (15m / 1h / 4h / 24h · 仅合约)：
 *       - S↑ max（空头最大清算价位）
 *       - L↓ max（多头最大清算价位）
 *     主峰算法与 /api/trade/liq-signal 完全同源（_findPeaks），
 *     保证与前端清算热图上标注的横线一致。
 *   • 每个挂单墙窗口 (15m / 1h / 4h / 24h · 仅有订单簿录盘的品种)：
 *       - 买单墙（中价下方最强 bid 挂单价位）
 *       - 卖单墙（中价上方最强 ask 挂单价位）
 *     聚合口径与 /api/orderbook/heatmap 一致（USDT 名义额跨快照取 max）。
 *
 * 性能设计 (Performance)：
 *   • K 线复用：4 个热图窗口只发 2 次 K 线请求（1m×245 覆盖 15m/1h/4h 切片，
 *     5m×293 覆盖 24h），加上 4 个周期各 1 次 → 每次全量计算共 6 次 K 线请求
 *   • 挂单墙：24h 快照只读一次盘，只建一个矩阵，4 个窗口按时间子切片复用
 *   • 30s 内存 TTL 缓存（按 symbol|market），并发请求共享同一个 in-flight Promise
 *   • 单一聚合接口，前端一次拉全，不用发 8+ 个请求
 *
 * 查询参数：
 *   symbol   默认 'BTCUSDT'
 *   market   'spot' | 'futures'，默认 'futures'（spot 无清算热图部分）
 */

const express = require('express');
const { BinanceLive } = require('../services/binanceLive');
const {
  normalizeKlines,
  computeVWAP,
  detectFVGs
} = require('../indicators/klineIndicators');
const { computeVolumeProfile } = require('../indicators/volumeProfile');
const { buildPredictiveLiquidationHeatmap } = require('../services/predictiveLiquidations');
const { _findPeaks } = require('./liqSignal');
const obRecorder = require('../services/orderbookRecorder');

const router = express.Router();

const ONE_MIN_MS = 60_000;
const ONE_HOUR_MS = 3600_000;

// FVG / POC / VWAP 的周期集合
const LEVEL_INTERVALS = ['15m', '1h', '4h', '1d'];
const LEVEL_KLINE_LIMIT = 120;

// 清算热图窗口集合：src 指定切片来源（1m 或 5m 共享缓存）
const LIQ_WINDOWS = [
  { label: '15m', ms: 15 * ONE_MIN_MS, src: '1m', srcMs: ONE_MIN_MS, bucketMs: ONE_MIN_MS },
  { label: '1h', ms: ONE_HOUR_MS, src: '1m', srcMs: ONE_MIN_MS, bucketMs: ONE_MIN_MS },
  { label: '4h', ms: 4 * ONE_HOUR_MS, src: '1m', srcMs: ONE_MIN_MS, bucketMs: 2 * ONE_MIN_MS },
  { label: '24h', ms: 24 * ONE_HOUR_MS, src: '5m', srcMs: 5 * ONE_MIN_MS, bucketMs: 15 * ONE_MIN_MS }
];

// 挂单墙窗口集合（流动性热图 / 订单簿录盘）：一个 24h 矩阵按时间子切片复用
const OB_WALL_WINDOWS = [
  { label: '15m', ms: 15 * ONE_MIN_MS },
  { label: '1h', ms: ONE_HOUR_MS },
  { label: '4h', ms: 4 * ONE_HOUR_MS },
  { label: '24h', ms: 24 * ONE_HOUR_MS }
];

// ---- 30s TTL 缓存（in-flight Promise 共享，防并发击穿）----
const CACHE_TTL_MS = 30_000;
const _cache = new Map(); // key -> { ts, promise }

function _cacheKey(symbol, market) {
  return `${symbol}|${market}`;
}

/**
 * 单个清算窗口的主峰计算：切片 → 自适应价格范围 → 热图 → _findPeaks。
 * 价格范围 / 桶宽算法与 routes/liqSignal.js 的 auto 分支一致。
 */
function _computeWindowPeaks(srcCandles, win, midPrice, toMs) {
  const fromMs = toMs - win.ms;
  const wc = srcCandles.filter((c) => c.openTime >= fromMs - win.srcMs);
  if (wc.length < 3) return null;

  let lo = Infinity;
  let hi = -Infinity;
  for (const c of wc) {
    if (c.low < lo) lo = c.low;
    if (c.high > hi) hi = c.high;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;

  const pad = (hi - lo) * 0.3 + midPrice * 0.005;
  const half = Math.max(midPrice - lo, hi - midPrice) + pad;
  const priceMin = midPrice - half;
  const priceMax = midPrice + half;

  const rawBucket = (priceMax - priceMin) / 240;
  const exp = Math.pow(10, Math.floor(Math.log10(rawBucket)));
  const norm = rawBucket / exp;
  const factor = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
  const priceBucket = Math.max(0.01, factor * exp);

  const heat = buildPredictiveLiquidationHeatmap(wc, {
    fromMs, toMs, bucketMs: win.bucketMs, priceMin, priceMax, priceBucket
  });
  return _findPeaks(heat, midPrice);
}

/**
 * 挂单墙（流动性热图口径）：每个窗口的最强买单墙 / 卖单墙价位。
 *
 * 性能：录盘快照只读一次（24h），只建一个 5min×~240桶 矩阵，
 * 各窗口通过时间子切片取 row-max —— 与流动性热图"最大值突出持续墙"
 * 的聚合口径一致。仅 BTCUSDT futures 有录盘，其余返回 []。
 */
function _computeObWalls(symbol, market, midPrice) {
  const now = Date.now();
  const snapshots = obRecorder.findRange(symbol, market, now - 24 * ONE_HOUR_MS, now);
  if (!snapshots || !snapshots.length) return [];

  // 价格范围：扫快照实际覆盖的价差（与 /api/orderbook/heatmap auto 一致）
  let lo = Infinity;
  let hi = -Infinity;
  for (const snap of snapshots) {
    for (const [pStr] of (snap.bids || [])) {
      const p = Number(pStr);
      if (Number.isFinite(p) && p < lo) lo = p;
    }
    for (const [pStr] of (snap.asks || [])) {
      const p = Number(pStr);
      if (Number.isFinite(p) && p > hi) hi = p;
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [];

  const rawBucket = (hi - lo) / 240;
  const exp = Math.pow(10, Math.floor(Math.log10(rawBucket)));
  const norm = rawBucket / exp;
  const factor = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
  const priceBucket = Math.max(0.01, factor * exp);

  const fromMs = now - 24 * ONE_HOUR_MS;
  const bucketMs = 5 * ONE_MIN_MS;
  const m = obRecorder.buildHeatmapMatrix(snapshots, {
    fromMs, toMs: now, bucketMs, priceMin: lo, priceMax: hi, priceBucket
  });
  const T = m.times.length;
  const P = m.prices.length;
  const half = priceBucket / 2;

  return OB_WALL_WINDOWS.map((win) => {
    // 该窗口对应的时间桶起点
    let startTi = 0;
    const winFrom = now - win.ms;
    while (startTi < T && m.times[startTi] + bucketMs <= winFrom) startTi += 1;

    let bidArg = -1;
    let bidMax = 0;
    let askArg = -1;
    let askMax = 0;
    for (let pi = 0; pi < P; pi += 1) {
      const price = m.prices[pi] + half;
      for (let ti = startTi; ti < T; ti += 1) {
        const bv = m.bidMatrix[ti] ? (m.bidMatrix[ti][pi] || 0) : 0;
        const av = m.askMatrix[ti] ? (m.askMatrix[ti][pi] || 0) : 0;
        if (bv > bidMax && price < midPrice) { bidMax = bv; bidArg = pi; }
        if (av > askMax && price > midPrice) { askMax = av; askArg = pi; }
      }
    }
    return {
      label: win.label,
      windowMs: win.ms,
      bidWall: bidArg >= 0 ? m.prices[bidArg] + half : null,
      bidUsd: bidArg >= 0 ? bidMax : null,
      askWall: askArg >= 0 ? m.prices[askArg] + half : null,
      askUsd: askArg >= 0 ? askMax : null
    };
  });
}

/** 单个周期的 FVG / POC / VWAP */
function _computeIntervalLevels(interval, raw) {
  const candles = normalizeKlines(raw);
  if (candles.length < 5) return { interval, ok: false };

  const vwap = computeVWAP(candles);
  const fvgs = detectFVGs(candles);
  let bull = null;
  let bear = null;
  for (let i = fvgs.length - 1; i >= 0 && (!bull || !bear); i -= 1) {
    const f = fvgs[i];
    if (!bull && f.type === 'bullish') bull = f;
    else if (!bear && f.type === 'bearish') bear = f;
  }

  let poc = null;
  try {
    const profile = computeVolumeProfile(candles, 50);
    if (profile && profile.poc) {
      poc = { low: profile.poc.priceLow, high: profile.poc.priceHigh };
    }
  } catch (_) { /* volume profile 失败不阻断其他价位 */ }

  return {
    interval,
    ok: true,
    bullFvg: bull ? { lower: bull.lower, upper: bull.upper, time: bull.endTime } : null,
    bearFvg: bear ? { lower: bear.lower, upper: bear.upper, time: bear.endTime } : null,
    poc,
    vwap: vwap.length ? vwap[vwap.length - 1] : null
  };
}

async function _computeKeyLevels(symbol, market) {
  // 6 次 K 线请求并行：1m / 5m 给热图窗口切片，4 个周期给 FVG/POC/VWAP
  const [m1Raw, m5Raw, ...levelRaws] = await Promise.all([
    BinanceLive.getKlines(symbol, '1m', 245, market).catch(() => []),
    BinanceLive.getKlines(symbol, '5m', 293, market).catch(() => []),
    ...LEVEL_INTERVALS.map((iv) =>
      BinanceLive.getKlines(symbol, iv, LEVEL_KLINE_LIMIT, market).catch(() => []))
  ]);

  const c1m = normalizeKlines(m1Raw);
  const c5m = normalizeKlines(m5Raw);
  const latestPrice = c1m.length
    ? Number(c1m[c1m.length - 1].close)
    : (c5m.length ? Number(c5m[c5m.length - 1].close) : null);

  const intervals = LEVEL_INTERVALS.map((iv, i) => _computeIntervalLevels(iv, levelRaws[i]));

  // 清算热图主峰仅合约有意义（预测热图基于杠杆清算模型）
  let liqWindows = [];
  if (market === 'futures' && Number.isFinite(latestPrice) && latestPrice > 0) {
    const toMs = Date.now();
    liqWindows = LIQ_WINDOWS.map((win) => {
      const src = win.src === '1m' ? c1m : c5m;
      let peaks = null;
      try {
        peaks = _computeWindowPeaks(src, win, latestPrice, toMs);
      } catch (_) { /* 单窗口失败不阻断其余窗口 */ }
      return {
        label: win.label,
        windowMs: win.ms,
        sMax: peaks && peaks.peakShort ? peaks.peakShort.price : null,
        lMax: peaks && peaks.peakLong ? peaks.peakLong.price : null
      };
    });
  }

  // 挂单墙（订单簿录盘，同步磁盘读，放 try 里防录盘目录缺失）
  let obWalls = [];
  if (Number.isFinite(latestPrice) && latestPrice > 0) {
    try {
      obWalls = _computeObWalls(symbol, market, latestPrice);
    } catch (_) { /* 无录盘数据 → 前端隐藏该组 */ }
  }

  return { symbol, market, ts: Date.now(), latestPrice, intervals, liqWindows, obWalls };
}

router.get('/key-levels', async (req, res) => {
  try {
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    const market = req.query.market === 'spot' ? 'spot' : 'futures';
    const key = _cacheKey(symbol, market);

    const hit = _cache.get(key);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
      const data = await hit.promise;
      return res.json({ success: true, data, cached: true });
    }

    const promise = _computeKeyLevels(symbol, market);
    _cache.set(key, { ts: Date.now(), promise });
    // 计算失败清缓存，避免把 rejected Promise 缓存 30s
    promise.catch(() => _cache.delete(key));
    // 缓存 Map 无界增长防护：超 50 个 key 时清掉过期项
    if (_cache.size > 50) {
      const now = Date.now();
      for (const [k, v] of _cache.entries()) {
        if (now - v.ts >= CACHE_TTL_MS) _cache.delete(k);
      }
    }

    const data = await promise;
    res.json({ success: true, data, cached: false });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
// 供冒烟测试 (Exposed for smoke tests)
module.exports._computeWindowPeaks = _computeWindowPeaks;
module.exports._computeIntervalLevels = _computeIntervalLevels;
module.exports._computeObWalls = _computeObWalls;
