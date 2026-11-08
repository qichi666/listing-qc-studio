# 跨境 Listing 质检工作台 · 全部功能细节与技术实现说明

> 本文档用途：**交给其他 AI 审阅，评估可优化之处**。
> 写于 2026-09-28；**最近一次同步 2026-11-08**（新增 §25 并全量重算 §0.2 / §1.1 / §1.3 / §10.2 / §12 的参数与计数）。
> 所有参数均从源代码实际导出（非手抄），源码见配套的《给AI审阅-源码合集.md》。
> ⚠️ **口径提醒**：§14 起的"轮次"章节（§14–§25）是**历史快照**，其中的断言数（289 / 469 / 509 等）是**当时**的值，刻意保留作对照。
> **当前值一律以 §0.2 与 §10.2 为准。** 这条不是口头约定：`tools/check-doc-numbers.py` 只核对 §0–§13，
> 并对 §14 起的变更记录**打印跳过的行号**（静默跳过＝没写这条检查）。

---

## 0. 给审阅者的话（请先读这 6 条）

### 0.1 这个项目是什么

一个**本地优先**的跨境电商视觉与文案工作台。输入一句产品描述，输出**可直接使用的图片生成 Prompt**（单张或整套 14 张）、**Listing 文案草稿**与**合规质检报告**。

**核心设计主张**：把"跨境电商图片生成"的行业规则（来自一个 30KB 的 Skill 文档）**逐条翻译成可执行、可断言的代码**，而不是交给大模型"自觉遵守"。

### 0.2 已经验证到什么程度（请不要建议这些）

- **642 条断言 / 52 个测试节，全部通过**（`npm test`；本机实测输出「共 642 条断言：通过 642，失败 0」），覆盖六条铁律、多角度规则、整套规划、图生图、关键词挖掘、28 条质检规则与合规词表（含 2026-07-27 标题新规）、数据采集、Markdown XSS、编排层、英文支持、**亚马逊首图法规层**、服务端安全、前端接线、**搜索结果页批量采集**、**多竞品对比**、**多语种站点与词表**、**本地持久化（IndexedDB）**、**零依赖 ZIP 打包**、**图标注册表一致性**、**Rufus / Alexa 信息架构检查（P0-1，含对抗性与反向断言）**、**竞品实时抓取（出网白名单 + 本地关键词权重模型）+ 文案提示词拼装（含字符口径反向锁）**。
- **另有一套独立的安全回归**：`npm run test:server` → **290 条**，真起一个 `server.mjs` 真发请求，覆盖 SSRF 判据、静态目录穿越、Host 头校验、配置原子写、图片库清单/打包/删除、**竞品抓取接口的参数白名单（13 类非法参数 × 2 条路由，全部在发出网络请求之前就 400）**、**外部数据源（第三方 MCP）的门禁与示例数据**。
- **第三套：浏览器侧端到端自检**：`node tools/browser-selftest.mjs` → **199 条**。它**真起一个无头 Edge/Chrome（CDP 直连，零依赖）**，验证「页面 JS 真的跑起来了」（不是源码级断言）、8 个视图逐个点开、真点按钮走完「采集 → 一键送多竞品对比 → 语种自动带成 de → 共识词不含虚词」的闭环，并加载 `assets/selftest-browser.html` 在真实 IndexedDB 上跑真往返断言（页面底部会打印实际条数）。**本轮追加第 ⑥ 组：第 ⑦ 卡（竞品抓取 → 关键词权重 → 文案提示词）** —— 这一组会真去抓一次亚马逊榜单，**允许失败，但失败必须如实报错**，所以它的断言条数随网络环境浮动（详见 §22）。
- **三套合计 1131 条**（642 + 290 + 199）。
- **另有两套不并入三套合计的**：MCP 协议自检 `npm run test:mcp` → **248 条**（真起 MCP 进程灌 JSON-RPC）；词库链路自检 `node tools/keywords-selftest.mjs` → **136 条**（种子表 / 合并唯一性 / ASIN 字段对齐 / 陈旧四态 / 采集器 dry-run 实跑 / 状态文件 / 文件锁）。分开计是因为它们启动子进程、写入临时目录，与三套「纯函数 + 起服务 + 起浏览器」的定位不同。
- **含有"反向测试"**：故意破坏 Prompt / 故意算错后，自检必须报错（`auditPlan` 反向测试、首图 4 条硬约束的反向测试、缺留白反向测试、信息架构未超限反向测试、HTML 标记反向测试）。所以"建议加测试"不是有效建议，请指出**测试覆盖的盲区**。
- **零 npm 依赖、零构建步骤**，浏览器端原生 ESM。

### 0.3 已经明确决定不做的事（克制清单，别重复建议）

| 不做 | 原因 |
|---|---|
| 服务端爬虫抓亚马逊 | 会被反爬（Cloudflare + WAF + TLS 指纹）；且抓到的内容未必等于用户实际所见。改用书签脚本 + 粘贴，**含搜索结果页整页批量采集**。 |
| 用户账号体系 / 云同步 | 本地优先，密钥与数据不出本机。 |
| 自动调价 / 自动投放 | 涉及资金操作，风险不可控。 |
| 引入服务端数据库 | 单一用户、单机运行，服务端建库只会增加部署成本。**本地持久化用的是浏览器 IndexedDB**（见 §16.4），数据仍在本机，且可导出成 JSON 带走。 |
| 把所有环节都交给 LLM | 会让结果不可复现、没 key 就跑不起来。**这是刻意选择，不是能力不足。** |
| 接官方 Brand Analytics / 第三方关键词工具拿真实搜索量 | 需要卖家账号与付费订阅。所以 `mineKeywords()` 只做**词频**，并在界面显式声明"这不是搜索量"（`disclaimer.isSearchVolume = false`）。 |
| 把质检词表做成"越多越好" | **误报＝工具失信**。官方疾病表里 7 个词（`add`/`sad`/`mono`/`pid`/`crabs`/`tbi`/`ngu`）被**刻意剔除**，因为它们会命中 "Add to cart"、"Sad puppy"、"PID controller"、"mono output"、"crabs" 等正常商品文案。同理不收 `perfect`、不把 `% # +` 放符号黑名单。 |
| 把「五点大写引导词」当硬规则 | 它是行业惯例而非平台规则，放硬规则会让格式问题被报成"发布前必须修改"。已降级为 C。 |

### 0.4 请重点审这 8 个问题

1. **判据的正确性**：28 条 Listing 质检规则（+ **7 条 Rufus / Alexa 信息架构规则**，见 §20）的阈值与依据是否有明显错误或过时？有没有遗漏高频平台规则？
   ⚠️ 先说清楚：**「标题里品牌该前置还是后置」和「日本站标题是否按全角字符计数」这两条已经被核验过**——
   前者：亚马逊官方标题公式是 `[Brand] + [Primary Keyword] + ...`，且 A9 对品牌前置标题优先加权，**品牌后置反而丢权重**；
   后者：官方 FAQ 明确 character-based（任何语言都按字符，全角按 1 计），**真按字节计的只有 Search Terms**。这两条不必再提。
2. **机械自检的盲区**：`auditPlan` 只能验"Prompt 里写没写某约束"，验不了"生成出来的图对不对"。在**纯文本层面**还有可加的一层验证吗？
3. **确定性编排与模型编排的边界**：哪些环节其实该交给模型（如卖点提炼、痛点挖掘），哪些绝不该？现在的划分是否合理？
4. **主体抽取的鲁棒性**：现已支持中文与英文两套（英文走 `图类型 + of/for + 产品` 语序）。面对**长句、多产品混写、中英混排、口语化输入**还会崩吗？有没有更优方案？（§14/§16 有 24 个用例可对照）
5. **模板匹配算法**：目前是"最长匹配 > 位置最靠前 > trigger_phrase 优先"的快照排序。是否值得换成 TF-IDF / 向量相似度？代价是什么？
6. **前端架构**：单文件 `app.js`（**4894 行 / 246.5 KB**）是否该拆分？SSE 事件协议（7 种事件）设计是否合理？
7. **安全**：现在有 SSRF 拦截（协议白名单 + DNS 解析后按 IP 判内网 + 禁自动重定向）、静态服务白名单（仅 `index.html` + `assets/`）、Host 头校验、配置原子写。**已知残留**：DNS rebinding 的 TOCTOU 窗口（Node 内置 fetch 不支持 pin IP）。这台机器上还有哪些绕过路径？
8. **🆕 Rufus / Alexa 信息架构检查（§20）的判据是否站得住**：这个模块是纯机械匹配（不调模型），核心假设是"listing 里字段填了 / 文案里提到了 / 事实对得上 / 单位没打架 / 图上文字也写进文案了，Rufus 才引用得到"。
   请重点质疑三处：① **R4 的覆盖判据用 OR**（`answerHints` 的 key 命中任一即算覆盖）—— 这个松紧度对吗？
   ② **R2 的 guard 是字段级二值**（字段内命中任一"部件/混纺"词，该字段对该材质对的提及全部作废）—— 我们**明确知道它会造成漏报**（`Leather Belt` 标题 + `Faux Leather Strap` 描述不报），但收窄会让大量合法表述变误报；
   ③ **R5 只做"图内文字 ↔ 文案"的逐字比对**（不做 OCR、不做词序/同义词归一）—— 保守到什么程度才合适？
   我们已经把这些边界写成 §8 的十五条"诚实边界"+ 断言，**请指出我们没想到的那一条**。

### 0.5 上下文提示

- **运行时代码**（`index.html` + `server.mjs` + `assets/*.js`，**不含**生成物与样式）约 **506 KB**。
  若上下文有限，**优先看批次 A（核心规则引擎，约 273 KB）**：`prompt-engine.js` 62.3 + `orchestrator.js` 36.1 + `listing.js` 86.3 + `rufus-data.js` 54.7 + `rufus-facts.js` 17.9 + `rufus.js` 15.9。
- `assets/templates.js`（78.6 KB）是**生成的模板数据**，不是逻辑，已从合集排除（结构见 §9.1）。
- `assets/app.css`（18.1 KB）是样式，已排除。

### 0.6 诚实边界（审阅时应知情）

这是一个**求职作品集级别的复刻实现，未经真实卖家工作流验证**。所有数值（产品占比、留白、角度）都是**规则阈值**，不是 A/B 实验结果。请按"设计合理性"而非"运营效果已被证明"来评估。

---

## 1. 项目总览

### 1.1 基本信息

| 项 | 值 |
|---|---|
| 形态 | 本地 Web 应用（单页 + 可选本地服务） |
| 技术栈 | 原生 ESM JavaScript + 原生 CSS；服务端 Node 原生 `http` |
| 依赖 | **零**（`dependencies: {}`、`devDependencies: {}`） |
| 构建 | **无**（无打包器、无转译） |
| 规模 | **51 个源码 / 工具文件**，约 1887 KB（口径 = 下节 §1.3 全表；其中生成物 `assets/templates.js` 占 78.6 KB） |
| 运行 | `node server.mjs` → `http://127.0.0.1:8787/` |
| 离线能力 | 除"真出图/识图"外，全部功能可离线使用 |

### 1.2 为什么是"双路径架构"

```
浏览器端（原生 ESM）
  index.html
  assets/app.js           视图路由 / 事件分发 / 渲染
    ├─ prompt-engine.js   规则引擎：六条铁律、Prompt 组装、机械自检
    ├─ orchestrator.js    编排：六步流程 + 主体抽取 + 简报生成
    ├─ listing.js         关键词挖掘 + 28 条质检规则 + 草稿生成 + 后台字段导出
    ├─ amazon.js          选择器表 + 书签脚本 + 三种输入解析
    ├─ rufus-data.js      Rufus 属性 / 问题 / 单位 / 材质 数据（纯数据层，零 import）
    ├─ rufus-facts.js     Rufus 事实层（纯判定，可单独在 Node 断言）
    ├─ rufus.js           Rufus 规则引擎（R1~R5；只从 rufus-data.js 读数据）
    ├─ templates.js       模板数据（生成物）
    ├─ store.js           本地持久化（IndexedDB；纯函数层可在 Node 断言）
    ├─ zip.js             零依赖 ZIP 打包器
    ├─ net-guard.js       SSRF 防护 + Host 白名单
    ├─ api.js             探活 / SSE 客户端 / 上传
    └─ md.js              极简 Markdown 渲染（防 XSS）
                  │
                  │ ① 先探测 /api/health（2.5s 超时）
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
   探测成功              探测失败
   → 走服务端编排         → 走本机编排（runLocalTurn）
   → 可真出图             → 只出 Prompt
   server.mjs（9 个接口）
```

**同一个 `runLocalTurn` 被两条路径共用**（服务端 `import` 复用，不重写）。
⚠️ 这一点曾是缺陷来源：服务端一度有一份**自己手写的主体抽取与简报拼装**，导致"离线路径修好了、服务端还是旧行为"。现在自检里有**源码级断言**防止复发。

### 1.3 目录结构与职责

> 行数口径 = **原始行数**（`wc -l`，含空行与注释）。下表所有数字都按这个口径，不用"非空行 / 代码行"。

| 文件 | 原始行数 | 职责 |
|---|---|---|
| `index.html` | 874 行 | **8 个视图**的 DOM 骨架 + `file://` 启动告警 |
| `server.mjs` | 2490 行 | 零依赖本地服务，**25 个接口**（health/chat/llm/vision/image/upload/blob/config/library/keywords/keyword-roots（GET+POST）/export + `competitor/categories` · `bestsellers` · `subs` + `external/providers` · `test` · `call` · `import` · `terms`；配置自检 `config/test`；历史快照 `snapshots`（GET+POST）；抠图代理 `plugins/rembg`）+ 安全护栏 |
| `assets/prompt-engine.js` | 1375 行 | 规则引擎（铁律、模板消费、Prompt 组装、首图法规层、自检） |
| `assets/orchestrator.js` | 712 行 | 编排层（六步流程、中英文主体抽取、简报） |
| `assets/listing.js` | 1800 行 | Listing 质检（28 条规则 + 12 张词表 + 站外引流模式）、草稿（**标题溢出搬进 Highlights**）、后台字段导出 + **Flat File CSV**、关键词挖掘与**多竞品对比**、覆盖度分析、**按语种分表停用词**、**2026-07 标题新规口径（75 + Item Highlights 125）** |
| `assets/amazon.js` | 678 行 | 数据采集：**21 个 Marketplace**、详情页解析、**搜索结果页整页批量解析**、书签脚本双模式 |
| 🆕 `assets/rufus-data.js` | 786 行 | **Rufus / Alexa 信息架构检查 · 纯数据层**（8 类目属性表 / 8×10 问题矩阵 / 6 族单位 / 15 对互斥材质）—— 不 import 任何模块，浏览器与 Node 都能直接用 |
| 🆕 `assets/rufus-facts.js` | 396 行 | **Rufus · 事实层（纯判定）**：字段文本抽取、数值+单位提取、跨字段提及对齐、材质冲突、覆盖判据、图内文字比对 |
| 🆕 `assets/rufus.js` | 364 行 | **Rufus · 规则引擎**（R1~R5 共 7 条规则 + 出处分级的唯一映射点 + `summary` 汇总）—— 不写死任何属性 key |
| `assets/app.js` | 4894 行 | 前端外壳（8 视图路由 / dispatch / 渲染 / 图片库 / 本地产物 / **实时计数与限值表** / **Rufus 检查卡渲染** / **第 ⑦ 卡：竞品抓取 → 权重 → 文案提示词**） |
| `assets/api.js` | 234 行 | 传输层（SSE / 探活 + **双档 TTL 缓存**） |
| `assets/store.js` | 408 行 | **本地持久化层（IndexedDB，零依赖）**，纯函数层可在 Node 里断言 |
| `assets/zip.js` | 194 行 | **零依赖 ZIP 打包器**（`node:zlib` 的 `crc32` + 自写结构头 + ZIP64 越界闸门） |
| `assets/md.js` | 135 行 | Markdown 渲染 |
| 🆕 `assets/select-ui.js` | 279 行 | **原生 `<select>` 的自绘替身**（渐进增强）：原生控件保留为取值仓库，弹层挂 body + `getBoundingClientRect` 定位 + 视口翻转/收边 —— 原生 popup 的位置页面改不了，只能不用它 |
| `assets/net-guard.js` | 175 行 | **SSRF 防护 + Host 白名单**（独立模块，便于被自检引用） |
| 🆕 `assets/competitor-keywords.js` | 359 行 | **竞品关键词本地内核**：20 类目提示 / 19 个品类词 / 107 条子类目提示 / 139 个停用词 + 1–3 gram 切词 + 权重模型（覆盖率×50% + 位置×30% + 精准度×20%）—— **纯本地，零网络、零依赖** |
| 🆕 `assets/bestsellers.js` | 445 行 | **亚马逊 Best Sellers 实时抓取**（只用 Node 内置 `https`/`zlib`/`dns`）：8 站主机硬白名单 + 地址形状白名单 + `assertPublicUrl` + 10 分钟缓存 —— **全项目唯一主动爬第三方站点的通道** |
| 🆕 `assets/copy-prompts.js` | 221 行 | **文案提示词拼装**（纯函数、零网络）：5 类提示词，字符上限**全部**取自 `listing.js` 的 `LIMITS` / `titleLimit()`，不写第二份 |
| `assets/templates.js` | 生成物 | 25 个模板数据（1994 行 / 78.6 KB） |
| `assets/app.css` | 873 行 | 样式（手写，不引 CDN） |
| `assets/selftest-browser.html` | 216 行 | **浏览器里跑的真往返断言**（IndexedDB / 采集 / 对比 / 词表 / 标题新规 / CSV） |
| 🆕 `assets/amazon-suggest.js` | 126 行 | **搜索建议接口的唯一实现**（mid/lop 表 + URL 拼装 + 解析 + 不静默降级）：MCP 与每周采集器共用这一份，谁都不许再拼第二份 |
| 🆕 `assets/keyword-seeds.js` | 168 行 | **词根种子表（纯数据）**：13 组 / 194 条人工挑过的英文词根 —— 词根是人的判断，长尾才是机器的活 |
| 🆕 `assets/keyword-vault.js` | 526 行 | **快照合并的唯一口径**（纯函数）：firstSeen 继承、新增/消失、ASIN 去重保最小名次、上限截断、陈旧**四态**、首次/回归三态、digest 投影、三种排序 |
| 🆕 `assets/keywords-store.js` | 200 行 | 快照**只读**落盘层（Node 专用）：**没有写函数** —— MCP 与服务拿不到写入口，靠的是一个不存在的函数 |
| 🆕 `assets/csv.js` | 162 行 | **RFC 4180 CSV 编解码**（浏览器 / Node 共用纯函数）：UTF-8 BOM、逗号 / 引号 / 换行转义、往返相等 —— `/api/export` 与前端导出按钮共用这一份，不写第二套 |
| 🆕 `assets/score.js` | 303 行 | **Listing 健康分**（项目自定义加权，**不是官方评分**）：8 维权重单源合计 100、硬规则命中封顶 55、扣分项带 ruleId / source / fix、**缺数据维度按已计权重归一（不补 0 也不补满分）** |
| 🆕 `assets/reviews.js` | 303 行 | **评论 VOC 本地分析**：14 个方面的词表聚类（同一词表两种情感：痛点 / 好评）、高频疑问、词频候选；样本 <5 标注"只出线索"，不装成结论 |
| 🆕 `assets/image-audit.js` | 307 行 | **成图体检（纯像素，Canvas 原生）**：8 点采样判背景是否接近纯白、商品占比 ≥85%、最长边三档、透明通道、格式与体积；**不做 OCR、不判 Logo**，文字只给线索 |
| 🆕 `assets/snapshots.js` | 144 行 | **历史快照 + 迷你趋势图**：字段缺失给 `null` 不补 0；不插值、不预测，两点才画，断点处 `M` 重新起笔不连线；时间不全时退回序号轴并说明 |
| 🆕 `assets/aplus.js` | 304 行 | **A+ 模块骨架**（品牌故事 / 对比表 / 模块网格）：结构 + 写作预算（**自称建议值，不冒充平台硬限制**）+ 配图提示词；合规自检**复用 `listing.js` 的词表**，不造第二份 |
| 🆕 `assets/batch-lint.js` | 209 行 | **批量质检**：`---` 分块 / ASIN 与标签解析 → 逐条跑同一套规则与健康分 → **硬规则命中优先于分数排序**；口径写清是"同口径部分维度分（61/100）" |
| 🆕 `assets/csv-import.js` | 251 行 | **第三方关键词 CSV 导入**：分隔符嗅探、表头别名（Helium 10 / JS / 卖家精灵 / 中文）、搜索量解析（`1,200` / `12K` / `1.2万`）；**不猜列、不估算**，千分位异常标"存疑" |
| 🆕 `assets/keyword-roots.js` | 228 行 | **G-4 词根覆盖层**（纯函数）：基线 194 条 + `data/keywords/roots.json` 的 added / removed / renamed；非法项进 `rejected` 并给理由，读坏退回基线并说明，绝不中断采集 |
| `tools/build-templates.mjs` | 119 行 | 模板数据生成 |
| `tools/selftest.mjs` | 5535 行 | **642 条断言 / 52 节** |
| `tools/verify-server.mjs` | 1119 行 | **290 条断言** / 独立的安全回归（真起服务） |
| `tools/browser-selftest.mjs` | 1032 行 | **199 条断言** / **真起无头浏览器（零依赖 CDP）**；含「原生对话框一律自动取消并记录」，避免 confirm 卡死渲染线程 |
| 🆕 `tools/assert-count.mjs` | 42 行 | **断言数守卫**：少于期望 = 失败（删断言 / 集合变小会立刻红），多于期望 = 提示更新期望值 |
| 🆕 `tools/expected-counts.json` | 8 行 | **五套**断言数的唯一事实源（**只许上调**）：三套产品回归 + MCP 协议自检 + 词库自检 |
| 🆕 `tools/mcp-selftest.mjs` | 1290 行 | **248 条断言** / 真起 MCP 进程、真灌 JSON-RPC：stdout 纯度、工具契约、四态口径、6 份客户端配置可用性；**另起本地 mock MCP 服务**验 Streamable HTTP 客户端（SSE/JSON 双格式、会话 id、超时、401）与外部词表归一；结尾硬断言 `data/` 未变（采集器写的 `keywords/` 除外） |
| 🆕 `mcp/server.mjs` | 887 行 | **MCP server（stdio，零依赖）**：8 个工具把判断层暴露给外部客户端；日志只走 stderr，stdout 只放协议消息；`--no-net` 关掉唯一联网工具 |
| 🆕 `mcp/handler.mjs` | 174 行 | **回环 HTTP 的纯请求处理层**：Host / Origin / Bearer / `?token=` 降级四道门、method 与 path 路由；不监听端口、不写文件、不碰真实 req/res |
| 🆕 `mcp/http.mjs` | 134 行 | **回环 HTTP 进程入口**：只绑 `127.0.0.1:8790`，复用 `mcp/server.mjs` 的同一个 `handle()`；让客户端填一个 URL 就能接上 |
| 🆕 `tools/collect-keywords.mjs` | 674 行 | **每周词库采集器**：194 个词根 → 搜索建议 → 13 个类目榜单 → ASIN；合并上一份保 firstSeen。**一句话都不通时拒绝写盘（exit 2）** |
| 🆕 `tools/keywords-selftest.mjs` | 519 行 | **136 条断言**：种子口径、合并唯一性、ASIN 字段对齐、陈旧四态、采集器实跑（dry-run 到临时目录）、失败不覆盖、状态文件/文件锁、词面契约 |
| 🆕 `tools/schedule-weekly.ps1` | 153 行 | **本机计划任务注册**（周日晚 22:00）：node 绝对路径 + IgnoreNew 并发策略 + `-DryRun` 不真注册；为什么不用 GitHub Actions —— 这个目录没有 `.git`，定时任务一次都不会触发 |
| 🆕 `assets/mcp-http.js` | 217 行 | **Streamable HTTP 版 MCP 客户端**（我们当客户端去连第三方数据源）：一个 POST 一条 JSON-RPC、SSE 与 JSON 两种响应都认、回带 `Mcp-Session-Id`、通知不等回包。**只做传输**：不认厂商、不读配置、不做白名单（白名单必须在上层用常量钉死，否则它就是 SSRF 跳板） |
| 🆕 `assets/term-normalize.js` | 169 行 | **外部词表归一（纯函数）**：把各家的 `keyword / searchTerm / …` 与 `searches / volume / …` 猜成 `{term, volume, rank}`；猜不出来返回 0 条并说明原因 —— **不编数据**，字段映射原样回报 |
| 🆕 `examples/mcp-demo.mjs` | 399 行 | **可执行的接入示例**：零依赖手写 stdio 客户端，把 8 个工具逐个真调一遍（握手 / 通知不回包 / 列工具 / 调用 / 错误路径 / 收尾），29 条断言，退出码 0/1 可直接当冒烟测试 |

---

## 2. 模块一：Prompt 引擎（`assets/prompt-engine.js`）

### 2.1 用途

把"一句产品描述"变成"一段结构完整、约束齐备的图片生成 Prompt"，并**机械校验**它是否满足六条铁律。

### 2.2 操作流程（核心：`composePrompt` 的 9 段结构）

严格对齐参考 Skill 文档的段落顺序：

| 段 | 内容 | 为什么必须在这 |
|---|---|---|
| 1 | Campaign Style Lock（多图任务第一段，逐字相同） | 保证整套图风格不漂移 |
| 2 | 主体和场景（**详情页以 `E-commerce infographic layout —` 起头**） | 详情页不是"多角度产品照" |
| 3 | 目的与情绪 | 让模型理解这张图的职责 |
| 4 | 构图 / 镜头 / 取景（**显式写角度关键词**） | 不写角度，模型会总是给正面图 |
| 5 | 光线、颜色、材质纹理（颜色一律 hex） | 铁律 1 |
| 6 | 风格与真实感等级 | — |
| 7 | **平台限制与画幅**（比例 + 产品占比数字 + 留白下限） | 铁律 2 / 3 / 5 |
| 8 | **图片内文字**（三层信息架构） | 铁律 6 |
| 9 | 否定清单 + Anti-AI 处理 | 铁律 4 |

### 2.3 功能点明细

#### 2.3.1 铁律 1 · 颜色必须用 hex（`hexify`）

- **用途**：把"高级灰背景""deep green"这类形容词换成 hex。因为模型对形容词的理解不稳定，对 hex 稳定。
- **流程**：按序用 `COLOR_WORDS` 表逐条正则替换 → 返回 `{ text, applied[] }`。
- **关键参数**：42 个色值（见 §2.4 表）。
- **三条排序/防误伤规则**（每条都是踩坑后加的）：
  1. 更具体的写在更笼统的前面（`米白` 先于 `白色`、`深灰` 先于 `灰色`），否则会被吃掉。
  2. **不写裸的 `白`** —— 会把"米白"打成"米#FFFFFF"。
  3. 🔴 **单字色词必须带后缀**（`黑色` 可以、裸 `黑` 不行）。否则"金**属**质感"→`#D4AF37属质感`、"网**红**"→`网#C0392B`、"粉**末**"→`#E8B4B8末`。
- **已知取舍**：宁可有漏网（用户写"背景用灰"不转换），也不能误伤产品描述。

#### 2.3.2 铁律 2 / 3 · 数字化占比与显式留白（`FIGURE_SPEC` + `pctText`）

- **用途**：把"产品大一点"变成"product occupies 35-40% of the frame"，把"留白多一些"变成"at least 45% clean whitespace"。
- **流程**：按 `figure` 取区间 → 区间写 `35-40%`、单值写 `~40%`（避免 `40-40%` 读不通）。
- **关键参数**：7 种图型（见 §2.4 表）。

#### 2.3.3 铁律 4 · 否定清单（`negativeConstraints`）

- **用途**：明确列出**不要什么**。不写否定清单时模型倾向于加装饰、加手、加水印。
- **流程**：基础 7 项（`BASE_NEGATIVE`）+ 按 `templateId` 追加场景化禁止项。
- **关键参数（示例，hero-image）**：
  `Do NOT add: props not requested, hands, watermarks, fake logos, extra text, decorative elements, gradient backgrounds.`

#### 2.3.4 铁律 6 · 三层信息架构（`infoArchitecture`）

- **用途**：约束图内文字为三层（核心承诺 / 关键证据 / CTA），并**返回超限告警**。
- **流程**：检查三层各自字数 → 超限写入 `problems[]` → 由 `auditPlan` 汇总。
- **关键参数**：headline ≤15 字、evidence ≤3 个（超出 `slice` 截断）、CTA ≤8 字。
- **注意**：这三个数值是**项目自定义口径**（来自 Skill 文档），不是平台规则。

#### 2.3.5 多角度镜头规则（`assignAngles`）

- **用途**：保证一套图里角度有变化，避免 14 张全是正面图。
- **流程**：**确定性轮转**（不用随机 —— 随机就不可复现、无法写断言）→ 返回 `{ slots[], audit{} }`。
- **关键参数**：6 种角度 × 5 种景别（见 §2.4 表）。
- **审计口径实测**：

| kind | 张数 | 要求角度种数 | 要求特写/微距 | 实得 |
|---|---|---|---|---|
| hero | 5 | ≥3 | ≥1 | 5 种 / 特写 2 张 |
| pdp | 9 | ≥4 | ≥2 | 6 种 / 特写 3 张 |

- **其他约束**：不能连续 3 张同角度；全景占比 ≤40%。
- **实测主图角度槽位**：`front34 → high45 → side90 → lowup → topdown`

#### 2.3.6 转化驱动力诊断（`diagnoseConversionDriver`）

- **用途**：判断这个产品该走"视觉驱动 / 痛点驱动 / 情感价值驱动"，因为三者的**主图推进顺序完全不同**。
- **流程**：关键词命中计分 → 取最高分 → 同时返回置信度、命中词、推荐推进顺序。
- **关键参数**：三种驱动 × 各 5 张主图的固定序列（见 §2.4）。

#### 2.3.7 品类识别（`detectCategory`）

- **用途**：识别品类后套用该模板的 `category_tips`（同一模板在不同品类的调整建议）。
- **流程**：8 个品类关键词匹配 → 返回 `{ category, reason }`。
- **关键参数**：识别不出时返回 `null`（**不猜**）。

#### 2.3.8 模板匹配（`matchTemplate`）

- **用途**：从 25 个场景模板里选出最合适的一个。
- **流程**：把所有模板的 `keywords` 与 `trigger_phrases` 逐个在输入文本里定位 → **快照排序**：
  1. 匹配词更长优先（`使用场景`(4) 胜 `场景图`(3)）
  2. 位置更靠前优先
  3. `trigger_phrase` 优先于 `keyword`
- **关键参数**：显式指定模板时直接返回（`source: "explicit"`）；完全无匹配时回落 `hero-image`（`source: "fallback"`）。
- **⚠️ 这是本模块最值得审的地方**：当前是纯字符串启发式，见 §0.4 问题 5。

#### 2.3.9 Style Lock（`buildStyleLock`）

- **用途**：一次建锁，14 张复用同一段，防止"整套图风格漂移"。
- **关键参数**：10 个维度（视觉方向 / 固定色板 / 冷暖调 / 字体 / 背景 / 光线 / 布局 / 图标 / 产品呈现 / 禁止漂移项）。

#### 2.3.10 视觉节奏（`rhythmBackground`）

- **用途**：连续多张图背景不能完全一样。按 `#FFFFFF → #F5F1E8 → #1A3A2E` 循环。

#### 2.3.11 模板拍平（`flattenTemplate`）

- **用途**：把模板的 `prompt_template`（开放式 schema，66 种字段）转成自然语言片段，并应用风格变体与品类建议。
- **流程**：合并 `defaults` + `prompt_template` → 应用 `variants[key].overrides` → 追加 `category_tips` → 变量插值 → hex 化。

#### 2.3.12 整套图片包规划（`planImagePack`）

- **用途**：一次规划 5 张主图 + 9 张详情页 = 14 张。
- **流程**：诊断驱动 → 选主图序列 → 追加详情页序列 → 分配角度槽位 → 逐张 `composePrompt` → 返回 `{ driver, styleLock, counts, angleAudit, items[] }`。
- **关键参数**：
  - 画幅**按组定**：主图组一律 `1024x1024`、详情页组一律 `768x1024`。
    ⚠️ 这里曾按 `figure` 定，导致痛点驱动的 H5（figure=feedAd）拿到 4:3，与"主图必须 1:1"冲突。
  - 详情页**必须**以 `E-commerce infographic layout —` 起头且含 `feature callout icons`。

#### 2.3.13 机械自检（`auditPlan`）

- **用途**：对整套规划做逐张校验，返回问题数组（空数组 = 通过）。
- **9 条判据**（每张都查）：
  1. Prompt 以同一段 Style Lock 开头
  2. 含数字化产品占比（铁律 2）
  3. 含显式留白（铁律 3）
  4. 含 `Do NOT add:`（铁律 4）
  5. 含 hex 颜色（铁律 1）
  6. 含**比例**而非像素的画幅（`aspect ratio \d+:\d+`）
  7. 详情页以 `E-commerce infographic` 起头
  8. 详情页含 `feature callout icons`
  9. 全局：不能连续 3 张同角度；全景占比 ≤40%
- **⚠️ 已知盲区**：以上全是**文本层面**的检查，无法验证"图生成出来是否符合"。见 §0.4 问题 2。

#### 2.3.14 图生图（`composeImg2ImgPrompt`）

- **用途**：有参考图时，保留产品身份（图案/颜色/材质），只换场景与姿态。
- **关键约束**：**不写 `preserve composition`** —— 写它会锁死构图，与"换场景"目的矛盾。

#### 2.3.15 像素→比例转换（`toRatioText`）

- **用途**：前端传的是像素（`1024x1024`），但 Prompt 里要写比例（`1:1`）。
- **为什么单独存在**：曾直接把像素写进 Prompt，导致自检报"缺少画幅比例"14 次。

### 2.4 关键参数表（从代码导出）

> 🔴 本节**不是手抄的**：下面的内容由 `tools/_export-details.mjs` 从代码导出成片段，
> 再由 `tools/_sync-details-doc.mjs` **整段替换**进本文档。两步，顺序不能换：
>
> ```bash
> node tools/_export-details.mjs > tools/_details.out
> node tools/_sync-details-doc.mjs
> ```
>
> **为什么不合成一条命令**：`execFileSync(process.execPath, …)` 在 Windows 上会 `EBUSY`（同 exe 自调用，实测踩过）。
> **为什么不直接编辑下面的表**：下次同步会整段覆盖掉。要加参数，改 `_export-details.mjs`。
> 新增**首节**时还要同步加进 `_sync-details-doc.mjs` 的 `START_CANDIDATES` —— 它按「从新到旧」找锚点，
> 锚点没覆盖到新首节的话，同步会**静默跳过**那一节而不报错。

#### 竞品实时抓取 · 站点与出网白名单（`SITES` / `AMAZON_HOSTS`）

> 🔴 这是全项目**唯一**会主动爬第三方站点的通道。任何传入的 `href` 都要同时过三关：
> ① 主机在**硬编码的 8 个** amazon 域内；② 协议必须是 https；③ 路径必须是 `/gp/bestsellers/` 或 `/zgbs/`。
> 之后还要过 `assertPublicUrl`（DNS 解析后判内网 IP，防 rebinding），**重定向之后再判一遍白名单**。
> 原工具（`tool/server.js`）任何传入 href 都会去抓、且没有 SSRF 层 —— 这三处是本项目**有意加强**，不是照抄。

