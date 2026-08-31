# dsh-profile-selector — DSH Web GUI 提示词档案选择插件（双模式）

> **用途**：把 `.deepseek.yaml` 的 `system_prompts` 档案切换做成 DSH Web GUI 功能——
> 在输入卡片工具行渲染「profile-<档案名>」下拉框，选中档案后将其正文注入**当前会话**的
> system prompt（含档案 `temperature` 参数），刷新不丢。
>
> **双模式架构**（2026-08-18 起）：
> - **开发模式（动态插件）**：`cordis_define` + `cordis_run` 定义于 DSH 进程内存，pluginId `dshy-1`（Host 分配不可改），
>   槽位 `conversation.input.left`（工具行左侧、权限选择器右侧），RPC `dshprofile.*`，section `dsh-profile:profile`。
> - **发布模式（静态插件）**：`dsh plugin --profile web add file:$(pwd)` 安装，插件名 `dsh-profile-selector`，
>   槽位 `conversation.input.right`（工具行右侧、发送键前），RPC `dshprofile-static.*`，section `dsh-profile:profile-static`。
> - **核心共用**：两套壳共享 `src/core/`（yaml 解析 + host/client 工厂），仅 ID/槽位/RPC 通道不同（见 §三）。
>
> **状态**：✅ 已迁移为独立项目 `dsh-scene`（源码 + 提示词档案 + 工作区配置一体化管理，git 仓库管理，2026-08-18）
> **版本说明**：Package 编号按插件实例计数，DSH 进程重启后重新从 pkg-1 计数（动态插件定义在进程内存，
> 重启即丢，需重新部署——见 §8.1）；
> 本仓库功能演进以「功能版本」为准（见 §七 版本历史，当前 = pkg-23：修复静态 Client 不激活的真正根因——`export default apply` 导致 loader `unwrapExports` 解包成裸函数、inject 丢失）。
> **档案约束**（属提示词档案内容，与插件逻辑无关）：客户不持有现货、不做备兑；标的=上证50ETF华夏（510050）。

---

## 一、项目结构（文件清单）

| 文件 | 内容 |
|---|---|
| `src/core/yaml.js` | **共享核心**：迷你 YAML 解析器（纯函数，零依赖） |
| `src/core/host.js` | **共享核心**：Host 半区工厂 `hostCore(ctx, opts, rpc)`（双模式共用） |
| `src/core/client.js` | **共享核心**：Client 半区工厂 `clientCore(ctx, opts, deps)`（双模式共用） |
| `src/dynamic/host.js` | 动态模式 Host 壳模板（`/*__CORE_*__*/` 占位符，构建时内联核心） |
| `src/dynamic/client.js` | 动态模式 Client 壳模板（同上） |
| `src/static/host.js` | 静态模式 Host 壳（ESM import 核心；`connection.rpc.handle` 适配） |
| `src/static/client.js` | 静态模式 Client 壳（ESM import 核心；`connection.rpc.call` 适配） |
| `build.mjs` | 双模式构建脚本（动态内联 → `dist/dynamic/`；静态 esbuild → `lib/`） |
| `cordis.patch.yml` | 静态模式挂载层（`dsh plugin` 安装时插入 loader） |
| `package.json` | 项目元信息（`dsh.bundle.patch` / `dsh.client` / `exports` / `build` 脚本） |
| `dist/dynamic/{host,client}.js` | **构建产物**：动态函数体（cordis_define 用；勿手改） |
| `lib/{index,client}.js` | **构建产物**：静态 bundle（勿手改） |
| `doc/prompts/default.md` | 默认档案正文（期权分析角色；`{{date}}`、`{dataDir}`、`{fileDir}` 占位符） |
| `doc/prompts/dev.md` | 开发档案正文（开发工程师角色；`{{date}}`、`{workspace}` 占位符） |
| `.deepseek.yaml` | 工作区配置（`system_prompts` 源；被插件解析，含 `parameters.temperature`） |
| `README.md` | 本文档（功能 + 开发说明 + 版本史 + 已知坑） |
| `pnpm-workspace.yaml` | pnpm 构建策略（`allowBuilds: esbuild: true`，允许 esbuild 跑安装脚本） |
| `.gitignore` | 忽略 `node_modules/`、`.pnpm-store/`、`.idea/` 等 |

**运行期依赖**（DSH 提供，只读参考，勿改）：
- DSH 源码：`/home/j/.nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`
- 构建依赖：`esbuild`（devDependency `^0.28.2`）+ `react`（dependency `^19.2.8`，仅供静态 client bundle 的 seed word
  解析用；动态模式用闭包符号不依赖它）——均经 `pnpm install` 安装。

---

## 二、功能与 UI

