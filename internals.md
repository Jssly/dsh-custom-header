# 内部机制与已知坑（改代码前必读）

> 架构、RPC 协议、占位符规则与全部已知坑。**改 `src/` 之前请通读本文件**；
> 对外功能见 `features.md`，部署与排障见 `deployment.md`，历史见 `CHANGELOG.md`。

## 架构总览（双模式）

### 双模式隔离表（ID 与布局必须不同）

| 维度 | 动态模式（开发） | 静态模式（发布） |
|---|---|---|
| 安装方式 | `cordis_define` + `cordis_run`（进程内存） | `dsh plugin --profile web add file:$(pwd)`（loader 挂载） |
| pluginId / 插件名 | `dshy-1`（Host 分配不可改） | `dsh-profile-selector`（package.json name） |
| 槽位 | `conversation.input.left`（工具行左侧） | `conversation.input.right`（工具行右侧、发送键前） |
| 槽注册 id | `dsh-profile-selector` | `dsh-profile-selector-static` |
| RPC 前缀 | `dshprofile.*` | `dshprofile-static.*` |
| section 名 | `dsh-profile:profile` | `dsh-profile:profile-static` |
| CSS 类前缀 | `dshprofile-` | `dshprofile-static-` |
| RPC 通道 | `harness.handle`（闭包符号） | `ctx.connection.rpc.handle('/rpc', ...)`（RpcResult 包装） |
| Client 调用 | `host.call`（闭包符号） | `ctx.connection.rpc.call('/rpc', ...)`（解包 RpcResult） |
| 样式注入 | `styles.insert`（闭包符号） | `document.createElement('style')` |
| React | 闭包符号 | seed word `require('react')` |

> **为什么必须不同**：两套同时存在时，若 section 名 / RPC 前缀 / 槽 id 相同会互相冲突
> （同名 section 重复注册、RPC handler 撞名、槽注册 id 重复）。双模式隔离是硬约束。

### 数据流（以动态模式为例；静态模式仅 RPC 通道不同）

```
浏览器 (Client)                          DSH Host 进程 (Host)
┌──────────────────────┐   host.call    ┌────────────────────────────────────┐
│ ProfileSelect 组件     │ ─────────────▶ │ rpc.handle('dshprofile.activate')   │
│ 渲染于 input.left 槽   │ ◀───────────── │  enqueue(会话级串行队列)            │
│ autoFired 防双触发     │   JSON 返回    │   ├ 读 .deepseek.yaml (fs.resolve)  │
│ 成功→title / 失败→err  │               │   ├ 替换占位符 → profileText()      │
└──────────────────────┘                │   ├ forceCleanSection() 强制清残留   │
                                        │   ├ sp.section({name:'dsh-profile:profile', order:-50, text})
                                        │   └ agent.ctx.on('agent/request') 注入 temperature
                                        └────────────────────────────────────┘
                                                    │ systemPrompt 层
                                                    ▼
                                        Agent 会话作用域 PromptLayer
                                        （scope = AgentLoop 实例；sections NamedEntries）
```

### 核心/壳分层

```
src/core/            ← 纯函数工厂，零依赖，双模式共用
  yaml.js              parseScalar / parseYaml
  host.js              hostCore(ctx, opts, rpc)   — 全部 Host 业务逻辑
  client.js            clientCore(ctx, opts, deps) — 全部 Client UI 逻辑
        │ 动态：build.mjs 去 export/import 后内联进函数体
        │ 静态：ESM import，esbuild 打包
        ▼
src/dynamic/*.js  →  dist/dynamic/*.js  →  cordis_define（开发）
src/static/*.js   →  lib/*.js           →  dsh plugin 安装（发布）
```

- **Host 能力来源**：`ctx.get('fs')`（resolve/readText）、`ctx.get('sandboxPolicy')`（workspaceRoot 兜底）、
  `ctx.get('agents')`（`agents.get(sessionId)` → 会话 Agent，取 `agent.session.header.cwd` 与 `agent.ctx`）；
  RPC 注册经 `rpc.handle` 适配器（动态 `harness.handle` / 静态 `connection.rpc.handle`）。
- **Client 能力来源**：`ctx.get('slots')`；`React`/`call`/`insertCss` 经 `deps` 适配器注入
  （动态闭包符号 / 静态 seed word + connection.rpc）。
- **插件语言**：核心与壳均为纯 JavaScript（无 TS/JSX/import 转换）；动态函数体无 require
  （核心由构建内联）；静态 bundle 由 esbuild 处理 import。

---

## RPC 协议（Host handlers）

> 前缀随模式变化：动态 `dshprofile.*` / 静态 `dshprofile-static.*`（下表以动态为例）。

