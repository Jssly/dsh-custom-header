/**
 * dsh-profile-selector — 离线验证脚本（无需 DSH 运行时）
 *
 * 覆盖六块：
 *   A. 真实 .deepseek.yaml 结构守护（不写死档案名/文件名）+ 迷你 YAML 解析器（block sequence 与既有 map/标量行为）
 *   B. 档案 file 支持 string | string[]：按声明顺序合并、任一文件缺失即整体失败
 *   C. workspace.global_prompt：未配置 / 文件不存在 / 文件为空 → 不覆盖并清理残留
 *   D. 既有行为回归：单文件档案、temperature 注入、幂等、pending 延迟激活
 *   E. 子代理会话档案继承（继承父会话档案 / 回退 default / 不注入普通会话 / 显式优先）+ 未激活会话排队语义
 *      （sessionPersistence 快照按 header.id 匹配、cwd 兜底、不报红字）——见 internals.md
 *   F. workspace.persona_prompt / persona_clear：`system-prompt/assemble` 监听器改写
 *      `deployment:persona-prefix` 段（**默认清空** / 显式 clear:false 才保留 / 替换 /
 *      无 .deepseek.yaml 也清空 / 每次装配重新求值 / 只改 sections / 异常不吞 / 段名落空诊断）
 *      ——见 internals.md
 *
 * 维护须知：对**工作区真实配置**的断言只做结构守护（用户可随时增删档案、改 file 写法）；真实读盘路径
 * 由 A4-A6 用 realFs 端到端覆盖。历史教训：旧 A1-A3 写死了档案名与文件名，2026-09-15 配置改写后即整体失效。
 *
 * 用法：node scripts/verify-offline.mjs   （全部通过则退出码 0）
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseYaml } from '../src/core/yaml.js'
import { hostCore } from '../src/core/host.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SECTION = 'dsh-profile:profile'
const IDENTITY = 'harness:identity'
const PERSONA_SECTION = 'deployment:persona-prefix'

let passed = 0
const failures = []
function ok(name, cond, detail) {
  if (cond) { passed++; return }
  failures.push(name + (detail ? '  [' + detail + ']' : ''))
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
    'got=' + JSON.stringify(actual) + ' want=' + JSON.stringify(expected))
}
function today() {
  const d = new Date()
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

/* ---------------- mock 运行时（内存 fs + 假 ctx/agent） ---------------- */

function makeEnv(opts) {
  const o = opts || {}
  const files = Object.assign({}, o.files)
  const cwd = o.cwd || '/ws'
  const brokenDisposer = !!o.brokenDisposer
  // realFs=true：mock fs 未命中内存 files 时回退真实磁盘（用于「真实 .deepseek.yaml + 真实档案文件」守护）
  const realFs = !!o.realFs
  // sessions 内存表只认登记过的会话 id；persistence 模拟 sessionPersistence.list() 的快照数组
  const memSessions = new Set(o.memSessions || [])
  const persistence = o.persistence
  const logs = []
  const rpcHandlers = new Map()
  const listeners = new Map()
  const agents = new Map()

  const fs = {
    async resolve(rel, args) {
      const base = (args && args.cwd) || cwd
      return rel.startsWith('/') ? rel : base.replace(/\/+$/, '') + '/' + rel
    },
    async readText(target) {
      if (Object.prototype.hasOwnProperty.call(files, target)) return files[target]
      if (realFs) {
        try { return readFileSync(target, 'utf8') } catch (e) { throw new Error('ENOENT: ' + target) }
      }
      throw new Error('ENOENT: ' + target)
    },
  }
  const ctx = {
    get(name) {
      if (name === 'fs') return fs
      if (name === 'sandboxPolicy') return { workspaceRoot: '/deploy-root' }
      if (name === 'agents') return { get: (id) => agents.get(id) }
      if (name === 'sessions') return { get: (id) => (memSessions.has(id) ? { id } : undefined) }
      if (name === 'sessionPersistence') {
        return persistence === undefined ? undefined : { list: async () => persistence }
      }
      return undefined
    },
    logger: { warn: (m) => logs.push(String(m)) },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
      return () => {}
    },
  }
  hostCore(ctx, { sectionName: SECTION, rpcPrefix: 'dshprofile' }, {
    handle(method, handler) {
      rpcHandlers.set(method, handler)
      return () => rpcHandlers.delete(method)
    },
  })

  /** 登记一个已激活 agent；headerExtra 可带 origin/parentSession（子代理会话血缘）。 */
  function makeAgent(sessionId, headerExtra) {
    const scoped = new Map()
    const global = new Map()
    global.set(IDENTITY, { name: IDENTITY, order: -1000, text: 'You are an AI agent powered by DeepSeek Harness.' })
    const layers = {
      scoped: new Map(),
      global: { sections: { data: global, has: (n) => global.has(n), delete: (n) => global.delete(n) } },
    }
    const requestHandlers = []
    // system-prompt/assemble 监听器（persona 段覆盖走这条路，见 F 组 / internals.md）
    const assembleHandlers = []
    const sp = {
      layers,
      section(spec) {
        scoped.set(spec.name, { name: spec.name, order: spec.order, text: spec.text })
        // 真实运行时 disposer 可能静默失效（internals.md）：用 brokenDisposer 复现
        return () => { if (!brokenDisposer) scoped.delete(spec.name) }
      },
    }
    const agent = {
      id: sessionId,
      session: { header: Object.assign({ cwd }, headerExtra || {}) },
      ctx: {
        systemPrompt: sp,
        assembleHandlers,
        on(event, fn) {
          const bucket = event === 'agent/request' ? requestHandlers
            : event === 'system-prompt/assemble' ? assembleHandlers
              : null
          if (bucket) bucket.push(fn)
          // 真实 disposer 会移除监听器；不可用的情形由 brokenDisposer 单独复现（见 C 组）
          return () => {
            if (!bucket) return
            const i = bucket.indexOf(fn)
            if (i >= 0) bucket.splice(i, 1)
          }
        },
      },
    }
    layers.scoped.set(agent, { sections: { data: scoped } })
    agents.set(sessionId, agent)
    return { agent, scoped, global, requestHandlers, assembleHandlers }
  }

  async function created(agent) {
    for (const h of (listeners.get('agent/created') || [])) await h({ agent })
  }
  /**
   * 模拟一次 system-prompt/assemble 瀑布（DSH 的 scope 过滤在这里等价于「只跑该 agent
   * 自己 ctx 上的监听器」）：按注册顺序调用，末端 next() 返回传入的 assembly。
   * opts.throwEnd=true 让**末端** next() 抛错，用于验证监听器不吞上游异常（F19）。
   */
  async function assemble(agent, assembly, opts) {
    const handlers = (agent && agent.ctx && agent.ctx.assembleHandlers) || []
    const throwEnd = !!(opts && opts.throwEnd)
    let i = -1
    const next = async () => {
      i++
      if (i < handlers.length) return handlers[i](assembly, { agent }, next)
      if (throwEnd) throw new Error('boom')
      return assembly
    }
    return next()
  }
  function rpc(method, args) {
    const h = rpcHandlers.get('dshprofile.' + method)
    if (!h) throw new Error('no rpc handler: ' + method)
    return h(args)
  }
  return { files, cwd, logs, makeAgent, created, assemble, rpc }
}

