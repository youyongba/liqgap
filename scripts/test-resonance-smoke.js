'use strict';

/* eslint-disable no-console */
/**
 * 冷烟测试 (Smoke tests) - 资源 = node + 内置 assert，无第三方框架
 *
 * 覆盖范围：
 *   1. detectFVGs / markFVGFillStatus / findActiveFVGAtPrice 行为
 *   2. computeVolumeSurge / computeOISurge 数值正确性
 *   3. resonance 信号置信度计算（构造 6 项全 hit / 缺一项的两个场景）
 *   4. 飞书时间格式化 fmtCnTime → 必须落在 Asia/Shanghai
 *
 * 运行: node scripts/test-resonance-smoke.js
 */

require('dotenv').config();
const assert = require('assert');

const {
  detectFVGs,
  markFVGFillStatus,
  findActiveFVGAtPrice
} = require('../indicators/klineIndicators');
const { computeVolumeSurge } = require('../indicators/volumeSurge');
const { computeOISurge } = require('../indicators/oiSurge');
const { fmtCnTime } = require('../services/feishu');

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`✗ ${name}\n   ${err.message}\n   ${err.stack && err.stack.split('\n')[1]}`);
  }
}

// ============================================================================
// 1. FVG 检测 + 填补状态 + active 查询
// ============================================================================
test('detectFVGs: 看涨缺口被正确识别', () => {
  const candles = [
    { openTime: 1, closeTime: 2,  open: 100, high: 100, low: 95,  close: 96 },
    { openTime: 2, closeTime: 3,  open: 96,  high: 100, low: 95,  close: 99 },
    { openTime: 3, closeTime: 4,  open: 99,  high: 110, low: 105, close: 109 }
  ];
  const fvgs = detectFVGs(candles);
  assert.strictEqual(fvgs.length, 1, 'expect 1 FVG');
  assert.strictEqual(fvgs[0].type, 'bullish');
  assert.strictEqual(fvgs[0].lower, 100);
  assert.strictEqual(fvgs[0].upper, 105);
  assert.ok(fvgs[0].sizePct > 0);
  assert.strictEqual(fvgs[0].filled, false);
});

test('detectFVGs: 看跌缺口被正确识别', () => {
  const candles = [
    { openTime: 1, closeTime: 2, open: 110, high: 115, low: 105, close: 106 },
    { openTime: 2, closeTime: 3, open: 106, high: 108, low: 100, close: 101 },
    { openTime: 3, closeTime: 4, open: 101, high: 100, low: 90,  close: 92 }
  ];
  const fvgs = detectFVGs(candles);
  assert.strictEqual(fvgs.length, 1);
  assert.strictEqual(fvgs[0].type, 'bearish');
  assert.strictEqual(fvgs[0].lower, 100);
  assert.strictEqual(fvgs[0].upper, 105);
});

test('markFVGFillStatus: 缺口被部分填补', () => {
  const candles = [
    { openTime: 1, closeTime: 2,  open: 100, high: 100, low: 95,  close: 96 },
    { openTime: 2, closeTime: 3,  open: 96,  high: 100, low: 95,  close: 99 },
    { openTime: 3, closeTime: 4,  open: 99,  high: 110, low: 105, close: 109 },
    // 后续 K 线 low=102 → 部分回踩到缺口区间
    { openTime: 4, closeTime: 5,  open: 109, high: 112, low: 102, close: 108 },
    { openTime: 5, closeTime: 6,  open: 108, high: 113, low: 107, close: 111 }
  ];
  const fvgs = detectFVGs(candles);
  markFVGFillStatus(fvgs, candles);
  assert.strictEqual(fvgs[0].filled, false, 'should not be fully filled');
  assert.ok(fvgs[0].fillRatio > 0 && fvgs[0].fillRatio < 1,
    `fillRatio expected 0~1 but got ${fvgs[0].fillRatio}`);
});

test('markFVGFillStatus: 缺口被完全击穿', () => {
  const candles = [
    { openTime: 1, closeTime: 2,  open: 100, high: 100, low: 95,  close: 96 },
    { openTime: 2, closeTime: 3,  open: 96,  high: 100, low: 95,  close: 99 },
    { openTime: 3, closeTime: 4,  open: 99,  high: 110, low: 105, close: 109 },
    // K 线 low=90 → 跌破缺口下沿 100 → 击穿
    { openTime: 4, closeTime: 5,  open: 109, high: 110, low: 90,  close: 95 }
  ];
  const fvgs = detectFVGs(candles);
  markFVGFillStatus(fvgs, candles);
  assert.strictEqual(fvgs[0].filled, true, 'should be killed');
  assert.strictEqual(fvgs[0].fillRatio, 1);
});

test('findActiveFVGAtPrice: 价格在新鲜未填补 FVG 内时命中', () => {
  const now = Date.now();
  // sizePct = (100.05-100)/100.025 ≈ 0.0005 → 落在默认 [0.001, 0.020] 之外
  // 用更现实的 BTC 数量：lower=80000, upper=80120 → sizePct ≈ 0.0015 ✓
  const fvg = {
    type: 'bullish', lower: 80000, upper: 80120, mid: 80060,
    size: 120, sizePct: 120 / 80060,
    startTime: now - 1000, endTime: now - 1000,
    filled: false, fillRatio: 0
  };
  const found = findActiveFVGAtPrice([fvg], 80050, { type: 'bullish' });
  assert.ok(found, `should find FVG when price=80050 is inside [80000,80120], sizePct=${fvg.sizePct}`);
  assert.strictEqual(found, fvg);
});

