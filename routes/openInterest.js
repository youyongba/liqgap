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

// ---------------------------------------------------------------------------
// 多合约聚合 (Multi-contract aggregation)
// ---------------------------------------------------------------------------
// Coinglass 的「币安 OI」通常把同一标的的三类合约合并：
//   ① BTCUSDT  U 本位/USDT      fapi  symbol=BTCUSDT
//   ② BTCUSDC  U 本位/USDC      fapi  symbol=BTCUSDC
//   ③ BTCUSD   币本位 COIN-M    dapi  pair=BTCUSD, contractType=PERPETUAL
// 三家单位不同，统一换算成 (usd 名义价值, coin 币数) 再按时间戳相加。

// 币本位每张合约的 USD 面值：BTCUSD=100，其余主流=10
function coinmContractUsd(base) {
  return base === 'BTC' ? 100 : 10;
}

// 从 symbol 解析基础币种：BTCUSDT/BTCUSDC → BTC；BTCUSD → BTC
function parseBaseAsset(symbol) {
  const s = String(symbol).toUpperCase();
  if (s.endsWith('USDT') || s.endsWith('USDC')) return s.slice(0, -4);
  if (s.endsWith('USD')) return s.slice(0, -3);
  return s;
}

// 把 U 本位 (fapi) 原始样本归一化为 {ts, usd, coin}
//   sumOpenInterest = 币数 (coin)，sumOpenInterestValue = USDT/USDC ≈ USD
function _normalizeUsdM(raw) {
  return (Array.isArray(raw) ? raw : []).map((r) => ({
    ts: Number(r.timestamp),
    usd: Number(r.sumOpenInterestValue),
    coin: Number(r.sumOpenInterest)
  })).filter((p) => Number.isFinite(p.ts) && (Number.isFinite(p.usd) || Number.isFinite(p.coin)))
    .sort((a, b) => a.ts - b.ts);
}

// 把币本位 (dapi) 原始样本归一化为 {ts, usd, coin}
//   sumOpenInterest = 张数 → usd = 张数 × 每张面值
//   sumOpenInterestValue = 币数 (coin)
function _normalizeCoinM(raw, base) {
  const contractUsd = coinmContractUsd(base);
  return (Array.isArray(raw) ? raw : []).map((r) => ({
    ts: Number(r.timestamp),
    usd: Number(r.sumOpenInterest) * contractUsd,
    coin: Number(r.sumOpenInterestValue)
  })).filter((p) => Number.isFinite(p.ts) && (Number.isFinite(p.usd) || Number.isFinite(p.coin)))
    .sort((a, b) => a.ts - b.ts);
}

// 按时间戳合并多个源；每个源前向填充 (carry-forward) 避免缺样掉坑。
// 只从「所有在场源都已开始」的时间点起输出，避免左侧出现累加爬坡假象。
function _mergeSources(sources) {
  const present = sources.filter((s) => s.points && s.points.length);
  if (!present.length) return [];

  const tsSet = new Set();
  present.forEach((s) => s.points.forEach((p) => tsSet.add(p.ts)));
  const allTs = Array.from(tsSet).sort((a, b) => a - b);
  const startTs = Math.max(...present.map((s) => s.points[0].ts));

  const idx = present.map(() => 0);
  const last = present.map(() => null);
  const merged = [];

  for (const ts of allTs) {
    for (let k = 0; k < present.length; k += 1) {
      const pts = present[k].points;
      while (idx[k] < pts.length && pts[idx[k]].ts <= ts) {
        last[k] = pts[idx[k]];
        idx[k] += 1;
      }
    }
    if (ts < startTs) continue;
    let usd = 0;
    let coin = 0;
    let have = false;
    for (let k = 0; k < present.length; k += 1) {
      if (last[k]) {
        if (Number.isFinite(last[k].usd)) usd += last[k].usd;
        if (Number.isFinite(last[k].coin)) coin += last[k].coin;
        have = true;
      }
    }
    if (have) merged.push({ openTime: ts, openInterest: coin, openInterestValue: usd });
  }
  return merged;
}

// 聚合三类合约持仓量。任一源失败只记录、不影响其余源。
async function _aggregateOpenInterest(symbol, period, limit) {
  const base = parseBaseAsset(symbol);
  const usdtSym = `${base}USDT`;
  const usdcSym = `${base}USDC`;
  const coinPair = `${base}USD`;

  const [usdtRes, usdcRes, coinmRes] = await Promise.allSettled([
    BinanceService.getOpenInterestHist(usdtSym, period, limit),
    BinanceService.getOpenInterestHist(usdcSym, period, limit),
    BinanceService.getCoinMOpenInterestHist(coinPair, 'PERPETUAL', period, limit)
  ]);

  const usdtPts = usdtRes.status === 'fulfilled' ? _normalizeUsdM(usdtRes.value) : [];
  const usdcPts = usdcRes.status === 'fulfilled' ? _normalizeUsdM(usdcRes.value) : [];
  const coinmPts = coinmRes.status === 'fulfilled' ? _normalizeCoinM(coinmRes.value, base) : [];

  const sources = [
    { label: `${usdtSym} (USDT-M)`, points: usdtPts, ok: usdtRes.status === 'fulfilled', count: usdtPts.length },
    { label: `${usdcSym} (USDC-M)`, points: usdcPts, ok: usdcRes.status === 'fulfilled', count: usdcPts.length },
    { label: `${coinPair}_PERP (COIN-M)`, points: coinmPts, ok: coinmRes.status === 'fulfilled', count: coinmPts.length }
  ];

  const data = _mergeSources(sources);
  return {
    data,
    sources: sources.map((s) => ({
      label: s.label,
      ok: s.ok,
      count: s.count,
      error: s.ok ? null : 'fetch failed (可能该合约不存在或被限流)'
    }))
  };
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
  // aggregate=binance / 1 / true → 合并 USDT-M + USDC-M + COIN-M
  const aggregate = /^(binance|1|true|all)$/i.test(String(req.query.aggregate || ''));

  try {
    if (aggregate) {
      const { data: series, sources } = await _aggregateOpenInterest(symbol, period, limit);
      const okCount = sources.filter((s) => s.ok && s.count > 0).length;
      return res.json({
        success: true,
        data: {
          supported: true,
          symbol,
          market,
          interval: intervalRaw,
          period,
          fellBack,
          aggregated: true,
          sources,
          notes: [
            fellBack ? `OI 接口不支持 ${intervalRaw}，已回退到 ${period}` : null,
            `已合并 ${okCount}/3 类合约 (USDT-M + USDC-M + COIN-M 永续)`
          ].filter(Boolean).join('；') || null,
          data: series
        }
      });
    }

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
        aggregated: false,
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
