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
 * 每根 delta 统一用**币数 (base asset, e.g. BTC)** 口径，便于跨合约相加：
 *   delta = 2 × takerBuyBase - baseVolume
 *
 * 查询参数 (Query):
 *   symbol      默认 BTCUSDT
 *   market      'futures'(默认) | 'spot'（spot 无聚合意义，但仍可单独返回）
 *   interval    K 线周期，1m/15m/1h/4h/1d 等
 *   limit       默认 200，最大 1000
 *   aggregate   binance/1/true → 合并 USDT-M + USDC-M + 币本位 COIN-M 永续
 *
 * 响应 (Response):
 *   { supported, symbol, market, interval, aggregated, sources?, data:[{openTime, delta}] }
 *
 * 说明：
 *   - U 本位 (fapi) K 线：takerBuyBase=idx9, baseVolume=idx5
 *   - 币本位 (dapi) K 线：takerBuyBaseAssetVolume=idx10, baseAssetVolume=idx7（币数 BTC）
 *   - 任一源失败只记录、不影响其余源（graceful degrade）。
 */

const express = require('express');
const { BinanceService } = require('../services/binance');

const router = express.Router();

// 从 symbol 解析基础币种：BTCUSDT/BTCUSDC → BTC；BTCUSD → BTC
function parseBaseAsset(symbol) {
  const s = String(symbol).toUpperCase();
  if (s.endsWith('USDT') || s.endsWith('USDC')) return s.slice(0, -4);
  if (s.endsWith('USD')) return s.slice(0, -3);
  return s;
}

// U 本位 (fapi) K 线 → 每根 {openTime, delta(币数)}
function _deltasFapi(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => {
    const baseVol = Number(r[5]);
    const takerBuyBase = Number(r[9]);
    return { openTime: Number(r[0]), delta: 2 * takerBuyBase - baseVol };
  }).filter((p) => Number.isFinite(p.openTime) && Number.isFinite(p.delta));
}

// 币本位 (dapi) K 线 → 每根 {openTime, delta(币数 BTC)}
function _deltasDapi(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => {
    const baseVol = Number(r[7]);            // baseAssetVolume (BTC)
    const takerBuyBase = Number(r[10]);      // takerBuyBaseAssetVolume (BTC)
    return { openTime: Number(r[0]), delta: 2 * takerBuyBase - baseVol };
  }).filter((p) => Number.isFinite(p.openTime) && Number.isFinite(p.delta));
}

// 按 openTime 求和多个源的 delta（缺某根 bar 的源按 0 计入，不前向填充）
function _mergeDeltas(sources) {
  const map = new Map();
  for (const s of sources) {
    for (const p of s.points) {
      map.set(p.openTime, (map.get(p.openTime) || 0) + p.delta);
    }
  }
  return Array.from(map.entries())
    .map(([openTime, delta]) => ({ openTime, delta }))
    .sort((a, b) => a.openTime - b.openTime);
}

router.get('/cvd', async (req, res) => {
  const symbol = String(req.query.symbol || 'BTCUSDT').toUpperCase();
  const market = req.query.market === 'spot' ? 'spot' : 'futures';
  const interval = String(req.query.interval || '1h');
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 200, 1000));
  const aggregate = /^(binance|1|true|all)$/i.test(String(req.query.aggregate || ''));

  try {
    // 单一模式（含 spot）：只取当前 symbol
    if (!aggregate) {
      const rows = await BinanceService.getKlines(symbol, interval, limit, market);
      return res.json({
        success: true,
        data: {
          supported: true,
          symbol,
          market,
          interval,
          aggregated: false,
          data: _deltasFapi(rows)
        }
      });
    }

    // 聚合模式仅对合约有意义
    if (market !== 'futures') {
      const rows = await BinanceService.getKlines(symbol, interval, limit, market);
      return res.json({
        success: true,
        data: { supported: true, symbol, market, interval, aggregated: false, data: _deltasFapi(rows) }
      });
    }

    const base = parseBaseAsset(symbol);
    const [usdtRes, usdcRes, coinmRes] = await Promise.allSettled([
      BinanceService.getKlines(`${base}USDT`, interval, limit, 'futures'),
      BinanceService.getKlines(`${base}USDC`, interval, limit, 'futures'),
      BinanceService.getCoinMKlines(`${base}USD_PERP`, interval, limit)
    ]);

    const usdtPts = usdtRes.status === 'fulfilled' ? _deltasFapi(usdtRes.value) : [];
    const usdcPts = usdcRes.status === 'fulfilled' ? _deltasFapi(usdcRes.value) : [];
    const coinmPts = coinmRes.status === 'fulfilled' ? _deltasDapi(coinmRes.value) : [];

    const sources = [
      { label: `${base}USDT (USDT-M)`, points: usdtPts, ok: usdtRes.status === 'fulfilled', count: usdtPts.length },
      { label: `${base}USDC (USDC-M)`, points: usdcPts, ok: usdcRes.status === 'fulfilled', count: usdcPts.length },
      { label: `${base}USD_PERP (COIN-M)`, points: coinmPts, ok: coinmRes.status === 'fulfilled', count: coinmPts.length }
    ];
    const data = _mergeDeltas(sources);
    const okCount = sources.filter((s) => s.ok && s.count > 0).length;

    res.json({
      success: true,
      data: {
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
      }
    });
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
