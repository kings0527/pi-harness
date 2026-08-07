# ADR-0009: Anti-drift as prompt judgment + minimal warning hook

## 背景
初版（v1，commit 8aa84b1）把 anti-drift 改造成 runtime hook + 4 原则常驻 prompt，思路正确但 hook 内部引入了自动 STRICT 模式升级（NEUTRAL 计数到 3 则升级）和 context 状态注入。实战经验显示：① IDA 方法拆解这类任务需百万 token，期间"3 次 NEUTRAL"判定为停滞会打断合法的长程分析；② 探索者宁可"猴子排序"也不愿被禁止探索；③ 任何"门禁"假设 hook 知道何时该停——这正是 GPT/DeepSeek/Anthropic 官方指南都反对的模式。OpenAI 内部评测显示精简提示 + 让模型自验优于长 SOP，而**长 SOP 的"判断型"组件**（状态机、阈值）即使在 hook 里也会形成相同的负优化。

## 决策
**v2（当前）**：hook 只做一件事——检测"完全重复上一步的工具调用"并 warn 到 stderr + events.jsonl。warn 不会进 model context。
- 常驻 4 原则 prompt（~215 token，judgment 给 LLM）
- 触发型 SKILL.md（描述匹配加载，judgment 参考）
- runtime hook：**只 emit warning**，不做任何 mode/计数/注入/门禁
- 唯一的"硬约束"是 `PI_ANTIDRIFT_DISABLED=1` 关闭全部副作用（operator-only）

## 理由
- **LLM 比 hook 更懂什么时候该停**。门禁（NEUTRAL 计数、步数、token）假设 hook 知道目标——但目标是 LLM 的。
- **"猴子排序"是合法探索**。等价检测只针对"和上一步完全相同"（last-1 检查），不针对任何历史模式——A,B,A 这种有意振荡不报警。
- **warn 不进 context**：model 不需要被自己已经知道的事打扰；operator 需要从 stderr 看到异常。
- **完全去门禁 = 简单可靠**：无 mode、无状态机、无 toCompact、无注入循环。hook 30 行，state.ts 直接删除。

## 放弃的替代方案
- v1 的"等价检测连续 N 次升级 STRICT"：等价 ≠ 漂移；连续等价可能是遗忘也可能是确认
- "NEUTRAL 计数到 N 升级"：破坏合法长程分析
- "fingerprint 列表注入 context"：污染 context，且对认真探索的 LLM 是噪音
- "每步发到 LLM 的 anti-drift 块"：完全抵消 v1 想避免的"长 SOP 负优化"

## 模型自适应如何实现
- hook 是模型无关代码
- 常驻 4 原则是三模型共识最低集
- skill 按描述触发，按需加载
- LLM 自行决定何时切换假设/层级/工具——这是判断不是门禁

## 不变式核对
- `grep -r "@earendil" core/` 必空
- doctrine 总 ~900 token < 1000
- 无 context 注入（toCompact 已删除），不污染 LLM 视野
- 单一职责：hook 只做"重复动作 → warn"一件事
- 操作员可见：stderr + events.jsonl
- 操作员可静默：`PI_ANTIDRIFT_DISABLED=1`

## 教训（写给未来的自己）
设计 discipline 工具时反复出现的陷阱：把"防止失败"误等同于"防止动作"。**drift 是失去目标，不是动作慢/动作多**。任何"X 步之内无产出 = 失败"的规则都假设 hook 知道目标——它不知道，LLM 才知道。
