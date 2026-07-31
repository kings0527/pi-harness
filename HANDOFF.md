# pi-harness 交接文档（HANDOFF v3）

> 目标读者：从零接手本项目的 coding agent。
> 你的任务：构建 **pi-harness——一个标准 pi 包（npm 包）**。它不是 agent orchestrator，而是 agent 的**「共享认知层」**，包含三层能力：
> ① **协作层**：Topic（主题频道）+ 共享黑板（Shared Blackboard，工作记忆），实现多 agent"协作共进"；
> ② **知识层**：长期知识库（Knowledge）+ distill 蒸馏流程，让认知资产跨任务累积；
> ③ **哲学层**：从主流 agent 生态蒸馏出的设计纪律，以"精简 prompt + runtime hook + 按需 skill"三种形态落地。
> 本文档是唯一权威起点，请通读全文后再动手。（v3 依据外部评审重新定位：从"多 agent 插件"升级为"个人共享认知层/智能基础设施"，核心逻辑与 runtime 解耦。）

---

## 1. 愿景与非目标

### 1.1 定位：agent 的「共享认知层」

**pi-harness 不是 agent orchestrator（编排器），而是 agent 的「共享认知层」**——让多个智能体共享认知资产、减少重复探索。编排回答"谁在什么时候干什么"；认知层回答"大家已经知道了什么、正在发现什么"。

终态图景（自上而下）：

```
Working Memory：Board（黑板 —— 多 agent 围绕 topic 协作的工作记忆）
Long    Memory：Knowledge（个人知识库 —— 跨任务沉淀的长期记忆）
        ↓ 下接
Hooks / Skills（纪律与工作流）
        ↓ 底座
pi runtime（agent loop、工具、会话）
```

用户的长期使用场景：**逆向工程、投资研究、写作、技术探索、家庭知识管理**——认知层是跨所有场景复用的同一套基础设施。

### 1.2 核心理念：协作共进

分析一个复杂问题时，单个 agent 的视角有限。我们要的模式是：

1. 多个**分工明确的 agent**（例如一个查代码、一个查文档、一个做实验）各自独立调查；
2. 每个 agent 把自己的发现**写上共享黑板**（blackboard：所有参与者可读写的公共记录区）；
3. 每个 agent 能**读到他人的发现**，据此修正自己的方向；
4. 所有 agent 围绕一个**主题（topic）**异步讨论，最终收敛出结论。

关键点：**"讨论过程"本身是一等公民**——它是持久化的、人类可随时围观、可随时插入意见的数据结构（文件），而不是散落在各 agent 会话里的隐式状态。

### 1.3 第二条主线：单一整合包，告别脚手架拼装

用户 kk 不想再零散安装各种 pi 脚手架包（subagents、hooks、skills 各装一堆），而是**只装一个自己的整合包**：pi-harness。这个包把用户多年沉淀的工程纪律（原 CLAUDE.md 12 条规则、旧 harness 血泪经验）与生态精华（Codex / Claude Code / opencode / superpowers / mattpocock-skills / 12-factor-agents 的非冗余部分）蒸馏进来，一次 `pi install` 即得到完整的个人工作环境。

### 1.4 项目背景（为什么是 pi，不是旧 harness）

用户曾维护一个 Rust 多 Agent harness（`/home/me/harness/harness-mvp/harness-core`，核心文件 orchestrator.rs 约 2.4 万行），实现了 Orchestrator 调度、scope 频道、broadcast、caucus 多轮协商（曾成功用于狼人杀游戏多 agent 达成共识）。评估后决定**不再在旧 harness 上加功能**：其单 agent 引擎部分是重复造轮子，2.4 万行 orchestrator 维护成本过高。新方案：以 **pi coding agent**（Mario Zechner 的极简 coding agent，仓库已迁移至 https://github.com/earendil-works/pi ）为"发动机/底盘"，只在其 extension/package 体系上重建差异化能力。

pi 已在本机安装完成（详见 §2.1 本机环境事实）。

### 1.5 明确的非目标（不要做）

- ❌ **不造单 agent 发动机**：LLM 抽象、agent loop、工具执行、会话管理全由 pi 提供，一行都不重写，也不改 pi 源码。
- ❌ **不做重量级编排引擎 / workflow DSL**：不设计声明式流程语言、不做状态机引擎。协作策略用最朴素的 skill/钩子实现。
- ❌ **不追平 Claude Code 的功能面**：不做 IDE 集成、不堆功能。
- ❌ **不 bundle 第三方 pi 包**：只吸收其设计思想自己实现最小版（裁决理由见 §3.4 ADR-0）。
- ❌ **不造 Letta（自动记忆系统）**：v1 知识层 NEVER 引入 embeddings / 向量库 / 自动记忆（见 §4.1 ADR-2）。

---

## 2. 交付形态：标准 pi 包

### 2.1 本机环境事实（实测）

