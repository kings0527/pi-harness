# ADR-0011: knowledge 与 handoff 固定双层放置
状态：knowledge 分层由 ADR-0014 取代；handoff 决策仍有效。
背景：自由放置会造成索引失效、重复根与不可追踪状态。
原决策：项目 knowledge 只在 `<project-root>/knowledge/`，默认 `scope=project`。
原决策：跨项目 knowledge 只在 `~/.pi-harness/knowledge/`，使用 `scope=global`。
决策：handoff 只在 `<project-root>/handoff/`；固定根内部允许任意子目录。
所有 knowledge 路径须在规范化及 symlink 检查后仍位于所选根内。
理由：知识可随仓库同步，全局技术可跨项目复用，路径始终可检查。
放弃：全局单根，以及依赖索引发现的自由放置。
