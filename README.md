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
> 本仓库功能演进以「功能版本」为准（见 §七 版本历史，当前 = pkg-26：档案 `file` 支持**数组**（按序合并多文件提示词）+ `global_prompt` 未配置/文件缺失时**不再覆盖**）。
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
| `scripts/verify-offline.mjs` | **离线验证脚本**（零依赖，66 项：真实 `.deepseek.yaml` 结构守护 + YAML 解析 / 多文件合并 / 开场白覆盖语义 / 子代理档案继承 / 回归；`node scripts/verify-offline.mjs`） |
| `cordis.patch.yml` | 静态模式挂载层（`dsh plugin` 安装时插入 loader） |
| `package.json` | 项目元信息（`dsh.bundle.patch` / `dsh.client` / `exports` / `build` 脚本） |
| `dist/dynamic/{host,client}.js` | **构建产物**：动态函数体（cordis_define 用；勿手改） |
| `lib/{index,client}.js` | **构建产物**：静态 bundle（勿手改） |
| `doc/prompts/default.md` | 默认档案正文（期权分析角色；`{{date}}`、`{dataDir}`、`{fileDir}` 占位符） |
| `doc/prompts/dev.md` | 开发档案正文（开发工程师角色；`{{date}}`、`{workspace}` 占位符） |
| `doc/prompts/global.md` | **工作区级开场白覆盖正文**（由 `.deepseek.yaml` → `workspace.global_prompt` 指向；用于**替换** DSH 默认开场白 `You are an AI agent powered by DeepSeek Harness.`，见 §六-10） |
| `.deepseek.yaml` | 工作区配置（`system_prompts` 档案源 + `global_prompt` 开场白覆盖；被插件解析，含 `parameters.temperature`）。档案 `file` 可为**字符串或字符串数组**（数组=按序合并多个提示词文件）；`global_prompt` **缺失/文件不存在时不会被覆盖**（见 §六-10） |
| `README.md` | 本文档（功能 + 开发说明 + 版本史 + 已知坑） |
| `ops-notes.md` | **运维备忘 / 已知特性与排查记录**（部署环境、profile/bundle 同步、上游版本回归、升级核查；原 `todo.md` §2，2026-09-20 拆分重命名，条目编号 1-10，见其文件头） |
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
6. **注入内容**：`【当前会话已通过界面选择 .deepseek.yaml 提示词档案「<name>」，以下为该档案的完整指令，请以其中的角色设定与任务要求为准执行】\n\n<档案正文>`；
   档案 `file` 可以是**单一路径或路径数组**——数组时按**声明顺序**逐个读盘，用空行（`\n\n`）依次拼接为一段正文，
   前置说明头只加一次；任一文件读不到即**整体失败**（红字报错，不注入「半个档案」）。占位符替换规则见 §五。
7. **工作区级开场白覆盖（`workspace.global_prompt`）**：把 `.deepseek.yaml` 的
   `workspace.global_prompt` 指向的文件正文，注册为**同名 section `harness:identity`**（agent 作用域），
   从而**完全替换** DSH 自带的第一方开场白 `You are an AI agent powered by DeepSeek Harness.`
   ——用于消除该英文自我介绍导致的「AI 默认用英文思考」问题。
   - 与档案选择**解耦**：不依赖下拉框，`agent/created` 时对每个会话自动生效；
   - 配置示例：`workspace: { global_prompt: doc/prompts/global.md }`（路径相对**会话 cwd**，与档案 `file` 规则一致）；
   - **未配置（键缺失 / 值非字符串 / 空值）/ 文件不存在 / 文件为空 → 一律「不覆盖」**：先卸载已有覆盖
     （`disposer` + `forceCleanSection` 兜底，见 §六-10），再保留 DSH 默认开场白（只记 warn，不阻断会话创建）；
   - 生效确认：下拉框悬停 title 追加 `· 开场白覆盖: <file>`；`.state` RPC 返回 `globalPrompt` 字段。
