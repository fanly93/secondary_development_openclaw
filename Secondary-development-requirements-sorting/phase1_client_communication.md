# Phase1 客户端通信与构建分析（OpenClaw）

## 1. 目标与范围

本文基于仓库源码梳理 OpenClaw 第一层客户端（CLI、Web UI、macOS/iOS/Android）与 Gateway 的**统一通信规范**、**实现差异**与**构建差异**，并给出二次开发/自定义客户端的接入建议与功能入口。

分析重点：

- 统一输出规范（客户端向 Gateway 的协议与握手）
- 各客户端实现的共性与差异
- 各客户端构建流程相同点与不同点
- 自定义客户端接入时必须满足的配置与规范

---

## 2. 统一通信规范（跨客户端共用）

### 2.1 统一传输层与帧模型

所有客户端都通过 **WebSocket + JSON 文本帧** 连接 Gateway，帧模型统一为三类：

- `req`：`{ type, id, method, params }`
- `res`：`{ type, id, ok, payload?, error? }`
- `event`：`{ type, event, payload?, seq?, stateVersion? }`

对应协议定义在：

- `src/gateway/protocol/schema/frames.ts`
- `src/gateway/protocol/schema.ts`
- `docs/gateway/protocol.md`

### 2.2 统一握手流程（必须先 connect）

所有客户端共享同一握手时序：

1. Gateway 先发 `event: connect.challenge`（含 `nonce`）
2. 客户端发送 `req: connect`
3. Gateway 返回 `res(ok=true, payload=hello-ok)` 或错误并关闭连接

服务端要求**第一帧必须是 connect**，并强校验 `ConnectParams`，入口见：

- `src/gateway/server/ws-connection/message-handler.ts`

### 2.3 connect 参数的统一主干

跨端统一字段（最关键）：

- 协议协商：`minProtocol` / `maxProtocol`（当前为 3）
- 客户端身份：`client.{id,version,platform,mode,instanceId,...}`
- 身份与权限：`role` + `scopes`
- 能力声明：`caps` / `commands` / `permissions`（node 角色更常用）
- 鉴权：`auth.{token|bootstrapToken|deviceToken|password}`
- 设备身份：`device.{id,publicKey,signature,signedAt,nonce}`（用于配对与绑定）
- 上下文：`locale` / `userAgent`

核心 schema 与校验：

- `src/gateway/protocol/schema/frames.ts`（`ConnectParamsSchema`）
- `src/gateway/server/ws-connection/message-handler.ts`（`validateConnectParams`）

### 2.4 统一角色语义

角色统一为：

- `operator`：控制面客户端（CLI/UI/自动化）
- `node`：能力提供端（设备能力执行）

服务端在握手中会：

- 解析并校验 `role`
- 对 `scopes` 做默认拒绝语义（未显式声明即无权限）
- 在无 device identity 时触发额外限制/拒绝逻辑

入口：

- `src/gateway/server/ws-connection/message-handler.ts`
- `src/gateway/method-scopes.ts`

### 2.5 统一鉴权与设备令牌闭环

所有客户端都围绕同一鉴权闭环：

- 可用 shared token/password/bootstrap token
- 若有设备身份，会下发并复用 `hello-ok.auth.deviceToken`
- `deviceToken` 按 `deviceId + role` 维度缓存
- 连接失败时按错误码决定是否重试、是否清理过期 token

相关实现：

- CLI/Node 通用：`src/gateway/client.ts`
- Web UI：`ui/src/ui/gateway.ts`、`ui/src/ui/device-auth.ts`
- iOS/macOS：`apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayChannel.swift`
- Android：`apps/android/app/src/main/java/ai/openclaw/app/gateway/GatewaySession.kt`

---

## 3. 各客户端通信实现对比

## 3.1 CLI（TypeScript）

通信链路：

- `src/cli/gateway-rpc.runtime.ts` -> `src/gateway/call.ts` -> `src/gateway/client.ts`

特点：

- 以 `callGateway(...)` 发起短连接 RPC（默认 operator）
- 默认客户端元信息来自 `GATEWAY_CLIENT_NAMES.CLI` / `GATEWAY_CLIENT_MODES.CLI`
- scopes 支持 least-privilege 自动推导（按方法映射）
- 同样执行 `connect.challenge` + 签名设备身份 + connect

适合：

- 运维/脚本调用
- 后端或工具化调用 Gateway RPC

## 3.2 Web UI（Control UI，TypeScript + 浏览器）

通信入口：

- `ui/src/ui/gateway.ts`

特点：

- `GatewayBrowserClient` 维护长连接 + 自动重连 + seq gap 检测
- 默认 `role=operator`，固定操作范围（含 admin/read/write/approvals/pairing）
- `caps` 默认声明 `["tool-events"]`
- 依赖浏览器安全上下文（`crypto.subtle`）决定是否可携带 device identity
- device token 使用浏览器本地存储（local/session storage）并按 gateway scope 隔离

