---
name: web-reverse-engineering
description: AI驱动的系统化Web逆向工程方法论与实战指南
version: 1.0.0
author: kings0527
tags: [web-security, reverse-engineering, anti-crawler, jsvmp, cdp-bypass]
applicable_scenarios:
  - Web爬虫逆向与反爬对抗
  - JS加密算法分析与还原
  - 浏览器环境模拟与修补
  - CDP/TLS/HTTP2协议层绕过
  - JSVMP/WASM保护破解
---

# Web Reverse Engineering Skill

> AI驱动的系统化Web逆向工程方法论与实战指南
> 基于2026年反检测技术格局 + 开源项目实战

## 适用范围

> **定位：纯Web逆向，不含移动端App/原生层。** 本Skill聚焦浏览器环境下的JS逆向、反爬对抗、协议指纹绕过等Web安全领域。

当用户提出以下类型请求时，激活本Skill：
- **JS逆向分析**：目标网站使用JS混淆、JSVMP、控制流平坦化等保护，需要还原算法逻辑
- **反爬对抗**：遭遇Cloudflare、DataDome、瑞数、极验等反爬系统，需要绕过检测
- **签名算法还原**：需要复现请求签名（如X-Sign、__zse_ck、X-Gnarly等）
- **浏览器自动化反检测**：自动化脚本被识别为Bot，需要绕过CDP检测/指纹检测
- **TLS/协议指纹绕过**：遭遇JA3/JA4/HTTP2/QUIC指纹检测，需要模拟真实浏览器协议握手
- **验证码绕过**：滑块、点选、reCAPTCHA、Turnstile等验证码的自动化方案
- **环境修补**：在Node.js中运行浏览器端JS代码，需要伪造BOM/DOM环境

**不适用场景**：
- 纯后端API逆向（无JS保护）→ 直接使用抓包+请求伪造
- 移动端App/原生层逆向 → 不在本Skill范围内
- 二进制逆向（PE/ELF/Mach-O）→ 使用Ghidra/IDA

## 核心原则

1. **Observe-First（观察优先）**：先用CDP/抓包/DevTools收集完整行为数据，再开始分析。不猜测，用证据驱动。
2. **Evidence-Based（证据驱动）**：所有结论必须基于trace日志、网络包、字节码等可验证证据，拒绝推测。
3. **Minimum-Patch（最小修补）**：环境修补只补目标代码实际访问的API，不做多余伪造，减少被检测面。
4. **Layer-by-Layer（分层击破）**：组合保护按层级逐击破，先破外层（TLS/请求层），再破内层（JS/VM层）。
5. **Reproduce-Then-Optimize（先复现再优化）**：先完整复现目标算法（哪怕效率低），再优化性能和成功率。
6. **Tool-Appropriate（工具适配）**：根据反爬等级选择匹配工具，避免过度工程（简单混淆不必上JSVMP分析）。
7. **Iterative-Deepening（迭代深化）**：从最简方案开始，遇阻时逐级升级对抗手段。

---

# 第一部分：系统层方法论

## 1. 反爬技术全景图

### 1.1 攻击面四层模型

| 层级 | 检测技术 | 对抗策略 | 工具链 |
|------|---------|---------|--------|
| 请求层 | IP信誉评分、请求频率异常、Header一致性校验 | 代理池轮换、请求间隔随机化、Header模板化 | curl_cffi, httpx, requests |
| 协议层 | TLS指纹(JA3/JA4)、HTTP/2 SETTINGS帧指纹、QUIC传输参数 | TLS模拟、HTTP/2参数伪造 | curl_cffi, tls-client, h2 |
| 浏览器层 | JS环境检测、Canvas/WebGL/Audio指纹、CDP协议泄露 | 反检测浏览器、环境修补、CDP隐藏 | nodriver, patchright, camoufox |
| 引擎层 | JSVMP字节码VM、WASM保护、自定义IR混淆 | VM执行追踪、操作码还原、WASM反编译 | Chrome DevTools, Ghidra, Proxy Hook |

### 1.2 主流反爬技术分类

