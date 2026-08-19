'use strict';

/**
 * SWR 响应缓存 (stale-while-revalidate · 热点接口抗网关超时)
 *
 * 背景：浏览器与 Node 之间可能有一层反向代理/网关（超时 ~15s）。
 * klines / openInterest / cvd 这类被前端 10s 轮询的接口如果每次都实时
 * 穿透到 Binance，跨境链路一抖（单次尝试 6s × 重试）就可能顶到网关
 * 红线，被切成 502 HTML 错误页。
 *
 * 策略（对同一 key）：
 *   1. 新鲜 (age ≤ ttlMs)      → 直接返回缓存，毫秒级
 *   2. 过期但可用 (≤ staleMaxMs) → 立即返回旧值，同时后台刷新（去重，
 *      同 key 永远只有一个在途刷新）
 *   3. 无缓存（冷启动）          → 等待刷新，但最多 budgetMs；超预算抛
 *      err.budget=true（刷新继续在后台跑，下一轮轮询即可命中缓存）
 *
 * 效果：除第一次冷启动外，响应时间与 Binance 链路完全解耦；
 * 冷启动也被 budgetMs 兜住，永远不会顶到网关超时。
 *
 * 注意：返回的 value 是缓存共享对象，调用方不要原地修改。
 */

const MAX_ENTRIES = 100;

const _cache = new Map();    // key → { at, value }（Map 迭代序 = 插入序，近似 LRU）
const _inflight = new Map(); // key → Promise（后台刷新去重）

function _set(key, value) {
  if (_cache.size >= MAX_ENTRIES && !_cache.has(key)) {
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) _cache.delete(oldest);
  }
  _cache.delete(key); // 重新插入到队尾
  _cache.set(key, { at: Date.now(), value });
}

function _refresh(key, fetcher) {
  let p = _inflight.get(key);
  if (p) return p;
  p = Promise.resolve()
    .then(fetcher)
    .then((value) => { _set(key, value); return value; })
    .finally(() => { _inflight.delete(key); });
  // 后台刷新失败时可能无人 await → 挂空 catch 防 unhandledRejection
  p.catch(() => {});
  _inflight.set(key, p);
  return p;
}

function _withBudget(promise, budgetMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(
        `数据源响应超预算 ${Math.round(budgetMs / 1000)}s，已转后台继续拉取，`
        + '下一轮自动就绪 (upstream slow; warming cache in background)'
      );
      err.budget = true;
      reject(err);
    }, budgetMs);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

/**
 * @param {string} key       缓存键（把影响响应的所有参数编进来）
 * @param {() => Promise<*>} fetcher  真实取数函数（仅在需要刷新时调用）
 * @param {{ttlMs?:number, staleMaxMs?:number, budgetMs?:number}} [opts]
 * @returns {Promise<{value:*, ageMs:number, stale:boolean}>}
 */
async function swr(key, fetcher, opts = {}) {
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : 10_000;
  const staleMaxMs = Number.isFinite(opts.staleMaxMs) ? opts.staleMaxMs : 10 * 60_000;
  const budgetMs = Number.isFinite(opts.budgetMs) ? opts.budgetMs : 8_000;

  const hit = _cache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;

  if (hit && age <= ttlMs) {
    return { value: hit.value, ageMs: age, stale: false };
  }

  const refreshing = _refresh(key, fetcher);

  if (hit && age <= staleMaxMs) {
    // 先回旧值保面板不空窗，刷新在后台继续
    return { value: hit.value, ageMs: age, stale: true };
  }

  const value = await _withBudget(refreshing, budgetMs);
  return { value, ageMs: 0, stale: false };
}

/** 测试/调试用：清空全部缓存与在途刷新记录 */
function _resetForTest() {
  _cache.clear();
  _inflight.clear();
}

module.exports = { swr, _resetForTest };
