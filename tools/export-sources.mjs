/**
 * 生成《源码合集（按文件结构）》—— 面向「打包分享 / 交给别人读」的场景。
 *
 * 与 `_export-sources.mjs` 的区别（那个是给 AI 审阅用的，按"批次 + 审阅重点"组织）：
 *   本脚本按**真实目录结构**组织，先给目录树和文件清单（含职责 / 行数 / 体积 / 指纹），
 *   再按同样的顺序贴全文。读者手里拿到一个 zip 时，能按目录一条条对上去。
 *
 * 纪律：
 *   · 只读，不修改任何源文件；
 *   · 收录清单是**显式白名单**：新增文件默认不进合集，必须在这里登记；
 *   · 行数口径与 `wc -l` 一致（末尾无换行时最后一行也算），避免与文档里的表差 1；
 *   · 围栏长度按内容自适应（源码里有 ``` 时不会提前截断）。
 *
 * 用法：
 *   node tools/export-sources.mjs                      # 输出到 stdout
 *   node tools/export-sources.mjs > 源码合集.md
 *   node tools/export-sources.mjs --out ../源码合集.md  # 直接写文件
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SELF = "tools/export-sources.mjs";

/* 断言条数一律从 `tools/expected-counts.json` 读，不在这里硬编码 ——
   写死过一次，结果每次加断言都要记得改这里，忘了就是对外说错数字。 */
const COUNTS = JSON.parse(readFileSync(join(HERE, "expected-counts.json"), "utf8"));
const CN = {
  selftest: COUNTS.selftest,
  server: COUNTS["verify-server"],
  browser: COUNTS["browser-selftest"],
  mcp: COUNTS["mcp-selftest"],
  keywords: COUNTS["keywords-selftest"],
};
const THREE = CN.selftest + CN.server + CN.browser;

