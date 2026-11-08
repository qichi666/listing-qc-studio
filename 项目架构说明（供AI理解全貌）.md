# 跨境 Listing 质检工作台 · 项目架构说明（供 AI 理解全貌）

> 目的：让另一个 AI 在**不读完全部源码**的前提下，准确理解这个项目的分层、职责、调用关系与数据流，并能定位到具体代码位置。
> 所有数字与行号均来自 2026-11-05 的磁盘实测；断言数经 `node tools/selftest.mjs` / `node tools/verify-server.mjs` 现场复核。
> 本文只描述**现状**，不写改版历史。历史决策过程见 `给AI审阅-功能细节与技术实现.md` 的 §14 以后各节。

---

## 0. 三十秒版本

一句话：**一个零依赖、本地优先的跨境电商 Listing 工作台**——把「出图 Prompt 编排 + Listing 文案与合规质检 + 亚马逊数据采集 + 竞品关键词分析」四件事，用**可复现的确定性代码**串成一条流水线，LLM 只在用户显式开启时做润色。

四个不可动摇的前提：

1. **零 npm 依赖**。`package.json` 只有 `type: module` 与 `engines.node >= 20`，没有 `dependencies`。服务端只用 `node:http/fs/path/crypto/dns/zlib`。
2. **双路径同构**。浏览器端（离线）与服务端共用**同一份**编排代码（`orchestrator.js`），不存在"离线修好了、线上还是旧行为"。
3. **规则用代码判，不靠模型自觉**。模板匹配、合规质检、关键词权重、信息架构检查全部是纯函数，可写断言。
4. **数据不出本机**。默认只监听 `127.0.0.1`；密钥只进 `.env.local`，不进任何响应体。

---

## 1. 技术选型与运行方式

| 项 | 选择 | 原因（改之前先读） |
|---|---|---|
| 运行时 | Node ≥ 20.15，ESM（`type: module`） | 用内置 `fetch`、现代 API；无构建步骤。**20.15 这条线是 `zlib.crc32` 的要求**（只影响图片库打包下载）——`zip.js` 故意用默认导入 + 运行时探测，所以低版本照样能启，只有点下载时返回 501 |
| 服务端 | 原生 `http.createServer` | 只有 13 个路由，引 Express 等于引入几百 MB 与版本漂移 |
| 前端 | 原生 DOM + 手写渲染函数 | 单页 7 视图、无路由库；避免打包器 |
| Markdown | 自写 `md.js`（135 行） | 断网可用；只渲染自己产出的简报，可全量转义 |
| 持久化 | 浏览器 IndexedDB（`store.js`） | 产物可达数百 KB，localStorage 5MB 配额不够 |
| 抓取 | Node `https` + 正则解析（`bestsellers.js`） | 浏览器直连亚马逊会被 CORS 拦；且白名单必须放在服务端 |
| 测试 | 自写断言器 + CDP（Node 内置 `WebSocket`） | 不装 jest/playwright；浏览器自检真起 Edge/Chrome |
| 打包 | 自写 zip（`zip.js`，用 `node:zlib` 的 `crc32`） | 图片库"一次下载全部"不该引入 archiver |

**启动**

```bash
node server.mjs          # 默认 127.0.0.1:8787
node server-public.mjs   # 线上演示形态：绑 0.0.0.0 + 取 $PORT + 禁写密钥
```

⚠️ **不能双击 `index.html`**：整个应用是 ES 模块，`file://` 下浏览器以 CORS 为由拦掉模块请求，页面会是"有骨架、一行 JS 没跑"。`index.html:27-48` 有一段**经典脚本**专门检测并红条提示。

---

## 2. 目录结构与文件职责

