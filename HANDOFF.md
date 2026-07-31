# pi-harness 交接文档（HANDOFF）

> 目标读者：从零接手本项目的 coding agent。
> 你的任务：在 pi coding agent 的 extension 体系上，构建 **Topic（主题频道）+ 共享黑板（Shared Blackboard）** 协作层。
> 本文档是唯一权威起点，请通读全文后再动手。

---

## 1. 愿景与目标

### 1.1 核心理念：协作共进

分析一个复杂问题时，单个 agent 的视角有限。我们要的模式是：

1. 多个**分工明确的 agent**（例如一个查代码、一个查文档、一个做实验）各自独立调查；
2. 每个 agent 把自己的发现**写上共享黑板**（blackboard：一个所有参与者可读写的公共记录区）；
3. 每个 agent 能**读到他人的发现**，据此修正自己的方向；
4. 所有 agent 围绕一个**主题（topic）**异步讨论，最终收敛出结论。

关键点：**"讨论过程"本身是一等公民**——它是一个持久化的、人类可随时围观、可随时插入意见的数据结构（文件），而不是散落在各个 agent 会话里的隐式状态。

### 1.2 项目背景（为什么是 pi，不是旧 harness）

用户 kk 曾维护一个 Rust 多 Agent harness（位于 `/home/me/harness/harness-mvp/harness-core`，核心文件 orchestrator.rs 约 2.4 万行），实现了：

- Orchestrator 调度（中心化编排器分配任务给各 agent）
- scope 频道（按可见域隔离的通信通道）
- broadcast（向所有 agent 广播消息）
- caucus 多轮协商（多 agent 反复交换立场直至达成共识，曾成功用于狼人杀游戏中多 agent 达成一致决策）

评估后决定：**不再在旧 harness 上加功能**。它的单 agent 执行引擎部分（LLM 调用、工具循环、上下文管理）是重复造轮子，且 2.4 万行的 orchestrator 维护成本过高。新方案：以 **pi coding agent**（Mario Zechner / badlogic 的极简 coding agent，pi-mono 仓库）作为"发动机/底盘"，只在其 extension 体系上重建用户真正想要的**差异化能力**——Topic + 共享黑板。

pi 已在本机安装完成，可直接使用。

### 1.3 明确的非目标（不要做）

- ❌ **不造单 agent 发动机**：LLM 抽象、agent loop、工具执行、会话管理全部由 pi 提供，我们一行都不重写。
- ❌ **不做重量级编排引擎 / workflow DSL**：不设计声明式流程语言、不做状态机引擎。协作策略用最朴素的脚本/钩子实现。
- ❌ **不追平 Claude Code 的功能面**：不做 IDE 集成、不做花哨 TUI、不堆功能。本项目只做一件事：让多个 pi agent 能围绕主题在黑板上协作。

---

## 2. pi 引擎要点（接手者必读）

### 2.1 三层架构

pi-mono 仓库（https://github.com/badlogic/pi-mono）是一个 monorepo，核心三层：

| 层 | 包名 | 职责 |
|---|---|---|
| LLM 抽象 | **pi-ai** | 统一多个 provider（Anthropic/OpenAI/Google 等）的 API、流式输出、工具调用格式 |
| Agent 核心 | **pi-agent-core** | 约 418 行的 agent loop（读输入→调 LLM→执行工具→循环）+ extension 体系 |
| CLI | **pi-coding-agent** | 命令行入口、内置工具（read/write/edit/bash 等）、会话管理、TUI |

我们的全部代码都活在 **extension 层**，不改 pi 任何一层的源码。

### 2.2 Extension 机制（我们的落点）

- Extension 是一个 **TypeScript 模块**，由 **jiti**（运行时 TS 加载器）直接加载，**无需预编译**——写完 `.ts` 文件即可生效。
- 提供生命周期钩子（hook）：
  - `onSessionStart` / `onSessionEnd`：会话开始/结束
  - `onBeforeTurn` / `onAfterTurn`：每轮 LLM 调用前/后（**M3 摘要注入的落点**）
  - `onToolCall` / `onToolResult`：工具调用前/后（可拦截、可改写，**门禁检查的落点**）
- Extension 可以：
  - **注册自定义 tool**（LLM 可调用的工具，我们的 `board` 工具靠这个）
  - **注册 slash command**（用户在 CLI 输入 `/xxx` 触发，我们的 `/caucus` 靠这个）
  - **持久化状态**：往 session 里写 custom message（存进会话文件但**不发给 LLM**，适合存扩展自己的元数据）

