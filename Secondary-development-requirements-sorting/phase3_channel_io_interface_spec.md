# Phase3 Channel 统一输入输出接口规范（OpenClaw）

## 1. 文档目标

本文面向“自定义 channel 接入 OpenClaw”的二次开发场景，回答一个核心问题：

- 是否存在跨 channel（飞书、Telegram、WhatsApp 等）的统一输入/输出接口规范？
- 如果存在，这套规范具体是什么，如何基于它实现一个可运行的自定义 channel？

本文结论与规范全部基于源码契约，而非抽象推测。

---

## 2. 结论（先看这个）

存在，且是**强约束的统一契约**，不是“约定俗成”。

统一性体现在 3 层：

1. **Channel 插件契约层（注册与能力声明）**
   - `ChannelPlugin` 作为统一能力模型。
2. **入站输入层（消息交给 agent 前）**
   - 统一收敛到 `MsgContext`，并经 `finalizeInboundContext(...)` 标准化，再进入 `dispatchInboundMessage(...)`。
3. **出站输出层（agent 回复返回 channel）**
   - 统一 `ReplyPayload` 载荷模型，统一 `ChannelOutboundAdapter` 发送契约，最终统一产出 `OutboundDeliveryResult`。

换句话说：  
**各 channel 内部流程可不同，但想接入同一 agent 架构，必须满足同一 I/O 契约。**

---

## 3. 契约落点总览（源码坐标）

### 3.1 Channel 顶层能力契约

- `src/channels/plugins/types.plugin.ts`
  - `ChannelPlugin`：channel 插件统一接口

### 3.2 入站统一模型

- `src/auto-reply/templating.ts`
  - `MsgContext` / `FinalizedMsgContext`
- `src/auto-reply/reply/inbound-context.ts`
  - `finalizeInboundContext(...)`
- `src/auto-reply/dispatch.ts`
  - `dispatchInboundMessage(...)`

### 3.3 出站统一模型

- `src/auto-reply/types.ts`
  - `ReplyPayload`
- `src/channels/plugins/types.adapters.ts`
  - `ChannelOutboundAdapter`
- `src/infra/outbound/deliver.ts`
  - 统一出站发送总线（按 channel adapter 执行）
- `src/infra/outbound/deliver.ts`
  - `OutboundDeliveryResult`
- `src/plugin-sdk/reply-payload.ts`
  - `resolveSendableOutboundReplyParts(...)` 等出站规范化工具

### 3.4 注册与加载链路

- `src/plugin-sdk/channel-entry-contract.ts`
  - `defineBundledChannelEntry(...)` + `api.registerChannel(...)`
- `src/plugins/registry.ts`
  - `registerChannel(...)`
- `src/channels/plugins/outbound/load.ts`
  - `loadChannelOutboundAdapter(...)`

---

## 4. Channel 统一输入接口规范（Inbound）

## 4.1 统一入站执行入口

无论消息来自哪个 channel，进入 agent 的统一执行口都是：

- `dispatchInboundMessage({ ctx, cfg, dispatcher, replyOptions })`
- 文件：`src/auto-reply/dispatch.ts`

其中 `ctx` 必须是 `MsgContext`（或已完成标准化的 `FinalizedMsgContext`）。

---

## 4.2 统一输入数据结构：`MsgContext`

`MsgContext` 定义于 `src/auto-reply/templating.ts`，字段很多，但可按“强制/推荐/增强”分层使用：

### A. 最小可用字段（建议作为自定义 channel 的硬要求）

- `Body`：用户消息文本
- `SessionKey`：会话键
- `From` / `To`：消息来源与目标（至少可追踪）
- `Provider` 或 `Surface`：channel 标识（如 `telegram`、`feishu`）
- `OriginatingChannel` / `OriginatingTo`：用于回复路由回原始通道

> 说明：类型层面不会强制这些字段全都必填，但缺失会导致“可运行但不可用”或路由/会话行为异常。

### B. 路由与线程推荐字段（建议默认实现）

- `AccountId`
- `MessageThreadId`
- `ReplyToId`
- `ChatType`（direct/group/channel）
- `NativeChannelId`（平台原生会话 id）

### C. 媒体与上下文增强字段（可选）

- `MediaPath` / `MediaPaths`
- `MediaUrl` / `MediaUrls`
- `MediaType` / `MediaTypes`
- `SenderId` / `SenderUsername` / `SenderName`
- `ConversationLabel` / `GroupSubject`

