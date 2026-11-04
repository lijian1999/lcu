# LCU × OpenCode 适配器设计文档

- 版本：v0.3（草案，含第一、二阶段实测数据）
- 日期：2026-11-04
- 状态：设计阶段，未实现；E1/E2 实验已完成，结论推翻了 v0.2 的两个关键假设
- 目标平台：macOS（Apple Silicon）优先；Linux 为后续扩展
- 涉及组件：LCU 0.13.5、OpenCode Desktop 2.2.5（`ai.opencode.desktop`）、ChatGPT.app 26.1027.61615（CUA 0.0.35）

---

## 1. 背景与目标

### 1.1 背景

LCU（amontlabs/lcu）把 Codex 的 computer-use 运行时从官方宿主中解耦出来，以 MCP server 的形式提供给任意 harness。它对 harness 有一份明确的宿主契约（见 `docs/ADAPTERS.md`），官方适配器只有 7 个（Pi、Codex CLI、Claude Code、OMP、Hermes、DSH、Junie），**OpenCode 不在其中**。

当前状态：LCU 已以"裸注册"方式接入 OpenCode（`mcp.servers.lcu` 直连原始服务器），并已完成第一阶段实测（见 §2）。

### 1.2 目标

构建一个 **OpenCode 适配器**，使 OpenCode 满足 LCU 的完整宿主契约，达到官方适配器（Junie/Claude Code 级别）的行为对等：

1. 模型通过 OpenCode 使用 `js`/`js_reset` 控制 macOS 桌面应用与浏览器；
2. 逐应用审批（macOS elicitation）由 OpenCode 原生呈现，用户真实作答；
3. 轮次生命周期（turn_ended）正确转发，浏览器临时标签等清理行为生效；
4. host-guard 防自批准（拒绝控制 OpenCode 自身）；
5. host-only 工具（`turn_ended`、`js_add_node_module_dir`）对模型不可见。

### 1.3 非目标（v1）

- Chrome 控制（LCU 侧 opt-in，架构上预留，不实现）；
- Windows（LCU 本身 deferred）；
- Linux 沙箱状态（`codex/sandbox-state-meta`）处理——macOS 不受影响，中继应原样丢弃该 `_meta` 能力广播；
- 与 LCU 官方 `lcu setup` 集成（LCU 不认识 opencode，见 §6.4 的边界处理）。

---

## 2. 第一阶段实测记录（2026-11-04，本机）

实测方法：裸注册（无中继、无插件）下由会话内 agent 直接调用 `lcu_js`。

| # | 步骤 | 结果 | 结论 |
|---|------|------|------|
| 1 | `await cua.getState()` | ✅ 成功。返回完整第一手指南（约 4.5k tokens）+ 应用清单（含 `isRunning`、`useCount`） | **指令交付 ✓**——`js` 工具描述自带完整 cua_repl 指南，旧实验（OpenCode 1.18.32）的"缺指令"缺口已不存在 |
| 2 | `cua.getApp("访达")` | ❌ `Invalid app: 访达` | 中文名解析失败；需用 bundle ID 或英文路径（指南本身有此提示，符合预期） |
| 3 | `cua.getApp("com.apple.finder")` + `getScreenshot()` | ⚠️ `Computer Use permissions are still pending...`（运行时引导用户去授权） | **运行时启动 ✓**，macOS 隐私权限流已触发；用户完成授权后该错误自动消解 |
| 4 | 授权后重试截图 | ❌ `-10005: cgWindowNotFound`；`getAXState()` 同样失败 | 症状：能枚举应用但**零窗口**。高度指向**屏幕录制权限未生效**（CGWindowList 被掐断）。截图/AX 均以窗口清单为前置 |
| 5 | `listApps` | ✅ 应用枚举正常（9 个 running app，windows 全空） | 同上，窗口层缺失 |
| 6 | OpenCode 侧 | `mcp list` → `✓ lcu connected`；服务器指令已注入系统提示 | **MCP 通道 ✓** |
| 7 | 插曲 | 工具结果 error 文本中包含运行时注入的指令（"Do not end your turn yet, just call this tool again"） | 属工具返回内容，agent 未盲从（先诊断、征询用户）。**须写入适配器的审批策略**（§5.6） |

