/**
 * dsh-profile-selector — 共享核心：迷你 YAML 解析器（纯函数，零依赖）
 *
 * 双模式共用：动态模式由 build.mjs 内联进 cordis_define 函数体；
 * 静态模式由 src/static/*.js 以 ESM import 引用。
 * 仅支持 .deepseek.yaml 所需子集：map / list of scalars。
 */

/** 解析单个标量：去引号、布尔、数字、null。 */
export function parseScalar(raw) {
  const v = String(raw).trim()
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1)
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === 'null' || v === '~') return null
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  return v
}

/** 解析 YAML 文本为嵌套对象（map/list of scalars 子集）。 */
export function parseYaml(text) {
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