| handler | 入参 | 返回 | 说明 |
|---|---|---|---|
| `dshprofile.profiles` | `{sessionId, cwd?}` | `{profiles:[{name,title,file,files,parameters}], globalPrompt, cwd}` 或 `{profiles:[], globalPrompt:null, error}` | 解析工作区 `.deepseek.yaml` 的 `system_prompts`（与 `global_prompt`，同一 `loadWorkspace()` 入口一次解析）；`name`=档案 key，`title`=档案可选 `name` 字段（缺省=key，下拉框显示用）；`files`=规范化后的路径数组（**即多文件合并顺序**），`file` 向后兼容（单文件=字符串 / 多文件=数组）；`globalPrompt`=开场白覆盖文件路径（null=未配置或配置无效）；cwd 解析顺序：① 客户端显式传入的 `args.cwd`（来自会话 store，最可靠）→ ② Host 缓存 → ③ `agents.get(sessionId).session.header.cwd`；解析不到返回 `cwd:null` + 明确错误，**不回退** `sandboxPolicy.workspaceRoot`（见 internals.md） |
| `dshprofile.state` | `{sessionId}` | `{active: profileName\|null, globalPrompt: filePath\|null}` | 当前会话激活的档案 + 实际生效的开场白覆盖文件（Host 内存态 `active` / `identity` 两张 Map） |
| `dshprofile.activate` | `{sessionId, profile, cwd?}` | `{ok, profile, temperature?, cleaned?, globalPrompt?}` 或 `{ok:false, error}` | 切换档案；**同时重读 `global_prompt`**（用户改完 `.deepseek.yaml` 无需重启 DSH）；错误信息带 `[diag: ...]` 诊断段（见 internals.md）；档案 `file` 为数组时按声明顺序合并多文件正文，任一文件缺失 → `{ok:false, error}`（错误含「第 i/n 个 + 文件名」） |

**RPC 通道差异**（核心代码不感知，由壳适配）：
- 动态：`harness.handle(method, handler)` 直接注册；handler 返回业务结果；Client `host.call(method, args)` 直接拿结果。
- 静态：`connection.rpc.handle('/rpc', handler, {authority:'loopback'})` 注册；handler 返回
  `RpcResult`（`{ok:true,value}` / `{ok:false,error}`）；Client `connection.rpc.call('/rpc', method, args)` 返回
  `RpcResult`，由壳解包（`ok` 时取 `value`，否则 throw）。method 名即 endpoint（如 `dshprofile-static.profiles`）。

**激活流程（dshprofile.activate 内部）**：
1. `enqueue(sessionId, fn)` 入会话级串行队列（同一会话的激活严格顺序执行）；
2. **先重读开场白覆盖**：`applyIdentity(agent, sessionId, cwd)` —— 读 `.deepseek.yaml` 的 `workspace.global_prompt`，
   卸载旧注册后重注册 `harness:identity`（见 internals.md）；
3. 幂等短路：`active.get(sessionId).profileName === name` → 直接返回，不重注册；
4. 有旧档案 → `disposer()` + `disposeTemp()`，并从 `active` 删除；
5. 读 `.deepseek.yaml`（`loadWorkspace()`：迷你 YAML 解析，支持 map / 标量 / **标量列表**）→ 找档案 →
   读档案文件（档案 `files` 为**相对会话 cwd 的路径数组**，逐个 `fs.resolve(rel, { cwd })`，
   如 `doc/prompts/default.md`；单文件档案等价于长度 1 的数组；`file` 兼容旧写法）；
6. 替换占位符（见 internals.md）→ `profileText()` 生成注入正文；
7. `forceCleanSection(sp, agent, SECTION_NAME)` 强制清除残留 section（见 internals.md）；
8. `sp.section({name:'dsh-profile:profile', order:-50, text})` 注册（`sp = agent.ctx.systemPrompt`）；
9. 档案 `parameters.temperature`（数字）→ `agent.ctx.on('agent/request', ...)` 瀑布注入（见 internals.md）；
10. `active.set(sessionId, {...})` 记录 `{profileName, disposer, disposeTemp, temperature, sp, agent}`。

**YAML 解析能力边界**（迷你解析器，勿超纲使用）：
- 支持 `key: value`（标量）/ `key:`（嵌套 map，缩进栈）/ `- item`（**标量列表**，即 `file` 的多文件写法）；
- 标量：字符串（去引号）、布尔、数字、null；`#` 注释行与空行忽略；无法识别的行按「忽略」处理，**不抛错**；
- 列表实现（pkg-26）：`key:` 空值先懒创建占位对象，若该层首个内容行是 `- item` 就**原地升级为数组**。
  此前 `- item` 行被直接丢弃 → `file:` 数组被解析成 `{}` → 整个档案被 `typeof file === 'string'` 过滤掉；
- 不支持：锚点、多行字符串（`|` / `>`）、嵌套列表、列表内 map；
- 足够解析 `.deepseek.yaml` 的 `workspace.system_prompts.<name>.file|parameters.temperature`、
  `workspace.global_prompt` 与 `workspace.persona_prompt|persona_clear` 结构。

---

## 占位符替换规则

激活时对**档案正文**、**`global_prompt` 覆盖正文**与 **`persona_prompt` 覆盖正文**做如下替换（cwd = 会话工作区）：

| 占位符 | 替换为 |
|---|---|
| `{{date}}` | 当天 `YYYY-MM-DD` |
| `{workspace}` | 会话 cwd |
| `{dataDir}` | `cwd/output` |
| `{fileDir}` | `cwd/doc/ai` |

> **多文件档案（`file` 为数组）**：每个文件**各自**做上表替换，再按 `file` 的**声明顺序**用空行（`\n\n`）
> 依次拼接；前置说明头只加一次。任一文件读不到 → 整个档案激活失败（红字），不会静默注入残缺正文。

> 注意：档案正文（`doc/prompts/*.md`）中的 `F:\git\node\optionData\...` 字样是编写档案时的示例绝对路径，
> 激活时只做上表占位符替换，**示例路径不会被改写**。若档案要引用会话工作区内的目录（如 `doc/ai`、`output`），
> 应改用占位符（`{dataDir}`/`{fileDir}`/`{workspace}`），使注入内容随会话 cwd 自动适配；数据目录确在会话 cwd 之外时，
> 需调整 `substitute()`（src/core/host.js）的映射或修改档案内路径写法。

---

## 核心机制与已知坑（开发必读，勿破坏）