### 2.1 尚未实测的关键项（阻塞设计定稿的实验）

| 实验 | 目的 | 方法 |
|------|------|------|
| E1 | **elicitation 审批表单是否弹出、能否作答**（最大不确定点） | 屏幕录制权限修复后，对任一 App 首次触发桌面动作 → macOS 审批 elicitation 应直达 OpenCode |
| E2 | **截图 PNG 字节是否完整到达模型** | 通过后 `getScreenshot()`，核对模型可见图像 |
| E3 | **`_meta["ai.opencode/sessionID"]` 是否随工具调用到达** | 在中继里记录（裸注册下无法观测，属路线 B 第一步） |
| E4 | **MCP 连接是否多会话共享** | 开两个 OpenCode 会话并发调用，观测并发行为 |

> 设计文档中标注 ⚠️E1/E2/E3/E4 的条目依赖上述实验结果。

---

## 2.2 第二阶段实测（2026-11-04 下午，OpenCode Desktop 2.2.5 / LCU 0.13.5 / ChatGPT 26.1027.51404）

### 2.2.1 实验结果总览

| 实验 | 结果 | 结论 |
|---|---|---|
| **E1**（审批 elicitation 直达用户） | ❌ **失败** | OpenCode 静默自动接受 `elicitation/create`，用户全程看不到任何表单（详见 2.2.3） |
| **E2**（截图 PNG 字节完整到达模型） | ✅ **通过** | 活动监视器截图 211,946 字节逐位到达模型，内容与 AX 树一致 |
| **E3**（`_meta["ai.opencode/sessionID"]` 随调用到达） | ✅ 间接确认 | OpenCode 在 `tools/call` 携带该 `_meta`（opencode#51856 评论区抓包证实）；本次未在裸注册下直接复测 |
| **E4**（MCP 连接多会话共享模型） | ⚠️ **比预期更糟** | OpenCode **按项目目录**各启动一个 lcu 服务器（非共享单连接），标签页关闭后进程不退出，直至 App 重启；多实例争抢单一 Sky 运行时（见 2.2.4） |

### 2.2.2 排障过程记录（零窗口问题的真因链）

第二阶段开局即复现第一阶段遗留的"全部 App 零窗口"。排障依次排除了四个假设，最终定位：

1. ❌ **屏幕录制 TCC 授权对象错误**：`lcu doctor` 指明授权对象是 ChatGPT（录屏）+ Codex Computer Use helper（辅助功能），按签名身份归属。用户全部授权后依然零窗口。授权后**必须重启相关进程**（第一次"授权无效"即因未重启）。
2. ❌ **Sky helper 进程陈旧**：helper（`Codex Computer Use.app`）在授权后为全新进程，排除。
3. ✅（部分）**codex seatbelt 沙箱掐断 CGWindowList**：同一 Swift 探针（`CGWindowListCopyWindowInfo`），沙箱外 206 窗口，以 LCU worker 同款 `codex sandbox` 参数运行得 0 窗口——实锤。但注意：`LCU_NODE_REPL_SANDBOX` **仅 Linux 生效**（`runtime.mjs` 中 `if (target === 'linux')` 包裹），macOS 上是 no-op，写入该环境变量后零窗口依旧，与源码一致。
4. ✅（最终）**零窗口本身是良性表象**：AX 读取（getApp/getAXState）、截图、控制动作全部正常——这些经 Sky helper（沙箱外、TCC 已授）中转；只有 worker 进程内的 CGWindowList 枚举被沙箱拦截，表现为 `listApps().windows` 全空。**对功能无实际影响，但适配器不应依赖 worker 内窗口枚举。**

> 附带确认：`lcu apps` 输出为**已永久放行清单**（非已安装清单）。本机在测前已有 8 个 App 被放行（含 Finder、Chrome），来自 11-02 Pi 适配器会话的 `always` 持久化。

### 2.2.3 E1 详细记录（本次实验核心产出）

**现象**：对未放行 App（活动监视器 → Typora → 邮件）依次触发 `getApp` 绑定与控制动作（`performSecondaryAction(0, 'Raise')`），全部静默成功；用户全程（含专程盯屏复测）未见到任何审批 UI。用户主动关闭 OpenCode 的"自动接受权限"开关后复测，依旧无弹窗且成功。

