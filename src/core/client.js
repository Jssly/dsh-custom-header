/**
 * dsh-profile-selector — 共享核心：Client 半区逻辑（工厂函数，零依赖）
 *
 * 双模式共用：动态模式由 build.mjs 内联进 cordis_define 函数体；
 * 静态模式由 src/static/client.js 以 ESM import 引用。
 *
 * 参数化（双模式隔离的关键）：
 *   opts.slotName   — 槽位名（动态 conversation.input.left / 静态 conversation.input.right）
 *   opts.slotId     — 槽注册 id（动态 dsh-profile-selector / 静态 dsh-profile-selector-static）
 *   opts.rpcPrefix  — RPC method 前缀（动态 dshprofile / 静态 dshprofile-static）
 *   opts.cssPrefix  — CSS 类前缀（动态 dshprofile / 静态 dshprofile-static）
 *   deps.React      — React 引用（动态闭包符号 / 静态 seed word require('react')）
 *   deps.call       — RPC 调用适配器 (method, args) => Promise<业务结果>
 *                     （动态 host.call / 静态 connection.rpc.call 解包 RpcResult）
 *   deps.insertCss  — 样式注入 (css) => void（动态 styles.insert / 静态 DOM style 标签）
 *
 * 关键机制（勿随意改动，详见 README.md「已知坑」）：
 * 1. autoFired Set：每个会话的自动加载只触发一次（防 React 严格模式双挂载重复激活）；
 * 2. 成功反馈只进 select 的 title（tooltip），不渲染行内文字——避免挤动布局导致下拉框错位；
 *    仅错误才渲染红色 .err 行内文字；
 * 3. 选项文案格式「profile-<title>」：title 取档案子项可选 name 字段，缺省回退档案 key
 *    （如 default 有 name:"分析师" → profile-分析师；dev 无 name → profile-dev）；
 *    无空值项，无"系统默认"项。
 */

