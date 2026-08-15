/**
 * Per-agent-request session context propagation.
 *
 * The fetch middleware sees only the request URL, never the DSH
 * `GenerateOptions.sessionId` that names the agent conversation. Real Codex
 * / Claude Code keep session-scoped ids (`x-opencode-session`,
 * `X-Claude-Code-Session-Id`) per conversation, so sharing one process-wide
 * id across concurrent DSH agents would leak identity between sessions.
 *
 * The `llm/stream` waterfall observer runs every iteration of the adapter's
 * stream inside `AsyncLocalStorage.run({ sessionId })`; since adapters issue
 * provider fetches while iterating, those fetches inherit the context, and
 * the fetch middlewares read it back via `getStore()`. Requests outside the
 * LLM seam (model discovery, etc.) have no store and fall back to a
 * process-stable "default" session.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

/** Carries the DSH session key (String(sessionId), '' when absent). */
export const requestSessionContext = new AsyncLocalStorage<string>()

/** Current request's session key for the fetch middlewares. */
export function sessionKeyOf(): string | undefined {
	return requestSessionContext.getStore()
}