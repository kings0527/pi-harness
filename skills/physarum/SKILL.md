---
description: "Slime-mold collective intelligence. Multi-pulse parallel exploration where agents interconnect through the Board to form one brain. Use when a problem needs breadth-first probing with natural convergence through shared memory."
---

# Physarum — 黏菌集体智能

## 何时触发

- 问题空间需要多角度探索
- 单一视角不够，需要集体智慧互联
- 需要发散后自然收敛（而非人工裁判）

## 与 Storm 的区别

| | Storm | Physarum |
|---|---|---|
| 模式 | 对抗辩论 | 协同探索 |
| 角色关系 | advocate vs critic | 同一大脑的多个神经元 |
| 收敛方式 | 裁判综合 | 群体自然聚焦 |
| 适用场景 | 判断题审计 | 探索性问题解决 |

## 如何使用

1. 启用：`/physarum on <model1>,<model2>`
2. 打开 topic：`board action=open topic="my-problem" goal="..."`
3. 启动探索：`spawn action=physarum topic="my-problem" question="..." angles=["angle1", "angle2", ...]`
4. 查看结果：`board action=read topic="my-problem"`
5. 收尾：`board action=close` → `distill`

## 运行机制

- **Pulse 1（发散）**：N 个触角并行探索不同角度
- **Pulse 2..N-1（构建）**：每个触角读取 Board 上他人发现，互相构建、深化、交叉
- **最后一轮（综合）**：所有触角综合集体发现为统一答案
- 工作过程封闭在子 topic 内，结束后主 topic 仅新增 1 条综合结论（零副作用）

## 不要在以下情况使用

- 需要对抗性审计（用 /storm）
- 简单直接的实现任务（直接 spawn action=run）
- 只有一个明确方向不需要探索
