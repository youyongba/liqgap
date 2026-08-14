'use strict';

/**
 * 后端信号轮询器 (Server-side Signal Poller)
 *
 * 背景：前端右侧「清算磁极信号 / 双层共振信号」面板已移除（性能优化），
 * 但这两个信号的飞书推送和 autoTrade webhook 是在 GET 请求处理过程中
 * 计算并触发的 —— 没有人轮询接口，信号系统就会静默失效。
 *
 * 本服务在服务端定时自轮询（self-HTTP 到本机端口），完整复用
 * routes/liqSignal.js + routes/resonanceSignal.js 里的全部逻辑：
 *   三阶窗口闸门 / 冷却 / 飞书卡片 / autoTrade 二次确认……全部照旧。
 *
 * 相比原来"前端 30s 轮询当前选中窗口"的模式还有一个改进：
 * 这里会遍历 FULL + NOTIFY 名单里的每个窗口（默认 1h / 4h / 24h），
 * 不再依赖用户碰巧把热图切到某个窗口才算那个窗口的信号。
 *
 * 环境变量 (Env)：
 *   SIGNAL_POLL_ENABLED   'false' 关闭（默认开）
 *   SIGNAL_POLL_MS        轮询间隔毫秒，默认 60000（每窗口 2 个接口，
 *                         默认 3 窗口 → 6 请求/分钟，与旧前端轮询量相当）
 *   SIGNAL_POLL_SYMBOL    轮询交易对，默认 'BTCUSDT'（仅 futures 有信号）
 */

const axios = require('axios');

const ONE_HOUR_MS = 3_600_000;
const _DEFAULT_WINDOWS = [ONE_HOUR_MS, 4 * ONE_HOUR_MS, 24 * ONE_HOUR_MS];

let _timer = null;
let _polling = false;

function isEnabled() {
  return process.env.SIGNAL_POLL_ENABLED !== 'false';
}

function _pollMs() {
  const n = Number(process.env.SIGNAL_POLL_MS);
  return Number.isFinite(n) && n >= 10_000 ? n : 60_000;
}

function _symbol() {
  return String(process.env.SIGNAL_POLL_SYMBOL || 'BTCUSDT').trim().toUpperCase();
}

/** FULL + NOTIFY 两组窗口的并集（与 routes/liqSignal.js 同一对 env）。 */
function _windows() {
  const parse = (raw) => String(raw || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const full = parse(process.env.TRADE_SIGNAL_ALLOWED_WINDOWS_MS);
  const notify = parse(process.env.TRADE_SIGNAL_NOTIFY_WINDOWS_MS);
  const merged = [...new Set([...full, ...notify])].sort((a, b) => a - b);
  return merged.length ? merged : _DEFAULT_WINDOWS;
}

function _baseUrl() {
  return `http://127.0.0.1:${process.env.PORT || 3000}`;
}

async function _hit(path, params) {
  try {
    await axios.get(`${_baseUrl()}${path}`, { params, timeout: 30_000 });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[signal-poller] ${path} windowMs=${params.windowMs} failed:`, err.message);
  }
}

async function _poll() {
  if (_polling) return;
  _polling = true;
  try {
    const symbol = _symbol();
    // 串行逐窗口请求，避免同一时刻多份热图重计算挤爆 CPU / Binance 限频
    for (const windowMs of _windows()) {
      // 飞书推送 / autoTrade 由路由内部按三阶闸门 + 冷却自行把关
      await _hit('/api/trade/liq-signal', { symbol, windowMs });
      await _hit('/api/trade/resonance-signal', { symbol, windowMs });
    }
  } finally {
    _polling = false;
  }
}

function start() {
  if (_timer) return;
  if (!isEnabled()) {
    // eslint-disable-next-line no-console
    console.log('[signal-poller] disabled via SIGNAL_POLL_ENABLED=false');
    return;
  }
  const ms = _pollMs();
  // 等服务器完全就绪（自轮询本机端口）再开始第一轮
  _timer = setInterval(() => { _poll(); }, ms);
  setTimeout(() => { _poll(); }, 5_000);
  // eslint-disable-next-line no-console
  console.log(
    `[signal-poller] started · symbol=${_symbol()} · every ${Math.round(ms / 1000)}s · ` +
    `windows=[${_windows().map((w) => `${w / ONE_HOUR_MS}h`).join(', ')}]`
  );
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, isEnabled, _windows, _poll };
