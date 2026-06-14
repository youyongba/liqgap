'use strict';

/* eslint-disable no-console */
/**
 * 自动交易运行时开关 (Auto-Trade Runtime Kill Switch) 冷烟测试
 *
 * 覆盖：
 *   1. 默认关闭(opt-in)：URL 配置 + AUTO_TRADE_ENABLED 未显式 true → isEnabled()=false
 *   2. .env AUTO_TRADE_ENABLED=false → isEnabled()=false (env-disabled)
 *   3. runtime override = true → 覆盖 env-disabled (runtime-enabled)
 *   4. runtime override = false → 最高优先级，全部禁 (runtime-disabled)
 *   5. URL 未配置 → 永远禁 (no-url)，runtime override 无法救
 *   6. sendPendingOrder 在 disable 状态下 → ok:false, skipped:true
 *   7. setEnabled(null) 复位 → 回到 .env 行为
 *   8. _doSend 内部二次防御：stage 期间被 disable → 真正发送前拒绝
 *   9. POST endpoints (/disable /enable /toggle /reset-override) → 状态切换正确
 *  10. /auto-trade/test 在 disable 状态下 → 返回 error，不真调 axios
 *
 * 运行：node scripts/test-autotrade-kill-switch-smoke.js
 */

require('dotenv').config();
const path = require('path');
const http = require('http');
const assert = require('assert');

delete process.env.FEISHU_WEBHOOK_URL;

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { passed += 1; console.log(`✓ ${name}`); })
        .catch((err) => { failed += 1; console.error(`✗ ${name}\n   ${err.message}\n   ${err.stack}`); });
    }
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`✗ ${name}\n   ${err.message}`);
  }
}

function _freshRequire(p) {
  const abs = require.resolve(path.join(__dirname, '..', p));
  delete require.cache[abs];
  return require(abs);
}