1. **下拉框位置**（双模式不同，见 §三）：
   - 动态（开发）：输入卡片底部工具行左侧，`[+][🛡 Workspace Write][▾profile-default][模型][上下文][发送]`。
     实现：Client 注册 `conversation.input.left` 槽（list, scope session），顺序排在权限选择器（accessSelect）之后。
   - 静态（发布）：工具行右侧、发送键前，`[+][🛡 Workspace Write][模型][上下文][▾profile-default][发送]`。
     实现：Client 注册 `conversation.input.right` 槽。
2. **选项文案**：`profile-<title>`——title 取档案子项的可选 `name` 字段（如 `default: { name: "分析师" }` → `profile-分析师`），
   缺省回退为档案 key（如 `dev` 无 `name` → `profile-dev`）。无空值项、无"系统默认"项。
3. **默认行为**：新会话打开时**自动加载 `default` 档案**（若配置中没有 default 则加载第一个档案）；
   每个会话只自动触发一次（Client `autoFired` Set）。
4. **切换**：选中即切换该会话的档案正文；成功反馈仅显示在 select 悬停 title（tooltip）
   （`已切换: dev · temp 0.2`），**不渲染行内文字**（避免挤动布局导致下拉框错位）；仅失败渲染红色 `.err`。
5. **持久性**：档案状态存于 Host 内存 `active` Map（sessionId → 档案），刷新页面不丢（激活的是同一 Host 进程）；
   DSH 重启后需重新激活（新会话打开时自动加载 default）。
6. **注入内容**：`【当前会话已通过界面选择 .deepseek.yaml 提示词档案「<name>」，以下为该档案的完整指令，请以其中的角色设定与任务要求为准执行】\n\n<档案正文>`，
   占位符替换规则见 §五。

---

## 三、架构总览（双模式）

### 3.1 双模式隔离表（ID 与布局必须不同）

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

### 3.2 数据流（以动态模式为例；静态模式仅 RPC 通道不同）

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

### 3.3 核心/壳分层

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

## 四、RPC 协议（Host handlers）

> 前缀随模式变化：动态 `dshprofile.*` / 静态 `dshprofile-static.*`（下表以动态为例）。

| handler | 入参 | 返回 | 说明 |
|---|---|---|---|
| `dshprofile.profiles` | `{sessionId, cwd?}` | `{profiles:[{name,title,file,parameters}], cwd}` 或 `{profiles:[], error}` | 解析工作区 `.deepseek.yaml` 的 `system_prompts`；`name`=档案 key，`title`=档案可选 `name` 字段（缺省=key，下拉框显示用）；cwd 解析顺序：① 客户端显式传入的 `args.cwd`（来自会话 store，最可靠）→ ② Host 缓存 → ③ `agents.get(sessionId).session.header.cwd`；解析不到返回 `cwd:null` + 明确错误，**不回退** `sandboxPolicy.workspaceRoot`（见 §六-7） |
| `dshprofile.state` | `{sessionId}` | `{active: profileName\|null}` | 当前会话激活的档案（Host 内存态） |
| `dshprofile.activate` | `{sessionId, profile, cwd?}` | `{ok, profile, temperature?, cleaned?}` 或 `{ok:false, error}` | 切换档案；错误信息带 `[diag: ...]` 诊断段（见 §六-4） |

**RPC 通道差异**（核心代码不感知，由壳适配）：
- 动态：`harness.handle(method, handler)` 直接注册；handler 返回业务结果；Client `host.call(method, args)` 直接拿结果。
- 静态：`connection.rpc.handle('/rpc', handler, {authority:'loopback'})` 注册；handler 返回
  `RpcResult`（`{ok:true,value}` / `{ok:false,error}`）；Client `connection.rpc.call('/rpc', method, args)` 返回
  `RpcResult`，由壳解包（`ok` 时取 `value`，否则 throw）。method 名即 endpoint（如 `dshprofile-static.profiles`）。

**激活流程（dshprofile.activate 内部）**：
1. `enqueue(sessionId, fn)` 入会话级串行队列（同一会话的激活严格顺序执行）；
2. 幂等短路：`active.get(sessionId).profileName === name` → 直接返回，不重注册；
3. 有旧档案 → `disposer()` + `disposeTemp()`，并从 `active` 删除；
4. 读 `.deepseek.yaml`（迷你 YAML 解析，仅支持 map/list of scalars）→ 找档案 → 读档案文件
   （档案 `file` 为**相对会话 cwd 的路径**，`fs.resolve(profile.file, { cwd })`，如 `doc/prompts/default.md`）；
5. 替换占位符（见 §五）→ `profileText()` 生成注入正文；
6. `forceCleanSection(sp, agent)` 强制清除残留 section（见 §六-3）；
7. `sp.section({name:'dsh-profile:profile', order:-50, text})` 注册（`sp = agent.ctx.systemPrompt`）；
8. 档案 `parameters.temperature`（数字）→ `agent.ctx.on('agent/request', ...)` 瀑布注入（见 §六-5）；
9. `active.set(sessionId, {...})` 记录 `{profileName, disposer, disposeTemp, temperature, sp, agent}`。

