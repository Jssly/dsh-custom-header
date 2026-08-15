/**
 * Typecheck stubs for @deepseek-ai/cordis — the subset of the real Cordis
 * surface dsh-term-ask uses. Declarations only; never shipped.
 */

export interface Context {
  /** Service store resolution (the client reads mounted namespaces here). */
  readonly reflect: { get(name: string): unknown }
  /** Resolve a provided service by name. */
  get<K extends string>(name: K): unknown
  /** Register a lifecycle effect; returns the disposer or void. */
  effect(fn: () => void | Promise<void> | (() => void) | Promise<(() => void)>, label?: string): void
  /** Inject-dependent async setup. */
  inject(deps: readonly string[], fn: (ctx: Context) => void | (() => void)): void
  /** Emit an event on this context. */
  emit(event: string, ...args: unknown[]): void
  /** Loose remainder (typert, remote, sessions, slots, ... are accessed as any). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

/** Base class for services (Service-name style plugins). */
export class Service {
  readonly ctx: Context
  constructor(ctx: Context, name: string) {
    this.ctx = ctx
    void name
  }
}