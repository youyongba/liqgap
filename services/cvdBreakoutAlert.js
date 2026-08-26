'use strict';

/**
 * CVD 24h 突破监控 (CVD 24h breakout monitor) → 飞书推送
 *
 * 每 CVD_BREAKOUT_POLL_MS（默认 60s）轮询一次：
 *   1. 自轮询本机 /api/cvd（默认 aggregate=binance 合并 USDT-M + USDC-M +
 *      COIN-M 三类合约 delta，复用路由的 SWR 缓存，几乎零额外上游压力）
 *   2. 把窗口内每根 K 线的 delta 累加成 CVD 曲线
 *   3. 最新值 > 窗口内此前最高点 → 「📈 CVD 突破 24h 新高」
 *      最新值 < 窗口内此前最低点 → 「📉 CVD 跌破 24h 新低」
 *   4. 防轰炸：
 *      • 启动首轮只建基线不推送（重启时 CVD 恰在极值上不会立刻刷屏）
 *      • 同方向冷却（默认 30min）——持续创新高最多每 30min 提醒一次
 *
 * CVD 突破的交易含义：
 *   • 突破 24h 新高 = 主动买盘净流入创一天之最（bullish order flow）
 *   • 跌破 24h 新低 = 主动卖盘主导（bearish order flow）
 *   • 与价格对照更有意义：CVD 新高而价格滞涨 → 吸筹/对手方挂单吸收
 *
 * 环境变量 (Env)：
 *   CVD_BREAKOUT_NOTIFY_ENABLED  'false' 关闭（默认开，且需 FEISHU_WEBHOOK_URL）
 *   CVD_BREAKOUT_SYMBOLS         逗号分隔监控列表，默认 'BTCUSDT'（仅 futures）
 *   CVD_BREAKOUT_WINDOW_HOURS    回看窗口小时数，默认 24
 *   CVD_BREAKOUT_POLL_MS         轮询间隔毫秒，默认 60000
 *   CVD_BREAKOUT_COOLDOWN_MS     同方向冷却毫秒，默认 1800000 (30min)
 *   CVD_BREAKOUT_INTERVAL        采样 K 线周期，默认 '5m'（24h=288 根，够细且省流）
 *   CVD_BREAKOUT_MEASURE         突破判定口径 'usd'(默认·名义美元) | 'coin'(币数)
 *   CVD_BREAKOUT_AGGREGATE       'false' 只看当前合约；默认合并三类合约
 */

const axios = require('axios');
const feishu = require('./feishu');
const { BinanceLive } = require('./binanceLive');

const INTERVAL_MS = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
  '30m': 1_800_000, '1h': 3_600_000
};

