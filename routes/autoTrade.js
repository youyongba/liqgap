'use strict';

/**
 * 自动交易 Webhook 状态 / 测试 / 开关 (Auto-Trade webhook status / test / kill switch)
 *
 *   GET  /api/auto-trade/status
 *     返回当前 webhook 配置 + 运行时开关状态 + 冷却 + staged + 复检历史。
 *
 *   POST /api/auto-trade/test
 *     绕过冷却 / 信号白名单 / 置信度门槛，立即发一条测试 payload，验证 URL+Token。
 *     ⚠️ 仍受运行时开关约束：disable 状态下会返回 disabled 错误。
 *     body: { direction?: 'long'|'short', symbol?: string, label?: string }
 *
 *   ─── 运行时开关 (Runtime kill switch · 不需要重启) ───────────────────────────
 *   POST /api/auto-trade/disable           关闭：禁止所有自动交易 webhook（最高优先级）
 *   POST /api/auto-trade/enable            打开：允许 webhook（覆盖 .env AUTO_TRADE_ENABLED=false）
 *   POST /api/auto-trade/toggle            翻转当前 enabled 状态
 *   POST /api/auto-trade/reset-override    复位：回到 .env 默认行为
 *     全部返回 { success: true, data: { enabled, runtimeOverride, source, ... } }
 *
 *   POST /api/auto-trade/reset-staged      清空 stage 队列 + 复检历史
 *   POST /api/auto-trade/reset-cooldowns   清空 symbol+direction 冷却计数
 */

const express = require('express');
const axios = require('axios');
const autoTrade = require('../services/autoTrade');

const router = express.Router();

router.get('/auto-trade/status', (req, res) => {
  res.json({ success: true, data: autoTrade.getStatus() });
});

router.post('/auto-trade/test', async (req, res) => {
  const url = process.env.AUTO_TRADE_API_URL;
  if (!url) {
    return res.json({
      success: false,
      error: 'AUTO_TRADE_API_URL not configured in .env'
    });
  }
  // 运行时开关被关 → 测试 webhook 也禁止，避免"以为关了却还能发"的误导
  if (!autoTrade.isEnabled()) {
    const st = autoTrade.getEnabledStatus();
    return res.json({
      success: false,
      error: `auto-trade is disabled (source=${st.source}). Call POST /api/auto-trade/enable first.`,
      data: { enabledStatus: st }
    });
  }
  const direction = String((req.body && req.body.direction) || 'short').toLowerCase();
  if (direction !== 'long' && direction !== 'short') {
    return res.json({ success: false, error: 'direction must be "long" or "short"' });
  }
  const symbol = String((req.body && req.body.symbol) || 'BTCUSDT').toUpperCase();
  const label = (req.body && req.body.label) || `${symbol}-AUTO-TRADE-TEST`;
  const source = process.env.AUTO_TRADE_SOURCE || 'liq-signal';
  const payload = { direction, source, label };

  try {
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      Accept: 'application/json, */*',
      'User-Agent': 'liq-gap/1.0 (+auto-trade-test)'
    };
    if (process.env.AUTO_TRADE_API_TOKEN) {
      headers['X-Auth-Token'] = process.env.AUTO_TRADE_API_TOKEN;
    }
    const r = await axios.post(url, payload, { headers, timeout: 8000 });
    res.json({ success: true, data: { status: r.status, response: r.data, sent: payload } });
  } catch (err) {
    const status = err.response && err.response.status;
    res.json({
      success: false,
      error: `auto-trade test failed (HTTP ${status || 'NETERR'}): ${err.message}`,
      data: { sent: payload, response: err.response && err.response.data }
    });
  }
});

router.post('/auto-trade/reset-staged', (_req, res) => {
  autoTrade.resetStaged();
  res.json({ success: true, data: { cleared: true } });
});

router.post('/auto-trade/reset-cooldowns', (_req, res) => {
  autoTrade.resetCooldowns();
  res.json({ success: true, data: { cleared: true } });
});

// ────────────────────────────────────────────────────────────────────────────
// 运行时开关 (Runtime kill switch)
// ────────────────────────────────────────────────────────────────────────────
// 三个语义化 endpoint + 一个复位 endpoint。任何一个都返回当前完整状态，
// 前端 UI 拿到 enabled 字段直接更新按钮即可。
router.post('/auto-trade/disable', (_req, res) => {
  const before = autoTrade.isEnabled();
  const status = autoTrade.setEnabled(false);
  // eslint-disable-next-line no-console
  console.log(`[auto-trade] runtime kill-switch DISABLED (was enabled=${before}) → ${JSON.stringify(status)}`);
  res.json({ success: true, data: status });
});

router.post('/auto-trade/enable', (_req, res) => {
  const before = autoTrade.isEnabled();
  const status = autoTrade.setEnabled(true);
  // eslint-disable-next-line no-console
  console.log(`[auto-trade] runtime kill-switch ENABLED (was enabled=${before}) → ${JSON.stringify(status)}`);
  res.json({ success: true, data: status });
});

router.post('/auto-trade/toggle', (_req, res) => {
  const current = autoTrade.isEnabled();
  const status = autoTrade.setEnabled(!current);
  // eslint-disable-next-line no-console
  console.log(`[auto-trade] runtime kill-switch TOGGLED enabled=${current}→${status.enabled}`);
  res.json({ success: true, data: status });
});

router.post('/auto-trade/reset-override', (_req, res) => {
  const status = autoTrade.setEnabled(null);
  // eslint-disable-next-line no-console
  console.log(`[auto-trade] runtime override RESET → follows .env (enabled=${status.enabled}, source=${status.source})`);
  res.json({ success: true, data: status });
});

module.exports = router;