/* ---------------- A. YAML 解析 + 真实 .deepseek.yaml 守护 ---------------- */
{
  // ⚠️ 对真实配置只做**结构守护**，不写死档案名/文件名：工作区配置由用户随时增删档案、
  // 改 file 写法（2026-09-15 把 file 改成数组时，写死具体值的旧 A1-A3 就整体失效了——
  // 这正是本次修正的来源）。真实配置 + 真实档案文件的端到端解析由 A4-A6 覆盖。
  const raw = readFileSync(join(ROOT, '.deepseek.yaml'), 'utf8')
  const real = parseYaml(raw)
  const prompts = real.workspace && real.workspace.system_prompts
  ok('A1 真实 .deepseek.yaml：system_prompts 为非空对象',
    !!prompts && typeof prompts === 'object' && Object.keys(prompts).length > 0, JSON.stringify(prompts))
  ok('A2 真实 .deepseek.yaml：每个档案的 file 是 string | 非空 string[]',
    Object.values(prompts || {}).every((p) => (typeof p.file === 'string' && p.file.length > 0)
      || (Array.isArray(p.file) && p.file.length > 0 && p.file.every((f) => typeof f === 'string' && f.length > 0))),
    JSON.stringify(Object.values(prompts || {}).map((p) => p.file)))
  ok('A3 真实 .deepseek.yaml：global_prompt 若存在必为字符串',
    real.workspace.global_prompt === undefined || typeof real.workspace.global_prompt === 'string',
    JSON.stringify(real.workspace.global_prompt))

  const realEnv = makeEnv({
    cwd: ROOT,
    realFs: true,
    files: { [join(ROOT, '.deepseek.yaml')]: raw },
  })
  const realAgent = realEnv.makeAgent('real-1')
  const rp = await realEnv.rpc('profiles', { sessionId: 'real-1', cwd: ROOT })
  ok('A4 真实配置可解析出档案', !!rp && rp.profiles.length > 0 && !rp.error,
    JSON.stringify({ n: rp && rp.profiles.length, error: rp && rp.error }))
  ok('A5 每个档案的 files 与 file 形状一致（单文件=字符串 / 多文件=数组）',
    rp.profiles.every((p) => Array.isArray(p.files) && p.files.length > 0
      && (p.files.length === 1 ? p.file === p.files[0] : Array.isArray(p.file))),
    JSON.stringify(rp.profiles.map((p) => ({ file: p.file, files: p.files }))))
  const ra = await realEnv.rpc('activate', { sessionId: 'real-1', profile: rp.profiles[0].name, cwd: ROOT })
  ok('A6 真实档案正文读盘并注册 section',
    ra.ok === true && ((((realAgent.scoped.get(SECTION) || {}).text) || '').length > 0), JSON.stringify(ra))

  eq('A7 标量类型（数字/引号/布尔/null）', parseYaml('a: 1\nb: "q"\nc: true\nd: null\n'), { a: 1, b: 'q', c: true, d: null })
  eq('A8 缩进列表', parseYaml('a:\n  b:\n    - x\n    - y\n  c: 1\n'), { a: { b: ['x', 'y'], c: 1 } })
  eq('A9 零缩进列表（- 与 key 同缩进）', parseYaml('file:\n- a\n- b\nname: n\n'), { file: ['a', 'b'], name: 'n' })
  eq('A10 列表之后接同级 map 键', parseYaml('p:\n  file:\n    - f1\n    - f2\n  name: "t"\n'), { p: { file: ['f1', 'f2'], name: 't' } })
  eq('A11 空值键无子项仍为对象', parseYaml('a:\nb: 1\n'), { a: {}, b: 1 })
  eq('A12 注释与空行忽略', parseYaml('# c\n\na: 1\n\n'), { a: 1 })
  eq('A13 单文件（标量）仍是字符串', parseYaml('file: doc/prompts/dev.md\n'), { file: 'doc/prompts/dev.md' })

  // A14-A15：persona 段覆盖的真实配置守护——**不写死具体值**（用户可随时在
  // persona_prompt / persona_clear / 两者都不写 之间切换，断言跟着配置走）
  ok('A14 真实 .deepseek.yaml：persona_clear 若存在必为布尔、persona_prompt 若存在必为字符串',
    (real.workspace.persona_clear === undefined || typeof real.workspace.persona_clear === 'boolean')
    && (real.workspace.persona_prompt === undefined || typeof real.workspace.persona_prompt === 'string'),
    JSON.stringify([real.workspace.persona_clear, real.workspace.persona_prompt]))
  const personaPromptCfg = typeof real.workspace.persona_prompt === 'string' && real.workspace.persona_prompt.trim().length > 0
    ? real.workspace.persona_prompt.trim() : null
  // 与 src/core/host.js 的 resolvePersonaText() 同优先级：clear:true → 清空；有替换源 → 替换；
  // clear:false → 保留；两键都缺省 → **默认清空**
  const PERSONA_KEY = real.workspace.persona_clear === true ? 'clear'
    : personaPromptCfg ? 'prompt'
      : real.workspace.persona_clear === false ? 'keep' : 'clear'
  await realEnv.created(realAgent.agent)
  const realAssembly = { sections: [{ name: PERSONA_SECTION, order: 0, text: 'PRESET_PERSONA' }], contexts: [], tools: [], variables: {} }
  const realPersonaText = ((await realEnv.assemble(realAgent.agent, realAssembly)).sections[0] || {}).text
  let expectedPersona = ''            // clear 与「缺省 → 默认清空」都是空串
  if (PERSONA_KEY === 'keep') expectedPersona = 'PRESET_PERSONA'
  else if (PERSONA_KEY === 'prompt') {
    // 与 src/core/host.js 的 substitute() 同规则的独立复刻：档案/开场白/persona 正文共用这套占位符
    expectedPersona = readFileSync(join(ROOT, real.workspace.persona_prompt), 'utf8')
      .replace(/\{\{\s*date\s*\}\}/g, today())
      .replace(/\{workspace\}/g, ROOT)
      .replace(/\{dataDir\}/g, ROOT + '/output')
      .replace(/\{fileDir\}/g, ROOT + '/doc/ai')
      .trim()
  }
  ok('A15 真实配置下 persona 段装配结果与配置一致（' + PERSONA_KEY + '）',
    realPersonaText === expectedPersona,
    'got=' + JSON.stringify(realPersonaText) + ' want=' + JSON.stringify(expectedPersona))
}