| 项 | 值 |
|---|---|
| pi 版本 | **0.83.0** |
| pi 二进制位置 | `/home/me/.npm-global/bin/pi` |
| 全局配置 | `~/.pi/agent/settings.json` |
| 已装包 | **零**（干净环境，pi-harness 将是第一个） |

### 2.2 pi 包机制

一个 pi 包 = **一个 npm 包** + package.json 中的 `"pi"` 字段，声明四类资源目录：

| 资源目录 | 内容 | 加载方式 |
|---|---|---|
| `extensions/` | `.ts` 扩展（钩子、自定义 tool、slash command） | **jiti 运行时加载，无需预编译** |
| `skills/` | 每个 skill 一个目录，内含 SKILL.md | 渐进披露：仅 description 常驻，正文按需读取 |
| `prompts/` | `.md` prompt 模板 | 按名引用 |
| `themes/` | `.json` 主题 | — |

无 `pi` 字段时，pi 也会按上述目录约定自动发现资源；但**我们显式声明**，语义清晰。

官方文档（必读）：https://pi.dev/docs/latest/packages

### 2.3 安装 / 更新 / 卸载命令（可直接复制）

```bash
# 本地开发迭代：项目级安装（写进当前项目配置），--approve 跳过确认
pi install ./ -l --approve

# 全局安装（注册进 ~/.pi/agent/settings.json 的 packages 数组）
pi install ./

# 发布到 npm 之后（是否发布见 §8 开放问题 3）
pi install npm:pi-harness

# 更新 / 卸载
pi update
pi remove

# 不安装、临时试用某个扩展
pi -e ./extensions/board.ts
```

### 2.4 包骨架（M1 交付物）

```
pi-harness/
├── package.json          # 含 "pi" 字段，声明资源目录
├── tsconfig.json
├── core/                 # 纯 TS 库，runtime 无关，只操作文件系统（ADR-1）
│   ├── board/            # topic + 黑板读写
│   ├── knowledge/        # 长期知识库操作
│   ├── identity/         # agent profile 加载
│   └── events/           # 事件日志 append
├── extensions/           # pi 接口薄适配层：只做钩子/tool 注册，逻辑全部调 core
│   ├── board.ts          # M2：board 工具注册
│   ├── inject.ts         # M3：onBeforeTurn 注入（board digest + knowledge index）
│   └── discipline.ts     # M2.5：纪律 hooks（读后写、fail-loud、diff 观测）
├── skills/
│   ├── distill/SKILL.md  # M4：topic 结论升华进 knowledge
│   └── review/SKILL.md   # M6（可选）：三角评审
├── prompts/
│   └── meta-principles.md  # M2.5：≤500 token 常驻元原则
├── knowledge/            # 长期知识内容（git 版本化 markdown 树 + index.md）
├── agents/               # agent profile（*.json 或 *.md 角色卡）
├── docs/decisions/       # 短 ADR（接手者首次写 ADR 时创建）
└── HANDOFF.md            # 本文档
```

注：`core/`、`knowledge/`、`agents/` 不是 pi 资源类型，pi 不感知它们——它们随 npm 包分发，仅由 core 代码按路径读取。

**ADR-1「核心逻辑运行时无关」**：`core/` 不 import 任何 pi API，只依赖 Node 标准库操作文件系统；`extensions/` 是唯一接触 pi 接口的薄适配层。理由：将来若换 Codex SDK / Claude Code / 其他 runtime，认知资产层（core + knowledge + agents）原样复用，只需重写薄适配层——这延续了旧 harness"通信与执行运行时边界分离"的经验。接手者落为 `docs/decisions/0001-runtime-agnostic-core.md`。

package.json 要点：

```jsonc
{
  "name": "pi-harness",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=20" },
  "pi": {
    "extensions": ["extensions"],
    "skills": ["skills"],
    "prompts": ["prompts"]
  },
  // pi 已捆绑以下依赖，声明为 peerDependencies，不要复制进本包：
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-agent-core": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  }
  // 若引入其他运行时依赖，必须用 bundledDependencies 显式声明打包
}
```

### 2.5 pi 引擎要点速览

