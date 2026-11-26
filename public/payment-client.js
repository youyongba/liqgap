import { createWalletClient, custom } from 'viem';
import { baseSepolia } from 'viem/chains';
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { EthereumProvider } from '@walletconnect/ethereum-provider';

const PENDING_KEY = 'liq_gap_pending_order_v2';
let config;
let modal;
let walletPromise;
let busy = false;
let polling = false;
let unlocked = false;
let checkTimer;
let bootstrapPromise;
const nativeFetch = window.fetch.bind(window);

async function api(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await nativeFetch(url, { ...options, signal: controller.signal });
    const data = await response.json();
    if (!response.ok && response.status !== 402) throw new Error(data.error || `HTTP ${response.status}`);
    return { response, data };
  } finally { clearTimeout(timer); }
}
function pendingOrder() {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); } catch (_) { return null; }
}
function savePending(order) { localStorage.setItem(PENDING_KEY, JSON.stringify(order)); }
function message(text) {
  const el = document.getElementById('payment-status');
  if (el) el.textContent = text;
}
function lock() {
  if (unlocked) {
    // Reload clears chart data already in memory. Server auth remains the security boundary.
    location.reload();
    return;
  }
  document.body.classList.add('payment-locked');
  if (modal) modal.hidden = false;
}
function grant(data, orderId) {
  if (!data.hasAccess && !data.success) return;
  const expiry = document.getElementById('access-expiry');
  if (expiry) {
    const date = new Date(data.expiresAt);
    expiry.hidden = !Number.isFinite(data.expiresAt) || !Number.isFinite(date.getTime());
    const time = expiry.querySelector('time');
    if (!expiry.hidden && time.dateTime !== date.toISOString()) {
      time.dateTime = date.toISOString();
      time.textContent = date.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
    }
  }
  if (data.token) localStorage.setItem('liq_gap_x402_token', data.token);
  if (orderId && pendingOrder()?.id === orderId) localStorage.removeItem(PENDING_KEY);
  if (!unlocked) {
    unlocked = true;
    document.body.classList.remove('payment-locked');
    if (modal) modal.hidden = true;
    window.dispatchEvent(new Event('payment-access-granted'));
  }
}
async function checkAccess() {
  try {
    const token = localStorage.getItem('liq_gap_x402_token');
    const { data } = await api('/api/payment/status', {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    if (data.hasAccess) grant(data);
    else {
      localStorage.removeItem('liq_gap_x402_token');
      lock();
    }
    return !!data.hasAccess;
  } catch (_) {
    if (!unlocked) message('暂时无法检查权限，请检查网络后重试；不会自动再次扣费。');
    return false;
  }
}

async function walletConnect() {
  if (!walletPromise) {
    walletPromise = EthereumProvider.init({
      projectId: config.projectId,
      chains: [config.chainId],
      showQrModal: true,
      methods: ['eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4'],
      optionalMethods: ['wallet_switchEthereumChain'],
      events: ['chainChanged', 'accountsChanged'],
      rpcMap: { [config.chainId]: 'https://sepolia.base.org' },
      metadata: { name: 'Liquidity Gap', description: '行情分析工具访问授权',
        url: location.origin, icons: [] },
      qrModalOptions: { themeMode: 'dark', themeVariables: { '--wcm-z-index': '10001' } }
    }).catch(error => { walletPromise = null; throw error; });
  }
  const provider = await walletPromise;
  const hasValidSession = () => Number(provider.session?.expiry) * 1000 > Date.now();
  if (provider.session && !hasValidSession()) await provider.disconnect();
  // `connected` only describes the relay transport, not wallet authorization.
  if (!provider.session) await provider.connect();
  if (!hasValidSession()) {
    throw new Error('手机钱包尚未完成连接，请重新连接并在钱包中批准授权。');
  }
  const chainPrefix = `eip155:${config.chainId}:`;
  const accounts = Object.values(provider.session.namespaces || {})
    .flatMap(namespace => namespace.accounts || []);
  if (!accounts.some(account => account.startsWith(chainPrefix))) {
    throw new Error('手机钱包未授权 Base Sepolia 账户，请点击“重置钱包连接”后重新连接并批准该网络。');
  }
  return provider;
}
async function resetConnection() {
  if (busy) return;
  if (walletPromise) {
    try { const provider = await walletPromise; if (provider.session) await provider.disconnect(); } catch (_) { /* expired */ }
  }
  walletPromise = null;
  message('已断开旧会话。请重新连接手机钱包，已创建的订单和支付记录不会删除。');
}
function friendlyError(error) {
  const text = String(error.shortMessage || error.message || '');
  if ([4001, 'ACTION_REJECTED'].includes(error.code) || /reject|denied|cancel/i.test(text)) {
    return '已取消钱包操作，未创建新的支付授权。';
  }
  if (/reset|disconnect|expired|pairing|proposal|call connect\(\) before request\(\)/i.test(text)) {
    return '手机钱包连接已中断。请回到此页面，点击“重置钱包连接”后重新连接；已有订单请继续查询，不要重复支付。';
  }
  return text || '操作未完成，请检查钱包网络并重试。';
}

async function queryOrder() {
  const order = pendingOrder();
  if (!order || polling) return;
  polling = true;
  try {
    const { data } = await api(`/api/payment/orders/${order.id}`, { headers: { 'X-Order-Key': order.key } });
    if (data.hasAccess) grant(data, order.id);
    else if (data.state === 'failed') {
      localStorage.removeItem(PENDING_KEY);
      message(data.error || '链上确认该支付未执行，可以重新选择套餐。');
    }
    else if (data.state === 'revoked' || data.state === 'paid' || data.state === 'cancelled') {
      localStorage.removeItem(PENDING_KEY);
      message(data.state === 'revoked' ? '该订单权限已被撤销。' : data.state === 'cancelled' ? '订单已取消，可以重新选择套餐。' : '该订单权限已到期。');
    } else if (data.state === 'pending') {
      message(`订单 ${order.id}：${data.error || '支付授权已提交，正在核对链上到账；切回本页面可继续查询。'}`);
    } else {
      message('订单已保存，点击原套餐支付按钮可继续签名或提交。');
    }
  } catch (error) {
    message(`订单查询暂未完成：${friendlyError(error)} 请勿重复支付。`);
  } finally { polling = false; }
}

async function cancelUnsubmittedOrder() {
  if (busy) return;
  const order = pendingOrder();
  if (!order) { message('没有待处理订单。'); return; }
  try {
    await api(`/api/payment/orders/${order.id}`, { method: 'DELETE', headers: { 'X-Order-Key': order.key } });
    localStorage.removeItem(PENDING_KEY);
    message('未提交的订单已取消，可以重新选择套餐或重新签名。已提交结算的订单不能通过此操作取消。');
  } catch (error) { message(friendlyError(error)); }
}

async function pay(type, mobile) {
  if (busy) return;
  if (!document.getElementById('payment-consent').checked) {
    message('请先阅读并勾选免责声明。');
    return;
  }
  busy = true;
  modal.querySelectorAll('[data-mobile], input[name="payment-plan"]').forEach(el => { el.disabled = true; });
  try {
    if (!window.isSecureContext || !window.crypto?.subtle) {
      throw new Error('钱包支付需要 HTTPS 安全连接；手机请使用 HTTPS 域名访问，不能使用局域网 HTTP 地址。');
    }
    let order = pendingOrder();
    if (order && order.type !== type) throw new Error('有未完成订单，请先查询原订单，避免重复付款。');
    if (order) {
      const { data } = await api(`/api/payment/orders/${order.id}`, { headers: { 'X-Order-Key': order.key } });
      if (data.hasAccess) { grant(data, order.id); return; }
      if (data.state !== 'new') { await queryOrder(); return; }
      if (order.signature) { await submitSignedOrder(order); return; }
    }
    message('正在连接钱包，请在手机钱包中批准连接，并返回此页面完成支付签名。');
    const provider = mobile ? await walletConnect() : window.ethereum;
    if (!provider) throw new Error('未检测到浏览器钱包。手机可使用钱包内置浏览器，或选择手机钱包连接。');
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    if (!accounts.length) throw new Error('钱包尚未授权账户');
    const address = accounts[0];
    const chainId = Number(await provider.request({ method: 'eth_chainId' }));
    if (chainId !== config.chainId) {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x14a34' }] });
      if (Number(await provider.request({ method: 'eth_chainId' })) !== config.chainId) throw new Error('请切换到 Base Sepolia 测试网');
    }
    if (!order) {
      const { data } = await api('/api/payment/orders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, disclaimerVersion: config.disclaimerVersion })
      });
      order = { ...data, type };
      savePending(order);
    }
    const url = `/api/payment/orders/${order.id}/pay`;
    if (!order.signature) {
      const { response, data } = await api(url, { method: 'POST', headers: { 'X-Order-Key': order.key } });
      if (response.status !== 402) { if (data.hasAccess) grant(data, order.id); else await queryOrder(); return; }
      const required = decodePaymentRequiredHeader(response.headers.get('PAYMENT-REQUIRED'));
      const expected = config.plans[type];
      const accepted = required.accepts[0];
      if (required.accepts.length !== 1 || accepted.amount !== expected.amount ||
          accepted.network !== config.network || accepted.asset.toLowerCase() !== config.asset.toLowerCase() ||
          accepted.payTo.toLowerCase() !== config.payTo.toLowerCase()) throw new Error('支付要求与展示套餐不一致，已停止');
      const wallet = createWalletClient({ account: address, chain: baseSepolia, transport: custom(provider) });
      const client = new x402Client();
      client.setSpendControls({ maxAmountPerPayment: `$${expected.price}` });
      client.register(config.network, new ExactEvmScheme({
        address, signTypedData: args => wallet.signTypedData({ ...args, account: address })
      }));
      message(`请在钱包确认 ${expected.price} USDC 的 x402 支付授权签名（不是普通登录签名）。`);
      const payload = await client.createPaymentPayload(required);
      order.signature = encodePaymentSignatureHeader(payload);
      savePending(order); // Retry the same authorization after network loss, never sign another charge.
    }
    await submitSignedOrder(order);
  } catch (error) {
    message(friendlyError(error));
  } finally {
    busy = false;
    modal.querySelectorAll('[data-mobile], input[name="payment-plan"]').forEach(el => { el.disabled = false; });
  }
}

async function submitSignedOrder(order) {
  message('正在提交原订单的支付授权，请勿重复签名或转账。');
  const { data } = await api(`/api/payment/orders/${order.id}/pay`, { method: 'POST', headers: {
    'X-Order-Key': order.key, 'PAYMENT-SIGNATURE': order.signature
  } });
  if (data.hasAccess) grant(data, order.id);
  else await queryOrder();
}

function render() {
  document.body.classList.add('payment-locked');
  const plans = Object.entries(config.plans);
  const savedType = pendingOrder()?.type;
  const selected = Object.hasOwn(config.plans, savedType) ? savedType : plans[0][0];
  modal = document.createElement('section');
  modal.id = 'payment-dialog';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'payment-title');
  modal.innerHTML = `<div class="payment-card">
    <div class="payment-brand"><strong>x402</strong><span>Base Sepolia · 测试网</span></div>
    <h2 id="payment-title">解锁行情分析工具</h2>
    <p class="payment-intro">使用测试 USDC 支付，到账后开始计时，不自动续费。</p>
    <fieldset class="payment-picker"><legend>选择使用时长</legend>
      <div class="payment-plans">${plans.map(([type, plan]) => `
        <label class="payment-plan"><input type="radio" name="payment-plan" value="${type}" ${type === selected ? 'checked' : ''}>
          <span class="payment-tile"><span class="payment-duration">${plan.label}</span>
          <span class="payment-price"><b>${plan.price}</b> USDC</span></span>
        </label>`).join('')}</div>
    </fieldset>
    <label class="payment-consent"><input id="payment-consent" type="checkbox"><span>我已阅读并同意<a href="/disclaimer.html" target="_blank" rel="noopener">免责声明与支付说明</a>。链上支付一经确认无法撤回，可能无法退款。</span></label>
    <div class="payment-wallets"><button type="button" data-mobile="false">Web3 浏览器钱包</button>
      <button type="button" data-mobile="true">手机钱包 / 扫码</button></div>
    <div id="payment-status" role="status" aria-live="polite"></div>
    <details><summary>已支付？用钱包恢复访问</summary>
      <p>连接原付款账户，只签一次登录消息。不转账、不续期，原浏览器仍可使用。</p>
      <div class="payment-actions"><button type="button" data-recover="browser">用浏览器钱包恢复</button>
        <button type="button" data-recover="mobile">用手机钱包恢复</button></div>
    </details>
    <details><summary>订单与连接</summary><div class="payment-actions"><button id="payment-query">查询已有订单</button><button id="payment-reset">重置钱包连接</button><button id="payment-cancel">取消未提交订单</button></div></details>
    <details><summary>白名单登录</summary><form id="whitelist-login">
      <input name="username" aria-label="白名单账号" placeholder="白名单账号" autocomplete="username" maxlength="48" required>
      <input name="password" type="password" aria-label="白名单密码" placeholder="白名单密码" autocomplete="current-password" required>
      <button>登录并进入行情</button>
    </form></details>
    <div class="payment-foot"><span>请勿提供助记词或私钥</span><a href="/admin.html">管理员通道</a></div>
  </div>`;
  document.body.appendChild(modal);
  modal.querySelectorAll('[data-recover]').forEach(button => button.addEventListener('click',
    () => recoverAccess(button.dataset.recover === 'mobile')));
  modal.querySelectorAll('[data-mobile]').forEach(button => button.addEventListener('click', () => {
    const choice = modal.querySelector('input[name="payment-plan"]:checked');
    if (choice) pay(choice.value, button.dataset.mobile === 'true');
  }));
  document.getElementById('payment-query').onclick = () => {
    if (pendingOrder()) queryOrder(); else checkAccess();
  };
  document.getElementById('payment-reset').onclick = resetConnection;
  document.getElementById('payment-cancel').onclick = cancelUnsubmittedOrder;
  document.getElementById('whitelist-login').onsubmit = async event => {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const button = form.querySelector('button');
    busy = button.disabled = true;
    try {
      const { data } = await api('/api/payment/whitelist/login', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      localStorage.removeItem('liq_gap_x402_token');
      form.reset();
      grant(data);
    } catch (error) { message(friendlyError(error)); }
    finally { busy = button.disabled = false; }
  };
}

async function recoverAccess(mobile) {
  if (busy) return;
  busy = true;
  const controls = modal.querySelectorAll('[data-recover], [data-mobile]');
  controls.forEach(el => { el.disabled = true; });
  try {
    if (!window.isSecureContext) throw new Error('请通过 HTTPS 打开本站后恢复访问。');
    message('请连接原付款账户，再确认登录消息。');
    const provider = mobile ? await walletConnect() : window.ethereum;
    if (!provider) throw new Error('未检测到浏览器钱包，请使用手机钱包恢复。');
    const [address] = await provider.request({ method: 'eth_requestAccounts' });
    if (!address) throw new Error('钱包尚未授权账户。');
    const post = (path, body) => api(`/api/payment/recovery/${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const { data } = await post('challenge', { address });
    const wallet = createWalletClient({ account: address, transport: custom(provider) });
    const signature = await wallet.signMessage({ message: data.message });
    const result = await post('verify', { signature });
    localStorage.removeItem('liq_gap_x402_token');
    grant(result.data);
  } catch (error) { message(friendlyError(error)); }
  finally { busy = false; controls.forEach(el => { el.disabled = false; }); }
}

export function initPaymentUI() {
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    try {
      ({ data: config } = await api('/api/payment/config'));
      render();
      await checkAccess();
      if (!unlocked && pendingOrder()) queryOrder();
      checkTimer = setInterval(() => {
        if (document.hidden) return;
        if (!unlocked && pendingOrder()) queryOrder();
        else if (unlocked) checkAccess();
      }, 10000);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) { checkAccess(); if (pendingOrder()) queryOrder(); }
      });
      window.addEventListener('payment-access-revoked', lock);
      // Do not modify cross-origin wallet or CDN requests.
      window.fetch = async (...args) => {
        const response = await nativeFetch(...args);
        const url = new URL(args[0] instanceof Request ? args[0].url : args[0], location.href);
        if (response.status === 401 && url.origin === location.origin && url.pathname.startsWith('/api/')) lock();
        return response;
      };
      window.addEventListener('pagehide', () => clearInterval(checkTimer), { once: true });
    } catch (_) {
      const error = document.createElement('p');
      error.textContent = '支付服务暂不可用，请检查网络后刷新页面。未授权时不会加载行情。';
      document.body.prepend(error);
    }
  })();
  return bootstrapPromise;
}
