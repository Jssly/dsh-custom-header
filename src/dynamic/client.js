/**
 * dsh-profile-selector — 动态模式 Client 壳（开发用）
 *
 * 本文件是 cordis_define 的函数体模板：build.mjs 会把 src/core/client.js 的源码
 * （去掉 export 关键字）内联到 /*__CORE_CLIENT__*\/ 占位符处，生成
 * dist/dynamic/client.js 供 cordis_define 使用。请勿直接编辑 dist/dynamic/*.js。
 */
/*__CORE_CLIENT__*/
return {
  apply(ctx) {
    clientCore(ctx, {
      slotName: 'conversation.input.left',
      slotId: 'dsh-profile-selector',
      rpcPrefix: 'dshprofile',
      cssPrefix: 'dshprofile',
    }, {
      // 动态模式：React/styles/host 均为闭包符号
      React,
      call: (method, args) => host.call(method, args),
      insertCss: (css) => styles.insert(css),
    })
  },
}