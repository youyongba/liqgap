'use strict';

/**
 * 扎空 / 扎多 分析 (Squeeze analytics)
 *
 * 三阶段流程 (Three-stage workflow):
 *   1. computeWarning(...)        – 预警评分 (early warning score)
 *   2. computeConfirmation(...)   – 确认逻辑 (confirmation logic)
 *   3. buildLiquidationHeatmap    – 把强平订单按价格分桶
 *                                   (cluster liquidation orders into buckets)
 *
 * 约定 (Convention):
 *   - 'SHORT_SQUEEZE'  -> 扎空：空头被挤   -> 价格上行 -> 顺向交易 LONG
 *   - 'LONG_SQUEEZE'   -> 扎多：多头被挤   -> 价格下行 -> 顺向交易 SHORT
 *   - score ∈ [-100, +100]
 *       正值 (positive) => SHORT_SQUEEZE 倾向
 *       负值 (negative) => LONG_SQUEEZE  倾向
 */

const { mean, stdev, clamp } = require('./stats');

/**
 * 计算预警评分及各分项 Z-score
 * (Compute the warning score and component Z-scores)
 *
 * @param {object} params
 * @param {Array}  params.fundingRate   /fapi/v1/fundingRate 原始数据
 * @param {Array}  params.oiHist        /futures/data/openInterestHist 原始数据
 * @param {Array}  params.topPosRatio   /futures/data/topLongShortPositionRatio
 * @param {Array}  params.takerVol      /futures/data/takerlongshortRatio
 *
 * @returns {
 *   squeezeRisk: 'SHORT_SQUEEZE' | 'LONG_SQUEEZE' | 'NONE',
 *   score:        number  // [-100, 100]
 *   components: {
 *     fundingRateZ:        number,   // 资金费率 Z-score
 *     oiChangePct:         number,   // OI 区间变化率
 *     positionRatioZ:      number,   // 大户多空持仓比 Z-score
 *     takerImbalance:      number    // (主动买-主动卖)/(主动买+主动卖)
 *   },
 *   snapshot: { latestFundingRate, latestOI, latestPositionRatio, ... }
 * }
 */
