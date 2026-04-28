'use strict';

/**
 * 通用统计工具，被指标 / 预警 / 信号模块共用。
 * (Basic statistical helpers used across indicators / alerts / signals.)
 */

// 算术平均 (Arithmetic mean)
function mean(values) {
  if (!values.length) return 0;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

// 样本标准差 (Sample standard deviation, n-1)
function stdev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) ** 2;
  return Math.sqrt(acc / (values.length - 1));
}

/**
 * 皮尔逊相关系数 (Pearson correlation between two equal-length arrays)
 * 当分母为 0 时返回 0 (returns 0 when denominator is zero)。
 */
function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const aMean = mean(a.slice(0, n));
  const bMean = mean(b.slice(0, n));
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - aMean;
    const db = b[i] - bMean;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return 0;
  return cov / Math.sqrt(varA * varB);
}

// 把 x 限制在 [lo, hi] 之间 (Clamp x into [lo, hi])
function clamp(x, lo, hi) {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

module.exports = { mean, stdev, correlation, clamp };
