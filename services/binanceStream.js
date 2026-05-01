'use strict';

/**
 * Binance WebSocket 流服务 (Binance WebSocket stream service)
 *
 * 职责 (Responsibilities)：
 *  - 按 (symbol, market) 维护 WS 连接：
 *      - 现货 (spot)    : wss://stream.binance.com:9443/stream
 *      - 合约 (futures) : wss://fstream.binance.com/market/stream
 *        （/market 路径于 2026-03 升级后才推送 @kline、@aggTrade、
 *         @markPrice 等"market"类流；旧的 /stream 只支持 @depth 等
 *         "public"类，所以不能直接用）
 *  - 订阅三类流并维护内存快照供 REST 路由零延迟读取：
 *      ① <sym>@kline_<interval>   滚动 K 线序列（每个 interval 独立缓存）
 *      ② <sym>@depth@100ms        订单簿增量 + REST snapshot 拼接出完整盘口
 *      ③ <sym>@aggTrade           最近 N 笔聚合成交滚动 buffer
 *  - 懒启动：首次访问对应 (symbol, market) 时才建立连接 / 订阅；
 *    一段时间无访问后自动断开节省资源。
 *  - 自动重连 + 心跳，断线后 K 线 / 订单簿会重新执行"REST snapshot + 增量"流程。
 *
 * 设计说明 (Design notes)：
 *  - 订单簿同步严格遵循官方 doc：
 *      https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams
 *      https://binance-docs.github.io/apidocs/futures/en/#how-to-manage-a-local-order-book-correctly
 *    其中合约多了一个 `pu`（前一帧 final update id）字段用于做严格连续性校验。
 *  - 缓存对外只读，内部以单线程事件循环安全更新。
 */

const EventEmitter = require('events');
const WebSocket = require('ws');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { BinanceService } = require('./binance');

// 与 axios 一致：自动读取 HTTPS_PROXY / HTTP_PROXY，便于在受限网络下走代理
// (Honor HTTPS_PROXY / HTTP_PROXY env so WS works behind the same proxy axios uses.)
const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy ||
                  process.env.HTTP_PROXY || process.env.http_proxy || null;
const PROXY_AGENT = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : null;
if (PROXY_AGENT) {
  // eslint-disable-next-line no-console
  console.log(`[stream] using HTTPS proxy: ${PROXY_URL}`);
}

// ---------------- 配置 (Configuration) ----------------
// 2026-03 Binance USDⓈ-M Futures WebSocket 升级后，单连接被拆成两类路径：
//   /stream         (a.k.a. /ws/)         → 仅推 /public 类（@depth, @trade,
//                                              @bookTicker, @forceOrder ...）
//   /market/stream  (a.k.a. /market/ws/)  → 仅推 /market 类（@kline,
//                                              @aggTrade, @markPrice ...）
// 同一条连接只能订阅同一类，否则跨类的 stream 会"silent fail"——
// SUBSCRIBE 回 result=null（成功），但永远收不到任何 event。
// 现货保持单连接 (wss://stream.binance.com:9443/stream)。
//
// ref: https://developers.binance.com/docs/derivatives/usds-margined-futures
const SPOT_WS_HOST       = 'wss://stream.binance.com:9443';
const FUTURES_WS_HOST    = 'wss://fstream.binance.com';
const FUTURES_MARKET_WS  = `${FUTURES_WS_HOST}/market`;
//
// 路由规则：传入 stream 名 → 应该走哪条 channel 的 base
//   futures: kline/aggTrade/markPrice → market；其余 → public
//   spot:    全部 → market（spot 没有第二条 path）

const KLINE_MAX_HISTORY  = 1500; // 单 interval 最多保留 1500 根
const AGG_TRADES_BUFFER  = 1500; // 聚合成交滚动 buffer 上限（内存）
const AGG_REST_LIMIT_MAX = 1000; // Binance REST aggTrades 接口 limit 上限

const IDLE_TIMEOUT_MS   = 10 * 60 * 1000; // 10 分钟无访问 → 断开
const PING_INTERVAL_MS  = 30 * 1000;       // 客户端 30s 主动 ping
const PONG_TIMEOUT_MS   = 10 * 1000;       // ping 后 10s 没回应视为死连
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10_000, 20_000, 30_000];

// 订单簿 REST snapshot 用的合法档位（与 routes/orderbook.js 同步）
const OB_DEPTH_ALLOWED = {
  spot: [5, 10, 20, 50, 100, 500, 1000, 5000],
  futures: [5, 10, 20, 50, 100, 500, 1000]
};
function alignBinanceDepth(d, market) {
  const list = OB_DEPTH_ALLOWED[market] || OB_DEPTH_ALLOWED.futures;
  for (const v of list) if (d <= v) return v;
  return list[list.length - 1];
}

