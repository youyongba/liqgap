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
const http = require('http');
const https = require('https');

const SPOT_BASE_URL = 'https://api.binance.com';
const FUTURES_BASE_URL = 'https://fapi.binance.com';
// 币本位合约 (COIN-M Futures)，持仓量聚合时用到 (BTCUSD_PERP 等)
const COINM_BASE_URL = 'https://dapi.binance.com';

// ---------------------------------------------------------------------------
// 抗抖动网络层 (Network resilience layer · 针对跨境/高丢包链路优化)
// ---------------------------------------------------------------------------
// 韩国等跨境主机到 Binance 的链路常见丢包/RST，四项加固：
//   1. keep-alive 连接池：复用 TCP+TLS 连接，省掉每次 2-3 个 RTT 的握手
//      （丢包链路上握手阶段最容易失败，这是稳定性的最大单项提升）
//   2. 快速超时 + 自动重试：单次尝试 6s 超时（默认），网络错误/5xx 自动
//      重试 1 次（默认）；总耗时 ≈ 12.5s，仍在前端 15s soft-timeout 之内
//   3. 并发去重：同一 URL+参数在途时共享同一个 Promise，避免慢链路下
//      轮询请求堆积放大拥塞
//   4. stale 兜底：全部重试失败时回退最近一次成功响应（默认 3min 内），
//      面板显示略旧的数据而不是空窗报错
// 环境变量：BINANCE_TIMEOUT_MS / BINANCE_RETRIES / BINANCE_STALE_TTL_MS
const DEFAULT_TIMEOUT_MS = (() => {
  const v = Number(process.env.BINANCE_TIMEOUT_MS);
  return Number.isFinite(v) && v >= 1000 ? v : 6000;
})();
const RETRIES = (() => {
  const v = Number(process.env.BINANCE_RETRIES);
  return Number.isFinite(v) && v >= 0 && v <= 5 ? Math.floor(v) : 1;
})();
const STALE_TTL_MS = (() => {
  const v = Number(process.env.BINANCE_STALE_TTL_MS);
  return Number.isFinite(v) && v >= 0 ? v : 180_000; // 0 = 关闭 stale 兜底
})();
const RETRY_BACKOFF_MS = 250;

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

