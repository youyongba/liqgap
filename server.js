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
const compression = require('compression');

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
const predictiveLiquidationsRoute = require('./routes/predictiveLiquidations');
const alertCrossRoute = require('./routes/alertCross');
const liqSignalRoute = require('./routes/liqSignal');
const resonanceSignalRoute = require('./routes/resonanceSignal');
const autoTradeRoute = require('./routes/autoTrade');
const cvdRoute = require('./routes/cvd');
const keyLevelsRoute = require('./routes/keyLevels');
const orderbookRecorder = require('./services/orderbookRecorder');
const keyLevelsAlert = require('./services/keyLevelsAlert');
const signalPoller = require('./services/signalPoller');
const cvdBreakoutAlert = require('./services/cvdBreakoutAlert');

const app = express();
const PORT = process.env.PORT || 3000;

// 全局禁用浏览器缓存，确保仪表盘每次都拿到最新数据
// (Disable client-side cache globally so the dashboard always sees fresh data.)
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// gzip 压缩：清算热力图等接口返回大矩阵 JSON（未压缩可超 1MB，全是 0 和
// 重复数字，压缩率 >10x），跨境链路上传输时间是加载慢的主因之一。
// SSE (text/event-stream) 必须排除：compression 会缓冲响应，破坏实时推送。
app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    const ct = String(res.getHeader('Content-Type') || '');
    if (ct.includes('text/event-stream')) return false;
    return compression.filter(req, res);
  }
}));

app.use(express.json());

// ---------------------------------------------------------------------------
// /api 看门狗 (API watchdog)
// ---------------------------------------------------------------------------
// 上游 (Binance) 偶发挂死时，若本服务迟迟不响应，前置网关/反向代理会在
// ~15s 处直接返回 502/504 的 HTML 错误页，前端拿到非 JSON 响应只能报
// "HTTP 502 非 JSON 响应"。这里保证任何 /api 请求在 API_WATCHDOG_MS 内
// 一定响应 JSON：到点未响应就先回兜底错误（HTTP 200 + success:false），
// 迟到的路由响应会被安全丢弃（不会触发 ERR_HTTP_HEADERS_SENT）。
// SSE (/api/stream) 一建立连接就已发送 headers，天然不受看门狗影响。
const API_WATCHDOG_MS = (() => {
  const v = Number(process.env.API_WATCHDOG_MS);
  return Number.isFinite(v) && v >= 3000 ? v : 13000;
})();
app.use('/api', (req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = (body) => {
    if (res.headersSent) return res; // 看门狗已兜底 → 丢弃迟到的路由响应
    return origJson(body);
  };
  const timer = setTimeout(() => {
    if (res.headersSent) return;
    res.status(200);
    origJson({
      success: false,
      error: `服务端处理超时 (>${Math.round(API_WATCHDOG_MS / 1000)}s，上游数据源缓慢，稍后自动重试)`,
      watchdogTimeout: true
    });
  }, API_WATCHDOG_MS);
  if (typeof timer.unref === 'function') timer.unref();
  res.on('close', () => clearTimeout(timer));
  next();
});

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
app.use('/api', predictiveLiquidationsRoute);
app.use('/api', alertCrossRoute);
app.use('/api', liqSignalRoute);
app.use('/api', resonanceSignalRoute);
app.use('/api', autoTradeRoute);
app.use('/api', cvdRoute);
app.use('/api', keyLevelsRoute);
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
  // 启动关键价位触碰监控（价格触及各周期 FVG/清算主峰/买卖墙 → 飞书推送）
  try {
    keyLevelsAlert.start();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[server] key-levels touch monitor start failed:', err.message);
  }
  // 启动后端信号轮询（前端信号面板已移除；清算磁极 + 共振信号的
  // 飞书推送 / autoTrade webhook 改由服务端定时自轮询驱动）
  try {
    signalPoller.start();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[server] signal poller start failed:', err.message);
  }
  // 启动 CVD 24h 突破监控（CVD 创 24h 新高/新低 → 飞书推送）
  try {
    cvdBreakoutAlert.start();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[server] cvd breakout monitor start failed:', err.message);
  }
});