8. **子代理会话（2026-09-20 新增）**：DSH 委派出的子代理会话（session header `origin: 'subagent'`）由 **Host 侧自动继承
   父会话当前档案**（父无选择则回退 `default`），无需界面操作；Client 对子代理会话**不再自动加载档案**
   （避免与 Host 继承重复、并绕开「未激活」竞态），悬停 title 追加 `· 子代理会话(继承父会话档案)`。
   - **不再出现红字**：未激活的会话（含子代理、冷会话）一律走排队（`pending`），不再回 `会话不存在或未激活`（§六-11）。
   - ⚠️ **one-shot 子代理会话没有输入区**：DSH `ui-subagent` 会用只读 composer 接管 `conversation.composer` 链，
     `conversation.input.left/right` 槽整体不渲染——这是 DSH 的既有设计，插件无法在该会话显示下拉框
     （continuable 子代理会话在有输入区时正常显示）。详见 §六-11。

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
| `dshprofile.profiles` | `{sessionId, cwd?}` | `{profiles:[{name,title,file,files,parameters}], globalPrompt, cwd}` 或 `{profiles:[], globalPrompt:null, error}` | 解析工作区 `.deepseek.yaml` 的 `system_prompts`（与 `global_prompt`，同一 `loadWorkspace()` 入口一次解析）；`name`=档案 key，`title`=档案可选 `name` 字段（缺省=key，下拉框显示用）；`files`=规范化后的路径数组（**即多文件合并顺序**），`file` 向后兼容（单文件=字符串 / 多文件=数组）；`globalPrompt`=开场白覆盖文件路径（null=未配置或配置无效）；cwd 解析顺序：① 客户端显式传入的 `args.cwd`（来自会话 store，最可靠）→ ② Host 缓存 → ③ `agents.get(sessionId).session.header.cwd`；解析不到返回 `cwd:null` + 明确错误，**不回退** `sandboxPolicy.workspaceRoot`（见 §六-7） |
| `dshprofile.state` | `{sessionId}` | `{active: profileName\|null, globalPrompt: filePath\|null}` | 当前会话激活的档案 + 实际生效的开场白覆盖文件（Host 内存态 `active` / `identity` 两张 Map） |
| `dshprofile.activate` | `{sessionId, profile, cwd?}` | `{ok, profile, temperature?, cleaned?, globalPrompt?}` 或 `{ok:false, error}` | 切换档案；**同时重读 `global_prompt`**（用户改完 `.deepseek.yaml` 无需重启 DSH）；错误信息带 `[diag: ...]` 诊断段（见 §六-4）；档案 `file` 为数组时按声明顺序合并多文件正文，任一文件缺失 → `{ok:false, error}`（错误含「第 i/n 个 + 文件名」） |

**RPC 通道差异**（核心代码不感知，由壳适配）：
- 动态：`harness.handle(method, handler)` 直接注册；handler 返回业务结果；Client `host.call(method, args)` 直接拿结果。
- 静态：`connection.rpc.handle('/rpc', handler, {authority:'loopback'})` 注册；handler 返回
  `RpcResult`（`{ok:true,value}` / `{ok:false,error}`）；Client `connection.rpc.call('/rpc', method, args)` 返回
  `RpcResult`，由壳解包（`ok` 时取 `value`，否则 throw）。method 名即 endpoint（如 `dshprofile-static.profiles`）。

**激活流程（dshprofile.activate 内部）**：
1. `enqueue(sessionId, fn)` 入会话级串行队列（同一会话的激活严格顺序执行）；
2. **先重读开场白覆盖**：`applyIdentity(agent, sessionId, cwd)` —— 读 `.deepseek.yaml` 的 `workspace.global_prompt`，
   卸载旧注册后重注册 `harness:identity`（见 §六-10）；
3. 幂等短路：`active.get(sessionId).profileName === name` → 直接返回，不重注册；
4. 有旧档案 → `disposer()` + `disposeTemp()`，并从 `active` 删除；
5. 读 `.deepseek.yaml`（`loadWorkspace()`：迷你 YAML 解析，支持 map / 标量 / **标量列表**）→ 找档案 →
   读档案文件（档案 `files` 为**相对会话 cwd 的路径数组**，逐个 `fs.resolve(rel, { cwd })`，
   如 `doc/prompts/default.md`；单文件档案等价于长度 1 的数组；`file` 兼容旧写法）；
