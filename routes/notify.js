'use strict';

/**
 * 飞书推送相关 HTTP 端点 (Feishu webhook helper endpoints)
 *
 *  GET  /api/notify/status          查看 webhook 是否配置 + 最近一次推送状态
 *  POST /api/notify/test            发送一条测试卡片，验证 webhook 可达 / 签名正确
 *  POST /api/notify/signal          手动推送当前 /api/trade/signal 的最新结果
 *                                  body: { symbol?, market?, force?: true }
 *                                  force=true 时绕过去重 / 冷却 (manual override).
 *
 * 所有失败仍以 HTTP 200 + { success:false, error } 返回，便于前端解析。
 */

const express = require('express');
const axios = require('axios');
const feishu = require('../services/feishu');

const router = express.Router();

router.get('/notify/status', (_req, res) => {
  res.json({
    success: true,
    data: {
      enabled: feishu.isEnabled(),
      webhookConfigured: !!process.env.FEISHU_WEBHOOK_URL,
      signedRequest: !!process.env.FEISHU_WEBHOOK_SECRET,
      cooldownMs:
        Number(process.env.FEISHU_NOTIFY_COOLDOWN_MS) || 30 * 60 * 1000,
      lastNotified: feishu.getLastNotifiedSnapshot()
    }
  });
});

router.post('/notify/test', async (_req, res) => {
  if (!feishu.isEnabled()) {
    return res.json({
      success: false,
      error: 'FEISHU_WEBHOOK_URL 未配置，或 FEISHU_NOTIFY_ENABLED=false'
    });
  }
  const text =
    `liq-gap webhook 测试 / Test ping · ${new Date().toLocaleString('zh-CN', { hour12: false })}\n` +
    '若你看到这条消息，说明 webhook 连通 + 签名正确。';
  const r = await feishu.sendText(text);
  if (r.ok) {
    return res.json({ success: true, data: { message: 'sent', response: r.response } });
  }
  return res.json({ success: false, error: r.error || 'feishu send failed', response: r.response });
});

/**
 * 手动推送当前信号 (Manually push the current signal).
 *
 * 实现：内部反向调用 /api/trade/signal 拿最新数据再推送，避免逻辑重复。
 * (Re-fetch from our own /api/trade/signal so we always push the latest.)
 *
 * Body 字段 (POST JSON · 都可选):
 *   symbol         默认 'BTCUSDT'
 *   market         'spot' | 'futures'，默认 'futures'
 *   force          true → 绕过冷却 / 去重 (manual override)
 *   accountBalance 透传给 /api/trade/signal
 *   riskPercent    透传给 /api/trade/signal
 */
router.post('/notify/signal', async (req, res) => {
  if (!feishu.isEnabled()) {
    return res.json({
      success: false,
      error: 'FEISHU_WEBHOOK_URL 未配置，或 FEISHU_NOTIFY_ENABLED=false'
    });
  }
  const body = req.body || {};
  const symbol = String(body.symbol || 'BTCUSDT').toUpperCase();
  const market = body.market === 'spot' ? 'spot' : 'futures';
  const force = body.force === true || body.force === 'true';

  // 反向调用 /api/trade/signal · notify=false 防止递归推送
  const params = new URLSearchParams({
    symbol,
    market,
    notify: 'false'
  });
  if (body.accountBalance != null) params.set('accountBalance', String(body.accountBalance));
  if (body.riskPercent != null) params.set('riskPercent', String(body.riskPercent));
  const port = process.env.PORT || 3000;
  const url = `http://127.0.0.1:${port}/api/trade/signal?${params.toString()}`;
  let signalResp;
  try {
    const r = await axios.get(url, { timeout: 30000 });
    signalResp = r.data;
  } catch (err) {
    return res.json({
      success: false,
      error: `获取最新信号失败: ${err.message}`
    });
  }

  if (!signalResp || !signalResp.success) {
    return res.json({
      success: false,
      error: signalResp && signalResp.error
        ? `内部信号端点失败: ${signalResp.error}`
        : '内部信号端点未返回 success'
    });
  }

  const data = signalResp.data;
  const signal = data && data.signal;
  if (signal !== 'LONG' && signal !== 'SHORT') {
    return res.json({
      success: false,
      error: `当前信号为 ${signal || 'NONE'}，不推送`,
      data: { signal }
    });
  }

  // 校验去重 (除非 force)
  let verdict = { ok: true, reason: 'manual force=true' };
  if (!force) {
    verdict = feishu.shouldNotify(symbol, market, signal);
    if (!verdict.ok) {
      return res.json({
        success: false,
        error: `按去重 / 冷却跳过：${verdict.reason}`,
        hint: '可在请求体里加 force=true 绕过冷却'
      });
    }
  }

  // 标记 → 推送 (保持顺序，避免并发重复)
  feishu.markNotified(symbol, market, signal);
  const r = await feishu.sendSignalCard(data, {
    symbol,
    market,
    triggerSource: force ? 'manual force' : `manual · ${verdict.reason}`
  });
  if (r.ok) {
    return res.json({
      success: true,
      data: { signal, pushed: true, response: r.response }
    });
  }
  return res.json({
    success: false,
    error: r.error || 'feishu send failed',
    response: r.response
  });
});

module.exports = router;
