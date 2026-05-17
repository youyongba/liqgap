'use strict';

/* eslint-disable no-console */
/**
 * 清算热图 Cross / Reclaim 警报冷烟测试
 *
 * 覆盖：
 *   1. buildLiquidationCrossCard: eventType=cross 红/绿配色与原行为一致
 *   2. buildLiquidationCrossCard: eventType=reclaim long 用绿色 / short 用红色（按交易方向）
 *   3. buildLiquidationCrossCard: reclaim 卡显示 Sweep 极值 / 穿越深度 / 收回深度 / 耗时
 *   4. POST /api/alerts/liquidation-cross  eventType=cross  → 200 + skipped=false
 *   5. POST /api/alerts/liquidation-cross  eventType=reclaim → 200 + skipped=false + payload 包含 sweep 字段
 *   6. cross 与 reclaim 是不同 eventType，互相不挤冷却（连发两种事件都应成功）
 *   7. 同事件第二次（< 冷却时间）→ skipped=true reason 包含 'cooldown'
 *   8. 缺少 peakPrice → 400 错误
 *
 * 运行：node scripts/test-reclaim-smoke.js
 */

require('dotenv').config();
const path = require('path');
const http = require('http');
const assert = require('assert');

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

// 取消飞书凭证（避免烟测真的去推送线上）
delete process.env.FEISHU_WEBHOOK_URL;
delete process.env.FEISHU_WEBHOOK_SECRET;
// 收紧冷却到 500ms，方便测试冷却生效
process.env.LIQ_CROSS_COOLDOWN_MS = '500';
process.env.LIQ_RECLAIM_COOLDOWN_MS = '500';

const feishu = require('../services/feishu');

// ============================================================================
// 1-3. Card builder
// ============================================================================
test('buildLiquidationCrossCard: eventType=cross long → 红色卡 + "击穿"标题', () => {
  const card = feishu.buildLiquidationCrossCard({
    symbol: 'BTCUSDT', side: 'long', eventType: 'cross',
    peakPrice: 79000, peakValue: 1.5e9,
    prevPrice: 79050, curPrice: 78900, crossDirection: 'down',
    timestamp: Date.now()
  });
  assert.equal(card.header.template, 'red', 'long cross 应该是红色');
  const title = card.header.title.content;
  assert.ok(title.includes('多头清算墙击穿'), `title 应包含"击穿"，实际：${title}`);
  const note = card.elements[card.elements.length - 1].elements[0].content;
  assert.ok(note.includes('liq-cross alert'), 'note 应标识 cross');
});

test('buildLiquidationCrossCard: eventType=cross short → 绿色卡', () => {
  const card = feishu.buildLiquidationCrossCard({
    symbol: 'BTCUSDT', side: 'short', eventType: 'cross',
    peakPrice: 82000, peakValue: 2e9,
    prevPrice: 81950, curPrice: 82050, crossDirection: 'up',
    timestamp: Date.now()
  });
  assert.equal(card.header.template, 'green', 'short cross 应该是绿色');
});

test('buildLiquidationCrossCard: eventType=reclaim long → 绿色卡（做多机会）', () => {
  const card = feishu.buildLiquidationCrossCard({
    symbol: 'BTCUSDT', side: 'long', eventType: 'reclaim',
    peakPrice: 79000, peakValue: 1.5e9,
    prevPrice: 78950, curPrice: 79100, crossDirection: 'up',
    sweepExtreme: 78850,
    sweepDurationMs: 420_000,
    pierceDepthPct: 0.0019,
    reclaimDepthPct: 0.00126,
    timestamp: Date.now()
  });
  assert.equal(card.header.template, 'green', 'long reclaim 应该是绿色（做多）');
  const title = card.header.title.content;
  assert.ok(title.includes('假突破收回'), `title 应包含"假突破收回"，实际：${title}`);
  assert.ok(title.includes('LONG'), `title 应包含 LONG，实际：${title}`);
  const body = card.elements[0].text.content;
  assert.ok(body.includes('78850'), 'body 应包含 sweepExtreme=78850');
  assert.ok(body.includes('0.190%'), `body 应包含 pierce 0.190%，实际：${body}`);
  assert.ok(body.includes('0.126%'), `body 应包含 reclaim 0.126%，实际：${body}`);
  assert.ok(body.includes('7.0min'), `body 应包含 duration 7.0min，实际：${body}`);
  assert.ok(body.includes('做多机会'), 'body 应包含"做多机会"');
  const note = card.elements[card.elements.length - 1].elements[0].content;
  assert.ok(note.includes('liq-reclaim alert'), 'note 应标识 reclaim');
});