6. 替换占位符（见 §五）→ `profileText()` 生成注入正文；
7. `forceCleanSection(sp, agent, SECTION_NAME)` 强制清除残留 section（见 §六-3）；
8. `sp.section({name:'dsh-profile:profile', order:-50, text})` 注册（`sp = agent.ctx.systemPrompt`）；
9. 档案 `parameters.temperature`（数字）→ `agent.ctx.on('agent/request', ...)` 瀑布注入（见 §六-5）；
10. `active.set(sessionId, {...})` 记录 `{profileName, disposer, disposeTemp, temperature, sp, agent}`。

**YAML 解析能力边界**（迷你解析器，勿超纲使用）：
- 支持 `key: value`（标量）/ `key:`（嵌套 map，缩进栈）/ `- item`（**标量列表**，即 `file` 的多文件写法）；
- 标量：字符串（去引号）、布尔、数字、null；`#` 注释行与空行忽略；无法识别的行按「忽略」处理，**不抛错**；
- 列表实现（pkg-26）：`key:` 空值先懒创建占位对象，若该层首个内容行是 `- item` 就**原地升级为数组**。
  此前 `- item` 行被直接丢弃 → `file:` 数组被解析成 `{}` → 整个档案被 `typeof file === 'string'` 过滤掉；
- 不支持：锚点、多行字符串（`|` / `>`）、嵌套列表、列表内 map；
- 足够解析 `.deepseek.yaml` 的 `workspace.system_prompts.<name>.file|parameters.temperature` 与
  `workspace.global_prompt` 结构。

---

## 五、占位符替换规则

激活时对**档案正文**与 **`global_prompt` 覆盖正文**做如下替换（cwd = 会话工作区）：

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
- **修复（安全网）**：`forceCleanSection(sp, agent, name?)` —— 直接遍历 `sp.layers.scoped`（scope key === agent 的层）
  与 `sp.layers.global`，把 `layer.sections.data`（普通 Map）里的目标 section 名直接 `delete`。
  注册前与插件 `ctx.on('dispose')` 时都执行。**这是当前唯一可靠的移除手段，请保留**。
  - `name` 省略时清理本插件自己的档案 section（`SECTION_NAME`）；
  - ⚠️ 当 `name === 'harness:identity'` 时**跳过 global 层清扫**（§六-10）：那份是 DSH 自带开场白，
    删掉会波及所有工作区；替换只允许走 scoped shadow。

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
- **自动应用**：`ctx.on('agent/created', async ({agent}) => ...)` 监听 agent 发布（`agent.id === sessionId` 为 pending 键），
  经 `enqueue` 串行调用共享的 `applyActivation()` 注册 section——保证在首次模型调用前注入。
  **pkg-25 起该监听器承担两件事**：① 无条件执行工作区开场白覆盖 `applyIdentity()`（见 §六-10，与 pending 无关）；
  ② 命中 `pending` 时再 `enqueue` 应用排队档案。事件经 `ctx.serial` 串行派发并 `await`，故监听器内可安全 await 读盘。
- 配套：`.state` 把 pending 档案也算当前选中（下拉框不跳回默认）；Client 对 `pending:true` 显示
  「已排队(会话激活后生效)」提示而非红字；`dispose` 时清空 pending。
- 注意：`agent/created` 是 scoped emit（`this: Scoped<Agent>`），监听器必须用 `agent.id`（=== session.id）查 pending。
- ⚠️ **pkg-27 修正（2026-09-20）**：本节第 3 条的「会话确实不存在 → 才返回 `{ok:false, error:'会话不存在或未激活'}`」已**取消**。
  该判据依赖 `sessionExists()`，而它当时用 `sessionPersistence.list()` 快照的**顶层 `s.id`** 匹配，实际上
  快照的 id 在 `snapshot.header.id` 上 → 恒为 false → 子代理会话 / 冷会话被误判成「不存在」并报红字，
  延迟激活随之失效（客户端 `autoFired` 只自动加载一次，被这次误报吞掉）。现在**一律** `pending` 排队，
  `sessionExists()` 只用于决定是否写一条 warn 日志。语义、根因与验证见 §六-11。

