# ADR-0029 Board 协作实现独立审计

## Verdict

实现包含真实优化，但当前结论为 **revise，暂不宜提交**。P0 默认 catalog-only、未 join topic 正文与 CRITICAL 隔离、显式 join 后完整 checkpoint/delta 已成立；runtime actor 来源、legacy 读取与基础 target 校验也有效。仓库门禁 214/214、typecheck、diff-check、core isolation 均通过，但未覆盖以下可复现/可确定推导的负优化窗口。

## 阻断项

1. stale lock reclaim 存在 observe→rename TOCTOU：reclaimer 可移走已替换的 live lock，恢复时的 exists→rename 又可覆盖第三 writer 的锁。随机 UUID token 并非单调 fencing，且数据 mutation 与 token check 不原子，可能出现双 writer。
2. close journal 与 active META 使用原地覆盖，不具 crash 原子性。已复现 prepared journal + torn active JSONL 时 recovery 删除 journal 后遗留损坏；invalid/partial journal 永久 fail-loud；commit 后缺 `.board.md` 时不能从 archive JSONL 重建。
3. structured close gate 有错误放行：新 createdBy topic 可用 kind-less `tags=[convergence]` 走 legacy gate；历史 convergence 可裁决其后的 material claim；已撤回 verification 仍算 resolution；cross-topic material-claim challenge 被漏检。
4. catalog 任一 topic 变化都持久追加整份 catalog，重新引入 ADR-0018 消除的全量快照累积。row cap 不限制字节；单 topic 2MB goal 已生成 2,000,542-byte catalog。
5. `participate join` 不验证 topic 存在，错误 ID 会持久化并使 joined Board checkpoint 持续 deferred。

## 最低修复

采用条件式 inode/token claim 或真正单调 fencing，并用 barrier 三进程测试；journal/META 用 temp+fsync+rename，恢复成功前不删 journal；按完整 append-only 状态图重算 retraction/convergence/cross-topic refs，新 topic 强制 structured；catalog 改 checkpoint+metadata delta/tombstone，并限制总字节；participate 前验证 topic identity。

来源: topic-audit-board-collaboration-implementation#seq-5,seq-6,seq-7,seq-8,seq-9,seq-10,seq-11,seq-12,seq-13

---

来源: topic-audit-board-collaboration-implementation#seq-5,seq-6,seq-7,seq-8,seq-9,seq-10,seq-11,seq-12,seq-13
