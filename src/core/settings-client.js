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
export function settingsClientCore(ctx, opts, deps) {
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
