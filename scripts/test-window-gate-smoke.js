'use strict';

/* eslint-disable no-console */
/**
 * 交易信号窗口闸门（B 方案）冷烟测试
 *
 * 覆盖：
 *   1. /api/trade/liq-signal       windowMs=15m → 返回 NONE + windowGated:true，不调 autoTrade
 *   2. /api/trade/liq-signal       windowMs=1h  → 返回 NONE + windowGated:true
 *   3. /api/trade/liq-signal       windowMs=4h  → 通过闸门进入正常计算流程
 *   4. /api/trade/liq-signal       windowMs=24h → 通过闸门进入正常计算流程
 *   5. /api/trade/resonance-signal windowMs=15m → 返回 NONE + windowGated:true
 *   6. /api/trade/resonance-signal windowMs=24h → 通过闸门
 *   7. TRADE_SIGNAL_ALLOWED_WINDOWS_MS=14400000 (仅 4h) → 24h 被拒绝
 *
 * 运行：node scripts/test-window-gate-smoke.js
 */

require('dotenv').config();
const path = require('path');
const http = require('http');
const assert = require('assert');

// 关掉飞书 / autoTrade，避免烟测真去推送
delete process.env.FEISHU_WEBHOOK_URL;
delete process.env.FEISHU_WEBHOOK_SECRET;
delete process.env.AUTO_TRADE_API_URL;
delete process.env.AUTO_TRADE_AUTH_TOKEN;

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

// 工具：Mock Binance，避免真访问外网
function _mockBinance() {
  const binancePath = require.resolve(path.join(__dirname, '..', 'services', 'binance.js'));
  const bLivePath = require.resolve(path.join(__dirname, '..', 'services', 'binanceLive.js'));
  const fakeService = {
    async getKlines(_sym, _itv, limit /*, market */) {
      const raw = [];
      const now = Date.now();
      for (let i = 0; i < (limit || 200); i += 1) {
        const t = now - (limit - i) * 60_000;
        const p = 80000 + Math.sin(i / 10) * 200;
        raw.push([t, String(p), String(p + 50), String(p - 50), String(p), '100',
          t + 60_000, String(100 * p), 50, '50', String(50 * p), '0']);
      }
      return raw;
    },
    async getOpenInterestHist() { return []; },
    async getAggTrades() { return []; },
    async getFundingRate() { return { lastRate: 0.0001 }; }
  };
  require.cache[binancePath] = { id: binancePath, filename: binancePath, loaded: true, exports: { BinanceService: fakeService } };
  require.cache[bLivePath] = { id: bLivePath, filename: bLivePath, loaded: true, exports: { BinanceLive: fakeService } };
}

async function _startServer(route, mountPath = '/api') {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use(mountPath, route);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((res) => server.on('listening', res));
  return { server, port: server.address().port };
}

