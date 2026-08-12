# ADR-0014: monorepo knowledge 固定三层作用域
背景：ADR-0011 的单项目根会把关联子项目的局部知识汇入同一索引，产生冗余。
决策：`project`（默认）只写 pi 会话根 `<project-root>/knowledge/`，用于当前子项目。
决策：`workspace` 只写最近 Git 根 `<workspace-root>/knowledge/`，用于关联子项目共享结论。
决策：`global` 只写 `~/.pi-harness/knowledge/`，用于跨 workspace 结论。
上下文注入 project + workspace + global，同根去重，且不扫描兄弟子项目。
handoff 继续只写当前 `<project-root>/handoff/`；各固定根内部允许任意子目录。
所有路径经规范化与 symlink 检查后仍须位于所选根内。
理由：局部隔离、workspace 复用、全局复用三者分明且仍是可检查文件。
放弃：Git 根单索引、自动注入全部兄弟项目、任意目录散置。
