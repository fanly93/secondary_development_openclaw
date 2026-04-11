# Phase4 Agent 运行时架构拆解规范（OpenClaw）

## 1. 文档目标

本文面向“深入理解 OpenClaw Agent 内部实现与二次开发扩展”的场景，围绕你指定的 5 个核心方向进行源码级拆解：

1. Agent 底层技术架构
2. 大模型接入方式与支持模型类型
3. tools / skills / MCP 的接入与执行
4. 记忆系统（memory）设计与接入
5. 会话系统（session）设计与接入

同时补充当前架构中“容易被忽略但非常关键”的运行时模块，形成可用于二开评审的完整技术视图。其中 **自定义 Skill（含插件捆绑）** 的落地规范集中在 **§6.5**，可与 Phase3 Channel 规范配合使用。

---

## 2. 总结结论（先看）

OpenClaw 的 Agent 不是单体“模型调用器”，而是一个分层运行时系统：

- **入口编排层**：Gateway/HTTP/CLI 统一转为 `agentCommandFromIngress(...)`
- **命令控制层**：`prepareAgentCommandExecution(...)` 负责会话、模型、技能、工作区、权限整合
- **执行引擎层**：`runEmbeddedPiAgent(...)` 负责双队列串行、fallback、compaction、稳定性恢复
- **单次 attempt 组装层**：`runEmbeddedAttempt(...)` 负责系统提示词、tools、MCP、LSP、流式推理与落盘
- **扩展能力层**：插件、hooks、context-engine、memory-runtime、sandbox、安全策略等横切能力

一句话：**它是“可扩展的编排式 Agent Runtime”，而非单纯的 LLM SDK 包装。**

---

## 3. 全局调用链（运行时主路径）

典型请求（WS/HTTP/CLI）最终收敛为：

`gateway/server-methods/agent.ts`  
-> `src/commands/agent.ts`（转导出）  
-> `src/agents/agent-command.ts::agentCommandFromIngress(...)`  
-> `prepareAgentCommandExecution(...)`  
-> `runWithModelFallback(...) + runAgentAttempt(...)`  
-> `src/agents/pi-embedded-runner/run.ts::runEmbeddedPiAgent(...)`  
-> `src/agents/pi-embedded-runner/run/attempt.ts::runEmbeddedAttempt(...)`  
-> SessionManager / tool 执行 / 事件流 / transcript 持久化  
-> 回传 payload + usage + lifecycle

其中主入口与适配层：

- Gateway RPC：`src/gateway/server-methods/agent.ts`
- OpenAI/OpenResponses HTTP：`src/gateway/openai-http.ts`、`src/gateway/openresponses-http.ts`
- 命令入口导出：`src/commands/agent.ts`

---

## 4. 模块一：Agent 底层技术架构

## 4.1 分层职责

### A. 入口编排（Ingress Orchestration）

- 核心：`src/gateway/server-methods/agent.ts`
- 职责：
  - 参数校验（`validateAgentParams`/`validateAgentWaitParams`）
  - 组装 ingress options（sender 权限、sessionKey、attachments、delivery）
  - 异步触发 `agentCommandFromIngress(...)`
  - 通过 `runId` 与 dedupe 机制支持 `accepted/final` 双阶段响应

### B. 命令控制（Command Controller）

- 核心：`src/agents/agent-command.ts`
- 关键方法：
  - `prepareAgentCommandExecution(...)`
  - `agentCommandInternal(...)`
  - `agentCommandFromIngress(...)`
- 职责：
  - 统一解析 message/session/model/timeout/workspace/skillsSnapshot
  - 严格区分本地 trusted 与 ingress trust boundary（`senderIsOwner`、`allowModelOverride` 必填）
  - 分流 ACP 与 Embedded Pi 两条执行路径

### C. 执行引擎（Embedded Runner）