- **三层架构**：pi-ai（LLM 抽象，统一多 provider）/ pi-agent-core（约 418 行 agent loop + extension 体系）/ pi-coding-agent（CLI 与内置工具）。我们全部代码活在 extension/package 层。
- **生命周期钩子**：`onSessionStart` / `onBeforeTurn`（M3 注入落点）/ `onToolCall`（拦截与门禁落点）/ `onToolResult` / `onAfterTurn` / `onSessionEnd`。⚠️ 具体钩子签名以 pi 0.83 实测为准（见 §8 开放问题 4）。
- **会话模型**：append-only DAG（只追加、支持分支），跨 provider 续写；extension 可写 custom message 持久化自身状态（存入会话文件但不发给 LLM）。
- **重要先例**：https://github.com/baochunli/pi-collaborating-agents 已验证 pi 多 agent 消息传递可行——`registry/`（活跃 agent 注册）、`inbox/{name}/`（分 `queued/` 与 `urgent/` 两级：urgent 立即中断当前轮 steer，normal 排队 followUp）、`messages.jsonl`（全局 append-only 日志）、reserve paths（经 `onToolCall` 拦截 edit/write 防并发写冲突）、`@direct`/`@all` 寻址、subagent 并行生成（worker/scout/documenter/reviewer）。**接手者应通读其源码后做 fork-or-rewrite 决策**（§8 开放问题 1）。
- **参考链接**：
  - pi 源码：https://github.com/earendil-works/pi （原 badlogic/pi-mono 会 301 跳转到此）
  - 包文档：https://pi.dev/docs/latest/packages
  - 设计博文：https://mariozechner.at/posts/2025-11-30-pi-coding-agent/
  - Armin Ronacher 评述：https://lucumr.pocoo.org/2026/1/31/pi/

### 2.6 pi 设计哲学（本项目的裁决原则）

任何设计争议，以下六条是最终裁判——违反其一即需重新设计：

1. **system prompt < 1000 tokens**：不许显著撑大 pi 的系统提示。
2. **最少工具**：能用一个工具（带 action 参数）解决就不注册第二个。
3. **渐进披露**：只有 description 常驻上下文，正文按需加载。
4. **完整可观测**：一切状态都是可以用 `cat` 检查的文件，没有黑盒。
5. **文件优先**：状态、计划、通信全走文件系统，不引入数据库/消息队列/常驻服务。
6. **机制与策略分离**：pi 提供机制（钩子、工具），协作与纪律策略留在本包。

---

## 3. 哲学层：吸收与去冗余

### 3.1 核心结论：结构化约束 > 增量规则

现代前沿 LLM 已内化大量早期 prompt 技巧——superpowers 的启发式问题清单、"逐步分解"教学文字、Claude 系统 prompt 里的历史补丁，如今都是冗余 token。真正留下来的只有三类形态：

| 形态 | 载体 | 适用 |
|---|---|---|
| **极简元原则** | 常驻 prompt（≤500 token） | 无法代码化的价值观与判断倾向 |
| **runtime hook** | extension 代码强制 | 违反一次代价不可容忍的硬约束 |
| **按需 skill** | SKILL.md 渐进披露 | 特定场景才需要的完整工作流 |

一切候选规则先问：能做成 hook 吗？→ 能则做 hook；不能，是通用价值观吗？→ 是则进元原则；都不是 → 做成 skill 按需加载，或直接删除。

### 3.2 生态高价值包吸收表（吸收理念，不捆绑代码）

| 包（月下载量） | 它解决什么 | 我们吸收什么 |
|---|---|---|
| **pi-subagents**（166K/月） | 8 个预制角色 agent（scout/worker/reviewer/oracle）、链式/并行编排、watchdog 审计 | **角色卡 + 职责边界声明**的 subagent 生成模式（M5 spawn 分工 agent 时用） |
| **pi-mcp-adapter**（210K/月） | MCP 工具定义撑爆 context → 单 proxy 工具 + lazy 发现 | **一切常驻 context 的工具描述必须极小、能力按需披露**（board 工具 description 照此纪律写） |
| **context-mode**（85K/月） | hook 拦截工具输出防 context 窃取 + 持久索引 | **大输出落文件、context 只留摘要引用**（M2.5 纪律 hook 之一） |
| **pi-agent-extensions / oh-pi** | 整合包标杆：session 管理/handoff/todos/一键配置 | **单包聚合多资源**的组织方式（本包的形态样板） |
| **super-pi** | 五步 loop（brainstorm→plan→work→review→learn）+ TDD gate | **强制工作流作为 skill 状态机，而非 prompt 恳求**（M4 distill / M6 review 照此实现） |

### 3.3 八条蒸馏原则

