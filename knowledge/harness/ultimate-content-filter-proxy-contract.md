# Ultimate content_filter 分层诊断与代理契约

## 已验证根因

PI 选择 Qoder Ultimate 后出现 `Provider finish_reason: content_filter` 时，不能先假定是共享 session 或代理伪造。应在四层依次取证：PI 最终 payload、代理收到的逻辑 session/model、Qoder 原生 SSE、OpenAI 兼容映射。

本次 debug 抓到 Qoder 原始 `finish_reason=refusal`；代理只将非标准 `refusal` 映射为 OpenAI `content_filter`。最小 curl 同 prompt + 全新 affinity 连续成功，而逐个启用扩展后仅 context-feed 稳定复现。继续二分到 global knowledge catalog，若干 RE/抓包/加密类目录描述单行即可触发 Ultimate refusal。因此：

- 不得把 refusal/content_filter 改写为 stop；
- 不得无条件重试、换 session 或删除完整上下文，这些会隐藏真实策略结果或破坏证据完整性；
- 兼容层可以输出 `content_filter`，但日志必须保留 upstream raw reason，区分原生 `content_filter` 与映射自 `refusal`。

## 上下层转发契约

1. 客户端会话身份独立于模型路由；同一 PI session 的模型切换不应改变 upstream session。
2. 有 affinity 时优先级为 `X-Session-Id` > `X-Session-Affinity` > body `session_id` > `prompt_cache_key`；无 affinity 的独立首包必须生成独立 session，不能按 model 共享。
3. tool continuation 在 header 缺失时，应通过最近 tool_call ID 回关联逻辑 session；冲突、跨模型或过期映射 fail closed，生成新 session。
4. Qoder `business.id` / `request_set_id`：顶层用户轮为新 `start`；tool result continuation 为 `processing` 且复用；与 qodercli oracle 对齐。
5. `max_tokens`、`reasoning_effort`、`context_length` 是上层意图：代理仅校验/收紧到 catalog 上限，不应无条件改成下游最大值；省略 effort/context 时继续省略，让 Qoder catalog default 生效。
6. PI 内置 llama.cpp adapter 只用 `n_ctx` 且令 `maxTokens=contextWindow`，忽略 `/models.meta.n_predict`，也不会从该目录识别 reasoning。Qoder Ultimate 需在 `models.json` 用 `modelOverrides` 显式设 `maxTokens:32768`、`reasoning:true`、支持的 thinkingLevelMap 与 `supportsReasoningEffort:true`，provider 级开启 session affinity。

## 快速判别命令

- 直连全新 affinity 的最小首包；
- PI `--no-extensions` 与逐扩展 A/B；
- `before_provider_request` 只记录结构摘要（role/长度/字段），不要落 secret；
- 代理 debug 捕获 Qoder raw SSE finish reason；
- 用同 prompt、同 model、不同上下文做差分，不要继续盲转 session。

---

来源: topic-ultimate-first-request-content-filter#seq-2,seq-3,seq-4
