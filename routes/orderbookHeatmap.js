'use strict';

/**
 * GET /api/orderbook/heatmap
 *
 * 流动性热图数据接口 (Liquidity Heatmap data endpoint)。
 * 把 [from, to] 时间窗内录盘到的所有盘口快照，按 (时间桶, 价格桶) 聚合
 * 成 2D 矩阵，每格记录该桶内挂单量（USDT 名义额）的"最大值"——
 * 最大值能更突出"挂单墙"在时间维度上的持续性。
 *
 * 查询参数 (Query):
 *   symbol      默认 'BTCUSDT'
 *   market      'spot' | 'futures'，默认 'futures'
 *   from, to    毫秒时间戳。默认 to=now, from=now-1h。
 *   bucketMs    时间桶宽（毫秒）。默认 60_000（1min · 与录盘频率对齐）。
 *               允许范围 [60_000, 3_600_000]（1min ~ 1h）。
 *   priceBucket 价格桶宽（USDT）。默认按 mid 自适应（约 mid * 0.00005）。
 *   priceRange  价格上下窗（小数比例），围绕 mid 的对称窗。默认 0.01（±1%）。
 *
 * 响应 (Response):
 *   { success: true, data: {
 *       symbol, market,
 *       fromMs, toMs, bucketMs, priceBucket,
 *       midPrice, priceMin, priceMax,
 *       times:  number[]              // 长度 T，时间桶左边界（ms）
 *       prices: number[]              // 长度 P，价格桶左边界（USDT）
 *       bidMatrix: number[T][P]       // 该桶买墙挂单量峰值（USDT）
 *       askMatrix: number[T][P]       // 该桶卖墙挂单量峰值（USDT）
 *       maxValue,
 *       snapshotCount,
 *       generatedAt
 *   }}
 *
 * 注意 (Notes):
 *   - 回放窗口受录盘保留时长限制（默认 25h）。超出会返回较少 / 0 行。
 *   - 单次响应大小：T=60(1h/1m桶) × P≈200，每边数值 ≈ 1.5MB JSON。
 *     若想拉更长窗口请用更粗的 bucketMs（如 5min）。
 */

const express = require('express');
const recorder = require('../services/orderbookRecorder');
const { BinanceService } = require('../services/binance');

const router = express.Router();

const ONE_HOUR_MS = 3600_000;

