# 功能与 UI

> 插件**对外可见的行为**（下拉框、注入内容、档案约定）。改功能前先读这里；
> 内部实现与已知坑见 `internals.md`，部署见 `deployment.md`。

1. **下拉框位置**（双模式不同，见 internals.md）：
   - 动态（开发）：输入卡片底部工具行左侧，`[+][🛡 Workspace Write][▾profile-default][模型][上下文][发送]`。
     实现：Client 注册 `conversation.input.left` 槽（list, scope session），顺序排在权限选择器（accessSelect）之后。
   - 静态（发布）：工具行右侧、发送键前，`[+][🛡 Workspace Write][模型][上下文][▾profile-default][发送]`。
     实现：Client 注册 `conversation.input.right` 槽。
2. **选项文案**：`profile-<title>`——title 取档案子项的可选 `name` 字段（如 `default: { name: "分析师" }` → `profile-分析师`），
   缺省回退为档案 key（如 `dev` 无 `name` → `profile-dev`）。无空值项、无"系统默认"项。
3. **默认行为**：新会话打开时**自动加载 `default` 档案**（若配置中没有 default 则加载第一个档案）；
   每个会话只自动触发一次（Client `autoFired` Set）。
4. **切换**：选中即切换该会话的档案正文；成功反馈仅显示在 select 悬停 title（tooltip）
   （`已切换: dev · temp 0.2`），**不渲染行内文字**（避免挤动布局导致下拉框错位）；仅失败渲染红色 `.err`。
5. **持久性**：档案状态存于 Host 内存 `active` Map（sessionId → 档案），刷新页面不丢（激活的是同一 Host 进程）；
   DSH 重启后需重新激活（新会话打开时自动加载 default）。
6. **注入内容**：`【当前会话已通过界面选择 .deepseek.yaml 提示词档案「<name>」，以下为该档案的完整指令，请以其中的角色设定与任务要求为准执行】\n\n<档案正文>`；
   档案 `file` 可以是**单一路径或路径数组**——数组时按**声明顺序**逐个读盘，用空行（`\n\n`）依次拼接为一段正文，
   前置说明头只加一次；任一文件读不到即**整体失败**（红字报错，不注入「半个档案」）。占位符替换规则见 internals.md。
7. **工作区级开场白覆盖（`workspace.global_prompt`）**：把 `.deepseek.yaml` 的
   `workspace.global_prompt` 指向的文件正文，注册为**同名 section `harness:identity`**（agent 作用域），
   从而**完全替换** DSH 自带的第一方开场白 `You are an AI agent powered by DeepSeek Harness.`
   ——用于消除该英文自我介绍导致的「AI 默认用英文思考」问题。
   - 与档案选择**解耦**：不依赖下拉框，`agent/created` 时对每个会话自动生效；
   - 配置示例：`workspace: { global_prompt: doc/prompts/global.md }`（路径相对**会话 cwd**，与档案 `file` 规则一致）；
   - **未配置（键缺失 / 值非字符串 / 空值）/ 文件不存在 / 文件为空 → 一律「不覆盖」**：先卸载已有覆盖
     （`disposer` + `forceCleanSection` 兜底，见 internals.md），再保留 DSH 默认开场白（只记 warn，不阻断会话创建）；
   - 生效确认：下拉框悬停 title 追加 `· 开场白覆盖: <file>`；`.state` RPC 返回 `globalPrompt` 字段。
8. **子代理会话（2026-09-20 新增）**：DSH 委派出的子代理会话（session header `origin: 'subagent'`）由 **Host 侧自动继承
   父会话当前档案**（父无选择则回退 `default`），无需界面操作；Client 对子代理会话**不再自动加载档案**
   （避免与 Host 继承重复、并绕开「未激活」竞态），悬停 title 追加 `· 子代理会话(继承父会话档案)`。
   - **不再出现红字**：未激活的会话（含子代理、冷会话）一律走排队（`pending`），不再回 `会话不存在或未激活`（internals.md）。
   - ⚠️ **one-shot 子代理会话没有输入区**：DSH `ui-subagent` 会用只读 composer 接管 `conversation.composer` 链，
     `conversation.input.left/right` 槽整体不渲染——这是 DSH 的既有设计，插件无法在该会话显示下拉框
     （continuable 子代理会话在有输入区时正常显示）。详见 internals.md。
9. **persona 段清空 / 替换（`workspace.persona_prompt` / `workspace.persona_clear`）**：
   去掉（或替换）系统提示词开头**由 preset 自带**的那句
   `You are a coding agent powered by the {{model}} model.`（段名 `deployment:persona-prefix`）——
   即 `harness:identity`（第 1 句）之外的**第 2 句**。
   **默认就是「清空」：什么都不配也生效，连工作区没有 `.deepseek.yaml` 也一样。**
   - 与档案选择、下拉框**完全解耦**：`agent/created` 时在会话 agent 作用域挂
     `system-prompt/assemble` 监听器，改写**装配结果**里的该段（不能用同名 shadow——该槽位在 agent 层
     已有 owner，见 internals.md）；
   - 配置与优先级（`.deepseek.yaml` → `workspace`）：

     | 配置 | 结果 |
     |---|---|
     | 什么都不写（或没有 `.deepseek.yaml`） | **清空**（默认行为） |
     | `persona_clear: true` | 清空（显式写出；优先于 `persona_prompt`） |
     | `persona_prompt: <path>` | 用该文件正文**替换**该段（路径相对会话 cwd，占位符见 internals.md） |
     | `persona_clear: false` | **不改写**——保留 preset 原句（唯一的 opt-out） |

   - 示例：

     ```yaml
     workspace:
       # 默认即清空，无需配置；按需选用下面两行
       # persona_prompt: doc/prompts/persona.md   # 换成自己的话
       # persona_clear: false                     # 或：保留 DSH 原句
     ```
   - **读不到替换源**（文件不存在）→ 本次不改写 + 一条 warn（保留 preset 原句，不静默清掉）；
     替换源为**空文件** → 等价清空；
   - 无 UI / RPC 变更（不新增下拉框与字段）：诊断靠 Host 日志与让会话自述 system prompt；
   - ⚠️ **替换正文沿用原 persona 段的插值规则**：正文里完整的 `{{…}}` 仍会按 prompt variables
     解析（未知变量会让装配抛错）；要「原样注入」就别在正文里写 `{{…}}`。

---

## 档案内容约定

> 本节属于**提示词档案正文**（`doc/prompts/*.md`）与工作区配置的内容约定，与插件逻辑无关；
> 档案如何被解析、注入与占位符替换见上文。

- **档案约束**：客户不持有现货、不做备兑；标的 = 上证50ETF华夏（510050）。
- **档案指向**（由 `.deepseek.yaml` 的 `workspace.system_prompts` 定义）：

| 档案 key | 下拉框显示 | 正文文件 |
|---|---|---|
| `default` | 功能开发 | `doc/prompts/default.md`（**当前为空文件**——档案声明头照常注入，正文为空） |
| `ai` | 分析师模式 | `doc/prompts/ai.md` |
| `dev` | 期权开发模式 | `doc/prompts/dev.md` |

- `doc/prompts/global.md` **不是档案**，而是工作区开场白覆盖正文（由 `workspace.global_prompt` 指向）；
  当前该键在 `.deepseek.yaml` 里处于注释状态，**未启用**。
