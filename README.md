# dsh-profile-selector — DSH Web GUI 提示词档案选择插件（双模式）

> **用途**：把 `.deepseek.yaml` 的 `system_prompts` 档案切换做成 DSH Web GUI 功能——
> 在输入卡片工具行渲染「profile-<档案名>」下拉框，选中档案后将其正文注入**当前会话**的
> system prompt（含档案 `temperature` 参数），刷新不丢；并支持工作区级的开场白替换与
> persona 段清空 / 替换。
>
> **双模式架构**（2026-08-18 起）：
> - **开发模式（动态插件）**：`cordis_define` + `cordis_run` 定义于 DSH 进程内存，pluginId `dshy-1`（Host 分配不可改），
>   槽位 `conversation.input.left`（工具行左侧、权限选择器右侧），RPC `dshprofile.*`，section `dsh-profile:profile`。
> - **发布模式（静态插件）**：`dsh plugin --profile web add file:$(pwd)` 安装，插件名 `dsh-profile-selector`，
>   槽位 `conversation.input.right`（工具行右侧、发送键前），RPC `dshprofile-static.*`，section `dsh-profile:profile-static`。
> - **核心共用**：两套壳共享 `src/core/`（yaml 解析 + host/client 工厂），仅 ID / 槽位 / RPC 通道不同（见 `internals.md`）。
>
> **状态**：✅ 独立项目 `dsh-scene`（源码 + 提示词档案 + 工作区配置一体化管理，git 仓库管理，2026-08-18）；
> 当前功能版本 **pkg-28**，版本历史与编号规则见 `CHANGELOG.md`。

---

## 快速开始

```bash
node scripts/verify-offline.mjs            # 离线自检（90 项，零依赖，无需 DSH 运行时）
node build.mjs                             # 构建：dist/dynamic/*（动态） + lib/*（静态）
dsh plugin --profile web add file:$(pwd)   # 静态发布：走 DSH 插件安装流程（之后需重启 dsh web）
```

> **部署口径分场景**：**静态发布（正式使用）必须走上面的 `dsh plugin` 安装流程**，不要手工把文件复制进
> `~/.dsh/profiles/`；**动态模式 / 本地测试可以直接复制**（临时手段，测完恢复干净）。详见 `deployment.md`。

## 文档索引

> **引用约定**：跨文档引用**一律只写文件名**（如「见 `internals.md`」），不写章节号、不写锚点——
> 文档内的小节标题就是导航；增删或重排小节都不必回头改引用。

| 文件 | 内容 | 何时读 |
|---|---|---|
| `README.md` | 本文件：项目定位、快速开始、源码与产物结构 | 初次接触 |
| `features.md` | 对外可见的功能与 UI 行为、档案内容约定 | 使用 / 交付说明 |
| `internals.md` | 架构总览、RPC 协议、占位符规则、**核心机制与已知坑（12 条）** | **改 `src/` 之前必读** |
| `deployment.md` | 部署步骤（动态/静态/共存）、调试手段、随包内容、数据流与安全边界 | 部署 / 排障 |
| `CHANGELOG.md` | 功能版本历史（pkg-1..28）与编号规则 | 追溯某次改动 |
| `ops-notes.md` | 运维备忘：环境事实、profile/bundle 同步、上游版本回归、升级核查 | 排障 / 升级 |
| `persona-override.md` | persona 段清空 / 替换的设计依据（只保留最终方案） | 追溯设计决策 |
| `AGENTS.md` | 工作区指令（供 AI 会话读取）：指向本机 DSH 源码路径 | 定位 DSH 安装路径 |

`ops-notes.md` 与 `persona-override.md` 是开发侧记录，**不随包分发**（随包清单见 `deployment.md`）。

## 源码与产物结构

| 文件 | 内容 |
|---|---|
| `src/core/yaml.js` | **共享核心**：迷你 YAML 解析器（纯函数，零依赖） |
| `src/core/host.js` | **共享核心**：Host 半区工厂 `hostCore(ctx, opts, rpc)`（双模式共用） |
| `src/core/client.js` | **共享核心**：Client 半区工厂 `clientCore(ctx, opts, deps)`（双模式共用） |
| `src/dynamic/host.js` | 动态模式 Host 壳模板（`/*__CORE_*__*/` 占位符，构建时内联核心） |
| `src/dynamic/client.js` | 动态模式 Client 壳模板（同上） |
| `src/static/host.js` | 静态模式 Host 壳（ESM import 核心；`connection.register(ctx, '/rpc', ...)` 适配） |
| `src/static/client.js` | 静态模式 Client 壳（ESM import 核心；`connection.rpc.call` 适配） |
| `build.mjs` | 双模式构建脚本（动态内联 → `dist/dynamic/`；静态 esbuild → `lib/`） |
| `scripts/verify-offline.mjs` | **离线验证脚本**（零依赖，90 项：真实 `.deepseek.yaml` 结构守护 + YAML 解析 / 多文件合并 / 开场白覆盖 / persona 段清空替换 / 子代理档案继承 / 回归；`node scripts/verify-offline.mjs`） |
| `cordis.patch.yml` | 静态模式挂载层（`dsh plugin` 安装时插入 loader）；**顶层**另有一条 `includeHarnessIdentity: false` 覆盖，关掉第一方开场白（见 `internals.md`） |
| `package.json` | 项目元信息（`dsh.bundle.patch` / `dsh.client` / `exports` / `build` 脚本 / `files` 随包白名单） |
| `dist/dynamic/{host,client}.js` | **构建产物**：动态函数体（cordis_define 用；勿手改） |
| `lib/{index,client}.js` | **构建产物**：静态 bundle（勿手改） |
| `.deepseek.yaml` | 工作区配置（`system_prompts` 档案源 + `global_prompt` 开场白覆盖 + `persona_prompt` / `persona_clear` persona 段覆盖；被插件解析，含 `parameters.temperature`）。语义与生效条件见 `features.md` |
| `doc/prompts/*.md` | **工作区提示词档案正文**：`default.md`、`ai.md`、`dev.md` 为档案，`global.md` 为开场白覆盖正文；指向、占位符与内容约定见 `features.md` |
| `pnpm-workspace.yaml` | pnpm 构建策略（`allowBuilds: esbuild: true`，允许 esbuild 跑安装脚本） |
| `.gitignore` | 忽略 `node_modules/`、`.pnpm-store/`、`.idea/` 等 |

**运行期依赖**（DSH 提供，只读参考，勿改）：
- DSH 源码：`/home/j/.nvm/versions/node/<ver>/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`
  （**以本机实际安装为准**：本机当前 node `v22.23.2`；此处曾写死 `v24.19.0`，已过时——node 版本升级后路径会变）
- 构建依赖：`esbuild`（devDependency `^0.28.2`）+ `react`（dependency `^19.2.8`，仅供静态 client bundle 的 seed word
  解析用；动态模式用闭包符号不依赖它）——均经 `pnpm install` 安装。

> 开发须知：本项目的「开发必读」是 `internals.md`（含 12 条已知坑），部署与自检流程见 `deployment.md`；
> 改完 `src/core/` 请先跑离线自检脚本，全过再构建。
