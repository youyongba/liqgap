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
 *
 * 每个缺口包含：
 *  - lower / upper: 缺口上下边界
 *  - mid: 缺口中线
 *  - sizePct: 相对中线的尺寸百分比（用于过滤太小/太大的噪音缺口）
 *  - filled: 是否被后续 K 线完全穿透（穿透 = 缺口失效）
 *  - fillRatio: 0~1，0=完全未被触碰，1=完全填补
 *  - startTime / endTime: 起止时间戳
 *  - index: 中间 K 线索引
 */
function detectFVGs(candles) {
  const gaps = [];
  for (let i = 0; i < candles.length - 2; i += 1) {
    const c1 = candles[i];
    const c3 = candles[i + 2];
    if (c1.high < c3.low) {
      const lower = c1.high, upper = c3.low;
      const size = upper - lower;
      const mid = (upper + lower) / 2;
      gaps.push({
        type: 'bullish',
        lower, upper, mid, size,
        sizePct: mid > 0 ? size / mid : 0,
        startTime: c1.openTime,
        endTime: c3.closeTime,
        index: i + 1,
        filled: false,
        fillRatio: 0
      });
    } else if (c1.low > c3.high) {
      const lower = c3.high, upper = c1.low;
      const size = upper - lower;
      const mid = (upper + lower) / 2;
      gaps.push({
        type: 'bearish',
        lower, upper, mid, size,
        sizePct: mid > 0 ? size / mid : 0,
        startTime: c1.openTime,
        endTime: c3.closeTime,
        index: i + 1,
        filled: false,
        fillRatio: 0
      });
    }
  }
  return gaps;
}

/**
 * 标记 FVG 是否被后续 K 线填补 / 失效
 *  - filled = true: 缺口被价格完全穿透（反方向击穿） → 缺口失效
 *  - fillRatio: 最大触碰深度（0=未触碰，1=完全填补到对面边界）
 *
 * Bullish FVG（在价格下方的看涨缺口）：
 *   "填补" = 后续 K 线 low 触及缺口区间 [lower, upper]
 *   "击穿" = 后续 K 线 low 跌破缺口下沿 lower 以下
 *
 * Bearish FVG（在价格上方的看跌缺口）：镜像
 *
 * 修改 fvgs 数组原地，并返回该数组（链式调用方便）。
 */
function markFVGFillStatus(fvgs, candles) {
  if (!Array.isArray(fvgs) || !Array.isArray(candles)) return fvgs || [];
  // 用 closeTime 倒查 K 线索引（避免 O(n²) 全表扫）
  const closeIdx = new Map();
  candles.forEach((c, i) => closeIdx.set(Number(c.closeTime), i));
  for (const fvg of fvgs) {
    const formedIdx = closeIdx.get(Number(fvg.endTime));
    if (formedIdx == null) continue;
    let maxRatio = 0;
    let killed = false;
    for (let i = formedIdx + 1; i < candles.length; i += 1) {
      const k = candles[i];
      if (!Number.isFinite(k.high) || !Number.isFinite(k.low)) continue;
      if (fvg.type === 'bullish') {
        // 进入缺口区间
        if (k.low <= fvg.upper && k.low >= fvg.lower) {
          const r = (fvg.upper - k.low) / fvg.size;
          if (r > maxRatio) maxRatio = r;
        }
        // 击穿下沿 = 缺口失效
        if (k.low < fvg.lower) { killed = true; maxRatio = 1; break; }
      } else {
        if (k.high >= fvg.lower && k.high <= fvg.upper) {
          const r = (k.high - fvg.lower) / fvg.size;
          if (r > maxRatio) maxRatio = r;
        }
        if (k.high > fvg.upper) { killed = true; maxRatio = 1; break; }
      }
    }
    fvg.filled = killed || maxRatio >= 0.999;
    fvg.fillRatio = Math.min(1, Math.max(0, maxRatio));
  }
  return fvgs;
}

/**
 * 找出当前价格"正在测试"的未填补 FVG（用于入场信号）。
 *
 * @param {Array} fvgs              已标记 fill 状态的 FVG 列表
 * @param {number} price            当前价格
 * @param {object} opts
 *  - opts.maxAgeMs                 FVG 最大年龄（毫秒），太老的不要
 *  - opts.minSizePct / maxSizePct  尺寸过滤（避免噪音和异常）
 *  - opts.maxFillRatio             已填补超过此比例视为消耗殆尽
 *  - opts.tolerancePct             "正在测试"的边界容差（默认 0.001 = 0.1%）
 *  - opts.type                     'bullish' / 'bearish' / 'any' (默认 'any')
 *
 * @returns {object|null} 命中的 FVG，否则 null
 */
function findActiveFVGAtPrice(fvgs, price, opts = {}) {
  if (!Array.isArray(fvgs) || !Number.isFinite(price)) return null;
  const now = Date.now();
  const {
    maxAgeMs = 4 * 60 * 60 * 1000,
    minSizePct = 0.001,
    maxSizePct = 0.020,
    maxFillRatio = 0.5,
    tolerancePct = 0.001,
    type = 'any'
  } = opts;
  const tol = price * tolerancePct;
  // 候选打分：优先选 fillRatio 最小（最新鲜）、尺寸最合理的
  let best = null;
  let bestScore = -Infinity;
  for (const f of fvgs) {
    if (f.filled) continue;
    if (f.fillRatio > maxFillRatio) continue;
    if (type !== 'any' && f.type !== type) continue;
    if (now - f.endTime > maxAgeMs) continue;
    if (f.sizePct < minSizePct || f.sizePct > maxSizePct) continue;
    // 价格在 [lower - tol, upper + tol] 内视为"正在测试"
    if (price < f.lower - tol || price > f.upper + tol) continue;
    // 评分：新鲜度 + 未填补度 + 尺寸适中
    const age = (now - f.endTime) / maxAgeMs;
    const score = (1 - f.fillRatio) * 2 + (1 - age) - Math.abs(Math.log(f.sizePct / 0.005));
    if (score > bestScore) { bestScore = score; best = f; }
  }
  return best;
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
  markFVGFillStatus,
  findActiveFVGAtPrice,
  detectLiquidityVoids
};
