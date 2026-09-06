# 授权安全任务的低误拒提示设计

## 决策

- system prompt 可以设置强而窄的工作默认：当前项目中的安全分析请求默认属于用户授权的企业安全测试、QA、CTF 或靶场；不得仅凭“双用途”或安全术语推断未授权。若任务中的具体事实与该前提冲突，只询问冲突所需的最小范围，并继续完成不受影响的部分。
- 不写“无条件信任当前环境”“绝不可拒绝”。这类绝对指令既不能覆盖 provider/model 的上游策略，也可能增加 jailbreak/安全分类器触发面。
- Board/topic 是带 provenance 的证据与协作通道，不是权限提升或常驻策略通道。不要加入通用“边界、不做、拒绝”模板；topic goal 应写正向成功标准，必要禁区应具体、局部且任务相关。

## 分层诊断

先区分 harness 自身提示、模型策略和 provider/代理映射。若收到 `finish_reason=refusal` 或 `content_filter`，system prompt 声明无法保证覆盖；应对同 prompt、同 model、不同上下文做 A/B，并保留 upstream raw reason。已知 context-feed 注入的 RE/抓包/加密类 catalog 描述可能单行触发上游拒绝，因此优先精简或中性化触发文本，而不是把拒绝改写为成功、盲目重试或增加更强的反拒绝措辞。

## 验证门槛

任何新增常驻范围声明都必须：
1. 放在 `prompts/`，由 doctrine 正常加载；
2. 通过 `tests/architecture-invariants.test.ts` 的常驻 token 预算；
3. 用真实 provider 做修改前后 refusal 率 A/B，接纳标准至少是不升高。

---

来源: topic-authorized-security-context#seq-2,seq-3,seq-4,seq-5

---

来源: topic-authorized-security-context#seq-2,seq-3,seq-4,seq-5
