# pi-harness 交接文档（HANDOFF v2）

> 目标读者：从零接手本项目的 coding agent。
> 你的任务：构建 **pi-harness——一个标准 pi 包（npm 包）**，包含两层能力：
> ① **协作层**：Topic（主题频道）+ 共享黑板（Shared Blackboard），实现多 agent"协作共进"；
> ② **哲学层**：从主流 agent 生态蒸馏出的设计纪律，以"精简 prompt + runtime hook + 按需 skill"三种形态落地。
> 本文档是唯一权威起点，请通读全文后再动手。（本版基于两轮新调研全面重写，取代 v1。）

---

## 1. 愿景与非目标

### 1.1 核心理念：协作共进

分析一个复杂问题时，单个 agent 的视角有限。我们要的模式是：

1. 多个**分工明确的 agent**（例如一个查代码、一个查文档、一个做实验）各自独立调查；
2. 每个 agent 把自己的发现**写上共享黑板**（blackboard：所有参与者可读写的公共记录区）；
3. 每个 agent 能**读到他人的发现**，据此修正自己的方向；
4. 所有 agent 围绕一个**主题（topic）**异步讨论，最终收敛出结论。

关键点：**"讨论过程"本身是一等公民**——它是持久化的、人类可随时围观、可随时插入意见的数据结构（文件），而不是散落在各 agent 会话里的隐式状态。

### 1.2 第二条主线：单一整合包，告别脚手架拼装

用户 kk 不想再零散安装各种 pi 脚手架包（subagents、hooks、skills 各装一堆），而是**只装一个自己的整合包**：pi-harness。这个包把用户多年沉淀的工程纪律（原 CLAUDE.md 12 条规则、旧 harness 血泪经验）与生态精华（Codex / Claude Code / opencode / superpowers / mattpocock-skills / 12-factor-agents 的非冗余部分）蒸馏进来，一次 `pi install` 即得到完整的个人工作环境。

### 1.3 项目背景（为什么是 pi，不是旧 harness）

用户曾维护一个 Rust 多 Agent harness（`/Users/kk/harness/harness-mvp/harness-core`，核心文件 orchestrator.rs 约 2.4 万行），实现了 Orchestrator 调度、scope 频道、broadcast、caucus 多轮协商（曾成功用于狼人杀游戏多 agent 达成共识）。评估后决定**不再在旧 harness 上加功能**：其单 agent 引擎部分是重复造轮子，2.4 万行 orchestrator 维护成本过高。新方案：以 **pi coding agent**（Mario Zechner 的极简 coding agent，仓库已迁移至 https://github.com/earendil-works/pi ）为"发动机/底盘"，只在其 extension/package 体系上重建差异化能力。

pi 已在本机安装完成（详见 §2.1 本机环境事实）。

### 1.4 明确的非目标（不要做）

- ❌ **不造单 agent 发动机**：LLM 抽象、agent loop、工具执行、会话管理全由 pi 提供，一行都不重写，也不改 pi 源码。
- ❌ **不做重量级编排引擎 / workflow DSL**：不设计声明式流程语言、不做状态机引擎。协作策略用最朴素的 skill/钩子实现。
- ❌ **不追平 Claude Code 的功能面**：不做 IDE 集成、不堆功能。
- ❌ **不 bundle 第三方 pi 包**：只吸收其设计思想自己实现最小版（裁决理由见 §3.4 ADR-0）。

---

## 2. 交付形态：标准 pi 包

### 2.1 本机环境事实（实测）

| 项 | 值 |
|---|---|
| pi 版本 | **0.83.0** |
| pi 二进制位置 | `/Users/kk/.npm-global/bin/pi` |
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

