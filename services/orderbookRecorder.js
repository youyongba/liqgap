'use strict';

/**
 * 订单簿快照录盘服务 (Order book snapshot recorder)
 *
 * 用途 (Purpose)：
 *   - 提供"滚动窗口对比"功能所需的历史盘口基线。
 *   - 主图按 K 线 hover 时，可以拿到 hoverTime - windowMs 时刻的盘口快照，
 *     与当前实时盘口对比，看出"挂单墙"在最近 N 时间内的增厚 / 撤离。
 *
 * 设计 (Design)：
 *   - 每分钟整点（对齐分钟边界）从 binanceStream hub 取一次盘口快照。
 *   - 100 档（每边）就足够画全墙图，单条记录 ~5KB。
 *   - 落磁盘为 JSONL，按 UTC 日期分文件：
 *       <CACHE_DIR>/<SYMBOL>-<MARKET>-YYYY-MM-DD.jsonl
 *     一天 1440 条 ≈ 7MB，单 symbol 24h 总磁盘占用 < 10MB。
 *   - 启动时 + 每小时清理一次，删除超过 25h 的旧文件（多 1h 缓冲）。
 *   - 录盘 symbol 默认 BTCUSDT（合约），可通过 OB_RECORD_SYMBOLS 环境变量覆盖。
 *
 * 故意不放进程内存：进程重启 / pm2 restart 后历史快照不丢。
 */

const fs = require('fs');
const path = require('path');
const { getHub } = require('./binanceStream');

// ---- 配置 (Configuration) ----------------------------------------------
const DEFAULT_DIR = path.join(__dirname, '..', '.cache', 'orderbook-snapshots');
const RECORD_DIR = process.env.OB_SNAPSHOT_DIR || DEFAULT_DIR;
const RECORD_INTERVAL_MS = 60_000;       // 每分钟一次
const RETENTION_HOURS = 25;              // 保留 25h
const CLEANUP_INTERVAL_MS = 60 * 60_000; // 每小时清理一次
const SNAPSHOT_DEPTH = 100;              // 每边 100 档

const SYMBOLS_TO_RECORD = (process.env.OB_RECORD_SYMBOLS || 'BTCUSDT')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const MARKET = (process.env.OB_RECORD_MARKET || 'futures') === 'spot' ? 'spot' : 'futures';

// 启动时确保目录存在
try { fs.mkdirSync(RECORD_DIR, { recursive: true }); } catch (_) { /* noop */ }

// ---- 工具 (Helpers) ----------------------------------------------------
function _dateStr(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
       + `-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function _dailyFile(symbol, market, dateStr) {
  return path.join(RECORD_DIR, `${symbol}-${market}-${dateStr}.jsonl`);
}

// ---- 录盘核心 (Recording loop) -----------------------------------------
let _started = false;
let _intervalTimer = null;
let _cleanupTimer = null;

function start() {
  if (_started) return;
  _started = true;
  // eslint-disable-next-line no-console
  console.log(`[obRecorder] start · dir=${RECORD_DIR} symbols=[${SYMBOLS_TO_RECORD.join(',')}] market=${MARKET}`);

  // 立即触发一次（不等下一个分钟边界，让 24h 窗口尽快有锚点数据）
  _tick().catch((err) => {
    // eslint-disable-next-line no-console
    console.warn('[obRecorder] initial tick failed:', err.message);
  });

  // 对齐到下一个整分钟，然后每分钟一次
  const now = Date.now();
  const nextMinute = Math.ceil(now / RECORD_INTERVAL_MS) * RECORD_INTERVAL_MS;
  setTimeout(() => {
    _tick().catch((e) => { /* eslint-disable-next-line no-console */ console.warn('[obRecorder] tick err:', e.message); });
    _intervalTimer = setInterval(() => {
      _tick().catch((e) => { /* eslint-disable-next-line no-console */ console.warn('[obRecorder] tick err:', e.message); });
    }, RECORD_INTERVAL_MS);
  }, Math.max(0, nextMinute - now));

  // 启动时立刻清一次旧文件，再周期性清
  _cleanup();
  _cleanupTimer = setInterval(_cleanup, CLEANUP_INTERVAL_MS);
}

async function _tick() {
  const ts = Date.now();
  for (const symbol of SYMBOLS_TO_RECORD) {
    try {
      const hub = getHub(symbol, MARKET);
      const book = await hub.getOrderBook(SNAPSHOT_DEPTH);
      const record = {
        ts,
        symbol,
        market: MARKET,
        lastUpdateId: book.lastUpdateId,
        bids: (book.bids || []).slice(0, SNAPSHOT_DEPTH),
        asks: (book.asks || []).slice(0, SNAPSHOT_DEPTH)
      };
      const file = _dailyFile(symbol, MARKET, _dateStr(ts));
      fs.appendFileSync(file, JSON.stringify(record) + '\n');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[obRecorder] ${symbol} ${MARKET} snapshot failed: ${err.message}`);
    }
  }
}

