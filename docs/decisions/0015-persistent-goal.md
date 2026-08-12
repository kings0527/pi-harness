# 0015: /goal — session-persistent execution focus with frozen references
背景：执行目标需要跨用户轮次保持，但不得污染其他 pi session、破坏 KV cache 或提前声明完成。
决策：`/goal <condition>` 按 session ID 落盘，并将原命令作为可见 user message 立即启动 agent；每个 session 仅一个当前 goal。
决策：`before_agent_start` 每用户轮次递增一次并生成内容寻址快照；该轮所有 `context` calls 复用完全相同字节。
决策：快照写入 `.pi-board/context-snapshots/`，session entry 与 event 记录 goal ID、路径和轮次。
决策：完成 note 必须同时携带 `goal-met` 与 `goal:<id>`；`tool_result` 后复查已持久化 note，再由 core 标记 achieved。
理由：session 隔离避免父会话、fork 与 subagent 互相覆盖；冻结快照保持可审计和 cache 前缀稳定。
理由：LLM 判断目标是否达成，runtime 只验证当前 goal 对应证据确已写入。
放弃：项目级 `goal.json` 单例、每次 LLM call 改写计数、固定轮次 stall 阈值、`tool_call` 预执行完成。
