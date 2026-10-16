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
7. **设置面板「提示词档案」**（DSH 设置 → 提示词档案；实现：Client 注册 `settings.section` 槽）：
   编辑本插件的**三个全局设置**，不用手改 `cordis.patch.yml`：

   | 控件 | 键 | 语义 |
   |---|---|---|
   | checkbox | `includeHarnessIdentity` | **勾选 = 保留** DSH 第一方开场白 `You are an AI agent powered by DeepSeek Harness.`（系统提示词第 1 句）；不勾选（默认）= 关掉它 |
   | checkbox | `persona_clear` | **勾选 = 清空**（默认）preset 自带的 `You are a coding agent powered by the {{model}} model.`（第 2 句）；不勾选 = 保留原句 |
   | textbox | `global_prompt` | 开场白覆盖文件的**绝对路径**；留空（默认）= 不覆盖（此时第 1 句的去留由上面的开关决定） |

   > 文案与取值**同向**：勾选态直接渲染 `值 === true`。所以标题写「勾选＝怎样」，
   > 例如 `includeHarnessIdentity` 的值 `true` 表示保留，标题就是「保留 DSH 第一方开场白」。

   - **保存**：立即对所有活跃会话生效（无需重启），同时把三个键写进**本插件自己的
     `cordis.patch.yml`**（安装目录 `node_modules/dsh-profile-selector/` 下那份）末尾的受管块，
     供下次启动读回；面板底部显示实际写入路径。
   - **落盘不热重载**：DSH 的 HMR 只监视 profile 层与 home 层的 patch，**不监视 bundle patch** ——
     所以「持久化」与「立即生效」是两条路：写文件管下次启动，内存更新管当前进程。
   - **重装会覆盖**：`file:` 依赖是**拷贝**，重新 `dsh plugin --profile web add file:$(pwd)`
     会用源码仓库那份盖掉受管块（想留住面板里改的值，先把它们抄回仓库那份）。
   - 动态模式（`cordis_define`）没有可写的包目录 → 面板会提示「只在本次运行生效，重启后回退」。

8. **三层设置与「值覆盖」**（实现见 `internals.md`）：

   ```
   内置默认  ←  插件 config（cordis.patch.yml，面板写这一层）  ←  工作区 .deepseek.yaml 的 workspace 段
   ```

   高者**按字段**覆盖低者——工作区只写 `persona_clear` 时，`global_prompt` /
   `includeHarnessIdentity` 继续沿用插件层的值（不是整份替换）。三个键在三层同名：

   | 层 | 位置 | `global_prompt` 的路径基准 |
   |---|---|---|
   | 插件层 | `cordis.patch.yml` 的 `config:`（面板写入受管块覆盖它） | **绝对路径**（插件的全局设置） |
   | 工作区层 | 会话 cwd 的 `.deepseek.yaml` → `workspace` | **相对会话 cwd**（与档案 `file` 同一规则） |

9. **开场白（`harness:identity`）的三种落点**（实现：`resolveIdentity()` → `applyIdentity()`）：
   DSH 那句英文只注册在 **global 层**，所以在该会话的 **agent 作用域**注册同名 section 即可
   只替换它一句（其他工作区/会话不受影响；global 层那份永不改动）。

   | 条件（按顺序判定） | 落点 |
   |---|---|
   | 有效 `global_prompt` 且文件正文非空 | 用该文件正文替换（占位符见 `internals.md`） |
   | 否则 `includeHarnessIdentity: false`（默认） | 注册**空串** → 那句话消失（渲染时被过滤） |
   | 否则 `includeHarnessIdentity: true` | **不注册** → 保留 DSH 默认那句 |

   - `global_prompt` 读不到 / 文件为空 → 记一条 warn，**开关语义不变**（继续按第 2/3 步判断）；
   - 三态之间可自由切换，改完立即生效（面板保存、改 `.deepseek.yaml`、切档案都会重算）；
   - 生效确认：下拉框悬停 title 追加 `· 开场白覆盖: <file>`；`.state` 返回
     `globalPrompt`（覆盖源）与 `identityMode`（`text` / `blank` / `keep`）。
