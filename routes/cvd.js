'use strict';

/**
 * GET /api/cvd
 *
 * 合约累积主动买卖差 (CVD delta series, USDⓈ-M + 可选多合约聚合)
 *
 * CVD（Cumulative Volume Delta）= Σ(主动买量 - 主动卖量)。本接口只返回**每根
 * K 线的 delta**（增量），由前端累加成曲线 —— 这样无论窗口从哪根开始，
 * 累计基准都一致，且能和主图 K 线时间轴严格对齐。
 *
 * 每根同时给两种口径，便于前端 coin/USD 切换且都能跨合约相加：
 *   delta    (币数 base asset, e.g. BTC) = 2 × takerBuyBase - baseVolume
 *   deltaUsd (USD 名义价值/报价额)        = 2 × takerBuyQuote - quoteVolume
 *
 * 查询参数 (Query):
 *   symbol      默认 BTCUSDT
 *   market      'futures'(默认) | 'spot'（spot 无聚合意义，但仍可单独返回）
 *   interval    K 线周期，1m/15m/1h/4h/1d 等
 *   limit       默认 200，最大 1000
 *   aggregate   binance/1/true → 合并 USDT-M + USDC-M + 币本位 COIN-M 永续
 *
 * 响应 (Response):
 *   { supported, symbol, market, interval, aggregated, sources?, data:[{openTime, delta, deltaUsd}] }
 *
 * 说明：
 *   - U 本位 (fapi) K 线：takerBuyBase=idx9, baseVolume=idx5；takerBuyQuote=idx10, quoteVolume=idx7
 *   - 币本位 (dapi) K 线：takerBuyBaseAssetVolume=idx10, baseAssetVolume=idx7（币数 BTC）；
 *       USD 口径用张数换算：deltaUsd = 每张USD × (2×takerBuyVol(idx9) - volume(idx5))
 *   - 任一源失败只记录、不影响其余源（graceful degrade）。
 */

const express = require('express');
const { BinanceService } = require('../services/binance');
const swrCache = require('../services/swrCache');

const router = express.Router();

// 从 symbol 解析基础币种：BTCUSDT/BTCUSDC → BTC；BTCUSD → BTC
function parseBaseAsset(symbol) {
  const s = String(symbol).toUpperCase();
  if (s.endsWith('USDT') || s.endsWith('USDC')) return s.slice(0, -4);
  if (s.endsWith('USD')) return s.slice(0, -3);
  return s;
}

// 币本位每张合约 USD 面值（BTC=100，其余=10）
function coinmContractUsd(base) {
  return base === 'BTC' ? 100 : 10;
}

// U 本位 (fapi) K 线 → 每根 {openTime, delta(币数), deltaUsd(报价额≈USD)}
function _deltasFapi(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => {
    const baseVol = Number(r[5]);
    const quoteVol = Number(r[7]);
    const takerBuyBase = Number(r[9]);
    const takerBuyQuote = Number(r[10]);
    return {
      openTime: Number(r[0]),
      delta: 2 * takerBuyBase - baseVol,
      deltaUsd: 2 * takerBuyQuote - quoteVol
    };
  }).filter((p) => Number.isFinite(p.openTime) && Number.isFinite(p.delta));
}

// 币本位 (dapi) K 线 → 每根 {openTime, delta(币数 BTC), deltaUsd(用张数×每张USD换算)}
function _deltasDapi(rows, base) {
  const contractUsd = coinmContractUsd(base);
  return (Array.isArray(rows) ? rows : []).map((r) => {
    const baseVol = Number(r[7]);            // baseAssetVolume (BTC)
    const takerBuyBase = Number(r[10]);      // takerBuyBaseAssetVolume (BTC)
    const volContracts = Number(r[5]);       // volume (张数)
    const takerBuyContracts = Number(r[9]);  // takerBuyVolume (张数)
    return {
      openTime: Number(r[0]),
      delta: 2 * takerBuyBase - baseVol,
      deltaUsd: contractUsd * (2 * takerBuyContracts - volContracts)
    };
  }).filter((p) => Number.isFinite(p.openTime) && Number.isFinite(p.delta));
}

