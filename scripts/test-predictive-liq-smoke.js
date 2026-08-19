'use strict';

/* eslint-disable no-console */
/**
 * 预测性清算热力图路由 (predictive liquidations route) 冒烟测试
 *
 * 覆盖：
 *   1. 正常请求 → 矩阵结构齐全，非零值已压缩到 4 位有效数字
 *   2. SWR 缓存：TTL 内的第二次请求不再穿透 Binance（fetch 计数不变）
 *   3. 不同 windowMs → 不同缓存 key → 重新取数
 *   4. 无 K 线 → empty:true 空响应
 *
 * 运行：node scripts/test-predictive-liq-smoke.js
 */

require('dotenv').config();
const path = require('path');
const http = require('http');
const assert = require('assert');

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log(`✓ ${name}`); })
    .catch((err) => { failed += 1; console.error(`✗ ${name}\n   ${err.message}`); });
}

// 生成 fapi 原始 K 线数组：最近 count 根 × intervalMs
function _rawKlines(count, intervalMs) {
  const now = Date.now();
  const out = [];
  let price = 100000;
  for (let i = count - 1; i >= 0; i -= 1) {
    const t = now - i * intervalMs;
    price *= 1 + (((i * 7919) % 100) - 50) / 50000; // 确定性伪随机走价
    const vol = 300 + ((i * 104729) % 200);
    out.push([
      t, String(price), String(price * 1.002), String(price * 0.998),
      String(price * 1.0005), String(vol), t + intervalMs - 1,
      String(vol * price), 1000, String(vol * 0.5), String(vol * price * 0.5), '0'
    ]);
  }
  return out;
}

// Mock services/binance：getKlines 计数 + 可控返回
function _mockBinance(opts = {}) {
  const binancePath = require.resolve(path.join(__dirname, '..', 'services', 'binance.js'));
  const state = { calls: 0 };
  const fake = {
    async getKlines(_symbol, interval) {
      state.calls += 1;
      if (opts.empty) return [];
      const ms = ({ '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3600_000 })[interval] || 300_000;
      return _rawKlines(opts.count || 60, ms);
    }
  };
  require.cache[binancePath] = {
    id: binancePath, filename: binancePath, loaded: true,
    exports: { BinanceService: fake }
  };
  return state;
}

function _freshRoute() {
  // 路由带 SWR 响应缓存（模块级单例），各用例参数相同会互相命中 → 重置隔离
  require(path.join(__dirname, '..', 'services', 'swrCache'))._resetForTest();
  const abs = require.resolve(path.join(__dirname, '..', 'routes', 'predictiveLiquidations.js'));
  delete require.cache[abs];
  return require(abs);
}

async function _startServer(route) {
  const express = require('express');
  const app = express();
  app.use('/api', route);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((res) => server.on('listening', res));
  return { server, port: server.address().port };
}

function _get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (r) => {
      let buf = '';
      r.on('data', (b) => { buf += b; });
      r.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function run() {
  // ==========================================================================
  await test('1. 正常请求 → 结构齐全，矩阵值已压缩到 4 位有效数字', async () => {
    _mockBinance({ count: 120 });
    const route = _freshRoute();
    const { server, port } = await _startServer(route);
    try {
      const j = await _get(port, '/api/predictive/liquidations?symbol=BTCUSDT&windowMs=3600000');
      assert.ok(j.success, `success=false: ${j.error}`);
      const d = j.data;
      assert.ok(Array.isArray(d.times) && d.times.length > 0, 'times 为空');
      assert.ok(Array.isArray(d.prices) && d.prices.length > 0, 'prices 为空');
      assert.equal(d.longMatrix.length, d.times.length, 'longMatrix 行数 ≠ times');
      assert.equal(d.longMatrix[0].length, d.prices.length, 'longMatrix 列数 ≠ prices');
      assert.ok(d.maxValue > 0, 'maxValue 应 >0');
      assert.ok(Array.isArray(d.candles) && d.candles.length > 0, '应附带 slim K 线');
      // 抽查全部非零格：4 位有效数字压缩后应满足 v === Number(v.toPrecision(4))
      let nonZero = 0;
      for (const m of [d.longMatrix, d.shortMatrix]) {
        for (const row of m) for (const v of row) {
          if (v !== 0) {
            nonZero += 1;
            assert.equal(v, Number(v.toPrecision(4)), `矩阵值未压缩: ${v}`);
          }
        }
      }
      assert.ok(nonZero > 0, '矩阵不应全 0');
    } finally { server.close(); }
  });

  // ==========================================================================
  await test('2. SWR 缓存：TTL 内第二次请求不穿透 Binance', async () => {
    const state = _mockBinance({ count: 120 });
    const route = _freshRoute();
    const { server, port } = await _startServer(route);
    try {
      const q = '/api/predictive/liquidations?symbol=BTCUSDT&windowMs=3600000';
      const j1 = await _get(port, q);
      const callsAfterFirst = state.calls;
      assert.ok(callsAfterFirst >= 1, '首次应穿透取数');
      const j2 = await _get(port, q);
      assert.equal(state.calls, callsAfterFirst, `缓存未命中，Binance 又被调了 ${state.calls - callsAfterFirst} 次`);
      assert.equal(j2.data.generatedAt, j1.data.generatedAt, '应返回同一份缓存 payload');
    } finally { server.close(); }
  });

  // ==========================================================================
  await test('3. 不同 windowMs → 不同缓存 key → 重新取数', async () => {
    const state = _mockBinance({ count: 300 });
    const route = _freshRoute();
    const { server, port } = await _startServer(route);
    try {
      await _get(port, '/api/predictive/liquidations?symbol=BTCUSDT&windowMs=3600000');
      const callsAfterFirst = state.calls;
      const j = await _get(port, '/api/predictive/liquidations?symbol=BTCUSDT&windowMs=14400000');
      assert.ok(state.calls > callsAfterFirst, '不同 windowMs 应重新取数');
      assert.ok(j.success && j.data.times.length > 0);
    } finally { server.close(); }
  });

  // ==========================================================================
  await test('4. 无 K 线 → empty:true 空响应', async () => {
    _mockBinance({ empty: true });
    const route = _freshRoute();
    const { server, port } = await _startServer(route);
    try {
      const j = await _get(port, '/api/predictive/liquidations?symbol=BTCUSDT&windowMs=3600000');
      assert.ok(j.success);
      assert.equal(j.data.empty, true);
      assert.equal(j.data.times.length, 0);
    } finally { server.close(); }
  });

  console.log(`\n${passed} passed · ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

run();
