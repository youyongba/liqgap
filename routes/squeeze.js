'use strict';

/**
 * 扎空 / 扎多 路由 (Squeeze routes)
 *
 *  GET /api/squeeze/warning      – 预警评分 (early warning score)
 *  GET /api/squeeze/confirmation – 确认标志 (confirmation flags)
 *  GET /api/squeeze/heatmap      – 价格分桶强平热力图
 *                                  (price-bucketed liquidation heatmap)
 *  GET /api/squeeze/signal       – 综合交易计划：入场 / 止损 / TP1-3
 *                                  (combined trade plan: entry/SL/TP1-3)
 *
 * 所有路由统一返回 { success, data } | { success:false, error }。
 */

const express = require('express');
const { BinanceLive: BinanceService } = require('../services/binanceLive');
const { BinanceFutures } = require('../services/binanceFutures');
const {
  normalizeKlines,
  computeATR
} = require('../indicators/klineIndicators');
const {
  computeWarning,
  computeConfirmation,
  buildLiquidationHeatmap
} = require('../indicators/squeeze');

const router = express.Router();

// ---------------------------------------------------------------------------
// 工具：把任何上游 Promise 包成永不抛出的"安全"结果对象
// (Helper: turn any upstream Promise into a never-throwing result object.)
//   { ok:true, v }  on success
//   { ok:false, e } on failure
// ---------------------------------------------------------------------------
const safe = (p) =>
  p.then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, e: e.message || String(e) }));

// ---------------------------------------------------------------------------
// 并行拉取所有需要的数据集；单源失败仅降级，不让整个端点 500
// (Pull every dataset we need in parallel. Individual failures degrade.)
// ---------------------------------------------------------------------------
async function loadSqueezeBundle(symbol, period = '1h', oiLimit = 100) {
  const [
    fr,
    oiHist,
    topPos,
    takerVol,
    forceOrders,
    klines
  ] = await Promise.all([
    safe(BinanceFutures.getFundingRate(symbol, oiLimit)),
    safe(BinanceFutures.getOpenInterestHist(symbol, period, oiLimit)),
    safe(BinanceFutures.getTopLongShortPositionRatio(symbol, period, oiLimit)),
    safe(BinanceFutures.getTakerBuySellVol(symbol, period, oiLimit)),
    safe(BinanceFutures.getAllForceOrders(symbol, 100)),
    safe(BinanceService.getKlines(symbol, period, 100, 'futures'))
  ]);

  // 最新价直接从 K 线最后一根 close 派生；省掉一次 ticker REST，
  // 在 IP 被限流时尤其关键
  const klineArr = klines.ok && Array.isArray(klines.v) ? klines.v : [];
  const lastKline = klineArr.length > 0 ? klineArr[klineArr.length - 1] : null;
  const currentPrice = lastKline ? Number(lastKline[4]) : null;

  return {
    fundingRate: fr.ok ? fr.v : [],
    oiHist: oiHist.ok ? oiHist.v : [],
    topPosRatio: topPos.ok ? topPos.v : [],
    takerVol: takerVol.ok ? takerVol.v : [],
    forceOrders: forceOrders.ok ? forceOrders.v : { degraded: true, data: [] },
    klines: klines.ok ? klines.v : [],
    currentPrice,
    errors: {
      fundingRate: fr.ok ? null : fr.e,
      oiHist: oiHist.ok ? null : oiHist.e,
      topPosRatio: topPos.ok ? null : topPos.e,
      takerVol: takerVol.ok ? null : takerVol.e,
      forceOrders: forceOrders.ok ? null : forceOrders.e,
      klines: klines.ok ? null : klines.e,
      currentPrice: null
    }
  };
}

