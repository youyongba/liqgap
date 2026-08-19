'use strict';

/**
 * 清算热力图 sweepMode 冒烟测试
 *
 * 验证 services/predictiveLiquidations.js 的两种已扫处理模式：
 *   • 'clip'（热图视觉 · CoinGlass）：清算带画到首次被 K 线扫穿的时间桶
 *     断开，历史轨迹保留；断开之后同价位若有新开仓会长出新带。
 *   • 'invalidate'（信号口径）：被扫批次整条作废，矩阵只留活墙。
 *
 * 关键不变量：两种模式的**最后一列**（= 当前活墙）必须完全一致 ——
 * 前端 S↑/L↓ 主峰的存活闸门和后端 _findPeaks(invalidate) 才能对得上。
 *
 * 场景构造：
 *   10 根 1m K 线，全部 close=100、vol=1、takerBuy=0.5；lev=10、mmr=0
 *   → 多头清算价 = 90，空头清算价 = 110。
 *   第 5 根 K 线 low=89 向下插针 → 扫穿多头清算带（90）：
 *     - 第 0-4 根开的多头批次：clip 画到桶 4 为止、桶 5 起断开；invalidate 整条没有
 *     - 第 5-9 根开的多头批次：两种模式都完整存活
 *   没有任何 K 线 high ≥ 110 → 空头带在两种模式下完全一致。
 */

const { buildPredictiveLiquidationHeatmap } = require('../services/predictiveLiquidations');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed += 1; console.log(`✓ ${name}`); }
  else { failed += 1; console.error(`✗ ${name}`); }
}
// eps 取 1e-2：halfLifeMs=1e12 仍有 ~1e-4 量级的微小衰减，属预期
function approx(a, b, eps = 1e-2) { return Math.abs(a - b) <= eps; }

const M = 60_000;
const candles = [];
for (let i = 0; i < 10; i += 1) {
  candles.push({
    openTime: i * M,
    open: 100,
    high: 100,
    low: i === 5 ? 89 : 100, // 桶 5 向下插针扫穿多头清算价 90
    close: 100,
    volume: 1,
    takerBuyBase: 0.5
  });
}

const base = {
  fromMs: 0, toMs: 10 * M, bucketMs: M,
  priceMin: 80, priceMax: 120, priceBucket: 1,
  mmr: 0,
  halfLifeMs: 1e12,               // 近似无衰减，断言用整数
  leverageBuckets: [{ lev: 10, weight: 1 }],
  priceSpreadBuckets: 0           // 关闭价格扩散，单格断言
};

const clip = buildPredictiveLiquidationHeatmap(candles, { ...base, sweepMode: 'clip' });
const inv  = buildPredictiveLiquidationHeatmap(candles, { ...base, sweepMode: 'invalidate' });
const dflt = buildPredictiveLiquidationHeatmap(candles, { ...base });

const PI_LONG = 10;  // 价位 90 (80 + 10×1)
const PI_SHORT = 30; // 价位 110
// 每根 K 线单批贡献 = vol(1) × close(100) × share(0.5) × weight(1) = 50
const C = 50;

console.log('[1] 模式与默认值');
check("默认 sweepMode = 'clip'", dflt.sweepMode === 'clip');
check("clip / invalidate 模式字段回传正确", clip.sweepMode === 'clip' && inv.sweepMode === 'invalidate');

console.log('\n[2] clip：被扫带保留历史、在被扫桶断开');
check('clip 桶0 有带（历史保留）', approx(clip.longMatrix[0][PI_LONG], C));
check('clip 桶4 = 批次0-4 叠加 (250)', approx(clip.longMatrix[4][PI_LONG], 5 * C));
check('clip 桶5 断开：旧批次消失，只剩桶5 新开批次 (50)',
  approx(clip.longMatrix[5][PI_LONG], C));
check('clip 桶9 = 批次5-9 叠加 (250)（断带右侧长出新带）',
  approx(clip.longMatrix[9][PI_LONG], 5 * C));

console.log('\n[3] invalidate：被扫批次整条作废（旧行为）');
check('invalidate 桶0 无带', approx(inv.longMatrix[0][PI_LONG], 0));
check('invalidate 桶4 无带', approx(inv.longMatrix[4][PI_LONG], 0));
check('invalidate 桶5 = 仅桶5 新开批次 (50)', approx(inv.longMatrix[5][PI_LONG], C));
check('invalidate 桶9 = 批次5-9 叠加 (250)', approx(inv.longMatrix[9][PI_LONG], 5 * C));

console.log('\n[4] 关键不变量：最后一列（活墙）两模式完全一致');
{
  let same = true;
  const T = clip.times.length - 1;
  for (let pi = 0; pi < clip.prices.length; pi += 1) {
    if (!approx(clip.longMatrix[T][pi], inv.longMatrix[T][pi])) { same = false; break; }
    if (!approx(clip.shortMatrix[T][pi], inv.shortMatrix[T][pi])) { same = false; break; }
  }
  check('最后一列 long/short 矩阵逐格一致', same);
}

console.log('\n[5] 未被扫的空头带：两模式全矩阵一致');
{
  let same = true;
  for (let ti = 0; ti < clip.times.length; ti += 1) {
    if (!approx(clip.shortMatrix[ti][PI_SHORT], inv.shortMatrix[ti][PI_SHORT])) { same = false; break; }
  }
  check('空头带 (110) 每个时间桶一致', same);
  check('空头带桶9 = 全部10批叠加 (500)', approx(clip.shortMatrix[9][PI_SHORT], 10 * C));
}

console.log('\n[6] 诊断字段');
check('clip 的 sweptLong = 被断开的 5 批 (250)', approx(clip.sweptLong, 5 * C));
check('invalidate 的 sweptLong = 被作废的 5 批 (250)', approx(inv.sweptLong, 5 * C));
check('两模式 sweptShort 均为 0', approx(clip.sweptShort, 0) && approx(inv.sweptShort, 0));

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed ? 1 : 0);
