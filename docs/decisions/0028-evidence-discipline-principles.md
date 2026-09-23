# ADR-0028: Evidence discipline 四原则加入常驻 meta-principles
背景：评估从某兄弟项目提取的 fable-reasoning skill（Fable 5.1 系统 prompt 的操作规则抽取，注入块 ~3172 词/~4300 token）是否引入 pi-harness。结论：其大头（工具选择、文件管理、输出路由、规划）与现有 doctrine/anti-drift/代码强制冗余，整包引入会 4 倍突破 ADR 级 <1000 token 常量预算；真正稀缺的是 claude.ai memory 产品逼出的跨会话软状态防自欺纪律，pi-harness 尚未结构化。
决策：从该 skill 仅吸收四条，作为 `prompts/meta-principles.md` 的 "Evidence Discipline" 小节常驻注入：9) confirmation granularity（用户的"ok"只确认其参与粒度，助理提案不得记为用户决定）；10) provenance tiering（原始记录 > 摘要 > 记忆，蒸馏结论效力不超过来源）；11) retraction cascade（撤回一条事实须连带撤回仅由它推出的结论；supersede 是标记，retract 是删除）；12) named unknowns（未验证断言就地标注假设/推断/猜测，不接受笼统免责声明）。
约束：总量 ~70 词，注入后整 corpus 仍须通过 architecture-invariants 的 ≤900 token 预算测试；不引入 fable-reasoning 的常驻 toggle 扩展或其全文。
理由：四条直击真实污染通道——knowledge 沉淀自"上轮提议用户未反对"（9）、distill 摘要模糊 speaker/时间序（10）、KB 有 supersede 链但无撤回级联（11）、不确定性被免责声明稀释（12）；每条都是 doctrine 未覆盖且无法用代码强制、只能 prompt 引导的判断。
代价：原则 11 的 retract 语义目前无工具支持，依赖模型判断与 kb 维护纪律；四条原则的效果只能由用户实测确认，无自动度量。
放弃：整个引入 fable-reasoning skill（4300 token 超预算且 ~70% 冗余）；把这四条写进 knowledge 而非 prompt（非常驻则不生效于每轮判断）。
来源：兄弟项目 .pi/skills/fable-reasoning/SKILL.md §2/§4/§9；ANTHROPIC/Claude-Fable-5.1.md。
