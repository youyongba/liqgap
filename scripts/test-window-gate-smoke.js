'use strict';

/* eslint-disable no-console */
/**
 * 三阶窗口闸门（Three-tier window gate）冷烟测试
 *
 * 覆盖：
 *   1. /api/trade/liq-signal       windowMs=15m → NONE + windowGated:true（完全屏蔽）
 *   2. /api/trade/liq-signal       windowMs=1h  (NOTIFY 未设) → NONE + windowGated:true
 *   3. /api/trade/liq-signal       windowMs=1h  (NOTIFY=3600000) → 不 gated，data.notifyOnly=true
 *   4. /api/trade/liq-signal       windowMs=1h  (NOTIFY=3600000) → autoTrade.sendPendingOrder 不被调用
 *   5. /api/trade/liq-signal       windowMs=4h  → 通过闸门，data.notifyOnly=false
 *   6. /api/trade/liq-signal       windowMs=24h → 通过闸门，data.notifyOnly=false
 *   7. /api/trade/resonance-signal windowMs=15m → NONE + windowGated:true
 *   8. /api/trade/resonance-signal windowMs=1h  (NOTIFY=3600000) → 不 gated，data.notifyOnly=true
 *   9. /api/trade/resonance-signal windowMs=24h → 通过闸门
 *  10. TRADE_SIGNAL_ALLOWED_WINDOWS_MS=14400000 (仅 4h) → 24h 被拒绝
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
// 关掉 staging 延迟，避免测试要等 5 分钟
process.env.AUTO_TRADE_CONFIRMATION_DELAY_MS = '0';

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

// 工具：Mock services/autoTrade，记录所有 sendPendingOrder 调用
// 返回 spy 数组，每次测试可断言"是否被调用过"
function _mockAutoTrade() {
  const autoPath = require.resolve(path.join(__dirname, '..', 'services', 'autoTrade.js'));
  const calls = [];
  const fake = {
    sendPendingOrder: async (payload) => {
      calls.push(payload);
      return { ok: true, skipped: false, status: 200 };
    },
    isEnabled: () => false,
    getStatus: () => ({ enabled: false, staged: [] })
  };
  require.cache[autoPath] = { id: autoPath, filename: autoPath, loaded: true, exports: fake };
  return calls;
}

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

test('liq-signal: windowMs=1h (NOTIFY 未设) → NONE + windowGated:true', async () => {
  _mockBinance();
  process.env.TRADE_SIGNAL_ALLOWED_WINDOWS_MS = '14400000,86400000';
  delete process.env.TRADE_SIGNAL_NOTIFY_WINDOWS_MS;
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

test('liq-signal: windowMs=1h (NOTIFY=3600000) → 不 gated，正常进入计算流程', async () => {
  _mockBinance();
  process.env.TRADE_SIGNAL_ALLOWED_WINDOWS_MS = '14400000,86400000';
  process.env.TRADE_SIGNAL_NOTIFY_WINDOWS_MS  = '3600000';
  const route = _freshRequire('routes/liqSignal.js');
  const { server, port } = await _startServer(route);
  try {
    const r = await _get(port, '/api/trade/liq-signal?symbol=BTCUSDT&windowMs=3600000&notify=false&autoTrade=false');
    assert.equal(r.status, 200);
    const snap = r.body.data.indicatorsSnapshot || {};
    assert.notEqual(snap.windowGated, true,
      '1h 在 NOTIFY 名单内不应被 windowGated 拦截');
    // mock 数据未必出信号；但若出信号必须带 notifyOnly:true
    if (r.body.data.signal && r.body.data.signal !== 'NONE') {
      assert.equal(r.body.data.notifyOnly, true,
        `1h 信号 ${r.body.data.signal} 必须带 notifyOnly:true`);
    }
  } finally {
    server.close();
  }
});

test('liq-signal: windowMs=1h notifyOnly → autoTrade.sendPendingOrder 不被调用', async () => {
  _mockBinance();
  const autoCalls = _mockAutoTrade();
  process.env.TRADE_SIGNAL_ALLOWED_WINDOWS_MS = '14400000,86400000';
  process.env.TRADE_SIGNAL_NOTIFY_WINDOWS_MS  = '3600000';
  const route = _freshRequire('routes/liqSignal.js');
  const { server, port } = await _startServer(route);
  try {
    await _get(port, '/api/trade/liq-signal?symbol=BTCUSDT&windowMs=3600000');
    // fire-and-forget：给 100ms 让 .then 回调跑完
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(autoCalls.length, 0,
      `1h notifyOnly 不应触发 autoTrade.sendPendingOrder，实际调用 ${autoCalls.length} 次`);
  } finally {
    server.close();
  }
});

test('liq-signal: windowMs=4h full → autoTrade.sendPendingOrder 可被调用（若出信号）', async () => {
  _mockBinance();
  const autoCalls = _mockAutoTrade();
  process.env.TRADE_SIGNAL_ALLOWED_WINDOWS_MS = '14400000,86400000';
  process.env.TRADE_SIGNAL_NOTIFY_WINDOWS_MS  = '3600000';
  const route = _freshRequire('routes/liqSignal.js');
  const { server, port } = await _startServer(route);
  try {
    const r = await _get(port, '/api/trade/liq-signal?symbol=BTCUSDT&windowMs=14400000');
    await new Promise((res) => setTimeout(res, 100));
    // 4h 在 full 名单：守护逻辑允许 autoTrade（具体是否被 mock 数据触发到信号取决于 mock）
    // 只验证守护未硬拦：如果信号触发了 autoTrade 必有 ≥1 次调用；如果未出信号 autoCalls=0 也合规
    if (r.body.data.signal && r.body.data.signal !== 'NONE') {
      assert.equal(r.body.data.notifyOnly, false,
        '4h full 信号必须带 notifyOnly:false');
      assert.ok(autoCalls.length >= 1,
        '4h full 出信号时 autoTrade 应被调用');
    }
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
  delete process.env.TRADE_SIGNAL_NOTIFY_WINDOWS_MS;
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

test('resonance-signal: windowMs=1h (NOTIFY=3600000) → 不 gated', async () => {
  _mockBinance();
  process.env.TRADE_SIGNAL_ALLOWED_WINDOWS_MS = '14400000,86400000';
  process.env.TRADE_SIGNAL_NOTIFY_WINDOWS_MS  = '3600000';
  const route = _freshRequire('routes/resonanceSignal.js');
  const { server, port } = await _startServer(route);
  try {
    const r = await _get(port, '/api/trade/resonance-signal?symbol=BTCUSDT&windowMs=3600000&notify=false');
    assert.equal(r.status, 200);
    const snap = r.body.data.indicatorsSnapshot || {};
    assert.notEqual(snap.windowGated, true,
      '1h 在 NOTIFY 名单内不应被 windowGated 拦截');
    if (r.body.data.tier && r.body.data.tier !== 'NONE') {
      assert.equal(r.body.data.notifyOnly, true,
        `1h resonance ${r.body.data.tier} 必须带 notifyOnly:true`);
    }
  } finally {
    server.close();
  }
});

test('resonance-signal: windowMs=24h → 通过闸门', async () => {
  _mockBinance();
  process.env.TRADE_SIGNAL_ALLOWED_WINDOWS_MS = '14400000,86400000';
  process.env.TRADE_SIGNAL_NOTIFY_WINDOWS_MS  = '3600000';
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
  delete process.env.TRADE_SIGNAL_NOTIFY_WINDOWS_MS;
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