- 核心：`src/agents/pi-embedded-runner/run.ts::runEmbeddedPiAgent(...)`
- 职责：
  - 运行级串行控制（session lane + global lane）
  - 模型解析与 auth profile 轮转
  - 异常分类恢复（rate-limit/overload/overflow/timeout）
  - compaction、tool-result-truncation、retry、fallback

### D. Attempt 组装（Prompt + Tool + Session Assembly）

- 核心：`src/agents/pi-embedded-runner/run/attempt.ts::runEmbeddedAttempt(...)`
- 职责：
  - 组装 system prompt（bootstrap + skills + runtime + provider contribution）
  - 构造工具集合（core tools + plugin tools + MCP + LSP + client tools）
  - 准备 SessionManager、写锁、历史窗口、流式输出、落盘

## 4.2 执行并发模型（非常关键）

`runEmbeddedPiAgent(...)` 内部采用“双层串行”：

- 会话串行：`resolveSessionLane(...)`，确保同会话不并发写
- 全局串行/分 lane：`resolveGlobalLane(...)`，避免全局资源竞争
- 队列执行器：`src/process/command-queue.ts::enqueueCommandInLane(...)`

这套机制是稳定性的底盘，避免了 transcript 并发破坏与跨会话执行互相污染。

---

## 5. 模块二：大模型接入方式与支持类型

## 5.1 模型引用与解析

- 统一引用格式：`provider/model`
- 关键实现：
  - `src/agents/model-selection.ts::parseModelRef(...)`
  - `normalizeModelRef(...)`
  - `resolveConfiguredModelRef(...)`

支持别名索引、provider 归一化、模型 ID 归一化，以及 session/agent 维度的覆盖逻辑。

## 5.2 模型目录与发现机制

- 关键实现：`src/agents/model-catalog.ts::loadModelCatalog(...)`
- 聚合来源：
  - Pi SDK registry
  - `models.providers` 显式配置
  - provider plugin 补充目录（`augmentModelCatalogWithProviderPlugins(...)`）
- 输出字段包含：
  - `contextWindow`
  - `reasoning`
  - `input`（`text | image | document`）

## 5.3 models.json 运行时生成与一致性

- 关键实现：`src/agents/models-config.ts::ensureOpenClawModelsJson(...)`
- 特点：
  - 基于配置快照 + env + authProfiles 构建 fingerprint
  - 原子写入 + 写锁串行 + 缓存命中
  - 避免临时依赖抖动导致 catalog “毒化缓存”

## 5.4 运行时 fallback / failover

- 关键实现：
  - `src/agents/model-fallback.ts::runWithModelFallback(...)`
  - `src/agents/agent-command.ts` 中 fallback loop + `LiveSessionModelSwitchError`
  - `src/agents/pi-embedded-runner/run.ts` 内 failover policy

能力包括：

- 候选模型链路重试
- auth profile 轮转
- cooldown/probe 策略
- rate-limit/overload/timeout/overflow 分类恢复

## 5.5 支持的“模型类型”结论

按能力维度（源码可验证）：

- 文本模型
- 多模态输入模型（`image`、`document`）
- reasoning/thinking 模型
- tool-calling 模型
- provider-native transport 模型（含 SSE/WS/定制 streamFn）

按厂商维度：架构是“provider 插件化”，并不硬编码某单一供应商。

---

## 6. 模块三：tools / skills / MCP 接入与执行

## 6.1 Tools 总装配

- 核心：`src/agents/pi-tools.ts::createOpenClawCodingTools(...)`
- 组合层次：
  - 基础 coding tools（读写改、exec、process 等）
  - OpenClaw 内置业务工具（`src/agents/openclaw-tools.ts`）
  - plugin tools（`resolvePluginTools(...)`）
  - 执行策略包装（owner/group/sandbox/subagent/provider/message）
  - hook 包装（`before_tool_call`）
  - abort signal 包装

## 6.2 OpenClaw 内置工具谱系

`src/agents/openclaw-tools.ts::createOpenClawTools(...)` 组装了大量系统工具，如：

