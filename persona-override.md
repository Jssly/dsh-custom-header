# persona 提示词清空 / 替换：在 dsh-profile-selector 上的实现方案

> **状态**：✅ **已实现**（2026-10-16，功能版本 pkg-28）。本文档是本次改动的**设计依据**（只保留最终方案）；
> 实现落点、坑位、验证记录以 `internals.md` 与 ops-notes.md 为准，两者与本文档一一对应。
> **日期**：2026-10-16
> **适用面**：DSH Web 模式（`dsh --profile web`）；实现落在插件本体 `dsh-profile-selector`
> （本仓库 `/mnt/f/git/node/dsh-scene`，包名与目录名不同），对**所有使用该插件的工作区**生效
> **定位**：本文档**只保留最终采用的实现方案**；调研阶段评估过的其它路线不在此展开。
> **关联**：`features.md`（`global_prompt` / persona 段覆盖）、internals.md、internals.md、CHANGELOG.md 的 pkg-28、deployment.md；
> ops-notes.md

---

## 一、需求

Web 模式下，模型看到的系统提示词开头有两句固定身份声明：

```
You are an AI agent powered by DeepSeek Harness.
You are a coding agent powered by the deepseek-v4.1-flash-free model.
```

**目标：去掉（或替换）第 2 句，并且要能按工作区/会话配置。**

约束与现状：

| 项 | 现状 |
|---|---|
| 使用面 | 只用 Web 模式，不用 TUI，**不使用 Minimal 模式** |
| 第 1 句 | 由声明式开关关闭（见 §4.6） |
| 第 2 句 | host 层改不掉（见 §三），必须走 §四 的监听器 |
| 实现落点 | `dsh-profile-selector`（`dsh-scene` 项目），不改 DSH 任何文件 |

---

## 二、背景：那两句分别从哪里来

| 句子 | section 名 | order | 注册者 | 作用域 | 开关 |
|---|---|---|---|---|---|
| `You are an AI agent powered by DeepSeek Harness.` | `harness:identity` | −1000 | `dsh-system-prompt` 插件（构造期条件注册） | global | `includeHarnessIdentity` |
| `You are a coding agent powered by the {{model}} model.` | `deployment:persona-prefix` | 0 | **preset 里的 `dsh-persona` 行** | agent scope | preset 的 `persona.config.prefix` |

order 常量定义在 `dsh-system-prompt/lib/index.js` 的 `SECTION_ORDERS`：`HARNESS_IDENTITY: -1e3`、`DEPLOYMENT_PERSONA_PREFIX: 0`、`DEPLOYMENT_PERSONA_SUFFIX: 10200`。

### 2.1 四个 shipped preset 都挂了 persona 行

| preset | `persona.prefix` | persona 的其它键 | plugins 顶层项数 |
|---|---|---|---|
| standard（Web 默认） | `You are a coding agent powered by the {{model}} model.` | — | 22 |
| ptc | 同一句 | — | 见 `ptc.patch.yml` |
| cordis（Creator 模式用） | 同一句 | — | 见 `cordis.patch.yml` |
| minimal | `You are a helpful software engineer assistant.` | `complete: true`、`includeRuntimeContext: false` | 4 |

⚠️ minimal 的 `complete: true` 是本方案唯一不适用的情形，见 §五。

### 2.2 决定"能怎么改"的四条机制

1. **同名 shadow**：agent scope 的 section 按名字 shadow global 的同名 section；名字不同则两者并存。
2. **同层重复注册会抛错**：`dsh-system-prompt` 用 `NamedEntries` 保证同一 layer 内名字唯一（"duplicates within one layer throw"）。persona 槽位在 agent 层**已有 owner**（preset 的 persona 行），所以**不能**靠"再注册一个同名 section"来覆盖它——这是必须改走装配改写的原因。
3. **渲染期按长度过滤**：`renderPrompt` 结尾是 `.filter((text) => text.length > 0).join("\n\n")`。空串 section 被丢弃（无痕）；`" "` 长度为 1 会被保留，反而多出一个只含空格的段落。**要"没有这段"，就写空串，不要写空格。**
4. **host 的 `personaPrefix` 在 Web 下无效**：它注册在 global 的 `deployment:persona-prefix`，被 preset 在 agent scope 的同名注册 shadow。改它只影响无 preset 的场景（TUI）。

