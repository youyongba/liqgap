'use strict';

/**
 * POST /api/alerts/liquidation-cross
 *
 * 前端检测到现价穿越清算热图主峰（L↓ 多头清算墙 / S↑ 空头清算墙）时
 * 触发本接口；后端做服务端二次去重 + 推送飞书 + 写日志。
 *
 * Request body:
 *   {
 *     symbol, market,
 *     mode: 'predicted' | 'realized',
 *     side: 'long' | 'short',
 *     peakPrice, peakValue,
 *     prevPrice, curPrice,
 *     crossDirection: 'down' | 'up',
 *     timestamp
 *   }
 *
 * Response:
 *   { success:true, data: { skipped:bool, reason?:string, feishu?:{ok,...} } }
 */

const express = require('express');
const feishu = require('../services/feishu');

const router = express.Router();

// 服务端去重：同一 (symbol, market, side, peakPrice±tolerance) 在 N 分钟内
// 只发一次。前端也会去重，但这里再做一道兜底，避免多 tab / 多客户端刷屏。
const SERVER_COOLDOWN_MS = Number(process.env.LIQ_CROSS_COOLDOWN_MS) || 5 * 60_000;
const PRICE_TOLERANCE_PCT = 0.0005; // 主峰价位有 0.05% 抖动算同一价位

const _lastAlertByKey = new Map();

function _alertKey(b) {
  return `${String(b.symbol || '').toUpperCase()}|${b.market || 'futures'}|${b.side}`;
}
function _shouldAlert(body) {
  const key = _alertKey(body);
  const prev = _lastAlertByKey.get(key);
  const now = Date.now();
  const peak = Number(body.peakPrice);
  if (!Number.isFinite(peak) || peak <= 0) {
    return { ok: false, reason: 'invalid peakPrice' };
  }
  if (!prev) return { ok: true, key, now };
  const samePeak = Math.abs(peak - prev.peak) / prev.peak <= PRICE_TOLERANCE_PCT;
  const elapsed = now - prev.ts;
  if (samePeak && elapsed < SERVER_COOLDOWN_MS) {
    return { ok: false, reason: `same peak in cooldown (${Math.round(elapsed / 1000)}s ago)` };
  }
  return { ok: true, key, now };
}

router.post('/alerts/liquidation-cross', async (req, res) => {
  try {
    const b = req.body || {};
    const required = ['symbol', 'side', 'peakPrice', 'prevPrice', 'curPrice'];
    for (const k of required) {
      if (b[k] === undefined || b[k] === null) {
        return res.status(400).json({ success: false, error: `missing field: ${k}` });
      }
    }
    if (b.side !== 'long' && b.side !== 'short') {
      return res.status(400).json({ success: false, error: `side must be 'long' or 'short'` });
    }
    const decide = _shouldAlert(b);
    if (!decide.ok) {
      // eslint-disable-next-line no-console
      console.log(`[liq-cross] skip ${b.symbol}/${b.side} @ ${b.peakPrice}: ${decide.reason}`);
      return res.json({ success: true, data: { skipped: true, reason: decide.reason } });
    }

    const payload = {
      symbol: b.symbol,
      market: b.market || 'futures',
      mode: b.mode || 'predicted',
      side: b.side,
      peakPrice: Number(b.peakPrice),
      peakValue: Number(b.peakValue) || 0,
      prevPrice: Number(b.prevPrice),
      curPrice: Number(b.curPrice),
      crossDirection: b.crossDirection || (Number(b.curPrice) < Number(b.prevPrice) ? 'down' : 'up'),
      timestamp: Number(b.timestamp) || Date.now()
    };

    // eslint-disable-next-line no-console
    console.log(
      `[liq-cross] ALERT ${payload.symbol}/${payload.side} ` +
      `peak=${payload.peakPrice} (${payload.peakValue} USDT) ` +
      `${payload.prevPrice} → ${payload.curPrice} (${payload.crossDirection})`
    );

    let feishuResult = null;
    if (feishu.isEnabled()) {
      try {
        feishuResult = await feishu.sendLiquidationCrossCard(payload);
      } catch (err) {
        feishuResult = { ok: false, error: err.message };
      }
    } else {
      feishuResult = { ok: false, skipped: true, reason: 'feishu disabled' };
    }

    // 标记本次已触发（无论飞书是否成功，都更新冷却以防同价位刷屏）
    _lastAlertByKey.set(decide.key, { peak: payload.peakPrice, ts: decide.now });

    return res.json({
      success: true,
      data: { skipped: false, feishu: feishuResult, payload }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/alerts/liquidation-cross/status', (_req, res) => {
  const out = {};
  for (const [k, v] of _lastAlertByKey.entries()) {
    out[k] = { peak: v.peak, ts: v.ts, isoTime: new Date(v.ts).toISOString() };
  }
  res.json({
    success: true,
    data: {
      cooldownMs: SERVER_COOLDOWN_MS,
      priceTolerancePct: PRICE_TOLERANCE_PCT,
      feishuEnabled: feishu.isEnabled(),
      lastAlerts: out
    }
  });
});

module.exports = router;