| 站点代码 | 主机 | 名称 |
|---|---|---|
| `com` | `www.amazon.com` | 美国站 |
| `co.uk` | `www.amazon.co.uk` | 英国站 |
| `de` | `www.amazon.de` | 德国站 |
| `fr` | `www.amazon.fr` | 法国站 |
| `jp` | `www.amazon.co.jp` | 日本站 |
| `ca` | `www.amazon.ca` | 加拿大站 |
| `it` | `www.amazon.it` | 意大利站 |
| `es` | `www.amazon.es` | 西班牙站 |

- 默认站点 `DEFAULT_SITE = "com"` —— **服务端与前端下拉共用这一个常量**（服务端不再写第二份字面量）。
- 类目 slug 白名单 `CAT_SLUGS` 共 20 个；不在名单里的 slug 一律 400，不拼进路径。
- 缓存：`cacheStats().ttlMs = 600000` ms（10 分钟）；`size` = 当前缓存条目数。
- 单页解析出的字段：`rank` / `asin` / `title` / `rating` / `reviews` / `price`。
- 出网请求头**必须**带 `Cookie: i18n-prefs=USD; lc-main=en_US` —— 不带时亚马逊按请求方 IP 返回本地化结果（本机在中国会整列变成 CNY 价，实测踩过）。

#### 竞品抓取 · 类目清单（`CATS`，20 个）

| 中文名 | slug | 说明 |
|---|---|---|
| 玩具与游戏 | `toys-and-games` | 益智玩具 / 毛绒 / 模型 / 户外玩具 |
| 宠物用品 | `pet-supplies` | 狗猫鸟鱼小动物用品 |
| 电子产品 | `electronics` | 耳机 / 智能设备 / 影音 |
| 家居厨房 | `home-garden` | 家居用品 / 收纳 / 装饰 |
| 厨房餐具 | `kitchen` | 厨具 / 餐具 / 小家电 |
| 运动户外 | `sporting-goods` | 健身 / 露营 / 球类 |
| 美妆个护 | `beauty` | 护肤 / 彩妆 / 美发 |
| 健康家居 | `hpc` | 日用品 / 保健品 / 清洁 |
| 母婴用品 | `baby-products` | 婴儿护理 / 喂养 / 推车 |
| 办公用品 | `office-products` | 文具 / 打印 / 办公家具 |
| 家用电器 | `appliances` | 大家电 / 小家电 |
| 汽车用品 | `automotive` | 车载配件 / 养护 |
| 艺术手工 | `arts-crafts` | 绘画 / 手工 / 缝纫 |
| 乐器 | `musical-instruments` | 乐器 / 配件 |
| 服饰鞋包 | `fashion` | 服装 / 鞋 / 珠宝 |
| 电子游戏 | `videogames` | 游戏机 / 游戏软件 |
| 图书 | `books` | 图书 / 教材 |
| 食品杂货 | `grocery` | 食品 / 饮料 / 生鲜 |
| 工业科研 | `industrial` | 工业仪器 / 科研耗材 |
| 工具五金 | `tools` | 手工具 / 电动工具 |

#### 竞品关键词 · 词表规模与权重模型（`competitor-keywords.js`）

口径来自 `tool/server.js`（原「竞品销量榜」）的纯本地部分，**联网翻译那一支没搬**
（原 `probeWordsSync` 会读联网填充的缓存）—— 改成由调用方传 `extraWords`，于是这个模块断网也能算。

| 表 | 规模 | 用途 |
|---|---|---|
| `CAT_HINTS` | 20 | 类目关键词提示（`detectCatSlug` / `scoreCats` 用） |
| `SPECIES` | 19 | 品类实词（判断切出来的词是不是真品类词） |
| `SUB_HINTS` | 107 | 子类目/场景提示 |
| `STOP` | 139 | 停用词（虚词/连接词，不进权重表） |

切词与权重（`analyzeKeywords` 是唯一实现）：

- 切词：`tokenize` → 小写化 + 拆非字母数字 + **丢掉长度 <2 的词** + 去停用词 + 去纯数字。
  ⚠️ 丢掉短词会让 n-gram 的 `pos` 偏移（首词是 `a` 时第一条 bigram 从位置 1 起）—— 这是原工具既有行为，已按它锁快照。
- n-gram 只做 **1 / 2 / 3 阶**（`buildNgrams`）；同一标题内同一个词只计一次覆盖。
- 权重公式：`w = covScore*0.5 + posScore*0.3 + lenScore*0.2`，其中
  `covScore = 覆盖率*10`、`posScore = (1 - 平均位置)*10`、`lenScore = 1gram→4 / 2gram→7.5 / 3gram→10`。
- 单词且覆盖率 ≥0.9 再 `-1.2`（泛词扣分，防「入场券词」挤掉长尾）；最后 `clamp(1, 10)` 并保留一位小数。
- **只保留出现 ≥2 次的词**（`cov < 2` 直接丢弃）—— 所以它会漏真长尾，这是取舍不是 bug。
- 空白机会（差异化）口径：`useRate <= 25 && n >= 2`，最多列 12 个。

#### 文案提示词 · 五类与字符口径（`PROMPT_KINDS` / `buildCopyPrompt`）

| id | 名称 | 要关键词表 | 要竞品样本 |
|---|---|---|---|
| `analysis` | ① 竞品标题拆解 + 关键词提取 | — | ✅ |
| `title` | ② 标题 + 产品亮点（Item Highlights） | ✅ | ✅ |
| `bullets` | ③ 五点描述（Bullet Points） | ✅ | ✅ |
| `searchTerms` | ④ 后台搜索词（Search Terms） | ✅ | ✅ |
| `localize` | ⑤ 多语言本地化 | — | ✅ |

三条守卫（缺输入一律返回 `ok:false` + 可读中文原因，**绝不产出一份空提示词**）：
未知类型 → 先填产品名 → 需要样本的必须先有竞品 → 需要埋词依据的必须先跑过权重分析。

全部字符上限**取自 `listing.js`**，文案层一行都不手写（自检第 25 节有**反向锁**，禁在文案层出现字面量）：

| 口径 | 值 | 出处 |
|---|---|---|
| 标题（非 media） | 75 | `titleLimit({isMedia:false})` |
| 标题（media 类目例外） | 200 | `titleLimit({isMedia:true})` |
| 产品亮点 Item Highlights | 125 | `LIMITS.itemHighlights` |
| 标题 + 亮点合计 | 200 | `LIMITS.titleTotal` |
| 后台搜索词 | 250 **字节** | `LIMITS.searchTerms` |
| 五点单条 | 500 | `LIMITS.bullet` |
| 五点条数 | 5 | `LIMITS.bulletCount` |

> 顺手修掉原工具的两处**字符口径错误**：后台搜索词原文写「250 字符」（平台口径是**字节**，
> 中文字符占 3 字节，按字符算会超 3 倍）；五点原文写「200 」（`LIMITS.bullet` 是 500，200 是别处抄来的数字）。
> ⚠️ media 版提示词里**会**出现 `75`，但在**否定句**里（"不要套用非媒体类目的 75 字符上限"）——
> 断言锁的是**硬上限那句**（`严格 ≤200 字符`），不是整段搜 `75`（这个坑在 selftest 与 browser-selftest 各踩过一次）。

#### 模板自动匹配 · 别名层（`TEMPLATE_ALIASES`）

> 上游 25 个模板 JSON 来自参考仓（别人的仓库），`build-templates.mjs` 的铁律是**只消费不改写**。
> 但实测该词表里 `T恤` / `衣服` / `tee` / `shirt` / `apparel` / `garment` / `clothing` **全部 0 命中**，
> 服装类需求全被丢给白底主图。所以补在**读法层** —— 上游文件零改动。

| 模板 | 中文别名 | 英文别名 |
|---|---|---|
| `hero-image` | 首图 / 白底照 | main image |
| `ghost-mannequin` | t恤 / 衣服 / 上衣 / 衬衫 / 卫衣 / 毛衣 / 连衣裙 / 半身裙 / 外套 / 裤子 / 裙子 / 成衣 / 服装 / 不露脸 | t-shirt / tshirt / tee / shirt / apparel / garment / clothing / blouse / hoodie / sweater / outfit / wearable / streetwear |
| `model-showcase` | 模特上身 / 上身展示 / 真人模特 / 外模 | on-model |
| `try-on-virtual` | 虚拟试衣 / 虚拟试穿 / 换装 / 试戴 | virtual try-on / try-on |
| `social-media` | 种草图 / 小红书图 / 社交图 | instagram post |
| `ugc-style` | 买家晒图 / 素人图 | — |

#### 模板自动匹配 · 上下文亲和表（`CATEGORY_TEMPLATE_AFFINITY`）

品类命中 → **+6 分**。上下文**只做补位**：词证据打平时用它决胜，一个词都没命中时由它接管（这就是多级回落）。

| 品类 | 亲和模板（按优先级） |
|---|---|
| `fashion` | `ghost-mannequin` → `model-showcase` → `flat-lay` → `try-on-virtual` |
| `jewelry` | `detail-macro` → `luxury-atmospherics` → `model-showcase` |
| `beauty` | `detail-macro` → `before-after` → `lifestyle-scene` |
| `electronics` | `device-mockup` → `exploded-view` → `infographic` → `multi-angle-grid` |
| `food` | `detail-macro` → `packaging` → `lifestyle-scene` |
| `home` | `lifestyle-scene` → `size-spec` → `flat-lay` |
| `pet` | `lifestyle-scene` → `ugc-style` → `before-after` |
| `outdoor` | `lifestyle-scene` → `sports-campaign` → `multi-angle-grid` |

#### 模板 → 图型映射（`TEMPLATE_FIGURE`，25 个模板全有归属）

> 编排层原来是一串硬编码嵌套三元，**25 个模板里只认 hero-image / lifestyle-scene 两个**，
> 其余 23 个全被压成 `benefit`（卖点副图 25-30%）。选了模板却不认模板的构图口径，等于选型白做。

| 模板 | 图型 key | 中文标签 | 产品占比 | 留白下限 |
|---|---|---|---|---|
| `hero-image` | `hero` | 白底主图 | 35-40% | 45% |
| `lifestyle-scene` | `scene` | 场景氛围图 | 20-25% | 50% |
| `flat-lay` | `hero` | 白底主图 | 35-40% | 45% |
| `detail-macro` | `hero` | 白底主图 | 35-40% | 45% |
| `poster-banner` | `feedAd` | 信息流广告 | 40-40% | 45% |
| `social-media` | `feedAd` | 信息流广告 | 40-40% | 45% |
| `ugc-style` | `scene` | 场景氛围图 | 20-25% | 50% |
| `model-showcase` | `hero` | 白底主图 | 35-40% | 45% |
| `before-after` | `benefit` | 卖点副图 | 25-30% | 45% |
| `packaging` | `benefit` | 卖点副图 | 25-30% | 45% |
| `infographic` | `pdp` | 详情页信息图 | 30-40% | 48% |
| `creative-concept` | `feedAd` | 信息流广告 | 40-40% | 45% |
| `size-spec` | `pdp` | 详情页信息图 | 30-40% | 48% |
| `multi-product` | `hero` | 白底主图 | 35-40% | 45% |
| `livestream` | `scene` | 场景氛围图 | 20-25% | 50% |
| `try-on-virtual` | `scene` | 场景氛围图 | 20-25% | 50% |
| `exploded-view` | `pdp` | 详情页信息图 | 30-40% | 48% |
| `ghost-mannequin` | `hero` | 白底主图 | 35-40% | 45% |
| `multi-angle-grid` | `hero` | 白底主图 | 35-40% | 45% |
| `magazine-editorial` | `benefit` | 卖点副图 | 25-30% | 45% |
| `seasonal-campaign` | `feedAd` | 信息流广告 | 40-40% | 45% |
| `luxury-atmospherics` | `benefit` | 卖点副图 | 25-30% | 45% |
| `device-mockup` | `benefit` | 卖点副图 | 25-30% | 45% |
| `storefront` | `scene` | 场景氛围图 | 20-25% | 50% |
| `sports-campaign` | `feedAd` | 信息流广告 | 40-40% | 45% |

#### 铁律 1 · HEX 色板

| 常量名 | hex |
|---|---|
| `HEX.white` | #FFFFFF |
| `HEX.offWhite` | #FAF7F2 |
| `HEX.lightBeige` | #F5F1E8 |
| `HEX.cream` | #F2E8D5 |
| `HEX.black` | #111111 |
| `HEX.deepCharcoal` | #2D2D2D |
| `HEX.midGray` | #888888 |
| `HEX.lightGray` | #D8D8D8 |
| `HEX.gold` | #D4AF37 |
| `HEX.amber` | #FFBF00 |
| `HEX.bronze` | #CD7F32 |
| `HEX.copper` | #B87333 |
| `HEX.deepGreen` | #1A3A2E |
| `HEX.forest` | #2E5B3E |
| `HEX.sage` | #7A9E7E |
| `HEX.olive` | #808000 |
| `HEX.mint` | #98FF98 |
| `HEX.lime` | #9ACD32 |
| `HEX.seafoam` | #9FE2BF |
| `HEX.teal` | #008080 |
| `HEX.turquoise` | #40E0D0 |
| `HEX.wood` | #8B6F47 |
| `HEX.taupe` | #8B7D6B |
| `HEX.navy` | #12243A |
| `HEX.royalBlue` | #2A4B8D |
| `HEX.denim` | #4A6C8C |
| `HEX.sky` | #87CEEB |
| `HEX.red` | #C0392B |
| `HEX.maroon` | #800000 |
| `HEX.burgundy` | #6D1A36 |
| `HEX.coral` | #FF7F50 |
| `HEX.pink` | #E8B4B8 |
| `HEX.magenta` | #C2185B |
| `HEX.mauve` | #B784A7 |
| `HEX.plum` | #8E4585 |
| `HEX.yellow` | #E8C547 |
| `HEX.orange` | #D97706 |
| `HEX.purple` | #6B4E8F |
| `HEX.lilac` | #C8A2C8 |
| `HEX.indigo` | #3F51B5 |
| `HEX.brown` | #7B5540 |
| `HEX.khaki` | #C3B091 |

色板共 42 个色值。另有颜色词表 `COLOR_WORDS` 把中英文颜色形容词映射到这些 hex。

#### 铁律 2/3 · 图型 → 产品占比 / 留白下限（`FIGURE_SPEC`）

| figure key | 中文标签 | 产品占比区间 | 留白下限 |
|---|---|---|---|
| `main` | 亚马逊合规首图 | 85–100% | ≥0% |
| `hero` | 白底主图 | 35–40% | ≥45% |
| `benefit` | 卖点副图 | 25–30% | ≥45% |
| `scene` | 场景氛围图 | 20–25% | ≥50% |
| `feedAd` | 信息流广告 | 40–40% | ≥45% |
| `searchAd` | 搜索广告 | 45–45% | ≥45% |
| `sku` | SKU 多规格卡 | 60–70% | ≥30% |
| `pdp` | 详情页信息图 | 30–40% | ≥48% |

#### 铁律 4 · 否定清单

基础否定项（`BASE_NEGATIVE`，7 项）+ 按模板追加。示例（hero-image）：

```text
Do NOT add: props not requested, hands, watermarks, fake logos, extra text, decorative elements, gradient backgrounds.
```

#### 铁律 6 · 三层信息架构上限

- 核心承诺 headline：≤15 字
- 关键证据 evidence：≤3 个（超出被 slice 截断）
- CTA：≤8 字

超限时 `infoArchitecture()` 返回 `problems[]`，由 `auditPlan()` 汇总。

#### 多角度镜头规则 · 角度全集（`ANGLES`，6 种）

| key | 中文标签 | 写进 Prompt 的描述 |
|---|---|---|
| `front34` | 正面 3/4 | at a slight 3/4 angle showing the full front facade |
| `topdown` | 正上方俯视 | photographed directly from above at a 90-degree overhead angle |
| `side90` | 侧面 90° | photographed from a clean 90-degree side profile |
| `rear45` | 后侧 45° | photographed from behind at a 45-degree rear angle |
| `lowup` | 仰视低角度 | photographed from a very low angle looking upward |
| `high45` | 高角度俯视 | photographed from a high 45-degree angle looking down |

#### 多角度镜头规则 · 景别全集（`SHOTS`，5 种）

| key | 中文标签 | 写进 Prompt 的描述 |
|---|---|---|
| `full` | 全景 | full product visible |
| `mid` | 中景 | showing the featured section area |
| `close` | 特写 | tight zoom on the key detail |
| `macro` | 微距 | extreme close-up macro shot, shallow depth of field |
| `part` | 局部 | close-up detail shot focusing on a single part |

#### 角度分配审计口径（`assignAngles(count, {kind})`）

| kind | 要求角度种数 | 要求特写/微距张数 | 实测（count 对应值） |
|---|---|---|---|
| hero（5 张） | ≥3 | ≥1 | 实得 5 种 / 特写 2 张 |
| pdp（9 张） | ≥4 | ≥2 | 实得 6 种 / 特写 3 张 |

另有约束：不能连续 3 张同角度；全景占比 ≤40%。主图序列的 5 个角度槽位实测为：front34 → high45 → side90 → lowup → topdown

#### Campaign Style Lock · 10 个维度（`STYLE_LOCK_DIMENSIONS`）

1. 视觉方向
2. 固定色板（2-3 主色 + 1 强调色）
3. 冷暖调
4. 字体系统
5. 背景系统
6. 光线系统
7. 布局系统
8. 图标/插画系统
9. 产品呈现规则
10. 禁止漂移项

默认 Style Lock 全文（`DEFAULT_STYLE_LOCK`）：

```text
Campaign Style Lock: consistent premium ecommerce visual system across the entire image set; fixed palette of clean off-white background (#FAF7F2), deep charcoal text (#2D2D2D), one product-matched accent color, and one soft secondary accent; neutral-cool studio lighting; modern geometric sans-serif headline placeholders only; consistent rounded rectangular info labels; consistent thin-line icon style; clean high-end product photography mixed with minimal infographic elements; stable product scale and placement; generous whitespace; no color palette changes, no mixed fonts, no random backgrounds, no inconsistent lighting, no mismatched icon styles.
```

`buildStyleLock()` 默认值：

```text
Campaign Style Lock: visual direction = premium cross-border ecommerce; fixed palette = background #FAF7F2, text #2D2D2D, accent #1A3A2E; temperature = neutral-cool (identical across the whole set); typography = modern geometric sans-serif only, no serif/handwritten/retro/cartoon mix; background system = #FAF7F2 continuous surface; lighting system = neutral studio lighting, soft directional key light from upper left; layout system = rounded rectangular info labels with generous whitespace; icon system = consistent thin-line icons, uniform 1.5px stroke; product presentation = stable scale, stable angle family, consistent material rendering; never drift: color palette changes, mixed fonts, random backgrounds, inconsistent lighting, mismatched icon styles.
```

#### 主图序列（`HERO_SEQUENCES`，按转化驱动力三选一，各 5 张）

**驱动 = visual**

| code | 用途 | figure | 模板 | headline |
|---|---|---|---|---|
| H1 | 一眼可懂的视觉主张 | `hero` | `hero-image` | Instant visual hook |
| H2 | 核心功能或质感特写 | `benefit` | `detail-macro` | Texture you can feel |
| H3 | 使用场景匹配 | `scene` | `lifestyle-scene` | Fits your everyday |
| H4 | 普通方案 vs 升级方案对比 | `benefit` | `before-after` | Old way vs this way |
| H5 | 优惠、物流、保障或 CTA | `benefit` | `poster-banner` | Ready to upgrade |

**驱动 = pain**

| code | 用途 | figure | 模板 | headline |
|---|---|---|---|---|
| H1 | 问题快照 | `hero` | `before-after` | The problem, squared |
| H2 | 解决机制 | `benefit` | `detail-macro` | How it works |
| H3 | 利益证明 | `benefit` | `infographic` | Proof, not claims |
| H4 | 信任画面 | `benefit` | `packaging` | Built to be trusted |
| H5 | 优惠 + 紧迫 CTA | `feedAd` | `poster-banner` | Fix it today |

**驱动 = emotion**

| code | 用途 | figure | 模板 | headline |
|---|---|---|---|---|
| H1 | 情绪场景钩子 | `scene` | `lifestyle-scene` | How it should feel |
| H2 | 身份 / 价值表达 | `scene` | `model-showcase` | Made for you |
| H3 | 产品作为实现方式 | `hero` | `hero-image` | The one object |
| H4 | 归属、地位或社交信号 | `scene` | `social-media` | Share the moment |
| H5 | 带情绪强化的优惠 + CTA | `feedAd` | `poster-banner` | Bring it home |

#### 详情页序列（`PDP_SEQUENCE`，固定 9 张）

| code | 用途 | 模板 | headline |
|---|---|---|---|
| D1 | 首屏承接：延续主图卖点，说明为谁解决什么问题 | `infographic` | Who this is for |
| D2 | 痛点放大：展示用户当前的不便、损失、风险 | `before-after` | What it costs you now |
| D3 | 机制解释：视觉化说明产品如何发挥作用（不虚构数据） | `exploded-view` | What's inside |
| D4 | 核心利益：2-4 个主要利益做成易扫读信息图 | `infographic` | Core benefits |
| D5 | 使用步骤：3-4 步说明怎么用 | `size-spec` | How to use it |
| D6 | 场景覆盖：典型使用场景、适用对象 | `lifestyle-scene` | Where it works |
| D7 | 对比选择：普通方案 vs 本产品 | `before-after` | Why this one |
| D8 | 信任背书：材料、包装、质检（无证据写 proof placeholder） | `detail-macro` | Materials & quality |
| D9 | FAQ / 风险逆转 / CTA | `poster-banner` | Still deciding? |

#### 画幅规则

- 主图组（hero）：一律 `1024x1024`（1:1，亚马逊主图/副图要求）
- 详情页组（pdp）：一律 `768x1024`（3:4 竖版）
- Prompt 里写的是**比例**不是像素（`toRatioText()` 转换），如 `aspect ratio 1:1`

视觉节奏：`rhythmBackground(index)` 按 `#FFFFFF → #F5F1E8 → #1A3A2E` 循环取背景色。

#### Listing · 字段上限（`LIMITS`）

| 字段 | 上限 | 说明 |
|---|---|---|
| title | 75 | 标题硬上限（**2026-07-27 生效**，含空格） |
| titleMedia | 200 | **唯一例外**：media 类目（图书 / 音乐 / 影像） |
| itemHighlights | 125 | Item Highlights（后台显示名 / API 属性名 `title_differentiation`），**参与搜索** |
| titleTotal | 200 | 标题 + Item Highlights **合计**上限（官方明文：两项共享） |
| titleStrict | 70 | 保守建议上限（**项目自定义**口径，非平台值） |
| bullet（单条） | 500 | 五点描述单条上限 |
| bulletCount | 5 | 标准五点数量 |
| searchTerms | 250 | **字节**上限（非字符） |
| description | 2000 | 描述上限 |

关系式（不是巧合，是官方设计）：`title + itemHighlights = titleTotal` → **75 + 125 = 200**。
另有 `titleLimit(ctx)` 集中处理类目口径（`ctx.isMedia` → 200，否则 75），界面与判据共用一处，不各写一遍三元。

#### Listing · 词表（12 张）

**① 促销与最高级 `PROMO_WORDS`（42 个）** —— 分四组：价格促销 / 最高级 / 平台徽章词 / 大促名（后两类分别是「挪用平台标识」与「商标受限」）：

free shipping / free delivery / free gift / free returns / sale / on sale / hot sale / clearance / discount / cheap / cheapest / lowest price / price drop / buy now / order now / limited time / limited offer / new arrival / just launched / flash sale / lightning deal / deal of the day / clearance sale / best / bestseller / best seller / top rated / top seller / #1 / no.1 / number one / amazon's choice / amazon choice / amazon best seller / amazon's best seller / #1 best seller / editor's choice / editors choice / prime day / black friday / cyber monday / big deal days

> ⚠️ 刻意**不收** `perfect`：`perfect for gifting` 是海量合规 listing 的正常写法，收进来会造成大面积误报。

**② 特殊符号 `BAD_SYMBOLS`（20 个）**：! ? $ _ { } ^ ¬ ¦ ~ * ★ ☆ ✅ 🔥 @ | < > `

> 前 16 个＝平台明列 + 表情符号解析风险；后 4 个（竖线 / 尖括号 / 反引号）＝本项目补充，理由是解析与注入（这条文案还会走「导出 HTML 预览 / 粘贴到表格」的链路）。单个 `%` / `#` / `+` **不在黑名单里**（100% Cotton、Model #A、2+1 Pack 都是合法写法），改由 C7「符号密度」兜底。

**③ 保证性/绝对化 `CLAIM_WORDS`（71 个，含中文）**：

guarantee / guaranteed / money back / 100% guarantee / 100% safe / 100% pure / 100% satisfaction / satisfaction guaranteed / risk free / risk-free / no side effects / side effect free / clinically proven / clinically tested / doctor recommended / doctor approved / medically proven / medically approved / hospital grade / medical grade / pharmaceutical grade / scientifically proven / proven to / instantly / permanently / eliminates all / kills 99 / cure / cures / curative / heal / heals / healing / treat / treats / treating / treatment / therapy / therapeutic / diagnose / remedy / prescription / detox / detoxify / immunity booster / immune system boost / weight loss / fat burner / appetite suppressant / antibiotic / fda approved / fda cleared / fda registered / fda certified / usda organic / made in usa / made in the usa / gmp certified / 包治 / 根治 / 治愈 / 治疗 / 疗效 / 药效 / 防癌 / 抗癌 / 无副作用 / 永久有效 / 立竿见影 / 权威认证 / 国家免检

**④ 疾病/医疗声明 `DISEASE_TERMS`（76 个）**：官方文档「Prohibited Product Claims for Diseases」逐条列表。**刻意剔除 7 个高频歧义词** —— `add`（Add to cart）/ `sad`（Sad puppy）/ `mono`（mono output）/ `pid`（PID controller）/ `crabs`（海鲜与螃蟹玩具）/ `tbi` / `ngu`（纯缩写、收益为零），并保留其无歧义全称（`attention deficit` / `seasonal affective disorder` / `mononucleosis` / `pelvic inflammatory disease` / `pubic lice` / `traumatic brain injury`）。**误报＝工具失去信任**，所以宁可漏收缩写。

**⑤ 农药/抗菌声明 `PESTICIDE_CLAIMS`（27 个）**：进入 EPA 注册范畴的表述。

**⑥ 环境声明 `ENV_CLAIMS`（19 个）**：eco-friendly / eco friendly / environmentally friendly / sustainable / sustainability / biodegradable / compostable / carbon neutral / carbon-neutral / zero waste / 100% recyclable / recycled content / plastic free / plastic-free / green product / climate friendly / cruelty free / cruelty-free / vegan

**⑦ 不证自明声明 `SELF_EVIDENT_CLAIMS`（18 个）**：ce certified / ce marked / ukca / rohs / reach compliant / non-toxic / nontoxic / non toxic / toxin free / toxin-free / tested for harmful substances / no harmful substances / bpa free / bpa-free / phthalate free / lead free / food safe / food-safe

**⑧ 品类专属高风险 `CATEGORY_CLAIMS`（8 个品类）**：beauty / food / pet / home / electronics / fashion / jewelry / outdoor

> 同一个词在不同品类风险不同：`antibacterial` 用在清洁剂是必需描述、用在袜子上是违规声明。所以品类专属词表只在识别出对应品类时才参与判定。

**⑨ 利益导向词 `BENEFIT_WORDS_EN`（28 个）/ `BENEFIT_WORDS_ZH`（18 个）**：供 C3 使用，按 `detectLang()` 结果二选一。中文表每个词都**两字以上**（中文无词边界，单字如「更」「省」会命中「更衣」「省份」）。

**⑩ 站外引流/联系方式 `OFF_SITE_PATTERNS`（6 条，**P 级硬规则**）**：

- `\bhttps?:\/\/\S+` → 网址（http/https）
- `\bwww\.[a-z0-9-]+(?:\.[a-z]{2,})+` → 网址（www.）
- `\b[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b` → 邮箱地址
- `\b(?:visit|check out|shop at|order from|buy from)\s+(?:our|my|the)?\s*(?:website|web site|site|store|shop|online store)\b` → 引导去站外店铺
- `\b(?:contact us|email us|call us|reach us|message us)\b` → 引导联系（contact/email/call us）
- `(?:扫码|扫一扫|加微信|加微|微信号|联系方式|联系客服|关注公众号|私聊)` → 中文站外引流用语

> 以**模式**而不是词表：网址/邮箱的形态本身就是判据，列词反而不全。刻意**不**把裸 `@` 收进来（已在 `BAD_SYMBOLS` 按符号管），邮箱必须写成 `local@domain.tld` 才算。

**⑪ 疑似联系方式 `SOFT_CONTACT_PATTERNS`（4 条，**C 级软规则**）**：

- `\+\d[\d\s().-]{7,}\d` → 带国际区号的号码
- `\(\d{2,4}\)\s*\d{3,4}[-\s]?\d{3,4}` → 带括号的号码
- `\b(?:whatsapp|wechat|weixin|telegram|skype|line id|viber|messenger)\b` → 站外社交/通讯应用名
- `\b(?:facebook|instagram|tiktok|youtube|twitter|linkedin|pinterest|snapchat)\b` → 站外社交平台名

> 🔴 **为什么电话只能做软规则**：`350-500-1000` 这种三段规格串数字量就有 10 位，硬禁必然误报，而误报会让卖家不再相信整个质检结果。所以只挑「形态更像电话」的（带 `+` 区号 / 带括号 / 带分隔符）报出来并标「请人工确认」。**判不准就报疑似，不报违规。**

**⑫ 标题主观修饰词 `SUBJECTIVE_TITLE_WORDS`（19 个，C 级）**：premium / high quality / high-quality / best in class / top quality / professional grade / professional-grade / amazing / hot item / must have / must-have / world class / world-class / unbeatable / superior quality / quality guaranteed / top of the line / cutting edge / cutting-edge

> ⚠️ 边界要说清：官方只给了**原则**（Subjective commentary 一节）和两个例子（HOT ITEM / BEST SELLER），**没给词表** —— 这张表是本项目按该原则自定的，所以定 C 级、`source` 里写明。与 `PROMO_WORDS` 重叠的词只在 PROMO 侧报（有断言锁住，同一件事不报两遍）。

所有英文词表共用 `matchWords()` 做**词边界**匹配（避免 secure 命中 cure、freedom 命中 free）；中文表走子串匹配。

#### Listing · 全部规则（`RULES`，28 条）

