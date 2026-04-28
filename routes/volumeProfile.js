'use strict';

/**
 * GET /api/indicators/volume-profile
 *
 * 查询参数 (Query):
 *   symbol    必填 (required)
 *   interval  默认 '1h'
 *   limit     默认 200（K 线数量）
 *   buckets   默认 100（成交量分布桶数）
 *   market    'spot' | 'futures'，默认 'spot'
 *
 * 返回成交量分布 / POC / VAH / VAL
 * (Returns volume profile, point of control, value-area high/low.)
 */

const express = require('express');
const { BinanceService } = require('../services/binance');
const { normalizeKlines } = require('../indicators/klineIndicators');
const { computeVolumeProfile } = require('../indicators/volumeProfile');

const router = express.Router();

router.get('/indicators/volume-profile', async (req, res) => {
  try {
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    const interval = req.query.interval || '1h';
    const limit = Math.min(Number(req.query.limit) || 200, 1500);
    const buckets = Math.min(Number(req.query.buckets) || 100, 500);
    // 默认合约 (default to futures)
    const market = req.query.market === 'spot' ? 'spot' : 'futures';

    const raw = await BinanceService.getKlines(symbol, interval, limit, market);
    const candles = normalizeKlines(raw);
    const profile = computeVolumeProfile(candles, buckets);

    res.json({
      success: true,
      data: {
        symbol,
        market,
        interval,
        ...profile
      }
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
