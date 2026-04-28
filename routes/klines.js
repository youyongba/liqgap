'use strict';

/**
 * GET /api/klines
 *
 * 查询参数 (Query params):
 *   symbol         交易对，如 BTCUSDT (required)
 *   interval       默认 '1h'
 *   limit          默认 100
 *   market         'spot' | 'futures'，默认 'spot'
 *   detectPatterns 'true' | 'false'，默认 false
 *                  打开后会附带 FVG 与流动性空白识别结果
 *
 * 响应结构 (Response shape):
 * {
 *   success: true,
 *   data: {
 *     candles: [
 *       { openTime, open, high, low, close, volume, closeTime, quoteVolume,
 *         vwap, mfi }                            // K 线 + 指标
 *     ],
 *     fvgs:           [ { type, lower, upper, startTime, endTime, index } ]
 *     liquidityVoids: [ { startIndex, endIndex, startTime, endTime, lower, upper, length } ]
 *     summary:        { count, interval, market }
 *   }
 * }
 */

const express = require('express');
const { BinanceService } = require('../services/binance');
const {
  normalizeKlines,
  computeVWAP,
  computeMFI,
  detectFVGs,
  detectLiquidityVoids
} = require('../indicators/klineIndicators');

const router = express.Router();

router.get('/klines', async (req, res) => {
  try {
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    const interval = req.query.interval || '1h';
    const limit = Math.min(Number(req.query.limit) || 100, 1500);
    // 默认合约 (default to futures per project spec)
    const market = req.query.market === 'spot' ? 'spot' : 'futures';
    const detectPatterns = String(req.query.detectPatterns) === 'true';

    const raw = await BinanceService.getKlines(symbol, interval, limit, market);
    const candles = normalizeKlines(raw);
    const vwap = computeVWAP(candles);
    const mfi = computeMFI(candles, 14);

    // 把 vwap / mfi 附加到对应 K 线上 (Attach VWAP / MFI to each candle)
    const decorated = candles.map((c, i) => ({
      ...c,
      vwap: vwap[i],
      mfi: mfi[i]
    }));

    const result = {
      candles: decorated,
      summary: { count: decorated.length, interval, market, symbol }
    };

    if (detectPatterns) {
      result.fvgs = detectFVGs(candles);
      result.liquidityVoids = detectLiquidityVoids(candles);
    }

    res.json({ success: true, data: result });
  } catch (err) {
    // 统一以 200 + {success:false} 返回，前端永远能解析 JSON
    // (Always return {success:false} so the dashboard can render an error
    //  state instead of crashing on non-JSON 500 bodies.)
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
