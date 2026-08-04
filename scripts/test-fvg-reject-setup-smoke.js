'use strict';

/**
 * FVG 假突破形态检测冒烟测试
 * (Smoke tests for findFvgRejectSetup in routes/signal.js.)
 *
 * 运行 (Run): node scripts/test-fvg-reject-setup-smoke.js
 */

const detect = require('../routes/signal.js')._findFvgRejectSetup;

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.error(`  ✗ ${name}`); }
}

// 构造 K 线工具：openTime 按小时递增
function mkCandles(rows) {
  let t = 1700000000000;
  return rows.map(([open, high, low, close]) => {
    const c = { openTime: t, closeTime: t + 3599999, open, high, low, close };
    t += 3600000;
    return c;
  });
}

// ---------------------------------------------------------------------------
// 场景 1：做空 —— 上方看跌 FVG（102~104），价格冲入(高点103)又跌回 99
// ---------------------------------------------------------------------------
console.log('\n[1] FVG_REJECT_SHORT · CVD↑ + OI↑ + 打进上方看跌FVG又跌回');
{
  const candles = mkCandles([
    [105, 106, 104.5, 105], // i0 (c1: low=104.5)
    [104, 104.8, 103, 103.5], // i1 (FVG 中间棒)
    [102, 102.5, 101, 101.5], // i2 (c3: high=102.5 < 104.5? 是 → bearish FVG [102.5, 104.5], index=1)
    [101, 101.5, 100, 100.5], // i3
    [100.5, 103.0, 100, 102.8], // i4 冲入 FVG（high 103 ≥ 下沿 102.5）
    [102.5, 102.9, 98.5, 99.0]  // i5 跌回下方（close 99 < 102.5）
  ]);
  const fvgs = [{ type: 'bearish', lower: 102.5, upper: 104.5, index: 1, startTime: candles[0].openTime, endTime: candles[2].closeTime }];
  const r = detect({ fvgs, candles, latestPrice: 99.0, cvdTrendUp: true, oiRising: true });
  check('检出 SHORT', r && r.side === 'SHORT' && r.name === 'FVG_REJECT_SHORT');
  check('锚定正确的 FVG', r && r.fvg.lower === 102.5 && r.fvg.upper === 104.5);

  // 同形态但 OI 没涨 → 不触发
  const r2 = detect({ fvgs, candles, latestPrice: 99.0, cvdTrendUp: true, oiRising: false });
  check('OI 未上涨时不触发', r2 === null);

  // 同形态但 CVD 下跌（走的是做多分支）→ 不触发做空
  const r3 = detect({ fvgs, candles, latestPrice: 99.0, cvdTrendUp: false, oiRising: true });
  check('CVD 下跌时不给做空', r3 === null);

  // 价格还停在 FVG 里（未跌回）→ 不触发
  const r4 = detect({ fvgs, candles, latestPrice: 103.0, cvdTrendUp: true, oiRising: true });
  check('价格未跌回 FVG 下方时不触发', r4 === null);
}

// ---------------------------------------------------------------------------
// 场景 2：做多 —— 下方看涨 FVG（96~98），价格下探(低点97)又收回 101
// ---------------------------------------------------------------------------
console.log('\n[2] FVG_RECLAIM_LONG · CVD↓ + OI↑ + 打进下方看涨FVG又收回');
{
  const candles = mkCandles([
    [95, 96, 94, 95.5],   // i0 (c1: high=96)
    [97, 98.5, 96.5, 98], // i1 (中间棒)
    [98.5, 99.5, 98, 99], // i2 (c3: low=98 > 96 → bullish FVG [96, 98], index=1)
    [99.5, 100.5, 99, 100],  // i3
    [100, 100.2, 97.0, 97.5], // i4 下探进 FVG（low 97 ≤ 上沿 98）
    [97.8, 101.5, 97.5, 101.0] // i5 收回上方（close 101 > 98）
  ]);
  const fvgs = [{ type: 'bullish', lower: 96, upper: 98, index: 1, startTime: candles[0].openTime, endTime: candles[2].closeTime }];
  const r = detect({ fvgs, candles, latestPrice: 101.0, cvdTrendUp: false, oiRising: true });
  check('检出 LONG', r && r.side === 'LONG' && r.name === 'FVG_RECLAIM_LONG');
  check('锚定正确的 FVG', r && r.fvg.lower === 96 && r.fvg.upper === 98);

  // 价格还在 FVG 下方（没收回）→ 不触发
  const r2 = detect({ fvgs, candles, latestPrice: 97.0, cvdTrendUp: false, oiRising: true });
  check('价格未收回 FVG 上方时不触发', r2 === null);
}