| id | 级别 | 作用域 | 空值也判定 | 来源 | 判定逻辑（`test` 摘要） |
|---|---|---|---|---|---|
| P1 | P | `title` | — | 平台公开规则（2026-07-27 生效） | 标题上限 75 字符（含空格，media 类目除外）。超限的真实后果要写准：**不是"被拒收"** —— 官方原文是超 75（最多 200）仍可提交并被接受，但 Amazon 会按 AI 建议**自动拆分改写**你的标题，你拿到的是它给的版本（品牌方另有 14 天复核期）。也就是说，超限的代价是**失去标题控制权 + 丢掉 Item Highlights 的提交资格**（官方：只有 item_name ≤75 才能提交 title_differentiation），不是报错。 |
| P2 | P | `title` | — | 平台公开规则 | 标题含促销词 / 最高级 / 平台徽章词（free shipping、best seller、Amazon's Choice）属于违规表述：前两类无证据即误导，后一类是挪用了平台自有标识。 |
| P3 | P | `title` | — | 平台公开规则 | 特殊符号（! ? $ _ / < > 等）会造成解析异常，且平台明文不建议使用；< > ` 另有注入风险。 |
| P4 | P | `title` | — | 项目自定义（保守口径） | 标题踩到 76 字符就会**同时丢掉两样东西**：Item Highlights 的提交资格，以及标题的自主权（会被 AI 建议改写）。所以按 70 字符留 5 字符余量 —— 后面想补一个规格、换一个核心词，都不会当场越线。⚠️ 这 70 是本项目自定的，不是平台规则；media 类目不走这条。 |
| P5 | P | `title` | — | 平台公开规则 | 标题应避免全大写（ALL CAPS），平台会判为不规范并影响可读性。 |
| P6 | P | `copy` | — | 平台公开规则 | 禁止性声明三桶：①疾病/医疗（亚马逊官方 202024200 明列 80+ 疾病名，未经 FDA 批准不得声称诊断/治愈/缓解/治疗/预防）②农药/抗菌（进入 EPA 注册范畴）③保证性绝对化（guarantee / 100% safe / clinically proven，无客观证据即误导）。⚠️ stroke 等少数词有日常义，命中后需人工确认。 |
| P7 | P | `bullets` | — | 平台公开规则 | 单条五点超过 500 字符会被截断，尾部内容在移动端不可见。 |
| P8 | P | `bullets` | — | 平台公开规则 | 五点是产品属性描述位，写入价格/促销/物流信息属于违规内容。 |
| C9 | C | `bullets` | — | 行业通行做法 | 五点以大写引导词 + 冒号开头（BENEFIT: ...）便于移动端扫读，是主流写法；不这么做不影响合规，只影响扫读效率。 |
| P10 | P | `searchTerms` | — | 平台公开规则 | Search Terms 按字节计数，上限 250 字节；超出部分会被静默丢弃。 |
| P11 | P | `searchTerms` | — | 平台公开规则 | Search Terms 中重复品牌名会挤占额度（品牌名已在 Brand 字段生效），且平台不建议堆砌。 |
| P12 | P | `copy` | — | 平台公开规则 + 项目自定义 | 文案含 HTML/脚本标记（<b>、</p>、javascript:、onerror=、&#xxx;）会被平台清洗或拒收；更关键的是这条文案在「导出 HTML 预览 / 复制到别处」的链路上会被当代码执行 —— 合规与注入是同一个入口。 |
| P13 | P | `highlights` | — | 平台公开规则（2026-07-27 生效） | Item Highlights（API 属性名 title_differentiation）上限 125 字符。🔴 它不只是展示字段 —— 官方原文是 "This content is searchable"，它**参与搜索索引**。所以超限被截断＝已经把关键词挖出来了又白丢一次，比普通"文字被截"更可惜。 |
| P14 | P | `highlights` | — | 平台公开规则 | Item Highlights 与标题同属「买家可见 + 参与搜索」的字段，禁用语口径**完全一致**：促销 / 最高级 / 平台徽章词同样违规，特殊符号同样造成解析异常。不能因为它是新字段就放松 —— 官方也明说 Highlights 会被按同样的内容政策审查。 |
| P15 | P | `copy` | — | 平台公开规则（卖家行为准则） | 文案里出现网址 / 邮箱 / 引导去站外或「联系我们」的措辞 —— 平台禁止把买家带离亚马逊、禁止在 listing 里放可直接联系的方式。这类内容不是「措辞好不好」，是入口级违规，后果是绩效问题；而它又完全可以机械判定，正合本项目「硬规则不交给模型」的原则。 |
| C1 | C | `title` | — | 行业通行做法 | 标题前 5 个词决定移动端首屏可见性，核心搜索词应尽量前置。 |
| C2 | C | `title` | — | 行业通行做法 | 标题包含数字/规格（容量、数量、尺寸）能显著降低购买不确定性，提升点击。 |
| C3 | C | `bullets` | — | 行业通行做法 | 五点是利益点而非参数表：应出现利益导向词，否则只是规格罗列。中文与英文**各用一套词表**，且英文走词边界匹配（避免 easy 命中 uneasy）。 |
| C4 | C | `bullets` | — | 行业通行做法 | 五条长度差异过大（最短 < 40% 最长）说明结构不匀，扫读节奏会乱。 |
| C5 | C | `title` | — | 项目自定义 | 标题里同一实词重复 ≥3 次属于关键词堆砌观感，平台不建议且降低可读性。 |
| C6 | C | `bullets` | — | 项目自定义 | 五点不含任何具体材质/规格/工艺词时，容易被判定为空洞文案，买家无法建立信任。 |
| C7 | C | `title` | — | 项目自定义 | 符号密度过高（≥4 个非字母数字符号）影响可读性与解析。⚠️ 这里刻意用「密度」而不是「黑名单」：单个 % / # / + 是高频合法写法（100% Cotton、Model #A、2+1 Pack），逐符号硬禁会造成大面积误报。 |
| C8 | C | `copy` | — | 平台公开规则（需举证，非禁用） | 环境声明（eco-friendly / biodegradable / carbon neutral）与「不证自明声明」（non-toxic / BPA free / CE certified）平台**并非一律禁止**，要求的是真实、不误导、能提交证据（FTC Green Guides / 加州环境营销法）。所以定成软规则：提示你准备好证据，而不是逼你删词。 |
| C10 | C | `highlights` | ✅ | 平台公开规则（2026-07-27 生效） | Item Highlights 是**额外 125 字符、且与标题同等参与搜索**的位置（官方：searchable，并显示在搜索结果与详情页标题下方）。而标题被砍到 75 之后，这里是唯一能把「材质 / 推荐用途 / 兼容性」重新放回可搜索位置的地方。留空＝主动放弃 125 字符的索引额度。⚠️ 它**不是必填项**，所以这条是提示，不是「必须改」。 |
| C11 | C | `titleHighlights` | — | 平台公开规则 + 项目自定义阈值 | 官方明确：新规**不是**把同一批信息切成两半 —— 原文 Each one should add something different。标题该说「这是什么」（品牌 + 品名 + 关键属性），Highlights 该说「材质 / 推荐用途 / 兼容性」。两边说一样的话，等于花两次额度买同一个词。⚠️ 这里 80% 的阈值是本项目自定，官方只给了分工原则。 |
| C12 | C | `copy` | — | 平台公开规则（需人工确认） | 疑似电话号 / 站外社交平台名。**刻意定为软规则**：`350-500-1000` 这种三段规格串数字量就能到 10 位，硬禁会造成大面积误报（还会让卖家不再相信质检结果）。所以只挑「形态更像电话」的报出来让你自己确认 —— 判不准就报疑似，不报违规。 |
| C13 | C | `title` | — | 行业通行做法（第三方合规清单，非官方明文） | 标题里同一个词反复出现（第三方清单举的例：Dog Treats Dog Training Dog Snacks 里三个 Dog）。在 200 字符时代它只是不优雅，在 **75 字符**时代它直接吃掉额度 —— 重复一次就少放一个规格或一个长尾词。⚠️ 不计品牌词：品牌名前置本来就是官方推荐写法。 |
| C14 | C | `title` | — | 官方原则 + 项目自定义词表 | 官方《Product title requirements》的 Subjective commentary 一节要求不要用主观表述（官方举例 HOT ITEM / BEST SELLER）。⚠️ 官方**只给了原则和两个例子、没给词表** —— 下面命中用的是本项目按该原则自定的词表，所以定 C 级而不是硬规则。在 75 字符时代这件事更贵：一个 Premium 吃掉 7 个字符（约 9% 额度），却不提供任何可被搜索的区分信息。 |

> ⚠️ 「空值也判定」列：一般规则遇到字段为空**跳过**是对的（空字段算跳过、不算通过）；
> 但 `C10`（Item Highlights 为空）要报的恰恰就是「空」本身 —— 没有这个放行口，它会**永远静默不报**，
> 而一条静默失效的规则比没有这条规则更坏。放行有个前提：`hasContent` —— **整张表一个字都没填时不放行**，
> 否则第一次打开工作台就会看到「未填写 Item Highlights」，那是噪音不是信息。

**作用域分布**：

- `title`（11 条）：P1, P2, P3, P4, P5, C1, C2, C5, C7, C13, C14
- `copy`（5 条）：P6, P12, P15, C8, C12
- `bullets`（6 条）：P7, P8, C9, C3, C4, C6
- `searchTerms`（2 条）：P10, P11
- `highlights`（3 条）：P13, P14, C10
- `titleHighlights`（1 条）：C11

**来源分布**：平台公开规则（2026-07-27 生效） 3 条；平台公开规则 9 条；项目自定义（保守口径） 1 条；行业通行做法 5 条；平台公开规则 + 项目自定义 1 条；平台公开规则（卖家行为准则） 1 条；项目自定义 3 条；平台公开规则（需举证，非禁用） 1 条；平台公开规则 + 项目自定义阈值 1 条；平台公开规则（需人工确认） 1 条；行业通行做法（第三方合规清单，非官方明文） 1 条；官方原则 + 项目自定义词表 1 条

#### 模板数据（`assets/templates.js`，由 `tools/build-templates.mjs` 生成）

- 模板数：**25**｜变体合计：**88**｜示例合计：**66**｜`prompt_template` 字段种类：**66**
- 每个模板必填 11 个字段

| order | id | 名称 | keywords 数 | trigger_phrases 数 | 变体数 | 支持参考图 |
|---|---|---|---|---|---|---|
| 01 | `hero-image` | 白底/纯色底产品主图 | 8 | 6 | 4 | 支持 |
| 02 | `lifestyle-scene` | 场景化生活图 | 7 | 6 | 4 | 支持 |
| 03 | `flat-lay` | 平铺图 | 6 | 5 | 3 | 支持 |
| 04 | `detail-macro` | 细节微距图 | 7 | 6 | 3 | 支持 |
| 05 | `poster-banner` | 促销海报/Banner | 8 | 7 | 4 | 支持 |
| 06 | `social-media` | 社交媒体素材 | 7 | 7 | 3 | 支持 |
| 07 | `ugc-style` | UGC风格/买家秀 | 7 | 7 | 4 | 支持 |
| 08 | `model-showcase` | 模特展示图 | 6 | 6 | 3 | 支持 |
| 09 | `before-after` | 使用前后对比图 | 6 | 6 | 3 | 支持 |
| 10 | `packaging` | 包装设计展示 | 7 | 6 | 3 | 支持 |
| 11 | `infographic` | 信息图/A+Content | 7 | 6 | 3 | 支持 |
| 12 | `creative-concept` | 创意概念广告图 | 7 | 6 | 3 | 支持 |
| 13 | `size-spec` | 尺寸规格+使用步骤图 | 8 | 7 | 3 | 支持 |
| 14 | `multi-product` | 多产品套装/组合展示 | 7 | 7 | 3 | 支持 |
| 15 | `livestream` | 电商直播间场景 | 7 | 7 | 3 | 支持 |
| 16 | `try-on-virtual` | 虚拟试穿/产品融入场景 | 7 | 6 | 3 | 支持 |
| 17 | `exploded-view` | 技术拆解/爆炸图 | 9 | 7 | 4 | 支持 |
| 18 | `ghost-mannequin` | 隐形模特 | 8 | 6 | 4 | 支持 |
| 19 | `multi-angle-grid` | 产品多角度网格 | 9 | 8 | 4 | 支持 |
| 20 | `magazine-editorial` | 杂志大片/封面 | 9 | 8 | 4 | 支持 |
| 21 | `seasonal-campaign` | 季节主题网格 | 9 | 8 | 4 | 支持 |
| 22 | `luxury-atmospherics` | 奢华氛围渲染 | 11 | 8 | 4 | 支持 |
| 23 | `device-mockup` | 设备界面模型 | 9 | 9 | 4 | 支持 |
| 24 | `storefront` | 店铺门面/空间摄影 | 9 | 9 | 4 | 支持 |
| 25 | `sports-campaign` | 运动/健身广告 | 11 | 8 | 4 | 支持 |

`prompt_template` 字段种类（66 种，说明它是**开放式 schema**，各场景字段不同）：

after_state / arrangement / art_direction / athlete / atmosphere / autumn / background / before_state / camera / color_palette / color_scheme / components / composition / concept / cta / data_vis / decorative / desk_accessories / detail / details / device / dimensions / display / divider / effects / environment / expression / exterior / extras / features / form / grid / headline / host / imperfection / integration / interior / labels / layout / lighting / makeup_hair / metrics / model / mood / overlay / platform / price / product_action / props / quality / screen_content / separators / setting / skin_detail / spring / steps / style / subject / subtitle / summer / surface / type / typography / ui_overlay / variation / winter

#### 数据采集 · 选择器表（`SELECTORS`）

| 字段 | 选择器（按优先级） |
|---|---|
| `title` | `#productTitle` |
| `brand` | `#bylineInfo` |
| `bullets` | `#feature-bullets .a-unordered-list .a-list-item` · `#productFactsDesktopExpander .a-unordered-list .a-list-item` |
| `description` | `#productDescription` |
| `price` | `#corePriceDisplay_desktop_feature_div .a-offscreen` · `#corePrice_feature_div .a-offscreen` · `.a-price .a-offscreen` · `#priceblock_ourprice` · `#priceblock_dealprice` |
| `rating` | `#acrPopover .a-icon-alt` · `span[data-hook='rating-out-of-text']` · `#averageCustomerReviews .a-icon-alt` |
| `reviewCount` | `#acrCustomerReviewText` |
| `image` | `#landingImage` · `#imgTagWrapperId img` · `#imageBlock img` · `img[data-old-hires]` |
| `specTables` | `#productDetails_expanderTables_depthLeftSections .a-expander-container` · `#productDetails_expanderTables_depthRightSections .a-expander-container` |
| `breadcrumbs` | `#wayfinding-breadcrumbs_feature_div a` |
| `bestSellersRank` | `#SalesRank` · `#detailBullets_feature_div` |
| `asin` | `#ASIN` · `input[name='ASIN']` |

#### 数据采集 · 站点差异（`SITES`，21 个 Marketplace）

| 域名 | 站点 | 币种 | 语种 | 标题上限 | 建议上限 |
|---|---|---|---|---|---|
| amazon.com | 美国站 | USD | — | 75 | 70 |
| amazon.ca | 加拿大站 | CAD | — | 75 | 70 |
| amazon.co.uk | 英国站 | GBP | — | 75 | 70 |
| amazon.com.au | 澳大利亚站 | AUD | — | 75 | 70 |
| amazon.de | 德国站 | EUR | de | 75 | 70 |
| amazon.at | 奥地利站 | EUR | de | 75 | 70 |
| amazon.fr | 法国站 | EUR | fr | 75 | 70 |
| amazon.it | 意大利站 | EUR | it | 75 | 70 |
| amazon.es | 西班牙站 | EUR | es | 75 | 70 |
| amazon.nl | 荷兰站 | EUR | nl | 75 | 70 |
| amazon.com.be | 比利时站 | EUR | nl | 75 | 70 |
| amazon.se | 瑞典站 | SEK | — | 75 | 70 |
| amazon.pl | 波兰站 | PLN | — | 75 | 70 |
| amazon.co.jp | 日本站 | JPY | ja | 75 | 70 |
| amazon.in | 印度站 | INR | — | 75 | 70 |
| amazon.sg | 新加坡站 | SGD | — | 75 | 70 |
| amazon.ae | 阿联酋站 | AED | — | 75 | 70 |
| amazon.sa | 沙特站 | SAR | — | 75 | 70 |
| amazon.com.mx | 墨西哥站 | MXN | — | 75 | 70 |
| amazon.com.br | 巴西站 | BRL | — | 75 | 70 |
| amazon.com.tr | 土耳其站 | TRY | — | 75 | 70 |

> `lang` 为 `—` ＝英语系站点，其停用词走英语表；其余按 `stopwordsFor(lang)` 取对应语种表。`siteLang(host)` 容忍 `www.` 前缀，未知站点返回空串（不猜）。

#### 关键词挖掘 · 多语种停用词（`STOPWORDS_BY_LANG` / `stopwordsFor`）

| 语种 | 词表大小 | 代表虚词 |
|---|---|---|
| de | 75 | `und` · `der` · `die` · `das` · `den` · `dem` · `des` · `ein` · `eine` · `einen` · `einem` · `einer` … |
| fr | 70 | `le` · `la` · `les` · `un` · `une` · `des` · `du` · `de` · `et` · `ou` · `pour` · `avec` … |
| es | 58 | `el` · `la` · `los` · `las` · `un` · `una` · `unos` · `unas` · `de` · `del` · `y` · `o` … |
| it | 62 | `il` · `lo` · `la` · `gli` · `le` · `un` · `uno` · `una` · `di` · `del` · `della` · `dei` … |
| nl | 50 | `de` · `het` · `een` · `en` · `of` · `voor` · `met` · `zonder` · `op` · `aan` · `bij` · `naar` … |
| ja | 40 | `から` · `まで` · `より` · `など` · `こと` · `もの` · `する` · `され` · `した` · `して` · `です` · `ます` … |

> 🔴 **各语种表绝不能合并**：`car` / `son` / `main` / `kind` / `tag` / `ring` / `boot` / `note` / `tank` / `rock` / `van` / `over` / `fur` / `solo` / `plus` / `war` / `era` 这些词在英语里是**真词**，混进非英语表会把真实关键词一起删掉。
> ⚠️ `die`（德语第一大虚词 vs 英语 die-cut）是**有意保留的例外**，已被断言固定住，别当漏网之鱼去「修」。

#### 数据采集 · 搜索结果页批量解析（`detectPageKind` / `extractSearchResults`）

| 函数 | 作用 |
|---|---|
| `detectPageKind(html)` | 判 `search` / `detail` / `unknown` —— **同一段 DOM 必须先分流再解析**，否则搜索页会被当成「缺字段的详情页」 |
| `extractSearchResults(html, url)` | 整页解析：标题 / 价格 / 评分 / 评论数 / ASIN / 是否广告位 |
| `searchItemsToCompetitors(items)` | 转成多竞品对比要的 `[{name,text}]` 形态 |
| `searchItemsCorpus(items)` | 拼成可喂给关键词挖掘的一段语料 |
| `searchItemsSummary(items)` | 价格/评分/评论数的 min/max/median/avg/n（**空列表返回 `null` 而不是 `NaN`**） |

> ⚠️ 去重**必须放在计数之前** —— 同一商品可能出现重复卡片，先计数会把 `sponsored` / `withAsin` 刷高（实测踩到）。

#### 本地产物 · 持久化常量（`assets/store.js`，IndexedDB）

| 常量 | 值 | 说明 |
|---|---|---|
| `MAX_PAYLOAD_CHARS` | 400000 | 单条载荷上限，超了裁剪并打 `truncated` 标记 |
| `MAX_RECORDS_PER_KIND` | 60 | 每类最多留几条，超了淘汰最旧的 |

| 类（`KINDS`） | 名称 |
|---|---|
| `capture` | 采集 |
| `plan` | 图像方案 |
| `listing` | Listing |
| `coverage` | 覆盖度 |

> 🔴 **产物与配置刻意分两层**：`store.js` 只存产物（采集/方案/草稿/覆盖度），**API Key 永不进这里**，仍走服务端 `.env.local`。
> 这样「导出全部产物给同事」这条路径**从数据结构上就不可能夹带密钥**，不靠代码自觉。

#### 设置项与默认值（`DEFAULT_CONFIG`，存 localStorage 键 `clx_listing_workbench_config`）

| 配置项 | 默认值 |
|---|---|
| `serverUrl` | （空） |
| `imageBaseUrl` | `https://api.apimart.ai/v1` |
| `imageModel` | `gpt-image-2` |
| `imageApiKey` | （空） |
| `imageMode` | `auto` |
| `imageResolution` | `2k` |
| `chatBaseUrl` | `https://api.openai.com/v1` |
| `chatModel` | `gpt-4o-mini` |
| `chatApiKey` | （空） |
| `visionModel` | （空） |
| `enableAiPolish` | `false` |

#### Rufus 模块 · 属性清单（`CATEGORY_ATTRIBUTES`，8 个产品类型）

> `source` 只有三个合法取值：`amazon-guide`（帮助文档正文明确举例或定义）/ `amazon-schema`（Flat File 模板列名 / SP-API Product Type Definition schema 字段名 / 后台表单字段名）/ `practitioner`（无官方明文，行业通行）。**宁可标低不许标高**：拿不准一律 practitioner。
> `required` 的语义是「官方帮助文档正文明确要求必填」，**不是**「常识上应该必填」—— 放进 required 必须能附上引用句，拿不出引用句的一律放 recommended。界面上写「必填」等于替亚马逊下断言，只有官方明文可证才允许这样说。

| 产品类型 | 中文标签 | required | recommended | 合计 | required 字段（`key`） |
|---|---|---|---|---|---|
| `home_kitchen` | 家居厨房（Home & Kitchen） | 5 | 16 | 21 | `item_name`、`item_type_keyword`、`color`、`size`、`material` |
| `apparel` | 服装（Apparel） | 4 | 15 | 19 | `item_name`、`size`、`color`、`material` |
| `electronics` | 电子产品（Electronics） | 3 | 19 | 22 | `item_name`、`color`、`item_weight` |
| `pet_supplies` | 宠物用品（Pet Supplies） | 5 | 19 | 24 | `item_name`、`size`、`color`、`material`、`item_weight` |
| `beauty` | 美妆个护（Beauty & Personal Care） | 5 | 15 | 20 | `item_name`、`unit_count`、`unit_count_type`、`size`、`color` |
| `sports_outdoors` | 运动户外（Sports & Outdoors） | 5 | 17 | 22 | `item_name`、`color`、`size`、`material`、`item_weight` |
| `baby` | 母婴（Baby） | 4 | 20 | 24 | `item_name`、`color`、`size`、`material` |
| `office` | 办公用品（Office Products） | 5 | 18 | 23 | `item_name`、`color`、`size`、`material`、`item_weight` |

字段条目合计 **175**（required 36 / recommended 139）；按 source 分布：`amazon-guide` 86 / `amazon-schema` 43 / `practitioner` 46。

> 只有 `item_name`（全部 8 个类目）带 alias 读法层：`alias: ['title']`。读「该字段填了没有」时 `listing[e.key]` 非空 **或** 别名键非空即视为已填。没有它，用户在标题框填了标题、仍会被判「商品标题缺失」（必然误报）。其余 key 都是结构化类目属性，草稿模型（title / highlights / bullets / description / searchTerms）里没有语义等价字段，故一律不加别名。
> 另注：`bullet_point` / `product_description` / `title_differentiation` / `generic_keywords` 这几个内容类字段**本就不在**本清单里 —— 它们属 listing 内容模型，不是类目属性，因此没有为它们加 alias 的位置。

#### Rufus 模块 · 买家问题覆盖矩阵（`CATEGORY_QUESTIONS`）

> 🔴 全部 `source` 都是 `practitioner`。**我们没有任何官方问题清单** —— 这份清单是从业者口径（由评论 / Q&A / 客服收件箱归纳的经验值），绝不许写成官方。

| 产品类型 | 问题数 | 本题材前 3 题（原文） |
|---|---|---|
| `home_kitchen` | 10 | Will this fit a standard 30-inch cabinet? / What is it made of? / Is it dishwasher safe? |
| `apparel` | 10 | What size should I order if I normally wear a medium? / Is the fabric stretchy or rigid? / Can I machine wash this? |
| `electronics` | 10 | Does it come with a charger and cable in the box? / Are batteries included or do I need to buy them? / How long does the battery last on a full charge? |
| `pet_supplies` | 10 | What size dog is this suitable for? / Is this chew-proof for aggressive chewers? / Can I wash this in the washing machine? |
| `beauty` | 10 | What are the full ingredients in this product? / Is it suitable for sensitive or acne-prone skin? / Is this cruelty-free and vegan? |
| `sports_outdoors` | 10 | How much weight can this hold? / Is it waterproof for use in the rain? / What are the packed dimensions and weight? |
| `baby` | 10 | Is this safe for a 6-month-old baby? / What is the maximum weight limit? / Is it machine washable? |
| `office` | 10 | Does it fit standard 8.5 x 11 inch paper? / Is it compatible with both Windows and Mac? / How long is the cable or cord? |

问题合计 **80** 条。每条含 `id`（形如 `<productType>-q<n>`）/ `question`（英文，模拟买家在 Rufus / Alexa 里的真实问法） / `answerHints`（回答里应出现的关键信息类型，供机械匹配）/ `why` / `source`。

#### Rufus 模块 · 单位族（`UNIT_GROUPS`，6 族）

> 判定窗口**只在一个族内**：族内同时出现英制与公制才报。跨族（如重量 `lb` 与尺寸 `cm`）是不同维度，报它就是猜。

| 族 id | 中文 | 英制 | 公制 | 写法数 | source |
|---|---|---|---|---|---|
| `weight` | 重量 | oz / ounce / ounces / lb / lbs / pound / pounds | g / gram / grams / kg / kilogram / kilograms / mg / milligram / milligrams | 16 | `practitioner` |
| `length` | 长度 / 尺寸 | in / inch / inches / ft / foot / feet / yd / yard / yards | mm / millimeter / millimeters / cm / centimeter / centimeters / m / meter / meters | 18 | `practitioner` |
| `volume` | 体积 / 容积 | fl oz / fluid ounce / fluid ounces / gal / gallon / gallons / qt / quart / quarts / cup / cups / pt / pint / pints | ml / milliliter / milliliters / l / liter / liters / cl / centiliter / centiliters | 23 | `practitioner` |
| `temperature` | 温度 | f / fahrenheit / deg f / degree fahrenheit / degrees fahrenheit | c / celsius / deg c / degree celsius / degrees celsius / centigrade | 11 | `practitioner` |
| `power` | 功率 | w / watt / watts | kw / kilowatt / kilowatts | 6 | `practitioner` |
| `battery_capacity` | 电池容量 | mah / ah | wh / kwh | 4 | `practitioner` |

歧义单位白名单（`UNIT_AMBIGUOUS_WHITELIST`）：`oz` / `lb` / `kg`。单位 token 长度 ≤2 且不在白名单者（`in`、`g`、`w`、`mm`、`cm`、`ft` …）一律**不参与**判定，因为它们同时可能是普通词（`in` 是介词）；白名单里的三个虽同样短，但语义明确，仍参与判定。

#### Rufus 模块 · 互斥材质词对（`MATERIAL_CONFLICTS`，15 对）

> guards 对齐纪律：同一类语境事实在**所有**词对上必须写成同一份，禁止「这对有 `lining`、那对没有」。否则「主体 + 部件」复合商品（如主体陶瓷 + 塑料底座）会在词表不齐的那几对上误报。

| 词对 | 说明 | guards 合计 | 全对共用地板词 | 本对专有话术 | source |
|---|---|---|---|---|---|
| `cotton` ↔ `polyester` | 纯棉与涤纶互斥 | 37 | 33 | `poly-cotton`、`cotton-poly`、`cotton blend`、`polyester blend` | `practitioner` |
| `leather` ↔ `faux leather` | 真皮与人造革互斥 | 33 | 33 | — | `practitioner` |
| `leather` ↔ `vegan leather` | 真皮与素皮互斥 | 33 | 33 | — | `practitioner` |
| `stainless steel` ↔ `plastic` | 不锈钢与塑料互斥（主体材质不能两说） | 33 | 33 | — | `practitioner` |
| `down` ↔ `polyester` | 羽绒与聚酯纤维填充互斥 | 35 | 33 | `synthetic down`、`down alternative` | `practitioner` |
| `wool` ↔ `acrylic` | 羊毛与腈纶互斥 | 33 | 33 | — | `practitioner` |
| `silicone` ↔ `latex` | 硅胶与乳胶互斥 | 33 | 33 | — | `practitioner` |
| `genuine leather` ↔ `synthetic` | 真皮与合成材质互斥 | 33 | 33 | — | `practitioner` |
| `glass` ↔ `acrylic` | 玻璃与亚克力互斥 | 33 | 33 | — | `practitioner` |
| `wood` ↔ `metal` | 木质与金属互斥（主体材质不能两说） | 33 | 33 | — | `practitioner` |
| `ceramic` ↔ `plastic` | 陶瓷与塑料互斥 | 33 | 33 | — | `practitioner` |
| `aluminum` ↔ `carbon steel` | 铝与碳钢互斥 | 34 | 33 | `alloy` | `practitioner` |
| `suede` ↔ `faux suede` | 麂皮与人造麂皮互斥 | 33 | 33 | — | `practitioner` |
| `sheepskin` ↔ `faux fur` | 羊皮与仿毛互斥 | 33 | 33 | — | `practitioner` |
| `organic cotton` ↔ `regular cotton` | 有机棉与普通棉互斥（同一字段不能两说） | 33 | 33 | — | `practitioner` |

**全对共用地板词（33 个，实测为所有词对 guards 的交集）**：`lining` `lid` `base` `frame` `legs` `handle` `trim` `coating` `coated` `insert` `sole` `strap` `buckle` `panel` `cover` `grip` `rim` `shell` `filling` `padding` `cushion` `sleeve` `hood` `collar` `blend` `mixed` `mix` `combination` `compound` `weave` `woven` `knit` `knitted`

> 逐对层**只能放「离开本对就无意义」的复合词**。`alternatives` 是反面教材 —— 它会被 `better than alternatives` 这类正常文案命中、把真冲突静默压掉，**已删除**。另：通用连接词与纯符号一律不作 guard（stoplist = `and` `or` `with` `&` `+` `%` `/` `,`），它们在任何文案里都出现，当 guard 等于把真冲突一起放过。故意不收 `top` / `bottom` —— 会命中 `top quality cotton` 这类质量形容，属误伤。

#### Rufus 模块 · 数值 + 单位提取（`NUMBER_UNIT_RE`）

- `pattern`：`\b(\d+(?:[.,]\d+)?)\s*(?:-|to|~)?\s*(\d+(?:[.,]\d+)?)?\s*(fl\s?oz|fluid\s?ounces?|degrees?\s*fahrenheit|degrees?\s*celsius|milliliters?|centiliters?|millimeters?|centimeters?|kilograms?|milligrams?|kilowatts?|fahrenheit|celsius|milliliter|centiliter|millimeter|centimeter|kilogram|milligram|kilowatt|gallons?|quarts?|pints?|ounces?|pounds?|liters?|meters?|yards?|inch(?:es)?|watts?|hours?|minutes?|seconds?|sheets?|pieces?|counts?|packs?|mah|kwh|wh|°\s?[fc]|deg(?:rees?)?\s?[fc]|oz|lb|lbs|kg|mg|ml|cl|gal|qt|pt|cm|mm|ft|yd|hrs|in|g|l|m|w|v|ct|pcs)\b`（第 3 捕获组与 `.unit` **同源**，只写一次，永远不漂移）
- `flags` = `gi`｜`unit` 子模式枚举 65 个写法
- 捕获组：`1` = 第一个数值（整数或小数）｜`2` = 区间上界（如 `10-12 inches` 里的 `12`）｜`3` = 单位文本

#### Rufus 模块 · 规则表（`RUFUS_RULES`，7 条）

| id | 组 | 级别 | 作用域 | 按问题展开 | sourceTier | why |
|---|---|---|---|---|---|---|
| R1-01 | R1 | P | `attributes` | — | `official` | 官方明文要求必填的字段空着，商品进不了结构化比对，也进不了最细的浏览分类。 |
| R1-02 | R1 | C | `attributes` | — | `practitioner` | 推荐字段不填不致命，但会让买家问题没有答案、让商品在筛选里消失。 |
| R2-01 | R2 | C | `facts` | — | `practitioner` | 同一 listing 里两处说两个互斥材质（如标题纯棉、描述纯涤纶），Rufus 会在比对阶段降权。 |
| R2-02 | R2 | C | `facts` | — | `practitioner` | 标题说 2 件、五点说 3 件这类件数自相矛盾，是最常见的退货诱因之一。 |
| R3-01 | R3 | C | `units` | — | `practitioner` | 同一维度（如重量）在 listing 里同时用英制与公制表述，比价与规格比对会取到互相打架的数值。 |
| R4-01 | R4 | C | `coverage` | ✅ | `practitioner` | 买家高频问题在 listing 里找不到答案，Rufus 就没有可引用的句子，只能去别家找。 |
| R5-01 | R5 | C | `imageText` | — | `practitioner` | 规格 / 兼容性 / 成分 / 尺码只印在图上，机器读不到，等于这些信息不存在。 |

> 🔴 分级保守：R 组**出厂默认 C 级**；唯 R1 的 required 档、且守卫字段 `source === 'amazon-guide'` 者可判 P。跨字段一致性 / 单位制 / 图内文字都是从业者口径，报「发布前必须修改」就是撒谎。所以 `R1-01` 的级别是**运行时算出来的**（`test()` 返回的 `level` 覆盖静态值），静态表里写的 `P` 只是上限。
> `R4-01` 的 `perQuestion: true` 表示该条目**按 productType 的问题矩阵展开**为 R4-01…R4-0n，不产生自身的单条结果。

#### Rufus 模块 · 返回结构与分组口径（`lintRufus`）

`results[i] = { id, group, level, scope, status, detail, why, source, sourceTier }`，与 `lintListing` **同构**。

| 项 | 取值 |
|---|---|
| `status` 四值 | `命中` / `通过` / `通过（部分）` / `跳过` |
| `summary` 键 | `total` / `hit` / `hitP` / `hitC` / `skipped` / `byGroup` / `conclusion` |
| `byGroup[gid]` 键 | `total` / `hit` / `pass` / `partial` / `skipped` / `covered` / `miss`（其中 `covered = pass + partial`、`miss = hit`） |

| 组 id | 名称 |
|---|---|
| `R1` | attributes 完整性 |
| `R2` | 跨字段事实一致性 |
| `R3` | 单位制一致性 |
| `R4` | 买家问题覆盖矩阵 |
| `R5` | 图内文字未文本化 |

`conclusion` 三态（判定顺序自上而下，**不可换序**）：

1. 有 P 级命中 → `存在硬规则命中，发布前必须修改`
2. 无 P 级但有命中 → `硬规则全过，软规则有可优化项`
3. 全无命中时再分两种：**已检查项（非跳过）为 0** → `无可检查项：全部跳过（请先填文案，或选择产品类型）`；否则才是 `全部通过`

> 🔴 第 3 条的分叉是**缺陷修复**（缺陷 K）：空表本来会报「全部通过」—— 一条没查也叫全部通过，等于界面说假话。已由 SPEC AC-04 锁住，自检 §23n 做双向锁（空表必须报「无可检查项」；全字段填满仍须能报「全部通过」）。

#### Rufus 模块 · 出处分级（`tierOf`，全项目唯一映射点）

| 数据层 `source`（三值） | 规则层 `sourceTier`（两档） | 证据引用串（`sourceRef`） |
|---|---|---|
| `amazon-guide` | `official` | Amazon Seller Central 帮助文档正文（《Attributes guide》/《目录属性规范化》） |
| `amazon-schema` | `official` | Amazon Flat File 模板列名 / SP-API Product Type Definition schema 字段名 / 后台表单字段名 |
| `practitioner` | `practitioner` | 行业通行，无官方明文 |

未知 `source` 值 **必须抛异常**，绝不静默归为 official；证据引用串随档不同，不共用笼统的「亚马逊官方文档」—— 模板列名不许说成帮助文档正文。

## 3. 模块二：编排层（`assets/orchestrator.js`）

### 3.1 用途

把"用户一句话"编排成"完整简报 + 14 张 Prompt"，并负责在线/离线双路径切换。

### 3.2 操作流程（`runLocalTurn` 六步）

| 步 | 动作 | 产出事件 |
|---|---|---|
| ① | 匹配场景模板 | `tool_call` + `tool_result`（含匹配依据与候选状态） |
| ② | 诊断转化驱动力 | `tool_call` + `tool_result`（含置信度与推进顺序） |
| ③ | 识别品类 | `tool_result`（命中才发） |
| ④ | 建立 Campaign Style Lock | `tool_call` + `tool_result` |
| ⑤ | 组装 Prompt（单张或整套） | `tool_call` + `tool_result`（报告套用了哪些铁律） |
| ⑥ | 机械自检 | 结果写入简报（通过时也明说"查了哪几条"） |
| ⑦ | 生成简报 | `ai_response` |
| — | 成本说明 | `usage`（cost: 0） |

### 3.3 功能点明细

#### 3.3.1 主体抽取（`extractSubject`）

- **用途**：从"帮我给这款宠物自动喂食器做一整套主图和详情页，走痛点驱动"里抽出 `宠物自动喂食器`。
- **为什么重要**：主体会被拼进**每一张**图的 Prompt（`Subject and scene: ___`），抽脏了 14 张全脏。
- **流程（三步）**：
  1. 按标点切从句，**排除含风格词的从句**（痛点/风格/氛围/高级/驱动…）→ 剩下的按长度降序排队
  2. 逐个从句尝试清洗：切掉图类型之后的部分 → 处理"主图：xxx"这种前缀标签
  3. 反复剥噪声前后缀（礼貌语 / 给·把 / 我·我们的·这款 / 系动词 / 动词 / 营销形容词 / 量词）
- **关键设计（都是踩坑后的修正）**：
  - **逐句尝试而不是只挑一句**：「帮我出一张白底主图，产品是无线蓝牙耳机」前半句洗完是空的，必须能退到后半句。
  - **剥噪声顺序敏感**：必须先剥「给/把」再剥「我」。否则「给**我们的**硅胶婴儿餐盘」会被 `给我` 抢先吃掉，剩成「们的硅胶婴儿餐盘」。
  - **单字判定阈值 ≥2 字符**：`出`、`一张` 这种不是产品名。
  - **被图类型截过的从句要再查残渣**：挡「做一张促销海报 banner，走视觉驱动」这类**根本没有产品名**的输入（截完剩"一张促销"，看着像主体，其实是残渣）。
  - **不能误杀带风格词的品名**：`氛围灯` 必须能通过（所以风格词判定收窄为"以风格副词起头 + 含风格词"）。
- **兜底**：全部失败返回 `""` → 调用方填 `{PRODUCT}` 占位符，**并在简报首行显式告警**（不让用户误以为这是成品）。
- **⚠️ 这是最值得审的功能之一**：见 §0.4 问题 4。

#### 3.3.2 简报生成（`buildBriefMarkdown`）

- **用途**：把编排结果写成人类可读的 7 段报告。
- **结构**：① 匹配模板 → ② 驱动力诊断 → ③ Style Lock → ④ 14 张规划表 + 角度自检 + 机械自检 → ⑤ 第 1 张完整 Prompt → ⑥ 硬参数核对表 → ⑦ 下一步
- **关键设计**：主体抽取失败时，**首行加显式告警**；机械自检通过时也明确列出"查了哪几条"，而不是只字不提。