1. **Prompt 建议与 Runtime 约束分离**。能用代码强制的绝不写进 prompt；判断标准：**违反一次的代价大到不可容忍，就做成 hook**。prompt 里的"请务必"对 LLM 只是建议，`onToolCall` 里的 reject 才是约束。（来源：Claude Code hooks 的三层递进设计、12-factor-agents Factor 8"掌控控制流"。落地：M2.5 的 discipline.ts。）
2. **启用推理而非堆叠规则**。删除所有会被模型 thinking 过程自然覆盖的具体指导（"先分解问题""考虑边界情况"），prompt 精简到 3-5 条元原则。（来源：Claude 3.7→4 系统 prompt 的瘦身演进、Simon Willison 对系统 prompt 的逐段分析。落地：meta-principles.md ≤500 token。）
3. **共享语言优先于规则堆叠**。项目级 CONTEXT.md 术语表 + 短 ADR，让 agent 和人说同一种语言，比 30 条行为规则更省 token 也更有效。（来源：mattpocock-skills 的核心贡献。落地：本包 docs/decisions/ ADR 纪律 + 建议用户项目配 CONTEXT.md。）
4. **工作流强制优于单次对齐**。关键流程（设计确认→实现→测试→评审）做成**不可跳过的 skill 状态机**——skill 内每步有产出物检查，未过不进下一步。（来源：superpowers 去掉冗余启发式后仍然活着的精髓、super-pi 的 TDD gate。落地：M4 distill skill 与 M6 review skill。）
5. **失败检测多源验证**。测试 + lint + 并行多轴评审构成验证网，**不信任单一 LLM judge**——单个模型自评通过不算通过。（来源：Armin Ronacher "The Coming Loop"、superpowers 两阶段评审。落地：M5 验收要求人工检查 board.md + 会话文件双重证据。）
6. **上下文窗口显式管理**。优先级分层 + 预算内摘要 + 大输出落文件，绝不放任 context 自然增长。（来源：12-factor-agents Factor 3"掌控上下文窗口"、旧 harness 上下文压缩体系的教训。落地：M3 的 ≤3000 字节注入预算 + context-mode 式落文件 hook。）
7. **职责边界显式声明**。每个 agent / skill / hook 写明 `responsibilities` 与 `out_of_scope` 两个清单，越界即拒绝。（来源：12-factor-agents Factor 10"小而专注的 agent"。落地：M5 spawn 的角色卡模板。）
8. **反馈循环紧凑化**。任务切成**人类注意力范围内的垂直切片**，每片可独立验收，防止人对系统的理解力流失（comprehension loss）。（来源：Armin Ronacher 的 comprehension loss 警告。落地：M1-M6 里程碑本身就按此切分；board 过程实时落板供人围观。）

### 3.4 ADR-0：默认不捆绑第三方包（裁决记录）

- **背景**：pi 生态已有 subagents/mcp-adapter/context-mode 等成熟包，可以 bundle 进本包。
- **决策**：**默认不 bundle 任何第三方 pi 包**，只吸收设计思想，自己实现最小版。
- **理由**：① 保持"少即是多"——第三方包为通用场景设计，携带我们不需要的功能与常驻 token；② 完全自主——升级、行为、bug 修复不受上游节奏绑架；③ 我们需要的最小实现每个都在数百行内，重写成本低于长期集成成本。
- **放弃的替代方案**：bundle + 配置裁剪（配置面过大，违反极简纪律）。
- 接手者将此条正式落为 `docs/decisions/0000-no-third-party-bundle.md`。

### 3.5 用户 12 条规则（原 CLAUDE.md 模板）处置表

这是用户自己的沉淀，逐条给出去向：

| # | 原规则 | 处置 | 去向 |
|---|---|---|---|
| 1 | 先思后码 | **合并** | 与 #4 合并为一条元原则："启用 thinking，行动前确认成功标准" |
| 2 | 简单至上 | **保留为元原则**（精简措辞） | meta-principles.md |
| 3 | 外科手术式修改 | **转 runtime hook** | discipline.ts：diff 观测报告，超出声明 scope 时 warn + 记 event（v1 NEVER 自动拒绝，见 M2.5 松绑理由） |
| 4 | 目标驱动 | **合并** | 见 #1 |
| 5 | 判断题用 LLM、选择题用代码 | **保留为元原则** | meta-principles.md |
| 6 | token 预算意识 | **转 runtime hook** | PreCompact/预算检查：接近阈值主动摘要落文件 |
| 7 | 显式暴露冲突 | **保留为元原则** | meta-principles.md |
| 8 | 落笔前先阅读 | **转 runtime hook** | discipline.ts：修改已有文件前验证本会话内 Read 过，否则拒绝；创建新文件直接放行（M2.5 松绑） |
| 9 | 测试验证意图 | **保留为元原则** | meta-principles.md |
| 10 | 检查点 | **转 runtime hook** | PostToolUse 触发：阶段性成果自动提示 commit |
| 11 | 遵从既有规范 | **保留为元原则** | meta-principles.md |
| 12 | fail loud | **转 runtime hook** | 非零退出码捕获 + 完成条件门禁（完成标记只由 hook 落盘，见 §6.2） |

**处置逻辑**：写在 prompt 里的 #3/#6/#8/#10/#12 是**假约束**（LLM 可"合理地"忽略），必须代码化；#1-#2/#4-#5/#7/#9/#11 是价值观，精简后常驻。

**最终产物（= M2.5 交付物规格）**：
1. `prompts/meta-principles.md`：**≤500 token、5-6 条元原则**的常驻 prompt；
2. `extensions/discipline.ts`：上表 5 个 hook 的清单实现（diff 观测、token 预算、读后写、检查点提示、fail-loud 门禁；其中 diff 与读后写为松绑版，见 M2.5）。

---

## 4. 双层记忆模型与核心机制