/* ---------------- B. 档案 file 多文件合并 ---------------- */
{
  const env = makeEnv({
    files: {
      '/ws/.deepseek.yaml': 'workspace:\n  system_prompts:\n'
        + '    ai:\n      name: "分析师"\n      file:\n        - p/a.md\n        - p/b.md\n      parameters:\n        temperature: 0.2\n'
        + '    solo:\n      file: p/a.md\n'
        + '    empty:\n      file:\n        - ""\n        - 3\n',
      '/ws/p/a.md': 'AAA {{date}}',
      '/ws/p/b.md': 'BBB {workspace}',
    },
  })
  const { scoped } = env.makeAgent('s-merge')
  const p = await env.rpc('profiles', { sessionId: 's-merge', cwd: '/ws' })
  const ai = p.profiles.find((x) => x.name === 'ai')
  const solo = p.profiles.find((x) => x.name === 'solo')
  const empty = p.profiles.find((x) => x.name === 'empty')
  ok('B1 数组 file 的档案进入 profiles', !!ai, JSON.stringify(p.profiles.map((x) => x.name)))
  eq('B2 files 为规范化数组', ai && ai.files, ['p/a.md', 'p/b.md'])
  eq('B3 多文件时 file 兼容为数组', ai && ai.file, ['p/a.md', 'p/b.md'])
  eq('B4 单文件时 file 为字符串', solo && solo.file, 'p/a.md')
  eq('B5 单文件时 files 仍为数组', solo && solo.files, ['p/a.md'])
  ok('B6 无有效 file 的档案被剔除', !empty, 'empty 应被过滤')
  eq('B7 档案 title 解析', ai && ai.title, '分析师')

  const r = await env.rpc('activate', { sessionId: 's-merge', profile: 'ai', cwd: '/ws' })
  ok('B8 多文件档案激活成功', r.ok === true, JSON.stringify(r))
  const sec = scoped.get(SECTION) || {}
  const body = sec.text || ''
  ok('B9 注册了档案 section（order -50）', sec.order === -50, JSON.stringify(sec.order))
  ok('B10 合并顺序 = 声明顺序', body.indexOf('AAA') !== -1 && body.indexOf('BBB') !== -1 && body.indexOf('AAA') < body.indexOf('BBB'), body)
  ok('B11 空行分隔（\\n\\n）', body.indexOf(today() + '\n\nBBB') !== -1, JSON.stringify(body))
  ok('B12 占位符替换（{workspace}）', body.indexOf('BBB /ws') !== -1, JSON.stringify(body))
  ok('B13 前置说明保留', body.indexOf('提示词档案') !== -1)

  const env2 = makeEnv({
    files: {
      '/ws/.deepseek.yaml': 'workspace:\n  system_prompts:\n    ai:\n      file:\n        - p/a.md\n        - p/missing.md\n',
      '/ws/p/a.md': 'A',
    },
  })
  env2.makeAgent('s-fail')
  const r2 = await env2.rpc('activate', { sessionId: 's-fail', profile: 'ai', cwd: '/ws' })
  ok('B14 数组内文件缺失 → 整体失败', r2.ok === false, JSON.stringify(r2))
  ok('B15 错误信息含序号与文件名', typeof r2.error === 'string' && r2.error.indexOf('2/2') !== -1 && r2.error.indexOf('p/missing.md') !== -1, r2.error)
}

