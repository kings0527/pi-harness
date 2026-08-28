# ADR-0026: Index-row lifecycle — dead-link drop + retired fold
背景：每轮注入的 knowledge catalog 直接贴 index.md 原文，既包含指向已删文件的死链（误导模型"有此文件"），也把已被取代的历史行与当前有效知识并列（如 csjune SUPERSEDED 与终局 PASS 两行相互矛盾地同时在场），拉低信噪比。
决策：注入前用 getIndex() 解析而非贴原文；auditIndex 判定为 missing/invalid 的死链行排除出 catalog，但保留在 index.md 并继续作为 health issue 报告。
决策：index 行支持行首结构化标签 `[SUPERSEDED]`/`[ARCHIVED]`/`[DEPRECATED]`（大小写不敏感），解析为 status；无标签即 active，全部 legacy 行行为不变（向后兼容）。
决策：注入时 active 行留主 catalog，退休行折叠到末尾 `retired (folded…)` 区并保留标签，仍可被引用为历史；死链优先，既退休又缺文件的行直接排除、连 retired 区都不进。
决策：updateIndex 标签感知——对退休路径重新 distill 复活该行（去标签、回 active、不产生重复行）；path 匹配剥离标签后进行。
约束：绝不做中文/关键词模糊匹配判定过期（会误伤"superseded 链保留"这类有效条目）；退休标签只能由显式信号源（人工或 kb-audit skill 的分诊+审批）写入。绝不静默删除 index 行或知识文件——排除仅作用于注入视图。
理由：把"检测"（确定性、可自动、可暴力测试）与"处置授权"（判断、留给 LLM 分诊+人审批）分离；catalog 只呈现当前有效知识，历史仍在文件与 retired 区可溯源。
代价：第二步（退休折叠）在存量 KB 上收益为 0，直到有信号源给行打标签；死链排除依赖 auditIndex 每轮解析的开销。
放弃：贴 index.md 原文注入、按关键词自动判定过期、自动删除死链行或过期条目。
