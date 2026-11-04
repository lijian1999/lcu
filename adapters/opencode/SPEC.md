# LCU × OpenCode 适配器 — 实现规格书（v0.4 配套）

配套设计文档：`docs/opencode-adapter-design.md`（v0.4）。本文件是实现级规格，含精确的模块边界、协议、行为约定与测试要求。实现位置：`adapters/opencode/`。

## 0. 总体形态与运行环境

- 组件 = `relay.mjs`（stdio MCP server，OpenCode 的 `mcp.lcu.command` 启动）+ `plugin/`（OpenCode V2 插件，生命周期事件翻译）+ `install.mjs`（安装脚本）。
- 运行平台：macOS (Apple Silicon) 优先；代码不做平台假设但不测非 darwin。
- Node：系统 Node ≥ 22（本机 v26）；依赖仅 `@modelcontextprotocol/sdk`（`adapters/node_modules` 已装，relay 以相对路径 `../client.mjs`、`../diagnostics.mjs` 复用蓝本，SDK 从上层 `adapters/node_modules` 解析）。
- 上游 = 已安装的 LCU（默认 `~/.local/share/lcu/current/bin/lcu`，可 `--lcu` 覆盖）。**绝不调用 `lcu setup`**，只允许只读命令（`--version`/`status`/`apps`）出现在安装脚本里。
- 代码风格：对齐 `adapters/*.mjs` 现有风格 —— ESM、无类、工厂函数 + 闭包、纯逻辑函数全部可注入（lookup/now/env/randomUUID 等从参数注入以便单测）、JSDoc 英文注释、每文件顶部一段"做什么/不做什么"的中文或英文说明段均可（参考 client.mjs 的注释密度）。**禁止**引入新依赖。

## 1. relay.mjs — MCP stdio 中继

### 1.1 启动与角色

```
用法：node relay.mjs [--lcu <path>] [--state-dir <dir>]
默认 --lcu：~/.local/share/lcu/current/bin/lcu
默认 --state-dir：~/.local/state/lcu-opencode
```

启动流程：
1. `--lcu` 路径必须存在且可执行（`fs.accessSync` X_OK），否则 stderr 打印并 exit 2。
2. 尝试成为 **owner**：在 state-dir 下创建 `relay.lock`（`open(path, 'wx')` 写入 `{pid, startedAt}` JSON；`EEXIST` 时读出 pid，若该 pid 已死（`kill(pid, 0)` ESRCH）则删除陈旧锁重试一次，仍失败 → 进入 **standby** 模式）。
3. **owner**：创建 `relay.token`（0600，32 字节随机 hex）与 `relay.sock`（Unix socket，先 unlink 旧文件）。启动诊断日志 `openDiagnosticLog({ adapter: 'opencode' })`。打开 IPC 服务（见 1.6），随后**后台立即发起**上游连接（eager connect，`ensureUpstream()`，不阻塞启动；initialize 应答与 standby 的 instructions 请求会等它一小段——见 1.2；超时后连接继续在后台进行，后续 tools/call 照旧惰性重连）。
4. **standby**：不连上游、不开 IPC。`initialize`/`tools/list` 先经 IPC 向 owner 索取（见 1.2/1.6），拿不到 → 现状行为（'' + 静态描述符）；`tools/call` 时先尝试接管（重试 step 2 的锁获取；若锁被**活着的** owner 持有，先向其 sock 发 `{token, type:'yield'}`（token 从 `<state-dir>/relay.token` 读；无 sock/token → 直接 in-use 错误）：owner 回 `{ok:false, error:'busy'}` → 保持 standby，in-use 错误；owner 回 `{ok:true}`（或 `not_owner`）或无响应/超时（1s）→ 重试 acquire（最多 3 次、间隔 ~100ms；O_EXCL 天然仲裁并发 standby；锁在但进程死的清除沿用 step 2），成功则原地升级为 owner：建 token/sock/日志、连上游，然后继续处理本次调用），失败则返回 isError 文本：
   `LCU is in use by another OpenCode session (owner pid <N>). Switch to that OpenCode window or close it, then retry here.`
