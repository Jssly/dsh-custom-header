# 运维备忘 / 已知特性与排查记录

> 本文件记录 DSH **运行时、部署与环境**相关的已确认事实、已知特性（非 bug）与故障排查记录
> （上游版本回归、profile 同步、bundle 加载、升级核查等），按主题追加，不按版本号。
>
> 相关文档分工：
> - **部署步骤**（动态 define/run、静态 add/重启 web）：`deployment.md`
> - **核心机制与设计坑**（改代码前必读）：`internals.md`
> - **功能版本演进史**（pkg-N）：`CHANGELOG.md`
>
> 沿革：本文件原为 `todo.md` 的 §2（2026-09-20 拆分并重命名，条目编号由 2.x 重排为 1-11）；
> 同文件原有的 §1「Toast 反馈效果」（仅讨论、未实现）已按用户要求**废弃删除**（决策记录见下方「附录」）。

---

## 0. 附录：已废弃的待办

### Toast 反馈效果（2026-08-18 讨论，2026-09-20 废弃删除）
- 需求：切换 profile 时弹 Toast。**未实现，已放弃**——现有反馈继续只走 select 悬停 title
  （`已切换: dev · temp 0.2`），理由是工具行槽位有单行高度预算，行内文字会挤动布局导致下拉框错位
  （见 `features.md` / internals.md）。
- 若将来重启该需求，当时的调研结论是：DSH 端**无现成 toast 服务**（Client 服务目录只有
  `layout/locale/sessions/slots/theme/timer/workspaces`），但有现成承载槽位
  `shell.overlay`（list, scope root），可通过模块级事件总线把切换结果送过去，样式复用 `--dsw-alias-*`。

---

## 1. 动态插件 DSH 重启即丢（实测 2026-08-18 发生两次）
- 动态插件定义在 DSH 进程内存，`dsh web` 重启 = 整个 DSH 重启 → `dshy-1` 消失。
- 恢复：`node build.mjs` → 读 `dist/dynamic/{host,client}.js` 全文 → `cordis_define`（new 或 existing 追加）→ `cordis_run`。
- 详见 deployment.md。

## 2. 静态模式 file: 依赖是拷贝，不自动刷新
- `dsh plugin --profile web add file:$(pwd)` 把仓库**拷贝**进 `~/.dsh/profiles/web/node_modules/dsh-profile-selector/`。
- 改代码/构建后 pnpm 不自动刷新（报 "Already up to date"）：**静态发布必须重新
  `dsh plugin --profile web add file:$(pwd)`**（不要手工 `cp` 进 profile——依赖记录会与实际文件不一致）；
  **本地测试才可以直接 `cp`**（临时手段，测完恢复干净）。见 deployment.md。
- 注意：`/plugins/*/client.js` 是**按需读取**（serveBundle 每次请求读文件），同步后**无需重启 web**，刷新页面即生效（boot rev 会自动更新）。
- 详见 deployment.md。

## 3. 静态模式 `/rpc` 是共享通道，只能注册一次
- 旧适配器每方法各注册一次导致 `webserver: duplicate prefix route "/rpc"` 挂载回滚；已修复为单次注册 + routes Map 分发。
- 若再遇 405/404：查 `inject: ['connection']` 是否在 patch 与代码中都声明。详见 internals.md / deployment.md-4。

## 4. 静态模式 host bundle 需重启 web 才生效（pkg-19 实测）
- 静态 host bundle（`lib/index.js`）在 web 启动时加载进进程内存；同步文件后**运行中的进程仍是旧代码**，
  需重启 `dsh web` 才加载新 host bundle（client bundle 按需读取，刷新页面即生效，见 §2）。
- pkg-19（延迟激活修复）已同步静态 bundle，但运行中的静态插件仍是旧逻辑——重启 web 前，
  静态下拉框对冷会话仍可能报「会话不存在或未激活」；动态插件（dshy-2，已 run）不受影响。
- 验证基线：重启后对冷会话 activate 应返回 `{ok:true, pending:true}`，首次发消息后档案自动注入。

## 5. 角色分工：动态仅开发调试，正式使用走静态模式（2026-08-31 确认）
- **动态模式（dshy-*）**：进程内存，重启即丢，只用于开发/调试（deployment.md 恢复流程）。
- **静态模式（dsh-profile-selector）**：正式使用路径，经 `dsh plugin --profile web add file:$(pwd)` 安装。

