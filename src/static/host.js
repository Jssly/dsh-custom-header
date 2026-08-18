/**
 * dsh-profile-selector — 静态模式 Host 壳（发布用）
 *
 * 经 build.mjs 打包为 lib/index.js（ESM bundle，external @deepseek-ai/*），
 * 由 cordis.patch.yml 挂载进 web profile。ID 与动态模式隔离：
 *   section 名 dsh-profile:profile-static、RPC 前缀 dshprofile-static。
 *
 * RPC 通道：静态模式无 harness 内置，改用 ctx.connection.rpc.handle 注册
 * 逻辑通道 /rpc。注意 /rpc 是**共享通道**，只能注册一次——核心的每个
 * method 都经同一通道的不同 endpoint（method 名）分发：
 *   POST /rpc/<method>   body = { type:'client-request', rpcId, method, payload }
 * handler 返回 RpcResult（{ok:true,value} / {ok:false,error:{code,message}}），
 * 由 rpcFetchHandler 包装进 server-response。
 */
import { hostCore } from '../core/host.js'

/** Cordis 插件名（Loader entry，与 cordis.patch.yml 的 insert id 一致）。 */
export const name = 'dsh-profile-selector'

/** 服务依赖：connection 为硬依赖（RPC 通道注册前提；patch 层亦声明 inject: [connection]）。 */
export const inject = ['connection']

/** 插件入口：执行 Host 半区注册逻辑。 */
export function apply(ctx) {
  const connection = ctx.get('connection')
  if (connection === undefined) return
  // method -> 业务 handler 表：核心每次调用 rpc.handle 都登记一条。
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
      const dispose = connection.rpc.handle('/rpc', async (endpoint, payload) => {
        const route = routes.get(endpoint)
        if (!route) return { ok: false, error: { code: 'not-found', message: '未知方法: ' + String(endpoint) } }
        try {
          return { ok: true, value: await route(payload) }
        } catch (error) {
          return { ok: false, error: { code: 'internal', message: String((error && error.message) || error) } }
        }
      }, { authority: 'loopback' })
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

export default apply