5. 诊断事件：`relay_start {role: 'owner'|'standby', pid, lcu}`；standby 接管成功记 `relay_takeover {waitedMs}`；owner 让位记 `relay_yield {openTurns}`。

进程退出（SIGTERM/SIGINT/stdin EOF/beforeExit）：对每个有开放 turn 的 session 发 `Interrupt`（单个 2s 排空预算，Promise.race），关上游 client，删 sock/token/lock，日志 `relay_stop {reason}`。

### 1.2 MCP 方法面（对 OpenCode，SDK Server + StdioServerTransport）

- `initialize`：`capabilities: { tools: {} }`；`instructions`：**透传上游的 `client.instructions`**（OpenCode 会把它注入系统提示——模型学会 cua API 用法的关键，与 bare 注册对等）。owner：应答前等待 eager connect，上限 20s（OpenCode 的 MCP 启动预算 30s）；到点未连上或上游不可用 → instructions 置空，日志 `instructions_unavailable`，连接继续在后台进行。standby：经 IPC 向 owner 索取（见 1.6），结果缓存；owner 不在/超时 → ''。SDK 机制：`setRequestHandler(InitializeRequestSchema, …)` 覆盖内置 `_oninitialize`（文档明确"replace any previous handler"），应答 = `await server._oninitialize(request)` 的结果按需附加 `instructions` 字段（应答形状 `{protocolVersion, capabilities, serverInfo, instructions?}`，instructions 为空时不携带）。
- `tools/list`：owner → 首次调用触发上游连接（`createCuaClient(...).connect()`，超时 `CONNECT_TIMEOUT_MS`），成功后透传 `publicTools()`（恰好 js/js_reset，含原始 description——CUA 指南在里面，原文**不得改写**；js 描述另加截断对策前缀，见下条）；上游连接失败 → 返回空 tools 列表 + 日志（不崩，下次调用重试连接）。standby → 经 IPC 向 owner 索取其 `publicTools()` 并缓存（owner 未连上/不在 → 回退静态最小描述符，见 1.5，下次 list 重试）。
- **js 描述前缀（Code Mode 截断对策，生产证据：ses_e59f0c6a4ffe / ses_e5a1b7bedffe，2026-11-04）**：relay 暴露的每个 js 描述符都在 description **最前面**拼上导出常量 `JS_DESCRIPTION_PREFIX`（111 字符 + 空行：`Computer use. First call: \`await cua.getState()\` returns the guide. Output: nodeRepl.write(). No browser APIs.`），上游原文逐字保留在前缀之后；已以前缀开头的描述不再叠加（每次 list 都是全新拼接，绝不改写上游原对象）；`js_reset` 不加。三个应用点：owner 的 `publicTools()` 透传（list 时映射）；standby 经 IPC 继承的列表（standby 侧映射——owner 的 IPC `tools` 应答是原始 `publicTools()`）；静态 `STANDBY_TOOLS`（前缀直接并入 js description 定义）。为什么：OpenCode 的 Code Mode 把工具描述截断到 ~110-120 字符（只剩首句），上游 1511 字符描述中的三条使用规则（首次调用须执行恰好一个文档化 API 调用如 `await cua.getState()` 以取回完整指南；输出用 `nodeRepl.write()`，裸尾表达式只会得到 null；Browser APIs 禁用，乱试原始 `computer.*` 会撞审批参数形状错误）模型全看不到——生产会话 ses_e59f0c6a4ffe / ses_e5a1b7bedffe 里模型反复这样浪费回合，直到自己从函数源码反推出用法；前缀恰好落在截断窗内，截断后模型仍能看到三条规则。
- `tools/call`：仅接受 `js`/`js_reset`，其余 → SDK 错误 `InvalidParams`/未知工具错误。处理流程见 1.3/1.7。
- `resources/*`、`prompts/*` 等一律不支持（不声明 capability）。
- **永不**向下发送 `elicitation/create`、`sampling` 等请求（v0.4：无审批呈现）。

### 1.3 身份与会话互斥（D2/D3 的 v0.4 落地）

