/**
 * Typecheck stubs for @deepseek-ai/dsh-host-apiproxy — the subset of the
 * real apiproxy contract dsh-term-ask uses: the RPC envelope, the
 * PromptContentPart type, and the `sessions.prompt` endpoint the host calls
 * to send the follow-up question.
 */

// ---- rpc layer ----

export type RpcId = string & { readonly __rpcId: unique symbol }
export function RpcId(id: string): RpcId {
  return id as RpcId
}

export interface RpcError {
  readonly code: string
  readonly message: string
  readonly details: object
}

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError }

export interface RpcRequest<P> {
  readonly rpcId: RpcId
  readonly payload: P
}

export type RpcResponse<T> = RpcResult<T>

// ---- sessions domain (prompt only) ----

/** Browser-submitted prompt content part (text only for term-ask). */
export type PromptContentPart = {
  type: 'text'
  text: string
} | {
  type: 'image'
  mediaType: string
  data: string
  name?: string
}

export interface SessionsApi {
  prompt(request: RpcRequest<{
    sessionId: string
    mode: 'queue' | 'steer'
    content: PromptContentPart[]
    clientTimeZone?: string
  }>, signal?: AbortSignal): Promise<RpcResponse<{ accepted: true; command?: { kind: 'success'; text?: string } }>>
}

/** Host-side ApiProxy service face (the `apiProxy` inject). */
export interface ApiProxy {
  readonly sessions: SessionsApi
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly [domain: string]: any
}