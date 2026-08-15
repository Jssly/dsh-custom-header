# dsh-custom-header

**DeepSeek Harness（DSH）出站 LLM 请求头修改插件。**

工作在 fetch 传输层——比 LLM SDK 低一层——对出站 provider 请求的 HTTP
头做修改：

- **注入**客户端身份头（`User-Agent`、`Originator`、`X-Claude-Code-Session-Id`、
  `x-opencode-*` 等），预设头集仿照真实 Codex / Claude Code / opencode 客户端
- **剥离** SDK 运行时指纹头（`X-Stainless-*`）
- **重写**请求 URL（路径匹配 + `appendQuery`）
- **补丁** Anthropic Messages 请求体（identity / billing system 块 +
  `metadata.user_id`）

所有修改受显式主机白名单（`autoHosts`）约束——白名单外的请求一律不碰；
默认 `auto` profile 且白名单为空时，所有请求原样放行。

> 仅用于你有权管理的服务器或已授权环境。Cloudflare 的 TLS/Bot 边缘拦截
> 需要不同的 API 入口、管理员白名单或本地正向代理（见下文故障排查）。

## 工作机制

DSH 没有按请求注入头的钩子，因此所有修改都落在 **fetch 传输层**，共用
一条共享中间件管道（`Symbol.for("dsh-custom-header.fetch.pipeline.v1")`）：

| 机制 | 中间件 | 安全门 |
|---|---|---|
| 头注入 | `header-inject`（priority 7） | auto 需 host 匹配；固定 profile 始终注入 |
| 指纹头剥离 | `header-strip`（priority 6） | 仅 `autoHosts` 主机 |
| Anthropic body 补丁 | `body-patch`（priority 8） | 仅 Anthropic Messages 路径 |
| URL 重写 | `url-rewrite`（priority 5） | 仅 `autoHosts` 主机 |
| 会话 id 隔离 | 按 `GenerateOptions.sessionId` 隔离（AsyncLocalStorage 传递到 fetch 层，见 `session-context.ts`） | — |
| 403 诊断 | `llm/stream` 瀑布观察器（终态 403） | — |

安全默认：`profile: "auto"` 且 `autoHosts` 为空 → 什么都不做。

## 预设（profiles）

每个固定预设是一整套完整的客户端身份头：

| Profile | 发送的头 |
|---|---|
| `codex_desktop` | `codex_app/1.2026.0628 (Windows NT 10.0; Win64; x64)` + `Originator: codex_app` |
| `codex_official` | `codex_cli_rs/0.147.0 (Windows 10.0.19045; x86_64) WindowsTerminal` + `Originator: codex_cli_rs` |
| `codex_tui` | `codex-tui/0.147.0 (…; x86_64) WindowsTerminal` + `Originator: codex-tui` |
| `codex_claude_plugin` | `Claude Code/0.5.0 (Macos 15.5; arm64) iTerm2.app` + `Originator: Claude Code` |
| `pi_agent` | `pi-coding-agent/1.0` + `Originator: pi`（需要服务器侧同时放行该身份） |
| `claude_code_messages` | `claude-cli/2.1.220 (external, sdk-cli)` + `X-Claude-Code-Session-Id` + 完整 `anthropic-beta` + body（JSON `user_id` / system 块） |
| `opencode_zen` | `opencode/1.18.18 ai-sdk/...` UA + `x-opencode-client/project/session/request`，并剥离 `X-Stainless-*` 指纹头 |
| `auto` | `autoHosts` 匹配：Anthropic Messages 路径 → Claude 头集；其余 → `autoCodexProfile` |
| `off` | 不修改 |

Codex 头值已对照 openai/codex 开源源码验证（见下文「真实性核对」）；
opencode 的 `Identifier.ascending()` id 方案（`ses_`/`msg_` + hex12 +
base62）与 Claude Code 2.1.220 头集按真实格式重建。

## 真实性核对（Codex 预设）

Codex 身份字段逐项对照一手来源：

- **`Originator: codex_cli_rs`** —— openai/codex 源码实锤：
  `codex-rs/login/src/auth/default_client.rs` 中
  `DEFAULT_ORIGINATOR = "codex_cli_rs"`（另有 codex-tui / codex_vscode）。
- **codex_official 的 UA 构造** —— 同文件 `get_codex_user_agent()`：
  `{originator}/{版本} ({os_type} {os_version}; {arch}) {终端token}`，终端
  token 来自 `codex-rs/terminal-detection/src/lib.rs`（Windows Terminal →
  `WindowsTerminal`，TERM 环境 → `xterm-256color` 等）。写死的 `terminal`
  尾部不存在于任何真实 Codex 构建，已替换。版本为当前最新 `0.147.0`
  （rust-v0.147.0，2026-08-07 发布）。
- **codex_cli_rs 与 codex-tui 的区分** —— CLI 有多个第一方前端：
  `default_client.rs` 的 `DEFAULT_ORIGINATOR = "codex_cli_rs"` 且 UA 由进程
  originator 拼装，但 `is_first_party_originator` 白名单同时含 `codex-tui`
  和 `codex_vscode`，TUI 自报 `client_name: "codex-tui"`
  （`tui/src/lib.rs`）。交互式 `codex` 会话实际发 `codex-tui/…` UA +
  `Originator: codex-tui`。预设 `codex_official`（headless/默认）与
  `codex_tui`（交互 TUI）覆盖两种形态。
- **`codex_app/` + `Originator: codex_app`** —— 桌面壳闭源；
  `codex_app` 是客户端家族自身的身份串。完整 UA 为实测值，可用
  `codexDesktopVersion` 覆盖。
