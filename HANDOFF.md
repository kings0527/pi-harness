# HANDOFF：在 pi 引擎上搭建个人 Harness

> 交接对象：接手启动本项目的 agent。本文档由上一轮 better-harness 评审会话产出，
> 「已核实」条目均在 2026-07-31 于本机验证过；「待搭建」条目是目标清单，接手后按序推进。

## 1. 背景与目标

用户维护 [StructFlow](/Users/kk/me/money/structflow)（证据优先的 L0-L7 结构化投研 skill，
执行契约在其 `SKILL.md`）。近期对该项目做了一次 Harness 评审（报告：
`/Users/kk/me/money/structflow/.qoder/better-harness/2026-07-31/185817-structflow/`），
核心结论：

- 运行时契约（SKILL.md + references/）与测试面是最强资产；
- 已修复：仓库根 `AGENTS.md`（测试入口/核心边界/域红线指路）、配置化核心边界（排除 `scans/` 生成产物）；
- 未决：**skill 没有稳定的运行宿主触发面**（此前仅 `agents/openai.yaml` 为 OpenAI 宿主配了隐式路由）；
  变更验证无机械触发点（pre-commit 缺失）。

用户已选定 **pi 作为运行引擎**，本项目（pi-harness）的目标：在 pi 上搭建一套个人 Harness——
skill 挂载、上下文规则、验证回路、会话证据留存，让 StructFlow 及后续 skill 有一个可复评审的宿主。

## 2. pi 引擎现状（已核实，2026-07-31）

| 项 | 事实 |
|---|---|
| 版本/位置 | pi 0.83.0，`/Users/kk/.npm-global/bin/pi` |
| 全局配置 | `~/.pi/agent/settings.json`：defaultProvider=deepseek，defaultModel=deepseek-v4-flash，thinking=high |
| 凭据 | `~/.pi/agent/auth.json` 已配置（勿提交、勿读取内容） |
| Skills | 原生支持：`--skill <file|dir>` 显式加载 + 目录发现；`--no-skills` 可关 |
| 上下文文件 | 原生发现 `AGENTS.md` / `CLAUDE.md`（`--no-context-files` 可关） |
| 扩展 | TypeScript extensions：`pi install npm:…/git:…/./local/path`，`-l` 装到项目局部 `.pi/settings.json`；扩展可注册 flags 与工具 |
| Prompt 模板/主题 | `--prompt-template`、`--theme`，同样支持发现机制 |
| 自动化 | `--mode json|rpc`、`-p` 非交互、`--session-id`/`--fork`、`--export <file>` 导出会话 HTML |
| 会话存储 | `~/.pi/agent/sessions/`（按项目路径分目录） |
| 信任模型 | 项目局部文件需 `--approve`/`-a` 信任（或 `pi config`） |

## 3. 待搭建清单（按优先级）

### P0 — 项目骨架与 skill 挂载
1. 在本仓库初始化 `.pi/settings.json`（项目局部配置），确定 skills/extensions 的项目内目录约定。
2. 把 StructFlow 挂载为 pi skill：优先 `pi install /Users/kk/me/money/structflow -l`
   （本地路径安装，保持 SKILL.md 唯一正本，不复制内容）；不行则回退 `--skill` 显式加载。
3. 验证触发：真实发起一次小型 StructFlow 分析（如 validate-only 模式），确认 pi 能路由到
   skill、`references/` 渐进加载生效、`scripts/structflow.py` 可执行。
4. 写本仓库自己的 `AGENTS.md`：pi 原生发现它，收录本 harness 的约定与红线
   （参照 StructFlow 仓库根 AGENTS.md 的「只指路不复制」风格）。

### P1 — 模型与运行边界
5. 模型胜任性确认：StructFlow 声明由宿主模型完成全部推理（无独立 LLM key）。
   当前默认 deepseek-v4-flash——需要用一次真实扫描评估 L0-L7 推理质量，
   必要时用 `--models` 配置备选梯队（Ctrl+P 切换）。**这是用户决策点，先跑证据再问。**
6. 权限/信任边界：明确哪些项目局部文件走 `--approve`，`.env` 类敏感文件永不入库（沿用 StructFlow 红线）。

### P2 — 验证回路与证据留存
7. 机械验证触发点：为 StructFlow 仓库补 pre-commit（提交前 `python -m pytest -q`）——
   这是评审遗留的 Low 发现，可作为本 harness 的第一个「验证回路」范例。
8. 会话证据：约定用 `--session-id` 命名重要运行、`--export` 归档关键会话 HTML 到本仓库
   （或专门目录），为后续 harness 复评审提供证据源。
9. （可选，后置）自动化通道：探索 `--mode rpc` / `-p` 做定时扫描或 CI 式回归，先手动跑通再谈调度。

## 4. 接手后的第一批命令（建议顺序）

```bash
cd /Users/kk/git/pi-harness
git init   # 若尚未初始化
pi --version                                   # 确认引擎可用
pi install /Users/kk/me/money/structflow -l    # P0-2：项目局部挂载 skill
pi -a                                          # 交互式启动并信任项目局部文件，验证 skill 可被发现
```

## 5. 红线（从 StructFlow 契约继承，对本 harness 同样生效）

- 不得弱化任何 research gate；hard-gate 失败禁止发布报告。
- 不得给出买卖建议（prescriptive buy/sell advice）。
- 不提交 `.env` / `auth.json` 等凭据文件。
- SKILL.md 是 StructFlow 唯一执行契约正本：挂载只做引用，不复制形成第二正本。

## 6. 未决问题（需用户拍板，不要自行决定）

- 模型选择：deepseek-v4-flash 是否胜任 StructFlow 推理（P1-5 跑完证据后给用户看结论）。
- skill 安装方式：本地路径安装 vs git 源安装（当前 StructFlow 远程为 github.com/kings0527/structflow）。
- 是否为本仓库建远程并推送（用户对个人项目有长期 commit+push 授权，但新仓库建远程属新决策）。