### 作用域语义：section 注册在「Agent 会话作用域」
- `agent.ctx` = `createScope(loopCtx, loopInstance).ctx.extend({agent})`（dsh-agent-loop/lib/index.js:376），
  scope key = **AgentLoop 实例**（`agents.get(sessionId)` 返回同一对象）。
- `agent.ctx.systemPrompt` 经 Cordis traceable 代理访问：方法调用时 `this.ctx` 被重绑为**调用方上下文**，
  `sp.section()` 注册进**该 agent 作用域**的 PromptLayer（`ScopedLayers.scoped.get(scope)`）。
- 同名重复注册抛：`prompt section "dsh-profile:profile" is already registered in this scope`。

### ⚠️ 竞态（原 pkg-9→pkg-10 修复）：激活必须串行
- 症状：连续切换时偶发 "already registered" + 下拉框错位。
- 根因：自动加载与手动切换（或 React 严格模式双挂载）几乎同时 activate，两边都读到 `active.get()===undefined`，
  后到的 `section()` 撞名。**修复**：Host `enqueue()` 按会话串行 + 幂等短路；Client `autoFired` 每会话只自动加载一次。

### ⚠️ disposer 在真实运行时可能静默失效（原 pkg-12 核心修复）
- 症状：已串行+幂等（pkg-10）仍报 "already registered"。
- 根因：`sp.section()` 返回的 disposer 在真实运行时（traceable 影子上下文路径）调用后**并未真正移除注册**
  （单测用裸 `createScope`+`ScopedLayers` 复现不出，机制疑在影子 ctx 的 effect 归属）；旧注册残留 → 下次 `section()` 撞名。
- **修复（安全网）**：`forceCleanSection(sp, agent, name?)` —— 直接遍历 `sp.layers.scoped`（scope key === agent 的层）
  与 `sp.layers.global`，把 `layer.sections.data`（普通 Map）里的目标 section 名直接 `delete`。
  注册前与插件 `ctx.on('dispose')` 时都执行。**这是当前唯一可靠的移除手段，请保留**。
  - `name` 省略时清理本插件自己的档案 section（`SECTION_NAME`）；
  - ⚠️ 当 `name === 'harness:identity'` 时**跳过 global 层清扫**（internals.md）：那份是 DSH 自带开场白，
    删掉会波及所有工作区；替换只允许走 scoped shadow。

### 诊断探针
- activate 出错时错误信息追加 `[diag: scopedHits=?; agentKeyHit=?; globalHit=?]`——
  统计残留 section 落在哪些层（`sp.layers.scoped` 的层数 / 是否在 agent 作用域 / 是否在 global 层）。
- 若再次出现 "already registered"，用该 diag 定位残留位置后，把对应层加入 forceCleanSection 的清扫范围。

### temperature 注入（agent/request 瀑布）
- `.deepseek.yaml` 档案的 `parameters.temperature` 经 `agent.ctx.on('agent/request', async (_p,next)=>{...})`
  监听，在瀑布返回的请求配置对象上覆盖/删除 `temperature` 字段。
- `top_p` **无法应用**：DSH `LlmCallConfig` 与 deepseek 适配器均无 top_p 字段，故档案的 top_p 被忽略（有注释说明）。

### 槽位选择约束（位置已定，勿改）
- 动态：`conversation.input.left`（list, scope session, replaceRisk none）→ 渲染在 InputBar `.row → .tools`
  中 resident chrome（accessSelect 之后、leftItems 位置）= 权限选择器右侧、输入框下方工具行。
- 静态：`conversation.input.right`（list, scope session）→ 工具行右侧、发送键前。
- `conversation.input.plan` 是 **single** 槽且被系统占用（占用会顶掉系统计划按钮），**不可用**。
- `conversation.input.dock` 在 hero+active 均渲染但 header actions 在 blank/hero 整体隐藏——曾导致下拉框重复/错位，已弃用。
- 成功反馈**禁止**渲染行内文字（挤动布局 → 下拉框错位），只允许 title/tooltip；错误 `.err` 限宽 24ch 省略。

### 其他
- ⚠️ **cwd 解析绝不回退部署级根**（pkg-18 修复）：`sandboxPolicy.workspaceRoot` 是**部署级**工作区根（非会话 cwd）。
  旧实现 `sessionCwd()` 在 `agents.get(sessionId)` 取不到 cwd 时回退到它——切换对话时 agent 短暂未就绪/被 dispose，
  会去读用户目录下的 `.deepseek.yaml`（如 `/home/j/workspace/dsh/.deepseek.yaml`）报错。
  **修复**：① Client 从会话 store（槽位标准 prop `useSessions` → `s.byId[sessionId].cwd`）显式传 `cwd` 给 RPC，
  不依赖 agent 是否在线；② Host `sessionCwd(sessionId, explicitCwd)` 按「显式 cwd → 缓存 → agent header」解析并缓存；
  ③ 解析不到返回 `null` + 明确错误「会话工作区未就绪」，**绝不回退** `sandboxPolicy.workspaceRoot`。
- 每会话 `active` Map 在 Host 内存；DSH 进程重启即清空（新会话打开时 Client 自动重新加载 default）。
- 插件停用：动态 `cordis_stop dshy-1`（pluginId 为 Host 分配不可改，显示名称 dsh-profile-selector；停用后已注入的 section 由 dispose 清理）；
  静态 `dsh plugin --profile web remove dsh-profile-selector`（或编辑 profile 的 cordis.patch.yml）。

