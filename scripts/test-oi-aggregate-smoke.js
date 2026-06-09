'use strict';

/* eslint-disable no-console */
/**
 * 持仓量多合约聚合 (OI multi-contract aggregation) 冷烟测试
 *
 * 覆盖：
 *   1. aggregate=binance → 三类合约 (USDT-M + USDC-M + COIN-M) 按时间戳相加
 *      · USD = USDT.value + USDC.value + COINM.contracts×100
 *      · Coin = USDT.oi + USDC.oi + COINM.valueBTC
 *   2. 某一源缺失/失败 → 优雅降级，只合并在场源，sources[].ok 标记
 *   3. 单一模式 (无 aggregate) → 仍返回 BTCUSDT 单源，aggregated:false
 *   4. 前向填充：源缺中间样本时不掉坑（carry-forward）
 *
 * 运行：node scripts/test-oi-aggregate-smoke.js
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

// Mock services/binance：USDT-M / USDC-M 走 getOpenInterestHist(symbol)，
// COIN-M 走 getCoinMOpenInterestHist(pair)
function _mockBinance(opts = {}) {
  const binancePath = require.resolve(path.join(__dirname, '..', 'services', 'binance.js'));
  const fake = {
    async getOpenInterestHist(symbol) {
      const s = String(symbol).toUpperCase();
      if (s === 'BTCUSDT') return opts.usdt != null ? opts.usdt : [];
      if (s === 'BTCUSDC') {
        if (opts.usdcThrows) throw new Error('USDC market not found');
        return opts.usdc != null ? opts.usdc : [];
      }
      return [];
    },
    async getCoinMOpenInterestHist(pair) {
      if (String(pair).toUpperCase() === 'BTCUSD') {
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
  const abs = require.resolve(path.join(__dirname, '..', 'routes', 'openInterest.js'));
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

// 构造一条 U 本位样本 {timestamp, sumOpenInterest(coin), sumOpenInterestValue(usd)}
const um = (ts, coin, usd) => ({ timestamp: ts, sumOpenInterest: String(coin), sumOpenInterestValue: String(usd) });
// 构造一条币本位样本 {timestamp, sumOpenInterest(contracts), sumOpenInterestValue(coin BTC)}
const cm = (ts, contracts, coinBtc) => ({ timestamp: ts, sumOpenInterest: String(contracts), sumOpenInterestValue: String(coinBtc) });

async function run() {
  // ==========================================================================
  await test('1. 三源齐全 → USD/Coin 正确相加', async () => {
    _mockBinance({
      usdt:  [um(1000, 100, 1_000_000), um(2000, 110, 1_100_000)],
      usdc:  [um(1000, 10,  100_000),   um(2000, 12,  120_000)],
      coinm: [cm(1000, 5000, 50),       cm(2000, 6000, 60)] // 5000张×100=500k USD, 50 BTC
    });
    const route = _freshRoute();
    const { server, port } = await _startServer(route);
    try {
      const j = await _get(port, '/api/openInterest?symbol=BTCUSDT&market=futures&interval=1h&aggregate=binance');
      assert.ok(j.success);
      assert.equal(j.data.aggregated, true);
      const pts = j.data.data;
      assert.equal(pts.length, 2, `应有 2 个合并点，实际 ${pts.length}`);
      // ts=1000: usd = 1,000,000 + 100,000 + 5000*100(=500,000) = 1,600,000
      //          coin = 100 + 10 + 50 = 160
      assert.equal(pts[0].openInterestValue, 1_600_000, `usd 合计错: ${pts[0].openInterestValue}`);
      assert.equal(pts[0].openInterest, 160, `coin 合计错: ${pts[0].openInterest}`);
      // ts=2000: usd = 1,100,000 + 120,000 + 600,000 = 1,820,000 ; coin = 110+12+60 = 182
      assert.equal(pts[1].openInterestValue, 1_820_000);
      assert.equal(pts[1].openInterest, 182);
      // sources 全 ok
      assert.ok(j.data.sources.every((s) => s.ok && s.count === 2));
    } finally { server.close(); }
  });

  // ==========================================================================
  await test('2. COIN-M 失败 → 只合并 USDT+USDC，sources 标记 ok=false', async () => {
    _mockBinance({
      usdt: [um(1000, 100, 1_000_000)],
      usdc: [um(1000, 10, 100_000)],
      coinmThrows: true
    });
    const route = _freshRoute();
    const { server, port } = await _startServer(route);
    try {
      const j = await _get(port, '/api/openInterest?symbol=BTCUSDT&market=futures&interval=1h&aggregate=1');
      const pts = j.data.data;
      assert.equal(pts.length, 1);
      assert.equal(pts[0].openInterestValue, 1_100_000, '应只含 USDT+USDC');
      assert.equal(pts[0].openInterest, 110);
      const coinmSrc = j.data.sources.find((s) => /COIN-M/.test(s.label));
      assert.equal(coinmSrc.ok, false, 'COIN-M 应标记失败');
    } finally { server.close(); }
  });

  // ==========================================================================
  await test('3. 无 aggregate → 单一 BTCUSDT，aggregated:false', async () => {
    _mockBinance({ usdt: [um(1000, 100, 1_000_000)] });
    const route = _freshRoute();
    const { server, port } = await _startServer(route);
    try {
      const j = await _get(port, '/api/openInterest?symbol=BTCUSDT&market=futures&interval=1h');
      assert.equal(j.data.aggregated, false);
      assert.equal(j.data.data.length, 1);
      assert.equal(j.data.data[0].openInterest, 100);
      assert.equal(j.data.data[0].openInterestValue, 1_000_000);
    } finally { server.close(); }
  });

  // ==========================================================================
  await test('4. 前向填充：USDC 缺 ts=2000 样本 → 用 ts=1000 的值继承，不掉坑', async () => {
    _mockBinance({
      usdt:  [um(1000, 100, 1_000_000), um(2000, 100, 1_000_000)],
      usdc:  [um(1000, 10,  100_000)], // 缺 ts=2000
      coinm: [cm(1000, 1000, 10),       cm(2000, 1000, 10)]
    });
    const route = _freshRoute();
    const { server, port } = await _startServer(route);
    try {
      const j = await _get(port, '/api/openInterest?symbol=BTCUSDT&market=futures&interval=1h&aggregate=binance');
      const pts = j.data.data;
      assert.equal(pts.length, 2);
      // ts=2000: usd = 1,000,000 + (继承)100,000 + 1000×100(=100,000) = 1,200,000
      assert.equal(pts[1].openInterestValue, 1_200_000,
        `前向填充错: ${pts[1].openInterestValue}（应继承 USDC 的 100,000，不掉到 1,100,000）`);
    } finally { server.close(); }
  });

  console.log(`\n${passed} passed · ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

run();