/* ---------------- C. global_prompt：未配置/文件不存在即不覆盖 ---------------- */
{
  // brokenDisposer=true：模拟真实运行时 disposer 静默失效，验证 forceCleanSection 兜底
  const env = makeEnv({
    files: {
      '/ws/.deepseek.yaml': 'workspace:\n  global_prompt: p/global.md\n',
      '/ws/p/global.md': '覆盖正文',
    },
    brokenDisposer: true,
  })
  const { agent, scoped, global } = env.makeAgent('s-id')
  await env.created(agent)
  ok('C1 有效配置 → 注册 harness:identity 覆盖', (scoped.get(IDENTITY) || {}).text === '覆盖正文', JSON.stringify([...scoped.keys()]))
  eq('C2 覆盖 order 对齐 DSH 开幕式', (scoped.get(IDENTITY) || {}).order, -1000)
  eq('C3 state.globalPrompt 反映生效文件', (await env.rpc('state', { sessionId: 's-id' })).globalPrompt, 'p/global.md')

  env.files['/ws/.deepseek.yaml'] = 'workspace:\n  name: x\n'
  await env.created(agent)
  ok('C4 配置缺失（键不存在）→ 不覆盖且无残留', !scoped.has(IDENTITY), 'still=' + JSON.stringify([...scoped.keys()]))
  ok('C5 DSH 全局开场白未被破坏', global.has(IDENTITY))
  eq('C6 state.globalPrompt 归 null', (await env.rpc('state', { sessionId: 's-id' })).globalPrompt, null)

  env.files['/ws/.deepseek.yaml'] = 'workspace:\n  global_prompt: p/nope.md\n'
  await env.created(agent)
  ok('C7 文件不存在 → 不覆盖', !scoped.has(IDENTITY), JSON.stringify([...scoped.keys()]))
  ok('C8 文件不存在 → 记 warn', env.logs.some((m) => m.indexOf('global_prompt 文件读取失败') !== -1), JSON.stringify(env.logs))

  env.files['/ws/.deepseek.yaml'] = 'workspace:\n  global_prompt: p/global.md\n'
  await env.created(agent)
  ok('C9 配置恢复 → 重新注册', (scoped.get(IDENTITY) || {}).text === '覆盖正文', JSON.stringify([...scoped.keys()]))

  env.files['/ws/p/global.md'] = '   '
  await env.created(agent)
  ok('C10 文件被清空 → 不覆盖（无残留）', !scoped.has(IDENTITY), JSON.stringify([...scoped.keys()]))

  env.files['/ws/.deepseek.yaml'] = 'workspace:\n  global_prompt: p/global.md\n'
  env.files['/ws/p/global.md'] = 'X'
  await env.created(agent)
  ok('C11 再次恢复 → 重新注册', (scoped.get(IDENTITY) || {}).text === 'X')
  delete env.files['/ws/p/global.md']
  await env.created(agent)
  ok('C12 文件被删除 → 不覆盖', !scoped.has(IDENTITY), JSON.stringify([...scoped.keys()]))
  ok('C13 global 层始终未被触碰', global.has(IDENTITY))

  // global_prompt 值类型非法（列表）也算未配置
  const env3 = makeEnv({
    files: { '/ws/.deepseek.yaml': 'workspace:\n  global_prompt:\n    - a.md\n    - b.md\n' },
    brokenDisposer: true,
  })
  const a3 = env3.makeAgent('s-arr')
  await env3.created(a3.agent)
  ok('C14 global_prompt 非字符串 → 视为未配置', !a3.scoped.has(IDENTITY), JSON.stringify([...a3.scoped.keys()]))
}