#### 3.3.3 双路径切换（`runTurn`）

- **流程**：`probeServer()` → 在线则 `postChat`（SSE）→ 失败则**回退**到 `runLocalTurn` 并提示用户。
- **关键参数**：探活超时 2.5 秒。
- **设计要点**：两条路径吐出的**事件结构与文案格式完全一致**，前端不需要写两套渲染。

#### 3.3.4 生图与润色

- `generateOne({ prompt, size, imageKey })`：单张出图，带进度事件；离线或未配 key 时**明确报错而非静默失败**。
- `runImg2ImgTurn()`：有参考图时先识图再走图生图。
- `polishSubject()`：可选的 LLM 润色（默认关）。

---

## 4. 模块三：Listing 文案与合规质检（`assets/listing.js`）

### 4.1 用途

三件事：**关键词挖掘**（不给 LLM）、**28 条合规质检**、**规则式草稿生成**，外加**按亚马逊后台字段格式的导出**。

### 4.2 操作流程

```
① mineKeywords(竞品文本)  → 1/2/3-gram 词频，剔除停用词，按「频次×长度权重」排序
② generateListingDraft()  → 规则式草稿：标题 / 五点 / Search Terms / A+ 7 屏骨架
③ lintListing(listing)    → 28 条规则逐条判定 → 汇总结论
```

### 4.3 功能点明细

#### 4.3.1 关键词挖掘（`mineKeywords`）

- **用途**：从竞品标题+五点+评论里挖关键词。
- **为什么不用 LLM**：**词频是可复现的客观量**，交给模型反而不可验证。
- **流程**：清洗（去标点/智能引号）→ 分 token → 去停用词与纯数字 → 统计 1/2/3-gram → 加权排序。
- **关键参数**：`top=40`、`minCount=1`、`includeNgrams=true`；2-gram 权重 1.4、3-gram 权重 1.2。

#### 4.3.2 Search Terms 构造（`buildSearchTerms`）

- **用途**：拼 Search Terms 并卡**字节**上限（注意是字节不是字符）。
- **关键参数**：上限 250 字节、可传 `exclude`（品牌名等）、返回 `{ value, bytes, dropped[] }`。

#### 4.3.3 词边界匹配（`matchWords`）

- **用途**：词表匹配的统一入口。
- **关键设计**：**必须用正则词边界，不能用 `includes`** —— 否则 `secure` 命中 `cure`、`freedom` 命中 `free`。质检器的误报会直接消耗对工具的信任。
- **反例**：`cure` 的检查曾漏掉裸词 `guarantee`（表里只有 `guaranteed results`），而裸词恰是卖家最常写、平台最常抓的形态。

#### 4.3.4 28 条质检规则（`RULES` + `lintListing`）

- **规则结构**：每条含 `id / level / scope / test() / why / source`。
  - `level`：`P`（硬规则，平台级，有下架/降权风险）或 `C`（软规则，转化/可读性/需举证）
  - `source`：`平台公开规则` / `行业通行做法` / `项目自定义` —— **显式区分，不把自定义阈值伪装成官方标准**
- 🔴 **P 与 C 的判据不是"重要程度"，而是"错了会不会被打"**：
  - `P` ＝ 平台级风险（拒收 / 下架 / 降权 / 侵权 / 注入）→ 结论用「发布前必须修改」
  - `C` ＝ 转化、可读性、需要举证 → 结论只提示「可优化」，不制造虚假紧迫感
  - **本轮修正的反例**：原 `P9`「五点应以大写引导词 + 冒号开头」**降级为 `C9`** —— 这是**行业惯例**，没有任何平台文档要求这么做。把惯例放进硬规则，会让"五点内容全过、只是格式不合惯例"的 listing 被报成「发布前必须修改」，**结论强度与真实风险不匹配**。同时放宽正则，允许首词后接小写（`Easy to clean:` 也合理）。
- **返回四态**：`命中` / `通过` / `跳过`（对应字段为空）—— **空字段算"跳过"，不算"通过"**
- **summary 字段**：`{ total, hit, hitP, hitC, skipped, conclusion }`
  - `conclusion` 三档：`存在硬规则命中，发布前必须修改` / `硬规则全过，软规则有可优化项` / `全部通过`

**规则清单不在这里重复**（避免同一份文档出现两张会漂的表）：

> 📌 **规则全表见 §2.4 参数附录的「Listing · 全部规则（`RULES`）」** —— 那张表由
> `tools/_export-details.mjs` **从代码导出**（含 id / 级别 / 作用域 / 空值是否判定 / 来源 / why），
> 不是手抄。手抄的规则表一定会和代码漂，所以这里只留结构性说明。
>
> 当前规模：**28 条（硬规则 14 + 软规则 14）**，作用域从 4 个增到 6 个
> （`title` / `bullets` / `searchTerms` / `copy` / `highlights` / `titleHighlights`）。
> `highlights` 与 `titleHighlights` 是 2026-09-29 随标题新规加的，见 §18。

**几条只有看代码才看得出来的设计**（不放进导出表、但审阅时值得知道）：

| 设计 | 说明 |
|---|---|
| **`copy` 作用域为什么存在** | **"标题、五点各自合规、拼在一起不合规"是最常见的绕过形态**（标题干净、五点写疗效）。合规类规则（P6 声明 / P12 HTML / P15 站外引流）看的是标题 ＋ 五点 ＋ Item Highlights 拼成的**整块文案**。🔴 2026-09-29 把 `highlights` 也收进 `copy` —— 不收的话新字段立刻成为新的绕过口子（有断言锁住） |
| **`emptyOk` 与 `hasContent`** | 一般规则遇到字段为空**跳过**是对的（空字段算跳过、不算通过）。但 `C10`（Highlights 为空）要报的恰恰是"空"本身，所以给了它一个放行口。放行有个前提：**整张表一个字都没填时不放行** —— 否则第一次打开工作台就会看到一条噪音，而"在空表上乱叫"是质检器最快失去信任的方式 |
| **`P5` 字母 < 8 个时跳过** | 短标题（如 `"Mug 350ml"`）算大写占比会误伤 |
| **`P11` 未填品牌则跳过** | 没有品牌就没有"重复品牌名"这回事，报它是假警报 |
| **`C5` 与 `C13` 是两回事** | `C5`（项目自定义）管**≥3 次**的堆砌观感，词长 > 3 且排除停用词；`C13`（第三方清单的 best practice）管**任何重复**（≥2 次），词长 > 2 且排除品牌词。阈值与来源都不同，删任一条都会丢一个档位 |

**P6 的三个桶 + 品类差异化**：

| 桶 | 词表 | 说明 |
|---|---|---|
| ① 疾病 / 医疗 | `DISEASE_TERMS`（76 个） | 亚马逊官方文档明列的疾病名，未经 FDA 批准不得声称诊断/治愈/缓解/治疗/预防。⚠️ `stroke` / `gout` 有极少数日常义，文案写「疑似」并要求人工确认 |
| ② 农药 / 抗菌 | `PESTICIDE_CLAIMS`（27 个） | 写了就进入 EPA 注册范畴（`antibacterial` / `kills germs` / `repels pests` …） |
| ③ 保证性 / 绝对化 | `CLAIM_WORDS`（71 个） | `guarantee` / `100% safe` / `clinically proven` / `包治` / `根治` 等 |
| ④ 品类专属 | `CATEGORY_CLAIMS`（8 品类） | 同一个词在不同品类风险不同 |

**词表取舍（这是本项目最花心思的一处，也是"误报＝工具失信"的直接落地）**：

| 取舍 | 内容 | 理由 |
|---|---|---|
| **剔除** | 官方疾病表里的 `add` / `sad` / `mono` / `pid` / `crabs` / `tbi` / `ngu` | 会命中 `Add to cart` / `Sad puppy` / `mono output` / `PID controller` / 海鲜与螃蟹玩具；纯缩写收益为零。保留其无歧义全称（`attention deficit` / `seasonal affective disorder` / `mononucleosis` / `pelvic inflammatory disease` / `pubic lice` / `traumatic brain injury`） |
| **不收** | `PROMO_WORDS` 里不放 `perfect` | `perfect for gifting` 是海量合规 listing 的正常写法 |
| **不收** | `BENEFIT_WORDS_ZH` 里不放单字「更」「省」 | 会命中"更衣""省份"甚至品牌名 —— 中文没有词边界，**只能收两字以上的词** |
| **改口径** | 单个 `%` / `#` / `+` 不进符号黑名单，改由 C7「符号密度」兜底 | `100% Cotton` / `Model #A` / `2+1 Pack` 都是合法写法，逐符号硬禁＝大面积误报 |
| **降级** | 环境声明 / 不证自明声明定为 **C8 软规则** | 平台要求的是"有证据"，不是"禁用"；结论应是"请准备好证据"而不是"删掉" |

**字段上限（`LIMITS`）** —— 同样**不在这里重复**，全表见 §2.4 参数附录（从代码导出）。
一句话概括 2026-09-29 之后的口径：**标题 75（media 例外 200）+ Item Highlights 125，两项合计 200**；
Search Terms 按**字节** 250，其余按**字符**。详见 §18。


#### 4.3.5 规则式草稿生成（`generateListingDraft`）

- **用途**：给一个"结构正确、硬规则全过"的骨架，省掉从零排版。
- **⚠️ 诚实声明（代码注释里也写了）**：这是**机械填空，不是创意文案**。卖点措辞仍需人工改写。
- **流程**：
  - 标题：按"核心词 + 规格 + 品类 + 受众"组装，**超长从尾部整段剥**（而非任意截断）；
    🔴 剥下来的片段**不再丢弃**，而是按 role 分配去处：规格/数量/人群 → **Item Highlights**，长卖点句 → 五点（见 §18）
  - 五点：`BULLET_LEADS` 引导词 + 利益 + 支撑细节，**默认对齐 C9 的 `大写引导词:` 格式**（C9 是软规则，所以这个格式是"模板给的默认值"，不是强制约束）
  - Search Terms：`buildSearchTerms()` 自动排除品牌名
  - A+ 内容：固定 **7 屏**骨架
- **A+ 7 屏**：① Who this is for ② What it solves ③ How it works ④ Core benefits ⑤ Materials & quality ⑥ How to use it ⑦ Still deciding?
  - ⚠️ 其中 ②③⑤⑥ 是**占位提示语**（如 "State the specific friction this replaces — no invented numbers."），刻意不编造数据。
- **notes 字段**会返回三条提醒（含"所有材质/认证/数据必须有真实证据"）。

#### 4.3.6 关键词覆盖度分析（`analyzeCoverage` + `hasTerm`）

**用途**：回答"竞品在打的核心词，我是不是一个字都没提"。
这是同类方案（`nexscope-ai/Amazon-Skills` 的 keyword coverage tracking）里有、本项目原先没有的一块，
2026-09-29 按本项目的方式补上：**纯函数、零网络、可断言**。

**输入**：`{ title, bullets, searchTerms, description }` + `keywords`（用户候选词）+ `competitorText`（竞品语料）。
**输出**：逐词的 4 位置命中矩阵 + `gaps` / `minedGaps` / `weak` / `unused` + `coveragePct`。

🔴 **两类缺口必须分开（这是这块最关键的设计）**：

| 字段 | 含义 | 界面角色 |
|---|---|---|
| `gaps` | **用户自己选定的**候选词里，竞品在打、我完全没有 | 待办 —— 优先补进标题或五点 |
| `minedGaps` | 从竞品语料自动挖出的其他词 | 线索 —— **含 n-gram 噪声，只当线索看** |

理由：实测把竞品语料挖出的词全部混进 `gaps` 后，噪声（`dogs reduces` / `no-pull dog` 这类）
会把真正该补的 `anti-pull` / `small dogs` 直接淹掉。**报得越多，越没人看。**

**四个容易写错的地方（都有断言锁住）**：

| 坑 | 处理 |
|---|---|
| ASCII 词不加词边界 → `cat` 命中 `category`、`mug` 命中 `smug` | `hasTerm()` 对**两端都是字母数字**的词加 `\b` |
| 但 `#1` / `2+1 pack` / `bpa-free` 加了 `\b` 反而匹配不上 | 按形态分流：以符号开头/结尾的走 `includes` |
| 中文没有词边界概念 | 中文词直接走子串匹配 |
| 竞品语料整段挖 n-gram → 产出跨句假短语（`cups second`） | **按句拆分**（`[.\n;!?]`）后分别挖 |

**尺度与免责**：
- 字段权重 `FIELD_WEIGHT` = **3/2/1/1**（标题/五点/描述/后台词），`source` 明确写「**行业通行做法，不是亚马逊官方明文**」
- 未提供竞品语料时 `competitor` 返回 **`null` 而不是 `false`** —— 不能用"假"冒充"竞品没覆盖"
- `note` 与界面都写明：**这是文本覆盖，不是搜索排名、不是搜索量**

---

## 5. 模块四：亚马逊数据采集（`assets/amazon.js`）

### 5.1 用途

解决一个**架构上的死结**：网页读不到亚马逊商品页的 DOM（跨域）。所以给用户两条**主动**通道，而不做服务端爬虫。

### 5.2 操作流程（两条通道）

**通道 A：书签脚本（推荐）**
```
① 用户把「抓取」书签拖到书签栏
② 打开亚马逊商品页，点该书签
③ 书签内联的 IIFE 读取当前页 DOM → 结构化提取
④ 写入系统剪贴板（用户手动 Ctrl+V 或自动）
⑤ 回到工作台 → 「数据采集」视图粘贴 → 自动解析
```

**通道 B：直接粘贴**
```
把 商品页 HTML / JSON / 纯文本 粘进文本框 → extractAny() 自动判类型 → 解析
```

### 5.3 功能点明细

#### 5.3.1 选择器表（`SELECTORS`）

- **用途**：集中定义 12 个字段的取数路径，每个字段给**多个备选选择器**（亚马逊 A/B 测试多）。
- **关键参数**（实测导出）：

| 字段 | 选择器 |
|---|---|
| `title` | `#productTitle` |
| `brand` | `#bylineInfo` |
| `bullets` | `#feature-bullets .a-unordered-list .a-list-item` · `#productFactsDesktopExpander .a-unordered-list .a-list-item` |
| `description` | `#productDescription` |
| `price` | `#corePriceDisplay_desktop_feature_div .a-offscreen` · `#corePrice_feature_div .a-offscreen` · `.a-price .a-offscreen` · `#priceblock_ourprice` · `#priceblock_dealprice` |
| `rating` | `#acrPopover .a-icon-alt` · `span[data-hook='rating-out-of-text']` · `#averageCustomerReviews .a-icon-alt` |
| `reviewCount` | `#acrCustomerReviewText` |
| `image` | `#landingImage` · `#imgTagWrapperId img` · `#imageBlock img` · `img[data-old-hires]` |
| `specTables` | `#productDetails_expanderTables_depthLeftSections .a-expander-container` · `#productDetails_expanderTables_depthRightSections .a-expander-container` |
| `breadcrumbs` | `#wayfinding-breadcrumbs_feature_div a` |
| `bestSellersRank` | `#SalesRank` · `#detailBullets_feature_div` |
| `asin` | `#ASIN` · `input[name='ASIN']` |

#### 5.3.2 站点差异（`SITES`）

**21 个 Marketplace**（全表含语种见 §2.4「数据采集 · 站点差异」）。下表只取 6 个代表站点：

| 域名 | 站点 | 币种 | 标题上限 | 建议上限 |
|---|---|---|---|---|
| amazon.com | 美国站 | USD | 75 | 70 |
| amazon.co.uk | 英国站 | GBP | 75 | 70 |
| amazon.de | 德国站 | EUR | 75 | 70 |
| amazon.fr | 法国站 | EUR | 75 | 70 |
| amazon.co.jp | 日本站 | JPY | 75 | 70 |
| amazon.ca | 加拿大站 | CAD | 75 | 70 |

> ⚠️ 口径要说清：这两个字段是**展示用**（站点表上给个参照），**不参与判定**。
> 真正参与判定的是 `listing.js` 的 `LIMITS.title` / `titleLimit(ctx)`（见 §18）。
> 两道口径由自检里的断言锁在一起（`SITES[*].titleLimit === LIMITS.title`），改一处忘另一处会红。
> 所以历史上这两处曾经不同步（站点表还写着 `200/150`、判据已是 `75`），**是这份文档没跟上，不是代码**。

#### 5.3.3 三种输入解析

| 函数 | 输入 | 说明 |
|---|---|---|
| `extractFromDoc(doc, url)` | 已解析的 DOM | 书签脚本用 |
| `extractFromHTML(html)` | HTML 字符串 | 用 `DOMParser` 离线解析 |
| `extractFromText(text)` | 纯文本 | 兜底 |
| `extractAny(text)` | 任意 | **自动判类型**；空输入或缺少 title/bullets 时**抛错而非静默返回空对象** |

#### 5.3.4 书签脚本（`bookmarkletSource` / `bookmarkletHref`）

- **关键设计**：**自包含 IIFE**，不引用本应用的任何模块（书签环境没有模块系统）。
- **传输方式**：剪贴板中转（不用 postMessage，避免跨域与用户无感知的隐式通信）。

---

## 6. 模块五：传输层（`assets/api.js`）

### 6.1 用途

统一"本地服务在线/离线"的判定与请求，是双路径架构的开关。

### 6.2 功能点明细

| 函数 | 用途 | 关键参数 |
|---|---|---|
| `getConfig()` / `setConfig()` | 读写设置 | localStorage 键 `clx_listing_workbench_config` |
| `probeServer()` | 能力探测 | **2.5 秒超时**；失败返回 `{ online: false, reason, capabilities: {image:false,...} }` |
| `streamSSE()` | 解析 SSE 流 | 7 种事件：`ai_response` / `tool_call` / `tool_result` / `file_output` / `usage` / `ping` / `error_message` |
| `postChat()` | 走服务端编排 | 支持 `AbortSignal` 中断 |
| `uploadImage()` | 上传参考图 | — |
| `generateImage()` | 真出图 | — |
| `callVision()` / `callLLM()` | 识图 / 对话 | — |

### 6.3 设置项默认值

| 配置项 | 默认值 |
|---|---|
| `serverUrl` | （空 = 同源） |
| `imageBaseUrl` | `https://api.apimart.ai/v1` |
| `imageModel` | `gpt-image-2` |
| `imageApiKey` | （空） |
| `imageMode` | `auto`（自动判同步/异步） |
| `imageResolution` | `2k` |
| `chatBaseUrl` | `https://api.openai.com/v1` |
| `chatModel` | `gpt-4o-mini` |
| `chatApiKey` | （空） |
| `visionModel` | （空） |
| `enableAiPolish` | `false`（默认不走 LLM） |

**离线降级的用户体验**：顶部状态显示"本机离线模式 · 模板库 / Prompt 引擎 / Listing 质检均可离线跑"，输入区显示"本机编排 · 仅出 Prompt"。**不让用户以为"点了没反应是 bug"**。

---

## 7. 模块六：本地服务（`server.mjs`）

### 7.1 用途

在需要"真出图 / 真识图 / 调 LLM"时提供后端；全部规则功能不依赖它。

### 7.2 接口清单（8 个）

| 接口 | 方法 | 用途 | 关键设计 |
|---|---|---|---|
| `/api/health` | GET | 能力探测 | 返回 `capabilities` 与模板数，供前端决定走哪条路径 |
| `/api/config` | POST | 写密钥到 `.env.local` | — |
| `/api/upload` | POST | 上传参考图 | **自写 multipart 解析**（零依赖） |
| `/api/blob` | GET | 读回生成图 | **前缀白名单校验，防 SSRF** |
| `/api/image` | POST | 生图 | **双模式适配**：apimart 异步轮询 / OpenAI 同步 |
| `/api/vision` | POST | 识图 | — |
| `/api/llm` | POST | chat completions 代理 | — |
| `/api/chat` | POST | **SSE 编排主入口** | 复用 `runLocalTurn`，只额外做"识图 + 出图" |

### 7.3 关键设计

- **只监听 `127.0.0.1:8787`**，密钥从 `.env` / `.env.local` / 环境变量读取，不出本机。
- **生图双模式**：按域名判断 —— 含 `apimart` → 异步任务（提交后轮询 `/v1/tasks/{id}`）；其他 → OpenAI 同步。
- **`/api/chat` 复用编排**：🔴 曾有第二份手写实现导致"离线修好、服务端仍旧行为"，现在只 `import` 复用。
- **SSE 心跳**：每 5 秒发 `ping`，防中间层断连。

---

## 8. 模块七：前端外壳（`index.html` + `assets/app.js` + `assets/md.js`）

### 8.1 页面结构（单页 8 视图）

```
┌──────────────┬──────────────────────────────────────────────┐
│ 侧栏（三组）  │  主区                                         │
│              │                                              │
│ 创作          │ 创作台 —— 对话流 + 简报卡 + 图片卡              │
│  创作台       │   输入区：参考图 / ＋示例 / 整套 / 发送          │
│  模板库       │ 模板库 —— 25 张卡片（搜索 / 关键词 / 变体）      │
│  图片库       │ 图片库 —— 生成图清单 / 打包下载 ZIP / 删除      │
│ Listing      │ 文案与质检 —— 左输入 / 右 28 条逐条结果          │
│  文案与质检   │   （含 Rufus / Alexa 信息架构检查卡，见 §20）    │
│  数据采集     │ 数据采集 —— 书签脚本 + 粘贴框 + 解析结果         │
│  本周词库     │ 本周词库 —— 四格体检 / 搜索+排序 / 词表           │
│  本地产物     │ 本地产物 —— IndexedDB 记录清单 / 导出 JSON       │
│ 系统          │                                              │
│  设置与诊断   │ 设置与诊断 —— API 配置 + 能力探测                │
│ ── 状态：在线/离线 ──                                          │
└──────────────┴──────────────────────────────────────────────┘
```

**导航分组**：创作（3 个：创作台 / 模板库 / 图片库）、Listing（4 个：文案与质检 / 数据采集 / 本周词库 / 本地产物）、系统（1 个：设置与诊断），
共 **8 个 `#nav button[data-view]`**（依据：`index.html` 里 `data-view` 的去重取值）。
⚠️ 口径提醒：本文件历史上曾自相矛盾（§1.3 与 §8.1 分别写 7 与 5，都不对）。第 8 个视图是 2026-11-07 加的「本周词库」——
它当得起独立视图的唯一理由：词库是**全品类**能力，跟具体商品无关，而原先它只寄生在 Listing 页的一个抽屉里，
一次只铺 40 个 chip、不能搜、不给总数。
另：Rufus 检查卡与第 ⑦ 卡**仍然挂在「文案与质检」视图内，不单独占视图**（`index.html` 里有注释写明）。

图标一律是**内联描边 SVG**（viewBox 24 / 描边 1.75 / `currentColor` / 20px），**全项目零 emoji 图标** ——
自检第 24 节专门锁这条（防 emoji 图标、防静默空图标、防内联与注册表两份实现漂移）。

**路由方式**：`data-view` 属性 + CSS 类切换，无路由库、无 hash。
**唯一入口是 `goView(name)`**（`assets/app.js`）：侧栏点击与站内跳转（词库页「送进文案页」）都走它 ——
否则会出现"视角切了但侧栏高亮没动"这种只看截图看不出来的错位。视图的**首次取数**也挂在它里面（懒加载）。

### 8.2 事件协议（`dispatch` 的 6 个 case）

| case | 渲染成 | 内容 |
|---|---|---|
| `ai_response` | 简报气泡卡 | Markdown 渲染（`md.js`） |
| `tool_call` | 工具调用条 | 显示流水线正在做什么 |
| `tool_result` | 工具结果条 | 显示该步的产出摘要 |
| `file_output` | 图片卡 | 生成结果 + 模式/耗时/成本 |
| `usage` | 成本行 | cost / duration_ms / note |
| `error_message` | 错误条 | 明确错误原因（不静默失败） |

### 8.3 主要绑定与渲染函数

| 函数 | 职责 |
|---|---|
| `renderStatus` | 顶部在线/离线状态 |
| `bindNav` | 7 视图切换 |
| `dispatch` | SSE 事件分发（6 分支） |
| `renderMessages` / `renderOne` | 消息流渲染 |
| `bindComposer` | 输入区（含参考图上传、整套开关） |
| `bindTemplates` / `renderTemplateGrid` / `renderTemplateDetail` | 模板库视图 |
| `bindListing` / `renderListingLimits` | 质检视图 |
| `bindCapture` / `renderBookmarklet` / `renderProduct` | 采集视图 |
| `bindSettings` | 设置视图 |

### 8.4 Markdown 渲染（`md.js`）

- **用途**：渲染简报（表格、代码块、列表、粗体）。
- **安全设计**：**先整体 HTML 转义，再按白名单放行标签**。有 XSS 断言（`<script>`、`<img onerror>` 均被转义）。
- **关键参数**：围栏代码块内容不参与行内解析；行内 `` `code` `` 里的星号不被当粗体。

---

## 9. 模块八：模板数据层（`templates.js` + `tools/build-templates.mjs`）

### 9.1 数据规格（25 个模板）

- **模板数 25**｜变体合计 **88**｜示例合计 **66**｜`prompt_template` 字段种类 **66**
- 每个模板必填 **11 个字段**：`id / name / keywords / trigger_phrases / prompt_template / defaults / variants / category_tips / examples / anti_ai_tips / supports_image_reference`
- `variants` 每项固定 `{ description, overrides }`
- `prompt_template` 是**开放式 schema**（66 种字段名，随场景变化；`type`(25 次) 与 `subject`(24 次) 是较稳定的字段）

**25 个模板清单**（order / id / 名称 / keywords 数 / trigger_phrases 数 / 变体数）：

| order | id | 名称 | kw | trig | 变体 |
|---|---|---|---|---|---|
| 01 | `hero-image` | 白底/纯色底产品主图 | 8 | 6 | 4 |
| 02 | `lifestyle-scene` | 场景化生活图 | 7 | 6 | 4 |
| 03 | `flat-lay` | 平铺图 | 6 | 5 | 3 |
| 04 | `detail-macro` | 细节微距图 | 7 | 6 | 3 |
| 05 | `poster-banner` | 促销海报/Banner | 8 | 7 | 4 |
| 06 | `social-media` | 社交媒体素材 | 7 | 7 | 3 |
| 07 | `ugc-style` | UGC风格/买家秀 | 7 | 7 | 4 |
| 08 | `model-showcase` | 模特展示图 | 6 | 6 | 3 |
| 09 | `before-after` | 使用前后对比图 | 6 | 6 | 3 |
| 10 | `packaging` | 包装设计展示 | 7 | 6 | 3 |
| 11 | `infographic` | 信息图/A+Content | 7 | 6 | 3 |
| 12 | `creative-concept` | 创意概念广告图 | 7 | 6 | 3 |
| 13 | `size-spec` | 尺寸规格+使用步骤图 | 8 | 7 | 3 |
| 14 | `multi-product` | 多产品套装/组合展示 | 7 | 7 | 3 |
| 15 | `livestream` | 电商直播间场景 | 7 | 7 | 3 |
| 16 | `try-on-virtual` | 虚拟试穿/产品融入场景 | 7 | 6 | 3 |
| 17 | `exploded-view` | 技术拆解/爆炸图 | 9 | 7 | 4 |
| 18 | `ghost-mannequin` | 隐形模特 | 8 | 6 | 4 |
| 19 | `multi-angle-grid` | 产品多角度网格 | 9 | 8 | 4 |
| 20 | `magazine-editorial` | 杂志大片/封面 | 9 | 8 | 4 |
| 21 | `seasonal-campaign` | 季节主题网格 | 9 | 8 | 4 |
| 22 | `luxury-atmospherics` | 奢华氛围渲染 | 11 | 8 | 4 |
| 23 | `device-mockup` | 设备界面模型 | 9 | 9 | 4 |
| 24 | `storefront` | 店铺门面/空间摄影 | 9 | 9 | 4 |
| 25 | `sports-campaign` | 运动/健身广告 | 11 | 8 | 4 |

### 9.2 生成流程（`build-templates.mjs`）

```
读取参考仓 references/templates/*.json（25 个）
  → 校验 11 个必填字段
  → 校验 id 与文件名一致
  → 校验 variants.overrides 结构
  → 生成 assets/templates.js（导出 TEMPLATES / TEMPLATE_LIST / KEYWORD_INDEX）
  → 回读校验（模板数、id 条目数一致）
```

- **设计原则**：模板数据只有**一个事实源**（参考仓 JSON），应用侧只消费生成产物，不手抄、不改写、不合并字段。
- **⚠️ 许可提示**：参考仓**没有 LICENSE 文件**（默认保留所有权利）。本项目自用/作品集展示并注明出处；若要商用或公开再分发，应换成自建模板（脚本支持传入任意模板目录作为参数，自检第 1 节会校验 11 个字段）。

---

## 10. 模块九：自检体系（`tools/selftest.mjs`）

### 10.1 用途

本项目的核心主张是"规则用代码算，不靠模型自觉"，那就**必须能被机器证明**。

### 10.2 52 个测试节（共 642 条断言）＋ 独立安全回归（272 条）＋ 浏览器侧自检（199 条）

> 「52 个测试节」的口径 = `tools/selftest.mjs` 里 `section("…")` 的调用数（可自行 `grep -c` 复核）。
> 「条断言」= 脚本自己跑完打印的合计 —— **这个数字不许手抄**，见文末结论行。

```bash
npm test              # 纯函数 + 源码级断言（642 条，不起服务）
npm run test:server   # 起真服务做安全回归（290 条）
npm run test:all      # 五套顺序跑（642 + 290 + 199 + 248 + 136 = 1515）
node tools/browser-selftest.mjs   # 真起无头浏览器跑端到端（199 条，零依赖）
npm run test:mcp      # 另计：MCP 协议往返（248 条）
npm run test:keywords # 另计：词库与采集器（136 条）
```

> ⚠️ 三套必须**顺序跑、不许并行**：它们都会往 `tools/` 写各自的报告文件，
> 并行时另一套开头的"数据快照"会把对方的报告当成数据变动，从而随机报假 FAIL。

| 节 | 内容 | 代表断言 |
|---|---|---|
| 1 | 模板数据完整性 | 25 个模板、字段齐全、order 01-25 连续、每模板 ≥3 变体 ≥2 示例 |
| 2 | **模板匹配（自动 + 上下文）** | 15 个典型输入 → 正确模板；**服装类别名层**、**品类上下文接管**、**参考图优先**、**多级回落**、**并列候选降序**、**排序键顺序（词长>位置>权重）**、不传上下文时 `ctxScore` 必须为 0、显式指定兼容旧签名 |
| 3 | 转化驱动力诊断 | 三种驱动各自给出推进顺序 |
| 4 | 品类识别 + 铁律 1 | 中文通用色词/英文色词/多现全换/不误伤（金属·粉末·网红·黑科技）/米白不被白色吃掉 |
| 5 | **Prompt 组装 · 六条铁律逐条断言** | 断言的是一段段真实 Prompt 里到底有没有那串约束 |
| 6 | 多角度镜头规则 | 角度种数、特写张数、全景占比、仰视/俯视存在性 |
| 7 | 整套规划 + `auditPlan` | 14 张、Style Lock 同段、自检返回空、**反向测试**（破坏后必须报错） |
| 8 | 图生图 | 保留产品身份、不写 `preserve composition` |
| 9 | 关键词挖掘 | 词表行为 + **"这不是搜索量"的声明本身也要被断言** |
| 10 | **Listing 质检** | 差 listing 命中 ≥4 条硬规则、逐条 P 命中、**不误报**（secure/freedom）、结论措辞 |
| 10b | **合规词表与新增规则** | 疾病表覆盖、7 个刻意剔除词不在表里、P6 三桶分别报出、品类差异化、P12 HTML 标记、C7 符号密度、后台字段导出三种计法 |
| 10c | **关键词覆盖度分析** | 词边界、中文子串、`#1`/`2+1 pack` 形态分流、真缺口与噪声线索必须分开、按句挖掘不出跨句假短语、未给竞品时 `competitor` 必须是 `null`、免责声明存在 |
| 11 | 亚马逊采集 | 选择器覆盖、书签自包含、三种输入解析、空输入报错 |
| 12 | Markdown XSS 防护 | `<script>` / `<img onerror>` 被转义、表格/代码块正确 |
| 13 | **编排层** | 主体抽取、离线一轮、占位符告警、**单一事实源源码断言**、关键文件齐全 |
| 14 | 英文支持与颜色 | 语言判定、**英文色词词边界**（hundred/blueprint/wooden 不被改）、真色词仍识别、颜色概念词上报 |
| 15 | **亚马逊首图法规层** | 85-100% 占幅 / 纯白底 / 零文字 / ≤15% 留白 / 1:1，**4 个反向测试**；首图与设计档口径必须不同 |
| 16 | 英文主体抽取 | `photo for X` 语序、纯图类型句判空、`do` 不啃 `dog`、中文回归 |
| 17 | 服务端安全（源码级） | SSRF 模块被引用而非内联、静态白名单存在、Host 校验存在、`.env.local` 原子写 |
| 18 | **前端接线（源码级）** | 每个 `<button id>` 必须被绑定、`app.js` 引用的 `#id` 必须存在、import 名不能写错 |
| 18b | **本轮新增功能的接线（源码级）** | `btnSaveCapture` / `btnSearchToCompare` / `btnSearchToCorpus` / `btnCompare` / 图片库与产物面板的按钮必须都被绑定；`STORE` / `zip.js` 的 import 名不能写错 |
| 19 | **本地持久化（纯函数层）** | `fingerprint` 稳定性、`trimPayload` 超限裁剪并留标记、`makeRecord` 标题截断、`sortRecords` 不原地改、`pickEvictions` 淘汰顺序、配额错误自愈、`isAvailable()` 在没有 indexedDB 的环境返回 `false` 而不是抛错 |
| 20 | **静默失败加固** | 识图失败必须发 `level:"warn"` 的可见事件（不许只发一行 tool_result）、探活缓存 TTL 双档、`probeCacheFresh` 纯函数判据 |
| 21 | **零依赖 ZIP** | 本地头/中央目录/EOCD 三处偏移互相吻合、CRC32 与 `node:zlib` 对照、UTF-8 文件名通用位标记 bit 11、空包单独分支、`inspectZip` 能识破坏数据、**ZIP64 越界（>65535 条目 / >4GB）必须响亮报错而不是静默回绕** |
| 22 | **浏览器侧自检设施** | 自检页与自检脚本必须在仓库里、保持零依赖（内置 `WebSocket` 直连 CDP）、跑完必须把服务与浏览器都关掉（不留孤儿进程） |
| 10d | **多竞品对比** | 共识词 = 所有竞品都用的词、`consistency` 口径、`size<2` 时的提示、`analyzeCoverage` 的 `coveredBy` |
| 11b | **搜索结果页批量采集** | `detectPageKind` 分流、去重放在计数之前、广告位与 ASIN 计数、空 HTML 边界、价格中位数（空列表返回 `null` 而非 `NaN`） |
| 11c | **多语种站点与词表** | 21 个 Marketplace 的 `lang`/`currency` 映射、`stopwordsFor` 各语种表**不串味**、与英文同形词（car/son/war/era…）必须不在非英语表里、`die` 是有意保留的例外、`\p{L}\p{N}` 清洗不把 `für` 拆成 `fr`、`byteLength` 4 字节档 |
| 10e | **2026-07-27 标题新规** | 75 / 125 / 200 三个口径分别锁死、media 类目例外、**超限是 reconcile 不是拒收** |
| **23** | **Rufus 数据层：出处 / 结构 / 自洽** | 每条 `source` 只能是三个合法值；`required` 必须能附上引用句；15 对材质词对的 guards **逐对对齐**（禁止"这对有 `lining`、那对没有"） |
| **23b** | **Rufus 不得回归既有契约** | 源码级：R 模块只从 `rufus-data.js` 读数据、不写死属性 key；`lintListing` 的 28 条一条都不能少 |
| **23c** | **对抗性断言：材质冲突与单位制** | 打**生产入口**（不在测试里复刻逻辑）：混纺必须放行、真冲突必须报、"主体 + 部件"不得误报 |
| **23d** | **反向测试 fixture 形态** | 完整 fixture 必须**零命中**（防 fixture 本身造得"能过一切"） |
| **23e** | **guards 词表纪律** | `guards ∩ GUARD_STOPLIST = ∅`（通用连接词当 guard 会把真冲突静默压掉）；故意不收 `top` / `bottom` |
| **23f** | **R2 字段级窗口** | 口径 = 检测跨字段、抑制逐提及；同一字段内命中 guard 只作废**该字段**对该对的提及 |
| **23g** | **Guard B：每题 key 类 hint ≤ 3** | 防 OR 判据被堆 hint 稀释成"永远通过" |
| **23h** | **R4 覆盖判据：OR + 守卫 A + 状态值域** | `\|K\|==0` 跳过 / `==1` 覆盖即通过 / `≥2` 全未覆盖 = 命中、部分覆盖 = "通过（部分）"独立状态 |
| **23i** | **事实层等价性** | `termRanges` 与 `hasTerm` 的判定必须一致（防边界规则两处漂移） |
| **23j** | **AC-13 行数预算** | 代码行 ≤300、原始行数 ≤400；**计数逻辑只写一处**（不在测试里复刻生产口径） |
| **23k** | **成员数漂移锁** | `GUARD_STOPLIST` / `NEGATION_WORDS` / `UNIT_AMBIGUOUS_WHITELIST` 的成员数变化必须显式改断言 |
| **23l** | **R5 连字符归一（缺陷 L）** | 全大写 + 连字符的商图文字（`BPA-FREE` / `SPILL-PROOF`）在卖家文本里写成空格时**不得误报**；同时"真未文本化"必须仍报 |
| **23m** | **G4 否定窗口固定 2 词** | 反向锁（2 词内否定必须撤销）+ **已知误报边界**（3 词外不撤，SPEC §8 #15） |
| **23n** | **缺陷 K：conclusion 双向锁** | 空表**不得**报「全部通过」；全字段填满**仍须**能报「全部通过」（防把结论恒改成"无可检查项"） |
| **24** | **图标注册表一致性** | 防 emoji 图标 / 防静默空图标 / 防 `index.html` 内联 SVG 与 `ICONS` 注册表漂移 |
| **25** | **竞品关键词 → 文案提示词**（2026-10-02） | 词表规模锁 + 切词/权重/类目打分的**行为快照 hash** + 出网白名单 22 个用例 + **单一实现反向锁**（禁服务端/界面各写一份白名单）+ **字符口径反向锁**（禁在文案层手写 75/125/200/250/500）+ 第 ⑦ 卡接线 + 抓取模块零第三方依赖 |

