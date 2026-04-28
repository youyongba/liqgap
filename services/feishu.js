'use strict';

/**
 * 飞书自定义机器人推送 (Feishu / Lark custom-bot webhook)
 *
 * 配置 (Configuration · 来自 .env):
 *   FEISHU_WEBHOOK_URL      飞书群机器人的 webhook URL（必填）
 *   FEISHU_WEBHOOK_SECRET   签名密钥（飞书机器人若启用了"签名校验"必填）
 *   FEISHU_NOTIFY_ENABLED   'false' 关闭整体推送（默认开启）
 *   FEISHU_NOTIFY_COOLDOWN_MS 同方向推送冷却毫秒，默认 1800000 (30 分钟)
 *
 * 提供两类发送函数 (Two send helpers)：
 *   sendText(content)         发送纯文本
 *   sendCard(card)            发送 interactive 卡片
 *   sendSignalCard(payload)   把 /api/trade/signal 返回的 data 封装成卡片
 *
 * 还导出一个 dedup helper:
 *   shouldNotify(symbol, market, signal)  判断本次是否应该推送（去重 + 冷却）
 *
 * 设计原则：
 *   - 推送失败不抛错，只 console.error；网络异常不影响业务流。
 *   - 永不重试（避免在飞书侧产生重复消息）；调用方按需选择重试策略。
 *   - 把"上次推送状态"存内存，进程重启即清空 (in-memory only).
 */

const axios = require('axios');
const crypto = require('crypto');

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
const HTTP_TIMEOUT_MS = 8000;

// 浏览器风格 headers，避免被边缘节点拦截 (browser-like UA, defensive).
const FEISHU_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'User-Agent': 'liq-gap/1.0 (+feishu-notifier)'
};

// ============================================================================
// 内部状态：上次推送 (last-notified state · in-memory only)
// ============================================================================
const lastNotified = new Map(); // key: `${symbol}|${market}` → { signal, ts }

function key(symbol, market) {
  return `${String(symbol).toUpperCase()}|${market || 'futures'}`;
}

/**
 * 判断本次信号是否应该触发推送 (Should we notify this time?)
 *
 * 规则 (Rules)：
 *   - signal === 'NONE' → 永不推送
 *   - 上次为 NONE 或未推送过 → 推送
 *   - 方向反转 (LONG ↔ SHORT) → 推送
 *   - 同方向且距上次推送 < cooldown → 跳过
 *   - 同方向且距上次推送 >= cooldown → 推送
 */
function shouldNotify(symbol, market, signal) {
  if (signal !== 'LONG' && signal !== 'SHORT') {
    return { ok: false, reason: 'signal is NONE' };
  }
  const k = key(symbol, market);
  const prev = lastNotified.get(k);
  const cooldown = Number(process.env.FEISHU_NOTIFY_COOLDOWN_MS) || DEFAULT_COOLDOWN_MS;
  if (!prev) {
    return { ok: true, reason: 'first signal' };
  }
  if (prev.signal !== signal) {
    return { ok: true, reason: `direction flipped from ${prev.signal} to ${signal}` };
  }
  const elapsed = Date.now() - prev.ts;
  if (elapsed >= cooldown) {
    return { ok: true, reason: `cooldown elapsed (${Math.round(elapsed / 60000)}min)` };
  }
  return {
    ok: false,
    reason: `same direction (${signal}) within cooldown ${Math.round(cooldown / 60000)}min`,
    elapsedMs: elapsed
  };
}

/** 标记本次已推送 (Mark a successful push). */
function markNotified(symbol, market, signal) {
  lastNotified.set(key(symbol, market), { signal, ts: Date.now() });
}

/** 获取所有 symbol/market 的最近一次推送时间（仅状态查询用） */
function getLastNotifiedSnapshot() {
  const out = {};
  for (const [k, v] of lastNotified.entries()) {
    out[k] = { signal: v.signal, ts: v.ts, isoTime: new Date(v.ts).toISOString() };
  }
  return out;
}

