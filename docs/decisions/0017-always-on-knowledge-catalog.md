# ADR-0017: 常驻 knowledge catalog，正文按需加载
背景：LLM 必须始终知道知识位置，但 session_start 递归扫描 cwd 会在 home 等大目录阻塞启动。
决策：每轮 reference 常驻 project/workspace/global index 路径与完整索引行，作为导航 catalog。
决策：project/workspace 根 KNOWLEDGE.md 的 Areas 常驻；目录级正文仅在文件访问激活后进入下一轮快照。
决策：session_start 不递归清点 cwd；discoverScopes 仅供显式修复，并以 maxDirs=1000 全局终止。
决策：相同根只读取一次，catalog 路径即使 index 尚不存在也保持可见。
约束：scope 激活和读取经规范化及 symlink 检查后仍须位于选定根内。
理由：把“知道去哪里找”与“读取多少正文”分离，同时保持文件优先和可审计快照。
代价：手工创建但未登记的目录级 KNOWLEDGE.md 要通过 Areas 或显式 discovery 补入 catalog。
放弃：每个 session 全树预热，以及首次请求注入全部知识正文。