安全回归 `tools/verify-server.mjs` 的 **211 条**里，**95 条以上是真发 HTTP 请求的端到端**：
起一个 `server.mjs`，然后逐条验证「目录穿越 15 条路径全部 404」「Host 白名单 5 条」「配置校验 4 条」
「图片库清单字段 / `?zip=1` 的 `Content-Type`+`Content-Disposition`+`PK\x03\x04`+CRC / 四类非法删除（`../evil.png`、`sub/x.png`、`x.txt` → 400，不存在 → 404）」，
本轮追加第 6 节：**竞品抓取接口的参数白名单** —— 13 类非法参数 × 2 条路由（未知站点 / 类目为空 / 未知类目 / 路径穿越 / 带斜杠 / 塞成域名 / href 指向第三方站 / `amazon.com.evil.com` 后缀骗局 / 主机不在白名单 / 打本机服务 / 打云元数据 / `file://` / 已在亚马逊侧封锁的 `/s?k=`）全部必须在**发出网络请求之前**就 400；这一节**刻意不联网**，成功路径交给浏览器那套双向验收。
最后**硬断言用户的 `.env.local` 逐字节未被改动**（它含真实 API Key）。

**第三套 `tools/browser-selftest.mjs`（122 条）解决的是"源码级断言的根本盲区"**：源码里有 `$("#btn").onclick = …`
不代表点击真的有效。它真起一个无头浏览器，收 `Runtime.exceptionThrown` 与 console 错误，
逐视图点开并核对 `innerText`，真点按钮跑通闭环。**这是本项目唯一能证明"页面真的能用"的一层。**

### 10.3 关键测试设计

**"反向测试"是这套自检的核心**：先故意把 Prompt 改坏，确认自检真的会报错。否则那 9 条约束可能只是"写了但没生效"。

**源码级断言**：
- 第 17 节读 `server.mjs` 源码文本，要求出现 `runLocalTurn` 且**不得**再出现手写的主体抽取 —— 防"同一逻辑写两遍"这个已发生过的缺陷。
- 第 18 节读 `index.html` + `app.js`，要求**页面上每个按钮都被绑定**、**每个被引用的 id 都真实存在**。这条源码级断言是"按钮点了没反应"这类静默失效的**第一道**防线；**第二道是第一套第三层**——`tools/browser-selftest.mjs` 真起浏览器把按钮真的点一遍（见 §16.6）。

---

## 11. 已知限制与诚实边界（供审阅者判断可信度）

1. **C 组软规则是行业通行做法，不是平台明文** —— 每条 `source` 已标注。
2. **所有数值都是规则阈值，不是 A/B 实验结果。** 产品占比 35-40%、留白 ≥45% 这类数字来自参考 Skill 文档的经验值，未经本项目的实验验证。
3. **`auditPlan` 只能验证"Prompt 里写没写"，不能验证"图生成出来对不对"。** 后者需要人眼或视觉模型，本项目没做。
4. **`infoArchitecture` 的 15/3/8 字上限是项目自定义口径**，不是平台规则。
5. **模板匹配是纯字符串启发式**，没有语义理解。同义词、跨语言表达可能匹配错。
6. **书签脚本依赖亚马逊 DOM 结构**，亚马逊改版即失效。
7. **模板数据来自无 LICENSE 的第三方仓库**（见 §9.2）。
8. **未在真实卖家工作流中试用过。**
9. **`server.mjs` 的 multipart 解析是自写的**（为保持零依赖），可能有边界情况未覆盖。
10. **🔴 `file://` 直接打开页面时，应用不会启动**（实测，见 §16.5）—— 浏览器对 `file://` 的 ES module 施加 CORS 限制，`<script type="module" src="./assets/app.js">` 会被拦，**整个前端一行 JS 都不跑**，页面只剩静态骨架。本项目已改为：`<body>` 顶部加一段**经典脚本**（非 module，不受 CORS 限制）检测 `location.protocol === "file:"` 并插一条红色告警条，指引用 `npm start` 或 `run.cmd` 启动。**必须经 HTTP 访问**（`http://127.0.0.1:8765`）。
11. **`browser-selftest.mjs` 只覆盖到"能跑通闭环"，不覆盖视觉正确性** —— 它断言视图渲染出足够文本、按钮点了有结果、没有未捕获异常；**不断言布局好看、不断言像素级对齐**。样式回归仍需人眼。
12. **SSRF 防护留有 DNS rebinding 的 TOCTOU 窗口** —— 校验时的 DNS 解析与 `fetch` 时的解析是两次独立查询。Node 内置 fetch（undici）不支持 pin IP。本机 + 仅监听 127.0.0.1 的形态下可接受；**要部署到公网必须先补这一层**（换带 `lookup` 钩子的 dispatcher）。
13. **合规词表必然不完备** —— 官方疾病表本身就有限（页面原文写明"not exhaustive"），且平台会更新。本项目只能保证"表里有的能抓到、抓到的能对上官方出处"，不能保证"没漏"。规避方式是每条规则都带 `source`，让漏掉的能被人工补。
14. **品类识别是关键词命中** —— `detectCategory` 靠品类词表，识别不出时品类分支静默跳过（规则状态仍是"通过"）。这是刻意的：宁可少报，也不猜错品类去误报。
15. **主图合规只做到 Prompt 层** —— 能保证"Prompt 里把 85-100%/纯白底/零文字都写清楚了"，**不能保证生成出来的图真的合规**（同第 3 条）。最终仍要人工过一遍亚马逊上传前的预览。
16. **关键词覆盖度分析只测「文本覆盖」** —— 它回答"这个词有没有出现在我的文案里"，**不回答**"这个词值不值得做"。词频不是搜索量、覆盖不是排名，`FIELD_WEIGHT` 的 3/2/1/1 是行业惯例而非官方分值。真要判断词的价值，必须另接官方 Brand Analytics 或第三方关键词工具（本项目刻意不接，见 §0 克制清单）。
17. **`minedGaps` 必然含噪声** —— 从竞品语料挖出的 n-gram 里混有无意义片段（如 `dogs reduces`）。已经用"按句拆分"减少跨句假短语，但**没有**做词性/搭配过滤，所以它只作线索、不作待办。这是刻意的取舍：宁可让用户自己扫一眼，也不引一个 POS 词典进来增加体积与误判面。
18. **本地持久化受浏览器配额限制** —— IndexedDB 单条载荷超 400K 字符会被裁剪并打标记，每类最多留 60 条。`store.js` 有配额自愈（写满时丢弃该类最旧一半再重试一次），但**换浏览器/清站点数据就会丢** —— 所以"本地产物"面板提供导出为 JSON。此外 **`file://` 下 IndexedDB 不可用**（同第 10 条根因）。
19. **搜索页解析依赖亚马逊搜索结果页 DOM** —— 卡片选择器是 `[data-component-type="s-search-result"]`，亚马逊改版即失效；且**只解析当前渲染出的那一页**（不做翻页、不做地区/排序参数变更），分页要用户自己翻页后再点一次书签。
20. **多语种只覆盖"词表与站点参数"** —— 日语/中文的**分词**没做（`mineKeywords` 在 CJK 占比 >30% 时会明确提示"词形不可直接填 Search Terms"）。非英语站点的**文案生成本身**仍由模型完成，本项目只保证其不把虚词当关键词、不把 `für` 拆成 `fr`。

**以下 5 条是 Rufus / Alexa 信息架构检查模块（§20）的诚实边界 —— 逐条已落成断言，不是"我知道但我没说"：**

21. **🔴 R2 的 guard 是「字段级二值」→ 已知漏报边界（明确选择不改）** —— 一个字段内只要命中任一 guard 词（部件词 24 个 ∪ 混纺词 9 个），**该字段对该材质对的提及就全部作废**，不跨字段救场。
    后果：`strap` / `cover` / `shell` / `sole` / `legs` / `collar` 在很多品类里就是**商品本体**（皮带、箱包、锅），所以 `title "Leather Belt"` + `description "Faux Leather Strap"` 这种**真冲突会漏报**。
    **为什么不收窄**：收窄会让 `title "Wool Coat"` + `description "Acrylic lining"`（完全合法的"主体羊毛 + 内衬腈纶"）变成误报。**误报比漏报贵** —— 一条假报警就让人不再相信整份报告。
22. **R2 的否定窗口固定 2 词 → 已知误报边界（与第 21 条方向相反，故分开写）** —— 只有紧邻材质词 **2 个 token 内**的否定词（`not/no/non/never/without/…`）才撤销该提及。
    后果：`title "This is not the real genuine leather"` + `description "synthetic"` 会**报**（`not` 距材质词 3 词，不撤）。
    **为什么不把窗口拉长**：窗口越大，`"not only cotton but also polyester"` 这类正常表述越容易被整段静默压掉 —— 那就从"误报"换成"系统性漏报"，更坏。
23. **R5 只做逐字比对（且只做连字符归一）** —— 苹果商图最常见全大写 + 连字符（`BPA-FREE` / `SPILL-PROOF` / `EASY-CARE`），卖家文案里写成空格，所以两侧都过一遍连字符归一（`.` `-` `_` `/` → 空格）。但**不做词序归一、不做同义词归一**（`"free of BPA"` 仍判为"未逐字文本化"）—— 那属于"换个说法"，本项目保守报出，不替用户判断"这算不算写到了"。
    另：本模块**不解析图像、不做 OCR** —— `imageText` 必须由用户贴进来；没贴就整体跳过，绝不猜图上有什么。
24. **R1 的 `required` 只是「能附上官方引用句」的字段，不是"亚马逊的完整必填清单"** —— 8 个类目 × 官方帮助页正文能引到的那些。像 `brand` 这种"人人觉得该必填"的，因为只有 Learn 页流程叙述与第三方口径、拿不出帮助文档正文的引用句，**被移出 required 放进了 recommended**。这不是漏了，是证据不够就不敢写"必填"。
    另：属性**值**本身有闭集约束（官方错误码 90057：值必须来自下拉清单），本项目**只检查"哪个字段空着"**，不做生成式填值 —— 填一个不在下拉里的值比空着更糟。
25. **R4 的问题矩阵是「从业者口径」，不是官方问题清单** —— 我们没有任何官方问题清单，那 80 条问题（8 类目 × 10 题）来自评论 / Q&A / 客服收件箱的经验归纳，`source` 全部标 `practitioner`。

**以下 4 条是竞品实时抓取（§22）整合进来的诚实边界 —— 同样逐条落成断言：**

26. **抓取依赖亚马逊「Best Sellers 公开榜单页」的 DOM 结构** —— `parseItems` 认三类选择器（`data-asin` / `p13n-sc-price` / `out of 5 stars, N ratings`）。亚马逊改版即**抓到 0 条**，届时 `fetchBestsellers` 会**抛错**，界面照实显示失败原文 —— **不是静默给假数据**。另外：**榜单≠销量榜**（亚马逊不公开具体销量），评论数只是从业者经验口径的**代理指标**，提示词与界面上都按这个措辞写，没有说成「销量」。
27. **关键词权重模型是移植来的启发式，不是搜索量** —— 权重 = 覆盖率×50% + 位置×30% + 精准度×20%，衡量的是**该词在这批竞品标题里的相对结构**，与搜索量、竞争度、转化率**都无关**。出现 <2 次的词会被直接丢弃（视为噪声），这会**漏掉真实长尾**。切词是英文正则 + 停用词表，**CJK 不做分词** —— 中文竞品标题会切得很粗。
28. **文案提示词只是「给模型的输入」，不是产出** —— 本模块只拼文本、不调模型、也不校验模型输出。提示词里的字符口径（75 / 125 / 200 / 250 **字节** / 500）与质检规则**同源**（都取自 `listing.js` 的 `LIMITS`，有反向锁），但**模型是否遵守不受本项目控制**。
29. **原工具的「按关键词搜索」路径没有搬进来** —— 它走 `/s?k=` + Python `scrapling` 子进程；搬进来会给这个零依赖项目引入一个 Python 运行时依赖，而原代码注释自述该路径**已被亚马逊 503 封锁**。所以本工作台**只提供公开榜单页这一条通道**，界面上写明了这一点，不假装「什么都能抓」。
    且覆盖判据用 **OR**（`answerHints` 里任一 key 命中即算这条问题"有答案"）—— 这是刻意放松：**我们只能证明"文案里有相关线索"，不能证明"这句话真的回答了那个问题"**。所以状态里专门有「通过（部分）」这一档，而不是二分的通过/不通过。

---

## 12. 源码清单（便于定位审阅）

| 批次 | 文件 | 体量 | 建议审阅重点 |
|---|---|---|---|
| **A** | `assets/prompt-engine.js` | 62.3KB | 六条铁律的代码化是否完整、自检判据是否覆盖足够、角度分配算法、**首图法规层与设计构图口径的分层是否够干净** |
| **A** | `assets/orchestrator.js` | 36.1KB | 主体抽取鲁棒性（中英双语序）、六步流程的职责划分、简报生成 |
| **A** | `assets/listing.js` | 86.3KB | 28 条规则的正确性与完备性（含 **2026-07-27 标题新规**的 75/125/200 三个口径与 media 例外）、官方合规词表的取舍、词边界匹配、后台字段导出、关键词覆盖度的「真缺口 vs 噪声线索」分离是否合理、**多语种停用词表是否真的不串味** |
| **A** | 🆕 `assets/rufus-data.js` | 54.7KB | **8 个类目的属性表与问题矩阵有没有常识性错误**、`required` 的标注是否配得上"官方明文"（这是本项目最容易被质疑的一处，见 §20）、15 对互斥材质词对是否漏了高频冲突 |
| **A** | 🆕 `assets/rufus-facts.js` | 17.9KB | 数值+单位提取的正则边界、**跨字段提及的"字段级二值"抑制是否过宽**（已知会漏报）、否定窗口固定 2 词是否够 |
| **A** | 🆕 `assets/rufus.js` | 15.9KB | R1~R5 的判据是否与 `rufus-data.js` 的语义一致、**R4 覆盖判据用 OR 是否过松**、出处分级（unknown 必须抛异常）是否真的做到了"宁低不许高" |
| **B** | `server.mjs` | 38.5KB | 接口设计、静态白名单、Host 校验、multipart 自写解析、生图双模式、**图片库清单/打包/删除的路径校验** |
| **B** | `assets/net-guard.js` | 4.8KB | **SSRF 判据的内网段是否齐全**、DNS rebinding 的残留风险 |
| **B** | `assets/amazon.js` | 28.4KB | 选择器完备性、书签脚本自包含性、**搜索结果页批量解析的正则鲁棒性与去重时机**、站点表的 `titleLimit/titleAdvice` 只是展示用（真判据在 `listing.js`） |
| **B** | `assets/api.js` | 9.0KB | SSE 解析健壮性、探活降级逻辑、**双档 TTL 的取值是否合理** |
| **B** | `assets/store.js` | 14.1KB | **IndexedDB 封装是否为纯函数层留了可测接口**、配额自愈是否会误删、`isAvailable()` 的降级是否安全 |
| **B** | `assets/zip.js` | 8.2KB | **手写 ZIP 结构头是否有错**（三处偏移、UTF-8 位标记、空包分支、ZIP64 越界闸门）、CRC32 是否正确 |
| **B** | `assets/md.js` | 4.5KB | XSS 防护是否彻底 |
| **C** | `index.html` | 36.1KB | 视图结构与可访问性、**`file://` 告警条是否真的会在经典脚本里跑到**、**导航内联 SVG 与 `ICONS` 注册表是否逐位一致** |
| **C** | `assets/app.js` | 246.5KB | 单文件是否该拆（**已达 4894 行**）、事件分发设计、状态管理、**新增 7 个按钮的接线**、`renderRufus` 有没有偷偷自带第二套判定逻辑 |
| **C** | `assets/selftest-browser.html` | 10.0KB | **浏览器侧断言是否有"自证"风险**（断言的数据是不是自己造的） |
| **D** | `tools/selftest.mjs` | 189.7KB | 断言是否有"自证"风险、覆盖盲区（**特别看 §23j：有没有在测试里复刻生产口径**） |
| **D** | `tools/verify-server.mjs` | 12.4KB | 端到端安全回归是否够、有没有测试假象（如用 `fetch` 测 Host 头） |
| **D** | `tools/browser-selftest.mjs` | 24.3KB | **CDP 客户端的手写实现是否够健壮**（事件注册时序、超时与清理 —— 本项目在此处踩过一次真卡死，见 §21） |
| **D** | `tools/build-templates.mjs` | 4.9KB | 校验完整性 |

**未包含**：`assets/templates.js`（78.6KB 生成数据）、`assets/app.css`（18.1KB 样式）。

---

## 13. 附：一次完整请求的执行链路（便于理解全局）

输入：`给这款不锈钢保温杯做一整套主图和详情页，高级灰背景，痛点驱动`

```
① 前端探测 /api/health → 在线则走服务端，离线则本机编排
② extractSubject("…") → "不锈钢保温杯"
③ matchTemplate("…") → 命中「详情页」关键词，但其排序规则决定最终模板
④ diagnoseConversionDriver("…") → 命中「痛点」→ pain（置信度 1）
   推进顺序：痛点快照 → 解决机制 → 利益证明 → 信任画面 → 优惠+紧迫 CTA
⑤ detectCategory("…") → 未识别（不锈钢保温杯非宠物/电子等已知品类）
⑥ buildStyleLock({}) → 10 维度锁（背景 #FAF7F2 / 文字 #2D2D2D / 强调 #1A3A2E）
⑦ planImagePack({ driver:"pain", pack:"pdp" }) → 14 张
   ├─ 主图组 5 张：hero/before-after → benefit/detail-macro → benefit/infographic
   │                → benefit/packaging → feedAd/poster-banner  （画幅 1024x1024）
   ├─ 详情页 9 张：D1-D9（画幅 768x1024，全部以 E-commerce infographic 起头）
   ├─ 角度轮转：front34 → high45 → side90 → lowup → topdown（主图组）
   └─ 逐张 composePrompt：9 段结构 + hexify（"高级灰"→#888888）+ 占比 + 留白 + 否定清单
⑧ auditPlan(plan) → [] （14 张逐张过 9 条判据）
⑨ buildBriefMarkdown() → 7 段简报（含「机械自检：14 张逐张核过…」）
⑩ 若配了图片 API 且命中出图意图 → 逐张生成 → file_output
```

**成本**：以上 ①-⑨ 全部是本机计算，**不调用任何模型 API，成本 0 元**。
只有第 ⑩ 步（真出图）产生费用。

---

## 14. 2026-09-28 加强轮次：外部审阅意见的核验结论

这一节是**给下一位审阅者看的上下文** —— 上一位 AI 给了 19 条建议（4×P0 / 6×P1 / 9×P2），
我们逐条 grep / read 源码核验后才决定是否采纳。结论分三类，**错的也记下来**。

### 14.1 属实且已采纳（12 条）

| 建议 | 核验结果 |
|---|---|
| 英文色词无词边界，`/red/i` 会命中 `hundred` | **属实，且比说的更严重**。实测：`blueprint`→`#12243Aprint`、`blackberry`/`blacklist`、`wooden`、`screaming`(cream)、`rosemary`(rose) 全部误伤；审查只举了 4 个，实际 6 个。已给英文表全加 `\b` |
| 英文主体抽取失效（整套抽取逻辑全是中文模式） | **属实**。已补 `IMG_TOKEN_EN`/`STYLE_CLAUSE_EN`/`NOISE_*_EN` 等，并修掉审查没提到的**语序陷阱**：英文是「图类型 + of/for + 产品」，照搬中文的 `slice(0, 图类型位置)` 会把产品名整段切掉 |
| SSRF：`downloadToGen(url)` 直接 fetch 无校验 | **属实**。已加协议白名单 + DNS 解析后按 IP 判内网（含 `169.254.169.254` 云元数据）+ `redirect: "manual"` |
| 合规词表太薄 | **属实**。已按官方页面（Seller Central `202024200`）重建：疾病表 80+ 条、农药/抗菌、环境声明、自证声明、平台徽章词、大促名 |
| `BAD_SYMBOLS` 应补注入类符号 | **部分属实**。`\| < > \`` 确有解析/注入风险，已补；`% # = +` **没补**（`100% Cotton`/`Model #A`/`2+1 Pack` 都合法），改用 C7「符号密度」规则兜底 |
| 五点引导词规则不该是硬规则 | **属实**。是行业惯例而非平台规则，已 P → C，并放宽正则允许首词后接小写 |
| 「无导出能力」 | **部分不准确**。已有 `btnExportListing`（质检 JSON 导出）；真缺的是**逐字段可粘贴**形态，已补 `exportListingFields()` |
| `mineKeywords` 应声明不是搜索量 | **属实**。已加 `disclaimer.isSearchVolume = false` 并在界面渲染 |
| 颜色概念词应上报而非静默跳过 | **属实**。已加 `unrecognized[]`（莫兰迪/大地色/渐变等 13 条概念正则） |
| 品类应差异化 | **属实**。已加 `CATEGORY_CLAIMS`（8 品类），并复用 `detectCategory()` 的同一套词表避免漂移 |
| 自定义画幅支持 | **属实**。已加 `heroRatio` / `pdpRatio` 分组建模 |
| `auditPlan` 应校验主体本身是否可用 | **属实**。已加主体健全性检查（`{PRODUCT}` 占位符、中文按 2 计权超 50 报过长） |

### 14.2 审查说错了，**没有采纳**（3 条）

| 建议 | 为什么不做 |
|---|---|
| 「标题应核心词前置、**品牌放中段**」 | **判断是反的**。亚马逊官方标题公式是 `[Brand] + [Primary Keyword] + [Key Feature] + [Size/Variant]`，且 A9 对品牌前置标题**优先加权**。品牌后置反而丢掉品牌搜索权重 |
| 「日本站标题按**全角字符**计数」 | **说错了**。亚马逊官方 FAQ 明确：character-based, not byte-based —— *a 75-character string is 75 characters in any language*。全角按 1 计。⚠️ 真按字节计的只有 **Search Terms**（这也是本项目 `byteLength()` 只用在 Search Terms 的原因） |
| 「完全没有导出能力」 | 见 14.1 末行，不准确 |

### 14.3 审查**完全漏掉**、由本项目自查发现的（2 条，都比审查的多数条目严重）

| 漏掉的 | 为什么严重 |
|---|---|
| **亚马逊主图法规层缺席** | 项目 `hero` 图型写「产品占 35-40% + 留白 45%」，而亚马逊首图硬要求是「产品占幅 **85-100%** + 纯白背景 RGB(255,255,255) + 禁止文字/水印/logo/边框/道具/多件 + 最长边 ≥1000px」。**两者相加 130%，算术上就不成立**；35% 的首图会被直接判不合规。另外原 `composePrompt` 第 8 段会给首图加 `headline at 28-48pt`，与"首图禁止图内文字"正面冲突。→ 已建独立 `AMAZON_MAIN_IMAGE` 法规层，把「图位（slot）」与「构图占比」分成两层建模，并在自检里用 **4 个反向测试**锁住首图硬约束 |
| **静态服务目录穿越** | `serveStatic` 只挡了 `..` 逃逸，项目根目录下的**普通文件全可读**：`GET /.env.local` 直接拿走明文 API Key，`GET /server.mjs`、`GET /data/gen/*` 同理。叠上"不校验 Host 头"，本机服务可被 DNS rebinding 从任意网页读一遍。→ 已改**白名单**（仅 `index.html` + `assets/`）+ Host 白名单。审查只提了 SSRF（**出网**方向），漏了**入网**方向 |

### 14.4 这一轮顺便修掉的自己踩的坑（回归里都有断言）

| 坑 | 症状 | 修法 |
|---|---|---|
| `hero image` 被抽成 `hero` | 尾部 `image` 被 `NOISE_VERB_TAIL_EN` 当收尾语吃掉，残下 `hero` 冒充主体 | `cleanCandidate` 加「整句只有图类型词」前置判定（并把裸 `图` 换成 `图(?![一-龥])`，否则「图钉」被自己的字误伤） |
| `do` 啃掉 `dog` | `NOISE_LEAD_EN` 组后缺 `\b`，`dog harness`→`g harness`、`theory craft`→`ory craft` | 英文前导词组后统一加 `\b` |
| 纯风格句认不出来了 | 风格形容词先被尾部规则剥掉，`go premium` 只剩 `go` | 改用**剥噪声前的原文**做纯风格句判定 |
| `path.normalize` 在 Windows 上把 `/` 转成 `\` | 白名单比 `assets/` 前缀时恒为 false，**整个前端 404** | 白名单判定前先 `replace(/\\/g, "/")` |
| 用 `fetch` 测 Host 校验永远是 200 | Node 的 undici 把 `Host` 当禁止修改的头**静默丢弃** | 改用 `node:http` 发请求（测试假象 ≠ 代码通过） |
| 同 exe 自调用 `execFileSync` → `EBUSY`；Git Bash 的 `/tmp` 与 Node 看到的 `/tmp` 不是同一目录 | 补丁脚本 / 导出脚本失败 | 先落盘到项目内路径，再读 |
| 英文阈值 80 对短中文句不触发 | 「主体过长」健全性检查形同虚设 | 改成**中文按 2 计权、阈值 50** |

### 14.5 方法论备注

审查意见的价值不在"条数多"，而在"**能被源码证实**"。
这一轮 19 条里有 **3 条是错的**，而**真正严重的 2 个问题一条没提**。
判据很简单：**指不出 `文件:行号` 的建议不算证据。**

---

## 15. 2026-09-29：同类方案调研结论 + 由此补的功能

### 15.1 市面上（含 GitHub）的同类方案

定位差异一句话：成熟方案基本都在做「**抓取 + 生成**」，本项目做的是「**生成 + 合规质检 + 可断言**」。

| 项目 | 形态 | 它有我们没有 / 它有我们也有 |
|---|---|---|
| `nexscope-ai/Amazon-Skills`（546★ / MIT） | Claude Skills（Python），含 listing 优化 + 关键词研究两个 skill | **最接近的同类**（免费 / 无 key / Skill 形态）。它有：**竞品 ASIN 关键词继承**、**8 维度审计评分**（含图片/A+/定价/评论/SEO）。它有而我们**有**的是 28 条带 `source` 的合规质检规则 |
| `kumarBisho/Amazon-Product-Optimizer` | Node+TS+Express+Prisma+MySQL+React+Vite+Docker | 历史持久化（我们刻意不做 DB）；数据靠 **Rainforest API / Keepa**（付费）；需 Docker |
| `sohelkureshi/ASIN-AI-Optimizer` | Node + Puppeteer + Gemini + MySQL | 服务端 Puppeteer 抓亚马逊，自动探测 US→IN→UK |
| `Sharathchandra345/product-listing-ai` | React + Node + Puppeteer + Gemini + MySQL | 明确写了**为绕过亚马逊「Continue Shopping」机器人检测而实现「关会话→等待→重开」循环** |
| `huanpeng69-cmyk/amazon-ai-growth-os` | Multi-Agent（Supervisor + 9 专家 Agent） | 架构与我们正相反：意图路由派发 Agent vs 确定性流水线 |
| `CainGao/tradeai-platform` | Next.js + GLM-4-Flash，30+ 免费小工具 | 工具矩阵路线，单工具很薄 |

SaaS 侧（Helium 10 / Jungle Scout）把 AI listing 功能放在 **$99–279/月**付费墙后。

### 15.2 三个可对照的结论

1. **「服务端抓亚马逊」是同类最大的公共技术债**：`product-listing-ai` 用一整段 README 讲怎么跟反爬搏斗，
   反证这条路脆弱（改版即失效）+ 有 ToS 风险。本项目刻意改用**浏览器书签脚本**（用户已登录的浏览器里点一下），
   代价是"需要用户点一下"，换来不会被反爬拦、不违反 ToS、不存账号信息。
2. **Multi-Agent 不是这类任务的必需品**：二十多条硬约束靠模型自觉必然漂移；
   Supervisor 路由增加的是**覆盖面**，不是**可验证性**。
3. 🟡 **同类普遍缺「合规质检」层**，而这正是跨境运营最容易踩的坑 ——
   多数方案 `生成 → 展示` 就结束，把合规留给人肉检查；而下架/拒收恰恰来自合规项。

### 15.3 顺着调研补的功能：竞品关键词覆盖对比

对应 `nexscope-ai` 的 keyword coverage tracking，按本项目方式重做（纯函数 / 零网络 / 可断言），
详见 §4.3.6。**核心设计是两类缺口必须分开**：

- `gaps`（**待办**）= **用户自己选定的**候选词里，竞品在打、我完全没有
- `minedGaps`（**线索**）= 从竞品语料自动挖出的其他词，**含 n-gram 噪声**

> 实测教训：把挖出的词全混进 `gaps`，噪声（`dogs reduces` / `no-pull dog`）会把真正该补的
> `anti-pull` / `small dogs` 淹掉。**报得越多，越没人看。**

### 15.4 明确不做（想清楚才不做，不是没想到）

| 不做 | 理由 |
|---|---|
| 不接付费关键词 API（Helium 10 / Cerebro 等） | 搜索量数据要花钱，与"零门槛"定位冲突；且一旦接了就变成"必须付费才能用" |
| 不做服务端抓取亚马逊 | 见 15.2 第 1 条 |
| 不做多站点选择器的持续维护 | 亚马逊改版即失效，维护成本无底。当前只做"美/英/德/日等站点参数差异"，不做选择器自动跟随 |
| 不引 POS 词典去过滤 `minedGaps` 的 n-gram 噪声 | 会显著增加体积与误判面；宁可让用户自己扫一眼 |
| 不做"关键词价值评分" | 没有真实搜索量与竞争度数据，任何"价值分"都是编的 —— **宁可给一个覆盖矩阵，也不给一个假分数** |

---

## 16. 2026-09-29 第二轮：实时抓取、本地持久化与图片库

这一轮的需求原话是：**「实现数据的实时抓取，确保功能真正好用好上手、贴近实际使用需求；同时检索并对比同类工具或方案，分析我们与其之间是否仍存在差距。」**
前置条件：上一位 AI 给了第二轮审查意见（3 条 P0/P1 未修复 + 7 条 P1/P2 + 一张"实时抓取五方案对比表" + 一张与 Helium 10 / SellerSprite / Midjourney 的 12 维度对比表 + 五模块完成度评分）。本节按**核验 → 实现 → 对比 → 差距**的顺序写。

### 16.1 先核验：第二轮审查意见逐条实测结论

原则同 §14 —— **没有 `文件:行号` 或实测输出的不算证据**。10 条意见核验后：**3 条错判 / 6 条属实 / 1 条部分不准**。

| 审查意见 | 我实测的结论 | 处理 |
|---|---|---|
| **P0-1**「英文色词子串误伤（`midnight` 被当 `night` 等）原封未动」 | 🔴 **错判**。`COLOR_WORDS` 里**每个**英文词都已带 `\b`。实测：`reduce stress` / `refund policy` / `blueprint pattern` / `blackberry flavor` / `wooden spoon` **全未被转换**；`red cotton towel` → `#C0392B` 正常。**审查说的 `midnight/i` 根本不在表里** | 不采纳 |
| **P0-2**「英文主体抽取仍然失效」 | 🔴 **错判**。实测 5 个用例 5/5 全对：`make a hero shot for wireless earbuds` / `generate a product photo of a ceramic coffee mug` / `a lifestyle photo for a dog harness` / `hero image` / `create 5 images for a yoga mat` | 不采纳 |
| **P2-9**「`RATIO_OF_PIXELS` 里有脏 key `"1024x1024 "`（带尾随空格）」 | 🔴 **错判**。全仓库 grep 该串 **0 命中** | 不采纳 |
| **P1-6**「`probeCache` 不清缓存、探活结果永不过期」 | 🟡 **部分不准**。`app.js:782/809/819` 三处**已经**正确 `clearProbeCache()` + `probeServer({force:true})`；但**确实缺 TTL** —— 服务先挂后起、或先起后挂，探活结果会一直沿用 | 采纳"加 TTL"这一半 |
| **P1-1**「无本地持久化，刷新即丢」 | ✅ 属实 | 已实现（§16.4） |
| **P1-2**「生成的图片没有前端图库」 | ✅ 属实 | 已实现（§16.7） |
| **P1-3**「竞品分析一次只能处理一个」 | ✅ 属实 | 已实现（§16.3） |
| **P1-4**「`STOPWORDS` 只有英文，非英语站点会误删真词/留虚词」 | ✅ 属实 | 已实现（§16.8） |
| **P1-5**「`SITES` 只有 6 个站点」 | ✅ 属实 | 已扩到 **21 个** |
| **P2-x**「识图失败静默降级，用户不知道参考图没被用上」 | ✅ 属实。`server.mjs:547` 只发一行 tool_result | 已改为响亮降级（§16.8） |

