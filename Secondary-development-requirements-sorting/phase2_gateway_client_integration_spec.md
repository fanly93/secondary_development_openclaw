# Phase2 Gateway 标准接入与二次开发对接规范（OpenClaw）

## 1. 文档目标与范围

本文件在 `phase1_client_communication.md` 基础上，聚焦 Gateway 的二次开发接入实践，系统回答三件事：

1. 当前架构下，接入 Gateway 的标准方式与核心模块是什么。
2. 不同客户端对接 Gateway 时，输入/输出接口规范分别是什么。
3. 自定义客户端或二开客户端落地时，需要关注哪些关键技术细节与实现点。

本文分析依据来自 Gateway 协议层、服务端连接处理、方法路由、HTTP 兼容层与多端客户端实现源码。

---

## 2. 当前架构中的标准接入方式

## 2.1 标准方式 A：WebSocket Gateway 协议（主通道，推荐）

这是 Gateway 的主接入方式，覆盖控制面（operator）与能力面（node）。

- 传输：WebSocket 文本帧 JSON
- 首帧要求：必须是 `connect`
- 协议版本：`PROTOCOL_VERSION = 3`
- 帧模型：
  - `req`: `{ type, id, method, params }`
  - `res`: `{ type, id, ok, payload?, error? }`
  - `event`: `{ type, event, payload?, seq?, stateVersion? }`

源码依据：

- `src/gateway/protocol/schema/frames.ts`
- `src/gateway/protocol/index.ts`
- `src/gateway/server/ws-connection/message-handler.ts`
- `docs/gateway/protocol.md`

适用客户端：

- CLI / TUI / Web UI / 自定义控制台
- iOS / Android / macOS 节点端
- 需要实时事件流（agent/chat/presence/sessions.changed）的客户端

## 2.2 标准方式 B：OpenAI 兼容 HTTP 接口（模型生态接入）

Gateway 内置兼容接口，适合快速对接已有 OpenAI 生态客户端：

