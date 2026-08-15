/**
 * Plugin configuration: cordis.yml `dsh-custom-header:` section as the
 * schema, `normalizeCustomHeaderConfig()` as the single sanitizer.
 *
 * DSH-style: the schema lives on
 * the plugin (schemastery), the deployment config lives in cordis.yml, and
 * a runtime profile choice (future settings UI) persists under
 * `$DSH_HOME/plugins/dsh-custom-header.json` via {@link ConfigStore}.
 */
import z from '@deepseek-ai/schemastery'
import { DEFAULT_ANTHROPIC_BETA, DEFAULT_CLAUDE_CLI_VERSION, DEFAULT_CODEX_CLI_VERSION, DEFAULT_CODEX_DESKTOP_VERSION, DEFAULT_OPENCODE_VERSION } from './defaults.ts'
import type { AutoCodexProfileId, GatewayClientProfileId } from './types.ts'
import { isAutoCodexProfileId, isGatewayClientProfileId } from './types.ts'
import type { UrlRewriteTarget } from './url-rewrite.ts'

/** Deployment configuration. Every field optional; defaults fill the rest. */
export interface CustomHeaderConfig {
	profile?: GatewayClientProfileId;
	autoHosts?: string[];
	claudeSystemMode?: 'identity' | 'billing';
	/** Override claude-cli/x.y.z in claude_code_messages (default 2.1.220). */
	claudeCliVersion?: string;
	/** Override anthropic-beta header for the Claude profile. */
	anthropicBeta?: string;
	/** Override opencode/x.y.z in opencode_zen (default 1.18.18). */
	opencodeVersion?: string;
	/** Override codex_cli_rs/x.y.z in codex_official (default latest measured: 0.147.0). */
	codexVersion?: string;
	/** Override codex_app/x.y.z in codex_desktop (desktop is closed-source; keep the measured value). */
	codexDesktopVersion?: string;
	/** x-opencode-client value (default "cli"; opencode ACP mode uses "acp"). */
	opencodeClient?: string;
	/** x-opencode-project value (default "global", the measured no-project value). */
	opencodeProject?: string;
	/** Merged after profile headers (all profiles). */
	extraHeaders?: Record<string, string>;
	/** auto profile: Codex path when a host matches (default codex_official). */
	autoCodexProfile?: AutoCodexProfileId;
	/**
	 * URL rewrite rules (fetch layer): key = pathname (trailing "*" = prefix
	 * match), value = new pathname string, or { path?, appendQuery? }.
	 * Only hosts listed in autoHosts are ever rewritten (empty autoHosts =
	 * no rewriting). Example: "/v1/messages": { "appendQuery": "beta=true" }.
	 */
	urlRewrites?: Record<string, string | UrlRewriteTarget>;
	/**
	 * Persist a runtime profile choice to $DSH_HOME/plugins/
	 * dsh-custom-header.json. The persisted file wins over a cordis.yml
	 * `profile` only when cordis did not explicitly set one (explicit config
	 * wins over persisted state).
	 */
	persistProfile?: boolean;
}

/** Every field resolved. */
export interface ResolvedCustomHeaderConfig {
	profile: GatewayClientProfileId;
	autoHosts: string[];
	claudeSystemMode: 'identity' | 'billing';
	claudeCliVersion: string;
	codexVersion: string;
	codexDesktopVersion: string;
	anthropicBeta: string;
	opencodeVersion: string;
	opencodeClient: string;
	opencodeProject: string;
	extraHeaders: Record<string, string>;
	autoCodexProfile: AutoCodexProfileId;
	urlRewrites: Record<string, string | UrlRewriteTarget>;
	persistProfile: boolean;
}

export const CUSTOM_HEADER_DEFAULTS: ResolvedCustomHeaderConfig = {
	profile: 'auto',
	autoHosts: [],
	claudeSystemMode: 'identity',
	claudeCliVersion: DEFAULT_CLAUDE_CLI_VERSION,
	codexVersion: DEFAULT_CODEX_CLI_VERSION,
	codexDesktopVersion: DEFAULT_CODEX_DESKTOP_VERSION,
	anthropicBeta: DEFAULT_ANTHROPIC_BETA,
	opencodeVersion: DEFAULT_OPENCODE_VERSION,
	opencodeClient: 'cli',
	opencodeProject: 'global',
	extraHeaders: {},
	autoCodexProfile: 'codex_official',
	urlRewrites: {},
	persistProfile: true,
}

const BILLING_MODES: readonly ResolvedCustomHeaderConfig['claudeSystemMode'][] = ['identity', 'billing']

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cleanStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return []
	const out: string[] = []
	for (const entry of value) {
		if (typeof entry !== 'string') continue
		const trimmed = entry.trim()
		if (trimmed.length === 0) continue
		out.push(trimmed)
	}
	return out
}

function cleanHeaders(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {}
	const out: Record<string, string> = {}
	for (const [key, val] of Object.entries(value)) {
		if (typeof val === 'string') out[key] = val
	}
	return out
}