### 2.3 会话模型

- 会话是 **append-only DAG**（只追加的有向无环图）：每条消息只增不改，支持从任意节点**分支**出新的对话线。
- 支持**跨 provider 续写**：同一会话可以中途换模型/换厂商继续。

### 2.4 重要先例：baochunli/pi-collaborating-agents（必读源码）

仓库 https://github.com/baochunli/pi-collaborating-agents 已经验证了 **pi extension 做多 agent 消息传递是可行的**。其核心设计：

- **存储布局**（全部是文件，无服务进程）：
  - `registry/`：活跃 agent 注册表（谁在线、什么角色）
  - `inbox/{name}/`：每个 agent 的收件队列，分 `queued/`（普通排队）与 `urgent/`（紧急）
  - `runs/`：运行记录
  - `messages.jsonl`：全局 append-only 消息日志
- **文件预留（reserve paths）**：agent 声明"我要改这些文件"，通过 `onToolCall` 钩子**拦截其他 agent 的 edit/write**，避免并发写冲突。
- **寻址模式**：`@direct`（点对点）与 `@all` broadcast（广播）。
- **两级消息优先级**：urgent 消息**立即中断**接收方当前轮次（steer）；normal 消息**排队**待当前轮结束后处理（followUp）。
- **subagent 并行生成**：支持 spawn 出 worker / scout / documenter / reviewer 等类型的子 agent 并行工作。

**⚠️ 接手者第一步行动**：通读该仓库源码，然后做出决策——是 **fork 它来扩展**（加黑板能力），还是**仅借鉴其存储与消息模式、自己重写**。决策及理由必须记录下来（见 §7 开放问题 1）。

### 2.5 pi 设计哲学（本项目的裁决原则）

任何设计争议，以下原则是最终裁判——违反其一即需重新设计：

1. **system prompt < 1000 tokens**：pi 的系统提示极小，我们不许显著撑大它。
2. **最少工具**：能用一个工具（带 action 参数）解决就不注册第二个。
3. **渐进披露**：只有工具的 description 常驻上下文，具体内容（黑板正文等）按需加载。
4. **完整可观测**：一切状态都是可以用 `cat` 检查的文件，没有黑盒。
5. **文件优先**：状态、计划、通信全走文件系统，不引入数据库/消息队列/常驻服务。
6. **机制与策略分离**：pi core 提供机制（钩子、工具），协作策略（caucus 流程等）留在扩展层。

### 2.6 参考链接

- pi 设计博文：https://mariozechner.at/posts/2025-11-30-pi-coding-agent/
- pi 源码：https://github.com/badlogic/pi-mono
- 多 agent 先例：https://github.com/baochunli/pi-collaborating-agents
- Armin Ronacher 的 pi 评述：https://lucumr.pocoo.org/2026/1/31/pi/

---

## 3. 从旧 harness 迁移的设计智慧（血泪经验，MUST 遵守）

以下每条都是旧 harness 中真实踩过的坑，在本项目中为强制约束：

### 3.1 协作约束必须用 MUST，不用 SHOULD

Prompt 中对 agent 协作行为的约束（如"发现新信息后上板"）**必须写成 MUST**。旧 harness 实测：写 SHOULD 时，LLM 会"合理地"判断当前情况不适用而跳过，导致协作协议名存实亡。

### 3.2 完成标记的写入权归 runtime，绝不归 LLM

任务完成、readiness（就绪状态）等**关键流程门禁标记**，必须由 runtime/钩子代码写入（例如在 `onToolResult` 中验证某工具真实成功后才落盘标记）。**绝不允许 LLM 自己声明"我完成了"就算数**——旧 harness 中出现过 agent 伪造完成状态绕过流程门禁的情况。在 pi 下的映射见 §7 开放问题 4。

### 3.3 可见域隔离

**绝不通过公共频道泄漏仅个别成员可知的秘密信息**（旧 harness 狼人杀场景的核心教训：狼人身份一旦泄入公共频道游戏即崩坏）。好消息：pi 下每个 agent 是**独立进程/独立 session**，物理隔离天然成立。但注意：**共享黑板本身要按 topic 划分可见性**——agent 只应看到自己参与的 topic 的黑板内容，摘要注入（M3）时必须按参与关系过滤。

### 3.4 token 预算意识

黑板内容注入 agent 上下文**必须走"预算内摘要"**：

