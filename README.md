# Liquidity Gap · Binance 流动性指标 & 交易信号系统

一个完整的、可直接运行的流动性微结构监控 + 交易信号生成系统：

- **后端**：Node.js + Express（纯 JavaScript，CommonJS）
- **数据源**：币安公开 REST API（现货 / U 本位合约自由切换）
- **前端**：单页 HTML/CSS/JS 仪表盘，使用 TradingView Lightweight Charts 与 Chart.js 通过 CDN 加载
- **指标**：VWAP / MFI / ATR / FVG / 流动性空白 / Amihud ILLIQ / 成交量分布 / 滑点模拟 / Footprint / CVD / Delta / 综合预警 / 多空信号

---

## 目录结构

```
liq-gap/
├── package.json
├── server.js                  # Express 主入口
├── services/
│   ├── binance.js             # 币安 REST API 封装（现货+合约通用 K线/盘口/成交）
│   ├── binanceFutures.js      # 合约专属 API（资金费率 / OI / 多空比 / Taker / 强平）
│   ├── binanceData.js         # data.binance.vision 历史 aggTrades 流式下载/聚合 (回测专用)
│   └── feishu.js              # 飞书自定义机器人推送（签名 + 交互卡片 + 去重冷却）
├── routes/
│   ├── klines.js              # GET /api/klines
│   ├── orderbook.js           # GET /api/orderbook/indicators
│   ├── trades.js              # GET /api/trade/indicators
│   ├── illiquidity.js         # GET /api/indicators/illiquidity
│   ├── volumeProfile.js       # GET /api/indicators/volume-profile
│   ├── slippage.js            # GET /api/indicators/slippage
│   ├── alerts.js              # GET /api/alerts/liquidity
│   ├── signal.js              # GET /api/trade/signal  (核心信号)
│   ├── squeeze.js             # /api/squeeze/{warning,confirmation,heatmap,signal}
│   ├── backtest.js            # GET /api/backtest/run  (30 天回测)
│   └── notify.js              # /api/notify/{status,test,signal}  (飞书推送)
├── indicators/
│   ├── klineIndicators.js     # VWAP / MFI / ATR / FVG / Liquidity Voids
│   ├── orderbookIndicators.js # 深度比 / 估算有效价差 / 滑点模拟
│   ├── tradeIndicators.js     # Delta / CVD / Footprint
│   ├── illiquidity.js         # Amihud ILLIQ
│   ├── volumeProfile.js       # 成交量分布 / POC / VAH / VAL
│   ├── squeeze.js             # 扎空/扎多评分 / 确认 / 清算热力图
│   ├── backtest.js            # 30 天回测引擎（真实数据：VWAP+FVG+MFI+真实CVD+资金费率+ILLIQ）
│   └── stats.js               # mean / stdev / Pearson 相关
└── public/
    ├── index.html             # 仪表盘
    └── app.js                 # 前端控制器
```

---

## 安装与运行

需要 Node.js ≥ 18。

```bash
cd liq-gap
npm install
cp .env.example .env   # 第一次运行时；按需填写 BINANCE_API_KEY/SECRET
npm start              # 生产模式
# 或
npm run dev            # nodemon 热重载
```

启动后访问 <http://localhost:3000>。

### 环境变量 (`.env`)

`server.js` 会通过 `dotenv` 自动读取项目根目录的 `.env`：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `PORT` | 否 | 后端监听端口，默认 `3000` |
| `NODE_ENV` | 否 | `development` / `production` |
| `BINANCE_API_KEY` | 否 | 仅在需要拉取真实强平数据时填写 |
| `BINANCE_API_SECRET` | 否 | 与上配对 |
| `HTTPS_PROXY` / `HTTP_PROXY` | 否 | 网络受限时通过代理访问币安 |
| `FEISHU_WEBHOOK_URL` | 否 | 飞书自定义机器人 webhook，留空则关闭推送 |
| `FEISHU_WEBHOOK_SECRET` | 否 | 启用「签名校验」时填 |
| `FEISHU_NOTIFY_ENABLED` | 否 | `false` 表示完全关闭飞书推送 |
| `FEISHU_SIGNAL_NOTIFY_ENABLED` | 否 | `false` 仅关闭 LONG/SHORT 交易信号自动推送 |
| `FEISHU_FVG_NOTIFY_ENABLED` | 否 | `false` 仅关闭 FVG 缺口卡自动推送（regime webhook 不受影响）|
| `FEISHU_NOTIFY_COOLDOWN_MS` | 否 | 同方向交易信号推送冷却（默认 30 分钟）|
| **`REGIME_API_URL`** | 否 | **1h K 线出现新 FVG 时调用的 regime 接口**（留空则跳过）|
| `REGIME_API_METHOD` | 否 | 默认 `POST`，可改 `GET`（GET 用 query string 传参）|
| `REGIME_API_TOKEN` | 否 | 可选 Bearer token，附加在 `Authorization` 头 |
| `REGIME_NOTIFY_ENABLED` | 否 | `false` 表示完全关闭 regime 通知 |