router.get('/orderbook/heatmap', async (req, res) => {
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

    // 限制单次最多 T 桶（避免响应巨大）
    const MAX_T_BUCKETS = 600;
    let tCount = Math.ceil((toMs - fromMs) / bucketMs);
    if (tCount > MAX_T_BUCKETS) {
      bucketMs = Math.ceil((toMs - fromMs) / MAX_T_BUCKETS / 60_000) * 60_000;
      tCount = Math.ceil((toMs - fromMs) / bucketMs);
    }

    // 取区间内全部快照
    const snapshots = recorder.findRange(symbol, market, fromMs, toMs);

    // 推断 mid price：优先用最近一条快照的中价；否则用 ticker 兜底；都没有则返回空
    let midPrice = NaN;
    if (snapshots.length > 0) {
      const latest = snapshots[snapshots.length - 1];
      const bestBid = latest.bids && latest.bids[0] ? Number(latest.bids[0][0]) : NaN;
      const bestAsk = latest.asks && latest.asks[0] ? Number(latest.asks[0][0]) : NaN;
      if (Number.isFinite(bestBid) && Number.isFinite(bestAsk)) {
        midPrice = (bestBid + bestAsk) / 2;
      }
    }
    if (!Number.isFinite(midPrice)) {
      try {
        midPrice = await BinanceService.getCurrentPrice(symbol, market);
      } catch (_) { midPrice = NaN; }
    }
    if (!Number.isFinite(midPrice) || midPrice <= 0) {
      return res.json({
        success: true,
        data: {
          symbol, market,
          fromMs, toMs, bucketMs,
          midPrice: null, priceMin: null, priceMax: null,
          priceBucket: null,
          times: [], prices: [],
          bidMatrix: [], askMatrix: [],
          maxValue: 0,
          snapshotCount: snapshots.length,
          generatedAt: now,
          empty: true,
          reason: '尚无快照可用 / 价格无法确定，等待 obRecorder 录盘几分钟后再试。'
        }
      });
    }

    // ---- 价格窗 (Price window) ------------------------------------------
    // 默认走 'auto'：扫所有快照取盘口实际覆盖的价差，再加一点边距。
    // BTC futures 100 档常规只覆盖 mid ± 0.05% ~ 0.1%；过去用 ±1% 让大部
    // 分画布被空白吞掉，所有数据被挤成一条窄带。auto 模式下数据自然铺满。
    const priceRangeRaw = req.query.priceRange;
    let priceRange = NaN;
    let autoRange = false;
    if (priceRangeRaw === undefined || priceRangeRaw === '' || priceRangeRaw === 'auto') {
      autoRange = true;
    } else {
      priceRange = Number(priceRangeRaw);
      if (!Number.isFinite(priceRange) || priceRange <= 0) {
        autoRange = true;
      } else if (priceRange > 0.5) {
        priceRange = 0.5;
      }
    }

    let priceMin;
    let priceMax;
    if (autoRange) {
      // 扫所有快照拿到价差极值；再加 5% 边距让最远档位仍然可见。
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
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
        // 没拿到有效价差，退回 0.3%
        priceRange = 0.003;
        const halfWindow = midPrice * priceRange;
        priceMin = midPrice - halfWindow;
        priceMax = midPrice + halfWindow;
      } else {
        const span = hi - lo;
        const pad = span * 0.05;
        // 围绕 mid 对称：保证 mid 居中，且能看到两侧最远档位。
        const half = Math.max(midPrice - lo, hi - midPrice) + pad;
        priceMin = midPrice - half;
        priceMax = midPrice + half;
        priceRange = half / midPrice;
      }
    } else {
      const halfWindow = midPrice * priceRange;
      priceMin = midPrice - halfWindow;
      priceMax = midPrice + halfWindow;
    }

    let priceBucket = Number(req.query.priceBucket);
    if (!Number.isFinite(priceBucket) || priceBucket <= 0) {
      // 自适应：约 240 桶（更细粒度让墙的层次出来）
      const targetBuckets = 240;
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

    const matrix = recorder.buildHeatmapMatrix(snapshots, {
      fromMs, toMs, bucketMs,
      priceMin, priceMax, priceBucket
    });

    // ---- 计算 P95 / P50 用于前端归一化 -----------------------------------
    // 极少数巨墙会把 maxValue 拉得很大，导致中等墙都被 log 压成同色。
    // 把 P95 一并返回，前端可用作"高亮上限"。
    let p50 = 0, p95 = 0;
    {
      const flat = [];
      for (let i = 0; i < matrix.bidMatrix.length; i += 1) {
        const r = matrix.bidMatrix[i];
        for (let j = 0; j < r.length; j += 1) if (r[j] > 0) flat.push(r[j]);
      }
      for (let i = 0; i < matrix.askMatrix.length; i += 1) {
        const r = matrix.askMatrix[i];
        for (let j = 0; j < r.length; j += 1) if (r[j] > 0) flat.push(r[j]);
      }
      if (flat.length) {
        flat.sort((a, b) => a - b);
        p50 = flat[Math.floor(flat.length * 0.5)];
        p95 = flat[Math.floor(flat.length * 0.95)];
      }
    }

    res.json({
      success: true,
      data: {
        symbol, market,
        fromMs, toMs, bucketMs,
        midPrice, priceMin, priceMax, priceBucket, priceRange,
        autoRange,
        times: matrix.times,
        prices: matrix.prices,
        bidMatrix: matrix.bidMatrix,
        askMatrix: matrix.askMatrix,
        maxValue: matrix.maxValue,
        p50, p95,
        snapshotCount: matrix.snapshotCount,
        generatedAt: now,
        empty: matrix.snapshotCount === 0
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
