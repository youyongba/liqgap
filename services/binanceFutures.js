'use strict';

/**
 * Binance U 本位合约市场数据封装
 * (Binance USD-M Futures market-data wrapper)
 *
 * 这里使用的端点都是公开端点 (no signature) ——
 * 唯一例外是 `/fapi/v1/allForceOrders`。
 * 该端点在 2021 年悄悄改成了 USER_DATA 权重 (became USER_DATA-weighted)，
 * 现在需要带 API key 的签名请求。
 * 公网爆仓数据只能通过 `!forceOrder@arr` WebSocket 流获取
 * (public liquidation feed only via the websocket stream).
 *
 * 为了让项目在没有密钥时也能直接运行 (self-contained without API keys)，
 * 这里仍然暴露 `getAllForceOrders()`，但会捕获鉴权失败、
 * 返回空数组 + `degraded: true` 标记 (graceful degrade)，
 * 调用方可基于 OI / 资金费率回退检测。
 *
 * 如果用户在 .env 中提供了 BINANCE_API_KEY + BINANCE_API_SECRET，
 * 我们会签名后真正请求强平数据。
 * (When credentials are provided in .env we sign and fetch real data.)
 */

const axios = require('axios');
const crypto = require('crypto');

const BASE_URL = 'https://fapi.binance.com';

// 浏览器风格 headers (避免被 Cloudflare 当 bot 拦截 → 403)
// (Browser-like headers prevent Cloudflare bot challenge.)
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  Connection: 'keep-alive'
};

const httpClient = axios.create({
  timeout: 15000,
  headers: BROWSER_HEADERS
});

// 错误包装：把 HTTP 状态码 + URL + 提示拼到 message
function wrapError(prefix, path, err) {
  const status = err.response && err.response.status;
  const msg =
    (err.response && err.response.data && err.response.data.msg) ||
    err.message ||
    'Unknown futures API error';
  let hint = '';
  if (status === 403 || status === 451) {
    hint = '（疑似地理限制或 Cloudflare 拦截，请尝试在 .env 配置 HTTPS_PROXY）';
  } else if (status === 429 || status === 418) {
    hint = '（被币安限流 rate-limited，请降低轮询频率）';
  }
  const wrapped = new Error(`${prefix} ${path} failed (HTTP ${status || 'NETERR'}): ${msg}${hint}`);
  wrapped.cause = err;
  wrapped.status = status;
  return wrapped;
}

// 公开端点 GET (Public-endpoint GET)
async function publicGet(path, params) {
  try {
    const res = await httpClient.get(BASE_URL + path, { params });
    return res.data;
  } catch (err) {
    throw wrapError('Binance futures', path, err);
  }
}

// 签名端点 GET (Signed-endpoint GET — HMAC-SHA256)
async function signedGet(path, params = {}) {
  const apiKey = process.env.BINANCE_API_KEY;
  const apiSecret = process.env.BINANCE_API_SECRET;
  if (!apiKey || !apiSecret) {
    const e = new Error('signed endpoint requires BINANCE_API_KEY/SECRET');
    e.code = 'NO_AUTH';
    throw e;
  }
  const ts = Date.now();
  const queryParams = { ...params, timestamp: ts, recvWindow: 5000 };
  const queryString = new URLSearchParams(queryParams).toString();
  const sig = crypto
    .createHmac('sha256', apiSecret)
    .update(queryString)
    .digest('hex');

  try {
    const res = await httpClient.get(BASE_URL + path + '?' + queryString + '&signature=' + sig, {
      headers: { ...BROWSER_HEADERS, 'X-MBX-APIKEY': apiKey }
    });
    return res.data;
  } catch (err) {
    throw wrapError('Binance futures (signed)', path, err);
  }
}

