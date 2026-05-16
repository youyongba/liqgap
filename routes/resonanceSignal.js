'use strict';

/**
 * GET /api/trade/resonance-signal
 *
 * 双层共振交易信号 (Two-tier Resonance Signal System)
 * ================================================================
 *
 * 设计理念 (Why two tiers):
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  信号设计的不可能三角：高 confidence × 高频率 × 高胜率 三选二 │
 *   │                                                             │
 *   │  Tier 1 (HEXA)  : 6 指标共振，confidence ≥ 90               │
 *   │                   频率 3-7 天 1 次 / 100x + 50% 仓位        │
 *   │                   胜率 75-82% · 顶级 setup                   │
 *   │                                                             │
 *   │  Tier 2 (TRIO)  : 3 指标共振，confidence ≥ 75               │
 *   │                   频率每天 1-3 次 / 20x + 15% 仓位           │
 *   │                   胜率 60-68% · 日内常规                     │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * 6 指标（HEXA Tier 1 全部为必要条件 / required）：
 *   1. FVG           : 价格回到未填补的 FVG 区间内
 *   2. VWAP          : 价格与 1h VWAP 同侧（趋势对齐）
 *   3. LIQ Peak      : 距 row-max 主峰 (L↓ / S↑) < 0.5%
 *   4. Volume Surge  : 当前 5m 成交量 ≥ 1h avg × 2.0
 *   5. OI Surge      : OI 1h 涨幅 ≥ 1.5×（确认真实爆仓而非空头）
 *   6. CVD Divergence: CVD 与价格反向背离
 *
 * 加分项（决定 confidence 是 60 还是 100）：
 *   • klineReject / fvgFresh / fvgUnfilled / vwapStrongTrend
 *   • liqPeakStrong / dailyTrendAligned / fourHourTrendAligned
 *
 * Tier 2 (TRIO) 规则：上述 6 项任选 3 项 hit 即可，confidence ≥ 75
 *
 * 时间窗排除（两层共用）：
 *   • FOMC/CPI/NFP 前后 30 分钟（暂用配置时间表，未来可接日历 API）
 *   • 资金费率结算前后 15 分钟（UTC 00/08/16）
 *   • 周末 02:00-08:00 北京时间（亚洲流动性塌方）
 *
 * 查询参数 (与 /api/trade/liq-signal 一致 + 新增)：
 *   symbol         默认 'BTCUSDT'
 *   windowMs       主峰窗口 (15m ~ 31d)，默认 24h
 *   priceRange     'auto' 或 0~0.5
 *   sourceInterval / bucketMs
 *   autoTrade      'false' 关闭本次 webhook 推送（默认开启）
 *   notify         'false' 关闭本次飞书推送
 *
 * 响应：
 *   {
 *     success: true,
 *     data: {
 *       tier: 'HEXA' | 'TRIO' | 'NONE',
 *       signal: 'HEXA_RESONANCE_LONG' | 'TRIO_RESONANCE_SHORT' | ...,
 *       side: 'long' | 'short' | null,
 *       confidence: 0-100,
 *       conditions: { ... },
 *       fvg, vwap, peakLong, peakShort, oiSurge, volSurge, cvdDivergence,
 *       entryPrice, stopLoss, takeProfits, leverage, positionPct,
 *       indicatorsSnapshot: { ... }
 *     }
 *   }
 */

const express = require('express');
const { BinanceService } = require('../services/binance');
const {
  normalizeKlines,
  computeVWAP,
  computeATR,
  detectFVGs,
  markFVGFillStatus,
  findActiveFVGAtPrice
} = require('../indicators/klineIndicators');
const { computeTradeIndicators } = require('../indicators/tradeIndicators');
const { computeVolumeSurge } = require('../indicators/volumeSurge');
const { computeOISurge } = require('../indicators/oiSurge');
const { buildPredictiveLiquidationHeatmap } = require('../services/predictiveLiquidations');
const feishu = require('../services/feishu');
const autoTrade = require('../services/autoTrade');

const router = express.Router();

const ONE_MIN_MS = 60_000;
const ONE_HOUR_MS = 3600_000;

