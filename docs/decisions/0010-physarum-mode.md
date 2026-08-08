# 0010 — Physarum: 脉冲式集体智能

背景：storm 对抗模式适合审计/判断题；需要协作探索模式让多 agent 像黏菌一样发散-互联-收敛。
决策：多轮并行 pulse + Board 作为共享记忆；收敛由 agent 自行判断（判断题归 LLM），代码只编排轮次。
理由：与"判断题归LLM选择题归代码"一致；Board 天然是共享神经网络；不需要评分函数。
放弃：scoreSignals 评分（代码裁判违反原则）；单轮 diverge-converge（无互联效果）。
