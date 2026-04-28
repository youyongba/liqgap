'use strict';

/**
 * GET /api/indicators/slippage
 *
 * 查询参数 (Query):
 *   symbol         必填
 *   orderQuantity  必填，下单量（基础币 / base asset）
 *   side           'buy' | 'sell'，默认 'buy'
 *   market         'spot' | 'futures'，默认 'spot'
 *
 * 返回 (Returns):
 *   { avgFillPrice, slippage, filled, filledQty, bestPrice, levelsConsumed }
 */

const express = require('express');
const { BinanceService } = require('../services/binance');
const { simulateSlippage } = require('../indicators/orderbookIndicators');

const router = express.Router();

router.get('/indicators/slippage', async (req, res) => {
  try {
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    const orderQuantity = Number(req.query.orderQuantity);
    if (!orderQuantity || orderQuantity <= 0) {
      return res.json({
        success: false,
        error: 'orderQuantity 必须是正数 (must be a positive number)'
      });
    }
    const side = req.query.side === 'sell' ? 'sell' : 'buy';
    // 默认合约 (default to futures)
    const market = req.query.market === 'spot' ? 'spot' : 'futures';

    const book = await BinanceService.getOrderBook(symbol, 1000, market);
    const result = simulateSlippage(book, orderQuantity, side);

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
