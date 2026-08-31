/**
 * dsh-profile-selector — 静态模式 Client 壳（发布用）
 *
 * 经 build.mjs 打包为 lib/client.js（CJS bundle，ModuleLoader 包装），
 * 由 package.json 的 dsh.client 声明收录。ID 与布局与动态模式隔离：
 *   槽位 conversation.input.right（工具行右侧、发送键前）、
 *   RPC 前缀 dshprofile-static、CSS 类前缀 dshprofile-static。
 *
 * 能力来源（静态模式无闭包符号）：
 *   React      — seed word require('react')
 *   call       — ctx.connection.rpc.call('/rpc', method, payload) 解包 RpcResult
 *   insertCss  — document.createElement('style')（dsh-custom-header 同款做法）
 */
import React from 'react'
import { clientCore } from '../core/client.js'

/** 服务依赖：slots（槽注册）+ connection（RPC 通道调用）均为硬依赖。 */
export const inject = ['slots', 'connection']

/** 插件入口：注册下拉框到静态槽位。 */
export function apply(ctx) {
  const connection = ctx.get('connection')
  if (connection === undefined) return
  clientCore(ctx, {
    slotName: 'conversation.input.right',
    slotId: 'dsh-profile-selector-static',
    rpcPrefix: 'dshprofile-static',
    cssPrefix: 'dshprofile-static',
  }, {
    React,
    call: async (method, args) => {
      const result = await connection.rpc.call('/rpc', method, args)
      if (result.ok) return result.value
      throw new Error((result.error && result.error.message) || 'RPC failed')
    },
    insertCss: (css) => {
      if (typeof document === 'undefined') return
      const el = document.createElement('style')
      el.textContent = css
      document.head.appendChild(el)
    },
  })
}
// 注意：不要 `export default apply`。DSH 0.1.2-alpha.2 的 loader `unwrapExports` 会优先取
// exports.default 并解包成裸函数，导致插件对象上的 `inject` 丢失——静态 client 条目由 kernel
// 按名字创建（无 options inject），只靠 bundle 导出的 inject 等待 slots/connection；
// 丢失后 apply 立即执行、ctx.get('connection') 为 undefined → 静默退出 → 下拉框不渲染。
// 只导出 { inject, apply }（与 dsh-custom-header 一致），让 unwrap 返回完整对象（见 README §七 pkg-23）。