# ADR-0007: Storm 辩论模式用回合制而非并行

## 背景
多模型辩论需要参与者互相回应对方论点。

## 决策
advocate 和 critic 串行 spawn（先 advocate 上板，再 critic 读板后反驳），不并行。

## 理由
- 并行时双方首轮无法看到对方观点，辩驳纪律不可满足
- 串行保证 critic 总能读到 advocate 的立场
- 代价：延迟增加一轮 spawn 时间（可接受，debate 本身不追求速度）

## 放弃的替代方案
并行 spawn + 额外协调轮（复杂度高，pi 无内置消息等待机制）
