# 部署与排障手册

> 动态/静态两种模式的部署步骤、调试手段与数据流边界。
> 功能见 `features.md`，机制与坑见 `internals.md`。

## 如何部署（下次 AI 会话操作手册）

> **两级自检**：`node scripts/verify-offline.mjs`（纯逻辑，无需 DSH）+ 
> `DSH_INSTALL_DIR=<dsh 包目录> node scripts/verify-dsh.mjs`（**关键验证**：用 yaml 库生成/修改的
> patch 文件，DSH 自己的解析器与合并算法能否正确读到 —— 边界值逐字符比对 + 真实 patch 块外不受影响）。
>
> `verify-offline.mjs` 覆盖：真实 `.deepseek.yaml` 结构守护 / 多文件档案合并 / 开场白三种落点 /
> persona 段清空替换 / 子代理档案继承 / 三层设置与设置面板 RPC / 受管块读写 / Client 槽注册契约 /
> 既有行为回归），
> 全过再构建；改解析器、覆盖逻辑、装配监听器、设置模型或会话/子代理语义时请连同该脚本一起维护
> （项数随用例增删变化，以脚本输出为准）。

> ⚠️ **部署方式分两种情况，别混用**：
>
> | 场景 | 做法 |
> |---|---|
> | **静态发布（正式使用）** | **必须**走 DSH 插件安装流程：`dsh plugin --profile web add file:$(pwd)`（必要时先 `remove` 再 add）。**不要手工把文件复制进 profile 目录** |
> | **动态模式 / 本地测试** | **可以直接复制**（或改完直接 `cordis_run mode:'update'`）——测试用的临时手段，测完恢复干净即可 |
>
> **静态发布为什么必须走安装流程**（而不是手工 `cp`）：
> - profile 里那份是 pnpm 管理的 `file:` 依赖拷贝。`add` 会重算依赖指纹、拷贝新版仓库、reconcile
>   `dsh.profile.bundles` 与 `cordis.yml`——**这些都不是手工 `cp` 能做到的**；
> - 手工 `cp -r` 只换文件、不换 package.json / lockfile / bundle 列表里的记录，会留下
>   「文件是新的、依赖记录是旧的」半更新状态；之后 DSH 的 `add` / `remove` / 升级会按旧指纹覆盖或跳过，
>   故障极难定位；手工复制还容易漏文件（新增文档、`cordis.patch.yml` 等）。
>
> **本地测试为什么可以直接复制**：动态模式的正式流程本来就不经过 profile（`cordis_define` + `cordis_run`，
> 见上文），纯本机验证只看效果、不追求依赖记录一致，`cp` 一份进 profile 目录最快。
> 但**测完请恢复干净**：重新 `dsh plugin --profile web add file:$(pwd)`，或
> `dsh plugin --profile web remove dsh-profile-selector`——避免把测试现场当成发布态。
>
> **为什么会有"不复制就不生效"的错觉**（实测 2026-08-18）：`file:` 依赖是**拷贝**而不是符号链接，
> 改代码 / 构建后 pnpm 不会自动刷新（`pnpm install` 报 "Already up to date"），profile 里仍是旧拷贝——
> 这正是静态发布**必须重新 `add`** 的原因。
>
> **发布态重装后务必校验**（实测 2026-09-15）：不带 `remove` 直接 `add` 也能刷新成功，但要确认真的换成了新构建——
> `md5sum lib/index.js "$(readlink -f ~/.dsh/profiles/web/node_modules/dsh-profile-selector)/lib/index.js"`
> 两值必须一致（`lib/client.js`、`cordis.patch.yml` 同理）；不一致说明 profile 里还是旧构建，重启 web 也是旧行为。
> 注意跨文件系统（`/mnt/f` 到 `~/.dsh`）pnpm 无法硬链接，只能整包拷贝。
>
> ⚠️ **重装会盖掉设置面板写入的受管块**：受管块（见 `internals.md`）就写在这份 `cordis.patch.yml` 里，
> 而 `add` 是用仓库那份**整包覆盖**的。所以 `add` 之前先把面板里改过的值抄回仓库这份
> （或直接在仓库这份里改 `config:`），否则重装即丢失。反向也成立：**仓库这份是权威**，面板改的是「本机运行值」。

