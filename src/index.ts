/**
 * dsh-custom-header — gateway client-signature injection for DeepSeek
 * Harness (DSH).
 *
 * Modifies outbound LLM request headers at the fetch transport layer:
 * client-identity header presets mirroring real Codex / Claude Code /
 * opencode clients, X-Stainless fingerprint stripping, URL rewrites and
 * Anthropic body patching, scoped per host allowlist.
 *
 * Architecture (DSH has no per-request header hook, so every injection
 * point lands at the fetch transport layer, sharing one middleware
 * pipeline; nothing outside the autoHosts allowlist is ever touched):
 *
 *   - header injection      → `custom-header-inject` fetch middleware
 *   - X-Stainless stripping → `custom-header-strip` fetch middleware
 *   - Anthropic body patch  → `custom-body-patch` fetch middleware
 *   - URL rewrite           → `custom-url-rewrite` fetch middleware
 *   - session id scoping    → per-conversation ids via
 *     `GenerateOptions.sessionId` + AsyncLocalStorage (session-context.ts)
 *   - 403 diagnostics       → `llm/stream` waterfall observer
 *
 * Config: cordis.yml `dsh-custom-header:` section (schema below), plus a
 * persisted settings file under `$DSH_HOME/plugins/dsh-custom-header.json`
 * (explicit cordis.yml profile wins over the persisted profile). The
 * Settings → Plugins "Custom Header" tab (src/client) reads and writes
 * those settings over the `customHeader` Typert Remote namespace.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: brings the `llm/stream` and `agent/*` event vocabulary into
// the cordis Context type. At runtime nothing from these packages is
// imported — the plugin only registers listeners.
import type {} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'

import { normalizeCustomHeaderConfig, hasExplicitCordisProfile, CUSTOM_HEADER_DEFAULTS, ConfigSchema, type ConfigType, type ResolvedCustomHeaderConfig } from './config.ts'
import { CUSTOM_HEADER_SETTINGS_DEFAULTS } from './settings.ts'
import { getProfileMenuEntries, type GatewayHeaderProfile } from './profiles.ts'
import { registerFetchMiddleware } from './fetch-pipeline.ts'
import { createHeaderStripMiddleware, createHeaderInjectMiddleware } from './header-inject.ts'
import { createUrlRewriteMiddleware } from './url-rewrite.ts'
import { createBodyPatchMiddleware } from './body-patch.ts'
import { format403Hint } from './response-hints.ts'
import { SettingsStore, settingsStoreFile } from './store.ts'
import { requestSessionContext } from './session-context.ts'
import { CustomHeaderRuntime, type CustomHeaderRuntimeHooks } from './runtime.ts'
import { TYPERT_MANIFEST } from './typert.ts'
import type { GatewayClientProfileId } from './types.ts'

/** Cordis plugin name (the Loader entry). */
export const name = 'dsh-custom-header'

/** Services required before load: none hard — llm/agent events are optional observers. */
export const inject: string[] = []

/**
 * Deployment configuration. Every field optional; defaults fill the rest.
 * Deployment configuration, DSH-style.
 */
export interface Config {
  /** auto | off | codex_desktop | codex_official | codex_claude_plugin | pi_agent | claude_code_messages | opencode_zen */
  profile?: GatewayClientProfileId
  /** Hosts whose requests may be touched (auto profile + stripping + URL rewrite). */
  autoHosts?: string[]
  /** Claude system block: "identity" or "billing". */
  claudeSystemMode?: 'identity' | 'billing'
  /** Override claude-cli/x.y.z (default 2.1.220). */
  claudeCliVersion?: string
  /** Override the anthropic-beta header for the Claude profile. */
  anthropicBeta?: string
  /** Override opencode/x.y.z (default 1.18.18). */
  opencodeVersion?: string
  /** x-opencode-client value (default "cli"). */
  opencodeClient?: string
  /** x-opencode-project value (default "global"). */
  opencodeProject?: string
  /** Merged after profile headers (all profiles). */
  extraHeaders?: Record<string, string>
  /** auto profile: Codex preset for non-Anthropic hosts (default codex_official). */
  autoCodexProfile?: 'codex_official' | 'codex_desktop' | 'codex_claude_plugin'
  /** Fetch-layer URL rewrites; only autoHosts hosts are ever rewritten. */
  urlRewrites?: Record<string, string | { path?: string; appendQuery?: string }>
  /** Persist runtime profile choices (default true). */
  persistProfile?: boolean
}

