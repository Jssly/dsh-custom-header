# Changelog

## 0.1.0 (2026-08-15)

- 首个版本：`dsh-custom-header` —— DeepSeek Harness 网关客户端签名
  注入插件。
- 传输层全保真实现（fetch 中间件管道 `dsh-custom-header.fetch.pipeline.v1`）：
  - `header-inject`：按请求注入 8 个预设的客户端签名头（`autoHosts` 门控
    固定 profile 始终注入）
  - `header-strip`：opencode_zen 预设剥离 `X-Stainless-*` / 运行时指纹头
    （仅 `autoHosts` 主机）
  - `url-rewrite`：路径重写 / query 追加（如 `/v1/messages` 追加
    `beta=true`），host 门控
  - `body-patch`：Anthropic Messages body 注入 `system` 块与
    `metadata.user_id`（JSON 设备/会话格式）
- 会话级 id：`agent/session-start` 轮换 `X-Claude-Code-Session-Id` 与
  `x-opencode-session`；`x-opencode-request` 每次请求新生成
  （opencode `Identifier.ascending()` 复刻）
- `llm/stream` 瀑布观察器：终态 403 诊断，区分 Cloudflare HTML 边缘拦截
  与网关 `client_restriction` JSON
- DSH 原生格式：schemastery `Config` schema、cordis.yml 插件节、
  `$DSH_HOME/plugins/dsh-custom-header.json` 运行时持久化、
  `ctx.dshCustomHeader` 服务（`status()` / `setProfile()`）
- 冒烟测试 `tests/smoke.mjs`：本地假网关覆盖 5 个场景（auto+Claude 体补丁、
  auto+Codex 回退、opencode_zen 动态 id + 指纹剥离、host 门控、off）

### 已知限制

- `accept-language` / `sec-fetch-mode` 由 undici 在 fetch 之下注入，
  扩展层无法剥离）
- 固定 profile（非 auto/off）不受 `autoHosts` 限制，全局注入（pi 同款语义）

### 0.1.0 行为等价修正（评审后）

- **会话 id 按对话隔离**：pi 是单会话进程（模块级 id 正确）；DSH 多 agent 并发，
  改为 `llm/stream` 包装器将 `GenerateOptions.sessionId` 经 AsyncLocalStorage
  传递到 fetch 层，`x-opencode-session` / `X-Claude-Code-Session-Id` / body
  `user_id` 均按会话惰性分配缓存；非 LLM 请求退回进程稳定 default 会话
- **前缀路由兼容**：Anthropic 判断从精确 `/v1/messages` 改为三态匹配
  （`/v1/messages`、`/v1/messages/…`、`…/v1/messages`），对齐 pi 按
  `model.api` 判断的语义（覆盖 baseUrl 带路径段的自建网关）
- 冒烟测试扩展至 7 场景 25 断言（新增会话隔离、前缀路由）

### 0.1.2（2026-08-15）

- 预设 `sub2api_pi_agent` 改名为 `pi_agent`（配置标识符去品牌化）；
  旧值不再识别，需手工更新 cordis.yml 与持久化 JSON 中的 profile 值。

## 0.1.1 真实性核对修正（对照 openai/codex 源码与网关白名单）

- **codex_official UA 修正**：真实构造为
  `{originator}/{版本} ({os_type} {os_version}; {arch}) {终端token}`
  （`get_codex_user_agent` + `terminal_detection`）；旧值尾部 `terminal`
  不是任何真实终端 token，改为 `WindowsTerminal`；版本默认 0.98.0 → 0.147.0，
  新增 `codexVersion` / `codexDesktopVersion` 配置
- **新增 `codex_tui` 预设**：交互式 `codex`（TUI 前端）实际发送
  `codex-tui/…` UA + `Originator: codex-tui`（白名单
  `is_first_party_originator`、TUI `client_name`、官方 UA 前缀列表三处互证）；
  与 `codex_official`（headless 默认）并列，均可选作 `autoCodexProfile`
- 冒烟测试扩至 8 场景 27 断言（新增 codex_tui 精确匹配）