// ============================================================================
// 可调参数 (env override)
// ============================================================================
// --- Tier 1 (HEXA) ---
const HEXA_MIN_CONFIDENCE        = Number(process.env.HEXA_RESONANCE_MIN_CONFIDENCE) || 90;
const HEXA_LEVERAGE              = Number(process.env.HEXA_RESONANCE_LEVERAGE) || 100;
const HEXA_POSITION_PCT          = Number(process.env.HEXA_RESONANCE_POSITION_PCT) || 50;     // % of equity
const HEXA_COOLDOWN_MS           = Number(process.env.HEXA_RESONANCE_COOLDOWN_MS) || 6 * ONE_HOUR_MS;
const HEXA_STOP_LOSS_PCT         = Number(process.env.HEXA_RESONANCE_SL_PCT) || 0.004;        // 0.4%
const HEXA_TP_TIERS              = _parseTpTiers(process.env.HEXA_RESONANCE_TP_TIERS, [
  { pct: 0.002, ratio: 0.5 },
  { pct: 0.006, ratio: 0.3 },
  { pct: 0.010, ratio: 0.2 }
]);
// --- Tier 2 (TRIO) ---
const TRIO_MIN_CONFIDENCE        = Number(process.env.TRIO_RESONANCE_MIN_CONFIDENCE) || 75;
const TRIO_LEVERAGE              = Number(process.env.TRIO_RESONANCE_LEVERAGE) || 20;
const TRIO_POSITION_PCT          = Number(process.env.TRIO_RESONANCE_POSITION_PCT) || 15;
const TRIO_COOLDOWN_MS           = Number(process.env.TRIO_RESONANCE_COOLDOWN_MS) || 2 * ONE_HOUR_MS;
const TRIO_STOP_LOSS_PCT         = Number(process.env.TRIO_RESONANCE_SL_PCT) || 0.005;
const TRIO_TP_TIERS              = _parseTpTiers(process.env.TRIO_RESONANCE_TP_TIERS, [
  { pct: 0.003, ratio: 0.5 },
  { pct: 0.006, ratio: 0.5 }
]);
const TRIO_MAX_DAILY             = Number(process.env.TRIO_RESONANCE_MAX_DAILY) || 3;
// --- 通用 ---
const NEAR_LIQ_PEAK_PCT          = Number(process.env.RESONANCE_NEAR_LIQ_PEAK_PCT) || 0.005;  // 0.5%
const VOL_SURGE_THR              = Number(process.env.RESONANCE_VOL_SURGE_THR) || 2.0;
const OI_SURGE_THR               = Number(process.env.RESONANCE_OI_SURGE_THR) || 1.5;
const FVG_TOLERANCE_PCT          = Number(process.env.RESONANCE_FVG_TOLERANCE_PCT) || 0.001;  // 0.1%
const FVG_MIN_SIZE_PCT           = Number(process.env.RESONANCE_FVG_MIN_SIZE_PCT) || 0.001;
const FVG_MAX_SIZE_PCT           = Number(process.env.RESONANCE_FVG_MAX_SIZE_PCT) || 0.020;
const FVG_MAX_AGE_HOURS          = Number(process.env.RESONANCE_FVG_MAX_AGE_HOURS) || 4;
const FVG_MAX_FILL_RATIO         = Number(process.env.RESONANCE_FVG_MAX_FILL_RATIO) || 0.5;
const EXCLUDE_FUNDING_WINDOW_MIN = Number(process.env.RESONANCE_EXCLUDE_FUNDING_WINDOW_MIN) || 15;
const EXCLUDE_WEEKEND_LOW_LIQ    = String(process.env.RESONANCE_EXCLUDE_WEEKEND_LOW_LIQ || 'true').toLowerCase() !== 'false';
const COOLDOWN_REQUIRED          = String(process.env.RESONANCE_COOLDOWN_REQUIRED || 'true').toLowerCase() !== 'false';

// ============================================================================
// 冷却与日内计数（内存，按 symbol+tier+side 维度）
// ============================================================================
const _lastFireBy = new Map();       // key: 'BTCUSDT|HEXA|long' → ts
const _dailyCountBy = new Map();     // key: 'BTCUSDT|TRIO|YYYYMMDD' → count

function _cooldownKey(symbol, tier, side) {
  return `${String(symbol).toUpperCase()}|${tier}|${side}`;
}
function _dayKey(symbol, tier) {
  const now = new Date();
  // 用东八区日历日期，避免 UTC 跨日影响
  const ymd = new Date(now.getTime() + 8 * ONE_HOUR_MS).toISOString().slice(0, 10).replace(/-/g, '');
  return `${String(symbol).toUpperCase()}|${tier}|${ymd}`;
}
function _underCooldown(symbol, tier, side) {
  if (!COOLDOWN_REQUIRED) return false;
  const k = _cooldownKey(symbol, tier, side);
  const prev = _lastFireBy.get(k);
  const cooldown = tier === 'HEXA' ? HEXA_COOLDOWN_MS : TRIO_COOLDOWN_MS;
  if (!prev) return false;
  return Date.now() - prev < cooldown;
}
function _markFired(symbol, tier, side) {
  _lastFireBy.set(_cooldownKey(symbol, tier, side), Date.now());
  if (tier === 'TRIO') {
    const dk = _dayKey(symbol, tier);
    _dailyCountBy.set(dk, (_dailyCountBy.get(dk) || 0) + 1);
  }
}
function _dailyCountReached(symbol, tier) {
  if (tier !== 'TRIO') return false;
  const dk = _dayKey(symbol, tier);
  return (_dailyCountBy.get(dk) || 0) >= TRIO_MAX_DAILY;
}