每个 `tools/call`：
1. `sessionID`：`_meta['ai.opencode/sessionID']`（OpenCode 随 tools/call 附带，opencode#51856 抓包证实）→ 缺失时：env `LCU_OPENCODE_IDENTITY=strict` 则拒绝（isError `identity_refused: OpenCode did not provide a session id (_meta.ai.opencode/sessionID missing)`）；默认 `fallback`：用 `opencode-conn-<sha1(argv).slice(0,8)>`（每连接稳定假名），日志 `identity {source: 'meta'|'fallback', sessionID}`。
2. **会话互斥**：维护 `activeSession`（最近一次成功 js 的 sessionID）与每 session 的 in-flight 计数。若本次 sessionID ≠ activeSession 且存在其他 session 的 in-flight js → isError：`LCU is in use by another session (<otherSessionId>). Wait for it to finish or switch to that OpenCode session.`；否则把 activeSession 切到本次 sessionID（空闲切换允许，日志 `session_switch {from,to}`）。
3. **turn 管理**：`sessions` Map（sessionID → `{turnId, inFlight: number, open: boolean}`，容量 1024 LRU）。调用时无开放 turn 则 `turnId = randomUUID()` 新建并标 open；把 turnId 连同 sessionID 传给 `client.call(name, args, { sessionId, turnId, metadata: request._meta })`。in-flight 计数包住整个 await（含排队）。
4. 同 session 并发：直接并发下传（client.mjs 内部有 call tracker 与审批闸；上游 node_repl 自带 30s/队列语义）。不做额外排队。
5. `js_reset`：透传 `client.call('js_reset', args, ...)`（client.mjs 内部先对 ranJs 的 turns 发 `Interrupt`，无需中继重复）；成功后清除**所有** session 的 open turn 状态（worker 已换代）。
6. 调用结束（成功或失败）递减 in-flight；turn 保持 open 直到 turn_ended（§1.6 的 Stop/Interrupt）。

### 1.4 上游客户端（复用 createCuaClient）

```js
const client = createCuaClient({
  command: [lcuPath],
  adapter: 'opencode',
  log,                      // openDiagnosticLog({ adapter: 'opencode' }) 的实例，同一实例供 relay 自身用
  onElicitation: policy,    // §1.7
});
```

- `createCuaClient` 已提供：js/js_reset 过滤（`MODEL_TOOLS`）、worker-turn 跟踪、`js_reset` 前置 `Interrupt`、`_meta['x-codex-turn-metadata']` 注入、host-guard decline（`declineAgentHostApp`，OpenCode 在静态名单内）、审批闸（审批挂起时调用 deadline 停摆）、App 更新重启、stderr 分类日志、`turnEnded({sessionId, turnId, event})`。
- 中继只做：§1.3 的身份/互斥/turn 簿记 + §1.7 的策略回调 + §1.6 的 IPC + §1.1 的单例。

### 1.5 静态 standby 描述符

`js`：`{ name: 'js', description: 'Run JavaScript with the cua_repl computer-use API (LCU relay standby: calls are refused while another OpenCode session owns the runtime).', inputSchema: { type: 'object', properties: { code: { type: 'string' }, timeout_ms: { type: 'integer' } }, required: ['code'] } }`；`js_reset` 同理（inputSchema `{type:'object'}`）。字面描述无需精确——standby 下模型应读到 isError 的人话提示。现版 js description 前面另带 §1.2 的 Code Mode 截断前缀。

### 1.6 IPC（插件 ↔ owner 中继）