function _cleanup() {
  const cutoff = Date.now() - RETENTION_HOURS * 3600 * 1000;
  let files;
  try { files = fs.readdirSync(RECORD_DIR); } catch (_) { return; }
  let removed = 0;
  for (const f of files) {
    const full = path.join(RECORD_DIR, f);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed += 1;
      }
    } catch (_) { /* noop */ }
  }
  if (removed) {
    // eslint-disable-next-line no-console
    console.log(`[obRecorder] cleanup removed ${removed} expired snapshot file(s)`);
  }
}

/**
 * 找最接近 atMs 的快照（取 atMs 之前最近的一个，避免"未来"快照）。
 * 优先扫 atMs 当天，找不到再扫前一天 / 后一天兜底。
 *
 * @param {string} symbol e.g. 'BTCUSDT'
 * @param {string} market 'spot' | 'futures'
 * @param {number} atMs   目标时间戳（毫秒）
 * @returns {object|null} { ts, symbol, market, lastUpdateId, bids, asks }
 */
function findNearest(symbol, market, atMs) {
  const upSymbol = String(symbol).toUpperCase();
  const mkt = market === 'spot' ? 'spot' : 'futures';
  // 候选日期：当天、前一天、后一天（覆盖跨日边界）
  const dates = [
    _dateStr(atMs),
    _dateStr(atMs - 86400000),
    _dateStr(atMs + 86400000)
  ];
  let best = null;
  for (const dateStr of dates) {
    const file = _dailyFile(upSymbol, mkt, dateStr);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    const lines = raw.split('\n');
    for (const line of lines) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        if (typeof r.ts !== 'number' || r.ts > atMs) continue;
        if (!best || r.ts > best.ts) best = r;
      } catch (_) { /* skip bad line */ }
    }
  }
  return best;
}

/**
 * 读取 [fromMs, toMs] 区间内所有快照（按时间升序）。
 * 用于流动性热图的批量取数。
 *
 * @param {string} symbol
 * @param {string} market
 * @param {number} fromMs
 * @param {number} toMs
 * @returns {Array<{ts:number,symbol:string,market:string,lastUpdateId:number,
 *                    bids:Array<[string,string]>,asks:Array<[string,string]>}>}
 */
function findRange(symbol, market, fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];
  const upSymbol = String(symbol).toUpperCase();
  const mkt = market === 'spot' ? 'spot' : 'futures';

  // 枚举所需的所有 UTC 日期文件
  const dates = new Set();
  // 多扫一天兜底跨日边界（含 from-1h 与 to+1h）
  const lo = fromMs - 3600_000;
  const hi = toMs + 3600_000;
  for (let t = Math.floor(lo / 86400000) * 86400000; t <= hi; t += 86400000) {
    dates.add(_dateStr(t));
  }

  const out = [];
  for (const dateStr of dates) {
    const file = _dailyFile(upSymbol, mkt, dateStr);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    const lines = raw.split('\n');
    for (const line of lines) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        if (typeof r.ts !== 'number') continue;
        if (r.ts < fromMs || r.ts > toMs) continue;
        out.push(r);
      } catch (_) { /* skip bad line */ }
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/**
 * 把一组快照聚合成热图矩阵：
 *   matrix[ti][pi] = 该 (时间桶, 价格桶) 内挂单量（base × price = USDT 名义额）的最大值。
 *   取最大值（而非平均）能更突出"持续性挂单墙"——只要某一刻有大墙，该格就高亮。
 *
 * @param {Array} snapshots         findRange 的结果
 * @param {object} opts
 * @param {number} opts.fromMs      时间桶起点
 * @param {number} opts.toMs        时间桶终点（含）
 * @param {number} opts.bucketMs    时间桶宽（毫秒）
 * @param {number} opts.priceMin    价格桶最小价
 * @param {number} opts.priceMax    价格桶最大价
 * @param {number} opts.priceBucket 价格桶宽度（USDT）
 * @returns {{
 *   times:number[], prices:number[],
 *   bidMatrix:number[][], askMatrix:number[][],
 *   maxValue:number, snapshotCount:number
 * }}
 *   bidMatrix / askMatrix 分开返回，前端按 mid 上下分别上不同色温。
 */
