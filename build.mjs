/**
 * dsh-profile-selector — 双模式构建脚本
 *
 * 产出：
 *   dist/dynamic/host.js   动态 Host 函数体（cordis_define 用；内联核心源码）
 *   dist/dynamic/client.js 动态 Client 函数体（cordis_define 用；内联核心源码）
 *   lib/index.js           静态 Host ESM bundle（cordis.patch.yml 挂载）
 *   lib/client.js          静态 Client CJS bundle（ModuleLoader 包装；dsh.client 收录）
 *
 * 用法：node build.mjs
 */
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const read = (p) => readFileSync(join(root, p), 'utf8')
const write = (p, s) => writeFileSync(join(root, p), s)

mkdirSync(join(root, 'dist/dynamic'), { recursive: true })
mkdirSync(join(root, 'lib'), { recursive: true })

// --- 动态模式：核心源码去 export/import 后内联进函数体模板 ---
function inlineCore(source) {
  return source
    .replace(/^import\s+.*?from\s+['"].*?['"]\s*;?\s*$/gm, '') // 去掉 import 行
    .replace(/^export\s+/gm, '') // 去掉 export 关键字
    .trim()
}

// 内联顺序即依赖顺序：settings（键定义）→ patch（受管块）→ host（业务）
const settingsCore = inlineCore(read('src/core/settings.js'))
const patchCore = inlineCore(read('src/core/patch.js'))
const hostCore = inlineCore(read('src/core/host.js'))
const clientCore = inlineCore(read('src/core/client.js'))
const settingsClientCore = inlineCore(read('src/core/settings-client.js'))

const dynamicHost = read('src/dynamic/host.js')
  .replace('/*__CORE_SETTINGS__*/', settingsCore)
  .replace('/*__CORE_PATCH__*/', patchCore)
  .replace('/*__CORE_HOST__*/', hostCore)
write('dist/dynamic/host.js', dynamicHost)

const dynamicClient = read('src/dynamic/client.js')
  .replace('/*__CORE_CLIENT__*/', clientCore)
  .replace('/*__CORE_SETTINGS_CLIENT__*/', settingsClientCore)
write('dist/dynamic/client.js', dynamicClient)

// --- 静态模式：esbuild bundle ---
// 静态 bundle 的 external：DSH 自家包 + 我们的运行时依赖。
// ⚠️ `yaml` **必须 external**（不要打进 bundle）：该库内部有 `require('process')`，
// 被 esbuild 打进 ESM 输出后会变成垫片调用并在加载时抛
// 「Dynamic require of "process" is not supported」。作为依赖由 profile 的
// node_modules 解析（package.json 已声明，`dsh plugin add` 会装上）。
const dshExternal = ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-*', 'yaml']

await build({
  entryPoints: ['src/static/host.js'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  sourcemap: true,
  external: dshExternal,
  logLevel: 'info',
})

await build({
  entryPoints: ['src/static/client.js'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: true,
  external: [...dshExternal, 'react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'scheduler'],
  banner: {
    js: "window.__ModuleLoader__.load({ id: 'dsh-profile-selector', factory: (require) => { var module = { exports: {} }; var exports = module.exports;",
  },
  footer: {
    js: 'return module.exports; } });',
  },
  logLevel: 'info',
})

console.log('build ok: dist/dynamic/{host,client}.js + lib/{index,client}.js')