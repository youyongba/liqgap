'use strict';

/**
 * GET /api/backtest/run
 *
 * 30 天策略回测 · 真实数据驱动 (Real-data driven 30-day backtest)
 *
 * 查询参数 (Query · 全部可选 / all optional):
 *   symbol           默认 'BTCUSDT'
 *   market           'spot' | 'futures'，默认 'futures'
 *   days             默认 30 (1-90)
 *   initialBalance   默认 1000 (USDT)，与文档保持一致
 *   initialCapital   兼容旧字段，等价于 initialBalance
 *   riskPercent      默认 1
 *
 * 重要约束 (Hard requirement):
 *   - 仅支持 1h 周期 (interval is locked to '1h' on the backend)，
 *     这与真实历史 aggTrades 按 1h 桶聚合一致。
 *   - 任何真实数据缺失（无法下载 aggTrades / K 线）→ HTTP 200 +
 *     { success: false, error: "无法获取真实历史成交数据，回测中止" }，
 *     绝不退化为模拟数据。
 *
 * 响应 (Success response):
 *   {
 *     success: true,
 *     data: {
 *       symbol, market, interval, days,
 *       initialBalance, finalBalance, totalTrades,
 *       winningTrades, losingTrades, winRate, profitFactor,
 *       maxDrawdown, trades, equityCurve, notes,
 *       summary, drawdownCurve, dataSources, skippedIndicators, ...
 *     }
 *   }
 */

const express = require('express');
const { runBacktest, DEFAULT_OPTIONS } = require('../indicators/backtest');

const router = express.Router();

router.get('/backtest/run', async (req, res) => {
  try {
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    const market = req.query.market === 'spot' ? 'spot' : 'futures';
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
    const initialBalance = Number(
      req.query.initialBalance != null ? req.query.initialBalance : req.query.initialCapital
    ) || 1000;
    const riskPercent = Number(req.query.riskPercent) || 1;

    const result = await runBacktest(symbol, initialBalance, days, {
      market,
      interval: '1h',
      options: {
        riskPercent,
        atrMultiplierSL: Number(req.query.atrMultiplierSL) || DEFAULT_OPTIONS.atrMultiplierSL,
        feeRate: req.query.feeRate != null ? Number(req.query.feeRate) : DEFAULT_OPTIONS.feeRate,
        slippagePct: req.query.slippagePct != null
          ? Number(req.query.slippagePct)
          : DEFAULT_OPTIONS.slippagePct
      },
      log: (m) => console.log(m) // eslint-disable-line no-console
    });

    // 把 Map 转成 plain JSON 友好结构
    // 同时把规范要求的几个顶层字段提到 data.* 上，方便前端直接读。
    const payload = {
      symbol: result.symbol,
      market: result.market,
      interval: result.interval,
      days: result.days,
      initialBalance: result.initialBalance,
      finalBalance: result.summary.finalBalance,
      totalTrades: result.summary.totalTrades,
      winningTrades: result.summary.winningTrades,
      losingTrades: result.summary.losingTrades,
      winRate: result.summary.winRate,
      profitFactor: result.summary.profitFactor,
      maxDrawdown: result.summary.maxDrawdown,
      trades: result.trades,
      equityCurve: result.equityCurve,
      drawdownCurve: result.drawdownCurve,
      notes: result.notes.join('\n'),
      noteList: result.notes,
      warnings: result.warnings,
      skippedIndicators: result.skippedIndicators,
      dataSources: result.dataSources,
      summary: result.summary,
      metadata: result.metadata
    };
    res.json({ success: true, data: payload });
  } catch (err) {
    // 这里不再 res.status(500)：回测失败也返回 HTTP 200 + success:false，
    // 前端可以稳定解析；message 已经包含原因 (e.g. "无法获取真实历史成交数据…")。
    console.error('[backtest] failed:', err.message); // eslint-disable-line no-console
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
