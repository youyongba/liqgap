# 支付与授权模块

## 当前配置

- 网络：Base Sepolia（84532），测试 USDC。不会自动切换主网。
- 套餐：`daily` = 1 USDC / 24 小时；`weekly` = 5 USDC / 7 天；`monthly` = 15 USDC / 30 天。
- 采用 x402 v2 `exact` / EIP-3009：钱包授权签名 → facilitator 验证/结算 → RPC 核对成功回执、USDC Transfer 和 AuthorizationUsed → SQLite 签发权限。
- 本模块不保证任意智能合约钱包都支持 EIP-3009；需钱包与 facilitator 同时支持。不能因为钱包连接成功就跳过结算验证。

## 文件

- `config.js`：服务端套餐金额、网络及收款配置。
- `store.js`：SQLite 订单、访问凭证、撤销与重放约束。
- `settlement.js`：结算、收据核验与重启后订单恢复。
- `../../routes/payment.js`：支付 API、管理员接口与行情鉴权。
- `../../public/payment-client.js`：手机钱包、签名、订单恢复及支付界面。
- `../../public/disclaimer.html`：免责声明页面，支付前需勾选阅读。

## 部署

1. `npm install`，`node scripts/build-x402.js`。建议 Node.js 22 LTS；当前工作机 18.17 低于部分钱包依赖的 engines 要求，测试通过不代表所有依赖在该版本都兼容。
2. 在服务器配置 `AUTO_TRADE_API_TOKEN` 作为管理员密码。缺失时管理员接口拒绝访问，没有 `admin123` 默认密码。
3. 可选 `WALLETCONNECT_PROJECT_ID`，默认沿用原项目 ID。在 Reown 控制台核对项目是否有效、正式 HTTPS 域名是否被允许。手机外部浏览器必须用 HTTPS，局域网 HTTP 不是安全上下文；也可使用钱包内置浏览器。
4. 可选 `PAYMENT_DB_PATH`，默认 `process.cwd()/data/payments.sqlite`。生产环境建议绝对路径或持久卷，重启必须使用同一个数据库。不要放临时目录，不要在发布时清空 `data/`。
5. 可选 `PAYMENT_RPC_URL`（必须为 Base Sepolia RPC）、`X402_FACILITATOR_URL`。仅从启动命令继承 HTTP(S) 代理，不把代理写入代码或 `.env`；不会把 SOCKS URL 伪装成 HTTP。
6. 代码变更后手动重启服务。本次开发不自动重启实际交易服务。
7. SQLite 使用 WAL。在线备份请使用 SQLite backup API；不能在写入期间只拷贝 `.sqlite` 而忽略 WAL。数据库和订单凭证属于敏感数据，不应纳入 Git 或公开静态目录。
8. pkg/字节码部署需要在二进制旁的 `node_modules` 安装与目标平台、CPU 和 pkg Node ABI 匹配的 `better-sqlite3`。构建时将它作为外部原生依赖；不能复制 macOS 的 `.node` 文件到 Linux。本次未执行跨平台二进制打包。

## REST API

所有 URL 均相对于当前站点，JSON 请求使用 `Content-Type: application/json`。

| 接口 | 请求 | 响应 / 行为 |
| --- | --- | --- |
| `GET /api/payment/config` | 无 | 套餐、链、USDC、收款地址、公开 WalletConnect projectId、声明版本 |
| `POST /api/payment/orders` | `{type, disclaimerVersion:"2026-11-18"}` | `{id,key}`，key 是私密订单凭证 |
| `POST /api/payment/orders/:id/pay` | `X-Order-Key`；首次无签名 | HTTP 402 + `PAYMENT-REQUIRED` |
| 同上 | 再次附 `PAYMENT-SIGNATURE` | 验签、保存同一授权并异步结算；202 仅表示处理中，不代表已付款 |
| `GET /api/payment/orders/:id` | `X-Order-Key` | 状态；到账后返回 token、到期时间并设置 HttpOnly Cookie |
| `DELETE /api/payment/orders/:id` | `X-Order-Key` | 仅允许取消尚未提交结算的订单 |
| `GET /api/payment/status` | Cookie 或 `Authorization: Bearer ...` | `{hasAccess,type,expiresAt}` |
| `POST /api/payment/admin/grant` | `{secret}` | 当前浏览器一年管理员访问权限 |
| `POST /api/payment/admin/tokens` | `{secret}` | 最近 1000 条订单，键为订单 ID，不返回所有用户的访问 token |
| `POST /api/payment/admin/revoke` | `{secret,token:订单ID}` | 永久记录撤销，立即关闭该凭证的 SSE |

旧 `POST /buy/:type` 已返回 410，客户端直接传交易哈希不会获得权限。
管理员 API 的 `token` 参数名保留兼容页面调用，其值现为订单 ID。

## 状态与恢复

- `new`：还没有服务端接受的签名。用户拒绝签名不收费，可取消订单重新选择套餐。
- `pending`：已保存支付签名及授权 nonce。浏览器可刷新、手机可切后台；恢复后只查询原订单。网络故障不得重新生成签名并重复收费。
- `paid`：核实链上日志后签发，授权期限从签发时开始；重复查询不续期。
- `cancelled`：未提交订单已取消；并发验签无法重新激活它。
- `failed`：链上时间超过签名有效期至少 60 秒，且 USDC 合约确认该 nonce 未执行；允许重新选套餐。单纯网络超时不会判定付款失败。
- `revokedAt`：撤销记录不删除，过期记录也保留；到期或撤销后接口与 SSE 都拒绝继续提供数据。
- 重启后通过已保存的交易哈希或 `AuthorizationUsed(from,nonce)` 日志恢复结算结果。RPC 若限制历史日志范围，待处理订单可能需要运营方核验，不能盲目重新付款。
- 浏览器保留私密订单凭证与访问 token；清除浏览器数据或更换设备不等于删除服务端记录，但本版本未实现钱包签名登录的跨设备找回。
- **旧版只有内存 token，且没有可靠记录付款钱包/交易哈希，无法据此自动迁移为可信支付记录。** 已丢失的历史记录需依据原交易与运营记录人工核验，不应要求用户直接重复付款。

## 行情稳定性

- 授权确认后才加载行情脚本。删除支付层不能绕过后端 API 鉴权。
- 主图驱动副图时间范围；副图更新不反向改变主图缩放。
- SSE 重连保留同一品种/周期的数据所有权，轮询过期响应不得覆盖主图。
- 自动重连统一指数退避与抖动。初始化 20 秒预算、客户端 25 秒，初始化期间也发送心跳，断开立即清理监听。
- SSE 心跳正常而 K 线静默时提示上游延迟，不循环重建健康连接。
- SSE 接管后停止冗余 K 线轮询；繁忙时跳过周期 tick；缓存数据明确标注，慢接口失败时保留最近数据。
- 这些改动减少内部抖动，不能消除交易所限流、代理断开、RPC 故障。生产反向代理还需关闭 SSE buffering，并将 read timeout 设为大于心跳周期。

## 验证

```sh
node scripts/test-payment-access.js
node scripts/test-stream-lifecycle.js
node scripts/test-chart-state.js
node scripts/test-swr-cache-smoke.js
node scripts/test-cvd-aggregate-smoke.js
node scripts/test-oi-aggregate-smoke.js
node scripts/build-x402.js
```

支付测试使用临时 SQLite、合成钱包签名、模拟 facilitator/RPC，不广播真实交易。真实手机 WalletConnect 的连接、跳转、签名与到账仍需运营方在自己的 HTTPS 站点完成验收。
