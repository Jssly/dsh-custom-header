/**
 * dsh-profile-selector — 共享核心：bundle patch 的受管块读写
 *
 * ## 职责分工（关键）
 *
 * | 事情 | 谁做 |
 * |---|---|
 * | YAML 的**生成**与**解析** | **`yaml` 库**（成熟实现：自动决定何时加引号、多行用块标量、转义交给它） |
 * | 受管块的**范围界定** | 本文件 —— 库不管「哪几行是自己的」 |
 * | 整份文件的**替换** | 本文件 —— 按行拼接，标记之外的每一行原样保留（别人的内容绝不重写） |
 *
 * 为什么不让库去解析/重写**整份**文件：patch 文件里有别人的 `- insert:` 定义、注释，
 * 也可能有 `!!js` 表达式（DSH 的 loader 方言）。用库 `parseDocument` → `toString()` 往返
 * 会重排格式、按 `lineWidth` 折行（实测 `yaml` 2.9.1 对真实 patch 往返有数百行差异）。
 * 所以：**库只管块内那一小块，块之外靠文本标记界定。**
 *
 * ## 受管块
 *
 * 块本身是一个**顶层 patch 条目**，按 id 命中 `- insert:` 里定义的那一行做 config 覆盖：
 *
 *   # >>> dsh-profile-selector:settings:begin
 *   - id: dsh-profile-selector
 *     config:
 *       global_prompt: ''
 *       persona_clear: true
 *       includeHarnessIdentity: false
 *   # <<< dsh-profile-selector:settings:end
 *
 * 两条 DSH 语义（`applyEntryPatches`）：① 同一份 patch 内「先 insert、后同 id 顶层覆盖」
 * 成立，所以块追加在文件末尾即可；② 顶层覆盖对 `config` 是**整块替换**，所以块内必须
 * 写全三个键。
 *
 * ## 标记识别：整行精确匹配
 *
 * 只认「去掉首尾空白后整行恰好等于标记」的行。**不要**改成 `indexOf` 子串查找 ——
 * 曾因此把说明性注释里引用的标记字面量当成块边界，导致保存永远失败。
 *
 * 本模块的 YAML 能力由**壳**注入（`yaml` 参数 = `{ parse, stringify }`）：静态模式由
 * `src/static/host.js` 传入 `import * as YAML from 'yaml'`；动态模式在 apply 里
 * `await import('yaml')`（该模式本就不支持落盘，拿不到库时只影响工作区配置解析）。
 */
import { SETTINGS_KEYS } from './settings.js'

/** 受管块起始标记（整行，`#` 注释形态）。 */
export const SETTINGS_BLOCK_BEGIN = '# >>> dsh-profile-selector:settings:begin'
/** 受管块结束标记。 */
export const SETTINGS_BLOCK_END = '# <<< dsh-profile-selector:settings:end'
/** 受管条目命中的 loader entry id（与 package.json name / patch insert id 一致）。 */
export const MANAGED_ROW_ID = 'dsh-profile-selector'

/** 块内暴露的三个设置键（数据序；展示序见 core/settings-client.js）。 */
const KEYS = SETTINGS_KEYS

/** 某行是否为标记行：整行精确匹配（见文件头的「标记识别」）。 */
function isMarkerLine(line, marker) {
  return typeof line === 'string' && line.trim() === marker
}

/**
 * 定位受管块的 begin / end 行号（0 基）。只认第一对。
 * 只有其一、或 end 在 begin 之前 → 抛错（文件被改坏，宁可拒写也不猜）。
 * @returns `{ begin, end }`；无标记时为 `{ begin: -1, end: -1 }`。
 */
function locateBlock(lines) {
  let begin = -1
  let end = -1
  for (let i = 0; i < lines.length; i++) {
    if (begin < 0) {
      if (isMarkerLine(lines[i], SETTINGS_BLOCK_BEGIN)) begin = i
      continue
    }
    if (isMarkerLine(lines[i], SETTINGS_BLOCK_END)) { end = i; break }
  }
  if (begin < 0) {
    if (lines.some((line) => isMarkerLine(line, SETTINGS_BLOCK_END))) {
      throw new Error('cordis.patch.yml 中 dsh-profile-selector 受管块标记不完整（只找到结束标记）')
    }
    return { begin: -1, end: -1 }
  }
  if (end < 0) throw new Error('cordis.patch.yml 中 dsh-profile-selector 受管块标记不完整（只找到起始标记）')
  return { begin, end }
}

/**
 * 把任意输入收敛为「要写进块的三个值」：只留三个键，且类型正确
 * （`global_prompt` 非字符串→空串；布尔非 `true`→`false`）。纯 JS 对象处理，与 YAML 语法无关。
 */
function canonicalSettings(values) {
  const v = values && typeof values === 'object' ? values : {}
  const out = {}
  for (const key of KEYS) {
    out[key] = key === 'global_prompt'
      ? (typeof v[key] === 'string' ? v[key] : '')
      : v[key] === true
  }
  return out
}