## 6. DSH 0.1.2-alpha.2 升级兼容性核查（2026-08-31，结论：插件零代码改动即兼容）
- 升级路径：`npm install -g @deepseek-ai/dsh` → 0.1.1-rc.2 → **0.1.2-alpha.2**（08-30 发布，大版本内部重构：
  新增 dsh-api-*/dsh-sdk-*/dsh-acp-* 系列，`dsh-client-ui-slots`/`dsh-client-runtime` 包被合并移除）。
- 逐项核对（对照新版 DSH 源码与运行态）：
  - 动态内置符号 `harness.handle` / `host.call` / `styles.insert` / `React` 均在，签名不变；
  - 槽位 `conversation.input.left/right` 存在，注册格式 `{name,id,order,label}` 不变（新 runner 仍要求
    `options.name` 为槽位 key 并自动分配 priority）；props `useSessions`/`sessionId` 不变，
    `s.byId[id].cwd`（SessionSummary.cwd）形状不变；
  - Host 服务 `fs`/`agents`/`sessions`/`sessionPersistence`/`sandboxPolicy`/`systemPrompt` 均在；
    事件 `agent/created`（scoped, {agent}）、`agent/request`（瀑布, LlmCallConfig.temperature）签名不变；
    `PromptSection {name, order, text}` 字段一致；
  - 静态 RPC：`connection` 服务**仍在**（host inspect catalog 未收录但运行时存在——inspect 只收录登记过
    的目录项，别拿 catalog 判断存在性）；`connection.rpc.handle('/rpc', handler)` / `rpc.call('/rpc', ...)`
    协议不变。新版 `/rpc` 增加**浏览器 auth fence**（`requestRejection`：Host/Origin 校验 + browserAuth）——
    外部 curl 访问静态 `/rpc` 返回 401/403 属预期，浏览器会话 cookie 可通过；
  - client bundle 协议 `__ModuleLoader__.load({id, factory})` 仍在；`dsh.client.inject` 仍被读取，
    对已不存在的包名（`dsh-client-runtime`/`dsh-client-ui-slots`）**安全跳过不报错**（graphRows 无则忽略）；
    新版 bundle 走组合路由 `/plugins/??<id>/client.js,...&rev=...`，旧单文件 URL 404 属正常；
  - `forceCleanSection`/`sectionDiag` 依赖的运行时内部结构**依然存在**：`sp.layers.scoped` 仍是 Map、
    `layer.sections.data` 仍是 Map、`NamedEntries.has` 可用（.d.ts 标 private 不影响运行时字段；
    新版 `layers.effect(ctx,...)` 还按调用方 fiber 挂 disposer，旧版"disposer 失效"根因已被官方修复）。
- 静态模式实测：`POST /rpc/dshprofile-static.profiles` → HTTP 401（路由存活）；web profile 安装副本
  bundle 与仓库构建逐字节一致（无需重编译，重装仅刷新 profile 副本/patch）。
- 动态插件在升级重启后必然丢失（进程内存），恢复 = `node build.mjs` → cordis_define → cordis_run
  （deployment.md），本次 2026-08-31 已按此恢复（dshy-1/pkg-1）。

## 7. 静态 Client 不激活的真正根因：dsh.client.inject 幽灵服务名（pkg-22，2026-08-31）
- **现象**：静态下拉框完全不渲染；静态 Host 半区正常（`/rpc` 401 路由存活、档案能注入）。
- **根因**：0.1.2-alpha.2 里 `package.json` 的 `dsh.client.inject` 被用作 boot 图插件条目的
  **cordis 服务等待列表**（`dsh-client-modules` 浏览器端 `plugins.push({id, inject, ...})`；
  `cordis-plugin-loader` 按 `entry.options.inject` 做 `Inject.resolve` 等待）。旧值
  `["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-slots"]` 指向已移除的包——
  `dsh-client-runtime` 整个消失；`dsh-client-ui-slots` 只是前端 dist 里的 **require seed 模块**
  （`dsh-web-frontend/dist/assets/index-*.js` 的 `staticModules` 表），**不是 cordis 服务**。
  → 条目永远 waiting → `apply` 永不执行 → 不渲染。
- **修复（pkg-22）**：`dsh.client.inject` 改为 `["slots", "connection"]`（与 `src/static/client.js`
  的 `export const inject` 一致；`react` 由前端 seed 提供，无需声明 external）。
