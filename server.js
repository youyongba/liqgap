'use strict';

/**
 * Express 主入口 (Express entrypoint)
 *  - 把每个 route 模块挂到 /api 前缀下
 *    (Mounts every route module under /api)
 *  - 用 ./public 作为静态目录托管前端仪表盘
 *    (Serves the dashboard from ./public)
 *  - 监听 PORT 端口 (默认 3000)
 *    (Listens on PORT, default 3000)
 *
 * 启动时通过 dotenv 自动加载 .env，调用方可以无需手动 export 就能覆盖
 * 端口、提供 Binance API 凭证（只有强平签名端点需要）。
 *
 * (Environment variables are loaded from `.env` at startup so callers can
 *  override the port and supply Binance API credentials – only needed for
 *  the signed liquidation endpoint – without exporting them manually.)
 */

require('dotenv').config();

const path = require('path');
const express = require('express');

const klinesRoute = require('./routes/klines');
const orderbookRoute = require('./routes/orderbook');
const tradesRoute = require('./routes/trades');
const illiquidityRoute = require('./routes/illiquidity');
const volumeProfileRoute = require('./routes/volumeProfile');
const slippageRoute = require('./routes/slippage');
const alertsRoute = require('./routes/alerts');
const signalRoute = require('./routes/signal');
const squeezeRoute = require('./routes/squeeze');
const backtestRoute = require('./routes/backtest');
const notifyRoute = require('./routes/notify');
const streamRoute = require('./routes/stream');
const aiRoute = require('./routes/ai');
const openInterestRoute = require('./routes/openInterest');
const orderbookSnapshotRoute = require('./routes/orderbookSnapshot');
const orderbookHeatmapRoute = require('./routes/orderbookHeatmap');
const liquidationHeatmapRoute = require('./routes/liquidationHeatmap');
const predictiveLiquidationsRoute = require('./routes/predictiveLiquidations');
const orderbookRecorder = require('./services/orderbookRecorder');
const liquidationRecorder = require('./services/liquidationRecorder');

const app = express();
const PORT = process.env.PORT || 3000;

// 全局禁用浏览器缓存，确保仪表盘每次都拿到最新数据
// (Disable client-side cache globally so the dashboard always sees fresh data.)
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.use(express.json());

// 把 8 + 1 个路由模块挂到 /api 下 (Mount every route under /api)
app.use('/api', klinesRoute);
app.use('/api', orderbookRoute);
app.use('/api', tradesRoute);
app.use('/api', illiquidityRoute);
app.use('/api', volumeProfileRoute);
app.use('/api', slippageRoute);
app.use('/api', alertsRoute);
app.use('/api', signalRoute);
app.use('/api', squeezeRoute);
app.use('/api', backtestRoute);
app.use('/api', notifyRoute);
app.use('/api', streamRoute);
app.use('/api', openInterestRoute);
app.use('/api', orderbookSnapshotRoute);
app.use('/api', orderbookHeatmapRoute);
app.use('/api', liquidationHeatmapRoute);
app.use('/api', predictiveLiquidationsRoute);
app.use('/api/ai', aiRoute);

// 健康检查 (Health-check endpoint)
app.get('/api/health', (_req, res) => {
  res.json({ success: true, data: { status: 'ok', uptime: process.uptime() } });
});

// 静态资源 (Static assets)
app.use(express.static(path.join(__dirname, 'public')));

// 404 兜底 (404 fallback)
app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Not found' });
});

// 全局错误处理 (Global error handler)
app.use((err, _req, res, _next) => {
  // eslint-disable-next-line no-console
  console.error('[server] unhandled error', err);
  res.status(500).json({ success: false, error: err.message || 'Internal error' });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[server] dashboard ready on http://localhost:${PORT}`);
  // 启动订单簿录盘（每分钟一次，落磁盘，保留 25h）
  // (Kick off the order-book snapshot recorder so the rolling-window compare
  //  feature has data to draw against.)
  try {
    orderbookRecorder.start();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[server] orderbook recorder start failed:', err.message);
  }
  // (Kick off the liquidation-event recorder so liquidation heatmap has data.)
  try {
    liquidationRecorder.start();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[server] liquidation recorder start failed:', err.message);
  }
});
