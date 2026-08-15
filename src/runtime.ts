/**
 * The dsh-custom-header host Remote service (`ctx.customHeader`, wire
 * namespace `customHeader`). Registered as a TypertRemoteService so the
 * Host Gateway exports its @Remote methods to the Web client under
 * `/api/customHeader/*`.
 *
 * Endpoints:
 *   - `settingsGet`: current effective settings + factory defaults.
 *   - `settingsSet`: apply a partial patch, persist, return the fresh view.
 *
 * The runtime deliberately holds no state of its own — it forwards to the
 * plugin body's `RuntimeState`, so the fetch middlewares, the programmatic
 * `ctx.dshCustomHeader` face and the settings page all observe the same
 * config object.
 */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { CustomHeaderSettingsView } from './contract.ts'

/** Callbacks into the plugin body's runtime state. */
export interface CustomHeaderRuntimeHooks {
  /** Effective settings + defaults, for the settings tab. */
  getView(): CustomHeaderSettingsView
  /** Apply a partial patch to the live config, persist, return the view. */
  applyPatch(patch: Record<string, unknown>): CustomHeaderSettingsView
}

/** The customHeader control plane: settings endpoints. */
export class CustomHeaderRuntime extends TypertRemoteService {
  /**
   * Register the service under the `customHeader` key (the wire namespace).
   * @param ctx - owning cordis context.
   * @param hooks - state access into the plugin body (see above).
   */
  constructor(
    ctx: Context,
    private readonly hooks: CustomHeaderRuntimeHooks,
  ) {
    super(ctx, 'customHeader')
  }

  /** Current effective settings + factory defaults (settings tab load). */
  @Remote
  settingsGet(_payload: Record<string, never>): CustomHeaderSettingsView {
    return this.hooks.getView()
  }

  /**
   * Apply a partial settings patch, persist, and return the fresh view.
   * Values are sanitized host-side (bad values fall back to defaults).
   * @param payload - wire payload with the optional patch record.
   */
  @Remote
  settingsSet(payload: { patch?: Record<string, unknown> }): CustomHeaderSettingsView {
    return this.hooks.applyPatch(payload.patch ?? {})
  }
}