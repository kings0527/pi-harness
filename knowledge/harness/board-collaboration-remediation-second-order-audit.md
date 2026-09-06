# Board/topic 整改提案的二阶审计结论

## 总体判断

`handoff/2026-09-05-board-collaboration-review.md` 的整改方向针对真实缺陷，结论应为 **revise，不是 reject**。当前 `discoverPeerTopics()` 会把所有 open topic 自动加入每个 session，随后完整注入其 notes；历史原始 checkpoint 实测为 238,744–247,438 bytes、每份 27 topics。因此 P0 将“可发现”与“全文参与”分开，属于可量化的实质优化。P1 的可信 runtime actor、结构化论证关系与更准确的 close gate，以及 P2 的 stale-lock/close 恢复，也都对应现有代码中的真实缺口。

## 防止负优化的三组硬边界

1. **P0 可见性与容量**：未 join topic 的普通正文和 agent 标记的 CRITICAL 正文不得跨越 join 注入；只投递足以触发重审的 catalog/version/critical metadata。验收必须同时包含旧全量注入与新 catalog+joined 注入的固定 fixture 字节对照，以及多个 session 都 defer 时仍能观察到版本/关键状态变化的测试。否则可能从“全量噪声”退化为“集体漏协作”，或让 CRITICAL 成为绕过隔离的后门。
2. **P1 身份与兼容**：Pi session UUID 可作为 actorId；resume 保持 UUID，fork/clone 产生新 UUID并保留 parentSession 血缘。runtime 取不到稳定 ID 时必须拒写，不能静默写入 `unknown-session` 形成假责任链。普通/legacy note 应渐进兼容；只有显式 material claim 进入 close gate，convergence verdict 可显式接受 unresolved 后关闭，历史 topic 必须仍能读、写、关闭和归档。
3. **P2 锁与事务**：不得仅因 lease 超时抢锁。应结合 owner liveness 与 process-start identity，或采用完整 fencing/续租；release 必须匹配 lease token，旧 owner 恢复后不得继续写或删除新 owner 的锁。close 必须定义唯一 commit point 和幂等恢复；每个故障注入点应得到确定终态，恢复后的 archive 仍须通过现有 v1 integrity witness。

## 审计口径

当前测试全绿只证明现状，不能证明尚未实现的 P0/P1/P2 已完成。watch/defer 状态老化、leave 后旧 context 仍存在、外部 Git/NFS 破坏等已在提案中明确披露，不应重复上纲为新缺陷。

来源: topic-audit-board-topic-remediation#seq-5,seq-7,seq-13,seq-16,seq-17,seq-18

---

来源: topic-audit-board-topic-remediation#seq-5,seq-7,seq-13,seq-16,seq-17,seq-18
