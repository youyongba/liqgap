'use strict';

/**
 * Binance REST API 服务封装 (Binance REST API service wrapper)
 *
 * 支持两种市场类型 (Supports two market types)：
 *  - 'spot'    : 现货，base URL https://api.binance.com
 *  - 'futures' : U 本位合约 (USD-M futures)，base URL https://fapi.binance.com
 *
 * ⚠️ 重要陷阱 (IMPORTANT TRAPS · 调用方需注意)：
 *  - 现货 (Spot) aggTrades:
 *      isBuyerMaker === true  => 卖方主动成交 (seller-aggressor)
 *      => 主动买入 (aggressive buy) 对应 isBuyerMaker === false
 *  - 合约 (Futures) aggTrades:
 *      第三方工具常用 "和现货相反" 的标注约定 (some libraries invert).
 *      Binance 实际返回的字段语义与现货一致，
 *      但本项目按规范在指标层 (indicators/tradeIndicators.js)
 *      根据 marketType 显式应用约定，调用方拿到的是已统一过方向的数据。
 *
 * 这里 (this file) 只提供原始 HTTP 请求，不做方向转换；
 * 方向转换交给指标层处理，便于排错与单元测试。
 */

const axios = require('axios');

const SPOT_BASE_URL = 'https://api.binance.com';
const FUTURES_BASE_URL = 'https://fapi.binance.com';

const DEFAULT_TIMEOUT_MS = 15000;

// 用浏览器风格的 headers 避免被 Cloudflare 当作 bot 拦截 (返回 403)。
// (Browser-like headers prevent Cloudflare from flagging us as a bot.)
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
  timeout: DEFAULT_TIMEOUT_MS,
  headers: BROWSER_HEADERS
});

// ---------------------------------------------------------------------------
// 429 / 418 全局退避 (Global rate-limit cooldown)
// ---------------------------------------------------------------------------
//
// 当任意 REST 请求收到 429/418 时，把对应市场（spot / futures）置入冷却期：
//   - 默认 30s（可被 Retry-After header 覆盖）
//   - 冷却期内所有 REST 请求直接 throw，绕过网络往返，让 binanceLive 的
//     fallback 链路立即用 stream cache / 上层缓存兜底
//   - 防止"轮询风暴"在 IP 已被限流时火上浇油
//
// 设计：分 spot 和 futures 两个独立计时器（Binance 也是独立 weight 池）
const cooldown = {
  spot: 0,        // 解封时间戳 (ms epoch)
  futures: 0
};
const DEFAULT_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 5 * 60 * 1000;

function _market(url) {
  return /\/fapi\//.test(url) ? 'futures' : 'spot';
}

function _isCoolingDown(market) {
  return cooldown[market] > Date.now();
}

function _setCooldown(market, ms) {
  const until = Date.now() + Math.min(MAX_COOLDOWN_MS, Math.max(1000, ms));
  if (until > cooldown[market]) {
    cooldown[market] = until;
    // eslint-disable-next-line no-console
    console.warn(
      `[binance] ${market} REST cooled down for ${Math.round(ms / 1000)}s`
      + ` until ${new Date(until).toISOString()} (rate-limited; will use stream cache)`
    );
  }
}

function getRateLimitState() {
  const now = Date.now();
  return {
    spot: { coolingDown: cooldown.spot > now, untilMs: cooldown.spot },
    futures: { coolingDown: cooldown.futures > now, untilMs: cooldown.futures }
  };
}

// 根据市场类型选择 base URL (Resolve base URL by market type)
function resolveBaseUrl(marketType) {
  return marketType === 'futures' ? FUTURES_BASE_URL : SPOT_BASE_URL;
}

// K 线接口路径 (Kline endpoint path)
function resolveKlinePath(marketType) {
  return marketType === 'futures' ? '/fapi/v1/klines' : '/api/v3/klines';
}

// 订单簿接口路径 (Order-book / Depth endpoint path)
function resolveDepthPath(marketType) {
  return marketType === 'futures' ? '/fapi/v1/depth' : '/api/v3/depth';
}

// 聚合成交接口路径 (Aggregated trades endpoint path)
function resolveAggTradesPath(marketType) {
  return marketType === 'futures' ? '/fapi/v1/aggTrades' : '/api/v3/aggTrades';
}

// 最新价接口路径 (Latest ticker price endpoint path)
function resolveTickerPath(marketType) {
  return marketType === 'futures' ? '/fapi/v1/ticker/price' : '/api/v3/ticker/price';
}