| 类别 | 技术 | 检测原理 | 难度 |
|------|------|---------|------|
| JS混淆-L1 | 变量名混淆 | 标识符替换为_0x1a2b3c | ★☆☆☆☆ |
| JS混淆-L2 | 字符串加密 | 字符串数组+解密函数+解码器旋转 | ★★☆☆☆ |
| JS混淆-L3 | 控制流平坦化 | switch-case状态机+"数字串".split("|") | ★★★☆☆ |
| JS混淆-L4 | 死代码注入+自我防御 | 虚假分支+debugger陷阱+反格式化 | ★★★★☆ |
| JS混淆-L5 | JSVMP字节码VM | 自定义VM执行编译后的字节码 | ★★★★★ |
| 浏览器指纹 | Canvas指纹 | 2D渲染像素级差异+toDataURL哈希 | ★★★☆☆ |
| 浏览器指纹 | WebGL指纹 | 渲染器/厂商信息+扩展列表+着色器精度 | ★★★☆☆ |
| 浏览器指纹 | AudioContext指纹 | OfflineAudioContext浮点运算差异 | ★★★☆☆ |
| 浏览器指纹 | 字体枚举 | 通过宽高差异探测已安装字体 | ★★☆☆☆ |
| 浏览器指纹 | 屏幕/窗口属性 | screen尺寸、colorDepth、devicePixelRatio一致性 | ★★☆☆☆ |
| 浏览器指纹 | Navigator属性 | plugins数组、languages、hardwareConcurrency | ★★☆☆☆ |
| 浏览器指纹 | Permissions API | Notification.permission等权限状态 | ★★☆☆☆ |
| CDP检测 | Runtime.enable泄露 | 页面JS检测CDP Runtime域是否启用 | ★★★★☆ |
| CDP检测 | sourceURL注入 | evaluate注入的__pptr:__/_playwright_标记 | ★★★☆☆ |
| CDP检测 | navigator.webdriver | Chrome自动化标志位 | ★★☆☆☆ |
| CDP检测 | Target.setAutoAttach | 检测CDP Target域调用痕迹 | ★★★★☆ |
| CDP检测 | Chrome DevTools窗口 | window.outerWidth/Height差异检测 | ★★☆☆☆ |
| TLS指纹 | JA3指纹 | TLS版本+密码套件+扩展+曲线→MD5 | ★★★☆☆ |
| TLS指纹 | JA4指纹 | 规范化标识+TCP/HTTP2维度→36字符 | ★★★★☆ |
| 协议指纹 | HTTP/2 SETTINGS帧 | SETTINGS参数顺序、初始窗口大小、帧优先级配置 | ★★★☆☆ |
| 协议指纹 | QUIC传输参数 | 初始RTT、流控窗口、连接迁移参数 | ★★★★☆ |
| 行为分析 | 鼠标轨迹分析 | 速度曲线、加速度、微抖动模式 | ★★★☆☆ |
| 行为分析 | 键盘节奏分析 | 按键间隔分布、打字节奏模式 | ★★★☆☆ |
| 行为分析 | 请求时序分析 | 请求间隔分布、页面停留时间 | ★★☆☆☆ |
| 行为分析 | 页面交互序列 | 滚动/点击/焦点切换的行为模式 | ★★☆☆☆ |
| 验证码 | 滑块验证码 | 缺口识别+拟人轨迹验证 | ★★★☆☆ |
| 验证码 | 点选验证码 | 文字/图标识别+坐标点击 | ★★★★☆ |
| 验证码 | reCAPTCHA v2 | 图像分类+行为评分 | ★★★★☆ |
| 验证码 | reCAPTCHA v3 | 纯行为评分（无交互） | ★★★★☆ |
| 验证码 | Cloudflare Turnstile | 浏览器环境+行为综合评分 | ★★★★☆ |
| 验证码 | 极验GEETEST | 滑块/点选/图标多模态 | ★★★☆☆ |
| WAF | Cloudflare | JS Challenge+TLS指纹+行为分析组合 | ★★★★★ |
| WAF | DataDome | CDP检测+设备指纹+实时行为 | ★★★★☆ |
| WAF | 瑞数(RuiShu) | 动态JS混淆+cookie验证+JSVMP | ★★★★★ |
| WAF | 顶象(DingXiang) | JSVMP+环境检测+设备指纹 | ★★★★★ |
| WAF | 数美(ShuMei) | JS混淆+设备指纹+行为分析 | ★★★★☆ |

### 1.3 对抗策略决策矩阵

| 目标反爬类型 | 首选策略 | 备选策略 | 避免方案 |
|-------------|---------|---------|---------|
| 仅IP封禁 | 代理池+请求限速 | - | 单IP高频 |
| Header校验 | curl直接伪造Header | - | requests默认Header |
| TLS指纹检测 | curl_cffi模拟Chrome | tls-client | Python requests |
| 简单JS混淆(可读懂) | AST反混淆+环境修补 | webcrack自动处理 | 手动逐行阅读 |
| 重度JS混淆 | webcrack/js-deobfuscator+动态调试 | Chrome DevTools条件断点 | 纯静态分析 |
| JSVMP保护 | Proxy Hook+执行追踪+操作码还原 | Chrome DevTools LogPoint | 试图静态反编译VM |
| CDP检测 | nodriver直接CDP驱动 | rebrowser-patches | 原版Playwright/Puppeteer |
| 行为分析 | 拟人轨迹+随机化 | 真实浏览器+人工辅助 | 机械化操作 |
| 验证码 | 专业打码平台+AI分类 | 手动解决+逆向验证逻辑 | 暴力尝试 |

## 2. 系统化分析流程

### 2.0 10分钟快速反爬类型判定

在启动完整分析流程前，先用以下快速方法确定目标网站的保护类型：

**Step 1（2min）**：curl直接请求，观察响应
- 正常返回 → 无JS层保护，直接请求伪造
- 403/空响应 → 可能有TLS/IP层检测
- 返回HTML但无数据 → 需要执行JS

**Step 2（3min）**：浏览器正常访问+DevTools Network面板
- 观察是否有challenge页面（Cloudflare/瑞数特征）
- 检查cookie名称模式（__cf_bm, __cf_clearance, $_ts等）
- 观察JS文件特征（混淆程度、JSVMP特征）

**Step 3（3min）**：检查关键请求参数
- 是否有签名参数（sign, token, X-Bogus等）
- 签名参数是否每次变化
- 请求Header中是否有自定义加密字段

**Step 4（2min）**：初步判定与路径选择

| 观察结果 | 判定 | 推荐路径 |
|---------|------|----------|
| curl可直接获取数据 | L1无保护 | curl_cffi |
| 需cookie但算法简单 | L2轻度保护 | 环境修补 |
| challenge页面+复杂cookie | L3中度保护 | nodriver/patchright |
| JSVMP+多重签名 | L4重度保护 | VM执行追踪+操作码分析 |
| 全栈保护+行为分析 | L5极端保护 | 分层击破 |

