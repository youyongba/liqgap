'use strict';

/**
 * GET /api/trade/indicators
 *
 * 查询参数 (Query):
 *   symbol    必填 (required)
 *   limit     默认 500（聚合成交条数 / aggTrades count）
 *   market    'spot' | 'futures'，默认 'spot'
 *   buckets   默认 50（footprint 价格分桶数）
 *
 * 返回 deltaSeries / cvdSeries / footprintTable。
 */

const express = require('express');
const { BinanceLive: BinanceService } = require('../services/binanceLive');
const { computeTradeIndicators } = require('../indicators/tradeIndicators');

const router = express.Router();

router.get('/trade/indicators', async (req, res) => {
  try {
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    const limit = Math.min(Number(req.query.limit) || 500, 1000);
    // 默认合约 (default to futures)
    const market = req.query.market === 'spot' ? 'spot' : 'futures';
    const buckets = Math.min(Number(req.query.buckets) || 50, 500);

    const trades = await BinanceService.getAggTrades(symbol, limit, market);
    const result = computeTradeIndicators(trades, market, buckets);

    res.json({
      success: true,
      data: {
        symbol,
        market,
        ...result
      }
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