- 会话工具：`sessions_list`、`sessions_history`、`sessions_send`、`sessions_spawn`、`sessions_yield`
- 消息与通道：`message`、`gateway`
- 任务与编排：`cron`、`subagents`
- 多媒体：`image_generate`、`video_generate`、`music_generate`、`pdf`、`tts`
- 外部检索：`web_search`、`web_fetch`

## 6.3 Skills 机制

关键实现：

- 发现：`loadWorkspaceSkillEntries(...)`
- 快照：`buildWorkspaceSkillSnapshot(...)`
- 注入：`resolveSkillsPromptForRun(...)`
- 监听：`ensureSkillsWatcher(...)`

源码位置：

- `src/agents/skills/workspace.ts`
- `src/agents/skills/refresh.ts`

特点：

- 支持多来源技能目录（workspace / user / managed / bundled / plugin / extraDirs）
- 支持技能过滤、可见性控制、prompt budget 截断与 compact 格式降级
- 通过 snapshot version 避免每轮全量重建

**自定义 Skill 的完整二开规范**（目录、manifest、dist-runtime、配置与验收）见 **§6.5**（位于 MCP 小结之后）。

## 6.4 MCP 接入机制

### 运行时管理

- `src/agents/pi-bundle-mcp-runtime.ts`
  - `createSessionMcpRuntime(...)`
  - `getOrCreateSessionMcpRuntime(...)`

### 工具物化

- `src/agents/pi-bundle-mcp-materialize.ts::materializeBundleMcpToolsForRun(...)`
  - 服务器与工具名安全化
  - 保留名冲突规避
  - 稳定排序（保证 prompt cache 稳定性）

### 配置来源与传输

- 配置合并：`src/agents/embedded-pi-mcp.ts::loadEmbeddedPiMcpConfig(...)`
- 传输适配：`src/agents/mcp-transport.ts`（`stdio` / `sse` / `streamable-http`）

## 6.5 自定义 Skill 开发规范（二开指导）

本节总结在 OpenClaw 中**自行实现并交付** Skill（尤其随 **bundled 工作区插件** 发布的 Skill）时必须遵守的契约与常见踩坑，便于后续新增 Skill 时直接照做。

### 6.5.1 适用范围

| 类型                           | 说明                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| 工作区 Skill                   | 位于 `<agentWorkspace>/skills/<name>/` 或 `<workspace>/.agents/skills/` 等，由用户或同步脚本维护            |
| ClawHub 安装 Skill             | 通过 `openclaw skills install` 等进入 managed/workspace 目录，不依赖插件 manifest                           |
| **插件捆绑 Skill（本节重点）** | 位于 `extensions/<plugin-id>/skills/<skill-key>/`，由插件根目录 `openclaw.plugin.json` 的 `skills` 字段声明 |

Skill 与 **Channel 入站/出站**（Phase3）正交：同一 Skill 可被多通道使用；插件只是将 Channel 实现与可选 Skill 包放在同一仓库中发布。

### 6.5.2 目录结构与 manifest

1. **单包目录**：每个 Skill 一个子目录，根文件必须为 **`SKILL.md`**（可含 frontmatter）。
2. **推荐布局**：`extensions/<plugin-id>/skills/<skill-key>/SKILL.md`，可选 `scripts/`、`assets/` 等；脚本路径在 `SKILL.md` 正文中写相对说明（模型执行时以 skill 目录为基准解析）。
3. **插件清单**：在 `extensions/<plugin-id>/openclaw.plugin.json` 中声明技能根，例如：
   - `"skills": ["./skills"]`
   - 路径相对于**插件根目录**；可指向多个根目录（数组多项）。
