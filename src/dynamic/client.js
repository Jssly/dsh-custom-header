/**
 * dsh-profile-selector — 动态模式 Client 壳（开发用）
 *
 * 本文件是 cordis_define 的函数体模板：build.mjs 会把 src/core/client.js 与
 * src/core/settings-client.js 的源码（去掉 export / import 关键字）内联到
 * /*__CORE_CLIENT__*\/ 与 /*__CORE_SETTINGS_CLIENT__*\/ 占位符处，生成
 * dist/dynamic/client.js 供 cordis_define 使用。请勿直接编辑 dist/dynamic/*.js。
 *
 * 两个核心各自注册一块 UI（互不依赖）：
 *   clientCore         → 输入区下拉框（conversation.input.left）
 *   settingsClientCore → 设置面板的「提示词档案」页（settings.section）
 * 槽 id / RPC 前缀 / CSS 前缀都按动态模式的取值传（与静态模式隔离，见 internals.md）。
 */
/*__CORE_CLIENT__*/
/*__CORE_SETTINGS_CLIENT__*/
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
    settingsClientCore(ctx, {
      settingsSlotId: 'dsh-profile-selector-settings',
      rpcPrefix: 'dshprofile',
      cssPrefix: 'dshprofile-settings',
    }, {
      React,
      call: (method, args) => host.call(method, args),
      insertCss: (css) => styles.insert(css),
    })
  },
}