const _num = (env, dflt) => {
  const n = Number(process.env[env]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

// symbol → { baselined, lastFiredAt: { high, low } }
const _state = new Map();
// symbol → 最近一轮检测快照（/api/cvd-breakout/status 自诊断用）
const _lastPoll = new Map();
let _timer = null;
let _polling = false;
let _startedAt = 0;
let _pollCount = 0;

function isEnabled() {
  if (process.env.CVD_BREAKOUT_NOTIFY_ENABLED === 'false') return false;
  return feishu.isEnabled();
}

function _symbols() {
  return String(process.env.CVD_BREAKOUT_SYMBOLS || 'BTCUSDT')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
}

function _interval() {
  const v = String(process.env.CVD_BREAKOUT_INTERVAL || '5m');
  return INTERVAL_MS[v] ? v : '5m';
}

function _windowMs() {
  return _num('CVD_BREAKOUT_WINDOW_HOURS', 24) * 3_600_000;
}

function _measure() {
  return process.env.CVD_BREAKOUT_MEASURE === 'coin' ? 'coin' : 'usd';
}

function _aggregate() {
  return process.env.CVD_BREAKOUT_AGGREGATE !== 'false';
}

// 从 symbol 解析基础币种：BTCUSDT/BTCUSDC → BTC（与 routes/cvd.js 同款）
function _baseAsset(symbol) {
  const s = String(symbol).toUpperCase();
  if (s.endsWith('USDT') || s.endsWith('USDC')) return s.slice(0, -4);
  if (s.endsWith('USD')) return s.slice(0, -3);
  return s;
}

// ---------------------------------------------------------------------------
// 突破检测（纯函数 · 冒烟测试直接调用）
// ---------------------------------------------------------------------------
/**
 * @param {Array<{openTime:number, delta:number, deltaUsd:number}>} points 时间升序
 * @param {{windowMs:number, intervalMs:number, measure:'usd'|'coin'}} opts
 * @returns {null | {
 *   direction: 'high'|'low'|null,
 *   current:number, prevHigh:number, prevLow:number,
 *   currentUsd:number, currentCoin:number, bars:number, lastOpenTime:number
 * }} 数据不足（覆盖率 < 窗口一半）时返回 null
 */
function _detectBreakout(points, opts) {
  const { windowMs, intervalMs } = opts;
  const field = opts.measure === 'coin' ? 'delta' : 'deltaUsd';
  const pts = (Array.isArray(points) ? points : [])
    .filter((p) => p && Number.isFinite(p.openTime) && Number.isFinite(p[field]));
  if (pts.length < 3) return null;

  const lastOpenTime = pts[pts.length - 1].openTime;
  const fromMs = lastOpenTime - windowMs;
  const win = pts.filter((p) => p.openTime > fromMs);
  // 覆盖率守卫：窗口内样本要至少覆盖一半时长，否则"24h 高点"没有意义
  if (win.length < 3 || win.length * intervalMs < windowMs / 2) return null;

  let cum = 0;
  let cumUsd = 0;
  let cumCoin = 0;
  let prevHigh = -Infinity;
  let prevLow = Infinity;
  let current = 0;
  for (let i = 0; i < win.length; i += 1) {
    cum += win[i][field];
    cumUsd += Number.isFinite(win[i].deltaUsd) ? win[i].deltaUsd : 0;
    cumCoin += Number.isFinite(win[i].delta) ? win[i].delta : 0;
    if (i < win.length - 1) {
      if (cum > prevHigh) prevHigh = cum;
      if (cum < prevLow) prevLow = cum;
    } else {
      current = cum;
    }
  }

  const direction = current > prevHigh ? 'high' : current < prevLow ? 'low' : null;
  return {
    direction, current, prevHigh, prevLow,
    currentUsd: cumUsd, currentCoin: cumCoin,
    bars: win.length, lastOpenTime
  };
}

/**
 * 推送闸门（状态机 · 冒烟测试直接调用）：
 *   启动首轮 → 只建基线；之后同方向冷却期内不重复推送。
 */
function _shouldFire(symbol, direction, now, cooldownMs) {
  let st = _state.get(symbol);
  if (!st) {
    st = { baselined: false, lastFiredAt: { high: 0, low: 0 } };
    _state.set(symbol, st);
  }
  if (!st.baselined) {
    st.baselined = true;
    return false;
  }
  if (direction !== 'high' && direction !== 'low') return false;
  if (now - st.lastFiredAt[direction] < cooldownMs) return false;
  st.lastFiredAt[direction] = now;
  return true;
}

// ---------------------------------------------------------------------------
// 飞书卡片
// ---------------------------------------------------------------------------
function _fmtUsd(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '-';
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

function _fmtCoin(v, base) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '-';
  const digits = Math.abs(n) >= 100 ? 1 : 3;
  return `${n.toFixed(digits)} ${base}`;
}

function _fmtP(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '-';
  return n >= 1000
    ? n.toLocaleString('en-US', { maximumFractionDigits: 1 })
    : String(parseFloat(n.toPrecision(6)));
}

/**
 * @param {{symbol, info, measure, windowHours, price, aggregated, cooldownMs}} p
 */
function _buildBreakoutCard(p) {
  const { symbol, info, measure, windowHours, price, aggregated, cooldownMs } = p;
  const up = info.direction === 'high';
  const base = _baseAsset(symbol);
  const fmtMeasure = (v) => (measure === 'coin' ? _fmtCoin(v, base) : _fmtUsd(v));

  const title = up
    ? `📈 CVD 突破 ${windowHours}h 新高 · ${symbol}`
    : `📉 CVD 跌破 ${windowHours}h 新低 · ${symbol}`;
  const margin = up ? info.current - info.prevHigh : info.prevLow - info.current;

  const lines = [];
  lines.push(`**标的 / Symbol**: ${symbol} · 合约${aggregated ? '（聚合 USDT-M + USDC-M + COIN-M）' : ''}`);
  lines.push(`**当前 CVD**: ${_fmtUsd(info.currentUsd)} (${_fmtCoin(info.currentCoin, base)})`);
  lines.push('---');
  if (up) {
    lines.push(`**${windowHours}h 前高**: ${fmtMeasure(info.prevHigh)}`);
    lines.push(`**突破幅度**: +${fmtMeasure(margin)}`);
    lines.push('**解读**: 主动买盘净流入创一天之最（bullish flow）；若价格滞涨注意上方抛压吸收');
  } else {
    lines.push(`**${windowHours}h 前低**: ${fmtMeasure(info.prevLow)}`);
    lines.push(`**跌破幅度**: -${fmtMeasure(margin)}`);
    lines.push('**解读**: 主动卖盘主导（bearish flow）；若价格抗跌注意下方买盘吸收');
  }
  if (Number.isFinite(price)) lines.push(`**最新价 / Last**: ${_fmtP(price)}`);

  return {
    config: { wide_screen_mode: true },
    header: {
      template: up ? 'green' : 'red',
      title: { tag: 'plain_text', content: title }
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
      { tag: 'hr' },
      {
        tag: 'note',
        elements: [{
          tag: 'lark_md',
          content: `窗口 ${windowHours}h · 口径 ${measure === 'coin' ? '币数' : 'USD'} · `
            + `同方向 ${Math.round(cooldownMs / 60_000)}min 冷却 · `
            + `${new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })} (UTC+8)`
        }]
      }
    ]
  };
}

// ---------------------------------------------------------------------------
// 轮询
// ---------------------------------------------------------------------------
function _baseUrl() {
  return `http://127.0.0.1:${process.env.PORT || 3000}`;
}

async function _fetchDeltas(symbol) {
  const interval = _interval();
  const intervalMs = INTERVAL_MS[interval];
  const bars = Math.ceil(_windowMs() / intervalMs) + 2;
  const limit = Math.min(Math.max(bars, 10), 1000);
  const params = { symbol, market: 'futures', interval, limit };
  if (_aggregate()) params.aggregate = 'binance';
  const res = await axios.get(`${_baseUrl()}/api/cvd`, { params, timeout: 30_000 });
  const j = res.data;
  if (!j || !j.success || !j.data || !Array.isArray(j.data.data)) {
    throw new Error((j && j.error) || 'bad /api/cvd response');
  }
  return j.data.data; // [{openTime, delta, deltaUsd}] 时间升序
}

async function _poll() {
  if (_polling || !isEnabled()) return;
  _polling = true;
  _pollCount += 1;
  try {
    const measure = _measure();
    const windowMs = _windowMs();
    const intervalMs = INTERVAL_MS[_interval()];
    const cooldownMs = _num('CVD_BREAKOUT_COOLDOWN_MS', 1_800_000);
    const now = Date.now();

    for (const symbol of _symbols()) {
      const snap = { at: now, gate: 'none', direction: null, error: null, feishuOk: null };
      try {
        const points = await _fetchDeltas(symbol);
        const info = _detectBreakout(points, { windowMs, intervalMs, measure });
        if (!info) {
          snap.gate = 'insufficient-data';
          snap.error = `样本不足（收到 ${Array.isArray(points) ? points.length : 0} 根，需覆盖窗口一半以上）`;
          continue;
        }
        snap.direction = info.direction;
        snap.current = info.current;
        snap.prevHigh = info.prevHigh;
        snap.prevLow = info.prevLow;
        snap.bars = info.bars;

        const stBefore = _state.get(symbol); // _shouldFire 之前的状态（判定拦截原因用）
        const fire = _shouldFire(symbol, info.direction, now, cooldownMs);
        if (!fire) {
          if (!info.direction) {
            snap.gate = 'no-breakout';
          } else if (!stBefore || !stBefore.baselined) {
            snap.gate = 'baseline';
          } else {
            const left = cooldownMs - (now - (stBefore.lastFiredAt[info.direction] || 0));
            snap.gate = 'cooldown';
            snap.cooldownLeftSec = Math.max(0, Math.ceil(left / 1000));
          }
          if (info.direction) {
            // eslint-disable-next-line no-console
            console.log(
              `[cvdBreakout] ${symbol} 检测到 ${info.direction === 'high' ? '↑破前高' : '↓破前低'} `
              + `但被闸门拦截 (${snap.gate}${snap.gate === 'cooldown' ? ` 剩 ${Math.ceil((snap.cooldownLeftSec || 0) / 60)}min` : ''})`
            );
          }
          continue;
        }

        const price = await BinanceLive.getCurrentPrice(symbol, 'futures').catch(() => null);
        const card = _buildBreakoutCard({
          symbol, info, measure,
          windowHours: Math.round(windowMs / 3_600_000),
          price, aggregated: _aggregate(), cooldownMs
        });
        const r = await feishu.sendCard(card);
        snap.gate = 'sent';
        snap.feishuOk = !!(r && r.ok);
        if (!snap.feishuOk) snap.error = (r && r.error) || 'feishu send failed';
        // eslint-disable-next-line no-console
        console.log(
          `[cvdBreakout] ${symbol} ${info.direction === 'high' ? '↑ 突破前高' : '↓ 跌破前低'} `
          + `cvd=${measure === 'coin' ? info.currentCoin.toFixed(2) : info.currentUsd.toFixed(0)} `
          + `· feishu ok=${snap.feishuOk}`
        );
      } catch (err) {
        snap.gate = 'error';
        snap.error = err.message;
        // eslint-disable-next-line no-console
        console.warn(`[cvdBreakout] ${symbol} poll failed:`, err.message);
      } finally {
        _lastPoll.set(symbol, snap);
      }
    }
  } finally {
    _polling = false;
  }
}

/**
 * 自诊断状态（挂在 GET /api/cvd-breakout/status）：
 * 远端排查"为什么没推送"时一条 curl 就能看到监控是否在跑、
 * 最近一轮检测到什么、被哪道闸门拦住。
 */
function getStatus() {
  const now = Date.now();
  const symbols = _symbols();
  return {
    enabled: isEnabled(),
    feishuConfigured: feishu.isEnabled(),
    running: !!_timer,
    startedAt: _startedAt || null,
    uptimeSec: _startedAt ? Math.round((now - _startedAt) / 1000) : 0,
    pollCount: _pollCount,
    config: {
      symbols,
      windowHours: Math.round(_windowMs() / 3_600_000),
      interval: _interval(),
      measure: _measure(),
      aggregate: _aggregate(),
      pollMs: _num('CVD_BREAKOUT_POLL_MS', 60_000),
      cooldownMs: _num('CVD_BREAKOUT_COOLDOWN_MS', 1_800_000)
    },
    symbolsState: symbols.map((s) => {
      const st = _state.get(s);
      const lp = _lastPoll.get(s);
      return {
        symbol: s,
        baselined: !!(st && st.baselined),
        lastFiredAt: st ? st.lastFiredAt : { high: 0, low: 0 },
        lastPoll: lp || null,
        lastPollAgoSec: lp ? Math.round((now - lp.at) / 1000) : null
      };
    })
  };
}

function start() {
  if (_timer) return;
  if (!isEnabled()) {
    // eslint-disable-next-line no-console
    console.log('[cvdBreakout] disabled (CVD_BREAKOUT_NOTIFY_ENABLED=false or Feishu not configured)');
    return;
  }
  const pollMs = _num('CVD_BREAKOUT_POLL_MS', 60_000);
  _startedAt = Date.now();
  _timer = setInterval(_poll, pollMs);
  if (typeof _timer.unref === 'function') _timer.unref();
  // 等服务器就绪（自轮询本机端口）再跑首轮建基线
  setTimeout(() => { _poll(); }, 8_000);
  // eslint-disable-next-line no-console
  console.log(
    `[cvdBreakout] start · symbols=${_symbols().join(',')} · window=${Math.round(_windowMs() / 3_600_000)}h `
    + `· interval=${_interval()} · measure=${_measure()} · poll=${Math.round(pollMs / 1000)}s`
  );
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = {
  start,
  stop,
  isEnabled,
  getStatus,
  // 冒烟测试用 (for smoke tests)
  _poll,
  _detectBreakout,
  _shouldFire,
  _buildBreakoutCard,
  _state
};
