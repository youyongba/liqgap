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
function grant(data) {
  if (!data.hasAccess && !data.success) return;
  if (data.token) localStorage.setItem('liq_gap_x402_token', data.token);
  localStorage.removeItem(PENDING_KEY);
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
    if (data.hasAccess) grant(data);
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
  modal.querySelectorAll('button[data-plan]').forEach(el => { el.disabled = true; });
  try {
    if (!window.isSecureContext || !window.crypto?.subtle) {
      throw new Error('钱包支付需要 HTTPS 安全连接；手机请使用 HTTPS 域名访问，不能使用局域网 HTTP 地址。');
    }
    let order = pendingOrder();
    if (order && order.type !== type) throw new Error('有未完成订单，请先查询原订单，避免重复付款。');
    if (order) {
      const { data } = await api(`/api/payment/orders/${order.id}`, { headers: { 'X-Order-Key': order.key } });
      if (data.hasAccess) { grant(data); return; }
      if (data.state !== 'new') { await queryOrder(); return; }
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
      if (response.status !== 402) { if (data.hasAccess) grant(data); else await queryOrder(); return; }
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
    message('正在提交支付授权，请勿重复点击或再次转账。');
    const { data } = await api(url, { method: 'POST', headers: {
      'X-Order-Key': order.key, 'PAYMENT-SIGNATURE': order.signature
    } });
    if (data.hasAccess) grant(data);
    else await queryOrder();
  } catch (error) {
    message(friendlyError(error));
  } finally {
    busy = false;
    modal.querySelectorAll('button[data-plan]').forEach(el => { el.disabled = false; });
  }
}

function render() {
  document.body.classList.add('payment-locked');
  const style = document.createElement('style');
  style.textContent = `
    body.payment-locked { overflow:hidden; width:100%; }
    body.payment-locked > main, body.payment-locked > header { display:none; }
    #payment-dialog[hidden] { display:none; }
    #payment-dialog { position:fixed; inset:0; z-index:9998; background:rgba(11,14,17,.96); overflow:auto; display:flex; flex-direction:column; padding:16px; box-sizing:border-box; }
    .payment-card { flex:none; margin:auto; width:min(100%,560px); background:#181a20; color:#e0e3eb; border:1px solid #2b3139; border-radius:16px; padding:24px; box-sizing:border-box; font:14px/1.6 system-ui; }
    .payment-card h2 { margin:0 0 8px; } .payment-card p { color:#aeb6c3; }
    .payment-plans { display:grid; gap:12px; } .payment-plan { display:grid; grid-template-columns:1fr 1fr; gap:8px; padding:12px; border:1px solid #343b46; border-radius:10px; }
    .payment-plan strong { grid-column:1/-1; } .payment-card button { padding:10px; border:0; border-radius:24px; background:#00796b; color:white; cursor:pointer; font:inherit; }
    .payment-card button:disabled { opacity:.5; cursor:wait; } .payment-card .secondary { background:#303947; }
    .payment-card a { color:#aeb6c3; } #payment-status { min-height:44px; color:#e9c56c; overflow-wrap:anywhere; }
    .payment-consent { display:flex; align-items:flex-start; gap:8px; margin:16px 0; } .payment-consent input { flex:none; margin-top:6px; }
    .payment-actions { display:flex; flex-wrap:wrap; gap:8px; }
    @media(max-width:400px) { .payment-card { padding:16px; } .payment-plan { grid-template-columns:1fr; } }
  `;
  document.head.appendChild(style);
  modal = document.createElement('section');
  modal.id = 'payment-dialog';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'payment-title');
  modal.innerHTML = `<div class="payment-card">
    <h2 id="payment-title">解锁行情分析工具</h2>
    <p>当前为 Base Sepolia 测试网，仅使用测试 USDC。x402 支付采用钱包授权签名，核实到账后开始计时。</p>
    <div class="payment-plans">${Object.entries(config.plans).map(([type, plan]) => `
      <div class="payment-plan"><strong>${plan.label} · ${plan.price} USDC</strong>
      <button data-plan="${type}" data-mobile="false">浏览器钱包支付</button>
      <button data-plan="${type}" data-mobile="true">手机钱包 / 扫码</button></div>`).join('')}</div>
    <label class="payment-consent"><input id="payment-consent" type="checkbox"><span>我已阅读并同意<a href="/disclaimer.html" target="_blank" rel="noopener">免责声明与支付说明</a>。行情可能延迟或中断，分析不构成投资建议，不承诺收益。</span></label>
    <div id="payment-status" role="status" aria-live="polite"></div>
    <div class="payment-actions"><button id="payment-query" class="secondary">查询已有订单</button><button id="payment-reset" class="secondary">重置钱包连接</button><button id="payment-cancel" class="secondary">取消未提交订单</button></div>
    <p>手机上可直接跳转钱包，也可在钱包内置浏览器打开本站；电脑端可扫码。请勿向客服提供助记词或私钥。</p>
    <a href="/admin.html">管理员通道</a>
  </div>`;
  document.body.appendChild(modal);
  modal.querySelectorAll('[data-plan]').forEach(button => button.addEventListener('click', () => pay(button.dataset.plan, button.dataset.mobile === 'true')));
  document.getElementById('payment-query').onclick = () => {
    if (pendingOrder()) queryOrder(); else checkAccess();
  };
  document.getElementById('payment-reset').onclick = resetConnection;
  document.getElementById('payment-cancel').onclick = cancelUnsubmittedOrder;
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
