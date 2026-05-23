'use strict';

/**
 * 自动交易 Webhook 客户端 (Auto-Trade Pending-Order Webhook)
 *
 * 当 routes/liqSignal.js / resonanceSignal.js 产出高置信度信号时，把方向
 * 异步 POST 到外部自动交易系统，由对方下挂单/市价单。
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
 * 关键安全特性：
 *   1. 信号白名单 + 最低 confidence + 同 symbol/direction 冷却（基础闸门）
 *   2. **K 线收线二次确认**（可选）：信号产生后先 stage，等
 *      AUTO_TRADE_CONFIRMATION_DELAY_MS 后通过本机 HTTP 重新拉取信号验证：
 *        • signal 仍相同方向 + confidence 仍 ≥ 阈值 → 真正发送 webhook
 *        • peak 漂移 / CVD 反向 / 价格再次穿越 → 撤销，写入 ring buffer
 *      在 100x 高杠杆场景下能过滤 30-50% 的"瞬时假信号"，代价是延迟下单。
 *
 * 配置 (Env vars · 全部可选；未填 URL 则整体禁用)：
 *
 *   AUTO_TRADE_API_URL               目标 webhook URL；未配置则整体 no-op
 *   AUTO_TRADE_API_TOKEN             X-Auth-Token 头的值（与对方约定）
 *   AUTO_TRADE_ENABLED               'false' 显式关闭整体推送（默认开启）
 *                                    ⚠️ 这是启动期 env，重启才生效。
 *                                    需要"运行时一键开关"请用 setEnabled()
 *                                    或 POST /api/auto-trade/{enable|disable|toggle}。
 *   AUTO_TRADE_TRIGGER_SIGNALS       CSV，触发该 webhook 的信号白名单
 *   AUTO_TRADE_MIN_CONFIDENCE        触发的最低 confidence，默认 75
 *   AUTO_TRADE_COOLDOWN_MS           同 symbol+direction 冷却毫秒，默认 1800000 (30 分钟)
 *   AUTO_TRADE_SOURCE                payload.source 的值，默认 'liq-signal'
 *   AUTO_TRADE_LABEL_TEMPLATE        payload.label 的模板；支持占位符
 *                                    {symbol} {direction} {signal} {confidence}
 *                                    默认 '{symbol}-{signal}'
 *   AUTO_TRADE_CONFIRMATION_DELAY_MS 二次确认延迟（0 = 关闭立即发送 · 推荐 300000 = 5min）
 *   AUTO_TRADE_CONFIRM_HOST          复检 HTTP 调用的主机，默认 '127.0.0.1'
 *
 * 失败语义 (Failure semantics)：
 *   - 永不抛错：网络失败 / 非 2xx 都返回 { ok:false, error }，不阻塞业务流。
 *   - 永不重试：避免对方收到重复挂单。
 *   - 调用历史 + stage 历史写入内存 ring buffer，/api/auto-trade/status 可查。
 */

const axios = require('axios');

const HTTP_TIMEOUT_MS = 8000;
const CONFIRM_HTTP_TIMEOUT_MS = 8000;
const MAX_RECENT = 50;
const MAX_STAGED = 20;
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULT_MIN_CONFIDENCE = 75;
const DEFAULT_TRIGGER_SIGNALS = 'LIQ_REVERSAL_LONG,LIQ_REVERSAL_SHORT,'
  + 'HEXA_RESONANCE_LONG,HEXA_RESONANCE_SHORT,'
  + 'TRIO_RESONANCE_LONG,TRIO_RESONANCE_SHORT';
const DEFAULT_SOURCE = 'liq-signal';
const DEFAULT_LABEL_TEMPLATE = '{symbol}-{signal}';

const recentCalls = [];
const lastSentBy = new Map(); // key: `${symbol}|${direction}` → ts
// 二次确认 stage 队列 · key = `${symbol}|${signal}|${direction}`
//   record: { input, stagedAt, scheduledAt, timerId, status: 'pending'|'confirmed'|'rejected'|'fired' }
const stagedSignals = new Map();
// 复检历史 ring buffer（独立于 recentCalls，专门记 stage → 复检结果）
const stageHistory = [];

function recordCall(record) {
  recentCalls.unshift(record);
  if (recentCalls.length > MAX_RECENT) recentCalls.length = MAX_RECENT;
}

