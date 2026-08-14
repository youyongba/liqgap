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
// 场景 1b：已失效（被击穿）的 FVG 要跳过，取最近仍有效的
// ---------------------------------------------------------------------------
console.log('\n[1b] _computeIntervalLevels · 失效 FVG 过滤');
{
  const t0 = 1700000000000;
  // 结构：先形成一个 bearish FVG [97,99]（c1.low=99 > c3.high=97），
  // 之后价格涨破 99 上方 → 该缺口失效；不再有其他 bearish FVG。
  const raw = mkRaw([
    [100, 101, 99, 100, 50],      // c1: low=99
    [98, 98.5, 96.5, 97, 80],     // c2
    [96.8, 97, 95.5, 96, 120],    // c3: high=97 < c1.low=99 → bearish FVG [97,99]
    [96, 97.5, 95.8, 97.2, 60],
    [97.2, 100.5, 97, 100, 70],   // 涨破 99（缺口上沿）→ FVG 失效 (filled)
    [100, 100.8, 99.6, 100.3, 90]
  ], 3600_000, t0);
  const r = kl._computeIntervalLevels('1h', raw);
  check('被击穿的看跌 FVG 不再返回', r.bearFvg === null);
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

// ---------------------------------------------------------------------------
// 场景 3：_computeObWalls —— 挂单墙（buy 墙在中价下方 / sell 墙在中价上方）
// ---------------------------------------------------------------------------
console.log('\n[3] _computeObWalls · 买/卖墙价位');
{
  const obRecorder = require('../services/orderbookRecorder.js');
  const origFindRange = obRecorder.findRange;
  try {
    const now = Date.now();
    const mid = 100;
    // 伪造 30 分钟快照：98 有一面持续的大买墙，103 有一面大卖墙
    const snaps = [];
    for (let i = 0; i < 30; i += 1) {
      const ts = now - (30 - i) * 60_000;
      snaps.push({
        ts,
        bids: [['99.5', '1'], ['98', '50'], ['97', '2']],
        asks: [['100.5', '1'], ['103', '40'], ['104', '2']]
      });
    }
    obRecorder.findRange = () => snaps;

    const walls = kl._computeObWalls('BTCUSDT', 'futures', mid);
    check('返回 4 个窗口', Array.isArray(walls) && walls.length === 4);
    const w1h = walls.find((w) => w.label === '1h');
    check('1h 买墙在中价下方且贴近 98', w1h && w1h.bidWall < mid && Math.abs(w1h.bidWall - 98) < 1);
    check('1h 卖墙在中价上方且贴近 103', w1h && w1h.askWall > mid && Math.abs(w1h.askWall - 103) < 1);
    check('买墙名义额 > 卖墙以外档位', w1h && w1h.bidUsd > 0 && w1h.askUsd > 0);

    // 无快照 → []
    obRecorder.findRange = () => [];
    check('无快照返回 []', kl._computeObWalls('ETHUSDT', 'futures', mid).length === 0);
  } finally {
    obRecorder.findRange = origFindRange;
  }
}

// ---------------------------------------------------------------------------
// 场景 4：_computeEntryZones —— 多因子聚类给出做多 / 做空开仓区
// ---------------------------------------------------------------------------
console.log('\n[4] _computeEntryZones · 建议开仓区');
{
  const px = 100;
  // 下方 97.2~97.8 有强共振（L↓ + 买墙 + 看涨FVG），上方 102.5 附近有 S↑ + 卖墙
  const input = {
    latestPrice: px,
    intervals: [
      {
        interval: '1h', ok: true,
        bullFvg: { lower: 97.2, upper: 97.6 },
        bearFvg: { lower: 102.4, upper: 102.8 },
        poc: { low: 99.0, high: 99.2 },   // 下方但离簇远（>0.5% gap）
        vwap: 120                          // 距现价 20% → 应被距离过滤
      }
    ],
    liqWindows: [
      { label: '24h', lMax: 97.5, sMax: 102.6 },
      { label: '15m', lMax: 91,   sMax: 109 }   // 9% 距离 → 过滤
    ],
    obWalls: [
      { label: '4h', bidWall: 97.8, askWall: 102.5 }
    ]
  };
  const z = kl._computeEntryZones(input);
  check('做多区间存在', z.long != null);
  check('做多区间覆盖 97.2~97.8', z.long && z.long.low <= 97.2 && z.long.high >= 97.8 - 1e-9);
  check('做多区间在现价下方', z.long && z.long.high < px);
  check('做多依据含 24h·L↓主峰', z.long && z.long.basis.includes('24h·L↓主峰'));
  check('做多依据不含 20% 外的 VWAP', z.long && !z.long.basis.some((b) => b.includes('VWAP')));
  check('做空区间存在且在现价上方', z.short != null && z.short.low > px);
  check('做空依据含 4h卖墙', z.short && z.short.basis.includes('4h卖墙'));

  // 共振不足：只有一个 15m VWAP → 分数 0.6 < 2.5 → null
  const weak = kl._computeEntryZones({
    latestPrice: px,
    intervals: [{ interval: '15m', ok: true, bullFvg: null, bearFvg: null, poc: null, vwap: 99.5 }],
    liqWindows: [],
    obWalls: []
  });
  check('共振不足返回 null', weak.long === null && weak.short === null);

  // 无现价 → 双 null
  const noPx = kl._computeEntryZones({ latestPrice: null, intervals: [], liqWindows: [], obWalls: [] });
  check('无现价返回双 null', noPx.long === null && noPx.short === null);
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