### 2.3 装配流水线的顺序（本方案成立的根据）

`assemble()` 依次做：合并 global 层与该 scope 的层 → 分离工具参数 → 段排序 → **运行按作用域筛选的 `system-prompt/assemble` waterfall** → **把有效的 complete 段恢复为唯一段** → 应用运行时上下文抑制器。

关键点：**到 waterfall 运行时，preset 的 persona 段与 global 的 `harness:identity` 段都已经在 `assembly.sections` 数组里了**。所以监听器直接改写它们即可，无需与任何插件抢注册，也没有时序问题。

---

## 三、为什么第 2 句不能在 host 层解决

`dsh-system-prompt` 的 config 里有 `personaPrefix`（部署级 persona，global 的 `deployment:persona-prefix`，order 0），看起来改它就行。但 preset 的 persona 行在 **agent scope** 注册了**同名** section（order 也是 0），按 §2.2-1 **scoped 的那份胜出**：

- 改 host 的 `personaPrefix` → Web 会话看不到任何变化；
- §2.1 表明四个 shipped preset 全都挂了 persona 行，Web 下**不存在**"靠 host 配置生效"的窗口。

---

## 四、实现方案（最终）

### 4.1 职责分工

| 目标 | 手段 | 理由 |
|---|---|---|
| `harness:identity` | **声明式开关** `includeHarnessIdentity: false`（§4.6） | 有官方开关，用最弱够用的机制 |
| `deployment:persona-prefix` | **`system-prompt/assemble` 监听器**（§4.3） | 槽位在 agent 层已有 owner（§2.2-2），只能改装配结果 |

`dsh-agent-preset/skills/cordis-plugin-development/references/practices.md` 第 10 行给出了机制强度排序：`ctx.tools.restrict()` < `ctx.tools.guard()` < waterfall 监听器 < `system-prompt/assemble`（替换整个 assembly），并建议"用最弱够用的机制"。同文件第 17 行还写着"不要监听 `system-prompt/assemble` 来增删工具或文本"——那是**面向普通插件**的取向。本需求是例外（persona 槽位同层已有 owner，没有更弱的可用手段），**代价是必须自己保留其它插件的贡献，见 §4.5。**

### 4.2 官方签名与两个可照抄的范例

类型声明（`dsh-system-prompt/lib/types/index.d.ts:27`）：

```ts
'system-prompt/assemble'(
  this: Scoped<SystemPrompt>,
  assembly: PromptAssembly,
  context: AssembleContext,
  next: () => Promise<PromptAssembly>
): Promise<PromptAssembly>
```

DSH 内部同款用法两例——**实现时直接照抄形态**：

**范例一：在 agentCtx 上挂，`await next()` 后返回新对象**（`dsh-agent/lib/index.js:167-180`）

```js
const disposeAssembly = agentCtx.on("system-prompt/assemble", async (_assembly, _context, next) => {
  const assembled = await next()
  // …按需改写…
  return {
    ...assembled,
    variables: { ...assembled.variables, provider, model }
  }
})
```

**范例二：带 `{ prepend: true }` 控制监听顺序，并用 `context.agent` 过滤**（`dsh-working-directory/lib/index.js:48-65`）

```js
ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
  if (context.agent === void 0) return next()
  await this.ensure(context.agent, context.signal)
  const assembly = await next()
  // …按需改写…
  return assembly
}, { prepend: true })
```

要点：**必须调用 `await next()`**；返回**新对象**而不是原地改（范例一的写法更安全）；监听点是**按作用域筛选**的，挂在该 agent 的 ctx 上只影响该会话。第三处可参考的监听范例在 `dsh-session-reference/lib/index.js:459`。

### 4.3 代码骨架