/** 断言 yaml 能力已注入（壳没给就说明部署不完整，明确报错好过静默出错）。 */
function requireYaml(yaml) {
  if (!yaml || typeof yaml.parse !== 'function' || typeof yaml.stringify !== 'function') {
    throw new Error('yaml 能力未注入（静态壳应传 import * as YAML from \'yaml\' 的结果）')
  }
  return yaml
}

/**
 * 生成完整受管块文本（含首尾标记与结尾换行）。YAML 正文交给 `yaml.stringify`：
 * 引号、转义、多行块标量由库决定（`lineWidth: 0` 禁止折行，保持一行一个值）。
 */
export function generateSettingsBlock(values, yaml) {
  const lib = requireYaml(yaml)
  const body = lib.stringify([{ id: MANAGED_ROW_ID, config: canonicalSettings(values) }], { indent: 2, lineWidth: 0 })
  return SETTINGS_BLOCK_BEGIN + '\n' + String(body).replace(/\n+$/, '') + '\n' + SETTINGS_BLOCK_END + '\n'
}

/**
 * 提取受管块正文（不含 begin/end 两行本身）。
 * @returns 块正文；无受管块返回 null；标记不完整时抛错。
 */
export function extractSettingsBlock(raw) {
  const lines = String(raw).split('\n')
  const { begin, end } = locateBlock(lines)
  if (begin < 0) return null
  return lines.slice(begin + 1, end).join('\n')
}

/**
 * 读回受管块里的设置（YAML 解析交给 `yaml.parse`）。
 * @returns 三个键的对象；**没有受管块**（= 从未写过）返回 null；块被改坏/解析不出也返回 null。
 */
export function parseSettingsPatch(raw, yaml) {
  const lib = requireYaml(yaml)
  const block = extractSettingsBlock(raw)
  if (block === null || block.trim() === '') return null
  let parsed
  try {
    parsed = lib.parse(block)
  } catch (e) {
    return null
  }
  const row = Array.isArray(parsed) ? parsed.find((r) => r && r.id === MANAGED_ROW_ID) : null
  const config = row && typeof row.config === 'object' && row.config !== null ? row.config : null
  if (config === null) return null
  // 只取三个键（块里若被人加了别的键，不往上层传）
  const out = {}
  let seen = 0
  for (const key of KEYS) {
    if (config[key] !== undefined) { out[key] = config[key]; seen++ }
  }
  return seen === 0 ? null : out
}

/**
 * 用新的受管块替换旧块；标记之外的所有行**原样保留**。
 *   · 已有成对标记 → 替换 begin..end 区间；
 *   · 无标记 → 追加到末尾（空模板 `[]` 先被替换掉，避免拼出非法的 `[] - insert`）；
 *   · 删除块后只剩注释/空行 → 补回流式空数组 `[]`。
 */
export function replaceManagedBlock(raw, block) {
  const text = String(raw)
  const body = typeof block === 'string' ? block : ''
  const lines = text.split('\n')
  const { begin, end } = locateBlock(lines)
  const blockLines = body === '' ? [] : body.replace(/\n$/, '').split('\n')

  if (begin >= 0) {
    const next = [...lines.slice(0, begin), ...blockLines, ...lines.slice(end + 1)].join('\n')
    if (blockLines.length > 0) return next
    const meaningful = next.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'))
    if (meaningful.length === 0) return next.replace(/\s*$/, '') + '\n[]\n'
    return next
  }

  if (blockLines.length === 0) return text
  const meaningful = lines.map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'))
  if (meaningful.length === 1 && meaningful[0] === '[]') {
    const index = lines.findIndex((l) => l.trim() === '[]')
    return [...lines.slice(0, index), ...blockLines, ...lines.slice(index + 1)].join('\n')
  }
  const prefix = text.length === 0 ? '' : text.endsWith('\n') ? '\n' : '\n\n'
  return text + prefix + body
}

/** 受管块**之外**的行（去尾空行），用于下面那条断言。 */
function externalLines(text) {
  const lines = String(text).split('\n')
  const { begin, end } = locateBlock(lines)
  const ext = begin < 0 ? lines : [...lines.slice(0, begin), ...lines.slice(end + 1)]
  while (ext.length > 0 && ext[ext.length - 1].trim() === '') ext.pop()
  return ext
}

/**
 * 落盘的唯一入口：生成受管块 → 写进文件文本。
 *
 * 只保留**一条**断言：受管块之外的行必须逐行不变（防止替换逻辑误伤别人的配置）。
 * 块内容的正确性由 `yaml` 库负责（生成/解析同一套实现，往返可靠），不再另写自校验。
 *
 * @returns 写入后的完整文本（调用方可直接落盘）。
 * @throws 标记不完整、或块外内容被改动时抛错（此时**不写盘**）。
 */
export function applySettingsToPatch(raw, values, yaml) {
  const lib = requireYaml(yaml)
  const text = String(raw)
  const next = replaceManagedBlock(text, generateSettingsBlock(values, lib))
  if (JSON.stringify(externalLines(text)) !== JSON.stringify(externalLines(next))) {
    throw new Error('写入中止：受管块之外的内容将被改动（原文件未动）')
  }
  return next
}