/* ---------------- D. 回归：单文件档案 / temperature / 幂等 / pending ---------------- */
{
  const env = makeEnv({
    files: {
      '/ws/.deepseek.yaml': 'workspace:\n  system_prompts:\n    solo:\n      file: p/a.md\n      parameters:\n        temperature: 0.2\n',
      '/ws/p/a.md': 'SOLO',
    },
  })
  const { scoped, requestHandlers } = env.makeAgent('s-reg')
  const r1 = await env.rpc('activate', { sessionId: 's-reg', profile: 'solo', cwd: '/ws' })
  ok('D1 单文件档案激活', r1.ok === true && r1.temperature === 0.2, JSON.stringify(r1))
  const body = (scoped.get(SECTION) || {}).text || ''
  ok('D2 正文含前置说明与文件正文', body.indexOf('SOLO') !== -1 && body.indexOf('提示词档案') !== -1, body)
  ok('D3 temperature 瀑布注入器已注册', requestHandlers.length === 1, String(requestHandlers.length))
  const merged = await requestHandlers[0]({}, async () => ({ temperature: 0.9, model: 'm' }))
  eq('D4 temperature 覆盖生效', merged.temperature, 0.2)
  eq('D5 其它请求字段保留', merged.model, 'm')

  const sizeBefore = scoped.size
  const r2 = await env.rpc('activate', { sessionId: 's-reg', profile: 'solo', cwd: '/ws' })
  ok('D6 同档案重复激活幂等（不重复注册）', r2.ok === true && scoped.size === sizeBefore, String(scoped.size) + '/' + String(sizeBefore))

  const r3 = await env.rpc('activate', { sessionId: 's-reg', profile: 'nope', cwd: '/ws' })
  ok('D7 未知档案报错', r3.ok === false && String(r3.error).indexOf('未知档案') !== -1, JSON.stringify(r3))

  const r4 = await env.rpc('activate', { sessionId: 's-new', profile: 'solo', cwd: '/ws' })
  ok('D8 会话未激活 → pending 排队', r4.ok === true && r4.pending === true, JSON.stringify(r4))
  const made = env.makeAgent('s-new')
  await env.created(made.agent)
  ok('D9 agent/created 后自动应用档案', ((made.scoped.get(SECTION) || {}).text || '').indexOf('SOLO') !== -1)
  eq('D10 state.active 反映已应用档案', (await env.rpc('state', { sessionId: 's-new' })).active, 'solo')
}

