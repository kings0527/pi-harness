# ADR-1: 核心逻辑运行时无关

## 背景
pi-harness 需要在 pi 生态之上运行，但未来可能迁移到其他 runtime。

## 决策
core/ 不 import 任何 pi API，只依赖 Node 标准库操作文件系统。extensions/ 是唯一接触 pi 接口的薄适配层。

## 理由
- 将来换 Codex SDK / Claude Code / 其他 runtime 时，core + knowledge + agents 原样复用
- 延续旧 harness"通信与执行运行时边界分离"的经验

## 放弃的替代方案
直接在 core 中使用 pi API（耦合深，迁移成本高）