- **教训**：新版 `dsh.client.inject` 语义 = 服务等待（和 bundle 内 `export const inject` 一致），
  不再是旧版的"预注册 require 模块"。改插件包元数据时务必核对服务名是否真实存在
  （`Service.listService` catalog 之外的运行时服务如 `connection` 需按源码确认）。
- **连带**：profile 里 `dsh-custom-header` 的 `dsh.client.inject` 也含这两个幽灵名
  （`dsh-client-runtime`/`dsh-client-ui-slots`/`dsh-client-locale`），其 client 半区同样被卡死
  （除非它自己也已适配）；若其功能失效属同一根因。

## 8. 静态 Client 不激活的真正根因：export default apply 丢 inject（pkg-23，2026-08-31）
- **现象**：pkg-22（幽灵 inject 修复）后静态下拉框仍不显示；静态槽位 `conversation.input.right` 无 occupants。
- **根因**：`cordis-plugin-loader` 的 `unwrapExports`：
  `exports = exports.default ?? exports; if (!exports.__esModule) return exports; return exports.default ?? exports;`
  —— bundle 若导出 `default`（我们此前 `export default apply`，default = apply 函数），解包后
  plugin = **裸函数**，`plugin.inject` 丢失。fiber 的 inject 主要来自插件对象自身（`registry.plugin`
  里 `Inject.resolve(plugin.inject)`）+ 条目 options inject（loader 第 709 行合并）：
  - 静态 **Host**：patch YAML 声明了 `inject: [connection]` → 条目 options 有 inject → 合并后仍等待
    connection → 正常（/rpc 401 存活即证明）；
  - 静态 **Client**：kernel 按名字创建条目（`o.create({name})`，**无 options inject**），只靠 bundle
    导出的 inject 等待 slots/connection → 丢失后 apply 立即执行、`ctx.get('connection')` 尚 undefined
    → 静默 return → 无下拉框、无报错。
- **对照**：`dsh-custom-header` 的 client bundle 只导出 `{apply, inject}`（无 default）→ unwrap 返回
  完整对象 → inject 生效。**我们的修复方向错了第一版（pkg-22 只修了 package.json 的幽灵 inject）**，
  真正缺的是 bundle 导出形状。
- **修复（pkg-23）**：删除 `src/static/{host,client}.js` 的 `export default apply`，只导出
  `{name, inject, apply}`（host）/ `{inject, apply}`（client）。已用 unwrapExports 逻辑模拟验证：
  旧形状 plugin.inject=undefined（function），新形状 plugin.inject=['slots','connection']（object）。
- **教训**：新版 loader 对插件模块统一走 `unwrapExports`，任何 ESM/CJS bundle 都不要 `export default
  apply`——default 会被解包、丢掉同对象上的 `inject`/`name`。检查所有第三方 client 插件的 bundle
  导出形状（`__export(...)` 里有没有 `default`）。

## 9. DSH 0.1.5-alpha.1 回归：connection.rpc.handle 失效（pkg-24，2026-09-09）
- **现象**：`dsh plugin --profile web add file:/mnt/f/git/node/dsh-scene` → loader 报
  `dsh: plugin tree failed to load: failed to apply loader entry dsh-profile-selector (dsh-profile-selector): cannot get property "webServer" without inject`
  （`dsh-client-connection/lib/index.js:618`），条目回滚；profile package.json 不留依赖，但 `node_modules/.pnpm` 残留旧副本。
- **根因**：0.1.5-alpha.1 把 `dsh-client-connection` 插件自身 inject 由 `["webServer","credentials"]` 改为 `["credentials"]`
  （/api 路由改 `ctx.inject(['webServer'], ...)` 挂载）。`register()` 末行 `owner.effect(() => owner.webServer.register(route))`，
  而 `rpc.handle` 的 owner 是 cordis 影子 Context（`symbols.shadow` = connection 服务 ctx），服务解析从 connection fiber
  向上 → 找不到 webServer。**调用方 `inject: ['webServer']` 无效**（关键：别照报错提示改 inject）。
- **修复**：`connection.register(ctx, '/rpc', handler)` 显式传 owner = 本插件 ctx（inject 含 webServer）。
- **验证**（真实 `HostConnectionService` + cordis 4.0.2 合成宿主）：0.1.5（connection inject=[]）与 0.1.2-alpha.3（inject=[webServer]）
  均注册 `prefix:/rpc`；强制 inject=`['connection']` 精确复现原报错。脚本为临时探针，验证后已删。