---

## 4.3 入站标准化规则（系统自动执行）

`finalizeInboundContext(...)`（`src/auto-reply/reply/inbound-context.ts`）会做统一规范化：

1. 文本清洗与换行规范化（`Body`、`RawBody`、`CommandBody` 等）
2. `BodyForAgent` 回退链路补齐（优先显式值，否则回退到 clean body）
3. `BodyForCommands` 回退链路补齐
4. `ConversationLabel` 自动补全
5. `CommandAuthorized` 强制布尔化（默认 deny，即 `false`）
6. 媒体类型对齐：
   - 有媒体但缺类型时补 `application/octet-stream`
   - `MediaType` / `MediaTypes` 与媒体数量对齐

这意味着你在自定义 channel 里可以先构建“业务语义正确”的 `MsgContext`，再交给统一标准化层做补齐与安全收敛。

---

## 4.4 入站结果接口

`dispatchReplyFromConfig(...)` 返回：

- `DispatchFromConfigResult = { queuedFinal: boolean; counts: Record<ReplyDispatchKind, number> }`
- 文件：`src/auto-reply/reply/dispatch-from-config.ts`

这是一套统一的“本次入站是否排队出最终回复、分发计数”反馈契约。

---

## 5. Channel 统一输出接口规范（Outbound）

## 5.1 统一输出载荷：`ReplyPayload`

定义在 `src/auto-reply/types.ts`：

- `text?: string`
- `mediaUrl?: string`
- `mediaUrls?: string[]`
- `interactive?: InteractiveReply`
- `replyToId?: string`
- `audioAsVoice?: boolean`
- `isError?: boolean`
- `isReasoning?: boolean`
- `channelData?: Record<string, unknown>`（channel 扩展数据）

其中 `channelData` 是关键扩展位：  
统一外壳 + channel 私有能力，不破坏核心契约。

---

## 5.2 统一发送适配器：`ChannelOutboundAdapter`

定义在 `src/channels/plugins/types.adapters.ts`，核心点：

- `deliveryMode: "direct" | "gateway" | "hybrid"`（必选）
- `sendText(...)`（对“可发送 channel”基本是必需）
- 可选：`sendMedia(...)`、`sendPayload(...)`、`chunker(...)`、`sanitizeText(...)`、`normalizePayload(...)` 等

统一发送总线在 `src/infra/outbound/deliver.ts`：

- 通过 `loadChannelOutboundAdapter(channelId)` 动态加载对应 channel 的 outbound adapter
- 若 adapter 无法提供有效发送能力，会报：
  - `Outbound not configured for channel: <id>`

这说明：  
**你可以自定义发送细节，但必须挂在统一 outbound adapter 上。**

---

## 5.3 统一发送结果：`OutboundDeliveryResult`

定义在 `src/infra/outbound/deliver.ts`：

- `channel`
- `messageId`
- 可选：`chatId/channelId/roomId/conversationId/timestamp/toJid/pollId/meta`

`meta` 用于放置 channel 私有返回字段，避免污染核心返回契约。

---

## 5.4 路由与线程的统一钩子（输出前）

`routeReply(...)`（`src/auto-reply/reply/route-reply.ts`）在实际发送前会调用 channel 可选钩子：

- `plugin.messaging.transformReplyPayload(...)`
- `plugin.messaging.hasStructuredReplyPayload(...)`
- `plugin.threading.resolveReplyTransport(...)`

结论：  
**统一发送前，系统给了 channel 一个“标准化后的最后改写窗口”。**

---

## 6. “统一契约 + 差异实现”示例（源码对照）

## 6.1 Telegram

- `extensions/telegram/src/channel.ts`
  - 使用 `createChatChannelPlugin(...)`
  - 实现 `messaging`、`gateway.startAccount`、`outbound`

## 6.2 Feishu

- `extensions/feishu/src/channel.ts`
  - 同样使用 `createChatChannelPlugin(...)`
  - 也实现 `messaging`、`gateway.startAccount`、`outbound`

这两个 channel 的内部逻辑明显不同，但都遵循同一套 I/O 契约。

---

## 7. 自定义 Channel 的最小落地蓝图

这里给出“最小可运行”的推荐骨架（优先参考 `qa-channel` 实现）：

- 参考：`extensions/qa-channel/src/channel.ts`

### 7.1 文件建议