### 2.1 六步法

```
侦察 → 识别 → 定位 → 分析 → 还原 → 验证
```

**Step 1：侦察（Reconnaissance）**
- **输入**：目标URL、目标API端点
- **动作**：浏览器DevTools Network面板抓包、检查请求Header/Cookie/参数、记录响应状态码和内容
- **工具**：Chrome DevTools、curl、mitmproxy
- **输出**：请求参数清单、反爬现象描述（如403/JS Challenge/验证码页面）
- **检查点**：是否记录了完整的请求序列（含重定向链）

**Step 2：识别（Identification）**
- **输入**：侦察阶段收集的数据
- **动作**：判断反爬类型（参考1.2分类表）、识别保护厂商、评估保护等级
- **工具**：Wappalyzer、浏览器扩展、手动分析JS源码特征
- **输出**：反爬类型判定、保护等级评估
- **检查点**：是否正确识别了所有保护层级（可能组合多种）

**Step 3：定位（Localization）**
- **输入**：反爬类型判定结果
- **动作**：定位关键JS文件/函数、定位签名参数生成点、定位检测代码
- **工具**：Chrome DevTools Sources面板、断点调试、全局搜索
- **输出**：关键JS文件URL、关键函数位置、参数生成调用链
- **检查点**：能否在源码中搜索到目标参数名（如"_signature"、"X-Bogus"）

**Step 4：分析（Analysis）**
- **输入**：定位到的关键代码
- **动作**：AST反混淆、动态调试trace、VM操作码分析、算法逻辑提取
- **工具**：webcrack、Chrome DevTools LogPoint、Babel AST、Proxy Hook
- **输出**：算法逻辑描述（伪代码或可读代码）
- **检查点**：是否理解了完整的算法流程，包括输入/输出/中间状态

**Step 5：还原（Reproduction）**
- **输入**：算法逻辑描述
- **动作**：用Python/JS/Node.js复现算法、伪造必要的浏览器环境
- **工具**：Node.js、Python、Babel AST
- **输出**：可独立运行的签名/加密代码
- **检查点**：独立代码的输出是否与浏览器端一致

**Step 6：验证（Verification）**
- **输入**：还原代码
- **动作**：批量测试签名正确性、集成到爬虫框架、监控成功率
- **工具**：pytest、curl、爬虫框架
- **输出**：经过验证的、可投入生产的代码
- **检查点**：100次连续请求的成功率是否≥95%

### 2.2 分析路径决策树

```
目标网站
├── 无JS加密 → 直接请求伪造（curl_cffi + 代理池）
│   └── 检查：curl_cffi模拟浏览器TLS指纹 + 代理IP轮换
├── 简单JS加密（可读懂）→ AST反混淆 + 环境修补
│   └── 工具：webcrack自动处理 + Node.js补环境运行
├── 重度JS混淆（控制流平坦化）→ webcrack/js-deobfuscator + 动态调试
│   └── 流程：webcrack反混淆 → 阅读还原代码 → 提取算法 → 复现
├── JSVMP保护 → Proxy Hook执行追踪 + 操作码还原
│   └── 流程：提取字节码 → 识别操作码 → 反汇编 → 理解算法 → 复现
├── WASM保护 → WASM反编译 + Ghidra/wabt
│   └── 工具：wasm2wat反汇编 → Ghidra反编译 → C伪代码分析
└── 组合保护 → 分层逐击破
    └── 顺序：TLS指纹 → CDP检测 → JS混淆 → 核心算法
```

## 3. 工具链架构

### 3.1 四层工具栈

**基础层（网络与抓包）**：
- `curl_cffi` — Python HTTP库，模拟浏览器TLS指纹（JA3/JA4）
- `httpx` — 现代Python异步HTTP客户端
- `mitmproxy` — 中间人代理，抓包/改包/断点
- `curl-impersonate` — curl的浏览器指纹模拟分支

**引擎层（JS逆向与反检测）**：
- `webcrack` — JS自动反混淆（控制流平坦化+字符串解密+死代码）
- `js-deobfuscator` — 通用JS反混淆框架
- `synchrony` — obfuscator.io专用反混淆器
- `nodriver` (v0.50.3) — Python直接CDP WebSocket驱动，31/31反检测基准全通过
- `patchright` — Playwright fork，32个driver_patches模块全面修补
- `rebrowser-patches` — Puppeteer/Playwright的Runtime.enable泄露修补

**AI层（智能辅助）**：
- `anything-analyzer` — Electron桌面应用，MCP Client/Server架构的逆向分析平台
- `js-reverse-mcp` — Google出品的JS逆向MCP Server，提供AST分析工具集
- `reverse-skill` — AI逆向Skill集合，Observe→Capture→Rebuild→Patch→DeepDive模型

**自动化层（爬虫框架）**：
- `Crawl4AI` (66k stars) — AI驱动的通用爬虫框架
- `Firecrawl` (125k stars) — 智能网页内容提取
- `deepspider` — AI辅助的爬虫蜘蛛

### 3.2 工具选择决策表

