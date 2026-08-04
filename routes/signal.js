'use strict';

/**
 * GET /api/trade/signal
 *
 * 综合多种流动性信号，输出 LONG / SHORT / NONE 交易计划。
 * (Combines several liquidity signals to issue LONG / SHORT / NONE trade plans.)
 *
 * 两条出信号路径 (Two signal paths)：
 *   1. FVG 假突破形态 (FVG sweep-reject setup · 优先级更高，仅合约)：
 *      做空 = CVD↑ + OI↑（多头持续堆积）+ 价格上方的看跌 FVG 被打进
 *             又跌回其下方（假突破受阻回落，堆积的多头变燃料）
 *      做多 = CVD↓ + OI↑（空头持续堆积）+ 价格下方的看涨 FVG 被打进
 *             又收回其上方（下探失败，堆积的空头被反杀）
 *   2. 打分制 (score-based)：多/空各 5 项条件，≥3 项命中出信号
 *   开仓价 = 最新价；止损 / 止盈1-3 全部基于**当前周期** ATR(14) 计算，
 *   形态信号的止损锚定被触发的那个 FVG 远端 ± ATR×倍数。
 *
 * 查询参数 (Query params · 全部可选 / all optional):
 *   symbol            默认 'BTCUSDT'
 *   market            'spot' | 'futures'，默认 'spot'
 *   interval          K 线周期，默认 '1h'。前端传图表当前周期，
 *                     信号跟随所看周期计算（1h 图给 1h 信号，4h 图给 4h 信号）
 *   riskPercent       默认 1     （账户单笔风险 %）
 *   accountBalance    默认 1000  （报价币本位 USDT 等值）
 *   atrMultiplierSL   默认 1.5   （ATR 止损倍数）
 *   atrMultiplierTP1  默认 1.5
 *   atrMultiplierTP2  默认 3
 *   atrMultiplierTP3  默认 5
 *
 * 响应 (Response · 始终被 { success, data } 包裹):
 *   {
 *     signal: 'LONG' | 'SHORT' | 'NONE',
 *     entryPrice, stopLoss,
 *     takeProfits: [ { price, closeFraction }, ... ],
 *     positionSize, positionSizeQuote, riskAmount,
 *     indicatorsSnapshot: { ... }
 *   }
 *   当 signal === 'NONE' 时，价格 / 仓位字段为 null。
 */

const express = require('express');
const { BinanceLive: BinanceService } = require('../services/binanceLive');
const { BinanceService: BinanceRest } = require('../services/binance');
const {
  normalizeKlines,
  computeVWAP,
  computeATR,
  detectFVGs,
  detectLiquidityVoids
} = require('../indicators/klineIndicators');
const { computeOrderBookIndicators } = require('../indicators/orderbookIndicators');
const { computeTradeIndicators } = require('../indicators/tradeIndicators');
const { computeIlliquidity } = require('../indicators/illiquidity');
const { computeVolumeProfile } = require('../indicators/volumeProfile');
const { mean, correlation } = require('../indicators/stats');
const feishu = require('../services/feishu');

const router = express.Router();

// Binance 支持的 K 线周期白名单（防注入 / 打错参数直接回落 1h）
const VALID_INTERVALS = new Set([
  '1m', '3m', '5m', '15m', '30m',
  '1h', '2h', '4h', '6h', '8h', '12h',
  '1d', '3d', '1w', '1M'
]);

// K 线周期 → OI 历史统计周期（openInterestHist 只支持这几档，就近映射）
const OI_PERIOD_MAP = {
  '1m': '5m', '3m': '5m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '8h': '6h', '12h': '12h',
  '1d': '1d', '3d': '1d', '1w': '1d', '1M': '1d'
};

