'use strict';

/* eslint-disable no-console */
/**
 * LVN 识别冷烟测试 (Low Volume Node detection smoke tests)
 *
 * 覆盖：
 *   1. computeVolumeProfile 基础正确性（POC/VAH/VAL 位置）
 *   2. markLVN 识别真空带
 *   3. markLVN 过滤边缘 LVN
 *   4. markLVN 过滤未被 HVN 包夹的孤立 LVN
 *   5. LVN zones 合并相邻桶 + 按 depth 排序
 *   6. 端到端：通过 HTTP 调 /api/indicators/volume-profile 返回结构合规
 *
 * 运行: node scripts/test-lvn-smoke.js
 */

require('dotenv').config();
const path = require('path');
const http = require('http');
const assert = require('assert');

const { computeVolumeProfile, markLVN } = require('../indicators/volumeProfile');

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { passed += 1; console.log(`✓ ${name}`); })
        .catch((err) => { failed += 1; console.error(`✗ ${name}\n   ${err.message}`); });
    }
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`✗ ${name}\n   ${err.message}`);
  }
}

// ============================================================================
// 1. Volume Profile 基础
// ============================================================================
test('computeVolumeProfile: POC 在成交最密集的价位', () => {
  // 构造价格 100-110，POC 应该在 105 附近（所有 K 线都在 104-106 集中成交）
  const candles = [
    { high: 110, low: 100, volume: 10 },   // 散开
    { high: 106, low: 104, volume: 100 },  // 集中
    { high: 106, low: 104, volume: 100 },
    { high: 106, low: 104, volume: 100 },
    { high: 108, low: 102, volume: 20 }
  ];
  const p = computeVolumeProfile(candles, 20);
  const pocPrice = (p.poc.priceLow + p.poc.priceHigh) / 2;
  assert.ok(pocPrice >= 104 && pocPrice <= 106, `POC=${pocPrice} not in [104,106]`);
  assert.ok(p.vah > pocPrice && p.val < pocPrice, 'VAH/VAL 应包夹 POC');
  assert.ok(p.totalVolume > 0);
});

// ============================================================================
// 2. markLVN 识别真空带
// ============================================================================
test('markLVN: 识别中间真空带（HVN-LVN-HVN 结构）', () => {
  // 构造 100 个桶：底部 0-20 HVN，中间 35-45 LVN（量极小），顶部 60-80 HVN
  const candles = [];
  // 底部密集成交
  for (let i = 0; i < 30; i += 1) {
    candles.push({ high: 20, low: 0, volume: 100 });
  }
  // 中间几乎不成交（穿过去就走）
  for (let i = 0; i < 2; i += 1) {
    candles.push({ high: 80, low: 0, volume: 1 });  // 拉满价格区间但量极小
  }
  // 顶部密集成交
  for (let i = 0; i < 30; i += 1) {
    candles.push({ high: 80, low: 60, volume: 100 });
  }
  const p = computeVolumeProfile(candles, 80);
  markLVN(p, { lvnThresholdRatio: 0.2, minZoneBuckets: 2 });
  assert.ok(p.lvnZones && p.lvnZones.length > 0, `expect lvnZones, got ${p.lvnZones && p.lvnZones.length}`);
  // 应至少有一个 LVN 在 25-55 之间（中间真空带）
  const middleZone = p.lvnZones.find((z) => z.priceMid >= 20 && z.priceMid <= 60);
  assert.ok(middleZone, `expect middle LVN zone in [20,60], got ${JSON.stringify(p.lvnZones.map((z) => +z.priceMid.toFixed(1)))}`);
  assert.ok(middleZone.depth > 0.5, `expect depth > 0.5, got ${middleZone.depth}`);
});

test('markLVN: 边缘 LVN 被过滤（不在价格区间两端）', () => {
  const candles = [
    { high: 110, low: 100, volume: 5 },     // 顶部稀薄 → 应被边缘过滤
    { high: 106, low: 104, volume: 100 },
    { high: 106, low: 104, volume: 100 },
    { high: 90,  low: 80,  volume: 5 }      // 底部稀薄 → 应被边缘过滤
  ];
  const p = computeVolumeProfile(candles, 30);
  markLVN(p, { lvnThresholdRatio: 0.3, edgeIgnoreRatio: 0.1, minZoneBuckets: 1, requireSurroundedByHVN: false });
  // 检查最低 / 最高桶不应该被标 LVN
  assert.strictEqual(p.buckets[0].isLVN, false, 'lowest bucket should not be LVN (edge)');
  assert.strictEqual(p.buckets[p.buckets.length - 1].isLVN, false, 'highest bucket should not be LVN (edge)');
});