```
跨境Listing优化工作台/
├── index.html                     751   单页外壳：8 个视图 + 全部 DOM id
├── server.mjs                    1419   本地服务：13 个接口（静态、上传、生图、识图、LLM、SSE 编排、竞品抓取、词库读取）
├── server-public.mjs               23   线上形态入口：HOST=0.0.0.0、PORT=$PORT、LISTING_NO_KEY_WRITE=1
├── package.json                    24   仅 type/engines/scripts，无依赖
├── .env.example                        密钥模板（首行说明写 .env.local）
├── .github/workflows/
│   └── keywords.yml                    每周一 02:17 UTC 采集词库（也可在 Actions 页面手动触发）
├── assets/
│   ├── app.js                    4902   前端主控：路由、消息模型、四张工作卡、设置、健康分/VOC/快照/体检
│   ├── app.css                    848   全部样式（含自绘下拉、健康分、体检、A+ 骨架）
│   ├── orchestrator.js            712   编排层：意图→主体→模板→驱动→StyleLock→组装
│   ├── prompt-engine.js          1375   视觉 Prompt 引擎：匹配/诊断/构图/整套规划/机械自检
│   ├── templates.js              1994   25 个模板（**自动生成，勿手改**）
│   ├── listing.js                1800   Listing 领域：规则集/草稿/导出/词频/覆盖度/4 套语种利益词
│   ├── rufus.js                   364   Rufus 准入层：5 组 7 条规则
│   ├── rufus-facts.js             396   事实抽取：单位/数量/材质冲突/问题覆盖
│   ├── rufus-data.js              786   属性表 + 问题矩阵（8 个产品类型，只读数据）
│   ├── amazon.js                  678   页面解析：详情页/搜索页/纯文本/书签脚本（含评论区）
│   ├── competitor-keywords.js     359   竞品词权重（纯本地，无网络）
│   ├── copy-prompts.js            221   五类文案提示词拼装（只拼文本，不调模型）
│   ├── bestsellers.js             445   唯一出网通道：Amazon 榜单抓取 + 白名单 + 缓存
│   ├── amazon-suggest.js          126   搜索建议接口**唯一实现**（MCP 与周更采集器共用）
│   ├── keyword-seeds.js           168   词根种子表：14 组 / 194 条双词英文词根（纯数据）
│   ├── keyword-vault.js           526   快照合并**唯一口径**：归并/firstSeen/上限/陈旧四态（纯函数）
│   ├── keywords-store.js          200   词库只读落盘层（**刻意没有写函数**）
│   ├── score.js                   303   健康分（8 维加权合计 100、硬规则封顶 55、缺数据归一不补 0）
│   ├── reviews.js                 303   评论 VOC：14 个方面聚类、高频疑问、词频候选
│   ├── image-audit.js             307   成图体检（纯像素；不做 OCR、不判 Logo）
│   ├── snapshots.js               144   历史快照 + sparkline（不插值、两点才画、断点不连线）
│   ├── aplus.js                   304   A+ 骨架（三块模块 + 配图提示词；复用 listing 词表）
│   ├── batch-lint.js              209   批量质检（硬规则优先排序；同口径部分维度分）
│   ├── csv-import.js              251   第三方词表 CSV 导入（表头别名/搜索量解析/不猜列）
│   ├── csv.js                     162   RFC 4180 CSV 编解码（导出与导入共用同一份）
│   ├── term-normalize.js          169   外部词表字段归一（认不出返回 0 条 + 原因）
│   ├── keyword-roots.js           228   词根覆盖层（基线 194 条 + roots.json 增删改）
│   ├── mcp-http.js                217   外部 MCP 客户端传输（Streamable HTTP：SSE/JSON）
│   ├── api.js                     234   传输层：探活、SSE、上传、生图、识图、LLM
│   ├── store.js                   408   IndexedDB 产物库（含可断言的纯函数层）
│   ├── select-ui.js               279   原生 select 的自绘替身（OS 弹层错位的根治）
│   ├── net-guard.js                175   SSRF 防护 + Host 白名单（唯一实现）
│   ├── zip.js                     194   零依赖 zip 打包
│   ├── md.js                      135   极简 Markdown → HTML（先转义再白名单）
│   └── selftest-browser.html      216   浏览器自检的宿主页（给 CDP 用）
├── mcp/                                 MCP server（2026-11-07 新增）：把判断层开放给外部 AI 客户端
│   ├── server.mjs                  481   stdio + 每行一条 JSON-RPC；8 个工具全是现有函数的薄封装
│   ├── README.md                  295   接入说明：是什么/不是什么、八个工具、排错表、边界
│   └── clients/                        6 份现成配置（Claude Desktop/Code、Cursor、VS Code、Codex、WorkBuddy）
├── tools/
│   ├── selftest.mjs              5546   纯逻辑回归，643 条
│   ├── verify-server.mjs         1119   服务端安全回归，290 条（真起服务、真发请求）
│   ├── browser-selftest.mjs      1032   端到端回归，199 条（真起浏览器，走 CDP）
│   ├── mcp-selftest.mjs          1290   MCP 协议回归，248 条（真起进程灌 JSON-RPC；结尾硬断言 data/ 未变）
│   ├── keywords-selftest.mjs      519   词库与采集器回归，136 条（含 dry-run 实跑到临时目录）
│   ├── collect-keywords.mjs       674   周更采集器：词根覆盖层 → 搜索建议 → 榜单 ASIN（有节流、失败不覆盖、非 US 需显式放行）
│   ├── fixtures/keywords/              自检专用假数据（`_fixture` 已标明，ASIN 形如 B0FIX00001）
│   ├── expected-counts.json             五套断言数基线（assert-count.mjs 守「只增不减」）
│   ├── build-templates.mjs        119   从上游仓库 JSON 生成 templates.js
│   ├── make-share-pack.py         311   白名单打包 + 形态扫描 + 解压后实地跑一遍
│   ├── check-doc-numbers.py       151   核对文档里的行数/断言数是否与磁盘一致
│   ├── export-sources.mjs         373   生成按目录结构组织的《源码合集》
│   ├── export-guide-html.mjs      144   《功能详细介绍》md → 单文件 html
│   ├── _export-sources.mjs        244   生成《源码合集》（审阅批次版，旧）
│   ├── _export-details.mjs        600   把关键常量 dump 成文档片段（文档不手抄参数）
│   └── _sync-details-doc.mjs       72   把上一步输出写回技术文档
├── docs/                                规格与 ADR（Rufus 模块有正式 SPEC）
└── data/
    ├── gen/                             生成的图片（图片库面板读）
    ├── uploads/                         参考图上传
    └── keywords/                        周更词库：latest.json + history/YYYY-MM-DD.json（服务端只读）
```

规模：前端 + 服务端运行代码约 **15,400 行**（其中 `assets/templates.js` 是 1,994 行生成物）；工具与自检约 **9,600 行**（含 MCP server 481 行）。
行数口径与本表一致（`wc -l`），2026-11-07 按磁盘重算过一遍。

---

## 3. 分层与依赖方向

```
┌──────────────────────────────────────────────────────────────┐
│ 展示层  index.html + app.js + app.css + select-ui.js + md.js   │
│ 职责：DOM、事件绑定、渲染、视图切换、状态 S（全局单例）          │
└───────────────┬──────────────────────────────┬───────────────┘
                │ 直接 import（同进程）          │ fetch / SSE
┌───────────────▼──────────────┐   ┌───────────▼───────────────┐
│ 领域层（纯函数，浏览器/Node   │   │ 传输层 api.js              │
│ 都能跑）                      │   │ 探活缓存 / SSE 解析 / 上传  │
│ prompt-engine / listing      │   └───────────┬───────────────┘
│ rufus* / amazon / store      │               │ HTTP
│ competitor-keywords          │   ┌───────────▼───────────────┐
│ copy-prompts / zip / md      │   │ server.mjs（Node）         │
└───────────────▲──────────────┘   │ 路由 + 代理 + SSE 编排      │
                │ 同一份代码被服务端 import                     │
                └──────────────────┬───────────────────────────┘
                                   │ 出网（唯一）
                          bestsellers.js + net-guard.js
```

**依赖铁律**

- 领域层**不许** import 展示层，也不许碰 `document` / `window`（`store.js` 把 IndexedDB 包裹在 `isAvailable()` 之后，正是为了能在 Node 里 import 它做断言）。
- `server.mjs` **只 import 领域层**，绝不重写编排。`server.mjs:44-46` 的注释写死了这条：确定性编排只允许有一处实现。
- 出网只有两个出口：`bestsellers.js`（抓榜单）与 `server.mjs::downloadToGen`（下载生图结果）。两者都必须过 `net-guard.js`。

---

## 4. 两条运行路径（为什么是"双路径"）

`orchestrator.js` 的 `runTurn()`（`assets/orchestrator.js:546`）是唯一入口：

```
probeServer()  ──在线──► postChat() ──SSE──► server.mjs /api/chat ──► runLocalTurn()
      │                        │
      │                        └─失败─► catch：报错并回退 runLocalTurn()（mode: local-fallback）
      └──离线──► runLocalTurn()（浏览器内直接算，0 网络、0 成本）
```

