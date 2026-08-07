# ADR-0008: 修复 skill 死链与幽灵引用（内联替代策略）

## 背景
binary-protection-bypass 引用 4 个不存在的 exploitation skill（stack-overflow-and-rop, format-string-exploitation, heap-exploitation, arbitrary-write-to-rce）；web-reverse-engineering 引用 14 个不存在的 references/ 文件。Agent 尝试加载不存在的文件时进入错误循环。

## 决策
用现有 skill 路由 + 内联说明替代死链；移除幽灵文件引用，改为自引用到已有章节。不创建 stub skill 文件。

## 理由
- 创建 4 个新 exploitation skill 工作量巨大且超出当前维护能力，且与用户实际逆向工作（算法还原/签名复现）关联度低
- 被引用的内容 80%+ 已覆盖在现有 SKILL.md 正文中
- 删除无效引用的 ROI 最高：零新文件、零新维护负担、立即消除 agent 错误循环

## 放弃的替代方案
- 创建 stub skill 文件（增加维护面、内容必然与现有 skill 重复）
- 保留引用但添加 TODO 标记（agent 仍会尝试加载并失败）