**判定实验**（独立 MCP 探针客户端，声明 elicitation 能力）：

- 探针（无自动应答）对 Typora 发起同样调用 → 收到 `elicitation/create`（原文存 `/tmp/elicit_request_1.json`，要点如下），探针回答 `cancel` 后运行时正确 fail-closed（"Computer Use was not approved to use Typora"）：

```json
{
  "message": "Allow Computer Use to use \"Typora\"?",
  "mode": "form",
  "requestedSchema": { "properties": {}, "type": "object" },
  "_meta": {
    "codex_approval_kind": "mcp_tool_call",
    "connector_id": "computer-use",
    "connector_name": "Computer Use",
    "persist": ["session", "always"],
    "riskLevel": "low",
    "tool_name": "get_app_state",
    "tool_params": { "app": "abnerworks.Typora" }
  }
}
```

- 对照组：OpenCode 会话内同调用 → 成功且无表单。

**结论**：LCU 侧审批机制完好（发出、fail-closed、persist 语义齐全）；**OpenCode Desktop 2.2.5 的 MCP 客户端对 `elicitation/create` 静默回答 accept**，与"自动接受权限"开关无关，且 `requestedSchema` 为空 schema、不存在"应用默认值"的可能。与上游已知问题吻合（opencode#51856、#23066、#28567：OpenCode 声明 elicitation 能力但不向用户呈现 `mcp-elicitation` 类型表单；桌面版 `sessionFormRequest` 过滤只保留 `question`/`websearch.provider` 两种 kind；#58184 于 2026-10-22 关闭主 issue，但 Desktop 2.2.5 实测仍未呈现）。

**对设计的推翻与修订**：

- v0.2 §3.2/§5.4 的核心假设"OpenCode 原生呈现审批表单（E1）"**不成立**。中继不能把审批呈现寄托在 OpenCode 对 `elicitation` 的透传上。
- 修订审批管线优先级：
  1. **路线 1（首选）**：中继把审批映射为 OpenCode **`question` kind 的会话表单**（Desktop 确认会渲染该类型），需经插件的 session data API 创建，或在 relay 侧以 host 身份发起；对 `_meta.persist` 的"always"落库到 LCU 自身机制之外需另行设计（或仅支持 session 级）。
  2. **路线 2**：跟踪上游 Desktop 对 `mcp-elicitation` 的呈现修复；一旦上游修复即切回透传（保留探针脚本作为回归用例）。
  3. **路线 3（兜底，Junie 语义）**：中继对审批一律 cancel，并在工具结果中附提示块引导用户终端执行 `lcu apps allow <App>`（Touch ID）。
- host-guard（D4）优先级提升：在审批不可信的宿主里，中继侧拒绝控制 OpenCode 自身成为必需而非加固。

### 2.2.4 E4 详细记录（多会话并发）

- OpenCode Desktop 为**每个打开的项目目录**各启动一份 lcu MCP 服务器（主页视图 = 主目录也算一份）；本机实测同时存在 2–3 份 `runtime.mjs`。
- 标签页/会话关闭后其 MCP 进程**不退出**，直到 App 完全重启。多实例并发时互相断开对方的 Sky 连接（日志多次 `MCP server process exited`），表现为 js 内核内 `cua` 绑定随机丢失、调用间状态不稳定。
- **对设计的修订**：v0.2 D3 假设"多会话共享同一中继进程、需会话互斥"，实际形态更根本——**中继必须以单例方式部署**（如全局固定路径 + 文件锁，或建议用户单会话使用），并把"检测到第二个中继实例"作为显式错误而非静默争抢。

### 2.2.5 其他行为记录（适配器实现须绕开/处理）