/** 测试用：清空内部去重状态 (For tests / manual reset). */
function resetNotifiedState() {
  lastNotified.clear();
}

// ============================================================================
// 飞书签名 (Feishu signature)
// ============================================================================
/**
 * 飞书签名算法 (与官方文档一致)：
 *   stringToSign = `${timestamp}\n${secret}`
 *   sign         = base64( HMAC-SHA256(stringToSign, '') )
 * 注意 HMAC 的 key 是 stringToSign，data 是空字符串。
 */
function feishuSign(timestamp, secret) {
  const stringToSign = `${timestamp}\n${secret}`;
  return crypto.createHmac('sha256', stringToSign).update('').digest('base64');
}

// ============================================================================
// 发送
// ============================================================================
function isEnabled() {
  if (process.env.FEISHU_NOTIFY_ENABLED === 'false') return false;
  return !!process.env.FEISHU_WEBHOOK_URL;
}

function buildBody(payload) {
  const body = { ...payload };
  const secret = process.env.FEISHU_WEBHOOK_SECRET;
  if (secret) {
    const ts = Math.floor(Date.now() / 1000);
    body.timestamp = String(ts);
    body.sign = feishuSign(ts, secret);
  }
  return body;
}

async function postFeishu(payload) {
  if (!isEnabled()) {
    return { ok: false, skipped: true, reason: 'FEISHU_WEBHOOK_URL not set or disabled' };
  }
  const url = process.env.FEISHU_WEBHOOK_URL;
  const body = buildBody(payload);
  try {
    const res = await axios.post(url, body, {
      timeout: HTTP_TIMEOUT_MS,
      headers: FEISHU_HEADERS
    });
    // 飞书 webhook 即使 200 也可能有 code != 0 (e.g. {code: 19024, msg: 'sign match fail'})
    const data = res.data || {};
    if (data.code !== undefined && data.code !== 0) {
      return { ok: false, status: res.status, response: data, error: `feishu error code=${data.code} msg=${data.msg}` };
    }
    return { ok: true, status: res.status, response: data };
  } catch (err) {
    const status = err.response && err.response.status;
    const respData = err.response && err.response.data;
    // eslint-disable-next-line no-console
    console.error('[feishu] push failed:', err.message, respData || '');
    return {
      ok: false,
      status,
      error: `feishu request failed (HTTP ${status || 'NETERR'}): ${err.message}`,
      response: respData
    };
  }
}

/** 发送纯文本 (Send a plain-text message) */
async function sendText(content) {
  return postFeishu({ msg_type: 'text', content: { text: String(content) } });
}

/** 发送交互式卡片 (Send an interactive card) */
async function sendCard(card) {
  return postFeishu({ msg_type: 'interactive', card });
}

// ============================================================================
// 业务封装：交易信号卡片
// ============================================================================
/**
 * 生成「交易信号」卡片 (Build the trade-signal card payload).
 *
 * @param {object} payload   /api/trade/signal 的 data 字段
 * @param {object} [meta]    额外元信息：symbol / market / triggerSource
 */