| 路径 | 谁在算 | 能做什么 | 不能做什么 |
|---|---|---|---|
| 在线（服务端） | `server.mjs` 调 `runLocalTurn` | 全部 + 真出图 + 识图 + LLM 润色 + 图片库 + 竞品抓取 | 需要 `node server.mjs` |
| 离线（浏览器） | 浏览器直接调 `runLocalTurn` | 模板匹配、Prompt 组装、简报、质检、词频、覆盖度 | 出图、识图、抓取、图片库 |

**关键设计**：两条路径产出的事件序列与文案格式**完全一致**，因此前端 `dispatch()` 只写一套（`app.js:227`）。这也是为什么服务端必须复用 `runLocalTurn` 而不是自己拼 Prompt。

---

## 5. 事件协议（前后端唯一耦合点）

事件名刻意与参考项目 `ecom-details-image-ui` 对齐，便于对照。

| 事件 | 生产位置 | 前端处理（`app.js:227` `dispatch`） |
|---|---|---|
| `tool_call` | orchestrator 各步骤 / server 生图前 | 推一条 `role:"tool"`、`toolStatus:"run"` 气泡 |
| `tool_result` | 同上 | 找到同名 run 气泡 → 标 `ok` / `warn`，追加明细 |
| `ai_response` | 简报、图生图说明 | 追加到上一条助手气泡（流式拼接） |
| `file_output` | 生图成功 | 推一条图片卡片（`images[]`） |
| `usage` | 每轮结束 | 附到上一条助手消息（cost / duration） |
| `error_message` | 各类失败 | 推红色错误条 |
| `ping` | 服务端每 5s | 直接丢弃（仅保活） |

🔴 `tool_result` 的 `level:"warn"` 是**独立一档**，不是"成功"。典型场景：识图失败后降级纯文本生图——必须让用户知道"这次没参考你的图"（`server.mjs:694-701`）。

---

## 6. 四条主数据流

### 6.1 创作链路（最核心）

```
用户一句话
  │
  ├─① 意图判断        isGenerateIntent / isPackIntent / isNegative / parseRatio / AMAZON_MAIN_WORDS
  │                   （orchestrator.js:35-135）
  ├─② 主体抽取        extractSubject(message) → subject（失败给 {PRODUCT} 占位符）
  │                   （orchestrator.js:277；清洗链 cleanCandidate→cleanCore:203-290）
  ├─③ 上下文           detectCategory(message) + diagnoseConversionDriver(message)
  │                   （prompt-engine.js:699 / 410）
  ├─④ 模板匹配        matchTemplate(message, {explicitId, context}) → {id, source, reason, candidates}
  │                   （prompt-engine.js:613；打分 scoreTemplate:512）
  ├─⑤ 风格合同        buildStyleLock({}) → 一段可原样复制的英文 Style Lock
  │                   （prompt-engine.js:766）
  ├─⑥ 组装            单张：composePrompt(...)            （prompt-engine.js:939）
  │                   整套：planImagePack(...) → N 张      （prompt-engine.js:1094）
  ├─⑦ 机械自检        auditPlan(plan) → problems[]        （prompt-engine.js:1191）
  ├─⑧ 简报            buildBriefMarkdown(...) → ai_response （orchestrator.js:428）
  └─⑨（可选）出图      generateOne() 或 server 内部生图
```

**⑥ 的两条分支**

- **单张**：`composePrompt({subject, templateId, figure, slot, styleLock, category, sizeRatio, ...})`
  - `slot:"main"` → 走亚马逊首图法规层（85-100% 占幅 / `#FFFFFF` / 禁止任何图内文字 / 固定 1:1）。
  - 其余 → 走设计构图口径（35-40% 占幅 + 显式留白）。
  - Prompt 严格按 9 段拼：Style Lock → 主体与场景 → 目的与情绪 → 构图镜头 → 光线颜色材质 → 风格真实感 → 平台限制与画幅 → 图内文字 → 否定清单（`prompt-engine.js:971-1021`）。
- **整套**：`planImagePack({pack:"pdp"})` = 1 张可选合规首图 + 5 张主图（`HERO_SEQUENCES` 按驱动三选一）+ 9 张详情页（`PDP_SEQUENCE`）；每张独立主体、独立角度、背景按 `rhythmBackground(i)` 交替。

**⑦ 为什么必须有**：它把"这套图到底合不合规"从"模型觉得没问题"变成可断言事实——逐张检查画幅比例、数字化占比、留白、否定清单、hex 颜色、是否以同一段 Style Lock 开头、详情页是否以 `E-commerce infographic` 起头、连续 3 张是否同角度、全景占比是否 >40%。

### 6.2 Listing 链路

```
① 产品输入（品牌/产品名/核心词/卖点/规格/类目口径）
      │
② 关键词挖掘  mineKeywords(text,{top,lang})            listing.js:431
      │        （1/2/3-gram 词频，去停用词，可断网）
③ 规则式草稿  generateListingDraft(input)              listing.js:965
      │        标题按 role 组装 → 超 70 从尾部剥到 Item Highlights（不丢词）
      │        五点 = 引导词 + 卖点 + 规格尾句
      │        Search Terms 按字节截断并记录被丢弃的词
④ 合规质检    lintListing(listing, ctx)                listing.js:850
      │        28 条规则（14 P 硬 / 14 C 软），逐条给 status/detail/why/source
⑤ Rufus 准入  lintRufus(listing, ctx)                  rufus.js:318
      │        R1 属性完整性 / R2 跨字段事实 / R3 单位制 / R4 问题覆盖 / R5 图内文字
⑥ 覆盖度      analyzeCoverage(listing, opts)           listing.js:1393
      │        逐词判 4 个位置 + 竞品是否覆盖 → 给可执行动作
⑦ 导出        exportListingFields / exportFlatFileCsv  listing.js:1168 / 1247
               两段式标题总账（title + highlights ≤ 200，title > 75 则 highlights 提交不上去）
```

### 6.3 竞品关键词 → 文案提示词

```
[服务端抓取]  GET /api/competitor/categories → 站点/类目清单
              GET /api/competitor/subs       → 子类目 href
              GET /api/competitor/bestsellers→ 榜单 30-50 条（10 分钟缓存）
                    │  bestsellers.js: fetchAllowed → assertPublicUrl → fetchHtml → parseItems
                    ▼
[前端]  CMP.items ──► CK.analyzeKeywords(titles,{productName,allTitles})
                    │     覆盖率 50% + 位置 30% + 精准度 20% → 1-10 分
                    │     + 一致性校验（产品联想词在全部竞品标题里的命中率）
                    ▼
              CMP.rows ──► CP.buildCopyPrompt(kind, ctx)
                            5 类：拆解 / 标题+亮点 / 五点 / 后台词 / 多语言
                            （只拼文本，产出给人复制，不调模型）
```

