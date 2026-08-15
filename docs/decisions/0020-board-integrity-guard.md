# ADR-0020: Board 完整性护栏 — append-only 防回滚
背景：sibling-project 的 .pi-board/ 被 Git 跟踪后经冲突合并（67f0cdec），已关闭 topic 的 archive JSONL 被回滚：#31–#35 从 JSONL 消失，仅 summary/decisions 保住结论。
决策：统一 active parser（readActiveTopic）作为活 topic 唯一读入口：META 须第一行、id/status 匹配、Topic/Note 字段经运行时守卫（含 Date 范围）；openTopic/postNote 写入前同守卫，追加后重读比对完整 Note；任何不符即 throw，文件零污染。
决策：归档三方校验——close 时 META 写 integrityVersion=1 + finalSeq；summary 第一行机器 witness；v1 四项独立检查（finalSeq 存在/与 JSONL 相等、witness 存在/与两者相等）互不短路；legacy 用严格块解析（精确 headerBlock 定位、无 /m、紧邻 Participants）；解析不出则显式 unverified，readArchivedTopic/listTopics 携带 integrity 状态。
决策：runtime hook（extensions/board-integrity）：session_start 按 ctx.sessionManager 去重，检测 .pi-board 被 Git 跟踪即告警（含 git rm --cached 修复命令）；事件落盘根与检测根一致（appendEvent 显式 root，自动建目录、失败不崩溃），不注入模型上下文、不修改用户文件。
理由：保留文件存储（file-first），把 append-only 的跨机前提交给代码守住（constraints for code）；告警只对 operator，不占 token 预算。
未决定：SQLite/网络协作后端留待独立 ADR（本 ADR 不否决，只修 harness 自身护栏）。
