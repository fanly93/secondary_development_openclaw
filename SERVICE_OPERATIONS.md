# OpenClaw 服务查看与启停手册（仓库本地开发）

本文描述在**本仓库根目录**进行二次开发时，如何启动、查看与停止 **Gateway** 及可选的 **Control UI（Vite）** 开发服务。生产环境更常见的是 **OpenClaw macOS 应用**托管 Gateway，此处不展开。

---

## 环境与先决条件

- **Node**：22+（仓库基线；官方文档亦提及 24 推荐）。
- **包管理**：`pnpm install`（仓库默认；亦支持 Bun，见官方 [Bun 工作流](https://docs.openclaw.ai/install/bun)）。
- **配置与密钥**：运行时配置默认在 `~/.openclaw/openclaw.json`；环境变量会按 OpenClaw 规则合并（含仓库根目录 **`.env`**，且 **`.env` 不应提交到 Git**）。若你在终端里启动子进程前需要确保当前 shell 已具备模型等 API 密钥，可在**同一终端**执行：

  ```bash
  set -a
  source .env
  set +a
  ```

---

## 默认端口（未改 `gateway.port` 时）

| 用途                       | 默认              | 说明                                                                                                   |
| -------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------ |
| Gateway WebSocket / 控制面 | `127.0.0.1:18789` | 主入口；`gateway status` 探测此端口。                                                                  |
| Browser / Control UI HTTP  | `127.0.0.1:18791` | 相对 Gateway 端口 **+2**（见 `src/config/port-defaults.ts`）。由 Gateway 进程内嵌托管静态 Control UI。 |
| Vite（仅 `pnpm ui:dev`）   | 常见为 `5173`     | 独立前端热更新，与上表无冲突时需另开终端。                                                             |

实际端口以 `openclaw.json` / 环境变量为准；改 `gateway.port` 后，Browser Control 端口会随推导规则变化。

---

## 推荐命令对照（不必手写长路径）

| 场景                                | 命令                                                     |
| ----------------------------------- | -------------------------------------------------------- |
| **Gateway 热重载（开发首选）**      | `pnpm gateway:watch`                                     |
| 等价底层命令                        | `node scripts/watch-node.mjs gateway --force`            |
| **本仓库 CLI（会按需构建 `dist`）** | `pnpm openclaw …`（例如 `pnpm openclaw gateway status`） |
| **Control UI 单独热更新**           | `pnpm ui:dev`（底层为 `node scripts/ui.js dev`）         |

若已全局安装 CLI，可直接使用 `openclaw …`；与 `pnpm openclaw` 二选一即可。

---

## 1）如何查看当前服务是怎么启动的

在仓库根目录执行（路径按你本机克隆位置替换）：

```bash
cd <openclaw-repo-root>
ps -axo pid,ppid,command | sed -n '1p;/watch-node\.mjs gateway/p;/run-node\.mjs gateway/p;/openclaw-gateway/p;/scripts\/ui\.js dev/p;/vite/p'
```

常见进程链：

- `pnpm` → `node scripts/watch-node.mjs gateway --force` → `node scripts/run-node.mjs gateway --force` → `openclaw-gateway`
- 若单独起了前端：`node scripts/ui.js dev` → `vite …`

---

## 2）如何查看当前服务状态

```bash
cd <openclaw-repo-root>

# 端口是否在监听
lsof -nP -iTCP:18789 -sTCP:LISTEN
lsof -nP -iTCP:18791 -sTCP:LISTEN
lsof -nP -iTCP:5173 -sTCP:LISTEN   # 仅当使用 pnpm ui:dev 时

# 网关状态（本仓库推荐）
pnpm openclaw gateway status
# 或：node openclaw.mjs gateway status（需已存在可用构建产物）
```

健康时通常可见 **RPC probe: ok**；若使用 **LaunchAgent / 安装版应用**托管，状态里可能出现已加载的 LaunchAgent 描述；**纯终端 watch 开发**则一般为未加载 LaunchAgent，属正常。

---

## 3）如何关闭当前开发相关进程

**口径**：Gateway + 内嵌 Browser Control（同一进程树）；可选：`pnpm ui:dev` 对应的 Vite。

### 3.1 优先：在启动它们的终端按 `Ctrl+C`

### 3.2 找不到终端时（进程名匹配）

```bash
# 停 Gateway watch / run / 子进程
pkill -f "scripts/watch-node.mjs gateway" || true
pkill -f "scripts/run-node.mjs gateway" || true
pkill -f "openclaw-gateway" || true

# 停可选的 Control UI 开发服务
pkill -f "scripts/ui.js dev" || true
pkill -f "vite" || true
```

复查：

```bash
lsof -nP -iTCP:18789 -sTCP:LISTEN || true
lsof -nP -iTCP:18791 -sTCP:LISTEN || true
lsof -nP -iTCP:5173 -sTCP:LISTEN || true
```

说明：若 Gateway 由 **macOS 应用或 launchd** 管理，请用应用内开关或 `openclaw gateway stop` 等官方方式，避免与开发用 `pkill` 混用误杀。

---

## 4）如何启动服务

### 4.1 Gateway（推荐：watch 热重载）

```bash
cd <openclaw-repo-root>
pnpm install   # 首次或依赖变更后

# 如需把 .env 注入当前 shell（可选，见上文）
set -a && source .env && set +a

pnpm gateway:watch
```

行为简述：

- `gateway:watch` 监听相关源码与配置变更，触发 **构建并重启** Gateway（适合改 TypeScript / 插件元数据）。
- 首次运行前若从未构建，`run-node` 链路会按需触发构建；长期开发仍建议偶尔执行 `pnpm build` 以与 CI/发布行为对齐（见仓库 `AGENTS.md`）。

**网关配置提示**（摘自官方 CLI 文档）：默认要求配置中 `gateway.mode=local` 才允许启动本地 Gateway；临时排障可使用 `openclaw gateway run --allow-unconfigured` 等标志，详见 [Gateway CLI](https://docs.openclaw.ai/cli/gateway)。

### 4.2 可选：Control UI 独立开发（Vite）

另开终端：

```bash
cd <openclaw-repo-root>
pnpm ui:dev
```

用于 **只改 `ui/` 前端** 时的热更新；浏览器访问 Vite 提示的本地 URL。若仅验证内嵌静态 UI，只起 `pnpm gateway:watch` 并打开 `http://127.0.0.1:18791`（及配置中的 `gateway.controlUi.basePath`）即可。

### 4.3 启动后验收

```bash
lsof -nP -iTCP:18789 -sTCP:LISTEN
lsof -nP -iTCP:18791 -sTCP:LISTEN
pnpm openclaw gateway status
```

进一步可做通道探测（需 Gateway 可达）：

```bash
pnpm openclaw channels status --probe
```

---

## 5）延伸阅读（官方）

- [Gateway Runbook](https://docs.openclaw.ai/gateway)
- [Gateway CLI](https://docs.openclaw.ai/cli/gateway)
- [Setup / 从本仓库跑 Gateway](https://docs.openclaw.ai/start/setup)
