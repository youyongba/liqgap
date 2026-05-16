'use strict';

/**
 * 成交量暴涨检测 (Volume Surge Detection)
 *
 * 给共振信号系统提供"放量确认" —— 主力推动 vs 散户噪音的区分指标。
 *
 * 核心思路：
 *   surge = 当前 5m bucket 成交量 / 过去 N 个 5m bucket 均值
 *   surge ≥ 2.0 → 强放量（默认阈值）
 *   surge ≥ 1.5 → 中放量
 *   surge < 1.0 → 缩量
 *
 * 注意时间窗选择：
 *   • 用 24h × 5m 聚合 (288 桶) 做均值基准，避开亚洲深夜时段拉低均值
 *   • 若样本不足 30 个，退化为 1h 1m 聚合
 */

/**
 * 计算当前成交量相对于历史均值的倍数
 *
 * @param {Array<{volume:number}>} candles5m  5m K 线序列（建议 ≥ 288 根 = 24h）
 * @param {number} [lookbackBuckets=288]      均值基准窗口
 * @param {object} [opts]
 * @param {number} [opts.minSamples=12]       最少样本数（不足则返回 null）
 * @param {boolean} [opts.excludeLatest=true] 计算均值时排除最新桶（避免自比）
 *
 * @returns {{
 *   latest: number,     // 最新桶成交量
 *   avg: number|null,   // 历史均值（per minute）
 *   surge: number|null, // latest / avg
 *   level: 'surge'|'mid'|'normal'|'low'|null
 * }}
 */
function computeVolumeSurge(candles5m, lookbackBuckets = 288, opts = {}) {
  const { minSamples = 12, excludeLatest = true } = opts;
  if (!Array.isArray(candles5m) || candles5m.length === 0) {
    return { latest: 0, avg: null, surge: null, level: null };
  }
  const latest = Number(candles5m[candles5m.length - 1].volume) || 0;
  // 用 per-minute 均值（5m volume / 5）避免 bucket 大小差异
  const baseSlice = excludeLatest ? candles5m.slice(-lookbackBuckets - 1, -1) : candles5m.slice(-lookbackBuckets);
  if (baseSlice.length < minSamples) {
    return { latest, avg: null, surge: null, level: null };
  }
  let sum = 0, n = 0;
  for (const c of baseSlice) {
    const v = Number(c.volume);
    if (Number.isFinite(v) && v >= 0) { sum += v; n += 1; }
  }
  if (n === 0) return { latest, avg: null, surge: null, level: null };
  const avgPerMinute = sum / n / 5;
  const latestPerMinute = latest / 5;
  const surge = avgPerMinute > 0 ? latestPerMinute / avgPerMinute : null;
  let level = null;
  if (surge != null) {
    if (surge >= 2.0) level = 'surge';
    else if (surge >= 1.5) level = 'mid';
    else if (surge >= 0.7) level = 'normal';
    else level = 'low';
  }
  return { latest, avg: avgPerMinute, surge, level };
}

/**
 * 简易判定：当前是否处于"显著放量"（默认阈值 ≥ 2×）
 */
function isVolumeSurging(candles5m, threshold = 2.0, lookbackBuckets = 288) {
  const r = computeVolumeSurge(candles5m, lookbackBuckets);
  return r.surge != null && r.surge >= threshold;
}

module.exports = {
  computeVolumeSurge,
  isVolumeSurging
};