**YAML 解析能力边界**（迷你解析器，勿超纲使用）：
- 仅支持 `key: value` / `key:`（嵌套 map，缩进栈）/ 列表暂不支持复杂结构；
- 标量：字符串（去引号）、布尔、数字、null；`#` 注释行忽略；
- 足够解析 `.deepseek.yaml` 的 `workspace.system_prompts.<name>.file|parameters.temperature` 结构。

---

## 五、占位符替换规则

激活时对档案正文做如下替换（cwd = 会话工作区）：

| 占位符 | 替换为 |
|---|---|
| `{{date}}` | 当天 `YYYY-MM-DD` |
| `{workspace}` | 会话 cwd |
| `{dataDir}` | `cwd/output` |
| `{fileDir}` | `cwd/doc/ai` |

> 注意：档案正文（`doc/prompts/*.md`）中的 `F:\git\node\optionData\...` 字样是编写档案时的示例绝对路径，
> 激活时只做上表占位符替换，**示例路径不会被改写**。若档案要引用会话工作区内的目录（如 `doc/ai`、`output`），
> 应改用占位符（`{dataDir}`/`{fileDir}`/`{workspace}`），使注入内容随会话 cwd 自动适配；数据目录确在会话 cwd 之外时，
> 需调整 `substitute()`（src/core/host.js）的映射或修改档案内路径写法。

---

## 六、核心机制与已知坑（开发必读，勿破坏）

### 1. 作用域语义：section 注册在「Agent 会话作用域」
- `agent.ctx` = `createScope(loopCtx, loopInstance).ctx.extend({agent})`（dsh-agent-loop/lib/index.js:376），
  scope key = **AgentLoop 实例**（`agents.get(sessionId)` 返回同一对象）。
- `agent.ctx.systemPrompt` 经 Cordis traceable 代理访问：方法调用时 `this.ctx` 被重绑为**调用方上下文**，
  `sp.section()` 注册进**该 agent 作用域**的 PromptLayer（`ScopedLayers.scoped.get(scope)`）。
- 同名重复注册抛：`prompt section "dsh-profile:profile" is already registered in this scope`。

### 2. ⚠️ 竞态（原 pkg-9→pkg-10 修复）：激活必须串行
- 症状：连续切换时偶发 "already registered" + 下拉框错位。
- 根因：自动加载与手动切换（或 React 严格模式双挂载）几乎同时 activate，两边都读到 `active.get()===undefined`，
  后到的 `section()` 撞名。**修复**：Host `enqueue()` 按会话串行 + 幂等短路；Client `autoFired` 每会话只自动加载一次。

### 3. ⚠️ disposer 在真实运行时可能静默失效（原 pkg-12 核心修复）
- 症状：已串行+幂等（pkg-10）仍报 "already registered"。
- 根因：`sp.section()` 返回的 disposer 在真实运行时（traceable 影子上下文路径）调用后**并未真正移除注册**
  （单测用裸 `createScope`+`ScopedLayers` 复现不出，机制疑在影子 ctx 的 effect 归属）；旧注册残留 → 下次 `section()` 撞名。
- **修复（安全网）**：`forceCleanSection(sp, agent)` —— 直接遍历 `sp.layers.scoped`（scope key === agent 的层）
  与 `sp.layers.global`，把 `layer.sections.data`（普通 Map）里的 `SECTION_NAME` 直接 `delete`。
  注册前与插件 `ctx.on('dispose')` 时都执行。**这是当前唯一可靠的移除手段，请保留**。

### 4. 诊断探针
- activate 出错时错误信息追加 `[diag: scopedHits=?; agentKeyHit=?; globalHit=?]`——
  统计残留 section 落在哪些层（`sp.layers.scoped` 的层数 / 是否在 agent 作用域 / 是否在 global 层）。
- 若再次出现 "already registered"，用该 diag 定位残留位置后，把对应层加入 forceCleanSection 的清扫范围。

### 5. temperature 注入（agent/request 瀑布）
- `.deepseek.yaml` 档案的 `parameters.temperature` 经 `agent.ctx.on('agent/request', async (_p,next)=>{...})`
  监听，在瀑布返回的请求配置对象上覆盖/删除 `temperature` 字段。
- `top_p` **无法应用**：DSH `LlmCallConfig` 与 deepseek 适配器均无 top_p 字段，故档案的 top_p 被忽略（有注释说明）。

### 6. 槽位选择约束（位置已定，勿改）
- 动态：`conversation.input.left`（list, scope session, replaceRisk none）→ 渲染在 InputBar `.row → .tools`
  中 resident chrome（accessSelect 之后、leftItems 位置）= 权限选择器右侧、输入框下方工具行。