**三条分工写死**（`app.js:912-918`）：抓取走服务端、权重纯本地、拼装纯本地。断网时只有"抓取不可用"，算法与拼装照常。

**请求世代号** `cmpEpoch`（`app.js:926`）：切换站点/类目/子类目时 +1，在途旧响应回来直接丢弃；`clearCompetitorResult()` 会同时清空榜单、关键词、提示词。这解决的是"下拉已换成电子产品、表格还是玩具榜"的自相矛盾。

### 6.4 数据采集链路

```
方式 A 书签脚本：在亚马逊页面执行 bookmarkletSource()（amazon.js:471）
        → 若当前是搜索结果页，产出 {kind:"search", items:[...]}
        → 若是详情页，产出 Product 对象
        → 用户粘贴 JSON 回工作台
方式 B 直接粘贴：extractAny(text)（amazon.js:251）
        ├─ 以 "{" 开头        → JSON（再按 kind 分流 search / product）
        ├─ 含 HTML 特征        → detectPageKind() → extractSearchResults / extractFromHTML
        └─ 纯文本              → extractFromText（标题 + 五点兜底）
                    ▼
        S.product / S.search ──► 「拿去 Listing 工作台」/「整页送去多竞品对比」
```

`extractAny` 的返回值**必须按 `kind` 分流**（`app.js:1445`）：搜索页载荷没有 `title/bullets`，交给商品渲染器会渲染空表，用户会误判为"解析失败"。

---

## 7. 模块逐个说明

### 7.1 `prompt-engine.js`（1212 行）—— 视觉 Prompt 引擎

职责：把"产品 + 意图"变成一段结构固定、可审计、可断言的英文图像 Prompt。

| 能力 | 入口 | 关键实现 |
|---|---|---|
| 转化驱动力诊断 | `diagnoseConversionDriver` (410) | visual / pain / emotion 三组关键词计分；全 0 时给 `confidence:0` + visual 兜底，**调用方不得把它当证据** |
| 模板打分 | `scoreTemplate` (512) | 词证据（trigger_phrase 6 / alias 3 / keyword 0）+ 上下文证据（品类 6 / 驱动 3 / 参考图 3），两组独立返回 |
| 模板匹配 | `matchTemplate` (613) | 排序键顺序极敏感：①有词证据 > 无 ②词长 ③位置 ④词权重 ⑤上下文 ⑥order |
| 品类识别 | `detectCategory` (699) | 8 个品类词表；命中最多者胜 |
| 颜色 hex 化 | `hexify` (725) | 色词→hex；识别到但映射不了的"色系/趋势"词单独返回 `unrecognized`，**不许静默跳过** |
| 风格合同 | `buildStyleLock` (766) | 10 个维度；多图任务逐张原样复制 |
| 模板拍平 | `flattenTemplate` (868) | 合并 defaults + prompt_template，应用 variant overrides 与 category_tips |
| 单张 Prompt | `composePrompt` (939) | 9 段结构；`slot:"main"` 切法规层 |
| 图生图 | `composeImg2ImgPrompt` (1024) | 保留产品身份/图案/颜色/材质，**不保留构图** |
| 整套规划 | `planImagePack` (1094) | 主图/详情页按组定画幅，`assignAngles` 分配角度与景别 |
| 机械自检 | `auditPlan` (1191) | 逐张 6 项 + 首图 7 项 + 连续同角度 + 全景占比 |

常量：`FIGURE_SPEC`（图型→产品占比/留白）、`AMAZON_MAIN_IMAGE`（85-100% / `#FFFFFF` / 空置 ≤15% / 长边 ≥1000、建议 1600）、`HERO_SEQUENCES`（三种驱动各 5 张）、`PDP_SEQUENCE`（9 张）、`PROMPT_MAX_CHARS = 4000`（项目经验阈值，超长部分模型会静默截断）。

### 7.2 `orchestrator.js`（623 行）—— 编排层

**为什么不用 Agent SDK**：LLM 决定调哪个工具 → 结果不可复现、漏调则质量掉档、没 key 完全跑不起来。这里把编排做成**确定性代码**，LLM 只负责润色产品描述。

关键函数：

| 函数 | 行 | 说明 |
|---|---|---|
| `isGenerateIntent` / `isPackIntent` | 36 / 40 | 关键词判定。🔴 **在线与离线必须同源**：服务端不再自带词表，直接 import 这两个函数（`server.mjs:956` 用 `isNegative`）；曾因两份词表不一致导致同一句话在线不出图、离线出图 |
| `isNegative` | 58 | 判"明确说了先别出图"。**只看出图词所在分句的前 12 字符**，且被标点截断——全句扫否定会把"画面不要文字"误判成不要出图 |
| `parseRatio` | 95 | 返回 `{ratio,size,explicit,scope}`；**没明说时 `explicit:false`**。冒号只认白名单比例（1:1/4:3/3:2/16:9/9:16/4:5/3:4/2:3/5:4），`10:30` 这类时间不会再被当画幅 |
| `extractSubject` | 277 | 逐句尝试，先剔除风格从句，再按"图类型"截断，最后剥噪声前后缀 |
| `cleanCandidate` / `cleanCore` | 247 / 203 | 英文 `of/for` 语序优先；整句只有图类型词 → 判为无产品名；纯风格句 → 返回空 |
| `runLocalTurn` | 298 | 六步确定性编排 + 事件播报 + 简报 |
| `runTurn` | 500 | 在线/离线分流与失败回退 |
| `generateOne` | 517 | 单张出图（进度事件 + 明确报错） |
| `runImg2ImgTurn` | 553 | 识图 → 改写 Prompt → 返回 |
| `polishSubject` | 604 | 可选 LLM 润色（默认关） |

### 7.3 `listing.js`（1455 行）—— Listing 领域

**口径（2026-07-27 新规，写死在 `LIMITS`，`listing.js:50`）**