4. **Frontmatter**：至少包含 `name`（全局合并时的技能键，与目录名建议一致）、`description`。可选使用 OpenClaw 约定的元数据声明依赖（如 `requires.bins`、`requires.env`、`primaryEnv`），以便 `openclaw skills check` 与 Control UI 展示「缺依赖 / 就绪」状态。公共语义见仓库内 `docs/tools/skills-config.md` 与官方文档 [Skills](https://docs.openclaw.ai/tools/skills)。

### 6.5.3 发现、合并与源码落点

- **统一入口**：`loadWorkspaceSkillEntries(...)` → 内部 `loadSkillEntries(...)`（`src/agents/skills/workspace.ts`）。
- **插件技能根**：`resolvePluginSkillDirs({ workspaceDir, config })`（`src/agents/skills/plugin-skills.ts`）根据 `loadPluginManifestRegistry` 扫描已激活插件的 `skills` 路径，将目录并入 `skills.load.extraDirs` 同类逻辑（来源标记为 **`openclaw-extra`**）。
- **合并与覆盖**：多来源技能按固定顺序合并到 `Map<skill.name, Skill>`，**同名后者覆盖前者**；需避免与内置或其它插件 **技能名冲突**。
- **快照与注入**：`buildWorkspaceSkillSnapshot(...)`、`resolveSkillsPromptForRun(...)`、`ensureSkillsWatcher(...)`（同目录 `workspace.ts`、`refresh.ts`）；会话侧刷新见 `src/auto-reply/reply/session-updates.ts`。

### 6.5.4 插件激活与「为何列表里没有」

插件自带目录只有在其 **运行时判定为已激活** 时才会参与 `resolvePluginSkillDirs`：

- **Agent workspace**：`workspaceDir` 来自 `resolveAgentWorkspaceDir(config, agentId)`（`src/agents/agent-scope.ts`）；若为空则**不会**附加任何插件 skill 根（早期常见问题）。
- **激活策略**：`resolveEffectivePluginActivationState` / `resolvePluginActivationState`（`src/plugins/config-policy.ts`，供 skill 扫描使用）须与 `config-state` 语义一致：例如配置了 **`plugins.allow`** 时，**已通过 channel / entries 显式启用的 bundled 插件**不得被 allow 列表误拦截，否则插件未激活 → 整包 `./skills` 不出现。
- **Memory 槽位等**：仅影响带 `memory` kind 的插件；普通 channel 插件一般不受影响（`src/plugins/config-policy.ts` 中 `resolveMemorySlotDecision`）。

### 6.5.5 dist、dist-runtime 与路径预期（本地开发必读）

源码检出下，bundled 插件根常解析为 **`dist-runtime/extensions/<plugin-id>`**（当存在成对的 `dist/extensions` 与 staging 结果时），见 `src/plugins/bundled-dir.ts`。

- **Staging 规则**：`scripts/stage-bundled-plugin-runtime.mjs` 将 `dist/extensions/<plugin>` 镜像到 `dist-runtime/extensions/<plugin>`。其中 **`skills/` 树下的文件必须以物理拷贝形式存在**，不得依赖指向 `dist/extensions/...` 的符号链接作为最终交付物；否则 `loadSkills` 内对 `realpath` 的**包含关系校验**会认为路径逃出配置的 skill 根，日志出现 `Skipping skill path that resolves outside its configured root.`，该插件下所有 pack skill 被静默丢弃（飞书 / Web UI 均看不到）。
- **开发闭环**：编辑 `extensions/<plugin>/skills/...` → 执行 **`pnpm build`**（或 `watch-node.mjs gateway` 触发的完整构建链，确保重新 stage）→ **重启 gateway**，再在 Control UI 或 `openclaw skills check` 验证。
- **运行时路径**：模型或工具日志中出现 **`.../dist-runtime/extensions/<plugin>/skills/<skill-key>/scripts/...`** 属于本地开发下的**预期现象**；发布安装形态下前缀会随安装目录变化，语义不变。

### 6.5.6 Agent 技能白名单（prompt 可见性）

若配置中设置了 **`agents.defaults.skills`** 或 **`agents.list[].skills`**（最终白名单语义），则仅列表中的 `name` 会进入面向模型的技能提示；**未列入则即使用插件已扫描到也会在 prompt 层被滤掉**。未配置该字段则默认不限制。详见 `docs/tools/skills-config.md` 与 schema 说明。

### 6.5.7 密钥、进程环境与技能脚本

- Skill 内脚本通常直接读取 **`process.env`**（如 Tavily 的 `TAVILY_API_KEY`）。
- 变量必须对 **gateway / agent 宿主进程** 可见：可通过 `openclaw.json` 顶层 **`env`**、`~/.openclaw/.env`、仓库 `.env`（开发）、或系统环境注入；优先级以运行时加载顺序为准（参见仓库 `.env.example` 注释）。
- 可选 per-skill 覆盖：`skills.entries.<skillKey>.env` / `apiKey`（见官方 Skills 配置文档）。

### 6.5.8 验收清单（建议发布前自测）

- [ ] `SKILL.md` 存在且 `name` 唯一；manifest 中 `skills` 路径存在且可读。
- [ ] 插件在目标环境中为 **activated**（channel enabled / entries / 不与 `plugins.allow` 冲突）。
- [ ] `pnpm build`（或 CI 等价物）后 **`dist-runtime/.../skills/<skill-key>/`** 下关键文件为**实文件**而非指向 `dist/` 外链的 symlink（必要时检查 `SKILL.md`、入口脚本）。
- [ ] `openclaw skills check` 或 Control UI **Skills** 页能列出该技能；若声明了 env/bin，确认「缺依赖」状态符合预期。
- [ ] 若使用技能白名单，已将 **`name`** 写入 `agents.defaults.skills` 或对应 `agents.list[].skills`。
- [ ] 飞书 / 其它通道：**新会话或触发 skills 快照刷新** 后再测，避免沿用旧 `<available_skills>`。

### 6.5.9 架构边界与禁止事项

- Skill 说明与脚本：**不得**依赖未公开的 core 深路径 `src/**` 作为稳定契约；插件生产代码应通过 `openclaw/plugin-sdk/*` 与 manifest 表达扩展（与仓库 `AGENTS.md` 插件边界一致）。
- 避免与内置 bundled skill **同名**；保持 `SKILL.md` 体积与扫描上限在默认限制内（见 `resolveSkillsLimits`）。

---

## 7. 模块四：记忆系统（Memory）设计与接入

## 7.1 三层记忆架构

### A. 文件记忆层

- 以 agent workspace 为中心的 Markdown 持久化（如 `MEMORY.md`、`memory/*.md`）
- 作为长期语义记忆的可审计载体

### B. 检索层（Memory Search）

- 核心：`src/agents/memory-search.ts::resolveMemorySearchConfig(...)`
- 能力：
  - provider/fallback
  - 向量 + 关键词 hybrid
  - chunking / sync / cache
  - multimodal memory embedding

### C. 插件运行时层

- 全局注册与读取：
  - `src/plugins/memory-state.ts`
  - `registerMemoryRuntime(...)`
  - `registerMemoryPromptSection(...)`
  - `registerMemoryFlushPlanResolver(...)`
- 激活与访问：
  - `src/plugins/memory-runtime.ts::getActiveMemorySearchManager(...)`
- embedding provider 解析：
  - `src/plugins/memory-embedding-provider-runtime.ts`

## 7.2 自动 memory flush 门控

- 核心：`src/auto-reply/reply/memory-flush.ts`
  - `shouldRunMemoryFlush(...)`
  - `hasAlreadyFlushedForCurrentCompaction(...)`
  - `computeContextHash(...)`

门控维度：

- token 压力阈值
- compaction 周期去重
- transcript 上下文哈希去重

目标是“减少重复写记忆”和“在压缩前保留高价值上下文”。

## 7.3 ContextEngine 可插拔框架

- 接口定义：`src/context-engine/types.ts`
- 注册与解析：`src/context-engine/registry.ts`、`resolveContextEngine(...)`
- 默认实现：`src/context-engine/legacy.ts::LegacyContextEngine`
- 初始化：`src/context-engine/init.ts::ensureContextEnginesInitialized(...)`

ContextEngine 将 `bootstrap / maintain / ingest / assemble / compact / afterTurn` 全流程标准化，是替换默认上下文策略的正式扩展点。

---

## 8. 模块五：会话系统（Session）设计与接入

## 8.1 会话解析与路由

- 核心：`src/agents/command/session.ts`
  - `resolveSessionKeyForRequest(...)`
  - `resolveSession(...)`

能力：

- `to/sessionId/sessionKey/agentId` 联合解析
- 按 session policy 判断 freshness（日切、空闲、reset）
- 兼容跨 agent store 的同 sessionId 匹配选择

## 8.2 元数据存储层（sessions.json）

- 核心：`src/config/sessions/store.ts`
- 能力：
  - 归一化 key
  - 合并与维护（prune/cap/rotate/disk budget）
  - 写缓存与对象缓存
  - ACP 元数据保留策略

## 8.3 转录层（\*.jsonl）

- 核心：`src/config/sessions/transcript.ts`
  - `resolveSessionTranscriptFile(...)`
  - transcript header 初始化
  - 幂等 append（idempotency key 检测）

## 8.4 并发一致性保障

### 文件写锁

- `src/agents/session-write-lock.ts::acquireSessionWriteLock(...)`
- 机制：
  - `.lock` 文件 + PID/starttime 校验
  - stale lock 清理
  - watchdog 强制释放

### 命令队列

- `src/process/command-queue.ts::enqueueCommandInLane(...)`
- `src/agents/pi-embedded-runner/lanes.ts`
  - `resolveSessionLane(...)`
  - `resolveGlobalLane(...)`

这一组机制保证 transcript 与 session store 在并发场景下可恢复、可追踪、可串行化。

---

## 9. 你原先 5 点之外的关键“遗漏模块”

下面这些模块不属于你列的 5 个基础项，但在 OpenClaw 架构里同样是“主干能力”：

## 9.1 ACP 双运行时路径

- 文件：`src/agents/agent-command.ts`
- 当 `acpResolution.kind === "ready"` 时，走 ACP turn 流程（`acpManager.runTurn(...)`），不是 Embedded Pi 主循环。
- 意义：同一入口，存在两套执行内核；二开时必须明确目标运行时。

## 9.2 Compaction 与超长会话恢复

- 文件：`src/agents/pi-embedded-runner/run.ts`
- 包含 timeout-triggered compaction、overflow compaction、tool-result truncation、多轮 retry。
- 意义：决定“长会话可持续运行”的上限。

## 9.3 Hook 生命周期扩展

- 关键点分布在 runner/attempt 与工具包装逻辑中（例如 prompt build、tool call 前后）。
- 意义：插件可在不改核心代码的情况下改变 Agent 行为。

## 9.4 Sandbox 与工具安全边界

- 关键文件：`src/agents/pi-tools.ts`、`src/agents/sandbox/*`
- 包含 workspace-only、sandbox bridge、owner-only、group-policy、subagent-policy。
- 意义：这是“可执行 agent”安全闭环，不能当成可选功能。

## 9.5 Prompt Cache 稳定性保障

- 在 attempt 里对工具名、MCP 工具顺序、prompt 组装顺序做稳定化处理。
- 意义：直接影响多轮对话延迟与成本，不是纯性能优化项，而是运行时一致性约束。

## 9.6 子代理编排（Subagent）

- 体现于 `sessions_spawn`、`subagents` 工具、spawned context 与 session 继承模型。
- 意义：多 agent 协同与任务分解的核心基础设施。

## 9.7 观测与诊断链路

- runId/lifecycle/assistant/tool 事件流、systemPromptReport、usage 累积、dedupe/wait。
- 意义：运维可观测性与线上问题定位依赖这条链路。

## 9.8 传输兼容与 provider 适配

- 在 runner/attempt 中有大量 provider 特化（tool schema 兼容、reasoning block、stream transport）。
- 意义：不同模型供应商“可用性差异”主要由这一层抹平。

---

## 10. 二次开发落地建议（围绕 5 大模块）

## 10.1 若你要扩展“技术架构”

- 尽量在 `agent-command` 前后做编排增强，不要直接改 `runEmbeddedAttempt` 深层逻辑。
- 新执行模式优先做“并行路径”（像 ACP）而非侵入主循环。

## 10.2 若你要接新模型或策略

- 优先接入 provider plugin + model-catalog 扩展，不建议硬编码在 runner。
- fallback 策略改动要同步考虑 auth profile cooldown 与 allowlist。

## 10.3 若你要扩展 tools/skills/mcp

- tools：优先 `resolvePluginTools(...)` 与策略管线，不要绕过 `createOpenClawCodingTools(...)`
- skills：遵守 snapshot/version 机制，避免每轮全量扫描；**新增或插件捆绑 Skill 时按 §6.5 规范**（manifest、`dist-runtime` 物化、激活与白名单、验收）。
- mcp：复用 session runtime manager，不要每轮新建连接

## 10.4 若你要改 memory

- 先通过 memory runtime 与 embedding provider 扩展点接入
- 不建议直接写死 memory flush 条件，避免破坏 compaction 协同

## 10.5 若你要改 session

- 必须保留“会话 lane + 文件锁 + transcript idempotency”三件套
- 任何 store 结构调整都要兼顾旧 key 归一化和跨 agent store 兼容检索

---

## 11. 核心源码索引（按主题）

### 11.1 主链路

- `src/gateway/server-methods/agent.ts`
- `src/commands/agent.ts`
- `src/agents/agent-command.ts`
- `src/agents/command/attempt-execution.ts`
- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`

### 11.2 模型

- `src/agents/model-selection.ts`
- `src/agents/model-catalog.ts`
- `src/agents/models-config.ts`
- `src/agents/model-fallback.ts`

### 11.3 tools / skills / MCP

- `src/agents/pi-tools.ts`
- `src/agents/openclaw-tools.ts`
- `src/agents/skills/workspace.ts`
- `src/agents/skills/plugin-skills.ts`
- `src/agents/skills/refresh.ts`
- `scripts/stage-bundled-plugin-runtime.mjs`（bundled 插件 `dist-runtime` 镜像；`skills/` 物化策略）
- `src/agents/pi-bundle-mcp-runtime.ts`
- `src/agents/pi-bundle-mcp-materialize.ts`
- `src/agents/embedded-pi-mcp.ts`
- `src/agents/mcp-transport.ts`

### 11.4 memory / context engine

- `src/agents/memory-search.ts`
- `src/auto-reply/reply/memory-flush.ts`
- `src/plugins/memory-state.ts`
- `src/plugins/memory-runtime.ts`
- `src/plugins/memory-embedding-provider-runtime.ts`
- `src/context-engine/types.ts`
- `src/context-engine/registry.ts`
- `src/context-engine/legacy.ts`

### 11.5 session / 并发

- `src/agents/command/session.ts`
- `src/config/sessions/store.ts`
- `src/config/sessions/transcript.ts`
- `src/agents/session-write-lock.ts`
- `src/process/command-queue.ts`
- `src/agents/pi-embedded-runner/lanes.ts`

---

## 12. 最终结论（给架构决策）

你提出的 5 个模块已经覆盖了通用 Agent 架构的主干，但在 OpenClaw 中还必须把以下能力纳入“同级核心”：

- ACP 双路径执行
- compaction/overflow 自愈
- hook 生命周期
- sandbox 与策略安全管线
- prompt cache 稳定性
- subagent 编排
- 可观测性与运行诊断

如果把这 8 个部分补齐到你的架构图里，这份架构认知基本可以覆盖 OpenClaw Agent 的真实生产运行面。
