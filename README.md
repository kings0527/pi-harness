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
- **`spawn` 工具**：并行启动分工 subagent。三张角色卡——`scout`（探索）/ `worker`（深挖）/ `reviewer`（验证/找反例）。subagent 以 `pi --print` 脚本化驱动，非交互、并行、带超时，产出全部落板。
- **Agent 自主判断**何时启动多 agent 协作（≥2 个可并行方向、探索面大、需独立验证时），无需用户手动指示。
- **迭代收敛循环**：spawn → 读板 → 不够就针对缺口再 spawn → 收敛才 close。
- **Close 门禁**：runtime 强制 `close` 前必须先在板上贴出带 `convergence` tag 的收敛判词，否则阻断（收敛判断归 LLM，存在性校验归代码）。

### 知识层：Knowledge + Distill

- **`knowledge/`**：markdown 目录树 + `index.md` 索引，作为长期记忆，随 git 版本化。
- **`distill` skill**：topic close 后系统性评估每条发现，够格的蒸馏进知识库。写入走 `board` 工具的 `distill` 动作。
- **强制溯源**：每条知识条目必须带 `source`（如 `topic-<id>#seq-<N>`），无溯源直接被 runtime 拒绝。
- **CONFLICT 标记机制**：新知识与旧条目冲突时用 `distill-conflict` 只追加冲突块，永不静默覆盖原内容。

### 哲学层：Discipline + Doctrine

- **6 条元原则** + **协作决策准则**：由 `before_agent_start` hook 常驻注入 systemPrompt（约每会话一次），让"该不该协作"成为 agent 的自触发判断，而非需要用户下令。
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
  context-feed.ts    context feed（knowledge index + board digest/plan）
  discipline.ts      纪律 hooks（read-before-write, fail-loud, diff-scope）
  convergence.ts     收敛门禁（close 前置校验 + spawn 轮次护栏）
  doctrine.ts        常驻认知注入（before_agent_start）
core/                ← 纯 Node.js，runtime 无关（零 pi import）
  board/             黑板逻辑 + digest 生成
  knowledge/         知识库读写
  identity/          角色卡加载
  spawn/             subagent 启动
  events/            事件日志
  storage/           存储路径管理
skills/distill/      ← 蒸馏工作流 skill
prompts/             ← 常驻 prompt（meta-principles + collaboration-doctrine）
knowledge/           ← 长期知识存储（git 版本化）
agents/              ← 角色卡（scout / worker / reviewer）
docs/decisions/      ← 架构决策记录（ADR）
```

黑板运行时状态落在 `.pi-board/`（topics + `events.jsonl`），可直接 `cat` 检查。

## 设计原则

- **Core runtime-agnostic**：`core/` 不 import 任何 pi API，只依赖 Node 标准库；未来可整体迁移到其它 runtime。
- **文件优先**：一切状态皆为可 `cat` 检查的文件，无黑盒。
- **最少工具**：两个工具（board + spawn）覆盖全部协作。
- **判断归 LLM，约束归代码**：hook 只强制不可违反的硬约束，语义判断留给 LLM。
- **渐进披露**：工具 description 极小，skill 正文按需加载。

## ADR（架构决策）

- **0000**: 不捆绑第三方包（只吸收设计思想，自实现最小版）
- **0001**: Core 运行时无关
- **0002**: v1 不引入 embeddings / 向量库
- **0003**: 重写而非 fork pi-collaborating-agents
- **0004**: Spawn 用 `pi --print` 脚本化驱动
- **0005**: 协作准则常驻 systemPrompt 注入
- **0006**: Close 收敛门禁

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm run test        # node --test tests/**/*.test.ts
```

## License

Private — personal toolbox for kk.
