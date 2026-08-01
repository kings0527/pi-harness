# spawn 工具使用说明

leader agent 用 `spawn` 工具启动分工 subagent，各 subagent 独立调查并把发现 post 上黑板。

## 前置

- 角色卡在 `agents/<name>.json`（字段：`name`、`specialty[]`、`confidence_bias?`、`out_of_scope[]`），内置 scout / worker / reviewer 三张。
- topic 必须先用 board 工具 open。

## Actions

| action | 参数 | 语义 |
|---|---|---|
| `list` | — | 列出可用角色卡（name + specialty + out_of_scope） |
| `run` | `topic`（必须 open）、`agents: [{profile, task}]`、`timeoutMs?`（默认 10 分钟） | 并行启动 subagent，返回每个的 exitCode + 输出尾部 |

## 典型流程

1. `board open <topic> --goal "..."`
2. `spawn run`：给每个 profile 分派一个具体调查任务
3. subagent 各自 `pi --print` 独立运行（cwd = 项目目录，共享同一 `.pi-board/`），MUST 先 `board read` 再调查，发现 MUST `board post`（author = 自己的 name）
4. `board read <topic>` 查看它们上板的发现；`.pi-board/events.jsonl` 有 spawn_start / spawn_end 记录

## 环境

子进程用 `PI_BIN` 环境变量指定 pi 二进制（默认 PATH 中的 `pi`）。