test('markLVN: 未被 HVN 包夹的 LVN 被过滤（孤立 LVN 不算）', () => {
  // 单调上涨：每个价位成交量大致相同，没有真正的"真空带"
  const candles = [];
  for (let i = 0; i < 100; i += 1) {
    const p = 100 + i;
    candles.push({ high: p, low: p, volume: 100 });
  }
  // 中间硬塞一根高成交量的 K 线
  candles.push({ high: 150, low: 150, volume: 5000 });
  const p = computeVolumeProfile(candles, 50);
  markLVN(p, { lvnThresholdRatio: 0.05, requireSurroundedByHVN: true });
  // 因为没有真正"两端都有 HVN"的结构，应当没有 zones 或很少
  assert.ok((p.lvnZones || []).length <= 2,
    `expect 0-2 zones for monotonic data, got ${p.lvnZones.length}`);
});

test('markLVN: LVN zones 按 depth 降序', () => {
  // 制造两个 LVN，一深一浅
  const candles = [];
  // 30-40 HVN
  for (let i = 0; i < 50; i += 1) candles.push({ high: 40, low: 30, volume: 100 });
  // 45-50 中等量
  for (let i = 0; i < 5; i += 1) candles.push({ high: 50, low: 45, volume: 30 });
  // 55-60 极低量（最深 LVN）
  for (let i = 0; i < 2; i += 1) candles.push({ high: 60, low: 55, volume: 1 });
  // 65-75 HVN
  for (let i = 0; i < 50; i += 1) candles.push({ high: 75, low: 65, volume: 100 });
  const p = computeVolumeProfile(candles, 100);
  markLVN(p, { lvnThresholdRatio: 0.4, minZoneBuckets: 1 });
  if (p.lvnZones.length >= 2) {
    for (let i = 0; i < p.lvnZones.length - 1; i += 1) {
      assert.ok(p.lvnZones[i].depth >= p.lvnZones[i + 1].depth,
        `zones not sorted by depth desc: ${p.lvnZones.map((z) => z.depth).join(', ')}`);
    }
  }
});

test('markLVN: 空数据安全退出', () => {
  const p = computeVolumeProfile([], 50);
  markLVN(p);
  assert.deepStrictEqual(p.lvnZones, []);
});

// ============================================================================
// 6. 端到端：HTTP 路由（mock Binance）
// ============================================================================
test('routes/volumeProfile: 返回 POC/VAH/VAL/lvnZones（不依赖外网）', async () => {
  // mock Binance —— 同 e2e 模式
  const binancePath = require.resolve(path.join(__dirname, '..', 'services', 'binance.js'));
  const bLivePath   = require.resolve(path.join(__dirname, '..', 'services', 'binanceLive.js'));
  const fakeService = {
    async getKlines(_sym, _itv, limit /*, market */) {
      const raw = [];
      const now = Date.now();
      for (let i = 0; i < (limit || 200); i += 1) {
        const t = now - (limit - i) * 60_000;
        // 制造 HVN-LVN-HVN 结构
        let p, vol;
        if (i < 60) { p = 100 + Math.sin(i / 5) * 2; vol = 100; }
        else if (i < 70) { p = 200; vol = 1; }     // LVN 区
        else { p = 250 + Math.sin(i / 5) * 3; vol = 100; }
        raw.push([t, String(p), String(p + 1), String(p - 1), String(p), String(vol),
          t + 60_000, String(vol * p), 50, String(vol / 2), String(vol / 2 * p), '0']);
      }
      return raw;
    }
  };
  require.cache[binancePath] = { id: binancePath, filename: binancePath, loaded: true, exports: { BinanceService: fakeService } };
  require.cache[bLivePath]   = { id: bLivePath,   filename: bLivePath,   loaded: true, exports: { BinanceLive: fakeService } };

  const express = require('express');
  const route = require('../routes/volumeProfile');
  const app = express();
  app.use('/api', route);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((res) => server.on('listening', res));
  const port = server.address().port;

  const body = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/indicators/volume-profile?symbol=BTCUSDT&interval=1m&limit=200&buckets=100' }, (r) => {
      let buf = '';
      r.on('data', (b) => { buf += b; });
      r.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
  server.close();
  assert.ok(body.success, 'response.success should be true');
  assert.ok(body.data.poc, 'should have poc');
  assert.ok(Number.isFinite(body.data.vah), 'should have vah');
  assert.ok(Number.isFinite(body.data.val), 'should have val');
  assert.ok(Array.isArray(body.data.lvnZones), 'should have lvnZones array');
  console.log(`   POC=${(body.data.poc.priceLow + body.data.poc.priceHigh) / 2 | 0}, VAH=${body.data.vah.toFixed(0)}, VAL=${body.data.val.toFixed(0)}, LVN zones=${body.data.lvnZones.length}`);
});

// ============================================================================
process.on('exit', () => {
  console.log(`\n${passed} passed · ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
});
