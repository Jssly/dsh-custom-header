/**
 * Settings page: the "请求头修改 / Custom Header" tab inside the official
 * Plugins settings section (`settings.plugins.tab` slot, registered in
 * client/index.ts).
 *
 * Loads the resolved settings from the host (`customHeader/settingsGet`),
 * renders a plain HTML form (no primitives dependency), and saves through
 * `customHeader/settingsSet`. Saves apply host-side immediately — the fetch
 * middlewares read the same state object, so no reload is needed.
 */
import { useEffect, useState } from 'react'
import type { CustomHeaderSettingsView } from '../contract.ts'
import type { CustomHeaderNamespaceFace } from './face.ts'
import { en, zh, type CustomHeaderKey } from './locales.ts'

// Locale pick (module-level by browser language).
const zhLocale = typeof navigator !== 'undefined'
  ? navigator.language.toLowerCase().startsWith('zh')
  : false
const dict: Record<string, string> = zhLocale ? zh : en

function t(key: CustomHeaderKey): string {
  return dict[key] ?? key
}

/** Error line builder (locale stores "{message}" placeholder). */
function errText(message: string): string {
  return t('error').replaceAll('{message}', message)
}

/** One-line ↔ array helpers for the autoHosts textarea. */
function lines(value: string[] | undefined): string {
  return Array.isArray(value) ? value.join('\n') : ''
}
function splitLines(value: string): string[] {
  return value.split('\n').map(line => line.trim()).filter(line => line.length > 0)
}

/** Fixed profile ids in menu order (mirrors SELECTABLE_PROFILE_IDS). */
const PROFILE_IDS = [
  'auto',
  'off',
  'codex_official',
  'codex_tui',
  'codex_desktop',
  'codex_claude_plugin',
  'pi_agent',
  'claude_code_messages',
  'opencode_zen',
] as const

/** auto fallback codex presets. */
const AUTO_CODEX_PROFILE_IDS = [
  'codex_official',
  'codex_tui',
  'codex_desktop',
  'codex_claude_plugin',
] as const

/** Local form state, initialized from the loaded host view. */
interface FormState {
  profile: string
  autoCodexProfile: string
  autoHosts: string
  claudeSystemMode: string
  codexVersion: string
  codexDesktopVersion: string
  claudeCliVersion: string
  opencodeVersion: string
  opencodeClient: string
  opencodeProject: string
}

/** Read one string field from a loose settings config. */
function strOf(cfg: Record<string, unknown> | undefined, key: string, fallback: string): string {
  if (cfg === undefined) return fallback
  const v = cfg[key]
  return typeof v === 'string' && v.length > 0 ? v : fallback
}

/** Read autoHosts (string array) from a loose settings config. */
function hostsOf(cfg: Record<string, unknown> | undefined): string[] {
  if (cfg === undefined) return []
  const v = cfg.autoHosts
  return Array.isArray(v) ? v.filter((h): h is string => typeof h === 'string' && h.length > 0) : []
}

/** Form fields of a host view (used to init and to reset). */
function formOf(cfg: Record<string, unknown> | undefined): FormState {
  return {
    profile: strOf(cfg, 'profile', 'auto'),
    autoCodexProfile: strOf(cfg, 'autoCodexProfile', 'codex_official'),
    autoHosts: lines(hostsOf(cfg)),
    claudeSystemMode: strOf(cfg, 'claudeSystemMode', 'identity'),
    codexVersion: strOf(cfg, 'codexVersion', '0.147.0'),
    codexDesktopVersion: strOf(cfg, 'codexDesktopVersion', '1.2026.0628'),
    claudeCliVersion: strOf(cfg, 'claudeCliVersion', '2.1.220'),
    opencodeVersion: strOf(cfg, 'opencodeVersion', '1.18.18'),
    opencodeClient: strOf(cfg, 'opencodeClient', 'cli'),
    opencodeProject: strOf(cfg, 'opencodeProject', 'global'),
  }
}