// 通用 GET 请求 + 错误包装 (Generic GET with error wrapping)
//   错误信息里附带 HTTP 状态码与 URL 路径，便于排查
//   ECONNRESET / 403 / 451 / 429 等具体原因。
//
//   429/418 被检测到时，对应市场进入冷却期，期内的请求直接抛出
//   "rate-limit cooldown" 不再发起网络请求，避免雪崩。
async function get(url, params) {
  const market = _market(url);
  if (_isCoolingDown(market)) {
    const remainMs = cooldown[market] - Date.now();
    const path = (url || '').replace(/^https?:\/\/[^/]+/, '');
    const err = new Error(
      `Binance API ${path} skipped (rate-limit cooldown ${Math.ceil(remainMs / 1000)}s remaining)`
    );
    err.cooldown = true;
    err.status = 429;
    throw err;
  }
  try {
    const response = await httpClient.get(url, { params });
    return response.data;
  } catch (err) {
    const status = err.response && err.response.status;
    const reason =
      (err.response && err.response.data && err.response.data.msg) ||
      err.message ||
      'Unknown Binance API error';
    let hint = '';
    if (status === 403 || status === 451) {
      // 地理限制 / Cloudflare 拦截常见提示
      // (Geographic / Cloudflare restriction hint.)
      hint = '（疑似地理限制或 Cloudflare 拦截，请尝试在 .env 配置 HTTPS_PROXY；' +
             ' likely geo-block / Cloudflare bot challenge — try HTTPS_PROXY in .env）';
    } else if (status === 429 || status === 418) {
      hint = '（被币安限流 rate-limited，请降低轮询频率）';
      // 触发对应市场冷却期：优先尊重 Retry-After header，否则用默认值
      // (Prefer Retry-After header; fall back to default cooldown.)
      const retryAfter = err.response && err.response.headers
        ? err.response.headers['retry-after']
        : null;
      const seconds = Number(retryAfter);
      const ms = Number.isFinite(seconds) && seconds > 0
        ? seconds * 1000
        : DEFAULT_COOLDOWN_MS;
      _setCooldown(market, ms);
    }
    const path = (url || '').replace(/^https?:\/\/[^/]+/, '');
    const wrapped = new Error(
      `Binance API ${path} failed (HTTP ${status || 'NETERR'}): ${reason}${hint}`
    );
    wrapped.cause = err;
    wrapped.status = status;
    throw wrapped;
  }
}

const BinanceService = {
  /**
   * 获取 K 线 / 蜡烛图数据 (Fetch klines / candlesticks)
   *
   * 返回 Binance 原始数组结构 (Returns raw Binance kline arrays):
   *   [ openTime, open, high, low, close, volume, closeTime,
   *     quoteAssetVolume, numberOfTrades, takerBuyBase, takerBuyQuote, ignore ]
   */
  async getKlines(symbol, interval = '1h', limit = 100, marketType = 'spot') {
    const url = resolveBaseUrl(marketType) + resolveKlinePath(marketType);
    return get(url, {
      symbol: String(symbol).toUpperCase(),
      interval,
      limit
    });
  },

  /**
   * 获取订单簿快照 (Fetch order book snapshot)
   *
   * 返回 (Returns):
   *   {
   *     lastUpdateId,
   *     bids: [[price, qty], ...],   // 按价格降序 (sorted DESC)
   *     asks: [[price, qty], ...]    // 按价格升序 (sorted ASC)
   *   }
   */
  async getOrderBook(symbol, limit = 100, marketType = 'spot') {
    const url = resolveBaseUrl(marketType) + resolveDepthPath(marketType);
    return get(url, {
      symbol: String(symbol).toUpperCase(),
      limit
    });
  },

  /**
   * 获取聚合成交 (Fetch aggregated trades)
   *
   * 返回数组元素 (Each element):
   *   { a, p, q, f, l, T, m, M }
   *   其中 m 即 isBuyerMaker (m === isBuyerMaker)。
   */
  async getAggTrades(symbol, limit = 500, marketType = 'spot') {
    // Binance aggTrades 接口 limit 上限为 1000（spot 与 futures 一致）。
    // 调用方传 >1000 会被 Binance 直接拒绝（400 'limit not valid'），
    // 因此在底层封装做硬上限防护，避免业务层反复处理。
    const url = resolveBaseUrl(marketType) + resolveAggTradesPath(marketType);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 500, 1000));
    return get(url, {
      symbol: String(symbol).toUpperCase(),
      limit: safeLimit
    });
  },

  /**
   * 获取标的最新价 (Fetch the latest ticker price)
   * 返回 (Returns)：number 类型的最新成交价。
   */
  async getCurrentPrice(symbol, marketType = 'spot') {
    const url = resolveBaseUrl(marketType) + resolveTickerPath(marketType);
    const data = await get(url, { symbol: String(symbol).toUpperCase() });
    return Number(data.price);
  },

  /**
   * 获取 USDⓈ-M 合约持仓量历史 (Fetch USDⓈ-M Futures Open Interest history)
   *
   * Binance docs: GET /futures/data/openInterestHist
   *   period 仅支持 5m/15m/30m/1h/2h/4h/6h/12h/1d
   *   limit 最大 500
   *   仅 USDⓈ-M Futures 提供，spot 没有持仓量概念
   *
   * 返回原始数组 (Returns raw array):
   *   [{ symbol, sumOpenInterest, sumOpenInterestValue, timestamp }, ...]
   */
  async getOpenInterestHist(symbol, period = '1h', limit = 200) {
    const url = `${FUTURES_BASE_URL}/futures/data/openInterestHist`;
    const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
    return get(url, {
      symbol: String(symbol).toUpperCase(),
      period,
      limit: safeLimit
    });
  }
};

module.exports = {
  BinanceService,
  SPOT_BASE_URL,
  FUTURES_BASE_URL,
  getRateLimitState
};
