/**
 * dsh-profile-selector — 离线验证脚本（无需 DSH 运行时）
 *
 * 覆盖四块：
 *   A. 迷你 YAML 解析器：标量列表（block sequence）与既有 map/标量行为
 *   B. 档案 file 支持 string | string[]：按声明顺序合并、任一文件缺失即整体失败
 *   C. workspace.global_prompt：未配置 / 文件不存在 / 文件为空 → 不覆盖并清理残留
 *   D. 既有行为回归：单文件档案、temperature 注入、幂等、pending 延迟激活
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
      if (!Object.prototype.hasOwnProperty.call(files, target)) throw new Error('ENOENT: ' + target)
      return files[target]
    },
  }
  const ctx = {
    get(name) {
      if (name === 'fs') return fs
      if (name === 'sandboxPolicy') return { workspaceRoot: '/deploy-root' }
      if (name === 'agents') return { get: (id) => agents.get(id) }
      if (name === 'sessions') return { get: (id) => (id ? { id } : undefined) }
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

  function makeAgent(sessionId) {
    const scoped = new Map()
    const global = new Map()
    global.set(IDENTITY, { name: IDENTITY, order: -1000, text: 'You are an AI agent powered by DeepSeek Harness.' })
    const layers = {
      scoped: new Map(),
      global: { sections: { data: global, has: (n) => global.has(n), delete: (n) => global.delete(n) } },
    }
    const requestHandlers = []
    const sp = {
      layers,
      section(spec) {
        scoped.set(spec.name, { name: spec.name, order: spec.order, text: spec.text })
        // 真实运行时 disposer 可能静默失效（README 六-3）：用 brokenDisposer 复现
        return () => { if (!brokenDisposer) scoped.delete(spec.name) }
      },
    }
    const agent = {
      id: sessionId,
      session: { header: { cwd } },
      ctx: {
        systemPrompt: sp,
        on(event, fn) { if (event === 'agent/request') requestHandlers.push(fn); return () => {} },
      },
    }
    layers.scoped.set(agent, { sections: { data: scoped } })
    agents.set(sessionId, agent)
    return { agent, scoped, global, requestHandlers }
  }

  async function created(agent) {
    for (const h of (listeners.get('agent/created') || [])) await h({ agent })
  }
  function rpc(method, args) {
    const h = rpcHandlers.get('dshprofile.' + method)
    if (!h) throw new Error('no rpc handler: ' + method)
    return h(args)
  }
  return { files, cwd, logs, makeAgent, created, rpc }
}

/* ---------------- A. YAML 解析 ---------------- */
{
  const real = parseYaml(readFileSync(join(ROOT, '.deepseek.yaml'), 'utf8'))
  const aiFile = real.workspace.system_prompts.ai.file
  ok('A1 真实 .deepseek.yaml：数组 file 解析为数组', Array.isArray(aiFile) && aiFile.length === 2, JSON.stringify(aiFile))
  ok('A2 真实 .deepseek.yaml：数组顺序保留', Array.isArray(aiFile) && aiFile[0] === 'doc/prompts/global.md', JSON.stringify(aiFile))
  eq('A3 单文件仍是字符串', real.workspace.system_prompts.default.file, 'doc/prompts/dev.md')
  eq('A4 标量类型（数字/引号/布尔/null）', parseYaml('a: 1\nb: "q"\nc: true\nd: null\n'), { a: 1, b: 'q', c: true, d: null })
  eq('A5 缩进列表', parseYaml('a:\n  b:\n    - x\n    - y\n  c: 1\n'), { a: { b: ['x', 'y'], c: 1 } })
  eq('A6 零缩进列表（- 与 key 同缩进）', parseYaml('file:\n- a\n- b\nname: n\n'), { file: ['a', 'b'], name: 'n' })
  eq('A7 列表之后接同级 map 键', parseYaml('p:\n  file:\n    - f1\n    - f2\n  name: "t"\n'), { p: { file: ['f1', 'f2'], name: 't' } })
  eq('A8 空值键无子项仍为对象', parseYaml('a:\nb: 1\n'), { a: {}, b: 1 })
  eq('A9 注释与空行忽略', parseYaml('# c\n\na: 1\n\n'), { a: 1 })
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

/* ---------------- 汇总 ---------------- */
if (failures.length === 0) {
  console.log('offline verify: ' + passed + '/' + passed + ' 通过')
  process.exit(0)
} else {
  console.log('offline verify: ' + passed + ' 通过, ' + failures.length + ' 失败')
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