- Unix socket `<state-dir>/relay.sock`；**令牌校验**：连接后首条消息必须是 `{token, ...}`，不匹配 → 写一行错误并断开（防本机其他用户/进程滥用；token 文件 0600，同用户可读即可）。
- 消息 = 单行 JSON，响应 = 单行 JSON：
  - `{token, type:'bind', sessionID}` → `{ok:true, pid}`；语义：该 session 新一轮 prompt 开始——若该 session 已有 open turn：in-flight > 0 → `client.turnEnded({sessionId, turnId, event:'Interrupt'})`，否则 `'Stop'`；随后把该 session 的 turn 标记为已结束（下一个 js 来时新建 turn）。重复 bind（无 open turn）→ no-op `{ok:true}`。
  - `{token, type:'turn_ended', sessionID, event}`（event ∈ Stop|Interrupt，默认 Stop）→ 结束该 session 的 open turn（同上选择逻辑：in-flight > 0 或 event='Interrupt' → Interrupt）。
  - `{token, type:'ping'}` → `{ok:true, pid, role:'owner'}`（插件用于发现 owner）。
  - `{token, type:'yield'}`（D3.1，standby 调用时的接管尝试触发——relay 绝不主动发，防乒乓）→ owner 判定：任一 session 的 in-flight 调用存在（或自身正在升级/正在让位）→ `{ok:false, error:'busy'}`（不释放）；否则执行**让位序列**：① 对所有 open turn 发 `Interrupt`（复用退出排空逻辑，2s 预算，失败不阻塞）；② 清空 open turn 簿记并关闭上游 client（`upstream?.close()`，upstreamReady=false；若有 connect 仍在飞行，epoch 守卫使其自行退出并关闭自己启动的 client）；③ 关闭自己的 IPC server（**不要**删除 sock 文件——新 owner 自行 unlink 重建；`ipc.close` 默认强断连接，让位路径须用优雅关闭让 `{ok:true}` 先送达）；④ 删除 `relay.token`，并仅当 `lockOwnedBy(stateDir, pid)` 时删除 `relay.lock`；⑤ `role='standby'`，日志 `relay_yield {openTurns}`；⑥ 回 `{ok:true}`。让位后 relay 继续存活、继续以 standby 服务它自己的 OpenCode 连接（下一次调用走接管路径）。已不是 owner（重复 yield / 正在让位）→ `{ok:false, error:'not_owner'}`。
  - `{token, type:'instructions'}`（standby 的 initialize 触发）→ owner 等待自己的上游连接（eager connect 通常几百 ms；上限 30s，超时回 `{ok:true, instructions:''}`）→ `{ok:true, instructions}`；等待期间或应答前让位/易主 → `{ok:false, error:'not_owner'}`（standby 收到后重试一次）。
  - `{token, type:'tools'}`（standby 的 tools/list 触发）→ owner 已连上游 → `{ok:true, tools:[publicTools()]}`；未连上/不可用 → `{ok:false, error:'unavailable'}`（standby 回退静态描述符，不等待）。
  - 未知 type / 坏 JSON → `{ok:false, error:'bad_request'}` 并断开。
- **失败重试语义**：`client.turnEnded` 抛 `LCU_TURN_CLEANUP_TIMEOUT` → 视为已受理（后台继续清理），open turn 照常结束，日志 `turn_end {outcome:'cleanup_timeout'}`；其他错误 → 该 session 记 `pendingEnd = {turnId, event}`，该 session 下一次 `js` 调用前先重试 turnEnded（成功才继续 js；仍失败 → isError `LCU is still finishing the previous turn`）。上游未连接时 turnEnded 直接忽略（client.mjs 行为）。
- 插件侧不必等在本仓库实现（阶段 2），但 relay 侧先按此协议实现并单测。

### 1.7 审批策略（v0.4 §5.4）

`onElicitation(params)`（在 client.mjs 的 guard/origin 判定**之后**被调用）：

```js
async function approvalPolicy(params, { log }) {
  const meta = params?._meta ?? {};
  const app = meta?.tool_params?.app;
  log.event('approval_auto_accepted', {
    app: typeof app === 'string' ? app : undefined,
    connector: meta?.connector_id,
    risk: meta?.riskLevel,
    tool: meta?.tool_name,
    persist_offered: Array.isArray(meta?.persist) ? meta.persist.join(',') : undefined,
  });
  return { action: 'accept', content: {} };
}
```

- 绝不向上游回 cancel（guard 命中时 client.mjs 已先 decline）。
- 绝不把 `params` 内容写入模型可见结果；日志只记元数据（同 client.mjs 纪律）。

### 1.8 turn_ended 事件映射（供插件使用，写入 README）