10. **子代理会话（2026-09-20 新增）**：DSH 委派出的子代理会话（session header `origin: 'subagent'`）由 **Host 侧自动继承
    父会话当前档案**（父无选择则回退 `default`），无需界面操作；Client 对子代理会话**不再自动加载档案**
    （避免与 Host 继承重复、并绕开「未激活」竞态），悬停 title 追加 `· 子代理会话(继承父会话档案)`。
    - **不再出现红字**：未激活的会话（含子代理、冷会话）一律走排队（`pending`），不再回 `会话不存在或未激活`（internals.md）。
    - ⚠️ **one-shot 子代理会话没有输入区**：DSH `ui-subagent` 会用只读 composer 接管 `conversation.composer` 链，
      `conversation.input.left/right` 槽整体不渲染——这是 DSH 的既有设计，插件无法在该会话显示下拉框
      （continuable 子代理会话在有输入区时正常显示）。详见 internals.md。
    - 开场白与 persona 覆盖**照常作用于子代理会话**（两者都与档案选择解耦）。
11. **persona 段清空 / 替换（`persona_clear` + `workspace.persona_prompt`）**：
    去掉（或替换）系统提示词开头**由 preset 自带**的那句
    `You are a coding agent powered by the {{model}} model.`（段名 `deployment:persona-prefix`）——
    即 `harness:identity`（第 1 句）之外的**第 2 句**。
    **默认就是「清空」：什么都不配也生效，连工作区没有 `.deepseek.yaml` 也一样。**
    - 与档案选择、下拉框**完全解耦**：`agent/created` 时在会话 agent 作用域挂
      `system-prompt/assemble` 监听器，改写**装配结果**里的该段（不能用同名 shadow——该槽位在 agent 层
      已有 owner，见 internals.md）；
    - 结果由三层设置里的 `persona_clear` 决定，外加工作区专有的替换源 `persona_prompt`：

      | 条件（按顺序判定） | 结果 |
      |---|---|
      | 工作区**显式**写 `persona_clear: true` | **清空**（与同层 `persona_prompt` 冲突时以它为准） |
      | 工作区写了 `persona_prompt: <path>` 且可读 | 用该文件正文**替换**该段（路径相对会话 cwd，占位符见 internals.md） |
      | 合并后的 `persona_clear: false`（工作区或面板给出） | **不改写**——保留 preset 原句（唯一的 opt-out） |
      | 其余（含没有 `.deepseek.yaml`） | **清空**（默认行为） |

      第 1 步只看**工作区层是否显式写了 true**：合并结果里的 true 可能来自内置默认或面板，
      那属于「没有意见」，不该压掉工作区自己给出的替换源。

    - 面板用法：设置 → 提示词档案 → 取消勾选「清空 persona 段」即等价于全局 `persona_clear: false`；
    - 示例：

      ```yaml
      workspace:
        # 默认即清空，无需配置；按需选用下面两行
        # persona_prompt: doc/prompts/persona.md   # 换成自己的话
        # persona_clear: false                     # 或：保留 DSH 原句
      ```
    - **读不到替换源**（文件不存在）→ 本次不改写 + 一条 warn（保留 preset 原句，不静默清掉）；
      替换源为**空文件** → 等价清空；
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

- `doc/prompts/global.md` **不是档案**，而是开场白覆盖正文，有两个可选指向：
  工作区 `.deepseek.yaml` 的 `workspace.global_prompt`（相对 cwd 路径），或插件的全局设置
  `global_prompt`（绝对路径，设置面板那个 textbox）。**当前两处都没启用**——
  `.deepseek.yaml` 里该键处于注释状态，插件默认值是空串（= 不覆盖，那句英文由
  `includeHarnessIdentity` 开关决定去留）。
