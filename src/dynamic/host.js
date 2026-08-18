/**
 * dsh-profile-selector — 动态模式 Host 壳（开发用）
 *
 * 本文件是 cordis_define 的函数体模板：build.mjs 会把 src/core/yaml.js 与
 * src/core/host.js 的源码（去掉 export 关键字）内联到 /*__CORE_YAML__*\/ 与
 * /*__CORE_HOST__*\/ 占位符处，生成 dist/dynamic/host.js 供 cordis_define 使用。
 * 请勿直接编辑 dist/dynamic/*.js（构建产物）。
 */
/*__CORE_YAML__*/
/*__CORE_HOST__*/
return {
  apply(ctx) {
    hostCore(ctx, {
      sectionName: 'dsh-profile:profile',
      rpcPrefix: 'dshprofile',
    }, {
      // 动态模式：harness.handle 直接注册，handler 返回业务结果
      handle: (method, handler) => harness.handle(method, handler),
    })
  },
}