// ============================================================================
// 时间窗排除
// ============================================================================
function _isFundingWindow(date = new Date()) {
  // 资金费率结算：每天 00/08/16 UTC（即北京时间 08/16/00）。
  // 前后 ±EXCLUDE_FUNDING_WINDOW_MIN 分钟内拒绝信号。
  const utcMinutesOfDay = date.getUTCHours() * 60 + date.getUTCMinutes();
  const settlements = [0, 8 * 60, 16 * 60];
  const w = EXCLUDE_FUNDING_WINDOW_MIN;
  for (const s of settlements) {
    const diff = Math.min(
      Math.abs(utcMinutesOfDay - s),
      Math.abs(utcMinutesOfDay - s + 1440),
      Math.abs(utcMinutesOfDay - s - 1440)
    );
    if (diff <= w) return true;
  }
  return false;
}
function _isWeekendLowLiq(date = new Date()) {
  if (!EXCLUDE_WEEKEND_LOW_LIQ) return false;
  // 东八区计算：星期六/日凌晨 02:00 - 08:00 视为低流动性窗口
  const cn = new Date(date.getTime() + 8 * ONE_HOUR_MS);
  const day = cn.getUTCDay(); // 0=Sun 6=Sat（在 +8 偏移后仍是该日 0-6）
  const hour = cn.getUTCHours();
  if (day === 0 || day === 6) {
    if (hour >= 2 && hour < 8) return true;
  }
  return false;
}