/* ── 收录清单：按目录分组，组内顺序即输出顺序 ──────────────────────── */
const GROUPS = [
  {
    dir: "根目录",
    note: "启动入口、页面骨架与零依赖声明。除了 `.env.example`，根目录不放业务逻辑。",
    files: [
      ["package.json", "零依赖声明与 npm 脚本；`type: module` 与 `engines.node>=20.15` 是整站能跑起来的前提", "—"],
      ["index.html", "8 个视图的 DOM 骨架，不含业务逻辑（逻辑全在 `assets/app.js`）", "—"],
      ["server.mjs", "零依赖 HTTP 服务：25 个接口、静态白名单、Host / 同源校验、SSRF 拦截、配置原子写、SSE 转发", "由 `node server.mjs` 直接启动"],
      ["server-public.mjs", "线上部署入口：只覆盖 HOST / PUBLIC_HOSTS / LISTING_NO_KEY_WRITE 三个环境变量，其余全部复用 `server.mjs`", "由 `node server-public.mjs` 启动"],
      [".env.example", "全部配置项的样例，密钥一律留空", "复制为 `.env.local` 后填写"],
      [".github/workflows/keywords.yml", "每周定时采集词库（周一 02:17 UTC + 手动触发）：跑采集器 → 跑词库自检 → 提交快照。失败不覆盖旧数据，job 会红", "由 GitHub Actions 触发"],
    ],
  },
  {
    dir: "assets/",
    note: "前端与规则引擎。除 `app.js` 外都是**纯模块**，可在 Node 里单独 `import` 做测试（`app.js` 需要 `document`）。",
    files: [
      ["assets/app.js", "前端外壳：视图路由、SSE 事件分发、消息渲染、各视图绑定、图片库与产物面板、Rufus / 竞品两张卡的渲染", "`ICONS` / `iconSvg`"],
      ["assets/api.js", "传输层：配置读写、探活（成功 60s / 失败 5s 双档 TTL）、SSE 解析、上传 / 生图 / 识图 / LLM 请求", "`probeServer` `streamSSE` `generateImage` `callVision` 等"],
      ["assets/orchestrator.js", "编排层：意图判定（含否定）、画幅解析、主体抽取、`runLocalTurn` 七步流程；浏览器与服务端共用同一份", "`runLocalTurn` `runTurn` `isNegative` `parseRatio` `extractSubject`"],
      ["assets/prompt-engine.js", "规则引擎：色板 / 占比 / 信息架构 / 否定清单 / 角度景别 / Style Lock / 模板匹配 / Prompt 组装 / 机械自检 / 画幅映射表", "`composePrompt` `planImagePack` `auditPlan` `matchTemplate` `RATIO_PIXELS`"],
      ["assets/listing.js", "Listing 规则与字段：28 条质检规则（每条带可执行的 `fix`）、关键词挖掘、草稿生成、后台字段导出、Flat File CSV、覆盖度分析（支持 `targets` 分组）、多竞品对比", "`lintListing` `generateListingDraft` `exportListingFields` `analyzeCoverage`"],
      ["assets/score.js", "健康分（项目自定义加权）：8 维权重单源、硬规则命中封顶 55、扣分项带 ruleId/source/fix、缺数据的维度不参与计分（按已计权重归一）", "`scoreListing` `SCORE_DIMS` `gradeOf`"],
      ["assets/reviews.js", "评论（VOC）本地分析：14 个方面的词表聚类（同一词表两种情感）、高频疑问、词频线索；样本 <5 只出线索", "`analyzeReviews` `reviewsFromPayload` `REVIEW_ASPECTS`"],
      ["assets/image-audit.js", "成图体检（纯像素，Canvas 原生）：背景是否接近纯白、商品占比 ≥85%、最长边分档、透明通道、文字线索；不做 OCR、不判 Logo", "`auditPixels` `auditFileMeta` `auditImageBlob`"],
      ["assets/snapshots.js", "历史快照与迷你趋势图：不插值、不预测、两点才画，断点处不连线", "`sparklinePath` `seriesDigest` `seriesOf`"],
      ["assets/aplus.js", "A+ 模块骨架：品牌故事 / 对比表 / 模块网格的结构与写作预算、配图提示词；自检复用 listing.js 的词表（不另造第二份）", "`buildAplusPlan` `aplusToText` `lintAplusText` `APLUS_MODULES`"],
      ["assets/batch-lint.js", "批量质检：多段粘贴 → 按「先改哪条」排序（硬规则优先于分数）；口径写清是部分维度分", "`parseBatch` `batchLint` `batchCsv`"],
      ["assets/csv-import.js", "第三方关键词 CSV 导入：表头别名识别（Helium 10 / JS / 卖家精灵）、搜索量解析、千分位存疑标记；不猜列、不估算", "`importKeywordCsv` `detectColumns` `parseVolume` `withVolumes`"],
      ["assets/csv.js", "RFC 4180 CSV 编解码（浏览器 / Node 共用纯函数）：UTF-8 BOM、逗号 / 引号 / 换行转义、往返相等。`/api/export` 与前端导出按钮共用这一份", "`toCsv` `parseCsv`"],
      ["assets/rufus.js", "Rufus / Alexa 信息架构检查引擎：5 组规则，结论只由 `summary.conclusion` 一处产出", "`lintRufus` `tierOf` `RUFUS_RULES`"],
      ["assets/rufus-facts.js", "事实层（无规则、无文案）：字段抽取、单位归一、材质冲突、图内文字未文本化、覆盖事实", "`materialConflicts` `judgeCoverage` `uncoveredImageText`"],
      ["assets/rufus-data.js", "纯数据层：8 个类目的属性表、买家高频问题、单位组、材质冲突词表", "`CATEGORY_ATTRIBUTES` `CATEGORY_QUESTIONS` `MATERIAL_CONFLICTS`"],
      ["assets/amazon-suggest.js", "亚马逊搜索建议接口的**唯一实现**（mid/lop 表 + URL 拼装 + 解析 + 不静默降级的返回契约）。MCP 与每周采集器共用这一份", "`suggest` `suggestUrl` `parseSuggestions` `normalizeSite`"],
      ["assets/keyword-seeds.js", "词根种子表（纯数据）：14 组 194 条人工挑过的英文词根。**词根是人的判断，长尾是机器的活**", "`ROOTS` `ROOT_GROUPS` `ROOT_TO_GROUP`"],
      ["assets/keyword-roots.js", "G-4 词根覆盖层（纯函数）：基线 194 条 + 运营在 `data/keywords/roots.json` 里的 added / removed / renamed。非法项单独进 `rejected` 并给理由，读坏了退回基线并说明，绝不中断采集", "`resolveRoots` `OVERLAY_SCHEMA`"],
      ["assets/keyword-vault.js", "快照合并的**唯一口径**：firstSeen 继承、新增/消失、ASIN 去重保最小名次、上限截断、陈旧判定；历史紧凑投影与两期对比（词 / ASIN 榜单变动）。纯函数", "`buildSnapshot` `staleness` `digestOf` `compareSnapshots` `diffAsins` `lookup` `isEmpty`"],
      ["assets/keywords-store.js", "词库快照的**只读**落盘层（Node 专用）：没有写函数 —— MCP 与服务拿不到写入口，靠的是一个不存在的函数，不是自觉。另管站点文件路径与同日重跑不覆盖的历史序号", "`readLatest` `latestPath` `nextHistoryPath` `keywordsDir`"],
      ["assets/mcp-http.js", "**Streamable HTTP 版 MCP 客户端**（我们当客户端去连第三方数据源）：一个 POST 一条 JSON-RPC、SSE 与 JSON 两种响应都认、回带 `Mcp-Session-Id`、通知不等回包。**只做传输**，不认厂商、不做白名单", "`HttpMcp` `HttpMcpError`"],
      ["assets/term-normalize.js", "外部词表归一（纯函数）：把各家的 `keyword/searchTerm/…` + `searches/volume/…` 猜成 `{term, volume, rank}`，猜不出就返回 0 条并说明原因 —— **不编数据**", "`normalizeTerms` `TERM_FIELDS`"],
      ["assets/competitor-keywords.js", "竞品关键词内核（零网络）：词表 + 1–3 gram 切词 + 权重模型 + 类目识别", "`analyzeKeywords` `detectCatSlug` `buildNgrams`"],
      ["assets/copy-prompts.js", "5 类文案提示词拼装；字符上限全部取自 `listing.js`，一行不手写", "`buildCopyPrompt` `PROMPT_KINDS`"],
      ["assets/bestsellers.js", "亚马逊 Best Sellers 实时抓取：主机与地址形状双白名单、重定向复检、10 分钟缓存、强制美元", "`fetchBestsellers` `fetchSubs` `isAllowedAmazonUrl`"],
      ["assets/amazon.js", "亚马逊页面解析与书签脚本（详情页 / 搜索结果页双模式）", "`extractAny` `bookmarkletHref` `SITES`"],
      ["assets/net-guard.js", "SSRF 判据（协议白名单 + DNS 解析后按 IP 判内网），服务端与自检共用同一份", "`assertPublicUrl` `allowedHosts`"],
      ["assets/zip.js", "零依赖 ZIP 打包器（存储模式 + `zlib.crc32`），含 ZIP64 越界前置断言", "`buildZip` `inspectZip` `assertZipWithinLimits`"],
      ["assets/store.js", "浏览器端产物留档（IndexedDB）：指纹、裁剪、排序、淘汰、配额自愈，Node 下优雅降级", "`save` `list` `toExport` `importFrom`"],
      ["assets/md.js", "极简 Markdown 渲染：先整体转义再白名单放行标签，防 XSS", "`renderMarkdown` `escapeHtml`"],
      ["assets/select-ui.js", "原生 `<select>` 的自绘替身（渐进增强），原生控件保留为取值仓库", "`enhanceSelects`"],
      ["assets/templates.js", "**生成物**：25 个模板的结构化数据 + 关键词索引（305 个词条）。不手改，改参考数据后重跑 `build-templates`", "`TEMPLATES` `TEMPLATE_LIST` `KEYWORD_INDEX`"],
      ["assets/app.css", "全站样式：颜色变量、布局、卡片、聊天流、图片墙与响应式", "—"],
      ["assets/selftest-browser.html", "浏览器内自检页：IndexedDB 真往返等 Node 测不到的部分", "—"],
    ],
  },
  {
    dir: "tools/",
    note: "自检与构建脚本。自检脚本**只读**业务代码，且一律把数据目录重定向到临时目录，不碰真实数据。",
    files: [
      ["tools/selftest.mjs", `${CN.selftest} 条断言：纯函数行为 + 源码级静态断言（28 条规则逐条的 fix、hits[].why/fix、覆盖度扩展向后兼容、CSV 往返、零 process.cwd()），不联网、不写盘`, "由 `node tools/selftest.mjs` 运行"],
      ["tools/verify-server.mjs", `${CN.server} 条断言：真起服务打接口（SSRF / 目录穿越 / Host / 同源 / 配置原子写 / 打包下载 / 外部数据源门禁 / 无账号时的示例数据 / 词根覆盖层 / CSV 导出 / 历史对比）`, "由 `node tools/verify-server.mjs` 运行"],
      ["tools/browser-selftest.mjs", `${CN.browser} 条断言：CDP 驱动无头浏览器，点遍 8 个视图并跑采集→对比闭环、外部数据源的示例入口、词库页默认收起的 6 个折叠区与双覆盖率渲染`, "由 `node tools/browser-selftest.mjs` 运行"],
      ["tools/collect-keywords.mjs", "每周词库采集器：词根覆盖层 → 搜索建议（194 条基线）→ 类目榜单 → ASIN；合并上一份保 firstSeen，同日重跑写 `-2` 不覆盖，落一份 <40KB 的历史投影。一句话都不通时**拒绝写盘**（exit 2）；非 US 站点未实测则默认拒绝（exit 4，须显式 `--allow-unverified`）", "由 `node tools/collect-keywords.mjs` 运行，`--dry-run` 用 fixture 跑完整管线"],
      ["tools/keywords-selftest.mjs", `${CN.keywords} 条断言：种子表口径、ASIN 字段对齐、合并唯一性、陈旧四态边界、采集器实跑（dry-run 到临时目录）、失败不覆盖、状态文件与文件锁、词面契约、词根覆盖层冲突语义、站点文件路径、历史投影体积、两期词 / ASIN 对比`, "由 `node tools/keywords-selftest.mjs` 运行"],
      ["tools/fixtures/keywords/dry-run.json", "**自检专用假数据**（不是真实抓取结果）：6 个词根 × 若干建议词 + 3 个类目的 ASIN。只为验证管线", "被 --dry-run 与 keywords-selftest 读取"],
      ["tools/fixtures/external/sellersprite-demo.json", "**示例数据**（`demo: true`，12 个词）：给没有卖家精灵账号的人先看清「导入之后长什么样」。只读仓库里的这一份，不写 `data/external/`", "被 `/api/external/terms?demo=1` 读取（设置页「没有账号？看示例对比」）"],
      ["tools/mcp-selftest.mjs", `${CN.mcp} 条断言：真起 MCP 进程、真灌 JSON-RPC，验 stdout 纯度 / 工具契约 / 「未判定 ≠ 通过」口径 / 客户端配置可用性；另用本地 mock 服务验 Streamable HTTP 客户端（SSE/JSON 双格式、会话 id、超时、401）与外部词表归一；结尾硬断言 \`data/\` 一字节未变`, "由 `node tools/mcp-selftest.mjs` 运行"],
      ["tools/assert-count.mjs", "断言数守卫：实际少于期望就算失败（删断言/循环集合变小都会红），多于期望只提示去更新期望值", "被三套自检 import"],
      ["tools/expected-counts.json", "断言数期望值（唯一事实源）。只许上调，下调必须有理由", "被 tools/assert-count.mjs 读取"],
      ["tools/build-templates.mjs", "从参考仓的模板 JSON 生成 `assets/templates.js`，含必填字段校验与回读校验", "由 `node tools/build-templates.mjs` 运行"],
      ["tools/check-doc-numbers.py", "核对文档里的行数 / 断言数 / 文件数是否与磁盘一致（文档会安静地说出过期数字，所以需要机器核对）", "由 `python tools/check-doc-numbers.py` 运行"],
      ["tools/mcp-setup.mjs", "一键生成 6 份客户端配置到 `data/mcp-setup/`（claude-code / claude-desktop / cursor / vscode / codex / workbuddy）；**绝不覆盖**客户端已有配置", "由 `node tools/mcp-setup.mjs` 运行，`--list` 只看不写"],
      ["tools/schedule-weekly.ps1", "Windows 计划任务注册（周日晚 22:00）：node 绝对路径 + IgnoreNew 并发策略 + 日志落 `data/keywords/logs/`；`-DryRun` 只打印不注册", "由 `powershell -File tools/schedule-weekly.ps1 -DryRun` 查看"],
      [SELF, "生成本合集（只读）：按目录结构输出树、清单与全文", "由 `node tools/export-sources.mjs` 运行"],
      ["tools/export-guide-html.mjs", "把《功能详细介绍》的 Markdown 渲染成单文件 HTML（复用 `assets/md.js`，不另写解析器）", "由 `node tools/export-guide-html.mjs` 运行"],
    ],
  },
  {
    dir: "mcp/",
    note: "把判断层暴露成标准 MCP server：零依赖、零密钥、只读。别人拉下仓库改一行路径就能接进 Claude Desktop / Cursor / VS Code / Codex / WorkBuddy。",
    files: [
      ["mcp/server.mjs", "stdio JSON-RPC 实现：8 个工具（质检 / 预校验 / 覆盖度 / 词频 / Prompt / 快照对比 / 搜索建议 / 本周词库），工具定义与 run() 同处一处；`annotations` / `outputSchema` / `structuredContent` 全工具覆盖，参数校验走表驱动 `VALIDATORS`，`analyze_coverage.useVault` 是显式 opt-in。日志一律走 stderr，stdout 只放协议消息", "由 `node mcp/server.mjs` 启动，`--no-net` 关掉唯一联网工具"],
      ["mcp/handler.mjs", "P0-B2 回环 HTTP 的**纯请求处理层**：Host / Origin / Bearer / `?token=` 降级四道门、method 与 path 路由。不监听端口、不写文件、不碰真实 req/res 对象", "`createRequestHandler`"],
      ["mcp/http.mjs", "P0-B2 回环 HTTP 进程入口：只绑 `127.0.0.1:8790`，复用 `mcp/server.mjs` 的同一个 `handle()`（动态 import 前先设 `MCP_HTTP_NO_STDIO=1`）。让客户端填一个 URL 就能接上", "由 `node mcp/http.mjs` 或 `npm run mcp:http` 启动"],
      ["mcp/README.md", "接入说明：stdio 与回环 HTTP 两种接法、是什么 / 不是什么、八个工具的参数与返回、一次可粘贴的完整调用、传输与协议、排错表、边界清单与明确不做清单、第三方数据为什么必须各自 Token", "—"],
      ["mcp/clients/claude-desktop.json", "Claude Desktop 配置样例（`%APPDATA%\\Claude\\claude_desktop_config.json`）", "路径为 `<PROJECT_DIR>` 占位符"],
      ["mcp/clients/claude-code.json", "Claude Code 配置样例（项目根 `.mcp.json`）", "同上"],
      ["mcp/clients/cursor.json", "Cursor 配置样例（`.cursor/mcp.json`）", "同上"],
      ["mcp/clients/vscode.json", "VS Code + Copilot 配置样例（`.vscode/mcp.json`，键名是 `servers` 且要 `type: stdio`）", "同上"],
      ["mcp/clients/workbuddy.json", "WorkBuddy 配置样例（`~/.workbuddy/mcp.json`，已有内容需合并而非覆盖）", "同上"],
      ["mcp/clients/codex.toml", "Codex CLI 配置样例（追加到 `~/.codex/config.toml`，段落名 `[mcp_servers.listing-studio]`）", "同上"],
    ],
  },
  {
    dir: "data/keywords/",
    note: "**运营可改的数据，不是源码**。随分享包发一份初始覆盖层，收件人打开就知道格式；不贴 867 KB 的 `latest.json` 全文（理由见文末未收录清单）。",
    files: [
      ["data/keywords/roots.json", "G-4 词根覆盖层初始文件：`schema:1` + 三个空数组，等价 194 条基线、零改动。`added` 填 `{root, group}`、`removed` 填词根字符串、`renamed` 填 `{from, to}`；`POST /api/keyword-roots` 原子覆盖它", "界面「词根管理」或采集器读取；文件损坏会退回基线并说明原因"],
    ],
  },
  {
    dir: "examples/",
    note: "给调用方看的可执行示例。**不是**第二份实现 —— 它 import 的全是 `mcp/server.mjs`，只负责演示协议怎么走。",
    files: [
      ["examples/mcp-demo.mjs", "最小 MCP 客户端：起进程 → initialize → notifications/initialized → tools/list → 逐个 tools/call → 校验 → 收尾。零依赖手写 stdio，含按行缓冲、id 配对、通知不回包、超时、错误路径（不存在的工具 / 缺必填参数）", "由 `node examples/mcp-demo.mjs` 运行，`--no-net` 跳过联网工具，`--json` 逐帧打印协议"],
    ],
  },
  {
    dir: "docs/",
    note: "规格与决策记录。**冲突时优先级：Spec > ADR > 其他文档**。",
    files: [
      ["docs/SPEC-P0-1-rufus.md", "Rufus 检查模块的规格即契约：15 条 EARS 验收标准 + 15 条主动登记的已知边界", "—"],
      ["docs/decisions/ADR-001-rufus-module.md", "架构决策记录（MADR）：把每条验收标准落成可机械验证的 fixture", "—"],
      ["docs/整合方案-竞品关键词进工作台.md", "竞品关键词整合的可执行方案：能力盘点、形态决策、五阶段步骤、删除清单、风险登记", "—"],
      ["docs/测试盲区清单.md", "**全绿不等于对**：按「坏了会怎样」排序的盲区清单（外部站点改版、真实 API 漂移、IndexedDB 边界、规则本身、视觉/可达性、浏览器矩阵），含明确「不做」的清单与加断言的口径", "—"],
    ],
  },
];