// Mock axios：不真发 POST，记录调用次数和 URL
function _mockAxios() {
  const axiosPath = require.resolve('axios');
  const calls = [];
  const fake = {
    post: async (url, payload) => {
      calls.push({ url, payload });
      return { status: 200, data: { ok: true } };
    },
    get: async (url) => {
      calls.push({ url, method: 'GET' });
      return { status: 200, data: { success: true, data: { signal: 'NONE' } } };
    }
  };
  // axios 既 export default 也可能用作 namespace
  require.cache[axiosPath] = {
    id: axiosPath, filename: axiosPath, loaded: true,
    exports: Object.assign(fake, { default: fake })
  };
  return calls;
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

function _request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path, method,
      headers: data
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        : {}
    }, (r) => {
      let buf = '';
      r.on('data', (b) => { buf += b; });
      r.on('end', () => {
        try { resolve({ status: r.statusCode, body: JSON.parse(buf) }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ============================================================================
// 1-7. services/autoTrade.js 单元行为
// ============================================================================
test('1. 默认关闭(opt-in)：URL 配置 + AUTO_TRADE_ENABLED 未显式 true → enabled=false', () => {
  process.env.AUTO_TRADE_API_URL = 'http://fake.example/webhook';
  delete process.env.AUTO_TRADE_ENABLED;
  const at = _freshRequire('services/autoTrade');
  const st = at.getEnabledStatus();
  assert.equal(st.enabled, false, '缺省应关闭，需显式 =true 才开');
  assert.equal(st.runtimeOverride, null);
  assert.equal(st.source, 'env-disabled');
});

test('1b. 显式 AUTO_TRADE_ENABLED=true + URL 配置 → enabled=true (env-enabled)', () => {
  process.env.AUTO_TRADE_API_URL = 'http://fake.example/webhook';
  process.env.AUTO_TRADE_ENABLED = 'true';
  const at = _freshRequire('services/autoTrade');
  const st = at.getEnabledStatus();
  assert.equal(st.enabled, true);
  assert.equal(st.source, 'env-enabled');
});

test('2. .env AUTO_TRADE_ENABLED=false → enabled=false (env-disabled)', () => {
  process.env.AUTO_TRADE_API_URL = 'http://fake.example/webhook';
  process.env.AUTO_TRADE_ENABLED = 'false';
  const at = _freshRequire('services/autoTrade');
  const st = at.getEnabledStatus();
  assert.equal(st.enabled, false);
  assert.equal(st.source, 'env-disabled');
});

test('3. runtime override=true → 覆盖 env-disabled (runtime-enabled)', () => {
  process.env.AUTO_TRADE_API_URL = 'http://fake.example/webhook';
  process.env.AUTO_TRADE_ENABLED = 'false';
  const at = _freshRequire('services/autoTrade');
  at.setEnabled(true);
  const st = at.getEnabledStatus();
  assert.equal(st.enabled, true);
  assert.equal(st.runtimeOverride, true);
  assert.equal(st.source, 'runtime-enabled');
});

test('4. runtime override=false → 最高优先级 (runtime-disabled)', () => {
  process.env.AUTO_TRADE_API_URL = 'http://fake.example/webhook';
  delete process.env.AUTO_TRADE_ENABLED;
  const at = _freshRequire('services/autoTrade');
  at.setEnabled(false);
  const st = at.getEnabledStatus();
  assert.equal(st.enabled, false);
  assert.equal(st.source, 'runtime-disabled');
});

test('5. URL 未配置 → 永远禁 (no-url)，runtime=true 也救不了', () => {
  delete process.env.AUTO_TRADE_API_URL;
  delete process.env.AUTO_TRADE_ENABLED;
  const at = _freshRequire('services/autoTrade');
  at.setEnabled(true);
  const st = at.getEnabledStatus();
  assert.equal(st.enabled, false);
  assert.equal(st.source, 'no-url');
});

test('6. sendPendingOrder 在 disable 状态下 → ok:false, skipped:true, 不发 axios', async () => {
  process.env.AUTO_TRADE_API_URL = 'http://fake.example/webhook';
  process.env.AUTO_TRADE_TRIGGER_SIGNALS = 'HEXA_RESONANCE_LONG';
  process.env.AUTO_TRADE_MIN_CONFIDENCE = '75';
  process.env.AUTO_TRADE_CONFIRMATION_DELAY_MS = '0';
  delete process.env.AUTO_TRADE_ENABLED;
  const axiosCalls = _mockAxios();
  const at = _freshRequire('services/autoTrade');
  at.setEnabled(false);
  const r = await at.sendPendingOrder({
    signal: 'HEXA_RESONANCE_LONG', direction: 'long', confidence: 95, symbol: 'BTCUSDT'
  });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, true);
  assert.ok(/disabled|not set/.test(r.reason), `reason 应说明被禁用：${r.reason}`);
  assert.equal(axiosCalls.length, 0, 'axios.post 不应被调用');
});

test('7. setEnabled(null) 复位 → 回到 .env 行为 (env=true 时复位为开)', () => {
  process.env.AUTO_TRADE_API_URL = 'http://fake.example/webhook';
  process.env.AUTO_TRADE_ENABLED = 'true';
  const at = _freshRequire('services/autoTrade');
  at.setEnabled(false);
  assert.equal(at.isEnabled(), false);
  at.setEnabled(null);
  const st = at.getEnabledStatus();
  assert.equal(st.runtimeOverride, null);
  assert.equal(st.enabled, true);
  assert.equal(st.source, 'env-enabled');
});

// ============================================================================
// 8. 二次防御：stage 期间被 disable
// ============================================================================
test('8. _doSend 二次防御：sendPendingOrder 中途切 disable → 不真发 axios', async () => {
  process.env.AUTO_TRADE_API_URL = 'http://fake.example/webhook';
  process.env.AUTO_TRADE_TRIGGER_SIGNALS = 'HEXA_RESONANCE_LONG';
  process.env.AUTO_TRADE_MIN_CONFIDENCE = '75';
  process.env.AUTO_TRADE_CONFIRMATION_DELAY_MS = '0';
  delete process.env.AUTO_TRADE_ENABLED;
  const axiosCalls = _mockAxios();
  const at = _freshRequire('services/autoTrade');
  at.setEnabled(true);
  // shouldFire 通过后，构造一个手工调用 _doSend 已经无法直接访问；
  // 用法：sendPendingOrder 走到 _doSend 前发现 isEnabled 仍 true → 进入 _doSend
  // → 在 _doSend 开头再次 isEnabled 检查（防 stage 期切换）。
  // 这里通过先 setEnabled(true) 让 shouldFire 通过，再立即 setEnabled(false)，
  // 因为 delay=0 同步调用 _doSend，几乎不可能切换；所以本测试主要验证
  // "_doSend 顶部确实有 isEnabled() 检查" —— 检查实现而不是时序。
  const code = require('fs').readFileSync(
    path.join(__dirname, '..', 'services', 'autoTrade.js'), 'utf8'
  );
  assert.ok(/async function _doSend[\s\S]{0,400}isEnabled\(\)/.test(code),
    '_doSend 函数体内应有 isEnabled() 检查，作为 stage 期切换的二次防御');
  // 行为验证：disable 后发送被拦
  at.setEnabled(false);
  const r = await at.sendPendingOrder({
    signal: 'HEXA_RESONANCE_LONG', direction: 'long', confidence: 95, symbol: 'BTCUSDT'
  });
  assert.equal(r.ok, false);
  assert.equal(axiosCalls.length, 0);
});

// ============================================================================
// 9. POST endpoints
// ============================================================================
test('9a. POST /auto-trade/disable → 返回 enabled:false, source:runtime-disabled', async () => {
  process.env.AUTO_TRADE_API_URL = 'http://fake.example/webhook';
  delete process.env.AUTO_TRADE_ENABLED;
  _mockAxios();
  _freshRequire('services/autoTrade').setEnabled(null);
  const route = _freshRequire('routes/autoTrade');
  const { server, port } = await _startServer(route);
  try {
    const r = await _request(port, 'POST', '/api/auto-trade/disable');
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.data.enabled, false);
    assert.equal(r.body.data.source, 'runtime-disabled');
    assert.equal(r.body.data.runtimeOverride, false);
  } finally {
    server.close();
  }
});

test('9b. POST /auto-trade/enable → 返回 enabled:true', async () => {
  process.env.AUTO_TRADE_API_URL = 'http://fake.example/webhook';
  process.env.AUTO_TRADE_ENABLED = 'false';
  _mockAxios();
  _freshRequire('services/autoTrade').setEnabled(null);
  const route = _freshRequire('routes/autoTrade');
  const { server, port } = await _startServer(route);
  try {
    const r = await _request(port, 'POST', '/api/auto-trade/enable');
    assert.equal(r.body.data.enabled, true);
    assert.equal(r.body.data.source, 'runtime-enabled');
    assert.equal(r.body.data.runtimeOverride, true);
  } finally {
    server.close();
  }
});

test('9c. POST /auto-trade/toggle → 翻转状态两次回到原值（默认关闭起步）', async () => {
  process.env.AUTO_TRADE_API_URL = 'http://fake.example/webhook';
  delete process.env.AUTO_TRADE_ENABLED;
  _mockAxios();
  _freshRequire('services/autoTrade').setEnabled(null);
  const route = _freshRequire('routes/autoTrade');
  const { server, port } = await _startServer(route);
  try {
    const r1 = await _request(port, 'POST', '/api/auto-trade/toggle');
    assert.equal(r1.body.data.enabled, true, '从默认 OFF toggle 到 ON');
    const r2 = await _request(port, 'POST', '/api/auto-trade/toggle');
    assert.equal(r2.body.data.enabled, false, '从 ON 再 toggle 回 OFF');
  } finally {
    server.close();
  }
});

test('9d. POST /auto-trade/reset-override → runtimeOverride 回 null（跟随 .env）', async () => {
  // 注：本文件 async 测试并发共享 process.env，故这里不断言具体 env 值，
  // 只验证 reset 后 runtimeOverride=null 且 source 回到 env-* 系列（不再 runtime-*）。
  process.env.AUTO_TRADE_API_URL = 'http://fake.example/webhook';
  _mockAxios();
  const at = _freshRequire('services/autoTrade');
  at.setEnabled(false); // 先制造一个 runtime override
  const route = _freshRequire('routes/autoTrade');
  const { server, port } = await _startServer(route);
  try {
    const r = await _request(port, 'POST', '/api/auto-trade/reset-override');
    assert.equal(r.body.data.runtimeOverride, null);
    assert.ok(/^env-/.test(r.body.data.source), `复位后应跟随 env，实际 source=${r.body.data.source}`);
  } finally {
    server.close();
  }
});

// ============================================================================
// 10. test endpoint 受运行时开关约束
// ============================================================================
test('10. POST /auto-trade/test 在 disable 状态 → 返回 error，不真调 axios', async () => {
  process.env.AUTO_TRADE_API_URL = 'http://fake.example/webhook';
  delete process.env.AUTO_TRADE_ENABLED;
  const axiosCalls = _mockAxios();
  _freshRequire('services/autoTrade').setEnabled(false);
  const route = _freshRequire('routes/autoTrade');
  const { server, port } = await _startServer(route);
  try {
    const r = await _request(port, 'POST', '/api/auto-trade/test', { direction: 'short' });
    assert.equal(r.body.success, false);
    assert.ok(/disabled/i.test(r.body.error), `error 应说明被禁用：${r.body.error}`);
    assert.equal(axiosCalls.length, 0, '/test endpoint 不应在 disable 状态下真调 axios');
  } finally {
    server.close();
  }
});

// ============================================================================
process.on('exit', () => {
  console.log(`\n${passed} passed · ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
});
