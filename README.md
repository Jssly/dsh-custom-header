# dshy-1（yaml-profile-selector）— DSH Web GUI 提示词档案选择插件

> **用途**：把 `.deepseek.yaml` 的 `system_prompts` 档案切换做成 DSH Web GUI 功能——
> 在输入卡片工具行（权限选择器右侧、输入框下方）渲染「提示词-<档案名>」下拉框，
> 选中档案后将其正文注入**当前会话**的 system prompt（含档案 `temperature` 参数），刷新不丢。
>
> **状态**：✅ 已迁移为独立项目 `dsh-scene`（源码 + 提示词档案 + 工作区配置一体化管理，git 仓库管理，2026-08-18）
> **运行位置**：DSH 动态 Cordis 插件 `dshy-1`（定义于 DSH 进程内存；本仓库 `src/` 为源码快照 +
> 开发文档，供每次新 AI 会话加载后重新部署）
> **版本说明**：Package 编号按插件实例计数，DSH 进程重启后重新从 pkg-1 计数；
> 本仓库功能演进以「功能版本」为准（见 §七 版本历史，当前 = 原 pkg-12 快照）。
> **档案约束**（属提示词档案内容，与插件逻辑无关）：客户不持有现货、不做备兑；标的=上证50ETF华夏（510050）。

---

## 一、项目结构（文件清单）

| 文件 | 内容 |
|---|---|
| `src/host.js` | Host 半区源码（= 当前功能版本 pkg-12 的 Host 代码） |
| `src/client.js` | Client 半区源码（= 当前功能版本 pkg-12 的 Client 代码） |
| `doc/prompts/default.md` | 默认档案正文（期权分析角色；`{{date}}`、`{dataDir}`、`{fileDir}` 占位符） |
| `doc/prompts/dev.md` | 开发档案正文（开发工程师角色；`{{date}}`、`{workspace}` 占位符） |
| `.deepseek.yaml` | 工作区配置（`system_prompts` 源；被插件解析，含 `parameters.temperature`） |
| `README.md` | 本文档（功能 + 开发说明 + 版本史 + 已知坑） |
| `package.json` | 项目元信息（当前仅占位，无运行依赖） |

**运行期依赖**（DSH 提供，只读参考，勿改）：
- DSH 源码：`/home/j/.nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`

---

## 二、功能与 UI

1. **下拉框位置**：输入卡片底部工具行，`[+][🛡 Workspace Write][▾提示词-default][模型][上下文][发送]`。
   实现：Client 注册 `conversation.input.left` 槽（list, scope session），顺序排在权限选择器（accessSelect）之后。
2. **选项文案**：`提示词-<name>`（如 `提示词-default` / `提示词-dev`）。无空值项、无"系统默认"项。
3. **默认行为**：新会话打开时**自动加载 `default` 档案**（若配置中没有 default 则加载第一个档案）；
   每个会话只自动触发一次（Client `autoFired` Set）。
4. **切换**：选中即切换该会话的档案正文；成功反馈仅显示在 select 悬停 title（tooltip）
   （`已切换: dev · temp 0.2`），**不渲染行内文字**（避免挤动布局导致下拉框错位）；仅失败渲染红色 `.err`。
5. **持久性**：档案状态存于 Host 内存 `active` Map（sessionId → 档案），刷新页面不丢（激活的是同一 Host 进程）；
   DSH 重启后需重新激活（新会话打开时自动加载 default）。
6. **注入内容**：`【当前会话已通过界面选择 .deepseek.yaml 提示词档案「<name>」，以下为该档案的完整指令，请以其中的角色设定与任务要求为准执行】\n\n<档案正文>`，
   占位符替换规则见 §五。

---

## 三、架构总览

```
浏览器 (Client)                          DSH Host 进程 (Host)
┌──────────────────────┐   host.call    ┌────────────────────────────────────┐
│ ProfileSelect 组件     │ ─────────────▶ │ harness.handle('dshyaml.activate')  │
│ 渲染于 input.left 槽   │ ◀───────────── │  enqueue(会话级串行队列)            │
│ autoFired 防双触发     │   JSON 返回    │   ├ 读 .deepseek.yaml (fs.resolve)  │
│ 成功→title / 失败→err  │               │   ├ 替换占位符 → profileText()      │
└──────────────────────┘                │   ├ forceCleanSection() 强制清残留   │
                                        │   ├ sp.section({name:'dsh-yaml:profile', order:-50, text})
                                        │   └ agent.ctx.on('agent/request') 注入 temperature
                                        └────────────────────────────────────┘
                                                    │ systemPrompt 层
                                                    ▼
                                        Agent 会话作用域 PromptLayer
                                        （scope = AgentLoop 实例；sections NamedEntries）
```

