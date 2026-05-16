'use strict';

/**
 * 持仓量暴涨检测 (Open Interest Surge Detection)
 *
 * OI = Open Interest（未平仓合约总量），是衡量"新仓位是否在大量增加"的核心指标。
 *
 * 应用场景：
 *   • REVERSAL 信号：OI **不**暴涨 → 价格触墙是被动反弹，没人在加空 → 反转概率高
 *   • SQUEEZE 信号：OI 暴涨 → 大量新仓位加入推动价格穿越清算簇 → 顺势追单
 *   • SWEEP_REJECT 信号：OI 仍高位 → 清算簇被扫后未平仓 → 反向力量蓄积
 *
 * 算法：
 *   latest  = 最新 OI 值（sumOpenInterest）
 *   mean1h  = 最近 12 个 5m bucket 均值（即 1h 均值）
 *   surge   = latest / mean1h
 *
 *   surge ≥ 2.5 → 强暴涨（默认 SQUEEZE 触发阈值）
 *   surge ≥ 1.5 → 中等增加
 *   surge < 1.2 → 平稳
 */

/**
 * 从 Binance OI 历史响应中计算 surge 倍数
 *
 * @param {Array<{sumOpenInterest:number|string}>} oiHist  最近 N 条 OI 样本（5m 粒度）
 * @param {object} [opts]
 * @param {number} [opts.baselineBuckets=12]  均值基准桶数（默认 12 × 5m = 1h）
 *
 * @returns {{
 *   latest: number|null,
 *   mean: number|null,
 *   surge: number|null,    // latest / mean
 *   level: 'surge'|'mid'|'flat'|null
 * }}
 */
function computeOISurge(oiHist, opts = {}) {
  const { baselineBuckets = 12 } = opts;
  if (!Array.isArray(oiHist) || oiHist.length === 0) {
    return { latest: null, mean: null, surge: null, level: null };
  }
  const values = oiHist
    .map((d) => Number(d.sumOpenInterest))
    .filter((v) => Number.isFinite(v) && v > 0);
  if (values.length === 0) return { latest: null, mean: null, surge: null, level: null };
  const latest = values[values.length - 1];
  const baseSlice = values.length >= baselineBuckets + 1
    ? values.slice(-baselineBuckets - 1, -1)
    : values.slice(0, -1);
  let mean = null;
  if (baseSlice.length > 0) {
    let s = 0;
    for (const v of baseSlice) s += v;
    mean = s / baseSlice.length;
  }
  const surge = mean && mean > 0 ? latest / mean : null;
  let level = null;
  if (surge != null) {
    if (surge >= 2.5) level = 'surge';
    else if (surge >= 1.5) level = 'mid';
    else level = 'flat';
  }
  return { latest, mean, surge, level };
}

/**
 * 判定 OI 是否"显著上升"（默认阈值 1.5×）
 */
function isOIRising(oiHist, threshold = 1.5) {
  const r = computeOISurge(oiHist);
  return r.surge != null && r.surge >= threshold;
}

/**
 * 判定 OI 是否"暴涨"（默认阈值 2.5×，SQUEEZE 触发用）
 */
function isOISurging(oiHist, threshold = 2.5) {
  const r = computeOISurge(oiHist);
  return r.surge != null && r.surge >= threshold;
}

module.exports = {
  computeOISurge,
  isOIRising,
  isOISurging
};
