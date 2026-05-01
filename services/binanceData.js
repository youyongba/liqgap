'use strict';

/**
 * Binance 历史数据下载服务 (Binance historical data downloader)
 *
 * 数据源 (Source): https://data.binance.vision —— 币安官方公开历史数据仓库。
 *
 * 该模块仅用于回测 (Backtest only) 时拉取「真实」逐笔聚合成交 (aggTrades)：
 *   - 现货:  /data/spot/daily/aggTrades/<SYM>/<SYM>-aggTrades-YYYY-MM-DD.zip
 *   - U本位合约: /data/futures/um/daily/aggTrades/<SYM>/<SYM>-aggTrades-YYYY-MM-DD.zip
 *
 * 设计要点 (Key design points):
 *   - 流式处理 (streaming pipeline) axios stream → unzipper → readline，
 *     避免将整日 CSV (BTCUSDT 单日可达 1GB) 全部塞入内存。
 *   - 解析后立即累加到「按小时聚合」的桶中 (hourly bucket aggregation)；
 *     原始 trade 不再保留 (no per-trade retention)，最终内存占用仅 O(720) 桶。
 *   - is_buyer_maker 字段在 Binance Spot / Futures 历史 CSV 中语义一致：
 *       isBuyerMaker = true  → 卖方主动 (seller-aggressor)，归入 sellVolume
 *       isBuyerMaker = false → 买方主动 (buyer-aggressor)，归入 buyVolume
 *   - 只要任意一天下载或解析失败，整体抛错；调用方按"中止回测"处理，
 *     不允许任何模拟数据兜底 (no synthetic fallback by design).
 */

const axios = require('axios');
const readline = require('readline');
const unzipper = require('unzipper');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_BASE = 'https://data.binance.vision';

// ---------------------------------------------------------------------------
// 缓存 (Cache)
// ---------------------------------------------------------------------------
//
// daily aggTrades 文件是「历史不变量」，一旦下载并解析过，再次需要时直接读
// 内存 / 磁盘缓存即可，避免重复下载几百 MB 的 zip。
//
//   - 内存：进程启动后第一次读盘 → 落 Map<key, dayBuckets>
//   - 磁盘：JSON 文件，键为 (market, symbol, date)，值是 24 个小时桶
//
// 默认目录：$BINANCE_DATA_CACHE_DIR ?? <tmpdir>/liqgap-binance-data-cache
//
const CACHE_DIR =
  process.env.BINANCE_DATA_CACHE_DIR
  || path.join(os.tmpdir(), 'liqgap-binance-data-cache');

try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (_) { /* noop */ }
// eslint-disable-next-line no-console
console.log(`[binanceData] daily aggTrades cache dir: ${CACHE_DIR}`);

const _memCache = new Map(); // key -> Map<hourTs, bucket>

function _cacheKey(symbol, market, dateStr) {
  return `${market}|${String(symbol).toUpperCase()}|${dateStr}`;
}
function _cachePath(symbol, market, dateStr) {
  return path.join(
    CACHE_DIR,
    `${market}-${String(symbol).toUpperCase()}-${dateStr}.json`
  );
}
function _readCachedDay(symbol, market, dateStr) {
  const key = _cacheKey(symbol, market, dateStr);
  if (_memCache.has(key)) return _memCache.get(key);
  let raw;
  try { raw = fs.readFileSync(_cachePath(symbol, market, dateStr), 'utf8'); }
  catch (_) { return null; }
  try {
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.entries)) return null;
    const m = new Map(obj.entries.map(([k, v]) => [Number(k), v]));
    _memCache.set(key, m);
    return m;
  } catch (_) {
    return null;
  }
}
function _writeCachedDay(symbol, market, dateStr, dayBuckets) {
  const key = _cacheKey(symbol, market, dateStr);
  _memCache.set(key, dayBuckets);
  try {
    fs.writeFileSync(
      _cachePath(symbol, market, dateStr),
      JSON.stringify({ entries: Array.from(dayBuckets.entries()) })
    );
  } catch (_) { /* 缓存写失败不影响业务 */ }
}
function _mergeBuckets(target, source) {
  for (const [k, b] of source.entries()) {
    const cur = target.get(k);
    if (cur) {
      cur.buyVolume  += b.buyVolume;
      cur.sellVolume += b.sellVolume;
      cur.buyQuote   += b.buyQuote;
      cur.sellQuote  += b.sellQuote;
      cur.trades     += b.trades;
    } else {
      target.set(k, { ...b });
    }
  }
}