- 静态：`conversation.input.right`（list, scope session）→ 工具行右侧、发送键前。
- `conversation.input.plan` 是 **single** 槽且被系统占用（占用会顶掉系统计划按钮），**不可用**。
- `conversation.input.dock` 在 hero+active 均渲染但 header actions 在 blank/hero 整体隐藏——曾导致下拉框重复/错位，已弃用。
- 成功反馈**禁止**渲染行内文字（挤动布局 → 下拉框错位），只允许 title/tooltip；错误 `.err` 限宽 24ch 省略。

### 7. 其他
- ⚠️ **cwd 解析绝不回退部署级根**（pkg-18 修复）：`sandboxPolicy.workspaceRoot` 是**部署级**工作区根（非会话 cwd）。
  旧实现 `sessionCwd()` 在 `agents.get(sessionId)` 取不到 cwd 时回退到它——切换对话时 agent 短暂未就绪/被 dispose，
  会去读用户目录下的 `.deepseek.yaml`（如 `/home/j/workspace/dsh/.deepseek.yaml`）报错。
  **修复**：① Client 从会话 store（槽位标准 prop `useSessions` → `s.byId[sessionId].cwd`）显式传 `cwd` 给 RPC，
  不依赖 agent 是否在线；② Host `sessionCwd(sessionId, explicitCwd)` 按「显式 cwd → 缓存 → agent header」解析并缓存；
  ③ 解析不到返回 `null` + 明确错误「会话工作区未就绪」，**绝不回退** `sandboxPolicy.workspaceRoot`。
- 每会话 `active` Map 在 Host 内存；DSH 进程重启即清空（新会话打开时 Client 自动重新加载 default）。
- 插件停用：动态 `cordis_stop dshy-1`（pluginId 为 Host 分配不可改，显示名称 dsh-profile-selector；停用后已注入的 section 由 dispose 清理）；
  静态 `dsh plugin --profile web remove dsh-profile-selector`（或编辑 profile 的 cordis.patch.yml）。

### 8. ⚠️ 激活延迟（pkg-19 修复）：会话存在但 agent 未激活时不得报红字
- 症状：新建/切换会话后下拉框已加载（`.profiles` 成功），但自动加载或手动切换报红字「会话不存在或未激活」。
- 根因：`agents.get(sessionId)` 只返回**已激活**的 agent。会话在客户端 store / 持久化中存在，但 agent 尚未发布
  （新会话空白期、冷会话、DSH 重启后会话未恢复）——agent 要等首次 `session.prompt` 才经 `agents.resume()` 发布。
  旧实现把「agent 未激活」误判为「会话不存在」，直接硬失败。
- **修复**：activate 在 agent 缺失时先查会话是否真实存在（`sessions` 内存表 + `sessionPersistence.list()`，
  查询失败按存在处理——宁可延迟也不误报红字）：
  - 会话存在 → 暂存 `pending` Map（sessionId → {profile, cwd}），返回 `{ok:true, profile, pending:true, temperature:null}`；
  - 会话确实不存在 → 才返回 `{ok:false, error:'会话不存在或未激活'}`。
- **自动应用**：`ctx.on('agent/created', ({agent}) => ...)` 监听 agent 发布（`agent.id === sessionId` 为 pending 键），
  经 `enqueue` 串行调用共享的 `applyActivation()` 注册 section——保证在首次模型调用前注入。
- 配套：`.state` 把 pending 档案也算当前选中（下拉框不跳回默认）；Client 对 `pending:true` 显示
  「已排队(会话激活后生效)」提示而非红字；`dispose` 时清空 pending。
- 注意：`agent/created` 是 scoped emit（`this: Scoped<Agent>`），监听器必须用 `agent.id`（=== session.id）查 pending。

### 8. ⚠️ 静态 RPC 通道 /rpc 是共享通道，只能注册一次（2026-08-18 修复）
- 症状：web 重启后 loader entry 应用失败：`webserver: duplicate prefix route "/rpc"`，插件被回滚（boot 图无该插件）。
- 根因：`connection.rpc.handle('/rpc', ...)` 在 webServer 注册 **prefix 路由**（`webServer.register({kind:'prefix', path: channel})`），
  同名通道重复注册即抛错。旧静态适配器对每个 RPC 方法（profiles/state/activate）各调一次 → 第二次起冲突。
- **修复**：`src/static/host.js` 用 `routes` Map 登记 method→handler，**单次** `connection.rpc.handle('/rpc', ...)`，
  handler 内按 `endpoint`（即 method 名，如 `dshprofile-static.profiles`）分发；未知名返回 `{ok:false, error:{code:'not-found'}}`。