// 按 openTime 求和多个源的 delta / deltaUsd（缺某根 bar 的源按 0 计入，不前向填充）
function _mergeDeltas(sources) {
  const map = new Map();
  for (const s of sources) {
    for (const p of s.points) {
      const cur = map.get(p.openTime) || { delta: 0, deltaUsd: 0 };
      cur.delta += Number.isFinite(p.delta) ? p.delta : 0;
      cur.deltaUsd += Number.isFinite(p.deltaUsd) ? p.deltaUsd : 0;
      map.set(p.openTime, cur);
    }
  }
  return Array.from(map.entries())
    .map(([openTime, v]) => ({ openTime, delta: v.delta, deltaUsd: v.deltaUsd }))
    .sort((a, b) => a.openTime - b.openTime);
}

router.get('/cvd', async (req, res) => {
  const symbol = String(req.query.symbol || 'BTCUSDT').toUpperCase();
  const market = req.query.market === 'spot' ? 'spot' : 'futures';
  const interval = String(req.query.interval || '1h');
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 200, 1000));
  const aggregate = /^(binance|1|true|all)$/i.test(String(req.query.aggregate || ''));

  // 真实取数（仅在 SWR 缓存需要刷新时执行）
  const buildPayload = async () => {
    // 单一模式（含 spot / 聚合对现货无意义）：只取当前 symbol
    if (!aggregate || market !== 'futures') {
      const rows = await BinanceService.getKlines(symbol, interval, limit, market);
      return {
        supported: true,
        symbol,
        market,
        interval,
        aggregated: false,
        data: _deltasFapi(rows)
      };
    }

    const base = parseBaseAsset(symbol);
    const [usdtRes, usdcRes, coinmRes] = await Promise.allSettled([
      BinanceService.getKlines(`${base}USDT`, interval, limit, 'futures'),
      BinanceService.getKlines(`${base}USDC`, interval, limit, 'futures'),
      BinanceService.getCoinMKlines(`${base}USD_PERP`, interval, limit)
    ]);

    const usdtPts = usdtRes.status === 'fulfilled' ? _deltasFapi(usdtRes.value) : [];
    const usdcPts = usdcRes.status === 'fulfilled' ? _deltasFapi(usdcRes.value) : [];
    const coinmPts = coinmRes.status === 'fulfilled' ? _deltasDapi(coinmRes.value, base) : [];

    const sources = [
      { label: `${base}USDT (USDT-M)`, points: usdtPts, ok: usdtRes.status === 'fulfilled', count: usdtPts.length },
      { label: `${base}USDC (USDC-M)`, points: usdcPts, ok: usdcRes.status === 'fulfilled', count: usdcPts.length },
      { label: `${base}USD_PERP (COIN-M)`, points: coinmPts, ok: coinmRes.status === 'fulfilled', count: coinmPts.length }
    ];
    const data = _mergeDeltas(sources);
    const okCount = sources.filter((s) => s.ok && s.count > 0).length;
    // 三源全挂 → 抛错（不落 SWR 缓存），见 openInterest.js 同款守卫
    if (okCount === 0 && data.length === 0) {
      throw new Error('CVD 三类合约源全部拉取失败 (all CVD sources failed)');
    }

    return {
      supported: true,
      symbol,
      market,
      interval,
      aggregated: true,
      sources: sources.map((s) => ({
        label: s.label,
        ok: s.ok,
        count: s.count,
        error: s.ok ? null : 'fetch failed (可能该合约不存在或被限流)'
      })),
      notes: `已合并 ${okCount}/3 类合约 CVD (USDT-M + USDC-M + COIN-M 永续)`,
      data
    };
  };

  try {
    // SWR：命中缓存毫秒级返回；过期先回旧值后台刷新；
    // 冷启动最多等 8s（远离网关 15s 红线）
    const cacheKey = `cvd|${symbol}|${market}|${interval}|${limit}|${aggregate ? 1 : 0}`;
    const { value } = await swrCache.swr(cacheKey, buildPayload, {
      ttlMs: 10_000, staleMaxMs: 10 * 60_000, budgetMs: 8_000
    });
    res.json({ success: true, data: value });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[cvd] failed:', err.message);
    res.json({
      success: false,
      error: err.message,
      data: { supported: true, symbol, market, interval, aggregated: aggregate, data: [] }
    });
  }
});

module.exports = router;