### 4.1 双层记忆模型：Board + Knowledge

| 层 | 角色 | 形态 | 生命周期 |
|---|---|---|---|
| **Board** | 工作记忆 | 临时协作过程：per-topic jsonl + board.md（原设计不变） | 随 topic 开/关 |
| **Knowledge** | 长期记忆 | `knowledge/` 下按领域组织的 markdown 目录树 + 顶层 index.md | 跨任务永久累积 |

Knowledge 示例结构：`knowledge/reverse-engineering/ghidra/known-limitations.md`；顶层 `index.md` 是**极小的目录索引**（一行一条：路径 + 一句话描述）。

**ADR-2「v1 克制边界」（MUST，防 scope creep）**：v1 的知识层**只有**：markdown 文件 + git 版本化 + distill skill + index.md。**NEVER 在 v1 引入 embeddings / 向量库 / 自动记忆系统**（不造 Letta）。理由：对个人规模的知识库，grep + 目录索引足够；向量化引入服务依赖与黑盒，违反"文件优先、完整可观测"哲学。接手者落为 `docs/decisions/0002-no-embeddings-v1.md`。

**溯源要求（MUST）**：distill 进 knowledge 的每条结论必须附证据链接，格式如 `来源: topic-ghidra-crash#seq-12,seq-15`；**无溯源的知识条目视为不合格**。新发现与既有知识矛盾时，MUST 显式标注冲突：在旧条目加 `CONFLICT` 标记 + 链接新证据；**NEVER 静默覆盖或折中改写**——这是用户规则 #7（显式暴露冲突）在知识层的应用。

**读取路径（渐进式披露）**：index.md 极小，可注入常驻上下文（或由 onBeforeTurn 注入，形态见 §8 开放问题 5）；具体知识文件按需由 agent read——与 pi skills 的"description 常驻、内容按需"同构。**没有读取路径的知识库是 write-only 垃圾场**——写入和读取必须同等设计。

### 4.2 Topic 生命周期

在 open / post / read / list 基础上新增：

- `board close <topic>`：关闭主题，产出 `summary.md`（讨论摘要）+ `decisions.md`（结论与决策）；raw jsonl 保留归档不删。
- `distill` skill：close 后引导（agent 或 human）决定哪些结论升华进 `knowledge/`（带 §4.1 溯源链接），并更新 index.md。
- 归档约定：closed topic 移入 `topics/archive/`。

完整生命周期：`open → post/read（协作）→ close（summary + decisions）→ distill（升华进长期记忆）→ archive`。

### 4.3 Agent identity（轻量角色卡）

`agents/<name>.json`（或 .md），字段：`name`、`specialty[]`、`confidence_bias`（如 "avoid guessing"）、`out_of_scope`。用途两个：① 喂给 subagent 的 system prompt；② 作为 board note 的 author 元数据。明确：这是**轻量角色卡，不是严格 schema 的身份系统**。未来演进方向（一句带过）：个人专家团队——reverse-agent / finance-agent / writing-agent 等长期角色。

### 4.4 Event Log（系统行为事件日志）

`events.jsonl`：全局 append-only，由 `core/events` 提供 append API。记录系统行为事件：`agent_join`、`board_post`、`board_close`、`distill`、`hook_block`（含 reason）、`human_override` 等。用途：回答**"agent 为什么这样做"**——调试多 agent 系统的第一手证据（旧 harness 结构化日志追溯教训的延续：没有事件流就只能靠猜）。

### 4.5 Human-in-the-loop 优先级

- `board post --author human` 支持 `--priority critical`；
- **MUST**：digest 注入时 human critical note **无条件置顶，且不受预算裁剪淘汰**；
- 效果：human 可随时向任何 topic 投递方向性裁决，改变 agent 讨论轨迹——人不是旁观者，而是最高优先级的参与者。

---

## 5. 模块与里程碑

整体是**一个 pi 包**，内部按里程碑推进。依赖关系：

```
M1（包骨架 + core/extension 分离验证 + 决策）
 └─→ M2（board 原语 + 生命周期 + events.jsonl）
      ├─→ M2.5（元原则 + 松绑版 hooks）──┐
      ├─→ M3（onBeforeTurn 注入）        ──┤
      └─→ M4（knowledge 层 + distill）   ──┴─→ M5（真实任务端到端验收）─→ M6（可选：review skill）
```

M2.5 / M3 / M4 三者只共享 M2 的存储层，可并行。每完成一个里程碑：跑通验收标准 → commit →（如有重大取舍）写 ADR。

### M1：包骨架 + core/extension 分离验证 + fork-or-rewrite 决策

