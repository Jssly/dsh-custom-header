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