- `GET /v1/models`
- `POST /v1/embeddings`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /tools/invoke`

兼容层最终仍落到 OpenClaw 的 agent 运行链路（不是独立推理引擎）：

- `openai-http.ts` -> `agentCommandFromIngress(...)`
- `openresponses-http.ts` -> `agentCommandFromIngress(...)`

源码依据：

- `src/gateway/server-http.ts`
- `src/gateway/openai-http.ts`
- `src/gateway/openresponses-http.ts`
- `src/gateway/http-endpoint-helpers.ts`

## 2.3 标准方式 C：Hooks/Webhook 入口（外部系统触发）

Gateway 提供 hooks 路径接收外部系统调用（POST JSON），可触发 `wake` 或 `agent` 派发。

特点：

- 独立 token 校验
- idempotency 与重放防护
- 支持 mapping 到 agent 调度

源码依据：

- `src/gateway/server-http.ts`（hooks stage）
- `src/gateway/server/hooks.ts`
- `src/gateway/server-http.ts` 中 `createHooksRequestHandler(...)`

## 2.4 标准方式 D：插件 HTTP 路由（扩展接入面）

插件可注册网关路由，接入点由 Gateway 统一鉴权与路由分发。

源码依据：

- `src/gateway/server-http.ts`
- `src/gateway/server/plugins-http.ts`
- `src/gateway/server-runtime-state.ts`

---

## 3. Gateway 核心功能模块梳理（服务端视角）

## 3.1 模块分层总览

1. **启动与运行时编排**
   - 负责加载配置、插件、HTTP/WS 服务、定时任务、热重载
   - 入口：`src/gateway/server.impl.ts`
2. **传输接入层（HTTP + WS）**
   - 统一端口承载 WS RPC、HTTP API、Control UI、hooks
   - 入口：`src/gateway/server-runtime-state.ts`、`src/gateway/server-http.ts`
3. **握手鉴权与设备配对层**
   - `connect.challenge`、签名校验、token/deviceToken/bootstrapToken、pairing
   - 入口：`src/gateway/server/ws-connection/message-handler.ts`
4. **方法路由与授权层**
   - method -> handler 分发，role/scope 校验，控制面写操作限流
   - 入口：`src/gateway/server-methods.ts`、`src/gateway/method-scopes.ts`、`src/gateway/role-policy.ts`
5. **会话与事件状态层**
   - chat/agent 事件流、session 订阅、presence、dedupe、abort
   - 入口：`src/gateway/server-chat.ts`、`src/gateway/server-runtime-state.ts`
6. **Agent 编排层**
   - `chat.send`/`agent` 进入 `dispatchInboundMessage` 或 `agentCommandFromIngress`
   - 入口：`src/gateway/server-methods/chat.ts`、`src/gateway/server-methods/agent.ts`
7. **Node 能力编排层**
   - node 注册、invoke、pending queue、能力声明与命令白名单
   - 入口：`src/gateway/server-methods/nodes*.ts`、`src/gateway/node-registry.ts`
8. **HTTP 兼容与生态桥接层**
   - OpenAI/OpenResponses 协议适配
   - 入口：`src/gateway/openai-http.ts`、`src/gateway/openresponses-http.ts`

## 3.2 公共方法与事件面（可发现能力）

- 方法发现：`hello-ok.features.methods`
- 事件发现：`hello-ok.features.events`
- 基线定义：`src/gateway/server-methods-list.ts`

---

## 4. 不同客户端对接 Gateway 的输入/输出接口规范

## 4.1 通用输入规范（所有 WS 客户端）

握手输入 `connect.params` 核心字段：

- `minProtocol` / `maxProtocol`
- `client.{id,version,platform,mode,instanceId,...}`
- `role` (`operator` | `node`)
- `scopes`（operator 权限集合）
- `caps` / `commands` / `permissions`（节点能力声明）
- `auth.{token|bootstrapToken|deviceToken|password}`
- `device.{id,publicKey,signature,signedAt,nonce}`（推荐强制）

严格性要点：

- `client.id` 与 `client.mode` 不是自由字符串，受协议枚举限制。
- 第一帧非 `connect` 会被拒绝并断开。

源码依据：

- `src/gateway/protocol/schema/frames.ts`
- `src/gateway/protocol/schema/primitives.ts`
- `src/gateway/server/ws-connection/message-handler.ts`

## 4.2 通用输出规范（所有 WS 客户端）

握手成功输出 `hello-ok`：

- `protocol`
- `features.methods/events`
- `snapshot`（health/presence/stateVersion）
- `auth.deviceToken`（若发放）
- `policy.maxPayload/maxBufferedBytes/tickIntervalMs`

运行期输出：

- `res`: 每个 `req(id)` 的对应响应
- `event`: `agent`、`chat`、`session.message`、`sessions.changed`、`presence`、`tick` 等

源码依据：

- `src/gateway/protocol/schema/frames.ts`
- `src/gateway/server-methods-list.ts`

## 4.3 Operator 客户端接口规范（CLI/Web UI/自定义控制台）

典型输入（method）：

- 状态/探针：`health`、`status`、`system-presence`
- 会话/对话：`sessions.*`、`chat.send`、`chat.history`、`chat.abort`
- 调度：`agent`、`agent.wait`
- 配置控制：`config.*`、`update.run`、`secrets.*`（需更高 scopes）

典型输出（event）：

- `agent`（流式生命周期与工具事件）
- `chat`（delta/final/error）
- `session.message`、`sessions.changed`

权限语义：

- method 与 scope 强绑定（例如 `chat.send` 需 `operator.write`）
- `operator.admin` 可放宽为高权限总开关

源码依据：

- `src/gateway/method-scopes.ts`
- `src/gateway/server-methods.ts`
- `src/gateway/server-methods/chat.ts`
- `src/gateway/server-methods/agent.ts`

## 4.4 Node 客户端接口规范（iOS/Android/macOS 节点）

典型输入（连接声明）：

- `role: "node"`
- `scopes: []`（通常为空）
- `caps/commands/permissions` 声明设备能力

典型输入（运行期）：

- 上报：`node.event`
- 回传：`node.invoke.result`
- 拉取/确认：`node.pending.pull`、`node.pending.ack`

典型输出（Gateway -> Node）：

- `node.invoke.request`（执行命令）
- 配对生命周期事件

源码依据：

- `src/gateway/server/ws-connection/message-handler.ts`
- `src/gateway/server-methods-list.ts`
- `apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayChannel.swift`
- `apps/android/app/src/main/java/ai/openclaw/app/gateway/GatewaySession.kt`

## 4.5 浏览器 Control UI 客户端特有规范

- 使用 `GatewayBrowserClient`（浏览器侧）
- 固定 operator scopes（admin/read/write/approvals/pairing）
- 受 `secure context` 约束决定是否可携带 device identity
- 内置 device token 一次性重试逻辑（`AUTH_TOKEN_MISMATCH`）

源码依据：

- `ui/src/ui/gateway.ts`

## 4.6 HTTP 客户端规范（OpenAI/OpenResponses）

输入规范：

- HTTP Bearer 鉴权（共享密钥语义）
- JSON body 按兼容协议提交
- 可用头部：`x-openclaw-agent-id`、`x-openclaw-model`、`x-openclaw-session-key`、`x-openclaw-message-channel`

输出规范：

- 非流式：标准 JSON 对象
- 流式：SSE（chunk/delta/completed 事件）

注意：

- 兼容 HTTP 路径在 scope 语义上与普通 HTTP helper 有差异（共享密钥视为 trusted operator）

源码依据：

- `src/gateway/openai-http.ts`
- `src/gateway/openresponses-http.ts`
- `src/gateway/http-utils.ts`

---

## 5. 自定义客户端/二次开发对接时的关键技术细节

## 5.1 必须遵守的协议与连接细节

1. 必须处理 `connect.challenge`，并用 challenge nonce 参与设备签名。
2. 首帧必须是 `connect`，否则握手失败。
3. `minProtocol/maxProtocol` 必须覆盖服务端版本（当前 3）。
4. 建议启用 device identity；否则权限与配对路径会受限。

## 5.2 鉴权与设备令牌策略（强烈建议直接复用）

关键优先级（客户端侧）：

- 显式 shared token/password
- 显式 deviceToken
- 本地缓存 deviceToken
- bootstrap token（特定场景）

推荐策略：

- 连接成功后持久化 `hello-ok.auth.deviceToken`
- 仅在可信端点下做一次 deviceToken 重试
- 对不可恢复 auth 错误暂停自动重连并提示人工处理

源码参考：

- `src/gateway/client.ts`
- `ui/src/ui/gateway.ts`
- `apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayChannel.swift`

## 5.3 角色与权限设计（避免“连上但不能用”）

- `operator` 与 `node` 方法面不同，不能混用。
- `scopes` 建议最小权限申请，按方法反推（`method-scopes.ts`）。
- 对写操作建议带 idempotency 语义（如 `chat.send` 的 `idempotencyKey`）。

## 5.4 事件流处理与状态一致性

- 处理 `seq` gap（发现缺口主动刷新状态）
- 订阅 `sessions.changed` + `session.message` 组合，保持 UI 状态一致
- 正确处理 `chat delta`/`final`/`error` 三态

## 5.5 网络与安全传输

- 远程接入优先 `wss://` + TLS 指纹校验
- `ws://` 仅建议 loopback 或明确受信环境
- 不要通过 URL query 传递敏感 token

