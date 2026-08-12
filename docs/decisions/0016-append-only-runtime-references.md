# ADR-0016: Append-only runtime references preserve cross-turn cache prefixes
背景：在 `context` hook 中移动临时 reference，即使字节未变，也会从上一轮插入点切断 provider KV-cache 前缀。
决策：passive reference 与 active goal 作为 `before_agent_start` 返回的持久 custom message，只在状态或快照变化时追加。
决策：完整 reference 快照继续内容寻址落盘；相同 snapshot 不重复进入 LLM context，metadata 仍可逐轮记录。
决策：goal 的 turn count 只进状态与审计 metadata，不进入 goal prompt；pause、achieved、clear 与 fork 隔离以追加状态消息覆盖。
决策：压缩后若 active context 已无当前 reference，下一用户轮次重新追加完整当前快照。
理由：上一 provider request 保持为下一 request 的精确前缀，语义变化只追加、不回写历史 prompt。
代价：reference 真正变化时保留旧快照；最新消息显式 supersede，context-size 告警与 compaction 继续负责容量边界。
取代：ADR-0013/0015 中通过临时 `context` 注入实现 cache 稳定的部分；其冻结、完整性与审计要求保留。
