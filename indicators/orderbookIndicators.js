'use strict';

/**
 * 订单簿微观结构指标 (Order book microstructure indicators)
 *
 * Binance 订单簿字段 (schema):
 *   bids: [[price, qty], ...]  按价格降序，最优买价排第一 (sorted DESC, best bid first)
 *   asks: [[price, qty], ...]  按价格升序，最优卖价排第一 (sorted ASC,  best ask first)
 */

// 把字符串数组转换为数值数组 (Coerce raw level rows to numbers)
function parseLevels(levels) {
  return levels.map((l) => [Number(l[0]), Number(l[1])]);
}

/**
 * 计算订单簿核心指标 (Compute order-book indicators)
 *
 * @param {object} book      Binance 原始 depth 快照 (raw snapshot)
 * @param {number} depth     聚合时考虑的档位数 (top-N levels per side)
 * @param {number} probeQty  探测下单量，用于估算"有效价差"
 *                           (probe size in base asset, default 0.1 BTC)
 *
 * 返回字段 (Returned fields):
 *  - bestBid, bestAsk        : 最优买/卖价
 *  - midPrice                : 中间价 (mid price)
 *  - spread                  : 绝对价差 = bestAsk - bestBid
 *  - bidNotional             : 前 depth 档买单总额  (Σ price * qty)
 *  - askNotional             : 前 depth 档卖单总额
 *  - depthDiff               : bidNotional - askNotional
 *  - depthRatio              : (bidNotional - askNotional) / (bidNotional + askNotional)
 *  - estEffectiveSpread      : 模拟以 probeQty 市价吃单后，
 *                              平均成交价与中间价的偏离百分比
 *                              ((avgFillPrice - midPrice) / midPrice) * 100
 */
function computeOrderBookIndicators(book, depth = 20, probeQty = 0.1) {
  const bids = parseLevels(book.bids).slice(0, depth);
  const asks = parseLevels(book.asks).slice(0, depth);

  // 空盘口降级返回 (Empty-book fallback)
  if (!bids.length || !asks.length) {
    return {
      bestBid: null,
      bestAsk: null,
      midPrice: null,
      spread: null,
      bidNotional: 0,
      askNotional: 0,
      depthDiff: 0,
      depthRatio: 0,
      estEffectiveSpread: null,
      probeQty
    };
  }

  const bestBid = bids[0][0];
  const bestAsk = asks[0][0];
  const midPrice = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;

  const bidNotional = bids.reduce((acc, [p, q]) => acc + p * q, 0);
  const askNotional = asks.reduce((acc, [p, q]) => acc + p * q, 0);
  const depthDiff = bidNotional - askNotional;
  const totalNotional = bidNotional + askNotional;
  const depthRatio = totalNotional > 0 ? depthDiff / totalNotional : 0;

  const estEffectiveSpread = simulateMarketBuy(asks, probeQty, midPrice);

  return {
    bestBid,
    bestAsk,
    midPrice,
    spread,
    bidNotional,
    askNotional,
    depthDiff,
    depthRatio,
    estEffectiveSpread,
    probeQty,
    depthLevels: depth
  };
}

/**
 * 模拟市价单吃 ask 直到吃满 probeQty，
 * 返回平均成交价相对中间价的偏离百分比。
 * (Walk the ask book until we have filled `probeQty`, returning the
 *  pct deviation of the average fill price vs the mid price.)
 */
function simulateMarketBuy(asks, probeQty, midPrice) {
  let remaining = probeQty;
  let cost = 0;
  let filled = 0;
  for (const [price, qty] of asks) {
    if (remaining <= 0) break;
    const take = Math.min(qty, remaining);
    cost += take * price;
    filled += take;
    remaining -= take;
  }
  if (filled <= 0) return null;
  const avgFill = cost / filled;
  // 部分成交也保留信息 (keep informative for partial fills)
  if (filled < probeQty) {
    return ((avgFill - midPrice) / midPrice) * 100;
  }
  return ((avgFill - midPrice) / midPrice) * 100;
}

/**
 * 滑点模拟 (Slippage simulation)
 * 根据下单量 quantity、方向 side（buy/sell）穿透订单簿。
 *
 * 返回 (Returns):
 *   - avgFillPrice    : 平均成交价
 *   - slippage        : (avgFillPrice - bestPrice) / bestPrice
 *                       带方向：买单为正表示对买方更差
 *   - filled          : 是否完全成交 (boolean)
 *   - filledQty       : 实际成交量
 *   - bestPrice       : 第一档价
 *   - levelsConsumed  : 吃掉了多少档
 */
function simulateSlippage(book, quantity, side = 'buy') {
  const isBuy = side === 'buy';
  const ladder = parseLevels(isBuy ? book.asks : book.bids);

  if (!ladder.length) {
    return {
      avgFillPrice: null,
      slippage: null,
      filled: false,
      filledQty: 0,
      bestPrice: null,
      levelsConsumed: 0
    };
  }

  const bestPrice = ladder[0][0];
  let remaining = quantity;
  let cost = 0;
  let filledQty = 0;
  let levelsConsumed = 0;

  for (const [price, qty] of ladder) {
    if (remaining <= 0) break;
    const take = Math.min(qty, remaining);
    cost += take * price;
    filledQty += take;
    remaining -= take;
    levelsConsumed += 1;
  }
  const avgFillPrice = filledQty > 0 ? cost / filledQty : null;
  const filled = remaining <= 1e-12;
  let slippage = null;
  if (avgFillPrice !== null && bestPrice > 0) {
    slippage = isBuy
      ? (avgFillPrice - bestPrice) / bestPrice
      : (bestPrice - avgFillPrice) / bestPrice;
  }
  return {
    avgFillPrice,
    slippage,
    filled,
    filledQty,
    bestPrice,
    levelsConsumed,
    requestedQty: quantity,
    side
  };
}

module.exports = {
  computeOrderBookIndicators,
  simulateSlippage
};
