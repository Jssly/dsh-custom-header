/**
 * Settings normalization for the settings page: the single place that turns
 * arbitrary input (cordis.yml config seed, persisted JSON, wire patch) into
 * a fully resolved custom-header config with every field defined and
 * sanitized. Thin wrapper over `normalizeCustomHeaderConfig`, which already
 * owns the field vocabulary and the sanitizers.
 */
import type { ResolvedCustomHeaderConfig } from './config.ts'
import { normalizeCustomHeaderConfig } from './config.ts'
import { CUSTOM_HEADER_DEFAULTS } from './config.ts'

/** Factory defaults (also the reset target of the settings tab). */
export const CUSTOM_HEADER_SETTINGS_DEFAULTS: ResolvedCustomHeaderConfig = {
  ...CUSTOM_HEADER_DEFAULTS,
}

/** Normalize raw settings input (never throws for bad input). */
export function normalizeCustomHeaderSettings(
  raw: Record<string, unknown>,
): ResolvedCustomHeaderConfig {
  return normalizeCustomHeaderConfig(raw)
}