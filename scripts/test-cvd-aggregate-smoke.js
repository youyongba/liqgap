'use strict';

/* eslint-disable no-console */
/**
 * CVD 多合约聚合 (CVD multi-contract aggregation) 冷烟测试
 *
 * 覆盖：
 *   1. aggregate=binance → 三类合约 (USDT-M + USDC-M + COIN-M) 每根 delta 按时间戳相加
 *      · U 本位 delta = 2×takerBuyBase(idx9) - baseVolume(idx5)
 *      · 币本位 delta = 2×takerBuyBaseAssetVolume(idx10) - baseAssetVolume(idx7)
 *   2. 某一源失败 → 优雅降级，只合并在场源，sources[].ok 标记
 *   3. 单一模式 (无 aggregate) → 仅 BTCUSDT，aggregated:false
 *   4. 缺某根 bar 的源按 0 计入（不前向填充 delta），其余源仍相加
 *
 * 运行：node scripts/test-cvd-aggregate-smoke.js
 */

require('dotenv').config();
const path = require('path');
const http = require('http');
const assert = require('assert');

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log(`✓ ${name}`); })
    .catch((err) => { failed += 1; console.error(`✗ ${name}\n   ${err.message}`); });
}

// Mock services/binance：U 本位走 getKlines(symbol)，币本位走 getCoinMKlines(symbol)
function _mockBinance(opts = {}) {
  const binancePath = require.resolve(path.join(__dirname, '..', 'services', 'binance.js'));
  const fake = {
    async getKlines(symbol) {
      const s = String(symbol).toUpperCase();
      if (s === 'BTCUSDT') return opts.usdt != null ? opts.usdt : [];
      if (s === 'BTCUSDC') {
        if (opts.usdcThrows) throw new Error('USDC market not found');
        return opts.usdc != null ? opts.usdc : [];
      }
      return [];
    },
    async getCoinMKlines(symbol) {
      if (String(symbol).toUpperCase() === 'BTCUSD_PERP') {
        if (opts.coinmThrows) throw new Error('coin-m down');
        return opts.coinm != null ? opts.coinm : [];
      }
      return [];
    }
  };
  require.cache[binancePath] = {
    id: binancePath, filename: binancePath, loaded: true,
    exports: { BinanceService: fake }
  };
}

function _freshRoute() {
  const abs = require.resolve(path.join(__dirname, '..', 'routes', 'cvd.js'));
  delete require.cache[abs];
  return require(abs);
}

async function _startServer(route) {
  const express = require('express');
  const app = express();
  app.use('/api', route);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((res) => server.on('listening', res));
  return { server, port: server.address().port };
}