> ⚠️ **给下一位审阅者的提示**：这已是**连续两轮**出现"审查说 P0、实测证伪"的情况（上一轮 19 条里 3 条完全错）。
> 提意见时请附**可复现的输入与期望输出**，否则会被记录为错判。

### 16.2 「实时抓取」怎么做：五个方案的实际选型

审查给了一张对比表，但**结论和我们的实测不一致**。逐条摊开（评估维度：能否真正拿到数据 / 依赖体积 / 是否会失效 / 是否违反 ToS / 用户门槛）：

| 方案 | 能否真拿到 | 依赖体积 | 失效风险 | ToS / 法律 | 门槛 | 实测结论 |
|---|---|---|---|---|---|---|
| ① **服务端 Node `fetch` 抓亚马逊** | ❌ **基本拿不到** | 0 | 低（因为根本拿不到） | 灰色 | 0 | 实测被 Cloudflare + WAF 拦，且 TLS 指纹与真实浏览器不同，返回的是验证页而不是商品页。**这条路是死的** |
| ② **Playwright / Puppeteer 无头浏览器** | ✅ 能拿到 | **+300MB**（含 Chromium 下载） | 中（选择器改版） | 灰色 | 需装依赖 | 技术上可行，但**直接推翻本项目"零 npm 依赖、零构建"的第一原则**；且它要替用户保管登录态，等于把"不存账号信息"这条也一起推翻 |
| ③ **Chrome/Edge 扩展** | ✅ 能拿到 | ~50KB | 中 | 灰色 | **要装一次扩展**（还可能要面对商店审核） | 可行，但"装扩展"对非技术用户的门槛**远高于**"拖一个书签"。而且扩展要申请 `activeTab` 权限，反而更吓人 |
| ④ **官方 PA-API（Product Advertising API）** | ✅ 最稳 | 0 | **极低**（官方接口） | ✅ 合规 | ⚠️ 需 Amazon Associates 资质 + 有销量才有配额 | 是"正确答案"，但**准入条件把绝大多数学生/新卖家挡在门外**，与"零门槛"定位正面冲突。**可作为付费用户的升级路径** |
| ⑤ **浏览器书签脚本 + 粘贴 + 本地留档**（本项目） | ✅ 能拿到 | **0** | 中（DOM 改版） | ✅ 用户在自己已登录的浏览器里取自己看得到的数据，不代抓 | 0（拖一次书签） | ✅ **当前最优解**。换来的代价是"用户要点一下"，但规避了反爬、ToS、账号保管、体积膨胀四个问题 |

**为什么书签脚本反而是对的**（这条要讲清楚，否则会被当成"没实现实时抓取"的借口）：

1. **它拿到的数据比服务端爬虫更"真"** —— 服务端爬虫看到的是亚马逊给"机器人"的版本（可能缺 A+、缺广告位、缺地区化价格）；而书签脚本跑在**用户已登录的浏览器**里，拿到的是**用户此刻真正看到的页面**。这恰好符合本项目的一贯主张：**给用户看的数字，要能被他自己的双眼验证**。
2. **它不代抓** —— 不违反 ToS 的地方在于：数据的获取动作由用户在自己的浏览器里发起，本项目只是一段在本地运行的解析代码，不托管、不转发、不上传。
3. **它零体积零依赖** —— 与本项目"零 npm 依赖"的第一原则一致。

**所以"实现实时抓取"这一轮的实际交付是**：把书签脚本从"单商品"升级为**双模式**（详情页 + 搜索结果页整页），并把它接进一个**从采集到结论的完整闭环**（见 §16.3）。**"实时"体现在用户点书签的那一刻，而不是服务端定时轮询。**

### 16.3 🔴 审查漏掉的最高性价比切入点：搜索结果页批量采集

审查整张对比表都在讨论"详情页怎么抓"，**但漏掉了一个数量级更大的场景**：

> **卖家本来就在看搜索结果页**（一页 16-24 个商品）。原来要"开 5 个标签页、点 5 次书签"才能拿到 5 个竞品；现在**一次点击拿到整页**：标题 / 价格 / 评分 / 评论数 / ASIN / 是否广告位。

这是这一轮**价值最高的一个功能**，而它是审查完全没提的。实现要点：

- **`detectPageKind(html)` 先分流** —— 同一段 DOM 既可能是详情页也可能是搜索页，必须先判定再解析（否则搜索页会被当成"缺字段的详情页"而解析失败）。判据：出现 `[data-component-type="s-search-result"]` 或 `s-result-item` → 搜索页。
- **`extractSearchResults(html, url)` 全部接受 HTML 字符串** —— 这样同一套正则能在 Node 里被断言，不需要真浏览器。
- **去重必须放在计数之前** —— 亚马逊搜索结果里同一商品可能出现多张卡片（不同广告位 / 不同变体），先计数会把 `sponsored`、`withAsin` 刷高。这是一个**实测踩到的**顺序问题。
- **`empty` 对象在 `try` 之后构造** —— 否则空 HTML 时连 `site` / `keyword` 都解析不出来，回包结构不一致。
- **一键闭环**：整页表格 → 「把这一页当竞品做多竞品对比」按钮 → 自动填 `lCorpus` + 自动把语种设成该站点的语言 + 自动点「对比」→ 直接看到**共识词**（所有竞品都在打的词）。浏览器自检里真点过这条路，验到 `lLang === "de"` 且共识词含 `kissen`、不含 `für`。

**顺带解决的一个真实痛点**：多竞品语料原来只能靠"用 `---` 手动分隔粘贴"，现在**一次书签点击就填好了**。

### 16.4 本地持久化：为什么用 IndexedDB 而不是 localStorage

审查说"刷新即丢"，属实。但选型上有个**容易被做错的地方**：

| | localStorage | IndexedDB |
|---|---|---|
| 容量 | ~5MB | 通常数百 MB（按浏览器配额） |
| API | **同步**（几百 KB 会卡住 UI 线程） | 异步 |
| 结构化 | 只能存字符串 | 可存对象 |
| 本项目要存的 | 整页搜索结果 JSON + 14 张图的 Prompt 全文 | ← 会超 5MB，且同步写会卡 |

**所以必须是 IndexedDB。** 但这里有一个**刻意设计**：

> **产物（可导出/可分享）与配置（密钥，绝不导出）分两层存。**
> `store.js` 只管产物 —— 采集结果、图像方案、Listing 草稿、覆盖度报告。
> **API Key 完全不进 `store.js`**，仍走 `.env.local`（服务端，且已被安全回归锁住"逐字节未被改动"）。

这样"导出全部产物给同事"这条路径**不可能夹带密钥**，是从数据结构上防止的，不是靠代码自觉。

另外三个**可测性**设计（否则浏览器专属 API 就变成测试盲区）：

1. `store.js` **顶层不碰任何浏览器 API**，`isAvailable()` 在没有 `indexedDB` 的环境**返回 `false` 而不是抛错** → Node 里能安全 import。
2. 记录构造 / 裁剪 / 排序 / 淘汰 / 指纹 / 摘要全部做成**纯函数并导出** → `selftest.mjs` 第 19 节在 Node 里断言，`selftest-browser.html` 在真浏览器里再断言一次。
3. **配额自愈**：`save()` 遇到 `QuotaExceededError` 时，丢弃该类最旧的**一半**再重试一次（只重试一次，避免无限循环）。

### 16.5 🔴 本轮最重要的实测发现：`file://` 下整个应用一行 JS 都不跑

**这个发现比审查提的所有问题都严重，而且是审查完全没看到的。**

原因：项目用原生 ES module（`<script type="module" src="./assets/app.js">`）。浏览器对 `file://` 协议下的模块加载施加 **CORS 限制**，模块会被直接拦掉 —— **整个应用不启动，页面只剩静态骨架，而且不报任何可见错误。**

**实测（Edge 153 无头，`--dump-dom` 对比同一份代码）**：

| 打开方式 | DOM 大小 | 说明 |
|---|---|---|
| `file:///…/index.html` | **23.9 KB** | 纯静态骨架，`app.js` 完全没执行 |
| `http://127.0.0.1:8765/` | **322 KB** | 真渲染（模板列表、规则表等全部生成出来） |

**差了 13 倍。** 这意味着原来 README / 文档 / UI 里"**直接双击 index.html 也能用**"是一句**假的功能声明** —— "本机离线模式"在 `file://` 下**根本不存在**。

**修复**：`<body>` 顶部加一段**经典脚本**（非 module，不受 CORS 限制）：

```html
<script>
  if (location.protocol === "file:") { /* 插一条红色告警条，指引用 npm start / run.cmd 启动 */ }
</script>
```

同时删掉所有误导文案，把界面的"本机离线模式"改成"**本地服务未连接**"（准确描述"服务端不可达，但前端仍在跑本机编排"这个真实状态）。
自检里加了断言**防止这句假声明回归**。

> **为什么用"加告警条"而不是"把代码改成非 module"**：改成非 module 要引入全局变量或打包器，等于推翻"零构建"。**保持 ESM + 明确告诉用户怎么启动**，成本最低且不骗人。

### 16.6 第三套自检：浏览器侧端到端（真起浏览器，零依赖）

这一轮暴露了一个根本问题：**`file://` 那件事，任何源码级断言都查不出来**（源码里 `type="module"` 一直是对的，错的是"用户会双击打开"这个假设）。源码级断言能证明"写了"，证明不了"跑起来"。

所以新增 `tools/browser-selftest.mjs`，**用浏览器自带的 CDP 直连，不装 puppeteer / playwright**：

- Node 22 内置全局 `WebSocket` → 直连 `--remote-debugging-port` 暴露的 CDP 端点，手写一个极简客户端（`send` / `eval` / 事件收集）。
- **关键坑（实测踩到）**：必须先 `Runtime.enable` **再** `Page.navigate`，否则**加载期的异常一条都收不到** —— 而这恰恰是最需要抓的（模块加载失败就发生在加载期）。
- 199 条断言：① 主页真加载 + JS 真跑（导航按钮数、状态文案、欢迎消息、无未捕获异常、无 console.error）；② 8 个视图逐个点开且 `innerText` 有实质内容；③ 新功能界面存在；④ **模板自动匹配（2026-09-29 追加）**：往「自动匹配预览」输入框真敲一句话，验证预览算出 `ghost-mannequin`、摊开「依据」与「也可考虑」、乱码输入如实报「规则兜底」，以及「固定用这个模板 → 顶栏提示 → 一键恢复自动」这条链路真的能走通；⑤ **2026-07 标题新规（2026-09-29 追加）**：限值表口径、真敲 80 字符看计数变红且 Highlights 格主动说明「提交不上去」、**切 media 后同一个 150 字符标题的结论必须反过来**（证明口径真的接进判据）、浏览器里直接 import 模块跑 CSV 导出并核对转义；⑥ **第 ⑦ 卡：竞品关键词 → 文案提示词（2026-10-02 追加）**：16 个控件齐备、三个下拉被服务端清单填满、「没填产品名 / 没抓竞品就点生成」必须给可读错误且**不产出空提示词**、浏览器里直接 import 模块核对 75 / 125 / 200 与「搜索词按**字节**」、**真点一次抓取并按「成功 / 失败都必须诚实」双向验收**（状态条数 == 表格行数、价格必须是美元、权重表只留 ≥2 条的词、权重分夹在 1–10），最后把标题一键送进上方竞品语料框；⑦ **真点按钮走完「采集 → 一键多竞品对比」闭环**；⑨ **原生下拉的替身（2026-10-30 追加）**：11 个 `select.in` 全部被自绘控件接管（断言的是「每个都有替身」这个不变量，不是写死数量）、点开后弹层必须**紧贴触发按钮**（横向 ≤2px、纵向 ≤8px）且**完全落在视口内**、选中后 `select.value` 真变且 `change` 真派发、程序直接赋值也能刷新按钮文字 —— 这一组锁的正是「下拉飞到侧栏上方 / 一闪就没了」那个真实 bug（原生成因见 `assets/select-ui.js` 文件头）。

| 浏览器 | 路径 | 找不到时 |
|---|---|---|
| Edge | `Program Files (x86)/Microsoft/Edge/Application/msedge.exe` 等 | 跳过（**不算失败**，因为可能只是本机没装，不是代码错） |
| Chrome | 标准三处路径 | 同上 |

`finally` 里必须关掉 CDP 连接 + 浏览器进程 + 服务进程 + 删掉临时 profile 目录（否则会留一堆孤儿进程 —— 这条也被断言锁住）。

### 16.7 与同类工具的实际差距（用户第 ③ 个交付点）

先说结论：**差距分三类，混在一起谈就会得出"我们很落后"的错误结论。**

| # | 维度 | Helium 10 / SellerSprite | Midjourney | 本项目 | 差距性质 |
|---|---|---|---|---|---|
| 1 | 关键词**真实搜索量** | ✅ 有（付费数据源） | — | ❌ 只做词频，且界面**显式声明** `isSearchVolume = false` | 🔴 **真差距**，但**刻意的**（见下） |
| 2 | **竞品关键词反查**（Cerebro 类） | ✅ 输入 ASIN 出它排名的词 | — | 🟡 只做"多竞品文本覆盖对比"（拿不到真实排名数据） | 🔴 **真差距** —— 需要工具方有销量/排名数据 |
| 3 | **历史排名/价格追踪** | ✅ 长期曲线 + 提醒 | — | ❌ 无（每次采集是独立快照） | 🔴 **真差距** —— 需要服务端持续存储与调度 |
| 4 | **Listing 合规质检** | 🟡 有基础检查 | — | ✅ **28 条带官方 `source` 的规则 + 反向测试** | 🟢 **本项目反超**（同类普遍只做"生成→展示"） |
| 5 | **图片生成 Prompt** | — | 🟡 需用户自己会写 prompt | ✅ **14 张整套规划 + 六条铁律 + 机械自检 + 亚马逊首图法规层** | 🟢 **本项目反超**（把行业规则变成可断言代码） |
| 6 | **图片生成本身** | — | ✅ 画质天花板 | 🟡 依赖用户自配 API（复用现成模型） | 🟡 **不是同一层**（我们是"生成前的规则层"，不是模型） |
| 7 | **多站点支持** | ✅ 主要站点 | — | 🟡 **21 个 Marketplace 的 `lang`/`currency`/标题限长** | 🟡 差距在"深度"（我们能对齐参数，但没有各站真实排名数据） |
| 8 | **数据持久化** | ✅ 云端 | ✅ 云端作品库 | ✅ **本机 IndexedDB + 可导出 JSON** | 🟢 形态不同（本地优先） |
| 9 | **协作 / 分享** | ✅ 团队账号 | ✅ 社区 | 🟡 **导出 ZIP 分享**（含图片包） | 🟡 真差距（无多用户）—— **刻意不做** |
| 10 | **价格** | ❌ $99–279/月 | ❌ $10–60/月 | ✅ **零成本、零依赖、零注册** | 🟢 **本项目反超** |
| 11 | **上手门槛** | 需注册+付费+学界面 | 需学 prompt | ✅ 拖一次书签 + 跑一个 `run.cmd` | 🟢 **本项目反超** |
| 12 | **数据隐私** | ❌ 数据在对方云 | ❌ 数据在对方云 | ✅ **不出本机**（密钥与产物都在本地） | 🟢 **本项目反超** |

### 16.8 差距点的可落地改进思路（按"值不值得做"排序）

**先明确一条判据**：**差距不等于缺陷。** 有些差距是资源差距（要钱、要资质、要服务端运维），补它等于换一个产品；有些差距是**真能补的**。按"补它的代价 vs 收益"排序：

| 优先级 | 差距点 | 可落地的改进思路 | 代价 | 为什么值得 / 不值得 |
|---|---|---|---|---|
| **P0** | **历史价格/排名追踪**（第 3 项，最痛） | **不需要服务端**：把每次采集的快照存进 IndexedDB（已有 `store.js`），按 ASIN 归并成时间序列，前端画一条 sparkline。用户手动采集 N 次就有 N 个点 | **低**（复用现有持久化层） | ✅ **值得做**。这是"从工具变成习惯"的关键 —— 用户有理由每天点一次书签。**而且它是纯本地实现，不引入任何新依赖** |
| **P0** | **搜索结果页分页**（当前只取当页） | 书签脚本检测"下一页"按钮并可选自动翻 2-3 页（带随机间隔），或**指引用户翻页后再点一次**（合并同一次会话的多页结果） | **低** | ✅ **值得做**。当前"只解析当前渲染的当页"是用户最容易碰到的边界。**先做"合并多次点击"这个零风险版本** |
| **P1** | **真实搜索量缺失**（第 1 项） | 不做服务端数据源。改为**把"词频 + 竞品覆盖 + Search Terms 字节预算"三件事讲透**，并在界面挂一栏"**去哪里查真实搜索量**"（Brand Analytics / 卖家精灵免费额度）的指路 | **极低** | ✅ **值得做**。诚实指路 > 编一个假分数，且与本项目定位一致 |
| **P1** | **竞品 ASIN 反查**（第 2 项） | 官方 **PA-API** 是唯一正路。做成**可选插件**：用户有 Associates 资质就填 key，没有就走书签脚本 | **中**（要接官方接口 + 处理配额） | 🟡 **可做但优先级低**。准入条件把目标用户挡在外面，做了大部分人也用不上 |
| **P2** | **图片库云端存储**（第 9 项） | 不做。保持"图片在本地 `data/gen/`，一键打包成 ZIP 带走" | — | ❌ **不值得做**。云端存储要账号体系 + 存储成本 + 隐私政策，与"不出本机"正面冲突 |
| **P2** | **多用户协作**（第 9 项） | 不做。"分享"这一层的答案就是**导出 ZIP / 导出 JSON** | — | ❌ **不值得做**。同上 |
| **P2** | **图片生成质量**（第 6 项） | 不做模型。定位是"生成前的规则层"，模型好坏交给用户自配的 API | — | ❌ **不是本项目的战场**。跟 Midjourney 比画质是换赛道 |

**"好用、好上手"这一点的具体落点**（用户原话里的重点）：

- **最短路径 = 3 步**：① 双击 `run.cmd`（或 `npm start`）→ ② 浏览器打开 `http://127.0.0.1:8765`（告警条会把这一步说清楚）→ ③ 拖一次书签。
- **首次使用引导**：采集页把"书签怎么装"写成**三步图**（拖到书签栏 / 在亚马逊页面点它 / 回来粘），而不是一段技术说明。
- **每个"没数据"的地方都要说清原因**：`—` 而不是 `0`，并注明"为什么算不出来"（这是 §0 铁律 5 的延续）。
- **一键闭环优先于"多一个选项"**：整页采集 → 一键当竞品 → 一键对比 → 一键把共识词填入关键词框。**每一步都能一步接下一步**，用户不需要记"该先去哪个页面"。

### 16.9 本轮回归总览

```bash
npm test                          # 289 条 / 22 节（纯函数 + 源码级断言）
npm run test:server               # 113 条（真起服务，含图片库清单/打包/删除）
node tools/browser-selftest.mjs   # 67 条（真起无头浏览器，走通闭环）
```

**三套合计 469 条，全部通过。** 其中本轮新增：节 10d（多竞品对比 8 条）、11b（搜索页批量采集 14 条）、11c（多语种站点与词表 10 条）、18b（新功能接线 8 条）、19（本地持久化 10 条）、20（静默失败加固 **7 条**，含「界面不许说假话」2 条）、21（零依赖 ZIP **11 条**，含 ZIP64 越界闸门）、22（浏览器自检设施 3 条），安全回归第 5 节（图片库 32 条）。
**同日追加（模板自动匹配，见 §17）**：节 2 由 12 条扩到 **31 条**（新增别名层、上下文接管、参考图优先、多级回落、并列候选、排序键顺序、纯函数可解释性、两条源码级接线断言），浏览器侧由 40 条 → **46 条**（新增第 ④ 组"真敲一句话看匹配"）。

**顺带修掉的一个自己踩的坑**：`buildZip` 出来的**空包**被 `inspectZip` 判为坏包 —— 因为 `total === 0` 时 `cdOffset` 处就是 EOCD，去读中央目录签名会读到 EOCD 的签名。已加空包单独分支，并在自检里锁住。

**同日第三段追加（2026-07-27 标题新规，见 §18）**：`LIMITS.title` 200 → **75**、新增
`itemHighlights: 125` / `titleMedia: 200` / `titleTotal: 200`；规则 20 → **28 条**
（新增 P13/P14/P15/C10/C11/C12/C13/C14）；词表 9 → **12 张**；新增 Flat File CSV 导出与前端实时额度计数。
自检 268 → **289 条**（新增 10e 节 21 条），浏览器侧 46 → **67 条**（新增 3c 节 18 条 + 自检页 3 组）。
🔴 这次改造**当场顶红了两条既有断言**，两条都不是改数据就完事的：
「好 listing 硬规则全过」的 fixture 标题原本 80 字符（旧口径下合格、新规下超限），
以及 `hasContent` 判定用错函数导致空表上误报。前者说明规则真的生效了，后者是我自己的实现 bug。

### 16.10 下一轮审阅请重点看这里（本轮新增的、最可能有问题的三处）

1. **`store.js` 的配额自愈**：写满时丢"最旧一半"是不是太激进？如果用户刚存的三条恰好都在被丢的一半里怎么办？（当前顺序是按 `createdAt` 升序淘汰最旧，但如果同一毫秒写入多条，`createdAt` 会撞。）
2. **`zip.js` 的手写结构头**：已用 Python `zipfile.testzip()` 真解压验证（含中文名与空包）。**ZIP64 越界已补上闸门** —— `assertZipWithinLimits(count, bytes)` 在越界的第一刻抛 `RangeError`（而不是让 4 字节偏移字段静默回绕后产出一个"文件损坏"的包），并有 2 条断言锁住（含"造 65536 个条目必须抛"这条真跑的）。**仍未覆盖**：加密包、分卷包（本实现明确不支持，也未因此做任何兼容）。
3. **`browser-selftest.mjs` 的 CDP 时序**：`Runtime.enable` 必须在导航之前，这一点已在注释里写明；但**如果页面加载极慢**，`load` 事件与服务端就绪之间是否存在竞态？目前靠固定等待 + 轮询 `__SMOKE_DONE__`，不够优雅。

### 16.11 一次真实用户输入的逐步追踪（2026-09-29 诊断记录）

用户输入：`帮我生成一款关于黄色鸭子的logo印在黑色衣服的T恤上` → 走完 ①~⑦ 步、Prompt 正常产出，但**没有出图**。逐步实测：

| 步 | 实测结果 | 判断 |
|---|---|---|
| 意图判定 | `isGenerateIntent` = **false** | 只出 Prompt（**设计如此**，简报⑦ 已明示）。探针：加「直接出图」→ `true` |
| 主体抽取 | `关于黄色鸭子的logo印在黑色衣服的T恤上` | 🔴 **整句被当主体**，应抽成「印有黄色鸭子 logo 的黑色 T 恤」 |
| 模板匹配 | `score=0` → 回落 `hero-image`（白底/纯色底产品主图） | 🟡 关键词表里**没有** `T恤` / `衣服` / `tee` / `shirt` / `apparel`（只有 `ghost-mannequin` 收了「服装」）→ 服装类需求全部回落白底主图，而**隐形模特/模特展示**本来更合适。**✅ 同日已修，见 §17** |
| 品类 / 驱动 | `fashion` / visual（置信度 0） | 正常 |
| 构图口径 | `product occupies 35-40%` | **设计层**口径。⚠️ 若被当亚马逊首图用会**判不合规**（首图要求 85-100%） |
| 出图接口 | `POST /api/image` → `{"error":"缺少 IMG_BASE_URL / IMG_API_KEY 配置"}` | **响亮失败**（不静默）✓ 这是没出图的硬原因 |

**顺手诊出并已修的三个真缺陷**（症状都是"用户以为能做，其实没做成"）：

1. **界面显示「可出图」但实际出不了** —— 右上角模式标签只判「服务端是否在线」就写 `服务端编排 · 可出图`，**没判有没有配图片 key**。同一个事实在文件里本来有**三处**写法（侧栏状态 / 模式标签 / 出图前检查），其中两处是对的、只有标签那处漏了。已抽成唯一的 `canGenerateImage()` 三处共用，并加断言锁住。
2. **简报指向界面上不存在的按钮（一）** —— 出图分支写「点下方的 **生成图片** 按钮」，但**界面上没有这个按钮**（聊天区只有 📎 / ＋ / 整套 / 发送 / 停止），而且真实触发路径不是点按钮（是：消息里带「出图」词 → 发送 → 服务端自动调）。
3. **简报指向界面上不存在的按钮（二）** —— 整套模式写「点「**导出图片包**」可一次拿走全部 Prompt（json / csv / md）」，**这个按钮同样不存在**。后果更重：**"整套模式"实际没有出口** —— 14 张 Prompt 只能手动选中复制。

> 🔴 三条是**同一个模式**：文案描述了一个界面上没有的能力。已把 2、3 改成实话，并加断言
> （`简报不许指向界面上不存在的按钮`）把这三处都锁住 —— 新写的文案如果再"承诺"一个不存在的按钮，自检会红。
> ⚠️ 同时留一个**真缺口**（不是缺陷，是没做）：「整套 Prompt 一键导出（json / csv / md）」这个能力本身**值得补**，
> 因为整套模式的价值就在于"一次拿走 14 张"，而没有导出就只能手动抄。列在待办里。

**仍待议的三条**（都涉及判据，改动会改变输出，需单独定范围）：

- 主体抽取对「**印在…上**」这类**空间关系句**会把整句当主体（`Subject and scene:` 段读起来是坏的：`…T恤上. background: …`）
- ✅ **已解决（同日，见 §17）**：模板关键词表缺**服装类词** —— 已加别名层（`TEMPLATE_ALIASES`）并把品类/驱动/参考图接进匹配，服装需求不再回落白底主图
- `hero-image` 模板名带「产品主图」，但出的是**设计稿口径 35-40%**，界面上没有提示「这**不是**亚马逊首图口径（85-100% + 纯白底 + 零文字）」—— 用户很容易直接拿去上架
- 另：`isGenerateIntent("帮我生成一张图")` = **false**（`GENERATE_WORDS` 有「生成图片 / 生成图」，但没有「生成一张图」）—— 用户很自然的说法不被识别

---

## 17. 2026-09-29 追加：模板自动匹配（第二版）

### 17.1 先纠正一个前提

需求原话：「改为自动匹配机制……**请说明触发条件、匹配规则与优先级，以及当无法匹配到合适模板时的处理方式**」。

**旧实现已经是自动的** —— `matchTemplate(message)` 从当轮消息文本里找关键词，用户不需要先选模板。
但它**是聋的**。四个实测出来的问题（前三个见 §16.11 的诊断记录）：

| # | 问题 | 实测证据 |
|---|---|---|
| 1 | 关键词表**没有服装词** | `T恤 / 衣服 / tee / shirt / apparel / garment / clothing` 在 25 个模板里 **0 命中** → 服装需求全部被丢给白底主图 |
| 2 | **同一个系统里两个模块各算各的** | `detectCategory` 明明已经算出 `fashion`，但**没有任何一行代码把它喂给模板匹配** |
| 3 | 回落只有一档 | 只要没命中词，**永远**回落 `01-hero-image`，不看品类、不看意图 |
| 4 | 模板库里的手选**根本没接通** | `S.selectedTemplate` 只影响"详情面板显示哪一个"，**从不参与生成** |

### 17.2 设计：证据分两段，上下文只做补位

| 段 | 来源 | 权重 |
|---|---|---|
| **词证据** `termScore` | 上游 `trigger_phrases` | 词长 + 6 |
| | 本层**别名层** `TEMPLATE_ALIASES` | 词长 + 3 |
| | 上游 `keywords` | 词长 + 0 |
| | 次要证据（同模板命中多个词） | 每个 +1，**封顶 +3**（不封顶会奖励"词多"，而词多往往是噪音） |
| **上下文证据** `ctxScore` | 品类亲和 `CATEGORY_TEMPLATE_AFFINITY` | +6 |
| | 转化驱动力亲和（**只在 confidence > 0 时才算**） | +3 |
| | 手上有参考图且该模板吃参考图 | +3 |

**为什么要分段**：上下文只做两件事 —— ① 词证据打平时决胜；② 完全没有词证据时接管（这就是"多级回落"）。用户明说「促销海报」时，哪怕品类是 `fashion` 也不会改判。

别名层的存在理由：上游 25 个模板 JSON 是**别人的仓库**（`ecom-details-image`，MIT），`tools/build-templates.mjs` 的铁律是"只消费不改写"。所以词表的空洞只能在**读法层**补 —— `TEMPLATE_ALIASES` 加的是读法，不是数据，上游文件一个字节都没动。

### 17.3 触发条件

- **每一轮对话都跑一次**（`runLocalTurn` 的第 ① 步），没有"关闭自动"的开关。
- 输入 = 当轮消息文本 **+** 同一轮已算出的上下文（品类 / 转化驱动力 / 是否带参考图）。
- 只有**显式指定**能覆盖它（用户在模板库点了「固定用这个模板」）。
- ⚠️ 品类与驱动力被**提到匹配之前**计算，并有源码级断言锁住这个顺序 —— 否则上下文永远是空的，功能等于白写。

### 17.4 匹配规则与优先级（自上而下，先满足者胜）

1. **显式指定**（`explicitId`）→ `score: Infinity`，一票通过，`source = "explicit"`。
2. **词证据**：`trigger_phrases` > 别名 > `keywords`；同权重比**词长**（长词更具体）；再同位比**出现位置**（靠前更可能是主意图）。
3. **上下文证据**：品类亲和（+6）> 驱动亲和（+3）＝ 参考图（+3）。
4. **🔴 排序键顺序（最容易被改坏的地方）**：
   `词证据有无` → `词长` → `位置` → `词权重` → `总分` → `order`
   第一版实现把"词权重"加进总分当**主**排序键，当场把「直播间场景图」判成 `lifestyle-scene`（因为"场景图"是它的 `trigger_phrase`，+6 分），而正确答案是**句首**的 `livestream`。教训：**词权重只能做同位决胜**。这条既有回归（`直播间场景图 → livestream`）本来就在，正好把它当场抓了出来。
5. **全都没证据** → 按 `order` 升序 → 稳定落到 `01-hero-image`。

### 17.5 无法匹配到合适模板时（多级回落）

**不再是"永远 hero-image"**，而是先交给上下文：

| 品类 | 回落到 |
|---|---|
| `fashion` | `ghost-mannequin`（隐形模特） |
| `electronics` | `device-mockup` |
| `pet` | `lifestyle-scene` |
| `beauty` / `jewelry` | `detail-macro` 等 |
| …8 个品类各有亲和表 | 见 `CATEGORY_TEMPLATE_AFFINITY` |

**连上下文也没有**（例如纯乱码 `zzz qqq`）→ 回落 `01-hero-image`，并在 `reason` 里**如实说明这是兜底**，而不是假装匹配上了。

🔴 这里顺手修了一个"界面说假话"：`diagnoseConversionDriver` 在**什么都没识别出来**时返回 `confidence: 0` + 默认的 `visual`。把 `driver` 直接传进上下文的话，乱码输入就会报出"按「visual」驱动常用图型选取"—— **把兜底当成了证据**。现在只在 `confidence > 0` 时才计分，并有源码级 + 行为级两条断言锁住（行为级那条真调 `runLocalTurn("zzz qqq")`，断言输出里不许出现"驱动常用图型"）。

### 17.6 附带的三个修正

1. **图型不再只认 2 个模板**。编排层原来是一串硬编码嵌套三元，25 个模板里只有 `hero-image` / `lifestyle-scene` 被认出来，其余 23 个全被压成 `benefit`（卖点副图 25-30%）。现在 `TEMPLATE_FIGURE` 给**全部 25 个**都有归属（`infographic → pdp`、`poster-banner → feedAd`、`ghost-mannequin → hero`…），断言"没有任何模板缺映射"。
2. **显式通道真正接通**。`api.js` → `server.mjs` → `runTurn` / `runLocalTurn` 全链路带上 `templateId`，且**只作用于下一条消息**（`send()` 里取走即清）—— 做成粘性状态的话，用户点过一次模板库之后，后面所有对话都会静默违背自动匹配，而他早就忘了。
3. **匹配过程可见**。模板库新增「自动匹配预览」（`index.html` + `renderAutoMatch()`）：敲一句话，实时显示会选到哪个、依据是什么、还有哪些备选。理由：自动匹配要**可审议**，否则用户被分到不合适的模板时只能反复改措辞瞎试。

### 17.7 新增断言

自检**节 2** 由 12 条扩到 **31 条**：服装类词必须能命中某个模板、服装需求不得回落白底主图、别名层权重夹在中间、上下文接管、上下文不能推翻词证据、参考图优先、兜底必须如实说明、候选降序且不含自己、**排序键顺序**、`scoreTemplate` 纯函数可解释、旧签名（字符串第二参数）兼容、25 个模板图型全覆盖、orchestrator 真的传了 context、显式通道两条路径都接通。

浏览器侧新增 6 条：真敲一句话看预览算出 `ghost-mannequin`、预览摊开依据与备选、乱码不编造依据、「固定用 → 顶栏提示 → 一键恢复自动」链路可走通。

### 17.8 已知边界（下一轮请重点看这里）

1. **别名层是手写的，会漏。** 目前只补了实测确认空缺、且不与现有模板冲突的词（服装类为主）。**没有自动扩展机制** —— 新品类（比如"汽配"）出现时还是得人工补。
2. **`REFERENCE_FAVORED` 那个集合也是手挑的**，判据是"这个模板本质上是拿参考图当输入"，`hero-image` 被**刻意排除**（它是从零画一张，把参考图当加分项会让方向反过来）。这个判断没有更强依据。
3. **匹配仍是子串匹配，没有词边界。** 中文靠子串是对的，但英文可能误伤（`tee` 会命中 `committee`）。目前只靠"别名层不放高歧义词"规避，**没有**真正的词边界处理 —— 这是已知的粗糙处。
4. **图生图路径不消费显式模板**（它有自己固定的场景改造逻辑），界面上用"下一条**文本**消息固定用 XX"的措辞如实说明了这一点，而不是让用户以为它会生效。

---

## 18. 2026-09-29 第三轮：2026-07 标题新规（75 字符 + Item Highlights）

### 18.1 这一轮的原话

> 「继续优化当前内容，针对尚未实现达标的功能和条件进行补充、改进与完善；
> 同时检索相关资料和参考做法，据此进一步优化，并明确说明各项改动的优化点与预期效果。」

