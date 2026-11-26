---
name: flux
description: "Live Flux collective intelligence (Live Field). Default-on concurrent tentacles sharing step-level sideline deltas (objective echoes, focus-area presence, cooperative resource leases, shared artifacts) without rigid barriers or scoring."
---

# Flux（涌流）— 活体侧线集体智能

## 何时触发

- 身处未知迷宫，无法预先划分边界，需要多视角并发试错、借真实环境反馈快速显形轮廓与缝隙
- 需要并行多锤洗礼（不同认知姿态或不同渠道模型），同时避免自评置信度、互评打分与固定轮次浪费
- 需要在共享目录探测（`shared`）或隔离 `git worktree` 平行改造（`worktree`）的同时实时共享踩坑情报

## 零门槛启动（默认开启，无需先敲 `/flux on`）

### 方式 1：自然语言直接拉起（推荐）
- 直接调用 `spawn action=flux`（默认继承当前会话的 `provider/id` 模型，或复用全局/项目模型池；若 `topic` 不存在则自动创建）：
  `spawn action=flux topic="my-hunt" question="..." lenses=["spine","seam","probe"] mode="shared"`
- 需要长期自治推进时，模型可直接调用 `goal action=set objective="..."` 激活会话持久化目标
- 单点收束：主脑读取返回的集体客观回声摘要，验证并 `convergence` → `close` → `distill`

### 方式 2：交互式 TUI 选模型池（空格多选、自动保存）
- 在 TUI 中输入 `/flux`（或 `/flux models`）打开交互面板：
  - `↑/↓` 或 `j/k` 移动，`/` 过滤，`Space` 勾选/取消任意多渠道 `provider/id` 模型并**立即自动保存**
  - `t` 切换触角数，`m` 切换 `shared/worktree`，`c` 清空池（回退自动继承当前模型），`s` 切换全局/项目作用域，`Enter/Esc/q` 退出
- 命令行等效：`/flux status` | `/flux on <provider/id>[,...]` | `/flux off` | `/flux tentacles <N|auto>` | `/flux mode shared|worktree`

### 方式 3：多终端平权接入同一个 Live Field
1. 主窗口开场：`/field open my-hunt "目标描述"`
2. 其他终端加入：`/field join my-hunt seam` / `/field join my-hunt probe`
3. 各终端每次工具返回自动收到 `[FIELD Δ]` 单步侧线差分；也可通过 `field action=pulse|claim|release|peek|artifact` 交互

## 5 种起手认知姿态（破除初始对称性，随真反馈自然衰减）

- `spine`：主干追踪（顺入口/主调用链/主报错纵深切入）
- `seam`：缝隙游走（专查边界、配置、交接与异常分支）
- `probe`：实证戳刺（构造最小输入/脚本/探针尽早向环境要反馈）
- `invert`：反证破坏（专盯看似合理的假设找反例，防假阴性）
- `scout`：外围测绘（退一步看依赖、环境约束与历史知识）

## 核心原则

- **无固定轮次屏障、无武断墙钟截杀**：触角在活体工具循环内实时互通，看门狗按真实活动（输出/心跳）保活
- **无打分、无互评、无绝对“安全/死路”判决**：`field action=pulse` 只写客观回声（方法 → 观察现象 → 下一步朝向）
- **独占资源协同与共享产物**：触碰不可并发的外部目标前先 `field action=claim` / `release`，可复用产物放共享 `artifacts/` 目录并用 `kind="artifact"` 广播
- **破墙即共振**：真实环境验证突破立刻发 `kind="breach"`，其他触角下一步即收到 `BREACH WAVE`，结合完整目标评估是否正交复核、补齐缺口或收尾