- 按 §2.4 搭出包骨架，写一个 hello-world extension：钩子里调用 `core/` 的一个纯函数（验证薄适配层→core 的调用链路）；
- `pi install ./ -l --approve` 安装，启动会话确认 **hello extension 被 pi 加载**、钩子触发；
- 实测记录 pi 0.83 的钩子签名（名称、参数、返回值语义）；
- 通读 pi-collaborating-agents 源码，产出 fork-or-rewrite 决策 ADR；同时落 ADR-0（§3.4）、ADR-1（§2.4）、ADR-2（§4.1）。
- **验收标准**：`pi install` 成功且 settings.json（或项目配置）出现本包；hello 钩子日志可见且日志内容来自 core 函数返回值；`core/` 内 `grep -r "pi-" core/` 无任何 pi 包 import；四条 ADR 已提交，fork-or-rewrite ADR 含至少 3 条对比理由。

### M2：核心原语——`board` 工具 + 生命周期 + events

一个自定义 tool（名为 `board`），用 **action 参数区分子操作**（参考 pi-collaborating-agents 的 `agent_message` 单工具多 action 模式，符合"最少工具"）；存储与逻辑全部在 `core/board`，extension 只做注册：

| 操作 | 语义 |
|---|---|
| `board open <topic> --goal "..."` | 开主题：注册 topic 元信息 + 创建黑板文件 |
| `board post <topic> "<content>" [--tags] [--priority critical]` | 上板一条 note，字段：`seq`（单调递增）、`author`、`timestamp`、`tags`、`priority`、`content`；`--author human --priority critical` 见 §4.5 |
| `board read <topic> [--since seq]` | 读黑板，`--since` 增量读取（只返回大于该 seq 的条目） |
| `board list` | 列出所有主题及条目计数（含 open/closed 状态） |
| `board close <topic>` | 关闭主题：产出 summary.md + decisions.md，移入 archive（§4.2） |

同时交付 `core/events` 的 append API，并在 board 各操作中埋入事件记录（§4.4）。

存储布局：

```
<存储根>/                    # ~/.pi/agent/collab-board/ 或项目本地 .pi-board/，见 §8 开放问题 2
  topics/
    <topic>.jsonl           # append-only 黑板正文，每行一条 note
    <topic>.board.md        # 人类可读快照，每次 post 后重新渲染
    archive/                # closed topic（jsonl + board.md + summary.md + decisions.md）
  events.jsonl              # 全局系统行为事件日志
```

- board 工具的 description 遵守 pi-mcp-adapter 式纪律：极小、只说 action 列表，细节按需。
- **验收标准**：两个终端各起一个 pi agent，A `post` 后 B 能 `read --since` 增量读到；`board.md` 与 JSONL 内容一致；seq 严格单调；`close` 后 archive/ 下四件套齐全；events.jsonl 完整记录了本段测试的全部 board_post/board_close 事件。

### M2.5：元原则 prompt + 纪律 hooks（松绑版）

交付 §3.5 的两个最终产物：

- `prompts/meta-principles.md`（≤500 token，5-6 条）；
- `extensions/discipline.ts`，至少实现三个 hook（注意两处**松绑**，均有意为之）：
  - **读后写（松绑）**：仅约束**修改已有文件**必须先 read；**创建新文件直接放行**；
  - **外科手术 diff（松绑为观测）**：v1 只做**观测报告**——diff 统计 + 与声明 scope 对比，超出时 warn + 记 `hook_block` event（含 reason），**NEVER 自动拒绝**。理由：LLM 修改范围判断很难，自动拒绝会误伤多文件修复，把 agent 变成填表机器人；
  - **fail-loud（不松绑）**：bash 非零退出码不允许被静默吞掉；"任务完成"类标记只能由 hook 验证后落盘。
- **验收标准**：未读先改已有文件被拦、新建文件不被拦；越界 diff 产生 warn 与 event 但未阻断执行；吞错误码被捕获；meta-principles.md 用 tokenizer 实测 ≤500 token。

### M3：onBeforeTurn 注入（board digest + knowledge index + human 置顶）

- `onBeforeTurn` 中注入三类内容，均走预算管理：
  1. **board digest**：若当前 agent **参与了某 topic**（open/首次 post 时登记），注入该黑板的预算内摘要——增量策略：只注入上次注入之后的新条目原文 + 一段更早内容的精简全景；
  2. **knowledge index**：注入 index.md（极小目录，具体文件留给 agent 按需 read，§4.1）；
  3. **human critical 置顶**：§4.5 的 MUST——human critical note 无条件置顶且不受预算裁剪淘汰。
- 遵守 §6.4 全部约束（≤3000 字节、最新优先、`(last_seq, digest)` 缓存防重复生成）；
- 效果：agent **不用主动调用 `board read` 也能看见同伴的新发现**。
- **验收标准**：agent B 在**未调用 `board read`** 的情况下，回复中引用了 agent A 上板的发现（检查 B 的会话文件确认无 read 调用）；构造一条 human critical note，在预算已满时仍出现在注入内容首位。

### M4：knowledge 层 + distill skill

