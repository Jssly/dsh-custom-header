/**
 * dsh-profile-selector — 动态模式 Client 壳（开发用）
 *
 * 本文件是 cordis_define 的函数体模板：build.mjs 会把 src/core/client.js 与
 * src/core/settings-client.js 的源码（去掉 export / import 关键字）内联到
 * /*__CORE_CLIENT__*\/ 与 /*__CORE_SETTINGS_CLIENT__*\/ 占位符处，生成
 * dist/dynamic/client.js 供 cordis_define 使用。请勿直接编辑 dist/dynamic/*.js。
 *
 * 两个核心各自注册一块 UI（互不依赖）：
 *   clientCore         → 输入区下拉框（conversation.input.left）
 *   settingsClientCore → 设置面板的「提示词档案」页（settings.section）
 * 槽 id / RPC 前缀 / CSS 前缀都按动态模式的取值传（与静态模式隔离，见 internals.md）。
 */
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
 * 关键机制（勿随意改动，详见 internals.md）：
 * 1. autoFired Set：每个会话的自动加载只触发一次（防 React 严格模式双挂载重复激活）；
 * 2. 成功反馈只进 select 的 title（tooltip），不渲染行内文字——避免挤动布局导致下拉框错位；
 *    加载失败（如工作区没有 .deepseek.yaml）时不渲染下拉框（return null，不报红字）；
 *    仅切换失败才渲染红色 .err 行内文字；
 * 3. 选项文案格式「profile-<title>」：title 取档案子项可选 name 字段，缺省回退档案 key
 *    （如 default 有 name:"分析师" → profile-分析师；dev 无 name → profile-dev）；
 *    无空值项，无"系统默认"项；
 * 4. 子代理会话（session summary.origin === 'subagent'）：客户端**不**自动加载档案
 *    （Host 侧在 agent/created 时继承父会话档案注入，见 host.js internals.md），只在 tooltip
 *    标注来源；profile RPC 成功时清除 fatal——首帧 cwd 未就绪的临时错误不得永久抑制下拉框。
 */