/* ---------------- E. 子代理会话档案继承 + 未激活会话不报红字（2026-09-20 修复） ----------------
 * E1-E6：子代理会话（header.origin='subagent' + header.parentSession）在 agent/created 时
 *         自动继承父会话当前档案，父无选择回退 default；普通会话不自动注入；显式选择优先。
 * E7-E11：未激活会话一律 pending 排队（不报红字）；sessionPersistence 快照按 header.id 匹配；
 *         RPC 用持久化 header 兜底解析 cwd。反向对照：把 sessionExists 的匹配改回顶层
 *         `s.id`，E7/E9 立即失败（这正是本次修复的回归点，见 internals.md）。
 */
{
  const YAML = 'workspace:\n  system_prompts:\n'
    + '    ai:\n      file: p/ai.md\n'
    + '    default:\n      file: p/dev.md\n'
  const files = {
    '/ws/.deepseek.yaml': YAML,
    '/ws/p/ai.md': 'AI_BODY',
    '/ws/p/dev.md': 'DEV_BODY',
  }

  // E1-E3：父会话选 ai → 子代理继承 ai
  const env = makeEnv({ files })
  env.makeAgent('p1')
  const pa = await env.rpc('activate', { sessionId: 'p1', profile: 'ai', cwd: '/ws' })
  ok('E1 父会话先激活 ai', pa.ok === true && pa.profile === 'ai', JSON.stringify(pa))
  const c1 = env.makeAgent('c1', { origin: 'subagent', parentSession: 'p1' })
  await env.created(c1.agent)
  ok('E2 子代理注入了档案 section', c1.scoped.has(SECTION), JSON.stringify([...c1.scoped.keys()]))
  ok('E3 子代理继承父会话当前档案', ((((c1.scoped.get(SECTION) || {}).text) || '').indexOf('AI_BODY') !== -1),
    ((c1.scoped.get(SECTION) || {}).text || '').slice(0, 60))
  eq('E4 state.active 反映继承的档案', (await env.rpc('state', { sessionId: 'c1' })).active, 'ai')

  // E5：父会话没有档案选择 → 子代理回退 default
  const env2 = makeEnv({ files })
  env2.makeAgent('p2')
  const c2 = env2.makeAgent('c2', { origin: 'subagent', parentSession: 'p2' })
  await env2.created(c2.agent)
  ok('E5 父无选择时子代理回退 default', ((((c2.scoped.get(SECTION) || {}).text) || '').indexOf('DEV_BODY') !== -1),
    ((c2.scoped.get(SECTION) || {}).text || '').slice(0, 60))

  // E6：普通（非子代理）会话不自动注入档案
  const env3 = makeEnv({ files })
  const plain = env3.makeAgent('n1')
  await env3.created(plain.agent)
  ok('E6 普通会话不自动注入档案', !plain.scoped.has(SECTION), JSON.stringify([...plain.scoped.keys()]))

  // E7：显式排队（客户端已选择）优先于父会话继承
  const env4 = makeEnv({ files })
  env4.makeAgent('p4')
  await env4.rpc('activate', { sessionId: 'p4', profile: 'ai', cwd: '/ws' })
  const rq = await env4.rpc('activate', { sessionId: 'c4', profile: 'default', cwd: '/ws' })
  const c4 = env4.makeAgent('c4', { origin: 'subagent', parentSession: 'p4' })
  await env4.created(c4.agent)
  ok('E7 显式选择优先于父继承',
    rq.pending === true && ((((c4.scoped.get(SECTION) || {}).text) || '').indexOf('DEV_BODY') !== -1),
    JSON.stringify(rq))

  // E8-E10：未激活会话 + 持久化快照（header.id 匹配）
  const coldSnapshots = [{ header: { id: 'cold-1', cwd: '/ws' }, revision: 'r1' }]
  const env5 = makeEnv({ files, persistence: coldSnapshots })
  const rc = await env5.rpc('activate', { sessionId: 'cold-1', profile: 'ai' })
  ok('E8 未激活会话返回 pending 而非 error',
    rc.ok === true && rc.pending === true && !rc.error, JSON.stringify(rc))
  ok('E9 命中持久化记录时不误报「会话不存在」（无 warn）',
    !env5.logs.some((m) => m.indexOf('cold-1') !== -1), JSON.stringify(env5.logs))
  const rp5 = await env5.rpc('profiles', { sessionId: 'cold-1' })
  ok('E10 RPC 用持久化 header 兜底解析 cwd',
    rp5.cwd === '/ws' && rp5.profiles.length === 2 && !rp5.error,
    JSON.stringify({ cwd: rp5.cwd, n: rp5.profiles.length, error: rp5.error }))
  const c5 = env5.makeAgent('cold-1', { origin: 'subagent', parentSession: 'p1' })
  await env5.created(c5.agent)
  ok('E11 pending 的档案在 agent 创建后自动应用',
    ((((c5.scoped.get(SECTION) || {}).text) || '').indexOf('AI_BODY') !== -1),
    ((c5.scoped.get(SECTION) || {}).text || '').slice(0, 60))

  // E12：完全不存在的会话：仅排队 + warn，不报 error
  const env6 = makeEnv({ files })
  const rg = await env6.rpc('activate', { sessionId: 'ghost-1', profile: 'ai' })
  ok('E12 不存在的会话不报 error（仅排队 + warn）',
    rg.ok === true && rg.pending === true && !rg.error && env6.logs.some((m) => m.indexOf('ghost-1') !== -1),
    JSON.stringify(rg))

  // E13：子代理会话同时获得工作区开场白覆盖（与档案解耦，两条路径互不影响）
  const env7 = makeEnv({
    files: {
      '/ws/.deepseek.yaml': 'workspace:\n  global_prompt: p/g.md\n  system_prompts:\n    ai:\n      file: p/ai.md\n',
      '/ws/p/g.md': 'GLOBAL_BODY',
      '/ws/p/ai.md': 'AI_BODY',
    },
  })
  const c7 = env7.makeAgent('c7', { origin: 'subagent', parentSession: 'p7' })
  await env7.created(c7.agent)
  ok('E13 子代理同时获得开场白覆盖（替换 harness:identity）',
    ((((c7.scoped.get(IDENTITY) || {}).text) || '').indexOf('GLOBAL_BODY') !== -1), JSON.stringify([...c7.scoped.keys()]))
  ok('E14 开场白覆盖与档案继承互不影响（两者同时注册）',
    c7.scoped.has(IDENTITY) && c7.scoped.has(SECTION), JSON.stringify([...c7.scoped.keys()]))
}