/* ── 未收录清单（写清理由，避免读者以为漏了） ─────────────────────── */
const SKIPPED = [
  ["`data/keywords/latest.json`", "867 KB 的**运行期快照**（2,135 词 / 769 ASIN），不是源码，贴全文会把合集撑成一本电话簿；分享包里随包发原件，这里只收录它的读写契约"],
  ["`data/keywords/history/`", "历史紧凑投影（每份 <40KB，保留 104 份），属于使用者自己的趋势数据，可由 latest 重新生成"],
  ["`data/gen/`、`data/uploads/`", "运行期产物（生成的图、上传的参考图），属于使用者自己的数据，不进源码包"],
  ["`.env.local` / `.env`", "真实密钥。`.env.example` 才是该外发的那份"],
  ["`node_modules/`", "本项目零依赖，正常不存在"],
  ["`tools/_export-details.mjs`、`_sync-details-doc.mjs`、`_export-sources.mjs`", "**文档工具链**（不是运行时依赖）：把常量 dump 成参数附录、同步进《给AI审阅》、旧版合集生成器。仍在用，所以保留；它们的中间输出 `_details.out` 属于一次产物，已于 2026-11-08 清理"],
  ["`tools/_keywords-snapshot.json`", "移植前给原算法拍的行为快照（87 KB 纯数据），只在追查算法漂移时用得上"],
  ["`tools/make-share-pack.py`", "**打包器自身刻意不收录**：它写着完整的排除清单与隐私自检规则，外发等于把「哪些是敏感件」的原件一起送出去"],
  ["`README.md`、`给AI审阅-*.md`", "体积大且与本合集内容重叠，源码包里作为独立文件提供，不在这里重复贴一遍"],
];

