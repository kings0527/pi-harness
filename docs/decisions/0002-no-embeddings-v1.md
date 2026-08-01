# ADR-2: v1 不引入 embeddings 或向量库

## 背景
知识层需要检索能力，embeddings/向量库是业界常见方案。

## 决策
v1 只用 markdown 文件 + git 版本化 + distill skill + index.md。绝不引入 embeddings/向量库/自动记忆。

## 理由
- 对个人规模知识库，grep + 目录索引足够
- 向量化引入服务依赖与黑盒，违反"文件优先、完整可观测"哲学
- 防 scope creep

## 放弃的替代方案
引入 Letta 式自动记忆系统（违反可观测性原则）