# 发布到 npm 之后（是否发布见 §7 开放问题 3）
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
├── extensions/
│   ├── board.ts          # M2：board 工具 + 存储层
│   ├── inject.ts         # M3：onBeforeTurn 黑板摘要注入
│   └── discipline.ts     # M2.5：纪律 hooks（外科手术 diff、fail-loud、读后写）
├── skills/
│   └── caucus/
│       └── SKILL.md      # M4：讨论协议
├── prompts/
│   └── meta-principles.md  # M2.5：≤500 token 常驻元原则
├── docs/decisions/       # 短 ADR（接手者首次写 ADR 时创建）
└── HANDOFF.md            # 本文档
```

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
- **生命周期钩子**：`onSessionStart` / `onBeforeTurn`（M3 注入落点）/ `onToolCall`（拦截与门禁落点）/ `onToolResult` / `onAfterTurn` / `onSessionEnd`。⚠️ 具体钩子签名以 pi 0.83 实测为准（见 §7 开放问题 4）。
- **会话模型**：append-only DAG（只追加、支持分支），跨 provider 续写；extension 可写 custom message 持久化自身状态（存入会话文件但不发给 LLM）。
- **重要先例**：https://github.com/baochunli/pi-collaborating-agents 已验证 pi 多 agent 消息传递可行——`registry/`（活跃 agent 注册）、`inbox/{name}/`（分 `queued/` 与 `urgent/` 两级：urgent 立即中断当前轮 steer，normal 排队 followUp）、`messages.jsonl`（全局 append-only 日志）、reserve paths（经 `onToolCall` 拦截 edit/write 防并发写冲突）、`@direct`/`@all` 寻址、subagent 并行生成（worker/scout/documenter/reviewer）。**接手者应通读其源码后做 fork-or-rewrite 决策**（§7 开放问题 1）。
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
| **super-pi** | 五步 loop（brainstorm→plan→work→review→learn）+ TDD gate | **强制工作流作为 skill 状态机，而非 prompt 恳求**（M4 caucus 照此实现） |

### 3.3 八条蒸馏原则

1. **Prompt 建议与 Runtime 约束分离**。能用代码强制的绝不写进 prompt；判断标准：**违反一次的代价大到不可容忍，就做成 hook**。prompt 里的"请务必"对 LLM 只是建议，`onToolCall` 里的 reject 才是约束。（来源：Claude Code hooks 的三层递进设计、12-factor-agents Factor 8"掌控控制流"。落地：M2.5 的 discipline.ts。）
2. **启用推理而非堆叠规则**。删除所有会被模型 thinking 过程自然覆盖的具体指导（"先分解问题""考虑边界情况"），prompt 精简到 3-5 条元原则。（来源：Claude 3.7→4 系统 prompt 的瘦身演进、Simon Willison 对系统 prompt 的逐段分析。落地：meta-principles.md ≤500 token。）
3. **共享语言优先于规则堆叠**。项目级 CONTEXT.md 术语表 + 短 ADR，让 agent 和人说同一种语言，比 30 条行为规则更省 token 也更有效。（来源：mattpocock-skills 的核心贡献。落地：本包 docs/decisions/ ADR 纪律 + 建议用户项目配 CONTEXT.md。）
4. **工作流强制优于单次对齐**。关键流程（设计确认→实现→测试→评审）做成**不可跳过的 skill 状态机**——skill 内每步有产出物检查，未过不进下一步。（来源：superpowers 去掉冗余启发式后仍然活着的精髓、super-pi 的 TDD gate。落地：M4 caucus skill。）
5. **失败检测多源验证**。测试 + lint + 并行多轴评审构成验证网，**不信任单一 LLM judge**——单个模型自评通过不算通过。（来源：Armin Ronacher "The Coming Loop"、superpowers 两阶段评审。落地：M5 验收要求人工检查 board.md + 会话文件双重证据。）
6. **上下文窗口显式管理**。优先级分层 + 预算内摘要 + 大输出落文件，绝不放任 context 自然增长。（来源：12-factor-agents Factor 3"掌控上下文窗口"、旧 harness 上下文压缩体系的教训。落地：M3 的 ≤3000 字节注入预算 + context-mode 式落文件 hook。）
7. **职责边界显式声明**。每个 agent / skill / hook 写明 `responsibilities` 与 `out_of_scope` 两个清单，越界即拒绝。（来源：12-factor-agents Factor 10"小而专注的 agent"。落地：M5 spawn 的角色卡模板。）
8. **反馈循环紧凑化**。任务切成**人类注意力范围内的垂直切片**，每片可独立验收，防止人对系统的理解力流失（comprehension loss）。（来源：Armin Ronacher 的 comprehension loss 警告。落地：M1-M5 里程碑本身就按此切分；caucus 每轮结果落板供人围观。）

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
| 3 | 外科手术式修改 | **转 runtime hook** | discipline.ts：diff 范围检查，改动超出声明范围即警告/拒绝 |
| 4 | 目标驱动 | **合并** | 见 #1 |
| 5 | 判断题用 LLM、选择题用代码 | **保留为元原则** | meta-principles.md |
| 6 | token 预算意识 | **转 runtime hook** | PreCompact/预算检查：接近阈值主动摘要落文件 |
| 7 | 显式暴露冲突 | **保留为元原则** | meta-principles.md |
| 8 | 落笔前先阅读 | **转 runtime hook** | discipline.ts：Edit/Write 前验证该文件本会话内 Read 过，否则拒绝 |
| 9 | 测试验证意图 | **保留为元原则** | meta-principles.md |
| 10 | 检查点 | **转 runtime hook** | PostToolUse 触发：阶段性成果自动提示 commit |
| 11 | 遵从既有规范 | **保留为元原则** | meta-principles.md |
| 12 | fail loud | **转 runtime hook** | 非零退出码捕获 + 完成条件门禁（完成标记只由 hook 落盘，见 §5.2） |

**处置逻辑**：写在 prompt 里的 #3/#6/#8/#10/#12 是**假约束**（LLM 可"合理地"忽略），必须代码化；#1-#2/#4-#5/#7/#9/#11 是价值观，精简后常驻。

**最终产物（= M2.5 交付物规格）**：
1. `prompts/meta-principles.md`：**≤500 token、5-6 条元原则**的常驻 prompt；
2. `extensions/discipline.ts`：上表 5 个 hook 的清单实现（外科手术 diff 检查、token 预算、读后写、检查点提示、fail-loud 门禁）。

---

## 4. 模块与里程碑

整体是**一个 pi 包**，内部按里程碑推进。依赖关系：

```
M1（包骨架 + 环境验证 + 决策）
 └─→ M2（board 核心原语）
      ├─→ M2.5（元原则 + 纪律 hooks）──┐
      ├─→ M3（黑板摘要注入）        ──┤
      └─→ M4（caucus skill）        ──┴─→ M5（端到端验收）
