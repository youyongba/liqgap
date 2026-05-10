'use strict';

/**
 * GET /api/openInterest
 *
 * 持仓量历史 (USDⓈ-M Futures Open Interest history)
 *
 * 用法 (Usage)：与 K 线时间轴一一对齐，让前端把它叠加在副图区域，
 * 配合 CVD 判断市场资金方向：
 *   - OI ↑ + CVD ↓  → 新空单进场，做空主导 (short build-up)
 *   - OI ↑ + CVD ↑  → 新多单进场，做多主导 (long build-up)
 *   - OI ↓ + CVD ↑  → 空头平仓，轧空 (short covering)
 *   - OI ↓ + CVD ↓  → 多头平仓 / 止损 (long unwind)
 *
 * 查询参数 (Query):
 *   symbol     必填，e.g. BTCUSDT
 *   interval   K 线 interval，1s/15m/1h/4h/1d 等，会自动映射到 OI 支持的 period
 *   limit      默认 200，最大 500
 *   market     'futures' (默认) | 'spot'
 *
 * 响应 (Response):
 *   现货 / 不支持: { supported: false, reason, market, symbol, interval, data: [] }
 *   合约成功:      { supported: true,  symbol, market, interval, period,
 *                    data: [{ openTime, openInterest, openInterestValue }, ...] }
 *
 * 设计说明：
 *   - Binance OI hist 仅支持 5m/15m/30m/1h/2h/4h/6h/12h/1d。
 *     若用户当前 K 线 interval 是 1s/1m/3m，自动 fallback 到 5m，
 *     并在 response.notes 里说明。
 *   - 时间戳用 `openTime` 字段名（与 K 线一致），方便前端直接对齐时间轴。
 */

const express = require('express');
const { BinanceService } = require('../services/binance');

const router = express.Router();

// Binance 持仓量接口支持的 period 白名单
const OI_SUPPORTED_PERIODS = new Set(['5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d']);

/** 把 K 线 interval 映射到 OI 接口支持的 period */
function mapIntervalToOiPeriod(interval) {
  if (OI_SUPPORTED_PERIODS.has(interval)) return interval;
  // 1s / 1m / 3m → 5m；其它未知 interval 也兜底到 5m
  return '5m';
}

router.get('/openInterest', async (req, res) => {
  const symbol = String(req.query.symbol || 'BTCUSDT').toUpperCase();
  const market = req.query.market === 'spot' ? 'spot' : 'futures';
  const intervalRaw = String(req.query.interval || '1h');
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 200, 500));

  // 现货市场没有持仓量概念，直接告诉前端（仍用项目统一的 success 包结构）
  if (market !== 'futures') {
    return res.json({
      success: true,
      data: {
        supported: false,
        reason: '现货市场无持仓量数据 (Spot has no Open Interest)',
        market,
        symbol,
        interval: intervalRaw,
        data: []
      }
    });
  }

  const period = mapIntervalToOiPeriod(intervalRaw);
  const fellBack = period !== intervalRaw;

  try {
    const raw = await BinanceService.getOpenInterestHist(symbol, period, limit);
    const series = (Array.isArray(raw) ? raw : []).map((row) => ({
      openTime: Number(row.timestamp),
      openInterest: Number(row.sumOpenInterest),
      openInterestValue: Number(row.sumOpenInterestValue)
    })).filter((p) =>
      Number.isFinite(p.openTime) && Number.isFinite(p.openInterest)
    ).sort((a, b) => a.openTime - b.openTime);

    res.json({
      success: true,
      data: {
        supported: true,
        symbol,
        market,
        interval: intervalRaw,
        period,
        fellBack,
        notes: fellBack
          ? `OI 接口不支持 ${intervalRaw}，已回退到 ${period}`
          : null,
        data: series
      }
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[openInterest] failed:', err.message);
    res.json({
      success: false,
      error: err.message,
      data: {
        supported: true,
        symbol,
        market,
        interval: intervalRaw,
        period,
        fellBack,
        data: []
      }
    });
  }
});

module.exports = router;
