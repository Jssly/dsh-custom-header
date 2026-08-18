/**
 * dshy-1 (yaml-profile-selector) — Host 半区源码
 *
 * 当前版本：pkg-12（2026-08-18，run-10 激活成功）
 * 说明：本文件是 DSH 动态 Cordis 插件 dshy-1 的 Host 半区源码快照，
 *       与运行中的 pkg-12 完全一致。开发文档见同目录 README.md。
 *
 * 功能：读取工作区 .deepseek.yaml 的 system_prompts 档案，
 *       经 GUI 下拉框选择后，把档案正文注册为当前会话的 systemPrompt section
 *       （section 名 dsh-yaml:profile，order -50），并注入档案的 temperature 参数。
 *
 * 关键机制（勿随意改动，详见 README.md「已知坑」）：
 * 1. 会话级串行队列 enqueue()：同一会话的 activate 严格顺序执行，杜绝注册竞态；
 * 2. forceCleanSection()：注册前直接删除层里残留的 section（disposer 在真实运行时
 *    可能静默失效，这是安全网，也是 pkg-12 修复 "already registered" 的关键）；
 * 3. sectionDiag()：出错时返回残留注册位置诊断（scopedHits/agentKeyHit/globalHit）；
 * 4. temperature 经 agent/request 瀑布注入（top_p 无对应配置项，不应用）；
 * 5. ctx.on('dispose') 统一清理：disposer + disposeTemp + forceCleanSection 兜底。
 */
return {
  apply(ctx) {
    const fs = ctx.get('fs')
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const agents = ctx.get('agents')
    if (fs === undefined || sandboxPolicy === undefined || agents === undefined) return

    const fallbackRoot = sandboxPolicy.workspaceRoot
    const SECTION_NAME = 'dsh-yaml:profile'
    const SECTION_ORDER = -50
    // sessionId -> { profileName, disposer, disposeTemp, temperature, sp, agent }
    const active = new Map()
    // 会话级串行队列：保证同一会话的 activate 顺序执行，杜绝注册竞态
    const chains = new Map()
    const handles = []

    function sessionCwd(sessionId) {
      if (!sessionId) return fallbackRoot
      try {
        const agent = agents.get(sessionId)
        const cwd = agent && agent.session && agent.session.header && agent.session.header.cwd
        if (typeof cwd === 'string' && cwd.length > 0) return cwd
      } catch (e) { /* fall through */ }
      return fallbackRoot
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

    // --- minimal YAML subset parser (maps/lists of scalars) ---
    function parseScalar(raw) {
      const v = String(raw).trim()
      if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1)
      if (v === 'true') return true
      if (v === 'false') return false
      if (v === 'null' || v === '~') return null
      if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
      return v
    }

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

    handles.push(harness.handle('dshyaml.profiles', async (args) => {
      try {
        const cwd = sessionCwd(args && args.sessionId)
        const profiles = await loadProfiles(cwd)
        return { profiles, cwd }
      } catch (err) {
        return { profiles: [], error: String((err && err.message) || err), cwd: sessionCwd(args && args.sessionId) }
      }
    }))

    handles.push(harness.handle('dshyaml.state', async (args) => {
      const sessionId = args && args.sessionId
      const entry = sessionId ? active.get(sessionId) : undefined
      return { active: entry ? entry.profileName : null }
    }))

    handles.push(harness.handle('dshyaml.activate', async (args) => {
      const sessionId = args && args.sessionId
      if (!sessionId) return { ok: false, error: 'missing sessionId' }
      const name = args.profile
      return enqueue(sessionId, async () => {
        try {
          const agent = agents.get(sessionId)
          if (!agent) return { ok: false, error: '会话不存在或未激活' }
          const cwd = sessionCwd(sessionId)
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
      for (const d of handles) {
        try { d() } catch (e) { /* noop */ }
      }
    })
  },
}