| 字段 | 上限 | 备注 |
|---|---|---|
| 标题 | 75 字符 | media（图书/音乐/影像）例外 200；建议值 70（项目自定义） |
| Item Highlights | 125 字符 | API 属性名 `title_differentiation`，参与搜索 |
| 标题 + Highlights | 200 字符 | 两段共享额度 |
| 单条五点 | 500 字符 | 标准 5 条 |
| Search Terms | **250 字节** | 注意是字节不是字符 |
| 描述 | 2000 字符 | — |

🔴 **最关键的因果**：标题 > 75 时 Highlights **提交不上去**；且超限不报错，亚马逊会按 AI 建议自动改写标题。所以这两个字段必须一起改。

| 能力 | 入口 | 说明 |
|---|---|---|
| 规则集 | `RULES` (547) | 28 条：14 条硬规则（P1-P15，编号跳过 P9）+ 14 条软规则（C1-C14，含 C9） |
| 质检 | `lintListing` (850) | scope → 取值表；空字段跳过；`emptyOk` 规则在整表为空时也不放行 |
| 草稿 | `generateListingDraft` (946) | 标题按 role 组装；溢出部分下移 Highlights；材质句按逗号拆短语；不编造参数 |
| 后台字段 | `exportListingFields` (1168) | 逐字段 used/remaining/over/empty + 两段式总账 + notes |
| Flat File CSV | `exportFlatFileCsv` (1204) | RFC 4180 转义；**明确声明不是官方模板** |
| 词频 | `mineKeywords` (431) | 1/2/3-gram；按语言选停用词；CJK 单独处理 |
| 后台词 | `buildSearchTerms` (496) | 按字节截断，返回 `dropped[]` 说明每个词为什么被丢 |
| 多竞品对比 | `compareCompetitors` (1290) | 按"几个竞品用到"分共识/差异化；`count===size` 才是共识 |
| 覆盖度 | `analyzeCoverage` (1393) | 4 个位置 + 竞品覆盖；真缺口（given）与噪声线索（mined）分开 |

### 7.4 Rufus 三件套 —— 准入层

与 ⑤ 的"引用层"质检并列，但问题不同：⑤ 问"文案合不合规"，⑥ 问"能不能被 Rufus 纳入结构化比对"。

| 文件 | 职责 | 关键点 |
|---|---|---|
| `rufus-data.js` | 8 个产品类型的属性表 + 问题矩阵（只读数据） | `CATEGORY_ATTRIBUTES` / `CATEGORY_QUESTIONS` / `UNIT_GROUPS` / `MATERIAL_CONFLICTS` |
| `rufus-facts.js` | 事实抽取与判定 | 单位归一化（oz/lb/kg 歧义白名单）、跨字段事实比对、材质冲突（含否定语境）、问题覆盖（属性 vs 文本） |
| `rufus.js` | 规则表与执行 | 5 组（R1-R5）、7 条规则条目；R4 按问题展开为 R4-01…R4-0n |

**出处分级是硬约束**：`source` 三值（`amazon-guide` / `amazon-schema` / `practitioner`）→ `sourceTier` 两档（official / practitioner）。只有"官方帮助文档正文"（`amazon-guide`）才允许判 P 级；混合来源取**最弱**一档（`rufus.js:58-61`，宁低不许高）。未知 source 直接抛错，不静默归为 official。

界面纪律（`app.js:1264-1273`）：跳过项必须可见且带原因；结论文案只来自 `summary.conclusion`；C 级命中只说"命中"，不许渲染成"必须改"。

### 7.5 `amazon.js`（582 行）—— 页面解析

| 能力 | 入口 | 说明 |
|---|---|---|
| 详情页 | `extractFromDoc` (134) | 多组选择器逐个试；五点取第一个有内容的列表；主图优先 `data-old-hires` |
| 粘贴 HTML | `extractFromHTML` (204) | `DOMParser` 全程离线；ASIN 从 canonical 兜底 |
| 纯文本 | `extractFromText` (218) | 只保证标题 + 五点 |
| 统一入口 | `extractAny` (251) | JSON / HTML / 文本三分支；返回 `kind` 区分商品与搜索页 |
| 搜索页 | `extractSearchResults` (343) | 按 `data-component-type="s-search-result"` 切卡片；正则抠 ASIN/标题/价格/评分/评论/图；去重后才统计广告位 |
| 书签 | `bookmarkletSource` (471) | 生成可拖拽的 `javascript:` 脚本 |
| 转工作台 | `productToWorkbenchInput` (561) | 映射到 Listing 输入；media 类目同步口径 |

### 7.6 `competitor-keywords.js`（359 行）—— 竞品词权重

- `tokenize`：小写 → 去标点 → 去停用词/纯数字/单字符。
- `buildNgrams`：1/2/3-gram + 位置。
- `hasWord`（196）：**词边界匹配**，不是 `indexOf`。`rope` 命中 `ropes`、`box` 命中 `boxes`，但 `art` 不命中 `party`、`car` 不命中 `cardigan`。
- `analyzeKeywords`（232）：覆盖率 × 50% + 位置 × 30% + 精准度 × 20% → 1-10；单字且覆盖率 ≥90% 扣 1.2（防止"入场券词"挤掉长尾）；只保留出现在 ≥2 条标题的词。
- `blank`：覆盖率 ≤25% 且 n≥2 的差异化机会。
- `consistency`：产品联想词在**全部抓到的竞品**（≥5 条）里的命中率；样本不足时用勾选的那几条。
- `groupByAdvice`（350）：把词分成 must / mid / tail / backend 四档，供提示词使用。

### 7.7 `copy-prompts.js`（221 行）—— 文案提示词拼装

只拼文本，**不调模型**。5 类：`analysis` / `title` / `bullets` / `searchTerms` / `localize`。

- `buildHead`：产品 + 站点 + 类目 + 竞品样本（含榜单名次/星级/评论/价格），并明确声明"评论数是销量代理指标，从业者口径"。
- `buildRules`：产品对口校验、只统计不联想、不编参数。
- `buildRuleTitle`：从 `LIMITS` 取数，不手写；media 单独分支。
- `buildKeywordBlock`：把工具算好的权重表塞进去，并写明"直接采用，不要自己重算"。
- `buildCopyPrompt`（198）：前置校验（产品名必填、竞品必填、埋词表建议先跑），返回 `{ok,prompt,meta}`。

### 7.8 `bestsellers.js`（350 行）—— 唯一主动爬第三方的通道

