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
| `dshprofile.profiles` | `{sessionId, cwd?}` | `{profiles:[{name,title,file,files,parameters}], globalPrompt, cwd}` 或 `{profiles:[], globalPrompt:null, error}` | 解析工作区 `.deepseek.yaml` 的 `system_prompts`（与 `global_prompt`，同一 `loadWorkspace()` 入口一次解析）；`name`=档案 key，`title`=档案可选 `name` 字段（缺省=key，下拉框显示用）；`files`=规范化后的路径数组（**即多文件合并顺序**），`file` 向后兼容（单文件=字符串 / 多文件=数组）；`globalPrompt`=开场白覆盖文件路径（null=未配置或配置无效）；cwd 解析顺序：① 客户端显式传入的 `args.cwd`（来自会话 store，最可靠）→ ② Host 缓存 → ③ `agents.get(sessionId).session.header.cwd`；解析不到返回 `cwd:null` + 明确错误，**不回退** `sandboxPolicy.workspaceRoot`（见《其他》） |
| `dshprofile.state` | `{sessionId}` | `{active: profileName\|null, globalPrompt: filePath\|null}` | 当前会话激活的档案 + 实际生效的开场白覆盖文件（Host 内存态 `active` / `identity` 两张 Map） |
| `dshprofile.activate` | `{sessionId, profile, cwd?}` | `{ok, profile, temperature?, cleaned?, globalPrompt?}` 或 `{ok:false, error}` | 切换档案；**同时重读 `global_prompt`**（用户改完 `.deepseek.yaml` 无需重启 DSH）；错误信息带 `[diag: ...]` 诊断段（见《诊断探针》）；档案 `file` 为数组时按声明顺序合并多文件正文，任一文件缺失 → `{ok:false, error}`（错误含「第 i/n 个 + 文件名」） |

**RPC 通道差异**（核心代码不感知，由壳适配）：
- 动态：`harness.handle(method, handler)` 直接注册；handler 返回业务结果；Client `host.call(method, args)` 直接拿结果。
- 静态：`connection.rpc.handle('/rpc', handler, {authority:'loopback'})` 注册；handler 返回
  `RpcResult`（`{ok:true,value}` / `{ok:false,error}`）；Client `connection.rpc.call('/rpc', method, args)` 返回
  `RpcResult`，由壳解包（`ok` 时取 `value`，否则 throw）。method 名即 endpoint（如 `dshprofile-static.profiles`）。

**激活流程（dshprofile.activate 内部）**：
1. `enqueue(sessionId, fn)` 入会话级串行队列（同一会话的激活严格顺序执行）；
2. **先重读开场白覆盖**：`applyIdentity(agent, sessionId, cwd)` —— 读 `.deepseek.yaml` 的 `workspace.global_prompt`，
   卸载旧注册后重注册 `harness:identity`（见《工作区开场白覆盖》）；
3. 幂等短路：`active.get(sessionId).profileName === name` → 直接返回，不重注册；
4. 有旧档案 → `disposer()` + `disposeTemp()`，并从 `active` 删除；
5. 读 `.deepseek.yaml`（`loadWorkspace()`：迷你 YAML 解析，支持 map / 标量 / **标量列表**）→ 找档案 →
   读档案文件（档案 `files` 为**相对会话 cwd 的路径数组**，逐个 `fs.resolve(rel, { cwd })`，
   如 `doc/prompts/default.md`；单文件档案等价于长度 1 的数组；`file` 兼容旧写法）；
6. 替换占位符（见《占位符替换规则》）→ `profileText()` 生成注入正文；
7. `forceCleanSection(sp, agent, SECTION_NAME)` 强制清除残留 section（见《disposer 在真实运行时可能静默失效》）；
8. `sp.section({name:'dsh-profile:profile', order:-50, text})` 注册（`sp = agent.ctx.systemPrompt`）；
9. 档案 `parameters.temperature`（数字）→ `agent.ctx.on('agent/request', ...)` 瀑布注入（见《temperature 注入》）；
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

### ⚠️ 竞态：激活必须串行

- 症状：连续切换档案时偶发 `already registered` + 下拉框错位。
- 机制：自动加载与手动切换（或 React 严格模式双挂载）几乎同时 `activate`，两边都读到
  `active.get() === undefined` → 后到的 `section()` 撞名。