function cleanUrlRewrites(value: unknown): Record<string, string | UrlRewriteTarget> {
	if (!isRecord(value)) return {}
	const out: Record<string, string | UrlRewriteTarget> = {}
	for (const [key, val] of Object.entries(value)) {
		if (typeof key !== 'string' || key.length === 0) continue
		if (typeof val === 'string' && val.length > 0) {
			out[key] = val
		} else if (isRecord(val)) {
			const target: { path?: string; appendQuery?: string } = {}
			if (typeof val.path === 'string' && val.path.length > 0) target.path = val.path
			if (typeof val.appendQuery === 'string' && val.appendQuery.length > 0) target.appendQuery = val.appendQuery
			if (Object.keys(target).length > 0) out[key] = target
		}
	}
	return out
}

function mergeRaw(
	base: ResolvedCustomHeaderConfig,
	raw: Record<string, unknown>,
): ResolvedCustomHeaderConfig {
	const next: ResolvedCustomHeaderConfig = { ...base }
	if (typeof raw.profile === 'string' && isGatewayClientProfileId(raw.profile)) {
		next.profile = raw.profile
	}
	if (raw.autoHosts !== undefined) {
		next.autoHosts = cleanStringList(raw.autoHosts)
	}
	if (raw.claudeSystemMode === 'identity' || raw.claudeSystemMode === 'billing') {
		next.claudeSystemMode = raw.claudeSystemMode
	}
	if (typeof raw.claudeCliVersion === 'string' && raw.claudeCliVersion.trim()) {
		next.claudeCliVersion = raw.claudeCliVersion.trim()
	}
	if (typeof raw.codexVersion === 'string' && raw.codexVersion.trim()) {
		next.codexVersion = raw.codexVersion.trim()
	}
	if (typeof raw.codexDesktopVersion === 'string' && raw.codexDesktopVersion.trim()) {
		next.codexDesktopVersion = raw.codexDesktopVersion.trim()
	}
	if (typeof raw.anthropicBeta === 'string' && raw.anthropicBeta.trim()) {
		next.anthropicBeta = raw.anthropicBeta.trim()
	}
	if (typeof raw.opencodeVersion === 'string' && raw.opencodeVersion.trim()) {
		next.opencodeVersion = raw.opencodeVersion.trim()
	}
	if (typeof raw.opencodeClient === 'string' && raw.opencodeClient.trim()) {
		next.opencodeClient = raw.opencodeClient.trim()
	}
	if (typeof raw.opencodeProject === 'string' && raw.opencodeProject.trim()) {
		next.opencodeProject = raw.opencodeProject.trim()
	}
	if (raw.extraHeaders !== undefined) {
		next.extraHeaders = { ...base.extraHeaders, ...cleanHeaders(raw.extraHeaders) }
	}
	if (typeof raw.autoCodexProfile === 'string' && isAutoCodexProfileId(raw.autoCodexProfile)) {
		next.autoCodexProfile = raw.autoCodexProfile
	}
	if (raw.urlRewrites !== undefined) {
		next.urlRewrites = cleanUrlRewrites(raw.urlRewrites)
	}
	if (typeof raw.persistProfile === 'boolean') {
		next.persistProfile = raw.persistProfile
	}
	return next
}

/**
 * The single sanitizer: arbitrary input (cordis.yml seed, persisted JSON,
 * future wire patches) → fully resolved config.
 *
 * Precedence: `base` (already-merged cordis seed) first, then `overlay` —
 * callers decide the file/cordis order by choosing what they pass as base.
 * Unknown keys are dropped; bad values fall back to their defaults.
 */
export function normalizeCustomHeaderConfig(
	raw: Record<string, unknown>,
	base: ResolvedCustomHeaderConfig = { ...CUSTOM_HEADER_DEFAULTS },
): ResolvedCustomHeaderConfig {
	let next = mergeRaw({ ...base }, raw)

	// claudeSystemMode must be one of the two documented values.
	if (!BILLING_MODES.includes(next.claudeSystemMode)) {
		next.claudeSystemMode = 'identity'
	}
	return next
}

/**
 * Explicit cordis.yml profile? (the persisted-store override must not mask a
 * deliberate deployment choice — explicit config must win over the
 * persisted store).
 */
export function hasExplicitCordisProfile(raw: Record<string, unknown> | undefined): boolean {
	if (!raw || !isRecord(raw)) return false
	return typeof raw.profile === 'string' && isGatewayClientProfileId(raw.profile)
}

/** schemastery schema mirror of {@link CustomHeaderConfig} (inferred type used by the loader). */
export const ConfigSchema = z.object({
	profile: z.string().default('auto'),
	autoHosts: z.array(z.string()).default([]),
	claudeSystemMode: z.string().default('identity'),
	claudeCliVersion: z.string().default(DEFAULT_CLAUDE_CLI_VERSION),
	codexVersion: z.string().default(DEFAULT_CODEX_CLI_VERSION),
	codexDesktopVersion: z.string().default(DEFAULT_CODEX_DESKTOP_VERSION),
	anthropicBeta: z.string().default(DEFAULT_ANTHROPIC_BETA),
	opencodeVersion: z.string().default(DEFAULT_OPENCODE_VERSION),
	opencodeClient: z.string().default('cli'),
	opencodeProject: z.string().default('global'),
	extraHeaders: z.dict(z.string()).default({}),
	autoCodexProfile: z.string().default('codex_official'),
	urlRewrites: z
		.dict(
			z.union([
				z.string(),
				z.object({
					path: z.string(),
					appendQuery: z.string(),
				}),
			]),
		)
		.default({}),
	persistProfile: z.boolean().default(true),
})

export type ConfigType = Partial<CustomHeaderConfig>