// ---------------- 通用工具 (Helpers) ----------------
function _now() { return Date.now(); }
function _key(symbol, market) {
  return `${String(symbol).toUpperCase()}|${market === 'spot' ? 'spot' : 'futures'}`;
}
/**
 * 按 stream 名判断该走哪条 channel。
 * (Binance 2026-03 split: /market vs /public — they refuse cross-category
 *  streams on the same socket.)
 */
function _classifyStream(name, market) {
  if (market === 'spot') return 'market';
  // futures：market 类（推送在 /market 路径）
  if (/@kline_/.test(name)) return 'market';
  if (/@aggTrade$/.test(name)) return 'market';
  if (/@markPrice/.test(name)) return 'market';
  if (/@miniTicker/.test(name) || /@ticker$/.test(name)) return 'market';
  // 其它（@depth, @trade, @bookTicker, @forceOrder ...）默认走 public
  return 'public';
}

// 把 WS 推送的 K 线对象转成 normalizeKlines 一致的字段
function _wsKlineToCandle(k) {
  // k 是 e.k 字段
  return {
    openTime: Number(k.t),
    open: Number(k.o),
    high: Number(k.h),
    low: Number(k.l),
    close: Number(k.c),
    volume: Number(k.v),
    closeTime: Number(k.T),
    quoteVolume: Number(k.q),
    trades: Number(k.n),
    takerBuyBase: Number(k.V),
    takerBuyQuote: Number(k.Q),
    isFinal: !!k.x
  };
}

// 把 REST 返回的原始 K 线数组转成 candle 对象（与 normalizeKlines 一致字段）
function _restKlineToCandle(arr) {
  return {
    openTime: Number(arr[0]),
    open: Number(arr[1]),
    high: Number(arr[2]),
    low: Number(arr[3]),
    close: Number(arr[4]),
    volume: Number(arr[5]),
    closeTime: Number(arr[6]),
    quoteVolume: Number(arr[7]),
    trades: Number(arr[8]),
    takerBuyBase: Number(arr[9]),
    takerBuyQuote: Number(arr[10]),
    isFinal: true
  };
}

// 把 candle 对象再转回 normalizeKlines 期望的 raw 数组格式
// （路由层 klineIndicators.normalizeKlines 期望 Binance 的原始数组）
function _candleToRestArray(c) {
  return [
    c.openTime, String(c.open), String(c.high), String(c.low), String(c.close),
    String(c.volume), c.closeTime, String(c.quoteVolume), c.trades,
    String(c.takerBuyBase), String(c.takerBuyQuote), '0'
  ];
}

// ---------------- StreamChannel：单条 WS 连接 ----------------
//
// 一个 channel 对应一条 underlying WebSocket，按 base URL 区分：
//   - spot:           wss://stream.binance.com:9443/stream
//   - futures market: wss://fstream.binance.com/market/stream  (kline/aggTrade)
//   - futures public: wss://fstream.binance.com/stream         (depth/trade)
//
// channel 只管 ws 生命周期（连接、重连、心跳、URL-bound 订阅），
// 实际 message 解析仍交给 hub._onMessage 统一处理。
//
class StreamChannel {
  constructor({ label, baseUrl, hub }) {
    this.label = label;          // 'market' | 'public'
    this.baseUrl = baseUrl;      // 不带 /stream 后缀
    this.hub = hub;              // 父 hub（用于回调消息处理 & 取 symbol/market 标签）
    this.alive = true;
    this.ws = null;
    this.connected = false;
    this.connecting = null;
    this.reconnectAttempt = 0;
    this.subscribedStreams = new Set();
    this.connectedStreamsSnapshot = null;
    this.pingTimer = null;
    this.pongTimer = null;
    this._subscribeFlush = null;
  }

  _tag() { return `${this.hub.symbol} ${this.hub.market}/${this.label}`; }

  /** 把 streams 加入订阅集合并确保 ws URL 已包含它们（同 tick 多次调用会合并） */
  async subscribe(streams) {
    if (!streams || streams.length === 0) return;
    streams.forEach((s) => this.subscribedStreams.add(s));
    if (!this._subscribeFlush) {
      this._subscribeFlush = Promise.resolve().then(async () => {
        this._subscribeFlush = null;
        await this._doConnectIfNeeded();
      });
    }
    return this._subscribeFlush;
  }

  async _doConnectIfNeeded() {
    if (!this.connected) {
      await this._ensureConnected();
      return;
    }
    const inUrl = this.connectedStreamsSnapshot || new Set();
    let needsReconnect = false;
    for (const s of this.subscribedStreams) {
      if (!inUrl.has(s)) { needsReconnect = true; break; }
    }
    if (needsReconnect) await this._reconnectForNewStreams();
  }

