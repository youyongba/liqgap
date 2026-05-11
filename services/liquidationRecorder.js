'use strict';

/**
 * 强平事件录盘服务 (Liquidation event recorder)
 *
 * 用途 (Purpose):
 *   - 订阅 Binance Futures <symbol>@forceOrder 流，把每条强平推送累积到磁盘，
 *     供"清算热力图 / Liquidation Heatmap"按 (时间桶, 价格桶) 聚合渲染。
 *   - 同时维护一个内存滚动 buffer (最近 N 条) 让前端"实时清算流"使用。
 *
 * 设计 (Design):
 *   - 与 obRecorder 同模板：JSONL 落盘，按 UTC 日期分文件
 *       <RECORD_DIR>/<SYMBOL>-<MARKET>-YYYY-MM-DD.jsonl
 *   - flush 策略：每分钟一次，把 buffer flush 到当天文件；进程退出时也 flush。
 *   - 保留 25h，每小时清理一次旧文件。
 *   - 不开新 WS 连接：直接订阅已有 streamHub.on('liquidation', ...) 事件。
 *   - 强平事件比快照稀疏（一般每小时几十~几百条），磁盘消耗远低于 obRecorder。
 *
 * 单条 JSONL 记录:
 *   { ts: <ms>, symbol, side: 'long'|'short', price: <num>, qty: <num>,
 *     value: <USDT 名义额> }
 */

const fs = require('fs');
const path = require('path');
const { getHub } = require('./binanceStream');

const DEFAULT_DIR = path.join(__dirname, '..', '.cache', 'liquidation-events');
const RECORD_DIR = process.env.LIQ_RECORD_DIR || DEFAULT_DIR;
const FLUSH_INTERVAL_MS = 60_000;
const RETENTION_HOURS = 25;
const CLEANUP_INTERVAL_MS = 60 * 60_000;
const MEM_BUFFER_MAX = 2000; // 最近 2k 条事件留在内存

const SYMBOLS_TO_RECORD = (process.env.LIQ_RECORD_SYMBOLS || 'BTCUSDT')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const MARKET = (process.env.LIQ_RECORD_MARKET || 'futures') === 'spot' ? 'spot' : 'futures';

try { fs.mkdirSync(RECORD_DIR, { recursive: true }); } catch (_) { /* noop */ }

