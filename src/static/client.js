/**
 * dsh-profile-selector — 静态模式 Client 壳（发布用）
 *
 * 经 build.mjs 打包为 lib/client.js（CJS bundle，ModuleLoader 包装），
 * 由 package.json 的 dsh.client 声明收录。ID 与布局与动态模式隔离：
 *   槽位 conversation.input.right（工具行右侧、发送键前）、
 *   RPC 前缀 dshprofile-static、CSS 类前缀 dshprofile-static。
 *
 * 两个核心各自注册一块 UI（互不依赖）：
 *   clientCore         → 输入区下拉框（conversation.input.right）
 *   settingsClientCore → 设置面板的「提示词档案」页（settings.section）
 *
 * 能力来源（静态模式无闭包符号）：
 *   React      — seed word require('react')
 *   call       — ctx.connection.rpc.call('/rpc', method, payload) 解包 RpcResult
 *   insertCss  — document.createElement('style')（dsh-custom-header 同款做法）
 */
import React from 'react'
import { clientCore } from '../core/client.js'
import { settingsClientCore } from '../core/settings-client.js'

/** 服务依赖：slots（槽注册）+ connection（RPC 通道调用）均为硬依赖。 */
export const inject = ['slots', 'connection']

/**
 * 样式注入：按 `data-plugin-css` 标记去重（同一份 CSS 只插一个 <style>）。
 * 两个核心各注入一次自己的样式，且 React 严格模式/重挂载可能重复调用——
 * 不去重就会在 <head> 里堆一串内容相同的标签。
 */
function insertCss(mark, css) {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-plugin-css="' + mark + '"]')) return
  const el = document.createElement('style')
  el.dataset.pluginCss = mark
  el.textContent = css
  document.head.appendChild(el)
}

/** 插件入口：注册下拉框与设置页。 */
export function apply(ctx) {
  const connection = ctx.get('connection')
  if (connection === undefined) return
  const deps = {
    React,
    call: async (method, args) => {
      const result = await connection.rpc.call('/rpc', method, args)
      if (result.ok) return result.value
      throw new Error((result.error && result.error.message) || 'RPC failed')
    },
    insertCss: (css) => insertCss('dsh-profile-selector', css),
  }
  clientCore(ctx, {
    slotName: 'conversation.input.right',
    slotId: 'dsh-profile-selector-static',
    rpcPrefix: 'dshprofile-static',
    cssPrefix: 'dshprofile-static',
  }, deps)
  settingsClientCore(ctx, {
    settingsSlotId: 'dsh-profile-selector-static-settings',
    rpcPrefix: 'dshprofile-static',
    cssPrefix: 'dshprofile-static-settings',
  }, Object.assign({}, deps, { insertCss: (css) => insertCss('dsh-profile-selector-static-settings', css) }))
}
// 注意：不要 `export default apply`。DSH 0.1.2-alpha.2 的 loader `unwrapExports` 会优先取
// exports.default 并解包成裸函数，导致插件对象上的 `inject` 丢失——静态 client 条目由 kernel
// 按名字创建（无 options inject），只靠 bundle 导出的 inject 等待 slots/connection；
// 丢失后 apply 立即执行、ctx.get('connection') 为 undefined → 静默退出 → 下拉框不渲染。
// 只导出 { inject, apply }（与 dsh-custom-header 一致），让 unwrap 返回完整对象（见 CHANGELOG.md pkg-23）。
