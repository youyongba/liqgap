'use strict';

/**
 * GET /api/trade/liq-signal
 *
 * "清算磁极"高胜率交易信号：基于预测性清算热图的两条主峰横线（L↓ 多头清算
 * 墙 / S↑ 空头清算墙），结合 CVD / OI / 成交量过滤，输出四类高胜率信号：
 *
 *   LIQ_REVERSAL_LONG    现价跌到 L↓ 附近 (距离 < 0.3%) → 反转做多
 *   LIQ_REVERSAL_SHORT   现价涨到 S↑ 附近 (距离 < 0.3%) → 反转做空
 *   LIQ_SQUEEZE_LONG     现价刚穿过 S↑（10min 内）→ 顺势追多吃 squeeze
 *   LIQ_SQUEEZE_SHORT    现价刚穿过 L↓（10min 内）→ 顺势追空吃 cascade
 *
 * 置信度 (confidence 0~100) 综合评分；≥ 75 才会推送飞书。
 *
 * 查询参数：
 *   symbol           默认 'BTCUSDT'
 *   market           固定 'futures'（spot 无杠杆故无清算）
 *   windowMs         主峰窗口，默认 4h；范围 [1h, 24h]（太长主峰过时，太短噪声大）
 *   riskPercent      默认 1
 *   accountBalance   默认 1000 USDT
 *   notify           'false' 关闭本次飞书推送
 *
 * 响应：
 *   {
 *     signal: 'LIQ_REVERSAL_LONG' | 'LIQ_REVERSAL_SHORT' |
 *             'LIQ_SQUEEZE_LONG'  | 'LIQ_SQUEEZE_SHORT'  | 'NONE',
 *     confidence: 0..100,
 *     side: 'long'|'short',
 *     entryPrice, stopLoss, takeProfits[],
 *     positionSize, positionSizeQuote, riskAmount,
 *     peakLong: { price, value }, peakShort: { price, value },
 *     conditions: { ... },     // 命中明细
 *     indicatorsSnapshot: { ... }
 *   }
 */

const express = require('express');
const { BinanceService } = require('../services/binance');
const {
  normalizeKlines,
  computeATR
} = require('../indicators/klineIndicators');
const { computeTradeIndicators } = require('../indicators/tradeIndicators');
const { buildPredictiveLiquidationHeatmap } = require('../services/predictiveLiquidations');
const feishu = require('../services/feishu');

const router = express.Router();

const ONE_MIN_MS = 60_000;
const ONE_HOUR_MS = 3600_000;

// ------ 可调参数（env 覆盖）------
const REVERSAL_DIST_PCT = Number(process.env.LIQ_SIGNAL_REVERSAL_DIST_PCT) || 0.003; // 0.3%
const SQUEEZE_LOOKBACK_MS = Number(process.env.LIQ_SIGNAL_SQUEEZE_LOOKBACK_MS) || 10 * ONE_MIN_MS;
const OI_SURGE_MULT = Number(process.env.LIQ_SIGNAL_OI_SURGE_MULT) || 1.5;
const VOL_SURGE_MULT = Number(process.env.LIQ_SIGNAL_VOL_SURGE_MULT) || 3.0;
const POWER_RATIO_THR = Number(process.env.LIQ_SIGNAL_POWER_RATIO) || 1.5;
const COOLDOWN_MS = Number(process.env.LIQ_SIGNAL_COOLDOWN_MS) || 30 * ONE_MIN_MS;
const MIN_CONFIDENCE_TO_NOTIFY = Number(process.env.LIQ_SIGNAL_MIN_CONFIDENCE) || 75;

// ------ 飞书去重（按 symbol + signalType）------
const _lastSignalByKey = new Map();
function _shouldNotifyLiq(symbol, market, signal) {
  const k = `${String(symbol).toUpperCase()}|${market}|${signal}`;
  const prev = _lastSignalByKey.get(k);
  const now = Date.now();
  if (!prev) return { ok: true, key: k };
  const elapsed = now - prev.ts;
  if (elapsed >= COOLDOWN_MS) return { ok: true, key: k };
  return { ok: false, reason: `same signal in cooldown (${Math.round(elapsed / 1000)}s ago)` };
}
function _markNotified(key) {
  _lastSignalByKey.set(key, { ts: Date.now() });
}