/** Client 半区 apply 函数体：注册下拉框到指定槽位。 */
export function clientCore(ctx, opts, deps) {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  const React = deps.React
  const call = deps.call
  const insertCss = deps.insertCss
  const css = opts.cssPrefix
  insertCss(
    '.' + css + '-inline{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary);height:26px;}' +
    '.' + css + '-inline select{font-size:11px;padding:1px 4px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;max-width:150px;height:22px;}' +
    '.' + css + '-inline .err{color:var(--dsw-alias-state-error-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:24ch;}'
  )
  // 防重复自动加载（React 严格模式双挂载等场景只触发一次）
  const autoFired = new Set()
  function ProfileSelect(props) {
    const sessionId = props.sessionId
    // 会话 cwd 从客户端会话 store 读取（槽位标准 prop useSessions）：
    // 切换对话时 Host 侧 agent 可能尚未就绪，store 始终可用——显式传给 RPC，
    // 避免 Host 回退到部署级根去读错误的 .deepseek.yaml（README §六-7）
    const useSessions = props.useSessions
    const cwd = typeof useSessions === 'function'
      ? useSessions((s) => (sessionId ? s.byId[sessionId]?.cwd : undefined))
      : undefined
    const [profiles, setProfiles] = React.useState(null)
    const [active, setActive] = React.useState(null)
    const [tip, setTip] = React.useState(null)
    const [fatal, setFatal] = React.useState(null)
    const [error, setError] = React.useState(null)
    React.useEffect(() => {
      let alive = true
      call(opts.rpcPrefix + '.profiles', { sessionId, cwd }).then((r) => {
        if (!alive) return
        if (r && Array.isArray(r.profiles)) setProfiles(r.profiles)
        if (r && r.error) setFatal(String(r.error))
        if (r && Array.isArray(r.profiles) && r.profiles.length === 0 && !r.error) setFatal('未找到 .deepseek.yaml 的 system_prompts')
      }).catch((err) => {
        if (alive) { setProfiles([]); setFatal('RPC 失败: ' + String((err && err.message) || err)) }
      })
      call(opts.rpcPrefix + '.state', { sessionId }).then((r) => {
        if (alive && r) setActive(r.active || null)
      }).catch(() => {})
      return () => { alive = false }
    }, [sessionId, cwd])
    // 无显式选择时默认加载 default 档案（每个会话只自动触发一次）
    React.useEffect(() => {
      if (!profiles || profiles.length === 0 || active !== null || autoFired.has(sessionId)) return
      autoFired.add(sessionId)
      const name = profiles.some((p) => p.name === 'default') ? 'default' : profiles[0].name
      call(opts.rpcPrefix + '.activate', { sessionId, profile: name, cwd }).then((r) => {
        if (r && r.ok) {
          setActive(r.profile)
          setTip((r.pending ? '已排队(会话激活后生效): ' : '默认加载: ') + r.profile + (r.temperature != null ? ' · temp ' + r.temperature : ''))
        } else if (r && r.error) {
          setError(String(r.error))
        }
      }).catch(() => {})
    }, [profiles, active, sessionId, cwd])
    const onChange = (e) => {
      const name = e.target.value || null
      setError(null)
      if (!name) return
      call(opts.rpcPrefix + '.activate', { sessionId, profile: name, cwd }).then((r) => {
        if (r && r.ok) {
          setActive(r.profile)
          setTip((r.pending ? '已排队(会话激活后生效): ' : '已切换: ') + r.profile + (r.temperature != null ? ' · temp ' + r.temperature : ''))
          setError(null)
        } else {
          setError((r && r.error) || '切换失败')
        }
      }).catch((err) => setError('失败: ' + String((err && err.message) || err)))
    }
    if (profiles === null) return React.createElement('span', null, 'profile…')
    if (fatal) return React.createElement('span', { className: 'err', title: String(fatal) }, 'profile:' + String(fatal))
    if (profiles.length === 0) return React.createElement('span', { title: '未找到 .deepseek.yaml 的 system_prompts 配置' }, 'profile:—')
    // 仅一个档案：无需选择，不出下拉框，静态展示档案名（自动加载逻辑仍生效）
    if (profiles.length === 1) {
      const only = profiles[0]
      const shownKey = active || only.name
      const shownTitle = only.title || shownKey
      const temp = only.parameters && only.parameters.temperature != null ? only.parameters.temperature : null
      return React.createElement('span', { className: css + '-inline' },
        React.createElement('span', {
          title: error || tip || 'profile-' + shownTitle + (temp != null ? ' · temperature ' + temp : ''),
        }, 'profile-' + shownTitle),
        error ? React.createElement('span', { className: 'err', title: error }, error) : null
      )
    }
    const shown = active || (profiles.some((p) => p.name === 'default') ? 'default' : profiles[0].name)
    const shownProfile = profiles.find((p) => p.name === shown)
    const shownTitle = shownProfile ? (shownProfile.title || shown) : shown
    return React.createElement('span', null,
      React.createElement('select', {
        value: shown,
        onChange,
        title: error || tip || (shownProfile && shownProfile.parameters && shownProfile.parameters.temperature != null
          ? 'profile-' + shownTitle + ' · temperature ' + shownProfile.parameters.temperature
          : '切换 .deepseek.yaml profile'),
      },
        profiles.map((p) => React.createElement('option', { key: p.name, value: p.name }, 'profile-' + (p.title || p.name)))
      ),
      error ? React.createElement('span', { className: 'err', title: error }, error) : null
    )
  }
  // 位置：由 opts 决定（动态=输入卡片工具行左侧；静态=工具行右侧、发送键前）
  slots.inject(opts.slotName, () => slots.register(
    { name: opts.slotName, id: opts.slotId, order: 0, label: () => 'profile' },
    (props) => React.createElement('div', { className: css + '-inline' }, React.createElement(ProfileSelect, { sessionId: props.sessionId, useSessions: props.useSessions }))
  ))
}