function buildSignalCard(payload, meta = {}) {
  const signal = payload && payload.signal;
  const isLong = signal === 'LONG';
  const isShort = signal === 'SHORT';
  const sym = (meta.symbol || (payload.indicatorsSnapshot && payload.indicatorsSnapshot.symbol) || 'BTCUSDT').toUpperCase();
  const market = meta.market || (payload.indicatorsSnapshot && payload.indicatorsSnapshot.market) || 'futures';
  const sideArrow = isLong ? '🟢 LONG (做多)' : isShort ? '🔴 SHORT (做空)' : '⚪ NONE';
  const template = isLong ? 'green' : isShort ? 'red' : 'grey';

  const tps = Array.isArray(payload.takeProfits) ? payload.takeProfits : [];
  const snap = payload.indicatorsSnapshot || {};
  const triggerSource = meta.triggerSource || 'auto';

  // 主体内容 (Body content) —— 用 lark_md 富文本
  const lines = [];
  lines.push(`**标的 / Symbol**: ${sym} · ${market === 'spot' ? '现货 / Spot' : '合约 / Futures'}`);
  lines.push(`**最新价 / Last**: ${fmt(snap.latestPrice)}`);
  lines.push('---');
  if (signal === 'NONE') {
    lines.push(`**信号 / Signal**: 无 (${escapeMd(payload.reason || 'no actionable signal')})`);
  } else {
    lines.push(`**入场 / Entry**: \`${fmt(payload.entryPrice)}\``);
    lines.push(`**止损 / Stop Loss**: \`${fmt(payload.stopLoss)}\``);
    if (tps[0]) lines.push(`**TP1 (50%)**: \`${fmt(tps[0].price)}\``);
    if (tps[1]) lines.push(`**TP2 (30%)**: \`${fmt(tps[1].price)}\``);
    if (tps[2]) lines.push(`**TP3 (20%)**: \`${fmt(tps[2].price)}\``);
    lines.push('---');
    lines.push(`**风险 / Risk**: ${fmt(payload.riskAmount)} USDT`);
    lines.push(`**仓位 / Size**: ${fmt(payload.positionSize, 6)} (${fmt(payload.positionSizeQuote, 2)} USDT)`);
  }

  // 条件命中 / Conditions（若有）
  const condBlock = [];
  if (snap.longConditions) condBlock.push(formatConditions('多 / Long', snap.longConditions, snap.longScore));
  if (snap.shortConditions) condBlock.push(formatConditions('空 / Short', snap.shortConditions, snap.shortScore));
  if (condBlock.length) {
    lines.push('---');
    lines.push(condBlock.join('\n'));
  }

  // 关键指标快照 (Snapshot)
  const snapLines = [];
  if (snap.atr != null) snapLines.push(`ATR=${fmt(snap.atr)}`);
  if (snap.vwap != null) snapLines.push(`VWAP=${fmt(snap.vwap)}`);
  if (snap.depthRatio != null) snapLines.push(`depthRatio=${fmt(snap.depthRatio, 3)}`);
  if (snap.cvdPriceCorr != null) snapLines.push(`CVD-Px corr=${fmt(snap.cvdPriceCorr, 3)}`);
  if (snap.latestIlliq != null) snapLines.push(`ILLIQ=${fmt(snap.latestIlliq, 6)}`);

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `${sideArrow} · ${sym}` },
      template
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: lines.join('\n') }
      },
      ...(snapLines.length
        ? [
            { tag: 'hr' },
            {
              tag: 'note',
              elements: [
                { tag: 'lark_md', content: '指标 / Snapshot: ' + snapLines.join(' · ') }
              ]
            }
          ]
        : []),
      {
        tag: 'note',
        elements: [
          {
            tag: 'lark_md',
            content: `触发 / Trigger: **${triggerSource}** · ${new Date().toLocaleString('zh-CN', { hour12: false })}`
          }
        ]
      }
    ]
  };
}

function formatConditions(label, conds, score) {
  const items = Object.entries(conds).map(([k, v]) => `${v ? '✅' : '❌'} ${k}`);
  const head = score != null ? `${label}（${score}/${items.length}）` : label;
  return `**${head}**: ${items.join(', ')}`;
}

function fmt(v, digits = 4) {
  if (v == null) return '-';
  if (!Number.isFinite(Number(v))) return String(v);
  const n = Number(v);
  return n.toFixed(digits).replace(/\.?0+$/, '') || n.toFixed(digits);
}

function escapeMd(s) {
  return String(s == null ? '' : s).replace(/[*_`]/g, (m) => '\\' + m);
}

/** 一键封装：构造卡片并发送 (Build & send the trade-signal card). */
async function sendSignalCard(payload, meta = {}) {
  const card = buildSignalCard(payload, meta);
  return sendCard(card);
}

module.exports = {
  isEnabled,
  sendText,
  sendCard,
  sendSignalCard,
  buildSignalCard,
  shouldNotify,
  markNotified,
  getLastNotifiedSnapshot,
  resetNotifiedState,
  feishuSign
};