| 场景 | 推荐工具 | 安装命令 | 替代方案 | 不适用 |
|------|---------|---------|---------|--------|
| TLS指纹绕过 | curl_cffi | `pip install curl_cffi` | tls-client, curl-impersonate | Python requests |
| JS控制流反平坦化 | webcrack | `npx webcrack` | js-deobfuscator | 手动AST |
| obfuscator.io还原 | synchrony | `npx synchrony` | webcrack | 手工分析 |
| CDP反检测(Python) | nodriver | `pip install nodriver` | camoufox | Selenium原版 |
| CDP反检测(Node.js) | patchright | `npm i patchright` | rebrowser-patches | Playwright原版 |
| CDP反检测(Puppeteer) | rebrowser-patches | `npx rebrowser-patches patch` | patchright | puppeteer-extra-stealth |
| JSVMP分析 | Proxy Hook + Chrome DevTools LogPoint | 执行追踪脚本 | Chrome Extension注入 | 纯静态分析 |
| 环境修补 | 自定义Proxy监测+逐步补全 | 手写 | jsdom（部分可用） | 完整Chromium |
| 签名复现验证 | Node.js子进程 | 内置 | Python execjs | 浏览器内运行 |

### 3.3 WebTrace MCP 工具集

WebTrace 是一个 Chrome/Edge Extension，通过 MCP 协议暴露 Web 逆向分析能力。
AI Agent 可直接调用以下工具执行分析任务，无需手动操作 DevTools。

**安装**：`git clone https://github.com/kings0527/web-trace && cd web-trace && npm install && npm run build`
**加载**：Chrome → chrome://extensions → 开发者模式 → Load unpacked → 选择 dist/
**连接**：通过 WebSocket (`ws://127.0.0.1:3100/mcp`) 或 Chrome Runtime Port 与 Agent 通信

#### 可用工具

| Tool | 功能 | 典型场景 |
|------|------|----------|
| `detect_protection` | 检测页面保护类型和等级 | 初期侦查，判定反爬类型 |
| `analyze_jsvmp` | 分析JSVMP代码结构，识别派发循环 | VM逆向，定位操作码分支 |
| `trace_execution` | 在QuickJS沙箱中执行并收集trace | 离线分析，验证算法逻辑 |
| `extract_bytecode` | 从页面中提取字节码数组 | JSVMP数据提取 |
| `extract_wasm` | 提取页面中的WASM模块 | WASM逆向，获取二进制 |
| `analyze_wasm` | WASM反汇编+加密算法识别 | WASM逆向，定位密码函数 |
| `dump_wasm_memory` | 读取WASM实例线性内存 | 密钥提取，运行时数据 |
| `hook_api` | 在页面中设置隐蔽API Hook | 动态监控fetch/crypto等 |
| `get_hook_logs` | 获取Hook收集的调用日志 | 数据收集，签名参数捕获 |
| `page_state` | 获取页面完整状态(cookie/storage/scripts) | 初期侦查，环境信息 |
| `deobfuscate` | 反混淆JS代码（多种变换） | 代码清洗，可读性还原 |

#### 推荐工作流

```
1. page_state → 了解页面结构和初始状态
2. detect_protection → 识别保护类型和等级
3. 根据保护类型选择路径：
   ├── L1-L2: deobfuscate → 分析清洗后的代码逻辑
   ├── L3(混淆): deobfuscate → analyze_jsvmp → trace_execution
   ├── L4(JSVMP): extract_bytecode → analyze_jsvmp → hook_api(crypto/cookie) → get_hook_logs
   ├── L4-L5(WASM): extract_wasm → analyze_wasm → dump_wasm_memory
   └── 组合保护: hook_api + extract_bytecode + extract_wasm 联合分析
```

#### 与其他工具的配合

- **nodriver/patchright**：提供反检测浏览器环境，启动时通过 `--load-extension` 自动加载 WebTrace
- **mitmproxy**：网络层抓包分析，WebTrace 提供应用层 JS/WASM 分析能力
- **webcrack**：离线 AST 反混淆，WebTrace 的 `deobfuscate` 提供在线版本（直接对页面代码操作）
- **curl_cffi**：签名复现验证，WebTrace 的 `hook_api` + `get_hook_logs` 用于捕获签名参数

> 详细使用说明见 `references/webtrace-mcp.md`

---

# 第二部分：问题细节层 - 各类反爬针对性解法

## 4. JS混淆对抗

### 4.1 变量/函数名恢复

**方法**：AST分析 + 上下文推断

1. **字符串关联法**：变量在字符串拼接/模板字符串中使用时，根据上下文推断含义
2. **API调用推断法**：`_0x1a2b3c.call(null, "click")` → 推断为事件派发函数
3. **类型推断法**：通过操作符推断类型（`>>>0` → 无符号整数、`|0` → 整数）

```javascript
// Babel AST遍历：根据MemberExpression属性名推断变量含义
const renameVisitor = {
  VariableDeclarator(path) {
    const binding = path.scope.getBinding(path.node.id.name);
    if (!binding) return;
    // 检查所有引用点的上下文
    for (const ref of binding.referencePaths) {
      const parent = ref.parentPath;
      if (parent.isMemberExpression({ object: ref.node })) {
        const prop = parent.node.property.name || parent.node.property.value;
        // 如 _0x1a2b.length → 可能是数组或字符串
        console.log(`${path.node.id.name} → used as .${prop}`);
      }
    }
  }
};
```

### 4.2 字符串解密

**完整流程**：找到解密函数 → 静态计算 → 批量替换

