'use strict';

/**
 * GET /api/predictive/liquidations
 *
 * CoinGlass 风格的"预测性"清算热力图数据。
 * 基于历史 K 线 × 杠杆估算反推出"如果价格走到 X 价位，预计会触发的清算量"，
 * 并加入"已扫消耗"——价格已穿过的清算线在那一刻起从矩阵剔除。
 * 输出形态接近 CoinGlass Liquidation Heatmap 的"横向亮带"。
 *
 * 查询参数 (Query):
 *   symbol      默认 'BTCUSDT'
 *   market      'futures' (现货无杠杆，默认强制 futures)
 *   windowMs    回看时间窗。默认 24h，范围 [15m, 7d]
 *   bucketMs    时间桶宽。默认按 windowMs 自适应。
 *   priceRange  价格范围比例 (auto / 0.005 / 0.01 / 0.02 / 0.05)。默认 auto。
 *   sourceInterval  采样 K 线粒度。默认 1m；可选 1m/5m/15m。粒度越细越准
 *                   但接口越慢；24h 用 5m (288 根) 是性价比最佳。
 */

const express = require('express');
const { BinanceService } = require('../services/binance');
const { normalizeKlines } = require('../indicators/klineIndicators');
const { buildPredictiveLiquidationHeatmap } = require('../services/predictiveLiquidations');

const router = express.Router();
const ONE_HOUR_MS = 3600_000;
const ONE_MIN_MS = 60_000;

// 把 windowMs 映射成合理的 (sourceInterval, bucketMs)
// 设计目标：源 K 线 ≤ 1500 根（Binance 单次拉取上限），时间桶 ≤ ~120 个，
// 让前端渲染流畅、清算分布在长窗口下也能看出 macro 趋势。
function _autoSampling(windowMs) {
  if (windowMs <=       ONE_HOUR_MS) return { source: '1m',  bucketMs:        ONE_MIN_MS };  // 1h: 60×1m
  if (windowMs <=   4 * ONE_HOUR_MS) return { source: '1m',  bucketMs:   2  * ONE_MIN_MS };  // 4h: 240×1m → 桶 120
  if (windowMs <=  12 * ONE_HOUR_MS) return { source: '5m',  bucketMs:   5  * ONE_MIN_MS };  // 12h: 144×5m
  if (windowMs <=  24 * ONE_HOUR_MS) return { source: '5m',  bucketMs:  15  * ONE_MIN_MS };  // 24h: 288×5m → 桶 96
  if (windowMs <=  48 * ONE_HOUR_MS) return { source: '5m',  bucketMs:  30  * ONE_MIN_MS };  // 48h: 576×5m → 桶 96
  if (windowMs <=  72 * ONE_HOUR_MS) return { source: '15m', bucketMs:  60  * ONE_MIN_MS };  // 3d:  288×15m → 桶 72
  if (windowMs <=   7 * 24 * ONE_HOUR_MS) return { source: '15m', bucketMs:   2 * 60 * ONE_MIN_MS }; // 1w: 672×15m → 桶 84
  if (windowMs <=  14 * 24 * ONE_HOUR_MS) return { source: '30m', bucketMs:   4 * 60 * ONE_MIN_MS }; // 2w: 672×30m → 桶 84
  if (windowMs <=  21 * 24 * ONE_HOUR_MS) return { source: '1h',  bucketMs:   6 * 60 * ONE_MIN_MS }; // 3w: 504×1h  → 桶 84
  return                                          { source: '1h',  bucketMs:   8 * 60 * ONE_MIN_MS }; // 1mo:744×1h → 桶 ~93
}