- 8 个站点（`SITES`）、20 个类目（`CATS`）。
- `isAllowedAmazonUrl`（87）：https + 主机白名单 + 默认端口 + 路径必须是 `/gp/bestsellers/` 或含 `/zgbs/`。**端口也管**（`:8443` 会被拒）。
- `fetchHtml`（107）：`family:4`（避免 IPv6 不可达）、显式 Cookie `i18n-prefs=USD; lc-main=en_US`（否则按请求方 IP 返回 CNY）、手动处理 3xx 并**重新过白名单**、跳转上限 3 次。
- `decodeEntities`（179）：`&amp;` **最后**替换，避免 `&amp;lt;` 被双重解码。
- 缓存（286-314）：TTL 10 分钟，上限 40 条，`cachePut` 按插入序淘汰最旧。每条是一整页 HTML（1-3MB），不设上限会一路涨。
- `fetchBestsellers` / `fetchSubs`：白名单 → 缓存 → 重试（2 次）→ 解析；解析为空按上游故障报错。

### 7.9 `api.js`（234 行）—— 传输层

- 配置存 `localStorage["clx_listing_workbench_config"]`，`DEFAULT_CONFIG` 给出默认 baseUrl/model。
- `probeServer`（83）：2.5s 超时；成功缓存 60s，**失败缓存仅 5s**——因为"先开页面、后启服务"是常见顺序，失败结果赖着不走会让用户以为服务没起来。
- `streamSSE`（123）：按 `\n\n` 切帧，单条坏帧不影响整条流，`ping` 丢弃。
- 其余：`postChat` / `uploadImage` / `generateImage` / `callVision` / `callLLM` / `downloadText` / `downloadJSON`。

### 7.10 `store.js`（373 行）—— 本地产物

- 单库单 store（`clx_listing_workbench` / `items`），4 类：capture / plan / listing / coverage。
- 纯函数层可在 Node 断言：`fingerprint`（djb2）、`trimPayload`（超 400k 字符显式标 `__truncated`）、`makeRecord`、`sortRecords`、`pickEvictions`（每类 60 条）、`summarize`。
- `isAvailable()` 在 Node 返回 false，读写变安全空操作 → 降级路径被真实测到。

### 7.11 `app.js`（1931 行）—— 前端主控

| 区域 | 行 | 职责 |
|---|---|---|
| `ICONS` + `iconSvg` | 51 / 87 | 唯一图标注册表（图形片段 + 统一描边规格）；禁止 emoji 当功能图标 |
| 全局状态 `S` | 95 | 当前视图、消息、附件、探活结果、模板选择、listing、采集结果 |
| `boot` | 129 | 绑 9 组事件 → 渲染 → 探活 → 设置表单 → **最后** `enhanceSelects` |
| 导航 / 消息 | 186 / 227 | 7 视图切换；事件分发与渲染 |
| 发送 | 485 | 有参考图 → 图生图；否则 `runTurn` + 显式模板"读完即清" |
| 模板库 | 553 | 网格、详情、自动匹配预览、显式固定（只作用于下一条） |
| Listing 四卡 | 695-1435 | 限制表、实时计数、草稿、质检、Rufus、覆盖度、导出 |
| 竞品卡 | 912-1179 | 抓取、权重、提示词、世代号 |
| 采集 / 多竞品 | 1439 / 1613 | 解析分流、概览统计、一键送对比 |
| 图片库 / 产物 | 1668 / 1756 | `data/gen` 列表、打包、删除；IndexedDB 历史 |
| 设置 | 1855 | 保存到 localStorage / 写入服务端 `.env.local` / 重置 |

🔴 `boot()` 里 `enhanceSelects` **必须在最后**：先把所有下拉选项与初始值填完，再接管"点开"行为，否则按钮第一次显示空框。

### 7.12 `server.mjs`（936 行）—— 本地服务

**13 个路由**

| 方法 | 路径 | 作用 | 关键安全点 |
|---|---|---|---|
| GET | `/` 与 `/assets/*` | 静态资源 | **白名单**：只放行 `index.html` 与 `assets/`；其余 404（不报 403） |
| GET | `/api/health` | 能力探测 | 返回 image/chat/vision/storage/competitor + 模板数 |
| POST | `/api/config` | 运行时写密钥 | 只认 5 个键；baseUrl 必须 http(s)；**同源校验**（`Origin` 与 `Host` 不同源、或 `Sec-Fetch-Site` 非 same-origin/none → 403）；**只收 `application/json`**（否则 415，掐断 no-cors 简单请求）；**合并不覆盖**（读现有 `.env.local` → 只改提交的键 → 空值删除 → 原子写 0600）；回执只给键名 |
| POST | `/api/upload` | 参考图上传 | multipart 最小解析；只收 `image/*`；≤8MB |
| GET | `/api/blob?key=` | 图片代理 | 只允许 `gen/` `uploads/` 前缀；禁 `..` |
| GET/DELETE | `/api/library` | 图片清单 / 删除 / `?zip=1` 打包 | 文件名必须是纯文件名 + 扩展名白名单 + 前缀二次校验 |
| POST | `/api/image` | 生图 | 支持 txt2img / img2img（data URI）；同步/异步双适配 |
| POST | `/api/vision` | 识图 | 固定 JSON schema 提示词；解析失败给原文 |
| POST | `/api/llm` | chat completions 代理 | 三件套缺一即报错（可选能力） |
| POST | `/api/chat` | SSE 编排 | 心跳 5s；识图失败降级但要 `warn` |
| GET | `/api/competitor/categories` | 站点/类目/开关状态 | — |
| GET | `/api/competitor/bestsellers` | 实时榜单 | site/slug 白名单；`href` 必须过 `isAllowedAmazonUrl` |
| GET | `/api/competitor/subs` | 子类目 | 同上 |

**配置读取优先级**（`getEnv`，`server.mjs:171`）：`runtimeConfig`（设置页写入）> `process.env` > `.env.local` > `.env`。同名键 `.env.local` 赢。别名：`IMG_BASE_URL` 也认 `OPENAI_BASE_URL` / `OPENAI_API_BASE`。

**生图适配器**（`callImageAPI`，`server.mjs:566`；`detectMode` 在 560）：`detectMode` 按 baseUrl 含 `apimart` 判 async；异步为"提交 task → 等 12s → 每 4s 轮询，上限 180s"；同步兼容 OpenAI `b64_json` 与 `url` 两种返回。

**下载生图结果**（`downloadToGen`，`server.mjs:629`）：`assertPublicUrl` 校验 + `redirect:"manual"`（禁自动跳转，防绕过内网校验）。

