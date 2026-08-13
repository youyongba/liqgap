'use strict';

/**
 * 关键价位触碰监控 (Key Levels touch monitor) → 飞书推送
 *
 * 每 KEY_LEVELS_TOUCH_POLL_MS（默认 20s）轮询一次：
 *   1. 取关键价位（复用 /api/key-levels 的 30s 缓存，零额外计算压力）
 *   2. 取最新 1m K 线（用 high/low 而非 close，插针也能捕捉）
 *   3. 逐价位跑「武装 → 触发 → 冷却」状态机：
 *      • 看跌 FVG / S↑ 清算主峰 / 卖单墙（现价上方）：
 *          价格先在价位下方（武装）→ K 线 high 触及 → 推送「⬆️ 上涨触及」
 *      • 看涨 FVG / L↓ 清算主峰 / 买单墙（现价下方）：
 *          价格先在价位上方（武装）→ K 线 low 触及 → 推送「⬇️ 下跌触及」
 *      触发后必须先离开该价位一段距离（rearm 缓冲，默认 0.15%）才会
 *      重新武装；且同一价位 30 分钟冷却 —— 双保险防轰炸。
 *   4. 同一轮里触发的多个价位合并成一张卡片（分周期罗列），避免刷屏
 *
 * 环境变量 (Env)：
 *   KEY_LEVELS_TOUCH_NOTIFY_ENABLED  'false' 关闭（默认开，且需 FEISHU_WEBHOOK_URL）
 *   KEY_LEVELS_TOUCH_SYMBOL          监控交易对，默认 'BTCUSDT'
 *   KEY_LEVELS_TOUCH_MARKET          'futures' | 'spot'，默认 'futures'
 *   KEY_LEVELS_TOUCH_POLL_MS         轮询间隔，默认 20000
 *   KEY_LEVELS_TOUCH_COOLDOWN_MS     同一价位冷却，默认 1800000 (30min)
 *   KEY_LEVELS_TOUCH_TYPES           监控类型，默认 'fvg,liq,wall'
 *                                    （可加 'poc','vwap'；VWAP 常驻现价附近，
 *                                      开启会很吵，默认不监控）
 *   KEY_LEVELS_TOUCH_REARM_PCT       重新武装需要离开价位的距离(%)，默认 0.15
 */

const feishu = require('./feishu');
const { BinanceLive } = require('./binanceLive');