```

M2.5 / M3 / M4 三者只共享 M2 的存储层，可并行。每完成一个里程碑：跑通验收标准 → commit →（如有重大取舍）写 ADR。

### M1：包骨架跑通 + fork-or-rewrite 决策

- 按 §2.4 搭出包骨架，写一个 hello-world extension（如 `onSessionStart` 打印一行日志）；
- `pi install ./ -l --approve` 安装，启动会话确认 **hello extension 被 pi 加载**、钩子触发；
- 实测记录 pi 0.83 的钩子签名（名称、参数、返回值语义）；
- 通读 pi-collaborating-agents 源码，产出 fork-or-rewrite 决策 ADR；同时落 ADR-0（§3.4）。
- **验收标准**：`pi install` 成功且 settings.json（或项目配置）出现本包；hello 钩子日志可见；两条 ADR 已提交，fork-or-rewrite ADR 含至少 3 条对比理由。

### M2：核心原语——`board` 工具

一个自定义 tool（名为 `board`），用 **action 参数区分子操作**（参考 pi-collaborating-agents 的 `agent_message` 单工具多 action 模式，符合"最少工具"）：

| 操作 | 语义 |
|---|---|
| `board open <topic> --goal "..."` | 开主题：注册 topic 元信息 + 创建黑板文件 |
| `board post <topic> "<content>" [--tags]` | 上板一条 note，字段：`seq`（单调递增）、`author`、`timestamp`、`tags`、`content` |
| `board read <topic> [--since seq]` | 读黑板，`--since` 增量读取（只返回大于该 seq 的条目） |
| `board list` | 列出所有主题及条目计数 |

存储布局：

```
<存储根>/                    # ~/.pi/agent/collab-board/ 或项目本地 .pi-board/，见 §7 开放问题 2
  topics/
    <topic>.jsonl           # append-only 黑板正文，每行一条 note
    <topic>.board.md        # 人类可读快照，每次 post 后重新渲染