- 建议预算 **≤ 3000 字节**；
- **最新条目优先**（新发现比旧结论更值得占预算）；
- 维护 `(last_seq, digest)` 缓存：记录上次摘要覆盖到的序号与摘要哈希，条目没变就复用缓存，**避免重复生成摘要**；
- **绝不全量注入**黑板内容——旧 harness 曾因全量注入历史导致上下文爆炸、触发压缩链路一连串 bug。

### 3.5 append-only + 人类可读快照

- 黑板与消息**一律追加式 JSONL**（每行一个 JSON 对象，只追加不修改）；
- **单写者原则**：同一文件同一时刻只有一个写者，或按文件分区（如每个 agent 写自己的 inbox 文件）来规避并发写冲突——不引入锁服务；
- 同时渲染一份**人类可读的 `board.md` 快照**（由扩展在每次 post 后重新生成），供用户围观进度、并可直接在其中插入人工意见（人机共写，见 M5 验收）。

---

## 4. 待搭建模块（核心交付物）

整体以**一个 pi extension** 实现（建议名 `pi-harness` 或 `collab-board`），保持最小 API 表面。

### M1：环境验证 + fork-or-rewrite 决策

- 跑通 pi 基础流程：启动一个单 agent 会话完成简单任务；写一个 hello-world extension（如在 `onSessionStart` 打印一行日志），确认 jiti 加载与钩子触发正常。
- 通读 pi-collaborating-agents 源码，产出 **fork 还是重写** 的决策记录（ADR，见 §6）。
- **验收标准**：hello-world 钩子日志可见；决策 ADR 已提交，含至少 3 条对比理由。

### M2：核心原语——`board` 工具

一个自定义 tool（名为 `board`），用 **action 参数区分子操作**（参考 pi-collaborating-agents 的 `agent_message` 单工具多 action 模式，符合"最少工具"原则）：

| 操作 | 语义 |
|---|---|
| `board open <topic> --goal "..."` | 开主题：注册 topic 元信息 + 创建黑板文件 |
| `board post <topic> "<content>" [--tags]` | 上板一条 note，字段：`seq`（单调递增序号）、`author`、`timestamp`、`tags`、`content` |
| `board read <topic> [--since seq]` | 读黑板，支持 `--since` 增量读取（只返回大于该 seq 的条目） |
| `board list` | 列出所有主题及各自条目计数 |

存储布局：

```
<存储根>/                     # ~/.pi/agent/collab-board/ 或项目本地 .pi-board/，见开放问题 2
  topics/
    <topic>.jsonl            # append-only 黑板正文，每行一条 note
    <topic>.board.md         # 人类可读快照，每次 post 后重新渲染
```

- **验收标准**：两个终端各起一个 pi agent，A `post` 后 B 能 `read --since` 增量读到；`board.md` 内容与 JSONL 一致；seq 严格单调。

### M3：摘要自动注入（onBeforeTurn）

- 在 `onBeforeTurn` 钩子中：若当前 agent **参与了某 topic**（参与关系在 open/首次 post 时登记），把该黑板的**预算内摘要**注入本轮上下文。
- 增量策略：只注入**上次注入之后的新条目**原文 + 一段**精简全景**（更早内容的一两句概括）。
- 遵守 §3.4 全部约束（≤3000 字节、最新优先、`(last_seq, digest)` 缓存）。
- 效果：agent **不用主动调用 `board read` 也能看见同伴的新发现**。
- **验收标准**：agent B 在**未调用 `board read`** 的情况下，其回复中引用了 agent A 上板的发现（检查 B 的会话文件确认无 read 调用）。

### M4：讨论协议（caucus 的 pi 化）

caucus = 多轮协商流程。由一个 **leader 会话**驱动：

1. leader 向 topic 全体成员**轮询征集立场**（复用 pi-collaborating-agents 式的 inbox 消息机制）；
2. **收割回复上板**（每个成员的立场作为 note post 到黑板，含 `consensus` 字段表明其当前结论）;
3. 检测共识：各方 `consensus` 字段一致 → 收敛；否则进入下一轮（把分歧摘要发回各成员）；
4. 达到 `max_rounds` 仍未收敛 → leader 汇总各方立场与分歧，作为最终结论 note 上板。

实现形态：**slash command（`/caucus <topic>`）或 leader 端驱动脚本**（二选一，见开放问题 3）。策略全部留在扩展层，**不侵入 pi core**。

- **验收标准**：3 个成员立场初始不一致，经 ≤3 轮后黑板上出现共识（或 max_rounds 汇总）note，且每轮的立场都完整留在黑板上可回溯。

