# pi-harness

> Agent 的共享认知层——安装一个包，获得完整的多 agent 协作 + 长期记忆 + 工程纪律体系。

pi-harness 是一个 [pi](https://github.com/earendil-works) 扩展包。装上它，agent 就具备了自主发起多 agent 协作、把结论沉淀成长期知识、以及一套由 runtime 强制的工程纪律。核心逻辑运行时无关，未来可迁移到其它 runtime。

## 安装

```bash
pi install /path/to/pi-harness -l --approve   # 本地
pi install github:kings0527/pi-harness         # 从 GitHub
```

要求 Node.js >= 20。作为 pi 扩展包运行，依赖 `@earendil-works/pi-*` 系列（peerDependencies）。

## 核心能力

### 协作层：Board + Spawn

- **`board` 工具**：topic-based 共享黑板。核心协作动作 `open`（定目标）/ `post`（上板）/ `read`（读板，支持增量 `--since`）/ `list` / `close`（归档并生成 summary + decisions）。
- **`spawn` 工具**：并行启动分工 subagent。五张角色卡——`scout`（探索）/ `worker`（深挖）/ `reviewer`（验证/找反例）/ `advocate`（辩论正方）/ `critic`（辩论反方）。subagent 以 `pi --print` 脚本化驱动，非交互、并行、带超时，产出全部落板。
- **`/storm` 命令**：开启多模型对抗辩论。`/storm on <model1>,<model2>` 启用后，agent 可通过 `spawn action=debate` 触发回合制辩论（advocate 先上板，critic 读板后反驳）。适用于判断题、盲区突破等场景。
- **Agent 自主判断**何时启动多 agent 协作（≥2 个可并行方向、探索面大、需独立验证时），无需用户手动指示。
- **迭代收敛循环**：spawn → 读板 → 不够就针对缺口再 spawn → 收敛才 close。
- **Close 门禁**：runtime 强制 `close` 前必须先在板上贴出带 `convergence` tag 的收敛判词，否则阻断（收敛判断归 LLM，存在性校验归代码）。
- **持久执行目标**：`/goal <objective>` 按 session 保存目标、在 transcript 保留原命令并立即启动执行；可逆路线自主择优，仅真实全路径阻塞时请求输入；`status/pause/resume/off` 只管理状态。

### 知识层：Knowledge + Distill

- **分层 knowledge**：`project` 默认写当前子项目 `<project-root>/knowledge/`，`workspace` 写总项目 Git 根 `<workspace-root>/knowledge/`，`global` 写 `~/.pi-harness/knowledge/`。处理 A 时只注入 A + workspace + global，不加载 B/C/D；同根自动去重。读取不建目录，写入时按需创建。
- **`distill` skill**：topic close 后系统性评估每条发现，够格的蒸馏进知识库。写入走 `board` 工具的 `distill` 动作。
- **强制溯源**：每条知识条目必须带 `source`（如 `topic-<id>#seq-<N>`），无溯源直接被 runtime 拒绝。
- **CONFLICT 标记机制**：新知识与旧条目冲突时用 `distill-conflict` 只追加冲突块，永不静默覆盖原内容。
- **完整上下文**：knowledge index、Board notes 与 subagent 输出保持完整；估算达到当前模型窗口 20% 时仅告警，提示检查过期、错误、重复或过长内容。
- **稳定且可审计的注入**：knowledge 与 Board 独立持久；Board 对当前 session 参与的 topic 在 active context 先发一次 checkpoint，后续只按 topic `seq` 追加 delta，压缩后 checkpoint 缺失才重发全量。参与关系以 session entry 保存；每份实际注入的精确字节写入 `.pi-board/context-snapshots/`，CRITICAL note 保持带来源可见。
- **上下文 headroom 护栏**：在 session start、agent settled 和 idle input 边界同时预留 completion + 新输入空间，先于 Pi 默认阈值压缩；session/settled 边界等待压缩结算，越线 input 在自己的原管线内等待（保留 skill/template 展开），non-idle steer/followUp/缺参保持 Pi 原始时机；同 session 额外并发 idle input 不竞争 agent run，而是原样持久化并显式提示重试；最后竞态仅联动收紧 provider 已有 output/thinking budget，无可调字段时显式告警。
- **主动 reasoning epoch**：不检查括号、短句或其他输出风格；每累计 32K reasoning tokens，就在下一次 provider 调用前插入持久 epoch 边界。已完成 epoch 的 raw thinking 与 opaque reasoning signature 不再回放，当前尚未消费的 tool-call 协议只桥接一次；原 session JSONL、用户文本、可见结论、工具调用/结果、Board、knowledge 与 artifacts 保持完整。可用 `PI_REASONING_EPOCH_TOKENS` 调整预算（下限 1024）。每条 assistant 消息追加 `thinking_observation` 审计事件（思考字符数、电报体 `（——` 标记数/千字比率、请求上下文 tokens），用于长程 A/B 关联退化与上下文大小；`PI_REASONING_EPOCH_STRIP=0/false/off` 关闭已完成 epoch 的剥离（协议合规臂，thinking 完整回塞，轮转 marker 仍做重锚定），默认开启。

### 哲学层：Discipline + Doctrine

- **7 条元原则** + **协作决策准则**：由 `before_agent_start` hook 为每个用户轮次组装同一套稳定 systemPrompt，让"该不该协作"成为 agent 的自触发判断，而非需要用户下令。
- **Plan 纪律**：≥3 步的任务先上板贴计划；最新计划每轮自动置顶注入，context 压缩后计划不丢，subagent 也随黑板注入继承计划。
- **Runtime hooks**（`discipline.ts` / `convergence.ts`）：
  - `read-before-write`：改文件前未读则告警（记事件，不阻断）
  - `fail-loud`：bash 非零退出码记入 `events.jsonl` 供审计
  - `diff-scope`：单会话改动 > 5 个文件时提醒收敛范围
  - `spawn-round-guard`：单 topic 第 4 轮 spawn 起提醒反思方向（不阻断）
  - `convergence-gate`：唯一的硬阻断——close 无收敛判词则拒绝

## 工作流示意

```
你："调查 XX 问题，给我完整报告"
  → agent 自主判断：多方向，需协作
  → board open（定目标）
  → post plan（出计划）
  → spawn scout + worker + reviewer（并行探索）
  → subagents 上板发现 → agent 读板判断收敛
  → 不够 → 针对缺口再 spawn 一轮
  → 够了 → post convergence verdict → board close
  → distill 蒸馏进 knowledge
  → 下次同类问题直接命中知识库
```

## 架构

```
extensions/          ← pi 薄适配层（工具注册 + hooks，唯一接触 pi 接口的层）
  board.ts           共享黑板工具
  spawn.ts           多 agent spawn 工具
  storm.ts           /storm 命令注册
  context-feed.ts    冻结、审计并追加 knowledge + Board checkpoint/delta
  context-headroom.ts 提前压缩 + provider output 边界护栏
  reasoning-epoch.ts 固定预算推理分代 + completed-thinking provider 隔离
  discipline.ts      纪律 hooks（read-before-write, fail-loud, diff-scope）
  convergence.ts     收敛门禁（close 前置校验 + spawn 轮次护栏）
  doctrine.ts        常驻认知注入（before_agent_start）
core/                ← 纯 Node.js，runtime 无关（零 pi import）
  board/             黑板逻辑 + digest 生成
  context-reference/ knowledge/Board 分层选择与 reference 格式化
  context-headroom/  completion/ingress 预留与 output-only clamp 决策
  reasoning-epoch/   推理 token 计量、epoch 隔离与 checkpoint 策略
  context-size/      上下文体积估算与告警阈值
  context-snapshot/  注入内容寻址快照
  knowledge/         知识库读写
  identity/          角色卡加载
  spawn/             subagent 启动
  storm/             storm 配置管理
  events/            事件日志
  storage/           存储路径管理
skills/distill/      ← 蒸馏工作流 skill
skills/storm/        ← Storm 辩论 skill（按需加载）
prompts/             ← 常驻 prompt（meta-principles + collaboration-doctrine）
knowledge/           ← 当前 project 或共享 workspace 的知识存储
~/.pi-harness/knowledge/ ← 跨项目知识存储（scope=global）
handoff/             ← 项目 session handoff 的唯一根
agents/              ← 角色卡（scout / worker / reviewer / advocate / critic）
docs/decisions/      ← 架构决策记录（ADR）
```

黑板运行时状态落在 `.pi-board/`（topics + `events.jsonl` + `context-snapshots/`），可直接 `cat` 检查。

### Knowledge 渐进披露

- 每轮 reference 常驻 project/workspace/global `index.md` 路径与完整索引行；index 是导航 catalog，不是正文。
- project/workspace 根 `KNOWLEDGE.md` 的 `Areas` 常驻，目录级 `KNOWLEDGE.md` 在文件访问后从下一用户轮次开始披露。
- `session_start` 不递归扫描 cwd；`discoverScopes` 只作为显式 catalog 修复接口，并受目录预算限制。

## 设计原则

- **Core runtime-agnostic**：`core/` 不 import 任何 pi API，只依赖 Node 标准库；未来可整体迁移到其它 runtime。
- **文件优先**：一切状态皆为可 `cat` 检查的文件，无黑盒。
- **最少工具**：两个工具（board + spawn）覆盖全部协作。
- **判断归 LLM，约束归代码**：hook 只强制不可违反的硬约束，语义判断留给 LLM。
- **渐进披露**：工具 description 极小，skill 正文按需加载。
- **证据完整**：运行时不静默截断诊断与协作内容；体积过大时显式告警并保留原文。
- **scratchpad 分代**：raw thinking 仍完整留在可审计 session 文件中，但不作为跨 epoch 的持久证据或模仿样本回放。

## ADR（架构决策）

- **0000**: 不捆绑第三方包（只吸收设计思想，自实现最小版）
- **0001**: Core 运行时无关
- **0002**: v1 不引入 embeddings / 向量库
- **0003**: 重写而非 fork pi-collaborating-agents
- **0004**: Spawn 用 `pi --print` 脚本化驱动
- **0005**: 协作准则常驻 systemPrompt 注入
- **0006**: Close 收敛门禁
- **0007**: Storm 辩论回合制
- **0008**: 修复 skill 死链接
- **0009**: Anti-drift 仅告警 hook
- **0010**: Physarum collective intelligence
- **0011**: Knowledge/handoff 原固定双层放置（knowledge 部分由 0014 取代）
- **0012**: 完整保留上下文，超量只告警
- **0013**: 每用户轮次冻结且可审计的 reference 注入
- **0014**: Monorepo knowledge 固定 project/workspace/global 三层作用域
- **0015**: `/goal` 按 session 隔离并以持久快照绑定完成证据
- **0016**: Runtime reference 只追加状态变化，保持跨用户轮次 cache prefix
- **0017**: Knowledge catalog 常驻，目录正文按访问渐进披露，启动阶段零递归扫描
- **0018**: Board 每个 active context 一次 checkpoint，后续按 topic seq 追加 delta
- **0019**: 输出感知的 context headroom，提前压缩并以 output-only clamp 兜底
- **0020**: Board append-only 完整性护栏
- **0021**: 固定 token 预算主动切换 reasoning epoch，压缩前移除 scratchpad

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm run test        # node --test tests/**/*.test.ts
```

## License

Private — personal toolbox for kk.