/** schemastery schema (the Loader validates cordis.yml against it). */
export const Config: typeof ConfigSchema = ConfigSchema

/** Runtime state shared by every middleware (read fresh per request). */
interface RuntimeState {
  profile: GatewayClientProfileId
  config: ResolvedCustomHeaderConfig
}

/** The plugin's public service surface (diagnostics + programmatic switch). */
export interface CustomHeaderService {
  /** Effective profile & resolved config (diagnostics core). */
  status(): { profile: GatewayClientProfileId; effective: string; config: ResolvedCustomHeaderConfig; profileMenu: string[] }
  /** Switch profile at runtime; persists when persistProfile is on. */
  setProfile(profile: GatewayClientProfileId): void
}

/**
 * Mount the plugin.
 * @param ctx - host cordis context.
 * @param config - validated plugin configuration (schema defaults applied).
 */
export function apply(ctx: Context, config?: ConfigType): void {
  const seed = normalizeCustomHeaderConfig((config ?? {}) as Record<string, unknown>)
  const explicit = hasExplicitCordisProfile((config ?? {}) as Record<string, unknown>)

  // Persisted settings file fields > cordis.yml seed fields > defaults. An
  // explicitly set cordis.yml profile still wins over the persisted profile
  // (deployment intent beats a saved UI selection).
  const store = new SettingsStore(settingsStoreFile(), seed)
  const resolved = store.get()
  if (explicit) resolved.profile = seed.profile

  const state: RuntimeState = { profile: resolved.profile, config: resolved }

  // ---- fetch middleware chain (priority ascending) ----
  registerFetchMiddleware({
    name: 'dsh-custom-header-url-rewrite',
    priority: 5,
    middleware: createUrlRewriteMiddleware(() => ({
      enabled: state.profile !== 'off',
      hosts: state.config.autoHosts,
      rewrites: state.config.urlRewrites,
    })),
  })
  registerFetchMiddleware({
    name: 'dsh-custom-header-header-strip',
    priority: 6,
    middleware: createHeaderStripMiddleware(() => ({
      profile: state.profile,
      config: state.config,
    })),
  })
  registerFetchMiddleware({
    name: 'dsh-custom-header-header-inject',
    priority: 7,
    middleware: createHeaderInjectMiddleware(() => ({
      profile: state.profile,
      config: state.config,
    })),
  })
  registerFetchMiddleware({
    name: 'dsh-custom-header-body-patch',
    priority: 8,
    middleware: createBodyPatchMiddleware(() => ({
      profile: state.profile,
      config: state.config,
    })),
  })

  // ---- session-scoped ids + 403 diagnostics: wrap the LLM stream ----
  // Every iteration of the adapter's stream (including the fetch it issues)
  // runs inside AsyncLocalStorage carrying GenerateOptions.sessionId, so the
  // fetch middlewares can scope x-opencode-session / X-Claude-Code-Session-Id
  // per DSH conversation instead of sharing one process-wide id (concurrent
  // DSH agents would otherwise steal another conversation's ids).
  const logger = ctx.logger
  ctx.on('llm/stream', function (_options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) {
    const inner = next()
    const iterator = inner[Symbol.asyncIterator]()
    const sessionKey = String(_options.sessionId ?? '')

    const observe = (result: IteratorResult<StreamChunk>): IteratorResult<StreamChunk> => {
      const chunk = result.done ? undefined : result.value
      const failure =
        chunk?.type === 'finish' &&
        (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')
          ? chunk.reason.failure
          : undefined
      if (failure?.status === 403) {
        logger.warn(`[dsh-custom-header] HTTP 403 — ${format403Hint({ message: failure.message, profile: state.profile })}`)
      }
      return result
    }

    const doneResult = (): IteratorResult<StreamChunk> => ({ done: true, value: undefined })
    const runNext = () => requestSessionContext.run(sessionKey, () => iterator.next())
    const runReturn = () =>
      requestSessionContext.run(sessionKey, () => iterator.return?.() ?? Promise.resolve(doneResult()))
    const runThrow = (err: unknown) =>
      requestSessionContext.run(sessionKey, () => iterator.throw?.(err) ?? Promise.resolve(doneResult()))

    return {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.resolve(runNext()).then(observe),
          return: () => Promise.resolve(runReturn()).then(observe),
          throw: (err: unknown) => Promise.resolve(runThrow(err)).then(observe),
        }
      },
    }
  })

  // ---- service surface ----
  ctx.provide('dshCustomHeader', {
    status() {
      return {
        profile: state.profile,
        effective: effectiveStatus(state),
        config: { ...state.config },
        profileMenu: getProfileMenuEntries(state.config).map((m) => `${m.id} — ${m.label}`),
      }
    },
    setProfile(profile: GatewayClientProfileId) {
      state.profile = profile
      state.config.profile = profile
      if (state.config.persistProfile) {
        store.update({ profile })
      }
      logger.info(`[dsh-custom-header] profile -> ${profile}`)
    },
  } satisfies CustomHeaderService)

  // ---- settings page (Typert Remote) ----
  // Registered only when the host provides the strict Typert registry; the
  // fetch-pipeline core works without it. The runtime forwards to the same
  // state the middlewares read, so saves apply immediately.
  const hooks: CustomHeaderRuntimeHooks = {
    getView() {
      return {
        config: { ...state.config },
        defaults: { ...CUSTOM_HEADER_SETTINGS_DEFAULTS },
      }
    },
    applyPatch(patch) {
      const view = store.update(patch)
      let next = view.config
      if (explicit) next = { ...next, profile: seed.profile }
      state.config = next
      state.profile = next.profile
      const keys = Object.keys(patch)
      logger.info(`[dsh-custom-header] settings updated${keys.length ? `: ${keys.join(', ')}` : ''}`)
      return {
        config: { ...next },
        defaults: { ...CUSTOM_HEADER_SETTINGS_DEFAULTS },
      }
    },
  }

  ctx.effect(() => {
    const typert = ctx.get('typert') as
      | { register(manifest: unknown): unknown; get?(name: string): unknown }
      | undefined
    if (typert === undefined || typeof typert.register !== 'function') return
    void new CustomHeaderRuntime(ctx, hooks)
    const dispose = typert.register(TYPERT_MANIFEST) as (() => void) | undefined
    return () => {
      if (typeof dispose === 'function') void dispose()
    }
  }, 'dsh-custom-header: typert manifest + customHeader runtime')

  // ---- startup diagnostics ----
  diagnostics(ctx, state)
}

