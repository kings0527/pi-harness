# ADR-0009: Anti-drift 从常驻 SOP 改为 runtime hook + 极简 prompt

## 背景
`skills/anti-drift-discipline/SKILL.md` 当前是 233 词长 SOP，模型每轮按"四行假设/五字段锚点/六条纪律"机械输出。引用 2026-08-07 knowledge `findbug-metaskill-anti-premature-convergence`：半天内 6 条自信根因 3 条被证伪，证实当前 SOP 不仅冗余还助长"说服文"伪收敛。OpenAI/DeepSeek/Anthropic 官方一致结论：精简提示+让模型自验，长 SOP 对前沿模型反成负优化。

## 决策
- 新增 `prompts/anti-drift.md`（~120 token，4 条原则）由 `doctrine.ts` 常驻注入
- 重写 `SKILL.md` 为触发型（描述触发 + 完整原则参考，**不进** systemPrompt）
- 新增 `core/anti-drift/{state,fingerprint,evidence,detector,types,events}.ts`
- 新增 `extensions/anti-drift.ts`：onBeforeTurn/onToolCall/onToolResult/onAfterTurn/onContext

## 理由
- prompt 是模型共享税，hook 是跨模型确定性执行。判断放 LLM，约束放代码。
- 4 条原则对 DeepSeek V4 Flash / GPT-5.6 Sol / Opus 5 均不冗余（删掉了"70% 交付""每步四行""重复验证"等模型特异指令）
- fingerprint 归一化不靠内容哈希（脆弱），靠 `{tool, targetPath, queryIntent, keyParams}`（语义等价）
- evidence_delta 不信模型自评，靠返回内容启发式分类 + onAfterTurn 假设状态对账

## 放弃的替代方案
- 把整个 SOP 压成 200 token 写进 prompt（仍每轮付税，且仍依赖模型自觉）
- 只改 skill 不加 hook（hook 才能在不付 token 税前提下做等价检测/熔断）
- 为每个模型写独立 prompt 分支（违反"薄扩展"原则，且模型路由会随 pi 升级变化）

## 模型自适应如何实现
- hook 是模型无关代码（fingerprint/evidence/detector 跨模型一致）
- 常驻 4 原则是三模型共识最低集（"动作为决策服务/不重复/不混层/停滞切维度"）
- skill 描述触发机制由 pi 已有 description matching 承担，不在 prompt 里

## 不变式核对
- `grep -r "@earendil" core/` 必空（runtime-agnostic）
- doctrine 总 token < 1000（meta-principles 124 + collaboration-doctrine 401 + anti-drift ~120 ≈ 645）
- context-feed 注入 ≤ 3000 bytes/turn（anti-drift 状态走独立通道，≤ 300 bytes）
