import { createWalletClient, custom } from 'viem';
import { baseSepolia } from 'viem/chains';
import { wrapFetchWithPayment } from '@x402/fetch';
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { EthereumProvider } from '@walletconnect/ethereum-provider';

export async function initPaymentUI() {
  const token = localStorage.getItem('liq_gap_x402_token');
  if (token) {
    try {
      const res = await fetch(`/api/payment/status?token=${token}`);
      const data = await res.json();
      if (data.hasAccess) {
        document.cookie = `liq_gap_token=${token}; path=/; max-age=31536000`; // Set cookie for API requests
        unlockDashboard();
        return;
      } else {
        localStorage.removeItem('liq_gap_x402_token');
        document.cookie = 'liq_gap_token=; path=/; max-age=0';
      }
    } catch (e) {
      console.error(e);
    }
  }
  
  showPaymentModal();
}

function unlockDashboard() {
  const modal = document.getElementById('x402-payment-modal');
  if (modal) {
    modal.style.display = 'none';
  }
  const overlay = document.getElementById('x402-payment-overlay');
  if (overlay) {
    overlay.style.display = 'none';
  }
}

function showPaymentModal() {
  let modal = document.getElementById('x402-payment-modal');
  if (!modal) {
    // Create the overlay and modal dynamically
    const overlay = document.createElement('div');
    overlay.id = 'x402-payment-overlay';
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.backgroundColor = 'rgba(0,0,0,0.8)';
    overlay.style.backdropFilter = 'blur(5px)';
    overlay.style.zIndex = '9998';
    
    modal = document.createElement('div');
    modal.id = 'x402-payment-modal';
    modal.style.position = 'fixed';
    modal.style.top = '50%';
    modal.style.left = '50%';
    modal.style.transform = 'translate(-50%, -50%)';
    modal.style.backgroundColor = '#1e1e1e';
    modal.style.padding = '30px';
    modal.style.borderRadius = '12px';
    modal.style.zIndex = '9999';
    modal.style.color = '#fff';
    modal.style.textAlign = 'center';
    modal.style.minWidth = '400px';
    
    modal.innerHTML = `
      <h2 style="margin-top:0;">支付解锁高级功能</h2>
      <p style="color:#aaa; margin-bottom:24px;">支持 Web3 浏览器钱包 (插件) 或 WalletConnect (手机扫码)</p>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:15px;">
        <button id="btn-mm-24h" style="padding:12px; background:#00796b; color:#fff; border:none; border-radius:8px; cursor:pointer;">🌐 插件支付 0.0001 USDC / 24h</button>
        <button id="btn-mm-1m" style="padding:12px; background:#00796b; color:#fff; border:none; border-radius:8px; cursor:pointer;">🌐 插件支付 0.0030 USDC / 包月</button>
        <button id="btn-wc-24h" style="padding:12px; background:#00796b; color:#fff; border:none; border-radius:8px; cursor:pointer;">📱 扫码支付 0.0001 USDC / 24h</button>
        <button id="btn-wc-1m" style="padding:12px; background:#34495e; color:#fff; border:none; border-radius:8px; cursor:pointer;">📱 扫码支付 0.0030 USDC / 包月</button>
      </div>
      <div style="margin-top: 24px; font-size: 12px;">
        <a href="/admin.html" style="color: #848E9C; text-decoration: none; border-bottom: 1px dashed #848E9C; padding-bottom: 2px;">🔑 管理员后台通道</a>
      </div>
    `;
    
    document.body.appendChild(overlay);
    document.body.appendChild(modal);
    
    document.getElementById('btn-mm-24h').addEventListener('click', () => handlePayment('daily', false, document.getElementById('btn-mm-24h')));
    document.getElementById('btn-mm-1m').addEventListener('click', () => handlePayment('monthly', false, document.getElementById('btn-mm-1m')));
    document.getElementById('btn-wc-24h').addEventListener('click', () => handlePayment('daily', true, document.getElementById('btn-wc-24h')));
    document.getElementById('btn-wc-1m').addEventListener('click', () => handlePayment('monthly', true, document.getElementById('btn-wc-1m')));
  }
}