### 8. ⚠️ 静态 RPC 通道 /rpc 是共享通道，只能注册一次（2026-08-18 修复）
- 症状：web 重启后 loader entry 应用失败：`webserver: duplicate prefix route "/rpc"`，插件被回滚（boot 图无该插件）。
- 根因：`connection.rpc.handle('/rpc', ...)` 在 webServer 注册 **prefix 路由**（`webServer.register({kind:'prefix', path: channel})`），
  同名通道重复注册即抛错。旧静态适配器对每个 RPC 方法（profiles/state/activate）各调一次 → 第二次起冲突。
- **修复**：`src/static/host.js` 用 `routes` Map 登记 method→handler，**单次** `connection.rpc.handle('/rpc', ...)`，
  handler 内按 `endpoint`（即 method 名，如 `dshprofile-static.profiles`）分发；未知名返回 `{ok:false, error:{code:'not-found'}}`。
- 配套：patch 与壳代码均声明 `inject: ['connection']`（硬依赖等待 connection 服务就绪，否则 apply 静默退出、/rpc 不注册）。
  ⚠️ 2026-09-09 更新：DSH 0.1.5-alpha.1 起 `rpc.handle` 失效、改 `connection.register(ctx, ...)` 且需加 inject webServer，见 §六-9。
- 浏览器侧调用形态（dsh-client-connection/lib/client.js `createWebConnectionRpc`）：`rpc.call(channel, endpoint, payload)`
  → `POST {channel}/{endpoint}`，body `{type:'client-request', rpcId, method: endpoint, payload}`；返回 `full.result`（即 RpcResult）。
- 动态模式无此问题：`harness.handle` 每个 method 独立注册，无共享通道概念。

### 9. ⚠️ DSH 0.1.5-alpha.1 回归：`connection.rpc.handle` 全员失效，改用 `connection.register(ctx, ...)`（2026-09-09 修复）
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

### 10. 工作区开场白覆盖 `harness:identity`（2026-09-15 新增）

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
  - 作用域语义与档案 section 完全一致（§六-1），无需新增任何机制。
- **生效时机**：`ctx.on('agent/created', ...)`（该事件经 `ctx.serial` 串行派发并 `await`，可安全 await 读盘），
  **与下拉框选档案解耦** —— 新建会话 / 冷恢复 / DSH 重启后重连 / `compact` / `clear` 换 agent 对象时都会执行；
  切档案（`.activate`）时额外重读一次，便于改完 `.deepseek.yaml` 免重启生效。
- **幂等与清理**：`identity` Map（sessionId → `{disposer, sp, agent, file}`）；`unapplyIdentity()` 负责
  「dispose 旧注册 → `forceCleanSection(sp, agent, IDENTITY_SECTION)` 兜底 → 从 Map 删除」，
  成功路径**注册前**与**「不覆盖」路径**（未配置 / 文件不存在 / 文件为空）都调用它。
- ⚠️ **`forceCleanSection` 新增 `name` 参数，且对 `harness:identity` 禁用 global 层清扫**：
  global 层那份是 DSH 自带开场白，直接 `delete` 会波及**所有**工作区（见 §六-3 的清扫范围说明）。
  这是本次改动最容易踩的坑。
- **失败策略：绝不抛出**（否则会阻断会话创建）。未配置（键缺失 / 值非字符串 / 空值）/ 文件不存在 /
  文件为空 / 无 systemPrompt 服务 → 一律保留 DSH 默认开场白，只 `warn` 一条带文件名的日志。
  **空文件视为未配置**——否则 system prompt 首段会整段消失。
- ⚠️ **「不覆盖」必须主动卸载（pkg-26 修复）**：上述失败分支以前只调 `prev.disposer()` 就返回，而 disposer
  在真实运行时可能静默失效（§六-3）→ 旧的 `harness:identity` 残留在 agent 作用域**继续覆盖**，
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
  > 即从未被加载。需要的话按 §8.2 用 `dsh plugin --profile web add github:Len7183/DSH-Think-zh` 安装。
