'use strict';

/**
 * GET /api/klines
 *
 * 查询参数 (Query params):
 *   symbol         交易对，如 BTCUSDT (required)
 *   interval       默认 '1h'
 *   limit          默认 100
 *   market         'spot' | 'futures'，默认 'spot'
 *   detectPatterns 'true' | 'false'，默认 false
 *                  打开后会附带 FVG 与流动性空白识别结果
 *
 * 响应结构 (Response shape):
 * {
 *   success: true,
 *   data: {
 *     candles: [
 *       { openTime, open, high, low, close, volume, closeTime, quoteVolume,
 *         vwap, mfi }                            // K 线 + 指标
 *     ],
 *     fvgs:           [ { type, lower, upper, startTime, endTime, index } ]
 *     liquidityVoids: [ { startIndex, endIndex, startTime, endTime, lower, upper, length } ]
 *     summary:        { count, interval, market }
 *   }
 * }
 */

const express = require('express');
const { BinanceService } = require('../services/binance');
const {
  normalizeKlines,
  computeVWAP,
  computeMFI,
  detectFVGs,
  detectLiquidityVoids
} = require('../indicators/klineIndicators');
const feishu = require('../services/feishu');
const regime = require('../services/regime');

const router = express.Router();

router.get('/klines', async (req, res) => {
  try {
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    const interval = req.query.interval || '1h';
    const limit = Math.min(Number(req.query.limit) || 100, 1500);
    // 默认合约 (default to futures per project spec)
    const market = req.query.market === 'spot' ? 'spot' : 'futures';
    const detectPatterns = String(req.query.detectPatterns) === 'true';

    const raw = await BinanceService.getKlines(symbol, interval, limit, market);
    const candles = normalizeKlines(raw);
    const vwap = computeVWAP(candles);
    const mfi = computeMFI(candles, 14);

    // 把 vwap / mfi 附加到对应 K 线上 (Attach VWAP / MFI to each candle)
    const decorated = candles.map((c, i) => ({
      ...c,
      vwap: vwap[i],
      mfi: mfi[i]
    }));

    const result = {
      candles: decorated,
      summary: { count: decorated.length, interval, market, symbol }
    };

    if (detectPatterns) {
      result.fvgs = detectFVGs(candles);
      result.liquidityVoids = detectLiquidityVoids(candles);

      // ---- 新 FVG 派发：飞书卡片 + regime 接口 ----
      // (Dispatch newly-appeared FVGs to Feishu + regime API.)
      //
      // 设计要点：
      //   - 飞书与 regime **共用一次** pickNewFvgs 调用，避免任一方推进 baseline
      //     另一方收不到（两端共享 lastFvgNotified 状态）。
      //   - regime 仅在 **1h** K 线上触发（用户需求：当一小时 K 线出现 long/short FVG）。
      //   - 通过 ?notify=false 显式关闭所有 FVG 派发（前端 fetch 时可用）。
      //   - fire-and-forget，不阻塞响应。
      if (req.query.notify !== 'false') {
        const latestPrice = decorated.length ? decorated[decorated.length - 1].close : null;
        const picked = feishu.pickNewFvgs(symbol, market, result.fvgs);

        if (picked.baseline) {
          // eslint-disable-next-line no-console
          console.log(`[klines] FVG baseline established for ${symbol} ${market} (${result.fvgs.length} historical FVGs · 不推送)`);
        } else if (picked.toPush.length > 0) {
          dispatchNewFvgs(picked.toPush, {
            symbol,
            market,
            interval,
            latestPrice
          });
        }
      }
    }

    res.json({ success: true, data: result });
  } catch (err) {
    // 统一以 200 + {success:false} 返回，前端永远能解析 JSON
    // (Always return {success:false} so the dashboard can render an error
    //  state instead of crashing on non-JSON 500 bodies.)
    res.json({ success: false, error: err.message });
  }
});

/**
 * 把新检测到的 FVG 派发到 飞书 / regime。
 * (Dispatch the *picked* (already-deduplicated) new FVGs to downstream sinks.)
 *
 * @param {Array} newFvgs   feishu.pickNewFvgs(...).toPush
 * @param {{symbol:string, market:string, interval:string, latestPrice:number|null}} ctx
 */
function dispatchNewFvgs(newFvgs, ctx) {
  const { symbol, market, interval, latestPrice } = ctx;

  // ----- (1) 飞书卡片推送 (Feishu cards) -----
  // FEISHU_FVG_NOTIFY_ENABLED=false 时跳过；regime webhook 仍照常发。
  if (feishu.isFvgNotifyEnabled()) {
    Promise.allSettled(
      newFvgs.map((f) => feishu.sendFvgCard(f, { symbol, market, latestPrice }))
    )
      .then((settled) => {
        const ok = settled.filter((s) => s.status === 'fulfilled' && s.value && s.value.ok).length;
        const fails = settled
          .map((s, i) => ({ s, i }))
          .filter(({ s }) => !(s.status === 'fulfilled' && s.value && s.value.ok));
        if (ok > 0) {
          // eslint-disable-next-line no-console
          console.log(`[klines] pushed ${ok} new FVG(s) to Feishu for ${symbol} ${market}`);
        }
        if (fails.length > 0) {
          // eslint-disable-next-line no-console
          console.warn(
            `[klines] FVG Feishu push had ${fails.length} failures:`,
            fails
              .map(({ s }) => (s.status === 'rejected' ? s.reason && s.reason.message : (s.value && s.value.error)))
              .filter(Boolean)
              .join(' | ')
          );
        }
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[klines] FVG Feishu dispatch threw:', err.message);
      });
  }

  // ----- (2) Regime 接口通知 (Regime / market-state notify) -----
  // 用户需求：当 **1h K 线** 出现 long / short FVG 才调 regime 接口。
  // (Per user spec: only fire on 1h timeframe.)
  if (interval === '1h' && regime.isEnabled()) {
    Promise.allSettled(
      newFvgs.map((f) => {
        const direction = f.type === 'bullish' ? 'long' : 'short';
        return regime.notifyFvg(direction, {
          symbol,
          market,
          interval,
          fvg: {
            type: f.type,
            upper: f.upper,
            lower: f.lower,
            startTime: f.startTime,
            endTime: f.endTime
          }
        });
      })
    )
      .then((settled) => {
        const ok = settled.filter((s) => s.status === 'fulfilled' && s.value && s.value.ok).length;
        const fails = settled.filter((s) => !(s.status === 'fulfilled' && s.value && s.value.ok));
        if (ok > 0) {
          // eslint-disable-next-line no-console
          console.log(`[klines] notified regime for ${ok} new FVG(s) (${symbol} ${market} ${interval})`);
        }
        if (fails.length > 0) {
          // eslint-disable-next-line no-console
          console.warn(
            `[klines] regime notify had ${fails.length} failures:`,
            fails
              .map((s) => (s.status === 'rejected' ? s.reason && s.reason.message : (s.value && s.value.error)))
              .filter(Boolean)
              .join(' | ')
          );
        }
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[klines] regime dispatch threw:', err.message);
      });
  }
}

module.exports = router;