### ⚠️ 激活延迟（pkg-19 修复）：会话存在但 agent 未激活时不得报红字
- 症状：新建/切换会话后下拉框已加载（`.profiles` 成功），但自动加载或手动切换报红字「会话不存在或未激活」。
- 根因：`agents.get(sessionId)` 只返回**已激活**的 agent。会话在客户端 store / 持久化中存在，但 agent 尚未发布
  （新会话空白期、冷会话、DSH 重启后会话未恢复）——agent 要等首次 `session.prompt` 才经 `agents.resume()` 发布。
  旧实现把「agent 未激活」误判为「会话不存在」，直接硬失败。
- **修复**：activate 在 agent 缺失时先查会话是否真实存在（`sessions` 内存表 + `sessionPersistence.list()`，
  查询失败按存在处理——宁可延迟也不误报红字）：
  - 会话存在 → 暂存 `pending` Map（sessionId → {profile, cwd}），返回 `{ok:true, profile, pending:true, temperature:null}`；
  - 会话确实不存在 → 才返回 `{ok:false, error:'会话不存在或未激活'}`。
- **自动应用**：`ctx.on('agent/created', async ({agent}) => ...)` 监听 agent 发布（`agent.id === sessionId` 为 pending 键），
  经 `enqueue` 串行调用共享的 `applyActivation()` 注册 section——保证在首次模型调用前注入。
  **pkg-25 起该监听器承担两件事**：① 无条件执行工作区开场白覆盖 `applyIdentity()`（见 internals.md，与 pending 无关）；
  ② 命中 `pending` 时再 `enqueue` 应用排队档案。事件经 `ctx.serial` 串行派发并 `await`，故监听器内可安全 await 读盘。
- 配套：`.state` 把 pending 档案也算当前选中（下拉框不跳回默认）；Client 对 `pending:true` 显示
  「已排队(会话激活后生效)」提示而非红字；`dispose` 时清空 pending。
- 注意：`agent/created` 是 scoped emit（`this: Scoped<Agent>`），监听器必须用 `agent.id`（=== session.id）查 pending。
- ⚠️ **pkg-27 修正（2026-09-20）**：本节第 3 条的「会话确实不存在 → 才返回 `{ok:false, error:'会话不存在或未激活'}`」已**取消**。
  该判据依赖 `sessionExists()`，而它当时用 `sessionPersistence.list()` 快照的**顶层 `s.id`** 匹配，实际上
  快照的 id 在 `snapshot.header.id` 上 → 恒为 false → 子代理会话 / 冷会话被误判成「不存在」并报红字，
  延迟激活随之失效（客户端 `autoFired` 只自动加载一次，被这次误报吞掉）。现在**一律** `pending` 排队，
  `sessionExists()` 只用于决定是否写一条 warn 日志。语义、根因与验证见 internals.md。

### ⚠️ 静态 RPC 通道 /rpc 是共享通道，只能注册一次（2026-08-18 修复）
- 症状：web 重启后 loader entry 应用失败：`webserver: duplicate prefix route "/rpc"`，插件被回滚（boot 图无该插件）。
- 根因：`connection.rpc.handle('/rpc', ...)` 在 webServer 注册 **prefix 路由**（`webServer.register({kind:'prefix', path: channel})`），
  同名通道重复注册即抛错。旧静态适配器对每个 RPC 方法（profiles/state/activate）各调一次 → 第二次起冲突。
- **修复**：`src/static/host.js` 用 `routes` Map 登记 method→handler，**单次** `connection.rpc.handle('/rpc', ...)`，
  handler 内按 `endpoint`（即 method 名，如 `dshprofile-static.profiles`）分发；未知名返回 `{ok:false, error:{code:'not-found'}}`。
- 配套：patch 与壳代码均声明 `inject: ['connection']`（硬依赖等待 connection 服务就绪，否则 apply 静默退出、/rpc 不注册）。
  ⚠️ 2026-09-09 更新：DSH 0.1.5-alpha.1 起 `rpc.handle` 失效、改 `connection.register(ctx, ...)` 且需加 inject webServer，见 internals.md。
- 浏览器侧调用形态（dsh-client-connection/lib/client.js `createWebConnectionRpc`）：`rpc.call(channel, endpoint, payload)`
  → `POST {channel}/{endpoint}`，body `{type:'client-request', rpcId, method: endpoint, payload}`；返回 `full.result`（即 RpcResult）。
- 动态模式无此问题：`harness.handle` 每个 method 独立注册，无共享通道概念。

### ⚠️ DSH 0.1.5-alpha.1 回归：`connection.rpc.handle` 全员失效，改用 `connection.register(ctx, ...)`（2026-09-09 修复）
- 症状：`dsh plugin --profile web add file:$(pwd)` 时 loader 报
  `dsh: plugin tree failed to load: failed to apply loader entry dsh-profile-selector (dsh-profile-selector): cannot get property "webServer" without inject`
  （栈顶 `dsh-client-connection/lib/index.js:618`），条目被回滚（profile package.json 不留该依赖）。
- 根因（新版 DSH 回归）：`HostConnectionService.register()` 末行 `owner.effect(() => owner.webServer.register(route))`；
  `rpc.handle` 的 owner 取 `this.ctx`——cordis 服务追踪构造的**影子 Context**（`createTraceable` / `createShadow`：
  原型链是调用方 ctx，但 `symbols.shadow` 指向 connection 服务自身 ctx），因此 `owner.webServer` 的服务解析是
  从 **connection 插件 fiber** 向上查找。旧版（0.1.0-rc.8 ~ 0.1.2-alpha.3）connection 插件自身 inject 含 webServer
  （`["webServer", "credentials"]`），其 fiber.store 有 webServer → 正常；**0.1.5-alpha.1 把 connection 的 inject
  改为 `["credentials"]`**（/api 路由改用 `ctx.inject(['webServer'], ...)` 挂载），connection fiber 的 store 不再有
  webServer → 无论调用方 inject 什么，都必抛上述错误。**调用方声明 `inject: ['webServer']` 无效**——解析起点是
  服务侧 fiber，不是调用方 fiber（已用真实 `HostConnectionService` + cordis 4.0.2 复现并验证）。
