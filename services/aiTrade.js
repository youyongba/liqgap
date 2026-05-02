'use strict';

const axios = require('axios');

const getAiApiUrl = () => process.env.AITRADE_API_URL || 'https://aitrade.24os.cn';

/**
 * 将交易信号推送至 AI 分析系统
 * @param {Object} signalData - 信号数据对象
 * @param {Object} extra - 额外字段 (symbol, market)
 */
async function pushSignalToAI(signalData, extra = {}) {
  try {
    const snap = signalData.indicatorsSnapshot || {};
    const symbol = snap.symbol || extra.symbol || 'BTCUSDT';
    const direction = signalData.signal === 'NONE' ? null : signalData.signal;
    
    const payload = {
      symbol,
      direction,
      entry_price: signalData.entryPrice,
      stop_loss: signalData.stopLoss,
      take_profits: signalData.takeProfits ? JSON.stringify(signalData.takeProfits.map(tp => tp.price)) : undefined,
      risk_amount: signalData.riskAmount,
      position_size: signalData.positionSize,
      notional: signalData.positionSizeQuote,
      long_conditions: snap.longConditions ? JSON.stringify(Object.keys(snap.longConditions).filter(k => snap.longConditions[k])) : undefined,
      short_conditions: snap.shortConditions ? JSON.stringify(Object.keys(snap.shortConditions).filter(k => snap.shortConditions[k])) : undefined,
      long_score: snap.longScore,
      short_score: snap.shortScore,
      last_price: snap.latestPrice,
      vwap: snap.vwap,
      atr14: snap.atr,
      depth_ratio: snap.depthRatio,
      spread: snap.spread,
      cvd: snap.cvd,
      cvd_price_corr: snap.cvdPriceCorr,
      illiq: snap.latestIlliq
    };

    // 过滤掉 undefined 的字段
    Object.keys(payload).forEach(key => payload[key] === undefined && delete payload[key]);

    const url = `${getAiApiUrl()}/api/v1/signals`;
    const response = await axios.post(url, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000 // 5s 超时
    });
    
    return { ok: true, data: response.data };
  } catch (error) {
    return { 
      ok: false, 
      error: error.response ? error.response.data : error.message 
    };
  }
}

module.exports = {
  pushSignalToAI
};