```

- board 工具的 description 遵守 pi-mcp-adapter 式纪律：极小、只说 action 列表，细节按需。
- **验收标准**：两个终端各起一个 pi agent，A `post` 后 B 能 `read --since` 增量读到；`board.md` 与 JSONL 内容一致；seq 严格单调。

### M2.5：元原则 prompt + 纪律 hooks

交付 §3.5 的两个最终产物：

- `prompts/meta-principles.md`（≤500 token，5-6 条）；
- `extensions/discipline.ts`，至少实现三个 hook：
  - **外科手术 diff 检查**：edit/write 改动范围超出任务声明范围时警告；
  - **读后写**：Edit/Write 目标文件在本会话未 Read 过则拒绝；
  - **fail-loud**：bash 非零退出码不允许被静默吞掉；"任务完成"类标记只能由 hook 验证后落盘。
- **验收标准**：构造违规操作（未读先写、吞错误码）被 hook 实际拦截，有日志证据；meta-principles.md 用 tokenizer 实测 ≤500 token。

### M3：黑板摘要自动注入（onBeforeTurn）

- `onBeforeTurn` 中：若当前 agent **参与了某 topic**（open/首次 post 时登记参与关系），把该黑板的**预算内摘要**注入本轮上下文；
- 增量策略：只注入**上次注入之后的新条目**原文 + 一段更早内容的**精简全景**；
- 遵守 §5.4 全部约束（≤3000 字节、最新优先、`(last_seq, digest)` 缓存防重复生成）；
- 效果：agent **不用主动调用 `board read` 也能看见同伴的新发现**。
- **验收标准**：agent B 在**未调用 `board read`** 的情况下，回复中引用了 agent A 上板的发现（检查 B 的会话文件确认无 read 调用）。

### M4：讨论协议 caucus（skill 形态）

caucus = 多轮协商流程，实现为 `skills/caucus/SKILL.md`（强制工作流状态机，见原则 4），由一个 **leader 会话**驱动：

1. leader 向 topic 全体成员**轮询征集立场**（复用 pi-collaborating-agents 式 inbox 消息机制）；
2. **收割回复上板**（每个成员的立场作为 note post 到黑板，含 `consensus` 字段表明其当前结论）；
3. 检测共识：各方 `consensus` 字段一致 → 收敛；否则把分歧摘要发回各成员，进入下一轮；
4. 达到 `max_rounds` 仍未收敛 → leader 汇总各方立场与分歧，作为最终结论 note 上板。

策略全部留在 skill 层，不侵入 pi core。驱动方式（交互式 vs `pi --print` 脚本化）见 §7 开放问题 3。

- **验收标准**：3 个成员立场初始不一致，经 ≤3 轮后黑板上出现共识（或 max_rounds 汇总）note，且每轮立场完整留板可回溯；skill 状态机的每步产出物检查确实拦住过一次"跳步"。

### M5：端到端验收场景

「三 agent 分析一个真实问题」全流程：

1. leader `board open` 一个 topic（真实问题，如"分析某开源项目的一个 bug 根因"）；
2. spawn 3 个分工 agent——按原则 7 使用**角色卡**（role、responsibilities、out_of_scope），各自调查一个方向（如代码路径 / issue 历史 / 复现实验）；
3. 各 agent 独立调查并 `board post` 发现（期间 M3 注入让它们互相看见）；
4. `/caucus` 讨论收敛出结论；
5. 检查 `board.md` **完整呈现整个讨论过程**（所有发现、每轮立场、最终结论）；
6. **人工在对应 JSONL 中插入一条人类意见**（author 为人类用户），验证后续 agent 能读到——人机共写成立。

- **验收标准**：6 步全部通过；`board.md` 可作为独立文档读懂整个调查与讨论过程；验证证据来自多源（board.md + 各会话文件），不依赖任何单一 agent 的自我报告（原则 5）。

---

## 5. 旧 harness 血泪经验（MUST 遵守）

以下五条来自旧 harness 真实踩坑，均为强制约束；括号内标注其与 §3.3 八条原则的对应关系。

### 5.1 协作约束必须用 MUST，不用 SHOULD（→ 原则 1 的 prompt 侧下限）

Prompt 中对 agent 协作行为的约束（如"发现新信息后上板"）必须写 MUST。实测：写 SHOULD 时 LLM 会"合理地"判断当前情况不适用而跳过。注意这只是下限——按原则 1，真正关键的约束应直接升级为 hook。

### 5.2 完成标记的写入权归 runtime，绝不归 LLM（→ 原则 1 的极端情形，M2.5 fail-loud 门禁）

任务完成、readiness（就绪状态）等流程门禁标记，必须由钩子代码在验证真实条件后落盘。**绝不允许 LLM 自己声明"我完成了"就算数**——旧 harness 出现过 agent 伪造完成状态绕过门禁。pi 下的映射见 §7 开放问题 4。

### 5.3 可见域隔离（→ 原则 7 的信息侧）

绝不通过公共频道泄漏仅个别成员可知的秘密信息（狼人杀场景核心教训：狼人身份泄入公共频道游戏即崩坏）。pi 下每个 agent 是独立进程/session，物理隔离天然成立；但**共享黑板要按 topic 划分可见性**——agent 只应看到自己参与的 topic，M3 注入时必须按参与关系过滤。

### 5.4 token 预算意识（→ 原则 6）

黑板内容注入上下文必须走"预算内摘要"：**≤3000 字节**；**最新条目优先**；维护 `(last_seq, digest)` 缓存（条目没变则复用，避免重复生成摘要）；**绝不全量注入**——旧 harness 曾因全量注入历史导致上下文爆炸、触发压缩链路连环 bug。

### 5.5 append-only + 人类可读快照（→ 原则 8 的可围观性基础）

黑板与消息一律**追加式 JSONL**（每行一个 JSON 对象，只追加不修改）；**单写者原则**：同一文件同一时刻只有一个写者，或按文件分区（如每 agent 写自己的 inbox 文件）规避并发冲突，不引入锁服务；同时渲染人类可读的 `board.md` 快照（每次 post 后重新生成），供用户围观并可直接插入人工意见。

---

## 6. 技术栈与约定

- **语言**：TypeScript（跟随 pi 生态）；**Node ≥ 20**。
- **依赖纪律**：`@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`typebox` 一律 peerDependencies（pi 已捆绑，不复制）；其他运行时依赖须 bundledDependencies 显式声明——且每加一个依赖先自问是否违反 ADR-0 精神。
- **极简纪律**：本包新增的**常驻 context 内容**（tool description、meta-principles.md 等）总计控制在**数百 token 内**；黑板正文走按需加载与预算内摘要，绝不常驻。
- **git 约定**：本仓库本地提交即可，不需要配置远端（是否发 npm 见 §7 开放问题 3）；阶段性成果主动 commit，message 遵循 conventional commits（`feat:` / `fix:` / `docs:`）；不 force push、不提交敏感文件（密钥、token 等）。
- **决策记录**：重大取舍写入 `docs/decisions/` 下的短 ADR（Architecture Decision Record，架构决策记录），**每条 10 行以内**：背景 1-2 行、决策 1 行、理由 2-3 行、放弃的替代方案 1-2 行。

