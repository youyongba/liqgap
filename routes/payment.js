const express = require('express');
const crypto = require('crypto');
const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
const { ExactEvmScheme } = require('@x402/evm/exact/server');
const { HTTPFacilitatorClient } = require('@x402/core/server');
const { ProxyAgent, setGlobalDispatcher } = require('undici');

const proxyUrl = process.env.https_proxy || process.env.http_proxy || process.env.all_proxy;
if (proxyUrl) {
  let cleanUrl = proxyUrl;
  if (cleanUrl.startsWith('socks5://')) {
    cleanUrl = cleanUrl.replace('socks5://', 'http://');
  }
  setGlobalDispatcher(new ProxyAgent(cleanUrl));
}

const router = express.Router();
const RECIPIENT_ADDRESS = "0x5c8E2fd639AaBa1DdB76504fC33A608528c6f975"; 
const ADMIN_SECRET = process.env.ADMIN_SECRET || "admin123";

const facilitatorClient = new HTTPFacilitatorClient({
  url: "https://x402.org/facilitator"
});

const tokens = {}; // { token: { expiresAt, type, createdAt } }

// --- Admin Routes ---
router.post('/admin/grant', (req, res) => {
  if (req.body.secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Invalid secret' });
  const token = crypto.randomBytes(16).toString('hex');
  tokens[token] = { expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000, type: 'admin', createdAt: Date.now() };
  res.json({ success: true, token });
});

router.post('/admin/tokens', (req, res) => {
  if (req.body.secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Invalid secret' });
  // Cleanup expired
  const now = Date.now();
  for (const t in tokens) {
    if (tokens[t].expiresAt < now) delete tokens[t];
  }
  res.json({ success: true, tokens });
});

router.post('/admin/revoke', (req, res) => {
  if (req.body.secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Invalid secret' });
  const { token } = req.body;
  if (tokens[token]) {
    delete tokens[token];
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Token not found' });
  }
});

// --- x402 Payment Routes ---
router.post('/buy/daily', async (req, res) => {
  const { txHash } = req.body;
  if (!txHash) return res.status(400).json({ error: 'Missing txHash' });

  try {
    // 1. 查询 Base Sepolia 链上的交易记录
    const fetch = require('node-fetch'); // fallback if needed, but undici is active
    const rpcRes = await fetch('https://sepolia.base.org', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_getTransactionByHash',
        params: [txHash],
        id: 1
      })
    });
    
    const txData = await rpcRes.json();
    const tx = txData.result;
    
    if (!tx) {
      return res.status(400).json({ error: 'Transaction not found on chain' });
    }

    // 2. 检查交易数据是否包含向指定收款地址的转账特征 (a9059cbb + recipient)
    const input = tx.input.toLowerCase();
    const recipientClean = RECIPIENT_ADDRESS.toLowerCase().replace('0x', '');
    
    if (!input.includes(recipientClean)) {
      return res.status(400).json({ error: 'Invalid recipient address in transaction' });
    }
    
    // 如果验证通过，签发 24 小时权限 Token
    const token = crypto.randomBytes(16).toString('hex');
    tokens[token] = { expiresAt: Date.now() + 24 * 60 * 60 * 1000, type: 'daily', createdAt: Date.now() };
    res.json({ success: true, token });
    
  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

router.post('/buy/monthly', async (req, res) => {
  const { txHash } = req.body;
  if (!txHash) return res.status(400).json({ error: 'Missing txHash' });

  try {
    const fetch = require('node-fetch');
    const rpcRes = await fetch('https://sepolia.base.org', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_getTransactionByHash',
        params: [txHash],
        id: 1
      })
    });
    
    const txData = await rpcRes.json();
    const tx = txData.result;
    
    if (!tx) return res.status(400).json({ error: 'Transaction not found on chain' });

    const input = tx.input.toLowerCase();
    const recipientClean = RECIPIENT_ADDRESS.toLowerCase().replace('0x', '');
    
    if (!input.includes(recipientClean)) {
      return res.status(400).json({ error: 'Invalid recipient address in transaction' });
    }
    
    const token = crypto.randomBytes(16).toString('hex');
    tokens[token] = { expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, type: 'monthly', createdAt: Date.now() };
    res.json({ success: true, token });
    
  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

router.get('/status', (req, res) => {
  const token = req.query.token;
  if (token && tokens[token] && Date.now() < tokens[token].expiresAt) {
    res.json({ hasAccess: true, type: tokens[token].type });
  } else {
    if (token && tokens[token]) delete tokens[token];
    res.json({ hasAccess: false });
  }
});

module.exports = router;
