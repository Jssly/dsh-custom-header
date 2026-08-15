/**
 * dsh-custom-header client plugin: the browser half of the settings page.
 *
 * It mounts the `customHeader` Remote namespace (client/remote.ts) and
 * registers one Settings → Plugins "请求头修改 / Custom Header" tab
 * (client/settings-tab.tsx). Saving writes through `customHeader/settingsSet`
 * to the host store — the fetch middlewares read the same state, so new
 * headers apply to the next request, no reload.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { CustomHeaderNamespaceFace } from './face.ts'
import { CUSTOM_HEADER_REMOTE } from './remote.ts'
import { adoptCustomHeaderStyles } from './styles.ts'
import { CustomHeaderSettingsTab } from './settings-tab.tsx'
import { NS, en, zh, type CustomHeaderKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-custom-header section copy. */
    customHeader: CustomHeaderKey
  }
}

/** Required services: Remote mount, slots, locale. */
export const inject = ['remote', 'slots', 'locale']

/** Locale pick for slot labels (module-level by browser language). */
const zhLocale = typeof navigator !== 'undefined'
  ? navigator.language.toLowerCase().startsWith('zh')
  : false
const dict = zhLocale ? zh : en
function t(key: CustomHeaderKey): string {
  const value = dict[key]
  return typeof value === 'string' ? value : key
}

/**
 * Install the settings tab and mount the customHeader Remote namespace.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  adoptCustomHeaderStyles()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-custom-header: dictionaries')

  // Mount the customHeader namespace; resolve the face through the
  // fiber-safe reflect channel (the dotted `ctx.remote.customHeader` read
  // stops at the Loader's internal forks — same caveat as dsh-session-hub).
  let face: CustomHeaderNamespaceFace | undefined
  ctx.effect(async () => {
    const dispose = await ctx.remote.$mount(CUSTOM_HEADER_REMOTE)
    face = (ctx.reflect as unknown as { get(name: string): unknown })
      .get('remote.customHeader') as CustomHeaderNamespaceFace | undefined
    if (face === undefined) {
      throw new Error('dsh-custom-header: the customHeader Remote namespace did not mount')
    }
    return () => {
      face = undefined
      void dispose()
    }
  }, 'dsh-custom-header: remote')

  // Settings → Plugins tab: host-synced custom-header settings. The Plugins
  // section's tab ledger projects this registration automatically
  // (id/order/label from slot options).
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'custom-header',
    order: 7,
    label: () => t('settingsTab'),
    locale: NS,
    inject: (): { face: () => CustomHeaderNamespaceFace | undefined } => ({
      face: () => face,
    }),
  }, CustomHeaderSettingsTab))
}