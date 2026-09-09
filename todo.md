# TODO / 待办与调研备忘

> 本文件记录未完成的功能讨论、调研结论与运维备忘，供后续会话快速接续。
> 功能版本演进见 `README.md` §七；本文件按主题追加，不按版本号。

---

## 1. Toast 反馈效果（讨论中，未实现）— 2026-08-18

### 需求
切换 profile 时加一个 Toast 效果（用户提出，明确"先讨论、暂不实现"）。

### 现状
切换反馈目前只显示在 select 悬停 title（tooltip）：`已切换: dev · temp 0.2`。
这是有意的设计——工具行槽位有单行高度预算，行内文字会挤动布局导致下拉框错位（此前踩过坑，见 README §二-4 / §六-6）。

### 调研结论（2026-08-18，Inspect 实测）
1. **DSH 无现成 toast 服务**：
   - Client 端 Service 目录：`layout / locale / sessions / slots / theme / timer / workspaces` —— 无 notification/toast/snackbar。
   - Host 端 Service 目录（几十个服务）—— 同样无通知类服务。
   - 结论：不能"直接调用现成 toast API"。
2. **但有现成承载槽位 `shell.overlay`**：
   - `shell.overlay`（list, scope root, replaceRisk: none）—— "Frame-wide floating layer, above every column and outside their scroll containers"。
   - 框架级浮动层，在所有列之上、滚动容器之外，正是 toast 该待的位置；比自绘 `position: fixed` 更规范（不脱离 DSH 渲染树）。

### 拟定实现思路（未编码）
```
conversation.input.left/right（现有下拉框）
  ProfileSelect 切换成功/失败
        │ emit('profile:switched', msg)
        ▼
模块级事件总线（src/core/client.js 内一个 Set<listener> + emit/subscribe，零依赖）
        ▼
shell.overlay（新注册 toast 组件，常驻，无消息渲染 null）
  显示「已切换: dev · temp 0.2」→ 2.5s 淡出
```
- 双模式共用同一份核心代码（src/core/client.js），无需新增服务。
- 样式复用 `--dsw-alias-*` CSS 变量，右下角浮出，不占工具行高度。
- 与现有 title 提示可并存（title 兜底 + toast 增强）。

### 待用户定夺
- [ ] 位置：右下角（常见）还是输入栏上方？
- [ ] 时长：2.5s 自动消失？成功/失败不同颜色（绿/红）？
- [ ] 触发范围：仅手动切换弹，还是自动加载 default 也弹？（自动加载每次新会话都弹可能烦）

### 相关文件
- `src/core/client.js` — ProfileSelect 切换逻辑（onChange / 自动加载）
- `README.md` §二-4 — 当前 title 提示设计说明

---

## 2. 运维备忘（已知特性，非 bug）

### 2.1 动态插件 DSH 重启即丢（实测 2026-08-18 发生两次）
- 动态插件定义在 DSH 进程内存，`dsh web` 重启 = 整个 DSH 重启 → `dshy-1` 消失。
- 恢复：`node build.mjs` → 读 `dist/dynamic/{host,client}.js` 全文 → `cordis_define`（new 或 existing 追加）→ `cordis_run`。
- 详见 README §8.1。

### 2.2 静态模式 file: 依赖是拷贝，不自动刷新
- `dsh plugin --profile web add file:$(pwd)` 把仓库**拷贝**进 `~/.dsh/profiles/web/node_modules/dsh-profile-selector/`。
- 改代码/构建后 pnpm 不自动刷新（报 "Already up to date"），需重装或手动 `cp` 同步 lib/ 等。
- 注意：`/plugins/*/client.js` 是**按需读取**（serveBundle 每次请求读文件），同步后**无需重启 web**，刷新页面即生效（boot rev 会自动更新）。
- 详见 README §8.2。

### 2.3 静态模式 `/rpc` 是共享通道，只能注册一次
- 旧适配器每方法各注册一次导致 `webserver: duplicate prefix route "/rpc"` 挂载回滚；已修复为单次注册 + routes Map 分发。
- 若再遇 405/404：查 `inject: ['connection']` 是否在 patch 与代码中都声明。详见 README §6-8 / §8.2-4。

### 2.4 静态模式 host bundle 需重启 web 才生效（pkg-19 实测）
- 静态 host bundle（`lib/index.js`）在 web 启动时加载进进程内存；同步文件后**运行中的进程仍是旧代码**，
  需重启 `dsh web` 才加载新 host bundle（client bundle 按需读取，刷新页面即生效，见 2.2）。
- pkg-19（延迟激活修复）已同步静态 bundle，但运行中的静态插件仍是旧逻辑——重启 web 前，
  静态下拉框对冷会话仍可能报「会话不存在或未激活」；动态插件（dshy-2，已 run）不受影响。
- 验证基线：重启后对冷会话 activate 应返回 `{ok:true, pending:true}`，首次发消息后档案自动注入。

### 2.5 角色分工：动态仅开发调试，正式使用走静态模式（2026-08-31 确认）
- **动态模式（dshy-*）**：进程内存，重启即丢，只用于开发/调试（README §8.1 恢复流程）。
- **静态模式（dsh-profile-selector）**：正式使用路径，经 `dsh plugin --profile web add file:$(pwd)` 安装。

### 2.6 DSH 0.1.2-alpha.2 升级兼容性核查（2026-08-31，结论：插件零代码改动即兼容）
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
  （README §8.1），本次 2026-08-31 已按此恢复（dshy-1/pkg-1）。

### 2.7 静态 Client 不激活的真正根因：dsh.client.inject 幽灵服务名（pkg-22，2026-08-31）
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

### 2.8 静态 Client 不激活的真正根因：export default apply 丢 inject（pkg-23，2026-08-31）
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

### 2.9 DSH 0.1.5-alpha.1 回归：connection.rpc.handle 失效（pkg-24，2026-09-09）
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