```javascript
// Step 1: 识别字符串数组和解密函数模式
// 典型模式：const _0xabc = ["base64str1", "base64str2", ...];
// function _0xdef(index, key) { return atob(_0xabc[index]) ^ key; }

// Step 2: 用Babel AST提取并执行解密函数
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const vm = require('vm');

function decryptStrings(code) {
  const ast = parse(code);
  // 提取字符串数组和解密函数
  let stringArray = null;
  let decryptFn = null;
  
  traverse(ast, {
    VariableDeclaration(path) {
      const decl = path.node.declarations[0];
      if (decl.init?.type === 'ArrayExpression' && 
          decl.init.elements.length > 50) {
        // 大数组 → 可能是字符串数组
        stringArray = generate(decl).code;
      }
    },
    FunctionDeclaration(path) {
      if (path.node.params.length >= 2) {
        const body = generate(path.node).code;
        if (body.includes('atob') || body.includes('charCodeAt')) {
          decryptFn = body;
        }
      }
    }
  });

  // Step 3: 在沙箱中执行解密函数，批量替换调用点
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${stringArray}; ${decryptFn};`, sandbox);
  
  traverse(ast, {
    CallExpression(path) {
      try {
        const code = generate(path.node).code;
        const result = vm.runInContext(code, sandbox);
        if (typeof result === 'string') {
          path.replaceWith({ type: 'StringLiteral', value: result });
        }
      } catch(e) {}
    }
  });
  return generate(ast).code;
}
```

### 4.3 控制流反平坦化

**核心模式识别**：`"2|4|3|0|1".split("|")` + switch-case状态机

webcrack的 `control-flow-switch.ts` 实现原理（详见 `references/deobfuscation.md`）：

1. **匹配模式**：识别 `const sequence = "数字串".split("|")` + `while(true) { switch(sequence[iterator++]) { case "0": ... } }`
2. **提取序列**：从字符串字面量中提取执行顺序，如 `"2|4|3|0|1"` → `[2,4,3,0,1]`
3. **重排分支**：按序列顺序重新排列switch case中的语句
4. **移除包装**：去除while(true)/switch/iterator，输出扁平化代码

```javascript
// 反平坦化前后对比
// Before:
const _0xa = "2|4|3|0|1".split("|");
let _0xb = 0;
while (true) {
  switch (_0xa[_0xb++]) {
    case "0": console.log("step4"); continue;
    case "1": console.log("step5"); continue;
    case "2": console.log("step1"); continue;
    case "3": console.log("step3"); continue;
    case "4": console.log("step2"); continue;
  }
  break;
}

