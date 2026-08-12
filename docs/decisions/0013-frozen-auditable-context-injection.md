# ADR-0013: 冻结且可审计的 reference 注入
背景：cache miss 只影响计费；轮内变化、贴在 user 尾部和不落盘会造成隐式 steering 与复盘缺口。
决策：在 `before_agent_start` 为每个用户轮次生成一次完整快照，后续 LLM calls 复用相同字节。
精确注入文本按 SHA-256 写入 `.pi-board/context-snapshots/<hash>.txt`，session entry/event 记录路径与来源。
`context` hook 将独立 `<reference_context>` 消息插在真实 user 消息之前，不再改写 user 文本。
Board CRITICAL notes 不进入隐藏 reference；以带 `topic#seq` 的可见持久消息进入 session。
模型使用 reference 结论时应引用 knowledge scope/path 或 Board topic#seq，不再要求静默吸收。
理由：稳定 cache 前缀，同时满足文件优先、显式 steering、可溯源与完整证据。
放弃：逐 LLM call 刷新、user 尾部 HTML comment、仅为 cache 命中改变语义内容。
