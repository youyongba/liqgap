'use strict';

/**
 * 30 天策略回测引擎 · 完全基于真实历史数据
 * (30-day strategy backtest engine · 100% real-data driven)
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  设计原则 (Design principles)：唯一被「模拟」的，只有 1000 USDT 虚拟资金
 *  按信号开仓 / 止损 / 止盈并记录盈亏。所有用于生成信号的指标，全部由真实
 *  历史数据计算：
 *
 *    K 线 (1h)            ←  /fapi/v1/klines (or spot)
 *    日线 (1d, ILLIQ)     ←  /fapi/v1/klines interval=1d
 *    资金费率历史          ←  /fapi/v1/fundingRate
 *    主动买卖 / CVD       ←  data.binance.vision daily aggTrades zip
 *
 *  禁止任何「模拟 CVD」(no synthetic CVD：阳线量当主动买、阴线量当主动卖
 *  这种近似都不允许)。
 *  禁止任何「模拟订单簿」(no synthetic order book) —— 币安未提供历史订单簿
 *  快照下载，所以 spread / depthRatio / 有效价差 完全不参与回测，也不
 *  伪造中性值。在 result.notes 中明确声明。
 *
 *  策略 (Strategy)：投票制 (vote-based)，统计真实指标条件中支持 LONG / SHORT
 *  的票数，≥3 票即出信号；冲突按净票数取胜。条件清单见 evaluateConditions()。
 *
 *  风控 (Risk control)：
 *     riskAmount = balance * riskPercent / 100
 *     positionSize = riskAmount / stopDistance
 *     stopDistance = ATR(14) * 1.5
 *     stopLoss     = max(下方近 5 根低点, 入场价 - stopDistance)  (LONG)
 *                  = min(上方近 5 根高点, 入场价 + stopDistance)  (SHORT)
 *     若有可用的最近反向 FVG，FVG 的远边作为更紧的止损候选。
 *     TP1/2/3 = entry ± ATR × {1.5, 3, 5}，平仓比例 50% / 30% / 20%
 *     手续费 0.04%、滑点 0.05% (单边)；保守撮合：SL 与 TP 同根 K 线先按 SL。
 * ────────────────────────────────────────────────────────────────────────────
 */

const {
  normalizeKlines,
  computeVWAP,
  computeATR,
  computeMFI,
  detectFVGs,
  detectLiquidityVoids
} = require('./klineIndicators');
const { computeIlliquidity } = require('./illiquidity');
const { fetchHistoricalAggTrades } = require('../services/binanceData');
const { BinanceService } = require('../services/binance');
const { BinanceFutures } = require('../services/binanceFutures');

const HOUR_MS = 3600000;
const DAY_MS = 86400000;

const DEFAULT_OPTIONS = {
  riskPercent: 1,
  atrPeriod: 14,
  mfiPeriod: 14,
  fvgLookback: 5,
  warmupBars: 30,
  atrMultiplierSL: 1.5,
  rMultipliers: [1.5, 3, 5],
  closeFractions: [0.5, 0.3, 0.2],
  maxBarsInTrade: 96,
  feeRate: 0.0004,
  slippagePct: 0.0005,
  cvdCorrWindow: 24,         // CVD-Price 滚动相关性窗口 (24 根 = 1 天)
  cvdCorrThreshold: 0.3,     // |相关系数| ≥ 该阈值才视为同向/背离信号
  illiqLookback: 7,          // 用近 7 天 ILLIQ 中位数判断「流动性枯竭」
  fundingExtremeBps: 5       // 资金费率绝对值 > 0.05% (5bp) 视为极端
};

// ===========================================================================
// 主入口 (Entrypoint)
// ===========================================================================
/**
 * runBacktest(symbol, initialBalance, days, [extra])
 *
 * @param {string} symbol         交易对
 * @param {number} initialBalance 初始虚拟资金 (USDT)
 * @param {number} days           回测天数 (1-90)
 * @param {object} [extra]
 * @param {'spot'|'futures'} [extra.market='futures']
 * @param {string}             [extra.interval='1h']
 * @param {object}             [extra.options]   覆盖 DEFAULT_OPTIONS 的字段
 * @param {(m:string)=>void}   [extra.log]
 * @returns {Promise<object>}     成功 ⇒ 完整结果；失败 ⇒ 抛出 Error
 *
 * 失败语义：若任何一类「真实数据」无法获取，函数 reject，调用方应将其
 * 转换成 { success: false, error: "无法获取真实历史成交数据，回测中止" }。
 */
