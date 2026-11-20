'use strict';

// Exercise the actual frontend state-machine source with deterministic transports.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(process.cwd(), 'public/app.js'), 'utf8');
function scale() {
  return {
    calls: 0, listener: null, range: { from: 10, to: 20 },
    getVisibleRange() { return this.range; },
    setVisibleRange(range) { this.calls++; this.range = range; this.listener?.(range); },
    subscribeVisibleTimeRangeChange(fn) { this.listener = fn; }
  };
}
const scales = Array.from({ length: 4 }, scale);
const timers = new Map();
let sequence = 0;
const setTimer = fn => { timers.set(++sequence, fn); return sequence; };
const sandbox = {
  console: { info() {}, warn() {}, error() {} }, URLSearchParams, Date, Math, Promise,
  setTimeout: setTimer, clearTimeout: id => timers.delete(id),
  setInterval: setTimer, clearInterval: id => timers.delete(id),
  requestAnimationFrame: setTimer, cancelAnimationFrame: id => timers.delete(id),
  mainChart: { timeScale: () => scales[0] }, volumeChart: { timeScale: () => scales[1] },
  cvdChart: { timeScale: () => scales[2] }, oiChart: { timeScale: () => scales[3] }
};
vm.createContext(sandbox);
vm.runInContext(source.slice(source.indexOf('  const allTimeScales = ['), source.indexOf('  // ---- 流动性热图')), sandbox);
scales[1].listener({ from: 11, to: 15 });
assert.equal(scales[0].calls, 0);
scales[0].listener({ from: 10, to: 20 });
assert.equal(scales[0].calls, 0);
assert.equal(scales[1].calls, 1);
console.log('PASS: 副图更新不能反向改变主图，主图可同步副图');

class FakeSource {
  constructor() { this.handlers = {}; this.readyState = 1; }
  addEventListener(event, fn) { this.handlers[event] = fn; }
  emit(event, data) { this.handlers[event]?.({ data: JSON.stringify(data) }); }
  close() { this.closed = true; this.readyState = 2; }
}
let mainRenders = 0;
Object.assign(sandbox, {
  EventSource: FakeSource, KLINE_LIMIT: 200, SUBCHART_LIMIT: 500,
  els: { symbol: { value: 'BTCUSDT' }, market: { value: 'futures' }, interval: { value: '1h' } },
  obDepthForInterval: () => 50, setStatus() {}, nowBJTimeHMS: () => '12:00:00',
  renderMain: () => { mainRenders++; }, renderOrderBook() {},
  window: { dispatchEvent() {} }, Event: class {}, renderOpenInterest() {},
  oiAggregateParam: () => '', _cvdAggregate: false, lastCandles: [], fitCharts() {},
  _restoreHoverCrosshairs() {}, refreshCvdDisplay() {}, document: { hidden: false },
  POLL_INTERVAL_MS: 10000, pollTimer: null
});
const start = source.indexOf('  const SSE_RENDER_THROTTLE_MS');
const end = source.indexOf('  /**\n   * Binance USD', start);
vm.runInContext(source.slice(start, end) + '\nthis.testState={startSSE,restartSSE,scheduleSSEReconnect,sseState,poll};', sandbox);
const state = sandbox.testState;
state.startSSE();
state.sseState.es.emit('snapshot', { klines: [{ openTime: 1 }], symbol: 'BTCUSDT', market: 'futures', interval: '1h' });
assert.equal(state.sseState.everReady, true);
state.scheduleSSEReconnect();
assert.equal(state.sseState.everReady, true);
assert.equal(state.sseState.candles.length, 1);
assert.equal(state.sseState.es, null);
const reconnect = timers.get(state.sseState.reconnectTimer);
reconnect();
assert.equal(state.sseState.everReady, true);
assert.equal(state.sseState.backoffMs, 2000);
state.restartSSE();
assert.equal(state.sseState.everReady, false);
console.log('PASS: 自动重连保留所有权与数据，手动切换才重置，退避递增');

async function race() {
  const pending = [];
  sandbox.fetchJsonSoft = url => new Promise(resolve => pending.push({ url, resolve }));
  sandbox.fetchJsonSoft.lastErrors = {};
  sandbox.fetchJsonSoft.cacheInfo = {};
  const request = state.poll();
  state.sseState.es.emit('snapshot', { klines: [{ openTime: 2 }], symbol: 'BTCUSDT', market: 'futures', interval: '1h' });
  const afterSnapshot = mainRenders;
  pending.forEach(item => item.resolve({ candles: [], data: [] }));
  await request;
  assert.equal(mainRenders, afterSnapshot);
  console.log('PASS: SSE接管后返回的旧轮询不能覆盖主图');
}
race().catch(error => { console.error(error); process.exitCode = 1; });
