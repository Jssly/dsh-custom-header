/**
 * Anthropic Messages body patch at the fetch layer.
 *
 * Applies the same injection rules and guard rails as the header injector,
 * but operating on the JSON body of the outgoing request:
 *
 *   - only Anthropic Messages request bodies are touched (must contain both
 *     `messages` and `model`; OpenAI Responses bodies have neither shape
 *     field and must never receive `metadata`/`system` — strict upstreams
 *     like Grok/xAI reject the request with "Argument not supported");
 *   - the `system` slot gains the Claude Code identity (or billing) block
 *     when no Claude Code system signal is present;
 *   - `metadata.user_id` becomes the measured JSON device/session object.
 *
 * Safety: only requests whose resolved profile declares
 * `patchAnthropicBody` (`claude_code_messages`) are patched, and only when
 * the body is parseable JSON we can rewrite (string / Buffer / Uint8Array).
 * A streamed body is passed through untouched.
 */

import type { FetchMiddleware } from "./fetch-pipeline.ts";
import type { ResolvedCustomHeaderConfig } from "./config.ts";
import type { GatewayClientProfileId } from "./types.ts";
import { isAnthropicMessagesUrl, resolveProfileForUrl } from "./profiles.ts";
import {
	CLAUDE_CODE_IDENTITY_SYSTEM,
	claudeCodeBillingSystemBlock,
	getClaudeCodeSessionId,
} from "./profiles.ts";
import { sessionKeyOf } from "./session-context.ts";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stable device fingerprint (process-level). The CLI uses a 64-hex device id. */
const STABLE_DEVICE_ID =
	"1dcf65c37100eb22dea67fe52f799f8e75716d2dfcf1dd5b2acbf07395170f4b";

function buildClaudeCodeUserId(sessionKey?: string): string {
	const sessionId = getClaudeCodeSessionId(sessionKey);
	return JSON.stringify({
		device_id: STABLE_DEVICE_ID,
		account_uuid: "",
		session_id: sessionId,
	});
}

function hasClaudeCodeSystemSignal(system: unknown): boolean {
	if (typeof system === "string") {
		return (
			system.includes("x-anthropic-billing-header") &&
			system.includes("cc_entrypoint=sdk-cli")
		) || system.replace(/\s+/g, " ").includes(CLAUDE_CODE_IDENTITY_SYSTEM);
	}
	if (!Array.isArray(system)) {
		return false;
	}
	for (const entry of system) {
		if (!isRecord(entry)) continue;
		const text = entry.text;
		if (typeof text !== "string" || text === "") continue;
		if (
			text.startsWith("x-anthropic-billing-header") &&
			text.includes("cc_entrypoint=sdk-cli")
		) {
			return true;
		}
		if (text.replace(/\s+/g, " ").includes(CLAUDE_CODE_IDENTITY_SYSTEM)) {
			return true;
		}
	}
	return false;
}

function ensureMetadataUserId(metadata: unknown, sessionKey?: string): JsonRecord {
	if (!isRecord(metadata)) {
		return { user_id: buildClaudeCodeUserId(sessionKey) };
	}
	const userId = metadata.user_id;
	// Measured format: JSON string {"device_id":"...","account_uuid":"","session_id":"..."}
	if (typeof userId === "string" && userId.trim() !== "") {
		return metadata;
	}
	return { ...metadata, user_id: buildClaudeCodeUserId(sessionKey) };
}

/**
 * Pure patch: payload-level, exported for tests. No-op unless the payload
 * is a real Anthropic Messages body.
 */
export function patchAnthropicMessagesPayload(
	payload: unknown,
	mode: "identity" | "billing",
	config: Pick<ResolvedCustomHeaderConfig, "claudeCliVersion">,
	sessionKey?: string,
): unknown {
	if (!isRecord(payload)) {
		return payload;
	}
	// Only true Anthropic Messages bodies (must have messages + model).
	if (!("messages" in payload) || !("model" in payload)) {
		return payload;
	}

	const next: JsonRecord = { ...payload };

	if (!hasClaudeCodeSystemSignal(next.system)) {
		const blockText =
			mode === "billing"
				? claudeCodeBillingSystemBlock(config.claudeCliVersion)
				: CLAUDE_CODE_IDENTITY_SYSTEM;
		const injected = { type: "text", text: blockText };
		if (Array.isArray(next.system)) {
			next.system = [injected, ...next.system];
		} else if (typeof next.system === "string" && next.system.trim() !== "") {
			next.system = [injected, { type: "text", text: next.system }];
		} else {
			next.system = [injected];
		}
	}

	next.metadata = ensureMetadataUserId(next.metadata, sessionKey);

	return next;
}

function urlOf(input: unknown): URL | null {
	try {
		if (typeof input === "string") return new URL(input);
		if (input instanceof URL) return new URL(input);
		if (input instanceof Request) return new URL(input.url);
	} catch {
		// ignore malformed URLs
	}
	return null;
}

function bodyText(
	init: RequestInit | undefined,
	input: Parameters<typeof fetch>[0],
): string | null {
	const body = init?.body ?? (input instanceof Request ? input.body : undefined);
	if (typeof body === "string") return body;
	if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
	if (body instanceof Uint8Array) return new TextDecoder().decode(body);
	if (body && typeof body === "object" && "buffer" in body && (body as { buffer?: unknown }).buffer instanceof ArrayBuffer) {
		return new TextDecoder().decode((body as { buffer: ArrayBuffer }).buffer);
	}
	// ReadableStream / FormData / URLSearchParams: cannot safely re-read.
	return null;
}

/**
 * Middleware — patches the wire body of Anthropic Messages requests when the
 * resolved profile says so. Runs after header injection (Host/UA final),
 * but body and headers are independent here.
 */
export function createBodyPatchMiddleware(
	getContext: () => { profile: GatewayClientProfileId; config: ResolvedCustomHeaderConfig },
): FetchMiddleware {
	return async ({ input, init, next }) => {
		const { profile, config } = getContext();
		if (profile === "off") {
			return next(input, init);
		}
		const url = urlOf(input);
		if (!url || !isAnthropicMessagesUrl({ hostname: url.hostname, pathname: url.pathname })) {
			return next(input, init);
		}

		const resolved = resolveProfileForUrl(
			profile,
			{ hostname: url.hostname, pathname: url.pathname },
			config,
			sessionKeyOf(),
		);
		if (!resolved?.patchAnthropicBody) {
			return next(input, init);
		}

		const text = bodyText(init, input);
		if (text === null) {
			return next(input, init);
		}

		let payload: unknown;
		try {
			payload = JSON.parse(text);
		} catch {
			return next(input, init);
		}

		const patched = patchAnthropicMessagesPayload(
			payload,
			config.claudeSystemMode,
			config,
			sessionKeyOf(),
		);
		if (patched === payload) {
			return next(input, init);
		}

		const nextText = JSON.stringify(patched);
		const headerBag = new Headers(
			init?.headers ?? (input instanceof Request ? input.headers : undefined),
		);
		const base: RequestInit = { ...init };
		// the old content-length no longer matches — drop it, Node recomputes.
		headerBag.delete("content-length");
		return next(input, { ...base, body: nextText, headers: headerBag });
	};
}