触发它的是一份外部审阅报告。报告提出 10 条（P0×4 / P1×6），第一条是
「亚马逊 2026-07-27 生效标题新规，本项目的规则还是旧的」。

**核验结论（先说结果，再说过程）**：

| 报告条项 | 核验结果 | 处置 |
|---|---|---|
| ① 标题阈值过时（200 → 75） | ✅ **成立**，且比报告说得更严重（见 18.2） | 已改 |
| ④ 无 Item Highlights 支持 | ✅ **成立**（`grep itemHighlights assets/listing.js` 零命中） | 已补 |
| ⑦ 合规词表覆盖不足 | ⚠️ **部分成立**。词表本身很全（76 疾病 / 71 保证性 / 27 农药 / 8 品类），但**完全没有「站外引流 / 联系方式」检测** —— 而这是平台明文禁止项 | 已补 P15 + C12 |
| ② 英文色词子串误伤（`/red/i` 命中 reduce） | ❌ **上一轮已修** | 本轮只用断言把它钉住 |
| ③ 英文主体抽取失效（NOISE_LEAD 全中文） | ❌ **上一轮已修**（§16 / §15） | — |
| ⑤ 无项目持久化 | ❌ **上一轮已修**（`store.js` IndexedDB，§16.2） | — |
| ⑥ 无图片库管理 | ❌ **上一轮已修**（`?lib=1` + 打包下载，§16.3） | — |
| ⑧ 竞品一次只能一个 | ❌ **上一轮已修**（`compareCompetitors`，§16.5） | — |
| ⑨ `probeCache` 不随配置变更刷新 | ❌ **上一轮已修**（`probeCacheFresh` 双档 TTL，§20 断言） | — |
| ⑩ 停用词表只支持英文 | ❌ **上一轮已修**（`STOPWORDS_BY_LANG` + `SITE_LANG`，§16.7） | — |

> 🔴 **"报告说没做、其实做了"这种误判，代价和"报告说做了、其实没做"是一样的** ——
> 都会让人做重复劳动。所以这一节把两边都写清楚，判断依据是 `grep` 与既有断言，不是印象。

### 18.2 官方口径（这一轮最该被记住的部分）

报告的表述有一处**必须纠正**：「写 100 字符会被判『通过』，但实际上在亚马逊后台会被拒收或截断」。

**官方原文不是这样。** SP-API 开发者文档《Submit modular titles》原文：

| 属性 | 用途 | 上限 |
|---|---|---|
| `item_name` | Core product identity（品牌 + 品名 + 关键属性） | **75** 字符 |
| `title_differentiation` | Comma-separated differentiating details（Item Highlights） | **125** 字符 |

> "The total character limit is **200** across both fields."
> "You can only submit `title_differentiation` when `item_name` is 75 characters or fewer."
> "If you submit an `item_name` longer than 75 characters (up to 200), Amazon **may reconcile** the value
> in the catalog, splitting it across `item_name` and `title_differentiation`."

再加 Seller Central Europe 公告：

> "Starting July 27, 2026, titles in all categories **except for media** will need to be
> 75 characters or less **including spaces**."
> "Item Highlights provides an additional 125 characters for sharing materials or recommended use cases
> … This content is **searchable** and visible with titles in search results and on product detail pages."
> "After July 27, any titles still over 75 characters will be updated to the AI recommendation gradually.
> Your listings stay active throughout this process… brand owners will have **14 days** … to review."

**结论（三句话）**：

1. **超限不报错，超限被"改"** —— 你还能提交，但目录页显示的是 Amazon  reconciled 出来的版本（AI 建议），
   品牌方有 14 天复核期。真实代价是**失去标题控制权**，不是被拒收。
2. **真正不可逆的是连带效应**：标题 >75 时 `title_differentiation` **提交不上去**
   —— 这是一个"两边都落空"的组合：标题保不住、新字段也用不上。
3. **唯一例外只有 media**（图书 / 音乐 / 影像），它仍走 200 且没有 `title_differentiation`。

官方示例（标题改造的方向）：

| 属性 | Before（单条长标题，92 字符） | After（两段式） |
|---|---|---|
| `item_name` | `Premium Stainless Steel Insulated Water Bottle – Keeps Drinks Cold 24 Hours, Hot 12 Hours, BPA-Free` | `Premium Stainless Steel Insulated Water Bottle – BPA-Free` |
| `title_differentiation` | （不存在） | `Keeps drinks cold 24 hours, hot 12 hours. Ideal for gym, office, and outdoor adventures.` |
| 官方 API 文档给的例 | `Fast Charger Adapter, PPS Supported, Compact Charger for models like MacBook Air/…, Cable Not Included` | `Fast Charger Adapter` + `USB-C, PPS Support, Cable not included` |

### 18.3 改了什么（逐项：优化点 → 预期效果）

| # | 改动 | 优化点 | 预期效果 |
|---|---|---|---|
| 1 | `LIMITS.title` 200 → **75**；新增 `titleMedia: 200` / `itemHighlights: 125` / `titleTotal: 200`；`titleStrict` 150 → **70** | 判据与平台当前口径对齐；把 200 拆成"硬顶 + 例外 + 合计"三个可分别引用的量 | 写 80 字符的标题**当场被判超限**（此前会判通过）。回归里那条「好 listing 硬规则全过」的 fixture 标题原本 80 字符，新规则一上就自己红了 —— 这是"规则真的生效"最硬的证据 |
| 2 | `titleLimit(ctx)` 集中类目口径；界面加**显式**口径开关（普通 / media） | 口径只有一处实现，界面与判据共用 | 不会再出现"界面按 75 显示、判据按 200 判"这类漂移；media 卖家不会被假警报轰炸 |
| 3 | `P1` 的 `why` 重写：讲清「不是拒收、是被 AI 改写」「14 天复核期」「超限连带丢掉 Highlights 提交资格」 | 把后果写**准**，而不是写**狠** | 用户知道自己在赌什么；写"拒收"会让人为一个不存在的风险做过度妥协。`why` 里有断言锁住必须提到这三点 |
| 4 | `P4` 重定义为"逼近硬顶"（71–75 命中），media 口径下跳过 | 76 是悬崖，71 就该提醒 | 让"还想再加一个规格"的人在动手前就知道会掉下去 |
| 5 | 新增 `P13`（Highlights >125）/ `P14`（禁用语 + 特殊符号，与标题同口径） | 新字段立即纳入机械判定，不留窗口期 | 新字段一上线就是"被检查的字段"，而不是"以后再说" |
| 6 | **`copy` 作用域纳入 `highlights`** | 堵住"标题干净、五点干净、疗效写在 Highlights 里"的新绕过形态 | 新字段不会成为合规缺口（有断言锁住 `copy` 必须包含 highlights） |
| 7 | 新增 `C10`（Highlights 为空，`emptyOk` + `hasContent` 双重把关） | 提示"你正在放弃 125 字符的可搜索额度" | 最常见的失误形态是"标题压好了、亮点忘了填"—— 那正好是索引覆盖最差的状态 |
| 8 | 新增 `C11`（Highlights 与标题重复度过高） | 官方明说两段要**各说各的**（"Each one should add something different"） | 阻止"把同一批词切成两半"这种假两段式 |
| 9 | 新增 `P15`（站外引流 / 联系方式）+ `C12`（疑似电话 / 社交平台名） | 补上一块**完全缺失**的明文禁止项 | 入口级违规（绩效问题）从"完全没检查"变成"硬规则拦截" |
| 10 | 新增 `C13`（标题重复词）/ `C14`（主观修饰词） | 75 字符时代**每个字符都变贵了**：一个 `Premium` 吃掉 7 字符（约 9%），一个重复的 `Dog` 也是一样 | 把"长度压力"转成可见的建议，而不是让用户自己去数 |
| 11 | 草稿生成改为**按 role 分配字段**：规格/数量/人群 + 材质句 → Highlights；长卖点句 → 五点 | 标题放不下的内容**不再丢弃**（旧版是 `pop()` 掉就直接扔） | 生成一次草稿不再静默删掉一批关键词；且字段分配符合官方对两段的定位 |
| 12 | `AMAZON_FIELDS` 新增 `title_differentiation`（**官方属性名**），排在 `item_name` 之后 | 字段名直接用得上（Listings Items API / JSON_LISTINGS_FEED），不用二次翻译 | 走 API 的团队可以直接抄 key；相邻顺序本身就是那条依赖关系 |
| 13 | `exportListingFields()` 增加 `budget`（两段式总账）+ `notes`（超限因果提示） | 单看任一字段看不出额度还剩多少 | 导出/复制出去的文本里自带"标题超限 → 亮点提交不上去"的提示，用户在后台遇到失败时知道原因 |
| 14 | 新增 `exportFlatFileCsv()`（列名用官方属性名 + RFC 4180 转义） | 补上批量表这条出口 | 五点带逗号是常态，转义不做会直接把一行撑成多列（有断言） |
| 15 | 前端实时计数（标题 / Highlights / 两段合计），**标题超限时 Highlights 那一格主动说明"提交不上去"** | 后果量级大，不该点了按钮才知道 | 打字的过程中就能看见边界；报警"联动"而不是各报各的 |
| 16 | `amazon.js` 的 21 个站点表 `titleLimit/titleAdvice` 从 200/150 → 75/70 | 清掉一个会显示给用户的旧口径残留 | 站点表不再和判据打架；两边一致性由断言锁住 |
| 17 | 采集回填时自动判断 media（**只认无歧义的图书/音乐/影像词**） | 图书卖家不会被 75 的尺子量 | 少一类假警报；`Video Games` / `Software` 刻意不认（公告没点名，猜错方向会让超限标题被判"通过"） |

### 18.4 顺手清掉的文档自相矛盾

这一轮发现《功能细节》文档里**同一份文档有两张规则表和两张 LIMITS 表**，
§4 那张是手抄的、已停在 20 条 / `title: 200`，而 §2.4 附录那张是从代码导出的。

**处置：删掉手抄的那两张，只留"从代码导出"的那一张**（加一段结构性说明）。
理由很直接：**手抄的表一定会和代码漂**，而"文档里有两条互相矛盾的口径"比"文档缺一张表"更坏 ——
审阅者会先怀疑整份文档的可信度。这条和项目里"派生字段只有一处实现"是同一个原则。

### 18.5 新增断言（+21 条，合计 289）

自检新增 **10e 节**（`2026-07-27 标题新规`）**21 条**（268 → 289，新增的 21 条全在这一节里），
另有 2 条塞进既有节：`SITES[*].titleLimit === LIMITS.title`、
以及把那条「好 listing 硬规则全过」的 fixture 标题从 80 字符压到 61 字符
（**它不是"为了过测试而改数据"** —— fixture 本来就该代表"当下真实合格"的样子）。

重点几条（都是"会因为我改错而变红"的那种）：

- 🔴 **反向测试**：`"A".repeat(40) + " " + "B".repeat(39)`（80 字符）**必须**被判超限 ——
  这条断言存在的意义就是"旧口径会让它失败"。
- 边界：75 通过 / 76 命中（一个字符都不能差）；Highlights 125 通过 / 126 命中。
- **`P1` 的 `why` 必须提到「不是拒收」「14 天」「丢掉 Highlights 提交资格」** ——
  防的是"把后果写狠一点以显得重要"。
- `copy` scope 必须包含 `highlights`（源码级 regex + 行为级各一条）。
- `C10` 在字段为空**命中**、**整张表为空时跳过**（`emptyOk` 与 `hasContent` 都要被测到）。
- `C12` **不误伤** `Dim 350-500-1000 mm` —— 这条是"为什么电话只能做软规则"的证据本身。
- CSV 转义：`"Ceramic, 350ml"` 要加引号、`""hi""` 要翻倍。
- 草稿：标题 ≤70、Highlights ≤125、**不含句末标点**（官方要求是短语不是句子）、
  **长卖点句不得被搬进 Highlights**、`headlineChars == title.length + highlights.length`。
- `SITES[*].titleLimit === LIMITS.title`（把两处口径钉在一起）。
- 浏览器侧新增 3c 节 18 条 + 自检页 3 组：真敲 80 字符看计数变红、
  **切 media 后同一个 150 字符标题的结论必须反过来**（这条是"口径真的接进判据"的证据）、
  浏览器里直接 import 模块跑 CSV 导出。

**三套合计：289（Node）+ 113（服务端）+ 67（浏览器）= 469 条，全绿。**

### 18.6 本轮踩到并修掉的三个自己的错

这一节留着，因为它们都是**同一类**问题：断言写得比事实更响。

1. **`hasContent` 用错了判定函数** —— 写成 `!isBlank([title, ...])`，而 `isBlank` 对**数组**判的是
   "长度是否为 0"，`["", "", ""]` 长度是 3 → 得出"有内容"的错误结论，`C10` 在空表上乱叫。
   被既有断言「字段为空时标记为跳过而不是通过」当场抓住。**教训：复用工具函数要看它判什么维度**。
2. **浏览器断言命中了规则自己的解释文案** —— 断言写 `!/上限 75/.test(lintOut)`，
   而 `P1` 的 `why` 里就写着"标题上限 75 字符（含空格，media 类目除外）"，
   于是判据明明是对的，断言却红了。**教训：断言要打在"判定结果"上，不能打在整段渲染文本上**
   （改成匹配 `\d+ 字符 / 上限 200（media 类目）` 这个 detail 格式）。
3. **又一次 TDZ** —— 新的 10e 节排在 §18 之前，一引用 `HTML`/`APP` 就 `ReferenceError`（和之前 `ROOT` 一模一样）。
   **处置不是挪断言，而是把"做静态断言用的源码快照"全部提到文件顶部**，
   并在注释里写清这是第三次同类问题。

### 18.7 已知边界（下一轮请重点看这里）

1. **新规的存量 listing 影响被低估的风险**。官方说存量是"渐进式 rollout、不提交就不动"，
   但"不动"意味着**你的标题会一直是旧口径**，而竞品已经在用两段式。
   本工具现在只告诉你"怎么写对"，**没有**"我现有 listing 该按什么优先级改"的能力
   （官方给的优先级是：畅销 ASIN > 高流量 > 超限标题 > 变体族 > 套装 > 在投广告的品）。
2. **Item Highlights 的"好坏"判不了，只能判"合规与用没用"**。能机械判的是长度、禁用语、
   特殊符号、是否为空、是否复述标题；**判不了**"这个材质句对买家有没有说服力"。
   这是本工具的定位边界，不该假装能判。
3. **`C11` 的 80% 重复阈值是本项目自定**，官方只给了分工原则（"Each one should add something different"）。
   中文标题会先被切词失败（无分词），所以这条**对中文标题基本不起作用** —— 已知粗糙处。
4. **`C14` 的主观词表是自定的**，且 `premium` 在合规 listing 里出现频率极高。
   定成 C 级是刻意的：它会误报，但只报"建议"，不报"必须改"。
5. **免费/低成本图片模型的接入没做**。外部报告建议接 Pixazo / Cloudflare Workers AI / Google ImageFX / Leonardo
   （称现有 `callImageAPI` 只需改 `baseUrl` + `model`）。**核验结论：这个说法只对了一半** ——
   本项目对生图接口的假设是 OpenAI 兼容的 `images/generations`（含 `b64_json`/`url` 两种回包），
   而各家免费层的**回包形态与鉴权头并不一致**（有的走 `/v1/images/generations` 但要求不同 field、
   有的返回的是任务 id 要轮询）。**没有真实 key 就无法验证**，所以按本项目"没有真跑过就不算数"的规矩，
   这一项**没有落地成代码**，只在设置页保留了标准的 `baseUrl` + `model` 两个字段（可自填任何兼容端点）。
   要接的话，第一步应该是拿一个真 key 跑通一次最小请求，再决定是否加"预设"。

---

## 19. 2026-10-01：数据目录可重定向（自检不再碰用户数据）

### 19.1 起因：三套自检里有 4 条红，但根因只有一条

跑 `npm run test:all` 时出现 `113 → 110`、`67 → 66`：

| 失败断言 | 归属 |
|---|---|
| `删除自己的临时图 → 200`（实际 500） | `verify-server.mjs` 第 5 节 |
| `🔴 临时图已从磁盘消失` | 同上 |
| `清单里也不再有它` | 同上 |
| `图片库空态有指引文案` | `browser-selftest.mjs` 第 3 节 |

**实际根因一条**：第 5 节要往"图片库目录"里写一个临时图再删掉，而那目录原先硬编码指向
用户的 `data/gen`。在受沙箱保护的环境里 `fs.unlinkSync()` 会被拦成安全删除并抛错：

```
[safe-delete][SAFE_DELETE_BULK_GUARD_ERROR] state lock timeout
```

→ 删除接口返回 500 → 残留一个 16 字节的 `data/gen/_verify-tmp-image.png`
→ `browser-selftest` 读到的图片库**不再是空的** → "空态文案"断言随之失效。

**判定**：不是产品缺陷（用户自己双击启动时没有这层拦截，删除接口正常）；
但暴露了两个真实问题 ——
① **验证脚本会写到用户真实数据目录**（本项目的规矩是"验证脚本绝不许碰真实数据"）；
② **`browser-selftest` 的"空态"断言是状态依赖的**（取决于"用户碰巧没生成过图"），不是产品行为。

### 19.2 改动：加一个环境变量，而不是加一堆 if

`server.mjs`：

```js
const DATA = process.env.LISTING_DATA
  ? path.resolve(process.env.LISTING_DATA)
  : path.join(HERE, "data");     // 不设变量时行为一字不变
```

`tools/verify-server.mjs` / `tools/browser-selftest.mjs`：各自 `mkdtempSync()` 一个临时目录，
起服务时用 `LISTING_DATA` 指过去，`finally` 里删掉整个临时目录。

**为什么选这个方案**：`data/uploads` 与 `data/gen` 是同一条落盘路径，逐个打补丁（"测试时跳过删除断言"）
会把一个真断言降级成假绿；重定向是**一处收口**，同时解决三个问题
（断言稳定 / 不碰真实数据 / 分享包接收者跑自检不留垃圾）。

### 19.3 改完的实测结果

```
tools/selftest.mjs          共 289 条：通过 289，失败 0
tools/verify-server.mjs     共 113 条：通过 113，失败 0
tools/browser-selftest.mjs  共  67 条：通过  67，失败 0
```

> ⚠️ 上面这组是**那一轮（2026-10-01）当时**的数字，作为历史记录保留。
> 第一套后来因 Rufus 模块涨到 **392**；**当前值一律看 §0.2 与 §10.2**，别引用本节。

**反向验证**：重定向到临时目录后原样的删除接口返回 200、磁盘文件真的消失 ——
说明之前的 500 确实来自"工作区内的删除被拦截"，与接口实现无关。这条反证是本次判定成立的依据。

### 19.4 顺手核对的两件事

1. **分享包不含用户数据**：`跨境Listing优化工作台-分享版.zip` 里 `data/gen/` 与 `data/uploads/`
   只有空目录条目，没有那 16 字节的残留文件 —— 外发是干净的。
2. **`.gitignore` 已覆盖 `data/`**：所以这次残留没有进任何版本产物。

### 19.5 仍然存在的限制（诚实标注）

- `TMP_DATA` 建在系统临时目录下（`fs.mkdtempSync(os.tmpdir())`）。**这是刻意的**：
  同卷的工作区目录在沙箱下删除会被拦，临时目录不会。若将来把自检放进 CI，这一层可以去掉。
- `verify-server.mjs` 仍会读 `.env.local` 做备份/还原与"逐字节未变"断言（这是它的价值所在），
  **没有**把 `.env.local` 一起重定向 —— 因为它要断言"真实密钥没被改写"，指到临时文件就失去意义了。
- `LISTING_DATA` 只重定向 `data/`（uploads + gen）。`.env.local` 与源码目录不受影响。

---

## 20. 2026-10-02：P0-1 · Rufus / Alexa 信息架构检查模块（新增）

> 设计契约在 `docs/SPEC-P0-1-rufus.md`（**200 行 / v1.0.8**）；
> 逐条判据在 `docs/decisions/ADR-001-rufus-module.md`（**110 条 / 501 行**）。
> ⚠️ 阅读顺序：**SPEC > ADR > 本文**。三者冲突时以 SPEC 为准。

### 20.1 为什么加这一层（和已有的 28 条质检不重复）

已有 28 条查的是**「文案本身有没有违规」**；这一层查的是**「机器能不能把你的商品读进去」**。
两者是并列的两层，不是"新规则替换旧规则"：

| | 已有 28 条（`listing.js`） | 新增 7 条（`rufus.js`） |
|---|---|---|
| 回答的问题 | 这句话**会不会被平台罚** | 这句话**能不能被 AI 购物助手引用** |
| 典型命中 | 标题含 `Best Seller`、描述里塞了网址 | 标题写 2 件、五点写 3 件；标题 `32 fl oz`、描述 `1 liter` |
| 判据来源 | 平台公开规则为主 | **行业通行口径为主**（只有 R1 触到官方明文） |
| 输出级别 | P / C | 按设计**几乎全是 C** |

一句话概括：**Rufus / Alexa 这类助手只引用「结构化字段」和「能检索到的句子」。字段空着、事实自相矛盾、单位打架、图上信息没写进文案 —— 这四种情况下，信息对机器等于不存在。**

### 20.2 五组规则（7 条规则条目，其中 R4 按问题展开）

| 组 | 名称 | 规则条目 | 判什么 | 出厂级别 |
|---|---|---|---|---|
| R1 | attributes 完整性 | `R1-01` / `R1-02` | 类目属性的 required / recommended 字段有没有空着 | **P**（仅 required 档）/ C |
| R2 | 跨字段事实一致性 | `R2-01` / `R2-02` | 材质互斥、件数矛盾 | C |
| R3 | 单位制一致性 | `R3-01` | 同一维度组内英制与公制并存 | C |
| R4 | 买家问题覆盖矩阵 | `R4-01` → **按问题展开成 10 条** | 8 类目 × 10 个买家高频问题，listing 里有没有答案线索 | C |
| R5 | 图内文字未文本化 | `R5-01` | 贴在图上的规格文字有没有同时写进文本字段 | C |

**`R1-01` 的级别是运行时算出来的**：只有当缺失字段**全部**来自官方帮助文档正文（`source === "amazon-guide"`）时才判 P（"发布前必须修改"）；只要有一个字段的依据是 schema 或从业者口径，**整条降为 C**。
理由：**报"硬规则"等于替亚马逊下断言，证据不够就不能这么说。**

调用入口只有一个：`lintRufus(listing, ctx)`，`ctx = { productType, imageText, category, brand }`。
返回结构与 `lintListing` **同构**（`results[i] = { id, group, level, scope, status, detail, why, source, sourceTier }`），
`status ∈ {命中, 通过, 通过（部分）, 跳过}` —— 「通过（部分）」是 R4 专属的**第三态**（部分 key 覆盖），不是二分的通过/不通过。

### 20.3 数据从哪来（三档出处，宁可标低不许标高）

`source` 只有三个合法取值，**没有第四种写法**：

| `source` | 含义 | 条目数（属性清单 175 条中的占比） |
|---|---|---|
| `amazon-guide` | 亚马逊**帮助文档正文**明确举例或定义（《Attributes guide》《目录属性规范化》、类目 Style Guide 脚注） | 86 |
| `amazon-schema` | 亚马逊一方的**结构性产物**：Flat File 模板列名 / SP-API Product Type Definition schema 字段名 / Seller Central 后台表单字段名 | 43 |
| `practitioner` | 无官方明文，行业通行或项目自定义 | 46 |

- **`required` 的语义是「官方帮助文档正文明确要求必填」，不是「常识上应该必填」** —— 放进去必须能附上引用句。
  `brand` 就是典型：人人都觉得该必填，但只有 Learn 页流程叙述与第三方口径，**拿不出帮助页正文的引用句**，所以被移出 required 放进 recommended。
  **不为了对称而降低证据标准。**
- 品类属性清单共 **175 条**（required 36 / recommended 139），覆盖 **8 个产品类型**；
  买家问题 **80 条**（8 类目 × 10 题），`source` 全部 `practitioner`。
- 单位族 **6 族**（重量 / 长度 / 体积 / 温度 / 功率 / 电池容量），另有歧义单位白名单 `oz` / `lb` / `kg`。
- 互斥材质词对 **15 对**，guards 采用「全对共用地板词 **33 个**（部件词 24 ∪ 混纺词 9）+ 逐对专有话术」的结构。

### 20.4 三条设计纪律（违反即失真）

1. **数据与逻辑分离** —— `rufus.js` **不写死任何属性 key、问题句、单位词**，一律从 `rufus-data.js` 读。
   `rufus-data.js` 本身**不 import 任何模块**（浏览器与 Node 都能直接用）。有一条源码级断言锁这一点（§23b）。
2. **出处分两档，未知必须抛异常** —— `sourceTier ∈ {official, practitioner}` 只由 `tierOf()` **一处**映射；
   传进未知的 `source` **必须抛异常**，绝不静默归为 `official`。证据引用串随档不同，
   模板列名不许说成帮助文档正文、更不许说成笼统的"亚马逊官方文档"。
3. **分级保守** —— R 组出厂默认 C 级；只有 R1 required 档 + 官方帮助文档正文者可判 P。
   跨字段一致性 / 单位制 / 图内文字都是从业者口径，**报"发布前必须修改"就是撒谎**。

### 20.5 主动登记的两条已知边界（明确选择「不改」，附理由）

这两条是**我们知道自己会判错**、但仍然选择这样实现的地方，已写成断言固定住：

**① R2 的 guard 是「字段级二值」→ 会漏报（`title "Leather Belt"` + `description "Faux Leather Strap"` 不报）**

一个字段内只要命中任一 guard 词，**该字段对该材质对的提及就全部作废**，且不跨字段救场。
后果是 `strap` / `cover` / `shell` / `sole` / `legs` / `collar` 在很多品类里本身就是商品本体（皮带 / 箱包 / 锅），真冲突会漏报。

**为什么不收窄**：收窄会让 `title "Wool Coat"` + `description "Acrylic lining"`（完全合法的"主体羊毛 + 内衬腈纶"）变成**误报**。
本项目的判断是 **误报比漏报贵** —— 一条假报警就让人不再相信整份报告。

**② R2 的否定窗口固定 2 词 → 会误报（与 ① 方向相反）**

`title "This is not the real genuine leather"` + `description "synthetic"` **会报** —— 因为 `not` 距离材质词 3 个 token，超出窗口不撤销。
**为什么不把窗口拉长**：窗口越大，`"not only cotton but also polyester"` 这类正常表述越容易被整段静默压掉，那就从"误报"变成"系统性漏报"，**更坏**。

> ⚠️ ① 与 ② 方向相反，所以在本文件里**必须分开陈述**，不能合并成一句"R2 有边界"。

### 20.6 这一轮修掉的两个真实缺陷

| 缺陷 | 现象（实测） | 根因 | 处置 |
|---|---|---|---|
| **K** | 空表 + `productType:"apparel"` → `{total:16, hit:0, skipped:16, conclusion:"全部通过"}` —— **一条都没查，却报"全部通过"** | 原 SPEC 只约束了「不报命中」、**没约束结论文案**，属规格漏项 | SPEC 补 AC-04；`rufus.js` 里加 `checked = total - skipped`，为 0 时给「无可检查项：全部跳过（请先填文案，或选择产品类型）」；断言 **23n 双向锁**（空表不得报通过；全字段填满**仍须**能报通过，防把结论恒改成"无可检查项"） |
| **L** | 苹果商图最常见的全大写+连字符文字（`BPA-FREE` / `SPILL-PROOF` / `EASY-CARE`）在卖家文案里写成空格时**被报"未文本化"** | token 正则 `/[a-z0-9][a-z0-9.\-]{1,}/gi` 允许 `-` 在词内 → `"SPILL-PROOF"` 被切成**一个**含连字符的 token，于是要求文本侧也带连字符 | 修法是**两侧对称过一遍 `norm()`**（`.` `-` `_` `/` → 空格），净增 2 行；断言 **23l 共 8 条**，且**同时锁住"真未文本化必须仍报"**（否则"把误报修成漏报"也会绿） |

这两个缺陷都不是外部审阅发现的，是**对抗性实测**打出来的：K 是拿空表打生产入口，L 是拿真实苹果商图文字形态打 R5。

### 20.7 行数预算（AC-13）与"不许上调上限"

SPEC 的 AC-13 规定：**代码行 ≤300 且原始行数 ≤400**（口径：纯注释行 = `trim()` 后以 `//` `*` `/*` `*/` 开头；代码行 = 去空行 + 去纯注释行；另设原始行数上限**防注释灌水绕过**）。
计数逻辑**只写一处**（`selftest.mjs` 的 `rufusLineCounts`），**不在测试里复刻另一份生产口径**。

| 文件 | 原始行数 | 非空行 | 代码行 |
|---|---|---|---|
| `assets/rufus.js` | 345 | 327 | **292** |
| `assets/rufus-facts.js` | 396 | 360 | **261** |

**贴近上限时的处置顺序**（SPEC AC-13 明文）：① 先压注释密度 → ② 仍不行才按子功能拆文件 → 🔴 **不许上调上限**。
（`rufus-data.js` 是数据层，不受此预算约束。）

### 20.8 新增断言

| 节 | 锁什么 |
|---|---|
| 23 | 数据层：出处合法性、结构自洽、15 对 guards **逐对对齐**（禁止"这对有 `lining`、那对没有"） |
| 23b | 源码级：R 模块不写死属性 key；既有 28 条一条都不能少 |
| 23c / 23f / 23l / 23m | **打生产入口**的对抗性断言（混纺必须放行、真冲突必须报、"主体+部件"不误报、连字符归一、否定窗口） |
| 23d | 反向测试 fixture 必须**零命中**（防 fixture 造得"能过一切"） |
| 23e / 23k | `guards ∩ GUARD_STOPLIST = ∅`；内部常量成员数漂移锁 |
| 23g / 23h / 23i | Guard B（每题 key 类 hint ≤3）、R4 覆盖判据（OR + 守卫 A + 状态值域）、`termRanges` 与 `hasTerm` 判定必须一致 |
| 23j | AC-13 行数预算 |
| 23n | 缺陷 K 双向锁 |
| 24 | **图标注册表一致性**（防 emoji 图标 / 防静默空图标 / 防 `index.html` 内联 SVG 与 `ICONS` 漂移）—— 本轮给第 ⑥ 卡做图标时新增 |

**断言总数 289 → 392（+103）**；测试节现为 **43**（口径 = `section()` 调用数；其中编号主节到 24，另有 `10b`–`10e` / `11b` / `11c` / `18b` / `23b`–`23n` 这些分节）。
三套现场实测（顺序跑）：

```
tools/selftest.mjs          共 392 条：通过 392，失败 0
tools/verify-server.mjs     共 113 条：通过 113，失败 0
tools/browser-selftest.mjs  共  67 条：通过  67，失败 0
```

### 20.9 界面层（一个新卡，不是新视图）

第 ⑥ 卡**刻意挂在「文案与质检」视图内，不新增导航视图**（`#nav button[data-view]` 仍是 7 个）。
DOM 层做过一次**用无头浏览器真打开页面**的独立验收（不是源码级断言）：

| 断言 | 实测结果 |
|---|---|
| 空表不谎报 | 结论 = 「无可检查项：全部跳过（请先填文案，或选择产品类型）」，**界面上不出现"全部通过"四个字**；7 行全部为「跳过」且带原因「整张表一个字段都没填，无从检查」 |
| 下拉与数据层一致 | 1 个占位 + **8 个类目**（与 `CATEGORY_ATTRIBUTES` 的键数一致） |
| 填入文案后 | 结论 = 「存在硬规则命中，发布前必须修改」；`sourceTier` 上屏（官方 1 / 从业者 15）；R5 转为命中 |
| 「通过（部分）」不被画成红色 | 该状态**逐字出现 5 处**，class = `rule soft`（`isRed = false`）；detail 来自引擎本身：「部分覆盖，仍缺线索：`fabric_type`（已覆盖 1/2（属性 0 / 文本 1））」 |
| R4 分组头 | 「共 10 · 已覆盖 5 · 未覆盖 5 · 跳过 0」 |
| 没有第二套判定逻辑 | 渲染层只调 `lintRufus(currentListing(), rufusCtx())`；C 级命中**不叫"建议改"**（刻意不复用 ⑤ 的 `statusBadge`） |

> ⚠️ 最后一次验收用的驱动脚本是本项目**临时代码**（不在交付物里）。它第一次跑的时候**真卡死过一次**：
> 卡在等 CDP WebSocket 的 `open` 事件，裸 `await` 没有任何超时。处置见 §21。

### 20.10 已知边界（下一轮请重点看这里）

1. **R4 的覆盖判据是 OR，偏松** —— `answerHints` 里任一 key 命中即算"这条问题有答案"。
   我们能证明的只是"文案里有相关线索"，**不能证明"这句话真的回答了那个问题"**。用「通过（部分）」这一态来缓和，但松紧度是否合适，需要真实卖家判断。
2. **R2 的两条边界（§20.5）** —— 一条漏报、一条误报，都写成了断言，但**方向相反的两条边界同时存在**，是这一层最可能被挑战的地方。
3. **R5 依赖用户手贴 `imageText`** —— 不解析图像、不做 OCR。不贴就整体跳过。**"跳过"不是"通过"**，界面上会显示原因。
4. **R1 的 required 只是"能附引用句"的字段**，不是亚马逊的完整必填清单；
   属性**值**本身有闭集约束（官方错误码 90057），本项目**只检查"哪个字段空着"**，不做生成式填值 —— 填一个不在下拉里的值比空着更糟。
5. **8 个类目的属性/问题清单必然不完备** —— 是从官方帮助页正文与从业者经验归纳出来的第一版，覆盖的是最高频的类目。
   扩展方式是"照着同一套 `source` 纪律再加类目"，**不是**把清单做成"越多越好"。
6. **问题矩阵 80 条全是 `practitioner`** —— 没有任何官方问题清单存在，所以这一整组的"权威性"上限就在从业者经验。

---

## 21. 附：一次「无超时等待」导致的挂死，以及它的处置

写在这里是因为它**不是产品缺陷，而是验证工具链的缺陷** —— 而且这类缺陷的症状是"什么都不打印、什么都不报错，就是不动了"，最难排查。

### 21.1 卡在哪一步

用**临时写的** CDP 驱动脚本（不在交付物里）去真浏览器里抓第 ⑥ 卡的 DOM 证据。
最后一步卡在等 CDP 的 WebSocket 打开：

```js
await new Promise((r) => ws.addEventListener("open", r));   // ← 裸 await，没有任何超时
```

### 21.2 表现与持续

命令**没有超时退出、也没有报错退出**，是"被用户中断"。进程被挂住，**且没有走清理路径**（残留的子进程要靠外部回收）。

### 21.3 触发条件（判定：等待输入 / 依赖阻塞）

**不是死循环、不是资源不足。** 依据是事后取证：

| 检查 | 结果 | 说明 |
|---|---|---|
| `netstat` 查 8899 / 9333 / 9223 | 无监听 | 本地服务与调试端口都已回收 |
| `node.exe` 进程数 | 0 | 没有进程泄漏 |
| `msedge.exe` 进程数 | 13 | 浏览器进程仍在（但已无调试会话在推进） |