| OpenCode 事件 | data | → IPC |
|---|---|---|
| `session.execution.started` | sessionID | `bind` |
| `session.execution.succeeded` | sessionID | `turn_ended {event:'Stop'}` |
| `session.execution.failed` | sessionID | `turn_ended {event:'Interrupt'}` |
| `session.execution.interrupted` | sessionID | `turn_ended {event:'Interrupt'}` |
| `session.deleted` | sessionID | `turn_ended {event:'Interrupt'}`（失败即弃，会话已死） |
| `session.idle` / `session.status` | — | 不消费（execution.* 已覆盖；idle 不必发） |

依据：baoyu 项目 idle-tracker.ts 注释（2.2.5 实测 execution.started/succeeded 必发、idle 不一定）。

## 2. plugin/ — OpenCode V2 插件（阶段 2）

- 形态：目录 `adapters/opencode/plugin/`，`package.json`（`{name:'lcu-opencode-plugin', type:'module', exports:{'.':'./index.ts'}, dependencies:{'@opencode/plugin':'latest'}}`），`index.ts` 用 `Plugin.define({ id:'lcu-opencode-plugin', async setup(ctx) {...} })`。
- 行为：订阅 §1.8 的事件 → 向 `<state-dir>/relay.sock` 发对应 IPC 消息（每事件短连接：connect → 发送 → 等 ack（1s 超时）→ close；socket/token 不存在 → 静默跳过，不打扰会话）。
- sessionID 来源：事件 `data.sessionID`。
- 保底绑定（§5.2 tool.hook）：`ctx.tool.hook('execute.after')` 中若工具名含 `lcu`（js 调用经 Code Mode 后工具名可能是 `lcu_js` 等）→ 忽略内容，仅核对事件里的 sessionID 已 bind 过（内存 Set）；未 bind 过则补发一条 `bind`。**只做簿记，不做业务**。
- 失败纪律：一切 IPC 失败只 console.warn（带 `[lcu-opencode]` 前缀）+ 节流（同错误 60s 内最多一条），绝不抛出阻断会话。
- 配置：无 options；state-dir 与 relay 一致（`~/.local/state/lcu-opencode`），环境变量 `LCU_OPENCODE_STATE_DIR` 可覆盖（插件与 relay 都读）。

## 3. install.mjs — 安装/卸载（阶段 3）

- 用法：`node install.mjs [--yes] [--uninstall] [--refresh] [--prefix <dir>]`；默认 prefix `~/.local/share/lcu-opencode/current`。
- 安装步骤：前置检查（macOS、`<lcu>/--version` 可读、OpenCode ≥ 2.2（读 `/Applications/OpenCode.app/Contents/Info.plist` 的 CFBundleShortVersionString，缺失则警告不阻塞））；把仓库 `adapters/opencode/{relay.mjs,plugin/}` 拷入 prefix（plugin 保留 ts 源 + 写入其 package.json）；`npm ci --omit=dev --prefix adapters` 后把 `adapters/node_modules` 中 relay 运行所需依赖拷/链接到 prefix（简单起见：直接 `cp -R adapters/node_modules <prefix>/node_modules`，尺寸可接受）；解析 node：优先 `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node`（存在且可执行），否则系统 `node`（`process.execPath`）；写 `~/.config/opencode/opencode.json`：JSON 合并（保留其他字段，写前备份 `opencode.json.bak-lcu-opencode`）——
  - `mcp.lcu` = `{type:'local', command:[<node>, <prefix>/relay.mjs, '--lcu', <lcuPath>]}`（若现有 `mcp.lcu` 存在则覆盖并日志说明）；
  - `plugins` 追加 `<prefix>/plugin`（去重）。
- `--refresh`：重跑安装（幂等）。`--uninstall`：从 opencode.json 移除这两个条目 + 删 prefix（不动 `~/.local/state/lcu-opencode` 与已装 LCU 本体）。
- `--yes`：跳过确认；无 tty 且无 `--yes` → 打印计划并退出。全程只调 `lcu --version`/`status`/`apps`。
- 幂等：重复运行只更新自身条目，不碰其他 `mcp.*`/`plugins.*`。

## 4. 测试（阶段 1/2 交付物）

