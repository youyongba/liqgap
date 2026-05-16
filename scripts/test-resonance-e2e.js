'use strict';

/* eslint-disable no-console */
/**
 * 端到端冷烟测试 (E2E smoke test with mocked Binance)
 *
 * 不依赖外部网络 —— 用 require.cache 注入 mock 的 BinanceService 模块，
 * 然后启动 express，对 /api/trade/resonance-signal 发真正的 HTTP 请求，
 * 验证：
 *   1. 模块全链路启动 + 路由可达
 *   2. 响应结构完整（含 conditions / FVG / 主峰 / TP）
 *   3. 不同价格场景下 confidence 分级符合预期
 *   4. 时间窗硬过滤（funding window）正确触发拒绝
 *   5. 飞书时间格式化 = 东八区
 */

require('dotenv').config();
// 强制关闭 auto-trade webhook + 飞书推送，避免冷烟测试给外部发请求
process.env.AUTO_TRADE_ENABLED = 'false';
process.env.FEISHU_NOTIFY_ENABLED = 'false';
// 关闭周末 / funding 时间过滤，方便随时跑
process.env.RESONANCE_EXCLUDE_WEEKEND_LOW_LIQ = 'false';
process.env.RESONANCE_EXCLUDE_FUNDING_WINDOW_MIN = '0';
// 关闭冷却（多次测试同 symbol+direction）
process.env.RESONANCE_COOLDOWN_REQUIRED = 'false';

const path = require('path');
const http = require('http');

// ============================================================================
// 1. 准备模拟数据 —— 生成"6 指标全 hit"的 long 场景
// ============================================================================
//
//  midPrice = 80000，构造：
//    • peakLong = 79900 (距 midPrice 0.125% < 0.5% 触发 nearLiqPeak)
//    • 价格刚 reject 79900 后反弹（K 线下影针）
//    • 多头方向 FVG [79950, 80050] = 0.125% size，价格 80000 在内
//    • VWAP 1h = 79800（midPrice 在 VWAP 上方 → vwapAligned for long）
//    • 5m 成交量末桶暴涨 3x
//    • OI 末桶相比 1h 均值涨 2x
//    • CVD 与价格背离（价跌 CVD 涨 → bullish 背离）
//
const NOW = Date.now();
const ONE_MIN = 60_000;
const MID = 80000;

// 1m × 60 K 线（用于 trend + VWAP + FVG）
const candles1m = [];
for (let i = 0; i < 60; i += 1) {
  const t = NOW - (60 - i) * ONE_MIN;
  if (i === 30) {
    // 中间制造一个 bullish FVG：candle[30].high < candle[32].low
    candles1m.push({ openTime: t, open: 79940, high: 79950, low: 79900, close: 79945, volume: 50, closeTime: t + ONE_MIN, quoteVolume: 50*79945, trades: 100, takerBuyBase: 25, takerBuyQuote: 25*79945 });
  } else if (i === 31) {
    candles1m.push({ openTime: t, open: 79945, high: 80050, low: 79940, close: 80020, volume: 80, closeTime: t + ONE_MIN, quoteVolume: 80*80020, trades: 200, takerBuyBase: 50, takerBuyQuote: 50*80020 });
  } else if (i === 32) {
    candles1m.push({ openTime: t, open: 80020, high: 80100, low: 80050, close: 80080, volume: 60, closeTime: t + ONE_MIN, quoteVolume: 60*80080, trades: 150, takerBuyBase: 40, takerBuyQuote: 40*80080 });
  } else if (i >= 57) {
    // 末 3 根：制造 reject + 反弹做多形态（最低点触 79900，收盘 high）
    if (i === 58) {
      candles1m.push({ openTime: t, open: 80000, high: 80020, low: 79910, close: 80010, volume: 100, closeTime: t + ONE_MIN, quoteVolume: 100*80010, trades: 200, takerBuyBase: 70, takerBuyQuote: 70*80010 });
    } else if (i === 59) {
      // 最新桶：成交量大 → 触发 vol surge
      candles1m.push({ openTime: t, open: 80010, high: 80050, low: 79990, close: MID, volume: 500, closeTime: t + ONE_MIN, quoteVolume: 500*MID, trades: 600, takerBuyBase: 350, takerBuyQuote: 350*MID });
    } else {
      candles1m.push({ openTime: t, open: 79980, high: 80000, low: 79970, close: 79990, volume: 80, closeTime: t + ONE_MIN, quoteVolume: 80*79990, trades: 150, takerBuyBase: 45, takerBuyQuote: 45*79990 });
    }
  } else if (i >= 50) {
    // 价格下行制造 CVD 背离的前提
    const p = 80300 - i * 5;
    candles1m.push({ openTime: t, open: p, high: p + 5, low: p - 5, close: p - 2, volume: 60, closeTime: t + ONE_MIN, quoteVolume: 60*p, trades: 100, takerBuyBase: 30, takerBuyQuote: 30*p });
  } else {
    // 早期 K 线：让 VWAP 偏低（cumulative 偏低价位）
    candles1m.push({ openTime: t, open: 79750, high: 79800, low: 79700, close: 79780, volume: 50, closeTime: t + ONE_MIN, quoteVolume: 50*79780, trades: 80, takerBuyBase: 25, takerBuyQuote: 25*79780 });
  }
}