// 配置了 HTTP(S)_PROXY 时不挂自定义 agent（axios 走自己的 proxy 通道，
// 两者同时设置会冲突）；直连时启用 keep-alive 连接池。
const _proxyConfigured = !!(
  process.env.HTTPS_PROXY || process.env.https_proxy ||
  process.env.HTTP_PROXY || process.env.http_proxy
);
const _keepAliveOpts = {
  keepAlive: true,
  keepAliveMsecs: 15_000,
  maxSockets: 50,
  maxFreeSockets: 10,
  // 空闲连接留 30s：Binance/Cloudflare 侧 idle timeout 更长，30s 内复用安全
  timeout: 30_000
};
const httpClient = axios.create({
  timeout: DEFAULT_TIMEOUT_MS,
  headers: BROWSER_HEADERS,
  ...(_proxyConfigured ? {} : {
    httpAgent: new http.Agent(_keepAliveOpts),
    httpsAgent: new https.Agent(_keepAliveOpts)
  })
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
  // U 本位 (/fapi/) 与币本位 (/dapi/) 都归到 futures 限流桶，
  // 避免币本位请求误用 spot 的冷却计时
  return /\/(fapi|dapi)\//.test(url) ? 'futures' : 'spot';
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

// ---------------------------------------------------------------------------
// 并发去重 + stale 兜底缓存
// ---------------------------------------------------------------------------
// _inflight：同一 URL+参数在途时后来的调用共享同一个 Promise。
//   慢链路下 10s 轮询 + 12s 响应会造成请求堆积，去重后同 key 永远只有 1 个
//   在途请求，还顺带合并了多个模块对同一份 K 线的重复拉取。
// _staleCache：每个 key 记住最近一次成功响应。全部重试失败时若缓存仍在
//   TTL 内则回退返回（console.warn 提示），面板保持有数据而不是报错空窗。
const _inflight = new Map();
const _staleCache = new Map(); // key → { at, data }
const STALE_MAX_ENTRIES = 150; // 安全阀：历史翻页 endTime 会产生一次性 key

function _cacheKey(url, params) {
  return `${url}?${JSON.stringify(params || {})}`;
}

function _staleSet(key, data) {
  if (STALE_TTL_MS <= 0) return;
  if (_staleCache.size >= STALE_MAX_ENTRIES && !_staleCache.has(key)) {
    // 淘汰最老条目（Map 迭代顺序 = 插入顺序）
    const oldest = _staleCache.keys().next().value;
    if (oldest !== undefined) _staleCache.delete(oldest);
  }
  _staleCache.delete(key); // 重新插入到队尾，近似 LRU
  _staleCache.set(key, { at: Date.now(), data });
}

function _staleGet(key) {
  if (STALE_TTL_MS <= 0) return null;
  const hit = _staleCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > STALE_TTL_MS) { _staleCache.delete(key); return null; }
  return hit;
}

// 网络错误（无 HTTP 状态码：ECONNRESET / 超时 / DNS 等）和 5xx 可重试；
// 4xx（参数错/限流/封禁）重试无意义且可能加重限流。
function _isRetryable(err) {
  const status = err.response && err.response.status;
  if (status == null) return true;
  return status >= 500;
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 通用 GET 请求 + 错误包装 (Generic GET with error wrapping)
//   错误信息里附带 HTTP 状态码与 URL 路径，便于排查
//   ECONNRESET / 403 / 451 / 429 等具体原因。
//
//   429/418 被检测到时，对应市场进入冷却期，期内的请求直接抛出
//   "rate-limit cooldown" 不再发起网络请求，避免雪崩。
async function get(url, params) {
  const market = _market(url);
  const key = _cacheKey(url, params);
  if (_isCoolingDown(market)) {
    // 冷却期内优先回 stale（有总比没有强），否则抛错让上层兜底
    const stale = _staleGet(key);
    if (stale) return stale.data;
    const remainMs = cooldown[market] - Date.now();
    const path = (url || '').replace(/^https?:\/\/[^/]+/, '');
    const err = new Error(
      `Binance API ${path} skipped (rate-limit cooldown ${Math.ceil(remainMs / 1000)}s remaining)`
    );
    err.cooldown = true;
    err.status = 429;
    throw err;
  }
  const pending = _inflight.get(key);
  if (pending) return pending;
  const p = _getWithRetry(url, params, key, market)
    .finally(() => { _inflight.delete(key); });
  _inflight.set(key, p);
  return p;
}

async function _getWithRetry(url, params, key, market) {
  const path = (url || '').replace(/^https?:\/\/[^/]+/, '');
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    if (attempt > 0) {
      await _sleep(RETRY_BACKOFF_MS * attempt);
      // 重试前再查一次冷却：上一次尝试可能刚触发 429
      if (_isCoolingDown(market)) break;
    }
    try {
      const response = await httpClient.get(url, { params });
      _staleSet(key, response.data);
      return response.data;
    } catch (err) {
      lastErr = err;
      if (!_isRetryable(err)) break;
      if (attempt < RETRIES) {
        // eslint-disable-next-line no-console
        console.warn(`[binance] ${path} attempt ${attempt + 1} failed (${err.message}), retrying…`);
      }
    }
  }

  const err = lastErr || new Error('Unknown Binance API error');
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

  // stale 兜底：重试全部失败但最近成功过 → 返回旧数据保面板不空窗
  const stale = _staleGet(key);
  if (stale) {
    // eslint-disable-next-line no-console
    console.warn(
      `[binance] ${path} failed after ${RETRIES + 1} attempt(s) (${reason}); ` +
      `serving stale copy from ${Math.round((Date.now() - stale.at) / 1000)}s ago`
    );
    return stale.data;
  }

  const wrapped = new Error(
    `Binance API ${path} failed (HTTP ${status || 'NETERR'}): ${reason}${hint}`
  );
  wrapped.cause = err;
  wrapped.status = status;
  throw wrapped;
}

const BinanceService = {
  /**
   * 获取 K 线 / 蜡烛图数据 (Fetch klines / candlesticks)
   *
   * 返回 Binance 原始数组结构 (Returns raw Binance kline arrays):
   *   [ openTime, open, high, low, close, volume, closeTime,
   *     quoteAssetVolume, numberOfTrades, takerBuyBase, takerBuyQuote, ignore ]
   */
  async getKlines(symbol, interval = '1h', limit = 100, marketType = 'spot', endTime = 0) {
    const url = resolveBaseUrl(marketType) + resolveKlinePath(marketType);
    const params = {
      symbol: String(symbol).toUpperCase(),
      interval,
      limit
    };
    // endTime（毫秒）：只取该时刻之前的 K 线，用于向前翻页加载历史
    if (Number(endTime) > 0) params.endTime = Number(endTime);
    return get(url, params);
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
  },

  /**
   * 获取币本位合约 K 线 (Fetch COIN-M Futures klines)
   *
   * Binance docs: GET https://dapi.binance.com/dapi/v1/klines
   *   symbol 用永续/交割合约符号，如 'BTCUSD_PERP'
   *
   * ⚠️ 字段顺序与 U 本位不同 (COIN-M kline array layout)：
   *   [0]openTime [1]o [2]h [3]l [4]c
   *   [5]volume(张数/contracts) [6]closeTime
   *   [7]baseAssetVolume(币数 BTC) [8]numberOfTrades
   *   [9]takerBuyVolume(张数) [10]takerBuyBaseAssetVolume(币数 BTC) [11]ignore
   */
  async getCoinMKlines(symbol, interval = '1h', limit = 200) {
    const url = `${COINM_BASE_URL}/dapi/v1/klines`;
    const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 1500));
    return get(url, {
      symbol: String(symbol).toUpperCase(),
      interval,
      limit: safeLimit
    });
  },

  /**
   * 获取币本位合约持仓量历史 (Fetch COIN-M Futures Open Interest history)
   *
   * Binance docs: GET https://dapi.binance.com/futures/data/openInterestHist
   *   参数用 pair + contractType（不是 symbol）：
   *     pair         交易对，如 'BTCUSD'
   *     contractType PERPETUAL / CURRENT_QUARTER / NEXT_QUARTER / ALL
   *   period 仅支持 5m/15m/30m/1h/2h/4h/6h/12h/1d，limit 最大 500
   *
   * 返回原始数组 (Returns raw array)：
   *   [{ pair, contractType, sumOpenInterest, sumOpenInterestValue, timestamp }, ...]
   *   其中 sumOpenInterest = 张数 (contracts，BTCUSD 每张 100 USD)，
   *        sumOpenInterestValue = 币数 (in base coin, e.g. BTC)
   */
  async getCoinMOpenInterestHist(pair, contractType = 'PERPETUAL', period = '1h', limit = 200) {
    const url = `${COINM_BASE_URL}/futures/data/openInterestHist`;
    const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
    return get(url, {
      pair: String(pair).toUpperCase(),
      contractType,
      period,
      limit: safeLimit
    });
  }
};

module.exports = {
  BinanceService,
  SPOT_BASE_URL,
  FUTURES_BASE_URL,
  COINM_BASE_URL,
  getRateLimitState
};
