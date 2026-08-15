/**
 * Single-file client + ESM host build for dsh-custom-header.
 *
 * The web server serves exactly one file per plugin
 * (/plugins/dsh-custom-header/client.js), so the client half is one CJS
 * bundle wrapped in the ModuleLoader factory handshake. The client bundle
 * imports no bare specifiers at runtime (all @deepseek-ai imports are
 * type-only), so nothing needs to stay external for the browser. The host
 * half is plain ESM for Node, externalizing the @deepseek-ai/dsh-* runtime
 * packages plus cordis and schemastery, while bundling zod (the Loader
 * validates Config against the schema and the Typert descriptors carry the
 * strict codecs).
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

mkdirSync('lib', { recursive: true })

const require = createRequire(import.meta.url)
const dshExternal = ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-*']

await build({
  entryPoints: ['src/index.ts'],
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
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: true,
  jsx: 'automatic',
  external: [...dshExternal, 'react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'scheduler'],
  banner: {
    js: "window.__ModuleLoader__.load({ id: 'dsh-custom-header', factory: (require) => { var module = { exports: {} }; var exports = module.exports;",
  },
  footer: {
    js: 'return module.exports; } });',
  },
  logLevel: 'info',
})

// Typecheck + emit declarations (PATH-independent, cross-platform).
execFileSync(process.execPath, [require.resolve('typescript/lib/tsc.js'), '-p', 'tsconfig.json'], { stdio: 'inherit' })