- **js 工具结果会被提前定稿**：`cua.getApp(...)` 的自动 AX 输出之后，同一调用内后续 `nodeRepl.write` 的内容不进入工具结果（疑似首条 emit 即定稿）。适配器文档须写明"绑定与取结果分开调用"的用法约定。
- **审批后内核重置**：审批事件后 js 内核重置，`cua` 绑定丢失，需 `js_reset` 或重连恢复（多次复现）。
- 顶层 `return` 非法（模块作用域），IIFE + `nodeRepl.write` 是可靠取值方式。
- 中文 App 显示名解析失败（"访达"），须用 bundle ID（与文档一致）。
- 运行时在工具结果中注入超长指南与"Confirmations Policy"文本（~19KB/次）：对模型上下文是持续税负，中继可评估缓存/裁剪（不得改变语义）。

### 2.2.6 当前安全姿态（裸注册，诚实现状）

在 E1 失效 + E4 并发争抢的现状下，裸注册的实际防线为：

1. macOS TCC（录屏/辅助功能，已授 ChatGPT/Codex Computer Use/OpenCode）；
2. OpenCode 工具调用批准（**当前会话未弹出过**，权限表为空，生效状态待新会话复测）；
3. ~~LCU 逐应用审批~~（被宿主静默放行，失效）；
4. LCU 运行时硬拒绝清单（Terminal/iTerm2 等）仍然有效。

**在适配器路线 1/2/3 落地前，不应认为"AI 控制任意 App"有审批闸**。临时缓解：保持"自动接受权限"关闭；不用时退出敏感 App（注意 `getApp` 可后台拉起 App，此缓解不彻底）；等待/推进路线 1。

---

## 3. 总体架构

### 3.1 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│ OpenCode Server (ai.opencode.desktop / opencode-cli serve)      │
│                                                                 │
│  ┌───────────────────────┐        ┌──────────────────────────┐  │
│  │ lcu-opencode-plugin   │        │ MCP client               │  │
│  │ (in-process, TS)      │        │  elicitation → 原生表单   │  │
│  │  session.hook(prompt) │        └───────────┬──────────────┘  │
│  │  event: execution.*   │                    │ stdio           │
│  └───────────┬───────────┘                    │                 │
└──────────────┼────────────────────────────────┼─────────────────┘
               │ lifecycle IPC                  ▼
               │ (Unix socket + token)  ┌──────────────────────────┐
               └───────────────────────►│ lcu-opencode-relay       │
                                        │ (stdio MCP server, mjs)  │
                                        │  tools/list 过滤          │
                                        │  elicitation 转发+guard   │
                                        │  turn id 管理             │
                                        └───────────┬──────────────┘
                                                    │ stdio MCP
                                                    ▼
                                        ┌──────────────────────────┐
                                        │ lcu（LCU 安装命令）        │
                                        │  = 原始 CUA MCP server    │
                                        └───────────┬──────────────┘
                                                    │ native pipe
                                                    ▼
                                        ┌──────────────────────────┐
                                        │ ChatGPT.app CUA runtime  │
                                        └──────────────────────────┘