// ────────────────────────────────────────────────────────────────────────────
// 运行时开关 (Runtime kill switch)
// ────────────────────────────────────────────────────────────────────────────
//   null  → 跟随 .env（默认行为，按 AUTO_TRADE_ENABLED + URL 是否配置）
//   true  → 运行时强制启用（覆盖 AUTO_TRADE_ENABLED=false；URL 必须配置否则仍发不出）
//   false → 运行时强制禁用（最高优先级，所有 webhook 立即停发；不影响飞书 / 信号计算）
//
// 通过 setEnabled() 切换；REST API：
//   POST /api/auto-trade/disable           → setEnabled(false)
//   POST /api/auto-trade/enable            → setEnabled(true)
//   POST /api/auto-trade/toggle            → 翻转当前 isEnabled()
//   POST /api/auto-trade/reset-override    → 复位为 null（跟随 .env）
//
// 重启后回到 null（内存状态，不持久化）。如果要"重启也保持禁用"请同步设
// .env AUTO_TRADE_ENABLED=false。
let _runtimeOverride = null;

function isEnabled() {
  if (_runtimeOverride === false) return false;
  if (!process.env.AUTO_TRADE_API_URL) return false;
  if (_runtimeOverride === true) return true;
  if (process.env.AUTO_TRADE_ENABLED === 'false') return false;
  return true;
}

function setEnabled(value) {
  if (value === null || typeof value === 'undefined') {
    _runtimeOverride = null;
  } else {
    _runtimeOverride = !!value;
  }
  return getEnabledStatus();
}

