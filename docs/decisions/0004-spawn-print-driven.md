# ADR-0004: spawn 采用 `pi --print` 脚本化驱动

- **背景**：spawn 工具需要启动分工 subagent（HANDOFF §8 开放问题 3a：交互式会话 vs 脚本化驱动）。
- **决策**：subagent 用 `child_process.spawn` 启动 `pi --print --approve "<prompt>"`，非交互、并行、带超时。
- **理由**：① 可自动化、可测试——exitCode/输出可程序化断言；② subagent 的 cwd 设为项目目录，自动装载同一份 pi-harness 扩展与 `.pi-board/`，协作过程全部落板，人类照样可通过 board.md 围观（脚本驱动 + 结果落板的混合路线）；③ 实测通过：scout 真实上板（author=scout）、events.jsonl 记录 spawn_start/spawn_end。
- **放弃的替代方案**：交互式会话驱动（人类需在场逐轮介入，无法并行与自动化；人的介入点已由 board post --author human --priority critical 覆盖）。