### 开发模式（动态插件，默认）

动态插件定义在**当前 DSH 进程内存**中；新会话/重启后需用源码重新构建并定义。步骤：

1. **加载技能**（开发前必读）：`skill: cordis-plugin-development`；需要时 `cordis_inspect_list/query` 查询
   `slots`/`systemPrompt`/`agents` 等契约与最新签名。
2. **构建**：`node build.mjs`（若改了 `src/core/` 或壳；产物在 `dist/dynamic/` 与 `lib/`）。
3. **读取产物**：`dist/dynamic/host.js` + `dist/dynamic/client.js`（构建产物，含内联核心；勿手改）。
4. **定义插件**：`cordis_define { plugin: { kind: 'new', idPrefix: 'dshy' }, name: 'dsh-profile-selector', purpose, code: { host, client } }`
   —— `code.host`/`code.client` 必须传 **dist/dynamic 产物全文**（不是 src/dynamic 模板，模板含占位符会报
   `hostCore is not defined`）。新会话用 new；已有 dshy-1 时用 `kind:'existing', pluginId:'dshy-1'` 追加 Package。
5. **激活**：`cordis_run { pluginId, packageId, mode: 'run'|'update' }`（首次 run；换版本 update）。
   ⚠️ approval policy 为 ask 时，首次运行需用户在 GUI 批准（awaiting-approval）；批准后为异步 starting。
6. **验证**（GUI 手动）：
   - 输入卡片工具行出现 `▾profile-<name>` 下拉框（权限选择器右侧）；
   - 新会话自动加载 default（悬停 title 显示 `默认加载: default · temp 0.2`）；
   - 连续快速切换 dev ↔ default 多次：无 "already registered"、下拉框不错位、title 显示 `已切换: ...`；
   - 发一条消息验证注入：回复开头/内容应体现「当前会话已通过界面选择 .deepseek.yaml 提示词档案」前置说明，
     且角色设定符合所选档案（default=期权交易员 / dev=开发工程师）。
   - 槽位占用可用 Inspect 确认：`Slots.listSubTree {root:'conversation.input.left'}` →
     occupants 应含 `dyn/dshy-1 → dsh-profile-selector (active)`。
   - **子代理会话**（pkg-27，internals.md）：在主会话委派一个 continuable 子代理，打开其会话 →
     ① 不出现红字「会话不存在或未激活」；② 悬停 title 出现 `· 子代理会话(继承父会话档案)`，档案与父会话一致
     （父选 `ai` 则子代理 `profile-分析师模式`）；③ 让子代理自述 system prompt，应含
     「当前会话已通过界面选择 .deepseek.yaml 提示词档案」段落。one-shot 子代理会话**没有输入区**属 DSH 设计（预期无下拉框）。
   - **persona 段清空/替换**（pkg-28，internals.md；静态/动态同机制）：**新建会话** → 系统提示词里不再出现
     preset 自带的那句 `You are a coding agent powered by the …model.`（`.deepseek.yaml` 配
     **默认即清空**，无需配置）；配 `persona_prompt` 则换成该文件正文、配 `persona_clear: false` 可保留 DSH 原句。同时确认工作区 `AGENTS.md`
     的注入**仍在**（语言要求 / 文件修改规范，来自 `~/.dsh/AGENTS.md`）——persona 只改一个 section，不影响档案与它。
     ⚠️ 若某会话没生效：**先看它当前是哪个模式**（minimal 的 `complete: true` 会让改写静默失效），别先翻代码。
   - **设置面板**（pkg-30，internals.md；仅静态可落盘）：打开 DSH 设置 → 左侧出现「提示词档案」页 →
     三个控件显示当前插件层值（默认 `includeHarnessIdentity` 未勾、`persona_clear` 已勾、`global_prompt` 空）→
     勾上 `includeHarnessIdentity` 保存 → **当前会话立即**恢复那句英文（无需重启、无需新建会话）；
     `global_prompt` 填一个绝对路径保存 → 该句被文件正文替换。面板底部显示写入路径，确认它是
     `…/profiles/web/node_modules/dsh-profile-selector/cordis.patch.yml`，且该文件末尾出现受管块
     （一对 `# >>>` / `# <<<` 整行标记夹住的 `- id: dsh-profile-selector` 条目；**别用 `grep` 判断**
     ——注释里也有类似字样，判据见 `ops-notes.md`）。标记之外的内容必须一字不变。
     ⚠️ 保存报「受管块标记不完整」= pkg-31 那个 bug 回归了，见 `ops-notes.md` 的排查顺序。
     动态模式（无包目录可写）保存后会提示「只在本次运行生效」——属预期。