不填密钥 `/api/squeeze/*` 会自动降级（强平数据返回空 + `degraded:true`），其余路由全部可用。

---

## API 一览

| Method | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/klines` | K 线 + VWAP + MFI（可选 FVG / 流动性空白） |
| GET | `/api/orderbook/indicators` | 价差 / 深度差 / 深度比 / 有效价差 |
| GET | `/api/trade/indicators` | deltaSeries / cvdSeries / footprintTable |
| GET | `/api/indicators/illiquidity` | Amihud ILLIQ 时间序列 |
| GET | `/api/indicators/volume-profile` | 成交量分布、POC、VAH、VAL |
| GET | `/api/indicators/slippage` | 给定数量市价单滑点模拟 |
| GET | `/api/alerts/liquidity` | 综合预警（5 项触发器 + 风险分数） |
| GET | `/api/trade/signal` | **核心**：LONG/SHORT/NONE 信号 + 入场/止损/止盈 |
| GET | `/api/squeeze/warning` | 扎空/扎多预警评分（资金费率 / OI / 持仓比 / Taker） |
| GET | `/api/squeeze/confirmation` | 价格-OI 背离 / 爆仓主导 / 资金费率回归 |
| GET | `/api/squeeze/heatmap` | 清算价位热力图 + 最近多/空爆仓集群 |
| GET | `/api/squeeze/signal` | **核心**：扎空/扎多交易信号 + 三段止盈 |
| GET | `/api/backtest/run` | **新增**：30 天策略回测（VWAP+FVG+MFI），返回胜率/盈亏比/资金曲线 |
| GET | `/api/notify/status` | 飞书 webhook 状态（是否启用、签名、上次推送时间） |
| POST | `/api/notify/test` | 发送一条测试卡片验证 webhook |
| POST | `/api/notify/signal` | 手动推送当前 `/api/trade/signal` (body 支持 `{symbol, market, force}`) |
| GET | `/api/health` | 健康检查 |

公共参数：`symbol`（默认 `BTCUSDT`）、`market`（`spot` / `futures`，**默认 `futures`，即 U 本位合约**）。

> ⚠️ 默认市场已从现货改为 U 本位合约。如需现货请显式传 `market=spot`。

所有路由统一返回 `{ success, data | error }`，**任何上游失败都返回 HTTP 200 + `success:false`**，便于前端统一处理。

### 主动单方向约定

- 现货：`isBuyerMaker === false` 视为主动买入（spec 与 Binance 实际语义一致）
- 合约：本项目按需求文档「现货反向」的约定处理（详见 `indicators/tradeIndicators.js` 中 `isAggressiveBuy()` 的注释），所有 Delta / CVD / Footprint 计算均会根据 `marketType` 做正确判断。

---

## 核心交易信号（`/api/trade/signal`）

**多头条件**（≥3 触发即 LONG）：

1. 最近 5 根 K 线检测到**看涨 FVG**
2. `depthRatio > 0.6`（买方深度主导）
3. 近 10 根 K 线 **CVD↑ 价格↑**（正相关）
4. ILLIQ 低于 20 日均值 且 spread 未超过 2 倍均值
5. 当前价格位于 **VWAP 上方**

空头条件为反向。

**关键价位**：

- 入场价 = 当前最新价
- 止损：多头 → 最近看涨 FVG 下沿 - ATR×倍数；无 FVG 则用近 5 根低点下方 1% 或 ATR 退化
- TP1：基于 R 倍数（`stopDistance × atrMultiplierTP1`）
- TP2：优先取**流动性空白**或 **POC**，否则 ATR×倍数
- TP3：近 20 根摆动高/低点 或 ATR×倍数
- `closeFraction`：50% / 30% / 20%

**仓位计算**：

```
riskAmount   = accountBalance * riskPercent / 100
positionSize = riskAmount / |entry - stopLoss|
```

---

## 前端仪表盘

- 顶部控制栏：交易对 / 现货-合约切换 / 周期 / 手动刷新 / 自动刷新（10s）
- 左侧主图：K 线 + VWAP 线 + FVG 价格线 + FVG/Void 标记
- 右下副图：成交量直方图、CVD 累积曲线、订单簿水平条形深度图
- 右侧信号面板：LONG/SHORT/NONE 标签、入场/止损/止盈、仓位、条件评估、5 项流动性预警、指标快照

页面纯原生 HTML/CSS/JS，仅通过 CDN 引入：

- TradingView Lightweight Charts <https://unpkg.com/lightweight-charts>
- Chart.js <https://cdn.jsdelivr.net/npm/chart.js>

---

## 30 天策略回测 (Backtest) · 真实数据驱动

`GET /api/backtest/run` 端点，**唯一被「模拟」的就是 1000 USDT 虚拟资金按信号开仓 / 止损 / 止盈并记录盈亏**；所有用于生成信号的指标全部由真实历史数据计算。

### 真实数据来源 (Real-data sources)

| 数据 | 来源 | 用途 |
| --- | --- | --- |
| 1h K 线 | `/fapi/v1/klines`（合约）/ `/api/v3/klines`（现货） | VWAP / ATR / MFI / FVG / 流动性空白 |
| 1d K 线 | 同上 (`interval=1d`) | Amihud ILLIQ |
| 资金费率历史 | `/fapi/v1/fundingRate` | 资金费率均值回归投票 |
| **逐笔成交 aggTrades** | **`https://data.binance.vision/data/futures/um/daily/aggTrades/<SYM>/<SYM>-aggTrades-YYYY-MM-DD.zip`** | **真实 Delta / 真实 CVD（按小时聚合）** |