test('buildLiquidationCrossCard: eventType=reclaim short → 红色卡（做空机会）', () => {
  const card = feishu.buildLiquidationCrossCard({
    symbol: 'BTCUSDT', side: 'short', eventType: 'reclaim',
    peakPrice: 82000, peakValue: 2e9,
    prevPrice: 82050, curPrice: 81900, crossDirection: 'down',
    sweepExtreme: 82150,
    sweepDurationMs: 90_000,
    pierceDepthPct: 0.00183,
    reclaimDepthPct: 0.00122,
    timestamp: Date.now()
  });
  assert.equal(card.header.template, 'red', 'short reclaim 应该是红色（做空）');
  const title = card.header.title.content;
  assert.ok(title.includes('SHORT'), `title 应包含 SHORT，实际：${title}`);
  const body = card.elements[0].text.content;
  assert.ok(body.includes('82150'), 'body 应包含 sweepExtreme=82150');
  assert.ok(body.includes('做空机会'), 'body 应包含"做空机会"');
});

test('buildLiquidationCrossCard: 不传 eventType → 默认走 cross 路径（兼容旧客户端）', () => {
  const card = feishu.buildLiquidationCrossCard({
    symbol: 'BTCUSDT', side: 'long',
    peakPrice: 79000, peakValue: 1.5e9,
    prevPrice: 79050, curPrice: 78900, crossDirection: 'down',
    timestamp: Date.now()
  });
  const title = card.header.title.content;
  assert.ok(title.includes('击穿'), 'eventType 缺省应走 cross 路径');
});

