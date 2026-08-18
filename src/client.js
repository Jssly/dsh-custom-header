/**
 * dshy-1 (yaml-profile-selector) — Client 半区源码
 *
 * 当前版本：pkg-12（2026-08-18，run-10 激活成功）
 * 说明：本文件是 DSH 动态 Cordis 插件 dshy-1 的 Client 半区源码快照，
 *       与运行中的 pkg-12 完全一致。开发文档见同目录 README.md。
 *
 * 功能：在输入卡片工具行（权限选择器右侧、输入框下方）渲染「提示词-<档案名>」
 *       下拉框；新会话自动加载 default 档案；切换经 host.call('dshyaml.activate')。
 *
 * 关键机制（勿随意改动，详见 README.md「已知坑」）：
 * 1. autoFired Set：每个会话的自动加载只触发一次（防 React 严格模式双挂载重复激活）；
 * 2. 成功反馈只进 select 的 title（tooltip），不渲染行内文字——避免挤动布局导致下拉框错位；
 *    仅错误才渲染红色 .err 行内文字；
 * 3. 选项文案格式「提示词-<name>」（无空值项，无"系统默认"项）。
 */
return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    styles.insert(
      '.dshyaml-inline{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary);height:26px;}' +
      '.dshyaml-inline select{font-size:11px;padding:1px 4px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;max-width:150px;height:22px;}' +
      '.dshyaml-inline .err{color:var(--dsw-alias-state-error-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:24ch;}'
    )
    // 防重复自动加载（React 严格模式双挂载等场景只触发一次）
    const autoFired = new Set()
    function ProfileSelect(props) {
      const sessionId = props.sessionId
      const [profiles, setProfiles] = React.useState(null)
      const [active, setActive] = React.useState(null)
      const [tip, setTip] = React.useState(null)
      const [fatal, setFatal] = React.useState(null)
      const [error, setError] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        host.call('dshyaml.profiles', { sessionId }).then((r) => {
          if (!alive) return
          if (r && Array.isArray(r.profiles)) setProfiles(r.profiles)
          if (r && r.error) setFatal(String(r.error))
          if (r && Array.isArray(r.profiles) && r.profiles.length === 0 && !r.error) setFatal('未找到 .deepseek.yaml 的 system_prompts')
        }).catch((err) => {
          if (alive) { setProfiles([]); setFatal('RPC 失败: ' + String((err && err.message) || err)) }
        })
        host.call('dshyaml.state', { sessionId }).then((r) => {
          if (alive && r) setActive(r.active || null)
        }).catch(() => {})
        return () => { alive = false }
      }, [sessionId])
      // 无显式选择时默认加载 default 档案（每个会话只自动触发一次）
      React.useEffect(() => {
        if (!profiles || profiles.length === 0 || active !== null || autoFired.has(sessionId)) return
        autoFired.add(sessionId)
        const name = profiles.some((p) => p.name === 'default') ? 'default' : profiles[0].name
        host.call('dshyaml.activate', { sessionId, profile: name }).then((r) => {
          if (r && r.ok) {
            setActive(r.profile)
            setTip('默认加载: ' + r.profile + (r.temperature != null ? ' · temp ' + r.temperature : ''))
          } else if (r && r.error) {
            setError(String(r.error))
          }
        }).catch(() => {})
      }, [profiles, active, sessionId])
      const onChange = (e) => {
        const name = e.target.value || null
        setError(null)
        if (!name) return
        host.call('dshyaml.activate', { sessionId, profile: name }).then((r) => {
          if (r && r.ok) {
            setActive(r.profile)
            setTip('已切换: ' + r.profile + (r.temperature != null ? ' · temp ' + r.temperature : ''))
            setError(null)
          } else {
            setError((r && r.error) || '切换失败')
          }
        }).catch((err) => setError('失败: ' + String((err && err.message) || err)))
      }
      if (profiles === null) return React.createElement('span', null, '提示词…')
      if (fatal) return React.createElement('span', { className: 'err', title: String(fatal) }, '提示词:' + String(fatal))
      if (profiles.length === 0) return React.createElement('span', { title: '未找到 .deepseek.yaml 的 system_prompts 配置' }, '提示词:—')
      const shown = active || (profiles.some((p) => p.name === 'default') ? 'default' : profiles[0].name)
      const shownProfile = profiles.find((p) => p.name === shown)
      return React.createElement('span', null,
        React.createElement('select', {
          value: shown,
          onChange,
          title: error || tip || (shownProfile && shownProfile.parameters && shownProfile.parameters.temperature != null
            ? '提示词档案 · temperature ' + shownProfile.parameters.temperature
            : '切换 .deepseek.yaml 提示词档案'),
        },
          profiles.map((p) => React.createElement('option', { key: p.name, value: p.name }, '提示词-' + p.name))
        ),
        error ? React.createElement('span', { className: 'err', title: error }, error) : null
      )
    }
    // 位置：输入卡片工具行内、权限选择器右侧（输入框下方）
    slots.inject('conversation.input.left', () => slots.register(
      { name: 'conversation.input.left', id: 'dsh-yaml-profile', order: 0, label: () => '提示词档案' },
      (props) => React.createElement('div', { className: 'dshyaml-inline' }, React.createElement(ProfileSelect, { sessionId: props.sessionId }))
    ))
  },
}