/* ---------------- F. persona 段清空/替换（workspace.persona_prompt / persona_clear，internals.md） ----------------
 * F1-F14：配置求值——默认清空 / 替换（含占位符）/ 显式 false 才不改写 / clear 优先 / 空文件 / 读盘失败 /
 *          每次装配重新求值 / 段名落空诊断（一次性 warn）
 * F15-F20：三条自律——只改 sections（tools/contexts/variables 原样透传）、不吞 next() 异常、
 *          不动 name/order；以及子代理会话同样挂载、重复 agent/created 不重复挂载
 */
{
  const PRESET_PERSONA = 'You are a coding agent powered by the {{model}} model.'
  // 模拟装配结果：preset 的 persona 段（agent 层已有 owner，插件只能改写它）+ 其它插件贡献
  const makeAssembly = () => ({
    sections: [
      { name: IDENTITY, order: -1000, text: 'You are an AI agent powered by DeepSeek Harness.' },
      { name: SECTION, order: -50, text: '档案正文' },
      { name: PERSONA_SECTION, order: 0, text: PRESET_PERSONA },
    ],
    contexts: [{ name: 'working-directory:current', text: '/ws', interpolate: false }],
    tools: [{ name: 'bash', description: 'x' }],
    variables: { provider: 'p', model: 'm' },
  })
  const personaTextOf = (assembly) => (assembly.sections.find((s) => s.name === PERSONA_SECTION) || {}).text

  // F1-F7：persona_clear: true → 清空该段，其余原样
  const env = makeEnv({ files: { '/ws/.deepseek.yaml': 'workspace:\n  persona_clear: true\n' } })
  const h = env.makeAgent('f-clear')
  await env.created(h.agent)
  ok('F1 agent/created 挂上 system-prompt/assemble 监听器', h.assembleHandlers.length === 1, String(h.assembleHandlers.length))

  const a1 = makeAssembly()
  const out1 = await env.assemble(h.agent, a1)
  ok('F2 persona_clear → persona 段文本被清空', personaTextOf(out1) === '', JSON.stringify(personaTextOf(out1)))
  ok('F3 清空值是空串而非空格（空格长度为 1，renderPrompt 会保留成一个空段落）',
    String(personaTextOf(out1)).length === 0, JSON.stringify(personaTextOf(out1)))
  ok('F4 其它 section 不受影响（开场白 / 档案段保持原文本）',
    out1.sections.length === 3 && out1.sections[0].text === a1.sections[0].text && out1.sections[1].text === '档案正文',
    JSON.stringify(out1.sections.map((s) => [s.name, s.text])))
  ok('F5 只改 sections：tools / contexts / variables 原样透传（引用未变）',
    out1.tools === a1.tools && out1.contexts === a1.contexts && out1.variables === a1.variables)
  ok('F6 不动 name / order', out1.sections[2].name === PERSONA_SECTION && out1.sections[2].order === 0)
  ok('F7 返回新对象且不原地改输入', out1 !== a1 && a1.sections[2].text === PRESET_PERSONA)

  // F8：persona_prompt → 用文件正文替换（占位符替换与 global_prompt 同规则）
  env.files['/ws/.deepseek.yaml'] = 'workspace:\n  persona_prompt: p/persona.md\n'
  env.files['/ws/p/persona.md'] = '你是简洁的中文助手，工作区 {workspace}'
  const out2 = await env.assemble(h.agent, makeAssembly())
  eq('F8 persona_prompt → 替换为文件正文（占位符已替换）', personaTextOf(out2), '你是简洁的中文助手，工作区 /ws')

  // F9：两键都缺省 → **默认清空**（默认行为，不再需要显式 persona_clear: true）
  env.files['/ws/.deepseek.yaml'] = 'workspace:\n  name: 无 persona 配置\n'
  eq('F9 两键缺省 → 默认清空', personaTextOf(await env.assemble(h.agent, makeAssembly())), '')

  // F10：两键同时给出 → clear 优先
  env.files['/ws/.deepseek.yaml'] = 'workspace:\n  persona_clear: true\n  persona_prompt: p/persona.md\n'
  eq('F10 两键同时给出 → persona_clear 优先', personaTextOf(await env.assemble(h.agent, makeAssembly())), '')

  // F11：替换源为空文件 → 空串（= 清空；与 global_prompt 的「空即未配置」语义不同）
  env.files['/ws/.deepseek.yaml'] = 'workspace:\n  persona_prompt: p/persona.md\n'
  env.files['/ws/p/persona.md'] = '   \n'
  const out5 = await env.assemble(h.agent, makeAssembly())
  eq('F11 替换源为空文件 → 空串（等价清空）', personaTextOf(out5), '')

  // F12-F14：替换源读不到 → 不改写 + 一次性 warn
  env.files['/ws/.deepseek.yaml'] = 'workspace:\n  persona_prompt: p/missing.md\n'
  const a6 = makeAssembly()
  const out6 = await env.assemble(h.agent, a6)
  ok('F12 替换源文件不存在 → 不改写（保留 preset 原有 persona）',
    out6 === a6 && a6.sections[2].text === PRESET_PERSONA, JSON.stringify(personaTextOf(out6)))
  ok('F13 读盘失败记 warn（含文件名）', env.logs.filter((m) => m.indexOf('p/missing.md') !== -1).length === 1, JSON.stringify(env.logs))
  await env.assemble(h.agent, makeAssembly())
  ok('F14 同一问题只 warn 一次（每次装配都求值，不能每步刷屏）',
    env.logs.filter((m) => m.indexOf('p/missing.md') !== -1).length === 1, JSON.stringify(env.logs))

  // F15-F16：每次装配重新求值 —— 改配置后无需重挂监听器
  env.files['/ws/.deepseek.yaml'] = 'workspace:\n  persona_clear: true\n'
  eq('F15 改配置后同一监听器立即生效（无需重启 / 重挂）', personaTextOf(await env.assemble(h.agent, makeAssembly())), '')
  ok('F16 监听器未被重挂（数量仍为 1）', h.assembleHandlers.length === 1, String(h.assembleHandlers.length))

  // F17-F18：装配结果里没有 persona 段 → 原样返回 + 段名落空诊断（一次性）
  const noPersona = () => ({ sections: [{ name: SECTION, order: -50, text: 'x' }], contexts: [], tools: [], variables: {} })
  const a8 = noPersona()
  const out8 = await env.assemble(h.agent, a8)
  ok('F17 装配无 persona 段 → 原样返回', out8 === a8)
  ok('F18 段名落空记一次 warn（DSH 段名变更诊断）',
    env.logs.filter((m) => m.indexOf(PERSONA_SECTION) !== -1).length === 1, JSON.stringify(env.logs))

  // F19：next() 的异常绝不吞（吞掉后返回空 assembly 会让下游 sections 处理崩溃）
  const err = await env.assemble(h.agent, makeAssembly(), { throwEnd: true }).then(() => null, (e) => e)
  ok('F19 next() 异常向上传播（未被 catch 成空 assembly / []）',
    !!err && String(err.message).indexOf('boom') !== -1, err && String(err.message))

  // F20：重复 agent/created（compact / clear 换 agent 对象）不重复挂载
  await env.created(h.agent)
  ok('F20 重复 agent/created 不重复挂载（先释放旧监听器）', h.assembleHandlers.length === 1, String(h.assembleHandlers.length))

  // F23-F25：唯一的 opt-out（显式 false）、以及「连 .deepseek.yaml 都没有」的默认行为
  env.files['/ws/.deepseek.yaml'] = 'workspace:\n  persona_clear: false\n'
  const a23 = makeAssembly()
  const out23 = await env.assemble(h.agent, a23)
  ok('F23 显式 persona_clear: false → 不改写（保留 preset 原句）',
    out23 === a23 && a23.sections[2].text === PRESET_PERSONA, JSON.stringify(personaTextOf(out23)))
  delete env.files['/ws/.deepseek.yaml']
  const logsBefore = env.logs.length
  eq('F24 无 .deepseek.yaml → 仍默认清空', personaTextOf(await env.assemble(h.agent, makeAssembly())), '')
  ok('F25 缺配置文件不产生告警（默认行为，不是错误）',
    env.logs.length === logsBefore, JSON.stringify(env.logs.slice(logsBefore)))

  // F21-F22：子代理会话同样挂载（与开场白覆盖同路径，注册只作用于该子代理自己的作用域）
  const envSub = makeEnv({ files: { '/ws/.deepseek.yaml': 'workspace:\n  persona_clear: true\n' } })
  const cs = envSub.makeAgent('f-sub', { origin: 'subagent', parentSession: 'f-parent' })
  await envSub.created(cs.agent)
  ok('F21 子代理会话同样挂上装配监听器', cs.assembleHandlers.length === 1, String(cs.assembleHandlers.length))
  eq('F22 子代理会话的 persona 段同样被清空', personaTextOf(await envSub.assemble(cs.agent, makeAssembly())), '')
}

/* ---------------- 汇总 ---------------- */
if (failures.length === 0) {
  console.log('offline verify: ' + passed + '/' + passed + ' 通过')
  process.exit(0)
} else {
  console.log('offline verify: ' + passed + ' 通过, ' + failures.length + ' 失败')
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
