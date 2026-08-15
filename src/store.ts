/**
 * Persistent store for a runtime profile choice (and future settings UI):
 * JSON file under DSH_HOME/plugins (dsh-custom-header.json), same location
 * the official harness keeps plugin state. Writes are atomic (tmp + rename)
 * and mode 0600 — the file holds hostnames and a profile id, nothing secret,
 * but plugin storage should not be world-readable either.
 *
 * Only the `profile` field persists here; every other field stays in
 * cordis.yml (deployment config) or defaults. Explicit cordis.yml profile
 * wins over the persisted choice (see index.ts).
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { GatewayClientProfileId } from './types.ts'
import { isGatewayClientProfileId } from './types.ts'

interface StoredState {
	readonly version: 1
	readonly profile?: GatewayClientProfileId
}

const STORAGE_VERSION = 1 as const

function readStored(dataFile: string): GatewayClientProfileId | undefined {
	try {
		const raw = JSON.parse(readFileSync(dataFile, 'utf8')) as Partial<StoredState>
		if (raw !== null && typeof raw === 'object' && raw.version === STORAGE_VERSION) {
			const profile = raw.profile
			if (typeof profile === 'string' && isGatewayClientProfileId(profile)) {
				return profile
			}
		}
		return undefined
	} catch {
		return undefined
	}
}

/** Runtime profile choice holder (get / set / persist). */
export class ProfileStore {
	constructor(
		private readonly dataFile: string,
		private profile: GatewayClientProfileId | undefined,
	) {}

	/** The persisted profile choice, if any. */
	read(): GatewayClientProfileId | undefined {
		return this.profile
	}

	/** Persist a new profile choice and return it. */
	set(profile: GatewayClientProfileId): GatewayClientProfileId {
		this.profile = profile
		this.persist()
		return profile
	}

	/** Atomic write (tmp + rename), best-effort: a failed write must not kill a save. */
	private persist(): void {
		try {
			const dir = this.dataFile.slice(0, this.dataFile.lastIndexOf('/'))
			if (dir) mkdirSync(dir, { recursive: true })
			const tmp = `${this.dataFile}.tmp-${process.pid}`
			const stored: StoredState = { version: STORAGE_VERSION, profile: this.profile }
			writeFileSync(tmp, JSON.stringify(stored, null, 2), { mode: 0o600 })
			renameSync(tmp, this.dataFile)
		} catch (error) {
			console.error(`[dsh-custom-header] profile persist failed: ${error instanceof Error ? error.message : String(error)}`)
		}
	}
}

/** Locate the plugin state file under DSH_HOME (defaults to ~/.dsh). */
export function profileStoreFile(): string {
	const base = process.env.DSH_HOME ?? join(homedir(), '.dsh')
	return join(base, 'plugins', 'dsh-custom-header.json')
}

/** Build a store seeded from an existing file (absent/corrupt → undefined). */
export function openProfileStore(dataFile = profileStoreFile()): ProfileStore {
	return new ProfileStore(dataFile, readStored(dataFile))
}