> ⚠️ **绝不模拟 CVD**：不使用「阳线量当作主动买、阴线量当作主动卖」的近似。真实主动买卖量直接从每日 aggTrades zip 中按 `is_buyer_maker` 字段聚合。
> ⚠️ **绝不模拟订单簿**：币安未提供历史订单簿快照下载，因此 `Depth Ratio` / `Spread` / 估算有效价差等订单簿类指标在回测中**完全不参与判断**，并在响应 `skippedIndicators` 字段里明确列出。

### 信号生成 (vote-based)

每根 1h K 线收盘时根据下面**真实**指标的投票判断：
- `price ⋛ VWAP`（1 票）
- 近 5 根 K 线内 bullish/bearish FVG（1 票）
- MFI: 中性区 [30,70] 不计票；< 30 或 > 70 反向加 1 票
- **真实 CVD vs 价格** 24 根滚动 Pearson 相关 ≥ ±0.3 + 当前 Delta 同向 → 1 票
- 价格突破真实流动性空白带（1 票）
- 资金费率 ≥ ±5bp → 反向 1 票（mean-reversion）
- ILLIQ 异常（> 7 日中位数 5×）→ 一票否决，**直接拒绝任何信号**

LONG 票数 ≥ 3 且 > SHORT 即出多；反之出空。

### 风控 / 撮合
- `riskAmount = balance × riskPercent / 100`，`positionSize = riskAmount / stopDistance`
- 止损 = `entry ∓ ATR×1.5`，并用最近反向 FVG 边或 5 根 swing 极值收紧
- TP1/2/3 = `entry ± ATR × {1.5, 3, 5}`，平仓 50% / 30% / 20%
- 单边手续费 0.04%、单边滑点 0.05%（合约 taker 典型值）
- 同根 K 线 SL+TP 同时触发 → 保守按 SL 优先
- 单笔最长持仓 96 根 (4 天) 超时按收盘价强平

### 失败语义 (Hard-fail policy)
- 任何一类真实历史数据无法获取 → HTTP 200 + `{ success: false, error: "无法获取真实历史成交数据，回测中止" }`，**绝不退化为模拟数据**。
- 最常见失败：30 天 aggTrades 中某天的 zip 下载失败（网络中断 / 在被屏蔽地区）。
- aggTrades 覆盖率 < 50% 也会直接中止；50–95% 之间允许跑但在 `warnings` 中告警。

