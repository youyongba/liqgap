'use strict';

/**
 * 成交量分布 (Volume Profile)
 *
 * 算法 (Strategy):
 *   把整体价格区间 [globalLow, globalHigh] 等分为 `buckets` 个桶。
 *   每根 K 线的成交量按其 [low, high] 区间相交的桶数等分摊，
 *   而不是简单地把整根 K 线的成交量丢到收盘价桶里 (more informative
 *   than naively dropping the whole volume into the close-price bucket)。
 *
 * 返回 (Returns):
 *   {
 *     buckets: [
 *       { bucketIndex, priceLow, priceHigh, volume, percent, isPOC }
 *     ],
 *     poc        : 成交量最大的桶 (Point of Control)
 *     vah        : 价值区间上沿 (Value Area High, ~70% volume cumulative)
 *     val        : 价值区间下沿 (Value Area Low)
 *     totalVolume: 总成交量
 *   }
 */
function computeVolumeProfile(candles, buckets = 100) {
  if (!candles.length) {
    return {
      buckets: [],
      poc: null,
      vah: null,
      val: null,
      totalVolume: 0
    };
  }

  // 取全局价格范围 (Find global price extents)
  let priceMin = Infinity;
  let priceMax = -Infinity;
  for (const c of candles) {
    if (c.low < priceMin) priceMin = c.low;
    if (c.high > priceMax) priceMax = c.high;
  }
  const range = priceMax - priceMin || 1;
  const step = range / buckets;

  const out = new Array(buckets).fill(null).map((_, i) => ({
    bucketIndex: i,
    priceLow: priceMin + i * step,
    priceHigh: priceMin + (i + 1) * step,
    volume: 0
  }));

  // 把每根 K 线成交量平均分摊到所跨桶 (Spread volume across spanned buckets)
  for (const c of candles) {
    const cRange = (c.high - c.low) || step;
    const startIdx = Math.max(0, Math.floor((c.low - priceMin) / step));
    const endIdx = Math.min(buckets - 1, Math.floor((c.high - priceMin) / step));
    if (startIdx === endIdx) {
      out[startIdx].volume += c.volume;
    } else {
      const slices = endIdx - startIdx + 1;
      const perSlice = c.volume / slices;
      for (let i = startIdx; i <= endIdx; i += 1) {
        out[i].volume += perSlice;
      }
    }
    void cRange; // 预留：将来按高低权重再细化 (reserved for weighted refinement)
  }

  const totalVolume = out.reduce((acc, b) => acc + b.volume, 0);
  // 找出 POC（Point of Control，成交量最大的桶）
  let pocIdx = 0;
  for (let i = 1; i < out.length; i += 1) {
    if (out[i].volume > out[pocIdx].volume) pocIdx = i;
  }

  for (let i = 0; i < out.length; i += 1) {
    out[i].percent = totalVolume > 0 ? (out[i].volume / totalVolume) * 100 : 0;
    out[i].isPOC = i === pocIdx;
  }

  // 价值区间 (~70%)：从 POC 向两侧扩展，直到累积成交量 >= 70%
  // (Value area: expand outward from POC while we're below 70%.)
  let upper = pocIdx;
  let lower = pocIdx;
  let acc = out[pocIdx].volume;
  const target = totalVolume * 0.7;
  while (acc < target && (lower > 0 || upper < buckets - 1)) {
    const upGain = upper < buckets - 1 ? out[upper + 1].volume : -1;
    const downGain = lower > 0 ? out[lower - 1].volume : -1;
    if (upGain >= downGain && upGain >= 0) {
      upper += 1;
      acc += upGain;
    } else if (downGain >= 0) {
      lower -= 1;
      acc += downGain;
    } else {
      break;
    }
  }

  return {
    buckets: out,
    poc: out[pocIdx],
    vah: out[upper].priceHigh,
    val: out[lower].priceLow,
    totalVolume
  };
}

