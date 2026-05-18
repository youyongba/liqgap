'use strict';

/* eslint-disable no-console */
/**
 * autoTrade 二次确认 (Stage + Confirm) 冷烟测试
 *
 * 覆盖：
 *   1. CONFIRMATION_DELAY_MS=0 → 立即发送（保持旧行为不回归）
 *   2. CONFIRMATION_DELAY_MS=200 + 复检通过 → 延迟后 _doSend 真正发送
 *   3. CONFIRMATION_DELAY_MS=200 + 复检失败（signal 变 NONE）→ 撤销 + 写 stageHistory
 *   4. CONFIRMATION_DELAY_MS=200 + 复检失败（confidence 跌破阈值）→ 撤销
 *   5. 同 stageKey 已 staged → 后续重复信号被跳过
 *   6. resetStaged 清空所有
 *
 * 运行：node scripts/test-autotrade-stage-smoke.js
 */

require('dotenv').config({ override: false });
const path = require('path');
const http = require('http');
const assert = require('assert');

// 关掉外部副作用 + 收紧时间参数
delete process.env.FEISHU_WEBHOOK_URL;
delete process.env.FEISHU_WEBHOOK_SECRET;
process.env.AUTO_TRADE_TRIGGER_SIGNALS = 'HEXA_RESONANCE_LONG,HEXA_RESONANCE_SHORT,TRIO_RESONANCE_LONG,TRIO_RESONANCE_SHORT';
process.env.AUTO_TRADE_MIN_CONFIDENCE = '88';
process.env.AUTO_TRADE_COOLDOWN_MS = '0';

let passed = 0, failed = 0;
const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}
async function runAll() {
  for (const c of cases) {
    try {
      await c.fn();
      passed += 1;
      console.log(`✓ ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`✗ ${c.name}\n   ${err.message}`);
    }
  }
  console.log(`\n${passed} passed · ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

function _freshRequire(p) {
  const abs = require.resolve(path.join(__dirname, '..', p));
  delete require.cache[abs];
  return require(abs);
}

// 启动一个 mock 服务：
//   • mockWebhookServer 收所有 POST → 记到 receivedWebhooks
//   • mockRefetchServer 模拟本机 /api/trade/{liq|resonance}-signal
//     - 用 currentRefetchResponse 控制返回什么（可在测试中替换）
let receivedWebhooks = [];
let currentRefetchResponse = null;
let mockServerPort = 0;
let mockServer = null;
let webhookServerPort = 0;
let webhookServer = null;

async function _startServers() {
  receivedWebhooks = [];

  // Webhook 收集服务
  webhookServer = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (b) => { buf += b; });
    req.on('end', () => {
      try { receivedWebhooks.push({ url: req.url, body: JSON.parse(buf) }); } catch (_) {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => webhookServer.on('listening', r));
  webhookServerPort = webhookServer.address().port;

  // 复检 mock 服务：处理 /api/trade/liq-signal 和 /api/trade/resonance-signal
  mockServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      data: currentRefetchResponse || { signal: 'NONE', confidence: 0, indicatorsSnapshot: {} }
    }));
  }).listen(0, '127.0.0.1');
  await new Promise((r) => mockServer.on('listening', r));
  mockServerPort = mockServer.address().port;
  process.env.PORT = String(mockServerPort);
  process.env.AUTO_TRADE_CONFIRM_HOST = '127.0.0.1';
  process.env.AUTO_TRADE_API_URL = `http://127.0.0.1:${webhookServerPort}/webhook`;
}

function _stopServers() {
  if (mockServer) mockServer.close();
  if (webhookServer) webhookServer.close();
}

