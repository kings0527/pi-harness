# ADR-11: knowledge 与 handoff 固定放置在项目根目录

## 背景
项目级知识曾被写到项目树的各种位置（子目录 knowledge/、随机路径），
handoff 文件也无固定位置，导致检索失效与"双知识根"坑。

## 决策
- 项目级 knowledge 唯一位置：`<项目根>/knowledge/`（runtime scope="project"，默认值）。
- 跨项目 knowledge 唯一位置：`~/.pi-harness/knowledge/`（scope="global"）。
- handoff 唯一位置：`<项目根>/handoff/`。
- 两者内部允许任意子目录分级；项目树内其他任何位置一律禁止。

## 理由
- 项目知识随仓库走（提交/同步/跨机），全局库只放跨项目可复用技术
- 固定唯一点 = grep 可及、无黑盒、无散乱目录（文件优先哲学）

## 放弃的替代方案
- 全局单根（项目知识不随仓库走，跨机丢失）
- 自由放置 + 索引发现（索引腐烂后即失联）