### M5：端到端验收场景

「三 agent 分析一个真实问题」全流程：

1. leader `board open` 一个 topic（真实问题，如"分析某开源项目的一个 bug 根因"）；
2. spawn 3 个分工 agent（各自调查一个方向，如代码路径 / issue 历史 / 复现实验）；
3. 各 agent 独立调查并 `board post` 各自发现（期间 M3 注入让它们互相看见）；
4. `/caucus` 讨论收敛出结论；
5. 检查 `board.md` **完整呈现整个讨论过程**（所有发现、每轮立场、最终结论）；
6. **人工在 board.md 对应 JSONL 中插入一条人类意见**（author 为人类用户），验证后续 agent 能读到——证明人机共写成立。

- **验收标准**：上述 6 步全部通过，`board.md` 可作为独立文档读懂整个调查与讨论过程。

---

## 5. 里程碑依赖与建议顺序

```
M1（环境验证 + 决策）
 └─→ M2（board 核心原语）
      ├─→ M3（摘要注入）──┐
      └─→ M4（caucus）  ──┴─→ M5（端到端验收）
```

- **M1 → M2 强依赖**：fork-or-rewrite 决策直接决定 M2 的代码起点。
- **M3 与 M4 可并行**：两者只共享 M2 的 board 存储层，互不依赖。
- **M5 依赖 M3 + M4 全部完成**。
- 每完成一个里程碑：跑通其验收标准 → commit → （如有重大取舍）写 ADR。

---

## 6. 技术栈与约定

- **语言**：TypeScript（跟随 pi 生态）；**Node 版本跟随 pi 的要求**（以本机已装 pi 的运行环境为准）。
- **极简纪律**：新增的**常驻 context 内容**（tool description、注入的固定说明等）总计控制在**数百 token 以内**；黑板正文走按需加载与预算内摘要，绝不常驻。
- **git 约定**：
  - 本仓库**本地提交即可**，不需要配置远端；
  - 阶段性成果**主动 commit**，message 遵循 conventional commits 规范（`feat:` / `fix:` / `docs:` 等）；
  - **不 force push、不提交敏感文件**（密钥、token、本机路径外泄的配置等）。
- **决策记录**：重大取舍写入 `docs/decisions/` 下的短 ADR（Architecture Decision Record，架构决策记录），**每条 10 行以内**：背景 1-2 行、决策 1 行、理由 2-3 行、放弃的替代方案 1-2 行。该目录由你（接手者）在第一次写 ADR 时创建。

---

## 7. 开放问题（需在 M1 结束时给出答案，每题一条 ADR）

1. **fork pi-collaborating-agents 还是重写？**
   通读其源码后回答。考量维度：代码质量与可维护性、其消息机制与我们黑板模型的契合度、fork 后跟进上游的成本。

2. **黑板存储放全局 `~/.pi/agent/collab-board/` 还是项目本地 `.pi-board/`？**
   考量维度：跨项目复用讨论 vs 讨论随项目走（可进 git）、多项目并行时的隔离、pi 自身惯例（其 session 存储在哪，保持一致）。

3. **caucus 的 leader 用交互式会话还是 `pi --print` 脚本化驱动？**
   交互式：人类可实时介入每轮；脚本化（`pi --print` 非交互模式）：可自动化、可测试。也可能是混合方案（脚本驱动 + 每轮结果落板供人围观）。

4. **旧 harness 的 readiness 门禁思想在 pi 下映射为哪个钩子的什么检查？**
   候选：`onToolCall` 拦截"声明完成"类操作并校验前置条件是否真实满足（如黑板上是否存在该 agent 的发现 note）；或 `onAfterTurn` 校验后由钩子代码写入完成标记。核心红线不变：**完成标记只能由钩子代码落盘，LLM 无权自报**（§3.2）。

---

## 附：接手后的前三个动作（建议）

1. `pi --help` 与一次最小会话，确认本机 pi 可用、确认其版本与 extension 加载方式（查 pi-mono 的 README / docs 中 extension 目录约定）。
2. clone 并通读 https://github.com/baochunli/pi-collaborating-agents ，边读边记 fork-or-rewrite 的证据。
3. 写 hello-world extension 验证钩子链路（M1），然后回到本文档按 §5 顺序推进。

祝顺利。有疑问以 §2.5 的六条哲学裁决；哲学之外的坑，§3 已经替你踩过了。