router.get('/predictive/liquidations', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || 'BTCUSDT').toUpperCase();
    // 现货无杠杆 → 强制 futures
    const market = 'futures';

    const now = Date.now();
    let windowMs = Number(req.query.windowMs);
    if (!Number.isFinite(windowMs) || windowMs < 15 * ONE_MIN_MS) windowMs = 24 * ONE_HOUR_MS;
    // 上限放宽到 31 天，覆盖前端 48h / 3d / 1w / 2w / 3w / 1月 选项
    if (windowMs > 31 * 24 * ONE_HOUR_MS) windowMs = 31 * 24 * ONE_HOUR_MS;

    const toMs = now;
    const fromMs = toMs - windowMs;

    const auto = _autoSampling(windowMs);
    const sourceInterval = (req.query.sourceInterval || auto.source);
    let bucketMs = Number(req.query.bucketMs);
    if (!Number.isFinite(bucketMs) || bucketMs < ONE_MIN_MS) bucketMs = auto.bucketMs;
    // 长窗口（>= 1 周）需要更大的时间桶（4h/6h/8h），不再硬封顶到 1h，
    // 否则 1月窗口会出现 744 桶而把热图压得糊成一片。
    const MAX_BUCKET_MS = 12 * ONE_HOUR_MS;
    if (bucketMs > MAX_BUCKET_MS) bucketMs = MAX_BUCKET_MS;

    // 拉 K 线（最大 1500 根；如果 windowMs 需要更多就分批）
    // 这里做单次拉取覆盖：windowMs / sourceMs ≤ 1500 时直接一次拉。
    const sourceMs = ({
      '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
      '30m': 1800_000, '1h': 3600_000, '2h': 7200_000, '4h': 14400_000
    })[sourceInterval] || 60_000;
    const needed = Math.ceil(windowMs / sourceMs);
    const limit = Math.min(needed + 5, 1500); // 多拉 5 根做边界兜底

    const raw = await BinanceService.getKlines(symbol, sourceInterval, limit, market);
    const candles = normalizeKlines(raw).filter((c) => c.openTime >= fromMs - sourceMs);

    if (!candles.length) {
      return res.json({
        success: true,
        data: {
          symbol, market, fromMs, toMs, bucketMs,
          midPrice: null, priceMin: null, priceMax: null, priceBucket: null,
          priceRange: null, autoRange: true,
          times: [], prices: [],
          longMatrix: [], shortMatrix: [],
          maxValue: 0, p50: 0, p95: 0,
          totalLong: 0, totalShort: 0, candleCount: 0, eventCount: 0,
          generatedAt: now, empty: true,
          mode: 'predicted',
          reason: '尚无 K 线 / no klines available'
        }
      });
    }

    const midPrice = Number(candles[candles.length - 1].close);

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
      // 用 K 线 high/low 范围取实际波动 + 留 30% 边距给极端杠杆清算线
      let lo = Infinity, hi = -Infinity;
      for (const c of candles) {
        if (c.low < lo) lo = c.low;
        if (c.high > hi) hi = c.high;
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
        priceRange = 0.05;
        const half = midPrice * priceRange;
        priceMin = midPrice - half; priceMax = midPrice + half;
      } else {
        const pad = (hi - lo) * 0.3 + midPrice * 0.005;
        const half = Math.max(midPrice - lo, hi - midPrice) + pad;
        priceMin = midPrice - half;
        priceMax = midPrice + half;
        priceRange = half / midPrice;
      }
    } else {
      const half = midPrice * priceRange;
      priceMin = midPrice - half; priceMax = midPrice + half;
    }

    // 价格桶自适应：约 200 桶
    let priceBucket = Number(req.query.priceBucket);
    if (!Number.isFinite(priceBucket) || priceBucket <= 0) {
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

    const matrix = buildPredictiveLiquidationHeatmap(candles, {
      fromMs, toMs, bucketMs,
      priceMin, priceMax, priceBucket
    });

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

    // 用于前端在热力图上叠加 K 线（CoinGlass 风格）。slim 字段缩短传输体积。
    // 仅返回窗口内 candles，避免边界外多余样本带歪缩放。
    const slimCandles = candles
      .filter((c) => c.openTime >= fromMs - sourceMs && c.openTime <= toMs)
      .map((c) => ({ t: c.openTime, o: c.open, h: c.high, l: c.low, c: c.close }));

    res.json({
      success: true,
      data: {
        symbol, market,
        fromMs, toMs, bucketMs,
        midPrice, priceMin, priceMax, priceBucket, priceRange, autoRange,
        sourceInterval,
        times: matrix.times,
        prices: matrix.prices,
        longMatrix: matrix.longMatrix,
        shortMatrix: matrix.shortMatrix,
        maxValue: matrix.maxValue,
        p50, p95,
        totalLong: matrix.totalLong,
        totalShort: matrix.totalShort,
        candleCount: matrix.candleCount,
        eventCount: matrix.candleCount, // 兼容前端字段
        leverageBuckets: matrix.leverageBuckets,
        mmr: matrix.mmr,
        halfLifeMs: matrix.halfLifeMs,
        candles: slimCandles,
        candleInterval: sourceInterval,
        generatedAt: now,
        empty: matrix.maxValue === 0,
        mode: 'predicted'
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
