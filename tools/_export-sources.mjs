/**
 * 临时脚本：生成《给AI审阅-源码合集.md》
 * 把源码按批次拼成一个带围栏的 markdown，方便直接传给外部 AI 审阅。
 * 只读，不修改任何源文件。用完即删。
 */
import { readFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const BT = String.fromCharCode(96);
const FENCE = BT.repeat(4);   // 用 4 个反引号做围栏，避免与源码内的 3 反引号冲突

const BATCHES = [
  {
    name: "批次 A · 核心规则引擎",
    why: "本项目的主张全在这里：六条铁律如何被翻译成代码、机械自检怎么判、亚马逊首图法规层怎么和设计构图口径分离、Listing 28 条规则怎么定义（含 2026-07-27 标题新规的 75/125/200 三个口径）。上下文有限时优先看这批。",
    files: [
      ["assets/prompt-engine.js", "规则引擎：HEX 色板与颜色词表、FIGURE_SPEC 占比表、信息架构、否定清单、角度/景别、Style Lock、序列定义、模板拍平、Prompt 组装、整套规划、机械自检、**模板自动匹配（别名层 TEMPLATE_ALIASES + 品类亲和表 + 模板→图型映射 + 分层打分 scoreTemplate + 多级回落 + 并列候选）**"],
      ["assets/orchestrator.js", "编排层：中英文主体抽取（extractSubject）、六步流程（runLocalTurn）、**上下文组装（品类/转化驱动力/有无参考图喂给模板匹配）**、**显式模板通道**、简报生成、双路径切换（runTurn）"],
      ["assets/competitor-keywords.js", "竞品关键词内核（纯本地、零网络）：4 张词表（类目提示 20 / 品类实词 19 / 子类目提示 107 / 停用词 139）+ 1–3 gram 切词（丢长度<2 的词，故 ngram pos 会偏移，已按原实现锁快照）+ 权重模型（覆盖率×50% + 位置×30% + 精准度×20%，单词且覆盖率≥0.9 再 −1.2 防泛词，clamp 1–10）+ 只留出现 ≥2 次的词 + 类目打分/识别 + 一致性校验"],
      ["assets/copy-prompts.js", "文案提示词拼装（纯函数、零网络）：5 类提示词（拆解 / 标题+亮点 / 五点 / 后台词 / 本地化），三条守卫（未知类型 / 缺产品名 / 缺竞品或缺权重表一律 ok:false + 可读原因，绝不产出空提示词），**字符上限全部取自 listing.js 的 LIMITS / titleLimit()，一行都不手写**（自检有反向锁）"],
      ["assets/listing.js", "Listing：关键词挖掘（含多语种停用词 / 非 ASCII 不拆残词）、词边界匹配、28 条质检规则（P/C 分档，含 Item Highlights 与站外引流）、官方合规词表 + 站外引流模式表、lintListing（scope 扩展 + emptyOk）、规则式草稿（标题溢出搬进 Highlights）、后台字段导出 + Flat File CSV、关键词覆盖度分析（analyzeCoverage / hasTerm）、多竞品对比（normalizeCompetitors / compareCompetitors）"],
    ],
  },
  {
    name: "批次 B · 服务端、传输与本地持久化",
    why: "关注安全性与健壮性：SSRF 防护、自写 multipart 解析、SSE 协议、生图双模式适配、降级路径是否「响亮」、零依赖 ZIP 打包是否写对头字段。",
    files: [
      ["server.mjs", "零依赖本地服务，12 个接口（health/config/upload/blob/library/image/vision/llm/chat + competitor/categories·bestsellers·subs），只监听 127.0.0.1；含 SSRF 拦截、静态白名单、Host 校验、配置原子写、识图失败响亮降级；**竞品抓取路由的 ?href= 参数自己过白名单（否则就是一条任意 URL 抓取通道），上游出错返回 502 而不是 500**；**数据目录支持 LISTING_DATA 重定向（默认仍在项目内 data/）**"],
      ["assets/net-guard.js", "SSRF 判据（协议白名单 + DNS 解析后按 IP 判内网 + 内网/保留段 + Host 校验），服务端与自检共用同一份"],
      ["assets/bestsellers.js", "亚马逊 Best Sellers **实时抓取**（全项目唯一主动爬第三方站点的通道，只用 Node 内置 https/zlib/dns）：8 站主机硬白名单 + 地址形状白名单（/gp/bestsellers/ · /zgbs/）+ 过 assertPublicUrl + **重定向后复检白名单** + 10 分钟缓存；**带 Cookie i18n-prefs=USD 强制美元**（不带时按请求方 IP 返回本地化货币，实测踩过）"],
      ["assets/zip.js", "零依赖 ZIP 打包器（method=0 存储 + node:zlib 的 crc32），供图片库「打包下载」；含 inspectZip 结构自检"],
      ["assets/store.js", "本地产物持久化层（IndexedDB）：纯函数层（指纹/裁剪/排序/淘汰/摘要）+ 配额自愈 + Node 下优雅降级"],
      ["assets/amazon.js", "亚马逊数据采集：选择器表、站点差异与语种、详情页解析、搜索结果页整页批量解析、书签脚本（详情/搜索双模式）"],
      ["assets/api.js", "传输层：配置读写、探活降级（带 TTL 的缓存判据）、SSE 解析、上传与生图请求"],
      ["assets/md.js", "极简 Markdown 渲染（先整体转义再白名单放行标签，防空 XSS）"],
    ],
  },
  {
    name: "批次 C · 前端外壳",
    why: "关注架构：单文件 app.js（**1931 行 / 94.8KB**）是否该拆、7 种 SSE 事件的分发设计、状态管理、DOM 结构、「采集 → 对比 → 留档」的闭环是否顺手。",
    files: [
      ["index.html", "7 个视图的 DOM 骨架（创作台 / 模板库 / 图片库 / 文案与质检 / 数据采集 / 本地产物 / 设置与诊断）+ file:// 经典脚本兜底提示。**「文案与质检」视图内并列**三**张卡：⑤ 合规质检 · ⑥ Rufus 信息架构检查（准入层）· ⑦ 竞品榜单实时抓取 → 关键词权重 → 文案提示词——刻意不新增导航视图，保持 7 个**"],
      ["assets/app.js", "前端外壳：视图路由、dispatch 事件分发、消息渲染、各视图绑定、批量采集与多竞品对比闭环、图片库与产物面板；**含 ⑥ 卡渲染 `renderRufus`（三条「界面不许说假话」硬要求：跳过项必须带原因可见 / 结论文案只读 `summary.conclusion` 不另写一套 / 只有 P 级命中才染红，C 级命中与「通过（部分）」一律琥珀）与 `ICONS` 图标注册表（9 个真 SVG path，全项目唯一一套，无 emoji 图标）**；**含 ⑦ 卡全部逻辑：loadCompetitorCategories / fetchCompetitor / analyzeCompetitor / generateCompetitorPrompt / sendCompetitorToCorpus，失败一律如实报原文（「抓取失败：… 不会给你假数据」）**"],
      ["assets/select-ui.js", "原生 <select> 的自绘替身（渐进增强）：原生控件保留为取值仓库（pointer-events:none / opacity:0），自绘按钮 + 挂 body 的 fixed 弹层，getBoundingClientRect 定位 + 视口上下翻转/左右收边，选中后 dispatchEvent(new Event(\"change\",{bubbles:true}))；含 value 存取器截获（程序赋值也能刷新按钮）与 MutationObserver（选项被重建时同步）。为什么必须这么做见文件头 2026-10-30 实测记录"],
    ],
  },
  {
    name: "批次 D · 自检与工具链",
    why: "关注测试质量：415 + 151 + 108 条断言（共 674）是否有'自证'风险（只测自己实现的东西）、反向测试是否够、覆盖盲区在哪。注意 23 / 23b–23n 那批是**打生产入口**的对抗性断言，不是本地复刻实现。",
    files: [
      ["tools/selftest.mjs", "406 条断言 / **44 个测试节**（口径 = `section()` 调用数；编号主节 1–25，另有 10b–10e / 11b / 11c / 18b / 23b–23n 等分节）。除原有内容外，新增 **23 节 Rufus 信息架构检查**（23 数据层出处与结构 / 23b 不回归既有契约 / 23c 对抗性断言 / 23d 反向 fixture / 23e guards 词表纪律 / 23f R2 字段级窗口 / 23g Guard B / 23h R4 覆盖判据接真函数 / 23i termRanges≡hasTerm / 23j AC-13 行数预算 / 23k 规则层常量成员数漂移锁 / 23l R5 连字符归一 / 23m G4 否定窗口已知误报边界 / 23n 缺陷 K 结论文案双向锁）、**24 节图标注册表一致性**（防 emoji 图标 / 防静默空图标 / 防内联漂移）与 **25 节竞品关键词 → 文案提示词**（词表规模锁 + 切词/权重/类目打分的**行为快照 hash** + 出网白名单 22 个用例 + **单一实现反向锁** + **字符口径反向锁** + 第 ⑦ 卡接线 + 零第三方依赖）"],
      ["tools/verify-server.mjs", "151 条断言：真起 server.mjs 做端到端回归（SSRF / 目录穿越 / Host / 原子写 / 图片库与打包下载 / **竞品抓取接口的参数白名单**）。**用 LISTING_DATA 把数据目录重定向到临时目录，全程不碰用户真实 data/**"],
      ["tools/browser-selftest.mjs", "98 条断言：浏览器侧端到端自检，真起 Edge 无头 + CDP（零依赖，用 Node 内置 WebSocket），收未捕获异常 + 点遍所有视图 + 跑采集→对比闭环。**新增第 ⑥ 组会真去抓一次亚马逊榜单，允许失败但不许假装成功**（断言的是「状态文案 ↔ 表格内容」一致性），**同样把数据目录重定向到临时目录**"],
      ["assets/selftest-browser.html", "浏览器里跑的自检页：IndexedDB 真往返（Node 测不到的那一半）+ 解析/词频的浏览器内一致性"],
      ["tools/build-templates.mjs", "从参考仓 25 个模板 JSON 生成 assets/templates.js，含 11 个必填字段校验与回读校验"],
    ],
  },
  {
    name: "批次 E · Rufus / Alexa 信息架构检查（P0-1，本项目最新一块）",
    why: "**这一批最能看出「从'你有什么'到'岗位要什么'」的翻译能力**：5 组规则全部数据驱动、事实层与判据层分离、口径分「官方明文 / 官方 schema / 从业者」三档且未知档位必须抛异常、算不出来宁可标「跳过」也不给假数字。特别可看：`rufus.js` 的 `conclusion` 为何要分四支（缺陷 K：空表不许报「全部通过」）、`rufus-facts.js` 的提及管线四段顺序为何不能换（G4 否定撤销 → G5 逐字段归并 → guard 清字段 → G6 跨字段配对）、以及 SPEC §8 那 15 条**主动登记的已知边界**（含误报方向与漏报方向各自标注，并加了双向锁防后人「顺手修坏另一侧」）。",
    files: [
      ["assets/rufus-data.js", "纯数据层：8 类目属性表（字段 175 = required 36 / recommended 139，required 全部 amazon-guide 档）、8 类 × 10 题 = 80 条买家问题、6 个单位维度组、15 对材质冲突词表（guards 统一为「通用部件词 24 ∪ 通用混纺词 9 ∪ 该对特有话术」，逐对长度 37/33/33/33/35/33/33/33/33/33/33/34/33/33/33）"],
      ["assets/rufus-facts.js", "事实层（无规则、无文案）：字段文本抽取、单位归一与歧义判定（≤2 字符 token 除白名单外不参与）、材质冲突 `materialConflicts`（逐字段管线，顺序不可换）、图内文字未文本化 `uncoveredImageText`（两侧对称过 `norm()` 做连字符归一，缺陷 L）、R4 覆盖事实 `coveredKeys`/`keyClassHints`/`judgeCoverage`（带 attribute/text 来源标记）"],
      ["assets/rufus.js", "规则层与引擎：`tierOf` 是 source→sourceTier 的**唯一**映射点（未知值抛异常）、5 组规则 R1–R5（R4 按 productType 展开为 R4-01…R4-10）、`lintRufus` 返回与既有 `lintListing` 严格同构的 `{results, summary}`，`summary.conclusion` 是**唯一**结论文案来源（分四支，含「无可检查项：全部跳过」）"],
      ["docs/SPEC-P0-1-rufus.md", "**规格即契约（最高优先级，冲突时 Spec > ADR > 其他）**：15 条 EARS 验收标准 + **§8 十五条主动登记的诚实边界**（中文单位不支持 / 跨组不报 / 不做数值换算 / 同字段并列豁免 / guard 字段级二值导致的一批已知漏报 / G4 否定窗口导致的已知误报 / R5 不做词序归一 …），每条都带实测证据与「为什么这样取舍」"],
      ["docs/decisions/ADR-001-rufus-module.md", "架构决策记录（MADR）：110 条断言草案（R1=26 / R2=48 / R3=16 / R4=14 / R5=6），把每条 AC 都落成**可机械验证**的 fixture 与实测输出；含 G1–G6 六条消费形状与「同字段并列豁免」的口径演进"],
    ],
  },
  {
    name: "批次 F · 竞品实时抓取整合（2026-10-02）",
    why: "**这一批最能看出「先勘察再动手」的判断力**：勘察阶段先确认了「被整合工具的前端页与本地工作台重复、真正缺的只是文案提示词那一跳」，于是采「加卡不加视图」、只搬三个模块而不是搬一整个工具；移植前先给原算法拍**行为快照**（87KB）、移植后**逐字段比对 57 项**；三处相对原实现**有意加严**（主机硬白名单 / 过 assertPublicUrl / 服务端 href 参数自己校验）；并用实测抓出了一个真缺陷（不带 i18n cookie 时按请求方 IP 返回 CNY 价格）。特别可看：为什么安全回归**刻意不联网**、而浏览器那套**允许失败但只验收'诚实'**。",
    files: [
      ["docs/整合方案-竞品关键词进工作台.md", "**可执行方案全文**：0 一句话结论 / 1 三个实体身份 / 2 能力盘点（已有 vs 真增量 vs 易碎外壳）/ 3 形态决策 / 4 五阶段步骤（含「文件:行号」落点）/ 5 删除清单 A·B·C 三级 / 6 待拍板 / 7 明确不做 / 8 风险登记。可对照它检查代码是否真的按方案落地。\n\n> 这条链的**代码本身**列在别处、不在这里重复：`assets/bestsellers.js`（抓，批次 B）、`assets/competitor-keywords.js`（算，批次 A）、`assets/copy-prompts.js`（写，批次 A）。"],
    ],
  },
];

const SMALL = [
  ["package.json", "零依赖声明与 6 个 npm script"],
  [".env.example", "所有配置项的样例（密钥全部留空）"],
];

const out = [];
const w = (s = "") => out.push(s);
const kb = (n) => (n / 1024).toFixed(1) + " KB";
// 行数口径必须与 `wc -l` 一致：先削掉末尾换行再数，否则每个文件都会多报 1 行。
// （这本文件与《功能细节》§1.3 的行数表是同一次核对的两半，差 1 会被审阅者当成"两份文档对不上"。）
const lines = (p) => {
  const s = readFileSync(p, "utf8").replace(/\n$/, "");
  return s === "" ? 0 : s.split("\n").length;
};

/* 头部 */
w("# 跨境 Listing 质检工作台 · 源码合集（供 AI 审阅）");
w("");
w("配套文档：《给AI审阅-功能细节与技术实现.md》—— **建议先读那份**，它说明了每个功能的用途、流程与参数。");
w("");
w("## 怎么用这份合集");
w("");
w("| 你的情况 | 建议做法 |");
w("|---|---|");
w("| 支持上传文件 | 把这份 `.md` 整个传上去，配合同目录的功能说明文档一起 |");
w("| 只能粘贴文本 | 先粘「功能说明」，AI 需要看代码时，再按批次粘对应小节 |");
w("| 上下文有限 | 只粘**批次 A**（核心规则引擎）+ 功能说明文档 |");
w("");
w("## 批次总览");
w("");
w("| 批次 | 文件数 | 合计体量 | 建议审阅重点 |");
w("|---|---|---|---|");
let grand = 0;
for (const b of BATCHES) {
  let total = 0;
  for (const [f] of b.files) total += statSync(join(ROOT, f)).size;
  grand += total;
  w("| " + b.name + " | " + b.files.length + " | " + kb(total) + " | " + b.why + " |");
}
w("");
w("全部源码合计约 **" + kb(grand) + "**（口径 = 上表各批次文件体量之和；已排除生成物 `assets/templates.js` 78.6KB 与样式 `assets/app.css` 18.1KB）。");w("");
w("> `assets/templates.js` 是**生成的模板数据**（25 个模板），不是逻辑代码，结构已在功能说明文档 §9.1 列出。");
w("> 若需其内容，可单独索取或运行 `node tools/build-templates.mjs` 重新生成。");
w("");
w("---");
w("");

/* 各批次 */
for (const b of BATCHES) {
  w("## " + b.name);
  w("");
  w("> " + b.why);
  w("");
  w("**本批文件**");
  w("");
  w("| 文件 | 行数 | 体量 | 职责 |");
  w("|---|---|---|---|");
  for (const [f, desc] of b.files) {
    const p = join(ROOT, f);
    w("| `" + f + "` | " + lines(p) + " | " + kb(statSync(p).size) + " | " + desc + " |");
  }
  w("");
  for (const [f, desc] of b.files) {
    const p = join(ROOT, f);
    w("### " + f);
    w("");
    w("> " + desc);
    w("> 行数 " + lines(p) + "｜体量 " + kb(statSync(p).size));
    w("");
    w(FENCE + (f.endsWith(".html") ? "html" : "javascript"));
    w(readFileSync(p, "utf8").replace(/\s+$/, ""));
    w(FENCE);
    w("");
  }
  w("---");
  w("");
}

/* 小文件 */
w("## 附 · 配置文件");
w("");
for (const [f, desc] of SMALL) {
  const p = join(ROOT, f);
  w("### " + f);
  w("");
  w("> " + desc);
  w("");
  w(FENCE + (f.endsWith(".json") ? "json" : "ini"));
  w(readFileSync(p, "utf8").replace(/\s+$/, ""));
  w(FENCE);
  w("");
}

/* 尾部：给审阅者的提醒 */
w("---");
w("");
w("## 附 · 请勿重复建议的事项");
w("");
w("以下都是**已经明确决定不做**的（详见功能说明文档 §0.3）：");
w("");
w("- ❌ 服务端爬虫抓亚马逊（会被反爬，且数据未必等于用户所见）→ 已改用书签脚本 + 粘贴，**含搜索结果页整页批量采集**");
w("- ❌ 用户账号体系 / 云同步（本地优先，密钥不出本机）");
w("- ❌ 自动调价 / 自动投放（涉及资金操作）");
w("- ❌ 引入服务端数据库 / 框架 / 打包器（当前无必要，零依赖是刻意选择；**本地持久化用浏览器 IndexedDB**，不是服务端建库）");
w("- ❌ '建议加单元测试' —— 已有 289 + 113 + 67 = 469 条断言含反向测试与浏览器端到端，请改指**覆盖盲区**");
w("- ❌ '建议加英文支持' —— 自检第 14 / 16 节专测英文色词词边界、`photo for X` 语序、纯图类型句判空");
w("- ❌ '建议支持德语/日语站点' —— 已把 SITES 扩到 **21 个** Marketplace，并按站点套对应语种停用词表（自检第 11c 节）；⚠️ 日语**不做分词**并在界面明说（不引入词典依赖）");
w("- ❌ '应该做数据持久化 / 刷新就没了' —— 已实现 `assets/store.js`（IndexedDB，四类产物自动留档、可导出导入），并用浏览器自检覆盖真实读写");
w("- ❌ '应该做生成结果图片库' —— 已实现：缩略图墙 + 单个下载 + 删除 + **零依赖 ZIP 打包下载**（`assets/zip.js` 自写的存储模式打包器）");
w("- ❌ '应该做多竞品对比' —— 已实现 `compareCompetitors`：按「几个竞品用到这个词」区分**全类目共识词**与差异化/品牌词");
w("- ❌ '主图占幅应该再小一点/留白再多一点' —— 那 35-40% 是**设计稿**口径；亚马逊首图是 85-100% + ≤15% 空，法规层在自检第 15 节有 4 个反向测试锁住");
w("- ❌ '应该做竞品 ASIN 关键词继承 / 关键词覆盖率追踪' —— 已实现 `analyzeCoverage`（功能文档 §4.3.6）：逐词检查标题/五点/描述/后台词覆盖，并刻意把「**用户自己选的**词没覆盖＝待办」与「竞品语料挖出的词没覆盖＝线索（含 n-gram 噪声）」分开");
w("- ❌ '应该接 Helium 10 / Cerebro / Brand Analytics 的搜索量做关键词价值分' —— 刻意不接付费数据（功能文档 §15.4）：**宁可给一个覆盖矩阵，也不给一个编出来的价值分**");
w("- ❌ '应该加 Playwright / Puppeteer 抓亚马逊' —— 违背零依赖（+300MB）；服务端直抓会被 WAF 与 TLS 指纹拦。当前最优解是**书签脚本 + 本地留档**（功能文档 §15.2 有五种方案的逐项对比）");
w("- ❌ '标题上限写 200 已经过时，应该改成 75' —— **已改**（2026-09-29）：`LIMITS.title = 75`（含空格）、`titleMedia = 200`（唯一例外：media 类目）、`titleStrict = 70`（项目自留的保守口径）、`titleTotal = 200`（标题 + Highlights 合计），并提供 `titleLimit(ctx)` 按类目取；界面多了一个「类目口径」开关，21 个站点的展示口径也一并同步");
w("- ❌ '没有 Item Highlights（title_differentiation）字段' —— **已加**：数据模型、编辑框、计数 chip、8 条新规则中的 4 条（P13/P14/C10/C11）、草稿按字段职责分配（材质短语 + 溢出的规格进 Highlights，长卖点句**刻意留在五点**）、后台字段导出与 Flat File CSV 都已覆盖");
w("- ❌ '合规词表只有通用禁语，没有站外引流检测' —— **已加** `OFF_SITE_PATTERNS`（P 级，6 条：外链/二维码/暗示站外购买）与 `SOFT_CONTACT_PATTERNS`（C 级，4 条：疑似邮箱/社交号），并配 `C12` 疑似电话。测这条时**刻意避开** `350-500-1000` 这类规格数字，防误伤");
w("");
w("## 附 · 已修复的缺陷（避免重复提出）");
w("");
w("| 已修复 | 说明 |");
w("|---|---|");
w("| 模板匹配打分缺陷（第一版） | 原按'关键词长度求和'，导致「直播间场景图」被判给 lifestyle-scene；已改为快照排序（最长 > 最靠前 > trigger 优先）。**2026-09-29 第二版**：改造时又差点重蹈覆辙 —— 把词权重加进**主**排序键会再次判错，已固定为「词证据有无 > 词长 > 位置 > 词权重 > 总分 > order」，并加断言 |");
w("| 画幅写成像素 | Prompt 里曾写 `aspect ratio 1024x1024`，与 Skill 文档口径（比例）不符；已加 `toRatioText()` |");
w("| 画幅按 figure 定 | 导致痛点驱动的主图 H5（figure=feedAd）拿到 4:3；已改为按组定（主图一律 1:1） |");
w("| 详情页结构判据错误 | 原看'模板名里有没有 infographic'，使 D2/D7/D9 全部误报；已改按 `group==='pdp'` 判 |");
w("| 保证性用语漏报 | `CLAIM_WORDS` 缺裸词 `guarantee`（只有 `guaranteed results`）；已补，并改用词边界匹配 |");
w("| 颜色词表覆盖不足 | 原只有 beige/sage/navy 等设计色名，漏掉灰/黑/红/蓝/绿等通用色词；已补到 **42 色值**并加防误伤规则 |");
w("| 同一逻辑写两遍 | `server.mjs` 曾自有一份主体抽取，导致'离线修好、服务端仍旧行为'；已改为复用 `runLocalTurn` 并加源码级断言 |");
w("| **英文色词子串误伤** | `/red/i` 命中 hun**dred**（`hundred`→`hun#C0392B`）、`/blue/i` 命中 blueprint、`/wood/i` 命中 wooden、`/cream/i` 命中 s**cream**ing、`/rose/i` 命中 rosemary；英文表已全加 `\\b`（代价是 wooden/golden 这类材质形容词不再转换 —— 这是对的） |");
w("| **英文主体抽取缺失** | `IMG_TOKEN` / `STYLE_CLAUSE` / `NOISE_*` 全是中文模式，英文指令整句被当产品名；已补英文词表，并修掉审阅没提到的**语序陷阱**（英文是「图类型 + of/for + 产品」） |");
w("| **`hero image` 判空回归** | 尾部 `image` 被 `NOISE_VERB_TAIL_EN` 当收尾语吃掉，残下 `hero` 冒充主体；已在 `cleanCandidate` 加「整句只有图类型词」前置判定 |");
w("| **`do` 啃掉 `dog`** | 英文前导词组后缺 `\\b`，「dog harness」→「g harness」、「theory craft」→「ory craft」；已补词边界 |");
w("| **纯风格句识别失效** | 风格形容词先被尾部规则剥掉，`go premium` 只剩 `go` 就认不出来了；改为用**剥噪声前的原文**判定 |");
w("| **亚马逊首图法规层缺席** | `hero` 图型写「35-40% 占幅 + 45% 留白」，与首图硬要求「85-100% + 纯白底 + 零叠加」**算术矛盾（相加 130%）**；且原 `composePrompt` 会给首图加 `headline at 28-48pt`。已建独立的 `AMAZON_MAIN_IMAGE` 法规层 + 图位/构图两层建模 |");
w("| **静态服务目录穿越** | `serveStatic` 只挡 `..`，`GET /.env.local` 能直接拿走明文 API Key；已改为白名单（仅 `index.html` + `assets/`） |");
w("| **Host 头不校验** | 仅监听 127.0.0.1 仍可被 DNS rebinding 读；已加 Host 白名单。⚠️ 测这条不能用 `fetch`（undici 静默丢弃 Host 头，是测试假象） |");
w("| **SSRF** | 生图响应里的 `url` 由上游给出，服务端会去下载它 → 可打 `169.254.169.254` 云元数据 / 本机服务；已加协议白名单 + DNS 解析后按 IP 判内网 + 禁自动重定向 |");
w("| **`/api/config` 非原子写** | 直接覆盖 `.env.local`，写到一半崩溃会留下半截配置；已改 tmp + rename，并加 baseUrl 格式校验 |");
w("| **五点引导词规则档位错** | 「大写引导词:」是行业惯例而非平台规则，放在硬规则会让格式问题被报成「发布前必须修改」；已 P → C |");
w("| **关键词挖掘口径未声明** | 词频容易被当成搜索量；已加 `disclaimer.isSearchVolume=false` 并在界面显示 |");
w("| **file:// 下整个应用不启动** | 曾宣称「直接双击 index.html 也能用」—— 实测（Edge 153 headless --dump-dom）file:// 的 DOM 只有 23.9KB 纯骨架（ES 模块被 CORS 拦掉，JS 一行没跑），http:// 是 322KB 真渲染。已加**经典脚本**兜底提示 + 改掉全部误导文案 |");
w("| **识图失败静默降级** | `server.mjs` 不看 `resp.ok`，401/429 时 `json()` 仍成功、`raw` 取到空串 → **静默**退回纯文本生图，用户以为图是按自己产品生成的。已改为响亮降级（工具气泡标 warn 档 + 图片卡片标「未参考原图」） |");
w("| **探活缓存永不失效** | 缓存没有 TTL：服务起起来后页面还显示「未连接」，只能手动重探。已加**双档 TTL**（成功 60s / 失败 5s，因为失败时用户往往正在启动服务），并把判据抽成纯函数 `probeCacheFresh` 以便断言 |");
w("| **多语种站点会把虚词当关键词** | amazon.de 标题里满篇 `mit / für / und`，原来只有英文停用词表 → 这些会被当成卖点关键词推给用户；同时 `[^a-z0-9]` 清洗会把 `für` 拆成 `fr`。已加按语种的停用词表 + `\\p{L}\\p{N}` 清洗（并手工排除 car/son/main/van/door 这类与英文同形的词，避免删掉真实关键词） |");
w("| **byteLength 漏 4 字节档** | emoji 与 CJK 扩展 B 区是 4 字节，原实现按 3 算 → Search Terms 字节数被低估，会超限。已修 |");
w("| **搜索页载荷被当详情页渲染** | `extractAny` 只认 title/bullets，搜索结果页载荷会让界面渲染出一张空表，用户以为「解析失败」。已改为按 `kind` 显式分流 |");
w("| **ZIP64 越界会静默产出坏包** | 手写 ZIP 打包器原先把 `offset` 用 4 字节字段写、`count` 用 2 字节写，越界时 `offset` 先变成一个超范围数、到写 central 才抛一个语焉不详的 RangeError（甚至先静默回绕）。已加 `assertZipWithinLimits(count, bytes)`：越界的**第一刻**就抛带「ZIP64」字样的 `RangeError`，并有 2 条断言锁住（含「造 65536 个条目必须抛」这条真跑的） |");
w("| **简报指向界面上不存在的按钮** | 出图分支的文案写「点下方的 **生成图片** 按钮即可调用你配置的图片 API」，但界面上**根本没有这个按钮**（聊天区只有 📎/＋/整套/发送/停止），也不是靠点按钮触发（真实路径是：消息里带「出图」词 → 发送 → 服务端自动调）。整套模式那句「点『导出图片包』可一次拿走全部 Prompt」**同样是假的**。已全改成实话，并加断言把这三处一起锁住 |");
w("| **服装类需求全落白底主图** | 25 个模板词表里 `T恤` / `衣服` / `tee` / `shirt` / `apparel` / `garment` / `clothing` **全部 0 命中**（上游数据我们只消费不改写），导致「给这件 T 恤做图」一律被丢给 `hero-image`。已加**读法层** `TEMPLATE_ALIASES`（服装/模特/试穿/社交媒体类别名），上游文件一个字节未动 |");
w("| **品类识别与模板匹配各算各的** | `detectCategory` 明明已经算出 `fashion`，但**没有任何一行代码把它喂给 `matchTemplate`** —— 同一个系统里两个模块互不通气，上下文形同没有。已把品类/驱动力/有无参考图接成上下文，并把品类计算**提到匹配之前**（源码级断言锁住这个顺序） |");
w("| **无匹配时永远回落白底主图** | 只要没命中关键词就回落 `01-hero-image`，不看品类、不看意图。已改为**多级回落**：先按品类（fashion→隐形模特 / 电子→设备模型 / 宠物→场景图…），全无线索才落 `01-hero-image`，且「依据」里如实写「这是兜底」而不假装匹配上了 |");
w("| **25 个模板只认 2 个的图型** | 编排层的 `figure` 是一串硬编码嵌套三元，只认 `hero-image` / `lifestyle-scene`，其余 23 个模板全被压成 `benefit`（卖点副图 25-30%）—— 选了模板却不认模板的构图口径，等于选型白做。已建 `TEMPLATE_FIGURE`，25 个模板全有归属 |");
w("| **把兜底当成了匹配依据** | `diagnoseConversionDriver` 什么都没识别到时返回 `confidence:0` + 默认 `visual`；直接传进上下文会让**乱码输入**也报出「按『visual』驱动常用图型选取」。已改为只在 `confidence > 0` 时才算依据，源码级 + 行为级两条断言锁住 |");
w("| **模板库手选根本没接通** | `S.selectedTemplate` 只影响「详情面板显示哪一个」，**从不参与生成** —— 用户在模板库里点半天，生成结果一点没变。已把显式通道从 `api.js` → `server.mjs` → `runLocalTurn` 全链路接通，且**只作用于下一条消息**（粘性状态会让用户点过一次就开始静默违背自动匹配） |");
w("| **界面显示「可出图」但实际出不了** | 右上角模式标签只判「服务端是否在线」就写 `服务端编排 · 可出图`，**没判有没有配图片 key**。于是没配 key 的用户看到「可出图」→ 点了没反应 → 不知道问题在哪。同一个事实在文件里本来有**三处**写法，其中两处是对的、只有这一处漏了。已抽成唯一的 `canGenerateImage()` 并三处共用（+2 条断言） |");
w("| **标题阈值停在旧规（200 / 150）** | 亚马逊 **2026-07-27** 已生效新规：普通类目 `item_name` ≤ **75** 字符（含空格），唯一例外是 media 类目（100→200 沿用旧值）；本项目 `LIMITS.title = 200`、`titleStrict = 150` 且**全站 21 个站点表**也都写着 `200/150`。已按官方 SP-API 文档改为 **75 / 70 / 125 / 200** 四个口径并统一，加断言把站点表与 `LIMITS` 钉在一起（`assert.equal(SITES[h].titleLimit, LIMITS.title)`） |");
w("| **把「超限」说成「拒收」** | 外部意见认为标题超 75 会被拒收或截断。官方原文是**仍可提交、且会被接受**（`these submissions are accepted`），代价是 Amazon 会 **reconcile**（自动拆分改写）→ 后果是**丢掉标题控制权 + 同时失去 Item Highlights 提交资格**（`You can only submit title_differentiation when item_name is 75 characters or fewer`），品牌方有 **14 天**在 Review Listings Changes 复核。`P1.why` 已按原文写准，并加断言锁住「不是拒收」「14 天」「title_differentiation」三个要点都在 |");
w("| **`title_differentiation` 完全没被建模** | 数据模型里没有这个字段 → 无法编辑、无法计数、无法导出、规则也判不了。已补：`S.listing.highlights`、编辑框、计数 chip、`AMAZON_FIELDS` 新增一项（紧跟 `item_name`，limit 125，required false）、`P13`（>125）/`P14`（禁用语与符号）/`C10`（为空）/`C11`（两段重复度 >80%）四类规则 |");
w("| **`emptyOk` 规则在空表上乱叫** | 新增的 `C10`（Highlights 为空）需要「字段为空时仍判定」，但判据写成 `!isBlank([title, ...bullets])` —— `isBlank` 对数组判的是 `length === 0`，`[\"\", \"\"]` 长度是 2 → 空表也被认为「有内容」，于是一张全空的表上冒出「Highlights 为空」的噪音。已改为逐项 `String(s).trim()` 判定，并加「空表必须一条都不报」的反向断言 |");
w("| **草稿把 Highlights 塞成第二份五点** | 第一版按「剩余字符数」往下塞，把**长卖点句**搬进 Highlights，挤掉了真正的关键规格（`500ml` / `Pack of 2`）。官方要求 Highlights 是 **comma-separated phrases, not full sentences** 且「Each one should add something different」。已改为**按字段职责分配**：材质/规格短语进 Highlights，长卖点句留在五点；实测输出 `Food-grade 304 stainless steel, BPA free, Leak-proof silicone lid with carry loop, 500ml, Pack of 2` |");
w("");

process.stdout.write(out.join("\n") + "\n");