- **Host 能力来源**：`ctx.get('fs')`（resolve/readText）、`ctx.get('sandboxPolicy')`（workspaceRoot 兜底）、
  `ctx.get('agents')`（`agents.get(sessionId)` → 会话 Agent，取 `agent.session.header.cwd` 与 `agent.ctx`）、`harness.handle`。
- **Client 能力来源**：`ctx.get('slots')`、`styles.insert`、`host.call`、`React.createElement`（无 JSX）。
- **插件语言**：纯 JavaScript（Host/Client 均不做 TS/JSX/import 转换）；无 require；不能直接用 yaml 库（用内置迷你解析器）。

---

## 四、RPC 协议（Host handlers）

| handler | 入参 | 返回 | 说明 |
|---|---|---|---|
| `dshyaml.profiles` | `{sessionId}` | `{profiles:[{name,file,parameters}], cwd}` 或 `{profiles:[], error}` | 解析工作区 `.deepseek.yaml` 的 `system_prompts`；cwd = `agents.get(sessionId).session.header.cwd`，兜底 `sandboxPolicy.workspaceRoot` |
| `dshyaml.state` | `{sessionId}` | `{active: profileName\|null}` | 当前会话激活的档案（Host 内存态） |
| `dshyaml.activate` | `{sessionId, profile}` | `{ok, profile, temperature?, cleaned?}` 或 `{ok:false, error}` | 切换档案；错误信息带 `[diag: ...]` 诊断段（见 §六-4） |

**激活流程（dshyaml.activate 内部）**：
1. `enqueue(sessionId, fn)` 入会话级串行队列（同一会话的激活严格顺序执行）；
2. 幂等短路：`active.get(sessionId).profileName === name` → 直接返回，不重注册；
3. 有旧档案 → `disposer()` + `disposeTemp()`，并从 `active` 删除；
4. 读 `.deepseek.yaml`（迷你 YAML 解析，仅支持 map/list of scalars）→ 找档案 → 读档案文件
   （档案 `file` 为**相对会话 cwd 的路径**，`fs.resolve(profile.file, { cwd })`，如 `doc/prompts/default.md`）；
5. 替换占位符（见 §五）→ `profileText()` 生成注入正文；
6. `forceCleanSection(sp, agent)` 强制清除残留 section（见 §六-3）；
7. `sp.section({name:'dsh-yaml:profile', order:-50, text})` 注册（`sp = agent.ctx.systemPrompt`）；
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
> 需调整 `substitute()`（src/host.js）的映射或修改档案内路径写法。

---

## 六、核心机制与已知坑（开发必读，勿破坏）

### 1. 作用域语义：section 注册在「Agent 会话作用域」
- `agent.ctx` = `createScope(loopCtx, loopInstance).ctx.extend({agent})`（dsh-agent-loop/lib/index.js:376），
  scope key = **AgentLoop 实例**（`agents.get(sessionId)` 返回同一对象）。
- `agent.ctx.systemPrompt` 经 Cordis traceable 代理访问：方法调用时 `this.ctx` 被重绑为**调用方上下文**，
  `sp.section()` 注册进**该 agent 作用域**的 PromptLayer（`ScopedLayers.scoped.get(scope)`）。
- 同名重复注册抛：`prompt section "dsh-yaml:profile" is already registered in this scope`。

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
- `conversation.input.left`（list, scope session, replaceRisk none）→ 渲染在 InputBar `.row → .tools`
  中 resident chrome（accessSelect 之后、leftItems 位置）= 权限选择器右侧、输入框下方工具行。
- `conversation.input.plan` 是 **single** 槽且被系统占用（占用会顶掉系统计划按钮），**不可用**。
- `conversation.input.dock` 在 hero+active 均渲染但 header actions 在 blank/hero 整体隐藏——曾导致下拉框重复/错位，已弃用。
- 成功反馈**禁止**渲染行内文字（挤动布局 → 下拉框错位），只允许 title/tooltip；错误 `.err` 限宽 24ch 省略。

