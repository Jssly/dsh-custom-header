/**
 * dsh-profile-selector — 共享核心：迷你 YAML 解析器（纯函数，零依赖）
 *
 * 双模式共用：动态模式由 build.mjs 内联进 cordis_define 函数体；
 * 静态模式由 src/static/*.js 以 ESM import 引用。
 * 仅支持 .deepseek.yaml 所需子集：map / 标量 / 标量列表（block sequence）。
 * 不支持锚点、多行字符串（|、>）、嵌套列表、列表内 map 等复杂结构。
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
export function parseYaml(text) {
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