- **备选（DSH 侧）**：`~/.dsh/profiles/web/cordis.patch.yml` 加 `- id: connection` + `inject: [webRuntime, webServer]` 可恢复 rpc.handle；
  若上游修复（connection 重新自注入 webServer），本插件两种写法都可用。
- **升级备忘**：新版 profile 启动时重新同步（`node_modules`/`package.json`/`cordis.yml`）；安装失败会回滚 package.json，重装前无需清理 .pnpm 残留。

## 10. 子代理会话不加载档案 + 未激活会话误报红字（pkg-27，2026-09-20）
- **现象**：① one-shot 子代理会话既无输入框也无下拉框；② continuable 子代理会话有输入框与下拉框，但显示红字
  「会话不存在或未激活」，**切回主会话再切回来红字消失**；③ 子代理的 system prompt 里没有 `.deepseek.yaml`
  档案正文（只有 `global_prompt` 的 `harness:identity` 覆盖）。
- **根因一（红字 / 延迟激活失效）**：`sessionExists()` 用 `sessionPersistence.list()` 快照的**顶层 `s.id`** 匹配，
  而快照的会话标识在 **`snapshot.header.id`**（`@deepseek-ai/dsh-session-persistence` 的 `SessionPersistenceSnapshot`）
  → 恒为 false → `activate` 对任何未激活会话直接返回 `{ok:false, error:'会话不存在或未激活'}`。
  子代理会话几乎必然命中（结算后不驻留，也不在 `sessions` 内存表）。
  ⚠️ **「红字消失」是假象**：换会话只是 React 重挂载清掉 error state，而 Client `autoFired` 已记录该 sessionId
  → 不再重试 → 档案始终没注入。排查此类「刷新后报错消失」的问题时要先确认**修复动作是否真的发生过**。
- **根因二（子代理没有注入入口）**：档案只在客户端 `.activate` 时注册；one-shot 子代理会话被 DSH `ui-subagent`
  的只读 composer 接管整个 `conversation.composer` 链（`conversation.input.left/right` 槽不渲染）→ 无下拉框、
  也无 activate；continuable 子代理则撞上根因一。**结论：档案注入不能只依赖 UI。**
- **根因三（不继承父 agent 作用域）**：DSH scope 链不继承父 agent 的层——`applyChildComposition()` →
  `agentPresets.composeFrom(childCtx, parent.ctx)` 内部是 `bindScopeParent(agentKey, standing.key)`，
  把子代理 scope 挂到 **preset standing mount**、而不是父 agent scope（`packages/preset/agent-presets/src/index.ts:484`），
  因此父会话已选档案不会自动落到子代理。实测印证：子代理**有** `global_prompt` 覆盖（走 `agent/created` 自动路径）、
  **没有**档案正文（只由客户端驱动）。
- **修复**：① `sessionExists()` 改用 `snapshot.header.id`（兼容旧形态）并**降级为日志判据**；
  ② `activate` 在 agent 缺失时**一律** `pending` 排队（不再返回 error，只在查无记录时 warn）；
  ③ 新增 `persistedCwd()`/`resolveCwd()`，`.profiles` 在内存路径全失败后用持久化 header 兜底解析 cwd；
  ④ `agent/created` 对 `header.origin === 'subagent'` 的会话**继承父会话当前档案**（父无选择回退 `default`），
  显式排队优先，注册只作用于该子代理作用域；⑤ Client 修「`.profiles` 成功却不清 `fatal`」的首帧竞态 +
  子代理会话跳过自动加载 default + title 标注档案来源。
- **验证**：`node scripts/verify-offline.mjs` → **66/66**（E 组 14 项：继承/回退/不注入/优先级/`header.id` 匹配/
  cwd 兜底/不报 error/与开场白共存）；反向对照（把匹配改回顶层 `s.id`）精确复现 E9/E10 失败，恢复后 66/66
  （**注**：这是当时的项数，现脚本已增至 90 项，见 §11）；
  GUI 实测（2026-09-20，用户确认）：子代理会话红字消失、下拉框显示 `profile-开发者模式`，
  子代理自述 system prompt 含档案声明段且与父会话一致。根因/边界/验证全文见 internals.md。
