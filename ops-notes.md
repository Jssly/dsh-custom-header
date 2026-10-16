# 运维备忘（部署事实 · 升级核查 · 排查）

> 本文件只记**当前仍然成立**的运维事实与排查方法。历史上的坑（症状 / 根因 / 修复过程）不在此重复——
> 见 `CHANGELOG.md` 对应的 pkg 行与 git 历史；机制与坑位见 `internals.md`；部署步骤与口径见 `deployment.md`。
>
> 沿革：本文件原为 `todo.md` 的一部分（2026-09-20 拆分并重命名）。原条目编号已取消——跨文档引用一律只写文件名。

## 角色分工：动态仅开发调试，正式使用走静态模式（2026-08-31 确认）

- **动态模式**（`cordis_define` + `cordis_run`）定义在 **DSH 进程内存**：进程一重启就丢
  （`cordis_inspect_self dshy-1` 报 "no dynamic plugin"），改了代码要重新部署。适合快速试效果。
- **静态模式**装在 profile 里，重启后自动加载：**正式使用一律走静态**。

## `file:` 依赖是拷贝，不自动刷新

- `dsh plugin --profile web add file:$(pwd)` 把仓库**拷贝**进
  `~/.dsh/profiles/web/node_modules/dsh-profile-selector/`（`/mnt/f` → `~/.dsh` 跨文件系统，pnpm 无法硬链接，
  只能整包拷贝）。
- 改代码 / 构建后 pnpm 不会自动刷新（`pnpm install` 报 "Already up to date"）：
  **静态发布必须重新 `add`**（不要手工 `cp` 进 profile——依赖记录会与实际文件不一致）；
  **本地测试才可以直接 `cp`**（临时手段，测完恢复干净）。完整口径与 md5 校验见 `deployment.md`。

## 生效时机：Host 半区要重启，Client 半区刷新即可

- **Host 半区**（静态 `lib/index.js` / 动态 `dist/dynamic/host.js`）：静态 bundle 在 web 启动时加载进
  进程内存 → **必须重启 `dsh web`**；动态需重新 `cordis_run mode:'update'`。
- **Client 半区**（`lib/client.js`）：`/plugins/*/client.js` 是**按需读取**（serveBundle 每次请求读文件）
  → 换文件后**刷新页面**即生效，无需重启。

## `/rpc` 是共享通道，只能注册一次

- 静态模式由 `connection.register(ctx, '/rpc', handler)` 注册**一次**，插件内所有 method 经同一通道的
  endpoint 分发（method 名即 endpoint，如 `dshprofile-static.profiles`）。重复注册会报
  `duplicate prefix route "/rpc"` 并回滚挂载。
- DSH **0.1.5-alpha.1** 起 `connection.rpc.handle` 全员失效（其 owner 是服务侧影子 Context，
  调用方怎么 `inject` 都无效），必须改用 `connection.register(ctx, ...)` 显式传 owner。细节见 `internals.md`。

## 上游 DSH 升级核查

升级后依次做：

1. `node build.mjs` 能构建（`exports` / `dsh.bundle.patch` / `dsh.client` 元数据语义未被上游改动）；
2. `node scripts/verify-offline.mjs` 全绿（回归脚本不依赖 DSH 运行时）；
3. 按 `deployment.md` 的验证步骤走一遍：下拉框出现、RPC 通道可达、新会话 system prompt 内容正确；
4. 动态插件随重启丢失属预期，按 `deployment.md` 重新 define 即恢复。

| DSH 版本 | 核查结论 |
|---|---|
| 0.1.2-alpha.2 | 兼容：插件零代码改动，动态重新部署即恢复 |
| 0.1.5-alpha.1 | ⚠️ `connection.rpc.handle` 全员失效 → 已改用 `connection.register(ctx, ...)`（见 `CHANGELOG.md` 的 pkg-24） |

## 排查顺序（下拉框不显示 / 提示词没生效时）

1. **先看模式**：Minimal 模式的 persona 行带 `complete: true`，会让 persona 段改写**静默失效**
   （Standard / cordis / ptc 均可）。本项目不使用 Minimal——所以「某个会话没生效」的第一反应是看模式，
   而不是翻代码。
2. **分清半区**：下拉框不显示 = **Client 半区**（先刷新页面；再查
   `curl -s http://127.0.0.1:3080/ | grep dsh-profile-selector` 是否在 boot 图里）；注入没生效 = **Host 半区**
   （看 Host 日志里有没有 `[dsh-profile-selector]` 的 warn）。
3. **确认 profile 里是新代码**：`md5sum lib/index.js` 与 profile 拷贝对比（见 `deployment.md`）；
   静态还得确认重启过 web。
4. **确认工作区配置**：`.deepseek.yaml` 在**会话 cwd**（不是部署根目录）下、档案 `file` / `global_prompt` /
   `persona_prompt` 指向的文件真实存在（若配了；**不配则默认清空**）、`persona_clear` 为布尔或未配置。
5. **仍不对**：让会话自述 system prompt，对照 `features.md` 的注入内容说明逐项核对。
