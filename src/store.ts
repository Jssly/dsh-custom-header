/**
 * Persistent settings store: the plugin's settings live in a JSON file
 * under DSH_HOME/plugins (dsh-custom-header.json), the same place the
 * official harness keeps plugin state. Writes are atomic (tmp + rename)
 * and mode 0600 — the file holds hostnames and profile ids, nothing secret,
 * but plugin storage should not be world-readable either.
 *
 * Precedence: persisted file fields > cordis.yml seed fields > factory
 * defaults. An explicitly set cordis.yml `profile` still wins over the
 * persisted profile (deployment intent beats a saved UI selection), applied
 * by the plugin body after this store resolves.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { ResolvedCustomHeaderConfig } from './config.ts'
import { normalizeCustomHeaderConfig } from './config.ts'
import { CUSTOM_HEADER_SETTINGS_DEFAULTS } from './settings.ts'

interface StoredSettings {
  readonly version: 2
  readonly settings: ResolvedCustomHeaderConfig
}

const STORAGE_VERSION = 2 as const

/** Default data file: $DSH_HOME/plugins/dsh-custom-header.json. */
export function settingsStoreFile(): string {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(dshHome, 'plugins', 'dsh-custom-header.json')
}

/** Read the persisted settings file; null when absent/corrupt. */
function readStored(dataFile: string): Partial<ResolvedCustomHeaderConfig> | null {
  try {
    const raw = JSON.parse(readFileSync(dataFile, 'utf8')) as Partial<StoredSettings>
    if (
      raw !== null && typeof raw === 'object' && raw.version === STORAGE_VERSION &&
      typeof raw.settings === 'object' && raw.settings !== null
    ) {
      return raw.settings as Partial<ResolvedCustomHeaderConfig>
    }
    return null
  } catch {
    return null
  }
}

/** The plugin's runtime settings holder (get / update / persist). */
export class SettingsStore {
  private config: ResolvedCustomHeaderConfig

  /**
   * @param dataFile - where settings persist.
   * @param seed - cordis.yml seed (used per-field when the file has no value).
   * @param defaults - factory defaults (reset target).
   */
  constructor(
    private readonly dataFile: string,
    seed: Partial<ResolvedCustomHeaderConfig>,
    private readonly defaults: ResolvedCustomHeaderConfig = CUSTOM_HEADER_SETTINGS_DEFAULTS,
  ) {
    this.config = normalizeCustomHeaderConfig({
      ...defaults,
      ...seed,
      ...(readStored(dataFile) ?? {}),
    })
  }

  /** Current resolved settings. */
  get(): ResolvedCustomHeaderConfig {
    return this.config
  }

  /** View: current config + defaults (what the settings tab renders). */
  view(): { config: ResolvedCustomHeaderConfig; defaults: ResolvedCustomHeaderConfig } {
    return {
      config: { ...this.config },
      defaults: { ...this.defaults },
    }
  }

  /**
   * Merge a partial patch into the current settings, persist, and return the
   * fresh view. Invalid values are sanitized by normalizeCustomHeaderConfig
   * (never throws for bad input).
   */
  update(patch: Record<string, unknown>): { config: ResolvedCustomHeaderConfig; defaults: ResolvedCustomHeaderConfig } {
    this.config = normalizeCustomHeaderConfig({ ...this.config, ...patch })
    this.persist()
    return this.view()
  }

  /** Atomic write (tmp + rename), best-effort: a failed write must not kill a save. */
  private persist(): void {
    try {
      const dir = dirname(this.dataFile)
      mkdirSync(dir, { recursive: true })
      const tmp = `${this.dataFile}.tmp-${process.pid}`
      const stored: StoredSettings = { version: STORAGE_VERSION, settings: this.config }
      writeFileSync(tmp, JSON.stringify(stored, null, 2), { mode: 0o600 })
      renameSync(tmp, this.dataFile)
    } catch (error) {
      console.error(`[dsh-custom-header] settings persist failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** Open the store for the default data file location. */
export function openSettingsStore(dataFile = settingsStoreFile()): SettingsStore {
  return new SettingsStore(dataFile, {})
}