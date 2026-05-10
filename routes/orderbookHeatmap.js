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
const BinanceService = require('../services/binance');

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

    // 价格窗与价格桶
    let priceRange = Number(req.query.priceRange);
    if (!Number.isFinite(priceRange) || priceRange <= 0) priceRange = 0.01;
    if (priceRange > 0.5) priceRange = 0.5;

    const halfWindow = midPrice * priceRange;
    const priceMin = midPrice - halfWindow;
    const priceMax = midPrice + halfWindow;

    let priceBucket = Number(req.query.priceBucket);
    if (!Number.isFinite(priceBucket) || priceBucket <= 0) {
      // 自适应：约 200 桶
      const targetBuckets = 200;
      const raw = (priceMax - priceMin) / targetBuckets;
      // 圆整到 1/2/5/10/... 系列
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

    res.json({
      success: true,
      data: {
        symbol, market,
        fromMs, toMs, bucketMs,
        midPrice, priceMin, priceMax, priceBucket,
        times: matrix.times,
        prices: matrix.prices,
        bidMatrix: matrix.bidMatrix,
        askMatrix: matrix.askMatrix,
        maxValue: matrix.maxValue,
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