---

## 7. 开放问题（需在 M1 结束时给出答案，每题一条 ADR）

1. **fork pi-collaborating-agents 还是重写？**
   通读其源码后回答。考量维度：代码质量与可维护性、其消息机制与黑板模型的契合度、fork 后跟进上游的成本、其形态能否装进标准 pi 包结构。

2. **黑板存储放全局 `~/.pi/agent/collab-board/` 还是项目本地 `.pi-board/`？**
   考量维度：跨项目复用讨论 vs 讨论随项目走（可进 git）、多项目并行隔离、与 pi 自身存储惯例一致性。

3. **两个"驱动/分发"问题**：
   a) caucus 的 leader 用交互式会话还是 `pi --print` 脚本化驱动？（交互式：人类可实时介入每轮；脚本化：可自动化、可测试；或混合——脚本驱动 + 每轮结果落板供人围观。）
   b) 本包**发布到 npm 还是仅本地 `pi install ./`**？（仅本地：零发布负担；npm：多机同步方便。初期建议仅本地，留待 M5 后再议。）

4. **哪些钩子在 pi 0.83 实际可用？签名是什么？**
   本文档的钩子名（onBeforeTurn 等）来自调研资料，**必须在 M1 用 hello extension 逐个实测确认**（名称、参数结构、能否修改上下文/拦截工具）。同时回答：旧 harness 的 readiness 门禁在 pi 下映射为哪个钩子的什么检查——候选：`onToolCall` 拦截"声明完成"类操作并校验前置条件（如黑板上是否存在该 agent 的发现 note），或 `onAfterTurn` 校验后由钩子代码写入完成标记。红线不变：**完成标记只能由钩子代码落盘（§5.2）**。

---

## 8. 接手后前三个动作

1. **通读 pi packages 文档与 extension API 源码**：https://pi.dev/docs/latest/packages + https://github.com/earendil-works/pi 中 pi-agent-core 的 extension 接口定义（钩子签名、tool 注册、slash command 注册），对照本文档 §2.5 修正任何过时描述。
2. **搭包骨架并验证安装**：按 §2.4 建 package.json（含 pi 字段）+ 目录，`pi install ./ -l --approve`，确认包被注册、资源被发现。
3. **写 hello hook 实测钩子签名**：hello-world extension 覆盖 §2.5 列出的全部钩子，逐个打日志确认触发时机与参数结构，把实测结果记进 M1 的 ADR，然后按 §4 顺序推进。

祝顺利。设计争议以 §2.6 六条哲学裁决；候选规则的形态取舍用 §3.1 的三分法；哲学之外的坑，§5 已经替你踩过了。
