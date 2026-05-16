'use strict';

/**
 * 自动交易 Webhook 客户端 (Auto-Trade Pending-Order Webhook)
 *
 * 当 routes/liqSignal.js 产出高置信度的 LIQ_REVERSAL_LONG / LIQ_REVERSAL_SHORT
 * 信号时，把方向异步 POST 到外部自动交易系统，由对方下挂单。
 *
 * 触发示例 (Trigger example)：
 *   curl -X POST https://aitrade.24os.cn/api/auto-trade/pending-order \
 *     -H 'Content-Type: application/json' \
 *     -H 'X-Auth-Token: <AUTO_TRADE_API_TOKEN>' \
 *     -d '{
 *       "direction": "short",
 *       "source":    "liq-signal",
 *       "label":     "BTC-15m-Reversal-v2"
 *     }'
 *
 * 配置 (Env vars · 全部可选；未填 URL 则整体禁用)：
 *
 *   AUTO_TRADE_API_URL          目标 webhook URL；未配置则整体 no-op
 *   AUTO_TRADE_API_TOKEN        X-Auth-Token 头的值（与对方约定）
 *   AUTO_TRADE_ENABLED          'false' 显式关闭整体推送（默认开启）
 *   AUTO_TRADE_TRIGGER_SIGNALS  CSV，触发该 webhook 的信号白名单
 *                               默认 'LIQ_REVERSAL_LONG,LIQ_REVERSAL_SHORT'
 *   AUTO_TRADE_MIN_CONFIDENCE   触发的最低 confidence，默认 75
 *   AUTO_TRADE_COOLDOWN_MS      同 symbol+direction 冷却毫秒，默认 1800000 (30 分钟)
 *   AUTO_TRADE_SOURCE           payload.source 的值，默认 'liq-signal'
 *   AUTO_TRADE_LABEL_TEMPLATE   payload.label 的模板；支持占位符
 *                               {symbol} {direction} {signal} {confidence}
 *                               默认 '{symbol}-{signal}'
 *
 * 失败语义 (Failure semantics)：
 *   - 永不抛错：网络失败 / 非 2xx 都返回 { ok:false, error }，不阻塞业务流。
 *   - 永不重试：避免对方收到重复挂单。
 *   - 调用历史写入内存 ring buffer，便于 /api/auto-trade/status 排查。
 */

const axios = require('axios');

const HTTP_TIMEOUT_MS = 8000;
const MAX_RECENT = 50;
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULT_MIN_CONFIDENCE = 75;
const DEFAULT_TRIGGER_SIGNALS = 'LIQ_REVERSAL_LONG,LIQ_REVERSAL_SHORT,'
  + 'HEXA_RESONANCE_LONG,HEXA_RESONANCE_SHORT,'
  + 'TRIO_RESONANCE_LONG,TRIO_RESONANCE_SHORT';
const DEFAULT_SOURCE = 'liq-signal';
const DEFAULT_LABEL_TEMPLATE = '{symbol}-{signal}';

const recentCalls = [];
const lastSentBy = new Map(); // key: `${symbol}|${direction}` → ts

function recordCall(record) {
  recentCalls.unshift(record);
  if (recentCalls.length > MAX_RECENT) recentCalls.length = MAX_RECENT;
}

function isEnabled() {
  if (process.env.AUTO_TRADE_ENABLED === 'false') return false;
  return !!process.env.AUTO_TRADE_API_URL;
}