### 7. 其他
- `sandboxPolicy.workspaceRoot` 是**部署级**工作区根（非会话 cwd）——解析 `.deepseek.yaml` 必须用
  `agent.session.header.cwd`，否则跨工作区会解析到错误文件。
- 每会话 `active` Map 在 Host 内存；DSH 进程重启即清空（新会话打开时 Client 自动重新加载 default）。
- 插件停用：`cordis_stop dshy-1`（停用后已注入的 section 由 dispose 清理）。

---

## 七、版本历史

> **编号说明**：原插件实例按 Package 编号演进至 pkg-12（run-10）。DSH 进程重启 / 新 AI 会话重新定义后，
> Package 编号重新从 pkg-1 计数——本仓库「功能版本」沿用原编号（当前功能版本 = pkg-12），
> 每次会话实际定义的 Package 编号见 `cordis_inspect_self dshy-1`。

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

**仓库整理（非插件功能版本，2026-08-18）**：独立为 git 仓库 `dsh-scene`——源码落盘 `src/`、档案并入 `doc/prompts/`、
`.deepseek.yaml` 与 `package.json` 随仓库管理，README 重构。初次提交后，后续插件代码变更请在表中追加新的功能版本行。

---

## 八、如何重新部署（下次 AI 会话操作手册）

动态插件定义在**当前 DSH 进程内存**中；新会话/重启后需用源码重新定义。步骤：

1. **加载技能**（开发前必读）：`skill: cordis-plugin-development`；需要时 `cordis_inspect_list/query` 查询
   `slots`/`systemPrompt`/`agents` 等契约与最新签名。
2. **读取源码**：`src/host.js` + `src/client.js`（本仓库为准；若运行版本已更新，
   先用 `cordis_inspect_self dshy-1` 拉取当前 pkg 源码 diff 后再落盘同步）。
3. **定义插件**：`cordis_define { plugin: { kind: 'new', idPrefix: 'dshy' }, name, purpose, code: { host, client } }`
   （新会话用 new；已有 dshy-1 时用 `kind:'existing', pluginId:'dshy-1'` 追加 Package）。
4. **激活**：`cordis_run { pluginId, packageId, mode: 'run'|'update' }`（首次 run；换版本 update）。
5. **验证**（GUI 手动）：
   - 输入卡片工具行出现 `▾提示词-<name>` 下拉框（权限选择器右侧）；
   - 新会话自动加载 default（悬停 title 显示 `默认加载: default · temp 0.2`）；
   - 连续快速切换 dev ↔ default 多次：无 "already registered"、下拉框不错位、title 显示 `已切换: ...`；
   - 发一条消息验证注入：回复开头/内容应体现「当前会话已通过界面选择 .deepseek.yaml 提示词档案」前置说明，
     且角色设定符合所选档案（default=期权交易员 / dev=开发工程师）。
6. **改动后落盘**：把更新后的 host/client 代码同步写回 `src/`，并在本 README §七 版本历史登记变更。

**常用调试手段**：
- `cordis_inspect_self dshy-1` → 版本指针 / currentPackageId / 诊断；`cordis_inspect_self dshy-1 <pkgId>` → 源码与运行错误。
- activate 出错时 GUI 红字带 `[diag: ...]`，据此定位残留 section 所在层。
- Host 内部事实（供对照）：`sp.layers.scoped`（Map，key=AgentLoop 实例）、`sp.layers.global.sections`（NamedEntries）、
  `layer.sections.data`（普通 Map，可直接 delete）。

---

## 九、数据流与安全边界

- **读**：`fs.resolve/readText`（受 sandbox 约束；当前会话 policy=workspace-write，可读写工作区内的文件）；
  仅读 `.deepseek.yaml` 与其 `file` 指向的档案文件（`doc/prompts/`），不触碰其他数据。
- **写**：插件本身**不写盘**（激活状态在内存）；本仓库文件由开发期落盘维护。
- **作用域**：注入只影响发起激活的会话（agent 作用域 section + 该会话 `agent/request` 监听）；
  其他会话不受影响。