function buildHeatmapMatrix(snapshots, opts) {
  const { fromMs, toMs, bucketMs, priceMin, priceMax, priceBucket } = opts;
  const tCount = Math.max(1, Math.ceil((toMs - fromMs) / bucketMs));
  const pCount = Math.max(1, Math.ceil((priceMax - priceMin) / priceBucket));
  const times = new Array(tCount);
  for (let i = 0; i < tCount; i += 1) times[i] = fromMs + i * bucketMs;
  const prices = new Array(pCount);
  for (let j = 0; j < pCount; j += 1) prices[j] = priceMin + j * priceBucket;

  // 二维矩阵初始化为 0；buy/sell 分开
  const bidMatrix = new Array(tCount);
  const askMatrix = new Array(tCount);
  for (let i = 0; i < tCount; i += 1) {
    bidMatrix[i] = new Array(pCount).fill(0);
    askMatrix[i] = new Array(pCount).fill(0);
  }

  // 暂存每个 (time bucket, price bucket) 当前快照的累加值，跟历史最大比
  // 由于"取最大"算子需要先在单个快照内累加 sum，然后跨快照取 max，
  // 所以每处理一个快照都用临时 sum 数组，处理完再 max-merge 到主矩阵。
  let maxValue = 0;
  for (const snap of snapshots) {
    const ti = Math.floor((snap.ts - fromMs) / bucketMs);
    if (ti < 0 || ti >= tCount) continue;
    const sumBid = new Array(pCount).fill(0);
    const sumAsk = new Array(pCount).fill(0);
    for (const [pStr, qStr] of (snap.bids || [])) {
      const p = Number(pStr);
      const q = Number(qStr);
      if (!Number.isFinite(p) || !Number.isFinite(q) || q <= 0) continue;
      const pi = Math.floor((p - priceMin) / priceBucket);
      if (pi < 0 || pi >= pCount) continue;
      sumBid[pi] += p * q;
    }
    for (const [pStr, qStr] of (snap.asks || [])) {
      const p = Number(pStr);
      const q = Number(qStr);
      if (!Number.isFinite(p) || !Number.isFinite(q) || q <= 0) continue;
      const pi = Math.floor((p - priceMin) / priceBucket);
      if (pi < 0 || pi >= pCount) continue;
      sumAsk[pi] += p * q;
    }
    for (let pi = 0; pi < pCount; pi += 1) {
      if (sumBid[pi] > bidMatrix[ti][pi]) bidMatrix[ti][pi] = sumBid[pi];
      if (sumAsk[pi] > askMatrix[ti][pi]) askMatrix[ti][pi] = sumAsk[pi];
      if (sumBid[pi] > maxValue) maxValue = sumBid[pi];
      if (sumAsk[pi] > maxValue) maxValue = sumAsk[pi];
    }
  }

  return {
    times,
    prices,
    bidMatrix,
    askMatrix,
    maxValue,
    snapshotCount: snapshots.length
  };
}

/** 调试 / 状态查询 */
function getStatus() {
  let files = [];
  try { files = fs.readdirSync(RECORD_DIR); } catch (_) { /* noop */ }
  return {
    dir: RECORD_DIR,
    symbols: SYMBOLS_TO_RECORD,
    market: MARKET,
    intervalMs: RECORD_INTERVAL_MS,
    retentionHours: RETENTION_HOURS,
    snapshotDepth: SNAPSHOT_DEPTH,
    started: _started,
    files
  };
}

module.exports = {
  start,
  findNearest,
  findRange,
  buildHeatmapMatrix,
  getStatus,
  RECORD_DIR,
  RECORD_INTERVAL_MS
};
