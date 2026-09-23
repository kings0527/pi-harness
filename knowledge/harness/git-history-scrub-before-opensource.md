# Git 开源前历史清洗流程(pi-harness 实证)

- **审计分层**:① 全历史 blob 内容扫描(rev-list --objects | cat-file -p,836 blobs)找密钥/内网域名/个人路径/跨项目名;② commit 元数据(author/committer 邮箱);③ 未跟踪文件;④ 远端分支。
- **泄漏模式**(本次命中):anpm.alibaba registry URL、alibaba-inc.com 邮箱、/Users/kk 路径、兄弟项目名(mydroid/CL4R1T4S)、commit message 里的内网技能名。
- **清洗手段**:git-filter-repo 一轮完成 — `--replace-text`(blob,精确匹配)、`--message-callback`(commit message,可大小写不敏感正则,注意文件内容必须是函数体而非 def 行,否则静默无效)、`--name-callback`/`--email-callback`(身份统一)。filter-repo 运行后会移除 origin,需重加再 force-push。
- **验证闭环**:本地全历史扫描 + 干净目录 `git clone` 公开仓库后大小写不敏感扫描(消息+`git log -p` 全内容+密钥模式),三方全 0 才算通过。
- **边界**:GitHub 服务端不可达旧对象靠服务端 GC;彻底零残留需 delete+recreate(gh token 需 delete_repo scope);GitHub license 检测(LICENSE 文件)有约 30s 延迟。

---

来源: board topic pi-harness-opensource-scrub
