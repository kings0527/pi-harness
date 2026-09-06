# Board 多实例协作改造 — 审查 Handoff

**状态**：设计审查；未开始改产品代码。
**请求**：请独立审查本提案的语义、并发、迁移、上下文容量和测试缺口；不要把“计划”当成已实现。
**来源**：Board `multi-instance-board-coordination-audit#2,#3,#4`；`knowledge/harness/board-multi-instance-collaboration-audit.md`。

## 1. 已有能力（不是本次要修的故障）

- 同一 cwd 的 PI 实例共享 `.pi-board`；topic 按 ID 独立 JSONL。
- 每个 topic 的 open/post/close 有 `wx` sidecar lock；post 在锁内重读，分配连续 seq；archive 后禁止同 ID 复用。
- feed 内存状态按 session ID 隔离；跨进程实例在每个 user-turn 发现本项目 open topics，peer 新建/更新/关闭分别以 opened delta、seq delta、tombstone 投递。
- 这是 turn-boundary pull：不会中断一个正在运行的 agent call。

代码锚点：`core/board/index.ts`、`extensions/context-feed.ts`、`core/context-reference/index.ts`、`tests/board.test.ts`、`tests/context-feed.test.ts`、ADR-0018/0020/0027。

## 2. 已证实的当前问题

当前 `discoverPeerTopics()` 会把每个发现到的 open topic 持久加入当前 session；加入后其全部 non-critical notes 会进入 Board checkpoint/delta。它保证“不遗漏 peer topic”，但把 **发现** 错当成 **完整参与**。

后果不是存储/seq 混写，而是语义干扰：不相关 topic 的历史、假设和工作方法进入每个 agent 的 context，挤占容量且可能影响路线判断。`~/work/quna` 的只读历史审计：27 个 open topics、215 active notes；曾有单次 checkpoint 纳入 33/34 topics、238–247KB。仅 2 个 active topic 有多 author，表明当前“所有 open topic 自动加入”并未自然导向有效协作。

结构性缺口：

- Topic meta 无创建 actor、协调/声明范围、关系。
- `author` 和 `tags` 都可任意填写，不能证明谁做了什么。
- 无 claim/evidence/challenge/verification/retraction 的引用图。
- close gate 只验证曾出现任一 `convergence` tag，不检查新证据、未决质疑或关闭责任。
- lock 没有 stale-owner recovery；close 是多文件步骤，中途崩溃会 fail-loud/defer，不能恢复事务。

## 3. 提案与“会解决什么”

### P0：catalog + 显式参与状态

每个 user-turn 对所有 open topic 投递**轻量 catalog**，不投递其完整 note。catalog 至少含：

`topic id`、`goal`、`createdBy`（P1 前可标 unknown）、`createdAt`、last activity、note count、participants、relations、当前 lifecycle 状态。

一个 session 对每个 topic 的状态为：

- `join`：需要直接协作；完整、append-only topic notes 进入该 session 的 context。
- `watch`：潜在相关；仅接收 catalog card/版本变化提示，不接收正文。
- `defer`：当前无关或证据不足；持久记录判断和理由，不接收正文。
- 未声明：仅 catalog 可见；不应自动升级为 join。

**解决：**

1. peer topic 仍可被发现，因此不退回 ADR-0027 前“后开 topic 不可见”。
2. 不相关 topic 不再全文污染所有 session；新 session/compact 后的 full snapshot 尺寸主要由显式 joined topics 决定。
3. agent 对“我是否看过、为何加入/旁观/暂缓”留下可审计决策。
4. 可保持既有 joined topic 的完整性承诺：一旦 join，不截断其 notes，仍走 checkpoint/delta。

**不解决：**

- 系统不能自动知道 topic 是否真的相关；这是 agent 判断，catalog 只提供判断输入。
- agent 仍可能错误 defer、忘记 join 或过度 join。
- 同目标 topic 的重复创建、错误结论、错误验证不会因 catalog 自动消失。
- 运行中的 agent 仍只能下一个 user-turn 看见 peer 变化。
- 同 topic 的锁遗留与 close 中断仍存在。

### P1：可审计论证与责任链

将 actor identity 从 caller 的自由 `author` 中分离。runtime 从 Pi session 派生稳定 `actorId`（并持久化一个显示名），写入 topic 创建、note 和 close 事件；`author` 仅作为角色/显示标签。

为 note 加结构化 `kind`：`declare | plan | claim | evidence | challenge | verification | decision | retraction | convergence`。关键关系通过 target references 指向 `topic#seq`：

- `challenge` 必须 target 一个 claim/evidence/decision；
- `verification` 必须 target 一个 claim；
- `retraction` 必须 target 被撤回的 note；
- `convergence` 必须给出 verdict 和 unresolved 列表。

