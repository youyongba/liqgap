'use strict';

/**
 * GET /api/stream/status
 *
 * 返回当前所有活跃的 Binance WebSocket 订阅 hub 的状态：
 * 每个 hub 含 (symbol, market) + 订阅的 streams + 三类缓存的就绪状态。
 *
 * 主要用途：调试 / 监控 WS 是否正常推送、订单簿是否成功 reconcile。
 */

const express = require('express');
const { getStreamStatus } = require('../services/binanceLive');

const router = express.Router();

router.get('/stream/status', (_req, res) => {
  try {
    const hubs = getStreamStatus();
    res.json({
      success: true,
      data: {
        hubCount: hubs.length,
        now: Date.now(),
        hubs
      }
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