### 响应字段
```jsonc
{
  "success": true,
  "data": {
    "initialBalance": 1000,
    "finalBalance": 1074.66,
    "totalTrades": 7,
    "winningTrades": 6,
    "losingTrades": 1,
    "winRate": 0.857,
    "profitFactor": 6.78,
    "maxDrawdown": 0.020,
    "trades": [ /* 每笔含 entryTime/Side/entryPrice/SL/TP1-3/exitReason/realizedPnl/conditions/indicatorsAtEntry */ ],
    "equityCurve": [ { "time": ..., "equity": ..., "balance": ... }, ... ],
    "notes": "本回测所有指标均使用真实历史数据……Depth Ratio / Spread 因历史数据不可得而未使用。",
    "noteList": [ "...", "..." ],
    "warnings": [ /* coverageRatio 警告等 */ ],
    "skippedIndicators": [ "depthRatio (订单簿不平衡)", "spread / 估算有效价差", "..." ],
    "dataSources": {
      "klines":      { "endpoint": "/fapi/v1/klines", "bars": 720 },
      "dailyKlines": { "endpoint": "/fapi/v1/klines", "bars": 35 },
      "fundingRate": { "endpoint": "/fapi/v1/fundingRate", "records": 90 },
      "aggTrades":   { "source": "https://data.binance.vision/...", "daysDownloaded": 30,
                       "totalProcessedRows": 28341232, "totalBytes": 5234567890,
                       "coverageRatio": 1.0 }
    }
  }
}
```

### 调用示例
```bash
curl 'http://localhost:3000/api/backtest/run?symbol=BTCUSDT&days=30&initialBalance=1000&riskPercent=1'
```

> ⏱️ **耗时与流量提示**：30 天 BTCUSDT 合约 aggTrades 解压后约 5–15 GB，下载流量约 2–4 GB，整体回测时间通常 5–15 分钟（取决于带宽）。`unzipper` + `readline` 流式处理，运行时常驻内存 < 200 MB（按小时聚合后丢弃原始 trade）。
> 建议先用 `days=2` 跑通流程，再开 30 天。

前端右侧 "30 天策略回测" 面板支持一键运行，并在结果区展示：
- 资金曲线 (Chart.js)
- **真实数据声明 (notes)** —— 显式说明使用了哪些真实数据
- **未参与回测的指标 (skippedIndicators)** —— 显式标注订单簿类被跳过
- **警告 (warnings)** —— 例如覆盖率不足
- **数据源摘要 (dataSources)** —— K线条数、aggTrades 下载量与覆盖率
- **交易明细表 (trades)** —— 每笔 entry / SL / exit / 持仓 K 线 / 实现盈亏

---

## 扎空 / 扎多 (Squeeze) 模块

新增四个 `/api/squeeze/*` 端点，工作流：

1. **预警** `/api/squeeze/warning` —— 用资金费率 Z-score、OI 变化率、大户多空持仓比 Z-score、Taker 买卖失衡度合成 `[-100, 100]` 综合评分。`>=30` 视为 `SHORT_SQUEEZE`，`<=-30` 视为 `LONG_SQUEEZE`，否则 `NONE`。
2. **确认** `/api/squeeze/confirmation` —— 价格 / OI 背离判定、爆仓主导方向、资金费率从极端回归三项投票，每项最多 35 分，>= 50 即 `isSqueezeActive`。
3. **热力图** `/api/squeeze/heatmap` —— 将爆仓订单按价格分桶（默认 50 桶，±5% 当前价），分别累计多头爆仓量、空头爆仓量，并定位距当前价最近、最强的多/空集群。
4. **信号** `/api/squeeze/signal` —— 当 warning 与 confirmation 方向一致时生成交易计划：
   - `SHORT_SQUEEZE → LONG`，`LONG_SQUEEZE → SHORT`
   - 入场=当前价；止损=最近同方向爆仓集群外沿 ± 0.5% 缓冲，回退 ATR×1.2
   - TP1=最近反向爆仓集群边缘（平 50%）；TP2=近 30 根摆动高/低或 ATR×3（平 30%）；TP3=ATR×5 扩展（平 20%）
   - 仓位 = `accountBalance * riskPercent / 100 / |entry-stopLoss|`
   - confidence = `0.5 * |warning.score| + 0.5 * confirmation.confidence`

### 关于强平数据

- Binance 已将 `/fapi/v1/allForceOrders` 改为 `USER_DATA` 鉴权端点，公网无 API key 无法访问；公共爆仓数据只有 `!forceOrder@arr` WebSocket 流。
- 本项目实现优雅降级：未配置密钥时返回空数组并设置 `liquidationsDegraded: true`，热力图/信号仍可基于 OI / 资金费率工作（止损会回退至 ATR 模式）。
- 若想使用真实强平数据，可在启动前导出环境变量：

```bash
export BINANCE_API_KEY=...
export BINANCE_API_SECRET=...
npm start
```

