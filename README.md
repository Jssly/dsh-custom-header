# dsh-custom-header

**Outbound LLM request header modification for DeepSeek Harness (DSH).**

Operates at the fetch transport layer — one layer below the LLM SDK — and
modifies the HTTP headers of outgoing provider requests:

- **injects** client-identity headers (`User-Agent`, `Originator`,
  `X-Claude-Code-Session-Id`, `x-opencode-*`, …) from a set of presets that
  mirror real Codex / Claude Code / opencode clients
- **strips** SDK runtime fingerprint headers (`X-Stainless-*`)
- **rewrites** request URLs (path matching + `appendQuery`)
- **patches** Anthropic Messages request bodies (identity / billing system
  block + `metadata.user_id`)

All of it is scoped by an explicit host allowlist (`autoHosts`) — nothing
outside the allowlist is ever touched; the default `auto` profile with an
empty allowlist sends every request through untouched.

> For servers you administer or are authorized to use. Cloudflare TLS/Bot
> edge blocks need a different API entry, an admin allowlist, or a local
> forward proxy — see the troubleshooting section in the Chinese README.

## How it works

DSH has no per-request header hook, so every modification lands at the
**fetch transport layer**, sharing one middleware pipeline
(`Symbol.for("dsh-custom-header.fetch.pipeline.v1")`):

| mechanism | middleware | safety gate |
|---|---|---|
| header injection | `header-inject` (priority 7) | auto needs host match; fixed profiles always inject |
| fingerprint stripping | `header-strip` (priority 6) | `autoHosts` hosts only |
| Anthropic body patch | `body-patch` (priority 8) | Anthropic Messages paths only |
| URL rewrite | `url-rewrite` (priority 5) | `autoHosts` hosts only |
| session id scoping | per-conversation: `GenerateOptions.sessionId` → AsyncLocalStorage → fetch middlewares (`session-context.ts`) | — |
| 403 hints | `llm/stream` waterfall observer | — |

Safe default: `profile: "auto"` with empty `autoHosts` does nothing at all.

## Profiles

Each fixed profile is a complete client-identity header set:

| Profile | Headers sent |
|---|---|
| `codex_desktop` | `codex_app/1.2026.0628 (Windows NT 10.0; Win64; x64)` + `Originator: codex_app` |
| `codex_official` | `codex_cli_rs/0.147.0 (Windows 10.0.19045; x86_64) WindowsTerminal` + `Originator: codex_cli_rs` |
| `codex_tui` | `codex-tui/0.147.0 (…; x86_64) WindowsTerminal` + `Originator: codex-tui` |
| `codex_claude_plugin` | `Claude Code/0.5.0 (Macos 15.5; arm64) iTerm2.app` + `Originator: Claude Code` |
| `pi_agent` | `pi-coding-agent/1.0` + `Originator: pi` (needs the server to accept this identity too) |
| `claude_code_messages` | `claude-cli/2.1.220 (external, sdk-cli)` + `X-Claude-Code-Session-Id` + full `anthropic-beta` + body (`metadata.user_id` JSON / system block) |
| `opencode_zen` | `opencode/1.18.18 ai-sdk/...` UA + `x-opencode-client/project/session/request`, strips `X-Stainless-*` fingerprints |
| `auto` | `autoHosts` match: Anthropic Messages paths → Claude set; else → `autoCodexProfile` |
| `off` | nothing |

The Codex header values are verified against openai/codex source (see
"Truthfulness verification"); the opencode `Identifier.ascending()` id
scheme (`ses_`/`msg_` + hex12 + base62) and the Claude Code 2.1.220 header
set are re-implemented from their real-world formats.

## Truthfulness verification (Codex presets)

Codex identity fields were checked against primary sources:

- **`Originator: codex_cli_rs`** — openai/codex
  `codex-rs/login/src/auth/default_client.rs`: `DEFAULT_ORIGINATOR = "codex_cli_rs"`.
- **codex_official UA shape** — same file, `get_codex_user_agent()`:
  `{originator}/{CARGO_PKG_VERSION} ({os_type} {os_version}; {arch}) {terminal}`,
  with the terminal token from `codex-rs/terminal-detection/src/lib.rs`
  (`WindowsTerminal` for Windows Terminal, `xterm-256color` from `TERM`, …).
  A literal `terminal` tail matches no real build and was replaced.
  `0.147.0` is the current release (rust-v0.147.0, 2026-08-07).
- **codex_cli_rs vs codex-tui** — the CLI has several first-party front-ends.
  `default_client.rs` sets `DEFAULT_ORIGINATOR = "codex_cli_rs"` and builds the
  UA from the process originator, but `is_first_party_originator` also
  whitelists `codex-tui` and `codex_vscode`, and the TUI self-identifies as
  `client_name: "codex-tui"` (`tui/src/lib.rs`). Interactive `codex` sessions
  therefore actually send `codex-tui/…` UA + `Originator: codex-tui`.
  Profiles `codex_official` (headless/default) and `codex_tui` (interactive
  TUI) cover both.