- **验证手段**：
  - 下拉框悬停 title 尾部 `· 开场白覆盖: doc/prompts/global.md`；`.state` RPC 的 `globalPrompt` 字段；
  - 观察会话 system prompt：首段应为 `doc/prompts/global.md` 正文，且不再出现 `You are an AI agent powered by DeepSeek Harness.`；
  - 离线验证脚本 `scripts/verify-offline.mjs`（**66 项**，无需 DSH 运行时）：mock `ctx.get('fs'|'agents')` +
    捕获 `agent/created` 监听器，断言注册的 section 名/order/文本、多文件合并顺序、失败分支不抛异常、
    compact 重注册不撞名、global 层未被破坏，以及**「未配置 / 文件被删 / 文件被清空 → scoped 层无残留」**
    （用 `brokenDisposer` 复现 disposer 失效；反向对照：去掉 `forceCleanSection` 兜底则该 4 项失败）。
  - pkg-27 起该脚本为 **66 项**：A 组改为「真实 `.deepseek.yaml` 结构守护 + 真实档案文件端到端解析」，
    新增 E 组子代理继承与排队语义（见 §六-11）。

### 11. 子代理会话的档案继承 + 未激活会话的排队语义（2026-09-20，pkg-27 修复）

**症状**（用户报告）：由主代理委派出的子代理会话里，① one-shot 子代理会话没有下拉框（也没有输入区）；
② continuable 子代理会话有输入框和下拉框，但显示红字（疑似「会话不存在或未激活」），切回主会话再切回来红字消失；
③ 子代理的 system prompt 里**没有** `.deepseek.yaml` 档案正文。

**根因 1：`sessionExists()` 读错字段 → 未激活会话被误判为「不存在」并报红字**

- DSH `sessionPersistence.list()` 返回 `SessionPersistenceSnapshot[]`，会话标识在 **`snapshot.header.id`**，
  顶层**没有** `id`（`packages/session/session-persistence/src/index.ts:50`）。
- 旧代码 `list.some((h) => h.id === sessionId)` **恒为 false** → §六-8 的延迟激活判据永远判「会话不存在」，
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
   从持久化 header 兜底解析 cwd（子代理未驻留时唯一可用的路径，见 §六-7 的 cwd 解析顺序）；
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

- `node scripts/verify-offline.mjs` → **66/66**（E 组 14 项覆盖子代理继承 `ai`/`default` 回退、普通会话不注入、
  显式选择优先、`header.id` 匹配、cwd 兜底、不报 error、开场白与档案共存）；
- 反向对照：把 `sessionExists()` 的匹配改回顶层 `s.id` → **E9/E10 立即失败**（`cwd=null` + 误报 warn），
  恢复后 66/66；
- 运行时实测（2026-09-20）：让子代理转述自身 system prompt，确认修复前「有 `global_prompt` 覆盖、无档案正文」。

**修复后人工验证**：新建一个 continuable 子代理 → 其 system prompt 应含
「【当前会话已通过界面选择 .deepseek.yaml 提示词档案「<name>」…】」且角色设定与父会话一致；子代理会话不再冒红字。

---

## 七、版本历史