根因三选一，**并存无法再区分**（这本身就是问题）：
① headless Edge 未完全就绪时连 `--remote-debugging-port`，`open` 事件可能永不触发；
② 探针里 `--virtual-time-budget` 与 CDP 会话交互，页面事件不再推进；
③ 每次调用都 `spawn` 一个新浏览器进程，**没有超时兜底** —— 只要某次握手不返回，就永久挂住。

### 21.4 处置（四条，缺一条都还会复发）

1. **所有外部等待都套硬超时**：`withTimeout(p, ms, tag)`，覆盖 ws `open`（10s）、每条 CDP `rpc`（15s）、服务就绪（10s）、CDP 就绪（15s）、页面渲染就绪（10s）。
2. **用条件轮询替代固定 `sleep`**：等 `#btnRufus` 真的出现、等 `#rufusOut .rule` 真的渲染出节点 —— 而不是 `sleep(2000)` 赌它好了。
3. **`try / catch / finally` + `process.on("exit" / "SIGINT")` 兜底清理**，显式 `SIGKILL` 子进程，并打印 `[cleanup] 已终止 edge/server pid=…` 让人看得见。
4. **不依赖 `--dump-dom`**（一次性输出，会和 CDP 交互、以及虚拟时间预算打架）。

### 21.5 验证

重写后的脚本**56 秒跑完、0 FAIL**，且清理日志明确打印终止了 `edge pid=26320` 与 `server pid=22296` —— 说明"挂死"确实来自等待策略，而不是页面或服务本身有问题。

> 补充一条诚实说明：**交付物里的 `tools/browser-selftest.mjs` 本来就有 10 秒的连接超时**（第 67 行 `setTimeout(() => rej(new Error("CDP 连接超时")), 10000)`），所以它没出过这个问题。
> 这次的教训属于**临时脚本**：临时脚本最容易省掉超时，而它偏偏又是排查问题时最常跑的。
> 另外，三套自检**必须顺序跑、不许并行**（见 §10.2）—— 它们都会往 `tools/` 写报告，并行会互相把对方产物当数据变动。

---

## 22. 2026-10-02：把「亚马逊竞品销量榜工具」整合进工作台

### 22.1 整合前是两个仓库、两套壳

- **A（被整合方）**：`亚马逊竞品销量榜工具` —— 一个独立的 Node 服务（`server.js` 1110 行）+ 自己的前端页（1113 行）。
  它能做的事很单一：实时抓亚马逊 Best Sellers 榜单 → 算关键词权重 → 拼一段文案提示词给你复制。
- **C（落点）**：本工作台 —— 单页 8 视图，已有质检、草稿生成、采集、本周词库、图片库、本地产物、Rufus 检查。

### 22.2 勘察时发现的**关键事实**（决定了整合该怎么做）

C 的「文案与质检」视图里**早就有一条竞品关键词链**：`#lCorpus` 竞品语料框 → `mineKeywords()` → 一键填 `#lKeywords`
→ 多竞品共识词。**缺的只是最后一跳：把算好的结论拼成一段可复制的文案提示词。**

所以这次整合**实质上是"补上缺的那一半"**，而不是"把 A 整个搬进来"：

| A 的组成 | 去处 | 理由 |
|---|---|---|
| 关键词权重模型 + 4 张词表 | → `assets/competitor-keywords.js` | 纯本地纯函数，C 里没有 |
| Best Sellers 实时抓取 + 缓存 | → `assets/bestsellers.js` + `server.mjs` 三条路由 | C 里**完全没有**主动爬站点的能力 |
| 5 类文案提示词模板 | → `assets/copy-prompts.js` | C 的 `prompt-engine.js` 只做**图像**提示词，文案侧是空的 |
| A 的前端页（1113 行） | **不搬** | 与 C 的 7 视图外壳重复，搬进来就是第二套导航 |
| A 的 `/api/search`（`/s?k=` + Python `scrapling`） | **不搬** | 会给零依赖项目引入 Python 运行时；原代码注释自述该路径已被亚马逊 503 封锁 |

**遵守项目既有约定：加卡不加视图。** 第 ⑦ 卡挂在「文案与质检」视图内、⑥ Rufus 卡之后，
`#nav button[data-view]` 仍然是 7 个（自检有断言钉死这条，防止以后顺手加视图时同时踩到 3 处硬编码的「7」）。
卡内所有 id 用 `cp*` / `btnCp*` 前缀，与既有 id 零冲突。

### 22.3 三处**有意加强**（不是照抄 A）

1. **主机硬白名单**：只允许 8 个 amazon 域，且路径必须是 `/gp/bestsellers/` 或 `/zgbs/`。
   A 的实现是"任何传入的 href 都去抓" —— 那等于把 SSRF 交给了调用方。
2. **复用 `net-guard.js` 的 `assertPublicUrl`**：DNS 解析后判内网 IP。A 完全没有这层。
   **重定向之后再判一遍白名单**（`Location` 头是第二个注入点）。
3. **服务端 `href` 参数自己过白名单**：`?href=` 只在白名单内的地址才放行，否则 400 —— 否则这个参数就是一条任意 URL 抓取通道。

外加一个**实测修掉的缺陷**：请求头不带 `Cookie: i18n-prefs=USD; lc-main=en_US` 时，
亚马逊按**请求方 IP 所在国**返回本地化结果 —— 本机在中国，整列价格变成 `CNY 60.39`。
A 的 Python 侧（`scrape.py`）强制了 USD，Node 侧漏了。现已补上，浏览器自检里有断言锁死"价格必须以 `$` 开头"。

### 22.4 口径不写第二份

文案提示词里的字符上限**全部**取自 `assets/listing.js` 的 `LIMITS` / `titleLimit()`：
75（非 media 标题）/ 200（media 标题）/ 125（Item Highlights）/ 200（两段合计）/ 250 **字节**（后台搜索词）/
500（五点单条）/ 5（五点条数）。自检第 25 节有一条**反向锁**：文案层源码里出现这些字面量就直接 FAIL。

顺手修掉 A 的两处**字符口径错误**：后台搜索词原文写「250 字符」（平台口径是**字节**，中文占 3 字节会超 3 倍）；
五点原文写「200」（`LIMITS.bullet` 是 500）。

### 22.5 验收方式（这一节的做法值得单说）

- **行为快照先行**：移植权重模型前，先让 A 原样跑出一份 87,012 字节的字段级快照（`tools/_keywords-snapshot.json`，已随整合搬进工作台），
  移植后**逐字段比对 57 项**，全通过才继续 —— 而不是"看起来差不多"。
- **浏览器那套允许失败**：抓取是唯一联网动作，亚马逊改结构 / 断网 / 限流都属正常，
  所以断言的核心**不是"必须抓到 30 条"**，而是「**状态文案 ↔ 表格内容**」这条一致性不变量：
  状态说抓到 N 条，表格就必须真有 N 行；失败就必须显示失败原文且**表格里不许有伪造数据**。
  两种结局都诚实，才算通过。因此这一节的断言条数会随网络环境浮动（本轮实跑抓到 30 条，成功路径全部走通）。
- **安全那一套刻意不联网**：13 类非法参数 × 2 条路由，全部要求"在发出网络请求之前就 400" ——
  真抓取一旦进了安全回归，它就从"安全回归"退化成"看网速脸色"。

### 22.6 已知边界（详见 §11 第 26–29 条）

榜单页 DOM 会变；评论数只是**从业者口径**的销量代理指标（亚马逊不公开销量）；权重模型是启发式、**不是搜索量**；
中文竞品标题不做分词；提示词只是"给模型的输入"，产出质量不受本项目控制；`/s?k=` 关键词搜索路径**刻意不提供**。

---

## 23. 2026-11-06：外部审查后的 16 项加固（无新功能，全在修"说得到做不到"）

来源：一份外部竞品对比 + 代码审查。16 条的共同特征是**功能表面上都有、但结论会骗人**。
本节只写实现与契约，不重复 README 附五的表格。

### 23.1 质检状态语义（N1，最严重的一条）

**改前实测**：中文 Listing 的 `summary.skipped === 0`、结论「硬规则全过」，
而 P5 / P11 / C1 / C4 / C11 五条规则内部返回的是 `{ skip: true }` —— 也就是**未判定被算成了通过**。

**契约**（`assets/listing.js`）：

```js
status ∈ {"命中", "通过", "跳过", "异常"}
checked  = total - skipped - errored      // 真正判过的
unjudged = skipped + errored              // 未判定
```

- 规则抛异常 → `status = "异常"`（以前会让整条 `lintListing` 抛出去，或者更糟：静默不算）；
- `conclusion` 四档：有 P 命中 / 有 C 命中 / `checked === 0`（"这不等于通过"）/ 全过但仍有未判定；
- **任何**结论后面都要带「另有 N 条未判定：跳过 x / 异常 y」；
- 界面 KPI 同步改口径：`通过 = checked - hit`，另列「跳过·未判定」「异常·未判定」。

**反向锁**：自检里有「全过时结论仍是全部通过」（用零命中的 `CLEAN` fixture）与
「不得出现跳过/异常项」两条，防止以后有人把 `checked` 改回 `total`。

### 23.2 画幅口径收回服务端（N2 + A2 + N3）

三份映射表（客户端 `sizeToPixel`、服务端 `PIXEL_TO_RATIO`、prompt-engine 的 `RATIO_PIXELS`）收敛成一份：

```js
SYNC_CANVAS = { square: "1024x1024", landscape: "1536x1024", portrait: "1024x1536" }
resolveSendSize(size, mode, syncMode) → { sent, ratio, note }
```

| 模式 | 发什么 | 吸附 |
|---|---|---|
| `async`（apimart 类） | 比例字符串 `"16:9"` | 不吸附 |
| `sync` + `strict` | 三种白名单像素 | 吸附并**必带 `sizeNote`** |
| `sync` + `free` | 上表原样像素 | 不吸附（接口支不支持由用户负责） |

`/api/image` 回传三个字段：`size`（实发）、`sizeRequested`（请求）、`ratio`、`sizeNote`。
前端简报用 `r.ratio` 而不是用户输入值 —— **否则简报会和实际成图不一致**。

### 23.3 只读门与断连取消（A3 + A6）

```js
const RO_PUBLIC = process.env.LISTING_NO_KEY_WRITE === "1";
const WRITE_ROUTES = [["POST","/api/config"],["POST","/api/upload"],["POST","/api/image"],
                      ["POST","/api/vision"],["POST","/api/llm"],["DELETE","/api/library"]];
```

- 命中即 `403`，`health.capabilities.readonly = true`，前端**先禁用**按钮（不等 403）；
- `/api/chat` **刻意不关**：它是在线体验的主链路，且不消耗生图额度；
- 断连：`abortOnDisconnect(res)` 用 `res.on("close") + !res.writableEnded` 判定
  （`req.on("close")` 在请求体读完瞬间就触发，会把正常请求误判成断开），
  中止信号一路传到 `fetchWithTimeout` 与 `sleep(ms, signal)`，异步轮询循环里也检查 `signal.aborted`。

### 23.4 资源族（A5）

| 闸门 | 阈值 | 超限行为 |
|---|---|---|
| zip 文件数 | 300 | `413` + 可执行建议（先删哪些） |
| zip 单文件 | 40 MB | 跳过该张并说明 |
| zip 总量 | 300 MB | `413` |
| 上传格式 | PNG/JPEG/GIF/WebP（**按文件头魔数**） | `415`，回传 `declaredType` 便于排查 |
| 榜单页数 | 3 | 参数被夹到上限，回执里写实际页数 |

魔数嗅探堵的是 **SVG 里的 `<script>` 造成同源 XSS**：以前只看 `Content-Type`，
攻击者声明 `image/png` 实际传 SVG，落盘后被同源打开即执行。

榜单抓取另外两处：`withRetry` 对 400/401/403/404/405/410/451 **不重试**，
其余按 `gap × 2^i × (0.8~1.2)` 退避并尊重 `Retry-After`（封顶 10s）；
缓存改 LRU 但**命中不刷新 `at`**（否则热点 URL 永不过期，等于没有 TTL）。

### 23.5 IP 钉死（net-guard 补全）

```js
resolvePublicHost(url)  // 解析 → 逐 IP 判内网 → 返回 { address, family, host }
getPinned(pinned, opts) // https.request 带 lookup 钩子，把地址钉死
downloadPinned(url)     // 每跳重定向重新 resolve + 重新判内网，maxRedirects = 2
```

关键取舍：**TLS 的 `servername` 仍用域名**（SNI 与证书校验针对域名），只有 socket 连接用钉死的 IP。
这样既关掉 DNS rebinding 的 TOCTOU 窗口，又不会退化成"跳过证书校验"。

断言方式很直白：让域名**无法解析**、但 `lookup` 钩子钉到 `127.0.0.1`，仍能连通
→ 证明连接真的用了钉死的地址；同时另有一条断言锁「钉死 ≠ 放行内网」。

### 23.6 导出/导入的版本契约（A4）

```js
EXPORT_SCHEMA = 1
importFrom(text):
  schemaVersion 缺失  → 按 v0 兼容导入 + warning（提示重新导出带版本号的备份）
  非法（非正整数）    → 拒绝
  > EXPORT_SCHEMA     → 拒绝，并说明"强行导入会静默丢字段"
```

### 23.7 快照对比（`amazon.diffSnapshots`）

比 9 个文本字段；数组字段给 `added` / `removed`；对象（`specs`）先拍平成 `"键: 值"` 再比
—— 原来 `String(对象)` 恒为 `"[object Object]"`，**规格变化永远比不出来**（本轮修的隐藏 bug）。

三条纪律写进了源码注释与断言：

1. 只比抓到的内容，不猜原因（自检扫描函数体，禁止「可能是因为 / 说明对方 / 推测」等措辞）；
2. ASIN 不同 → `note` 必须写"这不是同一件商品的前后对比"；缺 ASIN → "无法确认是同一件"；
3. 数组顺序变化**算变**（前台展示顺序变了），但 `added` / `removed` 为空。

UI 侧：勾选上限 2 条，**按 `createdAt` 排序**而不是勾选顺序（否则勾反了会把"改前/改后"读反）。

### 23.8 语种边界（`detectScript`）

```js
detectScript(text) → "zh" | "en" | "ja" | "ko" | "other"
detectLang(text)   → "zh" | "en"        // 二元兼容入口，契约不变
```

C3 用 `detectScript`：非 zh/en 时 `{ skip: true }` + 说明语种。
原来日文五点里汉字占比高 → `detectLang` 判 `zh` → 拿中文利益词表套日文 → 命中 0 → **直接判死**。
这是**错判**，不是发现。

已知边界（写进 `LANG_SUPPORT` 与断言）：纯汉字日文与中文不可区分；`350ml` 仍判 `en`（有拉丁字母）；
利词表只有 zh/en，停用词有 7 套。

### 23.9 断言数守卫

`tools/expected-counts.json`（`{selftest: 571, verify-server: 260, browser-selftest: 199, mcp-selftest: 248, keywords-selftest: 136}`）
+ `tools/assert-count.mjs`：**实际 < 期望 → 退出码 1**；实际 > 期望 → 只提示。

三套必须顺序跑：报告写在 `src/tools/` 旁边，另一套开头的快照会把它当变动。

### 23.10 仍然未闭合的

- `IMG_API_MODE` 的默认值取决于你实际用哪种生图接口（apimart 异步 / OpenAI 兼容同步）—— 未定；
- 亚马逊「主图禁 AI / XMP 打标」官方原文未取得 → 两条保持 `sourceTier: 待核实`；
- 测试盲区（外部站点改版、真实 API 漂移、IndexedDB 配额、视觉/可达性、浏览器矩阵）**没有清零**，
  只是第一次被写成清单：`docs/测试盲区清单.md`。


---

## 24. 2026-11-07：外部数据源 —— 工作台自己去连第三方 MCP

### 24.1 要解决的问题

本地引擎能判"这个词覆盖了没有"，判不了"这个词一个月被搜多少次"。
后者只有买数据才有。上一轮的做法是"在 AI 客户端里挂两个 MCP server 让模型自己编排"，
但使用者真正会遇到的场景是：**在网页里少截一次图**。所以这轮把"当客户端"这件事做进服务端。

### 24.2 分层（三层，谁都不许跨）

| 层 | 文件 | 职责 | 明确不做 |
|---|---|---|---|
| 传输 | `assets/mcp-http.js` | Streamable HTTP：一个 POST 一条 JSON-RPC；SSE 与 JSON 两种响应都认；回带 `Mcp-Session-Id`；通知不等回包 | 不认厂商、不读配置、不做白名单 |
| 归一 | `assets/term-normalize.js` | 把任意返回猜成 `{term, volume, rank}`，回报实际用到的字段名 | 不编数据：认不出 → 0 条 + 原因 |
| 门禁 + 编排 | `server.mjs` | 常量白名单、同源校验、密钥读环境变量、超时与错误翻译、落盘、与本地词库求交集 | 不解释业务字段 |

**为什么白名单必须在门禁层**：`mcp-http.js` 只认 `url` 参数。如果 url 来自请求体，
这个路由就是一个通用 SSRF 跳板（`http://127.0.0.1:8787/api/config`、云元数据 `169.254.169.254`
都能被塞进来）。所以 `EXTERNAL_MCP` 是 `server.mjs` 里的常量对象，请求体里**没有** url 字段，
请求里夹带 `url` / `key` / `baseUrl` 一律被无视（有断言守着）。

### 24.3 协议层的四个坑（都有断言）

1. **响应可能是 SSE 也可能是 JSON** —— 同一个服务端混用是允许的；只认一种的实现会"永远没回包"。
2. **`Mcp-Session-Id` 只在 `initialize` 的响应头里出现一次**，后续每个请求都要回带，否则 400。
3. **`notifications/initialized` 没有 id，不等回包**；等它就是"接上了但一直转圈"。
4. **SSE 流里可能先来一条通知帧（无 id）**，naive 实现会把它当成结果，然后把"没有结果"当成"工具没返回"。

这些不靠真密钥也能验：`tools/mcp-selftest.mjs` §13c 起一个**本地 mock MCP 服务**，
把四种情况各跑一遍（含 401、超时、id 对不上）。§13d 验归一层的六个边界（嵌套/纯数组/12.3K/认不出/去重/长文本）。

### 24.4 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/external/providers` | 数据源清单 + 是否已配密钥（只回 `****末四位`，**不回密钥本体**） |
| POST | `/api/external/test` | `initialize` + `tools/list`，回服务器名/工具名/描述/必填参数 |
| POST | `/api/external/call` | 调一个工具，原样回传（带 `bytes` 与 `truncated`，让人知道这次拉回来多大） |
| POST | `/api/external/import` | 调工具 → 归一 → 原子写 `data/external/<id>.json`（只存归一后的词，不存原文） |
| GET | `/api/external/terms` | 读上次导入；`?compare=1` 追加与**本地全量**词库的交集（盲区 / 两边都有 / 本地独有） |

三个 POST 都：过同源校验（与 `/api/config` 同一套）→ 要求 `application/json` → 请求体上限 256 KB →
只接受白名单里的 `provider` → 密钥缺失时 400 且点名要配哪个环境变量。
线上只读模式（`LISTING_NO_KEY_WRITE=1`）下三个 POST 一律 403，`GET providers` 仍可读。

### 24.5 密钥的落点

`CONFIG_KEYS` 由 `EXTERNAL_MCP` **循环生成**（`sellerspriteKey` → `SELLERSPRITE_KEY`），
沿用 `.env.local` 的原子写（tmp + rename）与 `mode: 0o600`，写完立刻失效 env 缓存。
浏览器侧：保存成功后立刻清空输入框，页面上只留掩码；实测断言"密钥不在 DOM、不在 localStorage"。

### 24.6 与本地词库的交集为什么放在服务端

`GET /api/keywords` 有 500 条上限（`MAX_KEYWORD_LIMIT`）。如果对比放在浏览器里，
"盲区"会把 1,600 多条已覆盖的词算成盲区 —— 那个数字比不给更糟。
所以 `?compare=1` 在服务端用 `snapshot.keywords` 全量算，回传三个计数 + 前 100 条盲区。

### 24.7 本轮没有做的事

- **没有**为某个厂商写死字段映射（改版即静默失效）；归一仍是启发式，界面会显示"猜的哪些字段"；
- **没有**把外部返回塞进对话上下文（一次 `includeAsins` 默认开的快照就有 200 条 ASIN ≈ 1.7 万 token）；
- **没有**做自动投放/调价/改 listing —— 只取数；
- **没有**多数据源并行调度（现在是一个 `provider` 一个会话，够用就不提前抽象）。

---

## 25. 2026-11-08：批三 / 批四全量落地（趋势、词根、接入形态、协议契约）

### 25.1 范围与判据

《优化方案-评审建议逐条实现与竞品对照（2026-11-07）》把 32 个动作分四批。
批一、批二在 11-07 晚已落地（见该文 §10.6 / §10.7），**本轮做的是剩下的批三 8 项 + 批四 10 项 P2 + S-6**。
判据沿用方案原文：**是否影响数据可信 / 是否让运营用不起来**，不是"功能多不多"。

三项在核查时发现**之前已顺手实现**，本轮只复核并补断言，不重复改码：
P1-3 历史投影（`digestOf` 已是 topTerms 800 / asinRanks 30 / HISTORY_KEEP 104）、
P2#4 `priceKnown`、P2#7 `verifiedMarket`、P2#8 `mtimeNs` 缓存精度。

### 25.2 词库层：结构先行，不承诺开站

- **P1-2 一站一文件**：`latestPath(env, site)` 支持 `latest-<SITE>.json`，`readLatest(env, site)`
  在站点文件不存在时回落旧 `latest.json` 并打 `legacy:true`；`history/<SITE>/` 与旧扁平布局都能读。
  🔴 **默认不传 site 时产物名仍是 `latest.json`** —— `keywords-selftest` 有十几条断言硬编码检查这个文件的
  存在性、字节与 mtime，改名会让「失败不覆盖」这组最重要的回归集体变红。开站是"显式传参"的事，不是默认值的事。
- **P1-3 历史投影**：只存 `topTerms`（800 个 `[词, rootCount]` 元组）+ `asinRanks`（每类 30 个 `[ASIN, rank]`），
  单份 < 40KB，104 份约 3.6MB。上限取 800 不是 400：2135 词只投 400 会让低于投影线的回归词被算成"新增"。
- **G-4 词根覆盖层**：新 `assets/keyword-roots.js`，运营改 `data/keywords/roots.json` 即可增删词根，不动 JS。
  三条冲突语义写进代码并有断言：`removed` 优先于 `added`、`renamed` 原子（from 不存在 / to 已存在 → 整体拒）、
  `added` 已存在 = 幂等成功。覆盖层 JSON 损坏时**退回基线并说明**，不中断采集；非法项进 `rejected` + `notes`，不静默。
  覆盖率反馈落到 `snapshot.sources.roots`（planned / hit / zeroHit / top）。
- **S-3 / S-4**：`compareSnapshots` 与 `diffAsins` 都是纯函数。前者没有 prev 时三个集合给 **null**（不是 0），
  后者保证 entered / left / moved 是对全量 ASIN 的一个**划分**（互不重叠且并集闭合），名次变化单独记在 `rankChanges`。
- **P2#5 同日重跑**：`nextHistoryPath` 产出 `-2` / `-3`，保留策略按文件名字典序，与 P1-3 口径一致。

### 25.3 MCP 层：一个 URL 接入 + 更严的对外契约

- **P0-B2 回环 HTTP**：`mcp/http.mjs` 只绑 `127.0.0.1:8790`，`POST /mcp` 与 stdio **共用同一个消息处理函数**，
  所以两边 `tools/list` 逐字节相同。四道门：Host 白名单（防 DNS rebinding）、跨站 Origin → 403、
  Bearer token（优先 header，降级 `?token=` 时短效 12h + 拒绝非空 Referer）、`GET /mcp` → 405。
  🔴 **没有把 handler 拆成 `./handler.mjs`**：`mcp-selftest` 第 683 行静态断言要求 `mcp/server.mjs` 的 import
  只能是 `node:` 或 `../` 开头；拆文件会直接让这条红，而收益只是目录好看。架构洁癖让位于可验证性。
- **P2#1 / #2 / #3**：8 个工具都带 `annotations`（readOnly / destructive / idempotent / openWorldHint）、
  `outputSchema` 与 `structuredContent`（与 text 里的 JSON 深相等，`content` 保留向后兼容）；
  参数校验改表驱动 `VALIDATORS`，传错类型会明说「应为 number」并带上限值。
- **S-2 / G-8 `useVault`**：`analyze_coverage` 显式 opt-in 才把本周词库并进候选；user 词优先、vault 词去重，
  `coverageUser` / `coverageVault` **分开两个数**。无词库时 `isError:false` + `vault:{ok:false,reason:"missing"}`。
  🔴 不传 `useVault` 时走改动前 `run()` 的逐字拷贝，输出逐字节一致 —— 这是"没把老客户改坏"的唯一硬证据。
  开启后 `gaps` 变对象数组，响应里带 `gapShape` 自证形状，避免"同一字段两种形状"的静默陷阱。

### 25.4 判断层：每条命中都要说清「为什么」和「怎么改」

- **S-6 / P2#11**：`RULES` 28 条各加一句可执行的 `fix`，`lintListing` 的每条命中带 `why` + `fix`。
  规则 id、数量、`sourceTier` 口径、返回字段一律不变 —— 只加字段，不动行为。
- **S-2 覆盖度**：`analyzeCoverage` 支持 `targetsFrom` / `targets`；**默认返回对象一个字段都不加**
  （`deepEqual` 会看见新增字段，哪怕 JSON 里会消失）。只有显式传参才带 `gapsDetail` / `coverageUser` / `coverageVault`；
  `gaps` 永远保持字符串数组。支持「只传 `targetsFrom`、不传 `targets`」这种前端用法。
- **P2#10 CSV**：新 `assets/csv.js`，`toCsv(rows, cols)` 按 RFC 4180 转义 + UTF-8 BOM，`parseCsv` 保证含逗号/引号/换行的字段往返相等。浏览器与 Node 同一份实现。

### 25.5 界面层：功能全做，但页面不新增视图

S-2 / S-3 / S-4 / G-9 / G-4 / CSV 六组能力**全部收进现有第 8 个视图「本周词库」的折叠分区**，默认收起。
方案 §8.1 写的是「趋势/监控/对比三个视图上线」，这里刻意改成页内分区：
用户后来明确要求「页面要干净、别做复杂」，而三个视图会把侧栏从 8 项撑到 11 项、
同步牵动 README / 功能详细介绍 / `check-doc-numbers.py` 里所有视图数口径。
**功能一条没少，承载形式按后来的 UI 约束收敛** —— 这是取舍，不是漏做。

G-9 站点下拉里 US 之外全部标 `○ 未实测` 且 DOM 带 `data-verified="false"`，选中时提示「类目映射可能不准」。
所有新字段都可能缺失（旧服务端 / 只读演示版），每个渲染分支都要如实说明，不能显示 0。

### 25.6 服务端：新接口与门禁

`server.mjs` 新增 `/api/keyword-roots`（GET 读 / POST 原子写）、`/api/export`（CSV）、
`/api/keywords?compare=prev` 与 `site` 参数，并在 `/api/keywords` 回报 `compare` / `asinDiff` / `roots` / `verifiedMarkets`。
POST 词根覆盖层走同源 + 强制 `application/json` + 64KB 上限，且**只认 added / removed / renamed 三个字段**
（夹带 `path` / `key` 一律忽略），落盘路径是常量、原子写；已进 `WRITE_ROUTES`，线上只读版 403。
冷分支（没有快照）也返回与热分支**完全相同的字段形状**，一律 `ok:false` + 原因 —— G-3 的教训，不给 0。

### 25.7 验收口径

五套自检顺序跑（`tools/expected-counts.json` 守"只增不减"）；`check-doc-numbers.py` 逐项核对行数 / 断言数 /
文件数 / 视图数；`make-share-pack.py` 在解压后的干净目录里跑端到端；
最后在解压目录起服务打 `?compare=1&demo=1` 与新增接口，确认分享包接收者不缺文件。
具体条数与体积见 §0.2 与本文 §1.3 表（数字以磁盘为准，不在此复述）。

### 25.8 明确不做

方案 §7 的 9 条与 P2#12 的两条协议细节已写进 README 附六，**防止以后有人把克制当漏做又补回去**。
其中「真开 8 站」「项目内置真实搜索量」两条尤其容易被误读：前者是结构已留、默认只跑 US；
后者与"外部数据源可选接入"不冲突 —— 谁用谁配自己的密钥，项目不内置、不代付。

### 25.9 本轮没有做，也不假装做了

- **没有**用真 `secret-key` 核对第三方字段名（无账号）。示例数据能验界面与交集算术，代替不了这一步；
- **没有**注册本机每周计划任务（环境安全策略禁止调用任务计划程序）；项目无 `.git` / 远端，
  GitHub Actions 的每周任务仍不会触发，词库快照仍停在 11-07 那次手动采集；
- **没有**推送 GitHub（用户明令暂停所有推送操作）；
- **没有**擅自覆盖线上演示版链接 —— 重新发布是对外动作，需要用户本轮明确同意。

---

## 26. 2026-11-08：全面审查后的三批修复（止血 → 文档闸门 → 体验）

本轮起因是一次**带证据的全面审查**（真起服务 + 无头浏览器截 8 个视图 + 直接 import 引擎函数做边界实测），
不是"读代码猜问题"。审查结论按 P0/P1/P2 排成三批，三批全部落地。
每条都写明**判据**，因为"改完了"不等于"改对了"。

### 26.1 批一：止血（会让用户丢东西 / 会被误信的）

| 问题 | 原症状 | 处理 | 判据 |
|---|---|---|---|
| 刷新即丢全部输入 | `localStorage` 全项目零表单保存 | 17 个字段自动存本机（延迟 350ms，空表单清键），启动时逐字段回填 | 刷新后逐字段相等；清空是两步确认 |
| 生成草稿静默覆盖手改 | 原来无条件写回 5 个字段 | `draftConflicts()` 只比对"已有内容且不同"的字段；有冲突时给**填充空位 / 覆盖 / 取消**三选一，覆盖前留快照，可撤销 | 冲突时不写；撤销后逐字段回到手改内容 |
| 视图不进 URL | F5 回创作台，链接不可分享 | `VIEW_NAMES` 从 DOM 推导（不抄第二份清单）；`hashSelfWrite` 区分"自己写的"与"用户按后退" | 后退键能走、F5 不跳回 |
| 图片库空态被折成三行 | `.lib-empty` 被 186px 栅格压成一列 | `grid-column: 1 / -1` | 计算样式断言 |
| media 类目同屏两个上限 | 顶部 chip 写 120/200，摘要写 23/75 | 摘要改用 `L.titleLimit(ctx)` | 源码级断言 + 界面 |
| 空输入仍宣称"结构合规" | 空骨架也被盖章 | 按有无标题分岔，空输入明说"这是空骨架，不是合规草稿" | 断言两条文案都在 |
| Markdown 星号漏进 HTML | `**有资格**` 被 `innerHTML` 原样渲染 | 6 处去掉星号 | 断言源码无 `**` |

### 26.2 批二：文档闸门（让"写错的数字"能被机器抓到）

`tools/check-doc-numbers.py` 原来用 `re.search`，**只核对每类数字的第一次出现** ——
所以对外文档第 24 行写着「1021 条（509 + 237 + 134）」（括号内相加 880），脚本照样报全绿。

- 改成全量 `finditer`，逐处核对；基线**从 `expected-counts.json` 读**，不抄第二份；
- 新增 10 组检查（命令块、命令速查表、"N 条断言 / M 个测试节"、测试节数、三套合计含分项、`test:all`、`app.js` 行数与体量、`expected-counts.json` 内容描述、架构说明套件表、§1.3 表内条数）；
- 区分**当前状态**与**历史快照**：§0–§13 逐处核，§14 起是带日期的变更记录，跳过但**打印跳过的行号**（静默跳过等于没写这条检查）。
- 结果：项数 56 → **83**，首跑对升级后的文档报红 25 项（证明它真能抓），逐项改到全绿。

### 26.3 批三：体验（九项，逐项验收见 §26.4）

1. **Listing 右栏吸顶**：`@media (min-width: 781px)` 内 `position: sticky` + `max-height: calc(100vh - 28px)` + 自身滚动。窄屏不吸 —— 单栏吸顶会把内容压死。
2. **设置页「测试连接」**：`POST /api/config/test`，只 `GET {baseUrl}/models`。**三档结论**：绿 = 通了且密钥被验证（还核对模型在不在清单里）/ 黄 = 端点可达但对方不提供 `/models`、密钥**没被验证** / 红 = 没通（区分"连不上"与"密钥不被接受"）。允许请求体覆盖 baseUrl/key，**不写 runtimeConfig、不写 .env.local**（测试不该有副作用），并进 `WRITE_ROUTES`（只读演示版 403）。
3. **图片库搜索**：纯前端过滤，`libVisible()` 是唯一结果集；栅格与「复制路径」共用它，避免"显示 3 张、复制 40 条"。
4. **词库表头吸顶**：`border-collapse: collapse` 下边框不跟 sticky 元素走，下边线改用 `inset box-shadow`；必须有**不透明背景**，否则滚动时透字。
5. **CSV 公式注入防护**：`toCsv(rows, cols, { guard: true })` 给 `= + - @ TAB CR` 开头的字段加 `'` 前缀；**负号开头的纯数字不算公式**（`-12.5` 是数据，加前缀会让 Excel 当文本）。默认**不开** —— 开了会破坏 `toCsv → parseCsv` 往返相等这一核心契约，所以只在 `/api/export` 真正落成文件时打开。
6. **`npm run test:all` 补满五套**：原来只跑三套，漏 384 条。
7. **词库列名「词根」→「词根数」** 并右对齐（单元格是数量，不是词根本身）。
8. **`fmtStamp` 非法时间**不再显示 `1970-01-01`，改为 `—`。原来的 `t || 0` 会把缺值当 epoch —— 这是最坏的一种假数据，它看起来像一个真实时间戳。
9. **原生 `alert/confirm` 全项目清零**：新增 `uiToast()` / `uiConfirm()` 两个原语（各只有一份实现）。理由：阻塞主线程、样式不可控、塞不下第三个选项、无头环境必须挂 dialog 处理器。确认框正文**一律 `textContent`**（文件名、词面都是第三方可控文本）。

### 26.4 验收

- 五套自检顺序跑：**580 / 272 / 199 / 248 / 136 = 1,435 条**（原来 1,414；新增 21 条，其中 12 条在服务端回归里真打了一个假上游的 200 / 401 / 404）；
- `check-doc-numbers.py`：**83 项全一致**，另打印 3 处跳过的历史数字；
- 浏览器端到端另行实跑 **31 条**（不算进五套）：sticky 在两栏生效、770px 关闭、搜索筛选、空筛选出路、Toast 出现、确认框 Esc 关闭且不误删、确认后真删、表头 sticky、列名、设置页红灯与绿灯各一次、全程零 JS 异常。

### 26.5 明确不做

- 没有推送 GitHub、没有重新发布线上演示版（用户明令暂停）；
- 没有为"测试连接"未经许可花一次真实生图额度验证密钥 —— 那要用户自己在真实网关上点一次出图。
