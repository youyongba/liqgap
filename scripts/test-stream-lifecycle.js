'use strict';

const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const express = require('express');
const hub = new EventEmitter();
let resolveSeed;
hub.getKlines = () => new Promise(resolve => { resolveSeed = resolve; });
hub.getOrderBook = async () => ({ bids: [], asks: [] });
hub.getAggTrades = async () => [];
function substitute(name, exports) {
  const filename = require.resolve(name);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
substitute('../services/binanceStream', { getHub: () => hub });
substitute('../services/binanceLive', { getStreamStatus: () => [] });
substitute('../services/binance', { getRateLimitState: () => ({}) });
const streamRoute = require('../routes/stream');
const tick = () => new Promise(resolve => setTimeout(resolve, 25));

async function main() {
  const app = express();
  app.use('/api', streamRoute);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/api/stream/sse`;
  try {
    const controller = new AbortController();
    const first = await fetch(url, { signal: controller.signal });
    const reader = first.body.getReader();
    await reader.read();
    controller.abort();
    await tick();
    resolveSeed([]);
    await tick();
    assert.equal(hub.listenerCount('kline'), 0);
    assert.equal(hub.listenerCount('book'), 0);
    assert.equal(hub.listenerCount('trade'), 0);
    console.log('PASS: 初始化中断开不会残留hub监听');

    hub.getKlines = async () => [];
    const second = await fetch(url);
    const reader2 = second.body.getReader();
    const initial = await reader2.read();
    assert.match(new TextDecoder().decode(initial.value), /snapshot/);
    assert.equal(hub.listenerCount('kline'), 1);
    await reader2.cancel();
    await tick();
    assert.equal(hub.listenerCount('kline'), 0);
    assert.equal(hub.listenerCount('book'), 0);
    console.log('PASS: 正常订阅关闭后释放全部监听');

    hub.getKlines = async () => { throw new Error('test upstream timeout'); };
    const failed = await fetch(url);
    const text = await failed.text();
    assert.match(text, /event: error/);
    assert.equal(hub.listenerCount('kline'), 0);
    console.log('PASS: 上游失败返回明确事件并关闭，不遗留心跳');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