**Host 校验**（`server.mjs:1778-1815` + `assets/net-guard.js` 的 `allowedHosts`）：绑回环时名单 = 回环 + `PUBLIC_HOSTS`；绑 `0.0.0.0` 且未配 `PUBLIC_HOSTS` 时不校验；平台后缀 `.app.workbuddy.host` / `.sandbox.cloudstudio.club` 按后缀放行（线上反向代理的 Host 就是后者）。

**环境变量**

| 变量 | 作用 |
|---|---|
| `PORT` / `HOST` | 监听地址，默认 `8787` / `127.0.0.1` |
| `LISTING_DATA` | 整块重定向 `data/`（自检脚本靠它不碰真实数据） |
| `COMPETITOR_SCRAPE=0` | 关闭竞品抓取（接口返回 `enabled:false`，不报错） |
| `LISTING_NO_KEY_WRITE=1` | 线上演示禁止写密钥 |
| `PUBLIC_HOSTS` | 额外允许的 Host（逗号分隔） |
| `IMG_*` / `CHAT_*` | 图片与对话模型配置 |

### 7.13 基础设施

| 文件 | 作用 | 关键实现 |
|---|---|---|
| `net-guard.js` (94) | SSRF + Host 白名单 | `PRIVATE_V4` 覆盖 RFC1918/回环/链路本地/CGNAT/基准测试/组播；`dns.lookup({all:true})` 后逐个 IP 判；拿不到合法 IP 时按私网处理（宁可误拒） |
| `zip.js` (176) | 零依赖 zip | 本地头 + 中央目录 + EOCD；上限 65546 条目 / 4GB；`inspectZip` 供自检解包核对 |
| `md.js` (135) | Markdown 渲染 | **先整体转义，再按白名单放行标签**；支持围栏代码、表格、列表、引用、行内 code/粗斜体/链接 |
| `select-ui.js` (279) | 原生 select 的自绘替身 | 原生控件保留为值仓库（`pointer-events:none;opacity:0`）；按钮 `role="combobox"`；弹层挂 `body` + `position:fixed`；视口上下翻转 + 左右收边；截获实例 `value` 存取器；`MutationObserver` 同步选项重建；选中后派发原生 `change` |

**为什么必须换掉原生下拉**：原生下拉是 OS 窗口，位置由 Chromium 算。本页祖先链是 `height:100vh;overflow:hidden` → `overflow:hidden` → `overflow:hidden` → `overflow-y:auto`，再叠 `devicePixelRatio=1.5`，实测弹层偏移达 `(-938,-194)`。CSS 无法干预——只能不用原生 popup。

---

## 8. 关键设计决策（改之前先读，别"优化"掉）

| 决策 | 原因 | 代价 |
|---|---|---|
| 编排确定性化，LLM 只润色 | 可复现、可断言、无 key 可用 | 语义理解不如 LLM，靠词表 + 正则 |
| 服务端复用 `runLocalTurn` | 两套实现必然漂移 | 服务端不能做"只有服务端能做的事" |
| 单张 Prompt 固定 9 段 | 每段对应一条铁律，auditPlan 逐段可查 | Prompt 偏长（上限 4000 字符） |
| 首图法规层与设计层分开 | 85-100% 是上架要求，35-40% 是构图要求，混用会"设计合规、上架被拒" | 多一套常量与分支 |
| 模板数据只生成不手改 | 上游 25 个 JSON 是唯一事实源 | 改模板要改上游再重跑 `npm run build:templates` |
| 显式模板只作用于下一条 | 粘性状态会让后续对话静默违背自动匹配 | 用户需重复点击 |
| 竞品抓取放服务端 | 浏览器直连被 CORS 拦；白名单必须在服务端 | 离线时该卡不可用 |
| 失败如实报错，不给假数据 | 假数据比没有更坏 | 界面会有"抓取失败"这类红字 |
| 静态资源白名单而非黑名单 | 黑名单挡不住根目录的普通文件（`.env.local` / `server.mjs`） | 新增静态文件必须登记 |
| 产物存 IndexedDB 而非 localStorage | 单条可达数百 KB | 隐私模式下不可用（已显式降级提示） |

---

## 9. 不变量与铁律（改代码前必读）

1. **派生值只有一处实现**。判据层只吃算好的指标；`titleLimit()` 是标题上限唯一入口；`titleLimit` / `LIMITS` 不许在界面重写三元。
2. **口径不许说第二遍**。`DEFAULT_SITE` 从 `bestsellers.js` 取，不许在 `server.mjs` 写 `"com"`；`KINDS.icon` 只存 id，图形只在 `ICONS` 写一遍。
3. **空值不等于通过**。质检 `skipped` 必须单独计数并展示原因；Rufus 跳过项必须可见。
4. **静默降级禁止**。识图失败 → `level:"warn"`；颜色无法 hex 化 → `hexUnrecognized`；载荷被裁剪 → `__truncated`。
5. **数据安全**：`bestsellers.js` 是唯一主动爬第三方的通道；`downloadToGen` 的 URL 必须当不可信输入；`/api/blob` 只认两个前缀；删除接口必须过 `safeImageName` + 前缀二次校验。
6. **验证脚本不碰真实数据**。`LISTING_DATA` 重定向；三套自检**顺序跑、不许并行**（否则会互相把对方的报告当变动）。
7. **UI 不用 emoji 当功能图标**。唯一例外是 `index.html` 侧栏那 7 个内联 SVG（静态页面拿不到 `ICONS`）。
8. **文件默认进不了分享包**。`tools/make-share-pack.py` 是白名单，新增文件要显式登记。

---

## 10. 数据契约（跨模块传递的结构）

### `Product`（`amazon.js:184`）

```js
{ url, site, asin, title, brand, bullets[], description, specs{}, breadcrumbs[],
  bestSellersRank, rating, reviewCount, price, image, capturedAt, _source }
```

### `SearchResult`（`amazon.js:411`）

```js
{ kind:"search", url, site, keyword, items:[{asin,title,price,rating,reviewCount,url,image,sponsored,text}],
  stats:{blocks,parsed,sponsored,withAsin}, note }
```

### `listing`（前端 `S.listing`，`app.js:759`）

```js
{ title, highlights, bullets[], searchTerms, description }
```

### `matchTemplate` 返回（`prompt-engine.js:675`）

```js
{ id, score, source:"explicit|keyword|context|fallback", reason, matched, templateName, signals[], candidates[], auto }
```

### `planImagePack` 返回（`prompt-engine.js:1133`）

