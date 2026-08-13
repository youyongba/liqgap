'use strict';

const express = require('express');
const { BinanceLive: BinanceService } = require('../services/binanceLive');
const { normalizeKlines, detectFVGs } = require('../indicators/klineIndicators');
const { computeVolumeProfile } = require('../indicators/volumeProfile');
const { getStatus: getRecorderStatus, findRange } = require('../services/orderbookRecorder');
const { buildPredictiveLiquidationHeatmap } = require('../services/predictiveLiquidations');

const router = express.Router();

const PERIODS = [
  { label: '15m', windowMs: 15 * 60000, klineInterval: '15m' },
  { label: '1h', windowMs: 60 * 60000, klineInterval: '1h' },
  { label: '4h', windowMs: 4 * 60 * 60000, klineInterval: '4h' },
  { label: '24h', windowMs: 24 * 60 * 60000, klineInterval: '1h' } // use 1h for 24h K-lines to get more granular VWAP/FVG
];

function computeVWAP(candles) {
  let sumPV = 0;
  let sumV = 0;
  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    const vol = c.volume;
    sumPV += typicalPrice * vol;
    sumV += vol;
  }
  return sumV > 0 ? sumPV / sumV : null;
}

function findClosestFVGs(fvgs, currentPrice) {
  let closestBullish = null;
  let closestBearish = null;
  for (const f of fvgs) {
    if (f.type === 'bullish' && f.upper < currentPrice) {
      if (!closestBullish || f.upper > closestBullish.upper) closestBullish = f;
    }
    if (f.type === 'bearish' && f.lower > currentPrice) {
      if (!closestBearish || f.lower < closestBearish.lower) closestBearish = f;
    }
  }
  return { bullish: closestBullish, bearish: closestBearish };
}

function getMaxWalls(snapshots, fromMs) {
  let maxBid = 0;
  let maxBidPrice = null;
  let maxAsk = 0;
  let maxAskPrice = null;

  for (const snap of snapshots) {
    if (snap.timestamp < fromMs) continue;
    if (snap.bids && snap.bids.length > 0) {
      for (const [p, q] of snap.bids) {
        if (q > maxBid) { maxBid = q; maxBidPrice = p; }
      }
    }
    if (snap.asks && snap.asks.length > 0) {
      for (const [p, q] of snap.asks) {
        if (q > maxAsk) { maxAsk = q; maxAskPrice = p; }
      }
    }
  }
  return { maxBidPrice, maxAskPrice };
}

router.get('/key-levels', async (req, res) => {
  try {
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    const market = req.query.market === 'spot' ? 'spot' : 'futures';
    const now = Date.now();
    
    // We'll fetch orderbook snapshots inside the loop for each period
    const results = [];

    // run in parallel to speed up
    await Promise.all(PERIODS.map(async (p) => {
      try {
        // Klines for VWAP, FVG, POC
        const limit = p.label === '24h' ? 24 : 100;
        const raw = await BinanceService.getKlines(symbol, p.klineInterval, limit, market);
        const candles = normalizeKlines(raw);
        
        const currentPrice = candles.length > 0 ? candles[candles.length - 1].close : 0;
        
        const vwap = computeVWAP(candles);
        const profile = computeVolumeProfile(candles, 100);
        const poc = profile && profile.poc ? (profile.poc.priceLow + profile.poc.priceHigh) / 2 : null;
        
        const fvgs = detectFVGs(candles);
        const { bullish, bearish } = findClosestFVGs(fvgs, currentPrice);
        
        // Orderbook Max Walls
        const fromMs = now - p.windowMs;
        const snaps = findRange(symbol, market, fromMs, now);
        const walls = getMaxWalls(snaps, fromMs);
        
        // Predictive Liq Max
        let maxLongLiqPrice = null;
        let maxShortLiqPrice = null;
        try {
          const auto = { '15m': {s:'1m', b:60000}, '1h': {s:'1m', b:60000}, '4h': {s:'1m', b:120000}, '24h': {s:'5m', b:900000} }[p.label];
          const rawLiq = await BinanceService.getKlines(symbol, auto.s, Math.ceil(p.windowMs / (auto.s === '1m'?60000:300000)) + 5, 'futures');
          const liqCandles = normalizeKlines(rawLiq).filter(c => c.openTime >= fromMs);
          const liqHeatmap = buildPredictiveLiquidationHeatmap(liqCandles, auto.b);
          
          let maxLongLiq = 0;
          let maxShortLiq = 0;
          const prices = liqHeatmap.prices;
          const T = liqHeatmap.times.length;
          const P = prices.length;
          for (let ti = 0; ti < T; ti++) {
            for (let pi = 0; pi < P; pi++) {
              const lv = liqHeatmap.longMatrix[ti][pi] || 0;
              const sv = liqHeatmap.shortMatrix[ti][pi] || 0;
              if (lv > maxLongLiq) { maxLongLiq = lv; maxLongLiqPrice = prices[pi]; }
              if (sv > maxShortLiq) { maxShortLiq = sv; maxShortLiqPrice = prices[pi]; }
            }
          }
        } catch (e) {
          console.error('Liq error for period', p.label, ':', e.message);
        }

        results.push({
          period: p.label,
          order: PERIODS.indexOf(p),
          bullishFVG: bullish ? (bullish.upper + bullish.lower)/2 : null,
          bearishFVG: bearish ? (bearish.upper + bearish.lower)/2 : null,
          poc,
          vwap,
          maxBidWall: walls.maxBidPrice,
          maxAskWall: walls.maxAskPrice,
          maxLongLiq: maxLongLiqPrice,
          maxShortLiq: maxShortLiqPrice
        });
      } catch (err) {
        console.error('Error processing period', p.label, ':', err.message);
      }
    }));

    results.sort((a, b) => a.order - b.order);

    res.json({ success: true, data: results });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;