1. `extensions/<your-channel>/openclaw.plugin.json`
2. `extensions/<your-channel>/index.ts`
3. `extensions/<your-channel>/src/channel.ts`
4. `extensions/<your-channel>/src/monitor.ts`（接收外部平台事件）
5. `extensions/<your-channel>/src/outbound.ts`（发送适配）
6. `extensions/<your-channel>/src/accounts.ts`（多账号配置解析）

### 7.2 注册入口（必须）

- 在 `index.ts` 使用 `defineBundledChannelEntry(...)`
- 在 plugin manifest 中声明 `"channels": ["<your-channel-id>"]`

### 7.3 Channel 主体（必须）

在 `src/channel.ts` 构建 `createChatChannelPlugin({...})`：

- `base.id/meta/capabilities`
- `base.config`（`listAccountIds`、`resolveAccount` 至少实现）
- `base.gateway.startAccount`（启动连接/监听）
- `outbound.deliveryMode + sendText`（至少能发文本）
- `messaging.normalizeTarget`（建议实现）
- `messaging.resolveOutboundSessionRoute`（建议实现）

### 7.4 入站打通（必须）

在 monitor 中：

1. 接收平台事件
2. 映射为 `MsgContext`
3. 调用 `dispatchInboundMessage(...)`

最低建议确保以下字段存在：

- `Body`
- `SessionKey`
- `From` / `To`
- `Provider` / `Surface`
- `OriginatingChannel`
- `OriginatingTo`
- `CommandAuthorized`（即使不传也会被标准化层置为 `false`）

### 7.5 出站打通（必须）

在 outbound 中实现（至少）：

- `sendText(ctx)`
- 如支持媒体再实现 `sendMedia(ctx)`
- 根据需要实现 `chunker`/`textChunkLimit`/`normalizePayload`

---

## 8. 接入验收清单（建议直接照此自测）

## 8.1 合同层验收

- [ ] `openclaw.plugin.json` 包含 `channels` 声明
- [ ] `index.ts` 使用 `defineBundledChannelEntry(...)`
- [ ] `ChannelPlugin` 包含有效 `id/meta/capabilities/config`

## 8.2 入站验收

- [ ] monitor 收到外部消息后可进入 `dispatchInboundMessage(...)`
- [ ] `MsgContext` 至少包含最小可用字段
- [ ] 同一会话可持续命中相同 `SessionKey`
- [ ] 群聊/线程消息 `ChatType`、`MessageThreadId` 正确

## 8.3 出站验收

- [ ] agent 文本回复可成功发送到目标平台
- [ ] 多媒体回复（若支持）可按顺序发送
- [ ] `replyTo` / thread 行为符合平台语义
- [ ] 回执可得到 `messageId`（`OutboundDeliveryResult`）

## 8.4 生命周期验收

- [ ] `gateway.startAccount` 能拉起 channel 连接
- [ ] 配置变更后可按账号重启
- [ ] 断线可恢复（按 channel 自身策略）

---

## 9. 常见误区与规避建议

1. **误区：只实现平台 SDK 收发，不走统一契约**
   - 后果：无法无缝接入 agent/gateway 路由与会话体系。
   - 规避：入站一定走 `MsgContext + dispatchInboundMessage`，出站一定挂 `ChannelOutboundAdapter`。

2. **误区：不设置 `OriginatingChannel/OriginatingTo`**
   - 后果：回复回流可能走错路由或退回内部通道。
   - 规避：入站上下文明确写入原始 channel 与目标地址。

3. **误区：忽略 `config` 适配器**
   - 后果：多账号、启停、状态探测难以稳定。
   - 规避：至少实现 `listAccountIds` + `resolveAccount` + `isConfigured`。

4. **误区：outbound 未实现 `sendText`**
   - 后果：统一发送链路报 `Outbound not configured for channel`。
   - 规避：最小可用实现中把 `sendText` 作为强制项。

5. **误区：把 channel 私有数据塞进公共字段**
   - 后果：污染公共协议，后续升级风险高。
   - 规避：使用 `ReplyPayload.channelData` / `OutboundDeliveryResult.meta` 承载私有扩展。

---

## 10. 一句话总结（给后续开发决策）

OpenClaw 的 channel 接入不是“每个渠道各写各的”，而是：

- **统一 I/O 契约（必须遵守）**
- **差异化平台实现（可以自由发挥）**

这正是它能同时支持多 channel 并共享同一 agent 架构的核心原因。
