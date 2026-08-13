'use strict';

/**
 * 关键价位聚合接口冒烟测试
 * (Smoke tests for routes/keyLevels.js helpers · 离线，不需要网络)
 *
 * 运行 (Run): node scripts/test-key-levels-smoke.js
 */

const kl = require('../routes/keyLevels.js');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.error(`  ✗ ${name}`); }
}

// 构造原始 Binance K 线数组（openTime, o, h, l, c, vol, closeTime, quoteVol...）
function mkRaw(rows, stepMs, t0) {
  let t = t0;
  return rows.map(([o, h, l, c, v]) => {
    const row = [t, String(o), String(h), String(l), String(c), String(v ?? 100), t + stepMs - 1, String((v ?? 100) * c), 10, '0', '0', '0'];
    t += stepMs;
    return row;
  });
}

// ---------------------------------------------------------------------------
// 场景 1：_computeIntervalLevels —— FVG / POC / VWAP 提取
// ---------------------------------------------------------------------------
console.log('\n[1] _computeIntervalLevels · FVG/POC/VWAP');
{
  const t0 = 1700000000000;
  // 6 根：中间制造一个 bullish FVG（c1.high=101 < c3.low=103）
  const raw = mkRaw([
    [100, 101, 99, 100.5, 50],
    [102, 104, 101.5, 103.5, 80],
    [103.5, 105, 103, 104, 120],   // c3.low=103 > c1.high=101 → bullish FVG [101,103]
    [104, 104.5, 103.2, 103.8, 60],
    [103.8, 104.2, 103.4, 104, 70],
    [104, 104.8, 103.9, 104.5, 90]
  ], 3600_000, t0);
  const r = kl._computeIntervalLevels('1h', raw);
  check('ok=true', r.ok === true);
  check('检出看涨 FVG [101,103]', r.bullFvg && r.bullFvg.lower === 101 && r.bullFvg.upper === 103);
  check('VWAP 为有限数值', Number.isFinite(r.vwap));
  check('POC 有区间', r.poc && Number.isFinite(r.poc.low) && Number.isFinite(r.poc.high));
  const r2 = kl._computeIntervalLevels('4h', mkRaw([[100, 101, 99, 100]], 14400_000, t0));
  check('K 线不足时 ok=false', r2.ok === false);
}

// ---------------------------------------------------------------------------
// 场景 2：_computeWindowPeaks —— 清算主峰（S↑ 在上方 / L↓ 在下方）
// ---------------------------------------------------------------------------
console.log('\n[2] _computeWindowPeaks · 主峰位于现价两侧');
{
  const now = Date.now();
  const stepMs = 60_000;
  const n = 60;
  const t0 = now - n * stepMs;
  // 一段先涨后跌的行情，中间制造清算堆积
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const base = 100 + Math.sin(i / 8) * 3 + i * 0.02;
    rows.push([base, base + 0.6, base - 0.6, base + (i % 2 ? 0.3 : -0.3), 100 + (i % 7) * 40]);
  }
  const raw = mkRaw(rows, stepMs, t0);
  const { normalizeKlines } = require('../indicators/klineIndicators.js');
  const candles = normalizeKlines(raw);
  const mid = Number(candles[candles.length - 1].close);
  const win = { label: '1h', ms: 3600_000, src: '1m', srcMs: 60_000, bucketMs: 60_000 };
  const peaks = kl._computeWindowPeaks(candles, win, mid, now);
  check('返回 peaks 对象', peaks != null);
  check('L↓ 在现价下方', !peaks.peakLong || peaks.peakLong.price < mid);
  check('S↑ 在现价上方', !peaks.peakShort || peaks.peakShort.price > mid);
  check('至少一侧有主峰', !!(peaks.peakLong || peaks.peakShort));

  // K 线不足 → null
  const few = candles.slice(-2);
  check('K 线不足返回 null', kl._computeWindowPeaks(few, win, mid, now) === null);
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