- 实现 `core/knowledge`：知识文件读写、index.md 更新、CONFLICT 标注（§4.1）；
- 实现 `skills/distill/SKILL.md`：topic close 后引导逐条决定"升华 / 丢弃"，升华条目 MUST 带溯源链接（`来源: <topic>#seq-N`），同步更新 index.md；
- 与既有知识矛盾时执行 CONFLICT 流程（标注 + 链接新证据，NEVER 静默覆盖）。
- **验收标准**：对一个 closed topic 跑 distill，knowledge/ 出现带溯源的新条目且 index.md 同步；构造一条与既有知识矛盾的新结论，旧条目被加 CONFLICT 标记而非被改写；无溯源条目被 skill 流程拒收。

### M5：真实任务端到端验收

用**用户的真实逆向/研究任务**（不是构造的 toy 问题）跑全流程：

1. leader `board open` 一个 topic；
2. spawn 3 个分工 agent——使用 §4.3 角色卡（name/specialty/confidence_bias/out_of_scope），各自调查一个方向；
3. 各 agent 独立调查并 `board post` 发现（期间 M3 注入让它们互相看见）；
4. 人工投递一条 `--author human --priority critical` 的方向裁决，验证 agent 轨迹随之改变；
5. `board close` 产出 summary.md + decisions.md；
6. 跑 distill，产出**首批带溯源的知识条目**进 knowledge/。

- **验收标准**：6 步全部通过；`board.md` 可作为独立文档读懂整个调查过程；验证证据多源（board.md + events.jsonl + 各会话文件），不依赖单一 agent 自报（原则 5）；**同类问题第二次出现时，agent 通过 knowledge index 命中既有结论，未重复探索**——这是共享认知层核心价值的直接验证。

### M6（可选）：review skill（取代原 caucus 会议模拟）

原设计中的 caucus（多轮立场征集→共识检测会议模拟）**降级为可选**。降级理由：现代 LLM 缺的不是讨论能力，而是**共享事实**——一个含事实/证据/反例/决策的好 board 自然收敛，模拟会议是在解已被黑板解掉的问题。替代品：`skills/review/SKILL.md` 三角评审——**researcher（举证）→ critic（找反例）→ synthesizer（综合裁决上板）**，比模拟会议更接近科学方法。仅在 M5 暴露出"黑板自然收敛不够用"的实证需求时才实施。
- **验收标准**（若实施）：对一个有争议的结论跑三角评审，critic 产出至少一条有效反例，synthesizer 的裁决带双方证据链接上板。

### 难度自评

| 范围 | 难度 | 难点 |
|---|---|---|
| M1–M3 | ⭐⭐⭐ | 钩子签名实测、预算注入细节 |
| M5 | ⭐⭐⭐⭐ | 权限 / session / 并发 / 状态一致性（多 agent 同时读写真实任务） |
| 长期知识积累 | ⭐⭐⭐⭐⭐ | 不是代码难，是纪律难：distill 质量、溯源纪律、index 养护需长期坚持 |

---

## 6. 旧 harness 血泪经验（MUST 遵守）

以下五条来自旧 harness 真实踩坑，均为强制约束；括号内标注其与 §3.3 八条原则的对应关系。

### 6.1 协作约束必须用 MUST，不用 SHOULD（→ 原则 1 的 prompt 侧下限）

Prompt 中对 agent 协作行为的约束（如"发现新信息后上板"）必须写 MUST。实测：写 SHOULD 时 LLM 会"合理地"判断当前情况不适用而跳过。注意这只是下限——按原则 1，真正关键的约束应直接升级为 hook。

### 6.2 完成标记的写入权归 runtime，绝不归 LLM（→ 原则 1 的极端情形，M2.5 fail-loud 门禁）

任务完成、readiness（就绪状态）等流程门禁标记，必须由钩子代码在验证真实条件后落盘。**绝不允许 LLM 自己声明"我完成了"就算数**——旧 harness 出现过 agent 伪造完成状态绕过门禁。pi 下的映射见 §8 开放问题 4。

### 6.3 可见域隔离（→ 原则 7 的信息侧）

绝不通过公共频道泄漏仅个别成员可知的秘密信息（狼人杀场景核心教训：狼人身份泄入公共频道游戏即崩坏）。pi 下每个 agent 是独立进程/session，物理隔离天然成立；但**共享黑板要按 topic 划分可见性**——agent 只应看到自己参与的 topic，M3 注入时必须按参与关系过滤。

### 6.4 token 预算意识（→ 原则 6）

黑板内容注入上下文必须走"预算内摘要"：**≤3000 字节**；**最新条目优先**；维护 `(last_seq, digest)` 缓存（条目没变则复用，避免重复生成摘要）；**绝不全量注入**——旧 harness 曾因全量注入历史导致上下文爆炸、触发压缩链路连环 bug。

### 6.5 append-only + 人类可读快照（→ 原则 8 的可围观性基础）

