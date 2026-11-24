'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { once } = require('node:events');
globalThis.crypto = globalThis.crypto || require('node:crypto').webcrypto;
const { keccak256, toHex } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { x402Client } = require('@x402/core/client');
const { ExactEvmScheme } = require('@x402/evm/exact/client');
const { encodePaymentSignatureHeader } = require('@x402/core/http');
const { createStore } = require('../services/payment/store');
const config = require('../services/payment/config');
const { createPaymentRouter } = require('../routes/payment');
const { isPaymentReceipt, createSettlementService } = require('../services/payment/settlement');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liq-payment-test-'));
  const filename = path.join(dir, 'payments.sqlite');
  let store = createStore(filename);
  const oldSecret = process.env.AUTO_TRADE_API_TOKEN;
  process.env.AUTO_TRADE_API_TOKEN = 'test-only-admin-secret';
  let submitted = 0;
  const app = express();
  app.use(express.json());
  const router = createPaymentRouter({ store,
    verify: async payload => ({ isValid: payload.payload.signature !== 'invalid' }),
    settlement: { blockNumber: async () => '0x100', start: () => { submitted++; } }
  });
  app.use('/api/payment', router);
  app.use('/api', router.checkAuth);
  app.get('/api/private', (_req, res) => res.json({ success: true }));
  app.get('/api/stream/sse', (_req, res) => { res.set('Content-Type', 'text/event-stream'); res.write('data: ready\n\n'); });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(url, body, headers = {}) {
    const response = await fetch(base + url, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  const account = privateKeyToAccount('0x' + '01'.repeat(32)); // Synthetic key; never funded or broadcast.
  let paidOrder;
  try {
    assert.equal((await request('/api/private')).status, 401);
    assert.equal((await request('/api/private', null, { Cookie: 'liq_gap_token=forged' })).status, 401);
    assert.equal((await request('/api/payment/admin/grant', { secret: 'admin123' })).status, 403);
    delete process.env.AUTO_TRADE_API_TOKEN;
    assert.equal((await request('/api/payment/admin/grant', {})).status, 503);
    process.env.AUTO_TRADE_API_TOKEN = 'test-only-admin-secret';
    assert.equal((await request('/api/payment/buy/daily', { txHash: 'forged' })).status, 410);
    assert.equal((await request('/api/payment/orders', { type: 'weekly' })).status, 400);
    console.log('PASS: 未授权、伪造凭证、旧接口和默认密码均拒绝');
    const { disclaimerVersion } = (await request('/api/payment/config')).data;
    assert.equal((await request('/api/payment/orders', { type: 'daily', disclaimerVersion: '2026-11-18' })).status, 400);
    const secret = process.env.AUTO_TRADE_API_TOKEN;
    const adminPath = '/api/payment/admin/whitelist';
    const expiresAt = Date.now() + 86400000;
    const spec = { username: '试用-A', expiresAt };
    assert.equal((await request(adminPath, spec)).status, 403);
    assert.equal((await request(adminPath, { ...spec, secret, expiresAt: Date.now() - 1 })).status, 400);
    const created = await request(adminPath, { ...spec, secret });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('set-cookie'), null);
    const { password, id } = created.data;
    assert.equal((await request(adminPath, { ...spec, secret, username: '试用-a' })).status, 409);
    const listing = (await request('/api/payment/admin/tokens', { secret })).data.tokens;
    assert.equal(listing[id].username, spec.username);
    assert.ok(!JSON.stringify(listing).includes(password));
    const login = pwd => request('/api/payment/whitelist/login', { username: '试用-a', password: pwd });
    assert.equal((await login('wrong')).status, 401);
    const session = await login(password);
    assert.equal(session.status, 200);
    assert.equal(session.data.expiresAt, expiresAt);
    const cookie = session.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    const authHeaders = { Cookie: cookie.split(';')[0] };
    assert.equal((await request('/api/private', null, authHeaders)).status, 200);
    assert.equal((await request(adminPath, spec, authHeaders)).status, 403);
    const editPath = `${adminPath}/${id}/expiry`;
    assert.equal((await request(editPath, { expiresAt })).status, 403);
    store.db.prepare('UPDATE orders SET expiresAt=? WHERE id=?').run(Date.now() - 1, id);
    assert.equal((await login(password)).status, 401);
    assert.equal((await request('/api/private', null, authHeaders)).status, 401);
    assert.equal((await request(editPath, { secret, expiresAt })).status, 200);
    assert.equal((await login(password)).status, 200);
    assert.equal((await request('/api/payment/admin/revoke', { secret, token: id })).status, 200);
    assert.equal((await request(editPath, { secret, expiresAt })).status, 404);
    assert.equal((await login(password)).status, 401);
    assert.equal((await request('/api/private', null, authHeaders)).status, 401);
    console.log('PASS: 白名单创建、重复账号、登录、授权隔离、失效、续期、撤销');

    for (const [type, plan] of Object.entries(config.plans)) {
      const order = (await request('/api/payment/orders', { type, disclaimerVersion })).data;
      const headers = { 'X-Order-Key': order.key };
      const url = `/api/payment/orders/${order.id}/pay`;
      assert.equal((await request(url, {})).status, 404);
      const challenge = await request(url, {}, headers);
      assert.equal(challenge.status, 402);
      assert.equal(challenge.data.accepts[0].amount, plan.amount);
      const client = new x402Client();
      client.setSpendControls({ maxAmountPerPayment: `$${plan.price}` });
      client.register(config.network, new ExactEvmScheme(account));
      const payload = await client.createPaymentPayload(challenge.data);
      assert.equal(payload.payload.authorization.value, plan.amount);
      const wrong = structuredClone(payload);
      wrong.accepted.amount = '1';
      assert.equal((await request(url, {}, { ...headers, 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(wrong) })).status, 400);
      wrong.accepted.amount = plan.amount;
      wrong.payload.signature = 'invalid';
      assert.equal((await request(url, {}, { ...headers, 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(wrong) })).status, 400);
      const submittedOrder = await request(url, {}, { ...headers, 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(payload) });
      assert.equal(submittedOrder.status, 202);
      assert.equal(submittedOrder.data.hasAccess, false);
      assert.equal(store.access(store.get(order.id).token), undefined);
      const duplicate = (await request('/api/payment/orders', { type, disclaimerVersion })).data;
      assert.equal((await request(`/api/payment/orders/${duplicate.id}/pay`, {}, {
        'X-Order-Key': duplicate.key, 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(payload)
      })).status, 409);

      const stored = store.get(order.id);
      const topic = address => '0x' + address.slice(2).toLowerCase().padStart(64, '0');
      const receipt = { status: '0x1', logs: [
        { address: config.asset, topics: [keccak256(toHex('AuthorizationUsed(address,bytes32)')),
          topic(account.address), payload.payload.authorization.nonce], data: '0x' },
        { address: config.asset, topics: [keccak256(toHex('Transfer(address,address,uint256)')),
          topic(account.address), topic(config.payTo)], data: toHex(BigInt(plan.amount)) }
      ] };
      assert.equal(isPaymentReceipt(receipt, stored), true);
      assert.equal(isPaymentReceipt({ ...receipt, status: '0x0' }, stored), false);
      assert.equal(isPaymentReceipt({ ...receipt, logs: [receipt.logs[1]] }, stored), false);
      const incorrect = structuredClone(receipt);
      incorrect.logs[1].data = '0x01';
      assert.equal(isPaymentReceipt(incorrect, stored), false);
      incorrect.logs[1].address = '0x' + 'ff'.repeat(20);
      assert.equal(isPaymentReceipt(incorrect, stored), false);
      const txHash = '0x' + order.id.repeat(2);
      let settles = 0;
      const service = createSettlementService(store, {
        settle: async () => { settles++; throw new Error('Should recover without re-settling'); },
        fetchPayment: async (_url, options) => {
          const rpc = JSON.parse(options.body);
          return { ok: true, json: async () => ({ result: rpc.method === 'eth_getLogs'
            ? [{ transactionHash: txHash }] : receipt }) };
        }
      });
      service.start(order.id);
      service.start(order.id);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settles, 0);
      assert.equal(store.get(order.id).state, 'paid');
      const status = await request(`/api/payment/orders/${order.id}`, null, headers);
      assert.equal(status.data.hasAccess, true);
      assert.match(status.headers.get('set-cookie'), /HttpOnly/);
      assert.equal(store.get(order.id).expiresAt - Date.now() <= plan.duration, true);
      paidOrder = store.get(order.id);
    }
    console.log('PASS: 三套餐真实SDK签名、402挑战、金额校验、重放拒绝、链上日志核验与恢复');
    assert.ok(submitted >= 3);
    const cancelled = store.create('daily', config.plans.daily.amount, config.plans.daily.duration);
    assert.equal(store.cancel(cancelled.id), 1);
    assert.equal(store.reserve(cancelled.id, account.address, 'cancelled-nonce', {}, '0x100'), 0);
    store.complete(cancelled.id, '0x' + '11'.repeat(32));
    assert.equal(store.get(cancelled.id).state, 'cancelled');
    const expired = store.create('daily', config.plans.daily.amount, config.plans.daily.duration);
    store.reserve(expired.id, account.address, 'expired-nonce',
      { payload: { authorization: { nonce: '0x' + '22'.repeat(32), validBefore: '1' } } }, '0x100');
    const expiryService = createSettlementService(store, {
      settle: async () => { throw new Error('Expired unused authorization must not settle'); },
      fetchPayment: async (_url, options) => {
        const { method } = JSON.parse(options.body);
        return { ok: true, json: async () => ({ result: method === 'eth_getLogs' ? [] :
          method === 'eth_getBlockByNumber' ? { timestamp: '0x1000' } : '0x0' }) };
      }
    });
    expiryService.start(expired.id);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.get(expired.id).state, 'failed');
    assert.equal(store.access(expired.token), undefined);
    console.log('PASS: 已取消订单不会被并发验签激活，链上确认过期未执行订单可结束');
    const token = paidOrder.token;
    assert.equal((await request('/api/private', null, { Authorization: `Bearer ${token}` })).status, 200);
    const sse = await fetch(base + '/api/stream/sse', { headers: { Authorization: `Bearer ${token}` } });
    const reader = sse.body.getReader();
    await reader.read();
    assert.equal((await request('/api/payment/admin/revoke', {
      secret: process.env.AUTO_TRADE_API_TOKEN, token: paidOrder.id
    })).data.success, true);
    const remaining = await reader.read();
    assert.match(new TextDecoder().decode(remaining.value), /access-revoked/);
    assert.equal((await reader.read()).done, true);
    assert.equal((await request('/api/private', null, { Authorization: `Bearer ${token}` })).status, 401);
    const admin = (await request('/api/payment/admin/grant', { secret: process.env.AUTO_TRADE_API_TOKEN })).data;
    assert.equal((await request('/api/payment/status', null, { Authorization: `Bearer ${admin.token}` })).data.hasAccess, true);
    store.close();
    store = createStore(filename);
    assert.ok(store.get(id).revokedAt);
    assert.ok(!store.loginWhitelist(spec.username, password));
    assert.ok(store.access(admin.token));
    assert.equal(store.access(token), undefined);
    assert.ok(store.get(paidOrder.id).revokedAt);
    store.db.prepare('UPDATE orders SET expiresAt=? WHERE token=?').run(Date.now() - 1, admin.token);
    assert.equal(store.access(admin.token), undefined);
    console.log('PASS: SQLite重开后授权/撤销保留、授权到期拒绝、SSE撤销立即关闭');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    if (oldSecret === undefined) delete process.env.AUTO_TRADE_API_TOKEN;
    else process.env.AUTO_TRADE_API_TOKEN = oldSecret;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
