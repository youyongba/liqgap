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
// 仓位"半衰期"：参考 CoinGlass 视觉效果——亮带形成后会持续到当前。
// 24h 让 1 天窗口内基本不衰减（cohesive bands），更长窗口仍按比例衰减。
// 因为我们用"中心归一化"高斯核，单格主峰不会被稀释，所以更长 halfLife
// 不会让阈值过滤失效。
// 可通过 LIQ_HALF_LIFE_HOURS env 覆盖。
const DECAY_HALF_LIFE_MS = (() => {
  const v = Number(process.env.LIQ_HALF_LIFE_HOURS);
  return Number.isFinite(v) && v > 0 ? v * 3600_000 : 24 * 3600_000;
})();
// 价格扩散：CoinGlass 的亮带是"线条感"而不是"色块感"——主峰只占 1~2 桶宽，
// 相邻清算价位互相独立、清晰可分。所以默认 ±1 桶（共 3 格），中心 = 1，
// 邻居只有 ~0.3 的弱光晕（让"细线"看起来不是 1px 锯齿，但也不会糊成块）。
// 可通过 LIQ_PRICE_SPREAD_BUCKETS env 调节，需要更连续的视觉可设 2~3。
const DEFAULT_PRICE_SPREAD_BUCKETS = (() => {
  const v = Number(process.env.LIQ_PRICE_SPREAD_BUCKETS);
  return Number.isFinite(v) && v >= 0 && v <= 10 ? Math.floor(v) : 1;
})();
// 时间平滑：默认关闭。开启会让相邻时间桶的强度互相溢出，把多条独立的
// 清算线"焊"成一大块色团，丢失 CoinGlass 那种"清晰线条"的辨识度。
// 时间方向的连续性已经由 ti 累加机制 + 24h 半衰期保证。
// 可通过 LIQ_TIME_SMOOTH=1 强制开启。
const ENABLE_TIME_SMOOTH = process.env.LIQ_TIME_SMOOTH === '1';

// 关键：中心归一化（中心=1）而不是总和归一化。
// - 总和归一化会把中心权重压到 ~0.2（spread=2），让"主峰"被稀释 80%，
//   threshold=0.85 下整张图直接消失。
// - 中心归一化让中心格的累加强度与"旧算法"完全一致（向后兼容），
//   相邻格仅获得附赠（k=±1 ~0.75，k=±2 ~0.32），保证：
//     * threshold=0.85 仍能筛出主峰横线（不丢信号）
//     * threshold=0.6  能看到 ±2 桶的"粗连续亮带"（视觉连续性）
function _gaussianWeights(spread) {
  if (!(spread > 0)) return [1];
  // sigma 收紧：spread=1 时邻居 ~0.14，spread=2 时 ±1=~0.61 / ±2=~0.14。
  // 这样"线"中心高亮、边缘快速衰减，才是 CoinGlass 那种"清晰细线"的视觉。
  // 之前 sigma = spread/1.5 让邻居 0.32~0.93，反而把线"涂宽"成色块。
  const sigma = Math.max(0.4, spread / 2.5);
  const out = [];
  for (let k = -spread; k <= spread; k += 1) {
    out.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  }
  // 中心 = 1（不做总和归一化）
  const center = out[spread] || 1;
  if (center > 0) for (let i = 0; i < out.length; i += 1) out[i] /= center;
  return out;
}

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
  const spreadBuckets = Number.isFinite(opts.priceSpreadBuckets)
    ? Math.max(0, Math.min(10, Math.floor(opts.priceSpreadBuckets)))
    : DEFAULT_PRICE_SPREAD_BUCKETS;
  const spreadWeights = _gaussianWeights(spreadBuckets);

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
      // 同时把贡献按高斯核扩散到 piLong±spreadBuckets 个相邻价位，
      // 这样相邻 K 线的清算线在视觉上能连成一条粗带。
      if (longContrib > 0) {
        let w = 1;
        for (let ti = tiStart; ti < tCount; ti += 1) {
          for (let s = -spreadBuckets; s <= spreadBuckets; s += 1) {
            const pIdx = piLong + s;
            if (pIdx < 0 || pIdx >= pCount) continue;
            const sw = spreadWeights[s + spreadBuckets];
            const cell = longMatrix[ti][pIdx] + longContrib * w * sw;
            longMatrix[ti][pIdx] = cell;
            if (cell > maxValue) maxValue = cell;
          }
          w *= decayPerBucket;
          if (w < 1e-4) break;
        }
      }
      if (shortContrib > 0) {
        let w = 1;
        for (let ti = tiStart; ti < tCount; ti += 1) {
          for (let s = -spreadBuckets; s <= spreadBuckets; s += 1) {
            const pIdx = piShort + s;
            if (pIdx < 0 || pIdx >= pCount) continue;
            const sw = spreadWeights[s + spreadBuckets];
            const cell = shortMatrix[ti][pIdx] + shortContrib * w * sw;
            shortMatrix[ti][pIdx] = cell;
            if (cell > maxValue) maxValue = cell;
          }
          w *= decayPerBucket;
          if (w < 1e-4) break;
        }
      }
    }
  }

  // 时间方向 3-tap horizontal smoothing：消除"段"边界，模拟 CoinGlass
  // 那种"水平亮带从产生时间起就连续延伸"的视觉。kernel = [0.25, 0.5, 0.25]，
  // 等同于一次 box blur。只对每个价位行做平滑，主峰强度保持。
  // 平滑后会重算 maxValue，避免渲染时归一化偏差。
  if (ENABLE_TIME_SMOOTH && tCount >= 3) {
    const blur = (matrix) => {
      for (let pi = 0; pi < pCount; pi += 1) {
        const prev = new Array(tCount);
        for (let ti = 0; ti < tCount; ti += 1) prev[ti] = matrix[ti][pi];
        for (let ti = 1; ti < tCount - 1; ti += 1) {
          matrix[ti][pi] = 0.25 * prev[ti - 1] + 0.5 * prev[ti] + 0.25 * prev[ti + 1];
        }
        // 边界格按 2-tap 处理，保留信号
        matrix[0][pi]          = 0.66 * prev[0] + 0.34 * prev[1];
        matrix[tCount - 1][pi] = 0.66 * prev[tCount - 1] + 0.34 * prev[tCount - 2];
      }
    };
    blur(longMatrix);
    blur(shortMatrix);
    // 重算 maxValue（平滑后峰值会略下降）
    maxValue = 0;
    for (let ti = 0; ti < tCount; ti += 1) {
      for (let pi = 0; pi < pCount; pi += 1) {
        if (longMatrix[ti][pi]  > maxValue) maxValue = longMatrix[ti][pi];
        if (shortMatrix[ti][pi] > maxValue) maxValue = shortMatrix[ti][pi];
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
    halfLifeMs: halfLife,
    priceSpreadBuckets: spreadBuckets
  };
}

module.exports = {
  buildPredictiveLiquidationHeatmap,
  DEFAULT_MMR,
  DECAY_HALF_LIFE_MS
};