黑板与消息一律**追加式 JSONL**（每行一个 JSON 对象，只追加不修改）；**单写者原则**：同一文件同一时刻只有一个写者，或按文件分区（如每 agent 写自己的 inbox 文件）规避并发冲突，不引入锁服务；同时渲染人类可读的 `board.md` 快照（每次 post 后重新生成），供用户围观并可直接插入人工意见。

---

## 7. 技术栈与约定

- **语言**：TypeScript（跟随 pi 生态）；**Node ≥ 20**。
- **依赖纪律**：`@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`typebox` 一律 peerDependencies（pi 已捆绑，不复制）；其他运行时依赖须 bundledDependencies 显式声明——且每加一个依赖先自问是否违反 ADR-0 精神。
- **极简纪律**：本包新增的**常驻 context 内容**（tool description、meta-principles.md 等）总计控制在**数百 token 内**；黑板正文走按需加载与预算内摘要，绝不常驻。
- **git 约定**：本仓库本地提交即可，不需要配置远端（是否发 npm 见 §8 开放问题 3）；阶段性成果主动 commit，message 遵循 conventional commits（`feat:` / `fix:` / `docs:`）；不 force push、不提交敏感文件（密钥、token 等）。
- **决策记录**：重大取舍写入 `docs/decisions/` 下的短 ADR（Architecture Decision Record，架构决策记录），**每条 10 行以内**：背景 1-2 行、决策 1 行、理由 2-3 行、放弃的替代方案 1-2 行。

---

## 8. 开放问题（需在 M1 结束时给出答案，每题一条 ADR；5-7 可延至对应里程碑前回答）

1. **fork pi-collaborating-agents 还是重写？**
   通读其源码后回答。考量维度：代码质量与可维护性、其消息机制与黑板模型的契合度、fork 后跟进上游的成本、其形态能否装进标准 pi 包结构。

2. **黑板存储放全局 `~/.pi/agent/collab-board/` 还是项目本地 `.pi-board/`？**
   考量维度：跨项目复用讨论 vs 讨论随项目走（可进 git）、多项目并行隔离、与 pi 自身存储惯例一致性。

3. **两个"驱动/分发"问题**：
   a) M6 review（及未来多 agent 流程）的 leader 用交互式会话还是 `pi --print` 脚本化驱动？（交互式：人类可实时介入每轮；脚本化：可自动化、可测试；或混合——脚本驱动 + 每轮结果落板供人围观。）
   b) 本包**发布到 npm 还是仅本地 `pi install ./`**？（仅本地：零发布负担；npm：多机同步方便。初期建议仅本地，留待 M5 后再议。）

4. **哪些钩子在 pi 0.83 实际可用？签名是什么？**
   本文档的钩子名（onBeforeTurn 等）来自调研资料，**必须在 M1 用 hello extension 逐个实测确认**（名称、参数结构、能否修改上下文/拦截工具）。同时回答：旧 harness 的 readiness 门禁在 pi 下映射为哪个钩子的什么检查——候选：`onToolCall` 拦截"声明完成"类操作并校验前置条件（如黑板上是否存在该 agent 的发现 note），或 `onAfterTurn` 校验后由钩子代码写入完成标记。红线不变：**完成标记只能由钩子代码落盘（§6.2）**。

5. **knowledge index 的注入形态**：常驻 system prompt（最简单，但占固定 token）还是 onBeforeTurn 动态注入（可按任务相关性裁剪）？在 index 还很小时两者差异不大，但需为 index 长大后的形态提前留好接口。

6. **distill 由谁触发**：`board close` 时自动建议（agent 列候选条目供人确认）还是纯人工发起？关乎知识库质量门禁——自动化越多，垃圾进入长期记忆的风险越高。

7. **events.jsonl 是否分文件轮转**：单文件简单但会无限增长；按月/按大小轮转则读取需要合并。v1 可先单文件，但 core/events 的 API 设计不要把单文件假设泄漏给调用方。

---

## 9. 接手后前三个动作

1. **通读 pi packages 文档与 extension API 源码**：https://pi.dev/docs/latest/packages + https://github.com/earendil-works/pi 中 pi-agent-core 的 extension 接口定义（钩子签名、tool 注册、slash command 注册），对照本文档 §2.5 修正任何过时描述。
2. **搭包骨架并验证安装**：按 §2.4 建 package.json（含 pi 字段）+ 目录，`pi install ./ -l --approve`，确认包被注册、资源被发现。
3. **写 hello hook 实测钩子签名**：hello-world extension 覆盖 §2.5 列出的全部钩子，逐个打日志确认触发时机与参数结构，把实测结果记进 M1 的 ADR，然后按 §5 顺序推进。

祝顺利。设计争议以 §2.6 六条哲学裁决；候选规则的形态取舍用 §3.1 的三分法；记忆的去向用 §4.1 的双层模型判断；哲学之外的坑，§6 已经替你踩过了。
