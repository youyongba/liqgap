'use strict';

/**
 * GET /api/orderbook/snapshot
 *
 * 按时间戳查最近一条录盘快照（取 at 之前最近的，避免"未来"快照）。
 * 用于"滚动窗口对比"功能：前端拿当前盘口 + N 时间前的快照对比，
 * 看出最近 N 时间内挂单墙的增厚 / 撤离。
 *
 * 查询参数 (Query):
 *   symbol  默认 'BTCUSDT'
 *   market  'spot' | 'futures'，默认 'futures'
 *   at      毫秒时间戳，默认 Date.now()
 *
 * 响应 (Response):
 *   - 找到:
 *       { success: true, data: {
 *           found: true,
 *           requestedAt: <ms>,
 *           snapshotAt:  <ms>,
 *           ageMs:       requestedAt - snapshotAt （快照领先请求时间多久）,
 *           lastUpdateId, bids: [[p,q],...], asks: [[p,q],...]
 *       }}
 *   - 未找到:
 *       { success: true, data: { found: false, requestedAt, snapshot: null } }
 *
 * GET /api/orderbook/recorder/status
 *   查看录盘服务状态（dir / symbols / 已生成的文件列表），用于运维 / debug。
 */

const express = require('express');
const recorder = require('../services/orderbookRecorder');

const router = express.Router();

router.get('/orderbook/snapshot', (req, res) => {
  const symbol = String(req.query.symbol || 'BTCUSDT').toUpperCase();
  const market = req.query.market === 'spot' ? 'spot' : 'futures';
  const at = Number(req.query.at);
  const requestedAt = Number.isFinite(at) && at > 0 ? at : Date.now();

  let snap;
  try {
    snap = recorder.findNearest(symbol, market, requestedAt);
  } catch (err) {
    return res.json({ success: false, error: err.message, data: { found: false, requestedAt } });
  }

  if (!snap) {
    return res.json({
      success: true,
      data: {
        found: false,
        requestedAt,
        reason: '尚无该时间点之前的快照（录盘窗口可能还没覆盖到 / Recorder window not yet reached）'
      }
    });
  }

  res.json({
    success: true,
    data: {
      found: true,
      requestedAt,
      snapshotAt: snap.ts,
      ageMs: requestedAt - snap.ts,
      lastUpdateId: snap.lastUpdateId,
      bids: snap.bids,
      asks: snap.asks
    }
  });
});

router.get('/orderbook/recorder/status', (_req, res) => {
  res.json({ success: true, data: recorder.getStatus() });
});

module.exports = router;