function _get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (r) => {
      let buf = '';
      r.on('data', (b) => { buf += b; });
      r.on('end', () => {
        try { resolve({ status: r.statusCode, body: JSON.parse(buf) }); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// 强制重新 require 以让 env 生效（每个测试独立 server）
function _freshRequire(p) {
  const abs = require.resolve(path.join(__dirname, '..', p));
  delete require.cache[abs];
  return require(abs);
}

// ============================================================================
// 1-2. liq-signal: 短窗口 → windowGated
// ============================================================================
test('liq-signal: windowMs=15m → NONE + windowGated:true', async () => {
  _mockBinance();
  process.env.TRADE_SIGNAL_ALLOWED_WINDOWS_MS = '14400000,86400000';
  const route = _freshRequire('routes/liqSignal.js');
  const { server, port } = await _startServer(route);
  try {
    const r = await _get(port, '/api/trade/liq-signal?symbol=BTCUSDT&windowMs=900000');
    assert.equal(r.status, 200);
    assert.ok(r.body.success);
    assert.equal(r.body.data.signal, 'NONE', 'signal 应为 NONE');
    const snap = r.body.data.indicatorsSnapshot;
    assert.ok(snap, 'indicatorsSnapshot 应存在');
    assert.equal(snap.windowGated, true, 'windowGated 标识应为 true');
    assert.ok(/not in trade-signal allow-list/.test(r.body.data.reason),
      `reason 应说明窗口被闸门拦截，实际：${r.body.data.reason}`);
  } finally {
    server.close();
  }
});

test('liq-signal: windowMs=1h → NONE + windowGated:true', async () => {
  _mockBinance();
  process.env.TRADE_SIGNAL_ALLOWED_WINDOWS_MS = '14400000,86400000';
  const route = _freshRequire('routes/liqSignal.js');
  const { server, port } = await _startServer(route);
  try {
    const r = await _get(port, '/api/trade/liq-signal?symbol=BTCUSDT&windowMs=3600000');
    assert.equal(r.body.data.signal, 'NONE');
    assert.equal(r.body.data.indicatorsSnapshot.windowGated, true);
  } finally {
    server.close();
  }
});

// ============================================================================
// 3-4. liq-signal: 4h / 24h 通过闸门（不一定有信号，但不会被 windowGated 拒）
// ============================================================================
test('liq-signal: windowMs=4h → 通过闸门进入正常流程（无 windowGated 标识）', async () => {
  _mockBinance();
  process.env.TRADE_SIGNAL_ALLOWED_WINDOWS_MS = '14400000,86400000';
  const route = _freshRequire('routes/liqSignal.js');
  const { server, port } = await _startServer(route);
  try {
    const r = await _get(port, '/api/trade/liq-signal?symbol=BTCUSDT&windowMs=14400000&notify=false&autoTrade=false');
    assert.equal(r.status, 200);
    const snap = r.body.data.indicatorsSnapshot || {};
    assert.notEqual(snap.windowGated, true, '4h 不应被 windowGated 拦截');
    // 可能没有信号（取决于 mock 数据），但不应是窗口闸门拒绝
    if (r.body.data.signal === 'NONE' && r.body.data.reason) {
      assert.ok(!/not in trade-signal allow-list/.test(r.body.data.reason),
        '4h 的 NONE reason 应来自正常逻辑，不应是窗口闸门');
    }
  } finally {
    server.close();
  }
});

test('liq-signal: windowMs=24h → 通过闸门', async () => {
  _mockBinance();
  process.env.TRADE_SIGNAL_ALLOWED_WINDOWS_MS = '14400000,86400000';
  const route = _freshRequire('routes/liqSignal.js');
  const { server, port } = await _startServer(route);
  try {
    const r = await _get(port, '/api/trade/liq-signal?symbol=BTCUSDT&windowMs=86400000&notify=false&autoTrade=false');
    assert.equal(r.status, 200);
    const snap = r.body.data.indicatorsSnapshot || {};
    assert.notEqual(snap.windowGated, true, '24h 不应被 windowGated 拦截');
  } finally {
    server.close();
  }
});

// ============================================================================
// 5-6. resonance-signal 同样验证
// ============================================================================
test('resonance-signal: windowMs=15m → tier=NONE + windowGated:true', async () => {
  _mockBinance();
  process.env.TRADE_SIGNAL_ALLOWED_WINDOWS_MS = '14400000,86400000';
  const route = _freshRequire('routes/resonanceSignal.js');
  const { server, port } = await _startServer(route);
  try {
    const r = await _get(port, '/api/trade/resonance-signal?symbol=BTCUSDT&windowMs=900000');
    assert.equal(r.status, 200);
    assert.equal(r.body.data.tier, 'NONE');
    assert.equal(r.body.data.signal, 'NONE');
    const snap = r.body.data.indicatorsSnapshot;
    assert.equal(snap.windowGated, true);
    assert.ok(/not in trade-signal allow-list/.test(r.body.data.reason),
      `reason 应说明窗口被闸门拦截，实际：${r.body.data.reason}`);
  } finally {
    server.close();
  }
});

test('resonance-signal: windowMs=24h → 通过闸门', async () => {
  _mockBinance();
  process.env.TRADE_SIGNAL_ALLOWED_WINDOWS_MS = '14400000,86400000';
  const route = _freshRequire('routes/resonanceSignal.js');
  const { server, port } = await _startServer(route);
  try {
    const r = await _get(port, '/api/trade/resonance-signal?symbol=BTCUSDT&windowMs=86400000&notify=false');
    assert.equal(r.status, 200);
    const snap = r.body.data.indicatorsSnapshot || {};
    assert.notEqual(snap.windowGated, true, '24h 不应被 windowGated 拦截');
  } finally {
    server.close();
  }
});

// ============================================================================
// 7. 自定义白名单：仅 4h → 24h 被拒
// ============================================================================
test('自定义白名单 TRADE_SIGNAL_ALLOWED_WINDOWS_MS=14400000 (仅 4h) → 24h 被拒', async () => {
  _mockBinance();
  process.env.TRADE_SIGNAL_ALLOWED_WINDOWS_MS = '14400000';
  const route = _freshRequire('routes/liqSignal.js');
  const { server, port } = await _startServer(route);
  try {
    const r = await _get(port, '/api/trade/liq-signal?symbol=BTCUSDT&windowMs=86400000');
    assert.equal(r.body.data.signal, 'NONE');
    assert.equal(r.body.data.indicatorsSnapshot.windowGated, true,
      '24h 在自定义白名单下应被拒');
    assert.ok(/4h/.test(r.body.data.reason), `reason 应说明白名单只有 4h，实际：${r.body.data.reason}`);
  } finally {
    server.close();
  }
});

// ============================================================================
process.on('exit', () => {
  console.log(`\n${passed} passed · ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
});