  async _ensureConnected() {
    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const streamsList = Array.from(this.subscribedStreams);
      // 没订阅就不连——subscribe 才是入口
      if (streamsList.length === 0) {
        this.connecting = null;
        resolve();
        return;
      }
      const url = `${this.baseUrl}/stream?streams=${streamsList.join('/')}`;
      // eslint-disable-next-line no-console
      console.log(`[stream] ${this._tag()} connecting ${url}`);
      const wsOpts = { handshakeTimeout: 10_000 };
      if (PROXY_AGENT) wsOpts.agent = PROXY_AGENT;
      const ws = new WebSocket(url, wsOpts);
      this.ws = ws;
      this.connectedStreamsSnapshot = new Set(streamsList);

      const onOpen = () => {
        this.connected = true;
        this.reconnectAttempt = 0;
        this.connecting = null;
        this._setupHeartbeat();
        // eslint-disable-next-line no-console
        console.log(`[stream] ${this._tag()} connected (streams=${streamsList.length})`);
        // 通知 hub：channel 重建后跟它有关的缓存需要 invalidate
        try { this.hub._onChannelConnected(this); } catch (_) { /* noop */ }
        resolve();
      };
      const onErrorEvt = (err) => {
        // eslint-disable-next-line no-console
        console.warn(`[stream] ${this._tag()} ws error: ${err.message}`);
        if (this.connecting) { this.connecting = null; reject(err); }
      };
      const onCloseEvt = (code, reason) => {
        // eslint-disable-next-line no-console
        console.warn(`[stream] ${this._tag()} ws closed (${code} ${reason})`);
        this.connected = false;
        this.connecting = null;
        this._teardownHeartbeat();
        if (this.alive) this._scheduleReconnect();
      };

      ws.on('open', onOpen);
      ws.on('error', onErrorEvt);
      ws.on('close', onCloseEvt);
      ws.on('message', (data) => this.hub._onMessage(data, this));
      ws.on('pong', () => this._onPong());
    });
    return this.connecting;
  }

  async _reconnectForNewStreams() {
    if (this.ws) {
      try { this.ws.removeAllListeners('close'); } catch (_) { /* noop */ }
      try { this.ws.removeAllListeners('error'); } catch (_) { /* noop */ }
      try { this.ws.removeAllListeners('message'); } catch (_) { /* noop */ }
      try { this.ws.removeAllListeners('pong'); } catch (_) { /* noop */ }
      try { this.ws.close(); } catch (_) { /* noop */ }
      this.ws = null;
    }
    this.connected = false;
    this.connecting = null;
    this._teardownHeartbeat();
    // eslint-disable-next-line no-console
    console.log(
      `[stream] ${this._tag()} reconnect with new URL streams=${Array.from(this.subscribedStreams).join(',')}`
    );
    return this._ensureConnected();
  }

  _setupHeartbeat() {
    this._teardownHeartbeat();
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try { this.ws.ping(); } catch (_) { /* noop */ }
      this.pongTimer = setTimeout(() => {
        // eslint-disable-next-line no-console
        console.warn(`[stream] ${this._tag()} pong timeout, terminating`);
        try { this.ws.terminate(); } catch (_) { /* noop */ }
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }
  _teardownHeartbeat() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
  }
  _onPong() {
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
  }

  _scheduleReconnect() {
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
    this.reconnectAttempt += 1;
    // eslint-disable-next-line no-console
    console.log(`[stream] ${this._tag()} reconnect in ${delay}ms (attempt ${this.reconnectAttempt})`);
    setTimeout(() => {
      if (!this.alive) return;
      this._ensureConnected().catch(() => { /* close handler will reschedule */ });
    }, delay);
  }

  destroy() {
    this.alive = false;
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch (_) { /* noop */ }
      this.ws = null;
    }
    this.connected = false;
    this.connecting = null;
    this._teardownHeartbeat();
    this.subscribedStreams.clear();
  }

  status() {
    return {
      label: this.label,
      url: this.ws ? this.ws.url : null,
      connected: this.connected,
      streams: Array.from(this.subscribedStreams)
    };
  }
}

// ---------------- StreamHub：单 (symbol, market) 的 WS 连接 ----------------

