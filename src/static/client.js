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

export default apply