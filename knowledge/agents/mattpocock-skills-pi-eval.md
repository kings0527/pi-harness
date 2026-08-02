# mattpocock/skills 在 pi + DeepSeek flash 环境的评估结论

## 背景
- 仓库：41 个技能，17 个 engineering（9 user-invoked + 8 model-invoked），标准 agentskills.io 格式，宣称 "works with any model"。
- 本地 ~/.codex/skills 已有 16 个 v1.1.0 忠实副本（2026-07-14 安装，缺 resolving-merge-conflicts），与 ~/.agents/skills 现有 13 个（阿里运维+逆向）零重叠。

## 核心结论
1. 技能不是能力来源，是**纪律/检查点**来源——DeepSeek flash 预训练已内置 tdd/code-review/bug 诊断（mattpocock 的 leading words 设计前提）。
2. pi 默认不加载 ~/.codex/skills；激活只需在 ~/.pi/agent/settings.json 加 `"skills": ["~/.codex/skills"]`（官方跨 harness 机制）+ `"enableSkillCommands": true`。
3. 推荐启用轻量子集：tdd、diagnosing-bugs、code-review、research、domain-modeling、implement、resolving-merge-conflicts。
4. 跳过重流程集群：wayfinder（11.9KB，100K-token 会话假设）、triage、setup-matt-pocock-skills、to-tickets、improve-codebase-architecture、ask-matt（依赖 issue tracker/gh/glab + Claude Code 生态）。

## 优化清单（性价比排序）
1. settings.json 加 skills 数组 + enableSkillCommands
2. code-review 12 条 Fowler 坏味基线移出内嵌 → references/ 文件（省 token）
3. 重写 71 处跨技能 slash 引用（/tdd /grilling 等，grilling 在 productivity/ 跨分类）
4. issue tracker 只留零依赖本地 markdown（.scratch/）路径
5. 版本决策：本地锁 v1.1.0 vs 跟上 HEAD（2 周 pending：decision tickets / research 子代理）——先锁 v1.1.0 跑通
6. 保留 "stop-and-ask" 检查点模式（seam 确认、假设展示、一次一问）——小模型正资产
7. 控制系统提示技能清单长度（13 厚 + 16 薄会显著拉长）

## pi 兼容性
- frontmatter 标准格式完全兼容；disable-model-invocation: true pi 文档明确支持。
- code-review/research 的并行子代理 → pi 有 spawn 等价物，可移植。
- 唯一脚本 hitl-loop.template.sh 是模板复制型，无执行依赖。

---

来源: topic-mattpocock-skills-pi-eval#seq-4

---

## 落地状态（2026-08-02）

已整合进 pi-harness 包，实现开包即用（clone/install 即自动发现，无需 settings.json 配置）：

- **skills/mattpocock/**（10 个 pi 优化版）：tdd、diagnosing-bugs、code-review、research、domain-modeling、implement、prototype、resolving-merge-conflicts、to-spec、writing-great-skills
  - 优化点已应用：code-review 坏味基线移出至 references/fowler-smells.md；slash 引用改写为技能名；to-spec 去 tracker 依赖写本地 md；research 用 pi spawn；diagnosing-bugs 去 /improve-codebase-architecture 引用
- **skills/** 根目录（8 个逆向/安全 + find-skills）：anti-debugging-techniques、binary-protection-bypass、code-obfuscation-deobfuscation、dwarf-expert、symbolic-execution-tools、vm-and-bytecode-reverse、web-reverse-engineering、find-skills
- **许可证**：LICENSE.trailofbits-skills、LICENSE.yaklang-hack-skills（随包携带）
- **排除**：公司内部 5 个技能（skill-a ×2、flink ×2、skill-b）——含内部 registry（internal.example.com）与运行时 token（state/auth.json），不随包发布；Codex 原版 16 副本（~/.codex/skills）未动
- **来源**：pi 优化版源自 ~/.codex/skills v1.1.0 副本 + 上游补齐（resolving-merge-conflicts、writing-great-skills），临时全局副本 ~/.pi/agent/skills/mattpocock 已删除（repo 内为唯一权威）