// After:
console.log("step1");
console.log("step2");
console.log("step3");
console.log("step4");
console.log("step5");
```

### 4.4 JSVMP逆向完整指南

#### 4.4.1 JSVMP架构理解

**通用流水线**：`Source JS → Parser(Babel) → AST → Compiler → ByteCode → VM.execute()`

**栈式VM vs 寄存器式VM**：
- **栈式VM**（如jsvmp项目）：操作数通过栈传递，`PUSH a; PUSH b; ADD` → 弹出b和a，计算a+b，推入结果
- **寄存器式VM**（如新版腾讯VMP）：操作数通过虚拟寄存器传递，`ADD R1, R2, R3` → R1=R2+R3

**jsvmp项目指令集**（详见 `references/jsvmp-architecture.md`，38条操作码）：

| 分组 | 操作码 | 范围 |
|------|--------|------|
| 栈操作 | PUSH, POP, DUP | 0x01-0x03 |
| 算术运算 | ADD, SUB, MUL, DIV, MOD, NEG | 0x10-0x15 |
| 位移运算 | SHL, SHR, USHR | 0x16-0x18 |
| 位运算 | BIT_AND, BIT_OR, BIT_XOR, BIT_NOT | 0x19-0x1C |
| 比较运算 | EQ, NE, LT, LE, GT, GE | 0x20-0x25 |
| 逻辑运算 | AND, OR, NOT, TYPEOF | 0x30-0x33 |
| 变量操作 | LOAD, STORE, DECLARE | 0x40-0x42 |
| 控制流 | JMP, JIF, JNF | 0x50-0x52 |
| 函数操作 | CALL, RET, ENTER, LEAVE, CALL_METHOD | 0x60-0x64 |
| 对象操作 | NEW_OBJ, GET_PROP, SET_PROP, NEW | 0x70-0x73 |
| 数组操作 | NEW_ARR, GET_ELEM, SET_ELEM | 0x80-0x82 |
| 异常处理 | THROW, TRY, CATCH, FINALLY, END_TRY, BREAK, CONTINUE | 0x90-0x96 |
| 特殊 | NOP, HALT | 0x00, 0xFF |

#### 4.4.2 JSVMP逆向五步法

**Step 1：字符串反混淆**
用Babel AST遍历，将 `MemberExpression` 计算为字符串属性访问替换为字面量：
```javascript
// _0xabc["charCodeAt"] → _0xabc.charCodeAt
// _0xabc[0] → 直接用索引值查表
```

**Step 2：字节码提取**
从 `Uint8Array` 或编码数组中提取字节码序列，解析二进制格式：
```javascript
// 典型模式：const bytecode = new Uint8Array([72, 101, 108, ...]);
// 或：const bytecode = "SGVsbG8="  → Base64解码
```

**Step 3：操作码识别与分类**
将嵌套if-else分发改写为switch-case，按功能分组（算术/控制流/内存/IO）

**Step 4：执行追踪定位目标函数**
全局数组收集运行时数据（操作数栈变化、PC值、操作码），建立函数索引映射

**Step 5：反汇编输出**
字节码→可读汇编注释，标注每个函数的入口/出口、参数/返回值

#### 4.4.3 JSVMP保护产品识别

| 产品 | 特征 | 识别方法 |
|------|------|---------|
| 瑞数(RuiShu) | 动态cookie名+JSVMP+频繁刷新JS | cookie名每次变化、JS文件hash频繁更新 |
| 顶象(DingXiang) | 滑块+JSVMP+设备指纹 | 请求中包含dui、dx_c等参数 |
| 数美(ShuMei) | smid设备ID+JS混淆 | 请求头含smidv2、smid参数 |
| 极验(GEETEST) | 四代验证+JSVMP+行为分析 | gt/challenge参数、validate回包 |
| Cloudflare Turnstile | cf-turnstile-response+Challenge | cf_clearance cookie、/cdn-cgi/路径 |
| 腾讯TSec | 自研VMP+寄存器式VM | 80+操作码、SSA IR中间层 |

#### 4.4.4 IR混淆对抗

twisted项目展示了VM保护的高级形态：在字节码编译前引入SSA IR中间层，通过IR混淆Pass管线增加分析难度。

**核心混淆Pass**：
- **常量拆分**：`42` → `(x * 3) + (y - 7)` 其中x/y为运行时计算
- **变量加载展开**：简单变量访问变为多步间接寻址
- **算术恒等变形**：`a + b` → `(a ^ b) + 2 * (a & b)`（位运算恒等式）
- **控制流重组**：线性代码块拆分为多个通过跳转表连接的基本块

**对抗方法**：使用twisted的 `assembler/hyperion.ts` 和 `assembler/bulldozer.ts` 中的反混淆Pass，或手动应用代数简化规则。

## 5. 环境修补完全指南

### 5.1 Proxy代理监测法

核心思想：用递归Proxy包裹空对象，捕获目标代码所有属性访问，日志记录缺失的API，逐步补全。

```javascript
function createMonitoringProxy(target, name = 'globalThis') {
  const accessed = new Set();
  return new Proxy(target, {
    get(obj, prop) {
      const key = `${name}.${String(prop)}`;
      if (!accessed.has(key)) {
        accessed.add(key);
        console.log(`[ENV-ACCESS] ${key}`);
      }
      if (prop in obj) {
        const val = obj[prop];
        // 递归代理：返回的对象也包装Proxy
        if (typeof val === 'object' && val !== null && !Proxy.isProxy?.(val)) {
          return createMonitoringProxy(val, key);
        }
        if (typeof val === 'function') {
          return val.bind(obj);
        }
        return val;
      }
      // 未定义的属性 → 记录并返回undefined或空函数
      console.log(`[ENV-MISS] ${key} → needs implementation`);
      return function() { return undefined; };
    },
    has(obj, prop) {
      return true; // 让 'prop' in obj 始终返回true
    }
  });
}
```

### 5.2 核心BOM/DOM对象伪造清单

| 对象 | 必须属性/方法 | 说明 |
|------|-------------|------|
| `globalThis` | `Symbol.toStringTag → 'Window'` | **关键**：`Object.prototype.toString.call(window)` 必须返回 `[object Window]` |
| `window` | self, top, parent, frames, length, name, closed, atob, btoa, setTimeout, setInterval | self===window, top===window |
| `document` | createElement, getElementById, querySelector, cookie, title, readyState, domain, referrer | createElement必须返回带style/setAttribute的元素 |
| `navigator` | userAgent, platform, language, languages, hardwareConcurrency, maxTouchPoints, webdriver(false!) | **webdriver必须为false或undefined** |
| `location` | href, hostname, pathname, protocol, port, search, hash, origin | 与目标URL一致 |
| `screen` | width, height, availWidth, availHeight, colorDepth, pixelDepth | 常见值：1920x1080, colorDepth=24 |
| `history` | length, state, pushState, replaceState, back, forward | length≥1 |
| `localStorage` | getItem, setItem, removeItem, clear, length | Map模拟 |
| `sessionStorage` | 同localStorage | Map模拟 |
| `XMLHttpRequest` | open, send, setRequestHeader, addEventListener, readyState, responseText | 可用node-fetch桥接 |
| `canvas` | getContext('2d'), toDataURL, toBlob | 需实现基础2D API |

### 5.3 高级反检测技术

**toString修补**：所有伪造对象的 `toString()` 和 `Function.toString` 必须返回 `"[native code]"`

```javascript
// 修补Function.prototype.toString
const originalToString = Function.prototype.toString;
Function.prototype.toString = function() {
  if (this === Function.prototype.toString) return 'function toString() { [native code] }';
  if (this === window.navigator.userAgent?.get?.()) return 'function userAgent() { [native code] }';
  // 对所有伪造函数返回native code
  if (mockedFunctions.has(this)) return `function ${this.name || ''}() { [native code] }`;
  return originalToString.call(this);
};
```

**getOwnPropertyDescriptor修补**：确保属性描述符看起来自然
```javascript
// navigator.webdriver不应有enumerable:true等异常描述符
Object.defineProperty(navigator, 'webdriver', {
  get: () => false,
  enumerable: true,
  configurable: true
});
```

**document.all特殊处理**：`typeof document.all` 返回 `"undefined"` 但 `document.all` 是truthy
```javascript
// 用Symbol模拟document.all的特殊行为
const documentAll = new Proxy({}, {
  get(t, p) { return p === Symbol.toPrimitive ? () => undefined : undefined; }
});
// document.all在if判断中为truthy但typeof为"undefined"
```

### 5.4 浏览器指纹伪造

- **Canvas指纹**：对 `toDataURL` 和 `getImageData` 注入微小噪声（±1像素RGB偏移），确保每次运行结果一致
- **WebGL指纹**：伪造 `getParameter(RENDERER)` 返回常见显卡（如 "ANGLE (Intel, Intel(R) UHD Graphics 630)"）、控制 `getSupportedExtensions()` 列表
- **AudioContext指纹**：控制 `OfflineAudioContext` 的浮点运算精度，返回固定的 `AnalyserNode.getFloatFrequencyData` 结果
- **字体枚举**：模拟Windows 10/11常见字体列表（约200种），通过canvas宽高差异欺骗检测

### 5.5 时间戳和计时器一致性

```javascript
// 统一管理时间源，避免Date.now()和performance.now()不一致
const startTime = Date.now();
const perfOffset = performance.now();

