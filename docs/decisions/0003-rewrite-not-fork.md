# ADR-3: 重写而非 fork pi-collaborating-agents

## 背景
pi-collaborating-agents 已验证 pi 上多 agent 消息传递可行。

## 决策
精简重写，不 fork。提取文件系统存储 + 单写者原则的核心思想。

## 理由
- 其 agent_message 工具 11 个 action 过于庞大，我们只需 5 个（open/post/read/list/close）
- 其消息路由（inbox/urgent/steer）对黑板模型是冗余复杂度
- 自主可控，无需跟进上游变更
- 我们的黑板 + knowledge 双层模型是正交设计

## 放弃的替代方案
fork 后裁剪（维护负担高，架构不匹配）
