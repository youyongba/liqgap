'use strict';

/**
 * GET /api/trade/liq-signal
 *
 * "清算磁极"高胜率交易信号 v2 —— 6 类信号：
 *
 *   反转 (REVERSAL · 价触墙未穿)
 *     LIQ_REVERSAL_LONG    现价跌到 L↓ 附近 (≤ 0.3%) + 下影 reject + CVD 背离 → 反转做多
 *     LIQ_REVERSAL_SHORT   现价涨到 S↑ 附近 (≤ 0.3%) + 上影 reject + CVD 背离 → 反转做空
 *
 *   穿越 (SQUEEZE · 顺势追)
 *     LIQ_SQUEEZE_LONG     现价穿过 S↑ + OI/Vol 暴涨 + 同向趋势 → 顺势追多吃 squeeze
 *     LIQ_SQUEEZE_SHORT    现价穿过 L↓ + OI/Vol 暴涨 + 同向趋势 → 顺势追空吃 cascade
 *
 *   穿后回 (SWEEP_REJECT · liquidity sweep · 最高胜率)
 *     LIQ_SWEEP_REJECT_LONG   价格曾跌破 L↓ 但已回升 → 上方流动性已扫，做多
 *     LIQ_SWEEP_REJECT_SHORT  价格曾涨过 S↑ 但已回落 → 下方流动性已扫，做空
 *
 * v2 主要改动：
 *   • 加入"日线 EMA20 趋势对齐"硬过滤（strong-up 时禁用 short 信号、反之亦然）
 *   • REVERSAL 必须出现 K 线 reject 形态（影线 ≥ 实体 50%）
 *   • SQUEEZE 触发改用 sweepMin/sweepMax，避免窗口边界判定漂移
 *   • OI 暴涨阈值 1.5 → 2.5，成交量基准从 1h 改为 24h 5m 聚合
 *   • 加权置信度：CVD ×3 / OI ×2 / Vol ×2 / power ×2 / KlineReject ×2 / daily ×2 / 其他 ×1
 *   • 止损改用 max(peak_buffer, k×ATR)，避免被插针扫止损
 *   • 新增 SWEEP_REJECT 两类（理论胜率最高的 setup）
 *
 * 查询参数：
 *   symbol           默认 'BTCUSDT'
 *   market           固定 'futures'
 *   windowMs         主峰窗口，默认 24h；范围 [15m, 31d]（与前端"清算热图"一致）
 *   priceRange       价格范围 'auto' 或 0~0.5（与前端"清算热图"一致；默认 auto）
 *   sourceInterval   K 线粒度（可选；默认按 windowMs 自适应）
 *   bucketMs         时间桶大小（可选；默认按 windowMs 自适应）
 *   riskPercent      默认 1
 *   accountBalance   默认 1000 USDT
 *   notify           'false' 关闭本次飞书推送
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
const autoTrade = require('../services/autoTrade');

const router = express.Router();

const ONE_MIN_MS = 60_000;
const ONE_HOUR_MS = 3600_000;

// ============================================================================
// 可调参数（env 覆盖）
// ============================================================================
const REVERSAL_DIST_PCT = Number(process.env.LIQ_SIGNAL_REVERSAL_DIST_PCT) || 0.003; // 0.3%
const SQUEEZE_LOOKBACK_MS = Number(process.env.LIQ_SIGNAL_SQUEEZE_LOOKBACK_MS) || 10 * ONE_MIN_MS;
const SWEEP_REJECT_LOOKBACK_MS = Number(process.env.LIQ_SIGNAL_SWEEP_REJECT_LOOKBACK_MS) || 30 * ONE_MIN_MS;
const SWEEP_PIERCE_MIN_PCT = Number(process.env.LIQ_SIGNAL_SWEEP_PIERCE_MIN_PCT) || 0.0005; // 0.05%
const OI_SURGE_MULT = Number(process.env.LIQ_SIGNAL_OI_SURGE_MULT) || 2.5;
const OI_HOLD_MULT = Number(process.env.LIQ_SIGNAL_OI_HOLD_MULT) || 1.2;
const VOL_SURGE_MULT = Number(process.env.LIQ_SIGNAL_VOL_SURGE_MULT) || 3.0;
const POWER_RATIO_THR = Number(process.env.LIQ_SIGNAL_POWER_RATIO) || 1.5;
const COOLDOWN_MS = Number(process.env.LIQ_SIGNAL_COOLDOWN_MS) || 30 * ONE_MIN_MS;
const MIN_CONFIDENCE_TO_NOTIFY = Number(process.env.LIQ_SIGNAL_MIN_CONFIDENCE) || 75;
// 日线 EMA20 偏离 ≥ ±2% 算"强趋势"；逆强趋势直接拒绝（除非显式关闭）
const DAILY_EMA_PERIOD = Number(process.env.LIQ_SIGNAL_DAILY_EMA_PERIOD) || 20;
const DAILY_STRONG_DEV_PCT = Number(process.env.LIQ_SIGNAL_DAILY_STRONG_DEV_PCT) || 0.02;
const DAILY_TREND_REQUIRED = String(process.env.LIQ_SIGNAL_DAILY_TREND_REQUIRED || 'true').toLowerCase() !== 'false';
// ATR 倍数：reversal 用 1×ATR，squeeze 用 1.5×ATR，sweep_reject 用 0.7×ATR（用 sweep 极值定位本就更精确）
const ATR_MULT_REVERSAL = Number(process.env.LIQ_SIGNAL_ATR_MULT_REVERSAL) || 1.0;
const ATR_MULT_SQUEEZE  = Number(process.env.LIQ_SIGNAL_ATR_MULT_SQUEEZE)  || 1.5;
const ATR_MULT_SWEEP    = Number(process.env.LIQ_SIGNAL_ATR_MULT_SWEEP)    || 0.7;

// ============================================================================
// 飞书去重（按 symbol + signalType）
// ============================================================================
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

// ============================================================================
// 主路由
// ============================================================================
router.get('/trade/liq-signal', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || 'BTCUSDT').toUpperCase();
    const market = 'futures';
    let windowMs = Number(req.query.windowMs);
    if (!Number.isFinite(windowMs) || windowMs < 15 * ONE_MIN_MS) windowMs = 24 * ONE_HOUR_MS;
    if (windowMs > 31 * 24 * ONE_HOUR_MS) windowMs = 31 * 24 * ONE_HOUR_MS;
    const riskPercent = Number(req.query.riskPercent) || 1;
    const accountBalance = Number(req.query.accountBalance) || 1000;

    // ---- 主峰采样策略 ----
    const auto = _autoSampling(windowMs);
    const sourceInterval = String(req.query.sourceInterval || auto.source);
    let bucketMs = Number(req.query.bucketMs);
    if (!Number.isFinite(bucketMs) || bucketMs < ONE_MIN_MS) bucketMs = auto.bucketMs;
    if (bucketMs > 12 * ONE_HOUR_MS) bucketMs = 12 * ONE_HOUR_MS;
    const sourceMs = ({
      '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
      '30m': 1800_000, '1h': 3600_000, '2h': 7200_000, '4h': 14400_000
    })[sourceInterval] || 60_000;
    const hmLimit = Math.min(Math.ceil(windowMs / sourceMs) + 5, 1500);

    // ---- 数据源（并行拉取）----
    //   • hmKlines:    主峰窗口 K 线 (sourceInterval × hmLimit)
    //   • trendKlines: 1m × 60 = 最近 1h 近场，用于趋势 / reject 形态
    //   • vol5m:       5m × 288 = 24h 成交量基准
    //   • dailyKlines: 1d × 60 = 日线 EMA20 趋势框架
    //   • oiHist:      5m × 24 = 最近 2h OI 历史
    //   • trades:      500 笔最新成交，实时 CVD
    const [hmRaw, trendRaw, vol5mRaw, dailyRaw, oiHist, trades] = await Promise.all([
      BinanceService.getKlines(symbol, sourceInterval, hmLimit, market),
      BinanceService.getKlines(symbol, '1m', 60, market),
      BinanceService.getKlines(symbol, '5m', 288, market).catch(() => []),
      BinanceService.getKlines(symbol, '1d', 60, market).catch(() => []),
      BinanceService.getOpenInterestHist(symbol, '5m', 24).catch(() => []),
      BinanceService.getAggTrades(symbol, 500, market).catch(() => [])
    ]);

    const toMs = Date.now();
    const fromMs = toMs - windowMs;
    const hmCandles = normalizeKlines(hmRaw).filter((c) => c.openTime >= fromMs - sourceMs);
    const candles1m = normalizeKlines(trendRaw);
    const candles5m = Array.isArray(vol5mRaw) && vol5mRaw.length ? normalizeKlines(vol5mRaw) : [];
    const candlesDaily = Array.isArray(dailyRaw) && dailyRaw.length ? normalizeKlines(dailyRaw) : [];

    if (!candles1m.length) {
      return res.json({ success: true, data: _empty('Not enough kline data', { symbol, market, windowMs }) });
    }
    const latest = candles1m[candles1m.length - 1];
    const midPrice = Number(latest.close);
    if (!Number.isFinite(midPrice) || midPrice <= 0) {
      return res.json({ success: true, data: _empty('Invalid midPrice', { symbol, market, midPrice }) });
    }
    if (!hmCandles.length) {
      return res.json({ success: true, data: _empty('Not enough heatmap kline data', { symbol, market, windowMs, sourceInterval }) });
    }

    // ---- 计算两条主峰横线 ----
    const priceRangeRaw = req.query.priceRange;
    let priceRange = NaN;
    let autoRange = false;
    if (priceRangeRaw === undefined || priceRangeRaw === '' || priceRangeRaw === 'auto') {
      autoRange = true;
    } else {
      priceRange = Number(priceRangeRaw);
      if (!Number.isFinite(priceRange) || priceRange <= 0) autoRange = true;
      else if (priceRange > 0.5) priceRange = 0.5;
    }
    let priceMin, priceMax;
    if (autoRange) {
      let lo = Infinity, hi = -Infinity;
      for (const c of hmCandles) {
        if (c.low < lo) lo = c.low;
        if (c.high > hi) hi = c.high;
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
        priceRange = 0.05;
        const half = midPrice * priceRange;
        priceMin = midPrice - half; priceMax = midPrice + half;
      } else {
        const pad = (hi - lo) * 0.3 + midPrice * 0.005;
        const half = Math.max(midPrice - lo, hi - midPrice) + pad;
        priceMin = midPrice - half; priceMax = midPrice + half;
        priceRange = half / midPrice;
      }
    } else {
      const half = midPrice * priceRange;
      priceMin = midPrice - half; priceMax = midPrice + half;
    }
    const rawBucket = (priceMax - priceMin) / 240;
    const exp = Math.pow(10, Math.floor(Math.log10(rawBucket)));
    const norm = rawBucket / exp;
    const factor = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
    const priceBucket = Math.max(0.01, factor * exp);

    const heat = buildPredictiveLiquidationHeatmap(hmCandles, {
      fromMs, toMs, bucketMs, priceMin, priceMax, priceBucket
    });
    const peaks = _findPeaks(heat, midPrice);
    if (!peaks.peakLong && !peaks.peakShort) {
      return res.json({ success: true, data: _empty('No peaks detected', { symbol, market, midPrice, windowMs, sourceInterval }) });
    }

    // ---- 日线 EMA20 趋势框架 ----
    const dailyTrend = _dailyTrend(candlesDaily, DAILY_EMA_PERIOD, DAILY_STRONG_DEV_PCT);

    // ---- 趋势 / CVD / OI / 成交量 指标 ----
    const trendWindow = candles1m.slice(-30);
    const priceSlope = _slope(trendWindow.map((c) => Number(c.close)));
    const cvdMetrics = computeTradeIndicators(trades, market, 50);
    const cvdSeries = cvdMetrics.cvdSeries || [];
    const cvdSlope = cvdSeries.length >= 10
      ? _slope(cvdSeries.slice(-30).map((p) => p.value))
      : 0;
    const cvdDivergence = (priceSlope > 0 && cvdSlope < 0) ? 'bearish'
      : (priceSlope < 0 && cvdSlope > 0) ? 'bullish'
        : 'none';

    const oiArr = Array.isArray(oiHist) ? oiHist : [];
    const oiValues = oiArr.map((d) => Number(d.sumOpenInterest)).filter(Number.isFinite);
    const oiLatest = oiValues.length ? oiValues[oiValues.length - 1] : null;
    const oiMean1h = oiValues.length >= 12
      ? _mean(oiValues.slice(-12))
      : (oiValues.length ? _mean(oiValues) : null);
    const oiSurge = (oiLatest != null && oiMean1h) ? oiLatest / oiMean1h : null;

    // 成交量基准：24h 5m 聚合 → 单位 1m 的均值（避免亚洲深夜均值过低误触发）
    const vol24hPerMinute = candles5m.length >= 12
      ? _mean(candles5m.map((c) => Number(c.volume) / 5))
      : (candles1m.length >= 30 ? _mean(candles1m.slice(-60, -1).map((c) => Number(c.volume))) : 0);
    const volLatest = Number(latest.volume);
    const volSurge = vol24hPerMinute > 0 ? volLatest / vol24hPerMinute : null;

    // 力量对比
    const lv = peaks.peakLong  ? peaks.peakLong.value  : 0;
    const sv = peaks.peakShort ? peaks.peakShort.value : 0;
    const longShortPowerRatio = sv > 0 ? lv / sv : (lv > 0 ? Infinity : 1);
    const shortLongPowerRatio = lv > 0 ? sv / lv : (sv > 0 ? Infinity : 1);

    // 多窗口高低点
    const recent10mCount = Math.max(1, Math.floor(SQUEEZE_LOOKBACK_MS / ONE_MIN_MS));
    const recent10m = candles1m.slice(-recent10mCount);
    const recent10mHigh = Math.max(...recent10m.map((c) => Number(c.high)));
    const recent10mLow  = Math.min(...recent10m.map((c) => Number(c.low)));
    const sweep30mCount = Math.max(1, Math.floor(SWEEP_REJECT_LOOKBACK_MS / ONE_MIN_MS));
    const sweep30m = candles1m.slice(-Math.min(sweep30mCount, candles1m.length));
    const sweep30mHigh = Math.max(...sweep30m.map((c) => Number(c.high)));
    const sweep30mLow  = Math.min(...sweep30m.map((c) => Number(c.low)));

    // ---- 主峰价位 + 距离 ----
    const peakLongPrice  = peaks.peakLong  ? peaks.peakLong.price  : null;
    const peakShortPrice = peaks.peakShort ? peaks.peakShort.price : null;
    const distLongPct  = peakLongPrice  ? (midPrice - peakLongPrice)  / midPrice : null;
    const distShortPct = peakShortPrice ? (peakShortPrice - midPrice) / midPrice : null;

    // ---- K 线 reject 形态（最近 3 根 1m）----
    const recent3 = candles1m.slice(-3);
    const longRejectShape  = peakLongPrice  ? _hasLongRejectShape(recent3, peakLongPrice) : false;
    const shortRejectShape = peakShortPrice ? _hasShortRejectShape(recent3, peakShortPrice) : false;

    // ---- 信号判定 ----
    const signals = []; // 每条 { signal, side, conditions, ... }

    // ===== REVERSAL_LONG =====
    if (peakLongPrice && distLongPct != null && distLongPct >= 0 && distLongPct <= REVERSAL_DIST_PCT) {
      const conds = [
        { key: 'nearLongPeak',           value: true,                                     required: true,  weight: 0 },
        { key: 'klineRejectShape',       value: longRejectShape,                          weight: 2 },
        { key: 'cvdBullishDivergence',   value: cvdDivergence === 'bullish',              weight: 3 },
        { key: 'oiNotSurging',           value: oiSurge == null || oiSurge < OI_SURGE_MULT, weight: 2 },
        { key: 'shortPowerDominant',     value: shortLongPowerRatio >= POWER_RATIO_THR,   weight: 2 },
        { key: 'dailyTrendNotShort',     value: dailyTrend !== 'strong-down',             weight: 2 },
        { key: 'priceWithinRecentRange', value: midPrice >= recent10mLow * 0.998,         weight: 1 }
      ];
      // 日线硬过滤：strong-down 时禁用 long
      const passedDaily = !DAILY_TREND_REQUIRED || dailyTrend !== 'strong-down';
      if (passedDaily) {
        signals.push(_buildSignal('LIQ_REVERSAL_LONG', 'long', 'long', peakLongPrice, lv, conds,
          '价格触碰多头清算墙未穿越，等待反弹做多。止损放在墙下方 max(0.3%, 1×ATR)。'));
      }
    }

    // ===== REVERSAL_SHORT =====
    if (peakShortPrice && distShortPct != null && distShortPct >= 0 && distShortPct <= REVERSAL_DIST_PCT) {
      const conds = [
        { key: 'nearShortPeak',          value: true,                                     required: true,  weight: 0 },
        { key: 'klineRejectShape',       value: shortRejectShape,                         weight: 2 },
        { key: 'cvdBearishDivergence',   value: cvdDivergence === 'bearish',              weight: 3 },
        { key: 'oiNotSurging',           value: oiSurge == null || oiSurge < OI_SURGE_MULT, weight: 2 },
        { key: 'longPowerDominant',      value: longShortPowerRatio >= POWER_RATIO_THR,   weight: 2 },
        { key: 'dailyTrendNotLong',      value: dailyTrend !== 'strong-up',               weight: 2 },
        { key: 'priceWithinRecentRange', value: midPrice <= recent10mHigh * 1.002,        weight: 1 }
      ];
      const passedDaily = !DAILY_TREND_REQUIRED || dailyTrend !== 'strong-up';
      if (passedDaily) {
        signals.push(_buildSignal('LIQ_REVERSAL_SHORT', 'short', 'short', peakShortPrice, sv, conds,
          '价格触碰空头清算墙未穿越，等待回落做空。止损放在墙上方 max(0.3%, 1×ATR)。'));
      }
    }

    // ===== SQUEEZE_LONG =====（用 sweepMin 代替 recent10mOpen，避免边界误判）
    if (peakShortPrice && midPrice > peakShortPrice && recent10mLow <= peakShortPrice) {
      const conds = [
        { key: 'justCrossedShortPeakUp', value: true,                                     required: true,  weight: 0 },
        { key: 'oiSurging',              value: oiSurge != null && oiSurge >= OI_SURGE_MULT, weight: 2 },
        { key: 'volSurging24h',          value: volSurge != null && volSurge >= VOL_SURGE_MULT, weight: 2 },
        { key: 'cvdTrendUp',             value: cvdSlope > 0,                             weight: 3 },
        { key: 'priceTrendUp',           value: priceSlope > 0,                           weight: 1 },
        { key: 'dailyTrendUp',           value: dailyTrend === 'up' || dailyTrend === 'strong-up', weight: 2 }
      ];
      // SQUEEZE 强约束：日线方向必须同向（顺势追单）
      const passedDaily = !DAILY_TREND_REQUIRED
        || dailyTrend === 'up' || dailyTrend === 'strong-up' || dailyTrend === 'unknown';
      if (passedDaily) {
        signals.push(_buildSignal('LIQ_SQUEEZE_LONG', 'long', 'short', peakShortPrice, sv, conds,
          '价格穿过空头清算墙引发 squeeze，顺势追多。止损放在墙下方 max(0.5%, 1.5×ATR)。'));
      }
    }

    // ===== SQUEEZE_SHORT =====
    if (peakLongPrice && midPrice < peakLongPrice && recent10mHigh >= peakLongPrice) {
      const conds = [
        { key: 'justCrossedLongPeakDown', value: true,                                    required: true,  weight: 0 },
        { key: 'oiSurging',               value: oiSurge != null && oiSurge >= OI_SURGE_MULT, weight: 2 },
        { key: 'volSurging24h',           value: volSurge != null && volSurge >= VOL_SURGE_MULT, weight: 2 },
        { key: 'cvdTrendDown',            value: cvdSlope < 0,                            weight: 3 },
        { key: 'priceTrendDown',          value: priceSlope < 0,                          weight: 1 },
        { key: 'dailyTrendDown',          value: dailyTrend === 'down' || dailyTrend === 'strong-down', weight: 2 }
      ];
      const passedDaily = !DAILY_TREND_REQUIRED
        || dailyTrend === 'down' || dailyTrend === 'strong-down' || dailyTrend === 'unknown';
      if (passedDaily) {
        signals.push(_buildSignal('LIQ_SQUEEZE_SHORT', 'short', 'long', peakLongPrice, lv, conds,
          '价格跌破多头清算墙引发 cascade，顺势追空。止损放在墙上方 max(0.5%, 1.5×ATR)。'));
      }
    }

    // ===== SWEEP_REJECT_SHORT =====（最近 30min 内穿过 S↑ 但已回到墙下方）
    if (peakShortPrice
        && sweep30mHigh > peakShortPrice * (1 + SWEEP_PIERCE_MIN_PCT)
        && midPrice < peakShortPrice * (1 - SWEEP_PIERCE_MIN_PCT)) {
      const conds = [
        { key: 'sweptShortPeakAndReturned', value: true,                                  required: true,  weight: 0 },
        { key: 'closedBelowPeak',           value: midPrice < peakShortPrice * 0.998,     weight: 2 },
        { key: 'cvdBearishDuringSweep',     value: cvdSlope < 0 || cvdDivergence === 'bearish', weight: 3 },
        { key: 'oiHoldingHigh',             value: oiSurge != null && oiSurge >= OI_HOLD_MULT, weight: 2 },
        { key: 'longPowerStillDominant',    value: longShortPowerRatio >= POWER_RATIO_THR, weight: 2 },
        { key: 'dailyTrendNotLong',         value: dailyTrend !== 'strong-up',            weight: 2 }
      ];
      const passedDaily = !DAILY_TREND_REQUIRED || dailyTrend !== 'strong-up';
      if (passedDaily) {
        const sig = _buildSignal('LIQ_SWEEP_REJECT_SHORT', 'short', 'short', peakShortPrice, sv, conds,
          '上插钉子针穿越 S↑ 后跌回，多头力竭。空单入场，止损放在最近 sweep 高点上方 max(0.3%, 0.7×ATR)。');
        sig.sweepExtreme = sweep30mHigh; // 用作止损参考
        signals.push(sig);
      }
    }

    // ===== SWEEP_REJECT_LONG =====（最近 30min 内跌破 L↓ 但已回到墙上方）
    if (peakLongPrice
        && sweep30mLow < peakLongPrice * (1 - SWEEP_PIERCE_MIN_PCT)
        && midPrice > peakLongPrice * (1 + SWEEP_PIERCE_MIN_PCT)) {
      const conds = [
        { key: 'sweptLongPeakAndReturned',  value: true,                                  required: true,  weight: 0 },
        { key: 'closedAbovePeak',           value: midPrice > peakLongPrice * 1.002,      weight: 2 },
        { key: 'cvdBullishDuringSweep',     value: cvdSlope > 0 || cvdDivergence === 'bullish', weight: 3 },
        { key: 'oiHoldingHigh',             value: oiSurge != null && oiSurge >= OI_HOLD_MULT, weight: 2 },
        { key: 'shortPowerStillDominant',   value: shortLongPowerRatio >= POWER_RATIO_THR, weight: 2 },
        { key: 'dailyTrendNotShort',        value: dailyTrend !== 'strong-down',          weight: 2 }
      ];
      const passedDaily = !DAILY_TREND_REQUIRED || dailyTrend !== 'strong-down';
      if (passedDaily) {
        const sig = _buildSignal('LIQ_SWEEP_REJECT_LONG', 'long', 'long', peakLongPrice, lv, conds,
          '价格下插针穿越 L↓ 后涨回，空头力竭。多单入场，止损放在最近 sweep 低点下方 max(0.3%, 0.7×ATR)。');
        sig.sweepExtreme = sweep30mLow;
        signals.push(sig);
      }
    }

    // ---- 选最高置信度 ----
    signals.sort((a, b) => b.confidence - a.confidence);
    const best = signals[0];
    const snapshot = {
      symbol, market, windowMs, midPrice,
      sourceInterval, bucketMs,
      priceRange, autoRange, priceMin, priceMax, priceBucket,
      peakLong: peaks.peakLong, peakShort: peaks.peakShort,
      distLongPct, distShortPct,
      cvdDivergence, priceSlope, cvdSlope,
      oiLatest, oiMean1h, oiSurge,
      volLatest, vol24hPerMinute, volSurge,
      longShortPowerRatio, shortLongPowerRatio,
      recent10mHigh, recent10mLow, sweep30mHigh, sweep30mLow,
      dailyTrend, dailyTrendRequired: DAILY_TREND_REQUIRED,
      longRejectShape, shortRejectShape,
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
    const isSqueeze  = best.signal.startsWith('LIQ_SQUEEZE');
    const isSweep    = best.signal.startsWith('LIQ_SWEEP_REJECT');

    // ATR 倍数 + 最小 buffer
    const atrMult = isReversal ? ATR_MULT_REVERSAL : isSqueeze ? ATR_MULT_SQUEEZE : ATR_MULT_SWEEP;
    const minBufferPct = isReversal ? 0.003 : isSqueeze ? 0.005 : 0.003;
    const stopBuffer = Math.max(best.peakPrice * minBufferPct, lastAtr * atrMult);
    const entryPrice = midPrice;

    let stopLoss;
    if (isSweep) {
      // SWEEP_REJECT 用 sweep 极值（钉子针顶/底）做更精确的止损参考
      const ext = best.sweepExtreme || best.peakPrice;
      stopLoss = best.side === 'long'
        ? Math.min(ext - stopBuffer, entryPrice - lastAtr * 0.5)
        : Math.max(ext + stopBuffer, entryPrice + lastAtr * 0.5);
    } else {
      stopLoss = best.side === 'long'
        ? best.peakPrice - stopBuffer
        : best.peakPrice + stopBuffer;
    }
    // 兜底：止损必须在入场不利方向
    if (best.side === 'long' && stopLoss >= entryPrice) stopLoss = entryPrice - Math.max(stopBuffer, lastAtr);
    if (best.side === 'short' && stopLoss <= entryPrice) stopLoss = entryPrice + Math.max(stopBuffer, lastAtr);

    const stopDistance = Math.abs(entryPrice - stopLoss);
    if (stopDistance <= 0) {
      return res.json({ success: true, data: _empty('Invalid stop distance', snapshot, peaks) });
    }

    // TP 倍数：reversal 1/2/3 R；squeeze 1.5/3/5 R；sweep_reject 1.5/3/4 R + 对侧主峰兜底
    const tpMults = isReversal ? [1, 2, 3]
      : isSqueeze ? [1.5, 3, 5]
        : [1.5, 3, 4];
    const otherPeak = best.side === 'long' ? peakShortPrice : peakLongPrice;
    const tp1 = best.side === 'long' ? entryPrice + stopDistance * tpMults[0] : entryPrice - stopDistance * tpMults[0];
    const tp2 = best.side === 'long' ? entryPrice + stopDistance * tpMults[1] : entryPrice - stopDistance * tpMults[1];
    let tp3 = best.side === 'long' ? entryPrice + stopDistance * tpMults[2] : entryPrice - stopDistance * tpMults[2];
    if ((isSqueeze || isSweep) && otherPeak) {
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
      conditions: _condsToObject(best.conditions),
      sweepExtreme: best.sweepExtreme || null,
      indicatorsSnapshot: snapshot
    };

    // ---- 自动交易 webhook（仅 LIQ_REVERSAL_* + 高置信度，由 services/autoTrade 内部白名单/冷却把关）----
    // fire-and-forget：不阻塞响应；失败只记录日志和 ring buffer。
    if (req.query.notify !== 'false' && req.query.autoTrade !== 'false') {
      autoTrade.sendPendingOrder({
        signal: data.signal,
        direction: data.side,
        confidence: data.confidence,
        symbol,
        extra: {
          entryPrice: data.entryPrice,
          stopLoss: data.stopLoss,
          takeProfits: data.takeProfits,
          peakPrice: best.peakPrice,
          windowMs,
          sourceInterval
        }
      })
        .then((r) => {
          if (r.ok) {
            // eslint-disable-next-line no-console
            console.log(`[auto-trade] sent ${symbol} ${data.signal} ${data.side} (HTTP ${r.status})`);
          } else if (!r.skipped) {
            // eslint-disable-next-line no-console
            console.warn(`[auto-trade] ${symbol} ${data.signal} not sent: ${r.error}`);
          } else if (process.env.AUTO_TRADE_DEBUG === 'true') {
            // eslint-disable-next-line no-console
            console.log(`[auto-trade] skipped ${symbol} ${data.signal}: ${r.reason}`);
          }
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.error('[auto-trade] threw:', err && err.message);
        });
    }

    // ---- 飞书推送（≥ 75 + 通过冷却）----
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
function _autoSampling(windowMs) {
  if (windowMs <=       ONE_HOUR_MS) return { source: '1m',  bucketMs:        60_000 };
  if (windowMs <=   4 * ONE_HOUR_MS) return { source: '1m',  bucketMs:   2  * 60_000 };
  if (windowMs <=  12 * ONE_HOUR_MS) return { source: '5m',  bucketMs:   5  * 60_000 };
  if (windowMs <=  24 * ONE_HOUR_MS) return { source: '5m',  bucketMs:  15  * 60_000 };
  if (windowMs <=  48 * ONE_HOUR_MS) return { source: '5m',  bucketMs:  30  * 60_000 };
  if (windowMs <=  72 * ONE_HOUR_MS) return { source: '15m', bucketMs:  60  * 60_000 };
  if (windowMs <=   7 * 24 * ONE_HOUR_MS) return { source: '15m', bucketMs:   2 * 60 * 60_000 };
  if (windowMs <=  14 * 24 * ONE_HOUR_MS) return { source: '30m', bucketMs:   4 * 60 * 60_000 };
  if (windowMs <=  21 * 24 * ONE_HOUR_MS) return { source: '1h',  bucketMs:   6 * 60 * 60_000 };
  return                                          { source: '1h',  bucketMs:   8 * 60 * 60_000 };
}

// 主峰检测：row-max 策略 —— 每个价位的"最强单格"作为代表强度，取 argmax。
// 与前端 _draw() 中主峰选择算法一致，保证：
//   • 信号 conditions 里的 peakLong/peakShort 价位 = 图上视觉最亮的横线
//   • 飞书卡片的"触发墙"价位 = 用户在热图上看到的标注一致
// row-sum (旧策略) 会被"持续亮但每格不亮"的横线带偏，跟视觉/tooltip 不符。
function _findPeaks(heat, midPrice) {
  const Plen = heat.prices.length;
  const longMaxRow  = new Array(Plen).fill(0);
  const shortMaxRow = new Array(Plen).fill(0);
  for (let ti = 0; ti < heat.times.length; ti += 1) {
    const lr = heat.longMatrix[ti], sr = heat.shortMatrix[ti];
    if (!lr || !sr) continue;
    for (let pi = 0; pi < Plen; pi += 1) {
      const lv = lr[pi] || 0;
      const sv = sr[pi] || 0;
      if (lv > longMaxRow[pi])  longMaxRow[pi]  = lv;
      if (sv > shortMaxRow[pi]) shortMaxRow[pi] = sv;
    }
  }
  let longArg = -1, longMax = 0;
  let shortArg = -1, shortMax = 0;
  for (let pi = 0; pi < Plen; pi += 1) {
    const p = heat.prices[pi];
    if (p < midPrice && longMaxRow[pi]  > longMax)  { longMax  = longMaxRow[pi];  longArg  = pi; }
    if (p > midPrice && shortMaxRow[pi] > shortMax) { shortMax = shortMaxRow[pi]; shortArg = pi; }
  }
  return {
    peakLong:  longArg  >= 0 ? { price: heat.prices[longArg],  value: longMax  } : null,
    peakShort: shortArg >= 0 ? { price: heat.prices[shortArg], value: shortMax } : null
  };
}

function _slope(arr) {
  if (!arr || arr.length < 2) return 0;
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

// EMA 序列
function _ema(arr, period) {
  if (!arr.length) return [];
  const k = 2 / (period + 1);
  const out = [arr[0]];
  let ema = arr[0];
  for (let i = 1; i < arr.length; i += 1) {
    ema = arr[i] * k + ema * (1 - k);
    out.push(ema);
  }
  return out;
}

// 日线趋势：返回 'strong-up' / 'up' / 'down' / 'strong-down' / 'unknown'
//   close vs EMA20 偏离 ≥ ±strongDevPct 算"强趋势"
function _dailyTrend(daily, period, strongDevPct) {
  if (!Array.isArray(daily) || daily.length < period) return 'unknown';
  const closes = daily.map((c) => Number(c.close)).filter(Number.isFinite);
  if (closes.length < period) return 'unknown';
  const ema = _ema(closes, period);
  const lastClose = closes[closes.length - 1];
  const lastEma = ema[ema.length - 1];
  if (!Number.isFinite(lastEma) || lastEma <= 0) return 'unknown';
  const dev = (lastClose - lastEma) / lastEma;
  if (dev >  strongDevPct) return 'strong-up';
  if (dev > 0)             return 'up';
  if (dev < -strongDevPct) return 'strong-down';
  return 'down';
}

// 多头反转 reject 形态：最近 3 根中至少有一根，最低价 ≤ peak × 1.001 且收盘 > 该 K 的 (high+low)/2，
// 且下影线长度 ≥ 实体长度 × 0.8（下影 reject 钉子针）
function _hasLongRejectShape(candles, peakPrice) {
  for (const c of candles) {
    const o = Number(c.open), h = Number(c.high), l = Number(c.low), cl = Number(c.close);
    if (!Number.isFinite(l) || !Number.isFinite(cl)) continue;
    const touchedPeak = l <= peakPrice * 1.001;
    if (!touchedPeak) continue;
    const body = Math.abs(cl - o);
    const lowerWick = Math.min(o, cl) - l;
    if (lowerWick >= body * 0.8 && cl > l + (h - l) * 0.5) return true;
  }
  return false;
}

// 空头反转 reject 形态：最近 3 根中至少有一根，最高价 ≥ peak × 0.999 且收盘 < 该 K 的 (high+low)/2，
// 且上影线长度 ≥ 实体长度 × 0.8（上影 reject 钉子针）
function _hasShortRejectShape(candles, peakPrice) {
  for (const c of candles) {
    const o = Number(c.open), h = Number(c.high), l = Number(c.low), cl = Number(c.close);
    if (!Number.isFinite(h) || !Number.isFinite(cl)) continue;
    const touchedPeak = h >= peakPrice * 0.999;
    if (!touchedPeak) continue;
    const body = Math.abs(cl - o);
    const upperWick = h - Math.max(o, cl);
    if (upperWick >= body * 0.8 && cl < l + (h - l) * 0.5) return true;
  }
  return false;
}

// 加权置信度：
//   必要条件全满足 → 基础 50 分
//   加分项按 weight 累计：hitWeight / totalWeight × 50
//   最终 0~100，1 个必要条件不满足直接 0
function _confidenceWeighted(conds) {
  let totalW = 0, hitW = 0, requiredOk = true;
  for (const c of conds) {
    if (c.required) {
      if (!c.value) requiredOk = false;
      continue;
    }
    const w = Number(c.weight) || 0;
    if (w <= 0) continue;
    totalW += w;
    if (c.value) hitW += w;
  }
  if (!requiredOk) return 0;
  if (totalW <= 0) return 50;
  return Math.round(50 + 50 * (hitW / totalW));
}

function _condsToObject(conds) {
  const out = {};
  for (const c of conds) {
    out[c.key] = !!c.value;
  }
  return out;
}

function _buildSignal(name, side, triggerPeak, peakPrice, peakValue, conds, playbook) {
  return {
    signal: name,
    side,
    triggerPeak,
    peakPrice,
    peakValue,
    confidence: _confidenceWeighted(conds),
    conditions: conds,
    playbook
  };
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
    sweepExtreme: null,
    indicatorsSnapshot: snapshot || null
  };
}

const SIGNAL_TYPE_LABEL = {
  LIQ_REVERSAL_LONG:    '反转 / Reversal',
  LIQ_REVERSAL_SHORT:   '反转 / Reversal',
  LIQ_SQUEEZE_LONG:     'Squeeze 顺势',
  LIQ_SQUEEZE_SHORT:    'Squeeze 顺势',
  LIQ_SWEEP_REJECT_LONG:  'Sweep Reject 流动性扫荡',
  LIQ_SWEEP_REJECT_SHORT: 'Sweep Reject 流动性扫荡'
};

function _buildLiqSignalCard(d) {
  const isLong = d.side === 'long';
  const template = isLong ? 'green' : 'red';
  const sideEmoji = isLong ? '🟢 LONG' : '🔴 SHORT';
  const typeLabel = SIGNAL_TYPE_LABEL[d.signal] || d.signal;
  const fmtP = (v) => v == null ? '-' : Number(v).toFixed(Math.abs(Number(v)) >= 1000 ? 2 : 4);
  const fmtMoney = (v) => v >= 1e9 ? (v / 1e9).toFixed(2) + 'B'
    : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M'
    : v >= 1e3 ? (v / 1e3).toFixed(2) + 'K' : Number(v).toFixed(0);
  const sym = (d.indicatorsSnapshot && d.indicatorsSnapshot.symbol) || 'BTCUSDT';
  const triggerPeakObj = d.triggerPeak === 'long' ? d.peakLong : d.peakShort;
  const peakLabel = d.triggerPeak === 'long' ? 'L↓ 多头清算墙' : 'S↑ 空头清算墙';
  const lines = [];
  lines.push(`**类型 / Type**: ${typeLabel} · ${sideEmoji}`);
  lines.push(`**置信度 / Confidence**: \`${d.confidence}/100\``);
  lines.push(`**触发墙 / Trigger Wall**: ${peakLabel} @ \`${fmtP(triggerPeakObj && triggerPeakObj.price)}\` (累计 ${fmtMoney(triggerPeakObj ? triggerPeakObj.value : 0)} USDT)`);
  if (d.sweepExtreme != null) {
    lines.push(`**Sweep 极值 / Sweep Extreme**: \`${fmtP(d.sweepExtreme)}\``);
  }
  if (d.indicatorsSnapshot && d.indicatorsSnapshot.dailyTrend) {
    lines.push(`**日线趋势 / Daily Trend**: \`${d.indicatorsSnapshot.dailyTrend}\``);
  }
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
          { tag: 'lark_md', content: `触发 / Trigger: **liq-signal v2** · ${feishu.fmtCnTime()}` }
        ]
      }
    ]
  };
}

module.exports = router;
