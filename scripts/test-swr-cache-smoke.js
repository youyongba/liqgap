'use strict';

/**
 * swrCache 冒烟测试 (SWR response cache smoke tests)
 *
 * 验证：冷启动取数 / 新鲜命中 / 过期回旧值+后台刷新 / 并发去重 /
 *       冷启动超预算 / 错误传播 / 有旧值时刷新失败不影响返回。
 *
 * 运行：node scripts/test-swr-cache-smoke.js
 */

const swrCache = require('../services/swrCache');

let passed = 0;
let failed = 0;

function assert(cond, name) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.error(`  ✗ ${name}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ---- 1. 冷启动：调用 fetcher 并返回新值 ----
  console.log('1. 冷启动取数');
  swrCache._resetForTest();
  let calls = 0;
  const r1 = await swrCache.swr('k1', async () => { calls += 1; return { v: 1 }; }, { ttlMs: 1000 });
  assert(r1.value.v === 1 && r1.stale === false, '返回新值且 stale=false');
  assert(calls === 1, 'fetcher 被调用 1 次');

  // ---- 2. 新鲜命中：不再调用 fetcher ----
  console.log('2. 新鲜命中');
  const r2 = await swrCache.swr('k1', async () => { calls += 1; return { v: 2 }; }, { ttlMs: 1000 });
  assert(r2.value.v === 1 && r2.stale === false, '命中缓存返回旧对象');
  assert(calls === 1, 'fetcher 未被再次调用');

  // ---- 3. 过期回旧值 + 后台刷新 ----
  console.log('3. 过期先回旧值，后台刷新');
  swrCache._resetForTest();
  calls = 0;
  await swrCache.swr('k3', async () => { calls += 1; return { v: 'old' }; }, { ttlMs: 10 });
  await sleep(30); // 超过 ttl 但远小于 staleMax
  const r3 = await swrCache.swr('k3', async () => { calls += 1; return { v: 'new' }; },
    { ttlMs: 10, staleMaxMs: 60_000 });
  assert(r3.value.v === 'old' && r3.stale === true, '立即返回旧值且 stale=true');
  await sleep(20); // 等后台刷新落盘
  const r3b = await swrCache.swr('k3', async () => { calls += 1; return { v: 'newer' }; },
    { ttlMs: 60_000 });
  assert(r3b.value.v === 'new', '后台刷新后的值已生效');
  assert(calls === 2, '刷新只发生 1 次（共 2 次调用）');

  // ---- 4. 并发去重 ----
  console.log('4. 并发去重');
  swrCache._resetForTest();
  calls = 0;
  const slowFetch = async () => { calls += 1; await sleep(50); return { v: 'x' }; };
  const [a, b] = await Promise.all([
    swrCache.swr('k4', slowFetch, { budgetMs: 1000 }),
    swrCache.swr('k4', slowFetch, { budgetMs: 1000 })
  ]);
  assert(a.value === b.value, '两个并发请求拿到同一对象');
  assert(calls === 1, 'fetcher 只被调用 1 次');

  // ---- 5. 冷启动超预算：抛 budget 错误，但刷新继续、下轮命中 ----
  console.log('5. 冷启动超预算');
  swrCache._resetForTest();
  calls = 0;
  let budgetErr = null;
  try {
    await swrCache.swr('k5', async () => { calls += 1; await sleep(100); return { v: 'late' }; },
      { budgetMs: 20 });
  } catch (e) { budgetErr = e; }
  assert(budgetErr && budgetErr.budget === true, '超预算抛 err.budget=true');
  await sleep(120); // 让后台刷新完成
  const r5 = await swrCache.swr('k5', async () => { calls += 1; return { v: 'fresh' }; },
    { ttlMs: 60_000 });
  assert(r5.value.v === 'late' && calls === 1, '后台刷新已落盘，下轮直接命中');

  // ---- 6. 冷启动出错：错误向上传播 ----
  console.log('6. 冷启动错误传播');
  swrCache._resetForTest();
  let err6 = null;
  try {
    await swrCache.swr('k6', async () => { throw new Error('boom'); }, { budgetMs: 1000 });
  } catch (e) { err6 = e; }
  assert(err6 && err6.message === 'boom', '冷启动 fetcher 报错向上抛');

  // ---- 7. 有旧值时刷新失败：仍返回旧值不报错 ----
  console.log('7. 有旧值时刷新失败不影响返回');
  swrCache._resetForTest();
  await swrCache.swr('k7', async () => ({ v: 'safe' }), { ttlMs: 10 });
  await sleep(30);
  const r7 = await swrCache.swr('k7', async () => { throw new Error('net down'); },
    { ttlMs: 10, staleMaxMs: 60_000 });
  assert(r7.value.v === 'safe' && r7.stale === true, '刷新失败仍平稳返回旧值');
  await sleep(20); // 后台失败不应产生 unhandledRejection（有的话进程会打警告）

  console.log(`\n${passed} passed · ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