- **修复**：`src/static/host.js` 改用 `connection.register(ctx, '/rpc', handler)`——与 `rpc.handle` 同一实现，但 owner
  由调用方显式传入；传本插件自己的 ctx（inject 含 webServer，真实 ctx 无 shadow）即可解析。壳与 patch 均声明
  `inject: ['connection', 'webServer']`。验证：0.1.5-alpha.1 与 0.1.2-alpha.3 语义下均注册 `prefix:/rpc`；把 inject 强制
  回 `['connection']` 则精确复现原报错。
- 备选修复（DSH 侧，恢复旧版行为；本插件不依赖）：web profile 的 `~/.dsh/profiles/web/cordis.patch.yml` 追加
  `- id: connection` / `inject: [webRuntime, webServer]`。
- 动态模式不受影响：`harness.handle` 不经 connection/webServer。

### 工作区开场白覆盖 `harness:identity`（2026-09-15 新增）

**目标**：把 DSH 第一方开场白 `You are an AI agent powered by DeepSeek Harness.` 换成工作区自备的文件内容
（典型用途：强制中文思考）。DSH 只提供 `includeHarnessIdentity: boolean` 开关（整体开关），**没有改文本的入口**，
本插件也不修改 DSH 源码。

- **DSH 侧事实**：该开场白由 `@deepseek-ai/dsh-system-prompt` 构造函数以**全局作用域**注册：
  `section({ name: 'harness:identity', order: -1000, text: 'You are an AI agent powered by DeepSeek Harness.' })`
  （`packages/core/system-prompt/src/index.ts:426`；`SECTION_ORDERS.HARNESS_IDENTITY = -1000`）。
- **覆盖原理（无需改 DSH）**：`dsh-scope` 的 `ScopedLayers.merge()` 先取 global 层条目，再用 scope-chain 的**同名**条目覆盖
  （`packages/core/scope/src/store.ts:208`），`SystemPrompt.assemble()` 正是用它（`:576`）。
  因此在本插件已用的 **agent 作用域**注册**同名** `harness:identity`，即可只替换这一句：
  - 全局层那份**永不改动** → 其他工作区/其他会话不受影响；
  - 作用域语义与档案 section 完全一致（internals.md），无需新增任何机制。
- **生效时机**：`ctx.on('agent/created', ...)`（该事件经 `ctx.serial` 串行派发并 `await`，可安全 await 读盘），
  **与下拉框选档案解耦** —— 新建会话 / 冷恢复 / DSH 重启后重连 / `compact` / `clear` 换 agent 对象时都会执行；
  切档案（`.activate`）时额外重读一次，便于改完 `.deepseek.yaml` 免重启生效。
- **幂等与清理**：`identity` Map（sessionId → `{disposer, sp, agent, file}`）；`unapplyIdentity()` 负责
  「dispose 旧注册 → `forceCleanSection(sp, agent, IDENTITY_SECTION)` 兜底 → 从 Map 删除」，
  成功路径**注册前**与**「不覆盖」路径**（未配置 / 文件不存在 / 文件为空）都调用它。
- ⚠️ **`forceCleanSection` 新增 `name` 参数，且对 `harness:identity` 禁用 global 层清扫**：
  global 层那份是 DSH 自带开场白，直接 `delete` 会波及**所有**工作区（见 internals.md 的清扫范围说明）。
  这是本次改动最容易踩的坑。
- **失败策略：绝不抛出**（否则会阻断会话创建）。未配置（键缺失 / 值非字符串 / 空值）/ 文件不存在 /
  文件为空 / 无 systemPrompt 服务 → 一律保留 DSH 默认开场白，只 `warn` 一条带文件名的日志。
  **空文件视为未配置**——否则 system prompt 首段会整段消失。
- ⚠️ **「不覆盖」必须主动卸载（pkg-26 修复）**：上述失败分支以前只调 `prev.disposer()` 就返回，而 disposer
  在真实运行时可能静默失效（internals.md）→ 旧的 `harness:identity` 残留在 agent 作用域**继续覆盖**，
  表现为「`.deepseek.yaml` 里已经没有 `global_prompt`（或文件已删），开场白却还是被改了」的状态不一致。
  现统一走 `unapplyIdentity()`（`disposer()` + `forceCleanSection` 双保险）后再返回 `applied:false`；
  成功路径同样先卸载再注册（幂等，compact/clear 换 agent 对象亦安全）。
  清扫范围不变：`harness:identity` **只清该 agent 的 scoped 层**，global 层那份 DSH 自带开场白永远不动。