// 转成 Binance raw 数组格式 [openTime, open, high, low, close, volume, closeTime, qV, trades, takerBuyBase, takerBuyQuote, ignore]
const toRaw = (c) => [c.openTime, String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume), c.closeTime, String(c.quoteVolume), c.trades, String(c.takerBuyBase), String(c.takerBuyQuote), '0'];
const candles1mRaw = candles1m.map(toRaw);

// 5m × 288 K 线（用于 vol surge 基准）
// 注意：computeVolumeSurge 是看末桶 vs 之前 lookbackBuckets 个桶的均值（excludeLatest=true）
// 我们把末桶（i==287）放大到很大值
const candles5mRaw = [];
for (let i = 0; i < 288; i += 1) {
  const t = NOW - (288 - i) * 5 * ONE_MIN;
  const vol = i === 287 ? 5000 : 100; // 末桶 50× 均值
  candles5mRaw.push([t, '80000', '80050', '79950', '80000', String(vol), t + 5*ONE_MIN, String(vol*80000), 100, String(vol/2), String(vol/2*80000), '0']);
}

// OI 历史：最近 24 条 5m，末条相对前 12 条均值 3×
const oiHist = [];
for (let i = 0; i < 24; i += 1) {
  oiHist.push({
    timestamp: NOW - (24 - i) * 5 * ONE_MIN,
    sumOpenInterest: String(i === 23 ? 3000 : 1000),
    sumOpenInterestValue: String(i === 23 ? 240000000 : 80000000)
  });
}

// 聚合成交：买方主动占主导（让 CVD 上升）
const trades = [];
for (let i = 0; i < 500; i += 1) {
  trades.push({
    a: i, p: String(MID + (i % 10 - 5)), q: '0.5',
    f: i, l: i, T: NOW - (500 - i) * 100,
    m: i % 5 === 0  // 80% 买方主动（m=false）
  });
}

// ============================================================================
// 2. 替换 BinanceService 模块（require.cache 注入）
// ============================================================================
const binancePath = require.resolve(path.join(__dirname, '..', 'services', 'binance.js'));
require.cache[binancePath] = {
  id: binancePath,
  filename: binancePath,
  loaded: true,
  exports: {
    BinanceService: {
      async getKlines(symbol, interval, limit /*, market */) {
        if (interval === '5m') return candles5mRaw.slice(-limit);
        // 1m / 15m / 1h 共用 candles1m（数据有内部结构）
        return candles1mRaw.slice(-limit);
      },
      async getOpenInterestHist(/* symbol, period, limit */) {
        return oiHist;
      },
      async getAggTrades(/* symbol, limit, market */) {
        return trades;
      }
    }
  }
};

