'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(process.cwd(), 'public/payment-client.js'), 'utf8');
const connectionSource = source.slice(source.indexOf('async function walletConnect()'), source.indexOf('async function queryOrder()'));
const paymentSource = source.slice(source.indexOf('async function pay('), source.indexOf('function render()'));
const address = '0x1111111111111111111111111111111111111111';
const session = (chain = 84532) => ({
  expiry: Math.floor(Date.now() / 1000) + 3600,
  namespaces: { eip155: { accounts: [`eip155:${chain}:${address}`] } }
});

function harness(overrides = {}) {
  const calls = [];
  const provider = {
    connected: true,
    session: undefined,
    async connect() { calls.push('connect'); this.session = session(); },
    async disconnect() { calls.push('disconnect'); this.session = undefined; },
    async request({ method }) {
      assert.ok(this.session, 'No wallet request may run without a session');
      calls.push(method);
      if (method === 'eth_requestAccounts') return [address];
      if (method === 'eth_chainId') return '0x14a34';
      throw new Error(`Unexpected request: ${method}`);
    },
    ...overrides
  };
  const messages = [];
  const sandbox = {
    config: { chainId: 84532, projectId: 'test', disclaimerVersion: 'test' },
    walletPromise: undefined,
    busy: false,
    modal: { querySelectorAll: () => [] },
    EthereumProvider: { async init() { calls.push('init'); return provider; } },
    location: { origin: 'https://example.test' },
    window: { isSecureContext: true, crypto: { subtle: {} }, ethereum: provider },
    document: { getElementById: () => ({ checked: true }) },
    pendingOrder: () => null,
    message: text => messages.push(text),
    // Stop before any actual order, signature, or payment is created.
    api: async () => { calls.push('order'); throw new Error('test-stop-before-payment'); }
  };
  vm.createContext(sandbox);
  vm.runInContext(`${connectionSource}\n${paymentSource}`, sandbox);
  return { sandbox, provider, calls, messages };
}

test('relay connected without a session still awaits wallet approval before requests', async () => {
  const { sandbox, provider, calls } = harness();
  let approve;
  provider.connect = () => {
    calls.push('connect');
    return new Promise(resolve => {
      approve = () => { provider.session = session(); resolve(); };
    });
  };
  const payment = sandbox.pay('daily', true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['init', 'connect']);
  approve();
  await payment;
  assert.deepEqual(calls, ['init', 'connect', 'eth_requestAccounts', 'eth_chainId', 'order']);
});

test('valid restored session is reused regardless of relay connected flag', async () => {
  const { sandbox, calls } = harness({ connected: false, session: session() });
  await sandbox.walletConnect();
  await sandbox.walletConnect();
  assert.deepEqual(calls, ['init']);
});

test('expired session is disconnected and replaced before account requests', async () => {
  const expired = { ...session(), expiry: Math.floor(Date.now() / 1000) - 1 };
  const { sandbox, calls } = harness({ session: expired });
  await sandbox.pay('daily', true);
  assert.deepEqual(calls, ['init', 'disconnect', 'connect', 'eth_requestAccounts', 'eth_chainId', 'order']);
});

test('rejected connection makes no request or order and can be retried', async () => {
  const { sandbox, provider, calls, messages } = harness({
    async connect() { throw Object.assign(new Error('User rejected'), { code: 4001 }); }
  });
  await sandbox.pay('daily', true);
  assert.deepEqual(calls, ['init']);
  assert.match(messages.at(-1), /已取消/);
  assert.equal(sandbox.busy, false);
  provider.connect = async () => { provider.session = session(); };
  await sandbox.pay('daily', true);
  assert.deepEqual(calls, ['init', 'eth_requestAccounts', 'eth_chainId', 'order']);
});

for (const [name, nextSession] of [
  ['missing', undefined],
  ['expired', { ...session(), expiry: 1 }],
  ['invalid expiry', { ...session(), expiry: undefined }],
  ['wrong network', session(1)],
  ['missing accounts', { ...session(), namespaces: {} }]
]) {
  test(`${name} session after connect stops before account requests and order creation`, async () => {
    const { sandbox, calls, messages } = harness({
      async connect() { this.session = nextSession; }
    });
    await sandbox.pay('daily', true);
    assert.deepEqual(calls, ['init']);
    assert.match(messages.at(-1), /手机钱包/);
    assert.equal(sandbox.busy, false);
  });
}

test('disconnect race error has a Chinese recovery message', () => {
  const { sandbox } = harness();
  assert.match(sandbox.friendlyError(new Error('Please call connect() before request()')), /重置钱包连接/);
});

test('browser wallet keeps the injected-provider account authorization flow', async () => {
  const { sandbox, calls } = harness({ session: session() });
  await sandbox.pay('daily', false);
  assert.deepEqual(calls, ['eth_requestAccounts', 'eth_chainId', 'order']);
});

test('saved signature retries only the original order without reconnecting a wallet', async () => {
  const { sandbox, calls } = harness();
  sandbox.pendingOrder = () => ({ id: 'saved', key: 'private', type: 'daily', signature: 'same-signature' });
  sandbox.api = async (url, options) => {
    calls.push(url);
    assert.equal(options.headers['X-Order-Key'], 'private');
    if (options.method === 'POST') assert.equal(options.headers['PAYMENT-SIGNATURE'], 'same-signature');
    return { data: { state: options.method ? 'pending' : 'new' } };
  };
  sandbox.queryOrder = async () => calls.push('query');
  await sandbox.pay('daily', true);
  assert.deepEqual(calls, ['/api/payment/orders/saved', '/api/payment/orders/saved/pay', 'query']);
});
