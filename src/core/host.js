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
 * 关键机制（勿随意改动，详见 internals.md）：
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
 *    （见 normalizeFiles / profileText）；
 * 8. 子代理会话（header.origin === 'subagent'）的档案继承：agent/created 时按父会话
 *    （header.parentSession）当前档案注入，父无选择回退 default。子代理没有自己的 UI
 *    入口（one-shot 子代理会话连输入区都不存在），档案只能由 Host 侧注入——DSH 的
 *    scope 链不继承父 agent 的层，所以父会话已选档案不会自动落到子代理身上（internals.md）；
 * 9. 未激活会话**一律排队**（pending）而不是报红字：sessionExists() 仅供日志诊断。
 *    它过去用 snapshot.id 匹配，而 SessionPersistenceSnapshot 的 id 在 header.id 上，
 *    恒 false → 子代理会话被误判为「不存在」，唯一一次自动加载被吞（internals.md）。
 * 10. persona 段覆盖（workspace.persona_prompt / workspace.persona_clear）：以
 *    `system-prompt/assemble` 监听器（挂在会话 agent 作用域）改写 preset 的
 *    `deployment:persona-prefix` 段——该槽位在 agent 层**已有 owner**（preset 的
 *    `@deepseek-ai/dsh-persona` 行），同层同名 section 重复注册会抛错，所以只能改写装配
 *    结果，不能靠 shadow（与第 6 条的开场白覆盖路径不同）。⚠️ 用最强机制的代价：必须原样
 *    透传 tools/contexts/variables，且**绝不吞 next() 的异常**（internals.md）。
 *    默认行为 = **清空**（连 `.deepseek.yaml` 都没有的工作区也一样）；要保留 preset 原句需显式写
 *    `persona_clear: false`，要换成自己的话用 `persona_prompt`（见 internals.md / features.md）。
 */
import { parseYaml } from './yaml.js'