/* ── 工具函数 ─────────────────────────────────────────────────── */
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const bytes = (p) => statSync(join(ROOT, p)).size;
const kb = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
/** 与 `wc -l` 同口径：数换行符，末尾没有换行时最后一段也算一行。 */
const lines = (p) => {
  const s = read(p);
  if (s === "") return 0;
  const n = s.split("\n").length;
  return s.endsWith("\n") ? n - 1 : n;
};
const sha = (p) => createHash("sha256").update(readFileSync(join(ROOT, p))).digest("hex").slice(0, 10);
/** 围栏长度自适应：内容里最长的一串反引号 + 1，且不少于 4。 */
const fenceFor = (s) => {
  let max = 0;
  for (const m of s.matchAll(/`+/g)) max = Math.max(max, m[0].length);
  return "`".repeat(Math.max(4, max + 1));
};
const langOf = (p) => {
  const ext = p.slice(p.lastIndexOf(".") + 1).toLowerCase();
  return { js: "javascript", mjs: "javascript", html: "html", css: "css", json: "json", py: "python", md: "markdown" }[ext] || "text";
};

/* ── 统计 ─────────────────────────────────────────────────────── */
const all = GROUPS.flatMap((g) => g.files.map(([p]) => p));
const totalBytes = all.reduce((a, p) => a + bytes(p), 0);
const totalLines = all.reduce((a, p) => a + lines(p), 0);

const out = [];
const w = (s = "") => out.push(s);

/* ── 头部 ─────────────────────────────────────────────────────── */
const today = new Date();
const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

w("# 跨境 Listing 质检工作台 · 源码合集");
w("");
w(`> 按**真实目录结构**整理的全量源码（${stamp} 生成）。共 **${all.length} 个文件 / ${totalLines.toLocaleString("en-US")} 行 / ${kb(totalBytes)}**。`);
w("> 每个文件都标注了职责与对外接口；正文按目录顺序排列，可对照解压后的 zip 逐条核对。");
w("");
w("**这份文件适合谁**");
w("");
w("- 要把项目整体交给别人（同事、外包、面试官）—— 连同源码 zip 一起发，对方不用问「哪个文件干什么」；");
w("- 要通读代码但不想在几十个文件之间跳 —— 目录树 + 清单 + 全文在同一份文档里；");
w("- 要检查某个功能到底是不是真的实现了 —— 清单里能直接定位到文件。");
w("");
w("**配套文档**");
w("");
w("| 文档 | 读它做什么 |");
w("|---|---|");
w("| 《跨境Listing优化工作台-功能详细介绍.md / .html》 | 每个功能做什么、怎么点、注意事项。**不懂代码也能读**；HTML 是单文件，双击就能看，适合直接转发 |");
w("| `README.md` | 项目定位、快速开始、规则口径来源 |");
w("| `docs/SPEC-P0-1-rufus.md` | Rufus 检查的验收标准与已知边界（规格即契约） |");
w("");
w("---");
w("");

/* ── 一、目录结构 ─────────────────────────────────────────────── */
w("## 一、目录结构");
w("");
w("```text");
w("跨境Listing优化工作台/");
const lastGroup = GROUPS.length - 1;
GROUPS.forEach((g, gi) => {
  // 根目录不放文件夹节点，文件直接挂在项目根下 —— 否则树里会多出一层不存在的目录。
  const isRoot = gi === 0;
  const gLast = gi === lastGroup;
  if (!isRoot) w(`${gLast ? "└── " : "├── "}${g.dir}`);
  const prefix = isRoot ? "" : gLast ? "    " : "│   ";
  g.files.forEach(([p], fi) => {
    // 根目录的文件与后面的目录**共用一条竖线**，所以最后一个文件也用 ├── 收尾，
    // 由下一个目录节点的 └── 表示结束。
    const fLast = fi === g.files.length - 1 && !isRoot;
    const name = isRoot ? p : basename(p);
    w(`${prefix}${fLast ? "└── " : "├── "}${name}`);
  });
});
w("```");
w("");
w("生成物与运行期目录（不在上面的树里，因为内容不属于源码）：");
w("");
w("- `data/gen/`、`data/uploads/` —— 本机生成图与上传的参考图，可用 `LISTING_DATA` 环境变量整体重定向；");
w("- `.env.local` —— 你自己的密钥，已在 `.gitignore` 里；");
w("- `node_modules/` —— 本项目零依赖，正常不存在。");
w("");
w("---");
w("");

/* ── 二、文件清单 ─────────────────────────────────────────────── */
w("## 二、文件清单（职责速查）");
w("");
w("「指纹」是文件 SHA-256 的前 10 位，用来确认你手里的文件与这份合集是同一版（完整值可用 `sha256sum` 自行计算）。");
w("");
for (const g of GROUPS) {
  w(`### ${g.dir}`);
  w("");
  w(`> ${g.note}`);
  w("");
  w("| 文件 | 行数 | 体积 | 指纹 | 职责 | 对外接口 |");
  w("|---|---:|---:|---|---|---|");
  for (const [p, purpose, api] of g.files) {
    const name = g.dir === "根目录" ? `\`${p}\`` : `\`${basename(p)}\``;
    w(`| ${name} | ${lines(p)} | ${kb(bytes(p))} | \`${sha(p)}\` | ${purpose} | ${api} |`);
  }
  w("");
}
w(`合计：**${all.length} 个文件 / ${totalLines.toLocaleString("en-US")} 行 / ${kb(totalBytes)}**。`);
w("");
w("---");
w("");

/* ── 三、怎么跑起来 ───────────────────────────────────────────── */
w("## 三、跑起来与验证");
w("");
w("**环境**：Node.js ≥ 20.15（`zlib.crc32` 的真实下限），无需 `npm install`。");
w("");
w("```bash");
w("# 1. 启动（默认只监听 127.0.0.1:8787，不对外暴露）");
w("node server.mjs");
w("");
w("# 2. 三套自检必须**顺序**跑（并行会互相把对方生成的报告当成变动）");
w(`node tools/selftest.mjs            # ${CN.selftest} 条：纯函数 + 源码静态断言`);
w(`node tools/verify-server.mjs       # ${CN.server} 条：真起服务打接口`);
w(`node tools/browser-selftest.mjs    # ${CN.browser} 条：真浏览器端到端`);
w("```");
w("");
w(`三套合计 **${THREE} 条断言**（另有两套单列：MCP ${CN.mcp} 条、词库 ${CN.keywords} 条）。自检脚本只读业务代码，且把数据目录重定向到临时目录，跑完不会改动你的真实数据。`);
w("");
w("---");
w("");

/* ── 四、源码正文 ─────────────────────────────────────────────── */
w("## 四、源码正文");
w("");
w("按第二节同样的顺序排列。每个文件前的引用块是该文件的职责与注意事项。");
w("");
GROUPS.forEach((g, gi) => {
  w(`### 4.${gi + 1} ${g.dir}`);
  w("");
  for (const [p, purpose] of g.files) {
    const code = read(p).replace(/\s+$/, "");
    w(`#### \`${p}\``);
    w("");
    w(`> ${purpose}`);
    w(`>`);
    w(`> ${lines(p)} 行｜${kb(bytes(p))}｜sha256:${sha(p)}`);
    w("");
    const fence = fenceFor(code);
    w(fence + langOf(p));
    w(code);
    w(fence);
    w("");
  }
  w("---");
  w("");
});

/* ── 附录 A：HTTP 接口 ────────────────────────────────────────── */
w("## 附录 A · HTTP 接口一览");
w("");
w("服务端共 25 个接口，全部同源、无第三方依赖。写接口一律要求 `Content-Type: application/json` 且同源（防 CSRF）；线上只读实例会额外把写接口全部挡成 403。");
w("");
w("| 方法 | 路径 | 作用 | 备注 |");
w("|---|---|---|---|");
const API = [
  ["GET", "/api/health", "探活与能力探测", "返回 Node 版本、是否配了图片 / 对话 Key、模板数、是否只读"],
  ["POST", "/api/config", "写入 `.env.local`", "合并写盘 + 原子替换；线上实例禁用（`LISTING_NO_KEY_WRITE=1`）"],
  ["POST", "/api/upload", "上传参考图", "大小与类型受限，落在 `data/uploads/`"],
  ["GET", "/api/blob", "读取图片", "仅允许 `gen/` 与 `uploads/` 下的文件名"],
  ["GET", "/api/library", "图片库列表", "读 `data/gen/`，支持打包下载"],
  ["POST", "/api/image", "生成图片", "兼容 OpenAI 同步式与 apimart 异步式"],
  ["POST", "/api/vision", "识图（图生图前的参考）", "失败时**响亮降级**，不静默退回纯文本"],
  ["POST", "/api/llm", "通用模型调用", "用于「AI 润色主体描述」等可选能力"],
  ["POST", "/api/chat", "对话式编排（SSE）", "浏览器离线时走同一份 `runLocalTurn`"],
  ["GET", "/api/keywords", "本周词库快照", "`?limit` / `?sort` / `?q` / `?site` / `?compare=prev`；带两期词与 ASIN 榜单变动、词根覆盖层、站点实测状态"],
  ["GET", "/api/keyword-roots", "读词根覆盖层", "返回 194 条基线 + 覆盖层 diff、被拒项、词根命中统计、站点实测状态"],
  ["POST", "/api/keyword-roots", "保存词根覆盖层", "白名单收参（只认 added / removed / renamed）、原子写；线上只读实例 403"],
  ["GET", "/api/export", "导出 CSV", "`?kind=keywords|asins`；UTF-8 BOM + RFC 4180，与前端共用 `assets/csv.js`"],
  ["GET", "/api/external/providers", "外部数据源白名单", "常量表，请求体里**没有 url 字段**（防 SSRF）"],
  ["GET", "/api/external/terms", "读已导入的第三方词表", "`?compare=1` 算本地交集；`?demo=1` 读内置 12 词示例、不写盘（没账号也能验收）"],
  ["POST", "/api/external/test", "试连第三方 MCP", "验密钥与字段映射，不落盘；线上只读实例 403"],
  ["POST", "/api/external/call", "调用第三方 MCP 工具", "只走 `EXTERNAL_MCP` 常量白名单；线上只读实例 403"],
  ["POST", "/api/external/import", "导入第三方词表", "落到 `data/external/<id>.json`；线上只读实例 403"],
  ["GET", "/api/competitor/categories", "竞品榜单的站点与类目表", "纯静态数据"],
  ["GET", "/api/competitor/bestsellers", "抓取 Best Sellers 榜单", "`?href=` 参数自己过白名单；上游失败返回 502"],
  ["GET", "/api/competitor/subs", "抓取子类目列表", "同上"],
];
for (const [m, p, d, n] of API) w(`| ${m} | \`${p}\` | ${d} | ${n} |`);
w("");
w("---");
w("");

/* ── 附录 B：模块依赖 ────────────────────────────────────────── */
w("## 附录 B · 模块依赖方向");
w("");
w("依赖是**单向**的，没有循环引用。改代码时按这个方向找影响面：");
w("");
w("```text");
w("index.html");
w("  └─ assets/app.js（唯一入口，需要 DOM）");
w("       ├─ api.js ────────── 传输层（fetch / SSE）");
w("       ├─ orchestrator.js ─ 编排层");
w("       │    ├─ prompt-engine.js ─ 规则引擎");
w("       │    └─ templates.js ───── 模板数据（生成物）");
w("       ├─ listing.js ────── 质检 / 字段 / 草稿 / 覆盖度");
w("       ├─ rufus.js ────────┬─ rufus-facts.js ─ 事实层");
w("       │                   └─ rufus-data.js ── 数据层");
w("       ├─ competitor-keywords.js / copy-prompts.js");
w("       ├─ bestsellers.js ── 抓取（唯一主动爬第三方站点的模块）");
w("       ├─ amazon.js ─────── 页面解析 + 书签脚本");
w("       ├─ store.js ──────── IndexedDB 留档");
w("       ├─ select-ui.js / md.js");
w("       └─ zip.js");
w("");
w("server.mjs（Node）");
w("  ├─ orchestrator.js（与浏览器同一份 runLocalTurn）");
w("  ├─ net-guard.js（SSRF 判据，与自检共用）");
w("  ├─ bestsellers.js / amazon.js");
w("  └─ zip.js");
w("```");
w("");
w("---");
w("");

/* ── 附录 C：未收录 ──────────────────────────────────────────── */
w("## 附录 C · 未收录的文件及理由");
w("");
w("| 未收录 | 理由 |");
w("|---|---|");
for (const [p, why] of SKIPPED) w(`| ${p} | ${why} |`);
w("");
w("---");
w("");
w("## 附录 D · 已知边界（读代码前先知道）");
w("");
w("- **不做服务端爬虫**：竞品数据只有两条路——书签脚本采集、粘贴解析；唯一主动出网的是 Best Sellers 公开榜单抓取。");
w("- **不做账号体系与云同步**：产物存在本机浏览器 IndexedDB，密钥存在 `.env.local`，都不出本机。");
w("- **规则是机械判定**：宁可不报（标「跳过」并写明原因），也不给假结论。");
w("- **标题口径按 2026-07-27 新规**：普通类目 75 字符、media 200 字符、Item Highlights 125 字符、两者合计 200。");
w("- **模板数据是生成物**：`assets/templates.js` 由 `tools/build-templates.mjs` 生成，直接手改会在下次生成时被覆盖。");
w("");

/* ── 输出 ─────────────────────────────────────────────────────── */
// 🔴 这里**不能**做 `replace(/\n{3,}/g, "\n\n")` 之类的"美化"：全文里有源码，
//    连续空行是代码的一部分，压掉就等于改写了别人的文件。
const text = out.join("\n").trimEnd() + "\n";
const outIdx = process.argv.indexOf("--out");
if (outIdx > -1 && process.argv[outIdx + 1]) {
  const target = resolve(process.argv[outIdx + 1]);
  writeFileSync(target, text, "utf8");
  process.stderr.write(`已写入 ${target}（${text.length.toLocaleString("en-US")} 字符 / ${all.length} 个文件）\n`);
} else {
  process.stdout.write(text);
}
