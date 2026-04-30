'use strict';

/**
 * Binance WebSocket 流服务 (Binance WebSocket stream service)
 *
 * 职责 (Responsibilities)：
 *  - 按 (symbol, market) 维护 WS 连接：
 *      - 现货 (spot)    : wss://stream.binance.com:9443/stream
 *      - 合约 (futures) : wss://fstream.binance.com/stream
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
const SPOT_WS_BASE    = 'wss://stream.binance.com:9443';
const FUTURES_WS_BASE = 'wss://fstream.binance.com';

const KLINE_MAX_HISTORY = 1500; // 单 interval 最多保留 1500 根
const AGG_TRADES_BUFFER = 1500; // 聚合成交滚动 buffer 上限

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
function _wsBase(market) { return market === 'spot' ? SPOT_WS_BASE : FUTURES_WS_BASE; }

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

// ---------------- StreamHub：单 (symbol, market) 的 WS 连接 ----------------

class StreamHub {
  constructor(symbol, market) {
    this.symbol = String(symbol).toUpperCase();
    this.market = market === 'spot' ? 'spot' : 'futures';
    this.lower = this.symbol.toLowerCase();

    // ws 连接相关 (connection state)
    this.ws = null;
    this.connected = false;
    this.connecting = null; // Promise 用于并发等待连接完成
    this.reconnectAttempt = 0;
    this.pingTimer = null;
    this.pongTimer = null;
    this.subId = 1;
    // 已订阅的流名称集合（用于断线重连时恢复）
    this.subscribedStreams = new Set();

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

  /** 状态信息（供 /api/stream/status） */
  getStatus() {
    return {
      symbol: this.symbol,
      market: this.market,
      ws: this.ws ? this.ws.url : null,
      connected: this.connected,
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
      }
    }, IDLE_TIMEOUT_MS / 2);
  }

  /** 建立或复用 WS 连接 */
  async _ensureConnected() {
    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const url = `${_wsBase(this.market)}/stream`;
      // eslint-disable-next-line no-console
      console.log(`[stream] ${this.symbol} ${this.market} connecting ${url}`);
      const wsOpts = { handshakeTimeout: 10_000 };
      if (PROXY_AGENT) wsOpts.agent = PROXY_AGENT;
      const ws = new WebSocket(url, wsOpts);
      this.ws = ws;

      const onOpen = () => {
        this.connected = true;
        this.reconnectAttempt = 0;
        this.connecting = null;
        this._setupHeartbeat();
        // 重连后恢复订阅
        if (this.subscribedStreams.size > 0) {
          this._sendRaw({
            method: 'SUBSCRIBE',
            params: Array.from(this.subscribedStreams),
            id: this.subId++
          });
          // 订单簿/聚合成交需要重新建立缓存
          this.bookState.ready = false;
          this.bookState.buffer = [];
          this.aggTradesReady = false;
        }
        resolve();
      };
      const onError = (err) => {
        // eslint-disable-next-line no-console
        console.warn(`[stream] ${this.symbol} ${this.market} ws error: ${err.message}`);
        if (this.connecting) {
          this.connecting = null;
          reject(err);
        }
      };
      const onClose = (code, reason) => {
        // eslint-disable-next-line no-console
        console.warn(`[stream] ${this.symbol} ${this.market} ws closed (${code} ${reason})`);
        this.connected = false;
        this.connecting = null;
        this._teardownHeartbeat();
        if (this.idleTimer) {
          // 仅在非主动 destroy 时重连
          this._scheduleReconnect();
        }
      };

      ws.on('open', onOpen);
      ws.on('error', onError);
      ws.on('close', onClose);
      ws.on('message', (data) => this._onMessage(data));
      ws.on('pong', () => this._onPong());
    });
    return this.connecting;
  }

  _setupHeartbeat() {
    this._teardownHeartbeat();
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try { this.ws.ping(); } catch (_) { /* noop */ }
      this.pongTimer = setTimeout(() => {
        // eslint-disable-next-line no-console
        console.warn(`[stream] ${this.symbol} ${this.market} pong timeout, terminating`);
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
    console.log(`[stream] ${this.symbol} ${this.market} reconnect in ${delay}ms (attempt ${this.reconnectAttempt})`);
    setTimeout(() => {
      // 已经被 destroy 就不再重连
      if (!this.idleTimer) return;
      this._ensureConnected().catch(() => { /* will close → reschedule */ });
    }, delay);
  }

  _sendRaw(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  async _subscribe(streams) {
    await this._ensureConnected();
    const fresh = streams.filter((s) => !this.subscribedStreams.has(s));
    if (fresh.length === 0) return;
    fresh.forEach((s) => this.subscribedStreams.add(s));
    this._sendRaw({
      method: 'SUBSCRIBE',
      params: fresh,
      id: this.subId++
    });
  }

  // -------------- WS 消息分发 --------------
  _onMessage(raw) {
    let pkt;
    try { pkt = JSON.parse(raw.toString()); } catch (_) { return; }
    // 订阅确认 / 错误回包
    if (pkt && (pkt.result !== undefined || pkt.error)) {
      if (pkt.error) {
        // eslint-disable-next-line no-console
        console.warn('[stream] sub error', this.symbol, this.market, pkt.error);
      }
      return;
    }
    // combined stream 形如 { stream: '...', data: {...} }
    const data = pkt && pkt.data ? pkt.data : pkt;
    const stream = pkt && pkt.stream ? pkt.stream : '';
    if (!data || !data.e) {
      // depth 帧 e=depthUpdate；kline e=kline；aggTrade e=aggTrade
      // 也可能是订阅响应等
      return;
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
    if (!entry) return; // 我们没订阅这个 interval（不应该发生）
    const c = _wsKlineToCandle(data.k);
    entry.candles.set(c.openTime, c);
    entry.lastEventAt = _now();
    this._trimKlineCache(entry);
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
      // 立即触发 reconcile（不阻塞当前 message handler）
      setImmediate(() => this._ensureOrderBookReady(100).catch((e) => {
        // eslint-disable-next-line no-console
        console.warn('[stream] resync failed', e.message);
      }));
      return;
    }
    if (this.market === 'spot' && u <= this.bookState.lastUpdateId) return;
    this._applyDepthDiff(data);
    this.bookState.lastUpdateId = u;
    this.bookState.lastU = u;
    this.bookState.lastEventAt = _now();
    this._refreshBestPrices();
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
    }
    if (this.aggTradesReady) return;
    if (this.aggTradesInit) return this.aggTradesInit;
    this.aggTradesInit = (async () => {
      try {
        const seed = await BinanceService.getAggTrades(this.symbol, AGG_TRADES_BUFFER, this.market);
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
    this.aggTrades.push({
      a: data.a, p: data.p, q: data.q, f: data.f, l: data.l,
      T: data.T, m: data.m, M: data.M
    });
    if (this.aggTrades.length > AGG_TRADES_BUFFER) {
      this.aggTrades.splice(0, this.aggTrades.length - AGG_TRADES_BUFFER);
    }
  }

  // -------------- 销毁 --------------
  destroy() {
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }
    this._teardownHeartbeat();
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch (_) { /* noop */ }
      this.ws = null;
    }
    this.connected = false;
    this.subscribedStreams.clear();
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