代码只校验 actor、合法 kind、target 存在且类型匹配、引用不跨越未来 seq；**不得**裁决事实真伪或强制某一方法。`owner/coordinator` 若引入，仅表示维护收敛/计划责任，绝不是写锁或其他 agent 的排他权限。

**解决：**

1. 可回答“谁创建、谁声明、谁提出主张、谁提供证据、谁质疑、谁验证、谁撤回、谁关闭”。
2. agent 能判断其他 topic 的变化是 claim、证据、质疑还是结论，减少把普通长文本误当权威结论。
3. close 可以检查显式未决项，阻止只因历史上有 `convergence` tag 就静默关闭。
4. 跨 topic relation（`supports | depends-on | conflicts-with | duplicate-of | child-of`）让 agent 发现潜在冲突/依赖而非靠全文扫描。

**不解决：**

- runtime 能验证引用格式，不能验证“evidence 真能支持 claim”；仍需独立复核。
- actorId 证明的是 harness session，不是人类真实身份，也不能阻止同一 agent 编造内容。
- 强制结构可能增加摩擦，促使 agent 为过 gate 机械贴标签。
- 未提供有效异议/验证样本时，结构化流程也可能产生虚假的“已收敛”印象。

### P2：崩溃恢复与并发韧性

为 topic lock 记录 PID、创建时间、随机 lease token / process start identity；超时后仅在 owner 确认死亡或 lease 到期的明确规则下回收，避免盲删活锁。将 close 改为可检测、可恢复的 transaction：写 journal/临时目录，完成 archive artifacts 和 witness 后进行可恢复提交；启动/list/read 时检测半完成状态，完成或回滚并留下事件。

**解决：**

1. agent/进程 SIGKILL 后不永久遗留 `.lock`。
2. close 中断不会只能人工猜测 active/archive 哪一侧权威；恢复有明确状态机。
3. 保持现有 fail-loud，而不是用“忽略损坏文件”伪造成功。

**不解决：**

- 网络文件系统、外部手工编辑、Git merge rollback 仍可能破坏文件；现有完整性 guard 只能发现一部分，不能消除外部写入。
- lease 选择不当会产生活锁被误抢或死锁等待；需要 crash/长暂停/时钟异常测试。
- multi-file transaction 不能使任意文件系统具备分布式事务保证。

## 4. 重要语义：何时共同一个 topic？

- **同一个 topic**：目标、主要工件和验收条件相同，即使 agent 的方法/假设不同；通过 claim/evidence/challenge/verification 分支协作。
- **新的关联 topic**：有独立工件或决策边界，例如“实现 P0”和“审查 P0 的迁移安全性”；必须声明 relation。
- **join**：其他 topic 的结论/证据会改变当前假设、实现或验收。
- **watch**：可能相关但尚不足以占用全文 context。
- **defer**：当前明确不相关，或只有泛泛相似；理由应可被未来 agent 复查。
- **KB**：只用于 closed、可复用、带来源的结论；不能替代 open Board 的争议、实时状态或协作记录。

## 5. 必须先裁决的设计问题

1. **默认策略**：新 session 是否默认 `catalog-only`（推荐），还是对启动时已有 topics 自动 `watch`？后者更易感知变化，但会积累 watch 噪声。
2. **catalog 完整性与预算**：项目有非常多 open topics 时，catalog 本身可能很大。是否保证完整 catalog + 超量告警（符合“不静默截断”），还是定义显式分页/按需展开？不得悄悄丢 topic。
3. **participants 定义**：只算 `join`，还是包括 watch/defer/曾 post 的 actor？建议分开统计，避免把“看过”伪装为“共同承担”。
4. **defer 重审**：defer 是否因 topic version/新 CRITICAL/显式 relation 自动提醒重审？建议不自动升级 join，只发一个可见的 catalog-change marker。
5. **join 退出**：是否允许 leave？若允许，历史上已注入的 context 不能删除；只影响未来 deltas，且必须记 tombstone/reason。不得声称模型“已忘记”。
6. **CRITICAL 的例外**：是否对未 joined topic 的 critical note 直接可见？这会重新引入跨 topic 干扰。建议 catalog 显示 critical count/last critical metadata，由 agent 明确 join/read；只有用户/human critical 才可考虑系统级可见。
7. **actor identity**：Pi session ID 是否可稳定地供 runtime 使用？若 session fork/restore，如何生成不可冲突 actorId？不得只 hash 显示 author。
8. **结构化 kind 强制范围**：是否先只强制 challenge/verification/retraction/convergence，普通 progress/笔记允许 free-form？推荐渐进式，以免将当前历史 topic 变为无效。
9. **close gate**：何种 note 是“关键 claim”？建议 `kind=claim` 且显式 `material=true` 才进入 gate；否则无法从自由文本可靠推断。未决项可被 verdict 显式接受为 `unresolved`，不应要求所有探索都验证完才允许 bounded close。
10. **跨 topic target**：target 是否限定当前 topic？建议 note target 可跨 topic，但 relation 必须先存在或同次显式声明，防止任意 ID 引用形成噪声图。
11. **迁移**：旧 session 现有 auto-joined membership 如何映射？建议保留为 legacy-joined（不改变历史语义）；新发现 topic 默认 catalog-only。旧 Note 无 actor/kind/target 时视作 `legacy`，仅新结构化动作受 gate。
12. **P2 的范围**：先解决 stale lock，还是先实现 close journal？二者都需要 crash-injection 测试；不要在 P0/P1 评审中悄悄混入。