/** Build the wire patch (only fields that differ from the loaded config). */
function buildPatch(form: FormState, loaded: Record<string, unknown> | null): { patch: Record<string, unknown> } {
  const patch: Record<string, unknown> = {}
  if (loaded === null || form.profile !== strOf(loaded, 'profile', 'auto')) patch.profile = form.profile
  if (loaded === null || form.autoCodexProfile !== strOf(loaded, 'autoCodexProfile', 'codex_official')) patch.autoCodexProfile = form.autoCodexProfile
  const hosts = splitLines(form.autoHosts)
  if (loaded === null || JSON.stringify(hosts) !== JSON.stringify(hostsOf(loaded))) patch.autoHosts = hosts
  if (loaded === null || form.claudeSystemMode !== strOf(loaded, 'claudeSystemMode', 'identity')) patch.claudeSystemMode = form.claudeSystemMode
  if (loaded === null || form.codexVersion !== strOf(loaded, 'codexVersion', '0.147.0')) patch.codexVersion = form.codexVersion
  if (loaded === null || form.codexDesktopVersion !== strOf(loaded, 'codexDesktopVersion', '1.2026.0628')) patch.codexDesktopVersion = form.codexDesktopVersion
  if (loaded === null || form.claudeCliVersion !== strOf(loaded, 'claudeCliVersion', '2.1.220')) patch.claudeCliVersion = form.claudeCliVersion
  if (loaded === null || form.opencodeVersion !== strOf(loaded, 'opencodeVersion', '1.18.18')) patch.opencodeVersion = form.opencodeVersion
  if (loaded === null || form.opencodeClient !== strOf(loaded, 'opencodeClient', 'cli')) patch.opencodeClient = form.opencodeClient
  if (loaded === null || form.opencodeProject !== strOf(loaded, 'opencodeProject', 'global')) patch.opencodeProject = form.opencodeProject
  return { patch }
}

/** Profile label key for a profile id. */
function profileLabelKey(id: string): CustomHeaderKey {
  switch (id) {
    case 'auto': return 'profileAuto'
    case 'off': return 'profileOff'
    case 'codex_official': return 'profileCodexOfficial'
    case 'codex_tui': return 'profileCodexTui'
    case 'codex_desktop': return 'profileCodexDesktop'
    case 'codex_claude_plugin': return 'profileCodexClaudePlugin'
    case 'pi_agent': return 'profilePiAgent'
    case 'claude_code_messages': return 'profileClaudeCodeMessages'
    case 'opencode_zen': return 'profileOpencodeZen'
    default: return 'profileAuto'
  }
}