function _get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (r) => {
      let buf = '';
      r.on('data', (b) => { buf += b; });
      r.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// U 本位 kline 行：[openTime, o,h,l,c, baseVol(idx5), closeTime, quoteVol(idx7), n, takerBuyBase(idx9), takerBuyQuote(idx10), ...]
const fk = (ts, baseVol, takerBuyBase, quoteVol = 0, takerBuyQuote = 0) =>
  [ts, '0', '0', '0', '0', String(baseVol), ts + 1, String(quoteVol), 0, String(takerBuyBase), String(takerBuyQuote), '0'];
// 币本位 kline 行：[openTime, o,h,l,c, contracts(idx5), closeTime, baseAssetVol(idx7), n, takerBuyVol(idx9), takerBuyBaseAssetVol(idx10), ...]
const dk = (ts, baseAssetVol, takerBuyBaseAssetVol, contracts = 0, takerBuyContracts = 0) =>
  [ts, '0', '0', '0', '0', String(contracts), ts + 1, String(baseAssetVol), 0, String(takerBuyContracts), String(takerBuyBaseAssetVol), '0'];

async function run() {
  // ==========================================================================
  await test('1. 三源齐全 → 每根 delta(币) 与 deltaUsd 正确相加', async () => {
    _mockBinance({
      // coin delta = 2*tbB - baseVol ; usd delta = 2*tbQuote - quoteVol
      usdt:  [fk(1000, 100, 70, 1000, 700), fk(2000, 100, 40, 1000, 400)], // coin:40,-20 usd:400,-200
      usdc:  [fk(1000, 10, 8, 100, 80),     fk(2000, 10, 3, 100, 30)],     // coin:6,-4  usd:60,-40
      // COIN-M: coin delta = 2*tbBaseAsset - baseAssetVol ; usd = 100×(2*tbContracts - contracts)
      coinm: [dk(1000, 4, 3, 50, 35),       dk(2000, 4, 1, 50, 15)]        // coin:2,-2  usd:100×(70-50)=2000, 100×(30-50)=-2000
    });
    const route = _freshRoute();
    const { server, port } = await _startServer(route);
    try {
      const j = await _get(port, '/api/cvd?symbol=BTCUSDT&market=futures&interval=1h&aggregate=binance');
      assert.ok(j.success);
      assert.equal(j.data.aggregated, true);
      const pts = j.data.data;
      assert.equal(pts.length, 2, `应有 2 个合并点，实际 ${pts.length}`);
      // coin: ts=1000 → 40+6+2=48 ; ts=2000 → -20-4-2=-26
      assert.equal(pts[0].delta, 48, `ts1000 coin 合计错: ${pts[0].delta}`);
      assert.equal(pts[1].delta, -26, `ts2000 coin 合计错: ${pts[1].delta}`);
      // usd: ts=1000 → 400+60+2000=2460 ; ts=2000 → -200-40-2000=-2240
      assert.equal(pts[0].deltaUsd, 2460, `ts1000 usd 合计错: ${pts[0].deltaUsd}`);
      assert.equal(pts[1].deltaUsd, -2240, `ts2000 usd 合计错: ${pts[1].deltaUsd}`);
      assert.ok(j.data.sources.every((s) => s.ok && s.count === 2));
    } finally { server.close(); }
  });

  // ==========================================================================
  await test('2. COIN-M 失败 → 只合并 USDT+USDC，sources 标记 ok=false', async () => {
    _mockBinance({
      usdt: [fk(1000, 100, 70)], // delta 40
      usdc: [fk(1000, 10, 8)],   // delta 6
      coinmThrows: true
    });
    const route = _freshRoute();
    const { server, port } = await _startServer(route);
    try {
      const j = await _get(port, '/api/cvd?symbol=BTCUSDT&market=futures&interval=1h&aggregate=1');
      const pts = j.data.data;
      assert.equal(pts.length, 1);
      assert.equal(pts[0].delta, 46, '应只含 USDT+USDC = 46');
      const coinmSrc = j.data.sources.find((s) => /COIN-M/.test(s.label));
      assert.equal(coinmSrc.ok, false, 'COIN-M 应标记失败');
    } finally { server.close(); }
  });

  // ==========================================================================
  await test('3. 无 aggregate → 单一 BTCUSDT，aggregated:false', async () => {
    _mockBinance({ usdt: [fk(1000, 100, 70)] });
    const route = _freshRoute();
    const { server, port } = await _startServer(route);
    try {
      const j = await _get(port, '/api/cvd?symbol=BTCUSDT&market=futures&interval=1h');
      assert.equal(j.data.aggregated, false);
      assert.equal(j.data.data.length, 1);
      assert.equal(j.data.data[0].delta, 40);
    } finally { server.close(); }
  });

  // ==========================================================================
  await test('4. 缺某根 bar 的源按 0 计入，其余源仍相加', async () => {
    _mockBinance({
      usdt:  [fk(1000, 100, 70), fk(2000, 100, 40)], // 40, -20
      usdc:  [fk(1000, 10, 8)],                       // 缺 ts=2000
      coinm: [dk(1000, 4, 3),    dk(2000, 4, 1)]      // 2, -2
    });
    const route = _freshRoute();
    const { server, port } = await _startServer(route);
    try {
      const j = await _get(port, '/api/cvd?symbol=BTCUSDT&market=futures&interval=1h&aggregate=binance');
      const pts = j.data.data;
      assert.equal(pts.length, 2);
      // ts=2000: USDT(-20) + USDC(缺=0) + COINM(-2) = -22
      assert.equal(pts[1].delta, -22, `缺源应按 0 计入: ${pts[1].delta}`);
    } finally { server.close(); }
  });

  console.log(`\n${passed} passed · ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

run();