- **DSH-Think-zh 的关系**：该第三方插件走「在 persona 之后新增一个语言指令 section（order 2）」的注入路线，
  与本功能的「替换开场白」路线不同，二者可共存（section 名不同，互不覆盖）。
  本工作区 `doc/prompts/global.md` 的内容即等价于该插件的默认注入文本。
  > 排查记录（2026-09-15）：`/mnt/f/git/github/DSH-Think-zh` 的代码本身正确
  > （`inject: ['systemPrompt']` + `section()` 写法无误），**未生效的真因是它没被装进 profile**——
  > `~/.dsh/profiles/web/package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里都查无 `dsh-think-zh`，
  > 即从未被加载。需要的话按 deployment.md 用 `dsh plugin --profile web add github:Len7183/DSH-Think-zh` 安装。
- **验证手段**：
  - 下拉框悬停 title 尾部 `· 开场白覆盖: doc/prompts/global.md`；`.state` RPC 的 `globalPrompt` 字段；
  - 观察会话 system prompt：首段应为 `doc/prompts/global.md` 正文，且不再出现 `You are an AI agent powered by DeepSeek Harness.`；
  - 离线验证脚本 `scripts/verify-offline.mjs`（**90 项**，无需 DSH 运行时）：mock `ctx.get('fs'|'agents')` +
    捕获 `agent/created` 监听器与 `system-prompt/assemble` 瀑布，断言注册的 section 名/order/文本、
    多文件合并顺序、失败分支不抛异常、compact 重注册不撞名、global 层未被破坏，以及
    **「未配置 / 文件被删 / 文件被清空 → scoped 层无残留」**
    （用 `brokenDisposer` 复现 disposer 失效；反向对照：去掉 `forceCleanSection` 兜底则该 4 项失败）。
  - 项数演进（以脚本实际输出为准）：A 组「真实 `.deepseek.yaml` 结构守护 + 真实档案文件端到端解析」
    + E 组子代理继承与排队语义（pkg-27，见 internals.md）+ F 组 persona 段清空/替换
    （pkg-28，22 项，含 A14/A15 真实配置端到端守护，见 internals.md）。

### 子代理会话的档案继承 + 未激活会话的排队语义（2026-09-20，pkg-27 修复）

**症状**（用户报告）：由主代理委派出的子代理会话里，① one-shot 子代理会话没有下拉框（也没有输入区）；
② continuable 子代理会话有输入框和下拉框，但显示红字（疑似「会话不存在或未激活」），切回主会话再切回来红字消失；
③ 子代理的 system prompt 里**没有** `.deepseek.yaml` 档案正文。

**根因 1：`sessionExists()` 读错字段 → 未激活会话被误判为「不存在」并报红字**

- DSH `sessionPersistence.list()` 返回 `SessionPersistenceSnapshot[]`，会话标识在 **`snapshot.header.id`**，
  顶层**没有** `id`（`packages/session/session-persistence/src/index.ts:50`）。
- 旧代码 `list.some((h) => h.id === sessionId)` **恒为 false** → internals.md 的延迟激活判据永远判「会话不存在」，
  `activate` 直接返回 `{ok:false, error:'会话不存在或未激活'}` → Client 渲染红字。
- 触发面：任何 `agents.get(sessionId)` 取不到 agent 的会话。子代理会话几乎必然命中
  （子代理结算后不驻留；子代理会话也一般不在 `sessions` 内存表）。
- ⚠️ 切换会话后「红字消失」是**假象**：React 重新挂载把 error state 清掉了，而 Client `autoFired`
  已记录该 sessionId → 不再重试 → 档案**始终没注入**。这正是「红字消失后子代理仍然没有档案」的原因。

**根因 2：档案注入是「客户端 RPC 驱动」的，而子代理会话没有 UI 入口**

- `system_prompts` 档案只在 `.activate`（下拉框自动加载 default / 手动切换）时注册；one-shot 子代理会话
  被 DSH `ui-subagent` 用**只读 composer** 接管整个 `conversation.composer` 链
  （`packages/client/ui-subagent/src/client/index.ts` 的 `selectReadOnlySubagent` → `SubagentReadOnlyComposer`），
  `conversation.input.left/right` 槽**根本不渲染** → 既没有下拉框，也没有 `activate` 调用；
- continuable 子代理会话则撞上根因 1（红字）。

**根因 3：DSH 的 scope 链不继承父 agent 的层，父会话已选档案不会自动落到子代理身上**

- 子代理创建时 `applyChildComposition()` 调 `agentPresets.composeFrom(childCtx, parent.ctx)`
  （`packages/subagent/subagent/src/child-agent.ts:205`），其实现是
  `bindScopeParent(agentKey, standing.key)`——把子代理 scope 的父级绑到 **preset 的 standing mount**，
  **不是父 agent 的 scope key**（`packages/preset/agent-presets/src/index.ts:484`）。
- `dsh-scope` 的注册视图只沿这条链向下继承（`packages/core/scope/src/index.ts` 的 `scopeChainOf`），
  因此**父 agent 作用域里注册的档案 section 对子代理不可见**。
- 实测印证：子代理的 system prompt 里**有** `workspace.global_prompt` 的 `harness:identity` 覆盖
  （因为它走 `agent/created` 自动路径，与作用域继承无关），**没有**档案正文。

**修复（Host，`src/core/host.js`）**

1. `sessionExists()` 改用 `snapshot.header.id`（兼容旧形态的顶层 `id`），且**降级为日志判据**；
2. `activate` 在 agent 缺失时**一律** `pending` 排队（`{ok:true, pending:true}`），只在查不到任何记录时写一条 warn
   ——不再报红字；这样 continuable 子代理 / 冷会话在被创建或冷恢复（`agent/created`）时都能拿到档案；
3. 新增 `persistedCwd()` + `resolveCwd()`：`.profiles` RPC 在「显式 cwd → 缓存 → agent header」都失败后，
   从持久化 header 兜底解析 cwd（子代理未驻留时唯一可用的路径，见 internals.md 的 cwd 解析顺序）；
4. `agent/created` 新增**子代理档案继承**：`header.origin === 'subagent'` 时，
   取父会话（`header.parentSession`）`active`/`pending` 中的档案 → 无则 `default` → 再否则首个可用档案，
   经 `enqueue` 串行 `applyActivation()` 注册；注册只作用于**该子代理自己的 agent 作用域**（不影响父/兄弟）。
   与排队的关系是「**显式选择优先**」：`pending` 命中时先应用排队档案，不再走继承；
5. 子代理会话的 cwd 在 `agent/created` 时写入 `cwdCache`，供其之后的 RPC（未驻留期间）使用。

**修复（Client，`src/core/client.js`）**

1. `.profiles` 请求**成功即 `setFatal(null)`**：首帧 cwd 尚未就绪时 Host 会返回一次「会话工作区未就绪」，
   旧实现只 set profiles、从不 clear fatal → 该临时错误把下拉框**永久抑制**（fatal 分支 `return null`，连红字都没有）；
2. 子代理会话（session summary `origin === 'subagent'`）与会话摘要**尚未就绪**时，**跳过**自动加载 default
   （档案由 Host 继承，避免重复激活与竞态）；
3. 下拉框悬停 title 标注 `· 子代理会话(继承父会话档案)`。

**已知边界（不是 bug）**

- **one-shot 子代理会话没有输入区** → 下拉框无处显示（DSH 设计，插件无法绕过；要显示只能改挂槽位，如
  `conversation.session.header.leading`）；其档案由 Host 继承注入，查看其对话时 system prompt 已是父档案。
- **历史子代理会话**（本次修复前创建的）提示词已定型，无法回溯注入；只对之后新建的子代理生效。
- Host 内存 `active` 随 DSH 重启清空：父会话重新打开时会自动重新加载 default，之后的子代理继承那个选择。

**验证**

- `node scripts/verify-offline.mjs` → **90/90**（E 组 14 项覆盖子代理继承 `ai`/`default` 回退、普通会话不注入、
  显式选择优先、`header.id` 匹配、cwd 兜底、不报 error、开场白与档案共存）；
- 反向对照：把 `sessionExists()` 的匹配改回顶层 `s.id` → **E9/E10 立即失败**（`cwd=null` + 误报 warn），
  恢复后 90/90；
- 运行时实测（2026-09-20）：让子代理转述自身 system prompt，确认修复前「有 `global_prompt` 覆盖、无档案正文」。

**修复后人工验证**：新建一个 continuable 子代理 → 其 system prompt 应含
「【当前会话已通过界面选择 .deepseek.yaml 提示词档案「<name>」…】」且角色设定与父会话一致；子代理会话不再冒红字。

### persona 段清空 / 替换 `deployment:persona-prefix`（2026-10-16 新增）

**目标**：去掉（或替换）系统提示词开头**由 preset 自带**的那句
`You are a coding agent powered by the {{model}} model.`（段名 `deployment:persona-prefix`，order 0）——
即 internals.md 的 `harness:identity`（第 1 句）之外的**第 2 句**，并要能按工作区配置。
设计依据见 `persona-override.md`。

**为什么必须走 `system-prompt/assemble` 监听器（不能照搬 internals.md）**：

- `@deepseek-ai/dsh-system-prompt` 的 `section()` 用 `NamedEntries` 保证**同层名字唯一**
  （`prompt section "…" is already registered in this scope`）；
- 而 `deployment:persona-prefix` 这个槽位在 **agent 层已有 owner**——preset 的
  `@deepseek-ai/dsh-persona` 行（`PERSONA_PREFIX_SECTION`）就在该作用域注册同名 section。
  DSH 自己正是靠「两边同名」让 preset 顶掉部署级那份的，插件挤不进这个槽位；
- 与 internals.md 的差别就在这：`harness:identity` 只注册在 **global 层**（构造函数里），agent 层同名
  shadow 可用；persona 段在 agent 层已被占用，**只能改写装配结果**。

**实现落点（`src/core/host.js`）**：

| 符号 | 职责 |
|---|---|
| `PERSONA_SECTION` | `'deployment:persona-prefix'`（段名常量，与 DSH 的 `PERSONA_PREFIX_SECTION` 同值） |
| `loadWorkspace()` | 一次解析 `.deepseek.yaml`：档案 + `global_prompt` + `personaPrompt` / `personaClear`（唯一读盘入口） |
| `resolvePersonaText(cwd)` | 求值覆盖（**每次装配都重新调用**，不缓存）；任何异常退化为「本次不改写」 |
| `installPromptOverride()` | 在 agent 作用域 ctx 挂 `system-prompt/assemble` 监听器，改写该段 |
| `applyPersona()` / `unapplyPersona()` | 挂载 / 释放（`persona` Map：sessionId → `{disposer, agent}`，`ctx.on('dispose')` 一并清理） |
| `warnOnce()` | 一次性告警入口（装配每步都求值，同一问题不能每步刷屏） |

- **挂载点**：`ctx.on('agent/created')`（与 `applyIdentity` 并列，**在 pending 排队分支之前**——
  排队分支会提前 return，但 persona 覆盖与档案选择无关，必须照挂）。覆盖新建 / 冷恢复 /
  DSH 重启后重连 / `compact` / `clear` 换 agent 对象；重复 `agent/created` 先释放旧监听器再重挂。
  **子代理会话同样挂载**（与开场白覆盖同路径）。
- **求值时机**：监听器内每次装配现读现算 → 改 `.deepseek.yaml`、改替换源文件、切档案都**无需重启
  DSH，也无需重挂监听器**；代价是每个模型步两次小文件读。

**配置键**（`.deepseek.yaml` → `workspace`）：

| 键 | 语义 |
|---|---|
| `persona_prompt: <path>` | 用该文件正文**替换** persona 段（路径相对会话 cwd，与档案 `file` 同规则；占位符替换见 internals.md） |
| `persona_clear: true` | **清空** persona 段（写入 `text: ''`；**该键优先于** `persona_prompt`） |
| 两键都缺省 | **完全不改写**——绝不误删 preset 原有的 persona |

- ⚠️ **语义与 `global_prompt` 不同**：`global_prompt` 把「空值 / 空文件」都当**未配置**；本功能的
  目的恰恰是「清空」，所以清空必须由**显式键**表达（不能沿用「空即未配置」）。替换源为空文件 →
  等价清空（`''`）；替换源**读不到** → 本次不改写（保留 preset 原文 + 一次性 warn）。
- ⚠️ **要「无痕」就写空串，不要写空格**：`renderPrompt()` 结尾是
  `.filter((text) => text.length > 0).join("\n\n")`——空串段被丢弃；`" "` 长度为 1 会被保留，
  反而多出一个只含空格的段落。
- ⚠️ **装配阶段 `section.text` 已是解析后的字符串**（`assemble()` 对函数式 text 已调用过一次），
  直接赋新串是安全的。替换正文里的 `{{…}}` 仍会按原 persona 段的插值规则处理（见 features.md 的风险说明）。

**三条自律（使用最强机制的代价，勿破坏）**：

1. **只改 `sections`**：`tools` / `contexts` / `variables` 必须原样透传——改坏 `tools` 会毁掉工具
   schema，丢掉 `contexts` 会丢工作目录等运行时上下文，覆盖 `variables` 会打断 `dsh-agent` 在监听器里
   做的 provider/model 捕获；
2. **绝不 `catch` 掉 `next()` 的异常后返回空 assembly**：官方 waterfall 由框架调度，抛错会被上游正确
   处理；自行吞掉再返回 `{sections: [], …}` 会让下游对 `sections` 的处理崩溃，用户侧表现为
   「任务做到一半突然像换了个人」「状态存不下来」这类极难定位的故障（这个坑是真实踩过的）；
3. **不动 `name` / `order`**，只改 `text`（空串即「没有这段」）——排序交给框架，避免与其它插件争位置。

**段名漂移诊断**：装配结果里找不到 `deployment:persona-prefix`（DSH 改段名，或该 preset 未挂 persona 行）
→ 原样返回 + **一条** warn（`warnOnce`）。

**第 1 句 `harness:identity` 走声明式开关（不走监听器）**——落点是**插件自带的 `cordis.patch.yml` 顶层**
（与 `- insert:` 平级）：

```yaml
# cordis.patch.yml（插件自带 patch 层，随包分发；- insert: 与它平级）
- id: system-prompt
  config:
    includeHarnessIdentity: false