服务端相关约束：

- origin 检查、Control UI 安全策略（allowedOrigins、insecure flags）
- 见 `src/gateway/server/ws-connection/message-handler.ts`

## 3.3 iOS/macOS（Swift，共享 OpenClawKit）

核心通道：

- `apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayChannel.swift`
- `apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayNodeSession.swift`

特点：

- 统一封装 `GatewayConnectOptions`（role/scopes/caps/commands/permissions/clientId/clientMode）
- 同样等待 `connect.challenge` 后发 `connect`
- 支持 operator 与 node 两类 session 并行（尤其 iOS）
- node 场景可通过 `node.event` 上报事件、通过 `node.invoke.result` 回传执行结果
- 支持 TLS pinning、设备 token 缓存、配对失败暂停重连

平台侧使用入口：

- iOS：`apps/ios/Sources/Model/NodeAppModel.swift`、`apps/ios/Sources/Gateway/GatewayConnectionController.swift`
- macOS app：`apps/macos/Sources/OpenClaw/NodeMode/MacNodeModeCoordinator.swift`
- macOS CLI：`apps/macos/Sources/OpenClawMacCLI/ConnectCommand.swift`、`WizardCommand.swift`

## 3.4 Android（Kotlin）

通信入口：

- `apps/android/app/src/main/java/ai/openclaw/app/gateway/GatewaySession.kt`
- `apps/android/app/src/main/java/ai/openclaw/app/node/ConnectionManager.kt`
- `apps/android/app/src/main/java/ai/openclaw/app/NodeRuntime.kt`

特点：

- 同步实现 connect challenge -> connect 请求
- connect 参数构造与协议字段与 Swift/TS 对齐（protocol/client/role/scopes/caps/...）
- 维护 operator session + node session 双通道
- node 侧支持 `node.event`、`node.invoke.request/result`
- 提供 TLS 参数与指纹校验路径

---

## 4. 统一点 vs 差异点（通信层）

### 4.1 统一点（必须一致）

- 同一 WS 协议与帧结构（req/res/event）
- 必须先完成 connect 握手
- connect 参数骨架一致（protocol/client/role/scopes/auth/device）
- 设备身份签名绑定 `nonce`
- 统一处理 `hello-ok`、事件流、错误码、重连
- 统一依赖服务端配对与权限判断（而非客户端自判）

### 4.2 差异点（实现策略不同）

- **默认 role/scopes**
  - CLI/Web UI：operator
  - 移动/桌面 node 通道：node（另开 operator 通道用于控制面）
- **caps/commands/permissions**
  - Web UI/CLI：通常为空（或 tool-events）
  - node 客户端：按设备能力动态上报（camera/location/canvas/...）
- **device identity 可用性**
  - 浏览器受 secure context 限制
  - 原生端通常可稳定持有设备身份
- **token 存储介质**
  - Web UI：浏览器存储
  - CLI：本地配置/环境变量/运行时
  - iOS/macOS/Android：平台本地存储（Keychain/SharedPrefs 等封装）
- **重连策略与 UI 行为**
  - Web UI：前端退避 + 页面态回调
  - 原生端：任务循环 + 状态机（连接态、配对暂停、TLS 提示）

---

## 5. 构建流程对比（客户端）

## 5.1 共性

- 都在 monorepo 内，以根 `package.json` 脚本统一调度
- 都围绕“客户端壳 + 同一 Gateway 协议”构建，而不是各自定义协议
- 都有专属测试/校验链路（TS: vitest，Android: gradle test，iOS/macOS: Xcode/SwiftPM tests）

## 5.2 差异（按平台）

### CLI（Node + TS）

- 入口：`openclaw.mjs` -> `dist/entry.js`（构建产物）
- 构建主线：根脚本 `build`（TS 打包 + 运行时拷贝等）
- 运行：`pnpm openclaw ...` / `pnpm dev`

### Web UI（Vite + Lit）

- UI 子包：`ui/package.json`
- 构建：`vite build`
- Dev：`vite`
- 根侧通过 `scripts/ui.js` 调度 `ui:dev` / `ui:build`

### Android（Gradle + Kotlin + Compose）

- 构建脚本：`apps/android/app/build.gradle.kts`
- 常用命令：`android:assemble`、`android:run`、`android:test`
- 支持 flavor（`play` / `thirdParty`），并区分 release 签名配置

### iOS（XcodeGen + Xcode）

- 工程源：`apps/ios/project.yml`
- 生成工程：`xcodegen generate`
- 根脚本：`ios:gen` / `ios:build` / `ios:run` / `ios:open`
- iOS App 与 Share Extension、Watch、Widget 同仓统一管理

### macOS（SwiftPM + App 打包脚本）

- 包定义：`apps/macos/Package.swift`
- 产物含 GUI app 与 CLI（`openclaw-mac`）
- 打包与重启由根脚本驱动：`mac:package` / `mac:restart`

---

