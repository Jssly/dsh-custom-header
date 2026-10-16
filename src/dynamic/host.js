/**
 * dsh-profile-selector — 动态模式 Host 壳（开发用）
 *
 * 本文件是 cordis_define 的函数体模板：build.mjs 会把 src/core/ 下的共享核心源码
 * （去掉 export / import 关键字）内联到对应占位符处，生成 dist/dynamic/host.js 供
 * cordis_define 使用。请勿直接编辑 dist/dynamic/*.js（构建产物）。
 *
 * ⚠️ 动态函数体没有模块系统（宿主用 `new Function(wrapped)` 求值），所以：
 *   · YAML 能力用**动态 import** 取 `yaml` 库（apply 因此是 async）；取不到时传 null，
 *     核心会在真正需要解析时明确报错——该模式本就不支持落盘，受影响的是工作区配置解析。
 *   · 动态模式没有「插件包目录下的 cordis.patch.yml」可写，故 patchPath 传 null：
 *     设置面板的改动只在本次运行生效（面板会提示「重启后回退」）。要持久化请用静态模式。
 */
/*__CORE_SETTINGS__*/
/*__CORE_PATCH__*/
/*__CORE_HOST__*/
return {
  async apply(ctx, config) {
    let yaml = null
    try {
      yaml = await import('yaml')
    } catch (err) {
      yaml = null
    }
    hostCore(ctx, {
      sectionName: 'dsh-profile:profile',
      rpcPrefix: 'dshprofile',
    }, {
      // 动态模式：harness.handle 直接注册，handler 返回业务结果
      handle: (method, handler) => harness.handle(method, handler),
    }, {
      // 动态模式也能收到 cordis 传入的 config（cordis_define 的 config 字段）
      config,
      patchPath: null,
      yaml,
    })
  },
}