7. **改动后落盘**：把更新后的核心/壳代码同步写回 `src/`，并在本 README CHANGELOG.md 版本历史登记变更。

> ⚠️ **DSH 进程重启会丢动态插件**（实测 2026-08-18 发生两次）：重启 web（`dsh web`）即重启整个 DSH，
> 内存中的动态插件定义全部消失（`cordis_inspect_self dshy-1` 报 "no dynamic plugin"）。
> 无需惊慌：按步骤 2-5 重新构建 + define + run 即可，功能版本不变（CHANGELOG.md 编号说明）。
> 静态模式（8.2）不受影响——它装在 profile 里，重启后自动加载。

### 发布模式（静态插件）

1. **构建**：`node build.mjs`（产出 `lib/index.js` + `lib/client.js`）。
2. **安装**：`dsh plugin --profile web add file:$(pwd)`（把本仓库作为 file: 依赖加入 web profile；
   会 reconcile `dsh.profile.bundles`，`cordis.patch.yml` 挂载 Host 半区，`dsh.client` 收录 Client bundle）。
3. **重启 web**：静态 bundle 在启动时收录进 `window.__DSH_BOOT__` 图，需重启 `dsh --profile web` 服务后刷新页面。
4. **验证**：
   - GUI：工具行右侧、发送键前出现 `▾profile-<name>` 下拉框（静态槽位 `conversation.input.right`）；
     其余行为与动态模式一致（RPC 前缀 `dshprofile-static.*`，section `dsh-profile:profile-static`）。
   - RPC 通道（curl 直探，无需 GUI）：
     ```bash
     curl -s -X POST http://127.0.0.1:3080/rpc/dshprofile-static.profiles \
       -H "content-type: application/json" \
       -d '{"type":"client-request","rpcId":"probe","method":"dshprofile-static.profiles","payload":{"sessionId":"probe"}}'
     # 期望：HTTP 200 + {"type":"server-response","rpcId":"probe","result":{"ok":true,"value":{...}}}
     # 若返回 405/404 → 通道未注册；查 internals.md 与 inject: [connection]
     ```
   - 槽位占用：`Slots.listSubTree {root:'conversation.input.right'}` → occupants 应含
     `dsh-profile-selector-static (active)`。
5. **卸载**：`dsh plugin --profile web remove dsh-profile-selector`（或编辑 profile 的 cordis.patch.yml 移除 insert 行）。

### 双模式共存注意

- 开发与发布**可同时存在**（ID 全隔离，见 internals.md），但同一会话同一时刻只会被其中一套注入
  （section 名不同，互不覆盖）。若两套都激活，下拉框会出现两个（left + right），属预期。
- 改动核心 `src/core/` 后必须**重新构建**再部署：动态走 `node build.mjs` → 重新 define/run；
  静态走 `node build.mjs` → `dsh plugin --profile web add file:$(pwd)` **重装插件**（见上文注意）→ 重启 web。

**常用调试手段**：
- `cordis_inspect_self dshy-1` → 版本指针 / currentPackageId / 诊断；`cordis_inspect_self dshy-1 <pkgId>` → 源码与运行错误
  （pluginId 为 Host 分配不可改；插件显示名称 dsh-profile-selector）。报 "no dynamic plugin" = DSH 重启丢了，重新部署。
- `Slots.listSubTree {root:'conversation.input.left'|'conversation.input.right'}` → occupants 含 `dsh-profile-selector`
  / `dsh-profile-selector-static` 且 active=true = client 半区已挂载；occupants 空 = client 未激活（检查浏览器刷新/页面加载）。
- 静态挂载状态：`curl -s http://127.0.0.1:3080/ | grep dsh-profile-selector`（boot 图 `__DSH_BOOT__` 应含它
  与 `/plugins/dsh-profile-selector/client.js`；不含 = 挂载失败/未重启，查 internals.md）。