---

## 飞书推送 (Feishu / Lark Webhook)

两类自动推送：
- **交易信号**：`/api/trade/signal` 产出 LONG / SHORT 时按方向变化推送
- **新 FVG**：`/api/klines?detectPatterns=true` 检测到新出现的 Bullish / Bearish FVG 时实时推送（前端默认 10s 轮询，所以最迟 10s 内你就会收到）

### 配置
在 `.env` 填两项（签名是可选项，仅当机器人开启了"签名校验"时需要）：
```bash
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx
FEISHU_WEBHOOK_SECRET=xxxxxxxxxx        # 可选
# FEISHU_NOTIFY_ENABLED=false           # 想关掉自动推送时打开此行
# FEISHU_NOTIFY_COOLDOWN_MS=1800000     # 同方向重复推送的冷却（默认 30 min）
```
> 创建机器人：飞书群 → 设置 → 群机器人 → 添加 → 自定义机器人。

### 推送规则（去重 / 冷却）

**交易信号** —— 在 `routes/signal.js` 里：
- 仅当 `signal === 'LONG'` 或 `'SHORT'` 才推送（NONE 永不推）
- 上次为 NONE / 未推送过 → 推
- 方向反转 (`LONG ↔ SHORT`) → 推
- 同方向且距上次推送 ≥ `FEISHU_NOTIFY_COOLDOWN_MS` → 推
- 同方向且尚在冷却内 → 跳过（终端会 `console.log` 出原因）

**新 FVG** —— 在 `routes/klines.js` 里：
- **首次调用静默建立 baseline**：把当前所有历史 FVG 当作"已知"，不推送，避免初次启动洗版
- 之后每次只推送 `endTime` 严格大于已记录最大值的新 FVG（即"刚刚收盘 / 刚刚被确认"的 FVG）
- 单批最多推 3 条，防止异常情况刷屏；未推送但已看到的 FVG 仍计入"已知"，下一批不会重复

推送是 fire-and-forget，**不阻塞** API 响应；推送失败仅在服务端日志里告警。

### 卡片样式
**信号卡片**：header 带颜色（多=绿、空=红），主体含：
- 标的 / 最新价
- 入场价、止损、TP1 (50%) / TP2 (30%) / TP3 (20%)
- 风险金额、仓位大小
- 多/空条件命中清单（✅ ❌）
- 关键指标快照（ATR / VWAP / depthRatio / CVD-Px corr / ILLIQ）
- 触发来源 + 时间戳

**FVG 卡片**：header 颜色与类型一致（Bullish=绿、Bearish=红），主体含：
- 标的 / 类型（绿色看涨 / 红色看跌）
- 缺口下沿 / 上沿 / 宽度（含百分比）
- 当前最新价、起始 K 线、确认收盘时间
- 简易交易意图说明（回踩 / 反弹 / 失效条件）

### 端点
| 路径 | 用途 |
| --- | --- |
| `GET /api/notify/status` | 查看 webhook 是否启用、签名状态、上次推送时间 |
| `POST /api/notify/test` | 发送一条文本测试消息验证 webhook 可达 |
| `POST /api/notify/signal` | 手动触发推送当前信号；body `{symbol?, market?, force?}` |

### 前端
仪表盘的"交易信号"面板顶部新增飞书控制条，三个按钮：
- **推送飞书 / Push** — 受冷却限制
- **强制推送 / Force** — 绕过冷却（用于测试）
- **测试 webhook / Test** — 发一条 ping，确认 URL+签名正确

状态条显示：是否已配置、签名状态、当前 symbol+market 上次推送时间。

### 关闭自动推送但保留手动按钮
四种粒度（可组合）：
1. `.env` 里 `FEISHU_NOTIFY_ENABLED=false`：飞书所有自动 + 手动推送都关闭
2. `.env` 里 `FEISHU_SIGNAL_NOTIFY_ENABLED=false`：**只关掉 LONG/SHORT 交易信号自动推送**，
   FVG 缺口卡 / 手动 / 测试 ping 仍可用
3. `.env` 里 `FEISHU_FVG_NOTIFY_ENABLED=false`：**只关掉 FVG 缺口卡自动推送**，
   regime webhook / 信号卡 / 手动 / 测试 ping 仍可用
4. 在前端调用里加 `&notify=false`（按请求级别）：
   - `/api/trade/signal?...&notify=false` 关掉信号自动推送
   - `/api/klines?...&notify=false` 关掉 FVG 自动推送（同时也会跳过 regime 接口）
   - 手动按钮 `/api/notify/signal` / `/api/notify/test` 不受影响