## 6. 二次开发/自定义客户端：必须关注的配置与规范

## 6.1 最小接入规范（必须满足）

实现一个自定义客户端时，至少要做到：

1. 建立 WS 连接并处理 `connect.challenge`
2. 发送合法 `connect`（协议版本、client metadata、role/scopes、auth、device）
3. 支持 req/res/event 三类帧
4. 处理 `hello-ok` 并缓存必要 auth 信息（尤其 device token）
5. 处理错误码（未授权、配对、设备身份缺失等）与重连策略
6. 对 operator/node 角色采用正确的 scopes 与能力声明

建议直接对照：

- 协议：`src/gateway/protocol/schema/frames.ts`
- 服务端握手规则：`src/gateway/server/ws-connection/message-handler.ts`

## 6.2 自定义 Operator 客户端建议入口

优先复用/参考：

- TS：`src/gateway/client.ts`（Node 环境通用）
- 浏览器：`ui/src/ui/gateway.ts`
- Swift：`apps/shared/OpenClawKit/.../GatewayChannel.swift`
- Kotlin：`apps/android/.../GatewaySession.kt`

重点配置：

- `role: "operator"`
- `scopes`: 按最小权限申请（读写分离）
- `client.id/mode`: 明确标识并保持稳定
- `auth`: token/password/bootstrap token 之一
- `device`: 建议开启，避免受限模式

## 6.3 自定义 Node 客户端建议入口

优先复用/参考：

- Swift：`GatewayNodeSession.swift`
- Android：`GatewaySession.kt` + `ConnectionManager.kt`

重点配置：

- `role: "node"`
- `scopes`: 通常空数组（按服务端策略）
- `caps` / `commands` / `permissions`: 与本机真实能力一致
- 实现 `node.invoke.request` -> 执行 -> `node.invoke.result`
- 支持 `node.event` 主动上报（如 `agent.request`、设备状态等）

## 6.4 Gateway 侧配置关注点（与自定义客户端强相关）

- 鉴权模式：`gateway.auth.*`
- Control UI 安全项：`gateway.controlUi.allowedOrigins`
- 高风险开关（仅在明确场景下）：`allowInsecureAuth` / `dangerouslyDisableDeviceAuth` / `dangerouslyAllowHostHeaderOriginFallback`
- 远程连接建议 TLS/WSS + 指纹校验（移动端代码中已体现）

相关代码位置：

- `src/gateway/server/ws-connection/connect-policy.ts`
- `src/gateway/server/ws-connection/message-handler.ts`
- `src/security/audit.ts`

---

## 7. 客户端功能入口清单（便于二开定位）

- **协议定义**
  - `src/gateway/protocol/schema/frames.ts`
  - `src/gateway/protocol/index.ts`
  - `docs/gateway/protocol.md`

- **服务端握手/鉴权/配对**
  - `src/gateway/server/ws-connection/message-handler.ts`
  - `src/gateway/server/ws-connection/connect-policy.ts`

- **CLI**
  - `src/cli/gateway-rpc.runtime.ts`
  - `src/gateway/call.ts`
  - `src/gateway/client.ts`

- **Web UI**
  - `ui/src/ui/gateway.ts`
  - `ui/src/ui/device-auth.ts`
  - `ui/src/ui/storage.ts`

- **iOS / macOS 共享通信层**
  - `apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayChannel.swift`
  - `apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayNodeSession.swift`

- **iOS 应用层**
  - `apps/ios/Sources/Model/NodeAppModel.swift`
  - `apps/ios/Sources/Gateway/GatewayConnectionController.swift`
  - `apps/ios/ShareExtension/ShareViewController.swift`

- **Android 应用层**
  - `apps/android/app/src/main/java/ai/openclaw/app/gateway/GatewaySession.kt`
  - `apps/android/app/src/main/java/ai/openclaw/app/node/ConnectionManager.kt`
  - `apps/android/app/src/main/java/ai/openclaw/app/NodeRuntime.kt`

---

## 8. 二开落地建议（实践顺序）

1. 先选角色：`operator` 或 `node`（或双通道）
2. 直接实现 connect challenge + connect（先跑通 hello-ok）
3. 接入最小请求：`health`、`status`、`system-presence`
4. 再接事件流（tick/agent/presence）与 seq gap 恢复
5. 最后补齐鉴权升级（device token 缓存、pairing 错误处理、TLS pinning）

---

## 9. 结论

OpenClaw 的客户端通信是“**协议统一、实现分层、能力差异化声明**”：

- 协议和握手在所有客户端严格一致（统一 connect/frames/auth/device 语义）
- 差异主要体现在角色定位（operator/node）、能力声明（caps/commands/permissions）和平台构建链路
- 二次开发最关键的是：**不要自定义协议**，而是严格遵循现有 Gateway 协议与服务端策略

这使得你可以按统一规范扩展任意新客户端，同时保持与现有 CLI/Web UI/原生端的一致行为与安全边界。
