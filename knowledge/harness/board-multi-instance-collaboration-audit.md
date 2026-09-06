# 同目录多 PI 实例的 Board 协作审计

## 已验证行为

同一工作目录的 PI 实例共享 `.pi-board`。不同 topic ID 进入不同 JSONL；同一 topic 的 open/post/close 由 sidecar `wx` lock 串行化，post 在锁内重新读取并分配连续 seq，已归档 ID 不可复用。因此不同 topic 不会混写或互相占用 seq；同 ID 并发创建/写入会序列化或 fail-loud。

每个 session 的 feed 状态按 session ID 隔离；每个 user turn 会发现同项目全部 open topic，跨进程 peer 新建、更新和关闭 topic 分别以 opened delta、seq delta 与 tombstone 投递。投递是 turn-boundary pull，不会中断正在运行的模型调用。

## 当前协作缺口

自动发现会把所有 open topic 永久加入当前 session；已加入 topic 的全部非 CRITICAL note 会被完整注入。系统没有 `join/watch/defer`、相关性声明、topic relation、可信 actor identity 或 claim/evidence/challenge/verification 引用关系。故不同 topic 在字节存储层分开，但在模型上下文层会相互制造噪声；不得把「自动发现」等同于「应全文参与」。

`author` 与 tags 当前是自由文本；topic 也没有创建者/协调者。现有 close gate 只要求曾出现一个 `convergence` tag，不能表达未决质疑、验证状态或关闭责任。

## 推荐演进

保持共享 Board，拆开发现与参与：每轮展示所有 open topic 的轻量 catalog card，只有显式 `join` 的 topic 才完整注入；`watch` 仅接收目录/变化提示，`defer` 记录当前无关判断。相同目标、工件和验收标准的不同方法在同一 topic 内通过 claim/evidence/challenge/verification 协作；只有独立决策边界才分 topic，且用 supports/depends-on/conflicts-with/duplicate-of/child-of 关联。

P0 是 catalog + explicit join/watch/defer；P1 是 runtime-derived actor identity、结构化 note kind 与 target seq，以及基于未决 claim 的 close gate；P2 是 stale-lock/close-transaction recovery。代码只校验身份、结构、引用和未决状态；相关性与事实判断保留给 LLM。KB 仅沉淀 closed、可复用、可溯源结论，不能替代开放 Board 的活假设和争议。

来源: Board multi-instance-board-coordination-audit#seq-2,seq-4

---

来源: Board multi-instance-board-coordination-audit#seq-2,seq-4