function _wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// 1. delay=0 立即发送（保护旧行为）
// ============================================================================
test('delay=0 → 立即发送 webhook，不进 stage 队列', async () => {
  await _startServers();
  try {
    process.env.AUTO_TRADE_CONFIRMATION_DELAY_MS = '0';
    const autoTrade = _freshRequire('services/autoTrade.js');
    autoTrade.resetCooldowns(); autoTrade.resetStaged();
    autoTrade.resetRecentCalls();
    const r = await autoTrade.sendPendingOrder({
      signal: 'HEXA_RESONANCE_LONG', direction: 'long', confidence: 95, symbol: 'BTCUSDT'
    });
    assert.equal(r.ok, true, '应立即成功');
    assert.notEqual(r.staged, true, '不应进 stage');
    await _wait(50);
    assert.equal(receivedWebhooks.length, 1, '应收到 1 个 webhook');
    assert.equal(autoTrade.getStagedSignals().length, 0, 'stage 队列应空');
  } finally {
    _stopServers();
  }
});

// ============================================================================
// 2. delay>0 + 复检通过 → 延迟后真发送
// ============================================================================
test('delay=200 + 复检通过 → 200ms 后真发送', async () => {
  await _startServers();
  try {
    process.env.AUTO_TRADE_CONFIRMATION_DELAY_MS = '200';
    currentRefetchResponse = {
      signal: 'HEXA_RESONANCE_LONG',
      side: 'long',
      confidence: 93,
      indicatorsSnapshot: {}
    };
    const autoTrade = _freshRequire('services/autoTrade.js');
    autoTrade.resetCooldowns(); autoTrade.resetStaged();
    autoTrade.resetRecentCalls();
    const r = await autoTrade.sendPendingOrder({
      signal: 'HEXA_RESONANCE_LONG', direction: 'long', confidence: 95, symbol: 'BTCUSDT',
      extra: { windowMs: 86400000 }
    });
    assert.equal(r.staged, true, '应进 stage');
    assert.ok(r.confirmAt > Date.now(), 'confirmAt 应为未来时间');
    assert.equal(autoTrade.getStagedSignals().length, 1, 'stage 队列应有 1 个');
    assert.equal(receivedWebhooks.length, 0, '此时 webhook 不应已发');

    await _wait(400);
    assert.equal(receivedWebhooks.length, 1, '延迟后应发出 webhook');
    assert.equal(receivedWebhooks[0].body.direction, 'long');
    const hist = autoTrade.getStageHistory();
    assert.equal(hist.length, 1);
    assert.equal(hist[0].status, 'confirmed');
    assert.equal(hist[0].confirmedConfidence, 93, '复检后 confidence 应被更新为最新值');
  } finally {
    _stopServers();
  }
});

// ============================================================================
// 3. 复检失败：signal 变 NONE → 撤销
// ============================================================================
test('delay=200 + 复检 signal=NONE → 撤销 + 不发 webhook', async () => {
  await _startServers();
  try {
    process.env.AUTO_TRADE_CONFIRMATION_DELAY_MS = '200';
    currentRefetchResponse = { signal: 'NONE', confidence: 0, indicatorsSnapshot: {} };
    const autoTrade = _freshRequire('services/autoTrade.js');
    autoTrade.resetCooldowns(); autoTrade.resetStaged();
    autoTrade.resetRecentCalls();
    const r = await autoTrade.sendPendingOrder({
      signal: 'HEXA_RESONANCE_LONG', direction: 'long', confidence: 95, symbol: 'BTCUSDT',
      extra: { windowMs: 86400000 }
    });
    assert.equal(r.staged, true);

    await _wait(400);
    assert.equal(receivedWebhooks.length, 0, '复检失败不应发 webhook');
    const hist = autoTrade.getStageHistory();
    assert.equal(hist.length, 1);
    assert.equal(hist[0].status, 'rejected');
    assert.ok(/vanished|NONE/.test(hist[0].rejectReason),
      `reason 应说明 signal 消失，实际：${hist[0].rejectReason}`);
  } finally {
    _stopServers();
  }
});