router.get('/trade/signal', async (req, res) => {
  try {
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    // 默认合约 (default to futures)
    const market = req.query.market === 'spot' ? 'spot' : 'futures';
    // 信号跟随前端图表当前周期 (Signal follows the chart's active interval)
    const interval = VALID_INTERVALS.has(req.query.interval) ? req.query.interval : '1h';
    const riskPercent = Number(req.query.riskPercent) || 1;
    const accountBalance = Number(req.query.accountBalance) || 1000;
    const atrMultSL = Number(req.query.atrMultiplierSL) || 1.5;
    const atrMultTP1 = Number(req.query.atrMultiplierTP1) || 1.5;
    const atrMultTP2 = Number(req.query.atrMultiplierTP2) || 3;
    const atrMultTP3 = Number(req.query.atrMultiplierTP3) || 5;

    // 一次性并行抓取所需数据 (Fetch all upstream data in parallel)
    // latestPrice 不再单独走 ticker REST，直接从当前周期 K 线最后一根 close 派生，
    // 既避免无谓 weight 消耗（在被 IP 限流时尤其重要），
    // 又能复用 stream 缓存里的实时数据。
    // K 线取 50 根：FVG 假突破形态需要更宽的历史扫描窗口（与 alerts 路由一致）
    // OI 历史仅合约有，失败/现货 → null，不阻断信号计算，只是形态路径不触发
    const oiPromise = market === 'futures'
      ? BinanceRest.getOpenInterestHist(symbol, OI_PERIOD_MAP[interval] || '1h', 12).catch(() => null)
      : Promise.resolve(null);
    const [klinesRaw, dailyRaw, book, trades, oiHistRaw] = await Promise.all([
      BinanceService.getKlines(symbol, interval, 50, market),
      BinanceService.getKlines(symbol, '1d', 30, market),
      BinanceService.getOrderBook(symbol, 100, market),
      BinanceService.getAggTrades(symbol, 500, market),
      oiPromise
    ]);

    const candles = normalizeKlines(klinesRaw);
    const latestPrice = candles.length > 0
      ? Number(candles[candles.length - 1].close)
      : null;
    if (candles.length < 5) {
      return res.json({
        success: true,
        data: emptySignal('Not enough kline data', { symbol, market, interval, latestPrice })
      });
    }

    const vwap = computeVWAP(candles);
    const atr = computeATR(candles, 14);
    const fvgs = detectFVGs(candles);
    const liquidityVoids = detectLiquidityVoids(candles);
    const orderBook = computeOrderBookIndicators(book, 20, 0.1);
    const tradeMetrics = computeTradeIndicators(trades, market, 50);
    const illiqSeries = computeIlliquidity(normalizeKlines(dailyRaw));
    const profile = computeVolumeProfile(candles, 50);

    // ---- 条件输入项 (Condition inputs) ----
    const lastIdx = candles.length - 1;
    const lastCandle = candles[lastIdx];
    const lastVwap = vwap[lastIdx];
    const lastAtr = atr[lastIdx] || atr[lastIdx - 1] || 0;

    // 最近 5 根 K 线内的 FVG (FVGs within the last 5 candles)
    const recentFvgWindowStart = candles[Math.max(0, candles.length - 5)].openTime;
    const recentBullishFvgs = fvgs.filter(
      (g) => g.type === 'bullish' && g.endTime >= recentFvgWindowStart
    );
    const recentBearishFvgs = fvgs.filter(
      (g) => g.type === 'bearish' && g.endTime >= recentFvgWindowStart
    );

    // depthRatio
    const depthRatio = orderBook.depthRatio || 0;

    // CVD 与价格相关性（近 10 根 K 线 / last 10 candles）
    const cvdAtCandle = sampleCvdAtCandleClose(candles, tradeMetrics.cvdSeries);
    const lookback = Math.min(10, candles.length - 1);
    const priceChanges = [];
    const cvdChanges = [];
    for (let i = candles.length - lookback; i < candles.length; i += 1) {
      priceChanges.push(candles[i].close - candles[i - 1].close);
      cvdChanges.push(cvdAtCandle[i] - cvdAtCandle[i - 1]);
    }
    const cvdPriceCorr = correlation(priceChanges, cvdChanges);
    const priceTrendUp = sum(priceChanges) > 0;
    const cvdTrendUp = sum(cvdChanges) > 0;

    // ---- OI 持仓量趋势（近 6 个样本 · 币本位口径，避免价格涨跌污染名义价值）----
    let oiRising = false;
    let oiChangePct = null;
    if (Array.isArray(oiHistRaw) && oiHistRaw.length >= 2) {
      const coins = oiHistRaw
        .map((r) => Number(r.sumOpenInterest))
        .filter((v) => Number.isFinite(v));
      if (coins.length >= 2) {
        const n = Math.min(6, coins.length);
        const first = coins[coins.length - n];
        const last = coins[coins.length - 1];
        oiRising = last > first;
        if (first > 0) oiChangePct = (last / first - 1) * 100;
      }
    }

    // 流动性健康：ILLIQ 不高于 20 日均值 且 spread 不超 2 倍均值
    // (Liquidity health: ILLIQ below 20-day mean & spread within 2x mean.)
    const illiqValues = illiqSeries.map((d) => d.illiq);
    const illiqMean = mean(illiqValues.slice(-20));
    const latestIlliq = illiqValues[illiqValues.length - 1] || 0;
    const liquidityHealthy = latestIlliq <= illiqMean;
    // 由于无法在内存里维护历史 orderbook 快照，
    // 这里用近 20 根 K 线的 (high-low)*0.001 作为 spread 均值代理。
    // (Use a rolling proxy from recent N candles' (high-low) as we can't
    //  store historical order-book snapshots cheaply.)
    const recentSpreadProxy = mean(
      candles.slice(-20).map((c) => Math.max(0, c.high - c.low) * 0.001)
    );
    const spreadOk =
      orderBook.spread != null && recentSpreadProxy > 0
        ? orderBook.spread <= 2 * recentSpreadProxy * 1000
        : true;

    // 价格相对 VWAP 的位置 (Price vs VWAP)
    const aboveVwap = lastCandle.close > lastVwap;
    const belowVwap = lastCandle.close < lastVwap;

    // ---- 多 / 空条件（按规范）(conditions per spec) ----
    const longConditions = {
      bullishFvg: recentBullishFvgs.length > 0,
      depthDominant: depthRatio > 0.6,
      cvdPriceUp: cvdPriceCorr > 0 && priceTrendUp && cvdTrendUp,
      liquidityHealthy: liquidityHealthy && spreadOk,
      aboveVwap
    };
    const shortConditions = {
      bearishFvg: recentBearishFvgs.length > 0,
      depthDominantSell: depthRatio < -0.6,
      cvdPriceDown: cvdPriceCorr > 0 && !priceTrendUp && !cvdTrendUp,
      liquidityHealthy: liquidityHealthy && spreadOk,
      belowVwap
    };
    const longScore = countTrue(longConditions);
    const shortScore = countTrue(shortConditions);

    // ---- FVG 假突破形态（优先级高于打分制 / Setup path first）----
    // 做空：CVD↑ + OI↑ + 上方看跌 FVG 被打进又跌回下方
    // 做多：CVD↓ + OI↑ + 下方看涨 FVG 被打进又收回上方
    const setup = findFvgRejectSetup({ fvgs, candles, latestPrice, cvdTrendUp, oiRising });
    const setupSnapshot = setup
      ? {
          name: setup.name,
          label: setup.side === 'SHORT'
            ? '看跌FVG假突破回落 · CVD↑+OI↑ 多头堆积受阻'
            : '看涨FVG回踩收复 · CVD↓+OI↑ 空头堆积失效',
          fvg: { lower: setup.fvg.lower, upper: setup.fvg.upper },
          conditions: setup.side === 'SHORT'
            ? { cvdRising: true, oiRising: true, fvgTriggered: true, priceRejected: true }
            : { cvdFalling: true, oiRising: true, fvgTriggered: true, priceReclaimed: true }
        }
      : null;

    let signal = 'NONE';
    if (setup) signal = setup.side;
    else if (longScore >= 3 && longScore >= shortScore) signal = 'LONG';
    else if (shortScore >= 3) signal = 'SHORT';

    if (signal === 'NONE') {
      return res.json({
        success: true,
        data: emptySignal('No actionable signal', {
          symbol,
          market,
          interval,
          latestPrice,
          longScore,
          shortScore,
          longConditions,
          shortConditions,
          oiRising,
          oiChangePct,
          atr: lastAtr,
          vwap: lastVwap,
          depthRatio,
          latestIlliq,
          illiqMean,
          cvdPriceCorr
        })
      });
    }

    // ---- 价格 & 仓位 (Pricing & sizing) ----
    const entryPrice = latestPrice || lastCandle.close;
    let stopLoss;
    if (signal === 'LONG') {
      // 形态信号优先锚定被触发的看涨 FVG；否则用近期 FVG / 摆动低点
      const fvg = (setup && setup.side === 'LONG' && setup.fvg)
        || recentBullishFvgs[recentBullishFvgs.length - 1];
      if (fvg) {
        // 多头：FVG 下沿 - 当前周期 ATR×倍数
        stopLoss = fvg.lower - lastAtr * atrMultSL;
      } else {
        // 没 FVG 退化为近 5 根低点下方 1% 或 ATR
        const recentLows = candles.slice(-5).map((c) => c.low);
        const swingLow = Math.min(...recentLows);
        stopLoss = Math.min(swingLow * 0.99, entryPrice - lastAtr * atrMultSL);
      }
    } else {
      // 形态信号优先锚定被触发的看跌 FVG；否则用近期 FVG / 摆动高点
      const fvg = (setup && setup.side === 'SHORT' && setup.fvg)
        || recentBearishFvgs[recentBearishFvgs.length - 1];
      if (fvg) {
        // 空头：FVG 上沿 + 当前周期 ATR×倍数
        stopLoss = fvg.upper + lastAtr * atrMultSL;
      } else {
        const recentHighs = candles.slice(-5).map((c) => c.high);
        const swingHigh = Math.max(...recentHighs);
        stopLoss = Math.max(swingHigh * 1.01, entryPrice + lastAtr * atrMultSL);
      }
    }

    const stopDistance = Math.abs(entryPrice - stopLoss);
    if (stopDistance <= 0) {
      return res.json({
        success: true,
        data: emptySignal('Invalid stop distance', { entryPrice, stopLoss })
      });
    }

    // TP1：基于 R 倍数 (R-multiple of stop distance)
    const tp1 =
      signal === 'LONG'
        ? entryPrice + stopDistance * atrMultTP1
        : entryPrice - stopDistance * atrMultTP1;

    // TP2：优先取流动性空白边界或 POC，否则 ATR×倍数
    // (TP2 prefers a structural target: nearest liquidity void edge or POC.)
    let tp2;
    if (signal === 'LONG') {
      const voidUpper = liquidityVoids
        .map((v) => v.upper)
        .filter((p) => p > entryPrice)
        .sort((a, b) => a - b)[0];
      const pocPrice = profile.poc && profile.poc.priceHigh > entryPrice ? profile.poc.priceHigh : null;
      tp2 = voidUpper || pocPrice || entryPrice + lastAtr * atrMultTP2;
    } else {
      const voidLower = liquidityVoids
        .map((v) => v.lower)
        .filter((p) => p < entryPrice)
        .sort((a, b) => b - a)[0];
      const pocPrice = profile.poc && profile.poc.priceLow < entryPrice ? profile.poc.priceLow : null;
      tp2 = voidLower || pocPrice || entryPrice - lastAtr * atrMultTP2;
    }

    // TP3：近期摆动高/低或 ATR 扩展 (Recent swing high/low or ATR-based fallback)
    let tp3;
    if (signal === 'LONG') {
      const swingHigh = Math.max(...candles.slice(-20).map((c) => c.high));
      tp3 = Math.max(swingHigh, entryPrice + lastAtr * atrMultTP3);
    } else {
      const swingLow = Math.min(...candles.slice(-20).map((c) => c.low));
      tp3 = Math.min(swingLow, entryPrice - lastAtr * atrMultTP3);
    }

    const riskAmount = (accountBalance * riskPercent) / 100;
    const positionSize = riskAmount / stopDistance;
    const positionSizeQuote = positionSize * entryPrice;

    const signalData = {
      signal,
      entryPrice,
      stopLoss,
      takeProfits: [
        { price: tp1, closeFraction: 0.5 },
        { price: tp2, closeFraction: 0.3 },
        { price: tp3, closeFraction: 0.2 }
      ],
      positionSize,
      positionSizeQuote,
      riskAmount,
      indicatorsSnapshot: {
        symbol,
        market,
        interval,
        setup: setupSnapshot,
        oiRising,
        oiChangePct,
        latestPrice,
        atr: lastAtr,
        vwap: lastVwap,
        depthRatio,
        spread: orderBook.spread,
        latestIlliq,
        illiqMean,
        cvdPriceCorr,
        cvd: tradeMetrics.summary.finalCvd,
        longConditions,
        shortConditions,
        longScore,
        shortScore,
        recentBullishFvg:
          recentBullishFvgs.length > 0
            ? recentBullishFvgs[recentBullishFvgs.length - 1]
            : null,
        recentBearishFvg:
          recentBearishFvgs.length > 0
            ? recentBearishFvgs[recentBearishFvgs.length - 1]
            : null,
        poc: profile.poc ? { priceLow: profile.poc.priceLow, priceHigh: profile.poc.priceHigh } : null,
        liquidityVoidsCount: liquidityVoids.length
      }
    };

    // ---- 飞书自动推送 (Feishu auto-push) ----
    // 仅当 ① 启用了 webhook、② FEISHU_SIGNAL_NOTIFY_ENABLED !== 'false'、
    //      ③ signal === LONG/SHORT、④ 通过去重 / 冷却校验 时才推送；
    // 推送是 fire-and-forget，不阻塞响应，失败也只记日志。
    if (feishu.isSignalNotifyEnabled() && (signal === 'LONG' || signal === 'SHORT') && req.query.notify !== 'false') {
      const verdict = feishu.shouldNotify(symbol, market, signal);
      if (verdict.ok) {
        // 先标记，再异步发送，避免并发请求重复推送
        // (Mark first to dedupe under concurrent polls.)
        feishu.markNotified(symbol, market, signal);
        feishu
          .sendSignalCard(signalData, {
            symbol,
            market,
            interval,
            triggerSource: setup
              ? `auto · ${setup.name} · ${verdict.reason}`
              : `auto · ${verdict.reason}`
          })
          .then((r) => {
            if (!r.ok && !r.skipped) {
              // eslint-disable-next-line no-console
              console.warn('[signal] feishu push failed:', r.error || r.response);
            } else if (r.ok) {
              // eslint-disable-next-line no-console
              console.log(`[signal] pushed to Feishu: ${symbol} ${signal} (${verdict.reason})`);
            }
          })
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.error('[signal] feishu push threw:', err.message);
          });
      } else {
        // eslint-disable-next-line no-console
        console.log(`[signal] feishu skip: ${symbol} ${signal} → ${verdict.reason}`);
      }
    }

    res.json({ success: true, data: signalData });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// 空信号占位返回 (Empty-signal placeholder return)
function emptySignal(reason, snapshot) {
  return {
    signal: 'NONE',
    reason,
    entryPrice: null,
    stopLoss: null,
    takeProfits: null,
    positionSize: null,
    positionSizeQuote: null,
    riskAmount: null,
    indicatorsSnapshot: snapshot || null
  };
}

/**
 * FVG 假突破回落 / 回踩收复形态检测
 * (FVG sweep-reject / sweep-reclaim setup detection.)
 *
 * 做空 (FVG_REJECT_SHORT)：
 *   前提 CVD↑ + OI↑（多头一路追进），价格上方存在看跌 FVG，
 *   最近 FVG_TOUCH_LOOKBACK 根 K 线内价格曾冲入该 FVG（high ≥ 下沿，
 *   含瞬间插针），而当前收盘又跌回 FVG 下沿之下 —— 追多的堆积仓位
 *   被闷在上方，转为下跌燃料。
 * 做多 (FVG_RECLAIM_LONG)：镜像逻辑（CVD↓ + OI↑ + 下方看涨 FVG
 *   被打进又收回上方，堆积的空头被反杀）。
 *
 * 触发必须发生在 FVG 形成之后（i > f.index + 1），避免用形成 FVG 的
 * 那三根 K 线自身当"触发"。命中多个 FVG 时取离当前价最近的那个
 * （最先构成阻力/支撑、也是止损锚定最紧的那个）。
 */
const FVG_TOUCH_LOOKBACK = 6;
function findFvgRejectSetup({ fvgs, candles, latestPrice, cvdTrendUp, oiRising }) {
  if (!Array.isArray(fvgs) || !fvgs.length) return null;
  if (!Array.isArray(candles) || !candles.length) return null;
  if (!Number.isFinite(latestPrice)) return null;
  if (!oiRising) return null; // 两个方向都要求 OI 上涨（持仓堆积）

  const lastIdx = candles.length - 1;
  const fromIdx = Math.max(0, candles.length - FVG_TOUCH_LOOKBACK);

  function touchedRecently(f, isBearish) {
    for (let i = lastIdx; i >= fromIdx; i -= 1) {
      if (i <= f.index + 1) break; // 只认 FVG 形成之后的触发
      const c = candles[i];
      if (isBearish ? c.high >= f.lower : c.low <= f.upper) return true;
    }
    return false;
  }

  if (cvdTrendUp) {
    // 做空候选：上方看跌 FVG，被打进过，当前又收在下沿之下
    const candidates = fvgs
      .filter((f) => f.type === 'bearish' && latestPrice < f.lower && touchedRecently(f, true))
      .sort((a, b) => a.lower - b.lower);
    if (candidates.length) {
      return { side: 'SHORT', name: 'FVG_REJECT_SHORT', fvg: candidates[0] };
    }
  } else {
    // 做多候选：下方看涨 FVG，被打进过，当前又收在上沿之上
    const candidates = fvgs
      .filter((f) => f.type === 'bullish' && latestPrice > f.upper && touchedRecently(f, false))
      .sort((a, b) => b.upper - a.upper);
    if (candidates.length) {
      return { side: 'LONG', name: 'FVG_RECLAIM_LONG', fvg: candidates[0] };
    }
  }
  return null;
}

function sum(arr) {
  let s = 0;
  for (const v of arr) s += v;
  return s;
}

function countTrue(obj) {
  return Object.values(obj).filter(Boolean).length;
}

// 与 alerts 路由同名工具：把 cvd 时序对齐到每根 K 线收盘
// (Same helper as in alerts.js: align CVD series to candle close timestamps.)
function sampleCvdAtCandleClose(candles, cvdSeries) {
  const result = new Array(candles.length).fill(0);
  if (!cvdSeries.length) return result;
  let j = 0;
  let lastCvd = 0;
  for (let i = 0; i < candles.length; i += 1) {
    while (j < cvdSeries.length && cvdSeries[j].time <= candles[i].closeTime) {
      lastCvd = cvdSeries[j].value;
      j += 1;
    }
    result[i] = lastCvd;
  }
  return result;
}

module.exports = router;
// 供冒烟测试直接调用 (Exposed for smoke tests)
module.exports._findFvgRejectSetup = findFvgRejectSetup;
