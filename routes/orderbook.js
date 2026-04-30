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

// Binance 深度接口允许的离散 limit 集合：
//   现货 (Spot)    : 5 / 10 / 20 / 50 / 100 / 500 / 1000 / 5000
//   合约 (Futures) : 5 / 10 / 20 / 50 / 100 / 500 / 1000
// 任何不在此集合中的 limit 会被 Binance 拒绝。
// 我们把任意 depth 向上对齐到该集合中 ≥ depth 的最小值，再本地切片返回前 depth 档。
// (Align any requested depth to the next allowed Binance bucket and slice locally.)
function alignBinanceDepth(d, market) {
  const allowed = market === 'spot'
    ? [5, 10, 20, 50, 100, 500, 1000, 5000]
    : [5, 10, 20, 50, 100, 500, 1000];
  for (const v of allowed) if (d <= v) return v;
  return allowed[allowed.length - 1];
}

router.get('/orderbook/indicators', async (req, res) => {
  try {
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    // 默认合约 (default to futures)
    const market = req.query.market === 'spot' ? 'spot' : 'futures';
    const maxDepth = market === 'spot' ? 5000 : 1000;
    const depth = Math.min(Math.max(Number(req.query.depth) || 20, 1), maxDepth);
    const probeQty = Number(req.query.probeQty) || 0.1;

    const fetchDepth = alignBinanceDepth(Math.max(depth, 100), market);
    const book = await BinanceService.getOrderBook(symbol, fetchDepth, market);
    const indicators = computeOrderBookIndicators(book, depth, probeQty);

    res.json({
      success: true,
      data: {
        ...indicators,
        symbol,
        market,
        depth,
        fetchDepth,
        bids: book.bids.slice(0, depth),
        asks: book.asks.slice(0, depth)
      }
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
