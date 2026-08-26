'use strict';

/* eslint-disable no-console */
/**
 * CVD 24h 突破监控 (cvdBreakoutAlert) 冒烟测试
 *
 * 覆盖：
 *   1. 最新累计值 > 窗口内此前最高 → direction='high'
 *   2. 最新累计值 < 窗口内此前最低 → direction='low'
 *   3. 在高低点之间 → direction=null
 *   4. 覆盖率守卫：样本不足窗口一半 → 返回 null 不误报
 *   5. 推送闸门：启动首轮只建基线；同方向冷却；不同方向互不阻塞
 *   6. 卡片结构：标题/颜色/关键字段齐全
 *
 * 运行：node scripts/test-cvd-breakout-smoke.js
 */

require('dotenv').config();
const path = require('path');
const assert = require('assert');

const svc = require(path.join(__dirname, '..', 'services', 'cvdBreakoutAlert'));

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log(`✓ ${name}`); })
    .catch((err) => { failed += 1; console.error(`✗ ${name}\n   ${err.message}`); });
}

const H = 3_600_000;
const M5 = 300_000;
const OPTS = { windowMs: 24 * H, intervalMs: M5, measure: 'usd' };

// 生成 24h 整窗（288 根 5m）的 delta 序列：先给一段“基准形状”，
// 末根 delta 由调用方指定，用来精确控制突破方向。
function _series(lastDelta, shape) {
  const now = Date.now();
  const bars = 288;
  const out = [];
  for (let i = 0; i < bars; i += 1) {
    const t = now - (bars - 1 - i) * M5;
    let d;
    if (i === bars - 1) d = lastDelta;
    else if (shape === 'updown') d = i < 100 ? 1000 : -800; // 先升后降：中途有明确高点
    else d = i % 2 === 0 ? 500 : -400;                       // 锯齿缓升
    out.push({ openTime: t, delta: d / 50_000, deltaUsd: d });
  }
  return out;
}

// 计算给定序列“此前最高/最低”便于构造精确断言
function _prevExtremes(pts) {
  let cum = 0, hi = -Infinity, lo = Infinity;
  for (let i = 0; i < pts.length - 1; i += 1) {
    cum += pts[i].deltaUsd;
    if (cum > hi) hi = cum;
    if (cum < lo) lo = cum;
  }
  return { hi, lo, cumBeforeLast: cum };
}

async function run() {
  // ==========================================================================
  await test('1. 末根大额买入 delta → 突破前高 direction=high', async () => {
    const pts = _series(0, 'updown');
    const { hi, cumBeforeLast } = _prevExtremes(pts);
    // 让最终累计值恰好超过前高 1 USD
    pts[pts.length - 1].deltaUsd = hi - cumBeforeLast + 1;
    const info = svc._detectBreakout(pts, OPTS);
    assert.ok(info, '不应返回 null');
    assert.equal(info.direction, 'high', `应为 high，实际 ${info.direction}`);
    assert.ok(info.current > info.prevHigh, 'current 应 > prevHigh');
    assert.equal(info.bars, 288);
  });

  // ==========================================================================
  await test('2. 末根大额卖出 delta → 跌破前低 direction=low', async () => {
    const pts = _series(0, 'updown');
    const { lo, cumBeforeLast } = _prevExtremes(pts);
    pts[pts.length - 1].deltaUsd = lo - cumBeforeLast - 1;
    const info = svc._detectBreakout(pts, OPTS);
    assert.ok(info);
    assert.equal(info.direction, 'low', `应为 low，实际 ${info.direction}`);
    assert.ok(info.current < info.prevLow, 'current 应 < prevLow');
  });

  // ==========================================================================
  await test('3. 落在高低点之间 → direction=null（不推送）', async () => {
    const pts = _series(0, 'updown');
    const { hi, lo, cumBeforeLast } = _prevExtremes(pts);
    pts[pts.length - 1].deltaUsd = (hi + lo) / 2 - cumBeforeLast; // 精确落在中间
    const info = svc._detectBreakout(pts, OPTS);
    assert.ok(info);
    assert.equal(info.direction, null, `应为 null，实际 ${info.direction}`);
  });

  // ==========================================================================
  await test('4. 覆盖率守卫：仅 2h 样本 (24 根) → 返回 null 不误报', async () => {
    const pts = _series(99999, 'zigzag').slice(-24);
    const info = svc._detectBreakout(pts, OPTS);
    assert.equal(info, null, '样本不足窗口一半应返回 null');
  });

  // ==========================================================================
  await test('5. 推送闸门：首轮建基线 → 冷却 → 方向独立', async () => {
    svc._state.clear();
    const cd = 1_800_000;
    let now = Date.now();
    // 首轮：即使检测到 high 也只建基线
    assert.equal(svc._shouldFire('BTCUSDT', 'high', now, cd), false, '首轮应只建基线');
    // 第二轮：正常触发
    now += 60_000;
    assert.equal(svc._shouldFire('BTCUSDT', 'high', now, cd), true, '基线后应可触发');
    // 冷却内同方向：拒绝
    now += 60_000;
    assert.equal(svc._shouldFire('BTCUSDT', 'high', now, cd), false, '冷却内同方向应拒绝');
    // 冷却内不同方向：放行（high 冷却不阻塞 low）
    assert.equal(svc._shouldFire('BTCUSDT', 'low', now, cd), true, '不同方向应放行');
    // 冷却期满后同方向再次放行
    now += cd + 1;
    assert.equal(svc._shouldFire('BTCUSDT', 'high', now, cd), true, '冷却期满应放行');
    // direction=null 永不触发
    assert.equal(svc._shouldFire('BTCUSDT', null, now + cd + 1, cd), false);
    svc._state.clear();
  });

  // ==========================================================================
  await test('6. 卡片结构：标题/颜色/关键字段齐全', async () => {
    const info = {
      direction: 'high', current: 5_200_000, prevHigh: 5_000_000, prevLow: -2_000_000,
      currentUsd: 5_200_000, currentCoin: 47.3, bars: 288, lastOpenTime: Date.now()
    };
    const card = svc._buildBreakoutCard({
      symbol: 'BTCUSDT', info, measure: 'usd', windowHours: 24,
      price: 100234.5, aggregated: true, cooldownMs: 1_800_000
    });
    assert.equal(card.header.template, 'green', '突破新高应为绿卡');
    assert.ok(card.header.title.content.includes('突破 24h 新高'));
    const body = card.elements[0].text.content;
    assert.ok(body.includes('$5.20M'), `应含当前 CVD 金额，实际:\n${body}`);
    assert.ok(body.includes('突破幅度'), '应含突破幅度');
    assert.ok(body.includes('100,234.5'), '应含最新价');

    const downCard = svc._buildBreakoutCard({
      symbol: 'BTCUSDT',
      info: { ...info, direction: 'low', current: -2_100_000, currentUsd: -2_100_000 },
      measure: 'usd', windowHours: 24, price: 100234.5, aggregated: false, cooldownMs: 1_800_000
    });
    assert.equal(downCard.header.template, 'red', '跌破新低应为红卡');
    assert.ok(downCard.header.title.content.includes('跌破 24h 新低'));
    assert.ok(downCard.elements[0].text.content.includes('跌破幅度'));
  });

  console.log(`\n${passed} passed · ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

run();
