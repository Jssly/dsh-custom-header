/**
 * dsh-profile-selector — 共享核心：提示词设置的三层配置模型（纯函数，零依赖）
 *
 * 双模式共用：动态模式由 build.mjs 内联进 cordis_define 函数体；
 * 静态模式由 src/static/*.js 以 ESM import 引用。
 *
 * ## 三层合并
 *
 * 优先级从低到高，**高者按字段覆盖低者**（未设置的字段沿用低层，即「值覆盖」，
 * 不是「整份替换」）：
 *
 *   1. 内置默认  DEFAULT_SETTINGS（代码常量）
 *   2. 插件配置  cordis.patch.yml → `- id: dsh-profile-selector → config`
 *                （同时也是设置面板**写入**的那一层）
 *   3. 工作区覆盖 会话 cwd 的 .deepseek.yaml → `workspace` 段
 *
 * 举例：插件配置 `global_prompt: /opt/global.md`、工作区只写了
 * `persona_clear: false` —— 结果是「开场白仍用 /opt/global.md」+「persona 段保留原句」，
 * 工作区没提的 `includeHarnessIdentity` 继续沿用插件配置的值。
 *
 * ## 字段
 *
 * 键名与 .deepseek.yaml / patch config 保持一致（不做大小写转换，用户在哪一层
 * 看到的都是同一个名字）。值类型不符或键缺失一律记为 `undefined` = 「本层未设置」。
 *
 * | 键 | 类型 | 语义 |
 * |---|---|---|
 * | `global_prompt` | string | 开场白覆盖文件路径；**空串 = 本层不覆盖**。插件层是绝对路径（插件全局设置），工作区层是相对会话 cwd 的路径（与档案 `file` 规则一致） |
 * | `persona_clear` | boolean | `true` = 清空 preset 自带的 `You are a coding agent powered by the {{model}} model.`；`false` = 保留原句 |
 * | `includeHarnessIdentity` | boolean | `false` = 关闭 DSH 第一方开场白 `You are an AI agent powered by DeepSeek Harness.`；`true` = 保留 |
 *
 * `global_prompt` 优先级高于 `includeHarnessIdentity`：配了开场白覆盖文件就按文件来，
 * 该开关只在没有可用覆盖文件时决定那句英文的去留（见 host.js 的 resolveIdentity）。
 */

/** 设置键的固定顺序（UI、patch 受管块、诊断输出都按它排列）。 */
export const SETTINGS_KEYS = ['global_prompt', 'persona_clear', 'includeHarnessIdentity']

/** 每个键的期望类型：归一化时据此校验（类型不符 = 本层未设置）。 */
const KEY_TYPES = {
  global_prompt: 'string',
  persona_clear: 'boolean',
  includeHarnessIdentity: 'boolean',
}

/**
 * 内置默认值 —— 与「本插件引入设置项之前」的既有行为逐项等价：
 * 不清空 = 不覆盖开场白（`global_prompt: ''`）、persona 段清空（`true`）、
 * DSH 第一方开场白关闭（`false`）。
 */
export const DEFAULT_SETTINGS = Object.freeze({
  global_prompt: '',
  persona_clear: true,
  includeHarnessIdentity: false,
})

/**
 * 把任意来源的原始对象归一化为一层设置。
 *
 * 只认 `SETTINGS_KEYS` 里的键，且只认类型正确的值——类型不符/键缺失都不写入结果
 * （= 本层未设置），这样调用方无需区分「键不存在」与「值非法」，两者对合并的语义完全相同。
 *
 * @param raw - 原始对象（patch config / .deepseek.yaml 的 workspace 段 / RPC 入参）。
 * @returns 只含本层**显式设置**的字段的对象（可能为空对象）。
 */
export function normalizeLayer(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const key of SETTINGS_KEYS) {
    if (KEY_TYPES[key] === 'string') {
      if (typeof raw[key] === 'string') out[key] = raw[key].trim()
    } else if (typeof raw[key] === 'boolean') {
      out[key] = raw[key]
    }
  }
  return out
}

/**
 * 按参数顺序逐层合并（后面的层覆盖前面的层，按字段）。
 * @param layers - 任意个层对象；`null` / `undefined` 层被忽略。
 * @returns 合并结果（只含至少被某一层设置过的字段）。
 */
export function mergeLayers(...layers) {
  const out = {}
  for (const layer of layers) {
    if (!layer) continue
    for (const key of SETTINGS_KEYS) {
      if (layer[key] !== undefined) out[key] = layer[key]
    }
  }
  return out
}

/**
 * 求最终生效值：内置默认 ← 插件配置 ← 工作区覆盖。
 * @param pluginLayer - 归一化后的插件层（见 normalizeLayer）。
 * @param workspaceLayer - 归一化后的工作区层；缺省视为空层。
 * @returns 三个键都齐备的生效设置。
 */
export function resolveSettings(pluginLayer, workspaceLayer) {
  return mergeLayers(DEFAULT_SETTINGS, pluginLayer, workspaceLayer)
}

/**
 * 报告每个字段的生效来源，供 UI / 诊断解释「这个值是谁给的」。
 * @returns `{ <key>: 'workspace' | 'plugin' | 'default' }`
 */
export function settingsSources(pluginLayer, workspaceLayer) {
  const out = {}
  for (const key of SETTINGS_KEYS) {
    if (workspaceLayer && workspaceLayer[key] !== undefined) out[key] = 'workspace'
    else if (pluginLayer && pluginLayer[key] !== undefined) out[key] = 'plugin'
    else out[key] = 'default'
  }
  return out
}