- 位置 `adapters/opencode/test/*.test.mjs`，`node --test` 跑；风格对齐 `adapters/test/client.test.mjs`（先读它再写）。
- 上游用**内存假 MCP server**（参考 `adapters/test/mcp-fixture.mjs` 的做法：SDK Server + PassThrough 对接，或直接对 createCuaClient 注入……注意 createCuaClient 只吃 command argv，因此假上游 = spawn 一个 node 子进程跑 fixture 脚本，fixture 用 SDK 实现最小 lcu 行为：initialize/tools/list 返回 js/js_reset/turn_ended/js_add_node_module_dir、tools/call 记录 `_meta` 并回显、elicitation/create 发一次审批请求）。仓库已有 `adapters/test/codex-fixture.mjs` 等先例，先读再写。
- 必测（阶段 1）：
  1. tools/list 恰好暴露 js/js_reset（无 turn_ended/js_add_node_module_dir）；
  2. js 调用透传 `_meta['x-codex-turn-metadata']`（fixture 断言 session_id/turn_id 为 UUID 且 sessionID 来自 `_meta.ai.opencode/sessionID`；缺失时 fallback 名）；
  3. strict 模式缺失身份 → isError identity_refused；
  4. 会话互斥：session A js in-flight（fixture 挂 200ms）期间 session B js → 明确"in use"错误；A 空闲后 B 成功（session_switch）；
  5. bind 后再次 bind → 上游收到 `turn_ended {Stop}`（fixture 断言 turn_ended 调用参数）；
  6. in-flight 时 bind → `Interrupt`；
  7. 审批策略：fixture 发 elicitation/create → relay 自动 accept（fixture 断言收到 accept），诊断日志出现 `approval_auto_accepted` 且含 app/risk；guard 命中场景（fixture 伪造 `_meta.connector_id='computer-use', tool_params.app='com.apple.Terminal'`）→ decline（client.mjs 行为）；
  8. 单例：同 state-dir 起第二个 relay → standby；其 js 返回 in-use 文本；owner 锁文件删除（模拟崩溃）后 standby 下一次调用成功接管；D3.1 yield——空闲 owner 让位（open turn 被 `Interrupt`，锁/token/sock 归新 owner，旧 owner 的 MCP 连接以 standby 继续服务）、in-flight 时 owner 回 `busy`（in-use 文本不变）、对 standby 发 yield 得 `not_owner`、错误 token 被断开（in-use）、无响应 owner 保持锁直至其进程死亡后陈旧锁被清除。
  9. IPC：错误 token 被断开；bind/turn_ended/ping 各分支；`LCU_TURN_CLEANUP_TIMEOUT` 视为受理；
  10. 退出排空：SIGTERM → fixture 收到所有 open turn 的 Interrupt。
- 指令透传（2026-11 修复）：owner initialize 应答携带 fixture 的 instructions（eager connect；上游启动慢时在预算内等到）；上游不可用 → initialize 正常返回 ''（不挂起），后续 tools/call 仍重试连接；standby initialize 携带 owner 转发的 instructions、tools/list 返回 owner 的完整描述符（缓存）；owner 不在 → 降级 '' + 静态描述符；ask 落在让位中的 owner 上 → 重试一次由新 owner 应答；owner 等待期间的 ask 在其连上后应答；eager connect 中让位 → 无僵尸 ready、无孤儿上游子进程。
- 阶段 2 增测：事件映射表（假事件流 → 断言 IPC 消息）；节流告警。
- **测试纪律**：不写真实文件到 HOME（state-dir 等一律注入 temp 目录）；不依赖网络；诊断日志用 `adapters/test/no-diagnostic-log.mjs` 同款禁用方式（先读）。

## 5. 验收口径（指挥者验收用）

- `node --test adapters/opencode/test/` 全绿；
- `adapters/test/` 原有测试不受影响（`npm test --prefix adapters` 不因新增文件破坏——上游 glob 只扫 `test/*.test.mjs`，勿动它）；
- 手工冒烟：`node relay.mjs --lcu ~/.local/share/lcu/current/bin/lcu --state-dir /tmp/lcu-opencode-smoke` + 用仓库探针模式（JSON-RPC over stdio）跑 initialize/tools/list/js（读一次 Activity Monitor AX 树）；
- 代码评审点：无新依赖、无 `lcu setup` 调用、模型可见面只有 js/js_reset、日志无内容泄漏（只有元数据）。