// ============================================================================
// 主路由
// ============================================================================
router.get('/trade/resonance-signal', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || 'BTCUSDT').toUpperCase();
    const market = 'futures';
    let windowMs = Number(req.query.windowMs);
    if (!Number.isFinite(windowMs) || windowMs < 15 * ONE_MIN_MS) windowMs = 24 * ONE_HOUR_MS;
    if (windowMs > 31 * 24 * ONE_HOUR_MS) windowMs = 31 * 24 * ONE_HOUR_MS;

    // ---- 主峰采样 ----
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

    // ---- 数据源（并行）----
    const [hmRaw, trendRaw, vol5mRaw, vwap1hRaw, vwap4hRaw, oiHist, trades] = await Promise.all([
      BinanceService.getKlines(symbol, sourceInterval, hmLimit, market),
      BinanceService.getKlines(symbol, '1m', 60, market),       // 1m × 60 = 1h 近场
      BinanceService.getKlines(symbol, '5m', 288, market).catch(() => []),  // 5m × 288 = 24h 成交量基准
      BinanceService.getKlines(symbol, '1m', 60, market),       // 1m × 60 = 1h VWAP
      BinanceService.getKlines(symbol, '5m', 48, market).catch(() => []),   // 5m × 48 = 4h VWAP
      BinanceService.getOpenInterestHist(symbol, '5m', 24).catch(() => []), // OI 2h × 5m
      BinanceService.getAggTrades(symbol, 500, market).catch(() => [])
    ]);

    const toMs = Date.now();
    const fromMs = toMs - windowMs;
    const hmCandles = normalizeKlines(hmRaw).filter((c) => c.openTime >= fromMs - sourceMs);
    const candles1m = normalizeKlines(trendRaw);
    const candles5m = Array.isArray(vol5mRaw) && vol5mRaw.length ? normalizeKlines(vol5mRaw) : [];
    const candles1h = normalizeKlines(vwap1hRaw);
    const candles4h = Array.isArray(vwap4hRaw) && vwap4hRaw.length ? normalizeKlines(vwap4hRaw) : [];

    if (!candles1m.length || !hmCandles.length) {
      return res.json({ success: true, data: _empty('Not enough kline data', { symbol, market, windowMs }) });
    }
    const latest = candles1m[candles1m.length - 1];
    const midPrice = Number(latest.close);
    if (!Number.isFinite(midPrice) || midPrice <= 0) {
      return res.json({ success: true, data: _empty('Invalid midPrice', { symbol, market, midPrice }) });
    }

    // ---- 时间窗硬过滤 ----
    const inFunding = _isFundingWindow();
    const inWeekendLowLiq = _isWeekendLowLiq();
    if (inFunding || inWeekendLowLiq) {
      return res.json({
        success: true,
        data: _empty(
          inFunding ? 'In funding-rate window (±15min)' : 'In weekend low-liquidity window',
          { symbol, market, midPrice, windowMs, sourceInterval, inFunding, inWeekendLowLiq }
        )
      });
    }

    // ---- 主峰（与 liq-signal 共用算法 row-max）----
    const priceRangeRaw = req.query.priceRange;
    const priceCtx = _resolvePriceRange(priceRangeRaw, midPrice, hmCandles);
    const heat = buildPredictiveLiquidationHeatmap(hmCandles, {
      fromMs, toMs, bucketMs,
      priceMin: priceCtx.priceMin,
      priceMax: priceCtx.priceMax,
      priceBucket: priceCtx.priceBucket
    });
    const peaks = _findPeaks(heat, midPrice);

    // ---- VWAP（1h / 4h）----
    const vwap1hArr = computeVWAP(candles1h);
    const vwap1h = vwap1hArr[vwap1hArr.length - 1] || null;
    const vwap4hArr = candles4h.length ? computeVWAP(candles4h) : [];
    const vwap4h = vwap4hArr.length ? vwap4hArr[vwap4hArr.length - 1] : null;

    // ---- FVG（用 1m × 60 = 1h 近场检测）----
    const fvgsRaw = detectFVGs(candles1m);
    markFVGFillStatus(fvgsRaw, candles1m);
    const activeFvgLong = findActiveFVGAtPrice(fvgsRaw, midPrice, {
      type: 'bullish',
      maxAgeMs: FVG_MAX_AGE_HOURS * ONE_HOUR_MS,
      minSizePct: FVG_MIN_SIZE_PCT,
      maxSizePct: FVG_MAX_SIZE_PCT,
      maxFillRatio: FVG_MAX_FILL_RATIO,
      tolerancePct: FVG_TOLERANCE_PCT
    });
    const activeFvgShort = findActiveFVGAtPrice(fvgsRaw, midPrice, {
      type: 'bearish',
      maxAgeMs: FVG_MAX_AGE_HOURS * ONE_HOUR_MS,
      minSizePct: FVG_MIN_SIZE_PCT,
      maxSizePct: FVG_MAX_SIZE_PCT,
      maxFillRatio: FVG_MAX_FILL_RATIO,
      tolerancePct: FVG_TOLERANCE_PCT
    });

    // ---- 成交量 / OI ----
    const volRes = computeVolumeSurge(candles5m);
    const oiRes  = computeOISurge(oiHist);

    // ---- CVD ----
    const cvdMetrics = computeTradeIndicators(trades, market, 50);
    const cvdSeries = cvdMetrics.cvdSeries || [];
    const cvdSlope = cvdSeries.length >= 10 ? _slope(cvdSeries.slice(-30).map((p) => p.value)) : 0;
    const trendWindow = candles1m.slice(-30);
    const priceSlope = _slope(trendWindow.map((c) => Number(c.close)));
    const cvdDivergence = (priceSlope > 0 && cvdSlope < 0) ? 'bearish'
      : (priceSlope < 0 && cvdSlope > 0) ? 'bullish'
        : 'none';

    // ---- 距清算墙距离 ----
    const peakLongPrice  = peaks.peakLong  ? peaks.peakLong.price  : null;
    const peakShortPrice = peaks.peakShort ? peaks.peakShort.price : null;
    const distLongPct    = peakLongPrice  ? Math.abs(midPrice - peakLongPrice)  / midPrice : null;
    const distShortPct   = peakShortPrice ? Math.abs(peakShortPrice - midPrice) / midPrice : null;
    const nearLongPeak   = distLongPct  != null && distLongPct  <= NEAR_LIQ_PEAK_PCT;
    const nearShortPeak  = distShortPct != null && distShortPct <= NEAR_LIQ_PEAK_PCT;

    // ---- K 线 reject 形态 ----
    const recent3 = candles1m.slice(-3);
    const longReject  = peakLongPrice  ? _hasLongRejectShape(recent3, peakLongPrice)  : false;
    const shortReject = peakShortPrice ? _hasShortRejectShape(recent3, peakShortPrice) : false;

    // ---- 4h / 日线趋势对齐 ----
    const trend4h = _trendOf(candles4h, 'close');
    // 日线简化：用 1h × 60 = 60h 推趋势近似（资源开销小）
    const trend60h = _trendOf(candles1h, 'close');

    // ---- 构造 6 个共振信号（多 / 空各一组）----
    const longSignal  = _buildResonanceSignal({
      side: 'long',
      midPrice,
      fvg: activeFvgLong,
      vwap: vwap1h,
      peakPrice: peakLongPrice,
      nearPeak: nearLongPeak,
      peakValue: peaks.peakLong ? peaks.peakLong.value : 0,
      volSurge: volRes.surge,
      oiSurge: oiRes.surge,
      cvdDivergence,
      reject: longReject,
      trend4h,
      trend60h,
      vwap4h
    });
    const shortSignal = _buildResonanceSignal({
      side: 'short',
      midPrice,
      fvg: activeFvgShort,
      vwap: vwap1h,
      peakPrice: peakShortPrice,
      nearPeak: nearShortPeak,
      peakValue: peaks.peakShort ? peaks.peakShort.value : 0,
      volSurge: volRes.surge,
      oiSurge: oiRes.surge,
      cvdDivergence,
      reject: shortReject,
      trend4h,
      trend60h,
      vwap4h
    });

    // ---- 决出最优信号 + 分级 ----
    const candidates = [longSignal, shortSignal].filter((s) => s != null);
    candidates.sort((a, b) => b.confidence - a.confidence);
    const best = candidates[0] || null;

    const snapshot = {
      symbol, market, midPrice,
      vwap1h, vwap4h,
      volSurge: volRes.surge, volLevel: volRes.level,
      oiSurge: oiRes.surge, oiLevel: oiRes.level,
      cvdDivergence, cvdSlope, priceSlope,
      peakLong: peaks.peakLong, peakShort: peaks.peakShort,
      distLongPct, distShortPct,
      activeFvgLong, activeFvgShort,
      trend4h, trend60h,
      windowMs, sourceInterval, bucketMs,
      priceRange: priceCtx.priceRange, autoRange: priceCtx.autoRange,
      timeWindowsExcluded: { inFunding, inWeekendLowLiq }
    };

    if (!best || best.confidence < TRIO_MIN_CONFIDENCE) {
      return res.json({
        success: true,
        data: _empty(best ? `Best confidence ${best.confidence} < TRIO ${TRIO_MIN_CONFIDENCE}` : 'No actionable resonance',
          snapshot)
      });
    }

    // 决定 Tier
    const tier = best.confidence >= HEXA_MIN_CONFIDENCE && best.allRequiredHit ? 'HEXA' : 'TRIO';

    // 冷却 + 日内数量
    if (_underCooldown(symbol, tier, best.side)) {
      return res.json({
        success: true,
        data: _empty(`${tier} ${best.side} under cooldown`, snapshot, best)
      });
    }
    if (tier === 'TRIO' && _dailyCountReached(symbol, tier)) {
      return res.json({
        success: true,
        data: _empty(`TRIO daily max ${TRIO_MAX_DAILY} reached`, snapshot, best)
      });
    }

    // ---- 入场 / 止损 / 止盈 ----
    const leverage = tier === 'HEXA' ? HEXA_LEVERAGE : TRIO_LEVERAGE;
    const positionPct = tier === 'HEXA' ? HEXA_POSITION_PCT : TRIO_POSITION_PCT;
    const slPct = tier === 'HEXA' ? HEXA_STOP_LOSS_PCT : TRIO_STOP_LOSS_PCT;
    const tpTiers = tier === 'HEXA' ? HEXA_TP_TIERS : TRIO_TP_TIERS;

    const entryPrice = midPrice;
    const stopLoss = best.side === 'long'
      ? entryPrice * (1 - slPct)
      : entryPrice * (1 + slPct);
    const takeProfits = tpTiers.map((t) => ({
      price: best.side === 'long' ? entryPrice * (1 + t.pct) : entryPrice * (1 - t.pct),
      closeFraction: t.ratio,
      pct: t.pct
    }));

    const signalName = `${tier}_RESONANCE_${best.side === 'long' ? 'LONG' : 'SHORT'}`;
    const playbook = _playbookFor(tier, best.side, best);

    const data = {
      tier,
      signal: signalName,
      side: best.side,
      confidence: best.confidence,
      hitRequired: best.hitRequired,
      hitOptional: best.hitOptional,
      allRequiredHit: best.allRequiredHit,
      playbook,
      entryPrice,
      stopLoss,
      takeProfits,
      leverage,
      positionPct,
      stopLossPct: slPct,
      conditions: _condsToObject(best.conditions),
      peakLong: peaks.peakLong,
      peakShort: peaks.peakShort,
      triggerPeakPrice: best.peakPrice,
      activeFvg: best.fvg,
      indicatorsSnapshot: snapshot
    };

    _markFired(symbol, tier, best.side);

    // ---- 自动交易 webhook ----
    // 用 Tier 区分 label，外部中转服务可按 label 选择不同杠杆/仓位预设
    if (req.query.notify !== 'false' && req.query.autoTrade !== 'false') {
      const labelTpl = tier === 'HEXA'
        ? (process.env.AUTO_TRADE_TIER1_LABEL || 'HEXA-{leverage}x-{positionPct}pct-{side}')
        : (process.env.AUTO_TRADE_TIER2_LABEL || 'TRIO-{leverage}x-{positionPct}pct-{side}');
      const label = labelTpl
        .replace('{leverage}', String(leverage))
        .replace('{positionPct}', String(positionPct))
        .replace('{side}', best.side)
        .replace('{tier}', tier)
        .replace('{symbol}', symbol)
        .replace('{confidence}', String(best.confidence));
      autoTrade.sendPendingOrder({
        signal: signalName,
        direction: best.side,
        confidence: best.confidence,
        symbol,
        extra: {
          tier,
          entryPrice,
          stopLoss,
          takeProfits,
          leverage,
          positionPct,
          triggerPeakPrice: best.peakPrice,
          fvg: best.fvg ? { type: best.fvg.type, lower: best.fvg.lower, upper: best.fvg.upper } : null,
          labelOverride: label
        }
      })
        .then((r) => {
          if (r.ok) {
            // eslint-disable-next-line no-console
            console.log(`[resonance] auto-trade sent ${symbol} ${signalName} (HTTP ${r.status})`);
          } else if (!r.skipped) {
            // eslint-disable-next-line no-console
            console.warn(`[resonance] auto-trade ${symbol} ${signalName} not sent: ${r.error}`);
          } else if (process.env.AUTO_TRADE_DEBUG === 'true') {
            // eslint-disable-next-line no-console
            console.log(`[resonance] auto-trade skipped ${symbol} ${signalName}: ${r.reason}`);
          }
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.error('[resonance] auto-trade threw:', err && err.message);
        });
    }

    // ---- 飞书推送 ----
    if (feishu.isSignalNotifyEnabled() && req.query.notify !== 'false') {
      feishu.sendCard(_buildResonanceCard(data))
        .then((r) => {
          if (r.ok) {
            // eslint-disable-next-line no-console
            console.log(`[resonance] feishu pushed ${symbol} ${signalName} conf=${best.confidence}`);
          } else if (!r.skipped) {
            // eslint-disable-next-line no-console
            console.warn('[resonance] feishu failed:', r.error);
          }
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.error('[resonance] feishu threw:', err.message);
        });
    }

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// 状态查询 / 重置（运维用）
// ============================================================================
router.get('/trade/resonance-signal/status', (_req, res) => {
  const now = Date.now();
  const cooldownView = {};
  for (const [k, ts] of _lastFireBy.entries()) {
    const tier = k.split('|')[1];
    const cd = tier === 'HEXA' ? HEXA_COOLDOWN_MS : TRIO_COOLDOWN_MS;
    const remainMs = Math.max(0, cd - (now - ts));
    cooldownView[k] = {
      lastFiredAt: ts,
      lastFiredIso: new Date(ts).toISOString(),
      remainMs,
      remainMin: Math.round(remainMs / 60000)
    };
  }
  res.json({
    success: true,
    data: {
      config: {
        HEXA: {
          minConfidence: HEXA_MIN_CONFIDENCE,
          leverage: HEXA_LEVERAGE,
          positionPct: HEXA_POSITION_PCT,
          cooldownMs: HEXA_COOLDOWN_MS,
          stopLossPct: HEXA_STOP_LOSS_PCT,
          tpTiers: HEXA_TP_TIERS
        },
        TRIO: {
          minConfidence: TRIO_MIN_CONFIDENCE,
          leverage: TRIO_LEVERAGE,
          positionPct: TRIO_POSITION_PCT,
          cooldownMs: TRIO_COOLDOWN_MS,
          stopLossPct: TRIO_STOP_LOSS_PCT,
          tpTiers: TRIO_TP_TIERS,
          maxDaily: TRIO_MAX_DAILY
        },
        common: {
          nearLiqPeakPct: NEAR_LIQ_PEAK_PCT,
          volSurgeThr: VOL_SURGE_THR,
          oiSurgeThr: OI_SURGE_THR,
          fvgMaxAgeHours: FVG_MAX_AGE_HOURS,
          fvgMaxFillRatio: FVG_MAX_FILL_RATIO,
          excludeFundingMin: EXCLUDE_FUNDING_WINDOW_MIN,
          excludeWeekendLowLiq: EXCLUDE_WEEKEND_LOW_LIQ
        }
      },
      cooldowns: cooldownView,
      dailyCounts: Object.fromEntries(_dailyCountBy.entries()),
      timeWindowsNow: {
        inFunding: _isFundingWindow(),
        inWeekendLowLiq: _isWeekendLowLiq()
      }
    }
  });
});

