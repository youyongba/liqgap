'use strict';

/**
 * GET /api/indicators/illiquidity
 *
 * 查询参数 (Query):
 *   symbol  必填 (required)
 *   market  'spot' | 'futures'，默认 'spot'
 *   period  默认 '1d'
 *   limit   默认 30
 *
 * 返回 Amihud ILLIQ 时间序列 (Returns Amihud ILLIQ time-series)。
 */

const express = require('express');
const { BinanceService } = require('../services/binance');
const { normalizeKlines } = require('../indicators/klineIndicators');
const { computeIlliquidity } = require('../indicators/illiquidity');

const router = express.Router();

router.get('/indicators/illiquidity', async (req, res) => {
  try {
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    const period = req.query.period || '1d';
    const limit = Math.min(Number(req.query.limit) || 30, 1500);
    // 默认合约 (default to futures)
    const market = req.query.market === 'spot' ? 'spot' : 'futures';

    const raw = await BinanceService.getKlines(symbol, period, limit, market);
    const candles = normalizeKlines(raw);
    const series = computeIlliquidity(candles);

    res.json({
      success: true,
      data: {
        symbol,
        market,
        period,
        series
      }
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