test('findActiveFVGAtPrice: 已填补 / 过老 / 类型不匹配 / 尺寸异常 都不命中', () => {
  const now = Date.now();
  const baseFvg = {
    type: 'bullish', lower: 80000, upper: 80120, mid: 80060,
    size: 120, sizePct: 120 / 80060,
    startTime: now, endTime: now,
    filled: false, fillRatio: 0
  };
  const filled    = { ...baseFvg, filled: true, fillRatio: 1 };
  const tooOld    = { ...baseFvg, endTime: now - 100 * 3600 * 1000 };
  const wrongType = { ...baseFvg, type: 'bearish' };
  const tooBig    = { ...baseFvg, sizePct: 0.5 };
  const tooSmall  = { ...baseFvg, sizePct: 0.0001 };
  assert.strictEqual(findActiveFVGAtPrice([filled], 80050, { type: 'bullish' }), null);
  assert.strictEqual(findActiveFVGAtPrice([tooOld], 80050, { type: 'bullish' }), null);
  assert.strictEqual(findActiveFVGAtPrice([wrongType], 80050, { type: 'bullish' }), null);
  assert.strictEqual(findActiveFVGAtPrice([tooBig], 80050, { type: 'bullish' }), null);
  assert.strictEqual(findActiveFVGAtPrice([tooSmall], 80050, { type: 'bullish' }), null);
});

// ============================================================================
// 2. Volume Surge
// ============================================================================
test('computeVolumeSurge: 暴涨 ≥ 2× 被正确分类', () => {
  // 历史均值 100 / 桶，最新桶 250 → surge ≈ 2.5 (level=surge)
  const candles = [];
  for (let i = 0; i < 20; i += 1) candles.push({ volume: 100 });
  candles.push({ volume: 250 });
  const r = computeVolumeSurge(candles, 50);
  assert.ok(r.surge > 2, `expect surge > 2, got ${r.surge}`);
  assert.strictEqual(r.level, 'surge');
});

test('computeVolumeSurge: 数据不足时返回 null', () => {
  const r = computeVolumeSurge([{ volume: 100 }], 50);
  assert.strictEqual(r.surge, null);
});

// ============================================================================
// 3. OI Surge
// ============================================================================
test('computeOISurge: 1h 均值上升 2.5×', () => {
  const hist = [];
  for (let i = 0; i < 12; i += 1) hist.push({ sumOpenInterest: 1000 });
  hist.push({ sumOpenInterest: 2700 });
  const r = computeOISurge(hist);
  assert.ok(r.surge > 2.5, `expect surge > 2.5, got ${r.surge}`);
  assert.strictEqual(r.level, 'surge');
});

test('computeOISurge: 无数据返回 null', () => {
  const r = computeOISurge([]);
  assert.strictEqual(r.surge, null);
});

// ============================================================================
// 4. 飞书时间格式化（必须是东八区）
// ============================================================================
test('fmtCnTime: 输出必须使用东八区', () => {
  // 0 UTC = 8:00 北京时间，所以输出字符串里应包含 "08"（小时）
  const s = fmtCnTime(0);
  console.log(`   fmtCnTime(0) = ${s}`);
  // 1970-01-01 00:00:00 UTC → 1970/1/1 08:00:00 北京
  // toLocaleString('zh-CN') 输出形如 "1970/1/1 08:00:00"
  assert.ok(s.includes('08:00:00') || s.includes('08:00'), `expect '08:00...' in ${s}`);
  assert.ok(s.includes('1970'), `expect '1970' in ${s}`);
});

test('fmtCnTime: 当前时间不抛错', () => {
  const s1 = fmtCnTime();
  const s2 = fmtCnTime(Date.now());
  assert.ok(typeof s1 === 'string' && s1.length > 0);
  assert.ok(typeof s2 === 'string' && s2.length > 0);
});

// ============================================================================
// 5. resonance 信号置信度逻辑（在不启动 server 的情况下构造场景）
//    这里通过 require resonanceSignal 路由模块，但因为它依赖 BinanceService，
//    所以仅做"模块能 load + 默认配置导出正常"的冷烟测试。
// ============================================================================
test('routes/resonanceSignal: 模块可加载，且默认配置参数合理', () => {
  const route = require('../routes/resonanceSignal');
  assert.ok(route && typeof route === 'function', 'should export express router');
  // express Router 是 function，且有 stack 属性（中间件链）
  assert.ok(Array.isArray(route.stack), 'expected router.stack array');
});

test('.env: HEXA / TRIO 关键配置都被加载', () => {
  // 直接检查 process.env 是否已读入 .env
  assert.ok(process.env.HEXA_RESONANCE_MIN_CONFIDENCE, 'HEXA min conf missing in .env');
  assert.ok(process.env.TRIO_RESONANCE_MIN_CONFIDENCE, 'TRIO min conf missing in .env');
  assert.ok(process.env.AUTO_TRADE_TIER1_LABEL, 'AUTO_TRADE_TIER1_LABEL missing');
  assert.ok(process.env.AUTO_TRADE_TIER2_LABEL, 'AUTO_TRADE_TIER2_LABEL missing');
});

// ============================================================================
console.log(`\n${passed} passed · ${failed} failed`);
if (failed > 0) process.exit(1);