function computeWarning({ fundingRate = [], oiHist = [], topPosRatio = [], takerVol = [] } = {}) {
  // 1) 资金费率 Z-score
  //    资金费率为正 => 多头付空头 => 多头过度拥挤 => 潜在 LONG_SQUEEZE 风险
  //    (Positive funding rate (longs pay shorts) means crowded long
  //     => incoming long-squeeze risk, negative in our convention.)
  const frValues = fundingRate.map((f) => Number(f.fundingRate));
  const frLatest = frValues.length ? frValues[frValues.length - 1] : 0;
  const frMean = mean(frValues);
  const frStd = stdev(frValues);
  const fundingRateZ = frStd > 0 ? (frLatest - frMean) / frStd : 0;

  // 2) OI 变化率：从窗口最早值到最新值的相对变化
  //    (OI change pct between earliest and latest in the supplied window.)
  const oiValues = oiHist.map((o) => Number(o.sumOpenInterest));
  let oiChangePct = 0;
  if (oiValues.length >= 2) {
    const first = oiValues[0];
    const last = oiValues[oiValues.length - 1];
    if (first > 0) oiChangePct = (last - first) / first;
  }

  // 3) 大户多空持仓比 Z-score
  //    longShortRatio > 1 => 多头扎堆 (crowded long) => 极高时潜在 LONG_SQUEEZE
  const posValues = topPosRatio.map((p) => Number(p.longShortRatio));
  const posLatest = posValues.length ? posValues[posValues.length - 1] : 1;
  const posMean = mean(posValues);
  const posStd = stdev(posValues);
  const positionRatioZ = posStd > 0 ? (posLatest - posMean) / posStd : 0;

  // 4) Taker 主动买卖失衡度: (buyVol - sellVol) / (buyVol + sellVol)
  const tBuy = takerVol.length ? Number(takerVol[takerVol.length - 1].buyVol) : 0;
  const tSell = takerVol.length ? Number(takerVol[takerVol.length - 1].sellVol) : 0;
  const totalTaker = tBuy + tSell;
  const takerImbalance = totalTaker > 0 ? (tBuy - tSell) / totalTaker : 0;

  // 综合评分 (Composite scoring)
  // 直觉 (Reasoning):
  //   * SHORT_SQUEEZE 触发条件：
  //       - frZ < 0       => 资金费率偏低/为负 => 空头扎堆
  //       - posZ < 0      => 多空比极低，空头主导
  //       - takerImbalance > 0 => 近期主动买盘加剧
  //       - oiChangePct ↑ 同向放大
  //     => 净贡献为正 (positive score)
  //
  //   * LONG_SQUEEZE: 上述各项符号反转 (opposite signs)
  const fundingScore = -clamp(fundingRateZ, -3, 3) * 20; // fr 越低 => 分越高
  const oiScore = clamp(oiChangePct, -0.3, 0.3) * 100 * 0.5; // OI 是放大器
  const positionScore = -clamp(positionRatioZ, -3, 3) * 15; // 多头扎堆 => 分越低
  const takerScore = clamp(takerImbalance, -1, 1) * 25;     // 主动买 => 分越高

  // OI 当作放大器：跟随当前的方向倾向 (sign-follow amplifier).
  const directionalCore = fundingScore + positionScore + takerScore;
  const oiContribution = directionalCore >= 0 ? Math.abs(oiScore) : -Math.abs(oiScore);
  const score = clamp(directionalCore + oiContribution, -100, 100);

  let squeezeRisk = 'NONE';
  if (score >= 30) squeezeRisk = 'SHORT_SQUEEZE';
  else if (score <= -30) squeezeRisk = 'LONG_SQUEEZE';

  return {
    squeezeRisk,
    score: Number(score.toFixed(2)),
    components: {
      fundingRateZ: Number(fundingRateZ.toFixed(3)),
      oiChangePct: Number(oiChangePct.toFixed(4)),
      positionRatioZ: Number(positionRatioZ.toFixed(3)),
      takerImbalance: Number(takerImbalance.toFixed(4)),
      fundingScore: Number(fundingScore.toFixed(2)),
      oiScore: Number(oiContribution.toFixed(2)),
      positionScore: Number(positionScore.toFixed(2)),
      takerScore: Number(takerScore.toFixed(2))
    },
    snapshot: {
      latestFundingRate: frLatest,
      latestOI: oiValues.length ? oiValues[oiValues.length - 1] : null,
      latestPositionRatio: posLatest,
      latestTakerBuy: tBuy,
      latestTakerSell: tSell
    }
  };
}

/**
 * 判断是否正在发生 squeeze
 * (Determine if a squeeze is currently materialising)
 *
 * @param {object} p
 * @param {Array}  p.candles      规整后的 K 线 (latest at end)
 * @param {Array}  p.oiHist       近似与 K 线对齐的 OI 历史
 * @param {Array}  p.fundingRate  资金费率历史
 * @param {Array}  p.liquidations [{ side: 'BUY' | 'SELL', price, qty, time }]
 *                                'side' 指强平订单方向 —— SELL 表示多头被强平,
 *                                BUY 表示空头被强平。
 *
 * 启发式 (Heuristics):
 *   - 价格 / OI 背离 (Price/OI divergence):
 *       价↑ 且 OI↓ => 扎空确认 (short squeeze confirmed, shorts forced to close)
 *       价↓ 且 OI↓ => 扎多确认 (long  squeeze confirmed, longs  forced to close)
 *   - 强平方向占比 (Liquidation dominance):
 *       SELL 端 > 65% (多头被清) => LONG_SQUEEZE
 *       BUY  端 > 65% (空头被清) => SHORT_SQUEEZE
 *   - 资金费率从极端回归 (funding mean-reversion from extremes)
 *     作为第三层确认信号 (tertiary confirmation)。
 *
 * 置信度 (Confidence): 各确认项最多 +35 分，最高 100。
 */