/** Host 半区 apply 函数体：执行全部注册逻辑。 */
export function hostCore(ctx, opts, rpc) {
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
  /**
   * DSH 部署级 persona 段名（SECTION_ORDERS.DEPLOYMENT_PERSONA_PREFIX = 0，即
   * "You are a coding agent powered by the {{model}} model." 那一句所在段）。
   *
   * 与开场白的关键差异：该段在 agent 层的槽位**已有 owner**——preset 的
   * `@deepseek-ai/dsh-persona` 行就在该作用域注册同名 section；而 systemPrompt 的
   * section() 用 NamedEntries 保证**同层名字唯一**（重复注册抛
   * `prompt section "..." is already registered in this scope`），所以覆盖它**不能**
   * 走同名 shadow，只能在装配结果上改写（见 installPromptOverride）。DSH 自己也是靠
   * 「两边同名」让 preset 顶掉部署级那份的，本插件不能挤进去抢这个槽位。
   */
  const PERSONA_SECTION = 'deployment:persona-prefix'
  const rpcPrefix = opts.rpcPrefix
  // sessionId -> { profileName, disposer, disposeTemp, temperature, sp, agent }
  const active = new Map()
  // sessionId -> { disposer, sp, agent, file }：global_prompt 覆盖的当前注册
  const identity = new Map()
  // sessionId -> { disposer, agent }：persona 段装配监听器的当前挂载（见 internals.md）
  const persona = new Map()
  // 一次性告警键：persona 覆盖在**每次装配**都会求值，同一问题只提醒一次，避免每步刷屏
  const warnedOnce = new Set()
  // sessionId -> 已解析的会话 cwd（缓存：切换对话时 agent 可能短暂未就绪/被 dispose，
  // 缓存避免回退到部署级根去读错误的 .deepseek.yaml——见 internals.md）
  const cwdCache = new Map()
  // sessionId -> { profile, cwd } 待激活档案：会话存在但 agent 尚未激活
  // （新会话空白期 / 冷会话 / DSH 重启后会话未恢复）时暂存，agent/created 后自动应用。
  // 见 internals.md「激活延迟」。
  const pending = new Map()
  // 会话级串行队列：保证同一会话的 activate 顺序执行，杜绝注册竞态
  const chains = new Map()
  const handles = []

  /** 统一告警出口：logger 缺失或抛错都不影响主流程。 */
  function warn(message) {
    try { if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('[dsh-profile-selector] ' + message) } catch (e) { /* noop */ }
  }

  /**
   * 同 key 只告警一次（key 通常含 cwd / 文件名）。
   * persona 覆盖的求值发生在**每次装配**上，同一配置问题不去重会每个模型步刷一条日志。
   */
  function warnOnce(key, message) {
    if (warnedOnce.has(key)) return
    warnedOnce.add(key)
    warn(message)
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
   * 档案列表、开场白覆盖与 persona 段覆盖共用一次解析，避免同一会话重复读同一文件。
   * @returns { profiles, globalPrompt, personaPrompt, personaClear }
   *   （globalPrompt / personaPrompt 为 null 表示未配置或值无效）
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
    // 工作区级 persona 段覆盖（见 internals.md / features.md）：
    //   persona_prompt: <path>   用该文件正文**替换** preset 的 persona 段
    //   persona_clear:  true     显式**清空**（text 写空串，渲染时被丢弃）——同时也是**默认行为**
    //   persona_clear:  false    显式**不改写**（保留 preset 原有的 persona 句）
    // ⚠️ 与上面 global_prompt 的语义不同：global_prompt 是「空值 / 空文件即未配置、不覆盖」；
    // 本功能默认就是「清空」，所以 clear 用**三态**表达：true / false / null（未配置 → 走默认清空）。
    const rawPersona = ws.persona_prompt
    const personaPrompt = typeof rawPersona === 'string' && rawPersona.trim().length > 0 ? rawPersona.trim() : null
    const rawClear = ws.persona_clear
    const personaClear = rawClear === true ? true : (rawClear === false ? false : null)
    return { profiles, globalPrompt, personaPrompt, personaClear }
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
   * ⚠️ disposer 在真实运行时可能静默失效（见 internals.md），因此「未配置 / 文件不存在 /
   * 文件为空」这些**不覆盖**分支也必须走这里——否则旧的 harness:identity 会残留在 agent
   * 作用域继续覆盖 DSH 默认开场白，出现「配置已删、覆盖仍在」的状态不一致。
   * 只清 scoped 层：global 层那份是 DSH 自带开场白，永远不动（见 internals.md）。
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
   * 求值 persona 段覆盖：读 .deepseek.yaml 的 `persona_prompt` / `persona_clear`，
   * 需要时把替换源文件读盘并做占位符替换。
   *
   * **默认清空**：没有 `.deepseek.yaml`、或两键都缺省，都按「清空」处理——只有显式
   * `persona_clear: false` 才保留 preset 原有的 persona 句。
   *
   * 优先级（同一张表见 features.md）：
   *   1. `persona_clear: true`                       → 清空（优先于 `persona_prompt`）
   *   2. `persona_prompt: <path>`                    → 用该文件正文替换（读不到 → 不改写 + 一次性 warn）
   *   3. `persona_clear: false`（且无 `persona_prompt`）→ 不改写（保留 preset 原句）
   *   4. 其余（两键都缺省 / 读不到 `.deepseek.yaml`）  → **清空**（默认行为）
   *
   * **每次装配都重新调用**（不缓存）——这样切档案、改 `.deepseek.yaml`、改替换源文件
   * 之后都无需重启 DSH，也无需重挂监听器；代价是每个模型步两次小文件读。
   * 本函数**绝不抛错**：只有「显式指定了替换源却读不到」才退回「不改写」并 warn 一条。
   *
   * @returns { text: string } —— 要写进 persona 段的文本（'' = 清空）
   *          或 null —— 不改写
   */
  async function resolvePersonaText(cwd) {
    let ws = null
    try {
      ws = await loadWorkspace(cwd)
    } catch (err) {
      // 缺 .deepseek.yaml 是常态（很多工作区根本没有该文件）→ 按默认清空处理，不告警
      return { text: '' }
    }
    if (ws.personaClear === true) return { text: '' }
    if (ws.personaPrompt) {
      try {
        const target = await fs.resolve(ws.personaPrompt, { cwd })
        return { text: substitute(await fs.readText(target), cwd).trim() }
      } catch (err) {
        warnOnce('prompt:' + cwd + ':' + ws.personaPrompt, 'persona_prompt 文件读取失败（本次不改写，保留 preset 原有 persona）: '
          + ws.personaPrompt + '（工作区 ' + cwd + '）: ' + String((err && err.message) || err))
        return null
      }
    }
    if (ws.personaClear === false) return null
    return { text: '' }   // 两键都缺省 → 默认清空
  }

  /**
   * 在 agent 作用域挂 `system-prompt/assemble` 监听器，改写 persona 段（internals.md）。
   *
   * 为什么必须用这个最强机制：persona 槽位在 agent 层已有 owner（preset 的 dsh-persona 行），
   * 同层同名注册会抛错（见 PERSONA_SECTION 注释），所以只能改写装配结果。
   *
   * 三条自律（internals.md）：
   *   1. 只改 sections —— tools / contexts / variables 原样透传（改坏 tools 会毁掉工具 schema，
   *      丢掉 contexts 会丢工作目录等运行时上下文，覆盖 variables 会打断 dsh-agent 在监听器里
   *      做的 provider/model 捕获）；
   *   2. **绝不 try/catch 掉 next() 的异常** —— 官方 waterfall 由框架调度，抛错会被上游正确处理；
   *      一旦自行吞掉异常再返回空 assembly（sections: [] / tools: []），下游对 sections 的处理会崩，
   *      用户侧表现为「任务做到一半像换了个人」「状态存不下来」这类极难定位的故障；
   *   3. 只改 text（以及按需整段删除）—— 不动 name / order，排序交给框架，避免与其它插件争位置。
   *
   * @returns disposer，或 null（该 agent 没有可挂的 ctx）
   */
  function installPromptOverride(agent, sessionId) {
    let agentCtx
    try {
      agentCtx = agent && agent.ctx
    } catch (e) {
      return null
    }
    if (!agentCtx || typeof agentCtx.on !== 'function') return null
    // 段名漂移诊断：命中 0 次只报一条（DSH 若给段改名，改写会静默落空，见 internals.md 风险表）
    let missedReported = false
    return agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next()
      // ★ 注意：next() 之后没有任何 try/catch —— 见上面第 2 条自律
      let cwd
      try {
        cwd = agentCwd(agent) || sessionCwd(sessionId)
      } catch (e) {
        cwd = null
      }
      if (!cwd) return assembled
      const override = await resolvePersonaText(cwd)
      // 只有显式 persona_clear: false（且无替换源）才走 null → 不改写；其余都拿到要写入的文本
      if (!override || !assembled || !Array.isArray(assembled.sections)) return assembled
      let hits = 0
      const sections = assembled.sections.map((section) => {
        if (!section || section.name !== PERSONA_SECTION) return section
        hits++
        // 到装配阶段 text 已是解析后的字符串（assemble() 里对函数式 text 已调用过一次），
        // 直接赋新串是安全的；空串会在 renderPrompt 的 length 过滤里消失（= 没有这段），
        // 注意别写空格（" " 长度为 1 会被保留，反而多出一个空段落）。
        return { ...section, text: override.text }
      })
      if (hits === 0) {
        if (!missedReported) {
          missedReported = true
          warnOnce('miss:' + sessionId, '装配结果里没有 ' + PERSONA_SECTION + ' 段（DSH 段名变更或该 preset 未挂 persona 行）'
            + '—— persona_prompt / persona_clear 未生效，会话 ' + sessionId)
        }
        return assembled
      }
      return { ...assembled, sections }
    })
  }

  /**
   * persona 段覆盖的挂载入口：先释放该会话的旧监听器（幂等，compact / clear 换 agent 对象后重挂），
   * 再挂到新 agent 的 ctx 上。**不做配置预检**——监听器每次装配自行求值，
   * 因此这里只在 agent/created 时调用一次即可覆盖该会话的全部后续装配。
   * 失败绝不抛出（不阻断会话创建），返回 error 供调用方 warn。
   * @returns { installed, error }
   */
  function applyPersona(agent, sessionId) {
    unapplyPersona(sessionId)
    let disposer
    try {
      disposer = installPromptOverride(agent, sessionId)
    } catch (err) {
      const msg = '挂 ' + PERSONA_SECTION + ' 装配监听器失败: ' + String((err && err.message) || err)
      warn(msg)
      return { installed: false, error: msg }
    }
    if (!disposer) return { installed: false, error: '目标会话无 agent.ctx（无法挂装配监听器）' }
    persona.set(sessionId, { disposer, agent })
    return { installed: true, error: null }
  }

  /** 释放某会话的 persona 装配监听器（disposer 失效也不影响后续重挂，见 internals.md）。 */
  function unapplyPersona(sessionId) {
    const prev = persona.get(sessionId)
    if (!prev) return
    try { prev.disposer() } catch (e) { /* noop */ }
    persona.delete(sessionId)
  }

  /**
   * 判断会话是否真实存在（内存会话表或持久化列表）。
   * 用途：activate 在 agent 未激活时区分「会话不存在」（真错误）与
   * 「会话存在但 agent 尚未激活」（延迟激活）——见 internals.md。
   * 查询失败时按「存在」处理：宁可延迟激活，也不误报红字。
   */
  async function sessionExists(sessionId) {
    try {
      const sessionsSvc = ctx.get('sessions')
      if (sessionsSvc && sessionsSvc.get(sessionId)) return true
      const persistence = ctx.get('sessionPersistence')
      if (persistence && typeof persistence.list === 'function') {
        const list = await persistence.list()
        // ⚠️ SessionPersistenceSnapshot 的会话标识在 **snapshot.header.id** 上，顶层没有 id
        // （见 @deepseek-ai/dsh-session-persistence 的 SessionPersistenceSnapshot）。
        // 旧写法 list.some((h) => h.id === sessionId) 恒为 false，会把「已存在但未激活」的
        // 会话（典型是子代理会话）误判成「会话不存在」，直接报红字并让延迟激活失效
        // ——见 internals.md。这里同时兼容 header.id 与旧形态的顶层 id。
        return Array.isArray(list) && list.some((s) => {
          const id = s && s.header ? s.header.id : (s && s.id)
          return id === sessionId
        })
      }
      return false
    } catch (e) {
      return true
    }
  }

  /** 从持久化记录里读会话 cwd（内存 agent/session 都没有时的最后兜底）。 */
  async function persistedCwd(sessionId) {
    try {
      const persistence = ctx.get('sessionPersistence')
      if (!persistence || typeof persistence.list !== 'function') return null
      const list = await persistence.list()
      if (!Array.isArray(list)) return null
      const hit = list.find((s) => {
        const id = s && s.header ? s.header.id : (s && s.id)
        return id === sessionId
      })
      const cwd = hit && hit.header ? hit.header.cwd : null
      return typeof cwd === 'string' && cwd.length > 0 ? cwd : null
    } catch (e) {
      return null
    }
  }

  /**
   * RPC 用 cwd 解析：内存路径（显式传入 / 缓存 / agent header）失败后，
   * 再查一次持久化记录。子代理会话未驻留（已结束、非 resident）时只有这条路能拿到
   * cwd——它就是 header 里父会话的 cwd（见 DSH childSessionMeta）。
   */
  async function resolveCwd(sessionId, explicitCwd) {
    const direct = sessionCwd(sessionId, explicitCwd)
    if (direct) return direct
    const stored = sessionId ? await persistedCwd(sessionId) : null
    if (stored) {
      cwdCache.set(sessionId, stored)
      return stored
    }
    return null
  }

  /** header.origin === 'subagent' 的会话即子代理会话（DSH childSessionMeta 写入）。 */
  function isSubagentSession(agent) {
    try {
      const header = agent && agent.session && agent.session.header
      return !!(header && header.origin === 'subagent')
    } catch (e) {
      return false
    }
  }

  /** 子代理会话的父会话 id（header.parentSession，DSH childSessionMeta 写入）。 */
  function parentSessionOf(agent) {
    try {
      const header = agent && agent.session && agent.session.header
      const parent = header && header.parentSession
      return typeof parent === 'string' && parent.length > 0 ? parent : null
    } catch (e) {
      return null
    }
  }

  /**
   * 子代理会话应使用的档案：**父会话当前选择优先**，父无选择则回退 default，
   * 无 default 再用首个可用档案；工作区没有可用档案时返回 name:null（跳过注入）。
   * @returns { name: string|null, source: 'parent'|'default'|'none' }
   */
  async function inheritedProfile(parentSessionId, cwd) {
    const parentChoice = (parentSessionId ? active.get(parentSessionId) : undefined)
      || (parentSessionId ? pending.get(parentSessionId) : undefined)
    const chosen = parentChoice ? (parentChoice.profileName || parentChoice.profile) : null
    if (chosen) return { name: chosen, source: 'parent' }
    const profiles = (await loadWorkspace(cwd)).profiles
    if (profiles.length === 0) return { name: null, source: 'none' }
    const fallback = profiles.some((p) => p.name === 'default') ? 'default' : profiles[0].name
    return { name: fallback, source: 'default' }
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
      const cwd = await resolveCwd(args && args.sessionId, args && args.cwd)
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

  // 延迟激活 + 工作区开场白覆盖 + persona 段覆盖：会话 agent 发布（新会话首次 prompt /
  // 冷会话恢复 / DSH 重启后重连 / compact / clear 换 agent 对象）时触发。
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
    // 2) persona 段覆盖：挂装配监听器（工作区级清空/替换，见 internals.md）。
    //    与 1) 一样与档案选择解耦；配置求值在监听器内每次装配重做，故此处只在 agent
    //    发布时挂一次。放在 pending 分支**之前**：排队档案会提前 return，但 persona
    //    覆盖与档案无关，必须照挂。
    try {
      const pinned = applyPersona(agent, sessionId)
      if (!pinned.installed) warn('会话 ' + sessionId + ' persona 段覆盖未挂载: ' + pinned.error)
    } catch (err) {
      warn('会话 ' + sessionId + ' persona 段覆盖异常: ' + String((err && err.message) || err))
    }
    // 3) 延迟激活：应用排队中的档案（**优先于**下面的子代理继承——那是 UI/调用方的显式选择）
    const req = pending.get(sessionId)
    if (req) {
      pending.delete(sessionId)
      return enqueue(sessionId, async () => {
        try {
          await applyActivation(agent, sessionId, req.profile, req.cwd)
        } catch (err) {
          warn('延迟激活失败: ' + String((err && err.message) || err))
        }
      })
    }
    // 4) 子代理会话的档案继承：子代理没有自己的界面入口（one-shot 子代理会话连输入区都不
    //    存在，见 internals.md），档案只能由 Host 侧在 agent/created 时注入。目标档案取
    //    父会话当前选择，父无选择回退 default。注册只作用于该子代理自己的 agent 作用域
    //    （DSH 的 scope 链不继承父 agent 的层，因此父会话已选档案不会自动落到子代理身上）。
    if (!isSubagentSession(agent)) return
    try {
      const cwd = agentCwd(agent) || sessionCwd(sessionId)
      if (!cwd) return
      cwdCache.set(sessionId, cwd)
      const pick = await inheritedProfile(parentSessionOf(agent), cwd)
      if (!pick.name) return
      await enqueue(sessionId, async () => {
        try {
          const applied = await applyActivation(agent, sessionId, pick.name, cwd)
          if (!applied.ok) warn('子代理会话 ' + sessionId + ' 档案继承失败: ' + applied.error)
        } catch (err) {
          warn('子代理会话 ' + sessionId + ' 档案继承异常: ' + String((err && err.message) || err))
        }
      })
    } catch (err) {
      warn('子代理会话 ' + sessionId + ' 档案继承异常: ' + String((err && err.message) || err))
    }
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
          // agent 尚未激活：新会话空白期 / 冷会话 / DSH 重启后未恢复 / **子代理会话未驻留**。
          // 一律走延迟激活：暂存档案，agent/created（或冷恢复续话）后自动应用。
          // ⚠️ 绝不在这里回「会话不存在或未激活」红字：子代理会话不驻留、且
          // sessionPersistence 的匹配口径曾经写错（见 sessionExists 注释与 internals.md），
          // 误判会把唯一一次自动加载吞掉（客户端 autoFired 只触发一次）。
          if (name) pending.set(sessionId, { profile: name, cwd: explicitCwd })
          else pending.delete(sessionId)
          if (!(await sessionExists(sessionId))) {
            warn('会话 ' + sessionId + ' 未激活且查不到持久化记录：档案「' + (name || '空') + '」已排队，待 agent 创建后应用')
          }
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
    for (const entry of persona.values()) {
      try { entry.disposer() } catch (e) { /* noop */ }
    }
    persona.clear()
    warnedOnce.clear()
    for (const d of handles) {
      try { d() } catch (e) { /* noop */ }
    }
  })
}