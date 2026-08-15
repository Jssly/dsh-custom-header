/**
 * URL rewriting via the shared fetch pipeline.
 *
 * Why the fetch layer: the DSH LLM seam (`GenerateOptions`) exposes no
 * request URL — adapters build it inside the
 * SDK. The only way to rewrite the path / append a query is one layer below
 * the SDK, at fetch time.
 *
 * Safety: rewrites apply ONLY when
 *   1. the request hostname is listed in config.autoHosts, and
 *   2. the pathname matches a configured urlRewrites rule, and
 *   3. the profile is not "off".
 * Everything else passes through untouched.
 */

import type { FetchMiddleware } from "./fetch-pipeline.ts";

export type UrlRewriteTarget =
	| string // new pathname (e.g. "/v1/messages")
	| {
			/** Replace the request pathname with this value. */
			path?: string;
			/** Raw query string appended to the existing query (e.g. "beta=true"). */
			appendQuery?: string;
	  };

export interface UrlRewriteContext {
	/** Only hosts listed here may be rewritten (from config.autoHosts). */
	hosts: string[];
	/** pathname exact match, or prefix match when the key ends with "*". */
	rewrites: Record<string, UrlRewriteTarget>;
	/** Set to false when the profile is "off" — disables all rewriting. */
	enabled: boolean;
}

interface AppliedRule {
	path?: string;
	appendQuery?: string;
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

function matchRule(
	pathname: string,
	rewrites: Record<string, UrlRewriteTarget>,
): AppliedRule | null {
	for (const [pattern, target] of Object.entries(rewrites)) {
		const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : null;
		const matches = prefix !== null ? pathname.startsWith(prefix) : pathname === pattern;
		if (!matches) continue;

		if (typeof target === "string") {
			return { path: target };
		}
		return {
			path: typeof target.path === "string" && target.path ? target.path : undefined,
			appendQuery:
				typeof target.appendQuery === "string" && target.appendQuery
					? target.appendQuery
					: undefined,
		};
	}
	return null;
}

function applyRule(url: URL, rule: AppliedRule): URL {
	const next = new URL(url);
	if (rule.path) {
		next.pathname = rule.path;
	}
	if (rule.appendQuery) {
		next.search = next.search
			? `${next.search}&${rule.appendQuery}`
			: `?${rule.appendQuery}`;
	}
	return next;
}

export function rewriteUrlIfNeeded(
	input: Parameters<typeof fetch>[0],
	ctx: UrlRewriteContext,
): Parameters<typeof fetch>[0] {
	if (!ctx.enabled) return input;
	if (ctx.hosts.length === 0) return input;
	const url = urlOf(input);
	if (!url) return input;
	if (!ctx.hosts.includes(url.hostname)) return input;

	const rule = matchRule(url.pathname, ctx.rewrites);
	if (!rule) return input;

	const next = applyRule(url, rule);
	if (typeof input === "string") return next.toString();
	if (input instanceof URL) return next;
	return new Request(next.toString(), input);
}

/** Middleware factory — reads the context fresh on every request. */
export function createUrlRewriteMiddleware(
	getContext: () => UrlRewriteContext,
): FetchMiddleware {
	return async ({ input, init, next }) => {
		const rewritten = rewriteUrlIfNeeded(input, getContext());
		return next(rewritten, init);
	};
}