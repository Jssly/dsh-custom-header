/**
 * Heuristics for HTTP 403 responses surfaced through the LLM stream.
 *
 * DSH normalizes provider failures into a terminal `finish` chunk whose
 * `failure` carries the HTTP status when available. We use that status to
 * distinguish Cloudflare edge blocks (HTML, not fixable with client headers)
 * from gateway client-restriction JSON (fixable by switching profile).
 */

const CF_MARKERS = [
	"cloudflare",
	"cf-error",
	"attention required",
	"you have been blocked",
	"cdn-cgi",
	"cf-ray",
] as const;

export function looksLikeCloudflareBlock(text: string): boolean {
	const lower = text.toLowerCase();
	if (!lower.includes("<!doctype html") && !lower.includes("<html")) {
		return false;
	}
	return CF_MARKERS.some((m) => lower.includes(m));
}

export function looksLikeClientRestrictionJson(text: string): boolean {
	const lower = text.toLowerCase();
	return (
		lower.includes("client_restriction") ||
		lower.includes("claude_code_only") ||
		lower.includes("codex_cli_only") ||
		lower.includes("client restriction")
	);
}

export function format403Hint(options: {
	message?: string;
	profile?: string;
}): string {
	const { message, profile } = options;
	if (message && looksLikeCloudflareBlock(message)) {
		return [
			"detected a Cloudflare edge block (HTML), not a gateway client_restriction.",
			"Client headers do not affect TLS/Bot rules; switch API endpoint, ask the admin to allowlist, or use a local forward proxy.",
		].join(" ");
	}
	if (message && looksLikeClientRestrictionJson(message)) {
		return `gateway client check failed (profile ${profile ?? "auto"}): try codex_desktop (Desktop) or codex_official / claude_code_messages.`;
	}
	return "403: if the body is HTML it is Cloudflare; if JSON, switch the dsh-custom-header profile (recommended: codex_desktop).";
}