# Board 协作整改实现 — 独立审查 Handoff

**状态：已实现，未提交。** 请审查代码与测试；不要按旧设计 handoff 假定功能尚未实现。

## 实现范围

- **ADR**：`docs/decisions/0029-board-collaboration-state-machine.md`
- **P0**：`extensions/context-feed.ts`
  - 新 session 为 catalog-only；每 turn 注入完整 open-topic metadata catalog。
  - 仅 `board action=participate mode=join` 接收完整 Board notes/delta；`watch`/`defer` 只接收 metadata。
  - 未 join topic 的普通 note 和 agent 标记的 CRITICAL note 均不跨 session 注入。
  - catalog 有显式 `PI_BOARD_CATALOG_MAX_TOPICS`（默认 1000）上限；超过即 fail-loud，不静默丢 topic。
  - 旧 session 已持久化的 participation/checkpoint 迁移为 legacy join，避免历史正文突然消失。
- **P1**：`extensions/board.ts`、`core/board/types.ts`、`extensions/convergence.ts`
  - Board 工具的 open/post/close 必须有 Pi session ID；将其写为 actorId，caller 传的 `author` 仅显示名。
  - fork 仅在真实 `session_start.reason === "fork"` 时记录 parent session；resume/new 不伪造 ancestry。
  - 新增 `declare|plan|claim|evidence|challenge|verification|decision|retraction|convergence`、target refs、relations、material、verdict、unresolved。
  - structured topic 的 close 要求 convergence verdict；material claim 与 challenge 必须验证/撤回/决策处理，或被最后 verdict 显式接受为 bounded unresolved。
  - legacy free-form topic 继续用旧 `tags=["convergence"]` close，保证兼容。
- **P2**：`core/board/index.ts`
  - lock 先写完整 candidate，再以 hard link 原子发布，避免 SIGKILL 产生空锁。
  - stale recovery 仅允许 `kill(pid,0) => ESRCH` 或 Linux process-start identity 不同；没有 timeout 抢锁。
  - lock token fencing：旧 owner 不可释放/写入替代 lock。
  - close 用 `.transactions/<topic>.close.json` journal；archive JSONL 是唯一 commit point；恢复会确定性完成 archive side artifacts，或在 commit 前恢复 active META。
  - 缺失的 active `.board.md` 可从 JSONL 确定性重建；损坏 JSONL 仍 fail-loud。

## 重点文件

- `core/board/index.ts`
- `core/board/types.ts`
- `extensions/context-feed.ts`
- `extensions/board.ts`
- `extensions/convergence.ts`
- `prompts/collaboration-doctrine.md`
- `tests/board-collaboration-remediation.test.ts`
- `tests/board-extension-actor.test.ts`
- `tests/context-feed.test.ts`

## 已验证

```text
npm test          # 214/214 PASS
npm run typecheck # PASS
git diff --check  # PASS
grep -r '@earendil' core/ # empty
```

专项覆盖：catalog metadata 隔离、watch/defer 不泄漏 CRITICAL 正文、显式 join 后完整 checkpoint/delta、catalog cap fail-loud、actor 防伪与 fork lineage、target/type 校验、legacy close、material challenge gate、死锁回收、活锁不可抢、损坏 lock 不静默回收、open derived-view recovery、close commit-point recovery。

## 审查问题

1. hard-link candidate + rename-to-claim 是否在本地 POSIX 文件系统上保持互斥、token fencing 与恢复安全？请重点寻找双 writer / lock 丢失反例。
2. close journal 所有 crash 点是否落到唯一 active 或唯一 archive 真相？archive JSONL commit 后是否可能残留会误导的 active artifact？
3. catalog 是否真的不包含 note content、CRITICAL content、author free text；join/watch/defer session state 是否在 resume/compaction/fork 下正确？
4. structured close readiness 是否错误地允许或拒绝 material claim/challenge 的 bounded close？
5. actorId 是否只来自 runtime session，不会被 author/input 覆盖；fork lineage 是否只记录真实 fork？
6. compatibility：legacy note/archive/session/checkpoint 是否继续工作，且不违反完整性/append-only 约束？
7. 是否有必须新增的故障注入、并发或 cross-process 测试？

## 已知边界（非伪装为已解决）

- 不自动判断 topic 相关性；agent 必须 join/watch/defer。
- NFS、Git merge 或人工外部改写仍可能损坏文件；代码目标是 fail-loud/保留证据，不是分布式共识。
- catalog 超上限时拒绝投递，要求 operator 调整显式上限或治理 topic；不静默分页。
- `leave` 未实现，因旧 context 已注入内容无法诚实地“遗忘”。
- 未 join 的 human/system CRITICAL 没有特殊广播豁免；这是避免 priority 成为隔离后门的保守选择。