- 配套：patch 与壳代码均声明 `inject: ['connection']`（硬依赖等待 connection 服务就绪，否则 apply 静默退出、/rpc 不注册）。
- 浏览器侧调用形态（dsh-client-connection/lib/client.js `createWebConnectionRpc`）：`rpc.call(channel, endpoint, payload)`
  → `POST {channel}/{endpoint}`，body `{type:'client-request', rpcId, method: endpoint, payload}`；返回 `full.result`（即 RpcResult）。
- 动态模式无此问题：`harness.handle` 每个 method 独立注册，无共享通道概念。

---

## 七、版本历史

> **编号说明**：原插件实例按 Package 编号演进至 pkg-12（run-10）。DSH 进程重启 / 新 AI 会话重新定义后，
> Package 编号重新从 pkg-1 计数——本仓库「功能版本」沿用原编号（当前功能版本 = pkg-19：延迟激活修复），
> 每次会话实际定义的 Package 编号见 `cordis_inspect_self dshy-1`（pluginId 为 Host 分配，不可改）。
> 例如本会话（2026-08-18 第二次）DSH 重启后动态插件丢失，重新定义为 dshy-1/pkg-1（run-1），
> profile 文案更新为 dshy-1/pkg-2（run-2），功能等价于本表的 pkg-16。

