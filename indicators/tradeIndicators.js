'use strict';

/**
 * 成交流相关的微观结构指标 (Trade-based microstructure indicators)
 *
 * ⚠️ 主动方向约定 (Aggressor convention required by spec)：
 *   - 现货 (SPOT)    : isBuyerMaker === true  => 主动方为卖方 (aggressor is SELLER)
 *                      => 主动买入对应 isBuyerMaker === false
 *   - 合约 (FUTURES) : 按需求文档"isBuyerMaker===false 为买方主动，与现货相反"
 *                      该约定与原始 Binance 字段语义一致；
 *                      之所以保留 marketType 入参，是为了让未来 Binance
 *                      协议变更或换其它交易所时能在这一处集中翻转，
 *                      调用方代码不必改动 (single point of inversion)。
 *
 * 实现 (Implementation):
 *   isBuy(trade, marketType) 返回 true 表示买方主动成交 (buyer-aggressor)
 *   - spot     -> trade.m === false
 *   - futures  -> trade.m === false  （按规范同样语义）
 */

// 判断该笔成交是否为"买方主动" (Determine whether the buyer was the aggressor)
function isAggressiveBuy(trade, marketType) {
  // Binance 返回 m = isBuyerMaker
  // 现货 (Spot)   : 买方主动 => m === false
  // 合约 (Futures): 买方主动 => m === false（按规范）
  if (marketType === 'futures') {
    return trade.m === false;
  }
  return trade.m === false;
}

/**
 * 计算 Delta / CVD / Footprint 三件套 (Compute trade indicators)
 *
 * @returns {
 *   deltaSeries    : Array<{ time, price, qty, delta }>
 *                    每条成交的 delta（主动买为正、主动卖为负）
 *   cvdSeries      : Array<{ time, value }>
 *                    delta 的逐次累加序列 (Cumulative Volume Delta)
 *   footprintTable : Array<{
 *      bucketIndex, priceLow, priceHigh,
 *      buyVolume, sellVolume, totalVolume, delta, dominantSide
 *   }>                                  // 价格分桶 footprint 表 (默认 50 桶)
 *   summary        : { totalBuy, totalSell, finalCvd, priceMin, priceMax }
 * }
 */
function computeTradeIndicators(rawTrades, marketType, buckets = 50) {
  if (!rawTrades.length) {
    return {
      deltaSeries: [],
      cvdSeries: [],
      footprintTable: [],
      summary: {
        totalBuy: 0,
        totalSell: 0,
        finalCvd: 0,
        priceMin: null,
        priceMax: null
      }
    };
  }

  // 先扫一遍取价格范围用于分桶 (Scan once to derive price range for buckets)
  let priceMin = Infinity;
  let priceMax = -Infinity;
  for (const t of rawTrades) {
    const p = Number(t.p);
    if (p < priceMin) priceMin = p;
    if (p > priceMax) priceMax = p;
  }
  const priceRange = priceMax - priceMin || 1;
  const bucketSize = priceRange / buckets;

  const footprint = new Array(buckets).fill(null).map((_, i) => ({
    bucketIndex: i,
    priceLow: priceMin + i * bucketSize,
    priceHigh: priceMin + (i + 1) * bucketSize,
    buyVolume: 0,
    sellVolume: 0
  }));

  const deltaSeries = [];
  const cvdSeries = [];
  let cvd = 0;
  let totalBuy = 0;
  let totalSell = 0;

  for (const t of rawTrades) {
    const price = Number(t.p);
    const qty = Number(t.q);
    const buy = isAggressiveBuy(t, marketType);
    const delta = buy ? qty : -qty;

    if (buy) totalBuy += qty;
    else totalSell += qty;

    cvd += delta;
    deltaSeries.push({ time: t.T, price, qty, delta });
    cvdSeries.push({ time: t.T, value: cvd });

    // 把成交量计入对应价格桶 (Drop volume into matching bucket)
    let idx = Math.floor((price - priceMin) / bucketSize);
    if (idx >= buckets) idx = buckets - 1;
    if (idx < 0) idx = 0;
    if (buy) footprint[idx].buyVolume += qty;
    else footprint[idx].sellVolume += qty;
  }

  // 给每个桶补全 totalVolume / delta / dominantSide
  // (Fill totalVolume / delta / dominantSide for each bucket)
  const footprintTable = footprint.map((b) => ({
    ...b,
    totalVolume: b.buyVolume + b.sellVolume,
    delta: b.buyVolume - b.sellVolume,
    dominantSide:
      b.buyVolume === b.sellVolume
        ? 'flat'
        : b.buyVolume > b.sellVolume
        ? 'buy'
        : 'sell'
  }));

  return {
    deltaSeries,
    cvdSeries,
    footprintTable,
    summary: {
      totalBuy,
      totalSell,
      finalCvd: cvd,
      priceMin,
      priceMax
    }
  };
}

module.exports = {
  isAggressiveBuy,
  computeTradeIndicators
};