```

### 3.2 为什么必须是"中继"而不是"插件内嵌客户端"

| 方案 | 指令交付 | 审批 elicitation | 生命周期 | 结论 |
|------|---------|-----------------|---------|------|
| 裸注册（现状） | ✓ 自动 | ⚠️E1 直达 OpenCode | ✗ 无法转发 turn_ended | 不完整 |
| 插件内嵌共享客户端（Pi/Hermes 模式） | 需自建注入 | **✗ 不可行**：elicitation 只能从 MCP server 侧发起，插件注册的工具不是 MCP server，运行时的 `elicitation/create` 无从到达 OpenCode UI | ✓ 插件钩子 | **排除** |
| **MCP 中继（Junie/Codex 模式）** | ✓ 透传 | ✓ 逐跳转发 elicitation | ✓ 需插件经 IPC 协助 | **采用** |

理由：macOS 逐应用审批是 LCU 安全模型的根（approval boundary），任何不能呈现 elicitation 的方案在 macOS 上会静默 fail-closed 或被迫走 Junie 式"永久授权"降级，都不可接受。OpenCode 支持 elicitation，这是它优于 Junie 的根本原因，中继必须保住这条通路。

### 3.3 组件清单

| 组件 | 形态 | 参考蓝本（LCU 仓库内，MIT） |
|------|------|---------------------------|
| `lcu-opencode-relay` | Node mjs，stdio MCP server，OpenCode 的 `mcp.servers.lcu` 启动 | `adapters/codex.mjs`（工具过滤）+ `adapters/junie.mjs`（钩子协作）+ `adapters/client.mjs`（共享客户端） |
| `lcu-opencode-plugin` | OpenCode server part（TS），经 `plugins` 注册 | 无直接蓝本；事件映射见 §5 |
| 安装脚本 | 独立 shell/mjs（不进入 `lcu setup`） | `scripts/install.mjs` 的注册段 |

---

## 4. 关键设计决策

### D1 — 工具可见性：中继层过滤，而非 permissions deny

中继在 `tools/list` 只返回 `js`、`js_reset` 的原始描述符；`js_add_node_module_dir`、`turn_ended` 保留在中继的**私有方法面**（host-only），供插件/自身调用，永不出现在模型可见列表。这与 Codex 中继行为一致。现行的 permissions deny 规则降级为双保险（防中继自身回归），可保留也可移除。

### D2 — 轮次身份：中继拥有 turn id，OpenCode 提供 session id

- `sessionID`：直接采用 OpenCode 注入的 `_meta["ai.opencode/sessionID"]`（⚠️E3 未实测；若无则 fail-closed——拒绝调用并回报"identity_refused"，同 Claude 中继）。
- `turnID`：OpenCode 无原生 turn 概念，中继为每个 OpenCode 轮次生成 UUID。轮次边界由插件事件驱动（§5.2）。
- 键控：`(sessionID, turnID)` → 上游 turn 的映射表；上限 1024 个活跃轮次、65,536 条已结束记录（LRU），超限拒绝新建、不影响存量——照抄 Claude 中继的容量语义。

### D3 — 多会话并发：单上游连接 + 串行化 + 会话间互斥

⚠️E4 未实测。OpenCode server 的 MCP 连接按 server 进程管理（`mcp list` 显示全局单连接），**多个 OpenCode 会话共享同一个中继进程**，而 LCU 原始服务器是单运行时。设计：

- 同一时刻只允许一个 OpenCode 会话"拥有"上游运行时；第二会话的 `js` 调用得到明确错误："LCU is in use by another session"，模型应告知用户而非重试（Hermes 已验证该语义可行）。
- 同会话内并发 `js` 调用：排队串行（原始运行时本身有 30s JS 超时 + 队列语义）。
- 会话中断（`session.execution.interrupted` / 用户 Esc）：立即向该会话的活跃轮次发 `Interrupt`，释放锁。

### D4 — host-guard 在中继内复刻，且必须默认开启

- 祖先遍历：`ps` 找中继进程的 app bundle 链，`CFBundleIdentifier` 命中 `ai.opencode.desktop` → 该 App 的审批请求直接 `decline`（等同官方适配器对 Claude desktop 的处理）。
- 静态名单：照抄 `host-guard.mjs`（含 OpenCode、Terminal、iTerm2 等；编辑器类不列入，因其是合法的 computer-use 目标）。
- 查找失败 → fail-closed 回退静态名单。
- **不做** `LCU_ALLOW_AGENT_HOST_APP` 旁路（v1）。

### D5 — OpenCode 版本门槛与能力探测

适配器要求 OpenCode ≥ 2.2.x（elicitation + V2 插件 API）。安装脚本记录并检查 `CFBundleShortVersionString`；插件 `setup` 时运行时探测（`ctx.mcp.list()`、事件类型存在性），不满足则打印降级警告并停用生命周期部分（工具仍可用，等同路线 A）。

---

## 5. 详细设计

### 5.1 Relay（MCP 中继）

**启动**：OpenCode 以 `command: ["node", "<prefix>/current/adapters/opencode/relay.mjs", "--lcu", "<prefix>/current/bin/lcu"]` 启动。Node 来源：macOS 直接用 ChatGPT.app 的 `cua_node`（LCU 已验证其签名）；不依赖系统 Node。

**上游连接**：`adapters/client.mjs` 的 `createCuaClient`，`onElicitation` 回调接 §5.4 审批管线。连接策略：懒启动（首个 `js` 调用才连），保持整轮存活。

**方法面**：

| 方法 | 可见性 | 行为 |
|------|--------|------|
| `js` | 模型 | 校验身份（sessionID 存在、本会话持有锁）→ 透传上游；结果原样转发（text/image/isError） |
| `js_reset` | 模型 | **先**对所有在该 worker 上跑过的轮次发 `turn_ended(Interrupt)`（sky event-taps 语义，LCU 文档明确要求），再透传 reset |
| `opencode_bind` | host-only（IPC，非 MCP） | 插件经 socket 调用：绑定 `(sessionID → turnID)` |
| `opencode_turn_ended` | host-only（IPC） | 插件经 socket 调用：`(sessionID, event: Stop\|Interrupt)` → 上游 `turn_ended` |
| `turn_ended` / `js_add_node_module_dir` | 不暴露 | 若上游 `tools/list` 含它们，中继吞掉；防御性拒绝模型直呼 |

**清理重试语义**：`turn_ended` 失败 → 挂起，下轮该会话首次调用前重试；仍失败则拒绝调用："LCU is still finishing the previous turn"（Junie 已验证的成熟语义）。会话/中继退出时对开放轮次发 `Interrupt`（2s 排空预算）。

**诊断日志**：复用 `adapters/diagnostics.mjs`，adapter 名 `opencode`，写到 `~/Library/Logs/LCU/`。只记元数据（调用时长、审批 kind/选择、turn-end 结果），永不记工具参数与结果内容。

### 5.2 插件（OpenCode server part）

**职责边界**：插件只做**事件翻译**，不做工具、不碰内容。

**事件映射表**：

| OpenCode 事件/钩子 | 语义 | → LCU 动作 |
|---|---|---|
| `session.hook("prompt")` | 新用户输入 = 新轮次开始 | `opencode_bind(sessionID)`；同时结束该会话上一开放轮次（先 `Stop`，调用仍在跑则 `Interrupt`——Junie UserPromptSubmit 语义） |
| event `session.execution.succeeded` | 轮次正常完成 | `opencode_turn_ended(sessionID, Stop)` |
| event `session.execution.failed` | 模型/API 失败 | `opencode_turn_ended(sessionID, Interrupt)`（Claude StopFailure → Interrupt 同款） |
| event `session.execution.interrupted` | 用户中断/Esc | `opencode_turn_ended(sessionID, Interrupt)`，同步撤销该会话 pending 审批 |
| event `session.deleted` / 插件卸载 | 会话消失 | `Interrupt` + 释放锁 |
| `tool.hook("execute.before"/"after", lcu_js*)` | 保底身份绑定 | 仅用于校验 `_meta` 一致性；不做业务 |

**事件到轮次的归属判定（开放问题 Q1）**：`session.execution.*` 是否携带足够的轮次粒度、以及与 `session.idle` 的先后关系，需对照 OpenAPI schema 实测。若粒度不足，回退方案：以 `session.tool.called(lcu_js)` 为"轮次活跃"标记，`session.execution.*` 兜底结束。**设计上两条都实现，用配置切换**。

**子代理**：OpenCode 子会话有独立 sessionID，天然获得独立 turnID——比 Claude 的 prompt-id 映射简单。注意子会话与父会话互斥规则同 D3。

### 5.3 权限与配置模板

```jsonc
// opencode.json（安装脚本写入，保留其余字段）
{
  "mcp": {
    "servers": {
      "lcu": {
        "type": "local",
        "command": ["<node>", "<prefix>/current/adapters/opencode/relay.mjs", "--lcu", "<prefix>/current/bin/lcu"],
        "codemode": false,
        "timeout": { "startup": 60000, "execution": 3600000 }
      }
    }
  },
  "plugins": ["<prefix>/current/adapters/opencode/plugin"],
  "permissions": [
    // D1 落地后为双保险；默认 ask，auto 模式（可选，参考 lcu setup --approval auto 语义）：
    { "action": "lcu_js",       "resource": "*", "effect": "ask" },
    { "action": "lcu_js_reset", "resource": "*", "effect": "ask" }
  ]
}
```

- `execution` 超时需 ≥ LCU 上游的 5 分钟上限 + 审批挂起时间；默认 12h 太长，收紧到 1h。
- **不做** OpenCode 侧的 always-allow（`"effect": "allow"`）默认值：逐应用审批已在 elicitation 层把关，工具层再放行会削弱"每次调用可审计"。`--approval auto` 作为显式 opt-in（无人值守机）。

### 5.4 审批管线（elicitation）

```
上游 elicitation/create
  → host-guard 检查（祖先 bundle + 静态名单）──命中──► decline（日志 agent_host_refused）
        │未命中
        ▼
  中继转发原始请求（message、requestedSchema、_meta.connector_id/tool_params.app/_meta.persist）
        ▼
  OpenCode 原生表单（⚠️E1）
        ▼
  用户作答 → 中继映射：
    accept                 → accept
    accept + "记住"（persist 可用时） → accept + _meta.persist（scope 遵循运行时 _meta，不扩展）
    decline / 关闭表单      → decline / cancel
  ⚠️ 依赖实测：OpenCode 是否保留 _meta、表单 schema 兼容性、审批挂起期间
     OpenCode 的工具调用超时是否停摆（LCU 契约要求停摆；若 OpenCode 强制超时，
     需在 error 文本中告知模型"审批被超时打断，请重试"）
