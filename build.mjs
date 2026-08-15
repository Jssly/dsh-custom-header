/**
 * ESM host build for dsh-custom-header.
 *
 * The host half is plain ESM for Node, externalizing the @deepseek-ai/dsh-*
 * profile packages (the profile's node_modules provides them at load time).
 * There is no browser client half: every mechanism lives in the server
 * process that makes provider HTTP requests (fetch pipeline + llm/stream
 * observer), so nothing ships to the web UI.
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

mkdirSync('lib', { recursive: true })

const require = createRequire(import.meta.url)

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  sourcemap: true,
  external: ['@deepseek-ai/*'],
  logLevel: 'info',
})

// Emit declarations + typecheck (PATH-independent, cross-platform).
execFileSync(process.execPath, [require.resolve('typescript/lib/tsc.js'), '-p', 'tsconfig.json'], { stdio: 'inherit' })