```

- **顶层覆盖条目不要写 `name`**：写了会被当成「新增行」解析并报
  `disabling profile plugin row …: its declared dsh requirements cannot be validated: Cannot read properties of undefined (reading 'startsWith')`；
- **两处只能写一处（profile 层优先级更高）**：插件 patch 是 **bundle 层**；
  `~/.dsh/profiles/web/cordis.patch.yml`（profile 层）在**所有 bundle 层之后**应用，两处都写时 profile
  那条会整块盖掉插件这条（并顺带替换掉插件里将来可能新增的键），是「配置不生效」类疑难杂症的源头。
  **2026-10-16 已把该覆盖从 profile patch 搬进插件 patch**，profile patch 里原有的同款条目已删除；
  之后重装插件（`dsh plugin --profile web add file:$(pwd)`）会自动带上这条，无需再手工维护 profile；
- 该条目会替换 web-app 层设的 `personaPrefix`（host 层 persona 回落 `''`）：Web 会话无感（被 preset
  的 persona 行 shadow），只影响 TUI 那类无 preset 的场景；
- **需要重启 `dsh web` 才生效**（bundle patch 只在启动时应用，新建会话不算）。

**⚠️ Minimal 模式不适用（本项目不使用该模式）**：minimal 的 persona 行带 `complete: true`，
`assemble()` 在 waterfall **之后**把 `sections` 恢复成 `[completeSection]`，会把本监听器的改写整段丢弃
→ **静默失效**（不报错、不警告，只是提示词里那段没被改）。
**排查口诀：某个会话里提示词没生效 → 先看它当前是哪个模式（Standard / cordis / ptc 均可，minimal 不行），
而不是翻代码。**

**验证**：

- 离线 `node scripts/verify-offline.mjs` → **90/90**（F 组 22 项：清空 / 替换 / 占位符 / 两键缺省不改写 /
  clear 优先 / 空文件 / 读盘失败一次性 warn / 每次装配重新求值 / 段名落空 / 只改 sections / 不吞异常 /
  不动 name·order / 子代理同样挂载 / 重复 `agent/created` 不重复挂载；A14-A15：真实 `.deepseek.yaml`
  端到端守护，跟着配置走、不写死值）；
- 反向对照（四次）：只返回 `{sections}` → **F5** 失败；`catch` 住异常返回空 assembly → **F19** 失败；
  把清空写成 `' '` → **A15/F2/F3/F10/F15/F22** 六项失败；临时移除 `persona_clear` → 仍 90/90
  （证明 A15 不写死配置值）；
- 运行时人工验证：**新建会话** → 系统提示词里不再出现
  `You are a coding agent powered by the …model.`，同时工作区 `AGENTS.md` 的注入（语言要求 /
  文件修改规范）仍在（两件事互不影响：persona 只改一个 section）。

---