- **对策**：Host `enqueue()` 按会话串行 + 幂等短路；Client `autoFired` 每会话只自动加载一次。
  改这两处时不要破坏串行性。

### ⚠️ disposer 在真实运行时可能静默失效

- 现象：`sp.section()` 返回的 disposer 调用后**并未真正移除注册**（traceable 影子上下文路径下；单测用裸
  `createScope` + `ScopedLayers` 复现不出），旧注册残留 → 下次 `section()` 撞名。
- **对策（安全网，请保留）**：`forceCleanSection(sp, agent, name?)` —— 直接遍历 `sp.layers.scoped`
  （scope key === agent 的层）与 `sp.layers.global`，把 `layer.sections.data`（普通 Map）里的目标 section 名
  `delete` 掉。**注册前**与插件 `ctx.on('dispose')` 时都执行；这是当前唯一可靠的移除手段。
  - `name` 省略时清理本插件自己的档案 section（`SECTION_NAME`）；
  - ⚠️ `name === 'harness:identity'` 时**跳过 global 层清扫**（那份是 DSH 自带开场白，删掉会波及所有工作区，
    见《工作区开场白覆盖》）。

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

- ⚠️ **cwd 解析绝不回退部署级根**：`sandboxPolicy.workspaceRoot` 是**部署级**工作区根（不是会话 cwd）；回退到它会在
  切换对话（agent 短暂未就绪 / 被 dispose）时去读**别的目录**下的 `.deepseek.yaml`。当前解析顺序：
  ① Client 从会话 store 显式传 `cwd`（不依赖 agent 是否在线）→ ② Host 缓存 → ③ agent header →
  ④ 持久化 header 兜底；都拿不到就返回 `null` + 「会话工作区未就绪」，**绝不回退**。
- 每会话 `active` Map 在 Host 内存；DSH 进程重启即清空（新会话打开时 Client 自动重新加载 default）。
- 插件停用：动态 `cordis_stop dshy-1`（pluginId 由 Host 分配、不可改，显示名为 dsh-profile-selector）；
  静态 `dsh plugin --profile web remove dsh-profile-selector`（详见 `deployment.md`）。停用后已注入的 section 由 dispose 清理。

### ⚠️ 激活延迟：agent 未激活时不得报红字

- 背景：`agents.get(sessionId)` 只返回**已激活**的 agent；会话可能已存在（客户端 store / 持久化）但 agent 尚未
  发布——新会话空白期、冷会话、DSH 重启后会话未恢复，agent 要等首次 `session.prompt` 才经 `agents.resume()`
  发布。在这里硬失败（报「会话不存在或未激活」）是错的。
- **当前行为**：`activate` 在 agent 缺失时**一律** `pending` 排队（sessionId → `{profile, cwd}`），返回
  `{ok:true, profile, pending:true, temperature:null}`；`sessionExists()` 只用来决定是否写一条 warn 日志
  （其匹配口径见《子代理会话的档案继承》）。
- **自动应用**：`ctx.on('agent/created', …)`（`agent.id === sessionId` 即 pending 键）→ 经 `enqueue` 串行调用
  `applyActivation()`，保证在首次模型调用前注入。该事件经 `ctx.serial` 串行派发并 `await`，故监听器内可安全
  await 读盘；**这个监听器同时承担 persona 段覆盖的挂载**（见《persona 段清空 / 替换》）。
- 配套：`.state` 把 pending 档案也算当前选中（下拉框不跳回默认）；Client 对 `pending:true` 显示
  「已排队(会话激活后生效)」而非红字；`dispose` 时清空 pending。
- 注意：`agent/created` 是 scoped emit（`this: Scoped<Agent>`），监听器必须用 `agent.id` 查 pending。

### ⚠️ 静态 RPC 通道 `/rpc` 共享，只能注册一次

- `connection.register(owner, '/rpc', handler)` 在 webServer 注册的是 **prefix 路由**：同名通道重复注册会抛
  `webserver: duplicate prefix route "/rpc"`，整个 loader entry 回滚（boot 图里就没有这个插件）。
- **当前实现**：`src/static/host.js` 用 `routes` Map 登记 method → handler，**只注册一次** `/rpc`，handler 内按
  `endpoint`（即 method 名，如 `dshprofile-static.profiles`）分发，未知名返回
  `{ok:false, error:{code:'not-found'}}`。**新增 RPC method 时不要再加一次注册。**
