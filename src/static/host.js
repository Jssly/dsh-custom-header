/**
 * dsh-profile-selector — 静态模式 Host 壳（发布用）
 *
 * 经 build.mjs 打包为 lib/index.js（ESM bundle，external @deepseek-ai/*），
 * 由 cordis.patch.yml 挂载进 web profile。ID 与动态模式隔离：
 *   section 名 dsh-profile:profile-static、RPC 前缀 dshprofile-static。
 *
 * RPC 通道：静态模式无 harness 内置，改用 connection.register(ctx, '/rpc', ...)
 * 注册逻辑通道 /rpc（DSH 0.1.5-alpha.1 起不能再用 connection.rpc.handle，见 inject 注释）。
 * 注意 /rpc 是**共享通道**，只能注册一次——核心的每个 method 都经同一通道的
 * 不同 endpoint（method 名）分发：
 *   POST /rpc/<method>   body = { type:'client-request', rpcId, method, payload }
 * handler 返回 RpcResult（{ok:true,value} / {ok:false,error:{code,message}}），
 * 由 dsh-client-connection 的 rpcFetchHandler 包装进 server-response。
 */
import { hostCore } from '../core/host.js'

/** Cordis 插件名（Loader entry，与 cordis.patch.yml 的 insert id 一致）。 */
export const name = 'dsh-profile-selector'

/**
 * 服务依赖（均为硬依赖；patch 层亦声明同一列表）：
 *   connection — 调用 connection.register 注册 /rpc 通道的前提；
 *   webServer  — register 内部执行 owner.effect(() => owner.webServer.register(route))；
 *                本插件把 owner 显式指定为自己的 ctx（见 apply），故本 fiber 必须能解析
 *                webServer。缺声明时 apply 抛「cannot get property "webServer" without inject」，
 *                整个 loader entry 回滚。
 */
export const inject = ['connection', 'webServer']

/** 插件入口：执行 Host 半区注册逻辑。 */
export function apply(ctx) {
  const connection = ctx.get('connection')
  if (connection === undefined) return
  // method -> 业务 handler 表：核心每次调用适配器 handle 都登记一条。
  // 由于 /rpc 是共享通道（只能注册一次），把登记动作与通道注册解耦：
  // 全部 method 收敛到单次 /rpc 注册，handler 内按 endpoint 分发。
  const routes = new Map()
  let registered = false
  hostCore(ctx, {
    sectionName: 'dsh-profile:profile-static',
    rpcPrefix: 'dshprofile-static',
  }, {
    // 适配器：登记 method，并在首次登记时注册 /rpc 通道（幂等）
    handle: (method, handler) => {
      routes.set(method, handler)
      if (registered) return () => { routes.delete(method) }
      registered = true
      // ⚠️ DSH 0.1.5-alpha.1 起必须用 connection.register(ctx, ...) 显式传 owner，
      // 不能用 connection.rpc.handle('/rpc', ...)：
      //   · rpc.handle 内部 const owner = this.ctx 取的是 cordis **影子 Context**
      //     （读取服务时由 createTraceable/createShadow 构造：原型链是调用方 ctx，
      //     但 symbols.shadow 指向 connection 服务自身的 ctx），因此 owner.webServer
      //     的服务解析是从 **connection 插件 fiber** 向上查找；
      //   · 0.1.5-alpha.1 把 connection 插件自己的 inject 从 ['webServer','credentials']
      //     改成 ['credentials']（/api 路由改用 ctx.inject(['webServer'], ...) 挂载），
      //     connection fiber 的 store 不再有 webServer → 任何调用方（无论是否
      //     inject: webServer）都必抛 cannot get property "webServer" without inject；
      //   · register(owner, channel, handler) 与 rpc.handle 同一实现，但 owner 由调用方
      //     指定。传本插件自己的 ctx（inject 含 webServer，真实 ctx 无 shadow）即可在
      //     旧版（0.1.0-rc.8 ~ 0.1.2-alpha.3）与 0.1.5-alpha.1 同时工作。
      // 备选修复（DSH 侧）：在 web profile 的 cordis.patch.yml 给 connection 行补
      //   - id: connection
      //     inject: [webRuntime, webServer]
      // 恢复旧版行为后 rpc.handle 亦可；但本插件不依赖该改动。
      const dispose = connection.register(ctx, '/rpc', async (endpoint, payload) => {
        const route = routes.get(endpoint)
        if (!route) return { ok: false, error: { code: 'not-found', message: '未知方法: ' + String(endpoint) } }
        try {
          return { ok: true, value: await route(payload) }
        } catch (error) {
          return { ok: false, error: { code: 'internal', message: String((error && error.message) || error) } }
        }
      })
      return () => {
        routes.delete(method)
        if (routes.size === 0 && registered) {
          registered = false
          try { dispose() } catch (e) { /* noop */ }
        }
      }
    },
  })
}
// 注意：不要 `export default apply`。DSH 0.1.2-alpha.2 的 loader `unwrapExports` 会优先取
// exports.default 并解包成裸函数，导致插件对象上的 `inject` 丢失（静态 client 曾因此不激活，
// 见 CHANGELOG.md pkg-23 / ops-notes.md）。只导出 { name, inject, apply }，让 unwrap 返回完整对象。