// ---------------------------------------------------------------------------
// 场景 3：触发必须发生在 FVG 形成之后（不能拿形成 FVG 的三根自己当触发）
// ---------------------------------------------------------------------------
console.log('\n[3] FVG 形成后才算触发 · 陈旧触发不算');
{
  // 看跌 FVG 在末尾刚形成（index=4，形成于 i5），之后没有任何 K 线冲入过
  const candles = mkCandles([
    [110, 111, 109, 110],
    [109, 110, 108, 108.5],
    [108, 109, 107, 107.5],
    [107, 108, 106.5, 107], // i3 (c1: low=106.5)
    [106, 106.8, 105, 105.5], // i4 (中间棒)
    [104, 104.5, 103, 103.5]  // i5 (c3: high=104.5 < 106.5 → bearish FVG [104.5,106.5] index=4)
  ]);
  const fvgs = [{ type: 'bearish', lower: 104.5, upper: 106.5, index: 4, startTime: candles[3].openTime, endTime: candles[5].closeTime }];
  const r = detect({ fvgs, candles, latestPrice: 103.5, cvdTrendUp: true, oiRising: true });
  check('形成 FVG 的三根自身不算触发', r === null);
}

// ---------------------------------------------------------------------------
// 场景 4：瞬间插针（同一根 K 线冲入又收回）也算触发
// ---------------------------------------------------------------------------
console.log('\n[4] 瞬间插针 · 同一根冲入又收回');
{
  const candles = mkCandles([
    [105, 106, 104.5, 105],
    [104, 104.8, 103, 103.5],
    [102, 102.5, 101, 101.5], // bearish FVG [102.5, 104.5] index=1
    [101, 101.5, 100, 100.5],
    [100.5, 101, 99.8, 100.2],
    [100.2, 103.2, 99.0, 99.5] // 当前棒：插针 high 103.2 打进 FVG，收 99.5 回到下方
  ]);
  const fvgs = [{ type: 'bearish', lower: 102.5, upper: 104.5, index: 1, startTime: candles[0].openTime, endTime: candles[2].closeTime }];
  const r = detect({ fvgs, candles, latestPrice: 99.5, cvdTrendUp: true, oiRising: true });
  check('插针触发也检出 SHORT', r && r.side === 'SHORT');
}

// ---------------------------------------------------------------------------
// 场景 5：多个候选取离当前价最近的 FVG
// ---------------------------------------------------------------------------
console.log('\n[5] 多候选取最近的 FVG');
{
  const candles = mkCandles([
    [100, 100.5, 99.5, 100],
    [100, 100.5, 99.5, 100],
    [100, 100.5, 99.5, 100],
    [100, 100.5, 99.5, 100],
    [100, 108.0, 99.5, 107],  // 一根大阳冲进两个上方 FVG
    [107, 107.5, 98.0, 99.0]  // 跌回
  ]);
  const fvgs = [
    { type: 'bearish', lower: 105, upper: 107, index: 1, startTime: 0, endTime: 0 },
    { type: 'bearish', lower: 102, upper: 104, index: 2, startTime: 0, endTime: 0 }
  ];
  const r = detect({ fvgs, candles, latestPrice: 99.0, cvdTrendUp: true, oiRising: true });
  check('取下沿离当前价最近的 FVG (102~104)', r && r.fvg.lower === 102);
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