Date.now = () => startTime + (performance.now() - perfOffset);

// setTimeout/setInterval正确行为模拟
const timers = new Map();
let timerId = 1;
globalThis.setTimeout = (fn, delay = 0) => {
  const id = timerId++;
  timers.set(id, { fn, delay, type: 'timeout' });
  // 实际执行：用setImmediate或process.nextTick近似
  setImmediate(() => { if (timers.has(id)) { fn(); timers.delete(id); } });
  return id;
};
globalThis.clearTimeout = (id) => timers.delete(id);
```

### 5.6 环境修补实战模式（以知乎__zse_ck为例）

**Step 1**：预请求收集初始cookie
```bash
curl -c cookies.txt -D headers.txt "https://www.zhihu.com"
# 收集初始Set-Cookie
```

**Step 2**：GET challenge页面提取meta+xsrf+emo.js URL
```bash
curl -b cookies.txt "https://www.zhihu.com/api/v4/oauth/captcha_v2"
# 提取：_xsrf token、emo.js的URL
```

**Step 3**：下载emo.js（包含__zse_ck生成逻辑）
```bash
curl -o emo.js "https://static.zhihu.com/heifetz/emo.js"
```

**Step 4**：Node.js子进程运行环境模拟+emo.js生成__zse_ck
```javascript
const vm = require('vm');
// 伪造最小环境
const env = {
  globalThis: {}, window: {}, document: { cookie: initialCookies },
  navigator: { userAgent: '...' }, location: { href: 'https://www.zhihu.com/' },
  setTimeout, setInterval, clearTimeout, clearInterval
};
env.window = env.globalThis;
vm.createContext(env);
vm.runInContext(emoJsCode, env);
const zseCk = env.document.cookie.match(/__zse_ck=([^;]+)/)?.[1];
```

**Step 5**：带完整cookie请求目标页面
```bash
curl -b "cookies.txt; __zse_ck=$ZSE_CK" "https://www.zhihu.com/api/v4/..."
```

### 5.7 新型浏览器指纹（2024-2026）

| 指纹类型 | API | 检测方法 | 伪造难度 |
|---------|-----|---------|----------|
| Battery API | navigator.getBattery() | 电池状态一致性 | 低（直接覆写） |
| Sensor API | DeviceMotionEvent, DeviceOrientationEvent | 加速度/陀螺仪数据 | 中 |
| Storage Quota | navigator.storage.estimate() | 磁盘配额差异 | 低 |
| Notification | Notification.permission | 权限状态 | 低 |
| WebXR | navigator.xr.isSessionSupported() | VR/AR设备列表 | 低 |
| Gamepad | navigator.getGamepads() | 游戏手柄信息 | 低 |
| Bluetooth | navigator.bluetooth | 蓝牙设备列表 | 低 |
| USB | navigator.usb | USB设备信息 | 低 |
| Keyboard Layout | navigator.keyboard.getLayoutMap() | 键盘布局 | 中 |
| Connection | navigator.connection | 网络类型/速度 | 低 |

**指纹冲突处理**：当多个检测同时存在时，确保所有伪造值之间的一致性：
- CPU核心数(hardwareConcurrency)与并发线程数一致
- 内存大小(deviceMemory)与Storage配额合理对应
- 屏幕分辨率与Canvas渲染尺寸匹配

## 6. CDP检测绕过

### 6.1 CDP检测原理

| 检测向量 | 原理 | 影响 |
|---------|------|------|
| Runtime.enable泄露 | 页面JS检测CDP Runtime域是否启用（自动触发executionContextCreated） | Cloudflare/DataDome核心检测 |
| sourceURL注入 | `page.evaluate()` 注入 `//# sourceURL=__pptr:__` 或 `__playwright_` 标记 | 简单但有效的检测 |
| navigator.webdriver | Chrome自动化启动时设置 `navigator.webdriver = true` | 基础检测 |
| Target.setAutoAttach | 检测CDP Target域的自动附加痕迹 | 高级检测 |
| DevTools窗口 | `window.outerWidth - window.innerWidth` 异常差值 | 检测DevTools面板打开 |

### 6.2 四种绕过方案对比