/**
 * 识别 LVN (Low Volume Node)
 *
 * 拍卖市场理论 (Auction Market Theory) 里的"价格被拒绝"区域：
 *   - HVN (High Volume Node): 价格被接受，是公允区，price 倾向回到这里
 *   - LVN (Low Volume Node):  价格被拒绝，是真空带，价格穿过这里很快
 *
 * 实战价值：
 *   • 价格首次穿越 LVN → 快速通过（不翻转，~70% 概率）
 *   • 价格回测 LVN     → 翻转点（~65-80% 概率反弹/承压）
 *   • LVN + 清算主峰共振 → 反转高胜率区域
 *
 * 算法：
 *   1. 标记每个桶 isLVN = (volume < POC × lvnThresholdRatio)
 *   2. 过滤"价格区间两端的边缘 LVN"（因为最高/最低价附近自然成交少，不是真 LVN）
 *   3. 合并相邻 LVN 桶为 LVN zone（连续 N 个 LVN 桶 → 一个 zone）
 *   4. 计算每个 zone 的中心价、上下沿、强度（深度）
 *
 * @param {object} profile     computeVolumeProfile 的返回值（会被原地修改）
 * @param {object} [opts]
 * @param {number} [opts.lvnThresholdRatio=0.10]  LVN 阈值：volume < POC × 此比例
 * @param {number} [opts.edgeIgnoreRatio=0.05]    忽略价格区间两端 5% 的桶（避免边缘伪 LVN）
 * @param {number} [opts.minZoneBuckets=2]        连续 ≥ N 个 LVN 桶才算 zone（单桶噪声不算）
 * @param {boolean} [opts.requireSurroundedByHVN=true]
 *                                                 zone 上下必须都有 HVN（POC 的 50%）才算真 LVN
 * @returns {object} 同 profile，新增字段 isLVN（每桶）+ lvnZones（数组）
 */
function markLVN(profile, opts = {}) {
  const {
    lvnThresholdRatio = 0.10,
    edgeIgnoreRatio = 0.05,
    minZoneBuckets = 2,
    requireSurroundedByHVN = true
  } = opts;

  if (!profile || !profile.buckets || profile.buckets.length === 0 || !profile.poc) {
    if (profile) profile.lvnZones = [];
    return profile;
  }
  const buckets = profile.buckets;
  const n = buckets.length;
  const pocVol = profile.poc.volume || 0;
  const lvnThreshold = pocVol * lvnThresholdRatio;
  const hvnThreshold = pocVol * 0.5;
  const edge = Math.max(1, Math.floor(n * edgeIgnoreRatio));

  // 1. 标记每个桶 isLVN
  for (let i = 0; i < n; i += 1) {
    const isEdge = i < edge || i >= n - edge;
    buckets[i].isLVN = !isEdge && buckets[i].volume < lvnThreshold && buckets[i].volume > 0;
  }

  // 2. 合并连续 LVN 桶为 zone
  const rawZones = [];
  let runStart = -1;
  for (let i = 0; i < n; i += 1) {
    if (buckets[i].isLVN) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      rawZones.push({ startIdx: runStart, endIdx: i - 1 });
      runStart = -1;
    }
  }
  if (runStart >= 0) rawZones.push({ startIdx: runStart, endIdx: n - 1 });

  // 3. 过滤：长度 + 上下 HVN 包夹检查
  const zones = [];
  for (const z of rawZones) {
    const len = z.endIdx - z.startIdx + 1;
    if (len < minZoneBuckets) continue;

    if (requireSurroundedByHVN) {
      // 上方某个桶 ≥ HVN 阈值
      let hasUpperHVN = false;
      for (let i = z.endIdx + 1; i < n; i += 1) {
        if (buckets[i].volume >= hvnThreshold) { hasUpperHVN = true; break; }
      }
      // 下方某个桶 ≥ HVN 阈值
      let hasLowerHVN = false;
      for (let i = z.startIdx - 1; i >= 0; i -= 1) {
        if (buckets[i].volume >= hvnThreshold) { hasLowerHVN = true; break; }
      }
      if (!hasUpperHVN || !hasLowerHVN) continue;
    }

    const priceLow = buckets[z.startIdx].priceLow;
    const priceHigh = buckets[z.endIdx].priceHigh;
    const priceMid = (priceLow + priceHigh) / 2;
    // zone 深度：1 - (zone 平均 volume / POC volume)，越接近 1 越"空"
    let zoneSum = 0;
    for (let i = z.startIdx; i <= z.endIdx; i += 1) zoneSum += buckets[i].volume;
    const avgVol = zoneSum / len;
    const depth = pocVol > 0 ? 1 - avgVol / pocVol : 0;
    zones.push({
      startIdx: z.startIdx,
      endIdx: z.endIdx,
      priceLow,
      priceHigh,
      priceMid,
      bucketCount: len,
      avgVolume: avgVol,
      depth // 0~1，越大越"空"，越是真空带
    });
  }

  // 按 depth 降序（最强的 LVN 排前面）
  zones.sort((a, b) => b.depth - a.depth);
  profile.lvnZones = zones;
  return profile;
}

module.exports = {
  computeVolumeProfile,
  markLVN
};
