# ADR-0029 Board 协作整改实现

Board 的同目录协作改为「完整 metadata catalog + 显式参与」：新 session 默认 catalog-only，只有 `board participate mode=join` 接收完整 Board note checkpoint/delta；`watch` 与 `defer` 是带理由的 metadata-only session 状态。未 joined topic 的普通 note 和 agent 标记 CRITICAL 正文不跨 session 注入。catalog 完整投递；超过显式 `PI_BOARD_CATALOG_MAX_TOPICS`（默认 1000）时 fail-loud，不静默截断。

新 Board tool 写入 runtime session actorId；自由 `author` 仅用于显示。真实 fork 才记录 parent session。structured note 支持 claim/evidence/challenge/verification/retraction/convergence、target reference、relation、material、verdict、unresolved；structured topic close 要求有效 convergence，material claim/challenge 必须验证、撤回、决策处理，或被最后 verdict 显式接受为 bounded unresolved。legacy free-form topics 保留旧 convergence tag close 兼容。

锁以完整 candidate 文件 + hard-link 原子发布，死 owner 仅在 PID ESRCH 或 Linux process-start identity 不一致时回收，token 防止旧 owner 释放替代锁。close 使用 journal，archive JSONL 是唯一 commit point；恢复确定性完成 archive side artifacts 或在 commit 前恢复 active META。缺失派生 `.board.md` 从 JSONL 重建；损坏源文件仍 fail-loud。

验证：`npm test` 214/214 PASS、`npm run typecheck`、`git diff --check`、core 无 pi 依赖。边界：不自动判断相关性；NFS/Git/人工外部写入仍只 fail-loud；catalog 超 cap 需显式治理；不实现 leave，因为已注入的模型历史不能诚实遗忘。

来源: Board board-collaboration-remediation#seq-3,seq-4

---

来源: Board board-collaboration-remediation#seq-3,seq-4


## ⚠️ CONFLICT (2026-09-05T05:19:02.406Z)

**New evidence contradicts this entry.**

独立实现审计发现 lock reclaim TOCTOU、close crash recovery、structured close gate、catalog 全量累积与参与校验缺口，当前不应视为已安全完成

来源: topic-audit-board-collaboration-implementation#seq-5,seq-6,seq-8,seq-10,seq-11,seq-13
