'use strict';

const { keccak256, toHex } = require('viem');
const config = require('./config');
const TRANSFER = keccak256(toHex('Transfer(address,address,uint256)'));
const USED = keccak256(toHex('AuthorizationUsed(address,bytes32)'));
const topicAddress = address => '0x' + address.toLowerCase().slice(2).padStart(64, '0');

function isPaymentReceipt(receipt, order) {
  if (!receipt || receipt.status !== '0x1') return false;
  const auth = JSON.parse(order.payload).payload.authorization;
  const logs = (receipt.logs || []).filter(log => log.address.toLowerCase() === config.asset.toLowerCase());
  const used = logs.some(log => log.topics[0] === USED &&
    log.topics[1] === topicAddress(order.wallet) && log.topics[2] === auth.nonce.toLowerCase());
  const transfer = logs.some(log => log.topics[0] === TRANSFER &&
    log.topics[1] === topicAddress(order.wallet) && log.topics[2] === topicAddress(config.payTo) &&
    BigInt(log.data) === BigInt(order.amount));
  return used && transfer;
}

function createSettlementService(store, { settle, fetchPayment }) {
  const running = new Set();
  const lastAttempt = new Map();
  async function rpc(method, params = []) {
    const response = await fetchPayment(config.rpcUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(body.error.message);
    return body.result;
  }
  async function reconcile(order) {
    let txHash = order.txHash;
    if (!txHash) {
      const auth = JSON.parse(order.payload).payload.authorization;
      // USDC's nonce event proves this exact signed authorization was consumed.
      // It also recovers settlement if the process died after broadcast but before saving the hash.
      const logs = await rpc('eth_getLogs', [{
        address: config.asset, fromBlock: order.fromBlock, toBlock: 'latest',
        topics: [USED, topicAddress(order.wallet), auth.nonce]
      }]);
      txHash = logs[0] && logs[0].transactionHash;
    }
    if (!txHash) return false;
    const receipt = await rpc('eth_getTransactionReceipt', [txHash]);
    if (!isPaymentReceipt(receipt, order)) return false;
    store.complete(order.id, txHash);
    return true;
  }
  async function run(id) {
    let order = store.get(id);
    try {
      if (await reconcile(order)) return;
      const payload = JSON.parse(order.payload);
      const auth = payload.payload.authorization;
      if (Date.now() / 1000 > Number(auth.validBefore) + 60) {
        const block = await rpc('eth_getBlockByNumber', ['latest', false]);
        const data = keccak256(toHex('authorizationState(address,bytes32)')).slice(0, 10) +
          topicAddress(order.wallet).slice(2) + auth.nonce.slice(2);
        const used = await rpc('eth_call', [{ to: config.asset, data }, 'latest']);
        // A timeout alone is not failure. Only expire after chain time passes the
        // validity window AND the contract confirms this nonce was never consumed.
        if (Number(BigInt(block.timestamp)) > Number(auth.validBefore) + 60 && BigInt(used) === 0n) {
          store.fail(id, '支付授权已过期，链上确认未执行；可以重新选择套餐');
          return;
        }
      }
      if (order.txHash) {
        store.pending(id, order.txHash, '交易已广播，等待链上确认，请勿重复支付');
        return;
      }
      const result = await settle(payload, config.requirements(order));
      if (result.transaction && /^0x[a-f0-9]{64}$/i.test(result.transaction)) {
        store.pending(id, result.transaction.toLowerCase(), '正在核对链上到账记录');
      }
      order = store.get(id);
      if (await reconcile(order)) return;
      store.pending(id, null, result.success ? '结算已提交，等待链上确认' :
        '尚未确认到账，请继续查询原订单；不要再次支付');
    } catch (err) {
      store.pending(id, null, '网络或结算服务暂不可用，订单已保存；请继续查询，勿重复支付');
      console.warn('[payment settlement]', id, err.message);
    } finally {
      running.delete(id);
      lastAttempt.set(id, Date.now());
      if (lastAttempt.size > 1000) lastAttempt.delete(lastAttempt.keys().next().value);
    }
  }
  return {
    blockNumber: () => rpc('eth_blockNumber'),
    start(id) {
      const order = store.get(id);
      if (!order || order.state !== 'pending' || running.has(id) ||
          Date.now() - (lastAttempt.get(id) || 0) < 10000) return;
      running.add(id);
      void run(id);
    }
  };
}

module.exports = { createSettlementService, isPaymentReceipt };
