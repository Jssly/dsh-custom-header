/**
 * Typert codec shape regression test.
 *
 * DSH 0.1.6-alpha.2 ("perf(typert): materialize generated schemas on first
 * use") replaced the strict codec's materialized `schema` with a `create()`
 * factory. `ctx.typert.register()` and `ctx.remote.$mount()` both validate
 * strict codecs and refuse one without `create()` — which unmounts the
 * customHeader Remote namespace and makes the Settings tab report
 * "设置不可用（宿主侧未加载？）—— 显示默认值。".
 *
 * The descriptors therefore have to carry both shapes: `create()` for
 * 0.1.6-alpha.2+ and `schema` for older releases (which parsed
 * `codec.schema` directly). This test pins those two fields.
 *
 * Usage: node tests/contract.mjs
 */
const { CUSTOM_HEADER_INVOCATIONS } = await import('../lib/index.js')

let failures = 0
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function codecsOf(descriptor) {
  return [
    { where: `${descriptor.id} payload`, codec: descriptor.parameters[0]?.codec },
    { where: `${descriptor.id} result`, codec: descriptor.result },
  ]
}

check('two customHeader endpoints are declared', CUSTOM_HEADER_INVOCATIONS.length === 2, String(CUSTOM_HEADER_INVOCATIONS.length))

for (const descriptor of CUSTOM_HEADER_INVOCATIONS) {
  for (const { where, codec } of codecsOf(descriptor)) {
    check(`${where}: strict mode`, codec?.mode === 'strict', String(codec?.mode))
    check(`${where}: typeSymbol`, typeof codec?.typeSymbol === 'string' && codec.typeSymbol.length > 0, String(codec?.typeSymbol))
    // 0.1.6-alpha.2+ registry contract.
    check(`${where}: create() factory`, typeof codec?.create === 'function', typeof codec?.create)
    check(`${where}: create() returns a parse()-able schema`, typeof codec?.create?.()?.parse === 'function')
    // Pre-0.1.6-alpha.2 registry contract.
    check(`${where}: schema.parse()`, typeof codec?.schema?.parse === 'function')
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