function _dateStr(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
       + `-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function _dailyFile(symbol, market, dateStr) {
  return path.join(RECORD_DIR, `${symbol}-${market}-${dateStr}.jsonl`);
}

let _started = false;
let _startedAt = 0;
let _flushTimer = null;
let _cleanupTimer = null;
const _stats = {
  totalEvents: 0,
  lastEventAt: 0,
  lastEventSymbol: null,
  subscribeOk: false,
  subscribeError: null,
  subscribeAttempts: 0
};

// 每个 (symbol) 维护一个待 flush 缓冲 + 内存滚动 buffer
// pendingBySymbol: Map<sym, Array<event>>  待写盘（写完清空）
// memBufferBySymbol: Map<sym, Array<event>>  最近 N 条在内存（用于 status 与 hot 数据）
const _pendingBySymbol = new Map();
const _memBufferBySymbol = new Map();
let _hubListenersAttached = new Set();

function start() {
  if (_started) return;
  _started = true;
  _startedAt = Date.now();
  // eslint-disable-next-line no-console
  console.log(`[liqRecorder] start · dir=${RECORD_DIR} symbols=[${SYMBOLS_TO_RECORD.join(',')}] market=${MARKET}`);

  // 给每个 symbol 接 hub 的 'liquidation' 事件
  for (const symbol of SYMBOLS_TO_RECORD) {
    _attachHub(symbol);
  }

  // 周期 flush
  _flushTimer = setInterval(_flushAll, FLUSH_INTERVAL_MS);
  // 启动时立即清一次
  _cleanup();
  _cleanupTimer = setInterval(_cleanup, CLEANUP_INTERVAL_MS);

  // 进程退出时把内存缓冲冲到磁盘
  process.on('beforeExit', _flushAll);
  process.on('SIGINT',  () => { try { _flushAll(); } catch (_) {} process.exit(0); });
  process.on('SIGTERM', () => { try { _flushAll(); } catch (_) {} process.exit(0); });
}

async function _attachHub(symbol) {
  const k = `${symbol}|${MARKET}`;
  if (_hubListenersAttached.has(k)) return;
  // 先取 hub 并把"liquidation"监听器装上 —— 监听器是幂等的，
  // 装上之后即使 ensureForceOrderSubscription 抛错（比如临时网络问题），
  // hub 重连后会自动重建订阅，事件依然能被本监听器接到。
  let hub;
  try {
    hub = getHub(symbol, MARKET);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[liqRecorder] getHub failed · ${symbol} ${MARKET}: ${err.message}`);
    setTimeout(() => _attachHub(symbol), 5000);
    return;
  }

  hub.on('liquidation', (evt) => {
    if (!evt || !Number.isFinite(evt.ts)) return;
    const sym = evt.symbol || symbol;
    // 只录制配置中的 symbol（!forceOrder@arr 推送全市场事件，
    // 不过滤会导致内存里堆积上百个 symbol 的 buffer，且永远不被消费）
    if (!SYMBOLS_TO_RECORD.includes(sym)) return;
    if (!_pendingBySymbol.has(sym)) _pendingBySymbol.set(sym, []);
    _pendingBySymbol.get(sym).push(evt);
    if (!_memBufferBySymbol.has(sym)) _memBufferBySymbol.set(sym, []);
    const buf = _memBufferBySymbol.get(sym);
    buf.push(evt);
    if (buf.length > MEM_BUFFER_MAX) buf.splice(0, buf.length - MEM_BUFFER_MAX);
    _stats.totalEvents += 1;
    _stats.lastEventAt = evt.ts;
    _stats.lastEventSymbol = sym;
  });
  _hubListenersAttached.add(k);

  // 触发订阅；失败则间隔重试（hub 内部已有指数退避，
  // 这里再加一层 30s 兜底重试覆盖 ensureForceOrderSubscription 抛错的情况）
  const trySubscribe = async () => {
    _stats.subscribeAttempts += 1;
    try {
      await hub.ensureForceOrderSubscription();
      _stats.subscribeOk = true;
      _stats.subscribeError = null;
      // eslint-disable-next-line no-console
      console.log(`[liqRecorder] forceOrder subscribed · ${symbol} ${MARKET} (attempt ${_stats.subscribeAttempts})`);
    } catch (err) {
      _stats.subscribeOk = false;
      _stats.subscribeError = err.message;
      // eslint-disable-next-line no-console
      console.warn(`[liqRecorder] subscribe failed · ${symbol} ${MARKET}: ${err.message} (retry in 30s)`);
      setTimeout(trySubscribe, 30_000);
    }
  };
  trySubscribe();
}