```js
// src/core/host.js —— 与 IDENTITY_SECTION 并列的常量
const PERSONA_SECTION = 'deployment:persona-prefix'   // order 0（本方案新增）
const HARNESS_IDENTITY = 'harness:identity'           // 与 core/host.js:61 的 IDENTITY_SECTION 同值

/**
 * 在 agent 作用域挂装配监听器。到这一步，preset 的 persona 段与 global 的
 * harness:identity 段都已在 assembly.sections 里，无需抢注册、无时序问题。
 * 返回 disposer，由调用方在会话结束时释放（与现有 applyIdentity 的 disposer 一并管理）。
 *
 * resolveOverride() 每次装配都重新求值，这样切档案/改配置后无需重挂监听器。
 */
function installPromptOverride(agentCtx, resolveOverride) {
  return agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()                    // ★ 必须调用；异常不要吞（§4.5-2）
    const override = resolveOverride()
    if (!override || !Array.isArray(assembled.sections)) return assembled

    const sections = assembled.sections
      .filter((s) => !(override.dropIdentity && s.name === HARNESS_IDENTITY))
      .map((s) => {
        if (s.name !== PERSONA_SECTION) return s
        // 空串 → 渲染时被 length 过滤丢弃，等价于"没有这段"（§2.2-3）
        return { ...s, text: override.personaText }
      })

    // ★ 只改 sections；tools / contexts / variables 原样透传（§4.5-1）
    return { ...assembled, sections }
  })
}
```

补充说明：到装配阶段时，`section.text` **已经是解析后的字符串**（`assemble()` 里对函数式 text 已调用过一次），所以直接赋新字符串是安全的。

### 4.4 配置键

在 `.deepseek.yaml` 中，与现有 `workspace.global_prompt` 并列新增：

| 键 | 语义 |
|---|---|
| `workspace.persona_prompt: <path>` | 用该文件正文**替换** persona 段 |
| `workspace.persona_clear: true` | **清空** persona 段（写入 `text: ''`） |
| 两者都缺省 | **完全不改写**，保持现状 |

⚠️ 语义差异要写进代码注释：`global_prompt` 把"空值 / 空文件"视为**未配置**；而本需求的核心恰恰是"清空"，所以清空必须由显式键表达，不能沿用"空即未配置"。

### 4.5 三条自律（必须遵守）

1. **只改 `sections`**，`tools`、`contexts`、`variables` 必须原样透传。监听器拿到的是整个 assembly：改坏 `tools` 会毁掉工具 schema；丢掉 `contexts` 会丢工作目录等运行时上下文；覆盖 `variables` 会打断 `dsh-agent` 在监听器里做的 provider/model 捕获（范例一就是在做这件事）。这是使用最强机制的代价。
2. **绝不要 `catch` 住 `next()` 的异常后返回空 assembly。** 官方 waterfall 由框架调度，抛错会被上游正确处理；一旦自行吞掉异常再返回 `{ sections: [], contexts: [], tools: [] }`，下游对 `sections` 的处理就会崩溃，用户侧表现为"任务做到一半突然像换了个人""状态存不下来"这类难查的故障。**这个坑是真实踩过的**——第三方插件 dsh-purge 的猴补丁实现里为此专门写了兜底并在注释中记录（它不走官方 waterfall，才需要自己扛这些）。
3. **不改 `name` / `order`**，只改 `text`（以及按需整段删除）。把排序交给框架，避免与其它插件争位置。

### 4.6 `identity` 的声明式开关

用顶层 id 覆盖条目关闭官方开场白，位置在 `dsh-profile-selector/cordis.patch.yml` **顶层**（与 `- insert:` 平级）：

```yaml
- id: system-prompt
  config:
    includeHarnessIdentity: false

- insert:
    - id: dsh-profile-selector
      name: dsh-profile-selector
      inject: [connection, webServer]
```

要点：

- **不要写 `name`**：顶层条目按 id 命中已存在行做 config 覆盖；写了 `name` 会被当成"新增行"解析，报
  `disabling profile plugin row …: its declared dsh requirements cannot be validated: Cannot read properties of undefined (reading 'startsWith')`。
- **整块替换**：本条目会替换 web-app 层设的 `personaPrefix`，host 层 persona 回落为 `""`。Web 会话无感（被 preset shadow），只影响 TUI 那类场景。
- **与 profile patch 二选一**：`~/.dsh/profiles/web/cordis.patch.yml` 在所有 bundle 层**之后**应用，优先级更高。两处都写，profile 那条会盖掉插件这条（并整块替换掉插件里将来可能新增的键），属于"配置不生效"类疑难杂症的源头。
- 需要**重启 `dsh web`** 才生效（bundle patch 只在启动时应用，新建会话不算）。