> **编号说明**：原插件实例按 Package 编号演进至 pkg-12（run-10）。DSH 进程重启 / 新 AI 会话重新定义后，
> Package 编号重新从 pkg-1 计数——本仓库「功能版本」沿用原编号（当前功能版本 = pkg-27：子代理档案继承 + 未激活会话排队），
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
| pkg-21 | **DSH 0.1.2-alpha.2 升级兼容性核查（无代码改动）**：升级（0.1.1-rc.2 → 0.1.2-alpha.2，08-30 发布）后动态插件随进程重启丢失（进程内存，已知行为，按 §8.1 重新部署即恢复）。逐项核对新版 API 全部兼容：动态内置符号（harness/host.call/styles/React）、槽位注册格式 `{name,id,order,label}` 与 props（useSessions/sessionId）、Host 服务（fs/agents/sessions/sessionPersistence/sandboxPolicy/systemPrompt）、事件（agent/created、agent/request）、`PromptSection {name,order,text}`、静态 `connection`/`/rpc` 通道（新版加浏览器 auth fence，外部 curl 401 属预期）、`__ModuleLoader__` 协议、`forceCleanSection` 安全网（运行时内部结构未变）。**角色分工确认：动态仅开发调试，正式使用走静态模式**。详见 ops-notes.md §6 | ✅ 动态重新部署即恢复（2026-08-31，dshy-1/pkg-1）；静态 bundle 与已提交版本逐字节一致，无需重编译，重装仅刷新 profile 副本 |
| pkg-22 | **修复静态 Client 在 DSH 0.1.2-alpha.2 下不激活（下拉框不渲染）**：根因 `package.json` 的 `dsh.client.inject` 在新版被当作 **cordis 服务等待列表**（boot 图插件条目的 inject），而旧值 `["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-slots"]` 指向**已不存在的包**（前者整个被移除；后者只是前端 require seed 模块、非服务）→ 条目永远 waiting → `apply` 永不执行。**修复**：`dsh.client.inject` 改为 `["slots", "connection"]`（与 `src/static/client.js` 的 `export const inject` 一致；`react` 由前端 seed 提供无需声明 external）。静态 Host 半区不受影响（patch 的 `inject: [connection]` 是真实服务，一直正常） | ⚠️ 该修复必要但**不充分**（见 pkg-23） |
| pkg-23 | **修复静态 Client 不激活的真正根因：`export default apply`**。pkg-22 后下拉框仍不显示，深挖 loader（`cordis-plugin-loader`）`unwrapExports`：`exports = exports.default ?? exports`——bundle 若导出 `default`（= apply 函数），解包后 plugin = **裸函数**，`plugin.inject` 丢失。静态 Host 有 patch YAML 的 `inject: [connection]`（loader 合并条目 options inject）所以正常；静态 **Client** 条目由 kernel 按名字创建（`o.create({name})`，无 options inject），只靠 bundle 导出的 inject 等待 slots/connection——丢失后 apply 立即执行、`ctx.get('connection')` 尚为 undefined → **静默 return → 无下拉框**。参考 `dsh-custom-header` 的 bundle（只导出 `{apply, inject}`，无 default）。**修复**：删除 `src/static/{host,client}.js` 的 `export default apply`，只导出 `{name, inject, apply}` / `{inject, apply}`；已用 `unwrapExports` 逻辑模拟验证新旧形状 | ✅ 2026-08-31 修复；需重装 + 重启 web + 刷新页面生效 |
| pkg-24 | **修复 DSH 0.1.5-alpha.1 静态挂载失败（`cannot get property "webServer" without inject`）**：根因新版把 connection 插件的 inject 由 `["webServer","credentials"]` 改为 `["credentials"]`（/api 路由改 `ctx.inject(['webServer'], ...)`），而 `connection.rpc.handle` 的 owner 是 cordis 影子 Context（`symbols.shadow` = connection 服务 ctx，解析从 connection fiber 向上），故调用方怎么 inject 都无效；`src/static/host.js` 改用 `connection.register(ctx, '/rpc', handler)` 显式传 owner，壳与 patch 声明 `inject: ['connection','webServer']`。用真实 `HostConnectionService` + cordis 4.0.2 复现验证（新旧两代语义均注册 `prefix:/rpc`） | ✅ 2026-09-09 修复；需重装 `dsh plugin --profile web add file:$(pwd)` + 重启 web |
| pkg-25 | **工作区级开场白覆盖 `workspace.global_prompt`（2026-09-15 新增）**：以同名 section `harness:identity`（order −1000）注册进 agent 作用域，按名 shadow 掉 DSH 第一方开场白 `You are an AI agent powered by DeepSeek Harness.`（`dsh-scope` 的 `ScopedLayers.merge` 语义），用于消除英文自我介绍导致的中文用户「默认英文思考」。要点：① `loadProfiles()` 重构为 `loadWorkspace()`（档案 + `global_prompt` 一次解析）；② `applyIdentity()` 随 `agent/created` 对每个会话自动执行，与档案选择解耦；③ 切档案时重读（免重启）；④ 失败绝不抛出、空文件视为未配置 → 保留 DSH 默认；⑤ ⚠️ `forceCleanSection` 加 `name` 参数且对 `harness:identity` **禁用 global 层清扫**（否则会波及所有工作区）；⑥ `.profiles`/`.state`/`.activate` 返回 `globalPrompt` 诊断字段；⑦ Client 下拉框 tooltip 追加「开场白覆盖: `<file>`」。详见 §六-10 | ✅ 离线验证 16/16 通过（mock ctx + 捕获 `agent/created`）；已重装 `file:` 副本（md5 与新建构建一致）；**需重启 `dsh web` 生效** |
| pkg-26 | **档案 `file` 支持数组 + `global_prompt` 未配置/文件缺失时不再覆盖（2026-09-15 新增）**：① 迷你 YAML 解析器补上**标量列表**（block sequence；`key:` 空值占位在首个 `- item` 时就地升级为数组）——此前 `- item` 行被丢弃，`file:` 数组解析成 `{}` → 整个档案被 `typeof file === 'string'` 过滤掉，**数组档案根本不出现在下拉框**；② `loadWorkspace()` 用 `normalizeFiles()` 规范化 `string \| string[]`（顺序保留、空串/非字符串项忽略、无有效文件即剔除档案），档案对象新增 `files`（恒为数组=合并顺序），`file` 保持向后兼容（单文件=字符串 / 多文件=数组）；③ `profileText()` 按 `files` 顺序逐个读盘 + 占位符替换，用**空行**合并为一段正文，任一文件失败**整体失败**（错误带「档案名 + 第 i/n 个 + 文件名」）；④ `applyIdentity()` 重写并抽出 `unapplyIdentity()`（disposer + `forceCleanSection` 兜底），**未配置（键缺失/非字符串/空值）/ 文件不存在 / 文件为空 四条路径一律先卸载旧覆盖再返回 `applied:false`**，修掉「配置已删、覆盖仍在」（disposer 静默失效导致）的状态不一致；⑤ 新增 `scripts/verify-offline.mjs`（48 项断言 + 反向对照）。详见 §二-6/7、§四、§五、§六-10 | ✅ 离线验证 48/48 通过；反向对照（去掉兜底）精确复现 4 项失败（2026-09-15）；需重建 `lib/` + 同步 profile 副本 + 重启 `dsh web` 生效 |
| pkg-27 | **修复子代理会话不加载档案 + 未激活会话误报红字（2026-09-20）**：**根因一** `sessionExists()` 用 `sessionPersistence.list()` 快照的**顶层 `s.id`** 匹配，而会话标识在 `snapshot.header.id` 上 → 恒为 false → 子代理/冷会话被误判成「会话不存在或未激活」，`activate` 直接报红字、§六-8 的延迟激活随之失效（切换会话「红字消失」只是 React 重挂载清掉 error state，档案始终没注入）；**根因二** 档案注入只由客户端 `.activate` 驱动，而 one-shot 子代理会话被 DSH 只读 composer 接管整个 `conversation.composer` 链（`conversation.input.left/right` 槽不渲染）→ 没有任何自动加载入口；**根因三** DSH scope 链不继承父 agent 的层（`composeFrom` 把子代理 scope 的父级绑到 preset standing mount，不是父 agent scope）→ 父会话已选档案不会落到子代理。**修复**：① `sessionExists()` 改用 `snapshot.header.id`（兼容旧形态）并降级为日志判据；② agent 缺失时**一律** `pending` 排队（不再返回 error，只在查无记录时 warn）；③ 新增 `persistedCwd()`/`resolveCwd()`，`.profiles` 用持久化 header 兜底解析 cwd；④ `agent/created` 对 `header.origin === 'subagent'` 的会话**继承父会话当前档案**（无选择则 `default`，显式排队优先），注册仅作用于该子代理作用域；⑤ Client 修掉「`.profiles` 成功却不清 `fatal`」竞态 + 子代理会话跳过自动加载 default + title 标注档案来源。详见 §六-11 | ✅ 离线验证 **66/66**（E 组 14 项：继承/回退/不注入/优先级/`header.id` 匹配/cwd 兜底/不报 error）；反向对照（匹配改回顶层 `s.id`）精确复现 E9/E10 失败，恢复后 66/66（2026-09-20）；**需重建 + 重载插件（动态 `cordis_run mode:'update'`／静态同步 `lib/` + 重启 web）后新建子代理验证** |

