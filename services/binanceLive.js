'use strict';

/**
 * Binance 实时数据门面 (Binance live data facade)
 *
 * 对外暴露与 services/binance.js BinanceService 一致的方法签名 ——
 * getKlines / getOrderBook / getAggTrades / getCurrentPrice ——
 * 但内部优先从 services/binanceStream.js 维护的 WebSocket 缓存读取，
 * 失败 / 缓存未就绪时无缝退回 REST，让所有"轮询型"路由零成本拥有
 * 亚秒新鲜度，同时保持原有 fallback 路径作为可靠兜底。
 *
 * 历史 / 回测路径请继续直接使用 BinanceService（它走纯 REST，
 * 不会触发 WS 长连接）。
 */

const { BinanceService } = require('./binance');
const stream = require('./binanceStream');

// stream 路径时间上限：缓存命中是同步级别的（<1ms），只有冷启动 seed 会
// 走 REST 拉历史。若 seed 在慢链路上挂死，这里不设上限的话
// "stream 等待 + REST fallback" 会串联成 20s+，超过网关超时（~15s），
// 网关就会替我们返回 502 HTML 错误页 → 前端报"非 JSON 响应"。
// 上限内没出结果就立刻切 REST fallback；seed 仍在后台继续，下一轮直接命中缓存。
const STREAM_PATH_TIMEOUT_MS = (() => {
  const v = Number(process.env.BINANCE_STREAM_PATH_TIMEOUT_MS);
  return Number.isFinite(v) && v >= 500 ? v : 2500;
})();

function _withTimeout(promise, ms) {
  let timer = null;
  const gate = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`stream path timed out after ${ms}ms`)),
      ms
    );
  });
  return Promise.race([promise, gate]).finally(() => clearTimeout(timer));
}

async function _withFallback(label, useStream, useRest) {
  try {
    return await _withTimeout(useStream(), STREAM_PATH_TIMEOUT_MS);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[binanceLive] ${label} stream miss → fallback REST: ${err.message}`);
    return useRest();
  }
}

const BinanceLive = {
  /**
   * 实时 K 线：返回 Binance 原始数组结构（与 BinanceService.getKlines 一致），
   * 路由层 normalizeKlines 等下游函数完全不需要修改。
   */
  async getKlines(symbol, interval = '1h', limit = 100, marketType = 'spot') {
    return _withFallback(
      `kline ${symbol} ${marketType} ${interval}`,
      async () => {
        const hub = stream.getHub(symbol, marketType);
        // 触发订阅 + seed（首次同步等待历史 REST 拉取完成）
        await hub.getKlines(interval, limit);
        const arr = hub.klinesAsRestArrays(interval, limit);
        if (!arr.length) throw new Error('kline cache empty');
        return arr;
      },
      () => BinanceService.getKlines(symbol, interval, limit, marketType)
    );
  },

  /**
   * 实时订单簿：与 BinanceService.getOrderBook 返回结构一致：
   *   { lastUpdateId, bids:[[p,q]...], asks:[[p,q]...] }
   * 注意：缓存里维护的是 fetchDepth 档（500 / 1000），
   * 路由若要 slice(0, N) 仍可正常工作。
   */
  async getOrderBook(symbol, limit = 100, marketType = 'spot') {
    return _withFallback(
      `orderbook ${symbol} ${marketType}`,
      async () => {
        const hub = stream.getHub(symbol, marketType);
        const book = await hub.getOrderBook(limit);
        if (!book || !book.bids.length || !book.asks.length) throw new Error('book cache empty');
        return book;
      },
      () => BinanceService.getOrderBook(symbol, limit, marketType)
    );
  },

  /**
   * 实时聚合成交：返回元素结构与 BinanceService.getAggTrades 一致：
   *   { a, p, q, f, l, T, m, M }
   */
  async getAggTrades(symbol, limit = 500, marketType = 'spot') {
    return _withFallback(
      `aggTrades ${symbol} ${marketType}`,
      async () => {
        const hub = stream.getHub(symbol, marketType);
        const trades = await hub.getAggTrades(limit);
        if (!trades.length) throw new Error('aggTrades cache empty');
        return trades;
      },
      () => BinanceService.getAggTrades(symbol, limit, marketType)
    );
  },

  /**
   * 最新价：优先复用 hub 已订阅的 K 线缓存最后一根 close（0 weight），
   * 完全没有任何 K 线缓存时才退回 REST ticker，避免在被 IP 限流的情况下
   * 还无谓消耗 weight。
   */
  async getCurrentPrice(symbol, marketType = 'spot') {
    return _withFallback(
      `currentPrice ${symbol} ${marketType}`,
      async () => {
        const hub = stream.getHub(symbol, marketType);
        const status = hub.getStatus();
        const intervals = (status.klineIntervals || [])
          .filter((x) => x.bars > 0)
          .map((x) => x.interval);
        if (intervals.length === 0) throw new Error('no kline cache to derive price');
        const itv = intervals[0];
        const candles = await hub.getKlines(itv, 1);
        if (!candles.length) throw new Error('kline cache empty');
        return Number(candles[candles.length - 1].close);
      },
      () => BinanceService.getCurrentPrice(symbol, marketType)
    );
  }
};

module.exports = {
  BinanceLive,
  // 透传 stream 状态供 /api/stream/status 使用
  getStreamStatus: () => stream.getStatusAll()
};