router.get('/trade/liq-signal', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || 'BTCUSDT').toUpperCase();
    const market = 'futures'; // spot 无杠杆不可能爆仓
    let windowMs = Number(req.query.windowMs);
    if (!Number.isFinite(windowMs) || windowMs < ONE_HOUR_MS) windowMs = 4 * ONE_HOUR_MS;
    if (windowMs > 24 * ONE_HOUR_MS) windowMs = 24 * ONE_HOUR_MS;
    const riskPercent = Number(req.query.riskPercent) || 1;
    const accountBalance = Number(req.query.accountBalance) || 1000;

    // ---- 数据源（并行拉取）----
    // 主峰用 1m K 线（精度高，4h 窗口 240 根）
    // 趋势用 1m × 60 根（最近 1h 的价格 + CVD 趋势）
    // OI 用 5m × 24 根（最近 2h 的持仓量序列）
    // 成交用 500 笔 aggTrades（实时 CVD）
    const [hmRaw, oiHist, trades] = await Promise.all([
      BinanceService.getKlines(symbol, '1m', Math.min(Math.ceil(windowMs / ONE_MIN_MS) + 5, 1500), market),
      BinanceService.getOpenInterestHist(symbol, '5m', 24).catch(() => []),
      BinanceService.getAggTrades(symbol, 500, market).catch(() => [])
    ]);

    const candles1m = normalizeKlines(hmRaw);
    if (!candles1m.length) {
      return res.json({ success: true, data: _empty('Not enough kline data', { symbol, market, windowMs }) });
    }
    const latest = candles1m[candles1m.length - 1];
    const midPrice = Number(latest.close);
    if (!Number.isFinite(midPrice) || midPrice <= 0) {
      return res.json({ success: true, data: _empty('Invalid midPrice', { symbol, market, midPrice }) });
    }

    // ---- 计算两个主峰（与 routes/predictiveLiquidations 同算法，但只跑一次）----
    const toMs = Date.now();
    const fromMs = toMs - windowMs;
    const priceMin = midPrice * 0.95;
    const priceMax = midPrice * 1.05;
    const priceBucket = Math.max(0.01, midPrice * 0.0002);
    const bucketMs = Math.max(2 * ONE_MIN_MS, Math.floor(windowMs / 120));
    const heat = buildPredictiveLiquidationHeatmap(candles1m, {
      fromMs, toMs, bucketMs, priceMin, priceMax, priceBucket
    });
    const peaks = _findPeaks(heat, midPrice);
    if (!peaks.peakLong && !peaks.peakShort) {
      return res.json({ success: true, data: _empty('No peaks detected', { symbol, market, midPrice }) });
    }

    // ---- 趋势 / CVD / OI / 成交量 指标 ----
    // 价格趋势：最近 30 根 1m K 线的 close 斜率
    const trendWindow = candles1m.slice(-30);
    const priceSlope = _slope(trendWindow.map((c) => Number(c.close)));
    // CVD：最近 500 笔 aggTrades 算累计净额，看最近 N 段斜率
    const cvdMetrics = computeTradeIndicators(trades, market, 50);
    const cvdSeries = cvdMetrics.cvdSeries || [];
    const cvdSlope = cvdSeries.length >= 10
      ? _slope(cvdSeries.slice(-30).map((p) => p.value))
      : 0;
    // CVD 与价格的背离：最近 N min 价涨 但 CVD 跌（或反之）
    const cvdDivergence = (priceSlope > 0 && cvdSlope < 0)
      ? 'bearish' // 价涨 CVD 跌 → 看跌背离（适合做空）
      : (priceSlope < 0 && cvdSlope > 0)
        ? 'bullish' // 价跌 CVD 涨 → 看涨背离（适合做多）
        : 'none';

    // OI 序列（5m × N）→ 算最近 1 个值 vs 过去 1h 均值
    const oiArr = Array.isArray(oiHist) ? oiHist : [];
    const oiValues = oiArr.map((d) => Number(d.sumOpenInterest)).filter(Number.isFinite);
    const oiLatest = oiValues.length ? oiValues[oiValues.length - 1] : null;
    const oiMean1h = oiValues.length >= 12
      ? _mean(oiValues.slice(-12))
      : (oiValues.length ? _mean(oiValues) : null);
    const oiSurge = (oiLatest != null && oiMean1h)
      ? oiLatest / oiMean1h
      : null;

    // 成交量：最近 1 根 1m K 线 vs 过去 60 根均值
    const volLatest = Number(latest.volume);
    const volMean1h = candles1m.length >= 61
      ? _mean(candles1m.slice(-61, -1).map((c) => Number(c.volume)))
      : _mean(candles1m.slice(0, -1).map((c) => Number(c.volume)));
    const volSurge = (volMean1h > 0) ? volLatest / volMean1h : null;

    // 力量对比：peakLong.value vs peakShort.value
    const lv = peaks.peakLong  ? peaks.peakLong.value  : 0;
    const sv = peaks.peakShort ? peaks.peakShort.value : 0;
    const longShortPowerRatio = sv > 0 ? lv / sv : (lv > 0 ? Infinity : 1);
    const shortLongPowerRatio = lv > 0 ? sv / lv : (sv > 0 ? Infinity : 1);

    // 最近 N min 价格区间，用于判断是否"刚穿越"主峰
    const recent10m = candles1m.slice(-Math.max(1, Math.floor(SQUEEZE_LOOKBACK_MS / ONE_MIN_MS)));
    const recent10mHigh = Math.max(...recent10m.map((c) => Number(c.high)));
    const recent10mLow  = Math.min(...recent10m.map((c) => Number(c.low)));
    const recent10mOpen = Number(recent10m[0].open);

    // ---- 信号判定 ----
    const peakLongPrice  = peaks.peakLong  ? peaks.peakLong.price  : null;
    const peakShortPrice = peaks.peakShort ? peaks.peakShort.price : null;
    const distLongPct  = peakLongPrice  ? (midPrice - peakLongPrice)  / midPrice : null;
    const distShortPct = peakShortPrice ? (peakShortPrice - midPrice) / midPrice : null;

    const signals = []; // 候选 [{ signal, confidence, conditions, ... }]

    // ===== REVERSAL_LONG: 价格触碰 L↓（在墙上方，距离很近）+ 多个反转过滤 =====
    if (peakLongPrice && distLongPct != null
        && distLongPct >= 0 && distLongPct <= REVERSAL_DIST_PCT) {
      const cond = {
        nearLongPeak: true,
        cvdBullishDivergence: cvdDivergence === 'bullish',
        oiNotSurging: oiSurge == null || oiSurge < OI_SURGE_MULT,
        shortPowerDominant: shortLongPowerRatio >= POWER_RATIO_THR,
        priceWithinRecentRange: midPrice >= recent10mLow * 0.998
      };
      const conf = _confidenceFromConditions(cond);
      signals.push({
        signal: 'LIQ_REVERSAL_LONG',
        side: 'long',
        confidence: conf,
        conditions: cond,
        triggerPeak: 'long',
        peakPrice: peakLongPrice,
        peakValue: lv,
        playbook: '价格触碰多头清算墙未穿越，等待反弹做多。止损放在墙下方 0.3%。'
      });
    }

    // ===== REVERSAL_SHORT: 价格触碰 S↑（在墙下方，距离很近）+ 反转过滤 =====
    if (peakShortPrice && distShortPct != null
        && distShortPct >= 0 && distShortPct <= REVERSAL_DIST_PCT) {
      const cond = {
        nearShortPeak: true,
        cvdBearishDivergence: cvdDivergence === 'bearish',
        oiNotSurging: oiSurge == null || oiSurge < OI_SURGE_MULT,
        longPowerDominant: longShortPowerRatio >= POWER_RATIO_THR,
        priceWithinRecentRange: midPrice <= recent10mHigh * 1.002
      };
      const conf = _confidenceFromConditions(cond);
      signals.push({
        signal: 'LIQ_REVERSAL_SHORT',
        side: 'short',
        confidence: conf,
        conditions: cond,
        triggerPeak: 'short',
        peakPrice: peakShortPrice,
        peakValue: sv,
        playbook: '价格触碰空头清算墙未穿越，等待回落做空。止损放在墙上方 0.3%。'
      });
    }

    // ===== SQUEEZE_LONG: 价格刚穿过 S↑（recent10m 内）+ OI/Vol 暴涨 =====
    if (peakShortPrice && midPrice > peakShortPrice && recent10mOpen <= peakShortPrice) {
      const cond = {
        crossedShortPeakUp: true,
        oiSurging: oiSurge != null && oiSurge >= OI_SURGE_MULT,
        volSurging: volSurge != null && volSurge >= VOL_SURGE_MULT,
        priceTrendUp: priceSlope > 0,
        cvdTrendUp: cvdSlope > 0
      };
      const conf = _confidenceFromConditions(cond);
      signals.push({
        signal: 'LIQ_SQUEEZE_LONG',
        side: 'long',
        confidence: conf,
        conditions: cond,
        triggerPeak: 'short',
        peakPrice: peakShortPrice,
        peakValue: sv,
        playbook: '价格穿过空头清算墙引发 squeeze，顺势追多。止损放在墙下方 0.5%。'
      });
    }

    // ===== SQUEEZE_SHORT: 价格刚穿过 L↓（recent10m 内）+ 暴涨成交 =====
    if (peakLongPrice && midPrice < peakLongPrice && recent10mOpen >= peakLongPrice) {
      const cond = {
        crossedLongPeakDown: true,
        oiSurging: oiSurge != null && oiSurge >= OI_SURGE_MULT,
        volSurging: volSurge != null && volSurge >= VOL_SURGE_MULT,
        priceTrendDown: priceSlope < 0,
        cvdTrendDown: cvdSlope < 0
      };
      const conf = _confidenceFromConditions(cond);
      signals.push({
        signal: 'LIQ_SQUEEZE_SHORT',
        side: 'short',
        confidence: conf,
        conditions: cond,
        triggerPeak: 'long',
        peakPrice: peakLongPrice,
        peakValue: lv,
        playbook: '价格跌破多头清算墙引发 cascade，顺势追空。止损放在墙上方 0.5%。'
      });
    }

    // 选最高置信度的信号；如果都 < 50 则视为 NONE
    signals.sort((a, b) => b.confidence - a.confidence);
    const best = signals[0];
    const snapshot = {
      symbol, market, windowMs, midPrice,
      peakLong: peaks.peakLong, peakShort: peaks.peakShort,
      distLongPct, distShortPct,
      cvdDivergence, priceSlope, cvdSlope,
      oiLatest, oiMean1h, oiSurge,
      volLatest, volMean1h, volSurge,
      longShortPowerRatio, shortLongPowerRatio,
      recent10mHigh, recent10mLow, recent10mOpen,
      candidates: signals.map((s) => ({ signal: s.signal, confidence: s.confidence }))
    };

    if (!best || best.confidence < 50) {
      return res.json({
        success: true,
        data: _empty(best ? `Best candidate confidence ${best.confidence} < 50` : 'No actionable liq signal',
          snapshot, peaks)
      });
    }

    // ---- 入场 / 止损 / 止盈 ----
    const atrSeries = computeATR(candles1m, 14);
    const lastAtr = atrSeries[atrSeries.length - 1] || atrSeries[atrSeries.length - 2] || (midPrice * 0.001);
    const isReversal = best.signal.startsWith('LIQ_REVERSAL');
    const stopBuffer = isReversal ? best.peakPrice * 0.003 : best.peakPrice * 0.005;
    const entryPrice = midPrice;
    let stopLoss;
    if (best.side === 'long') {
      // 多头止损放在最近主峰价位**下方** stopBuffer
      const peakRef = isReversal ? best.peakPrice : best.peakPrice; // squeeze: peakShort 已被穿越，仍以它为参考
      stopLoss = peakRef - stopBuffer;
      if (stopLoss >= entryPrice) stopLoss = entryPrice - Math.max(stopBuffer, lastAtr);
    } else {
      const peakRef = best.peakPrice;
      stopLoss = peakRef + stopBuffer;
      if (stopLoss <= entryPrice) stopLoss = entryPrice + Math.max(stopBuffer, lastAtr);
    }
    const stopDistance = Math.abs(entryPrice - stopLoss);
    if (stopDistance <= 0) {
      return res.json({
        success: true,
        data: _empty('Invalid stop distance', snapshot, peaks)
      });
    }
    // TP 设计：
    //   REVERSAL：1R / 2R / 3R（反转通常不会走太远）
    //   SQUEEZE：1.5R / 3R / 用对侧主峰做最终目标
    const tpMults = isReversal ? [1, 2, 3] : [1.5, 3, 5];
    const otherPeak = best.side === 'long' ? peakShortPrice : peakLongPrice;
    const tp1 = best.side === 'long' ? entryPrice + stopDistance * tpMults[0] : entryPrice - stopDistance * tpMults[0];
    const tp2 = best.side === 'long' ? entryPrice + stopDistance * tpMults[1] : entryPrice - stopDistance * tpMults[1];
    let tp3 = best.side === 'long' ? entryPrice + stopDistance * tpMults[2] : entryPrice - stopDistance * tpMults[2];
    // squeeze 模式：tp3 用对侧主峰（如果在合理方向上）
    if (!isReversal && otherPeak) {
      if (best.side === 'long' && otherPeak > entryPrice) tp3 = otherPeak;
      if (best.side === 'short' && otherPeak < entryPrice) tp3 = otherPeak;
    }
    const riskAmount = (accountBalance * riskPercent) / 100;
    const positionSize = riskAmount / stopDistance;
    const positionSizeQuote = positionSize * entryPrice;

    const data = {
      signal: best.signal,
      side: best.side,
      confidence: best.confidence,
      playbook: best.playbook,
      entryPrice, stopLoss,
      takeProfits: [
        { price: tp1, closeFraction: 0.5 },
        { price: tp2, closeFraction: 0.3 },
        { price: tp3, closeFraction: 0.2 }
      ],
      positionSize, positionSizeQuote, riskAmount,
      peakLong: peaks.peakLong, peakShort: peaks.peakShort,
      triggerPeak: best.triggerPeak,
      conditions: best.conditions,
      indicatorsSnapshot: snapshot
    };

    // ---- 飞书自动推送（仅当 confidence ≥ 阈值 + 通过冷却）----
    if (feishu.isSignalNotifyEnabled() && data.confidence >= MIN_CONFIDENCE_TO_NOTIFY && req.query.notify !== 'false') {
      const verdict = _shouldNotifyLiq(symbol, market, data.signal);
      if (verdict.ok) {
        _markNotified(verdict.key);
        const card = _buildLiqSignalCard(data);
        feishu.sendCard(card)
          .then((r) => {
            if (r.ok) {
              // eslint-disable-next-line no-console
              console.log(`[liq-signal] pushed ${symbol} ${data.signal} conf=${data.confidence}`);
            } else if (!r.skipped) {
              // eslint-disable-next-line no-console
              console.warn('[liq-signal] feishu push failed:', r.error);
            }
          })
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.error('[liq-signal] feishu push threw:', err.message);
          });
      } else {
        // eslint-disable-next-line no-console
        console.log(`[liq-signal] feishu skip ${symbol} ${data.signal}: ${verdict.reason}`);
      }
    }

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// helpers
// ============================================================================
function _findPeaks(heat, midPrice) {
  const Plen = heat.prices.length;
  const longSum = new Array(Plen).fill(0);
  const shortSum = new Array(Plen).fill(0);
  for (let ti = 0; ti < heat.times.length; ti += 1) {
    const lr = heat.longMatrix[ti], sr = heat.shortMatrix[ti];
    if (!lr || !sr) continue;
    for (let pi = 0; pi < Plen; pi += 1) {
      longSum[pi]  += lr[pi] || 0;
      shortSum[pi] += sr[pi] || 0;
    }
  }
  let longArg = -1, longMax = 0;
  let shortArg = -1, shortMax = 0;
  for (let pi = 0; pi < Plen; pi += 1) {
    const p = heat.prices[pi];
    if (p < midPrice && longSum[pi]  > longMax)  { longMax  = longSum[pi];  longArg  = pi; }
    if (p > midPrice && shortSum[pi] > shortMax) { shortMax = shortSum[pi]; shortArg = pi; }
  }
  return {
    peakLong:  longArg  >= 0 ? { price: heat.prices[longArg],  value: longMax  } : null,
    peakShort: shortArg >= 0 ? { price: heat.prices[shortArg], value: shortMax } : null
  };
}

