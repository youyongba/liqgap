'use strict';

/**
 * Regime 接口客户端 (Regime / market-state API client)
 *
 * 当 1h K 线检测到「新出现」的 FVG 时，把方向通知到外部 regime 接口。
 * Body 形状固定为：
 *   { fvg: 'long' }   ← bullish FVG (绿色)
 *   { fvg: 'short' }  ← bearish FVG (红色)
 *
 * 配置 (Env vars):
 *   REGIME_API_URL          目标 URL，必填，未配置时整体禁用 (no-op)
 *   REGIME_API_METHOD       'POST' | 'GET' (默认 POST)
 *   REGIME_API_TOKEN        可选；存在时附加 `Authorization: Bearer <token>`
 *   REGIME_NOTIFY_ENABLED   'false' 显式关闭整体通知（默认开启）
 *
 * 失败语义：
 *   - 永不抛错；网络失败 / 非 2xx 都返回 { ok:false, error }，调用方决定是否重试。
 *   - 把所有调用记录到内存 ring buffer，便于 /api/notify/status 排查。
 */

const axios = require('axios');

const HTTP_TIMEOUT_MS = 8000;
const MAX_RECENT = 50;

// 调用记录环形缓冲 (Ring buffer of recent calls)
const recentCalls = [];

function recordCall(record) {
  recentCalls.unshift(record);
  if (recentCalls.length > MAX_RECENT) recentCalls.length = MAX_RECENT;
}

function isEnabled() {
  if (process.env.REGIME_NOTIFY_ENABLED === 'false') return false;
  return !!process.env.REGIME_API_URL;
}

function buildHeaders() {
  const h = {
    'Content-Type': 'application/json; charset=utf-8',
    Accept: 'application/json, */*',
    'User-Agent': 'liq-gap/1.0 (+regime-notifier)'
  };
  if (process.env.REGIME_API_TOKEN) {
    h.Authorization = `Bearer ${process.env.REGIME_API_TOKEN}`;
  }
  return h;
}

/**
 * 通知 regime 接口 (Notify regime API).
 *
 * @param {'long'|'short'} direction
 * @param {object} [meta]  附加诊断信息（仅记录到 recentCalls，不发送）
 * @returns {Promise<{ok:boolean, status?:number, response?:any, error?:string,
 *                    skipped?:boolean, reason?:string}>}
 */
async function notifyFvg(direction, meta = {}) {
  if (!isEnabled()) {
    return {
      ok: false,
      skipped: true,
      reason: 'REGIME_API_URL not set or REGIME_NOTIFY_ENABLED=false'
    };
  }
  if (direction !== 'long' && direction !== 'short') {
    const err = `invalid direction: ${direction}`;
    recordCall({
      ts: Date.now(),
      ok: false,
      direction,
      error: err,
      meta
    });
    return { ok: false, error: err };
  }

  const url = process.env.REGIME_API_URL;
  const method = String(process.env.REGIME_API_METHOD || 'POST').toUpperCase();
  const body = { fvg: direction };
  const startedAt = Date.now();

  try {
    let res;
    if (method === 'GET') {
      // GET：把 body 拍到 query string (防止网关丢 body)
      const qs = new URLSearchParams(body).toString();
      const sep = url.includes('?') ? '&' : '?';
      res = await axios.get(`${url}${sep}${qs}`, {
        timeout: HTTP_TIMEOUT_MS,
        headers: buildHeaders()
      });
    } else {
      res = await axios({
        method,
        url,
        data: body,
        timeout: HTTP_TIMEOUT_MS,
        headers: buildHeaders()
      });
    }
    recordCall({
      ts: startedAt,
      ok: true,
      direction,
      method,
      url,
      request: body,
      status: res.status,
      response: truncate(res.data),
      durationMs: Date.now() - startedAt,
      meta
    });
    return { ok: true, status: res.status, response: res.data };
  } catch (err) {
    const status = err.response && err.response.status;
    const respData = err.response && err.response.data;
    // eslint-disable-next-line no-console
    console.error(`[regime] notify ${direction} failed:`, err.message, respData || '');
    recordCall({
      ts: startedAt,
      ok: false,
      direction,
      method,
      url,
      request: body,
      status,
      error: err.message,
      response: truncate(respData),
      durationMs: Date.now() - startedAt,
      meta
    });
    return {
      ok: false,
      status,
      error: `regime request failed (HTTP ${status || 'NETERR'}): ${err.message}`,
      response: respData
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

module.exports = {
  isEnabled,
  notifyFvg,
  getRecentCalls,
  resetRecentCalls
};