- 浏览器侧形态（`dsh-client-connection` 的 `createWebConnectionRpc`）：`rpc.call(channel, endpoint, payload)`
  → `POST {channel}/{endpoint}`，body `{type:'client-request', rpcId, method: endpoint, payload}`，返回 `RpcResult`。
- 动态模式无此问题：`harness.handle` 每个 method 独立注册。

### ⚠️ `connection.rpc.handle` 自 DSH 0.1.5-alpha.1 起失效

- 症状：挂载报 `cannot get property "webServer" without inject`（栈顶 `dsh-client-connection/lib/index.js`），
  loader entry 被回滚（profile 的 package.json 不留该依赖）。
- 根因：`rpc.handle` 的 owner 取 `this.ctx`——cordis 服务追踪构造的**影子 Context**（`symbols.shadow` 指向
  connection 服务自身 ctx），故 `owner.webServer` 是从 **connection 插件 fiber** 向上解析的。旧版 connection
  自身 inject 含 `webServer`，其 store 有该服务；**0.1.5-alpha.1 把 connection 的 inject 改成 `["credentials"]`**
  → 无论调用方 inject 什么都会抛。**调用方声明 `inject: ['webServer']` 无效**（解析起点在服务侧 fiber）。
- **当前实现**：`connection.register(ctx, '/rpc', handler)` —— 与 `rpc.handle` 同一实现，但 owner 由调用方显式传入
  （传本插件自己的 ctx，真实 ctx 无 shadow）；壳与 patch 均声明 `inject: ['connection', 'webServer']`。
  该写法在 0.1.2-alpha.3 与 0.1.5-alpha.1 语义下都已验证注册 `prefix:/rpc`。

### 工作区开场白覆盖 `harness:identity`

**目标**：把 DSH 第一方开场白 `You are an AI agent powered by DeepSeek Harness.` 换成工作区自备的文件内容
（`.deepseek.yaml` → `workspace.global_prompt`，典型用途是强制中文思考）。
> 该句现在**默认已被关掉**（plugins patch 的 `includeHarnessIdentity: false`，见《persona 段清空 / 替换》）；
> 本节讲的是「不想关掉、想换成自己的话」时怎么覆盖。

- **DSH 侧事实**：该段由 `@deepseek-ai/dsh-system-prompt` 构造函数以**全局作用域**注册
  （`name: 'harness:identity'`，order `-1000`）；DSH 只暴露 `includeHarnessIdentity` 布尔开关，没有改文本的入口。
- **覆盖原理**：`dsh-scope` 的 `ScopedLayers.merge()` 先取 global 层条目、再用 scope-chain 的**同名**条目覆盖，
  所以在本插件已用的 **agent 作用域**注册同名 `harness:identity` 即可只替换这一句；全局层那份**永不改动**，
  其他工作区 / 其他会话不受影响。
- **生效时机**：`agent/created` 时执行（与档案选择解耦）→ 新建会话 / 冷恢复 / DSH 重启后重连 / `compact` /
  `clear` 换 agent 对象都会跑；切档案（`.activate`）时额外重读一次。与 persona 段的差别：后者走装配监听器。
- **幂等与清理**：`identity` Map（sessionId → `{disposer, sp, agent, file}`）；`unapplyIdentity()` =
  「dispose 旧注册 → `forceCleanSection` 兜底 → 删 Map」，**成功路径与「不覆盖」路径都调它**
  （disposer 可能静默失效，见《disposer 在真实运行时可能静默失效》）。旧写法只在失败分支调 `disposer()`，
  会造成「配置已删、覆盖仍在」的状态不一致。
- ⚠️ **`forceCleanSection` 对 `harness:identity` 跳过 global 层清扫**（否则会波及所有工作区）。
- **失败策略：绝不抛出**（否则阻断会话创建）：未配置（键缺失 / 非字符串 / 空值）/ 文件不存在 / 文件为空 /
  无 systemPrompt 服务 → 保留 DSH 默认开场白 + `warn` 一条带文件名的日志。**空文件视为未配置**。

### 子代理会话的档案继承

子代理会话没有自己的 UI 入口（one-shot 子代理连输入区都没有 → `conversation.input.left/right` 槽不渲染），
档案只能由 **Host 侧**在 `agent/created` 时注入。三条支撑事实：