function _slope(arr) {
  if (!arr || arr.length < 2) return 0;
  // 简单线性回归斜率 (least-squares)
  const n = arr.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i += 1) {
    sx += i; sy += arr[i];
    sxx += i * i; sxy += i * arr[i];
  }
  const denom = n * sxx - sx * sx;
  return denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
}

function _mean(arr) {
  if (!arr || arr.length === 0) return 0;
  let s = 0;
  for (const v of arr) s += Number(v) || 0;
  return s / arr.length;
}

// 触发条件已被 if 守门（conditions 第一项必为 true，是必要条件）。
// 基础分 60；其余 (n-1) 个为加分项，每命中 1 项 +10。
// 4 个加分项满命中 → 60 + 40 = 100。
function _confidenceFromConditions(cond) {
  const vals = Object.values(cond);
  if (vals.length === 0) return 0;
  const totalBonusSlots = vals.length - 1; // 减去必要触发条件
  const trues = vals.filter(Boolean).length;
  const bonusHits = Math.max(0, trues - 1);
  // 平均权重 / Average weight
  const perBonusPoint = totalBonusSlots > 0 ? 40 / totalBonusSlots : 0;
  return Math.round(Math.min(100, 60 + bonusHits * perBonusPoint));
}

function _empty(reason, snapshot, peaks) {
  return {
    signal: 'NONE',
    reason,
    side: null,
    confidence: 0,
    entryPrice: null,
    stopLoss: null,
    takeProfits: null,
    positionSize: null,
    positionSizeQuote: null,
    riskAmount: null,
    peakLong: peaks ? peaks.peakLong : null,
    peakShort: peaks ? peaks.peakShort : null,
    triggerPeak: null,
    conditions: null,
    indicatorsSnapshot: snapshot || null
  };
}