class StreamHub extends EventEmitter {
  constructor(symbol, market) {
    super();
    // 多 SSE 客户端并发订阅时避免 Node 默认 10 个 listener 警告
    this.setMaxListeners(64);
    this.symbol = String(symbol).toUpperCase();
    this.market = market === 'spot' ? 'spot' : 'futures';
    this.lower = this.symbol.toLowerCase();

    // 连接通道：spot 单条；futures 拆 market / public（必须 — Binance 2026-03 规则）
    this.channels = {};
    if (this.market === 'spot') {
      this.channels.market = new StreamChannel({
        label: 'spot',
        baseUrl: SPOT_WS_HOST,
        hub: this
      });
    } else {
      this.channels.market = new StreamChannel({
        label: 'market',
        baseUrl: FUTURES_MARKET_WS,
        hub: this
      });
      this.channels.public = new StreamChannel({
        label: 'public',
        baseUrl: FUTURES_WS_HOST,
        hub: this
      });
    }

    // 缓存 (caches)
    //   K 线：interval -> { candles: Map<openTime, candle>, lastEventAt }
    this.klineCache = new Map();
    //   订单簿
    this.bookState = {
      ready: false,
      reconciling: null,        // Promise，避免并发重建
      bids: new Map(),          // priceString -> qtyNumber
      asks: new Map(),
      lastUpdateId: 0,
      buffer: [],               // snapshot 完成前缓冲的增量
      lastU: null,              // 上一帧 final updateId
      lastEventAt: 0,
      bestBid: null,
      bestAsk: null
    };
    //   聚合成交
    this.aggTrades = [];
    this.aggTradesReady = false;
    this.aggTradesInit = null;   // Promise，避免并发拉 REST seed

    // idle 管理
    this.lastAccessAt = _now();
    this.idleTimer = null;
    this._scheduleIdleCheck();
  }

  // -------------- 公共 API（路由层调用） --------------

  /** 获取最近 N 根 K 线（已按 openTime 升序）。首次会触发 REST 拉取 + 订阅。 */
  async getKlines(interval, limit) {
    this._touch();
    await this._ensureKlineSubscription(interval);
    const entry = this.klineCache.get(interval);
    const all = Array.from(entry.candles.values()).sort((a, b) => a.openTime - b.openTime);
    const lim = Math.min(Math.max(Number(limit) || 100, 1), KLINE_MAX_HISTORY);
    return all.slice(-lim);
  }

