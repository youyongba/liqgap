'use strict';

/**
 * Amihud 非流动性指标 (Amihud Illiquidity Ratio)
 *
 *   ILLIQ_t = |return_t| / quoteVolume_t
 *           = |(close - open) / open| / quoteVolume
 *
 * 解读 (Interpretation):
 *   ILLIQ 越大说明每单位成交额能带动越大的价格变动，
 *   即标的"越不流动" (the asset is less liquid)。
 *   出处：Amihud (2002) "Illiquidity and stock returns".
 */
function computeIlliquidity(candles) {
  return candles.map((c) => {
    const ret = c.open === 0 ? 0 : (c.close - c.open) / c.open;
    const illiq = c.quoteVolume === 0 ? 0 : Math.abs(ret) / c.quoteVolume;
    return {
      openTime: c.openTime,
      closeTime: c.closeTime,
      date: new Date(c.closeTime).toISOString().slice(0, 10),
      return: ret,
      quoteVolume: c.quoteVolume,
      illiq
    };
  });
}

module.exports = {
  computeIlliquidity
};
