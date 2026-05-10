'use strict';

/**
 * 预测性清算热力图算法 (Predictive Liquidation Heatmap)
 *
 * CoinGlass 风格的"潜在清算热图"——不是真实发生的强平，而是基于历史 K 线
 * 反推出的"如果价格走到这里，会触发的清算估算量"。
 *
 * 思路 (Approach)：
 *   1. 对每根 K 线 (粒度 1m / 5m)，根据成交额估算"当时新开的仓位"。
 *   2. 把成交分摊到几档常见杠杆 (10x / 25x / 50x / 100x / 125x) 上，
 *      每档按经验权重切分；权重之和 = 1。
 *   3. taker buy / sell 比例近似多 / 空仓位的开仓比例。
 *   4. 对每档杠杆：
 *        多头清算价 ≈ open × (1 - 1/lev + mmr)
 *        空头清算价 ≈ open × (1 + 1/lev - mmr)
 *      mmr = 维持保证金率 (Maintenance Margin Rate)，BTC 永续约 0.4~0.5%。
 *   5. 把"清算线"从开仓时间一直延续到当前 (cumulative 累加到所有未来时间桶)，
 *      再做时间衰减让远古的仓位不会过度堆积。
 *
 * 局限 (Limitations)：
 *   - 这是经验估算模型，不是真实持仓；杠杆分布、留仓时间都是假设。
 *   - 不知道仓位什么时候被平掉，简化为"按时间衰减"近似活跃仓位。
 *   - 但这跟 CoinGlass 的算法在直觉上一致，输出形态接近。
 */

// 杠杆桶 + 权重 (Leverage buckets and weights, sum=1)
// 权重参考社区经验值；可通过环境变量调整：LEV_WEIGHTS=10:0.05,25:0.20,...
function _readLeverageBuckets() {
  const raw = process.env.LEV_WEIGHTS;
  if (!raw) {
    return [
      { lev: 10,  weight: 0.05 },
      { lev: 25,  weight: 0.20 },
      { lev: 50,  weight: 0.30 },
      { lev: 100, weight: 0.30 },
      { lev: 125, weight: 0.15 }
    ];
  }
  const out = [];
  for (const seg of raw.split(',')) {
    const [lev, w] = seg.split(':').map(Number);
    if (Number.isFinite(lev) && lev > 1 && Number.isFinite(w) && w > 0) {
      out.push({ lev, weight: w });
    }
  }
  // 归一化
  const sum = out.reduce((a, b) => a + b.weight, 0);
  if (sum > 0) out.forEach((b) => { b.weight /= sum; });
  return out.length ? out : [
    { lev: 25, weight: 0.5 }, { lev: 50, weight: 0.3 }, { lev: 100, weight: 0.2 }
  ];
}

const DEFAULT_MMR = 0.005;       // 0.5% 维持保证金（BTC 永续大致水平）
const DECAY_HALF_LIFE_MS = 8 * 3600_000; // 仓位"半衰期"：8h 后强度衰减一半

/**
 * @param {Array<{openTime,close,volume,takerBuyBase}>} candles
 * @param {{
 *   fromMs:number, toMs:number, bucketMs:number,
 *   priceMin:number, priceMax:number, priceBucket:number,
 *   mmr?:number, halfLifeMs?:number, leverageBuckets?:Array
 * }} opts
 */
function buildPredictiveLiquidationHeatmap(candles, opts) {
  const { fromMs, toMs, bucketMs, priceMin, priceMax, priceBucket } = opts;
  const mmr = Number.isFinite(opts.mmr) ? opts.mmr : DEFAULT_MMR;
  const halfLife = Number.isFinite(opts.halfLifeMs) ? opts.halfLifeMs : DECAY_HALF_LIFE_MS;
  const leverages = opts.leverageBuckets || _readLeverageBuckets();

  const tCount = Math.max(1, Math.ceil((toMs - fromMs) / bucketMs));
  const pCount = Math.max(1, Math.ceil((priceMax - priceMin) / priceBucket));
  const times = new Array(tCount);
  for (let i = 0; i < tCount; i += 1) times[i] = fromMs + i * bucketMs;
  const prices = new Array(pCount);
  for (let j = 0; j < pCount; j += 1) prices[j] = priceMin + j * priceBucket;

  const longMatrix  = new Array(tCount);
  const shortMatrix = new Array(tCount);
  for (let i = 0; i < tCount; i += 1) {
    longMatrix[i]  = new Array(pCount).fill(0);
    shortMatrix[i] = new Array(pCount).fill(0);
  }

  // 衰减系数：weight(t) = exp(-ln2 × (t - t_open) / halfLifeMs)
  // 预先按时间桶差预算好衰减因子表，避免内层循环算 exp。
  const ln2 = Math.log(2);
  const decayPerBucket = Math.exp(-ln2 * bucketMs / halfLife);

  let candleCount = 0;
  let totalLong = 0;
  let totalShort = 0;
  let maxValue = 0;

  for (const c of candles) {
    const open = Number(c.openTime);
    const close = Number(c.close);
    const vol = Number(c.volume);
    const takerBuy = Number(c.takerBuyBase);
    if (!Number.isFinite(open) || !Number.isFinite(close) || close <= 0 || !(vol > 0)) continue;
    if (open > toMs) continue;

    const tiStart = Math.max(0, Math.floor((open - fromMs) / bucketMs));
    if (tiStart >= tCount) continue;
    candleCount += 1;

    const longShare  = Number.isFinite(takerBuy) && vol > 0 ? Math.max(0, Math.min(1, takerBuy / vol)) : 0.5;
    const shortShare = 1 - longShare;
    const notional = vol * close;

    for (const { lev, weight } of leverages) {
      const longLiqPrice  = close * (1 - 1 / lev + mmr);
      const shortLiqPrice = close * (1 + 1 / lev - mmr);

      const piLong  = Math.floor((longLiqPrice  - priceMin) / priceBucket);
      const piShort = Math.floor((shortLiqPrice - priceMin) / priceBucket);

      const longContrib  = notional * longShare  * weight;
      const shortContrib = notional * shortShare * weight;
      totalLong  += longContrib;
      totalShort += shortContrib;

      // 从 tiStart 一直累加到 tCount-1，每过一个桶 × decay。
      // 用 running weight 避免循环里调用 Math.pow / Math.exp。
      if (piLong >= 0 && piLong < pCount && longContrib > 0) {
        let w = 1;
        for (let ti = tiStart; ti < tCount; ti += 1) {
          longMatrix[ti][piLong] += longContrib * w;
          if (longMatrix[ti][piLong] > maxValue) maxValue = longMatrix[ti][piLong];
          w *= decayPerBucket;
          if (w < 1e-4) break; // 衰减到极小直接截断
        }
      }
      if (piShort >= 0 && piShort < pCount && shortContrib > 0) {
        let w = 1;
        for (let ti = tiStart; ti < tCount; ti += 1) {
          shortMatrix[ti][piShort] += shortContrib * w;
          if (shortMatrix[ti][piShort] > maxValue) maxValue = shortMatrix[ti][piShort];
          w *= decayPerBucket;
          if (w < 1e-4) break;
        }
      }
    }
  }

  return {
    times, prices,
    longMatrix, shortMatrix,
    maxValue,
    totalLong, totalShort,
    candleCount,
    leverageBuckets: leverages,
    mmr,
    halfLifeMs: halfLife
  };
}

module.exports = {
  buildPredictiveLiquidationHeatmap,
  DEFAULT_MMR,
  DECAY_HALF_LIFE_MS
};
