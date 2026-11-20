'use strict';

const express = require('express');
const crypto = require('crypto');
const { HTTPFacilitatorClient } = require('@x402/core/server');
const { encodePaymentRequiredHeader, decodePaymentSignatureHeader } = require('@x402/core/http');
const { ProxyAgent, fetch: httpFetch } = require('undici');
const { createStore } = require('../services/payment/store');
const config = require('../services/payment/config');
const { createSettlementService } = require('../services/payment/settlement');

const proxy = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
// A SOCKS URL is not an HTTP proxy. Never silently rewrite proxy protocols.
const dispatcher = proxy && /^https?:\/\//.test(proxy) ? new ProxyAgent(proxy) : undefined;
const fetchPayment = (url, options) => httpFetch(url, { ...options, ...(dispatcher ? { dispatcher } : {}) });
const facilitator = new HTTPFacilitatorClient({
  url: process.env.X402_FACILITATOR_URL || 'https://x402.org/facilitator',
  timeoutMs: 20000
});
const facilitatorUrl = process.env.X402_FACILITATOR_URL || 'https://x402.org/facilitator';
async function control(operation, paymentPayload, paymentRequirements) {
  if (!dispatcher) return facilitator[operation](paymentPayload, paymentRequirements);
  // SDK transport has no per-client dispatcher. Keep proxy routing scoped to payment calls.
  const response = await fetchPayment(`${facilitatorUrl.replace(/\/$/, '')}/${operation}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
    signal: AbortSignal.timeout(facilitator.timeoutMs)
  });
  if (!response.ok) throw new Error(`Facilitator HTTP ${response.status}`);
  return response.json();
}

function createPaymentRouter({ store = createStore(), verify = (p, r) => control('verify', p, r),
  settlement } = {}) {
  const router = express.Router();
  const service = settlement || createSettlementService(store, {
    settle: (p, r) => control('settle', p, r), fetchPayment
  });
  const streams = new Map();
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  function bearer(req) {
    const authorization = req.get('authorization') || '';
    const cookie = (req.headers.cookie || '').match(/(?:^|;\s*)liq_gap_token=([^;]+)/);
    return authorization.startsWith('Bearer ') ? authorization.slice(7) : cookie && cookie[1];
  }
  function setAccess(req, res, order) {
    res.cookie('liq_gap_token', order.token, { httpOnly: true, sameSite: 'lax',
      secure: req.secure, path: '/', maxAge: Math.max(0, order.expiresAt - Date.now()) });
  }
  function requireAdmin(req, res, next) {
    const expected = process.env.AUTO_TRADE_API_TOKEN;
    const supplied = req.body && req.body.secret;
    if (!expected) return res.status(503).json({ error: '管理员凭证未配置' });
    if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
        !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
      return res.status(403).json({ error: '管理员密码错误' });
    }
    next();
  }
  function closeStream(res) {
    if (!res.writableEnded) res.end('event: access-revoked\ndata: {}\n\n');
  }
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/config', (_req, res) => res.json({ plans: config.plans, network: config.network,
    chainId: 84532, chainName: 'Base Sepolia', asset: config.asset, payTo: config.payTo,
    projectId: config.projectId, testnet: true, disclaimerVersion: '2026-11-18' }));
  router.post('/admin/grant', requireAdmin, (req, res) => {
    const order = store.create('admin', '0', 365 * 86400000, true);
    setAccess(req, res, order);
    res.json({ success: true, token: order.token, expiresAt: order.expiresAt });
  });
  router.post('/admin/tokens', requireAdmin, (_req, res) => {
    res.json({ success: true, tokens: Object.fromEntries(store.list().map(row => [row.id, row])) });
  });
  router.post('/admin/revoke', requireAdmin, (req, res) => {
    const order = store.get(String(req.body.token || ''));
    if (!order || !store.revoke(order.id)) return res.status(404).json({ error: '授权不存在' });
    for (const response of streams.get(order.token) || []) closeStream(response);
    res.json({ success: true });
  });
  router.get('/status', (req, res) => {
    // Accept the old local token once, then issue an HttpOnly cookie.
    const order = store.access(bearer(req) || req.query.token);
    if (order) setAccess(req, res, order);
    else res.clearCookie('liq_gap_token', { path: '/' });
    res.json({ hasAccess: !!order, type: order && order.type, expiresAt: order && order.expiresAt });
  });
  router.post('/orders', (req, res) => {
    const type = req.body && req.body.type;
    const plan = Object.hasOwn(config.plans, type) && config.plans[type];
    if (!plan || req.body.disclaimerVersion !== '2026-11-18') {
      return res.status(400).json({ error: '请选择有效套餐并阅读免责声明' });
    }
    const order = store.create(req.body.type, plan.amount, plan.duration);
    res.json({ id: order.id, key: order.key });
  });
  function requireOrder(req, res, next) {
    const order = store.authorize(req.params.id, req.get('X-Order-Key'));
    if (!order) return res.status(404).json({ error: '订单不存在或凭证无效' });
    req.order = order;
    next();
  }
  function replyOrder(req, res) {
    const order = store.get(req.order.id);
    const hasAccess = !!store.access(order.token);
    if (hasAccess) setAccess(req, res, order);
    res.json({ success: hasAccess, state: order.revokedAt ? 'revoked' : order.state,
      hasAccess, expiresAt: order.expiresAt, txHash: order.txHash,
      token: hasAccess ? order.token : undefined, error: order.error });
  }
  router.get('/orders/:id', requireOrder, (req, res) => {
    if (req.order.state === 'pending') service.start(req.order.id);
    replyOrder(req, res);
  });
  router.delete('/orders/:id', requireOrder, (req, res) => {
    if (!store.cancel(req.order.id)) return res.status(409).json({ error: '订单已提交结算，不能取消，请继续查询' });
    res.json({ success: true });
  });
  router.post('/orders/:id/pay', requireOrder, wrap(async (req, res) => {
    let order = req.order;
    if (order.state !== 'new') {
      if (order.state === 'pending') service.start(order.id);
      return replyOrder(req, res);
    }
    const required = config.requirements(order);
    const header = req.get('PAYMENT-SIGNATURE');
    if (!header) {
      const paymentRequired = { x402Version: 2,
        resource: { url: req.originalUrl, description: '行情分析工具访问权限', mimeType: 'application/json' },
        accepts: [required] };
      return res.status(402).set('PAYMENT-REQUIRED', encodePaymentRequiredHeader(paymentRequired)).json(paymentRequired);
    }
    let payload;
    try {
      payload = decodePaymentSignatureHeader(header);
      const accepted = payload.accepted;
      if (payload.x402Version !== 2 || !accepted ||
          ['scheme', 'network', 'asset', 'amount', 'payTo'].some(k =>
            String(accepted[k]).toLowerCase() !== String(required[k]).toLowerCase())) throw new Error();
      const auth = payload.payload.authorization;
      if (!auth || !/^0x[a-f0-9]{40}$/i.test(auth.from) || !/^0x[a-f0-9]{64}$/i.test(auth.nonce) ||
          String(auth.to).toLowerCase() !== required.payTo.toLowerCase() ||
          String(auth.value) !== required.amount) throw new Error();
    } catch (_) {
      return res.status(400).json({ error: '支付签名或套餐不匹配' });
    }
    const verification = await verify(payload, required);
    if (!verification.isValid) return res.status(400).json({ error: '支付签名验证未通过，请检查余额、网络和钱包支持' });
    const auth = payload.payload.authorization;
    const block = await service.blockNumber();
    const paymentKey = `${config.network}:${auth.from.toLowerCase()}:${auth.nonce.toLowerCase()}`;
    try {
      if (!store.reserve(order.id, auth.from.toLowerCase(), paymentKey, payload, block)) {
        return res.status(409).json({ error: '订单状态已变化，请查询订单' });
      }
    } catch (err) {
      if (err.code && err.code.startsWith('SQLITE_CONSTRAINT')) {
        return res.status(409).json({ error: '这份支付授权已用于另一订单，请恢复原订单' });
      }
      throw err;
    }
    service.start(order.id);
    res.status(202);
    replyOrder(req, res);
  }));
  // Retire unsafe legacy endpoints: a client-supplied transaction hash is not proof of ownership.
  router.post('/buy/:type', (_req, res) => res.status(410).json({ error: '支付流程已升级，请刷新页面' }));
  router.checkAuth = (req, res, next) => {
    const order = store.access(bearer(req));
    if (!order) return res.status(401).json({ success: false, error: 'Payment required' });
    if (req.path === '/stream/sse') {
      const set = streams.get(order.token) || new Set();
      set.add(res);
      streams.set(order.token, set);
      const timer = setInterval(() => { if (!store.access(order.token)) closeStream(res); }, 1000);
      timer.unref();
      res.once('close', () => { clearInterval(timer); set.delete(res); if (!set.size) streams.delete(order.token); });
    }
    next();
  };
  router.use((err, _req, res, _next) => {
    console.error('[payment]', err.message);
    if (!res.headersSent) res.status(503).json({ error: '支付服务暂时不可用，订单已保留，请稍后重试，勿重复付款' });
  });
  return router;
}

// Lazy creation keeps tests isolated and avoids opening a database during tooling imports.
let liveRouter;
function getRouter() { return liveRouter || (liveRouter = createPaymentRouter()); }
module.exports = (req, res, next) => getRouter()(req, res, next);
module.exports.checkAuth = (req, res, next) => getRouter().checkAuth(req, res, next);
module.exports.createPaymentRouter = createPaymentRouter;