- **codex_claude_plugin** —— Claude Code UA 格式（`Claude Code/x.y.z (OS;
  arch) Terminal`），`0.5.0` 是真实存在的旧版本；服务端只匹配前缀，
  保守取值。

## 行为说明

已用 `tests/smoke.mjs` 验证：

- **会话 id 按对话隔离**：DSH 多 agent 并发，若共享全局 id，任一 agent 的
  请求都会与其它 agent 互相串号。本插件由 `llm/stream` 包装器把
  `GenerateOptions.sessionId` 经 AsyncLocalStorage 传到 fetch 层，id 按会话
  惰性分配并缓存（会话内稳定、会话间隔离）；非 LLM 路径（如模型发现）
  退回进程稳定 default 会话。
- **前缀路由兼容**：fetch 层只有 URL，故 Anthropic 识别支持
  `/v1/messages`、`/v1/messages/…`、`…/v1/messages` 三种形态（覆盖 baseUrl
  带路径段的场景），profile 选择与 body 补丁共用同一判断。
- **UA 终局覆盖**：`dsh-llm-pi-ai` 会在 profile headers 之后合并 harness
  attribution UA（attribution 优先，配 `headers` 会被顶掉）；fetch 层在
  adapter 之后写入，注入 UA 必然生效，且 attribution 只产出
  `user-agent` 一个头、无其它残留头。

保留的结构性细节（设计使然）：

- 403 诊断触发在流终态（`llm/stream` finish `status === 403`）；诊断日志
  区分 Cloudflare HTML 拦截与 JSON 拒绝响应。
- `accept-language` / `sec-fetch-mode` 由 Node undici 在 fetch 之下注入，
  扩展层无法剥离。若服务端校验到这一层，需要本机反代出网前剥离。

## 安装

```bash
# 在插件仓库目录（装完重启 dsh web）
dsh plugin --profile web add file:$(pwd)

# 或发布到 npm 后：
dsh plugin --profile web add dsh-custom-header
```

验证：`dsh --profile web --dump-config | grep dsh-custom-header`，或观察
DSH 服务器日志里 `dsh-custom-header loaded: ...` 诊断行。

## 配置

`cordis.yml` 的插件节（所有字段可选）：

```yaml
dsh-custom-header:
  profile: auto                 # auto | off | codex_desktop | codex_official | codex_claude_plugin | pi_agent | claude_code_messages | opencode_zen
  autoHosts:                    # (必填才会修改请求) 目标主机名，子域自动匹配
    - gateway.example.com
  autoCodexProfile: codex_desktop
  codexVersion: 0.147.0        # codex_cli_rs UA 版本
  codexDesktopVersion: 1.2026.0628  # codex_app UA 版本（桌面端，闭源）
  claudeCliVersion: 2.1.220
  opencodeVersion: 1.18.18
  opencodeClient: cli
  opencodeProject: global
  claudeSystemMode: identity    # identity | billing
  extraHeaders: {}              # 合并到所有 profile 末尾
  urlRewrites:                  # 仅 autoHosts 主机生效
    /v1/messages:
      appendQuery: beta=true    # 服务端严格校验 ?beta=true 时
  persistProfile: true
```

## 设置页面

设置 → 插件 → **请求头修改 / Custom Header** Tab：下拉选择 `profile` 与
auto 兜底预设、编辑 `autoHosts` 白名单、切换 Claude system 块模式
（`identity` / `billing`）、调整各版本号字段——全部经宿主校验。保存通过
`customHeader/settingsSet`（Typert Remote）写入并**立即生效**（fetch
中间件读取同一个状态对象），无需刷新。

```js
// 任意插件 / 脚本里：
ctx.dshCustomHeader.setProfile('codex_desktop')
ctx.dshCustomHeader.status()   // 诊断快照
```

优先级：**持久化文件字段 > cordis.yml 字段 > 默认值**；特例：显式设置的
cordis.yml `profile` 仍优先于持久化 profile（部署意图优于页面选择）。

## 已知残留与限制

- **`accept-language` / `sec-fetch-mode`**：由 Node undici 在 fetch 之下注入，
  扩展层删不掉。多数服务端只看 UA + 自定义头，实践中够用；若服务端
  校验到这一层，需要本机反代出网前剥离。
- **opencode Zen 头互斥**：opencode 源码 `LLMRequestPrep.prepare` 三元分支——
  只有 `providerID.startsWith("opencode")` 才发 `x-opencode-*`；其它 provider
  发 `x-session-affinity` / `X-Session-Id`。本插件只复刻前者。
- **固定 profile 全局注入**：`codex_official` 等固定预设不受 `autoHosts`
  限制，对所有 provider 请求生效。不想影响某些端点时请用 `auto`。
- **Anthropic `?beta=true`**：通过 `urlRewrites.appendQuery` 解决，无需反代。
- **Cloudflare 拦截**：若错误是 **HTML**（Attention Required / blocked），
  属边缘拦截，修改请求头无效；需换 API 入口、管理员白名单或本机转发。
  `llm/stream` 观察器会在日志中区分 CF HTML 与 JSON 拒绝响应。
- **本插件是宿主侧插件，无浏览器客户端**：诊断走服务器日志 +
  `ctx.dshCustomHeader.status()`，不占用 Web UI 面。

## 开发

```bash
npm install
npm run typecheck   # tsc 类型检查
npm run build       # esbuild → lib/index.js + lib/types
node tests/smoke.mjs  # 传输层冒烟测试（本地假服务器，9 场景 29 断言）
```

## 许可

MIT。fetch 管道 vendored from [`@aizigao/pi-fetch-pipeline`](https://github.com/aizigao/pi-fetch-pipeline)（MIT）。