const _num = (env, dflt) => {
  const n = Number(process.env[env]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

// 价位状态：key → { armed, lastFiredAt, lastSeen }
const _state = new Map();
let _timer = null;
let _polling = false;

function isEnabled() {
  if (process.env.KEY_LEVELS_TOUCH_NOTIFY_ENABLED === 'false') return false;
  return feishu.isEnabled();
}

function _types() {
  const raw = process.env.KEY_LEVELS_TOUCH_TYPES || 'fvg,liq,wall';
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/**
 * 把 key-levels 数据摊平成待监控价位列表。
 *
 * side 语义：
 *   'above' = 价位在现价上方，等价格「上涨触及」（看跌FVG / S↑ / 卖墙）
 *   'below' = 价位在现价下方，等价格「下跌触及」（看涨FVG / L↓ / 买墙）
 * zone 价位（FVG/POC）触发边界取靠近现价的一侧：above 用 low，below 用 high。
 *
 * key 里的价格按 0.1% 相对精度取整 —— 主峰/墙每 30s 重算会有微小漂移，
 * 取整后仍视为同一价位，冷却状态不丢失。
 */
function _buildWatchList(data, types) {
  const px = Number(data && data.latestPrice);
  if (!Number.isFinite(px) || px <= 0) return [];
  const bucket = Math.max(px * 0.001, 1e-9);
  const pkey = (p) => Math.round(p / bucket);
  const out = [];

  if (types.has('fvg') || types.has('poc') || types.has('vwap')) {
    for (const it of data.intervals || []) {
      if (!it.ok) continue;
      const tf = it.interval;
      if (types.has('fvg')) {
        if (it.bearFvg && Number.isFinite(it.bearFvg.lower) && it.bearFvg.lower > px) {
          out.push({
            key: `fvg-bear|${tf}|${pkey(it.bearFvg.lower)}`,
            side: 'above', low: it.bearFvg.lower, high: it.bearFvg.upper,
            label: `${tf} 看跌FVG`, hint: '关注做空 / watch short'
          });
        }
        if (it.bullFvg && Number.isFinite(it.bullFvg.upper) && it.bullFvg.upper < px) {
          out.push({
            key: `fvg-bull|${tf}|${pkey(it.bullFvg.upper)}`,
            side: 'below', low: it.bullFvg.lower, high: it.bullFvg.upper,
            label: `${tf} 看涨FVG`, hint: '关注做多 / watch long'
          });
        }
      }
      if (types.has('poc') && it.poc && Number.isFinite(it.poc.low) && Number.isFinite(it.poc.high)) {
        const mid = (it.poc.low + it.poc.high) / 2;
        if (mid !== px) {
          out.push({
            key: `poc|${tf}|${pkey(mid)}`,
            side: mid > px ? 'above' : 'below', low: it.poc.low, high: it.poc.high,
            label: `${tf} POC`, hint: ''
          });
        }
      }
      if (types.has('vwap') && Number.isFinite(it.vwap) && it.vwap !== px) {
        out.push({
          key: `vwap|${tf}|${pkey(it.vwap)}`,
          side: it.vwap > px ? 'above' : 'below', low: it.vwap, high: it.vwap,
          label: `${tf} VWAP`, hint: ''
        });
      }
    }
  }

  if (types.has('liq')) {
    for (const w of data.liqWindows || []) {
      if (Number.isFinite(w.sMax) && w.sMax > px) {
        out.push({
          key: `liq-s|${w.label}|${pkey(w.sMax)}`,
          side: 'above', low: w.sMax, high: w.sMax,
          label: `${w.label} S↑ 空头最大清算`, hint: ''
        });
      }
      if (Number.isFinite(w.lMax) && w.lMax < px) {
        out.push({
          key: `liq-l|${w.label}|${pkey(w.lMax)}`,
          side: 'below', low: w.lMax, high: w.lMax,
          label: `${w.label} L↓ 多头最大清算`, hint: ''
        });
      }
    }
  }

  if (types.has('wall')) {
    for (const w of data.obWalls || []) {
      if (Number.isFinite(w.askWall) && w.askWall > px) {
        out.push({
          key: `wall-ask|${w.label}|${pkey(w.askWall)}`,
          side: 'above', low: w.askWall, high: w.askWall,
          label: `${w.label} 卖单墙`, hint: ''
        });
      }
      if (Number.isFinite(w.bidWall) && w.bidWall < px) {
        out.push({
          key: `wall-bid|${w.label}|${pkey(w.bidWall)}`,
          side: 'below', low: w.bidWall, high: w.bidWall,
          label: `${w.label} 买单墙`, hint: ''
        });
      }
    }
  }

  return out;
}

/**
 * 单价位状态机。candle = { high, low, close }。
 * 返回 true 表示本轮触发推送（内部已更新状态）。
 *
 * 武装条件（价格离价位足够远，防止在边界上反复抖动触发）：
 *   above: close < 触发边界 × (1 - rearmPct)
 *   below: close > 触发边界 × (1 + rearmPct)
 * 触发条件（用影线，插针也算触及）：
 *   above: high ≥ 触发边界   /   below: low ≤ 触发边界
 */
function _evalTouch(level, candle, now, cooldownMs, rearmPct) {
  let st = _state.get(level.key);
  if (!st) {
    st = { armed: false, lastFiredAt: 0, lastSeen: now };
    _state.set(level.key, st);
  }
  st.lastSeen = now;

  const edge = level.side === 'above' ? level.low : level.high;
  const buf = edge * rearmPct;

  const isAway = level.side === 'above'
    ? candle.close < edge - buf
    : candle.close > edge + buf;
  const isTouched = level.side === 'above'
    ? candle.high >= edge
    : candle.low <= edge;

  if (!st.armed) {
    // 未武装：价格离开价位足够远才武装（首次见到且已在区间内 → 不触发）
    if (isAway) st.armed = true;
    return false;
  }
  if (!isTouched) return false;
  if (now - st.lastFiredAt < cooldownMs) {
    // 冷却中：仍解除武装，等再次离开后重新武装
    st.armed = false;
    return false;
  }
  st.armed = false;
  st.lastFiredAt = now;
  return true;
}

/** 状态表防无界增长：淘汰 24h 未见的价位 */
function _pruneState(now) {
  if (_state.size < 500) return;
  for (const [k, v] of _state.entries()) {
    if (now - v.lastSeen > 24 * 3600_000) _state.delete(k);
  }
}

const _fmtP = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '-';
  return n >= 1000
    ? n.toLocaleString('en-US', { maximumFractionDigits: 1 })
    : String(parseFloat(n.toPrecision(6)));
};

/** 一轮触发的多个价位合并成一张卡片 */
function _buildTouchCard(symbol, market, price, touches) {
  const ups = touches.filter((t) => t.side === 'above');
  const downs = touches.filter((t) => t.side === 'below');
  // 全是上方价位被上涨触及 → 做空关注(红)；全是下方 → 做多关注(绿)；混合 → 橙
  const template = ups.length && !downs.length ? 'red'
    : downs.length && !ups.length ? 'green' : 'orange';

  const lines = touches.map((t) => {
    const arrow = t.side === 'above' ? '⬆️ 上涨触及' : '⬇️ 下跌触及';
    const range = t.low === t.high
      ? _fmtP(t.low)
      : `${_fmtP(t.low)} ~ ${_fmtP(t.high)}`;
    return `**${t.label}**  ${range} · ${arrow}${t.hint ? ` · ${t.hint}` : ''}`;
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      template,
      title: { tag: 'plain_text', content: `📍 关键价位触碰 · ${symbol} ${market}` }
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
      { tag: 'hr' },
      {
        tag: 'note',
        elements: [{
          tag: 'lark_md',
          content: `现价 ${_fmtP(price)} · ${new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })} (UTC+8) · 同价位 ${Math.round(_num('KEY_LEVELS_TOUCH_COOLDOWN_MS', 1800_000) / 60_000)}min 冷却`
        }]
      }
    ]
  };
}

async function _poll() {
  if (_polling || !isEnabled()) return;
  _polling = true;
  try {
    const symbol = (process.env.KEY_LEVELS_TOUCH_SYMBOL || 'BTCUSDT').toUpperCase();
    const market = process.env.KEY_LEVELS_TOUCH_MARKET === 'spot' ? 'spot' : 'futures';

    // 循环 require 规避：routes/keyLevels 也 require 本服务所在链路的 feishu，
    // 顶部互相引用容易成环，运行时再取。
    const { getKeyLevelsCached } = require('../routes/keyLevels');
    const [{ data }, klines] = await Promise.all([
      getKeyLevelsCached(symbol, market),
      BinanceLive.getKlines(symbol, '1m', 2, market).catch(() => [])
    ]);
    if (!data || !klines || !klines.length) return;

    const k = klines[klines.length - 1];
    const candle = { high: Number(k[2]), low: Number(k[3]), close: Number(k[4]) };
    if (!Number.isFinite(candle.close)) return;

    const now = Date.now();
    const cooldownMs = _num('KEY_LEVELS_TOUCH_COOLDOWN_MS', 1800_000);
    const rearmPct = _num('KEY_LEVELS_TOUCH_REARM_PCT', 0.15) / 100;
    const levels = _buildWatchList(data, _types());

    const touches = [];
    for (const lv of levels) {
      if (_evalTouch(lv, candle, now, cooldownMs, rearmPct)) touches.push(lv);
    }
    _pruneState(now);

    if (touches.length) {
      const card = _buildTouchCard(symbol, market, candle.close, touches);
      const r = await feishu.sendCard(card);
      // eslint-disable-next-line no-console
      console.log(`[klTouch] pushed ${touches.length} touch(es): ${touches.map((t) => t.label).join(' / ')} · feishu ok=${r && r.ok}`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[klTouch] poll failed:', err.message);
  } finally {
    _polling = false;
  }
}

function start() {
  if (_timer) return;
  if (!isEnabled()) {
    // eslint-disable-next-line no-console
    console.log('[klTouch] disabled (KEY_LEVELS_TOUCH_NOTIFY_ENABLED=false or Feishu not configured)');
    return;
  }
  const pollMs = _num('KEY_LEVELS_TOUCH_POLL_MS', 20_000);
  _timer = setInterval(_poll, pollMs);
  _timer.unref && _timer.unref();
  // eslint-disable-next-line no-console
  console.log(`[klTouch] start · symbol=${process.env.KEY_LEVELS_TOUCH_SYMBOL || 'BTCUSDT'} poll=${pollMs}ms types=${[..._types()].join(',')}`);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = {
  start,
  stop,
  isEnabled,
  // 冒烟测试用 (for smoke tests)
  _buildWatchList,
  _evalTouch,
  _buildTouchCard,
  _state
};
