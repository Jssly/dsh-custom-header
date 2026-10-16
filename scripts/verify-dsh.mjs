/**
 * dsh-profile-selector — DSH 集成验证（**需要本机装有 DSH**）
 *
 * 只验证一件事：**用 `yaml` 库生成/修改的 patch 文件内容，DSH 自己的加载器能不能正确读到。**
 *
 * 这是"离线测试"覆盖不到的那一层：`verify-offline.mjs` 只验我们自己的逻辑，
 * 而这里用 DSH 真实的解析（`loadOverlayPatches`，JSON_SCHEMA + `!!js` 方言）与合并
 * （`composeEntries` → `applyEntryPatches`）走一遍，确认三件事：
 *
 *   1. 受管块里的三个值被 DSH 逐字符读对（含反斜杠、字面量 true/null/123、井号、
 *      冒号、前后空格、换行、双引号、中文与空格路径、超长值、空串等边界）；
 *   2. 块里的条目按 id 命中 `- insert:` 定义的那一行（config 覆盖生效），且
 *      `name` / `inject` 等其它字段不丢；
 *   3. **块外的内容不受影响** —— 真实 `cordis.patch.yml` 追加受管块后，DSH 仍能完整解析，
 *      且块外条目一字不变。
 *
 * 用法：node scripts/verify-dsh.mjs
 *   · 找不到 DSH 时打印提示并以退出码 0 结束（不算失败——本机没装 DSH 也能跑其它检查）。
 *   · 需要指定 DSH 安装目录时设 DSH_INSTALL_DIR。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import * as YAML from 'yaml'
import { SETTINGS_BLOCK_BEGIN, SETTINGS_BLOCK_END, applySettingsToPatch, generateSettingsBlock } from '../src/core/patch.js'

/** 定位 DSH 安装目录（app-boot 所在包）。 */
function findDsh() {
  const candidates = []
  if (process.env.DSH_INSTALL_DIR) candidates.push(process.env.DSH_INSTALL_DIR)
  const require = createRequire(import.meta.url)
  try {
    // 从本仓库向上找 dsh（全局安装时通常落在 node 的 lib/node_modules 下）
    const bin = require.resolve('dsh/package.json')
    candidates.push(join(bin, '..'))
  } catch (e) { /* 未安装 */ }
  for (const base of candidates) {
    if (!base) continue
    const appBoot = join(base, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')
    if (existsSync(appBoot)) return { base, appBoot }
  }
  return null
}

const dsh = findDsh()
if (dsh === null) {
  console.log('verify-dsh: 未找到 DSH 安装（跳过）')
  console.log('  需要时设 DSH_INSTALL_DIR=<dsh 包目录> 再跑；本检查依赖 DSH 自身的解析器。')
  process.exit(0)
}

const appBoot = await import(dsh.appBoot)
const load = appBoot.loadOverlayPatches
const compose = appBoot.composeEntries

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

/** 把一段 patch 文本写成临时文件，用 DSH 的加载器读回并合并。 */
const dir = mkdtempSync(join(tmpdir(), 'dsh-profile-selector-verify-'))
let seq = 0
function dshRead(text) {
  const file = join(dir, 'probe-' + (seq++) + '.yml')
  writeFileSync(file, text, 'utf8')
  const rows = load('dsh', file)
  const entries = compose([rows], (msg, ...a) => failures.push('DSH warn: ' + msg + ' ' + JSON.stringify(a)))
  return entries
}

const INSERT = [
  '- insert:',
  '    - id: dsh-profile-selector',
  '      name: dsh-profile-selector',
  '      inject: [connection, webServer]',
  '',
].join('\n')

const VALUES = { global_prompt: '', persona_clear: true, includeHarnessIdentity: false }

/* ---------- 1. 库生成的值，DSH 逐字符读对 ---------- */
{
  const cases = [
    ['反斜杠（Windows 路径）', 'F:\\git\\node\\dsh-scene'],
    ['字面量 true（必须仍是字符串）', 'true'],
    ['字面量 null（必须仍是字符串）', 'null'],
    ['数字串（必须仍是字符串）', '123'],
    ['井号开头', '# 不是注释'],
    ['含冒号与空格', 'a: b'],
    ['前后空格', '  padded  '],
    ['含换行', 'line1\nline2'],
    ['含双引号与单引号', 'say "hi" and \'bye\''],
    ['中文 + 空格 + emoji', '/opt/中文 路径/😀.md'],
    ['超长值（240 字符）', '/' + 'x'.repeat(240) + '.md'],
    ['空串', ''],
  ]
  for (const [label, value] of cases) {
    const text = INSERT + generateSettingsBlock({ ...VALUES, global_prompt: value }, YAML)
    const row = dshRead(text).find((r) => r.id === 'dsh-profile-selector')
    eq('DSH 读对: ' + label, row && row.config ? row.config.global_prompt : null, value)
  }
  // 布尔字段
  const text = INSERT + generateSettingsBlock({ global_prompt: '/x.md', persona_clear: false, includeHarnessIdentity: true }, YAML)
  const row = dshRead(text).find((r) => r.id === 'dsh-profile-selector')
  eq('DSH 读对：两个布尔字段', [row.config.persona_clear, row.config.includeHarnessIdentity], [false, true])
  eq('DSH 读对：三键齐全', Object.keys(row.config).sort(), ['global_prompt', 'includeHarnessIdentity', 'persona_clear'])
  eq('覆盖生效：insert 行的 name/inject 保住', [row.name, row.inject], ['dsh-profile-selector', ['connection', 'webServer']])
}

/* ---------- 2. 真实 cordis.patch.yml：追加受管块后块外不受影响 ---------- */
{
  const realPath = join(process.cwd(), 'cordis.patch.yml')
  const before = readFileSync(realPath, 'utf8')
  const after = applySettingsToPatch(before, { global_prompt: '/probe.md', persona_clear: false, includeHarnessIdentity: true }, YAML)
  const entries = dshRead(after)
  const row = entries.find((r) => r.id === 'dsh-profile-selector')
  eq('真实 patch + 受管块：DSH 读到我们的值',
    row && row.config ? [row.config.global_prompt, row.config.persona_clear, row.config.includeHarnessIdentity] : null,
    ['/probe.md', false, true])
  ok('真实 patch + 受管块：受管块恰好一对标记',
    after.split('\n').filter((l) => l.trim() === SETTINGS_BLOCK_BEGIN).length === 1
    && after.split('\n').filter((l) => l.trim() === SETTINGS_BLOCK_END).length === 1)
  // 块外行逐行不变
  const ext = (t) => {
    const lines = String(t).split('\n')
    const b = lines.findIndex((l) => l.trim() === SETTINGS_BLOCK_BEGIN)
    const e = lines.findIndex((l) => l.trim() === SETTINGS_BLOCK_END)
    const rest = b < 0 ? lines : [...lines.slice(0, b), ...lines.slice(e + 1)]
    while (rest.length > 0 && rest[rest.length - 1].trim() === '') rest.pop()
    return rest
  }
  eq('真实 patch + 受管块：块外内容逐行不变', ext(after), ext(before))
  // 幂等：二次写入不追加第二份
  const again = applySettingsToPatch(after, VALUES, YAML)
  ok('二次写入：标记仍恰好一对',
    again.split('\n').filter((l) => l.trim() === SETTINGS_BLOCK_BEGIN).length === 1)
}

rmSync(dir, { recursive: true, force: true })

/* ---------- 汇总 ---------- */
if (failures.length === 0) {
  console.log('verify-dsh: ' + passed + '/' + passed + ' 通过（DSH 安装于 ' + dsh.base + '）')
  process.exit(0)
} else {
  console.log('verify-dsh: ' + passed + ' 通过, ' + failures.length + ' 失败')
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
