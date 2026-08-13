'use strict';

/**
 * 关键价位触碰监控冒烟测试
 * (Smoke tests for services/keyLevelsAlert.js · 离线，不需要网络)
 *
 * 运行 (Run): node scripts/test-key-levels-touch-smoke.js
 */

const alert = require('../services/keyLevelsAlert.js');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.error(`  ✗ ${name}`); }
}

const COOLDOWN = 1800_000;
const REARM = 0.0015; // 0.15%

// ---------------------------------------------------------------------------
// 场景 1：_buildWatchList —— 摊平 + 分边 + 类型过滤
// ---------------------------------------------------------------------------
console.log('\n[1] _buildWatchList · 摊平与分边');
{
  const data = {
    latestPrice: 100,
    intervals: [{
      interval: '1h', ok: true,
      bearFvg: { lower: 102, upper: 103 },   // 上方 → above
      bullFvg: { lower: 96, upper: 97 },     // 下方 → below
      poc: { low: 99, high: 99.5 },
      vwap: 100.2
    }],
    liqWindows: [{ label: '4h', sMax: 104, lMax: 95 }],
    obWalls: [{ label: '24h', askWall: 105, bidWall: 94 }]
  };
  const types = new Set(['fvg', 'liq', 'wall']);
  const list = alert._buildWatchList(data, types);
  check('默认类型共 6 个价位（无 POC/VWAP）', list.length === 6);
  check('看跌FVG side=above', list.find((l) => l.key.startsWith('fvg-bear')).side === 'above');
  check('看涨FVG side=below', list.find((l) => l.key.startsWith('fvg-bull')).side === 'below');
  check('S↑ side=above / L↓ side=below',
    list.find((l) => l.key.startsWith('liq-s')).side === 'above'
    && list.find((l) => l.key.startsWith('liq-l')).side === 'below');
  check('卖墙 above / 买墙 below',
    list.find((l) => l.key.startsWith('wall-ask')).side === 'above'
    && list.find((l) => l.key.startsWith('wall-bid')).side === 'below');

  // 跨现价的 FVG（已触发一半）不监控
  const crossed = alert._buildWatchList({
    latestPrice: 100,
    intervals: [{ interval: '1h', ok: true, bearFvg: { lower: 99, upper: 103 }, bullFvg: null, poc: null, vwap: null }],
    liqWindows: [], obWalls: []
  }, types);
  check('跨现价的看跌FVG不监控', crossed.length === 0);

  // 开启 poc/vwap 类型
  const withAll = alert._buildWatchList(data, new Set(['fvg', 'liq', 'wall', 'poc', 'vwap']));
  check('开启 poc/vwap 后共 8 个价位', withAll.length === 8);

  // 无现价 → 空
  check('无现价返回 []', alert._buildWatchList({ latestPrice: null }, types).length === 0);
}

// ---------------------------------------------------------------------------
// 场景 2：_evalTouch —— 武装 → 触发 → 冷却 状态机
// ---------------------------------------------------------------------------
console.log('\n[2] _evalTouch · 状态机');
{
  alert._state.clear();
  const lv = { key: 'fvg-bear|1h|1020', side: 'above', low: 102, high: 103, label: '1h 看跌FVG' };
  let now = 1_700_000_000_000;

  // 首见即在区间内（high 已越过 102）→ 不触发（未武装）
  check('首见在区间内不触发', alert._evalTouch(lv, { high: 102.5, low: 101, close: 102.2 }, now, COOLDOWN, REARM) === false);

  // 价格离开到边界下方 0.15% 以上 → 武装（101 < 102×0.9985≈101.847）
  now += 20_000;
  check('离开后武装（本轮不触发）', alert._evalTouch(lv, { high: 101.2, low: 100.8, close: 101 }, now, COOLDOWN, REARM) === false);

  // 影线上涨触及 102（插针）→ 触发
  now += 20_000;
  check('影线触及触发', alert._evalTouch(lv, { high: 102.1, low: 101, close: 101.5 }, now, COOLDOWN, REARM) === true);

  // 立刻再次离开又触及 → 冷却中不触发
  now += 20_000;
  alert._evalTouch(lv, { high: 101, low: 100.5, close: 100.8 }, now, COOLDOWN, REARM); // 重新武装
  now += 20_000;
  check('冷却内再触及不触发', alert._evalTouch(lv, { high: 102.3, low: 101, close: 102 }, now, COOLDOWN, REARM) === false);

  // 冷却结束 + 重新武装 + 再触及 → 再次触发
  now += COOLDOWN + 1000;
  alert._evalTouch(lv, { high: 101, low: 100.5, close: 100.8 }, now, COOLDOWN, REARM); // 武装
  now += 20_000;
  check('冷却结束后可再次触发', alert._evalTouch(lv, { high: 102.5, low: 101, close: 102.1 }, now, COOLDOWN, REARM) === true);

  // below 侧：看涨FVG 下跌触及
  const lvB = { key: 'fvg-bull|1h|970', side: 'below', low: 96, high: 97, label: '1h 看涨FVG' };
  now += 20_000;
  alert._evalTouch(lvB, { high: 99, low: 98, close: 98.5 }, now, COOLDOWN, REARM); // 现价在上方 → 武装
  now += 20_000;
  check('below 侧下跌触及触发', alert._evalTouch(lvB, { high: 98, low: 96.8, close: 97.5 }, now, COOLDOWN, REARM) === true);

  // 边界抖动：close 贴着边界（未离开 0.15%）→ 不重新武装 → 不触发
  const lvC = { key: 'liq-s|4h|1040', side: 'above', low: 104, high: 104, label: '4h S↑' };
  now += 20_000;
  alert._evalTouch(lvC, { high: 103, low: 102, close: 102.5 }, now, COOLDOWN, REARM); // 武装
  now += 20_000;
  check('触发一次', alert._evalTouch(lvC, { high: 104.2, low: 103.5, close: 103.95 }, now, COOLDOWN, REARM) === true);
  now += 20_000;
  // close=103.95 距 104 只有 0.05% < 0.15% → 未武装
  alert._evalTouch(lvC, { high: 103.98, low: 103.9, close: 103.95 }, now, COOLDOWN, REARM);
  now += 20_000;
  check('贴边抖动不重复触发', alert._evalTouch(lvC, { high: 104.3, low: 103.9, close: 104.1 }, now, COOLDOWN, REARM) === false);
}

// ---------------------------------------------------------------------------
// 场景 3：_buildTouchCard —— 合并卡片与配色
// ---------------------------------------------------------------------------
console.log('\n[3] _buildTouchCard · 卡片');
{
  const up = { side: 'above', low: 102, high: 103, label: '1h 看跌FVG', hint: '关注做空 / watch short' };
  const down = { side: 'below', low: 96, high: 97, label: '4h 看涨FVG', hint: '关注做多 / watch long' };

  const cardUp = alert._buildTouchCard('BTCUSDT', 'futures', 102.1, [up]);
  check('全 above → 红卡', cardUp.header.template === 'red');
  check('卡片含价位区间', cardUp.elements[0].text.content.includes('102 ~ 103'));
  check('卡片含上涨触及', cardUp.elements[0].text.content.includes('⬆️ 上涨触及'));

  const cardDown = alert._buildTouchCard('BTCUSDT', 'futures', 96.9, [down]);
  check('全 below → 绿卡', cardDown.header.template === 'green');

  const cardMixed = alert._buildTouchCard('BTCUSDT', 'futures', 100, [up, down]);
  check('混合 → 橙卡且两行', cardMixed.header.template === 'orange'
    && cardMixed.elements[0].text.content.split('\n').length === 2);
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
