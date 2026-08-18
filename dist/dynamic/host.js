/**
 * dsh-profile-selector — 动态模式 Host 壳（开发用）
 *
 * 本文件是 cordis_define 的函数体模板：build.mjs 会把 src/core/yaml.js 与
 * src/core/host.js 的源码（去掉 export 关键字）内联到 /*__CORE_YAML__*\/ 与
 * /*__CORE_HOST__*\/ 占位符处，生成 dist/dynamic/host.js 供 cordis_define 使用。
 * 请勿直接编辑 dist/dynamic/*.js（构建产物）。
 */
/**
 * dsh-profile-selector — 共享核心：迷你 YAML 解析器（纯函数，零依赖）
 *
 * 双模式共用：动态模式由 build.mjs 内联进 cordis_define 函数体；
 * 静态模式由 src/static/*.js 以 ESM import 引用。
 * 仅支持 .deepseek.yaml 所需子集：map / list of scalars。
 */

/** 解析单个标量：去引号、布尔、数字、null。 */
function parseScalar(raw) {
  const v = String(raw).trim()
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1)
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === 'null' || v === '~') return null
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  return v
}

/** 解析 YAML 文本为嵌套对象（map/list of scalars 子集）。 */
function parseYaml(text) {
  const root = {}
  const stack = [{ indent: -1, obj: root }]
  const lines = String(text).split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = line.match(/^\s*/)[0].length
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const content = line.slice(indent)
    const m = content.match(/^([^:#]+?):\s*(.*)$/)
    if (!m) continue
    const key = m[1].trim()
    const value = m[2].trim()
    const parent = stack[stack.length - 1].obj
    if (value === '') {
      const child = {}
      parent[key] = child
      stack.push({ indent, obj: child })
    } else {
      parent[key] = parseScalar(value)
    }
  }
  return root
}
/**
 * dsh-profile-selector — 共享核心：Host 半区逻辑（工厂函数，零依赖）
 *
 * 双模式共用：动态模式由 build.mjs 内联进 cordis_define 函数体；
 * 静态模式由 src/static/host.js 以 ESM import 引用。
 *
 * 参数化（双模式隔离的关键）：
 *   opts.sectionName — systemPrompt section 名（动态 dsh-profile:profile / 静态 dsh-profile:profile-static）
 *   opts.rpcPrefix   — RPC method 前缀（动态 dshprofile / 静态 dshprofile-static）
 *   rpc.handle       — RPC 注册适配器（动态 harness.handle / 静态 connection.rpc.handle）
 *                      handler 签名统一为 (args) => Promise<业务结果>，适配器负责包装
 *
 * 用法：hostCore(ctx, opts, rpc) 即 apply 的函数体——动态壳
 * `return { apply(ctx) { hostCore(ctx, opts, rpc) } }`，静态壳
 * `export default { apply(ctx) { hostCore(ctx, opts, rpc) } }`。
 *
 * 关键机制（勿随意改动，详见 README.md「已知坑」）：
 * 1. 会话级串行队列 enqueue()：同一会话的 activate 严格顺序执行，杜绝注册竞态；
 * 2. forceCleanSection()：注册前直接删除层里残留的 section（disposer 在真实运行时
 *    可能静默失效，这是安全网，也是 pkg-12 修复 "already registered" 的关键）；
 * 3. sectionDiag()：出错时返回残留注册位置诊断（scopedHits/agentKeyHit/globalHit）；
 * 4. temperature 经 agent/request 瀑布注入（top_p 无对应配置项，不应用）；
 * 5. ctx.on('dispose') 统一清理：disposer + disposeTemp + forceCleanSection 兜底。
 */

/** Host 半区 apply 函数体：执行全部注册逻辑。 */
function hostCore(ctx, opts, rpc) {
  const fs = ctx.get('fs')
  const sandboxPolicy = ctx.get('sandboxPolicy')
  const agents = ctx.get('agents')
  if (fs === undefined || sandboxPolicy === undefined || agents === undefined) return

  const SECTION_NAME = opts.sectionName
  const SECTION_ORDER = -50
  const rpcPrefix = opts.rpcPrefix
  // sessionId -> { profileName, disposer, disposeTemp, temperature, sp, agent }
  const active = new Map()
  // sessionId -> 已解析的会话 cwd（缓存：切换对话时 agent 可能短暂未就绪/被 dispose，
  // 缓存避免回退到部署级根去读错误的 .deepseek.yaml——见 README §六-7）
  const cwdCache = new Map()
  // sessionId -> { profile, cwd } 待激活档案：会话存在但 agent 尚未激活
  // （新会话空白期 / 冷会话 / DSH 重启后会话未恢复）时暂存，agent/created 后自动应用。
  // 见 README §六-8「激活延迟」。
  const pending = new Map()
  // 会话级串行队列：保证同一会话的 activate 顺序执行，杜绝注册竞态
  const chains = new Map()
  const handles = []

  function sessionCwd(sessionId, explicitCwd) {
    // 1) 客户端显式传入的会话 cwd（来自客户端会话 store，切换对话时最可靠，不依赖 agent 是否在线）
    if (typeof explicitCwd === 'string' && explicitCwd.length > 0) {
      if (sessionId) cwdCache.set(sessionId, explicitCwd)
      return explicitCwd
    }
    // 2) 缓存命中
    if (sessionId && cwdCache.has(sessionId)) return cwdCache.get(sessionId)
    // 3) agent 会话 header 兜底（仅当 agent 在线时可用）
    if (sessionId) {
      try {
        const agent = agents.get(sessionId)
        const cwd = agent && agent.session && agent.session.header && agent.session.header.cwd
        if (typeof cwd === 'string' && cwd.length > 0) {
          cwdCache.set(sessionId, cwd)
          return cwd
        }
      } catch (e) { /* fall through */ }
    }
    // 4) 解析不到返回 null，由调用方给出明确错误。绝不回退 sandboxPolicy.workspaceRoot：
    //    那是部署级根（跨工作区会读错 .deepseek.yaml，切换对话时会误读用户目录下的文件）
    return null
  }

  function enqueue(sessionId, fn) {
    const prev = chains.get(sessionId) || Promise.resolve()
    const tail = prev.then(fn, fn)
    const slot = tail.catch(() => {})
    chains.set(sessionId, slot)
    slot.then(() => { if (chains.get(sessionId) === slot) chains.delete(sessionId) })
    return tail
  }

  // 强制清理：直接删除层里残留的 section 注册（disposer 失效时的安全网）
  function forceCleanSection(sp, agent) {
    let removed = 0
    try {
      const layers = sp && sp.layers
      if (!layers) return removed
      if (layers.scoped && layers.scoped instanceof Map) {
        for (const [key, layer] of layers.scoped) {
          if (key !== agent) continue
          const s = layer && layer.sections
          if (s && s.data && s.data.has(SECTION_NAME)) {
            s.data.delete(SECTION_NAME)
            removed++
          }
        }
      }
      const g = layers.global && layers.global.sections
      if (g && g.data && g.data.has(SECTION_NAME)) {
        g.data.delete(SECTION_NAME)
        removed++
      }
    } catch (e) { /* noop */ }
    return removed
  }

  // 诊断：统计残留注册的位置（用于定位 disposer 为何失效）
  function sectionDiag(sp, agent) {
    const parts = []
    try {
      const layers = sp && sp.layers
      if (!layers) return 'no layers'
      let scopedHits = 0
      let agentKeyHit = 0
      if (layers.scoped && layers.scoped instanceof Map) {
        for (const [key, layer] of layers.scoped) {
          const s = layer && layer.sections
          if (s && typeof s.has === 'function' && s.has(SECTION_NAME)) {
            scopedHits++
            if (key === agent) agentKeyHit++
          }
        }
      }
      parts.push('scopedHits=' + scopedHits)
      parts.push('agentKeyHit=' + agentKeyHit)
      const g = layers.global && layers.global.sections
      parts.push('globalHit=' + (g && typeof g.has === 'function' ? (g.has(SECTION_NAME) ? 1 : 0) : 'na'))
    } catch (e) {
      parts.push('diagErr=' + String((e && e.message) || e))
    }
    return parts.join('; ')
  }

  function localDate() {
    const d = new Date()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return d.getFullYear() + '-' + mm + '-' + dd
  }

  function substitute(text, cwd) {
    let out = String(text)
    out = out.replace(/\{\{\s*date\s*\}\}/g, localDate())
    out = out.replace(/\{workspace\}/g, cwd)
    out = out.replace(/\{dataDir\}/g, cwd + '/output')
    out = out.replace(/\{fileDir\}/g, cwd + '/doc/ai')
    return out
  }

  async function loadProfiles(cwd) {
    const target = await fs.resolve('.deepseek.yaml', { cwd })
    const text = await fs.readText(target)
    const parsed = parseYaml(text)
    const ws = parsed && parsed.workspace
    const prompts = ws && ws.system_prompts
    if (!prompts || typeof prompts !== 'object') return []
    return Object.keys(prompts)
      .filter((name) => prompts[name] && typeof prompts[name].file === 'string')
      .map((name) => ({
        name,
        // 显示名：档案子项可选 name 字段；缺省回退为档案 key（下拉框显示 profile-<title>）
        title: typeof prompts[name].name === 'string' && prompts[name].name.length > 0 ? prompts[name].name : name,
        file: prompts[name].file,
        parameters: prompts[name].parameters && typeof prompts[name].parameters === 'object' ? prompts[name].parameters : {},
      }))
  }

  async function profileText(profile, cwd) {
    const target = await fs.resolve(profile.file, { cwd })
    const raw = await fs.readText(target)
    const body = substitute(raw, cwd)
    return '【当前会话已通过界面选择 .deepseek.yaml 提示词档案「' + profile.name + '」，以下为该档案的完整指令，请以其中的角色设定与任务要求为准执行】\n\n' + body
  }

  /**
   * 判断会话是否真实存在（内存会话表或持久化列表）。
   * 用途：activate 在 agent 未激活时区分「会话不存在」（真错误）与
   * 「会话存在但 agent 尚未激活」（延迟激活）——见 README §六-8。
   * 查询失败时按「存在」处理：宁可延迟激活，也不误报红字。
   */
  async function sessionExists(sessionId) {
    try {
      const sessionsSvc = ctx.get('sessions')
      if (sessionsSvc && sessionsSvc.get(sessionId)) return true
      const persistence = ctx.get('sessionPersistence')
      if (persistence && typeof persistence.list === 'function') {
        const list = await persistence.list()
        return Array.isArray(list) && list.some((h) => h && h.id === sessionId)
      }
      return false
    } catch (e) {
      return true
    }
  }

  /**
   * 激活核心：把档案正文注册进指定（已激活的）agent 的会话作用域。
   * 从 activate RPC 与 agent/created 延迟应用两条路径共用。
   * @returns 业务结果 {ok:true,...} 或 {ok:false,error}
   */
  async function applyActivation(agent, sessionId, name, explicitCwd) {
    const cwd = sessionCwd(sessionId, explicitCwd)
    if (!cwd) return { ok: false, error: '会话工作区未就绪（无法解析 cwd）' }
    const existing = active.get(sessionId)
    if (existing && existing.profileName === name) {
      return { ok: true, profile: name, temperature: existing.temperature }
    }
    if (existing) {
      try { existing.disposer() } catch (e) { /* noop */ }
      try { if (existing.disposeTemp) existing.disposeTemp() } catch (e) { /* noop */ }
      active.delete(sessionId)
    }
    if (!name) return { ok: true, profile: null }
    const profiles = await loadProfiles(cwd)
    const profile = profiles.find((p) => p.name === name)
    if (!profile) return { ok: false, error: '未知档案: ' + name + '（工作区 ' + cwd + '）' }
    const text = await profileText(profile, cwd)
    let sp
    try {
      sp = agent.ctx.systemPrompt
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
    if (!sp) return { ok: false, error: '目标会话无 systemPrompt 服务' }
    // 注册前强制清理残留（覆盖 disposer 失效/旧运行残留场景）
    const removed = forceCleanSection(sp, agent)
    const disposer = sp.section({ name: SECTION_NAME, order: SECTION_ORDER, text })
    // 档案采样参数：temperature 经 agent/request 瀑布注入（top_p 无对应配置项，不应用）
    const params = profile.parameters && typeof profile.parameters === 'object' ? profile.parameters : {}
    const hasTemp = typeof params.temperature === 'number' && Number.isFinite(params.temperature)
    let disposeTemp = null
    if (agent.ctx && typeof agent.ctx.on === 'function') {
      disposeTemp = agent.ctx.on('agent/request', async (_payload, next) => {
        const resolved = await next()
        if (!resolved || typeof resolved !== 'object') return resolved
        if (hasTemp) return Object.assign({}, resolved, { temperature: params.temperature })
        const rest = Object.assign({}, resolved)
        delete rest.temperature
        return rest
      })
    }
    active.set(sessionId, { profileName: name, disposer, disposeTemp, temperature: hasTemp ? params.temperature : null, sp, agent })
    return { ok: true, profile: name, temperature: hasTemp ? params.temperature : null, cleaned: removed }
  }

  handles.push(rpc.handle(rpcPrefix + '.profiles', async (args) => {
    try {
      const cwd = sessionCwd(args && args.sessionId, args && args.cwd)
      if (!cwd) return { profiles: [], error: '会话工作区未就绪（无法解析 cwd，sessionId=' + (args && args.sessionId) + '）', cwd: null }
      const profiles = await loadProfiles(cwd)
      return { profiles, cwd }
    } catch (err) {
      return { profiles: [], error: String((err && err.message) || err), cwd: null }
    }
  }))

  handles.push(rpc.handle(rpcPrefix + '.state', async (args) => {
    const sessionId = args && args.sessionId
    const entry = sessionId ? active.get(sessionId) : undefined
    // pending（延迟激活）中的档案也算当前选中，保证下拉框/单档案展示不跳回默认
    const queued = sessionId ? pending.get(sessionId) : undefined
    return { active: entry ? entry.profileName : (queued ? queued.profile : null) }
  }))

  // 延迟激活：会话 agent 发布（新会话首次 prompt / 冷会话恢复 / DSH 重启后重连）
  // 时自动应用 pending 档案——解决「下拉框已加载但 activate 报『会话不存在或未激活』」。
  // 事件形状：'agent/created'(this: Scoped<Agent>, payload: { agent })
  const stopCreated = ctx.on('agent/created', ({ agent }) => {
    const sessionId = agent && agent.id
    const req = sessionId ? pending.get(sessionId) : undefined
    if (!req) return
    pending.delete(sessionId)
    enqueue(sessionId, async () => {
      try {
        await applyActivation(agent, sessionId, req.profile, req.cwd)
      } catch (err) {
        try { if (ctx.logger && ctx.logger.warn) ctx.logger.warn('[dsh-profile-selector] 延迟激活失败: ' + String((err && err.message) || err)) } catch (e) { /* noop */ }
      }
    })
  })
  handles.push(stopCreated)

  handles.push(rpc.handle(rpcPrefix + '.activate', async (args) => {
    const sessionId = args && args.sessionId
    if (!sessionId) return { ok: false, error: 'missing sessionId' }
    const name = args.profile
    const explicitCwd = args && args.cwd
    return enqueue(sessionId, async () => {
      try {
        const agent = agents.get(sessionId)
        if (!agent) {
          // agent 尚未激活（新会话空白期 / 冷会话 / DSH 重启后未恢复）。
          // 会话真实存在 → 延迟激活：暂存档案，agent/created 后自动应用；
          // 会话确实不存在 → 才报错。
          if (!(await sessionExists(sessionId))) return { ok: false, error: '会话不存在或未激活' }
          if (name) pending.set(sessionId, { profile: name, cwd: explicitCwd })
          else pending.delete(sessionId)
          return { ok: true, profile: name || null, pending: true, temperature: null }
        }
        return await applyActivation(agent, sessionId, name, explicitCwd)
      } catch (err) {
        const msg = String((err && err.message) || err)
        let extra = ''
        try {
          const agent = agents.get(sessionId)
          const sp = agent && agent.ctx ? agent.ctx.systemPrompt : undefined
          extra = ' [diag: ' + sectionDiag(sp, agent) + ']'
        } catch (e) { /* noop */ }
        return { ok: false, error: msg + extra }
      }
    })
  }))

  ctx.on('dispose', () => {
    for (const entry of active.values()) {
      try { entry.disposer() } catch (e) { /* noop */ }
      try { if (entry.disposeTemp) entry.disposeTemp() } catch (e) { /* noop */ }
      // 安全网：直接清除残留 section
      try {
        if (entry.sp && entry.agent) forceCleanSection(entry.sp, entry.agent)
      } catch (e) { /* noop */ }
    }
    active.clear()
    pending.clear()
    for (const d of handles) {
      try { d() } catch (e) { /* noop */ }
    }
  })
}
return {
  apply(ctx) {
    hostCore(ctx, {
      sectionName: 'dsh-profile:profile',
      rpcPrefix: 'dshprofile',
    }, {
      // 动态模式：harness.handle 直接注册，handler 返回业务结果
      handle: (method, handler) => harness.handle(method, handler),
    })
  },
}