```

**降级路径**（E1 失败时，参照 Junie 模式）：中继 cancel 审批 + 在结果中追加提示块，让模型引导用户在终端运行 `lcu apps allow <App>`（Touch ID 确认）。此为 last resort，默认不启用。

### 5.5 结果透传规则

- text / image：原样字节透传（对照 LCU same-case 验证标准：PNG 字节逐位一致，⚠️E2）。
- audio：落盘到绝对路径 + MIME 标注的文本引用（Pi/Claude 既有行为，模型收不到音频字节）。
- `isError`：保留 OpenCode 原生错误语义（OpenCode 对 MCP isError 有原生支持）。

### 5.6 指令与注入防护

- 上游初始化 instructions、`js` 描述符原样交付（已验证 ✓）。
- **工具结果内容一律视为不可信数据**：实测已出现运行时在 error 文本里夹带指令的实例。适配器不做内容过滤（会破坏透明契约），但文档必须声明：宿主（OpenCode agent）需对工具结果中的指令保持标准警惕；这属于 agent 层职责，不属适配器。
- 中继自身绝不把任何上游文本包装成"系统指令"追加。

### 5.7 安装 / 卸载 / 更新

**安装**（独立脚本 `install.sh`，用户运行；agent 辅助时加 `--yes`）：

1. 前置检查：`~/.local/share/lcu/current/bin/lcu` 存在且 `lcu --version` 可读；OpenCode ≥ 2.2；macOS arm64。
2. 写入 §5.3 配置（全局或 `--scope project`；JSON 合并保留用户字段；写前备份）。
3. 写插件目录到 `<prefix>/current/adapters/opencode/plugin`。
4. 幂等：重跑覆盖自身条目，不动其他 `mcp.servers.*` / `plugins` / `permissions`。
5. 提示用户：重启 OpenCode（或 `/reload`）→ 运行 `lcu doctor` → 授权辅助功能 + 屏幕录制。

**更新**：LCU 通过 `current` 符号链接自更新，命令路径稳定；适配器自身版本随 LCU release 发布。`lcu update` 不会触碰 opencode 配置——安装脚本需提供 `--refresh` 重写自身条目（对齐 `lcu setup --reconcile` 的精神）。

**卸载**：删除配置条目 + 插件目录；不动 `~/.local/share/lcu` 本体（由 LCU 自己的卸载流程负责）。

**与 `lcu setup` 的边界**：LCU 官方文档禁止 agent "substitute another harness"，且 `lcu setup --agent ...` 不含 opencode。适配器安装脚本必须**自足**（自己写配置、自己探测），绝不调用 `lcu setup`；只调用只读命令（`lcu --version`、`lcu status`、`lcu apps`）。

---

## 6. 测试与验证计划

### 6.1 单元测试（Node，仿 `adapters/test/*.mjs`）

- 工具过滤：`tools/list` 恰好含 `js`/`js_reset`；host-only 直呼被拒。
- 审批映射：accept/persist/decline/cancel 全分支；guard 命中分支；审批挂起超时语义。
- turn 生命周期：bind/Stop/Interrupt/重试/会话切换/退出排空；`js_reset` 前置 Interrupt。
- 容量与淘汰：1024/65536 边界。
- 身份：缺失 `_meta` → identity_refused；跨会话并发 → 拒绝 + 文案。

### 6.2 集成测试（fixture）

- 以 LCU 测试用的 MCP fixture 替代上游（仓库有现成 harness），跑通中继 + 假插件事件流。
- 脚本化 OpenCode 模型（同 LCU 的 scripted-model 方法）驱动完整轮次。

### 6.3 实机验证清单（通过后才允许声称）

1. ✅（已验）MCP 连接与指令交付
2. ⚠️ E1 审批表单弹出 + 用户作答 + 审批后动作成功
3. ⚠️ E2 截图 PNG 字节完整进模型（SHA-256 对照）
4. Stop 后浏览器临时标签清理（需启用 Chrome 后测）
5. Esc → `Interrupt` → 活跃调用被取消、pending 审批撤销
6. 双会话互斥与恢复
7. host-guard：尝试控制 OpenCode 自身被拒
8. `js_reset` 后新调用正常、无 event-taps 残留

### 6.4 明确"不声称"清单（对齐 LCU parity 文档风格）

- 不声称：Chrome 站点审批流、audio、Linux、Windows、`--approval auto` 的安全等价性、组织策略环境（OpenCode 对应物未调研）。
- 运行时组合（ChatGPT 26.1027.61615 / CUA 0.0.35）本身未被 LCU 验证——适配器不为此背书。

---

## 7. 风险登记

| # | 风险 | 影响 | 缓解 |
|---|------|------|------|
| R1 | OpenCode elicitation 与 LCU 表单形状不兼容（E1 失败） | 审批不可用 → 桌面功能在 macOS 不可用 | §5.4 降级路径；或等 OpenCode elicitation 成熟；这是 go/no-go 决策点 |
| R2 | 审批挂起期间 OpenCode 强制超时 | 长审批被打断 | error 文案引导重试；向 OpenCode 提 issue |
| R3 | LCU 适配器契约漂移（0.13.x 迭代快） | 持续维护成本 | 复用其 `client.mjs`/`diagnostics.mjs` 减少自研面；锁定已测版本；跟踪 release notes |
| R4 | OpenCode plugin/MCP API 变更 | 插件失效 | 版本门槛 + 能力探测降级（D5） |
| R5 | `session.execution.*` 事件粒度不足（Q1） | turn_ended 误发/漏发 | 双策略实现 + 配置切换（§5.2） |
| R6 | 无上游背书，问题自担 | 排查成本 | 诊断日志 + 对齐 LCU 验证文化；最终走路线 C（提 PR）换长期维护 |

## 8. 里程碑估算

| 阶段 | 内容 | 产出 | 估时 |
|------|------|------|------|
| M0（已完成） | 裸注册 + 第一阶段实测 | 本文档 §2 | — |
| M1 | E1–E4 实验（权限修复后） | go/no-go 结论 | 0.5 天 |
| M2 | Relay 核心（过滤/审批/turn） | 可用的中继 + 单测 | 1–1.5 天 |
| M3 | 插件 + 生命周期打通 | 完整轮次清理 | 0.5–1 天 |
| M4 | 实机验证清单跑通 | verification record | 0.5 天 |
| M5（可选） | 打包安装脚本 + PR 上游 | 发布物 | 0.5–1 天 |

**合计：约 3–4.5 天**（单人，熟悉两边代码库的前提下）。

## 9. 开放问题

- Q1：`session.execution.*` 事件与轮次边界的精确映射（待对照 OpenAPI schema + 实测）。
- Q2：OpenCode MCP 连接的多会话复用模型（E4）——决定中继并发设计的最终形态。
- Q3：OpenCode 是否支持 MCP progress 通知（Codex 中继用它保进度；缺失则长任务无中间反馈，非阻塞）。
- Q4：OpenCode Desktop 与 CLI 的 elicitation 呈现差异（Claude 生态的前车之鉴：desktop app 可能没有 elicitation 回调）。
- Q5：是否值得在上游定义 "generic MCP host" 最小契约，让 OpenCode 适配从"自研"转为"官方支持"。