- activate 出错时 GUI 红字带 `[diag: ...]`，据此定位残留 section 所在层。
- Host 内部事实（供对照）：`sp.layers.scoped`（Map，key=AgentLoop 实例）、`sp.layers.global.sections`（NamedEntries）、
  `layer.sections.data`（普通 Map，可直接 delete）。
- 静态模式 RPC 失败排查：确认 web profile 的 `connection` 行存在（dsh-web-app patch 自带），
  `curl -X POST http://127.0.0.1:3080/rpc/dshprofile-static.profiles`（信封见上文「发布模式」的 curl 示例）看响应体（`RpcResult` 形状）。

---

## 数据流与安全边界

- **读**：`fs.resolve/readText`（受 sandbox 约束；当前会话 policy=workspace-write，可读写工作区内的文件）；
  仅读 `.deepseek.yaml` 与其 `file` / `global_prompt` / `persona_prompt` 指向的提示词文件（`doc/prompts/`），
  不触碰其他数据。persona 段覆盖在**每次装配**都重读 `.deepseek.yaml`（与替换源文件），不额外落盘任何状态。
- **写**：只有一处 —— **设置面板保存**时把自己 bundle patch（安装目录下的
  `node_modules/dsh-profile-selector/cordis.patch.yml`）里 begin/end 标记之间的受管块换掉，标记之外的
  字节逐字节保留（临时文件 + rename 原子替换；读到 ENOENT 才当空模板，其它读失败一律抛出）。
  写盘前还会**自校验**：块外内容必须逐行不变、回读必须等于写入值，任一不过即抛错且**不写盘**
  （`core/patch.js` 的 `applySettingsToPatch`）。YAML 的生成与解析由 `yaml` 库负责。
  ⚠️ 除此之外插件不写盘；档案、开场白正文、`.deepseek.yaml` 都由用户维护，插件只读。
  运行期的会话状态（激活档案、开场白落点、设置的内存值）全在 Host 内存，进程重启即重算。
- **作用域**：注入只影响发起激活的会话（agent 作用域 section + 该会话 `agent/request` 监听）；
  其他会话不受影响。开场白覆盖同理——`harness:identity` 只在该工作区会话的 agent 作用域内注册，
  **不修改 DSH 全局层**，故其他工作区/其他会话仍用 DSH 默认开场白（见 internals.md）。
  persona 段覆盖同理：`system-prompt/assemble` 监听器挂在**该会话 agent 自己的 ctx** 上
  （`agent/created` 时挂载、`ctx.on('dispose')` 释放），只改写该作用域装配结果里的
  `deployment:persona-prefix` 段——不动 preset、不动 DSH 源码（见 internals.md）。
  子代理会话的档案继承同理：注册进**该子代理自己的** agent 作用域（见 internals.md），
  不影响父会话、父会话的其他子代理，也不需要改动 DSH 源码；子代理的 cwd/血缘
  （`header.cwd`/`parentSession`/`origin`）均来自 DSH 子会话 header，插件只读不写。
- **静态模式权限**：`connection.rpc.handle('/rpc', ..., {authority:'loopback'})` 仅接受 loopback 来源
  （`isTrustedApiRequest` 校验，非 loopback 返回 403）；静态 bundle 由 web profile 的 `dsh.client` 声明收录，
  仅服务本机 GUI 页面。

---

## 随包内容（`package.json` 的 `files`）

`files` 是 npm 发布白名单，**实测对 `dsh plugin --profile web add file:$(pwd)` 的拷贝同样生效**——
profile 里只会出现白名单内的文件（其余文件留在仓库，不进入 profile 拷贝）。当前白名单：

```
lib/  dist/  src/  cordis.patch.yml  package.json  README.md
CHANGELOG.md  features.md  internals.md  deployment.md
```

因此 `ops-notes.md`、`scripts/`、`build.mjs`、`doc/`、`.deepseek.yaml` **不会**进入
profile 拷贝（它们分别在仓库里作为运维记录、设计依据、开发脚本与工作区内容）。

> 调整文档结构时记得同步 `files`：否则 profile 那份 `README.md` 的链接会指向包里不存在的文件。