**仓库整理（非插件功能版本，2026-08-18）**：独立为 git 仓库 `dsh-scene`——源码落盘 `src/`、档案并入 `doc/prompts/`、
`.deepseek.yaml` 与 `package.json` 随仓库管理，README 重构；双模式重构后删除旧的 `src/host.js`/`src/client.js`
（已被 `src/core/` + 双壳取代），新增 `.gitignore`（忽略 node_modules/.pnpm-store/.idea）与 `pnpm-workspace.yaml`
（`allowBuilds: esbuild: true`）。初次提交后，后续插件代码变更请在表中追加新的功能版本行。

**文档整理（非插件功能版本，2026-09-20）**：`todo.md` 重命名为 `ops-notes.md`（`git mv`，保留历史）——
删除原 §1「Toast 反馈效果」（仅讨论、未实现，用户决定废弃，决策留痕见 `ops-notes.md` §0），
原 §2「运维备忘」十一条目重排为 §1-§10；同步更新引用点：本文件 §一 文件清单、§七 pkg-21 行、
`cordis.patch.yml`（§九）、`src/static/host.js` 注释（§八）。此后 **待办/需求讨论不再单独建文件**，
功能想法直接进 §七 或 `ops-notes.md`，运维事实进 `ops-notes.md`。

---

