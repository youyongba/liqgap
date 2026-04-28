'use strict';

/**
 * GET /api/orderbook/indicators
 *
 * 查询参数 (Query):
 *   symbol    必填 (required)
 *   depth     默认 20，每边考虑的档位数 (top-N levels per side)
 *   market    'spot' | 'futures'，默认 'spot'
 *   probeQty  默认 0.1，估算"有效价差"用的下单量（基础币）
 *
 * 响应字段 (Response data fields):
 *   bestBid, bestAsk, midPrice, spread,
 *   depthDiff, depthRatio, estEffectiveSpread,
 *   bidNotional, askNotional, depthLevels,
 *   bids: 前 N 档买盘 (top-N), asks: 前 N 档卖盘 (top-N)
 */

const express = require('express');
const { BinanceService } = require('../services/binance');
const { computeOrderBookIndicators } = require('../indicators/orderbookIndicators');

const router = express.Router();

router.get('/orderbook/indicators', async (req, res) => {
  try {
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    const depth = Math.min(Number(req.query.depth) || 20, 1000);
    const probeQty = Number(req.query.probeQty) || 0.1;
    // 默认合约 (default to futures)
    const market = req.query.market === 'spot' ? 'spot' : 'futures';

    // Binance depth 接口只接受预设档数；先抓宽再本地切片
    // (Binance only allows preset depth sizes; we slice locally.)
    const fetchDepth = Math.max(depth, 100);
    const book = await BinanceService.getOrderBook(symbol, fetchDepth, market);
    const indicators = computeOrderBookIndicators(book, depth, probeQty);

    res.json({
      success: true,
      data: {
        ...indicators,
        symbol,
        market,
        bids: book.bids.slice(0, depth),
        asks: book.asks.slice(0, depth)
      }
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
