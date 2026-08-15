/**
 * The client-side Typert Remote contribution for the dsh-custom-header host
 * service: mounts the shared strict descriptors into `ctx.remote.customHeader`.
 */
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { CUSTOM_HEADER_INVOCATIONS } from '../contract.ts'
import type { CustomHeaderNamespaceFace } from './face.ts'

/** The customHeader Remote namespace's client contribution. */
export const CUSTOM_HEADER_REMOTE: TypertRemoteContribution = {
  package: 'dsh-custom-header',
  descriptors: CUSTOM_HEADER_INVOCATIONS,
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  // Typed face of the mounted namespace. Resolved at runtime through
  // `ctx.reflect.get('remote.customHeader')` (see client/index.ts).
  /** The `customHeader` namespace face mounted under `ctx.remote.customHeader`. */
  interface TypertRemoteNamespace$437573746f6d486561646572 extends CustomHeaderNamespaceFace {}
  interface TypertRemoteMap {
    'customHeader/settingsGet': CustomHeaderNamespaceFace['settingsGet']
    'customHeader/settingsSet': CustomHeaderNamespaceFace['settingsSet']
  }
  interface TypertRemoteNamespaceMap {
    customHeader: TypertRemoteNamespace$437573746f6d486561646572
  }
}

export type { CustomHeaderNamespaceFace }