1. **DSH 的 scope 链不继承父 agent 的层**：`applyChildComposition()` → `agentPresets.composeFrom(childCtx, parent.ctx)`
   内部是 `bindScopeParent(agentKey, standing.key)`——把子代理 scope 的父级绑到 **preset 的 standing mount**，
   而不是父 agent 的 scope key。因此**父 agent 作用域里注册的档案 section 对子代理不可见**，必须在子代理自己的
   `agent.ctx` 上重新注册。
2. **`sessionPersistence` 快照的会话标识在 `snapshot.header.id`**（顶层没有 `id`）→ 匹配必须用它；但该判据
   **只用于决定是否写一条 warn 日志**，不作为「会话不存在」的硬失败依据（见《激活延迟》）。
3. **cwd 兜底**：未驻留的子代理会话在内存里查不到 agent/session，`resolveCwd()` 用持久化 header 兜底解析 cwd
   （它就是父会话的 cwd）。

**实现**：`agent/created` 中若 `header.origin === 'subagent'` → 取父会话（`header.parentSession`）的
`active` / `pending` 档案 → 无则 `default` → 再否则首个可用档案，经 `enqueue` 串行 `applyActivation()` 注册；
**注册只作用于该子代理自己的作用域**（不影响父/兄弟）。与排队的关系是「**显式选择优先**」：`pending` 命中时
先应用排队档案，不再走继承。

**排查要点（历史踩过的坑）**：

- 「切回主会话再切回来，红字消失」是**假象**：React 重挂载清掉了 error state，而 Client `autoFired` 已记录该
  sessionId → 不再重试 → 档案始终没注入。**看到问题消失 ≠ 问题解决**。
- `.profiles` 请求**成功即 `setFatal(null)`**：首帧 cwd 尚未就绪时 Host 会返回一次「会话工作区未就绪」；
  旧实现只 set profiles、从不 clear fatal → 该临时错误把下拉框**永久抑制**（连红字都不显示）。

**已知边界（不是 bug）**：

- one-shot 子代理会话**没有输入区** → 下拉框无处显示（DSH 只读 composer 接管 `conversation.composer` 链；
  要显示只能改挂槽位，如 `conversation.session.header.leading`）；其档案由 Host 继承注入。
- **历史**子代理会话提示词已定型、无法回溯注入；其下拉框会回退显示 `profile-<default>` 而实际未注入
  （2026-09-20 决定不处理该显示不一致）。
- Host 内存 `active` 随 DSH 重启清空：父会话重新打开时自动重载 `default`，之后的子代理继承那个选择。

### persona 段清空 / 替换 `deployment:persona-prefix`

**目标**：去掉（或替换）系统提示词开头**由 preset 自带**的那句
`You are a coding agent powered by the {{model}} model.`（段名 `deployment:persona-prefix`，order 0）——
即 `harness:identity`（第 1 句）之外的**第 2 句**，且可按工作区配置。
面向使用者的配置语义（**默认清空**、`persona_clear: false` 才保留、`persona_prompt` 替换、优先级表）见 `features.md`。

**为什么必须走 `system-prompt/assemble` 监听器**：

- `systemPrompt.section()` 用 `NamedEntries` 保证**同层名字唯一**：同层重复注册直接抛
  `prompt section "…" is already registered in this scope`；
- 而 `deployment:persona-prefix` 这个槽位在 **agent 层已有 owner**——preset 的 `@deepseek-ai/dsh-persona` 行
  （`PERSONA_PREFIX_SECTION`）就在该作用域注册同名 section；DSH 自己正是靠「两边同名」让 preset 顶掉部署级
  那份的。插件挤不进这个槽位；
- 与开场白覆盖的差别：`harness:identity` 只注册在 **global 层** → agent 层同名 shadow 可用；persona 段在
  agent 层已被占用 → **只能改写装配结果**。代价是必须自己保留其它插件的贡献（见下面的三条自律）。

**实现落点（`src/core/host.js`）**：

| 符号 | 职责 |
|---|---|
| `PERSONA_SECTION` | `'deployment:persona-prefix'`（与 DSH 的 `PERSONA_PREFIX_SECTION` 同值） |
| `loadWorkspace()` | 一次解析 `.deepseek.yaml`：档案 + `global_prompt` + `personaPrompt` / `personaClear` |
| `resolvePersonaText(cwd)` | 求值覆盖（**每次装配都重新调用**，不缓存）；任何异常退化为「本次不改写」 |
| `installPromptOverride()` | 在 agent 作用域 ctx 挂 `system-prompt/assemble` 监听器，**只改该段的 `text`** |
| `applyPersona()` / `unapplyPersona()` | 挂载 / 释放（`persona` Map：sessionId → `{disposer, agent}`；`ctx.on('dispose')` 一并清理） |
| `warnOnce()` | 一次性告警入口（装配每步都求值，同一问题不能每步刷屏） |

