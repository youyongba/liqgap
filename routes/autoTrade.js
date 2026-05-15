'use strict';

/**
 * 自动交易 Webhook 状态 / 测试 (Auto-Trade webhook status & test)
 *
 *   GET  /api/auto-trade/status
 *     返回当前 webhook 配置 + 冷却状态 + 最近 10 次调用记录。
 *
 *   POST /api/auto-trade/test
 *     绕过冷却 / 信号白名单 / 置信度门槛，立即发一条测试 payload，验证 URL+Token。
 *     body: {
 *       direction?: 'long' | 'short',   // 默认 'short'
 *       symbol?:    string,             // 默认 'BTCUSDT'
 *       label?:     string              // 默认 '<symbol>-AUTO-TRADE-TEST'
 *     }
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

module.exports = router;