// 浏览器风格 headers，避免 Cloudflare 把 axios 当成爬虫拦截
// (Browser-like headers to dodge Cloudflare bot challenge.)
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/octet-stream, */*',
  'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
  Connection: 'keep-alive'
};

const DAILY_DOWNLOAD_TIMEOUT_MS = 180000; // 单日 zip 下载允许 3 分钟
const HOUR_MS = 3600000;

// ---------------------------------------------------------------------------
// URL 与日期工具 (URL & date helpers)
// ---------------------------------------------------------------------------
function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function utcDateStr(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function utcDayStart(d) {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function dailyZipUrl(symbol, market, dateStr) {
  const sym = String(symbol).toUpperCase();
  const segment = market === 'spot' ? 'spot/daily/aggTrades' : 'futures/um/daily/aggTrades';
  return `${DATA_BASE}/data/${segment}/${sym}/${sym}-aggTrades-${dateStr}.zip`;
}

// ---------------------------------------------------------------------------
// 单日 aggTrades 下载 + 流式聚合 (Single-day download + streaming aggregation)
// ---------------------------------------------------------------------------
/**
 * 下载某天 aggTrades zip 并解压成 CSV，逐行累加到 hourlyBuckets (Map<hourTs, bucket>)。
 *
 * 出错策略 (Failure policy):
 *   - HTTP 404 → 「该日 zip 还未上架」(尤其是最近 1-2 天会有滞后) 或 symbol
 *     不存在该日数据；返回 { missing:true, status:404, ... }，**不抛错**，
 *     由上层 fetchHistoricalAggTrades 收集到 missingDays 中决定是否中止。
 *   - 其他网络 / HTTP 失败 → 抛 Error (附状态码 + URL)
 *   - 解析任意一行失败 → 跳过该行 (skip line)；如果整日 0 行有效成交，
 *     认为该日数据损坏，抛错。
 *
 * @param {string} symbol  e.g. 'BTCUSDT'
 * @param {string} market  'spot' | 'futures'
 * @param {string} dateStr 'YYYY-MM-DD' (UTC)
 * @param {Map<number, {buyVolume:number, sellVolume:number, buyQuote:number,
 *                      sellQuote:number, trades:number}>} hourlyBuckets
 * @returns {Promise<{date:string, processed:number, url:string,
 *                    bytes:number, durationMs:number, missing?:boolean,
 *                    status?:number, reason?:string}>}
 */
