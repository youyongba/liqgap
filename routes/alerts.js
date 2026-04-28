'use strict';

/**
 * GET /api/alerts/liquidity
 *
 * 综合多条流动性 / 资金流信号，返回布尔型触发位 + 综合风险分数（触发数）。
 * (Aggregates several liquidity & flow signals and returns booleans plus a
 *  composite risk score (count of triggered alerts).)
 *
 * 触发器 (Triggers):
 *   1. spreadShock        : 当前 spread > μ + 3σ（最近 20 个 spread 样本）
 *   2. illiqShock         : 当前 ILLIQ > 历史均值 × 2（最近 `limit` 天）
 *   3. depthImbalance     : |depthRatio| > 0.8
 *   4. vwapDeviation      : |latestPrice / latestVWAP - 1| > 2%
 *   5. cvdPriceDivergence : 近 10 根 K 线 (price diff, cvd diff) 符号相关性为负
 */

const express = require('express');
const { BinanceService } = require('../services/binance');
const {
  normalizeKlines,
  computeVWAP
} = require('../indicators/klineIndicators');
const { computeOrderBookIndicators } = require('../indicators/orderbookIndicators');
const { computeTradeIndicators } = require('../indicators/tradeIndicators');
const { computeIlliquidity } = require('../indicators/illiquidity');
const { mean, stdev, correlation } = require('../indicators/stats');

const router = express.Router();

// 内存型滚动 spread 样本缓存（按 symbol+market 分组）
// (Tiny in-memory rolling cache for spread samples per (symbol, market).)
const spreadHistory = new Map();
function pushSpreadSample(key, value, max = 20) {
  const arr = spreadHistory.get(key) || [];
  arr.push(value);
  while (arr.length > max) arr.shift();
  spreadHistory.set(key, arr);
  return arr;
}

router.get('/alerts/liquidity', async (req, res) => {
  try {
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    // 默认合约 (default to futures)
    const market = req.query.market === 'spot' ? 'spot' : 'futures';

    // 并行请求 K 线 / 订单簿 / 成交 / 日 K（用于 ILLIQ）
    // (Run all four data fetches in parallel.)
    const [klinesRaw, dailyRaw, book, trades] = await Promise.all([
      BinanceService.getKlines(symbol, '1h', 50, market),
      BinanceService.getKlines(symbol, '1d', 30, market),
      BinanceService.getOrderBook(symbol, 100, market),
      BinanceService.getAggTrades(symbol, 500, market)
    ]);

    const candles = normalizeKlines(klinesRaw);
    const dailyCandles = normalizeKlines(dailyRaw);
    const orderBook = computeOrderBookIndicators(book, 20, 0.1);
    const tradeMetrics = computeTradeIndicators(trades, market, 50);
    const illiqSeries = computeIlliquidity(dailyCandles);

    // 1. spread 异常 (spread shock)：3σ 滚动窗口
    const spreadSamples = pushSpreadSample(`${market}:${symbol}`, orderBook.spread || 0, 20);
    const spreadMean = mean(spreadSamples);
    const spreadStd = stdev(spreadSamples);
    const spreadShock =
      spreadSamples.length >= 5 && orderBook.spread > spreadMean + 3 * spreadStd;

    // 2. ILLIQ 暴增 (ILLIQ shock)
    const illiqValues = illiqSeries.map((d) => d.illiq);
    const illiqMean = mean(illiqValues);
    const latestIlliq = illiqValues[illiqValues.length - 1] || 0;
    const illiqShock = illiqMean > 0 && latestIlliq > 2 * illiqMean;

    // 3. 订单簿失衡 (depth imbalance)
    const depthImbalance = Math.abs(orderBook.depthRatio || 0) > 0.8;

    // 4. VWAP 偏离 > 2% (VWAP deviation)
    const vwap = computeVWAP(candles);
    const latestPrice = candles.length ? candles[candles.length - 1].close : null;
    const latestVwap = vwap.length ? vwap[vwap.length - 1] : null;
    const vwapDeviation =
      latestPrice && latestVwap
        ? Math.abs(latestPrice / latestVwap - 1) > 0.02
        : false;

    // 5. CVD 与价格背离 (CVD vs price divergence)：把 cvd 时序对齐到 K 线收盘
    // (Resample the cvd time-series onto candle close timestamps.)
    const cvdAtCandle = sampleCvdAtCandleClose(candles, tradeMetrics.cvdSeries);
    const recentN = Math.min(10, candles.length);
    const priceChanges = [];
    const cvdChanges = [];
    for (let i = candles.length - recentN + 1; i < candles.length; i += 1) {
      priceChanges.push(candles[i].close - candles[i - 1].close);
      cvdChanges.push(cvdAtCandle[i] - cvdAtCandle[i - 1]);
    }
    const corr = correlation(priceChanges, cvdChanges);
    const cvdPriceDivergence = corr < 0;

    const flags = {
      spreadShock,
      illiqShock,
      depthImbalance,
      vwapDeviation,
      cvdPriceDivergence
    };
    const riskScore = Object.values(flags).filter(Boolean).length;

    res.json({
      success: true,
      data: {
        symbol,
        market,
        flags,
        riskScore,
        details: {
          spread: orderBook.spread,
          spreadMean,
          spreadStd,
          depthRatio: orderBook.depthRatio,
          latestPrice,
          latestVwap,
          latestIlliq,
          illiqMean,
          cvdPriceCorrelation: corr,
          cvd: tradeMetrics.summary.finalCvd
        }
      }
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

/**
 * 把 CVD 序列采样到每根 K 线收盘时刻
 * (Compute the running CVD value aligned to each kline's closeTime.)
 */
function sampleCvdAtCandleClose(candles, cvdSeries) {
  const result = new Array(candles.length).fill(0);
  if (!cvdSeries.length) return result;
  let j = 0;
  let lastCvd = 0;
  for (let i = 0; i < candles.length; i += 1) {
    while (j < cvdSeries.length && cvdSeries[j].time <= candles[i].closeTime) {
      lastCvd = cvdSeries[j].value;
      j += 1;
    }
    result[i] = lastCvd;
  }
  return result;
}

module.exports = router;