// ---------------------------------------------------------------------------
// 1. /api/squeeze/warning  —— 预警评分 (early warning score)
// ---------------------------------------------------------------------------
router.get('/squeeze/warning', async (req, res) => {
  try {
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    const limit = Math.min(Number(req.query.limit) || 100, 500);

    // 用 safe() 包裹每个上游调用，单源失败降级而不是整体 500
    // (Wrap each upstream call so single failures degrade gracefully.)
    const [fr, oiHist, topPos, takerVol] = await Promise.all([
      safe(BinanceFutures.getFundingRate(symbol, limit)),
      safe(BinanceFutures.getOpenInterestHist(symbol, '1h', limit)),
      safe(BinanceFutures.getTopLongShortPositionRatio(symbol, '1h', limit)),
      safe(BinanceFutures.getTakerBuySellVol(symbol, '1h', limit))
    ]);

    const warning = computeWarning({
      fundingRate: fr.ok ? fr.v : [],
      oiHist: oiHist.ok ? oiHist.v : [],
      topPosRatio: topPos.ok ? topPos.v : [],
      takerVol: takerVol.ok ? takerVol.v : []
    });

    res.json({
      success: true,
      data: {
        symbol,
        ...warning,
        errors: {
          fundingRate: fr.ok ? null : fr.e,
          oiHist: oiHist.ok ? null : oiHist.e,
          topPosRatio: topPos.ok ? null : topPos.e,
          takerVol: takerVol.ok ? null : takerVol.e
        }
      }
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 2. /api/squeeze/confirmation  —— 确认信号 (confirmation flags)
// ---------------------------------------------------------------------------
router.get('/squeeze/confirmation', async (req, res) => {
  try {
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();

    // 用 safe() 包裹所有上游 (Wrap all upstream calls in safe())
    const [klinesRes, oiHistRes, frRes, forceRes] = await Promise.all([
      safe(BinanceService.getKlines(symbol, '1h', 100, 'futures')),
      safe(BinanceFutures.getOpenInterestHist(symbol, '1h', 100)),
      safe(BinanceFutures.getFundingRate(symbol, 50)),
      safe(BinanceFutures.getAllForceOrders(symbol, 100))
    ]);

    const candles = klinesRes.ok ? normalizeKlines(klinesRes.v) : [];
    const oiHist = oiHistRes.ok ? oiHistRes.v : [];
    const fundingRate = frRes.ok ? frRes.v : [];
    const forceOrders = forceRes.ok ? forceRes.v : { degraded: true, data: [] };

    const confirmation = computeConfirmation({
      candles,
      oiHist,
      fundingRate,
      liquidations: forceOrders.data || []
    });

    res.json({
      success: true,
      data: {
        symbol,
        ...confirmation,
        liquidationsDegraded: !!forceOrders.degraded,
        errors: {
          klines: klinesRes.ok ? null : klinesRes.e,
          oiHist: oiHistRes.ok ? null : oiHistRes.e,
          fundingRate: frRes.ok ? null : frRes.e,
          forceOrders: forceRes.ok ? null : forceRes.e
        }
      }
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 3. /api/squeeze/heatmap  —— 强平热力图
// ---------------------------------------------------------------------------
router.get('/squeeze/heatmap', async (req, res) => {
  try {
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    const buckets = Math.min(Number(req.query.buckets) || 50, 500);

    // 用 safe() 包裹两个上游 (Wrap both upstream calls)
    // 最新价从 1m K 线最后一根 close 派生（走 stream cache，0 weight）
    const [forceRes, klineRes] = await Promise.all([
      safe(BinanceFutures.getAllForceOrders(symbol, 200)),
      safe(BinanceService.getKlines(symbol, '1m', 1, 'futures'))
    ]);

    const forceOrders = forceRes.ok ? forceRes.v : { degraded: true, data: [] };
    const klineArr = klineRes.ok && Array.isArray(klineRes.v) ? klineRes.v : [];
    const currentPrice = klineArr.length > 0 ? Number(klineArr[klineArr.length - 1][4]) : null;

    const heatmap = buildLiquidationHeatmap({
      liquidations: forceOrders.data || [],
      currentPrice,
      buckets,
      degraded: !!forceOrders.degraded
    });

    res.json({
      success: true,
      data: {
        symbol,
        ...heatmap,
        errors: {
          forceOrders: forceRes.ok ? null : forceRes.e,
          currentPrice: priceRes.ok ? null : priceRes.e
        }
      }
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 4. /api/squeeze/signal      ★ 交易计划 (trade plan)
// ---------------------------------------------------------------------------
router.get('/squeeze/signal', async (req, res) => {
  try {
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    const riskPercent = Number(req.query.riskPercent) || 1;
    const accountBalance = Number(req.query.accountBalance) || 1000;

    const bundle = await loadSqueezeBundle(symbol, '1h', 100);
    if (!bundle.currentPrice) {
      return res.json({
        success: true,
        data: emptySignal('Missing current price', { errors: bundle.errors })
      });
    }

    const warning = computeWarning({
      fundingRate: bundle.fundingRate,
      oiHist: bundle.oiHist,
      topPosRatio: bundle.topPosRatio,
      takerVol: bundle.takerVol
    });

    const candles = normalizeKlines(bundle.klines);
    const confirmation = computeConfirmation({
      candles,
      oiHist: bundle.oiHist,
      fundingRate: bundle.fundingRate,
      liquidations: bundle.forceOrders.data || []
    });

    const heatmap = buildLiquidationHeatmap({
      liquidations: bundle.forceOrders.data || [],
      currentPrice: bundle.currentPrice,
      buckets: 50,
      degraded: !!bundle.forceOrders.degraded
    });

    // ---- 决定方向 (Decide direction) ----
    // 必须 warning 与 confirmation 方向一致才出信号
    // (Both warning and confirmation must agree on the squeeze type.)
    const aligned =
      warning.squeezeRisk !== 'NONE' &&
      confirmation.type !== 'NONE' &&
      warning.squeezeRisk === confirmation.type;

    if (!aligned) {
      return res.json({
        success: true,
        data: emptySignal('Warning and confirmation not aligned', {
          warning,
          confirmation,
          heatmapDegraded: heatmap.degraded
        })
      });
    }

    const squeezeType = warning.squeezeRisk;
    const signalSide = squeezeType === 'SHORT_SQUEEZE' ? 'LONG' : 'SHORT';

    // ---- 价位计算 (Price levels) ----
    const entryPrice = bundle.currentPrice;
    const atrSeries = computeATR(candles, 14);
    const lastAtr = atrSeries.length
      ? atrSeries[atrSeries.length - 1] || atrSeries[atrSeries.length - 2] || entryPrice * 0.005
      : entryPrice * 0.005;

    let stopLoss;
    let tp1;
    let tp2;
    let tp3;

    const buffer = entryPrice * 0.005; // 0.5% 缓冲 (buffer)
    const longCluster = heatmap.nearestLongCluster;
    const shortCluster = heatmap.nearestShortCluster;

    if (signalSide === 'LONG') {
      // 止损：当前价下方多头爆仓密集区下沿 - 缓冲；
      // 热力图缺失时回退 ATR × 1.2 保护。
      // (Stop: below the dense long-liquidation cluster. Fall back to
      //  ATR * 1.2 protection if heatmap is degraded / empty.)
      stopLoss = longCluster
        ? longCluster.priceLow - buffer
        : entryPrice - lastAtr * 1.2;

      // TP1：上方空头爆仓集群上沿（价格磁吸）
      // (Nearest short-liq cluster top side -> price magnet up.)
      tp1 = shortCluster ? shortCluster.priceHigh : entryPrice + lastAtr * 1.5;

      // TP2：近 30 根摆动高点 或 ATR×3
      const swingHigh = Math.max(...candles.slice(-30).map((c) => c.high));
      tp2 = Math.max(swingHigh, entryPrice + lastAtr * 3);

      // TP3：ATR×5 扩展
      tp3 = entryPrice + lastAtr * 5;
    } else {
      // SHORT
      stopLoss = shortCluster
        ? shortCluster.priceHigh + buffer
        : entryPrice + lastAtr * 1.2;
      tp1 = longCluster ? longCluster.priceLow : entryPrice - lastAtr * 1.5;
      const swingLow = Math.min(...candles.slice(-30).map((c) => c.low));
      tp2 = Math.min(swingLow, entryPrice - lastAtr * 3);
      tp3 = entryPrice - lastAtr * 5;
    }

    const stopDistance = Math.abs(entryPrice - stopLoss);
    if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
      return res.json({
        success: true,
        data: emptySignal('Invalid stop distance', {
          entryPrice,
          stopLoss,
          warning,
          confirmation
        })
      });
    }

    const riskAmount = (accountBalance * riskPercent) / 100;
    const positionSize = riskAmount / stopDistance;
    const positionSizeQuote = positionSize * entryPrice;

    // 综合置信度 = 0.5 × |warning.score| + 0.5 × confirmation.confidence
    const confidence = Math.min(
      100,
      Math.round(0.5 * Math.abs(warning.score) + 0.5 * confirmation.confidence)
    );

    res.json({
      success: true,
      data: {
        signal: signalSide,
        entryPrice: round(entryPrice),
        stopLoss: round(stopLoss),
        takeProfits: [
          { price: round(tp1), closeFraction: 0.5 },
          { price: round(tp2), closeFraction: 0.3 },
          { price: round(tp3), closeFraction: 0.2 }
        ],
        positionSize: Number(positionSize.toFixed(6)),
        positionSizeQuote: round(positionSizeQuote),
        riskAmount: round(riskAmount),
        squeezeType,
        confidence,
        indicatorsSnapshot: {
          symbol,
          atr: round(lastAtr),
          warningScore: warning.score,
          warningComponents: warning.components,
          confirmation: {
            type: confirmation.type,
            confidence: confirmation.confidence,
            priceOiDivergence: confirmation.priceOiDivergence,
            liquidationDominance: confirmation.liquidationDominance,
            fundingRevertingFromExtreme: confirmation.fundingRevertingFromExtreme,
            stats: confirmation.stats
          },
          nearestLongCluster: heatmap.nearestLongCluster,
          nearestShortCluster: heatmap.nearestShortCluster,
          heatmapDegraded: heatmap.degraded
        }
      }
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// 空信号占位返回 (Empty-signal placeholder return)
function emptySignal(reason, context) {
  return {
    signal: 'NONE',
    reason,
    entryPrice: null,
    stopLoss: null,
    takeProfits: null,
    positionSize: null,
    positionSizeQuote: null,
    riskAmount: null,
    squeezeType: 'NONE',
    confidence: 0,
    indicatorsSnapshot: context || null
  };
}

// 数值四舍五入到指定小数位 (Round number to N decimal digits)
function round(x, digits = 4) {
  if (!Number.isFinite(x)) return x;
  return Number(Number(x).toFixed(digits));
}

module.exports = router;