async function runBacktest(symbol, initialBalance = 1000, days = 30, extra = {}) {
  const market = extra.market === 'spot' ? 'spot' : 'futures';
  const interval = extra.interval || '1h';
  if (interval !== '1h') {
    // 当前真实 aggTrades 聚合按 1h 桶，硬性约束 (hard constraint).
    throw new Error('interval must be "1h" for real-data backtest');
  }
  const opts = { ...DEFAULT_OPTIONS, ...(extra.options || {}) };
  const log = typeof extra.log === 'function' ? extra.log : () => {};

  const result = {
    symbol,
    market,
    interval,
    days,
    initialBalance,
    dataSources: {},
    notes: [],
    warnings: [],
    skippedIndicators: [
      'depthRatio (订单簿不平衡)',
      'spread / 估算有效价差 (effective spread)',
      'order-book imbalance / footprint absorption'
    ]
  };
  result.notes.push(
    '本回测所有指标均使用真实历史数据：K线、日线、资金费率、ILLIQ ' +
    '与逐笔成交 (aggTrades) 全部直接来自 Binance；CVD 由真实 aggTrades 聚合，' +
    '不使用「阳线量=主动买」式的模拟近似。'
  );
  result.notes.push(
    '由于币安未提供历史订单簿快照下载，Depth Ratio、Spread、有效价差等' +
    '订单簿类指标在本回测中未被使用 (skipped)。'
  );

  // -------------------------------------------------------------------------
  // 1) 真实 K 线 (1h, days+1 天预热) (Real 1h klines with warm-up)
  // -------------------------------------------------------------------------
  // /klines 单次最多 1500 根；30 天 1h ≈ 720 根，足够留预热预算。
  const klineLimit = Math.min(days * 24 + 200, 1500);
  let rawKlines;
  try {
    rawKlines = await BinanceService.getKlines(symbol, '1h', klineLimit, market);
  } catch (err) {
    throw new Error(`无法获取真实历史 K 线，回测中止：${err.message}`);
  }
  if (!Array.isArray(rawKlines) || rawKlines.length < days * 24 / 2) {
    throw new Error(
      `历史 K 线数量不足 (got ${rawKlines && rawKlines.length}，至少需要 ${Math.floor(days * 24 / 2)})，回测中止`
    );
  }
  const candles = normalizeKlines(rawKlines);
  result.dataSources.klines = {
    endpoint: market === 'spot' ? '/api/v3/klines' : '/fapi/v1/klines',
    interval: '1h',
    bars: candles.length,
    firstOpenTime: candles[0].openTime,
    lastCloseTime: candles[candles.length - 1].closeTime
  };

  // -------------------------------------------------------------------------
  // 2) 真实日线 (用于 ILLIQ) (Real daily klines for Amihud ILLIQ)
  // -------------------------------------------------------------------------
  let dailyIlliq = [];
  try {
    const rawDaily = await BinanceService.getKlines(
      symbol,
      '1d',
      Math.min(days + opts.illiqLookback + 5, 200),
      market
    );
    const dailyCandles = normalizeKlines(rawDaily);
    dailyIlliq = computeIlliquidity(dailyCandles);
    result.dataSources.dailyKlines = {
      endpoint: market === 'spot' ? '/api/v3/klines' : '/fapi/v1/klines',
      interval: '1d',
      bars: dailyCandles.length
    };
  } catch (err) {
    // ILLIQ 不是必备条件，缺失则跳过该指标
    result.warnings.push(`ILLIQ 数据获取失败，已跳过：${err.message}`);
    result.skippedIndicators.push('ILLIQ (Amihud illiquidity ratio)');
  }

  // -------------------------------------------------------------------------
  // 3) 真实资金费率历史（仅合约） (Real funding rate history · futures only)
  // -------------------------------------------------------------------------
  let fundingByHour = new Map(); // hourTs → fundingRate (将每条 funding 同步到所在小时)
  if (market === 'futures') {
    try {
      const fundingHist = await BinanceFutures.getFundingRate(symbol, 1000);
      for (const f of fundingHist || []) {
        const hourTs = Math.floor(Number(f.fundingTime) / HOUR_MS) * HOUR_MS;
        fundingByHour.set(hourTs, Number(f.fundingRate));
      }
      result.dataSources.fundingRate = {
        endpoint: '/fapi/v1/fundingRate',
        records: fundingHist ? fundingHist.length : 0
      };
    } catch (err) {
      result.warnings.push(`资金费率历史获取失败，已跳过：${err.message}`);
      result.skippedIndicators.push('funding rate extreme / mean-reversion');
    }
  } else {
    result.skippedIndicators.push('funding rate (现货市场无资金费率)');
  }

  // -------------------------------------------------------------------------
  // 4) 真实 aggTrades → 小时 CVD (THE essential one)
  // -------------------------------------------------------------------------
  // 这一步是「真实 CVD」的来源。失败 = 整体回测中止，不允许任何模拟兜底。
  let aggBundle;
  try {
    aggBundle = await fetchHistoricalAggTrades({
      symbol,
      market,
      days,
      log: (m) => log(m)
    });
  } catch (err) {
    throw new Error(`无法获取真实历史成交数据 (aggTrades)，回测中止：${err.message}`);
  }
  result.dataSources.aggTrades = {
    source: aggBundle.source,
    daysRequested: days,
    daysSucceeded: aggBundle.coverage.daysSucceeded,
    daysMissing: aggBundle.coverage.daysMissing,
    hoursCovered: aggBundle.coverage.hoursCovered,
    expectedHours: aggBundle.coverage.expectedHours,
    totalBytes: aggBundle.downloads.reduce((s, d) => s + (d.bytes || 0), 0),
    totalProcessedRows: aggBundle.downloads.reduce((s, d) => s + d.processed, 0),
    missingDays: aggBundle.missingDays.map((m) => m.date)
  };
  if (aggBundle.missingDays.length > 0) {
    // missing days 是常态（最近 1-2 天 zip 通常未上架），转成 warning 给前端
    // (Missing days are normal — recent 1-2 days lag — surface as warning.)
    result.warnings.push(
      `${aggBundle.missingDays.length} 天的 aggTrades zip 未在 data.binance.vision 上架（已跳过）：` +
      aggBundle.missingDays.map((m) => m.date).join(', ') +
      '。这是 daily 文件 T+1~T+2 上架的正常滞后，不影响其他天数据。'
    );
  }

  // -------------------------------------------------------------------------
  // 5) 把真实 CVD/Delta 合并到 K 线 (Merge real Delta/CVD onto each candle)
  // -------------------------------------------------------------------------
  let cumCvd = 0;
  for (const c of candles) {
    const hourTs = Math.floor(c.openTime / HOUR_MS) * HOUR_MS;
    const bucket = aggBundle.buckets.get(hourTs);
    if (bucket) {
      c.realBuyVolume = bucket.buyVolume;
      c.realSellVolume = bucket.sellVolume;
      c.realDelta = bucket.buyVolume - bucket.sellVolume;
      c.realTrades = bucket.trades;
      cumCvd += c.realDelta;
    } else {
      c.realBuyVolume = null;
      c.realSellVolume = null;
      c.realDelta = null;
      c.realTrades = 0;
    }
    c.realCvd = cumCvd;
  }

  // CVD 覆盖率 (Coverage check)：
  // 若覆盖率过低，仍允许跑但在 warnings 中告警；前端可以提示用户。
  const coveredHours = candles.filter((c) => c.realDelta !== null).length;
  const coverageRatio = candles.length ? coveredHours / candles.length : 0;
  result.dataSources.aggTrades.coverageRatio = Number(coverageRatio.toFixed(4));
  if (coverageRatio < 0.5) {
    throw new Error(
      `真实成交数据覆盖率仅 ${(coverageRatio * 100).toFixed(1)}%，不足以完成回测`
    );
  } else if (coverageRatio < 0.95) {
    result.warnings.push(
      `真实成交数据覆盖率 ${(coverageRatio * 100).toFixed(1)}%，部分小时缺失，对应 K 线的 CVD 投票将弃权`
    );
  }

  // -------------------------------------------------------------------------
  // 6) 预计算其余指标 (Precompute remaining indicators)
  // -------------------------------------------------------------------------
  const vwap = computeVWAP(candles);
  const atr = computeATR(candles, opts.atrPeriod);
  const mfi = computeMFI(candles, opts.mfiPeriod);
  const fvgs = detectFVGs(candles);
  const liquidityVoids = detectLiquidityVoids(candles);
  const fvgsByType = { bullish: [], bearish: [] };
  for (const f of fvgs) fvgsByType[f.type].push(f);

  // 把 ILLIQ 索引到日 → 用于 1h K 线对应日的 ILLIQ 查询
  const illiqByDay = new Map();
  for (const row of dailyIlliq) {
    illiqByDay.set(Math.floor(row.openTime / DAY_MS) * DAY_MS, row.illiq);
  }
  // 滚动中位数（近 illiqLookback 天）
  function rollingIlliqMedian(idxDay) {
    const sorted = dailyIlliq
      .filter((r) => r.openTime <= idxDay && r.openTime > idxDay - opts.illiqLookback * DAY_MS)
      .map((r) => r.illiq)
      .sort((a, b) => a - b);
    if (sorted.length === 0) return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // 滚动 Pearson 相关 (rolling Pearson) for CVD vs price
  function rollingCorrCvdPrice(idx) {
    const w = opts.cvdCorrWindow;
    if (idx < w) return null;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0, sumYY = 0;
    let n = 0;
    for (let j = idx - w + 1; j <= idx; j += 1) {
      const cv = candles[j].realCvd;
      const px = candles[j].close;
      if (!Number.isFinite(cv) || !Number.isFinite(px)) continue;
      sumX += px; sumY += cv;
      sumXY += px * cv;
      sumXX += px * px;
      sumYY += cv * cv;
      n += 1;
    }
    if (n < w * 0.6) return null;
    const numerator = n * sumXY - sumX * sumY;
    const denom = Math.sqrt((n * sumXX - sumX * sumX) * (n * sumYY - sumY * sumY));
    if (denom <= 0) return null;
    return numerator / denom;
  }

  // -------------------------------------------------------------------------
  // 7) 主回测循环 (Main backtest loop)
  // -------------------------------------------------------------------------
  let balance = initialBalance;
  let peak = balance;
  let maxDrawdown = 0;
  const equityCurve = [];
  const drawdownCurve = [];
  const trades = [];
  let openTrade = null;

  for (let i = opts.warmupBars; i < candles.length; i += 1) {
    const c = candles[i];

    // (a) 已有仓位先处理 (Process open trade first)
    if (openTrade) {
      processOpenTrade(openTrade, c, opts);
      if (openTrade.closed) {
        balance += openTrade.realizedPnl;
        trades.push(finalizeTrade(openTrade));
        openTrade = null;
      }
    }

    // (b) 记录权益曲线 (Equity curve incl. unrealized P&L)
    const unrealized = openTrade ? markToMarket(openTrade, c.close) : 0;
    const equity = balance + unrealized;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
    equityCurve.push({ time: c.closeTime, equity: round(equity, 4), balance: round(balance, 4) });
    drawdownCurve.push({ time: c.closeTime, drawdown: round(dd, 6) });

    if (openTrade) continue;

    // (c) 评估信号 (Evaluate vote-based signal)
    const evalCtx = {
      i, candles, vwap, atr, mfi, fvgsByType, liquidityVoids, opts,
      fundingByHour, illiqByDay, rollingIlliqMedian, rollingCorrCvdPrice, market
    };
    const signal = evaluateSignal(evalCtx);
    if (!signal) continue;
    if (i + 1 >= candles.length) continue;

    // (d) 入场 (Open at next bar's open + slippage)
    const nextBar = candles[i + 1];
    const entryPrice = applyEntrySlippage(nextBar.open, signal.side, opts);
    const lastAtr = atr[i];
    if (!Number.isFinite(lastAtr) || lastAtr <= 0) continue;

    let stopDistance = lastAtr * opts.atrMultiplierSL;
    let stopLoss = signal.side === 'LONG' ? entryPrice - stopDistance : entryPrice + stopDistance;

    // FVG / Swing 收紧止损 (Tighten SL using recent FVG / swing if possible)
    if (signal.side === 'LONG') {
      const recentBullFvg = lastFvgWithin(fvgsByType.bullish, c.closeTime, opts.fvgLookback, candles);
      if (recentBullFvg) {
        const fvgSL = recentBullFvg.lower - lastAtr * 0.5;
        if (fvgSL < entryPrice && (entryPrice - fvgSL) > 0) {
          stopLoss = Math.max(stopLoss, fvgSL);
        }
      }
      const swingLow = swingExtreme(candles, i, 5, 'low');
      if (swingLow && swingLow < entryPrice) {
        stopLoss = Math.max(stopLoss, swingLow - lastAtr * 0.25);
      }
    } else {
      const recentBearFvg = lastFvgWithin(fvgsByType.bearish, c.closeTime, opts.fvgLookback, candles);
      if (recentBearFvg) {
        const fvgSL = recentBearFvg.upper + lastAtr * 0.5;
        if (fvgSL > entryPrice) stopLoss = Math.min(stopLoss, fvgSL);
      }
      const swingHigh = swingExtreme(candles, i, 5, 'high');
      if (swingHigh && swingHigh > entryPrice) {
        stopLoss = Math.min(stopLoss, swingHigh + lastAtr * 0.25);
      }
    }
    stopDistance = Math.abs(entryPrice - stopLoss);
    if (!Number.isFinite(stopDistance) || stopDistance <= 0) continue;

    const riskAmount = (balance * opts.riskPercent) / 100;
    const positionSize = riskAmount / stopDistance;

    const tps = opts.rMultipliers.map((m, idx) => ({
      price: signal.side === 'LONG'
        ? entryPrice + lastAtr * m
        : entryPrice - lastAtr * m,
      closeFraction: opts.closeFractions[idx],
      hit: false
    }));

    openTrade = {
      side: signal.side,
      reason: signal.reason,
      conditions: signal.conditions,
      voteScore: signal.voteScore,
      entryTime: nextBar.openTime,
      entryPrice,
      entryIdx: i + 1,
      stopLoss,
      stopDistance,
      takeProfits: tps,
      positionSize,
      remainingFraction: 1,
      realizedPnl: 0,
      barsHeld: 0,
      events: [],
      closed: false,
      exitTime: null,
      exitPrice: null,
      exitReason: null,
      // 胜负判定标记 (Outcome flags)：
      //   tp1Hit  → 第一止盈命中过，整笔记 WIN（无论后续 SL 是否生效）
      //   slHit   → 止损被触发过
      //   tp1Hit && !slHit  ⇒ 'WIN'
      //   slHit && !tp1Hit  ⇒ 'LOSS'
      //   其它 (timeStop / EOD)  ⇒ 'OPEN_END'，不计入胜负率分母
      tp1Hit: false,
      slHit: false,
      indicatorsAtEntry: signal.indicatorsAtEntry
    };
    openTrade.realizedPnl -= entryPrice * positionSize * opts.feeRate; // 入场手续费
    openTrade.events.push({
      time: nextBar.openTime,
      type: 'OPEN',
      price: entryPrice,
      size: positionSize
    });
  }

  // 收尾 (Close-out at EOD)
  if (openTrade) {
    const last = candles[candles.length - 1];
    closeRemaining(openTrade, last.close, last.closeTime, 'EOD', opts);
    balance += openTrade.realizedPnl;
    trades.push(finalizeTrade(openTrade));
    openTrade = null;
  }

  if (trades.length === 0) {
    result.notes.push(`回测期内 (${days} 天) 没有任何符合条件的交易信号 (zero qualifying signals).`);
  }

  // -------------------------------------------------------------------------
  // 8) 汇总 (Summary)
  // -------------------------------------------------------------------------
  const summary = buildSummary(trades, initialBalance, balance, maxDrawdown, candles);
  return {
    ...result,
    summary,
    trades,
    equityCurve,
    drawdownCurve,
    metadata: {
      strategy: 'Real-data vote: VWAP + FVG + MFI + ATR + 真实CVD + 资金费率 + ILLIQ',
      candleCount: candles.length,
      tradedFromIdx: opts.warmupBars,
      options: opts,
      firstCandleTime: candles[0].openTime,
      lastCandleTime: candles[candles.length - 1].closeTime
    }
  };
}

// ===========================================================================
// 信号评估 · 投票制 (Vote-based signal)
// ===========================================================================
function evaluateSignal(ctx) {
  const { i, candles, vwap, atr, mfi, fvgsByType, liquidityVoids, opts,
    fundingByHour, illiqByDay, rollingIlliqMedian, rollingCorrCvdPrice, market } = ctx;
  const c = candles[i];
  const vwapV = vwap[i];
  const atrV = atr[i];
  const mfiV = mfi[i];
  if (!Number.isFinite(vwapV) || !Number.isFinite(atrV) || atrV <= 0) return null;
  if (mfiV === null || mfiV === undefined) return null;
  if (c.realDelta === null) return null; // 当前小时 CVD 缺失则不出信号

  const conditions = [];
  let longVotes = 0;
  let shortVotes = 0;

  // ---- 条件 1: 价格 vs VWAP ----
  if (c.close > vwapV) { conditions.push({ name: 'price>VWAP', side: 'LONG', ok: true }); longVotes += 1; }
  else if (c.close < vwapV) { conditions.push({ name: 'price<VWAP', side: 'SHORT', ok: true }); shortVotes += 1; }

  // ---- 条件 2: 近 N 根 FVG ----
  const lookbackStart = candles[Math.max(0, i - opts.fvgLookback)].openTime;
  const recentBull = fvgsByType.bullish.some((f) => f.endTime >= lookbackStart && f.endTime <= c.closeTime);
  const recentBear = fvgsByType.bearish.some((f) => f.endTime >= lookbackStart && f.endTime <= c.closeTime);
  if (recentBull && !recentBear) { conditions.push({ name: 'recentBullishFVG', side: 'LONG', ok: true }); longVotes += 1; }
  if (recentBear && !recentBull) { conditions.push({ name: 'recentBearishFVG', side: 'SHORT', ok: true }); shortVotes += 1; }

  // ---- 条件 3: MFI 区间过滤 (避免极端超买超卖入场) ----
  if (mfiV >= 30 && mfiV <= 70) {
    conditions.push({ name: 'mfi∈[30,70]', side: 'BOTH', ok: true });
    // 中性条件不算票，但 MFI 极端反向加票 ↓
  } else if (mfiV < 30) {
    conditions.push({ name: 'mfi<30 (oversold)', side: 'LONG', ok: true });
    longVotes += 1;
  } else if (mfiV > 70) {
    conditions.push({ name: 'mfi>70 (overbought)', side: 'SHORT', ok: true });
    shortVotes += 1;
  }

  // ---- 条件 4: 真实 CVD vs 价格 滚动相关 ----
  const corr = rollingCorrCvdPrice(i);
  if (corr !== null && Number.isFinite(corr)) {
    if (corr >= opts.cvdCorrThreshold && c.realDelta > 0) {
      conditions.push({ name: `realCVD↑ corr=${corr.toFixed(2)}`, side: 'LONG', ok: true });
      longVotes += 1;
    } else if (corr <= -opts.cvdCorrThreshold && c.realDelta < 0) {
      conditions.push({ name: `realCVD↓ corr=${corr.toFixed(2)}`, side: 'SHORT', ok: true });
      shortVotes += 1;
    }
  }

  // ---- 条件 5: 流动性空白 (liquidity void) ----
  // 价格穿过 void 的方向给 1 票（突破真空带 → 顺势）
  for (const v of liquidityVoids) {
    if (c.openTime > v.endTime && c.openTime - v.endTime < HOUR_MS * 12) {
      if (c.close > v.upper) { conditions.push({ name: 'breakAboveVoid', side: 'LONG', ok: true }); longVotes += 1; break; }
      if (c.close < v.lower) { conditions.push({ name: 'breakBelowVoid', side: 'SHORT', ok: true }); shortVotes += 1; break; }
    }
  }

  // ---- 条件 6: ILLIQ 流动性枯竭过滤 ----
  // 极度非流动性 (ILLIQ 远高于近 7 日中位数) → 拒绝任何信号
  const dayKey = Math.floor(c.openTime / DAY_MS) * DAY_MS;
  const todayIlliq = illiqByDay.get(dayKey);
  if (todayIlliq !== undefined) {
    const med = rollingIlliqMedian(dayKey);
    if (med && med > 0 && todayIlliq > med * 5) {
      conditions.push({ name: `ILLIQ极端(${(todayIlliq / med).toFixed(1)}x)`, side: 'BLOCK', ok: true });
      return null;
    } else {
      conditions.push({ name: 'ILLIQ正常', side: 'BOTH', ok: true });
    }
  }

  // ---- 条件 7: 资金费率均值回归 (futures only) ----
  if (market === 'futures' && fundingByHour.size > 0) {
    // 找最近一次 funding（≤ 当前小时）
    const hourTs = Math.floor(c.openTime / HOUR_MS) * HOUR_MS;
    let lastFr = null;
    for (let h = hourTs; h >= hourTs - 24 * HOUR_MS; h -= HOUR_MS) {
      if (fundingByHour.has(h)) { lastFr = fundingByHour.get(h); break; }
    }
    if (lastFr !== null && Number.isFinite(lastFr)) {
      const bps = lastFr * 10000;
      if (bps >= opts.fundingExtremeBps) {
        // 多头过热 → 加 1 票空 (mean-reversion)
        conditions.push({ name: `funding+${bps.toFixed(2)}bps→meanRevert`, side: 'SHORT', ok: true });
        shortVotes += 1;
      } else if (bps <= -opts.fundingExtremeBps) {
        conditions.push({ name: `funding${bps.toFixed(2)}bps→meanRevert`, side: 'LONG', ok: true });
        longVotes += 1;
      }
    }
  }

  // ---- 投票出信号 (Resolve votes) ----
  let side = null;
  let voteScore = 0;
  if (longVotes >= 3 && longVotes > shortVotes) {
    side = 'LONG';
    voteScore = longVotes - shortVotes;
  } else if (shortVotes >= 3 && shortVotes > longVotes) {
    side = 'SHORT';
    voteScore = shortVotes - longVotes;
  }
  if (!side) return null;

  return {
    side,
    voteScore,
    reason: `${side} votes=${longVotes}-${shortVotes}`,
    conditions,
    indicatorsAtEntry: {
      vwap: round(vwapV, 4),
      atr: round(atrV, 4),
      mfi: round(mfiV, 2),
      cvd: round(c.realCvd, 4),
      delta: round(c.realDelta, 4),
      cvdPriceCorr: corr === null ? null : round(corr, 3),
      illiq: todayIlliq === undefined ? null : round(todayIlliq, 6),
      fundingBpsAtBar: market === 'futures' ? snapshotFundingBps(fundingByHour, c.openTime) : null
    }
  };
}

function snapshotFundingBps(fundingByHour, ts) {
  const hourTs = Math.floor(ts / HOUR_MS) * HOUR_MS;
  for (let h = hourTs; h >= hourTs - 24 * HOUR_MS; h -= HOUR_MS) {
    if (fundingByHour.has(h)) return round(fundingByHour.get(h) * 10000, 4);
  }
  return null;
}

function lastFvgWithin(list, currentCloseTime, lookbackBars, candles) {
  if (!list.length) return null;
  const idx = candles.findIndex((c) => c.closeTime === currentCloseTime);
  if (idx < 0) return null;
  const startTime = candles[Math.max(0, idx - lookbackBars)].openTime;
  let best = null;
  for (const f of list) {
    if (f.endTime >= startTime && f.endTime <= currentCloseTime) {
      if (!best || f.endTime > best.endTime) best = f;
    }
  }
  return best;
}

function swingExtreme(candles, idx, lookback, key) {
  let v = candles[idx][key];
  for (let j = Math.max(0, idx - lookback); j <= idx; j += 1) {
    if (key === 'low' && candles[j].low < v) v = candles[j].low;
    if (key === 'high' && candles[j].high > v) v = candles[j].high;
  }
  return v;
}

// ===========================================================================
// 持仓管理 / 撮合 (Position management & fills)
// ===========================================================================
function processOpenTrade(trade, candle, opts) {
  trade.barsHeld += 1;
  const { side } = trade;
  const high = candle.high;
  const low = candle.low;

  // 保守原则：SL 与 TP 同根 K 线，先按 SL 触发
  // (Conservative: SL takes precedence when both fire on the same bar.)
  const slHit = side === 'LONG' ? low <= trade.stopLoss : high >= trade.stopLoss;
  if (slHit) {
    trade.slHit = true; // 即使后面 TP 也命中，整笔仍记录 SL 已触发过
    closeRemaining(trade, trade.stopLoss, candle.closeTime, 'STOP_LOSS', opts);
    return;
  }

  for (let tpIdx = 0; tpIdx < trade.takeProfits.length; tpIdx += 1) {
    const tp = trade.takeProfits[tpIdx];
    if (tp.hit) continue;
    const reached = side === 'LONG' ? high >= tp.price : low <= tp.price;
    if (!reached) continue;
    tp.hit = true;
    if (tpIdx === 0) trade.tp1Hit = true; // 用户口径：触发第一止盈即算胜
    const closeQty = trade.positionSize * tp.closeFraction;
    const exitPx = applyExitSlippage(tp.price, side, opts);
    const pnl = side === 'LONG'
      ? (exitPx - trade.entryPrice) * closeQty
      : (trade.entryPrice - exitPx) * closeQty;
    const fee = exitPx * closeQty * opts.feeRate;
    trade.realizedPnl += pnl - fee;
    trade.remainingFraction -= tp.closeFraction;
    trade.events.push({
      time: candle.closeTime,
      type: 'TP_HIT',
      tpIndex: tpIdx,
      price: exitPx,
      closeFraction: tp.closeFraction,
      pnl: round(pnl - fee, 4)
    });
  }

  if (trade.remainingFraction <= 1e-8) {
    trade.closed = true;
    trade.exitTime = candle.closeTime;
    trade.exitPrice = trade.takeProfits[trade.takeProfits.length - 1].price;
    trade.exitReason = 'ALL_TP';
    return;
  }

  if (trade.barsHeld >= opts.maxBarsInTrade) {
    closeRemaining(trade, candle.close, candle.closeTime, 'TIME_STOP', opts);
  }
}

function closeRemaining(trade, exitPrice, exitTime, reason, opts) {
  if (trade.remainingFraction <= 1e-8) {
    trade.closed = true;
    trade.exitTime = exitTime;
    trade.exitPrice = exitPrice;
    trade.exitReason = reason;
    return;
  }
  const closeQty = trade.positionSize * trade.remainingFraction;
  const exitPx = applyExitSlippage(exitPrice, trade.side, opts);
  const pnl = trade.side === 'LONG'
    ? (exitPx - trade.entryPrice) * closeQty
    : (trade.entryPrice - exitPx) * closeQty;
  const fee = exitPx * closeQty * opts.feeRate;
  trade.realizedPnl += pnl - fee;
  trade.remainingFraction = 0;
  trade.closed = true;
  trade.exitTime = exitTime;
  trade.exitPrice = exitPx;
  trade.exitReason = reason;
  trade.events.push({
    time: exitTime,
    type: reason,
    price: exitPx,
    closeFraction: 1,
    pnl: round(pnl - fee, 4)
  });
}

function markToMarket(trade, lastPrice) {
  if (trade.closed || trade.remainingFraction <= 0) return 0;
  const qty = trade.positionSize * trade.remainingFraction;
  return trade.side === 'LONG'
    ? (lastPrice - trade.entryPrice) * qty
    : (trade.entryPrice - lastPrice) * qty;
}

function applyEntrySlippage(price, side, opts) {
  return side === 'LONG'
    ? price * (1 + opts.slippagePct)
    : price * (1 - opts.slippagePct);
}
function applyExitSlippage(price, side, opts) {
  return side === 'LONG'
    ? price * (1 - opts.slippagePct)
    : price * (1 + opts.slippagePct);
}

function finalizeTrade(t) {
  // ---- 用户口径胜负判定 (User-spec outcome) ----
  // 'WIN'      → 第一止盈被触发（TP1 命中）
  // 'LOSS'     → 没有触发 TP1 但触发了止损 SL
  // 'OPEN_END' → 既未触发 TP1 也未触发 SL（time-stop / EOD 提前退出），不计入胜负
  let outcome;
  if (t.tp1Hit) outcome = 'WIN';
  else if (t.slHit) outcome = 'LOSS';
  else outcome = 'OPEN_END';

  return {
    side: t.side,
    reason: t.reason,
    voteScore: t.voteScore,
    conditions: t.conditions,
    entryTime: t.entryTime,
    entryPrice: round(t.entryPrice, 4),
    exitTime: t.exitTime,
    exitPrice: round(t.exitPrice, 4),
    exitReason: t.exitReason,
    outcome,
    tp1Hit: !!t.tp1Hit,
    slHit: !!t.slHit,
    stopLoss: round(t.stopLoss, 4),
    takeProfits: t.takeProfits.map((tp) => ({
      price: round(tp.price, 4),
      closeFraction: tp.closeFraction,
      hit: tp.hit
    })),
    positionSize: round(t.positionSize, 6),
    realizedPnl: round(t.realizedPnl, 4),
    barsHeld: t.barsHeld,
    events: t.events,
    indicatorsAtEntry: t.indicatorsAtEntry
  };
}

function buildSummary(trades, initialCapital, finalBalance, maxDrawdown, candles) {
  const totalTrades = trades.length;

  // ---- 用户口径：胜=TP1命中；负=未触发TP1但触发SL ----
  // (User spec: WIN = TP1 hit; LOSS = SL fired without prior TP1.)
  const wins = trades.filter((t) => t.outcome === 'WIN');
  const losses = trades.filter((t) => t.outcome === 'LOSS');
  const openEnded = trades.filter((t) => t.outcome === 'OPEN_END');
  const decided = wins.length + losses.length;
  const winRate = decided > 0 ? wins.length / decided : 0;
  // 备口径：按 P&L 正负 (legacy: by realized P&L sign) —— 仅供参考
  const winsByPnl = trades.filter((t) => t.realizedPnl > 0);
  const lossesByPnl = trades.filter((t) => t.realizedPnl <= 0);
  const winRateByPnl = totalTrades > 0 ? winsByPnl.length / totalTrades : 0;

  // 盈亏汇总仍按真实 P&L 计算（盈亏比 / 盈利因子 / 期望值都基于实际现金流）
  const grossProfit = wins.reduce((s, t) => s + t.realizedPnl, 0)
                    + openEnded.filter((t) => t.realizedPnl > 0).reduce((s, t) => s + t.realizedPnl, 0);
  const grossLoss = Math.abs(
    losses.reduce((s, t) => s + t.realizedPnl, 0)
    + openEnded.filter((t) => t.realizedPnl <= 0).reduce((s, t) => s + t.realizedPnl, 0)
  );
  const profitFactor = grossLoss > 0
    ? grossProfit / grossLoss
    : (grossProfit > 0 ? Infinity : 0);

  // 平均盈利：只看「TP1命中」组；平均亏损：只看「SL触发组」
  // 保证 payoffRatio 严格反映用户定义下「胜的钱 vs 负的钱」
  const avgWin = wins.length
    ? wins.reduce((s, t) => s + t.realizedPnl, 0) / wins.length
    : 0;
  const avgLoss = losses.length
    ? Math.abs(losses.reduce((s, t) => s + t.realizedPnl, 0)) / losses.length
    : 0;
  const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? Infinity : 0);

  const totalPnl = finalBalance - initialCapital;
  const totalReturnPct = initialCapital > 0 ? totalPnl / initialCapital : 0;
  const expectancy = decided > 0 ? winRate * avgWin - (1 - winRate) * avgLoss : 0;
  const periodMs = candles[candles.length - 1].closeTime - candles[0].openTime;
  const periodDays = periodMs / DAY_MS;

  return {
    initialCapital,
    finalBalance: round(finalBalance, 4),
    totalPnl: round(totalPnl, 4),
    totalReturnPct: round(totalReturnPct, 6),

    totalTrades,
    // 用户口径 (TP1 / SL based)
    winningTrades: wins.length,
    losingTrades: losses.length,
    openEndedTrades: openEnded.length,
    wins: wins.length,
    losses: losses.length,
    winRate: round(winRate, 4),

    // 备口径：按 P&L 正负
    winsByPnl: winsByPnl.length,
    lossesByPnl: lossesByPnl.length,
    winRateByPnl: round(winRateByPnl, 4),

    grossProfit: round(grossProfit, 4),
    grossLoss: round(grossLoss, 4),
    profitFactor: Number.isFinite(profitFactor) ? round(profitFactor, 3) : null,
    avgWin: round(avgWin, 4),
    avgLoss: round(avgLoss, 4),
    payoffRatio: Number.isFinite(payoffRatio) ? round(payoffRatio, 3) : null,
    expectancy: round(expectancy, 4),
    maxDrawdown: round(maxDrawdown, 4),
    maxDrawdownPct: round(maxDrawdown * 100, 2),
    periodDays: round(periodDays, 2)
  };
}

function round(x, digits = 4) {
  if (x === null || x === undefined) return x;
  if (!Number.isFinite(x)) return x;
  return Number(Number(x).toFixed(digits));
}

module.exports = {
  runBacktest,
  DEFAULT_OPTIONS
};