// ============================================================================
// 4. 复检失败：confidence 跌破阈值
// ============================================================================
test('delay=200 + 复检 confidence 跌破阈值 → 撤销', async () => {
  await _startServers();
  try {
    process.env.AUTO_TRADE_CONFIRMATION_DELAY_MS = '200';
    currentRefetchResponse = {
      signal: 'HEXA_RESONANCE_LONG', side: 'long', confidence: 70, // < 88
      indicatorsSnapshot: {}
    };
    const autoTrade = _freshRequire('services/autoTrade.js');
    autoTrade.resetCooldowns(); autoTrade.resetStaged();
    autoTrade.resetRecentCalls();
    await autoTrade.sendPendingOrder({
      signal: 'HEXA_RESONANCE_LONG', direction: 'long', confidence: 95, symbol: 'BTCUSDT',
      extra: { windowMs: 86400000 }
    });
    await _wait(400);
    assert.equal(receivedWebhooks.length, 0);
    const hist = autoTrade.getStageHistory();
    assert.equal(hist[0].status, 'rejected');
    assert.ok(/confidence dropped/.test(hist[0].rejectReason));
  } finally {
    _stopServers();
  }
});

// ============================================================================
// 5. 同 stageKey 重复 stage → 后续被跳过
// ============================================================================
test('同 stageKey 已 staged → 后续重复信号 skipped', async () => {
  await _startServers();
  try {
    process.env.AUTO_TRADE_CONFIRMATION_DELAY_MS = '200';
    currentRefetchResponse = { signal: 'HEXA_RESONANCE_LONG', confidence: 95, indicatorsSnapshot: {} };
    const autoTrade = _freshRequire('services/autoTrade.js');
    autoTrade.resetCooldowns(); autoTrade.resetStaged();
    autoTrade.resetRecentCalls();
    const r1 = await autoTrade.sendPendingOrder({
      signal: 'HEXA_RESONANCE_LONG', direction: 'long', confidence: 95, symbol: 'BTCUSDT',
      extra: { windowMs: 86400000 }
    });
    const r2 = await autoTrade.sendPendingOrder({
      signal: 'HEXA_RESONANCE_LONG', direction: 'long', confidence: 99, symbol: 'BTCUSDT',
      extra: { windowMs: 86400000 }
    });
    assert.equal(r1.staged, true, '第 1 个应 staged');
    // 第 2 个会先被冷却拦截（因为 stage 时占了 lastSentBy）；这是预期行为
    assert.equal(r2.ok, false);
    assert.ok(/cooldown|already staged/i.test(r2.reason || ''),
      `r2 应被冷却或同 stageKey 拦截，实际：${r2.reason}`);
    // 等待第 1 个 confirm 完成，避免污染后续测试
    await _wait(400);
  } finally {
    _stopServers();
  }
});

// ============================================================================
// 6. resetStaged 清空所有
// ============================================================================
test('resetStaged 立即清空 stage 队列 + 历史', async () => {
  await _startServers();
  try {
    process.env.AUTO_TRADE_CONFIRMATION_DELAY_MS = '5000';
    currentRefetchResponse = { signal: 'HEXA_RESONANCE_LONG', confidence: 95, indicatorsSnapshot: {} };
    const autoTrade = _freshRequire('services/autoTrade.js');
    autoTrade.resetCooldowns(); autoTrade.resetStaged();
    autoTrade.resetRecentCalls();
    await autoTrade.sendPendingOrder({
      signal: 'HEXA_RESONANCE_LONG', direction: 'long', confidence: 95, symbol: 'BTCUSDT',
      extra: { windowMs: 86400000 }
    });
    assert.equal(autoTrade.getStagedSignals().length, 1);
    autoTrade.resetStaged();
    assert.equal(autoTrade.getStagedSignals().length, 0);
    assert.equal(autoTrade.getStageHistory().length, 0);
  } finally {
    _stopServers();
  }
});

// ============================================================================
runAll();