---

## 五、Minimal 模式：适用性与将来的启用路径

### 5.1 四个模式的 complete 情况

| 模式 | persona 的 `complete` | 本方案的改写是否被推翻 | 是否适用 |
|---|---|---|---|
| Standard（Web 默认） | 无 | 否 | ✅ |
| cordis（Creator 模式用） | 无 | 否 | ✅ |
| ptc | 无 | 否 | ✅ |
| **minimal** | **`true`** | **是** | ❌ |

原因在 §2.3 的流水线顺序：**complete 恢复发生在 waterfall 之后**，它会把 `sections` 直接替换成 `[completeSection]`，于是监听器刚才的改写被整段丢弃。

### 5.2 现行处理与失败模式

本项目**不使用 Minimal 模式**（新会话默认是 Standard；Creator 用 cordis；三者皆非 complete），因此**不做任何处理，也不需要抄 minimal 的 4 项 plugins**。

但必须知悉它的失败模式：**静默失效**。若某天会话切到 Minimal（UI 手选、被设为新会话默认、或某个自动化流程选择了它），本方案的注入会**无声失效**——不报错、不警告，只是提示词里没有那段。

> **排查口诀：某个会话里提示词没生效 → 先看它当前是哪个模式，而不是翻代码。**

如需主动兜底，可在监听器里加一行诊断（检测到 complete 时记 warn），但不建议为此引入修复逻辑。

### 5.3 将来启用 Minimal 时的三条路径

`complete: true` 让本方案在 Minimal 下失效。若将来确实要用这个模式，三条路可选：

| 路径 | 做法 | 代价 |
|---|---|---|
| ① 保持现状 | 什么都不做，接受该模式下注入失效 | 只影响 Minimal 会话 |
| ② 关掉 complete | 覆盖 `preset-minimal` 声明，把 persona 的 `complete` 写死 `false`（见下） | **必须整块重述该 preset 的 `plugins`**；**必须补回 `agent-instructions`** |
| ③ 改在最终结果上改写 | 不用官方 waterfall，改为包装 `assemble` 方法、在最终 assembly 上改写 | 要自行承担框架兼容成本（cordis 的 shadow method 代理、disposer 生命周期、原生异常兜底），也就是 §4.5-2 那个坑的来源 |

**路径 ② 的隐蔽陷阱**：minimal 的 4 项 plugins 里**没有 `agent-instructions`**——它靠 `complete: true` 让 persona 成为唯一段，所以不需要注入 `AGENTS.md`。一旦关掉 complete 而不补这一行，工作区的 `AGENTS.md`（语言要求、文件修改规范）就再也不会进提示词：

```yaml
      - id: persona
        name: '@deepseek-ai/dsh-persona'
        config:
          prefix: ""
          complete: false              # ← 写死
          includeRuntimeContext: false
      - id: agent-instructions         # ★ 关掉 complete 后必须补这一行
        name: '@deepseek-ai/dsh-agent-instructions'
        config:
          maxBytes: 65536
```

**路径 ③ 的特点**：改写发生在 complete 恢复**之后**，因此天然不受它影响，不需要动 minimal 的任何配置——代价是要自己扛框架兼容那一摊。

⚠️ 三条路径都以 §5.1 的判定为前提：**complete 恢复发生在 waterfall 之后**（依据 `dsh-system-prompt/lib/index.js:398-405`）。若上游改动该顺序，本节结论需重新核对。

---

## 六、风险与回退

| 风险 | 说明 | 缓解 |
|---|---|---|
| 最强机制的连带责任 | 监听器拿到整个 assembly，改错会破坏工具/上下文/变量 | 严格遵守 §4.5 |
| 静默失效（minimal） | complete 恢复推翻改写，且无报错 | §5.2 的排查口诀；不使用 Minimal 即无需处理 |
| 上游段名变更 | `harness:identity` / `deployment:persona-prefix` 若改名，filter/map 会静默落空 | 监听器命中 0 次时记一条 warn |
| 覆盖条目写错位置 | `name` 写进顶层覆盖、或两处 patch 重复写 | §4.6 的四条要点 |
| 空串与空格混淆 | `" "` 会留下一个空行段落 | 要"无痕"就写 `""`（§2.2-3） |