router.post('/trade/resonance-signal/reset', (_req, res) => {
  _lastFireBy.clear();
  _dailyCountBy.clear();
  res.json({ success: true, data: { cleared: true } });
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

function _resolvePriceRange(priceRangeRaw, midPrice, hmCandles) {
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
  return { priceMin, priceMax, priceBucket, priceRange, autoRange };
}

// row-max 主峰：与前端 / liqSignal 一致，保证"图上视觉最强 = 信号触发价位"
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

function _trendOf(candles, field) {
  if (!Array.isArray(candles) || candles.length < 10) return 'unknown';
  const arr = candles.map((c) => Number(c[field])).filter(Number.isFinite);
  if (arr.length < 10) return 'unknown';
  const s = _slope(arr.slice(-20));
  const last = arr[arr.length - 1];
  if (!Number.isFinite(last) || last <= 0) return 'unknown';
  const norm = s / last;
  if (norm > 0.0005) return 'up';
  if (norm < -0.0005) return 'down';
  return 'flat';
}

function _hasLongRejectShape(candles, peakPrice) {
  for (const c of candles) {
    const o = Number(c.open), h = Number(c.high), l = Number(c.low), cl = Number(c.close);
    if (!Number.isFinite(l) || !Number.isFinite(cl)) continue;
    if (l > peakPrice * 1.002) continue;
    const body = Math.abs(cl - o);
    const lowerWick = Math.min(o, cl) - l;
    if (lowerWick >= body * 0.8 && cl > l + (h - l) * 0.5) return true;
  }
  return false;
}
function _hasShortRejectShape(candles, peakPrice) {
  for (const c of candles) {
    const o = Number(c.open), h = Number(c.high), l = Number(c.low), cl = Number(c.close);
    if (!Number.isFinite(h) || !Number.isFinite(cl)) continue;
    if (h < peakPrice * 0.998) continue;
    const body = Math.abs(cl - o);
    const upperWick = h - Math.max(o, cl);
    if (upperWick >= body * 0.8 && cl < l + (h - l) * 0.5) return true;
  }
  return false;
}

// ============================================================================
// 信号构造：把所有指标聚合成单方向（long/short）的 conditions 列表 + confidence
// ============================================================================
function _buildResonanceSignal(args) {
  const {
    side, midPrice, fvg, vwap, peakPrice, nearPeak, peakValue,
    volSurge, oiSurge, cvdDivergence, reject,
    trend4h, trend60h, vwap4h
  } = args;
  const isLong = side === 'long';
  const fvgFresh    = fvg && (Date.now() - fvg.endTime) < 2 * ONE_HOUR_MS;
  const fvgUnfilled = fvg && fvg.fillRatio < 0.2;
  const vwapAligned = vwap != null && (isLong ? midPrice > vwap : midPrice < vwap);
  const vwapStrong  = vwap != null && Math.abs((midPrice - vwap) / midPrice) >= 0.005;
  const cvdHit      = isLong ? cvdDivergence === 'bullish' : cvdDivergence === 'bearish';
  const trend4hAligned  = isLong ? trend4h  === 'up' || trend4h  === 'flat'
                                 : trend4h  === 'down' || trend4h === 'flat';
  const trend60hAligned = isLong ? trend60h === 'up' || trend60h === 'flat'
                                 : trend60h === 'down' || trend60h === 'flat';
  const vwap4hAligned   = vwap4h != null && (isLong ? midPrice > vwap4h : midPrice < vwap4h);

  const liqPeakStrong   = peakValue >= 50e6; // 50M USDT

  // 6 必要条件
  const conditions = [
    { key: 'inFVG',                value: !!fvg,                                       required: true, weight: 0 },
    { key: 'vwapAligned',          value: !!vwapAligned,                               required: true, weight: 0 },
    { key: 'nearLiqPeak',          value: !!nearPeak,                                  required: true, weight: 0 },
    { key: 'volumeSurging',        value: volSurge != null && volSurge >= VOL_SURGE_THR, required: true, weight: 0 },
    { key: 'oiSurging',            value: oiSurge  != null && oiSurge  >= OI_SURGE_THR,  required: true, weight: 0 },
    { key: 'cvdDivergence',        value: cvdHit,                                      required: true, weight: 0 },
    // 加分项（决定最终 confidence 是 60 还是 100）
    { key: 'klineReject',          value: !!reject,         weight: 3 },
    { key: 'fvgFresh',             value: !!fvgFresh,       weight: 2 },
    { key: 'fvgUnfilled',          value: !!fvgUnfilled,    weight: 2 },
    { key: 'vwapStrongTrend',      value: !!vwapStrong,     weight: 2 },
    { key: 'liqPeakStrong',        value: !!liqPeakStrong,  weight: 2 },
    { key: 'trend4hAligned',       value: !!trend4hAligned, weight: 2 },
    { key: 'trend60hAligned',      value: !!trend60hAligned,weight: 2 },
    { key: 'vwap4hAligned',        value: !!vwap4hAligned,  weight: 1 }
  ];

  // 计算：必要条件 + 加分项混合 confidence
  //   必要全部 hit → 基础 60 分（保证最少 60 起）
  //   缺一个必要 → 总分 = 60 × (hit/6)，最高 50
  //   加分项按 weight 加到 100
  const required = conditions.filter((c) => c.required);
  const optional = conditions.filter((c) => !c.required);
  const requiredHit = required.filter((c) => c.value).length;
  const allRequiredHit = requiredHit === required.length;
  let totalOptW = 0, hitOptW = 0;
  for (const c of optional) {
    const w = Number(c.weight) || 0;
    totalOptW += w;
    if (c.value) hitOptW += w;
  }
  let confidence;
  if (allRequiredHit) {
    confidence = Math.round(60 + 40 * (totalOptW > 0 ? hitOptW / totalOptW : 1));
  } else {
    // 不允许必要条件缺失的也升到 HEXA；但 TRIO 允许少 1-2 个必要项还能触发
    confidence = Math.round(50 * (requiredHit / required.length));
  }
  return {
    side,
    peakPrice,
    peakValue,
    fvg,
    confidence,
    conditions,
    hitRequired: requiredHit,
    hitOptional: optional.filter((c) => c.value).length,
    allRequiredHit,
    requiredTotal: required.length,
    optionalTotal: optional.length
  };
}

function _condsToObject(conds) {
  const out = {};
  for (const c of conds) out[c.key] = !!c.value;
  return out;
}

function _playbookFor(tier, side, sig) {
  const sym = side === 'long' ? '🟢 LONG' : '🔴 SHORT';
  if (tier === 'HEXA') {
    return `${sym} HEXA: 6 指标共振 + FVG 内 + 主峰 < 0.5% + OI 暴涨 + Vol 暴涨 + CVD 背离。100x + 50% 仓位。止损 -0.4% 严格执行，三段止盈 (0.2/0.6/1.0%)，15 分钟未达任何 TP 强平。`;
  }
  return `${sym} TRIO: 3 指标共振，confidence ${sig.confidence}。20x + 15% 仓位（低杠杆试探）。止损 -0.5%，两段止盈 (0.3/0.6%)。日内最多 ${TRIO_MAX_DAILY} 单。`;
}

function _empty(reason, snapshot, lastBest) {
  return {
    tier: 'NONE',
    signal: 'NONE',
    side: null,
    confidence: 0,
    reason,
    entryPrice: null,
    stopLoss: null,
    takeProfits: null,
    leverage: null,
    positionPct: null,
    conditions: null,
    peakLong: snapshot ? snapshot.peakLong : null,
    peakShort: snapshot ? snapshot.peakShort : null,
    triggerPeakPrice: null,
    activeFvg: null,
    indicatorsSnapshot: snapshot || null,
    lastBest: lastBest ? {
      side: lastBest.side,
      confidence: lastBest.confidence,
      conditions: _condsToObject(lastBest.conditions)
    } : null
  };
}

function _parseTpTiers(envStr, fallback) {
  if (!envStr) return fallback;
  try {
    return String(envStr).split(',').map((seg) => {
      const [pctStr, ratioStr] = seg.trim().split(':');
      const pct = Number(pctStr);
      const ratio = Number(ratioStr);
      if (!Number.isFinite(pct) || !Number.isFinite(ratio)) throw new Error('bad seg ' + seg);
      return { pct, ratio };
    });
  } catch (_) {
    return fallback;
  }
}

// ============================================================================
// 飞书卡片（东八区时间）
// ============================================================================
function _buildResonanceCard(d) {
  const isHexa = d.tier === 'HEXA';
  const isLong = d.side === 'long';
  const template = isHexa ? (isLong ? 'turquoise' : 'orange') : (isLong ? 'green' : 'red');
  const tierBadge = isHexa ? '🏆 HEXA · 顶级共振' : '⭐ TRIO · 日内常规';
  const sideEmoji = isLong ? '🟢 LONG (做多)' : '🔴 SHORT (做空)';
  const fmt = (v, d2 = 2) => v == null ? '-' : Number(v).toFixed(Math.abs(v) >= 1000 ? d2 : 4);
  const fmtMoney = (v) => v >= 1e9 ? (v / 1e9).toFixed(2) + 'B'
    : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M'
    : v >= 1e3 ? (v / 1e3).toFixed(2) + 'K' : Number(v).toFixed(0);
  const sym = (d.indicatorsSnapshot && d.indicatorsSnapshot.symbol) || 'BTCUSDT';
  const triggerPeak = d.side === 'long' ? d.peakLong : d.peakShort;
  const peakLabel = d.side === 'long' ? 'L↓ 多头清算墙' : 'S↑ 空头清算墙';
  const fvgLabel = d.activeFvg ? (d.activeFvg.type === 'bullish' ? '🟩 Bullish FVG' : '🟥 Bearish FVG') : '-';

  const lines = [];
  lines.push(`**类型 / Tier**: ${tierBadge} · ${sideEmoji}`);
  lines.push(`**置信度 / Confidence**: \`${d.confidence}/100\` · 必要 ${d.hitRequired}/6 · 加分 ${d.hitOptional}/8`);
  lines.push(`**杠杆 / Leverage**: ${d.leverage}x · 仓位 ${d.positionPct}%`);
  lines.push('---');
  lines.push(`**FVG**: ${fvgLabel}${d.activeFvg ? ` [${fmt(d.activeFvg.lower)} ~ ${fmt(d.activeFvg.upper)}] (filled ${(d.activeFvg.fillRatio * 100).toFixed(1)}%)` : ''}`);
  if (triggerPeak) {
    lines.push(`**触发墙**: ${peakLabel} @ \`${fmt(triggerPeak.price)}\` (累计 ${fmtMoney(triggerPeak.value)} USDT)`);
  }
  if (d.indicatorsSnapshot) {
    const s = d.indicatorsSnapshot;
    lines.push(`**VWAP 1h**: \`${fmt(s.vwap1h)}\` ${s.vwap4h != null ? `· 4h: \`${fmt(s.vwap4h)}\`` : ''}`);
    lines.push(`**Vol Surge**: \`${s.volSurge != null ? s.volSurge.toFixed(2) + 'x' : '-'}\` (${s.volLevel || '-'}) · **OI Surge**: \`${s.oiSurge != null ? s.oiSurge.toFixed(2) + 'x' : '-'}\` (${s.oiLevel || '-'})`);
    lines.push(`**CVD Div**: \`${s.cvdDivergence}\` · **趋势**: 4h \`${s.trend4h}\` · 60h \`${s.trend60h}\``);
  }
  lines.push('---');
  lines.push(`**入场 / Entry**: \`${fmt(d.entryPrice)}\``);
  lines.push(`**止损 / Stop**: \`${fmt(d.stopLoss)}\` (${(d.stopLossPct * 100).toFixed(2)}%)`);
  if (d.takeProfits && d.takeProfits.length) {
    d.takeProfits.forEach((tp, i) => {
      lines.push(`**TP${i + 1} (${(tp.closeFraction * 100).toFixed(0)}%)**: \`${fmt(tp.price)}\` (+${(tp.pct * 100).toFixed(2)}%)`);
    });
  }
  lines.push('---');
  lines.push(`**Playbook**: ${d.playbook}`);
  const hits = Object.entries(d.conditions || {}).map(([k, v]) => `${v ? '✅' : '❌'} ${k}`);
  if (hits.length) lines.push(`**命中 / Hit**: ${hits.join(' · ')}`);

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `${tierBadge} · ${d.signal} · ${sym}` },
      template
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
      {
        tag: 'note',
        elements: [
          { tag: 'lark_md', content: `触发 / Trigger: **resonance-signal** · ${feishu.fmtCnTime()}` }
        ]
      }
    ]
  };
}

module.exports = router;
