'use strict';

/**
 * 基于 K 线的指标 (K-line based indicators):
 *  - normalizeKlines        : 把 Binance 原始数组转换成对象 (raw arrays -> structured candles)
 *  - computeVWAP            : 累积量价加权均价 (volume-weighted average price)
 *  - computeMFI             : 资金流量指数 (Money Flow Index, period=14)
 *  - computeATR             : 平均真实波幅 (Average True Range, period=14)
 *  - detectFVGs             : 公允价值缺口识别 (Fair Value Gap detection)
 *  - detectLiquidityVoids   : 流动性空白区识别 (low-overlap consolidation areas)
 */

/**
 * 把 Binance K 线原始数组规整成对象数组
 * (Normalize Binance kline arrays to typed objects)
 *
 * Binance kline 字段顺序 (schema):
 *   [ openTime, open, high, low, close, volume,
 *     closeTime, quoteAssetVolume, trades,
 *     takerBuyBase, takerBuyQuote, ignore ]
 */
function normalizeKlines(rawKlines) {
  return rawKlines.map((k) => ({
    openTime: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime: Number(k[6]),
    quoteVolume: Number(k[7]),
    trades: Number(k[8]),
    takerBuyBase: Number(k[9]),
    takerBuyQuote: Number(k[10])
  }));
}

/**
 * 累积 VWAP (Cumulative VWAP)
 *   tp   = (high + low + close) / 3              // 典型价格 (typical price)
 *   VWAP = Σ(tp * volume) / Σ(volume)
 * 返回与 candles 一一对应的 running VWAP 数组。
 * (Returns an array of running VWAP values aligned with `candles`.)
 */
function computeVWAP(candles) {
  let cumPV = 0;
  let cumVol = 0;
  return candles.map((c) => {
    const tp = (c.high + c.low + c.close) / 3;
    cumPV += tp * c.volume;
    cumVol += c.volume;
    return cumVol > 0 ? cumPV / cumVol : tp;
  });
}

/**
 * 资金流量指数 (Money Flow Index, period=14)
 *   rawMoneyFlow_i = tp_i * volume_i
 *   tp_i > tp_{i-1} -> 正向资金流 (positive flow)
 *   tp_i < tp_{i-1} -> 负向资金流 (negative flow)
 *   moneyRatio     = Σpositive / Σnegative
 *   MFI            = 100 - 100 / (1 + moneyRatio)
 * 前 `period` 个返回 null。
 * (First `period` entries are null since they are unstable.)
 */
function computeMFI(candles, period = 14) {
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  const rmf = candles.map((c, i) => tp[i] * c.volume);
  const result = new Array(candles.length).fill(null);

  for (let i = period; i < candles.length; i += 1) {
    let posFlow = 0;
    let negFlow = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      if (j === 0) continue;
      if (tp[j] > tp[j - 1]) posFlow += rmf[j];
      else if (tp[j] < tp[j - 1]) negFlow += rmf[j];
    }
    if (negFlow === 0) {
      result[i] = 100;
    } else {
      const ratio = posFlow / negFlow;
      result[i] = 100 - 100 / (1 + ratio);
    }
  }
  return result;
}

/**
 * 平均真实波幅 (Average True Range, default period=14)
 *   TR_i = max(high-low, |high-prevClose|, |low-prevClose|)
 *   ATR  = period 内 TR 的简单移动平均 (SMA)
 */
function computeATR(candles, period = 14) {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose)
    );
  });
  const atr = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i += 1) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j += 1) sum += tr[j];
    atr[i] = sum / period;
  }
  return atr;
}

/**
 * 公允价值缺口识别 (Fair Value Gap detection · 三根 K 线窗口)
 *  - 看涨缺口 (Bullish FVG): candle[i].high   < candle[i+2].low
 *  - 看跌缺口 (Bearish FVG): candle[i].low    > candle[i+2].high
 * 每个缺口包含上下边界、所在中间 K 线索引、起止时间，方便前端绘图。
 * (Each gap records [lower, upper] price boundary,
 *  midpoint candle index, and timestamps for plotting.)
 */
function detectFVGs(candles) {
  const gaps = [];
  for (let i = 0; i < candles.length - 2; i += 1) {
    const c1 = candles[i];
    const c3 = candles[i + 2];
    if (c1.high < c3.low) {
      gaps.push({
        type: 'bullish',
        lower: c1.high,
        upper: c3.low,
        startTime: c1.openTime,
        endTime: c3.closeTime,
        index: i + 1
      });
    } else if (c1.low > c3.high) {
      gaps.push({
        type: 'bearish',
        lower: c3.high,
        upper: c1.low,
        startTime: c1.openTime,
        endTime: c3.closeTime,
        index: i + 1
      });
    }
  }
  return gaps;
}

/**
 * 流动性空白区识别 (Liquidity void detection)
 *   连续 ≥ minLength 根 K 线，影线区间整体重合度高于 0.5%
 *   (consecutive runs whose wick ranges overlap within ~0.5% of mid price)。
 *   这种紧密整理的区域代表"无成交、价格通过时阻力小"的真空带，
 *   一旦突破，价格往往快速穿越。
 *   (Such tight consolidations represent zones where little trading
 *    activity will resist a future price move.)
 */
function detectLiquidityVoids(candles, minLength = 5, overlapPct = 0.005) {
  const voids = [];
  let runStart = 0;
  let runHigh = candles[0] ? candles[0].high : 0;
  let runLow = candles[0] ? candles[0].low : 0;

  // 当一段 run 结束时检查是否够长 (Flush the current run if long enough)
  function flushRun(endExclusive) {
    const length = endExclusive - runStart;
    if (length >= minLength) {
      const mid = (runHigh + runLow) / 2 || 1;
      const range = (runHigh - runLow) / mid;
      if (range <= overlapPct) {
        voids.push({
          startIndex: runStart,
          endIndex: endExclusive - 1,
          startTime: candles[runStart].openTime,
          endTime: candles[endExclusive - 1].closeTime,
          lower: runLow,
          upper: runHigh,
          length
        });
      }
    }
  }

  for (let i = 1; i < candles.length; i += 1) {
    const c = candles[i];
    const newHigh = Math.max(runHigh, c.high);
    const newLow = Math.min(runLow, c.low);
    const mid = (newHigh + newLow) / 2 || 1;
    const range = (newHigh - newLow) / mid;
    if (range <= overlapPct) {
      runHigh = newHigh;
      runLow = newLow;
    } else {
      flushRun(i);
      runStart = i;
      runHigh = c.high;
      runLow = c.low;
    }
  }
  flushRun(candles.length);
  return voids;
}

module.exports = {
  normalizeKlines,
  computeVWAP,
  computeMFI,
  computeATR,
  detectFVGs,
  detectLiquidityVoids
};