| 功能版本 | 变更 | 结果 |
|---|---|---|
| pkg-1..3 | 初版：读 yaml、header/dock 渲染 | 空档案 bug：workspaceRoot 用错（部署级根）→ 改用 session cwd |
| pkg-4 | 修 Cloud client 逗号表达式 bug（`if (fatal) return A, B` 只返回 B） | 错误文案正常 |
| pkg-5 | 移除 header 注册，仅留 dock | 消除重复下拉框 |
| pkg-6 | 位置迁移：`conversation.input.left`（plan 槽被占） | 落到权限选择器右侧工具行 |
| pkg-7 | 迷你 YAML 解析 + 占位符替换 + 前置头文案 | 档案正文正确注入 |
| pkg-8 | temperature 经 agent/request 瀑布注入（top_p 放弃） | 采样参数生效 |
| pkg-9 | Client 自动加载 default + 成功提示 | — |
| pkg-10 | **竞态修复**：Host enqueue 串行 + 幂等短路；Client autoFired + 成功反馈移入 title | 竞态消除 |
| pkg-11/12 | **force-clean 修复**：注册前强制删除残留 section + 诊断探针 + dispose 兜底 | ✅ "already registered" 彻底解决（run-10） |
| pkg-13 | **更名 dsh-profile-selector**：RPC handler `dshyaml.*`→`dshprofile.*`、section `dsh-yaml:profile`→`dsh-profile:profile`、CSS 类 `dshyaml-inline`→`dshprofile-inline`、槽 id `dsh-yaml-profile`→`dsh-profile-selector`；pluginId 仍为 `dshy-1`（Host 分配不可改） | ✅ 名称全量同步（2026-08-18） |
| pkg-14 | **双模式重构**：核心抽到 `src/core/`（yaml/host/client 工厂，零依赖）；动态壳 `src/dynamic/`（构建内联核心）+ 静态壳 `src/static/`（ESM import + `connection.rpc` 适配）；`build.mjs` 产出 `dist/dynamic/`（cordis_define 用）与 `lib/`（静态 bundle）；`cordis.patch.yml` + `package.json` dsh 元数据；静态模式 ID 全隔离（section `dsh-profile:profile-static`、RPC `dshprofile-static.*`、槽 `conversation.input.right`、槽 id `dsh-profile-selector-static`、CSS `dshprofile-static-`） | ✅ 双模式共用核心（2026-08-18，run-5） |
| pkg-15 | **静态 RPC 通道修复**：`/rpc` 是共享通道只能注册一次——旧适配器每方法各注册一次导致 `webserver: duplicate prefix route "/rpc"` 挂载回滚；改为单次注册 + `routes` Map 按 endpoint 分发；patch 与壳均声明 `inject: ['connection']` 硬依赖 | ✅ 静态模式挂载成功，RPC 通道 HTTP 200 验证通过（2026-08-18） |
| pkg-16 | **下拉框文案「提示词」→「profile」**：选项 `profile-<name>`、label/title `profile`（原「提示词档案」）、loading/错误/空态同步；仅 Client 显示文案改动，Host 注入正文的前置说明保留中文「提示词档案」 | ✅ 双模式同步生效（2026-08-18，动态 run-2 / 静态 bundle 按需读取） |
| pkg-17 | **档案子项支持可选 `name` 字段**：Host `loadProfiles` 解析 `system_prompts.<key>.name` 并随 RPC 返回 `title`（缺省回退 key）；Client 下拉框选项/单档案展示/悬停 title 均显示 `profile-<title>`（如 `default` 有 `name:"分析师"` → `profile-分析师`，`dev` 无 `name` → `profile-dev`）；选项 value 与 activate 仍用档案 key，向后兼容 | ✅ 双模式同步生效（2026-08-19） |
| pkg-18 | **修复切换对话误读用户目录 `.deepseek.yaml`**：根因 `sessionCwd()` 在 agent 未就绪时回退部署级 `sandboxPolicy.workspaceRoot`（`/home/j/workspace/dsh`）。修复：① Client 从会话 store（`useSessions` → `s.byId[sessionId].cwd`）显式传 `cwd` 给 RPC；② Host `sessionCwd(sessionId, explicitCwd)` 按「显式 cwd → 缓存 → agent header」解析并缓存；③ 解析不到返回 `null` + 明确错误，**不回退部署根** | ✅ 双模式同步生效（2026-08-19，动态 run-1 / 静态需重启 web 加载新 host bundle） |
| pkg-19 | **修复「新建会话下拉框已加载但 activate 报『会话不存在或未激活』」**：根因 `agents.get(sessionId)` 只返回已激活 agent，会话存在但 agent 未发布（新会话空白期/冷会话/DSH 重启未恢复）被误判为会话不存在。修复：① activate 在 agent 缺失时查会话真实存在性（`sessions` + `sessionPersistence.list()`，查询失败按存在处理），存在则暂存 `pending` Map 并返回 `{ok:true, pending:true}`；② 新增 `ctx.on('agent/created')` 监听，agent 发布后经 `enqueue` 串行调用共享 `applyActivation()` 自动应用；③ `.state` 把 pending 档案算当前选中；④ Client 对 `pending:true` 显示「已排队(会话激活后生效)」而非红字；⑤ `dispose` 清空 pending。详见 §六-8 | ✅ 单测 10 项全过（2026-08-19）；动态 run-1 已生效；静态需重启 web 加载新 host bundle |
| pkg-20 | **工作区没有 `.deepseek.yaml` 时不显示下拉框**：Client 加载失败（fatal：读文件 ENOENT / cwd 未就绪 / RPC 失败）时不再渲染红色 `.err` 报错文字，改为 `return null` 直接不渲染下拉框；空档案（无 `system_prompts`）同样不渲染。仅切换失败仍渲染红色 `.err` 行内文字 | ✅ 双模式同步生效（2026-08-25，动态 run-1 已生效；静态需同步 bundle 后刷新页面） |
| pkg-21 | **DSH 0.1.2-alpha.2 升级兼容性核查（无代码改动）**：升级（0.1.1-rc.2 → 0.1.2-alpha.2，08-30 发布）后动态插件随进程重启丢失（进程内存，已知行为，按 §8.1 重新部署即恢复）。逐项核对新版 API 全部兼容：动态内置符号（harness/host.call/styles/React）、槽位注册格式 `{name,id,order,label}` 与 props（useSessions/sessionId）、Host 服务（fs/agents/sessions/sessionPersistence/sandboxPolicy/systemPrompt）、事件（agent/created、agent/request）、`PromptSection {name,order,text}`、静态 `connection`/`/rpc` 通道（新版加浏览器 auth fence，外部 curl 401 属预期）、`__ModuleLoader__` 协议、`forceCleanSection` 安全网（运行时内部结构未变）。**角色分工确认：动态仅开发调试，正式使用走静态模式**。详见 todo.md §2.6 | ✅ 动态重新部署即恢复（2026-08-31，dshy-1/pkg-1）；静态 bundle 与已提交版本逐字节一致，无需重编译，重装仅刷新 profile 副本 |
| pkg-22 | **修复静态 Client 在 DSH 0.1.2-alpha.2 下不激活（下拉框不渲染）**：根因 `package.json` 的 `dsh.client.inject` 在新版被当作 **cordis 服务等待列表**（boot 图插件条目的 inject），而旧值 `["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-slots"]` 指向**已不存在的包**（前者整个被移除；后者只是前端 require seed 模块、非服务）→ 条目永远 waiting → `apply` 永不执行。**修复**：`dsh.client.inject` 改为 `["slots", "connection"]`（与 `src/static/client.js` 的 `export const inject` 一致；`react` 由前端 seed 提供无需声明 external）。静态 Host 半区不受影响（patch 的 `inject: [connection]` 是真实服务，一直正常） | ⚠️ 该修复必要但**不充分**（见 pkg-23） |
| pkg-23 | **修复静态 Client 不激活的真正根因：`export default apply`**。pkg-22 后下拉框仍不显示，深挖 loader（`cordis-plugin-loader`）`unwrapExports`：`exports = exports.default ?? exports`——bundle 若导出 `default`（= apply 函数），解包后 plugin = **裸函数**，`plugin.inject` 丢失。静态 Host 有 patch YAML 的 `inject: [connection]`（loader 合并条目 options inject）所以正常；静态 **Client** 条目由 kernel 按名字创建（`o.create({name})`，无 options inject），只靠 bundle 导出的 inject 等待 slots/connection——丢失后 apply 立即执行、`ctx.get('connection')` 尚为 undefined → **静默 return → 无下拉框**。参考 `dsh-custom-header` 的 bundle（只导出 `{apply, inject}`，无 default）。**修复**：删除 `src/static/{host,client}.js` 的 `export default apply`，只导出 `{name, inject, apply}` / `{inject, apply}`；已用 `unwrapExports` 逻辑模拟验证新旧形状 | ✅ 2026-08-31 修复；需重装 + 重启 web + 刷新页面生效 |