function computeConfirmation({ candles = [], oiHist = [], fundingRate = [], liquidations = [] } = {}) {
  const out = {
    isSqueezeActive: false,
    type: 'NONE',
    confidence: 0,
    priceOiDivergence: null,
    liquidationDominance: null,
    fundingRevertingFromExtreme: false,
    stats: {}
  };

  // 1) 价格 / OI 背离投票 (Price / OI divergence vote)
  let priceChangePct = 0;
  if (candles.length >= 5) {
    const a = candles[candles.length - 5].close;
    const b = candles[candles.length - 1].close;
    if (a > 0) priceChangePct = (b - a) / a;
  }
  let oiChangePct = 0;
  if (oiHist.length >= 5) {
    const a = Number(oiHist[oiHist.length - 5].sumOpenInterest);
    const b = Number(oiHist[oiHist.length - 1].sumOpenInterest);
    if (a > 0) oiChangePct = (b - a) / a;
  }
  let divergenceVote = 'NONE';
  if (priceChangePct > 0.005 && oiChangePct < -0.01) divergenceVote = 'SHORT_SQUEEZE';
  else if (priceChangePct < -0.005 && oiChangePct < -0.01) divergenceVote = 'LONG_SQUEEZE';
  out.priceOiDivergence = divergenceVote !== 'NONE';
  out.stats.priceChangePct = Number(priceChangePct.toFixed(4));
  out.stats.oiChangePct = Number(oiChangePct.toFixed(4));

  // 2) 强平方向占比投票 (Liquidation dominance vote)
  // SELL 强平 (taker sell from forced liquidator) 关闭一笔 LONG。
  // BUY  强平 关闭一笔 SHORT。
  let longLiqQty = 0;
  let shortLiqQty = 0;
  for (const l of liquidations) {
    const qty = Number(l.origQty || l.qty || 0);
    const px = Number(l.price || l.avgPrice || 0);
    const notional = qty * (px || 1);
    const side = (l.side || '').toUpperCase();
    if (side === 'SELL') longLiqQty += notional;
    else if (side === 'BUY') shortLiqQty += notional;
  }
  const totalLiq = longLiqQty + shortLiqQty;
  let dominanceVote = 'NONE';
  if (totalLiq > 0) {
    const longShare = longLiqQty / totalLiq;
    if (longShare >= 0.65) dominanceVote = 'LONG_SQUEEZE';
    else if (longShare <= 0.35) dominanceVote = 'SHORT_SQUEEZE';
  }
  out.liquidationDominance = dominanceVote !== 'NONE' ? dominanceVote : null;
  out.stats.longLiqNotional = Number(longLiqQty.toFixed(2));
  out.stats.shortLiqNotional = Number(shortLiqQty.toFixed(2));
  out.stats.totalLiqNotional = Number(totalLiq.toFixed(2));

  // 3) 资金费率从极端回归 (Funding rate reverting from extreme):
  //    比较最近 3 周期均幅与之前 10 周期均幅。
  //    若幅度明显下降，说明极端资金费率开始降温。
  if (fundingRate.length >= 13) {
    const recent = fundingRate.slice(-3).map((f) => Math.abs(Number(f.fundingRate)));
    const prior = fundingRate.slice(-13, -3).map((f) => Math.abs(Number(f.fundingRate)));
    const recentMean = mean(recent);
    const priorMean = mean(prior);
    out.fundingRevertingFromExtreme = priorMean > 0 && recentMean < priorMean * 0.7;
    out.stats.recentFundingMagnitude = Number(recentMean.toFixed(6));
    out.stats.priorFundingMagnitude = Number(priorMean.toFixed(6));
  }

  // ---- 合并投票 (Merge votes) ----
  const votes = [];
  if (divergenceVote !== 'NONE') votes.push(divergenceVote);
  if (dominanceVote !== 'NONE') votes.push(dominanceVote);

  // 决出主导方向 (Determine the dominant type)
  if (votes.length) {
    const longCount = votes.filter((v) => v === 'LONG_SQUEEZE').length;
    const shortCount = votes.filter((v) => v === 'SHORT_SQUEEZE').length;
    if (longCount > shortCount) out.type = 'LONG_SQUEEZE';
    else if (shortCount > longCount) out.type = 'SHORT_SQUEEZE';
    else out.type = 'NONE';
  }

  let confidence = 0;
  if (out.priceOiDivergence) confidence += 35;
  if (out.liquidationDominance) confidence += 35;
  if (out.fundingRevertingFromExtreme && out.type !== 'NONE') confidence += 20;
  if (out.type !== 'NONE' && totalLiq > 0) confidence += 10; // 至少有数据 (any data)
  out.confidence = Math.min(100, confidence);
  out.isSqueezeActive = out.type !== 'NONE' && out.confidence >= 50;

  return out;
}