/** Client 半区 apply 函数体：注册下拉框到指定槽位。 */
function clientCore(ctx, opts, deps) {
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
    // 避免 Host 回退到部署级根去读错误的 .deepseek.yaml（internals.md）
    const useSessions = props.useSessions
    const summary = typeof useSessions === 'function'
      ? useSessions((s) => (sessionId ? s.byId[sessionId] : undefined))
      : undefined
    const cwd = summary ? summary.cwd : undefined
    const summaryKnown = summary !== undefined
    // 子代理会话（DSH session summary.origin === 'subagent'）：档案由 Host 侧在
    // agent/created 时继承父会话注入（internals.md），客户端**不**自动加载——
    // 子代理多半不驻留，自动 activate 只会撞上「未激活」竞态并误报红字。
    const isSubagent = !!(summary && summary.origin === 'subagent')
    const [profiles, setProfiles] = React.useState(null)
    const [active, setActive] = React.useState(null)
    // 工作区级开场白覆盖（.deepseek.yaml → workspace.global_prompt）：仅用于 tooltip 提示
    const [gp, setGp] = React.useState(null)
    const [tip, setTip] = React.useState(null)
    const [fatal, setFatal] = React.useState(null)
    const [error, setError] = React.useState(null)
    React.useEffect(() => {
      let alive = true
      call(opts.rpcPrefix + '.profiles', { sessionId, cwd }).then((r) => {
        if (!alive) return
        // ⚠️ 成功即清除 fatal：首帧 cwd 尚未就绪时 Host 会返回一次「工作区未就绪」，
        // 而 cwd 就绪后重跑会成功——旧实现只在成功分支 setProfiles、从不 clearErr，
        // 那个临时错误会把下拉框永久抑制（fatal 分支直接 return null，不报红字）。
        if (r && !r.error) setFatal(null)
        if (r && Array.isArray(r.profiles)) setProfiles(r.profiles)
        if (r && typeof r.globalPrompt === 'string' && r.globalPrompt.length > 0) setGp(r.globalPrompt)
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
    // 无显式选择时默认加载 default 档案（每个会话只自动触发一次）。
    // 跳过两种情形：会话摘要尚未就绪（cwd 会抖动，容易误报）；子代理会话（档案由 Host 继承）。
    React.useEffect(() => {
      if (!profiles || profiles.length === 0 || active !== null || autoFired.has(sessionId)) return
      if (!summaryKnown || isSubagent) return
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
    }, [profiles, active, sessionId, cwd, summaryKnown, isSubagent])
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
    // 加载失败（如工作区没有 .deepseek.yaml / cwd 未就绪 / RPC 失败）→ 不渲染下拉框，不报红字
    if (fatal) return null
    if (profiles.length === 0) return null
    // 仅一个档案：无需选择，不出下拉框，静态展示档案名（自动加载逻辑仍生效）
    if (profiles.length === 1) {
      const only = profiles[0]
      const shownKey = active || only.name
      const shownTitle = only.title || shownKey
      const temp = only.parameters && only.parameters.temperature != null ? only.parameters.temperature : null
      return React.createElement('span', { className: css + '-inline' },
        React.createElement('span', {
          title: error || tip || 'profile-' + shownTitle + (temp != null ? ' · temperature ' + temp : '') + (isSubagent ? ' · 子代理会话(继承父会话档案)' : '') + (gp ? ' · 开场白覆盖: ' + gp : ''),
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
            + (isSubagent ? ' · 子代理会话(继承父会话档案)' : '') + (gp ? ' · 开场白覆盖: ' + gp : '')
          : '切换 .deepseek.yaml profile' + (isSubagent ? '（子代理会话：默认继承父会话档案）' : '') + (gp ? ' · 开场白覆盖: ' + gp : '')),
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
/**
 * dsh-profile-selector — 共享核心：设置面板 Client 半区（工厂函数，零依赖）
 *
 * 在 DSH 设置面板里注册一个 `settings.section` 页（「提示词档案」），让用户直接编辑
 * 本插件的三个全局设置，而不是手改 cordis.patch.yml：
 *
 *   global_prompt           textbox   开场白覆盖文件（绝对路径；留空 = 不覆盖）
 *   persona_clear           checkbox  清空 preset 自带的 persona 句
 *   includeHarnessIdentity  checkbox  保留 / 关闭 DSH 第一方开场白
 *
 * ## 与下拉框 Client 半区的关系
 *
 * 两者互不依赖：本文件只管设置页，`client.js` 只管输入区下拉框，各自独立注册、独立
 * 注册槽 id 与 RPC 前缀（双模式隔离同样适用于设置页：动态 `…-settings` / 静态 `…-static-settings`）。
 *
 * ## 保存语义
 *
 * 保存会把**三个键整体**提交给 Host（DSH 的 patch 覆盖对 config 是整块替换，只提交
 * 改动键会让其余键丢失，见 core/patch.js）。Host 侧负责写受管块 + 刷新内存 + 对活跃
 * 会话重新求值；本组件只负责草稿、提交与反馈展示。
 *
 * ## 为什么不用 ctx.configForms
 *
 * DSH 自带的配置表单只暴露 schemastery `.volatile()` 字段，且写入目标是 **profile 层**
 * 的 cordis.patch.yml。本插件要写自己的 bundle patch（安装目录那份）并按工作区覆盖，
 * 所以走自定义 RPC + 自定义表单。
 *
 * 参数化（与 client.js 同款双模式隔离）：
 *   opts.settingsSlotId — 槽注册 id
 *   opts.rpcPrefix      — RPC method 前缀（核心用 `<prefix>.settings` / `<prefix>.settings.set`）
 *   opts.cssPrefix      — CSS 类前缀
 *   deps.React / deps.call / deps.insertCss — 与 client.js 同义
 */

/** Client 半区 apply 函数体：注册设置页到 settings.section 槽。 */
function settingsClientCore(ctx, opts, deps) {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  const React = deps.React
  const call = deps.call
  const insertCss = deps.insertCss
  const h = React.createElement
  const css = opts.cssPrefix

  insertCss(
    '.' + css + '{display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary,#1f1f1f);max-width:640px;}' +
    '.' + css + ' h2{margin:0;font-size:15px;font-weight:600;}' +
    '.' + css + '-hint{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#6b6b6b);}' +
    '.' + css + '-field{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#e0e0e0);border-radius:8px;background:var(--dsw-alias-bg-layer-1,transparent);}' +
    '.' + css + '-field > label{font-weight:500;display:flex;align-items:center;gap:8px;cursor:pointer;}' +
    '.' + css + '-field > label span.k{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dsw-alias-label-secondary,#6b6b6b);}' +
    '.' + css + '-desc{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#6b6b6b);}' +
    '.' + css + '-field input[type=text]{width:100%;box-sizing:border-box;font-size:12px;padding:5px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#e0e0e0);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,#1f1f1f);}' +
    '.' + css + '-field input[type=checkbox]{margin:0;}' +
    '.' + css + '-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}' +
    '.' + css + '-actions button{font-size:12px;padding:5px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#e0e0e0);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,#1f1f1f);cursor:pointer;}' +
    '.' + css + '-actions button[data-kind=primary]{border-color:transparent;background:var(--dsw-alias-label-primary,#1f1f1f);color:var(--dsw-alias-bg-layer-1,#fff);}' +
    '.' + css + '-actions button:disabled{opacity:.5;cursor:default;}' +
    '.' + css + '-status{margin:0;font-size:12px;line-height:1.6;}' +
    '.' + css + '-status[data-tone=error]{color:var(--dsw-alias-state-error-primary,#d03050);}' +
    '.' + css + '-status[data-tone=ok]{color:var(--dsw-alias-label-secondary,#6b6b6b);}' +
    '.' + css + '-meta{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary,#6b6b6b);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;}'
  )

  /**
   * 三个字段的展示元数据。顺序按**使用频率/重要性**排（开关在前、路径在后），
   * 与 core/settings.js 的 SETTINGS_KEYS（那是数据序）无关。
   *
   * ⚠️ 文案方向必须与 checkbox 的取值为**同向**（勾选 = 值为 `true`）：
   * 勾选态直接渲染 `draft[key] === true`，所以标题要写成「勾选＝怎样」。
   * 反着写（标题说「关闭」而 true 表示保留）会让默认状态看起来与文案矛盾。
   */
  const FIELDS = [
    {
      key: 'includeHarnessIdentity',
      kind: 'checkbox',
      title: '保留 DSH 第一方开场白',
      desc: '系统提示词的第 1 句 “You are an AI agent powered by DeepSeek Harness.”。'
        + '勾选 = 保留该句；不勾选（默认）= 关掉它。'
        + '本插件在会话作用域用同名段覆盖它，改完立即生效，无需重启。',
    },
    {
      key: 'persona_clear',
      kind: 'checkbox',
      title: '清空 persona 段',
      desc: 'preset 自带的第 2 句 “You are a coding agent powered by the {{model}} model.”。'
        + '勾选 = 清空（默认）；不勾选 = 保留原句。',
    },
    {
      key: 'global_prompt',
      kind: 'textbox',
      title: '开场白覆盖文件',
      // 文案里**不写具体路径示例**：面板可能被截图/分享，不该暴露本机目录结构。
      desc: '填一个文本文件的绝对路径。'
        + '填了就用自己的文件正文替换第 1 句；留空（默认）= 不覆盖（此时由上面的开关决定那句英文的去留）。',
      placeholder: '/path/to/your-prompt.md',
    },
  ]

  function SettingsPanel() {
    const [phase, setPhase] = React.useState('loading')
    const [saved, setSaved] = React.useState(null)
    const [draft, setDraft] = React.useState(null)
    const [meta, setMeta] = React.useState(null)
    const [error, setError] = React.useState(null)
    const mounted = React.useRef(true)
    const saving = React.useRef(false)

    const load = React.useCallback(async () => {
      setPhase('loading')
      setError(null)
      try {
        const r = await call(opts.rpcPrefix + '.settings', {})
        if (!mounted.current) return
        if (!r || r.error) {
          setError((r && r.error) || '读取设置失败')
          setPhase('error')
          return
        }
        setSaved(r.values)
        setDraft(r.values)
        setMeta(r)
        setPhase('ready')
      } catch (err) {
        if (!mounted.current) return
        setError('RPC 失败: ' + String((err && err.message) || err))
        setPhase('error')
      }
    }, [])

    React.useEffect(() => {
      mounted.current = true
      load()
      return () => { mounted.current = false }
    }, [load])

    const setField = (key, value) => {
      setDraft((current) => Object.assign({}, current, { [key]: value }))
      setError(null)
    }

    const dirty = !!(draft && saved) && FIELDS.some((f) => draft[f.key] !== saved[f.key])

    const save = async () => {
      if (!draft || saving.current || phase === 'loading') return
      saving.current = true
      setPhase('saving')
      setError(null)
      try {
        const r = await call(opts.rpcPrefix + '.settings.set', { values: draft })
        if (!mounted.current) return
        if (!r || !r.ok) {
          setError((r && r.error) || '保存失败')
          setPhase('ready')
          return
        }
        setSaved(r.values)
        setDraft(r.values)
        setMeta((current) => Object.assign({}, current, { values: r.values, patchPath: r.patchPath, writable: r.writable }))
        setPhase('ready')
        if (r.warning) setError(r.warning)
      } catch (err) {
        if (!mounted.current) return
        setError('保存失败: ' + String((err && err.message) || err))
        setPhase('ready')
      } finally {
        saving.current = false
      }
    }

    const restore = () => {
      setDraft((current) => Object.assign({}, current, {
        global_prompt: '',
        persona_clear: true,
        includeHarnessIdentity: false,
      }))
      setError(null)
    }

    if (phase === 'loading' && !draft) {
      return h('div', { className: css }, h('h2', null, '提示词档案'), h('p', { className: css + '-hint' }, '正在读取设置…'))
    }
    if (!draft) {
      return h('div', { className: css },
        h('h2', null, '提示词档案'),
        h('p', { className: css + '-status', 'data-tone': 'error', role: 'alert' }, error || '设置不可用'),
        h('div', { className: css + '-actions' }, h('button', { type: 'button', onClick: () => load() }, '重试')))
    }

    const busy = phase === 'saving'

    return h('div', { className: css },
      h('h2', null, '提示词档案'),
      h('p', { className: css + '-hint' },
        '这里是本插件的**全局默认值**（写在插件自己的 cordis.patch.yml 里）。'
        + '某个工作区的 .deepseek.yaml 若写了同名字段（workspace 段），会**按字段覆盖**这里的值；'
        + '没写的字段继续用这里的设置。'),
      ...FIELDS.map((field) => h('div', { className: css + '-field', key: field.key },
        field.kind === 'checkbox'
          ? h('label', null,
            h('input', {
              type: 'checkbox',
              checked: draft[field.key] === true,
              disabled: busy,
              onChange: (e) => setField(field.key, e.target.checked),
            }),
            h('span', null, field.title),
            h('span', { className: 'k' }, field.key))
          : h('label', { htmlFor: css + '-global-prompt' },
            h('span', null, field.title),
            h('span', { className: 'k' }, field.key)),
        field.kind === 'textbox'
          ? h('input', {
            id: css + '-global-prompt',
            type: 'text',
            value: typeof draft[field.key] === 'string' ? draft[field.key] : '',
            placeholder: field.placeholder,
            disabled: busy,
            spellCheck: false,
            onChange: (e) => setField(field.key, e.target.value),
          })
          : null,
        h('p', { className: css + '-desc' }, field.desc))),
      h('div', { className: css + '-actions' },
        h('button', {
          type: 'button',
          'data-kind': 'primary',
          disabled: busy || !dirty,
          onClick: () => save(),
        }, busy ? '保存中…' : '保存'),
        h('button', { type: 'button', disabled: busy || !dirty, onClick: restore }, '恢复默认值')),
      error ? h('p', { className: css + '-status', 'data-tone': 'error', role: 'alert' }, error) : null,
      !error && !dirty && phase === 'ready' ? h('p', { className: css + '-status', 'data-tone': 'ok', role: 'status' }, '已保存') : null,
      meta && meta.patchPath
        ? h('p', { className: css + '-meta' }, '写入位置: ' + meta.patchPath + (meta.writable === false ? '（当前进程不可写，仅在内存生效）' : ''))
        : meta && meta.writable === false
          ? h('p', { className: css + '-meta' }, '当前环境无可写 patch 文件（仅内存生效，重启后失效）')
          : null)
  }

  // 页签标题由注册项提供（DSH 的 settings.section 契约：label 是函数，locale 变化时重注册）。
  slots.inject('settings.section', () => slots.register(
    { name: 'settings.section', id: opts.settingsSlotId, order: 60, label: () => '提示词档案' },
    () => h(SettingsPanel, null)
  ))
}
return {
  apply(ctx) {
    clientCore(ctx, {
      slotName: 'conversation.input.left',
      slotId: 'dsh-profile-selector',
      rpcPrefix: 'dshprofile',
      cssPrefix: 'dshprofile',
    }, {
      // 动态模式：React/styles/host 均为闭包符号
      React,
      call: (method, args) => host.call(method, args),
      insertCss: (css) => styles.insert(css),
    })
    settingsClientCore(ctx, {
      settingsSlotId: 'dsh-profile-selector-settings',
      rpcPrefix: 'dshprofile',
      cssPrefix: 'dshprofile-settings',
    }, {
      React,
      call: (method, args) => host.call(method, args),
      insertCss: (css) => styles.insert(css),
    })
  },
}