// ============================================================================
// 4-8. HTTP route
// ============================================================================
async function _postJson(port, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port,
      path: '/api/alerts/liquidation-cross',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (r) => {
      let buf = '';
      r.on('data', (b) => { buf += b; });
      r.on('end', () => {
        try {
          resolve({ status: r.statusCode, body: JSON.parse(buf) });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function _startServer() {
  // 模块缓存清掉，确保 process.env.LIQ_*_COOLDOWN_MS 在 require 时生效
  const routePath = require.resolve(path.join(__dirname, '..', 'routes', 'alertCross.js'));
  delete require.cache[routePath];
  const express = require('express');
  const route = require('../routes/alertCross');
  const app = express();
  app.use(express.json());
  app.use('/api', route);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((res) => server.on('listening', res));
  return { server, port: server.address().port };
}

test('POST /alerts/liquidation-cross: eventType=cross → 200 + skipped=false', async () => {
  const { server, port } = await _startServer();
  try {
    const r = await _postJson(port, {
      symbol: 'BTCUSDT', side: 'long', eventType: 'cross',
      peakPrice: 79000, peakValue: 1.5e9,
      prevPrice: 79050, curPrice: 78900, crossDirection: 'down'
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.success);
    assert.equal(r.body.data.skipped, false, '首次触发不应被跳过');
    assert.equal(r.body.data.payload.eventType, 'cross');
  } finally {
    server.close();
  }
});

test('POST /alerts/liquidation-cross: eventType=reclaim → 200 + payload 含 sweep 字段', async () => {
  const { server, port } = await _startServer();
  try {
    const r = await _postJson(port, {
      symbol: 'BTCUSDT', side: 'long', eventType: 'reclaim',
      peakPrice: 79000, peakValue: 1.5e9,
      prevPrice: 78950, curPrice: 79100, crossDirection: 'up',
      sweepExtreme: 78850, sweepDurationMs: 420_000,
      pierceDepthPct: 0.0019, reclaimDepthPct: 0.00126
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.skipped, false);
    const p = r.body.data.payload;
    assert.equal(p.eventType, 'reclaim');
    assert.equal(p.sweepExtreme, 78850);
    assert.equal(p.sweepDurationMs, 420_000);
    assert.ok(Math.abs(p.pierceDepthPct - 0.0019) < 1e-9);
    assert.ok(Math.abs(p.reclaimDepthPct - 0.00126) < 1e-9);
  } finally {
    server.close();
  }
});

test('瞬间插针 (sweepDurationMs < 1s) reclaim payload 能正确处理 + 卡片包含 sub-1s 标识', async () => {
  const { server, port } = await _startServer();
  try {
    // 模拟前端 INSTANT-RECLAIM 路径：同采样周期内一次完成 idle → swept → reclaim
    // 典型场景：1m K 线内大单插针后立即收回，整段 sweep ≤ 500ms
    const r = await _postJson(port, {
      symbol: 'BTCUSDT', side: 'short', eventType: 'reclaim',
      peakPrice: 82000, peakValue: 2e9,
      prevPrice: 82010, curPrice: 81930, crossDirection: 'down',
      sweepExtreme: 82245,        // K 线 high 触到 82245（高于 peak * 1.001 = 82082）
      sweepDurationMs: 420,        // ⭐ 瞬间插针：sweep 持续 < 1 秒
      pierceDepthPct: 0.00298,
      reclaimDepthPct: 0.00085
    });
    assert.equal(r.status, 200, '后端应接受瞬间插针 reclaim payload');
    assert.equal(r.body.data.skipped, false);
    const p = r.body.data.payload;
    assert.equal(p.sweepDurationMs, 420, '后端应保留 sub-1s 的 sweepDurationMs');
    assert.equal(p.sweepExtreme, 82245, '后端应保留 K 线 high 作为 sweepExtreme（不是 close 价）');

    // 飞书卡 duration 字段应该显示"420s"或近似格式（人类可读）
    const card = feishu.buildLiquidationCrossCard(p);
    const body = card.elements[0].text.content;
    // sub-1s 触发时 fmtDur 会给出秒数
    assert.ok(/0s|1s/.test(body) || /420ms|0\.4s/.test(body), `body 应显示 sub-1s duration，实际：${body}`);
  } finally {
    server.close();
  }
});

test('cross 与 reclaim 独立冷却：同 side 连发 cross+reclaim 都应成功', async () => {
  const { server, port } = await _startServer();
  try {
    const a = await _postJson(port, {
      symbol: 'BTCUSDT', side: 'long', eventType: 'cross',
      peakPrice: 79000, peakValue: 1e9, prevPrice: 79050, curPrice: 78900,
      crossDirection: 'down'
    });
    const b = await _postJson(port, {
      symbol: 'BTCUSDT', side: 'long', eventType: 'reclaim',
      peakPrice: 79000, peakValue: 1e9, prevPrice: 78950, curPrice: 79100,
      crossDirection: 'up', sweepExtreme: 78850,
      sweepDurationMs: 10_000, pierceDepthPct: 0.0019, reclaimDepthPct: 0.00126
    });
    assert.equal(a.body.data.skipped, false, 'cross 应触发');
    assert.equal(b.body.data.skipped, false, 'reclaim 应触发（不应被 cross 的冷却挤掉）');
  } finally {
    server.close();
  }
});

test('同事件二次：< 冷却时间 → skipped=true（reason 含 cooldown）', async () => {
  const { server, port } = await _startServer();
  try {
    const a = await _postJson(port, {
      symbol: 'BTCUSDT', side: 'long', eventType: 'cross',
      peakPrice: 79000, peakValue: 1e9, prevPrice: 79050, curPrice: 78900,
      crossDirection: 'down'
    });
    const b = await _postJson(port, {
      symbol: 'BTCUSDT', side: 'long', eventType: 'cross',
      peakPrice: 79005, peakValue: 1e9, prevPrice: 79050, curPrice: 78900,
      crossDirection: 'down'
    });
    assert.equal(a.body.data.skipped, false, '首次应触发');
    assert.equal(b.body.data.skipped, true, '冷却期内同事件应被跳过');
    assert.ok(/cooldown/i.test(b.body.data.reason || ''), `reason 应含 cooldown，实际：${b.body.data.reason}`);
  } finally {
    server.close();
  }
});

test('缺少 peakPrice → 400', async () => {
  const { server, port } = await _startServer();
  try {
    const r = await _postJson(port, {
      symbol: 'BTCUSDT', side: 'long', eventType: 'cross',
      prevPrice: 79050, curPrice: 78900
    });
    assert.equal(r.status, 400);
    assert.ok(/peakPrice/.test(r.body.error || ''));
  } finally {
    server.close();
  }
});

test('status endpoint 返回 crossCooldownMs + reclaimCooldownMs', async () => {
  const { server, port } = await _startServer();
  try {
    const r = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/alerts/liquidation-cross/status' }, (rr) => {
        let buf = '';
        rr.on('data', (b) => { buf += b; });
        rr.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
      }).on('error', reject);
    });
    assert.ok(r.success);
    assert.equal(r.data.crossCooldownMs, 500, 'crossCooldownMs 应反映 env 覆盖');
    assert.equal(r.data.reclaimCooldownMs, 500, 'reclaimCooldownMs 应反映 env 覆盖');
  } finally {
    server.close();
  }
});

// ============================================================================
process.on('exit', () => {
  console.log(`\n${passed} passed · ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
});