function getTriggerSignals() {
  return String(process.env.AUTO_TRADE_TRIGGER_SIGNALS || DEFAULT_TRIGGER_SIGNALS)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function getMinConfidence() {
  const n = Number(process.env.AUTO_TRADE_MIN_CONFIDENCE);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_CONFIDENCE;
}

function getCooldownMs() {
  const n = Number(process.env.AUTO_TRADE_COOLDOWN_MS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_COOLDOWN_MS;
}

function buildHeaders() {
  const h = {
    'Content-Type': 'application/json; charset=utf-8',
    Accept: 'application/json, */*',
    'User-Agent': 'liq-gap/1.0 (+auto-trade)'
  };
  const token = process.env.AUTO_TRADE_API_TOKEN;
  if (token) h['X-Auth-Token'] = token;
  return h;
}

function renderLabel(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => {
    const v = vars[key];
    return v == null ? '' : String(v);
  });
}

function shouldFire({ signal, confidence, symbol, direction }) {
  if (!isEnabled()) {
    return { ok: false, skipped: true, reason: 'AUTO_TRADE_API_URL not set or AUTO_TRADE_ENABLED=false' };
  }
  if (!signal || !direction) {
    return { ok: false, skipped: true, reason: 'missing signal or direction' };
  }
  const triggers = getTriggerSignals();
  if (!triggers.includes(String(signal).toUpperCase())) {
    return { ok: false, skipped: true, reason: `signal ${signal} not in AUTO_TRADE_TRIGGER_SIGNALS` };
  }
  const min = getMinConfidence();
  if (Number(confidence) < min) {
    return { ok: false, skipped: true, reason: `confidence ${confidence} < ${min}` };
  }
  const cooldown = getCooldownMs();
  const k = `${String(symbol || '').toUpperCase()}|${String(direction).toLowerCase()}`;
  const prev = lastSentBy.get(k);
  if (prev && cooldown > 0 && Date.now() - prev < cooldown) {
    const remain = Math.max(0, cooldown - (Date.now() - prev));
    return { ok: false, skipped: true, reason: `cooldown active (${Math.round(remain / 1000)}s remaining)` };
  }
  return { ok: true, key: k };
}

/**
 * 触发自动交易挂单 (Send pending-order webhook).
 *
 * @param {object} input
 * @param {string} input.signal       信号名（如 LIQ_REVERSAL_SHORT）
 * @param {'long'|'short'} input.direction
 * @param {number} input.confidence   0~100
 * @param {string} input.symbol       交易对
 * @param {object} [input.extra]      额外字段（透传到 payload，仅用于诊断）
 * @returns {Promise<{ok:boolean, status?:number, response?:any, error?:string,
 *                    skipped?:boolean, reason?:string, payload?:object}>}
 */
async function sendPendingOrder(input) {
  const { signal, direction, confidence, symbol = 'BTCUSDT', extra = {} } = input || {};
  const verdict = shouldFire({ signal, confidence, symbol, direction });
  if (!verdict.ok) {
    return verdict;
  }

  const url = process.env.AUTO_TRADE_API_URL;
  const source = process.env.AUTO_TRADE_SOURCE || DEFAULT_SOURCE;
  const labelTpl = process.env.AUTO_TRADE_LABEL_TEMPLATE || DEFAULT_LABEL_TEMPLATE;
  // extra.labelOverride 让 resonance / 其他自定义路由可以指定专属 label（区分 Tier）
  // 中转服务那边可以按 label 前缀（HEXA-xxx / TRIO-xxx）选择不同杠杆/仓位预设
  const label = (extra && extra.labelOverride)
    ? renderLabel(extra.labelOverride, { symbol, direction, signal, confidence })
    : renderLabel(labelTpl, { symbol, direction, signal, confidence });

  const payload = {
    direction: String(direction).toLowerCase(),
    source,
    label
  };

  const startedAt = Date.now();
  // 先标记，避免并发请求重复触发（即使 HTTP 还没回来）
  lastSentBy.set(verdict.key, startedAt);

  try {
    const res = await axios.post(url, payload, {
      timeout: HTTP_TIMEOUT_MS,
      headers: buildHeaders()
    });
    recordCall({
      ts: startedAt,
      ok: true,
      url,
      symbol,
      signal,
      direction,
      confidence,
      payload,
      status: res.status,
      response: truncate(res.data),
      durationMs: Date.now() - startedAt,
      extra
    });
    return { ok: true, status: res.status, response: res.data, payload };
  } catch (err) {
    const status = err.response && err.response.status;
    const respData = err.response && err.response.data;
    // eslint-disable-next-line no-console
    console.error(`[auto-trade] ${symbol} ${signal} ${direction} failed (HTTP ${status || 'NETERR'}):`, err.message, respData || '');
    recordCall({
      ts: startedAt,
      ok: false,
      url,
      symbol,
      signal,
      direction,
      confidence,
      payload,
      status,
      error: err.message,
      response: truncate(respData),
      durationMs: Date.now() - startedAt,
      extra
    });
    return {
      ok: false,
      status,
      error: `auto-trade request failed (HTTP ${status || 'NETERR'}): ${err.message}`,
      response: respData,
      payload
    };
  }
}

function truncate(v) {
  if (v == null) return v;
  if (typeof v === 'string') return v.length > 500 ? v.slice(0, 500) + '…' : v;
  try {
    const s = JSON.stringify(v);
    return s.length > 500 ? s.slice(0, 500) + '…' : v;
  } catch (_) {
    return String(v).slice(0, 500);
  }
}

function getRecentCalls(limit = 10) {
  return recentCalls.slice(0, limit);
}

function resetRecentCalls() {
  recentCalls.length = 0;
}

function resetCooldowns() {
  lastSentBy.clear();
}

function getStatus() {
  return {
    enabled: isEnabled(),
    url: process.env.AUTO_TRADE_API_URL || null,
    tokenConfigured: !!process.env.AUTO_TRADE_API_TOKEN,
    triggerSignals: getTriggerSignals(),
    minConfidence: getMinConfidence(),
    cooldownMs: getCooldownMs(),
    source: process.env.AUTO_TRADE_SOURCE || DEFAULT_SOURCE,
    labelTemplate: process.env.AUTO_TRADE_LABEL_TEMPLATE || DEFAULT_LABEL_TEMPLATE,
    cooldownActive: Object.fromEntries(
      Array.from(lastSentBy.entries()).map(([k, ts]) => [k, { lastSentAt: ts, lastSentISO: new Date(ts).toISOString() }])
    ),
    recentCalls: recentCalls.slice(0, 10)
  };
}

module.exports = {
  isEnabled,
  shouldFire,
  sendPendingOrder,
  getRecentCalls,
  resetRecentCalls,
  resetCooldowns,
  getStatus
};
