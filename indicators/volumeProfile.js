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

module.exports = {
  computeVolumeProfile
};