function effectiveStatus(state: RuntimeState): string {
  // no request URL at startup; describe the configured rule
  const config = state.config
  if (state.profile === 'off') return 'off'
  if (state.profile === 'auto') {
    if (config.autoHosts.length === 0) return 'off (auto with empty autoHosts: safe default)'
    return `auto (hosts: ${config.autoHosts.join(', ')}, codex fallback: ${config.autoCodexProfile})`
  }
  return state.profile
}

function diagnostics(ctx: Context, state: RuntimeState): void {
  const config = state.config
  const lines = [
    `dsh-custom-header loaded: profile=${state.profile}`,
    `  effective: ${effectiveStatus(state)}`,
    `  autoHosts: ${config.autoHosts.length ? config.autoHosts.join(', ') : '(empty = auto never injects)'}`,
    `  autoCodexProfile: ${config.autoCodexProfile}`,
    `  claudeCliVersion: ${config.claudeCliVersion} · opencodeVersion: ${config.opencodeVersion}`,
    `  urlRewrites: ${Object.keys(config.urlRewrites).length ? `${Object.keys(config.urlRewrites).length} rule(s), autoHosts-gated` : 'none'}`,
    `  transport: fetch pipeline (strip+inject+rewrite+body-patch), host-scoped`,
    `  session ids: per-conversation (GenerateOptions.sessionId), x-opencode-request regenerates per request`,
  ]
  for (const line of lines) {
    ctx.logger.info(line)
  }
}

export type { GatewayHeaderProfile }
export { resolveProfileForUrl, getProfileMenuEntries, hostMatchesAutoHosts, describeEffectiveProfile } from './profiles.ts'
export { normalizeCustomHeaderConfig, CUSTOM_HEADER_DEFAULTS, type ResolvedCustomHeaderConfig } from './config.ts'
export { patchAnthropicMessagesPayload } from './body-patch.ts'
export { isGatewayClientProfileId } from './types.ts'
export { openSettingsStore, settingsStoreFile, type SettingsStore } from './store.ts'
export { registerFetchMiddleware, ensureFetchPipeline, type FetchMiddleware } from './fetch-pipeline.ts'
export { createUrlRewriteMiddleware, type UrlRewriteTarget } from './url-rewrite.ts'
export { createHeaderStripMiddleware, createHeaderInjectMiddleware } from './header-inject.ts'
export { createBodyPatchMiddleware } from './body-patch.ts'
export { requestSessionContext, sessionKeyOf } from './session-context.ts'

export default apply