  /** 获取当前订单簿快照。返回 { bids, asks, lastUpdateId, bestBid, bestAsk } */
  async getOrderBook(depthHint) {
    this._touch();
    await this._ensureOrderBookReady(depthHint);
    const bs = this.bookState;
    // 排序输出：bids 价降序、asks 价升序，与 REST API 保持一致
    const bids = Array.from(bs.bids.entries())
      .sort((a, b) => Number(b[0]) - Number(a[0]))
      .map(([p, q]) => [p, String(q)]);
    const asks = Array.from(bs.asks.entries())
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([p, q]) => [p, String(q)]);
    return { bids, asks, lastUpdateId: bs.lastUpdateId };
  }

  /** 获取最近 N 笔聚合成交。 */
  async getAggTrades(limit) {
    this._touch();
    await this._ensureAggTradesReady();
    const lim = Math.min(Math.max(Number(limit) || 500, 1), AGG_TRADES_BUFFER);
    return this.aggTrades.slice(-lim);
  }

  // -------------- channel 工具 --------------

  /** 合并所有 channel 已订阅 stream（用于 healthcheck / has() 等读检查） */
  get subscribedStreams() {
    const all = new Set();
    for (const ch of Object.values(this.channels)) {
      for (const s of ch.subscribedStreams) all.add(s);
    }
    return all;
  }

  /** 把 stream 路由到正确的 channel（按 Binance 2026-03 split 规则） */
  _channelFor(streamName) {
    const cls = _classifyStream(streamName, this.market);
    return this.channels[cls] || this.channels.market;
  }

  /** channel 重新连上时被回调：让相关缓存 invalidate（增量序列断了） */
  _onChannelConnected(ch) {
    // public channel 重连 → 订单簿增量序列已断，需要重拉 snapshot
    if (this.market === 'spot' || ch.label === 'public') {
      this.bookState.ready = false;
      this.bookState.buffer = [];
    }
    // market channel 重连 → aggTrade 流也断了
    if (ch.label === 'market' || ch.label === 'spot') {
      this.aggTradesReady = false;
    }
  }

  /** 任一 channel 是否已连接 */
  get connected() {
    const chs = Object.values(this.channels);
    if (chs.length === 0) return false;
    return chs.every((c) => c.connected);
  }

  /** 状态信息（供 /api/stream/status） */
  getStatus() {
    return {
      symbol: this.symbol,
      market: this.market,
      channels: Object.values(this.channels).map((c) => c.status()),
      streams: Array.from(this.subscribedStreams),
      klineIntervals: Array.from(this.klineCache.keys()).map((k) => ({
        interval: k,
        bars: this.klineCache.get(k).candles.size,
        lastEventAt: this.klineCache.get(k).lastEventAt
      })),
      orderBook: {
        ready: this.bookState.ready,
        lastUpdateId: this.bookState.lastUpdateId,
        bidsLevels: this.bookState.bids.size,
        asksLevels: this.bookState.asks.size,
        bestBid: this.bookState.bestBid,
        bestAsk: this.bookState.bestAsk,
        lastEventAt: this.bookState.lastEventAt
      },
      aggTrades: {
        ready: this.aggTradesReady,
        count: this.aggTrades.length,
        latestT: this.aggTrades.length ? this.aggTrades[this.aggTrades.length - 1].T : null
      },
      lastAccessAt: this.lastAccessAt
    };
  }

  // -------------- 内部：连接与订阅 --------------

  _touch() { this.lastAccessAt = _now(); }

  _scheduleIdleCheck() {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = setInterval(() => {
      if (_now() - this.lastAccessAt > IDLE_TIMEOUT_MS) {
        // eslint-disable-next-line no-console
        console.log(`[stream] ${this.symbol} ${this.market} idle > ${IDLE_TIMEOUT_MS / 1000}s, closing`);
        this.destroy();
        return;
      }
      // 订单簿活性兜底：订阅了 depth 但 ready=false / 长时间无增量 → 主动 resync
      // (Health-check fallback so a missed reconcile doesn't freeze the book.)
      const depthStream = `${this.lower}@depth@100ms`;
      if (this.subscribedStreams.has(depthStream)) {
        const idleMs = this.bookState.lastEventAt
          ? _now() - this.bookState.lastEventAt
          : Infinity;
        if (!this.bookState.ready) {
          // 一直没 ready → 持续重试
          this._scheduleBookResync(100);
        } else if (idleMs > 30_000) {
          // ready 但超过 30s 没新 depth event → 视为假活，强制重建
          // eslint-disable-next-line no-console
          console.warn(
            `[stream] ${this.symbol} ${this.market} book idle ${(idleMs / 1000).toFixed(1)}s, force resync`
          );
          this.bookState.ready = false;
          this.bookState.buffer = [];
          this._scheduleBookResync(100);
        }
      }
    }, Math.min(IDLE_TIMEOUT_MS / 2, 15_000));
  }

  // 注：连接 / 重连 / 心跳逻辑已搬到 StreamChannel；hub 只负责按 stream
  // 路由订阅到对应 channel，并在 channel 重连后由 _onChannelConnected 兜底
  // 重置缓存。

  /**
   * 把若干 stream 路由到对应 channel 后订阅。
   * (Group by channel so we issue at most one URL-bound reconnect per channel
   *  even if e.g. SSE seeds kline+depth+aggTrade in one tick.)
   */
  async _subscribe(streams) {
    if (!streams || streams.length === 0) return;
    const byChannel = new Map();
    for (const s of streams) {
      const ch = this._channelFor(s);
      if (!byChannel.has(ch)) byChannel.set(ch, []);
      byChannel.get(ch).push(s);
    }
    await Promise.all(
      Array.from(byChannel.entries()).map(([ch, list]) => ch.subscribe(list))
    );
  }

  /** 兼容旧调用：等所有 channel 都连上 */
  async _doConnectIfNeeded() {
    await Promise.all(
      Object.values(this.channels).map((c) =>
        c.subscribedStreams.size > 0 ? c._doConnectIfNeeded() : Promise.resolve()
      )
    );
  }

  // -------------- WS 消息分发 --------------
  // 第二个参数 channel 仅用于日志 / 路由判定，不影响事件解析
  _onMessage(raw, _channel) {
    let pkt;
    try { pkt = JSON.parse(raw.toString()); } catch (_) { return; }
    // 订阅确认 / 错误回包
    if (pkt && (pkt.result !== undefined || pkt.error)) {
      if (pkt.error) {
        // eslint-disable-next-line no-console
        console.warn('[stream] sub error', this.symbol, this.market, JSON.stringify(pkt));
      } else {
        // eslint-disable-next-line no-console
        console.log(`[stream] ${this.symbol} ${this.market} sub-ack id=${pkt.id} result=${JSON.stringify(pkt.result)}`);
      }
      return;
    }
    // combined stream 形如 { stream: '...', data: {...} }
    const data = pkt && pkt.data ? pkt.data : pkt;
    const stream = pkt && pkt.stream ? pkt.stream : '';
    if (!data || !data.e) {
      return;
    }
    // 首次收到每种事件 e 时打日志，方便定位"订阅生效但分发失败"的问题
    if (!this._seenEventTypes) this._seenEventTypes = new Set();
    if (!this._seenEventTypes.has(data.e)) {
      this._seenEventTypes.add(data.e);
      const chLabel = _channel ? _channel.label : '?';
      // eslint-disable-next-line no-console
      console.log(`[stream] ${this.symbol} ${this.market}/${chLabel} first '${data.e}' arrived (stream=${stream})`);
    }
    switch (data.e) {
      case 'kline':         this._handleKline(data, stream); break;
      case 'depthUpdate':   this._handleDepthUpdate(data); break;
      case 'aggTrade':      this._handleAggTrade(data); break;
      default: /* ignore */ break;
    }
  }

  // -------------- K 线流 --------------
  async _ensureKlineSubscription(interval) {
    if (!this.klineCache.has(interval)) {
      this.klineCache.set(interval, {
        candles: new Map(),
        lastEventAt: 0,
        seeding: null,
        ready: false
      });
    }
    const entry = this.klineCache.get(interval);
    const stream = `${this.lower}@kline_${interval}`;
    if (!this.subscribedStreams.has(stream)) {
      await this._subscribe([stream]);
    } else {
      // 已订阅但可能尚未连接（首次并发场景）→ 仍需 await 确保 ws OPEN
      await this._doConnectIfNeeded();
    }
    if (!entry.ready) {
      if (!entry.seeding) {
        entry.seeding = this._seedKlineHistory(interval).then(() => {
          entry.ready = true;
          entry.seeding = null;
        }).catch((err) => {
          entry.seeding = null;
          throw err;
        });
      }
      await entry.seeding;
    }
  }

  async _seedKlineHistory(interval) {
    const raw = await BinanceService.getKlines(this.symbol, interval, KLINE_MAX_HISTORY, this.market);
    const entry = this.klineCache.get(interval);
    if (!entry) return;
    for (const arr of raw) {
      const c = _restKlineToCandle(arr);
      // WS 已经 push 进来的更新优先（保持最新值）
      if (!entry.candles.has(c.openTime)) entry.candles.set(c.openTime, c);
    }
    this._trimKlineCache(entry);
  }

  _handleKline(data, _stream) {
    const itv = data.k && data.k.i;
    if (!itv) return;
    const entry = this.klineCache.get(itv);
    if (!entry) {
      // eslint-disable-next-line no-console
      console.warn(
        `[stream] ${this.symbol} ${this.market} got kline ${itv}`
        + ` but no cache entry (subscribed=${Array.from(this.subscribedStreams).join(',')})`
      );
      return;
    }
    const c = _wsKlineToCandle(data.k);
    entry.candles.set(c.openTime, c);
    entry.lastEventAt = _now();
    this._trimKlineCache(entry);
    if (!this._loggedFirstKline) {
      this._loggedFirstKline = true;
      // eslint-disable-next-line no-console
      console.log(
        `[stream] ${this.symbol} ${this.market} first kline cached (${itv} close=${c.close})`
      );
    }
    try { this.emit('kline', { interval: itv, candle: c }); } catch (_) { /* noop */ }
  }

  _trimKlineCache(entry) {
    if (entry.candles.size <= KLINE_MAX_HISTORY) return;
    const keysAsc = Array.from(entry.candles.keys()).sort((a, b) => a - b);
    const drop = entry.candles.size - KLINE_MAX_HISTORY;
    for (let i = 0; i < drop; i += 1) entry.candles.delete(keysAsc[i]);
  }

  /** 把缓存导出成 normalizeKlines 期望的原始数组格式（路由层无需改下游） */
  klinesAsRestArrays(interval, limit) {
    const entry = this.klineCache.get(interval);
    if (!entry) return [];
    const arr = Array.from(entry.candles.values()).sort((a, b) => a.openTime - b.openTime);
    const lim = Math.min(Math.max(Number(limit) || 100, 1), KLINE_MAX_HISTORY);
    return arr.slice(-lim).map(_candleToRestArray);
  }

  // -------------- 订单簿增量同步 --------------

  async _ensureOrderBookReady(depthHint) {
    const stream = `${this.lower}@depth@100ms`;
    if (!this.subscribedStreams.has(stream)) {
      await this._subscribe([stream]);
    } else {
      await this._doConnectIfNeeded();
    }
    if (this.bookState.ready) return;
    if (this.bookState.reconciling) return this.bookState.reconciling;
    this.bookState.reconciling = this._reconcileOrderBook(depthHint)
      .then(() => { this.bookState.reconciling = null; })
      .catch((err) => {
        this.bookState.reconciling = null;
        throw err;
      });
    return this.bookState.reconciling;
  }

  /**
   * 订单簿首次建立 / 重连后重建：
   *   1) 此前 WS 已经 push 进来的增量被堆到 buffer
   *   2) 拉一次 REST snapshot 拿到 lastUpdateId
   *   3) 丢弃 buffer 中 final u <= snapshotLastUpdateId 的事件
   *   4) 校验首条 valid 事件：
   *        spot     : event.U <= snapshotLastUpdateId+1 <= event.u
   *        futures  : event.U <= snapshotLastUpdateId  <= event.u
   *      （官方文档差异已实测）
   *   5) 顺序 apply 剩余事件并把后续 push 串行 apply
   */
  async _reconcileOrderBook(depthHint) {
    // 用大档位拉一次完整 snapshot（与 routes/orderbook.js 对齐）
    const want = Math.max(Number(depthHint) || 0, 100);
    const fetchDepth = alignBinanceDepth(want, this.market);
    const snap = await BinanceService.getOrderBook(this.symbol, fetchDepth, this.market);
    const snapId = Number(snap.lastUpdateId);

    // 把 snapshot 灌入 maps
    this.bookState.bids.clear();
    this.bookState.asks.clear();
    for (const [p, q] of (snap.bids || [])) {
      const qty = Number(q);
      if (qty > 0) this.bookState.bids.set(String(p), qty);
    }
    for (const [p, q] of (snap.asks || [])) {
      const qty = Number(q);
      if (qty > 0) this.bookState.asks.set(String(p), qty);
    }
    this.bookState.lastUpdateId = snapId;

    // 处理 buffer 中的事件
    const buf = this.bookState.buffer;
    this.bookState.buffer = [];
    let aligned = false;
    for (const ev of buf) {
      const U = Number(ev.U);
      const u = Number(ev.u);
      if (u <= snapId) continue; // 已经包含在 snapshot 中
      if (!aligned) {
        const spotOk    = U <= snapId + 1 && snapId + 1 <= u;
        const futuresOk = U <= snapId && u >= snapId;
        const ok = this.market === 'spot' ? spotOk : futuresOk;
        if (!ok) {
          // 第一条不对齐 → 丢弃当前 snapshot，下次再 reconcile
          // eslint-disable-next-line no-console
          console.warn(`[stream] ${this.symbol} ${this.market} depth not aligned (snap=${snapId} U=${U} u=${u}), retry`);
          this.bookState.ready = false;
          // 让下一个调用者再触发 reconcile
          throw new Error('depth snapshot not aligned, retrying next request');
        }
        aligned = true;
      }
      this._applyDepthDiff(ev);
    }
    this.bookState.ready = true;
    this.bookState.lastEventAt = _now();
    this._refreshBestPrices();
  }

  _handleDepthUpdate(data) {
    if (!this.bookState.ready) {
      // 还在等 snapshot，先缓冲
      this.bookState.buffer.push(data);
      // 防止 buffer 失控
      if (this.bookState.buffer.length > 500) this.bookState.buffer.shift();
      return;
    }
    const U = Number(data.U);
    const u = Number(data.u);
    const pu = data.pu != null ? Number(data.pu) : null;
    // 严格连续性校验
    if (this.market === 'futures' && pu != null && this.bookState.lastU != null && pu !== this.bookState.lastU) {
      // 不连续 → 重置缓存
      // eslint-disable-next-line no-console
      console.warn(`[stream] ${this.symbol} futures depth gap (pu=${pu} expected=${this.bookState.lastU}), resync`);
      this.bookState.ready = false;
      this.bookState.buffer = [];
      this._scheduleBookResync(100);
      return;
    }
    if (this.market === 'spot' && u <= this.bookState.lastUpdateId) return;
    this._applyDepthDiff(data);
    this.bookState.lastUpdateId = u;
    this.bookState.lastU = u;
    this.bookState.lastEventAt = _now();
    this._refreshBestPrices();
    // 广播给 SSE 订阅者（订阅者侧自己做 100ms 节流，hub 不替它节流）
    try { this.emit('book', { lastUpdateId: u }); } catch (_) { /* noop */ }
  }

  /**
   * 调度订单簿 resync：失败自动指数退避重试。
   * 解决"reconcile 因 REST 限流 / 网络瞬断而失败 → ready 永远停在 false → 订单簿冻结"的问题。
   * (Self-healing reconcile loop with exponential backoff so a single
   *  REST failure doesn't leave the book frozen forever.)
   */
  _scheduleBookResync(depthHint = 100) {
    if (this._bookResyncRunning) return; // 已有任务在跑
    this._bookResyncRunning = true;
    const attempt = (n) => {
      // 已被 destroy / 取消订阅 → 退出
      if (!this.idleTimer || !this.subscribedStreams.has(`${this.lower}@depth@100ms`)) {
        this._bookResyncRunning = false;
        return;
      }
      this._ensureOrderBookReady(depthHint)
        .then(() => {
          this._bookResyncRunning = false;
          // eslint-disable-next-line no-console
          console.log(`[stream] ${this.symbol} ${this.market} book resynced after ${n} attempt(s)`);
        })
        .catch((err) => {
          const delay = Math.min(2000 * (2 ** Math.min(n - 1, 5)), 60_000);
          // eslint-disable-next-line no-console
          console.warn(
            `[stream] ${this.symbol} ${this.market} book resync attempt ${n} failed:`
            + ` ${err.message} · retry in ${delay}ms`
          );
          setTimeout(() => attempt(n + 1), delay);
        });
    };
    attempt(1);
  }

  _applyDepthDiff(ev) {
    for (const [p, q] of (ev.b || [])) {
      const qty = Number(q);
      if (qty === 0) this.bookState.bids.delete(String(p));
      else this.bookState.bids.set(String(p), qty);
    }
    for (const [p, q] of (ev.a || [])) {
      const qty = Number(q);
      if (qty === 0) this.bookState.asks.delete(String(p));
      else this.bookState.asks.set(String(p), qty);
    }
  }

  _refreshBestPrices() {
    let bb = -Infinity, ba = Infinity;
    for (const p of this.bookState.bids.keys()) { const v = Number(p); if (v > bb) bb = v; }
    for (const p of this.bookState.asks.keys()) { const v = Number(p); if (v < ba) ba = v; }
    this.bookState.bestBid = Number.isFinite(bb) ? bb : null;
    this.bookState.bestAsk = Number.isFinite(ba) ? ba : null;
  }

  // -------------- 聚合成交 --------------
  async _ensureAggTradesReady() {
    const stream = `${this.lower}@aggTrade`;
    if (!this.subscribedStreams.has(stream)) {
      await this._subscribe([stream]);
    } else {
      await this._doConnectIfNeeded();
    }
    if (this.aggTradesReady) return;
    if (this.aggTradesInit) return this.aggTradesInit;
    this.aggTradesInit = (async () => {
      try {
        // REST seed 不能超过 Binance 接口的硬上限（1000），
        // WS 流后续会持续向 buffer 追加直到 AGG_TRADES_BUFFER。
        const seedLimit = Math.min(AGG_TRADES_BUFFER, AGG_REST_LIMIT_MAX);
        const seed = await BinanceService.getAggTrades(this.symbol, seedLimit, this.market);
        // REST seed 给出最近 N 笔；若 WS 已经 push 进若干，我们按 a 字段去重
        const seenA = new Set(this.aggTrades.map((t) => t.a));
        const merged = [];
        for (const t of seed) {
          if (!seenA.has(t.a)) merged.push(t);
        }
        const combined = merged.concat(this.aggTrades);
        combined.sort((a, b) => Number(a.T) - Number(b.T));
        this.aggTrades = combined.slice(-AGG_TRADES_BUFFER);
        this.aggTradesReady = true;
      } finally {
        this.aggTradesInit = null;
      }
    })();
    return this.aggTradesInit;
  }

  _handleAggTrade(data) {
    // data 字段：a, p, q, f, l, T, m, M
    const t = {
      a: data.a, p: data.p, q: data.q, f: data.f, l: data.l,
      T: data.T, m: data.m, M: data.M
    };
    this.aggTrades.push(t);
    if (this.aggTrades.length > AGG_TRADES_BUFFER) {
      this.aggTrades.splice(0, this.aggTrades.length - AGG_TRADES_BUFFER);
    }
    try { this.emit('trade', t); } catch (_) { /* noop */ }
  }

  // -------------- 销毁 --------------
  destroy() {
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }
    for (const ch of Object.values(this.channels)) {
      try { ch.destroy(); } catch (_) { /* noop */ }
    }
    this.bookState.ready = false;
    this.bookState.buffer = [];
    this.aggTradesReady = false;
    streamHubs.delete(_key(this.symbol, this.market));
  }
}

// ---------------- 全局 hubs 池 ----------------
const streamHubs = new Map();
function getHub(symbol, market) {
  const k = _key(symbol, market);
  let hub = streamHubs.get(k);
  if (!hub) {
    hub = new StreamHub(symbol, market);
    streamHubs.set(k, hub);
  }
  return hub;
}

function getStatusAll() {
  return Array.from(streamHubs.values()).map((h) => h.getStatus());
}

module.exports = {
  getHub,
  getStatusAll,
  // 测试 / 调试用
  _streamHubs: streamHubs,
  alignBinanceDepth
};