- **`codex_app/` + `Originator: codex_app`** — the desktop shell is
  closed-source; `codex_app` is the client family's own identity string.
  The full UA is a measured capture; override via `codexDesktopVersion`.
- **codex_claude_plugin UA** — Claude Code UA format
  (`Claude Code/x.y.z (OS; arch) Terminal`); 0.5.0 is an old but real
  version. Server checks only match the prefix, so the value is kept
  conservative.

## Behavior notes

Verified by `tests/smoke.mjs`:

- **Per-conversation session ids.** DSH runs concurrent agents in one
  process, so this plugin scopes `x-opencode-session` /
  `X-Claude-Code-Session-Id` per `GenerateOptions.sessionId`: the
  `llm/stream` wrapper runs every adapter iteration inside
  `AsyncLocalStorage`, and the fetch middlewares read the key back. Requests
  outside the LLM seam fall back to a stable "default" session.
- **Prefixed gateway paths.** The fetch layer only sees the URL, so the
  Anthropic Messages branch — both profile selection and body patching —
  accepts `/v1/messages`, `/v1/messages/…` and `…/v1/messages` (baseUrl path
  prefixes).
- **UA override is final.** `dsh-llm-pi-ai` merges its harness attribution
  `User-Agent` after profile headers (attribution wins there); the fetch
  layer writes after the adapter, so the injected UA always wins and the
  attribution layer cannot resurrect a conflicting one (attribution emits
  only `user-agent`, nothing else leaks).

Structural details kept by design:

- **403 diagnostics trigger at the stream terminal** (`llm/stream` finish
  with `status: 403`); the diagnostic distinguishes Cloudflare HTML blocks
  from JSON rejection responses.
- **`accept-language` / `sec-fetch-mode`** are injected by Node undici below
  `fetch` — unremovable at this layer. If your server checks them, terminate
  them at a local reverse proxy.

## Install

```bash
dsh plugin --profile web add file:$(pwd)     # or: dsh plugin --profile web add dsh-custom-header
```

Verify: `dsh --profile web --dump-config | grep dsh-custom-header`, or look
for the `dsh-custom-header loaded: ...` diagnostics in the server log.

## Config (`cordis.yml`)

```yaml
dsh-custom-header:
  profile: auto                 # auto | off | codex_desktop | codex_official | codex_claude_plugin | pi_agent | claude_code_messages | opencode_zen
  autoHosts:
    - gateway.example.com       # (required for auto/rewrite/strip to engage)
  autoCodexProfile: codex_desktop
  codexVersion: 0.147.0        # codex_cli_rs UA version
  codexDesktopVersion: 1.2026.0628  # codex_app UA version (desktop, closed-source)
  claudeCliVersion: 2.1.220
  opencodeVersion: 1.18.18
  opencodeClient: cli
  opencodeProject: global
  claudeSystemMode: identity    # identity | billing
  extraHeaders: {}              # merged onto every profile
  urlRewrites:
    /v1/messages:
      appendQuery: beta=true    # servers that strictly check ?beta=true
  persistProfile: true
```

## Settings page

Settings → Plugins → **Custom Header** (请求头修改) tab: choose the
`profile`, the auto fallback, edit the `autoHosts` allowlist, switch the
Claude system-block mode (`identity` / `billing`) and tune the version
fields — all host-validated. Save writes the patch over the
`customHeader/settingsSet` Typert Remote endpoint and applies to the next
request (the fetch middlewares read the same state object), no reload.

```js
ctx.dshCustomHeader.setProfile('codex_desktop')
ctx.dshCustomHeader.status()   // diagnostics snapshot
```

Precedence: **persisted file fields > cordis.yml fields > defaults**,
except an explicitly set cordis.yml `profile`, which still wins over the
persisted one (deployment intent beats a saved UI selection).

## Known residuals & limits

- **`accept-language` / `sec-fetch-mode`** — injected by Node undici below
  `fetch`, unremovable at the extension layer. Most servers only check UA +
  custom headers.
- **opencode header mutual exclusion** — opencode's `LLMRequestPrep.prepare`
  sends `x-opencode-*` only for opencode providers; other providers get
  `x-session-affinity` / `X-Session-Id`. This plugin replicates the former
  only.
- **Fixed profiles inject globally** — `codex_official` etc. are not gated by
  `autoHosts`. Use `auto` if you must not touch certain endpoints.
- **`?beta=true` for Anthropic** — solved via `urlRewrites.appendQuery`, no
  proxy needed.
- **Cloudflare blocks** — HTML edge responses cannot be fixed by header
  modification; switch API entry, ask for an allowlist, or forward locally.
  The `llm/stream` observer distinguishes CF HTML from JSON rejection
  responses in the logs.
- Host-only plugin: no browser client; diagnostics go to the server log and
  `ctx.dshCustomHeader.status()`.

## Development

```bash
npm install
npm run typecheck
npm run build                # esbuild → lib/index.js + lib/types
node tests/smoke.mjs         # transport smoke tests against a local fake endpoint (9 scenarios)
```

## License

MIT. Fetch pipeline vendored from
[`@aizigao/pi-fetch-pipeline`](https://github.com/aizigao/pi-fetch-pipeline)
(MIT).