/** The "请求头修改 / Custom Header" tab inside Settings → Plugins. */
export function CustomHeaderSettingsTab(props: {
  face: () => CustomHeaderNamespaceFace | undefined
}): JSX.Element {
  const face = props.face()
  const [loaded, setLoaded] = useState<CustomHeaderSettingsView | null>(null)
  const [form, setForm] = useState<FormState>(() => formOf(undefined))
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadedConfig = loaded?.config ?? null

  useEffect(() => {
    if (face === undefined) {
      setError(t('loadFailed'))
      return
    }
    let alive = true
    void face.settingsGet({}).then(result => {
      if (!alive) return
      if (result.ok) {
        setLoaded(result.value)
        setForm(formOf(result.value.config))
      } else {
        setError(errText(result.error.message))
      }
    }).catch(() => {
      if (!alive) return
      setError(t('loadFailed'))
    })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [face])

  const save = async (patch: Record<string, unknown>): Promise<boolean> => {
    if (face === undefined || busy) return false
    setBusy(true)
    setError(null)
    setFeedback(null)
    try {
      const result = await face.settingsSet({ patch })
      if (result.ok) {
        setLoaded(result.value)
        setForm(formOf(result.value.config))
        setFeedback(t('saved'))
        return true
      }
      setError(errText(result.error.message))
      return false
    } catch (e) {
      setError(errText(e instanceof Error ? e.message : String(e)))
      return false
    } finally {
      setBusy(false)
    }
  }

  const handleSave = async (): Promise<void> => {
    const patch = buildPatch(form, loadedConfig)
    if (Object.keys(patch).length === 0) {
      setFeedback(t('saved'))
      return
    }
    void save(patch)
  }

  const handleReset = async (): Promise<void> => {
    const defaults = loaded?.defaults
    if (defaults === undefined) return
    // Reset to factory defaults (host re-applies cordis.yml fields over them).
    const patch: Record<string, unknown> = {
      profile: strOf(defaults, 'profile', 'auto'),
      autoCodexProfile: strOf(defaults, 'autoCodexProfile', 'codex_official'),
      autoHosts: hostsOf(defaults),
      claudeSystemMode: strOf(defaults, 'claudeSystemMode', 'identity'),
      codexVersion: strOf(defaults, 'codexVersion', '0.147.0'),
      codexDesktopVersion: strOf(defaults, 'codexDesktopVersion', '1.2026.0628'),
      claudeCliVersion: strOf(defaults, 'claudeCliVersion', '2.1.220'),
      opencodeVersion: strOf(defaults, 'opencodeVersion', '1.18.18'),
      opencodeClient: strOf(defaults, 'opencodeClient', 'cli'),
      opencodeProject: strOf(defaults, 'opencodeProject', 'global'),
    }
    if (await save(patch)) setForm(formOf(defaults))
  }

  const set = (patch: Partial<FormState>): void => {
    setForm(f => ({ ...f, ...patch }))
  }

  const profileLabel = (id: string): string => t(profileLabelKey(id))

  return (
    <div className="dsh-ch-settings">
      <h2 className="dsh-ch-settings-title">{t('title')}</h2>
      <p className="dsh-ch-settings-intro">{t('intro')}</p>

      {error !== null && <div className="dsh-ch-settings-error">{error}</div>}

      {face === undefined
        ? <p className="dsh-ch-settings-muted">{t('loadFailed')}</p>
        : loaded === null && <p className="dsh-ch-settings-muted">{t('loading')}</p>}

      <div className="dsh-ch-card">
        <div className="dsh-ch-row dsh-ch-field">
          <span className="dsh-ch-row-title">{t('profile')}</span>
          <span className="dsh-ch-row-hint">{t('profileHint')}</span>
          <select value={form.profile} disabled={busy}
            onChange={e => set({ profile: e.currentTarget.value })}>
            {PROFILE_IDS.map(id => (
              <option key={id} value={id}>{profileLabel(id)}</option>
            ))}
          </select>
        </div>

        <div className="dsh-ch-row dsh-ch-field">
          <span className="dsh-ch-row-title">{t('autoCodexProfile')}</span>
          <span className="dsh-ch-row-hint">{t('autoCodexProfileHint')}</span>
          <select value={form.autoCodexProfile} disabled={busy}
            onChange={e => set({ autoCodexProfile: e.currentTarget.value })}>
            {AUTO_CODEX_PROFILE_IDS.map(id => (
              <option key={id} value={id}>{profileLabel(id)}</option>
            ))}
          </select>
        </div>

        <label className="dsh-ch-row dsh-ch-field">
          <span className="dsh-ch-row-title">{t('autoHosts')}</span>
          <span className="dsh-ch-row-hint">{t('autoHostsHint')}</span>
          <textarea rows={3} value={form.autoHosts} disabled={busy}
            onChange={e => set({ autoHosts: e.target.value })} />
        </label>

        <div className="dsh-ch-row dsh-ch-field">
          <span className="dsh-ch-row-title">{t('claudeSystemMode')}</span>
          <span className="dsh-ch-row-hint">{t('claudeSystemModeHint')}</span>
          <select value={form.claudeSystemMode} disabled={busy}
            onChange={e => set({ claudeSystemMode: e.currentTarget.value })}>
            <option value="identity">{t('modeIdentity')}</option>
            <option value="billing">{t('modeBilling')}</option>
          </select>
        </div>

        <div className="dsh-ch-row--two">
          <label className="dsh-ch-row dsh-ch-field">
            <span className="dsh-ch-row-title">{t('codexVersion')}</span>
            <input type="text" value={form.codexVersion} disabled={busy}
              onChange={e => set({ codexVersion: e.target.value })} />
          </label>
          <label className="dsh-ch-row dsh-ch-field">
            <span className="dsh-ch-row-title">{t('codexDesktopVersion')}</span>
            <input type="text" value={form.codexDesktopVersion} disabled={busy}
              onChange={e => set({ codexDesktopVersion: e.target.value })} />
          </label>
        </div>

        <div className="dsh-ch-row--two">
          <label className="dsh-ch-row dsh-ch-field">
            <span className="dsh-ch-row-title">{t('claudeCliVersion')}</span>
            <input type="text" value={form.claudeCliVersion} disabled={busy}
              onChange={e => set({ claudeCliVersion: e.target.value })} />
          </label>
          <label className="dsh-ch-row dsh-ch-field">
            <span className="dsh-ch-row-title">{t('opencodeVersion')}</span>
            <input type="text" value={form.opencodeVersion} disabled={busy}
              onChange={e => set({ opencodeVersion: e.target.value })} />
          </label>
        </div>

        <div className="dsh-ch-row--two">
          <label className="dsh-ch-row dsh-ch-field">
            <span className="dsh-ch-row-title">{t('opencodeClient')}</span>
            <input type="text" value={form.opencodeClient} disabled={busy}
              onChange={e => set({ opencodeClient: e.target.value })} />
          </label>
          <label className="dsh-ch-row dsh-ch-field">
            <span className="dsh-ch-row-title">{t('opencodeProject')}</span>
            <input type="text" value={form.opencodeProject} disabled={busy}
              onChange={e => set({ opencodeProject: e.target.value })} />
          </label>
        </div>

        <p className="dsh-ch-row-hint">{t('versionHint')}</p>
      </div>

      <div className="dsh-ch-settings-actions">
        <button type="button" className="dsh-ch-btn primary" disabled={busy || face === undefined}
          onClick={() => { void handleSave() }}>
          {busy ? t('saving') : t('save')}
        </button>
        <button type="button" className="dsh-ch-btn" disabled={busy || loaded === null}
          title={t('resetHint')} onClick={() => { void handleReset() }}>
          {t('reset')}
        </button>
        {feedback !== null && <span className="dsh-ch-settings-result">{feedback}</span>}
      </div>
    </div>
  )
}

export type { CustomHeaderSettingsView }