async function handlePayment(type, useWalletConnect, btnElement) {
  let provider;
  const projectId = '9cea3b242316cfb3d6ab12e8604fea22'; 

  const originalText = btnElement.innerText;
  btnElement.innerText = '正在唤起...';
  btnElement.disabled = true;

  try {
    if (useWalletConnect) {
      provider = await EthereumProvider.init({
        projectId: projectId,
        showQrModal: true,
        chains: [84532], // Base Sepolia
        qrModalOptions: { themeMode: "dark" }
      });
      await provider.connect();
    } else {
      if (!window.ethereum) {
        alert('未检测到 Web3 浏览器钱包插件，请安装或使用扫码支付。');
        btnElement.innerText = originalText;
        btnElement.disabled = false;
        return;
      }
      provider = window.ethereum;
      // We must await the requestAccounts here before proceeding
      await provider.request({ method: 'eth_requestAccounts' });
      // Force page to recognize the account change if it's the first time
      const accounts = await provider.request({ method: 'eth_accounts' });
      if (!accounts || accounts.length === 0) {
        throw new Error('User rejected account access');
      }
      const chainId = await provider.request({ method: 'eth_chainId' });
      if (chainId !== '0x14a34' && chainId !== '84532') {
        try {
          await provider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: '0x14a34' }],
          });
        } catch (e) {
          alert("请先在钱包中切换到 Base Sepolia 测试网！");
          btnElement.innerText = originalText;
          btnElement.disabled = false;
          return;
        }
      }
    }

    const accounts = useWalletConnect ? provider.accounts : await provider.request({ method: 'eth_accounts' });
    const address = accounts[0];

    const walletClient = createWalletClient({
      account: address,
      chain: baseSepolia,
      transport: custom(provider)
    });

    const signer = {
      address: address,
      signTypedData: async (args) => {
        // Intercept and send directly through provider instead of relying on viem wrapper
        // which sometimes bugs out with custom injected providers
        try {
           return await walletClient.signTypedData({
            account: address,
            domain: args.domain,
            types: args.types,
            primaryType: args.primaryType,
            message: args.message
          });
        } catch (err) {
          throw err;
        }
      }
    };

    // 绕过 x402 复杂的自动拦截，直接主动调用 provider 发起交易以确保 100% 唤起
    const txParams = {
      to: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // USDC Contract on Base Sepolia
      from: address,
      // a9059cbb = transfer(address,uint256)
      // Recipient: 0x5c8E2fd639AaBa1DdB76504fC33A608528c6f975
      // Amount: type === 'daily' ? 100 (0.0001) : 3000 (0.0030)
      data: '0xa9059cbb' + 
            '0000000000000000000000005c8E2fd639AaBa1DdB76504fC33A608528c6f975' + 
            (type === 'daily' 
              ? '0000000000000000000000000000000000000000000000000000000000000064'  // 100 in hex
              : '0000000000000000000000000000000000000000000000000000000000000bb8'  // 3000 in hex
            )
    };

    let txHash;
    if (useWalletConnect) {
       txHash = await provider.request({ method: 'eth_sendTransaction', params: [txParams] });
    } else {
       txHash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [txParams] });
    }

    // 交易发送成功后，通知后端发 token
    const res = await fetch(`/api/payment/buy/${type}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHash })
    });

    if (res.ok) {
      const data = await res.json();
      if (data.success && data.token) {
        localStorage.setItem('liq_gap_x402_token', data.token);
        document.cookie = `liq_gap_token=${data.token}; path=/; max-age=31536000`; // Set cookie
        unlockDashboard();
        
        // Optionally refresh the page or restart the app stream if needed, 
        // but the app.js will automatically retry failing requests.
        // Easiest is to reload the page to ensure all charts start fresh with valid token
        window.location.reload();
      }
    } else {
      alert(`支付校验失败 (HTTP ${res.status})`);
    }
  } catch (err) {
    console.error(err);
    if (err.message && (err.message.includes('User rejected') || err.message.includes('user rejected') || err.code === 4001 || err.code === 'ACTION_REJECTED')) {
      alert("支付已取消 (用户拒绝了交易)。");
    } else {
      alert(`支付异常: ${err.message}`);
    }
  } finally {
    btnElement.innerText = originalText;
    btnElement.disabled = false;
  }
}
