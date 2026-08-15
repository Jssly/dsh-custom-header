/**
 * Typecheck stubs for @deepseek-ai/dsh-llm — the subset of the real LLM
 * seam surface dsh-custom-header uses: the llm/stream event signature and
 * the stream chunk shape. Declarations only; never shipped. The real
 * package provides the full vocabulary at load time.
 */

/** Adapter iteration options (the sessionId scopes our session ids). */
export interface GenerateOptions {
  sessionId?: string | number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

/** One normalized stream chunk emitted by an adapter iteration. */
export interface StreamChunk {
  type: string
  text?: string
  reason: {
    kind: string
    failure?: { status?: number; message?: string }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Emitted once per adapter stream; wrap the iterator to observe chunks. */
    on(
      event: 'llm/stream',
      listener: (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => void,
    ): void
  }
}