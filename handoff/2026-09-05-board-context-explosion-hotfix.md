# Board 上下文注入爆炸 — 止血修复 Handoff

**状态：最小修复已实现，未提交。** 面向 ADR-0029 改动的原作者会话：你留下的未提交改动在真实 `.pi-board` 存在 fat 数据时会把会话上下文直接打爆（观测到 290.3%/1.0M）。本次只修注入爆炸本身；下方「未修残留」归你继续。

## 事故证据链（2026-09-05）

- `.pi-board/topics/fat-goal`：META 的 `goal` 字段本身是 10MB 的 `A`；`fat-note-rels`/`fat-rels` 各 ~4.4MB notes。
- `.pi-board/context-snapshots/df117ad3….txt`（13:04）与 `80851dbe….txt`（13:20）：两个 ~15MB 的 `<board_catalog>` —— catalog 逐字携带 goal/participants/relations。
- `e5073198….txt`（13:19）：10.5MB `<board_delta>` —— join 后笔记正文逐字注入。
- catalog 的 sha256 在任何 topic 活动后变化 → 全量 catalog 每轮重复注入；旧引用消息按 ADR-0012 永久保留 → 累积爆炸。
- `.pi-board/events.jsonl` 12MB：`board_open` 事件逐字记录 goal（core/board/index.ts `appendEvent("board_open", { goal, … })`，19 条 = 10.5MB）。

## 本次修复范围（ADR-0030）

所有**自动注入路径**字节有界，截断全部显式（kept/total 字节数 + 完整原文 sha256 + 检索指针）：

- 新增 `core/text-budget/index.ts`：`boundedExcerpt`（code-point 安全切割）+ `boundedIntEnv`。
- `extensions/context-feed.ts` catalog：goal 摘录（`PI_BOARD_GOAL_EXCERPT_BYTES`=240）、participants/relations 各 16 个（`PI_BOARD_CATALOG_MAX_LIST`，超出带 `_total=N`）、转义后整体字节帽（`PI_BOARD_CATALOG_MAX_BYTES`=64000，fail-loud throw，与 MAX_TOPICS 同语义；实际先于 topic 帽触发）。
- `core/context-reference/index.ts`：checkpoint/delta 4 处 section header 的 goal 摘录；`formatCriticalMessage` 的 goal 属性摘录 + 正文内联护栏（CRITICAL 不过 digest，必须单独守）。
- `core/board/digest.ts`：`inlineNoteBody`，正文超 `PI_BOARD_INLINE_NOTE_MAX_BYTES`（32768）→ 显式 "withheld from feed" stub，指向 `board action=read` / topic JSONL。
- `extensions/board.ts`：`open` 回显与 `list` 输出的 goal 摘录。`read` 保持无界——它就是 stub 的检索通道。
- 回归测试 `tests/board-feed-budget.test.ts`（8 例）；ADR-0030 已登记进架构测试清单。

已验证：`npm test` 222/222；`node --experimental-strip-types --check` 全部改动文件；`grep -r "@earendil" core/` 为空；对真实 `.pi-board`（fat-* 在场）模拟 session_start + before_agent_start，catalog 注入从 ~15MB 降到 **1857 字节**，fat goal 原文不再出现。未做真实 `pi -p` 端到端跑（本机 shell 无 pi CLI）——建议你补一次活体冒烟。

## 未修残留（原作者继续）

1. **写侧无限额**：`openTopic`/`postNote` 仍接受任意大小输入。建议 `PI_BOARD_MAX_GOAL_BYTES`/`PI_BOARD_MAX_NOTE_BYTES` 写入时拒绝（约束归代码）。注意限额只能加在写路径，不能进 `validateStructuredNote`/read 校验器——否则存量 fat topic 变得不可读，连 catalog 都会 throw。
2. **`/goal` 扩展同款漏洞**：`core/goal/index.ts` `setGoal`/`goal_replaced` 事件记录全文，`renderGoalReference` 每轮原文注入。同一套 boundedExcerpt 直接可套。
3. **`board_open` 事件日志膨胀**：上面证据链第 5 条；建议事件只记 `goalBytes`+`goalDigest`（该事件无 goal 字段消费者，已核实）。
4. **catalogEntry 全量解析**：每轮为构建 metadata 行完整 parse 每个 open topic 的 JSONL（fat-* 在场 ≈25MB/轮 JSON parse）。上下文已安全，但 CPU/延迟是浪费；考虑元数据增量维护或流式扫描。
5. **catalog 摘要抖动**：行内含 `activity` ISO 时间戳，任何 post 都改变全量 catalog 的 digest → 所有 session 下轮重注入。有界后每次仅 ~2KB，但活跃板上仍是每轮固定开销；可考虑降低 activity 精度或拆出 volatile 字段。
6. **knowledge 通道**索引行/KNOWLEDGE.md 正文字节无界：ADR-0012 有意残差，本次未动；如要收口需单独 ADR。
7. **fat-* 夹具**仍留在真实 `.pi-board`（fat-goal / fat-note-rels / fat-rels / t），现充当活体 canary；去留由你决定（删除属破坏性操作，建议确认后再清）。