- **边界（非 bug）**：one-shot 子代理会话没有输入区（DSH 设计，插件绕不过；要显示只能改挂槽位，如
  `conversation.session.header.leading`）；**历史**子代理会话提示词已定型、无法回溯注入，且其下拉框会回退显示
  `profile-<default>` 而实际未注入（2026-09-20 决定**不处理**该显示不一致）；Host 内存 `active` 随 DSH 重启清空，
  父会话重新打开时自动重载 default，之后的子代理继承那个选择。

## 11. persona 段清空 / 替换 `deployment:persona-prefix`（pkg-28，2026-10-16）
- **目标**：去掉（或替换）系统提示词开头 **preset 自带**的那句 `You are a coding agent powered by the
  {{model}} model.`（agent 作用域的 `deployment:persona-prefix` 段）；第 1 句 `harness:identity`
  （`You are an AI agent powered by DeepSeek Harness.`）走**声明式开关**关闭。
- **机制**：persona 槽位在 agent 层**已有 owner**（preset 的 `@deepseek-ai/dsh-persona` 行），而
  `systemPrompt.section()` 用 `NamedEntries` 保证同层名字唯一 → 同名 shadow 会抛
  `prompt section "…" is already registered in this scope`。因此只能挂 `system-prompt/assemble`
  监听器改写**装配结果**（会话 agent 作用域；`agent/created` 挂载、`ctx.on('dispose')` 释放；
  子代理会话同样挂载）。设计依据 `persona-override.md`，机制/坑位/验证全文见 internals.md。
- **配置键**（`.deepseek.yaml` → `workspace`）：`persona_prompt: <path>` 替换 / `persona_clear: true` 清空
  （优先）/ **两键都缺省 = 完全不改写**（绝不误删 preset 原有 persona）。求值在**每次装配**现读现算，
  改配置无需重启或重挂；代价是每个模型步两次小文件读。
- **⚠️ `includeHarnessIdentity: false` 的落点：插件自带 `cordis.patch.yml` 顶层**（与 `- insert:` 平级；
  2026-10-16 从 profile patch **搬入**本文件）：

  ```yaml
  - id: system-prompt
    config:
      includeHarnessIdentity: false
  ```

  它是 **bundle 层** patch，随包分发、重装即带上；`~/.dsh/profiles/web/cordis.patch.yml`（profile 层）在
  **所有 bundle 层之后**应用、优先级更高，**两处只能写一处**——都写时 profile 那条整块盖掉插件这条
  （并替换掉插件里将来可能新增的键）。profile patch 里原有的同款条目**已删除**（2026-10-16，备份在
  `/tmp/profile-cordis.patch.orig.yml`，本机临时文件）。顶层覆盖条目**不能写 `name`**：写了会被当成
  「新增行」解析并报
  `disabling profile plugin row …: Cannot read properties of undefined (reading 'startsWith')`。
- **部署**：`node build.mjs` → `dsh plugin --profile web add file:$(pwd)` 重新部署（file: 依赖是**拷贝**，
  pnpm 不会自动刷新；详见 §2 与 deployment.md，务必用 md5 校验 `lib/index.js` / `cordis.patch.yml` 与项目一致）
  → **重启 `dsh web`**（bundle patch 与静态 bundle 只在启动时应用，新建会话不算）。
- **排查口诀**：某个会话提示词没生效 → **先看它当前是哪个模式**（Standard / cordis / ptc 均可；
  **minimal 的 `complete: true` 会让本改写静默失效**——complete 恢复发生在 waterfall 之后，无报错无警告），
  而不是翻代码。本项目不使用 Minimal 模式。
- **验证**：`node scripts/verify-offline.mjs` → **90/90**（新增 F 组 22 项 + A14/A15 真实 `.deepseek.yaml`
  端到端守护）；四次反向对照精确复现预期失败（只返回 `{sections}` → F5；`catch` 后返回空 assembly → F19；
  清空写成 `' '` → A15/F2/F3/F10/F15/F22；临时移除 `persona_clear` → 仍 90/90，证明守护跟着真实配置走）。
- **已知边界**：替换正文沿用原 persona 段的插值规则（正文里完整的 `{{…}}` 会按 prompt variables 解析，
  未知变量会让装配抛错）；persona 覆盖对**该工作区的所有会话（含子代理）**生效，与档案选择解耦。