async function downloadDailyAggTrades(symbol, market, dateStr, hourlyBuckets) {
  const url = dailyZipUrl(symbol, market, dateStr);
  const startedAt = Date.now();

  // —— 缓存命中：直接合并到 hourlyBuckets 跳过下载 —— //
  const cached = _readCachedDay(symbol, market, dateStr);
  if (cached) {
    _mergeBuckets(hourlyBuckets, cached);
    let cachedTrades = 0;
    for (const b of cached.values()) cachedTrades += b.trades;
    return {
      date: dateStr,
      processed: cachedTrades,
      url,
      bytes: 0,
      durationMs: Date.now() - startedAt,
      cached: true
    };
  }

  let res;
  try {
    res = await axios.get(url, {
      responseType: 'stream',
      timeout: DAILY_DOWNLOAD_TIMEOUT_MS,
      headers: BROWSER_HEADERS,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
  } catch (err) {
    const status = err.response && err.response.status;
    // 404 → 该日 zip 不存在（常见于"昨天/今天"未上架）。
    // 上层会决定是中止还是跳过；这里不再抛错。
    if (status === 404) {
      // 显式消费响应流避免 socket 泄漏 (axios stream + 4xx 会先打开流)
      try {
        const stream = err.response && err.response.data;
        if (stream && typeof stream.resume === 'function') stream.resume();
      } catch (_) { /* noop */ }
      return {
        date: dateStr,
        processed: 0,
        url,
        bytes: 0,
        durationMs: Date.now() - startedAt,
        missing: true,
        status: 404,
        reason: 'daily zip not found (likely not yet published or symbol has no data this day)'
      };
    }
    throw new Error(
      `下载历史成交失败 ${dateStr} (HTTP ${status || 'NETERR'}): ${err.message} · ${url}`
    );
  }

  const totalBytes = Number(res.headers['content-length'] || 0);
  // 局部 dayBuckets 收集本日数据，结束后 (a) 写缓存 (b) merge 到 hourlyBuckets
  // 这种 "下载-缓冲-合并" 模式让多 worker 并发安全：每个 worker 持有自己的
  // dayBuckets，最后由 caller 串行合并到全局 buckets，避免竞态。
  const dayBuckets = new Map();
  let processed = 0;
  let parseErrors = 0;

  await new Promise((resolve, reject) => {
    let settled = false;
    function safeReject(e) { if (!settled) { settled = true; reject(e); } }
    function safeResolve() { if (!settled) { settled = true; resolve(); } }

    const zipStream = res.data.pipe(unzipper.ParseOne());
    res.data.on('error', safeReject);
    zipStream.on('error', safeReject);

    const rl = readline.createInterface({ input: zipStream, crlfDelay: Infinity });
    let firstLineSeen = false;

    rl.on('line', (line) => {
      if (!line) return;
      if (!firstLineSeen) {
        firstLineSeen = true;
        // 部分新文件带表头；表头第一列是 'agg_trade_id' (非数字)，遇到直接跳过。
        // (Some recent files include a CSV header; skip it.)
        if (line.indexOf('agg_trade_id') !== -1 || isNaN(parseFloat(line.split(',')[0]))) {
          return;
        }
      }
      const cols = line.split(',');
      if (cols.length < 7) { parseErrors += 1; return; }
      const price = parseFloat(cols[1]);
      const qty = parseFloat(cols[2]);
      const ts = Number(cols[5]);
      const isBuyerMakerRaw = cols[6];
      if (
        !Number.isFinite(price) ||
        !Number.isFinite(qty) ||
        !Number.isFinite(ts) ||
        qty <= 0
      ) {
        parseErrors += 1;
        return;
      }

      // is_buyer_maker 在 CSV 里可能是 "true"/"false"、"True"/"False" 或 0/1
      const isBuyerMaker =
        isBuyerMakerRaw === 'true' || isBuyerMakerRaw === 'True' || isBuyerMakerRaw === '1';

      // 归到对应的 1 小时桶（UTC）
      const hourTs = Math.floor(ts / HOUR_MS) * HOUR_MS;
      let bucket = dayBuckets.get(hourTs);
      if (!bucket) {
        bucket = {
          buyVolume: 0,
          sellVolume: 0,
          buyQuote: 0,
          sellQuote: 0,
          trades: 0
        };
        dayBuckets.set(hourTs, bucket);
      }

      const notional = price * qty;
      if (isBuyerMaker) {
        bucket.sellVolume += qty;
        bucket.sellQuote += notional;
      } else {
        bucket.buyVolume += qty;
        bucket.buyQuote += notional;
      }
      bucket.trades += 1;
      processed += 1;
    });

    rl.on('close', () => {
      if (processed === 0) {
        safeReject(new Error(
          `历史成交解析为空 ${dateStr} (zero rows; parseErrors=${parseErrors}) · ${url}`
        ));
      } else {
        safeResolve();
      }
    });
    rl.on('error', safeReject);
  });

  // 落缓存（内存 + 磁盘）+ 合并到调用方的全局桶
  _writeCachedDay(symbol, market, dateStr, dayBuckets);
  _mergeBuckets(hourlyBuckets, dayBuckets);

  return {
    date: dateStr,
    processed,
    url,
    bytes: totalBytes,
    durationMs: Date.now() - startedAt,
    parseErrors,
    cached: false
  };
}

// ---------------------------------------------------------------------------
// 多日聚合 (Multi-day aggregation)
// ---------------------------------------------------------------------------
/**
 * 拉取过去 `days` 天（UTC 自然日，不含「今日」，因为 daily 文件次日才会上架）
 * 的真实 aggTrades，并按小时返回聚合桶。
 *
 * 失败语义 (Failure semantics):
 *   - 单日 HTTP 404（zip 未上架 / 该日无数据）→ 收集到 missingDays，继续下一天，
 *     不抛错。币安 daily 文件通常 T+1 ~ T+2 上架，最近 1-2 天 404 是常态。
 *   - 单日网络/解析错误 → 抛错并中止（调用方应中止回测，不允许模拟兜底）。
 *   - 全部 days 都 404 → 抛错（用户可能选了一个完全没数据的 symbol）。
 *
 * @param {object} opts
 * @param {string} opts.symbol      e.g. 'BTCUSDT'
 * @param {string} opts.market      'spot' | 'futures'
 * @param {number} opts.days        回测天数 (1-90)
 * @param {(msg:string)=>void} [opts.log]
 * @returns {Promise<{
 *   buckets: Map<number, object>,
 *   coverage: {firstHour:number, lastHour:number, hoursCovered:number,
 *              expectedHours:number, daysSucceeded:number, daysMissing:number},
 *   downloads: Array<object>,
 *   missingDays: Array<{date:string, status:number, url:string, reason:string}>,
 *   source: string
 * }>}
 */
async function fetchHistoricalAggTrades({ symbol, market, days, log, concurrency }) {
  if (!symbol) throw new Error('symbol is required');
  if (market !== 'spot' && market !== 'futures') {
    throw new Error(`unsupported market: ${market}`);
  }
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error('days must be a positive number');
  }

  const buckets = new Map();
  // 注意：downloads 的顺序在并发场景下与 dates 顺序未必一致，使用前如需顺序请按
  // meta.date 重排。  callers (回测) 不依赖顺序，直接遍历桶时间戳。
  const downloads = [];
  const missingDays = [];

  // 用 UTC 切割，今天的 daily 文件还未上架，从「昨天」往前数 days 天。
  // (Daily files lag by ~1 day; start from yesterday and walk back.)
  const now = new Date();
  const yesterdayUtc = new Date(utcDayStart(now) - 86400000);

  // 准备 days 个待下载日期
  const dates = [];
  for (let i = 0; i < days; i += 1) {
    const day = new Date(yesterdayUtc.getTime() - i * 86400000);
    dates.push(utcDateStr(day));
  }

  // 限制并发：默认 6 路并行，命中缓存的天会瞬间返回不占名额
  // (Worker-pool style: parallel downloads cap to avoid hammering the CDN.)
  const conc = Math.max(1, Math.min(Number(concurrency) || 6, 12));
  let cursor = 0;
  let cachedCount = 0;
  let downloadedCount = 0;

  async function worker() {
    while (cursor < dates.length) {
      const idx = cursor;
      cursor += 1;
      const dateStr = dates[idx];
      if (typeof log === 'function') {
        log(`[binanceData] fetch ${symbol} ${market} ${dateStr}… (${idx + 1}/${dates.length})`);
      }
      try {
        const meta = await downloadDailyAggTrades(symbol, market, dateStr, buckets);
        downloads.push(meta);
        if (meta.cached) cachedCount += 1; else if (!meta.missing) downloadedCount += 1;
        if (meta.missing) {
          missingDays.push({ date: dateStr, status: meta.status, url: meta.url, reason: meta.reason });
          if (typeof log === 'function') {
            log(`[binanceData] ${dateStr} → 404, daily zip 未上架，跳过 (will be skipped)`);
          }
        }
      } catch (err) {
        // 直接向上抛，让所有 worker 终止
        throw err;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(conc, dates.length) }, () => worker())
  );

  if (typeof log === 'function') {
    log(`[binanceData] aggTrades fetch done · cached=${cachedCount} downloaded=${downloadedCount} missing=${missingDays.length}`);
  }

  // 全部缺失 = 数据无法获取，整体中止
  if (missingDays.length === days) {
    throw new Error(
      `所有 ${days} 天的 aggTrades 文件都不存在 (HTTP 404)。` +
      `请检查 symbol 是否正确、market 是否为有数据的市场，或缩短 days。`
    );
  }

  // 计算覆盖度 (Coverage stats)
  let firstHour = Infinity;
  let lastHour = -Infinity;
  for (const ts of buckets.keys()) {
    if (ts < firstHour) firstHour = ts;
    if (ts > lastHour) lastHour = ts;
  }
  const expectedHours = days * 24;

  return {
    buckets,
    coverage: {
      firstHour: Number.isFinite(firstHour) ? firstHour : null,
      lastHour: Number.isFinite(lastHour) ? lastHour : null,
      hoursCovered: buckets.size,
      expectedHours,
      daysSucceeded: days - missingDays.length,
      daysMissing: missingDays.length
    },
    downloads,
    missingDays,
    source: `${DATA_BASE}/data/${market === 'spot' ? 'spot' : 'futures/um'}/daily/aggTrades`
  };
}

module.exports = {
  fetchHistoricalAggTrades,
  downloadDailyAggTrades,
  dailyZipUrl,
  DATA_BASE,
  CACHE_DIR
};
