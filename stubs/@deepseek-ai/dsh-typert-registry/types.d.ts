/**
 * Typecheck stubs for @deepseek-ai/dsh-typert-registry/types — the strict
 * host manifest shape registered through `ctx.typert.register`.
 */

/** One method member of a Remote service model. */
export interface TypertMember {
  kind: 'method'
  name: string
  signature: string
}

/** One Remote service model (key = wire namespace). */
export interface TypertServiceModel {
  key: string
  exportName: string
  description: string
  tags: string[]
  members: TypertMember[]
  types: unknown[]
}

/** The full model tree of one manifest. */
export interface TypertModel {
  services: TypertServiceModel[]
  events: unknown[]
  objects: unknown[]
}

/** A host contribution to the strict Typert registry. */
export interface TypertContribution {
  package: string
  face: 'host'
  schemas: unknown[]
  model: TypertModel
  invocations: readonly unknown[]
}