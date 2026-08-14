# ADR-0019: Output-aware context headroom guard
背景：Pi 默认只预留 16384 tokens，但 provider 可请求 48000-token completion，且新 prompt/reference 在预检后加入。
决策：新增 runtime hook，按当前窗口、已观测/模型输出额度与 ingress margin 计算独立 headroom。
决策：session start/agent settled 越线时等待压缩结算；idle input 在原管线内等待自己的压缩。
决策：non-idle 输入保留 Pi 时机；额外并发 idle input 显式 handled 并持久化原文，不竞争 agent run。
决策：若仍到达 provider 边界，仅按窗口比例 safety 收紧已存在的 output 字段，不改消息和工具。
决策：Anthropic/Bedrock thinking budget 与 output 联动；无 output 字段的 adapter 保持请求并显式告警。
决策：每次提前压缩与 output clamp 写 stderr + `events.jsonl`，失败时保留原输入路径。
理由：提前压缩解决正常路径，provider clamp 只覆盖估算偏差和单轮突增的窄窗口。
放弃：仅修用户全局 settings（包不能自带默认值）以及对上下文做静默裁剪。
