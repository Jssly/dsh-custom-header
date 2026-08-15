/**
 * The dsh-custom-header wire contract, shared verbatim by the host manifest
 * (`ctx.typert.register` in typert.ts) and the client contribution
 * (`ctx.remote.$mount` in client/remote.ts). One `customHeader` namespace
 * exposes two endpoints:
 *   - `settingsGet`: read the resolved settings (cordis.yml + persisted file).
 *   - `settingsSet`: apply a partial settings patch (persisted host-side).
 *
 * The settings payload is the resolved custom-header config from
 * `normalizeCustomHeaderConfig`: profile, autoHosts, version fields, body
 * patch mode, extraHeaders and urlRewrites.
 */
import { z } from 'zod'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'

// ---- Shared settings types (host store ↔ settings tab) ----

/** The settings round-trip: current effective config + factory defaults. */
export interface CustomHeaderSettingsView {
  config: Record<string, unknown>
  defaults: Record<string, unknown>
}

// ---- Wire schemas ----

/** settingsGet payload: no arguments. */
export const settingsGetPayloadSchema = z.object({})

/** settingsSet payload: partial patch over the resolved settings. */
export const settingsSetPayloadSchema = z.object({
  patch: z.record(z.string(), z.unknown()).optional(),
}).passthrough()

/** Settings view codec (fields ride through as a loose record). */
export const settingsViewSchema = z.object({
  config: z.record(z.string(), z.unknown()),
  defaults: z.record(z.string(), z.unknown()),
}).passthrough()

function codec(typeSymbol: string, schema: z.ZodType): InvocationDescriptor['parameters'][number]['codec'] {
  return { mode: 'strict', typeSymbol, schema }
}

function param(schema: z.ZodType, typeSymbol: string): InvocationDescriptor['parameters'] {
  return [{
    name: 'payload',
    wire: 'payload',
    source: 'json',
    codec: codec(typeSymbol, schema),
  }]
}

function descriptor(
  method: string,
  payloadSchema: z.ZodType,
  payloadTypeSymbol: string,
  resultSchema: z.ZodType,
  resultTypeSymbol: string,
): InvocationDescriptor {
  return {
    id: `dsh-custom-header#customHeader/${method}`,
    service: 'customHeader',
    namespace: 'customHeader',
    method,
    invocation: { kind: 'direct' },
    parameters: param(payloadSchema, payloadTypeSymbol),
    result: { mode: 'strict', typeSymbol: resultTypeSymbol, schema: resultSchema },
  }
}

/** The customHeader namespace's strict invocation descriptors (host manifest + client mount share this). */
export const CUSTOM_HEADER_INVOCATIONS: readonly InvocationDescriptor[] = [
  descriptor('settingsGet', settingsGetPayloadSchema, 'dsh-custom-header#SettingsGetPayload', settingsViewSchema, 'dsh-custom-header#SettingsView'),
  descriptor('settingsSet', settingsSetPayloadSchema, 'dsh-custom-header#SettingsSetPayload', settingsViewSchema, 'dsh-custom-header#SettingsView'),
]