```js
{ driver, subject, styleLock, amazonMain,
  counts:{main,hero,pdp,total},
  angleAudit:{hero:{distinctAngles,needDistinct,closeShots,needClose}, pdp:{...}},
  items:[{index,group,slot,code,purpose,templateId,size,angle,shot,background,headline,prompt,meta}] }
```

### 产物记录（`store.js:86`）

```js
{ kind:"capture|plan|listing|coverage", title, payload, meta, truncated, chars, createdAt, fingerprint }
```

---

## 11. 自检体系：怎么证明"它真的这么干"

| 套件 | 条数 | 跑什么 | 特点 |
|---|---|---|---|
| `tools/selftest.mjs` | **643** | 纯逻辑：Prompt 9 段、首图法规层、模板匹配排序、词频、规则命中、导出、store 纯函数、zip | 断言对象是**行为**（Prompt 里到底有没有那串约束），不是实现细节 |
| `tools/verify-server.mjs` | **290** | 真起 `server.mjs`、真发请求 | 目录穿越、Host 校验、SSRF、图片库路径、竞品参数白名单；进出各备份/还原 `.env.local` |
| `tools/browser-selftest.mjs` | **199** | 真起浏览器（CDP，Node 内置 WebSocket） | `file://` 不启动、真实渲染、IndexedDB 读写、下拉替身定位、事件链 |
| `tools/mcp-selftest.mjs` | **248** | 真起 `mcp/server.mjs`、真灌 JSON-RPC | stdout 纯度、工具契约、四态口径、6 份客户端配置可用性；结尾硬断言 `data/` 未变 |
| `tools/keywords-selftest.mjs` | **136** | 采集器 dry-run 到临时目录 | 种子口径、合并唯一性、陈旧四态、失败不覆盖、文件锁 |
| **产品三套合计** | **1132** | — | 顺序执行，全绿（MCP / 词库两套单独计，不入三套合计；`test:all` 已跑满五套 = 1516） |
| **五套合计** | **1516** | — | 顺序执行，全绿 |

辅助：`tools/check-doc-numbers.py` 核对文档行数与断言数（跑完会打印「全部一致（N 项）」）；`tools/make-share-pack.py` 打包后**解压到干净目录再跑一遍 selftest 与 mcp-selftest**。

---

## 12. 已知边界（诚实清单，别当成 bug 提）

- **无 LLM 也能跑**，但语言理解靠词表：没命中关键词时会回落 `01-hero-image`，并在 `reason` 里说明是兜底。
- **竞品抓取依赖亚马逊页面结构**：改版会解析为空，此时按上游故障返回 502，不给假数据。
- **搜索页只有标题/价格/评分/评论数**，没有五点与描述；做词频够用，要完整文案得用详情页采集。
- **评论数只是销量代理指标**，从业者口径，非官方销量。
- **关键词覆盖度是文本覆盖判定**，不是搜索排名、不是搜索量。
- **IndexedDB 在隐私模式/老浏览器不可用**：功能降级为"关页面不留档"，采集/质检/Prompt 不受影响。
- **线上演示不接写入密钥**（`LISTING_NO_KEY_WRITE=1`）：要配 key 得在本地跑。
- **未配图片 API 时图片库为空**，其余功能正常。
- **MCP server 不含关键词数据**（没搜索量 / 没 ABA / 没关键词库）：它只把判断层开放出去，数据层需要账号级 Token，无法随代码分发。它也**只做 stdio**，不提供网络端口，别挂到公网。
- **MCP 与网页是同一份判断代码**：界面上的边界（C3 只认中英、覆盖度不是排名）在 MCP 里一模一样，不会因为换了入口就更准。

---

## 13. 功能 → 代码位置速查

| 我要找… | 去哪 |
|---|---|
| 一句话怎么变成 Prompt | `orchestrator.js:252` `runLocalTurn` |
| 模板怎么被选中 | `prompt-engine.js:613` `matchTemplate` + `:512` `scoreTemplate` |
| 9 段 Prompt 长什么样 | `prompt-engine.js:939` `composePrompt` |
| 整套图怎么排 | `prompt-engine.js:1094` `planImagePack`（序列表在 `:805` / `:829`） |
| 合规自检查什么 | `prompt-engine.js:1191` `auditPlan` |
| 质检有哪些规则 | `listing.js:547` `RULES`；执行在 `:850` |
| 标题/亮点额度 | `listing.js:50` `LIMITS` + `:66` `titleLimit` |
| 草稿怎么拼 | `listing.js:965` `generateListingDraft` |
| 后台字段导出 | `listing.js:1168` / `:1247` |
| Rufus 规则 | `rufus.js:123` `RUFUS_RULES`；执行 `:318` |
| 事实/单位/材质判定 | `rufus-facts.js:149` / `:261` / `:347` |
| 亚马逊页面怎么解析 | `amazon.js:134` / `:343` |
| 竞品词权重怎么算 | `competitor-keywords.js:232` |
| 文案提示词怎么拼 | `copy-prompts.js:198` |
| 榜单怎么抓 | `bestsellers.js:326` + `:107` `fetchHtml` |
| 出网怎么防 SSRF | `net-guard.js:59` `assertPublicUrl` |
| 服务端路由表 | `server.mjs:904-924` |
| SSE 编排 | `server.mjs:639` `handleChat` |
| 前端事件分发 | `app.js:227` `dispatch` |
| 下拉为什么是自己画的 | `select-ui.js:1-30` 顶部注释 + `:45` `placePop` |
| 持久化怎么降级 | `store.js:154` `isAvailable` |

---

## 14. 给下一位 AI 的阅读顺序建议

1. 本文 §0–§6（建立全局）。
2. `assets/orchestrator.js:298-422`（一轮完整编排，读懂这段就懂一半）。
3. `assets/prompt-engine.js:939` + `1191-1244`（Prompt 结构与自检）。
4. `assets/listing.js:50-68` + `850-925`（口径与质检执行）。
5. `server.mjs:896-936`（路由与 Host 校验）+ `639-761`（SSE 编排）。
6. `assets/app.js:129-151`（boot 顺序）+ `485-540`（发送分流）。
7. 需要改代码前，读 §8–§9 与 `tools/selftest.mjs` 里对应断言。

**改完后必须做**：`node tools/selftest.mjs && node tools/verify-server.mjs`，涉及前端再跑 `node tools/browser-selftest.mjs`；三者顺序执行，全绿才算完成。
