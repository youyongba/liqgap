'use strict';

/**
 * GET /api/indicators/volume-profile
 *
 * 查询参数 (Query):
 *   symbol             必填 (required)
 *   interval           默认 '1h'
 *   limit              默认 200（K 线数量）
 *   buckets            默认 100（成交量分布桶数）
 *   market             'spot' | 'futures'，默认 'futures'
 *   lvnThresholdRatio  默认 0.10（LVN 阈值 = POC × 此比例）
 *   minLvnBuckets      默认 2（连续 ≥ N 个 LVN 桶才合并为 zone）
 *   includeBuckets     默认 'true'。设为 'false' 时不返回桶明细（减小响应体积）
 *
 * 返回成交量分布 / POC / VAH / VAL + LVN zones
 * (Returns volume profile, point of control, value-area high/low,
 *  and identified Low Volume Node zones.)
 */

const express = require('express');
const { BinanceLive: BinanceService } = require('../services/binanceLive');
const { normalizeKlines } = require('../indicators/klineIndicators');
const { computeVolumeProfile, markLVN } = require('../indicators/volumeProfile');

const router = express.Router();

router.get('/indicators/volume-profile', async (req, res) => {
  try {
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    const interval = req.query.interval || '1h';
    const limit = Math.min(Number(req.query.limit) || 200, 1500);
    const buckets = Math.min(Number(req.query.buckets) || 100, 500);
    const market = req.query.market === 'spot' ? 'spot' : 'futures';
    const lvnThresholdRatio = Math.min(Math.max(Number(req.query.lvnThresholdRatio) || 0.10, 0.01), 0.5);
    const minLvnBuckets = Math.max(1, Number(req.query.minLvnBuckets) || 2);
    const includeBuckets = String(req.query.includeBuckets || 'true').toLowerCase() !== 'false';

    const raw = await BinanceService.getKlines(symbol, interval, limit, market);
    const candles = normalizeKlines(raw);
    const profile = computeVolumeProfile(candles, buckets);
    markLVN(profile, {
      lvnThresholdRatio,
      minZoneBuckets: minLvnBuckets,
      requireSurroundedByHVN: true
    });

    const payload = {
      symbol,
      market,
      interval,
      poc: profile.poc,
      vah: profile.vah,
      val: profile.val,
      totalVolume: profile.totalVolume,
      lvnZones: profile.lvnZones || []
    };
    if (includeBuckets) payload.buckets = profile.buckets;

    res.json({ success: true, data: payload });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