**仓库整理（非插件功能版本，2026-08-18）**：独立为 git 仓库 `dsh-scene`——源码落盘 `src/`、档案并入 `doc/prompts/`、
`.deepseek.yaml` 与 `package.json` 随仓库管理，README 重构；双模式重构后删除旧的 `src/host.js`/`src/client.js`
（已被 `src/core/` + 双壳取代），新增 `.gitignore`（忽略 node_modules/.pnpm-store/.idea）与 `pnpm-workspace.yaml`
（`allowBuilds: esbuild: true`）。初次提交后，后续插件代码变更请在表中追加新的功能版本行。

---

## 八、如何部署（下次 AI 会话操作手册）

### 8.1 开发模式（动态插件，默认）

动态插件定义在**当前 DSH 进程内存**中；新会话/重启后需用源码重新构建并定义。步骤：

1. **加载技能**（开发前必读）：`skill: cordis-plugin-development`；需要时 `cordis_inspect_list/query` 查询
   `slots`/`systemPrompt`/`agents` 等契约与最新签名。
2. **构建**：`node build.mjs`（若改了 `src/core/` 或壳；产物在 `dist/dynamic/` 与 `lib/`）。
3. **读取产物**：`dist/dynamic/host.js` + `dist/dynamic/client.js`（构建产物，含内联核心；勿手改）。
4. **定义插件**：`cordis_define { plugin: { kind: 'new', idPrefix: 'dshy' }, name: 'dsh-profile-selector', purpose, code: { host, client } }`
   —— `code.host`/`code.client` 必须传 **dist/dynamic 产物全文**（不是 src/dynamic 模板，模板含占位符会报
   `hostCore is not defined`）。新会话用 new；已有 dshy-1 时用 `kind:'existing', pluginId:'dshy-1'` 追加 Package。
5. **激活**：`cordis_run { pluginId, packageId, mode: 'run'|'update' }`（首次 run；换版本 update）。
   ⚠️ approval policy 为 ask 时，首次运行需用户在 GUI 批准（awaiting-approval）；批准后为异步 starting。
6. **验证**（GUI 手动）：
   - 输入卡片工具行出现 `▾profile-<name>` 下拉框（权限选择器右侧）；
   - 新会话自动加载 default（悬停 title 显示 `默认加载: default · temp 0.2`）；
   - 连续快速切换 dev ↔ default 多次：无 "already registered"、下拉框不错位、title 显示 `已切换: ...`；
   - 发一条消息验证注入：回复开头/内容应体现「当前会话已通过界面选择 .deepseek.yaml 提示词档案」前置说明，
     且角色设定符合所选档案（default=期权交易员 / dev=开发工程师）。
   - 槽位占用可用 Inspect 确认：`Slots.listSubTree {root:'conversation.input.left'}` →
     occupants 应含 `dyn/dshy-1 → dsh-profile-selector (active)`。
7. **改动后落盘**：把更新后的核心/壳代码同步写回 `src/`，并在本 README §七 版本历史登记变更。

> ⚠️ **DSH 进程重启会丢动态插件**（实测 2026-08-18 发生两次）：重启 web（`dsh web`）即重启整个 DSH，
> 内存中的动态插件定义全部消失（`cordis_inspect_self dshy-1` 报 "no dynamic plugin"）。
> 无需惊慌：按步骤 2-5 重新构建 + define + run 即可，功能版本不变（§七 编号说明）。
> 静态模式（8.2）不受影响——它装在 profile 里，重启后自动加载。

### 8.2 发布模式（静态插件）

1. **构建**：`node build.mjs`（产出 `lib/index.js` + `lib/client.js`）。
2. **安装**：`dsh plugin --profile web add file:$(pwd)`（把本仓库作为 file: 依赖加入 web profile；
   会 reconcile `dsh.profile.bundles`，`cordis.patch.yml` 挂载 Host 半区，`dsh.client` 收录 Client bundle）。