- **挂载点**：`agent/created`（与 `applyIdentity` 并列，且**在 pending 排队分支之前**——排队分支会提前 return，
  而 persona 覆盖与档案选择无关，必须照挂）；重复触发时先释放旧监听器再重挂；**子代理会话同样挂载**。
- **求值时机**：监听器内每次装配现读现算 → 改 `.deepseek.yaml`、改替换源文件、切档案都**无需重启 DSH、
  无需重挂监听器**；代价是每个模型步两次小文件读。
- **空串 vs 空格**：`renderPrompt()` 结尾是 `.filter((text) => text.length > 0).join("\n\n")`——清空必须写 `''`；
  `' '` 长度为 1 会被保留，反而多出一个只含空格的段落。
- **装配阶段 `section.text` 已是解析后的字符串**（`assemble()` 对函数式 text 已调用过一次），直接赋新串是安全的；
  替换正文里的 `{{…}}` 仍按插值规则处理（风险见 `features.md`）。
- **段名漂移诊断**：装配结果里找不到该段（DSH 改名，或该 preset 未挂 persona 行）→ 原样返回 + **一条** warn。

**三条自律（使用最强机制的代价，勿破坏）**：

1. **只改 `sections`**：`tools` / `contexts` / `variables` 必须原样透传——改坏 `tools` 会毁掉工具 schema，
   丢掉 `contexts` 会丢工作目录等运行时上下文，覆盖 `variables` 会打断 `dsh-agent` 在监听器里做的 provider /
   model 捕获；
2. **绝不 `catch` 掉 `next()` 的异常后返回空 assembly**：官方 waterfall 由框架调度，抛错会被上游正确处理；
   自行吞掉再返回 `{sections: [], …}` 会让下游对 `sections` 的处理崩溃，用户侧表现为「任务做到一半突然像换了
   个人」「状态存不下来」这类极难定位的故障；
3. **不动 `name` / `order`**，只改 `text`（空串即「没有这段」）——排序交给框架，避免与其它插件争位置。

**第 1 句 `harness:identity` 不走监听器，走声明式开关**——落点是**插件自带的 `cordis.patch.yml` 顶层**
（与 `- insert:` 平级）：

```yaml
- id: system-prompt
  config:
    includeHarnessIdentity: false
```

- **不要写 `name`**：顶层条目按 id 命中既有行；写了会被当成「新增行」解析，报
  `disabling profile plugin row …: Cannot read properties of undefined (reading 'startsWith')`；
- **两处只能写一处**：插件 patch 是 **bundle 层**；`~/.dsh/profiles/web/cordis.patch.yml`（profile 层）在所有
  bundle 层之后应用、优先级更高——两处都写时 profile 那条会整块盖掉本条（并顺带替换掉插件里将来可能新增的
  键），是「配置不生效」类疑难杂症的源头；
- 该条目会替换 web-app 层给 host 设的 `personaPrefix`（host 层回落为 `''`）：Web 会话无感（被 preset 的 persona
  行 shadow），只影响 TUI 那类无 preset 的场景；
- **需要重启 `dsh web` 才生效**（bundle patch 只在启动时应用，新建会话不算）。

**⚠️ Minimal 模式不适用（本项目不使用该模式）**：minimal 的 persona 行带 `complete: true`，`assemble()` 在
waterfall **之后**把 `sections` 恢复成 `[completeSection]`，会把本监听器的改写整段丢弃 → **静默失效**
（不报错、不警告，只是提示词里那段没被改）。
**排查口诀：某个会话里提示词没生效 → 先看它当前是哪个模式（Standard / cordis / ptc 均可，minimal 不行），
而不是翻代码。**

---

> 各条坑的**发现过程与修复历史**（症状、根因分析、逐步修复、当时的验证）不在此重复——
> 见 `CHANGELOG.md` 对应的 pkg 行与 git 历史；本文件只描述**当前机制与必须避开的陷阱**。
