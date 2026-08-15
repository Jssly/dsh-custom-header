/**
 * The callable face of the `customHeader` Remote namespace as the browser
 * sees it. One definition shared by the mount code (client/index.ts), the
 * Typert client contribution (client/remote.ts), and the settings tab.
 */
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { CustomHeaderSettingsView } from '../contract.ts'

/** The customHeader namespace face exposed under `ctx.remote.customHeader`. */
export interface CustomHeaderNamespaceFace {
  /** Current effective settings + factory defaults (settings tab load). */
  settingsGet(payload: Record<string, never>): Promise<RemoteResult<CustomHeaderSettingsView>>
  /** Apply a partial settings patch (persisted host-side). */
  settingsSet(payload: { patch?: Record<string, unknown> }): Promise<RemoteResult<CustomHeaderSettingsView>>
}

export type { RemoteResult, CustomHeaderSettingsView }