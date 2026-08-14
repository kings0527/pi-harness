# ADR-0018: Board checkpoint + delta feed
背景：每次 Board 变化都追加全量 open-topic 快照，使同一内容在压缩前被重复保留。
决策：knowledge 与 Board 分成独立持久消息，Board 每个 active context 先发一次全量 checkpoint。
决策：后续仅按 topic `seq` 追加新 note delta；新建/关闭 topic 以 open/tombstone delta 表达。
决策：topic ID 限定单路径段且归档后禁止复用；原子 lock 分配 `seq`，legacy 归档冲突在写前 fail-loud。
决策：每轮一次性捕获参与 topic；参与关系以 session entry 持久化，初始化失败持续重试。
决策：checkpoint 缺失时重发全量并从 closed archive 恢复 CRITICAL；每份注入仍内容寻址落盘。
迁移：legacy reference 视为 checkpoint；检测到旧 ID 复用时以 `createdAt` incarnation 全量重显 active 内容。
理由：语义完整性由 checkpoint+seq delta 保证，传输量与新信息量而非历史总量成正比。
取代：ADR-0013/0016 中“Board 变化即追加全量 reference”部分；冻结、可审计、append-only 要求保留。