> 想"屏蔽所有交易类卡片但保留 regime 自动交易"：把 ② 和 ③ 同时设为 `false`。

---

## Regime 接口 (Market-state Webhook)

当 **1h K 线** 出现一根「新」的 FVG 时，后端会异步把方向打到外部 regime 接口。
适合接入自定义的 market-state 模型 / 仓位管理 / 报警系统。

### 配置
```bash
REGIME_API_URL=https://your-regime-host/path
# REGIME_API_METHOD=POST       # 默认 POST，可改 GET（GET 时把 body 拼到 query string）
# REGIME_API_TOKEN=xxxxxxxx    # 可选 Bearer Token
# REGIME_NOTIFY_ENABLED=false  # 临时关掉
```
留空 `REGIME_API_URL` 即整体禁用，不会发任何请求。

### 触发规则
- **仅 1h K 线**：`/api/klines?interval=1h&detectPatterns=true` 命中时才触发；
  其他周期（15m / 4h / 1d 等）命中 FVG 只会推飞书，不调 regime
- **去重**：与飞书 FVG 推送共享一份 `pickNewFvgs` 状态——首次调用静默建立 baseline；
  之后每次只发送 `endTime` 严格更新的新 FVG（避免历史/重复 FVG 触发噪声）
- **fire-and-forget**：异步发送，**不阻塞** `/api/klines` 响应；失败只写服务端日志

### 请求体
固定 JSON 形状：

| FVG 类型 | 请求体 |
| --- | --- |
| Bullish (绿色 / 看涨) | `{"fvg": "long"}` |
| Bearish (红色 / 看跌) | `{"fvg": "short"}` |

请求头：
```
Content-Type: application/json; charset=utf-8
Authorization: Bearer <REGIME_API_TOKEN>   # 仅在配置时附带
User-Agent: liq-gap/1.0 (+regime-notifier)
```

GET 模式下，参数会拼到 URL：`?fvg=long` 或 `?fvg=short`。

### 排查
- 服务端日志里 `[regime] notified regime for N new FVG(s)` = 成功 N 条
- `[regime] notify long failed: ...` = 单条失败，不会影响其他 FVG
- 调 `GET /api/notify/status` 查看 `regime.recentCalls`，最近 10 次调用的方向 / 状态码 / 响应都在里面

---

## 错误处理与限制

- 所有路由统一返回 `{ success: boolean, data | error }`，并且**总是 HTTP 200**（即便上游币安失败），便于前端 `fetch` 解析。
- 错误信息会附带请求路径和 HTTP 状态码，例如：
  `Binance API /fapi/v1/klines failed (HTTP 403): ...（疑似地理限制或 Cloudflare 拦截）`
- 后端通过 `axios` 直连币安公网，**首次启动建议确认所在网络可访问 `api.binance.com` / `fapi.binance.com`**。
- 滑点 / 有效价差使用真实订单簿模拟吃单计算，仅供参考，不代表真实成交价。

### 常见错误排查 (Troubleshooting)

| 现象 | 原因 | 解决方案 |
| --- | --- | --- |
| `HTTP 403` / `HTTP 451` | Cloudflare / 地理限制（部分地区如中国大陆直连受限） | 在 `.env` 里取消注释并填写 `HTTPS_PROXY=http://127.0.0.1:7890`（替换为本地代理端口），重启服务 |
| `HTTP 429` / `418` | 被币安限流 | 加大前端 `POLL_INTERVAL_MS`，或降低 K 线 `limit` |
| `HTTP NETERR: ECONNRESET / ENOTFOUND` | 网络不通 / DNS 失败 | 检查代理或换网络环境 |
| 仪表盘 `部分失败 / Partial: ...` | 上述任何一种导致 5 个轮询接口失败 | 看状态栏后半段会显示具体上游错误，按表对照解决 |
| `/api/squeeze/*` 中 `liquidations.degraded=true` | 未配置 API Key 或签名失败，已降级 | 想要真实强平数据请在 `.env` 填 `BINANCE_API_KEY` / `BINANCE_API_SECRET`（建议只读权限） |

> 注意：`axios` 会自动识别 `HTTPS_PROXY` / `HTTP_PROXY` 环境变量，无需改代码。
> 修改 `.env` 后必须 **重启 `node server.js`**（dotenv 仅在启动时加载一次）。

---

## 许可证

MIT