/**
 * 构建价格分桶强平热力图
 * (Build a price-bucketed liquidation heatmap)
 *
 * @param {object} p
 * @param {Array}  p.liquidations  原始强平订单
 * @param {number} p.currentPrice  当前价（用于划窗口与定位上下集群）
 * @param {number} p.buckets       默认 50
 * @param {number} p.windowPct     默认 0.05 (=±5% 当前价)
 *
 * 返回 (Returns):
 * {
 *   buckets: [
 *     { bucketIndex, priceLow, priceHigh,
 *       longLiqQty, shortLiqQty, totalQty, dominantSide }
 *   ],
 *   nearestLongCluster:  当前价下方最强多头爆仓桶 | null  // 做多止损参考
 *   nearestShortCluster: 当前价上方最强空头爆仓桶 | null  // 做空止损参考
 *   currentPrice,
 *   degraded: boolean   // true 表示无强平数据可用 (no liquidation data available)
 * }
 */
function buildLiquidationHeatmap({
  liquidations = [],
  currentPrice,
  buckets = 50,
  windowPct = 0.05,
  degraded = false
} = {}) {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return {
      buckets: [],
      nearestLongCluster: null,
      nearestShortCluster: null,
      currentPrice: currentPrice || null,
      degraded: degraded || true
    };
  }

  // 默认窗口 ±windowPct (Default heatmap window)
  let priceLow = currentPrice * (1 - windowPct);
  let priceHigh = currentPrice * (1 + windowPct);

  // 若有强平点超出窗口，则扩展边界
  // (Expand to enclose every available liquidation if any exceed the window.)
  for (const l of liquidations) {
    const p = Number(l.price || l.avgPrice || 0);
    if (p > 0) {
      if (p < priceLow) priceLow = p;
      if (p > priceHigh) priceHigh = p;
    }
  }

  const range = priceHigh - priceLow || 1;
  const step = range / buckets;
  const grid = new Array(buckets).fill(null).map((_, i) => ({
    bucketIndex: i,
    priceLow: priceLow + i * step,
    priceHigh: priceLow + (i + 1) * step,
    longLiqQty: 0,
    shortLiqQty: 0
  }));

  for (const l of liquidations) {
    const p = Number(l.price || l.avgPrice || 0);
    const q = Number(l.origQty || l.qty || 0);
    if (!p || !q) continue;
    let idx = Math.floor((p - priceLow) / step);
    if (idx < 0) idx = 0;
    if (idx >= buckets) idx = buckets - 1;
    const side = (l.side || '').toUpperCase();
    if (side === 'SELL') grid[idx].longLiqQty += q;     // 卖单强平 -> 多头被清
    else if (side === 'BUY') grid[idx].shortLiqQty += q; // 买单强平 -> 空头被清
  }

  for (const b of grid) {
    b.totalQty = b.longLiqQty + b.shortLiqQty;
    if (b.longLiqQty === b.shortLiqQty) b.dominantSide = 'flat';
    else b.dominantSide = b.longLiqQty > b.shortLiqQty ? 'long' : 'short';
  }

  // 选出当前价下方多头集群最强桶、上方空头集群最强桶
  // (Pick strongest same-side bucket strictly below / strictly above current price.)
  let nearestLongCluster = null;
  let nearestShortCluster = null;
  for (const b of grid) {
    const mid = (b.priceLow + b.priceHigh) / 2;
    if (mid < currentPrice && b.longLiqQty > 0) {
      if (!nearestLongCluster || b.longLiqQty > nearestLongCluster.longLiqQty) {
        nearestLongCluster = b;
      }
    }
    if (mid > currentPrice && b.shortLiqQty > 0) {
      if (!nearestShortCluster || b.shortLiqQty > nearestShortCluster.shortLiqQty) {
        nearestShortCluster = b;
      }
    }
  }

  return {
    buckets: grid,
    nearestLongCluster,
    nearestShortCluster,
    currentPrice,
    degraded
  };
}

module.exports = {
  computeWarning,
  computeConfirmation,
  buildLiquidationHeatmap
};