## 八、如何部署（下次 AI 会话操作手册）

> **离线自检（无需 DSH 运行时）**：改完 `src/core/` 先跑 `node scripts/verify-offline.mjs`（66 项：真实
> `.deepseek.yaml` 结构守护 / YAML 解析 / 多文件档案合并 / 开场白覆盖语义 / 子代理档案继承 / 既有行为回归），
> 全过再构建；改解析器、覆盖逻辑或会话/子代理语义时请连同该脚本一起维护（项数随用例增删变化，以脚本输出为准）。

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
   - **子代理会话**（pkg-27，§六-11）：在主会话委派一个 continuable 子代理，打开其会话 →
     ① 不出现红字「会话不存在或未激活」；② 悬停 title 出现 `· 子代理会话(继承父会话档案)`，档案与父会话一致
     （父选 `ai` 则子代理 `profile-分析师模式`）；③ 让子代理自述 system prompt，应含
     「当前会话已通过界面选择 .deepseek.yaml 提示词档案」段落。one-shot 子代理会话**没有输入区**属 DSH 设计（预期无下拉框）。
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
>
> **刷新后务必校验**（实测 2026-09-15）：不带 `remove` 直接 `add` 也能刷新成功，但要确认真的换成了新拷贝——
> `md5sum lib/index.js "$(readlink -f ~/.dsh/profiles/web/node_modules/dsh-profile-selector)/lib/index.js"`
> 两值必须一致（`lib/client.js` 同理）；不一致说明 profile 里还是旧构建，重启 web 也是旧行为。
> 注意跨文件系统（`/mnt/f` 到 `~/.dsh`）pnpm 无法硬链接，只能整包拷贝。

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
  仅读 `.deepseek.yaml` 与其 `file` / `global_prompt` 指向的提示词文件（`doc/prompts/`），不触碰其他数据。
- **写**：插件本身**不写盘**（激活状态在内存）；本仓库文件由开发期落盘维护。
- **作用域**：注入只影响发起激活的会话（agent 作用域 section + 该会话 `agent/request` 监听）；
  其他会话不受影响。开场白覆盖同理——`harness:identity` 只在该工作区会话的 agent 作用域内注册，
  **不修改 DSH 全局层**，故其他工作区/其他会话仍用 DSH 默认开场白（见 §六-10）。
  子代理会话的档案继承同理：注册进**该子代理自己的** agent 作用域（见 §六-11），
  不影响父会话、父会话的其他子代理，也不需要改动 DSH 源码；子代理的 cwd/血缘
  （`header.cwd`/`parentSession`/`origin`）均来自 DSH 子会话 header，插件只读不写。
- **静态模式权限**：`connection.rpc.handle('/rpc', ..., {authority:'loopback'})` 仅接受 loopback 来源
  （`isTrustedApiRequest` 校验，非 loopback 返回 403）；静态 bundle 由 web profile 的 `dsh.client` 声明收录，
  仅服务本机 GUI 页面。
