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
 * 仅支持 .deepseek.yaml 所需子集：map / 标量 / 标量列表（block sequence）。
 * 不支持锚点、多行字符串（|、>）、嵌套列表、列表内 map 等复杂结构。
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

/**
 * 解析 YAML 文本为嵌套对象（map + 标量 + 标量列表子集）。
 *
 * 支持的形态：
 *   key: value                  → 标量（字符串去引号 / 布尔 / 数字 / null）
 *   key:                        → 嵌套 map（缩进栈）
 *   key:\n  - item              → 标量列表（block sequence；缩进对齐 key 的写法同样支持）
 * 空行与 `#` 注释行忽略；无法识别的行按「忽略」处理（不抛错，与库内既有风格一致）。
 *
 * 实现要点：`key:` 空值先懒创建一个占位对象并压栈（pending=true），若该层的首个内容行是
 * 列表项 `- item`，就把父容器里的这个占位对象**原地替换成数组**（YAML 的 map/list 二义性靠此消除）；
 * 一旦该层写入了子键或列表项，pending 即置 false。
 */
function parseYaml(text) {
  const root = {}
  /** 缩进栈：{ indent, obj, parent, key, pending }（obj 为对象或数组；parent/key 记录挂载位置）。 */
  const stack = [{ indent: -1, obj: root, parent: null, key: null, pending: false }]
  const lines = String(text).split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = line.match(/^\s*/)[0].length
    const content = line.slice(indent)
    const isItem = content === '-' || /^-\s/.test(content)
    while (stack.length > 1) {
      const top = stack[stack.length - 1]
      // 列表项与所属 key 同缩进（key: 换行后直接 "- item"）时保留占位层 / 数组层
      if (indent === top.indent && isItem && (top.pending || Array.isArray(top.obj))) break
      if (indent <= top.indent) { stack.pop(); continue }
      break
    }
    const top = stack[stack.length - 1]

    // 列表项：仅支持标量项；父层未定（空值占位）时就地升级为数组
    if (isItem) {
      const item = parseScalar(content.replace(/^-\s*/, ''))
      if (Array.isArray(top.obj)) { top.obj.push(item); continue }
      if (!top.pending || !top.parent) continue
      const arr = []
      top.parent[top.key] = arr
      top.obj = arr
      top.pending = false
      arr.push(item)
      continue
    }

    if (Array.isArray(top.obj)) continue // 列表内不支持 map 项
    const m = content.match(/^([^:#]+?):\s*(.*)$/)
    if (!m) continue
    const key = m[1].trim()
    const value = m[2].trim()
    if (value === '') {
      const child = {}
      top.obj[key] = child
      top.pending = false
      stack.push({ indent, obj: child, parent: top.obj, key, pending: true })
    } else {
      top.obj[key] = parseScalar(value)
      top.pending = false
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
 * 5. ctx.on('dispose') 统一清理：disposer + disposeTemp + forceCleanSection 兜底；
 * 6. 工作区开场白覆盖（workspace.global_prompt）：以同名 section 注册进 agent 作用域，
 *    按名 shadow 掉 DSH 第一方开幕式（harness:identity）——只改文本、不动 DSH 源码，
 *    且只影响该工作区的会话（见 IDENTITY_SECTION 注释）；
 *    **未配置（键缺失/非字符串/空值）/ 文件不存在 / 文件为空 → 一律走 unapplyIdentity()
 *    卸载旧注册（disposer + forceCleanSection 兜底），保留 DSH 默认开场白——绝不「配置没了、
 *    覆盖还在」**；成功路径见 applyIdentity()。
 * 7. 档案 file 支持 string | string[]：数组按声明顺序逐个读盘，用空行合并为一段正文
 *    （见 normalizeFiles / profileText）。
 */

/** Host 半区 apply 函数体：执行全部注册逻辑。 */
function hostCore(ctx, opts, rpc) {
  const fs = ctx.get('fs')
  const sandboxPolicy = ctx.get('sandboxPolicy')
  const agents = ctx.get('agents')
  if (fs === undefined || sandboxPolicy === undefined || agents === undefined) return

  const SECTION_NAME = opts.sectionName
  const SECTION_ORDER = -50
  /**
   * DSH 第一方开场白 section 名。@deepseek-ai/dsh-system-prompt 在构造函数里以
   * **全局作用域**注册它（order -1000，文本 "You are an AI agent powered by
   * DeepSeek Harness."），且只暴露 includeHarnessIdentity 布尔开关，改不了文本。
   *
   * 覆盖手法：dsh-scope 的 ScopedLayers.merge() 先取 global 层、再用 scope-chain
   * 的同名条目覆盖，assemble() 正是用它（packages/core/scope/src/store.ts:208）。
   * 因此在本插件已用的 agent 作用域注册**同名** section，即可只替换这一句。
   * 副作用面被自动限制住：全局层那份永远不动，其他工作区/会话不受影响。
   */
  const IDENTITY_SECTION = 'harness:identity'
  /** 与 SECTION_ORDERS.HARNESS_IDENTITY 对齐，保证替换后仍是 system prompt 最前一段。 */
  const IDENTITY_ORDER = -1000
  const rpcPrefix = opts.rpcPrefix
  // sessionId -> { profileName, disposer, disposeTemp, temperature, sp, agent }
  const active = new Map()
  // sessionId -> { disposer, sp, agent, file }：global_prompt 覆盖的当前注册
  const identity = new Map()
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

  /** 统一告警出口：logger 缺失或抛错都不影响主流程。 */
  function warn(message) {
    try { if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('[dsh-profile-selector] ' + message) } catch (e) { /* noop */ }
  }

  /** 从 agent 的会话 header 读取 cwd（agent 未激活/字段缺失时返回 null）。 */
  function agentCwd(agent) {
    try {
      const cwd = agent && agent.session && agent.session.header && agent.session.header.cwd
      return typeof cwd === 'string' && cwd.length > 0 ? cwd : null
    } catch (e) {
      return null
    }
  }

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
      const cwd = agentCwd(agents.get(sessionId))
      if (cwd) {
        cwdCache.set(sessionId, cwd)
        return cwd
      }
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
  // name 省略时清理本插件自己的档案 section。
  function forceCleanSection(sp, agent, name) {
    const sectionName = name || SECTION_NAME
    let removed = 0
    try {
      const layers = sp && sp.layers
      if (!layers) return removed
      if (layers.scoped && layers.scoped instanceof Map) {
        for (const [key, layer] of layers.scoped) {
          if (key !== agent) continue
          const s = layer && layer.sections
          if (s && s.data && s.data.has(sectionName)) {
            s.data.delete(sectionName)
            removed++
          }
        }
      }
      // 绝不清理 global 层的 harness:identity——那是 DSH 自带开场白，删掉会波及所有
      // 工作区的所有会话（覆盖只允许走 scoped shadow 这一条路径）。
      if (sectionName !== IDENTITY_SECTION) {
        const g = layers.global && layers.global.sections
        if (g && g.data && g.data.has(sectionName)) {
          g.data.delete(sectionName)
          removed++
        }
      }
    } catch (e) { /* noop */ }
    return removed
  }

  // 诊断：统计残留注册的位置（用于定位 disposer 为何失效）
  function sectionDiag(sp, agent, name) {
    const sectionName = name || SECTION_NAME
    const parts = []
    try {
      const layers = sp && sp.layers
      if (!layers) return 'no layers'
      let scopedHits = 0
      let agentKeyHit = 0
      if (layers.scoped && layers.scoped instanceof Map) {
        for (const [key, layer] of layers.scoped) {
          const s = layer && layer.sections
          if (s && typeof s.has === 'function' && s.has(sectionName)) {
            scopedHits++
            if (key === agent) agentKeyHit++
          }
        }
      }
      parts.push('scopedHits=' + scopedHits)
      parts.push('agentKeyHit=' + agentKeyHit)
      const g = layers.global && layers.global.sections
      parts.push('globalHit=' + (g && typeof g.has === 'function' ? (g.has(sectionName) ? 1 : 0) : 'na'))
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

  /**
   * 规范化档案 file 字段：string | string[] → 非空相对路径数组。
   * 数组按**声明顺序**保留（即合并顺序）；空串、非字符串项忽略；其它类型视为未配置。
   * 路径规则与单个 file 一致：相对会话 cwd（由 fs.resolve(rel, { cwd }) 解析）。
   */
  function normalizeFiles(raw) {
    if (typeof raw === 'string') {
      const one = raw.trim()
      return one.length > 0 ? [one] : []
    }
    if (Array.isArray(raw)) {
      const out = []
      for (const item of raw) {
        if (typeof item === 'string' && item.trim().length > 0) out.push(item.trim())
      }
      return out
    }
    return []
  }

  /**
   * 解析工作区 .deepseek.yaml 的 workspace 段——**唯一读盘入口**：
   * 档案列表与开场白覆盖共用一次解析，避免同一会话重复读同一文件。
   * @returns { profiles, globalPrompt }（globalPrompt 为 null 表示未配置或值无效）
   */
  async function loadWorkspace(cwd) {
    const target = await fs.resolve('.deepseek.yaml', { cwd })
    const text = await fs.readText(target)
    const parsed = parseYaml(text)
    const ws = parsed && parsed.workspace && typeof parsed.workspace === 'object' ? parsed.workspace : {}
    const prompts = ws.system_prompts && typeof ws.system_prompts === 'object' ? ws.system_prompts : null
    const profiles = prompts === null ? [] : Object.keys(prompts)
      .map((name) => {
        const entry = prompts[name]
        if (!entry || typeof entry !== 'object') return null
        const files = normalizeFiles(entry.file)
        if (files.length === 0) return null // 无有效 file（缺失/空串/空数组）→ 不是可用档案
        return {
          name,
          // 显示名：档案子项可选 name 字段；缺省回退为档案 key（下拉框显示 profile-<title>）
          title: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : name,
          // file 向后兼容旧消费者：单文件=字符串，多文件=数组
          file: files.length === 1 ? files[0] : files,
          // files 恒为字符串数组：多文件档案按此顺序合并
          files,
          parameters: entry.parameters && typeof entry.parameters === 'object' ? entry.parameters : {},
        }
      })
      .filter((p) => p !== null)
    // 工作区级开场白覆盖：非空字符串才是有效配置（YAML 空值/非字符串一律当未配置）
    const raw = ws.global_prompt
    const globalPrompt = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null
    return { profiles, globalPrompt }
  }

  /**
   * 档案正文：按 profile.files 的声明顺序逐个读盘 + 占位符替换，再用**空行**合并为一段。
   * 任一文件读不到就整体失败（抛错，由 activate 捕获成红字）——避免静默注入「半个档案」，
   * 错误信息带档案名、序号与文件名，便于直接定位配置笔误。
   */
  async function profileText(profile, cwd) {
    const files = profile.files
    const parts = []
    for (let i = 0; i < files.length; i++) {
      let raw
      try {
        const target = await fs.resolve(files[i], { cwd })
        raw = await fs.readText(target)
      } catch (err) {
        throw new Error('档案「' + profile.name + '」的第 ' + (i + 1) + '/' + files.length + ' 个提示词文件读取失败: '
          + files[i] + '（工作区 ' + cwd + '）: ' + String((err && err.message) || err))
      }
      parts.push(substitute(raw, cwd))
    }
    const body = parts.join('\n\n')
    return '【当前会话已通过界面选择 .deepseek.yaml 提示词档案「' + profile.name + '」，以下为该档案的完整指令，请以其中的角色设定与任务要求为准执行】\n\n' + body
  }

  /**
   * 卸载本会话已注册的开场白覆盖：disposer + forceCleanSection 双保险。
   *
   * ⚠️ disposer 在真实运行时可能静默失效（见 README §六-3），因此「未配置 / 文件不存在 /
   * 文件为空」这些**不覆盖**分支也必须走这里——否则旧的 harness:identity 会残留在 agent
   * 作用域继续覆盖 DSH 默认开场白，出现「配置已删、覆盖仍在」的状态不一致。
   * 只清 scoped 层：global 层那份是 DSH 自带开场白，永远不动（见 §六-10）。
   * @returns 实际清掉的残留 section 数
   */
  function unapplyIdentity(sessionId) {
    const prev = identity.get(sessionId)
    if (!prev) return 0
    let cleaned = 0
    try { prev.disposer() } catch (e) { /* noop */ }
    try {
      if (prev.sp && prev.agent) cleaned = forceCleanSection(prev.sp, prev.agent, IDENTITY_SECTION)
    } catch (e) { /* noop */ }
    identity.delete(sessionId)
    return cleaned
  }

  /**
   * 工作区开场白覆盖：把 .deepseek.yaml 的 workspace.global_prompt 指向文件的正文，
   * 以同名 harness:identity 注册进该会话的 agent 作用域，**完全替换** DSH 默认的
   * "You are an AI agent powered by DeepSeek Harness."。
   *
   * 设计要点：
   * 1. 与档案（system_prompts）解耦——不依赖下拉框选择，agent/created 时对每个会话
   *    自动执行（新建 / 冷恢复 / 重启后重连 / compact / clear 全覆盖）；
   * 2. **未配置就不覆盖**：global_prompt 键缺失 / 值非字符串或为空 / 指向的文件读取失败 /
   *    文件内容为空——四种情况一律先 unapplyIdentity() 卸载已有覆盖，再返回 applied:false，
   *    保留 DSH 默认开场白（只 warn，不阻断会话创建）；
   * 3. 幂等：成功路径也是先卸载旧注册（同一 sessionId 在 compact/clear 后会换 agent 对象），
   *    再 forceCleanSection 兜底，最后注册；
   * 4. 失败绝不抛出（不阻断会话创建），返回 error 供调用方 warn。
   * @returns { applied, file, cleaned, error }
   */
  async function applyIdentity(agent, sessionId, explicitCwd) {
    const cwd = agentCwd(agent) || sessionCwd(sessionId, explicitCwd)
    if (!cwd) return { applied: false, file: null, cleaned: 0, error: '会话工作区未就绪（无法解析 cwd）' }
    let rel
    try {
      rel = (await loadWorkspace(cwd)).globalPrompt
    } catch (err) {
      const cleaned = unapplyIdentity(sessionId)
      return { applied: false, file: null, cleaned, error: '读取 .deepseek.yaml 失败: ' + String((err && err.message) || err) }
    }
    // 未配置（键缺失 / 值非字符串 / 空值）→ 不覆盖：卸载残留注册，保留 DSH 默认开场白
    if (!rel) return { applied: false, file: null, cleaned: unapplyIdentity(sessionId), error: null }
    let text
    try {
      const target = await fs.resolve(rel, { cwd })
      text = substitute(await fs.readText(target), cwd).trim()
    } catch (err) {
      const cleaned = unapplyIdentity(sessionId)
      const msg = 'global_prompt 文件读取失败: ' + rel + '（工作区 ' + cwd + '）'
      warn(msg + ' — ' + String((err && err.message) || err))
      return { applied: false, file: rel, cleaned, error: msg }
    }
    if (text.length === 0) {
      return { applied: false, file: rel, cleaned: unapplyIdentity(sessionId), error: 'global_prompt 文件为空，保留 DSH 默认开场白' }
    }
    let sp
    try {
      sp = agent.ctx.systemPrompt
    } catch (e) {
      return { applied: false, file: rel, cleaned: 0, error: String((e && e.message) || e) }
    }
    if (!sp) return { applied: false, file: rel, cleaned: 0, error: '目标会话无 systemPrompt 服务' }
    // 注册前先卸载旧注册（含 forceCleanSection 兜底），再清一次当前层残留，最后注册
    const cleaned = unapplyIdentity(sessionId) + forceCleanSection(sp, agent, IDENTITY_SECTION)
    try {
      const disposer = sp.section({ name: IDENTITY_SECTION, order: IDENTITY_ORDER, text })
      identity.set(sessionId, { disposer, sp, agent, file: rel })
      return { applied: true, file: rel, cleaned, error: null }
    } catch (err) {
      const msg = '注册 ' + IDENTITY_SECTION + ' 覆盖失败: ' + String((err && err.message) || err)
        + ' [diag: ' + sectionDiag(sp, agent, IDENTITY_SECTION) + ']'
      warn(msg)
      return { applied: false, file: rel, cleaned, error: msg }
    }
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
    const profiles = (await loadWorkspace(cwd)).profiles
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
    const removed = forceCleanSection(sp, agent, SECTION_NAME)
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
      if (!cwd) return { profiles: [], globalPrompt: null, error: '会话工作区未就绪（无法解析 cwd，sessionId=' + (args && args.sessionId) + '）', cwd: null }
      const ws = await loadWorkspace(cwd)
      return { profiles: ws.profiles, globalPrompt: ws.globalPrompt, cwd }
    } catch (err) {
      return { profiles: [], globalPrompt: null, error: String((err && err.message) || err), cwd: null }
    }
  }))

  handles.push(rpc.handle(rpcPrefix + '.state', async (args) => {
    const sessionId = args && args.sessionId
    const entry = sessionId ? active.get(sessionId) : undefined
    // pending（延迟激活）中的档案也算当前选中，保证下拉框/单档案展示不跳回默认
    const queued = sessionId ? pending.get(sessionId) : undefined
    // globalPath：本会话实际生效的 global_prompt（null = 未覆盖，用 DSH 默认开场白）
    const ident = sessionId ? identity.get(sessionId) : undefined
    return {
      active: entry ? entry.profileName : (queued ? queued.profile : null),
      globalPrompt: ident ? ident.file : null,
    }
  }))

  // 延迟激活 + 工作区开场白覆盖：会话 agent 发布（新会话首次 prompt / 冷会话恢复 /
  // DSH 重启后重连 / compact / clear 换 agent 对象）时触发。
  // 事件形状：'agent/created'(this: Scoped<Agent>, payload: { agent, source, signal })
  // 由 ctx.serial 串行派发并 await，故此处可安全 await 读盘。
  const stopCreated = ctx.on('agent/created', async ({ agent }) => {
    const sessionId = agent && agent.id
    if (!sessionId) return
    // 1) 开场白覆盖——与档案选择无关，每个会话都要做（失败不影响会话创建）
    try {
      const applied = await applyIdentity(agent, sessionId)
      if (applied && applied.error) warn('会话 ' + sessionId + ' 开场白覆盖未生效: ' + applied.error)
    } catch (err) {
      warn('会话 ' + sessionId + ' 开场白覆盖异常: ' + String((err && err.message) || err))
    }
    // 2) 延迟激活：应用排队中的档案
    const req = pending.get(sessionId)
    if (!req) return
    pending.delete(sessionId)
    return enqueue(sessionId, async () => {
      try {
        await applyActivation(agent, sessionId, req.profile, req.cwd)
      } catch (err) {
        warn('延迟激活失败: ' + String((err && err.message) || err))
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
        // 切档案时顺手重读 global_prompt：用户改了 .deepseek.yaml 后无需重启 DSH
        const ident = await applyIdentity(agent, sessionId, explicitCwd)
        const result = await applyActivation(agent, sessionId, name, explicitCwd)
        return Object.assign({}, result, { globalPrompt: ident && ident.applied ? ident.file : null })
      } catch (err) {
        const msg = String((err && err.message) || err)
        let extra = ''
        try {
          const agent = agents.get(sessionId)
          const sp = agent && agent.ctx ? agent.ctx.systemPrompt : undefined
          extra = ' [diag: ' + sectionDiag(sp, agent, SECTION_NAME) + ']'
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
        if (entry.sp && entry.agent) forceCleanSection(entry.sp, entry.agent, SECTION_NAME)
      } catch (e) { /* noop */ }
    }
    active.clear()
    pending.clear()
    for (const entry of identity.values()) {
      try { entry.disposer() } catch (e) { /* noop */ }
      try {
        if (entry.sp && entry.agent) forceCleanSection(entry.sp, entry.agent, IDENTITY_SECTION)
      } catch (e) { /* noop */ }
    }
    identity.clear()
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