## 5.6 需要改 Gateway 源码的典型场景

以下场景通常不能“纯客户端实现”：

1. 你要新增 `client.id` / `client.mode` 枚举值。
2. 你要新增 Gateway method/event。
3. 你要改变 role-scope 授权规则。
4. 你要改变 pairing/device identity 安全策略。

对应改动面：

- 协议 schema：`src/gateway/protocol/schema/*`
- 路由与处理器：`src/gateway/server-methods*.ts`
- 权限与策略：`src/gateway/method-scopes.ts`、`src/gateway/role-policy.ts`

---

## 6. 二开落地建议（实施顺序）

1. **先定接入类型**：Operator WS / Node WS / HTTP 兼容。
2. **先跑通握手**：`connect.challenge` + `connect` + `hello-ok`。
3. **先接最小方法集**：
   - Operator：`health`、`status`、`chat.send`、`chat.history`、`agent.wait`
   - Node：`node.event`、`node.invoke.result`、`node.pending.pull/ack`
4. **补全事件流**：`agent`、`chat`、`sessions.changed`、`session.message`。
5. **最后做增强**：deviceToken 缓存、TLS pinning、断线重连、错误分级恢复。

---

## 7. 复用结论（给二开决策）

## 7.1 可直接复用（默认路径）

满足以下条件时，Gateway 端通常无需修改：

- 你遵循现有 WS/HTTP 协议与字段约束
- 复用现有 `client.id/mode` 枚举之一
- 不新增 method/event，仅调用现有能力
- 不改变 auth/pairing/role-scope 安全边界

## 7.2 需要部分改造（扩展路径）

如果你要做“协议扩展或安全策略变更”，就需要改 Gateway 源码（不建议只在客户端绕过）：

- 新客户端身份枚举
- 新 RPC 能力
- 新权限模型
- 新鉴权机制

---

## 8. 总结

OpenClaw 的 Gateway 已经是可复用的“后端中枢”：

- 对外提供统一接入契约（WS/HTTP/hooks/plugin routes）
- 对内完成鉴权、路由、状态、事件与 agent/node 编排
- 对二开而言，最优策略是“遵循既有协议并复用现有客户端实现策略”，而不是自定义协议分叉

对你的场景，建议优先走 **WS 标准协议接入 + 现有 auth/device token 流程复用**，这样可以在最小改动下拿到最大兼容性与稳定性。