function _flushAll() {
  for (const [symbol, events] of _pendingBySymbol.entries()) {
    if (!events || events.length === 0) continue;
    // 按日期分组写入对应文件
    const byDate = new Map();
    for (const e of events) {
      const ds = _dateStr(e.ts);
      if (!byDate.has(ds)) byDate.set(ds, []);
      byDate.get(ds).push(e);
    }
    for (const [ds, list] of byDate.entries()) {
      const file = _dailyFile(symbol, MARKET, ds);
      const lines = list.map((e) => JSON.stringify(e)).join('\n') + '\n';
      try {
        fs.appendFileSync(file, lines);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[liqRecorder] flush failed ${file}: ${err.message}`);
      }
    }
    // 已写入则清空待 flush
    _pendingBySymbol.set(symbol, []);
  }
}

function _cleanup() {
  const cutoff = Date.now() - RETENTION_HOURS * 3600_000;
  let files;
  try { files = fs.readdirSync(RECORD_DIR); } catch (_) { return; }
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const full = path.join(RECORD_DIR, f);
    let st;
    try { st = fs.statSync(full); } catch (_) { continue; }
    if (st.mtimeMs < cutoff) {
      try { fs.unlinkSync(full); /* eslint-disable-next-line no-console */ console.log(`[liqRecorder] cleanup removed ${f}`); }
      catch (_) { /* noop */ }
    }
  }
}

/**
 * 读 [fromMs, toMs] 区间内所有强平事件（按时间升序）。
 * 同时把"待 flush 缓冲 + 内存 buffer"也合并进来，确保实时事件不丢。
 */
function findRange(symbol, market, fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];
  const upSymbol = String(symbol).toUpperCase();
  const mkt = market === 'spot' ? 'spot' : 'futures';

  const dates = new Set();
  for (let t = Math.floor(fromMs / 86400000) * 86400000; t <= toMs; t += 86400000) {
    dates.add(_dateStr(t));
  }
  // 兜底再多扫一天，防跨日边界
  dates.add(_dateStr(fromMs - 86400000));
  dates.add(_dateStr(toMs + 86400000));

  const out = [];
  const seen = new Set(); // 去重 key

  for (const dateStr of dates) {
    const file = _dailyFile(upSymbol, mkt, dateStr);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (typeof e.ts !== 'number' || e.ts < fromMs || e.ts > toMs) continue;
        const key = `${e.ts}|${e.price}|${e.qty}|${e.side}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(e);
      } catch (_) { /* skip bad line */ }
    }
  }
  // 合并待 flush 与内存 buffer
  for (const src of [_pendingBySymbol.get(upSymbol), _memBufferBySymbol.get(upSymbol)]) {
    if (!src) continue;
    for (const e of src) {
      if (e.ts < fromMs || e.ts > toMs) continue;
      const key = `${e.ts}|${e.price}|${e.qty}|${e.side}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/**
 * 把强平事件聚合成 (T,P) 矩阵：
 *   longMatrix[ti][pi]  = 该桶内"long 被强平"事件累计 USDT 名义额
 *   shortMatrix[ti][pi] = 该桶内"short 被强平"事件累计 USDT 名义额
 * 累加而非取最大 — 因为这里看的是"该价位被洗了多少筹码"。
 */
function buildLiquidationHeatmap(events, opts) {
  const { fromMs, toMs, bucketMs, priceMin, priceMax, priceBucket } = opts;
  const tCount = Math.max(1, Math.ceil((toMs - fromMs) / bucketMs));
  const pCount = Math.max(1, Math.ceil((priceMax - priceMin) / priceBucket));
  const times = new Array(tCount);
  for (let i = 0; i < tCount; i += 1) times[i] = fromMs + i * bucketMs;
  const prices = new Array(pCount);
  for (let j = 0; j < pCount; j += 1) prices[j] = priceMin + j * priceBucket;

  const longMatrix  = new Array(tCount);
  const shortMatrix = new Array(tCount);
  for (let i = 0; i < tCount; i += 1) {
    longMatrix[i]  = new Array(pCount).fill(0);
    shortMatrix[i] = new Array(pCount).fill(0);
  }

  let maxValue = 0;
  let totalLong = 0;
  let totalShort = 0;

  for (const e of events) {
    const ti = Math.floor((e.ts - fromMs) / bucketMs);
    if (ti < 0 || ti >= tCount) continue;
    const pi = Math.floor((e.price - priceMin) / priceBucket);
    if (pi < 0 || pi >= pCount) continue;
    const v = e.value || (e.price * e.qty);
    if (!(v > 0)) continue;
    if (e.side === 'long') {
      longMatrix[ti][pi]  += v;
      totalLong += v;
      if (longMatrix[ti][pi] > maxValue) maxValue = longMatrix[ti][pi];
    } else {
      shortMatrix[ti][pi] += v;
      totalShort += v;
      if (shortMatrix[ti][pi] > maxValue) maxValue = shortMatrix[ti][pi];
    }
  }

  return {
    times, prices, longMatrix, shortMatrix,
    maxValue, totalLong, totalShort,
    eventCount: events.length
  };
}

function getStatus() {
  const files = (() => {
    try { return fs.readdirSync(RECORD_DIR).filter((f) => f.endsWith('.jsonl')); }
    catch (_) { return []; }
  })();
  const buffers = {};
  for (const [sym, buf] of _memBufferBySymbol.entries()) {
    buffers[sym] = { memCount: buf.length, latest: buf[buf.length - 1] || null };
  }
  const now = Date.now();
  return {
    started: _started,
    startedAt: _startedAt,
    uptimeMs: _startedAt ? now - _startedAt : 0,
    dir: RECORD_DIR,
    symbols: SYMBOLS_TO_RECORD,
    market: MARKET,
    flushIntervalMs: FLUSH_INTERVAL_MS,
    retentionHours: RETENTION_HOURS,
    files,
    pendingFlushBySymbol: Object.fromEntries(
      Array.from(_pendingBySymbol.entries()).map(([k, v]) => [k, v.length])
    ),
    memBuffers: buffers,
    subscribeOk: _stats.subscribeOk,
    subscribeError: _stats.subscribeError,
    subscribeAttempts: _stats.subscribeAttempts,
    totalEventsSinceStart: _stats.totalEvents,
    lastEventAt: _stats.lastEventAt,
    lastEventSymbol: _stats.lastEventSymbol,
    msSinceLastEvent: _stats.lastEventAt ? now - _stats.lastEventAt : null
  };
}

module.exports = {
  start,
  findRange,
  buildLiquidationHeatmap,
  getStatus,
  RECORD_DIR,
  FLUSH_INTERVAL_MS
};