const BinanceFutures = {
  /**
   * 获取资金费率历史 (Funding rate history)
   *  返回 (Returns): [ { symbol, fundingRate, fundingTime, markPrice? }, ... ]
   *  端点 (Endpoint): GET /fapi/v1/fundingRate
   */
  async getFundingRate(symbol, limit = 100) {
    return publicGet('/fapi/v1/fundingRate', {
      symbol: String(symbol).toUpperCase(),
      limit
    });
  },

  /**
   * 获取最新未平仓合约量快照 (Latest open-interest snapshot)
   *  返回 (Returns): { openInterest, symbol, time }
   *  端点 (Endpoint): GET /fapi/v1/openInterest
   */
  async getOpenInterest(symbol) {
    return publicGet('/fapi/v1/openInterest', {
      symbol: String(symbol).toUpperCase()
    });
  },

  /**
   * 获取未平仓合约量历史 (Open interest historical statistics)
   *  返回 (Returns): [ { symbol, sumOpenInterest, sumOpenInterestValue, timestamp } ]
   *  端点 (Endpoint): GET /futures/data/openInterestHist
   *  period 合法值 (valid values): 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d
   */
  async getOpenInterestHist(symbol, period = '1h', limit = 100) {
    return publicGet('/futures/data/openInterestHist', {
      symbol: String(symbol).toUpperCase(),
      period,
      limit
    });
  },

  /**
   * 大户多空账户数比 (Top trader long/short ACCOUNT ratio · 前 20%)
   *  端点 (Endpoint): GET /futures/data/topLongShortAccountRatio
   */
  async getTopLongShortAccountRatio(symbol, period = '1h', limit = 100) {
    return publicGet('/futures/data/topLongShortAccountRatio', {
      symbol: String(symbol).toUpperCase(),
      period,
      limit
    });
  },

  /**
   * 大户多空持仓量比 (Top trader long/short POSITION ratio · 前 20%)
   *  端点 (Endpoint): GET /futures/data/topLongShortPositionRatio
   */
  async getTopLongShortPositionRatio(symbol, period = '1h', limit = 100) {
    return publicGet('/futures/data/topLongShortPositionRatio', {
      symbol: String(symbol).toUpperCase(),
      period,
      limit
    });
  },

  /**
   * 全市场多空账户数比 (Global long/short account ratio)
   *  端点 (Endpoint): GET /futures/data/globalLongShortAccountRatio
   */
  async getGlobalLongShortAccountRatio(symbol, period = '1h', limit = 100) {
    return publicGet('/futures/data/globalLongShortAccountRatio', {
      symbol: String(symbol).toUpperCase(),
      period,
      limit
    });
  },

  /**
   * Taker 主动买卖量比 (Taker buy/sell volume ratio)
   *  端点 (Endpoint): GET /futures/data/takerlongshortRatio
   *  返回 (Returns): [ { buySellRatio, buyVol, sellVol, timestamp } ]
   */
  async getTakerBuySellVol(symbol, period = '1h', limit = 100) {
    return publicGet('/futures/data/takerlongshortRatio', {
      symbol: String(symbol).toUpperCase(),
      period,
      limit
    });
  },

  /**
   * 近期强平 / 爆仓订单 (Recent forced-liquidation orders)
   *
   * 端点 (Endpoint): GET /fapi/v1/allForceOrders
   * 鉴权 (Auth): USER_DATA (signed). 没有 API key 时会 401。
   *
   * 此时返回 { degraded: true, data: [] } 让后续指标流水线
   * (downstream pipeline) 仍可正常工作。
   *
   * 成功返回 (Success shape):
   *   [ { symbol, side, orderType, origQty, price, avgPrice, time, ... } ]
   */
  async getAllForceOrders(symbol, limit = 50) {
    try {
      const data = await signedGet('/fapi/v1/allForceOrders', {
        symbol: String(symbol).toUpperCase(),
        limit
      });
      return { degraded: false, data: Array.isArray(data) ? data : [] };
    } catch (err) {
      if (err.code === 'NO_AUTH' || err.status === 401 || err.status === 403) {
        return { degraded: true, reason: err.message, data: [] };
      }
      throw err;
    }
  }
};

module.exports = { BinanceFutures, FUTURES_BASE_URL: BASE_URL };
