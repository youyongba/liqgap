'use strict';

const DAY = 86400000;
const plans = {
  daily: { label: '24 小时', amount: '1000000', price: '1', duration: DAY },
  weekly: { label: '7 天', amount: '5000000', price: '5', duration: 7 * DAY },
  monthly: { label: '30 天', amount: '15000000', price: '15', duration: 30 * DAY }
};
const network = 'eip155:84532';
const asset = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const payTo = '0x5c8E2fd639AaBa1DdB76504fC33A608528c6f975';
const rpcUrl = process.env.PAYMENT_RPC_URL || 'https://sepolia.base.org';
const projectId = process.env.WALLETCONNECT_PROJECT_ID || '9cea3b242316cfb3d6ab12e8604fea22';
function requirements(order) {
  return { scheme: 'exact', network, asset, amount: order.amount, payTo,
    maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2', assetTransferMethod: 'eip3009' } };
}
module.exports = { plans, network, asset, payTo, rpcUrl, projectId, requirements };