**回退**：释放监听器 disposer（删掉注册）即可，磁盘与 profile patch 均不受影响。

---

## 七、参考：关键文件与行号

DSH 包根：`<DSH>` = `/home/j/.nvm/versions/node/<ver>/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`
（本机当前运行 node **v22.23.2**；项目 `README.md` 记录的 v24.19.0 路径已过时，以实际安装为准。）

| 文件 | 位置 | 内容 |
|---|---|---|
| `<DSH>/dsh-system-prompt/lib/index.js` | 10–43 | `SECTION_ORDERS`（`HARNESS_IDENTITY: -1e3`、`DEPLOYMENT_PERSONA_PREFIX: 0`、`DEPLOYMENT_PERSONA_SUFFIX: 10200`） |
| 同上 | 117–119 | `renderPrompt` 的 `filter(text => text.length > 0)`（§2.2-3） |
| 同上 | 214–220 | `Config`：`includeHarnessIdentity` / `includeRuntimeContext` / `personaPrefix` / `personaSuffix` / `toolOrder` |
| 同上 | 228–242 | 构造期注册 `harness:identity`（条件）与 `deployment:persona-prefix`（无条件） |
| 同上 | 398 / 399–405 | 调用 waterfall；**随后的 complete 恢复**（§五 的根据） |
| `<DSH>/dsh-system-prompt/lib/types/index.d.ts` | 27 | `system-prompt/assemble` 类型签名（§4.2） |
| `<DSH>/dsh-agent/lib/index.js` | 167–180 | **范例一**：agentCtx 上挂监听器、透传并改写 variables |
| `<DSH>/dsh-working-directory/lib/index.js` | 48–65 | **范例二**：`{ prepend: true }`、`context.agent` 过滤、`next()` 用法 |
| `<DSH>/dsh-session-reference/lib/index.js` | 459 | 另一处监听范例 |
| `<DSH>/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md` | 10 / 17 | 机制强度排序；"不要用 assemble 监听器增删文本"的取向（§4.1） |
| `<DSH>/dsh-persona/README.md` | 12 / 49 / 53 / 65 | persona 行只用于 shadow 部署级 persona；`prefix` required；`complete` 语义 |
| `<DSH>/dsh-web-app/cordis.patch.yml` | 17–20 | Web 层给 host 设 `personaPrefix` |
| `<DSH>/dsh-web-app/presets/standard.patch.yml` | 10–128 | standard 的 22 项 plugins |
| `<DSH>/dsh-web-app/presets/minimal.patch.yml` | 4–78 | minimal 的 4 项 plugins + `complete: true`（**无 `agent-instructions`**） |
| `<DSH>/dsh-app-boot/lib/index.js` | 2305–2336 | profile 行 preflight：缺 `name` 时抛 `startsWith` 并被禁用（§4.6） |
| 本项目 `src/core/host.js` | 符号索引（行号随改动漂移，按符号检索） | `IDENTITY_SECTION` / `PERSONA_SECTION`（§4.3 新增）/ `applyIdentity`（disposer 管理模式）/ `applyPersona` / `resolvePersonaText` / `installPromptOverride`；说明见 internals.md |

用户侧文件：

| 文件 | 说明 |
|---|---|
| `~/.dsh/profiles/web/cordis.patch.yml` | profile patch 层。§4.6 的覆盖已放进**插件自带 patch**，故此文件里原有的同款条目**已删除**（2026-10-16）——两处只能写一处 |
| `~/.dsh/profiles/web/package.json` | bundles 列表，含 `dsh-profile-selector`（顺序在 `dsh-web-app` 之后，可覆盖 preset 行） |
| 本项目 `cordis.patch.yml` | 插件自带 patch 层（§4.6 的落点；顶层 `- id: system-prompt` + `includeHarnessIdentity: false`，**不要写 `name`**） |
| 本项目 `.deepseek.yaml` | 档案源 + `workspace.global_prompt` + §4.4 新增的 `persona_prompt` / `persona_clear`（当前启用 `persona_clear: true`） |
