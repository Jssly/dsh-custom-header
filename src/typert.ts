/**
 * The hand-written host Typert manifest for the customHeader Remote.
 * Registered through `ctx.typert.register` in the plugin body; the Host
 * Gateway resolves and invokes `customHeader/settingsGet|settingsSet` from
 * this manifest without consulting the `@Remote` marker table.
 */
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
import { CUSTOM_HEADER_INVOCATIONS } from './contract.ts'

/** The customHeader namespace's host manifest (strict codecs shared with the client). */
export const TYPERT_MANIFEST: TypertContribution = {
  package: 'dsh-custom-header',
  face: 'host',
  schemas: [],
  model: {
    services: [
      {
        key: 'customHeader',
        exportName: 'CustomHeaderRuntime',
        description: 'Outbound LLM request header modification: client-identity presets, fingerprint stripping, URL rewriting and Anthropic body patching. Settings are read/written over this namespace.',
        tags: [],
        members: [
          { kind: 'method', name: 'settingsGet', signature: 'settingsGet(payload: {}): CustomHeaderSettingsView' },
          { kind: 'method', name: 'settingsSet', signature: 'settingsSet(payload: { patch?: Record<string, unknown> }): CustomHeaderSettingsView' },
        ],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
  invocations: CUSTOM_HEADER_INVOCATIONS,
}