| 方案 | 技术路线 | 检测通过率 | 生态 | 安装 |
|------|---------|-----------|------|------|
| nodriver | Python直接CDP WebSocket驱动，无Playwright/Selenium中间层 | 31/31全通过 | Python | `pip install nodriver` |
| rebrowser-patches | 三策略修补(addBinding/alwaysIsolated/enableDisable) | Cloudflare/DataDome通过 | Puppeteer/Playwright | `npx rebrowser-patches patch` |
| patchright | Playwright fork，32个模块全面修补 | 主流检测通过 | Playwright | `npm i patchright` |
| CloakBrowser | Chromium C++源码级49处修改 | 高度隐蔽 | C++/Chromium | 编译Chromium |

### 6.3 nodriver实现详解

nodriver（详见 `references/cdp-bypass.md`，v0.50.3）的核心优势：

1. **直接CDP WebSocket通信**：不通过Playwright/Selenium中间层，直接用Python与Chrome DevTools Protocol通信
2. **无WebDriver协议**：完全绕过 `navigator.webdriver` 检测
3. **进程级控制**：通过Chrome启动参数 `--disable-blink-features=AutomationControlled` 禁用自动化标志
4. **Flat Mode iframe穿透**：通过 `Target.setAutoAttach(flatten=true)` 实现对所有iframe的直接控制

```python
import nodriver as uc

async def main():
    browser = await uc.start()
    page = await browser.get('https://target.com')
    # 直接CDP通信，无中间层泄露
    await page.evaluate('document.title')
    await browser.stop()

uc.loop().run_until_complete(main())
```

### 6.4 rebrowser-patches三策略详解

详见 `references/cdp-bypass.md`：

**策略1：addBinding（推荐）**
- 在主世界创建随机名称的binding
- 调用binding获取executionContextId
- 环境变量：`REBROWSER_PATCHES_RUNTIME_FIX_MODE=addBinding`
- 优点：保持主世界访问，支持Web Worker和iframe

**策略2：alwaysIsolated**
- 通过 `Page.createIsolatedWorld` 创建隔离上下文
- 所有脚本在隔离世界执行
- 环境变量：`REBROWSER_PATCHES_RUNTIME_FIX_MODE=alwaysIsolated`
- 缺点：无法访问主世界变量

**策略3：enableDisable**
- 快速调用 `Runtime.Enable` + `Runtime.Disable`
- 在极短时间窗口内捕获executionContextCreated事件
- 环境变量：`REBROWSER_PATCHES_RUNTIME_FIX_MODE=enableDisable`
- 风险：极小概率在窗口期内被页面检测代码捕获

### 6.5 完整CDP检测向量清单（12项）

| # | 检测向量 | 检测原理 | 绕过方案 |
|---|---------|---------|----------|
| 1 | Runtime.enable泄露 | consoleAPICalled事件 | addBinding策略 |
| 2 | sourceURL泄露 | pptr:// 标记 | 替换为app.js |
| 3 | Target.setAutoAttach | 自动化连接序列 | 跳过或延迟 |
| 4 | navigator.webdriver | 自动化标记 | 启动参数禁用 |
| 5 | Chrome DevTools窗口 | outerWidth-innerWidth差异 | 隐藏DevTools |
| 6 | Error.stack格式 | Puppeteer注入脚本的栈帧 | sourceURL伪装 |
| 7 | Permission异常 | 自动化环境的权限状态不一致 | 修补Permissions API |
| 8 | WebGL Renderer | SwiftShader软渲染器特征 | 使用GPU渲染 |
| 9 | Chrome版本一致性 | UA与实际版本不匹配 | 使用channel=chrome |
| 10 | HeapSnapshot timing | 堆快照操作导致的时间异常 | 避免运行时快照 |
| 11 | Page.addScriptToEvaluateOnNewDocument | 注入脚本的执行时序 | Patchright延迟注入 |
| 12 | 多标签页行为 | 自动化通常只有一个标签 | 创建多标签模拟 |

---

## 参考文档索引

| 文档 | 路径 | 说明 |
|------|------|------|
| 环境修补 | references/env-patching.md | Proxy监测法、BOM/DOM伪造、反检测技术 |
| CDP绕过 | references/cdp-bypass.md | nodriver/patchright/rebrowser-patches |
| JS反混淆 | references/deobfuscation.md | webcrack、控制流还原、字符串解密 |
| JSVMP逆向 | references/jsvmp-reverse-methodology.md | 五步法、操作码分析、执行追踪 |
| JSVMP架构 | references/jsvmp-architecture.md | 38条指令集、栈式/寄存器式VM |
| 协议指纹 | references/protocol-fingerprinting.md | JA3/JA4、HTTP/2、QUIC |
| WASM逆向 | references/wasm-reverse.md | wabt、Ghidra、加密算法识别 |
| 多重保护 | references/layered-protection-bypass.md | 分层击破策略 |
| 反爬维护 | references/anti-crawler-maintenance.md | 监控、更新、持久化 |
| 网络拦截 | references/network-interception.md | mitmproxy、请求修改 |
| Chrome Extension | references/chrome-extension-helper.md | 扩展开发与注入 |
| 调试技巧 | references/debugging-techniques.md | 断点、LogPoint、条件调试 |
| AI逆向 | references/ai-reverse-tools.md | MCP Server、AI辅助分析 |
| WebTrace MCP | references/webtrace-mcp.md | MCP工具集详细使用指南 |
| 参考项目 | references/git-references.md | Git清单、开源项目索引 |