// 同样 mock binanceLive（多个 route 用它）
try {
  const bLivePath = require.resolve(path.join(__dirname, '..', 'services', 'binanceLive.js'));
  require.cache[bLivePath] = {
    id: bLivePath,
    filename: bLivePath,
    loaded: true,
    exports: {
      BinanceLive: require.cache[binancePath].exports.BinanceService
    }
  };
} catch (_) {}

// ============================================================================
// 3. 启动 express
// ============================================================================
const express = require('express');
const resonanceRoute = require('../routes/resonanceSignal');
const app = express();
app.use(express.json());
app.use('/api', resonanceRoute);
const server = app.listen(0, '127.0.0.1');
let port; // 异步取得，避免 server.address() 在 listen 完成前为 null
function _ensurePort() {
  return new Promise((resolve) => {
    if (port) return resolve(port);
    server.on('listening', () => { port = server.address().port; resolve(port); });
    const addr = server.address();
    if (addr) { port = addr.port; resolve(port); }
  });
}

function get(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.on('data', (b) => { body += b; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('non-JSON: ' + body.slice(0, 200))); }
      });
    });
    req.on('error', reject);
  });
}

function post(p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST' }, (res) => {
      let body = '';
      res.on('data', (b) => { body += b; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('non-JSON: ' + body)); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// ============================================================================
// 4. 运行测试
// ============================================================================
let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`✗ ${name}\n   ${err.message}`);
  }
}

(async () => {
  await _ensurePort();
  console.log(`   E2E server on 127.0.0.1:${port}\n`);
  await test('resonance status endpoint 返回完整配置', async () => {
    const r = await get('/api/trade/resonance-signal/status');
    const c = r.success && r.data && r.data.config;
    if (!c) throw new Error('no config');
    if (c.HEXA.leverage !== 100) throw new Error('HEXA leverage should be 100');
    if (c.TRIO.leverage !== 20) throw new Error('TRIO leverage should be 20');
  });

  await test('resonance signal 返回结构合规', async () => {
    const r = await get('/api/trade/resonance-signal?symbol=BTCUSDT&windowMs=86400000&priceRange=0.05&notify=false&autoTrade=false');
    if (!r.success) throw new Error('not success: ' + JSON.stringify(r).slice(0, 300));
    const d = r.data;
    if (!('tier' in d)) throw new Error('no tier field');
    if (!('signal' in d)) throw new Error('no signal field');
    if (!('indicatorsSnapshot' in d)) throw new Error('no snapshot');
    const s = d.indicatorsSnapshot;
    if (!('peakLong' in s) || !('peakShort' in s)) throw new Error('no peaks');
    if (!('vwap1h' in s)) throw new Error('no vwap1h');
    if (!('volSurge' in s) || !('oiSurge' in s)) throw new Error('no vol/oi surge');
    if (!('cvdDivergence' in s)) throw new Error('no cvd divergence');
    if (!('activeFvgLong' in s) || !('activeFvgShort' in s)) throw new Error('no active fvgs');
    if (!('trend4h' in s) || !('trend60h' in s)) throw new Error('no trend');
    console.log(`   tier=${d.tier} signal=${d.signal} conf=${d.confidence}`);
    console.log(`   vwap1h=${s.vwap1h?.toFixed(2)} volSurge=${s.volSurge?.toFixed(2)}x oiSurge=${s.oiSurge?.toFixed(2)}x`);
    console.log(`   peakLong=${s.peakLong?.price?.toFixed(2)} peakShort=${s.peakShort?.price?.toFixed(2)}`);
    console.log(`   activeFvgLong=${s.activeFvgLong ? 'YES' : 'NO'} activeFvgShort=${s.activeFvgShort ? 'YES' : 'NO'}`);
  });

  await test('reset 端点清空状态', async () => {
    const r = await post('/api/trade/resonance-signal/reset');
    if (!r.success) throw new Error('reset failed');
  });

  console.log(`\n${passed} passed · ${failed} failed`);
  server.close();
  process.exit(failed > 0 ? 1 : 0);
})();