3. **重启 web**：静态 bundle 在启动时收录进 `window.__DSH_BOOT__` 图，需重启 `dsh --profile web` 服务后刷新页面。
4. **验证**：
   - GUI：工具行右侧、发送键前出现 `▾profile-<name>` 下拉框（静态槽位 `conversation.input.right`）；
     其余行为与动态模式一致（RPC 前缀 `dshprofile-static.*`，section `dsh-profile:profile-static`）。
   - RPC 通道（curl 直探，无需 GUI）：
     ```bash
     curl -s -X POST http://127.0.0.1:3080/rpc/dshprofile-static.profiles \
       -H "content-type: application/json" \
       -d '{"type":"client-request","rpcId":"probe","method":"dshprofile-static.profiles","payload":{"sessionId":"probe"}}'
     # 期望：HTTP 200 + {"type":"server-response","rpcId":"probe","result":{"ok":true,"value":{...}}}
     # 若返回 405/404 → 通道未注册；查 §六-8 与 inject: [connection]
     ```
   - 槽位占用：`Slots.listSubTree {root:'conversation.input.right'}` → occupants 应含
     `dsh-profile-selector-static (active)`。
5. **卸载**：`dsh plugin --profile web remove dsh-profile-selector`（或编辑 profile 的 cordis.patch.yml 移除 insert 行）。

> ⚠️ **file: 依赖是拷贝，不是符号链接**（实测 2026-08-18）：`dsh plugin add file:$(pwd)` 把仓库**拷贝**进
> `~/.dsh/profiles/web/node_modules/dsh-profile-selector/`。改代码/构建后 pnpm 不会自动刷新
> （`pnpm install` 报 "Already up to date"），profile 里还是旧拷贝。
> 同步方式（任选）：① 重装 `dsh plugin --profile web add file:$(pwd)`（先 remove 更稳）；
> ② 手动 `cp -r` 覆盖 profile 拷贝（lib/、dist/、src/、cordis.patch.yml、package.json）；
> ③ 长期方案：改用 `link:` 或 symlink 依赖。同步后仍需重启 web 生效。

### 8.3 双模式共存注意

- 开发与发布**可同时存在**（ID 全隔离，见 §3.1），但同一会话同一时刻只会被其中一套注入
  （section 名不同，互不覆盖）。若两套都激活，下拉框会出现两个（left + right），属预期。
- 改动核心 `src/core/` 后必须**重新构建**再部署：动态走 `node build.mjs` → 重新 define/run；
  静态走 `node build.mjs` → 同步拷贝（见 8.2 注意）→ 重启 web。

**常用调试手段**：
- `cordis_inspect_self dshy-1` → 版本指针 / currentPackageId / 诊断；`cordis_inspect_self dshy-1 <pkgId>` → 源码与运行错误
  （pluginId 为 Host 分配不可改；插件显示名称 dsh-profile-selector）。报 "no dynamic plugin" = DSH 重启丢了，重新部署。
- `Slots.listSubTree {root:'conversation.input.left'|'conversation.input.right'}` → occupants 含 `dsh-profile-selector`
  / `dsh-profile-selector-static` 且 active=true = client 半区已挂载；occupants 空 = client 未激活（检查浏览器刷新/页面加载）。
- 静态挂载状态：`curl -s http://127.0.0.1:3080/ | grep dsh-profile-selector`（boot 图 `__DSH_BOOT__` 应含它
  与 `/plugins/dsh-profile-selector/client.js`；不含 = 挂载失败/未重启，查 §六-8）。
- activate 出错时 GUI 红字带 `[diag: ...]`，据此定位残留 section 所在层。
- Host 内部事实（供对照）：`sp.layers.scoped`（Map，key=AgentLoop 实例）、`sp.layers.global.sections`（NamedEntries）、
  `layer.sections.data`（普通 Map，可直接 delete）。
- 静态模式 RPC 失败排查：确认 web profile 的 `connection` 行存在（dsh-web-app patch 自带），
  `curl -X POST http://127.0.0.1:3080/rpc/dshprofile-static.profiles`（信封见 §8.2-4）看响应体（`RpcResult` 形状）。

---

## 九、数据流与安全边界

- **读**：`fs.resolve/readText`（受 sandbox 约束；当前会话 policy=workspace-write，可读写工作区内的文件）；
  仅读 `.deepseek.yaml` 与其 `file` 指向的档案文件（`doc/prompts/`），不触碰其他数据。
- **写**：插件本身**不写盘**（激活状态在内存）；本仓库文件由开发期落盘维护。
- **作用域**：注入只影响发起激活的会话（agent 作用域 section + 该会话 `agent/request` 监听）；
  其他会话不受影响。
- **静态模式权限**：`connection.rpc.handle('/rpc', ..., {authority:'loopback'})` 仅接受 loopback 来源
  （`isTrustedApiRequest` 校验，非 loopback 返回 403）；静态 bundle 由 web profile 的 `dsh.client` 声明收录，
  仅服务本机 GUI 页面。