function _buildLiqSignalCard(d) {
  const isLong = d.side === 'long';
  const isReversal = d.signal.startsWith('LIQ_REVERSAL');
  const template = isLong ? 'green' : 'red';
  const sideEmoji = isLong ? '🟢 LONG' : '🔴 SHORT';
  const typeLabel = isReversal
    ? '反转信号 / Reversal'
    : 'Squeeze 顺势 / Squeeze';
  const fmtP = (v) => v == null ? '-' : Number(v).toFixed(Math.abs(Number(v)) >= 1000 ? 2 : 4);
  const fmtMoney = (v) => v >= 1e9 ? (v / 1e9).toFixed(2) + 'B'
    : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M'
    : v >= 1e3 ? (v / 1e3).toFixed(2) + 'K' : Number(v).toFixed(0);
  const sym = (d.indicatorsSnapshot && d.indicatorsSnapshot.symbol) || 'BTCUSDT';
  const lines = [];
  lines.push(`**类型 / Type**: ${typeLabel} · ${sideEmoji}`);
  lines.push(`**置信度 / Confidence**: \`${d.confidence}/100\``);
  lines.push(`**触发墙 / Trigger Wall**: ${d.triggerPeak === 'long' ? 'L↓ 多头清算墙' : 'S↑ 空头清算墙'} @ \`${fmtP(d.peakLong && d.triggerPeak === 'long' ? d.peakLong.price : d.peakShort && d.peakShort.price)}\` (累计 ${fmtMoney(d.indicatorsSnapshot && (d.triggerPeak === 'long' ? (d.peakLong && d.peakLong.value) : (d.peakShort && d.peakShort.value)) || 0)} USDT)`);
  lines.push('---');
  lines.push(`**入场 / Entry**: \`${fmtP(d.entryPrice)}\``);
  lines.push(`**止损 / Stop**: \`${fmtP(d.stopLoss)}\``);
  if (d.takeProfits && d.takeProfits.length) {
    lines.push(`**TP1 (50%)**: \`${fmtP(d.takeProfits[0].price)}\``);
    lines.push(`**TP2 (30%)**: \`${fmtP(d.takeProfits[1].price)}\``);
    lines.push(`**TP3 (20%)**: \`${fmtP(d.takeProfits[2].price)}\``);
  }
  lines.push(`**风险 / Risk**: ${fmtP(d.riskAmount)} USDT · 仓位 ${fmtP(d.positionSize)} (~${fmtP(d.positionSizeQuote)} USDT)`);
  lines.push('---');
  lines.push(`**Playbook**: ${d.playbook}`);
  // 命中条件
  const hits = Object.entries(d.conditions || {}).map(([k, v]) => `${v ? '✅' : '❌'} ${k}`);
  if (hits.length) {
    lines.push(`**命中 / Hit**: ${hits.join(' · ')}`);
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🧲 ${d.signal} · ${sym}` },
      template
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
      {
        tag: 'note',
        elements: [
          { tag: 'lark_md', content: `触发 / Trigger: **liq-signal** · ${new Date().toLocaleString('zh-CN', { hour12: false })}` }
        ]
      }
    ]
  };
}

module.exports = router;