## 6. 验收标准（应先写测试）

### P0

1. 两个独立进程、同 cwd：A 新开 `x`，B 下个 turn 得到 `x` catalog，但不收到 `x` notes。
2. B `join x` 后，首次得到完整、连续 `x` checkpoint；之后只得到 `x` 的 seq delta。
3. B `watch x` 后，A post 仅使 B 收到 catalog version/last activity 变化，不含正文。
4. B `defer x` 后，持久化理由；A 的普通 post 不带正文；A 写 critical 时按被裁决规则通知重审，而非强制 join。
5. A/B/C 分别 open x/y/z，B join x、watch y、defer z：B 的 context 只有 x 正文；catalog 同时列 x/y/z 的状态。
6. peer 在 B session 启动后新开 topic，仍在下一 turn catalog 可见。
7. compression/resume/fork 后 membership 和 cursor 语义不倒退；legacy auto-joined session 不丢既有 topic。
8. catalog/active joined reference 到达容量阈值时告警且不静默丢失 topic 或 note。

### P1

1. topic open/post/close event 带 runtime-derived actorId；伪造 `author` 不改变 actorId。
2. challenge/verification/retraction 指向不存在、未来、错误 kind 或损坏 seq 时 fail-loud、零写入。
3. 合法 cross-topic target/relation 可往返、archive 后仍能审计。
4. close 被未回应 material claim 或 challenge 阻止；有 `verification`、`retraction` 或 convergence 的显式 unresolved verdict 后可关闭。
5. 多 actor 的并发 post 保持连续 seq，target 不被并发竞态错指。
6. 旧 topic 和旧 session 能读取、继续 post、close/archive；新增约束不把历史数据判坏。

### P2

1. 持 lock 进程被 SIGKILL 后，按明确 lease/owner 规则恢复；活锁不得被另一个进程抢走。
2. 在 close 的每个写/rename 点故障注入，重启后状态可恢复为完整 active 或完整 archive；不能出现两个“真相”。
3. recovery 保留原始 bytes / journal / events，禁止静默删 lock 或猜测丢弃 note。
4. 与已有 archive integrity check、topic reuse prohibition、checkpoint/tombstone delivery 的回归全绿。

## 7. 审查者应重点找的反例

- catalog-only 是否让关键 peer 结论更难被看到，导致“低噪声但漏协作”？
- watch/defer 是否会成为长期垃圾状态；重审触发是否足够可观察？
- “完整 catalog 不截断”与大量 topic 的 context headroom 是否矛盾？
- claim graph 是否会变成昂贵且可伪造的官僚层，反而掩盖证据质量？
- session ID 是否在 fork/resume/multiple local processes 下真能代表 actor identity？
- `leave` 后旧 context 仍在模型历史，是否会造成“协议说已退出、模型仍受旧内容影响”的错觉？
- stale lock reclaim 如何避免暂停、PID 重用、跨主机文件系统、时钟跳变导致双 writer？
- close journal 如何与 Git 外部修改和现有 v1 archive witness 相互作用？
- CRITICAL 是否应跨 join 传播；若是，谁有权标 critical，如何防止滥用？
- 旧 archive、旧 sessions、旧 Board references 的兼容/迁移是否会破坏 ADR-0012 的完整性或 ADR-0018 checkpoint/delta cursor？

## 8. 非目标 / 不可承诺

- 不用向量库、embedding 或隐式“相关性评分”替代明确协作判断。
- 不隔离同目录 Board；共享可发现性和可审计协作必须保留。
- 不承诺自动判断真相、自动选择正确 topic 或自动消除重复工作。
- 不因用户无交互而终止同一 topic 的不同方法；方法分歧本身是可协作内容。
- 不静默截断 catalog、joined note、archive、证据或 diagnostic output；容量问题应显式告警/要求选择，不假装未发生。
- 不把 KB 当作实时 Board 的替代。

## 9. 推荐审查输出格式

```md
## Verdict
accept | revise | reject

## Verified strengths
- ...（对应本 handoff 的章节/断言）

## Blocking defects
- severity: ...
  scenario: ...
  why proposal fails: ...
  minimum correction: ...

## Non-blocking risks
- ...

## Required ADR decisions
- ...

## Missing tests
- ...
```