function getEnabledStatus() {
  const envEnabled = process.env.AUTO_TRADE_ENABLED !== 'false';
  const urlConfigured = !!process.env.AUTO_TRADE_API_URL;
  let source;
  if (_runtimeOverride === false) source = 'runtime-disabled';
  else if (!urlConfigured) source = 'no-url';
  else if (_runtimeOverride === true) source = 'runtime-enabled';
  else if (!envEnabled) source = 'env-disabled';
  else source = 'env-enabled';
  return {
    enabled: isEnabled(),
    runtimeOverride: _runtimeOverride,
    envEnabled,
    urlConfigured,
    source
  };
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

function getConfirmationDelayMs() {
  const n = Number(process.env.AUTO_TRADE_CONFIRMATION_DELAY_MS);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function recordStageHistory(record) {
  stageHistory.unshift(record);
  if (stageHistory.length > MAX_RECENT) stageHistory.length = MAX_RECENT;
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
 * 当 AUTO_TRADE_CONFIRMATION_DELAY_MS > 0 时，进入 stage 流程：
 *   1. shouldFire 通过的信号先 stage 到内存，立即占用冷却（防止 5min 内 spam）
 *   2. 等 delay ms 后调本机 HTTP 复检 /api/trade/{liq-signal|resonance-signal}
 *   3. 仍满足条件 → _doSend；否则 → 撤销并写 stageHistory
 *
 * @param {object} input
 * @param {string} input.signal       信号名（如 HEXA_RESONANCE_LONG）
 * @param {'long'|'short'} input.direction
 * @param {number} input.confidence   0~100
 * @param {string} input.symbol       交易对
 * @param {object} [input.extra]      额外字段，复检需用到 windowMs / priceRange / sourceInterval
 * @returns {Promise<{ok:boolean, staged?:boolean, status?:number, response?:any,
 *                    error?:string, skipped?:boolean, reason?:string, payload?:object}>}
 */
async function sendPendingOrder(input) {
  const { signal, direction, confidence, symbol = 'BTCUSDT' } = input || {};
  const verdict = shouldFire({ signal, confidence, symbol, direction });
  if (!verdict.ok) {
    return verdict;
  }

  const delayMs = getConfirmationDelayMs();
  if (delayMs > 0) {
    return _stagePendingOrder(input, verdict.key, delayMs);
  }
  return _doSend(input, verdict.key);
}

// ---------------------------------------------------------------------------
// Stage 流程：信号先 stage，delay ms 后通过本机 HTTP 复检
// ---------------------------------------------------------------------------
function _stagePendingOrder(input, key, delayMs) {
  const { signal, direction, confidence, symbol } = input;
  const stageKey = `${String(symbol).toUpperCase()}|${signal}|${String(direction).toLowerCase()}`;

  // 已经 staged 同 key → 先到先服务，跳过新的（避免覆盖前一个还在等待复检的信号）
  if (stagedSignals.has(stageKey)) {
    return {
      ok: false,
      skipped: true,
      reason: `same signal already staged (key=${stageKey})`
    };
  }
  // 占用冷却（即使复检失败，也不希望同 key 在 delay 内反复 stage）
  lastSentBy.set(key, Date.now());

  const stagedAt = Date.now();
  const scheduledAt = stagedAt + delayMs;
  const record = {
    stageKey,
    input,
    key,
    stagedAt,
    scheduledAt,
    status: 'pending'
  };
  const timerId = setTimeout(() => _confirmAndSend(stageKey).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[auto-trade] confirm flow threw:', err && err.message);
  }), delayMs);
  // node 环境下 unref，避免阻止进程退出
  if (timerId && typeof timerId.unref === 'function') timerId.unref();
  record.timerId = timerId;
  stagedSignals.set(stageKey, record);
  if (stagedSignals.size > MAX_STAGED) {
    // 防御性丢弃最早的 staged（理论上不会触发，因为有冷却 + 单 key 跳过）
    const oldestKey = stagedSignals.keys().next().value;
    const oldest = stagedSignals.get(oldestKey);
    if (oldest && oldest.timerId) clearTimeout(oldest.timerId);
    stagedSignals.delete(oldestKey);
  }

  // eslint-disable-next-line no-console
  console.log(`[auto-trade] STAGED ${symbol} ${signal} ${direction} conf=${confidence} · confirm in ${delayMs / 1000}s`);
  return {
    ok: true,
    staged: true,
    confirmAt: scheduledAt,
    reason: `staged for 2nd confirmation after ${delayMs}ms`
  };
}

async function _confirmAndSend(stageKey) {
  const record = stagedSignals.get(stageKey);
  if (!record) return;
  stagedSignals.delete(stageKey);
  record.status = 'confirming';
  const { input, key } = record;
  const { signal, direction, confidence: stagedConfidence, symbol } = input;

  // 释放冷却前缀：让真正发送的逻辑重新设置冷却时间
  // （此时如果复检失败，释放冷却是合理的，下一个新信号可以正常触发）
  const cooldownPlacedAt = lastSentBy.get(key);
  if (cooldownPlacedAt === record.stagedAt) lastSentBy.delete(key);

  const refetch = await _refetchSignal(input);
  if (!refetch.ok) {
    record.status = 'rejected';
    record.rejectedAt = Date.now();
    record.rejectReason = refetch.reason;
    record.latestSnapshot = refetch.latest && {
      signal: refetch.latest.signal,
      confidence: refetch.latest.confidence,
      side: refetch.latest.side
    };
    recordStageHistory(record);
    // eslint-disable-next-line no-console
    console.log(`[auto-trade] STAGE-REJECTED ${symbol} ${signal} ${direction} (was conf=${stagedConfidence}): ${refetch.reason}`);
    return { ok: false, staged: true, rejected: true, reason: refetch.reason };
  }

  // 用复检后的最新 confidence / extra 替换（peak 可能漂移，但仍在同方向）
  const latest = refetch.latest;
  const confirmedInput = {
    ...input,
    confidence: Number(latest.confidence) || stagedConfidence,
    extra: { ...(input.extra || {}), confirmedFromStage: true, stagedConfidence }
  };
  record.status = 'confirmed';
  record.confirmedAt = Date.now();
  record.confirmedConfidence = confirmedInput.confidence;
  recordStageHistory(record);

  // eslint-disable-next-line no-console
  console.log(`[auto-trade] STAGE-CONFIRMED ${symbol} ${signal} ${direction} conf=${confirmedInput.confidence}`);
  return _doSend(confirmedInput, key);
}

async function _refetchSignal(input) {
  const { signal, symbol, extra = {} } = input;
  const port = process.env.PORT || 3000;
  const host = process.env.AUTO_TRADE_CONFIRM_HOST || '127.0.0.1';
  const isResonance = /^(HEXA|TRIO)_RESONANCE_/i.test(signal || '');
  const routePath = isResonance ? 'resonance-signal' : 'liq-signal';
  const qs = new URLSearchParams({
    symbol: String(symbol),
    notify: 'false',
    autoTrade: 'false'
  });
  if (extra.windowMs != null) qs.set('windowMs', String(extra.windowMs));
  if (extra.priceRange != null) qs.set('priceRange', String(extra.priceRange));
  if (extra.sourceInterval) qs.set('sourceInterval', String(extra.sourceInterval));
  if (extra.bucketMs != null) qs.set('bucketMs', String(extra.bucketMs));
  const url = `http://${host}:${port}/api/trade/${routePath}?${qs.toString()}`;

  try {
    const res = await axios.get(url, { timeout: CONFIRM_HTTP_TIMEOUT_MS });
    const data = res.data && res.data.data;
    if (!data) return { ok: false, reason: 'refetch empty data', latest: null };
    if (!data.signal || data.signal === 'NONE') {
      return { ok: false, reason: `signal vanished (now ${data.signal || 'null'})`, latest: data };
    }
    if (String(data.signal).toUpperCase() !== String(signal).toUpperCase()) {
      return { ok: false, reason: `signal changed: was ${signal}, now ${data.signal}`, latest: data };
    }
    const minConf = getMinConfidence();
    const curConf = Number(data.confidence);
    if (!Number.isFinite(curConf) || curConf < minConf) {
      return { ok: false, reason: `confidence dropped: was >=${minConf}, now ${data.confidence}`, latest: data };
    }
    // 窗口闸门可能在 stage 期间生效（罕见但要保护）
    const snap = data.indicatorsSnapshot || {};
    if (snap.windowGated) {
      return { ok: false, reason: 'windowGated during stage (allow-list narrowed)', latest: data };
    }
    return { ok: true, latest: data };
  } catch (err) {
    return { ok: false, reason: `refetch http error: ${err.message}`, latest: null };
  }
}

// ---------------------------------------------------------------------------
// 真正的 HTTP 发送（既可被直接发送，也可被 stage 复检后调用）
// ---------------------------------------------------------------------------
async function _doSend(input, key) {
  const { signal, direction, confidence, symbol = 'BTCUSDT', extra = {} } = input;
  // 再次检查运行时开关 —— stage 队列里的信号在 delay 期间用户可能 disable
  // 这里是最后一道防线，确保 disable 后绝对不会有 webhook 漏发
  if (!isEnabled()) {
    return {
      ok: false,
      skipped: true,
      reason: 'auto-trade disabled before send (runtime override or env)'
    };
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
  // 标记冷却（即使 HTTP 还没回来，并发请求也不会重复触发）
  if (key) lastSentBy.set(key, startedAt);

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

function resetStaged() {
  for (const r of stagedSignals.values()) {
    if (r.timerId) clearTimeout(r.timerId);
  }
  stagedSignals.clear();
  stageHistory.length = 0;
}

function getStagedSignals() {
  const now = Date.now();
  return Array.from(stagedSignals.values()).map((r) => ({
    stageKey: r.stageKey,
    symbol: r.input.symbol,
    signal: r.input.signal,
    direction: r.input.direction,
    stagedConfidence: r.input.confidence,
    stagedAt: r.stagedAt,
    stagedAtISO: new Date(r.stagedAt).toISOString(),
    scheduledAt: r.scheduledAt,
    scheduledAtISO: new Date(r.scheduledAt).toISOString(),
    remainingMs: Math.max(0, r.scheduledAt - now),
    status: r.status
  }));
}

function getStageHistory(limit = 10) {
  return stageHistory.slice(0, limit).map((r) => ({
    stageKey: r.stageKey,
    symbol: r.input.symbol,
    signal: r.input.signal,
    direction: r.input.direction,
    stagedConfidence: r.input.confidence,
    stagedAt: r.stagedAt,
    stagedAtISO: new Date(r.stagedAt).toISOString(),
    status: r.status,
    confirmedAt: r.confirmedAt || null,
    confirmedConfidence: r.confirmedConfidence || null,
    rejectedAt: r.rejectedAt || null,
    rejectReason: r.rejectReason || null,
    latestSnapshot: r.latestSnapshot || null
  }));
}

function getStatus() {
  const enabledStatus = getEnabledStatus();
  return {
    enabled: enabledStatus.enabled,
    runtimeOverride: enabledStatus.runtimeOverride,
    envEnabled: enabledStatus.envEnabled,
    urlConfigured: enabledStatus.urlConfigured,
    enabledSource: enabledStatus.source,
    url: process.env.AUTO_TRADE_API_URL || null,
    tokenConfigured: !!process.env.AUTO_TRADE_API_TOKEN,
    triggerSignals: getTriggerSignals(),
    minConfidence: getMinConfidence(),
    cooldownMs: getCooldownMs(),
    confirmationDelayMs: getConfirmationDelayMs(),
    source: process.env.AUTO_TRADE_SOURCE || DEFAULT_SOURCE,
    labelTemplate: process.env.AUTO_TRADE_LABEL_TEMPLATE || DEFAULT_LABEL_TEMPLATE,
    cooldownActive: Object.fromEntries(
      Array.from(lastSentBy.entries()).map(([k, ts]) => [k, { lastSentAt: ts, lastSentISO: new Date(ts).toISOString() }])
    ),
    staged: getStagedSignals(),
    stageHistory: getStageHistory(10),
    recentCalls: recentCalls.slice(0, 10)
  };
}

module.exports = {
  isEnabled,
  setEnabled,
  getEnabledStatus,
  shouldFire,
  sendPendingOrder,
  getRecentCalls,
  resetRecentCalls,
  resetCooldowns,
  resetStaged,
  getStagedSignals,
  getStageHistory,
  getStatus
};
