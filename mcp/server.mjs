#!/usr/bin/env node
/**
 * 跨境 Listing 质检工作台 · MCP server（stdio，零依赖）
 *
 * ── 为什么要有这个东西 ────────────────────────────────────────────────
 * 西柚洞察 / 卖家精灵 都提供 MCP，但它们都要**各自账号的 Token**：
 * 谁用谁配，配好也只对那个人有效。所以"配置完整、别人拉下来就能调"这件事，
 * 靠接别人的 MCP 做不到 —— 只能把**本项目的判断层**自己暴露成 MCP。
 *
 * 于是这个 server 的定位很明确：
 *   · 它**不是搜索量数据源**。没有搜索量、没有 ABA 排行、没有付费关键词库。
 *   · 它提供两样东西：
 *       ① **判断层**：28 条质检、三层上传前预校验、覆盖度、Prompt 组装、快照对比、词频；
 *       ② **词面清单**（`keyword_snapshot`）：定时任务每周抓的「词根 → 真实搜索建议词」
 *          与 Best Sellers 榜单 ASIN。只有词面，没有搜索量 —— 这个区别写在返回值里。
 *   · 数据从哪来由你决定：手动粘、从第三方导出、调 `amazon_suggest`，或读每周快照。
 *
 * ── 三条硬约束（违反就会坏）──────────────────────────────────────────
 *   ① **stdout 只能有 JSON-RPC**。任何 console.log / 调试输出都会让客户端解析失败，
 *      所以本文件所有日志一律走 stderr（`log()`）。
 *   ② **只读**：不写文件、不改配置、不碰 data/。即使将来加工具，也不许在这里写盘。
 *   ③ **不静默降级**：取不到就说取不到，返回 isError + 原因；绝不返回编造的数据。
 *
 * ── 启动 ────────────────────────────────────────────────────────────
 *   node mcp/server.mjs          # 正常（含 amazon_suggest）
 *   node mcp/server.mjs --no-net # 去掉联网工具，纯离线
 *
 * 协议版本：声明支持 **2025-11-25 / 2025-06-18 / 2024-11-05**（降序）。
 *   · 2026-07-28 的无状态核心**我们本来就满足**（handle() 不依赖 session，每个请求自带参数），
 *     缺的只是"发现入口"：已实现 `server/discover`；
 *   · 未实现 `Mcp-Method`/`Mcp-Name` header 路由（stdio 没有 HTTP 头）与 MRTR（8 个工具都是单轮）。
 *     所以对外口径是"兼容 2026-07-28 的无状态调用路径"，不是"完全符合 2026-07-28"。
 *   · 规范注：官方博客说 `server/discover` "not required"，但 specification 正文写
 *     "Servers MUST implement it" —— 两处口径冲突，我们按更严格的一侧实现。
 *
 * ── 两条传输、同一份处理函数（P0-B2）────────────────────────────────
 *   stdio：`node mcp/server.mjs` 起 readline 主循环，逐行读入 → `handle(msg)` → `send()`。
 *   HTTP ：`node mcp/http.mjs` 用 `MCP_HTTP_NO_STDIO=1` 动态 import 本文件，复用同一个
 *          `handle(msg)`，把返回对象序列化成 `POST /mcp` 的响应体。
 *
 * 🔴 `handle(msg)` 是**纯函数**：返回 `Promise<response|null>`，自己绝不写 stdout。
 *    两条传输只负责"怎么把 response 发出去"，所以 `tools/list` 在两条链路上必然逐字节相同。
 *    🔴 自检 2b 会用一个 wrapper `import` 本文件来验 stdout 闸门 —— 那个 wrapper **不带**
 *       `MCP_HTTP_NO_STDIO`，所以闸门与主循环必须照常启动；只有 http.mjs 显式带这个开关时才跳过。
 *    🔴 源码里不许出现 `console.log` / 任何写盘调用；import 只能是 `node:` 或 `../assets`
 *       （`tools/mcp-selftest.mjs` 第 12 节静态查这三条）。token 落盘在 http.mjs，不在这里。
 *
 * ── P2 增广（只在协议外壳，不动 8 条描述一个字）─────────────────────
 *   · annotations / outputSchema：在 `describeTool()` 里给出，不写进 TOOLS 定义；
 *   · structuredContent：由 `content[0].text` 同一份 stringify 反解，天然深相等；
 *   · 参数校验：`VALIDATORS` 表驱动 + enum/minimum/maximum/maxItems；
 *   · analyze_coverage.useVault：显式 opt-in，默认分支保持旧代码原样（逐字节回归铁证）。
 */

import { createInterface } from "node:readline";

import {
  lintListing, precheckForUpload, analyzeCoverage, mineKeywords,
} from "../assets/listing.js";
import { composePrompt, RATIO_PIXELS, toRatioText } from "../assets/prompt-engine.js";
import { diffSnapshots } from "../assets/amazon.js";
// 搜索建议：与服务端、采集器**同一份实现**（含 mid/lop 表与"不静默降级"的返回契约）
import { suggest, MARKET } from "../assets/amazon-suggest.js";
// 本周词库：只读。没有写入口 —— MCP 的"只读"靠的是一个不存在的函数，不是靠自觉。
import { readLatest, readStatus } from "../assets/keywords-store.js";
import { queryKeywords } from "../assets/keyword-vault.js";

const SERVER_INFO = { name: "listing-studio", version: "1.0.0" };
/** 降序：第 0 个是"我们能说的最新版本"。 */
const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2024-11-05"];

/** 客户端拿到的第一段话（initialize 与 server/discover 共用一份，避免两处说法漂移）。 */
const INSTRUCTIONS =
  "跨境 Listing 质检工作台的判断层 + 每周词面快照：质检、预校验、覆盖度、Prompt 组装、快照对比、词频，"
  + "以及 keyword_snapshot（词根→真实搜索建议词 + 榜单 ASIN）。"
  + "它没有搜索量：建议词只说明「有人这么打」，不说明「有多少人搜」。"
  + "「跳过」= 未判定，不等于通过。";

/**
 * 版本切成数字段。MCP 的版本号长成 `2025-11-25`（**日期**，不是 `1.2.3`），
 * 所以不能用 `split(".")` —— `"2025-11-25".split(".")` 只有一段，
 * `Number("2025-11-25")` = NaN，而 `NaN || 0` = 0 → 所有版本都"相等"。
 * 这个坑真实存在过：协商退化成「不精确匹配就返回最新」，而注释还写着"找它能接受的最高版本"。
 */
function versionParts(v) {
  return String(v).split(/[^0-9]+/).filter(Boolean).map(Number);
}

/** 版本比较：只按数字段比大小，不装库。 */
function cmpVersion(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 版本协商。三种情况必须分开处理，混成一句"回落"就会答错：
 *   · 比我们都新 → 给**最新**（降到两年前等于让新版客户端以为我们在说旧协议）
 *   · 比我们都老 → 给**最老**（给新版它反而用不了）
 *   · 夹在中间   → 给**不超过它的最高版**（这才是"它能接受的最新"）
 */
function negotiateProtocol(asked) {
  if (!asked) return SUPPORTED_PROTOCOLS[0];
  if (SUPPORTED_PROTOCOLS.includes(asked)) return asked;
  const newest = SUPPORTED_PROTOCOLS[0];
  const oldest = SUPPORTED_PROTOCOLS[SUPPORTED_PROTOCOLS.length - 1];
  if (cmpVersion(asked, newest) > 0) return newest;
  if (cmpVersion(asked, oldest) < 0) return oldest;
  return SUPPORTED_PROTOCOLS.find((v) => cmpVersion(v, asked) <= 0) || newest;
}
const NO_NET = process.argv.includes("--no-net") || process.env.MCP_NO_NET === "1";

/**
 * HTTP 接入模式开关：由 `mcp/http.mjs` 在动态 import 本文件之前设上。
 * 🔴 名字故意取得很内部化，且**默认是关**：stdio 主循环、stdout 闸门、ready 日志
 *    都必须照常启动。自检 2b 用一个 `import` 本文件的 wrapper 验闸门，它不带这个变量。
 *    HTTP 进程里 stdout 不是协议通道（响应走 socket），装闸门反而会误拦启动横幅。
 */
const HTTP_IMPORT = process.env.MCP_HTTP_NO_STDIO === "1";

/** 日志只走 stderr —— stdout 是协议通道，写一个字符都可能让客户端崩。 */
const log = (...a) => process.stderr.write(`[mcp] ${a.join(" ")}\n`);

/* ─────────────────── stdout 闸门（红线 8 的机制化） ───────────────────
 * 为什么需要：任何被 import 的模块里只要有一句 `console.log`，就会往协议通道里
 * 塞一行非 JSON。客户端的表现是 **「0 个工具」且不报错** —— 这是十条红线里唯一
 * 一条"纯自觉 + 失败静默"的（评审 3.4 的结论准确）。
 *
 * 做法：把 process.stdout.write 换成一个只放行合法 JSON-RPC 的漏斗，
 * 其余全部转 stderr 并留痕。零依赖，约 20 行。
 *
 * 三个坑（都踩过）：
 *   ① **必须按行缓冲**：一次 write 可能只有半行，前缀判断会把合法消息切成两半丢掉；
 *   ② **判定用 JSON.parse 而不是 startsWith('{"jsonrpc')**：JSON.stringify 不保证
 *      `jsonrpc` 是第一个键（当前对象字面量恰好是，但这不是契约）；
 *   ③ **回调必须手动调**：包装后 Node 不再替你调 cb，不调调用方会永久挂起
 *      —— 而"挂起"是最难排查的失败模式（比报错难十倍）。
 */
const RAW_WRITE = process.stdout.write.bind(process.stdout);
let outPending = "";
let outBlocked = 0;
let outLastOk = true;   // 透传背压信号：恒返回 true 等于对调用方撒谎

function stdoutGuard(chunk, enc, cb) {
  try {
    outPending += typeof chunk === "string"
      ? chunk
      : Buffer.from(chunk).toString(typeof enc === "string" ? enc : "utf8");

    let i;
    while ((i = outPending.indexOf("\n")) >= 0) {
      const line = outPending.slice(0, i);
      outPending = outPending.slice(i + 1);
      if (!line.trim()) continue;
      let ok = false;
      try {
        const m = JSON.parse(line);
        ok = Boolean(m) && m.jsonrpc === "2.0"
          && ("method" in m || "result" in m || "error" in m);
      } catch { ok = false; }
      if (ok) outLastOk = RAW_WRITE(`${line}\n`);
      else {
        outBlocked++;
        process.stderr.write(`[mcp] stdout blocked: ${line.slice(0, 200)}\n`);
      }
    }
  } catch (e) {
    process.stderr.write(`[mcp] stdout guard error: ${e.message}\n`);
  }
  // ③：回调无论走哪条路都要调，且只调一次。
  if (typeof enc === "function") enc();
  else if (typeof cb === "function") cb();
  return outLastOk;
}

// 🔴 只有 stdio 传输才装闸门；HTTP 传输的响应体走 res.end()，不经过 stdout。
if (!HTTP_IMPORT) process.stdout.write = stdoutGuard;

/** 被拦下的行数。自检用它证明闸门真的动过，而不是"恰好没有噪声"。 */
export const blockedStdoutLines = () => outBlocked;

/* ─────────────────────── 工具定义 ─────────────────────── */

const LISTING_PROPS = {
  title: { type: "string", description: "标题（≤75 字符；media 类目 ≤200）" },
  highlights: { type: "string", description: "Item Highlights，逗号分隔的短语（≤125 字符）" },
  bullets: { type: "array", items: { type: "string" }, maxItems: 50, description: "五点，每条一句；至少 3 条才算填够" },
  searchTerms: { type: "string", description: "后台 Search Terms（按**字节**算，上限 250）" },
  description: { type: "string", description: "商品描述（可选）" },
  brand: { type: "string", description: "品牌；为空会被判为硬缺口" },
  primaryKeyword: { type: "string", description: "核心关键词，用于检查有没有前置" },
  category: { type: "string", description: "品类（如 home / fashion），影响部分规则" },
  isMedia: { type: "boolean", description: "图书/音乐/影像类目 → 标题上限改为 200" },
};

/** 导出给 mcp/http.mjs 复用（同一份工具表 → tools/list 逐字节一致）。 */
export const TOOLS = [
  {
    name: "lint_listing",
    title: "Listing 质检（28 条规则）",
    description:
      "按亚马逊文案规则逐条检查标题 / Item Highlights / 五点 / Search Terms，返回命中项、出处与四态计数。\n"
      + "用我当：想知道「这条文案哪里不合规、哪里在浪费字符」，或要一份逐条规则+出处的整改清单。\n"
      + "别用我当：判断「现在能不能上传」（用 precheck_upload）；判断「关键词覆盖够不够」（用 analyze_coverage）。\n"
      + "你会拿到：conclusion、counts{total,hit,checked,skipped,errored}、hits[]{id,level,scope,detail,source,why,fix}、unjudged[]。\n"
      + "口径：跳过≠通过；checked = total - skipped - errored；hits[].source 是规则出处，why 说为什么命中、fix 说怎么改，改文案前先看它们。",
    inputSchema: { type: "object", properties: LISTING_PROPS, required: [] },
    run: (a) => {
      const r = lintListing(listingOf(a), ctxOf(a));
      const s = r.summary;
      const hits = r.results.filter((x) => x.status === "命中");
      const unjudged = r.results.filter((x) => x.status === "跳过" || x.status === "异常");
      return {
        conclusion: s.conclusion,
        counts: {
          total: s.total, hit: s.hit, hitP: s.hitP, hitC: s.hitC,
          checked: s.checked, skipped: s.skipped, errored: s.errored,
        },
        // S-6 / P2#11：28 条规则的 why（为什么命中）+ fix（怎么改）必须透传到 MCP 边界。
        //    🔴 字段顺序沿用现有投影（source 在后追加两项），不重排、不动 RULES、不动判定行为。
        //    outputSchema 是通用 {type:"object"}，加两个键不会破坏 structuredContent 深相等。
        hits: hits.map((x) => ({ id: x.id, level: x.level, scope: x.scope, detail: x.detail, source: x.source, why: x.why, fix: x.fix })),
        unjudged: unjudged.map((x) => ({ id: x.id, status: x.status, detail: x.detail })),
        note: "checked = total - skipped - errored。跳过与异常都不计入通过。",
      };
    },
  },
  {
    name: "precheck_upload",
    title: "上传前预校验（三层）",
    description:
      "分三层回答「现在上传还差什么」：blockers（一定传不上去）/ warnings（能传但吃亏）/ externals（本工具不查、你必须自己核）。\n"
      + "用我当：发布前最后一次体检，或想按严重程度排整改顺序。\n"
      + "别用我当：要具体改法（用 lint_listing 看规则与出处）；要关键词覆盖（用 analyze_coverage）。\n"
      + "你会拿到：blockers[] / warnings[] / externals[] 三层，每项一句原因。\n"
      + "口径：externals 是 UPC、类目节点、价格库存、主图、合规文件 —— 任何本地工具都查不到，别当成「已通过」。",
    inputSchema: { type: "object", properties: LISTING_PROPS, required: [] },
    run: (a) => precheckForUpload(listingOf(a), ctxOf(a)),
  },
  {
    name: "analyze_coverage",
    title: "关键词覆盖度",
    description:
      "把候选词逐个判定在标题 / 五点 / 描述 / Search Terms 四个位置是否出现，给加权覆盖率与缺口。\n"
      + "用我当：已知一批要打的词，想知道哪些还没写进文案。\n"
      + "别用我当：挖新词（用 mine_keywords 或 keyword_snapshot）；判文案合规（用 lint_listing）。\n"
      + "你会拿到：coveragePct、covered/total、gaps（真缺口）、minedGaps（竞品语料挖的噪声线索）、weak、unused。\n"
      + "口径：gaps 只含你给的词；coveragePct 是按字段权重算的加权值，不是「多少个词出现过」，也不代表搜索量或排名。",
    inputSchema: {
      type: "object",
      properties: {
        ...LISTING_PROPS,
        keywords: { type: "array", items: { type: "string" }, maxItems: 500, description: "候选关键词（你自己选定的）" },
        competitors: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            properties: { name: { type: "string" }, text: { type: "string" } },
            required: ["text"],
          },
          description: "竞品文案（标题+五点），可选；给了就会挖出 minedGaps",
        },
        top: { type: "number", maximum: 500, description: "最多分析多少个词，默认 30" },
        // S-2 / G-8：三个参数都是**显式 opt-in**。不传 useVault 时 run 走 legacyCoverage，
        // 输出与改动前逐字节一致（回归铁证写进 tools/mcp-selftest 之外的临时自测）。
        useVault: {
          type: "boolean",
          // 🔴 形状变更必须写进 schema，不能只靠文档：gaps 开启后**恒为对象数组**，
          //    与词库有无无关；返回体带恒值 gapShape:"objects" 自证形状。
          //    🔴 默认（不传 useVault）走 legacyCoverage → gaps 是字符串数组，逐字节不变。
          description: "把本周词库快照的词并入候选（默认 false）。⚠️ 开启后 gaps 变对象数组（带 from/rootCount/groups/missingIn），"
            + "响应里 gapShape 字段自证形状（恒为 'objects'）；不传时输出与旧版逐字节一致。",
        },
        vaultLimit: { type: "number", maximum: 500, description: "最多并入多少个词库词，默认 50，上限 500" },
        vaultCategory: { type: "string", description: "只取某个类目/分组的词库词（如 kitchen）；留空不筛" },
      },
      required: ["keywords"],
    },
    run: (a) => (a.useVault === true ? vaultCoverage(a) : legacyCoverage(a)),
  },
  {
    name: "mine_keywords",
    title: "词频挖掘（本地，不联网）",
    description:
      "对一段文本做 1–3 gram 词频统计并去停用词，回答「竞品标题到底在打哪些词」。本地计算，不联网。\n"
      + "用我当：手上有竞品文案，想快速看高频修饰词与短语。\n"
      + "别用我当：判断你的文案覆盖了没有（用 analyze_coverage）；要真实买家搜索词（用 amazon_suggest 或 keyword_snapshot）。\n"
      + "你会拿到：按频次排序的词与短语、语种、是否含 n-gram。\n"
      + "口径：频次高≠重要，只说明对方反复用；中文不做分词；停用词只有 en/de/fr/es/it/nl/ja 七套。",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "竞品标题 + 五点，多段用 --- 或换行分隔" },
        top: { type: "number", maximum: 500, description: "返回前 N 个，默认 40" },
        lang: { type: "string", description: "语种代码，如 de / ja；留空按英文" },
        includeNgrams: { type: "boolean", description: "是否统计 2–3 词短语，默认 true" },
      },
      required: ["text"],
    },
    run: (a) => mineKeywords(String(a.text || ""), {
      top: Number(a.top) > 0 ? Number(a.top) : 40,
      lang: a.lang || "",
      includeNgrams: a.includeNgrams !== false,
    }),
  },
  {
    name: "build_image_prompt",
    title: "图片 Prompt 组装",
    description:
      "按模板 / 图型 / 画幅组装一段可交给生图模型的英文 Prompt，并回传画幅像素与合规提示。\n"
      + "用我当：要出主图 / 场景图 / 卖点图，缺一段结构化的 Prompt。\n"
      + "别用我当：以为我会出图 —— 我只出文字 Prompt；图片是否符合首图规范用 lint_listing 的图片规则看；整条 Listing 能不能传用 precheck_upload。\n"
      + "你会拿到：prompt、meta{模板/图型/画幅/像素}。\n"
      + "口径：成图质量由模型决定，我不预测效果；slot=main 时按亚马逊首图规则约束。",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "产品主体，如 ceramic mug" },
        templateId: { type: "string", description: "模板 id，默认 hero-image" },
        figure: { type: "string", description: "图型，如 main / hero / benefit / scene" },
        ratio: { type: "string", description: "画幅比例，如 1:1 / 16:9 / 2:3" },
        slot: { type: "string", enum: ["design", "main", "secondary", "aplus"], description: "投放位；main = 亚马逊首图" },
        purpose: { type: "string", description: "这张图要解决什么（一句话）" },
        headline: { type: "string", description: "图内文字，可留空" },
        evidence: { type: "array", items: { type: "string" }, maxItems: 50, description: "要写进图里的证据点" },
        cta: { type: "string", description: "行动号召，可留空" },
      },
      required: ["subject"],
    },
    run: (a) => {
      const ratio = a.ratio ? toRatioText(a.ratio) : "1:1";
      const out = composePrompt({
        subject: String(a.subject),
        templateId: a.templateId || "hero-image",
        figure: a.figure,
        slot: a.slot,
        purpose: a.purpose,
        headline: a.headline,
        evidence: Array.isArray(a.evidence) ? a.evidence : [],
        cta: a.cta,
        sizeRatio: ratio,
      });
      return {
        prompt: out.prompt,
        meta: { ...out.meta, ratio, pixels: RATIO_PIXELS[ratio] || null },
        note: "prompt 是给生图模型的输入；成图质量由模型决定，本工具不预测效果。",
      };
    },
  },
  {
    name: "diff_snapshots",
    title: "两次采集的快照对比",
    description:
      "对比同一件商品前后两次采集，回答「对方改了哪些字段」。\n"
      + "用我当：确认竞品是否改了标题/五点/价格/规格，或验证自己的改动生效了没有。\n"
      + "别用我当：比较两份词库周报（用 keyword_snapshot）；判断改动是好是坏（我只报事实）。\n"
      + "你会拿到：rows[]{key,label,before,after,added,removed}、changedCount、unchanged、sameAsin、note。\n"
      + "口径：只比抓到的 9 个文本字段；ASIN 不同或缺失会在 note 里明说，不假装是同款，也不推断对方为什么改。",
    inputSchema: {
      type: "object",
      properties: {
        before: { type: "object", description: "早的那次采集（含 asin/title/price/bullets/specs…）" },
        after: { type: "object", description: "晚的那次采集" },
      },
      required: ["before", "after"],
    },
    run: (a) => diffSnapshots(a.before || {}, a.after || {}),
  },
  {
    name: "keyword_snapshot",
    title: "本周词库快照（只读）",
    description:
      "读每周快照：词根→真实搜索建议词 + Best Sellers 榜单 ASIN。可按词面/类目筛，按价值/新词/字母排序。\n"
      + "用我当：想知道本周有哪些词面、某个类目下有哪些词和 ASIN、这周新冒出来什么。\n"
      + "别用我当：要搜索量或 ABA 排名（我没有）；要实时单个词根的联想（用 amazon_suggest）。\n"
      + "你会拿到：keywords[]{term,rootCount,groups,firstSeen,newly}、asins[]{asin,rank,price}、staleness、status。\n"
      + "口径：rootCount=被几个词根带出，不是热度；rank=榜单名次，不是销量；没有快照时 ok:false，不是报错。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "按词面模糊筛选，如 mug；留空返回全部（受 limit 限制）" },
        limit: { type: "number", minimum: 1, maximum: 500, description: "最多返回多少条关键词，默认 50，上限 500" },
        category: { type: "string", description: "只看某个类目/分组（关键词与 ASIN 同时生效），如 kitchen" },
        sort: { type: "string", enum: ["roots", "new", "az"], description: "排序：roots=按词根覆盖数（默认）/ new=新词优先 / az=字母序" },
        includeAsins: { type: "boolean", description: "是否一并返回 ASIN 榜单条目（默认 true）" },
      },
      required: [],
    },
    run: (a) => {
      const r = readLatest();
      if (!r.ok) {
        // 🔴 「还没有词库」不是工具调用失败，是**数据还没生成**。所以 isError 保持 false，
        //    但 ok:false 且把原因与下一步说清楚 —— 报 isError 会让模型以为工具坏了、反复重试。
        return {
          ok: false,
          reason: r.reason,
          error: r.error,
          hint: "词库由每周定时任务生成。本地先跑 `node tools/collect-keywords.mjs`（约 3–5 分钟），"
            + "或在 GitHub Actions 里手动触发 keywords 工作流。",
        };
      }
      const snap = r.snapshot;
      const cat = String(a.category || "").trim();
      // 类目筛选**同时**作用于关键词与 ASIN：以前只筛 ASIN，于是「看 kitchen 的词」
      // 拿到的还是全部词 —— 与工具描述不一致，模型会据此得出错误结论。
      const SORTS = ["roots", "new", "az"];
      const sort = SORTS.includes(String(a.sort || "")) ? String(a.sort) : "roots";
      const kw = queryKeywords(snap, { q: a.query || "", limit: Number(a.limit) || 50, group: cat, sort });
      const st = readStatus();
      const asinPool = cat
        ? snap.asins.filter((x) => [x.group, x.category].some((v) => String(v || "").toLowerCase() === cat.toLowerCase()))
        : snap.asins;
      const asins = a.includeAsins === false ? [] : asinPool.slice(0, 200);
      return {
        ok: true,
        site: snap.site,
        market: snap.market || "",
        generatedAt: snap.generatedAt,
        ageDays: r.staleness.ageDays,
        stale: r.staleness.state !== "fresh",
        staleNote: r.staleness.note,
        counts: {
          keywords: snap.summary?.keywordCount ?? snap.keywords.length,
          asins: snap.summary?.asinCount ?? snap.asins.length,
          newKeywords: snap.summary?.newKeywordCount ?? 0,
          // 新出现的词里，真首次 / 回归各多少。returnedUnknown=true 时这两个数不可信（没有历史投影）。
          firstTime: snap.summary?.firstTimeCount ?? 0,
          returned: snap.summary?.returnedCount ?? 0,
          returnedUnknown: snap.summary?.returnedUnknown ?? true,
        },
        // 采集状态：ok=false 时说明"上一次采集挂了"，而 generatedAt 还是上一次成功的时间。
        status: st.ok ? st.status : { ok: false, reason: st.reason, error: st.error },
        // 截断要说出来：limit 再大底层也只有 500；ASIN 一次最多 200。
        keywordsTotal: kw.total,
        keywordsTruncated: kw.truncated,
        // 要多了不报错，但要报账：requested ≠ limit 时，模型才知道"你没给我 2000 条"。
        keywordsRequested: kw.requested,
        keywordsLimit: kw.limit,
        keywordsSort: sort,
        asinsTotal: asinPool.length,
        asinsTruncated: asinPool.length > asins.length,
        sources: snap.sources,
        keywords: kw.rows,
        asins,
        // 采集器发现"上一份快照损坏""预算不够跳过了词根"时会写进 summary.note，
        // 这里必须透传 —— 否则模型会把一份打了折的数据当成完整的。
        dataNote: snap.summary?.note || "",
        note: "这是词面清单，不是搜索量榜单。`rootCount`（旧名 `hits`）= 这周被几个词根带出来，"
          + "只说明词根的覆盖广度，与搜索热度无关。ASIN 的 `rank` 是 Best Sellers 榜单名次，不是销量。"
          + "`newly` = stable / new / returned / unknown（unknown 表示没有历史投影，分不出首次与回归）。",
      };
    },
  },
];

/* ── 唯一的联网工具（可用 --no-net 关掉）──
 * 为什么允许它存在：搜索建议接口返回的是**真实买家搜索词**，零 Key、零费用，
 * 是"词根 → 长尾"最省事的入口。但它毕竟是出网动作，所以：
 *   · 每次调用只发 **1 个请求**，8 秒超时，不重试、不翻页；
 *   · 失败就报失败，不返回空数组冒充"没有建议词"。
 * ⚠️ mid / lop 只有 US、DE 实测过；其余站点可能返回空，属于"参数没对上"，不是"没有词"。
 *
 * 🔴 具体实现在 `assets/amazon-suggest.js` —— **每周采集器用的是同一份**。
 *    这里只负责协议包装，不写第二份 URL 拼装与解析（那种重复永远不会同步）。
 */
if (!NO_NET) {
  TOOLS.push({
    name: "amazon_suggest",
    title: "亚马逊搜索建议（真实买家搜索词）",
    description:
      "查亚马逊搜索建议（买家真实输入的长尾词），一次一个词根、一次请求、8 秒超时。\n"
      + "用我当：临时想知道某个词根的长尾，不想等每周快照。\n"
      + "别用我当：批量抓词（用 keyword_snapshot 或采集器）；要搜索量（建议词没有量）。\n"
      + "你会拿到：suggestions[]、count、站点、该站点是否实测过。\n"
      + "口径：只有 US/DE 实测过，其余站点可能为空（参数没对上，不是没有词）；失败就报失败，不返回空数组冒充没有建议。",
    inputSchema: {
      type: "object",
      properties: {
        prefix: { type: "string", description: "词根，如 phone st" },
        site: { type: "string", enum: Object.keys(MARKET), description: "站点，默认 US" },
        limit: { type: "number", minimum: 1, maximum: 20, description: "最多几条，1–20，默认 11" },
      },
      required: ["prefix"],
    },
    run: (a) => suggest(String(a.prefix || ""), a.site || "US", Number(a.limit) || 11),
  });
}

/* ─────────────────────── 入参归一 ─────────────────────── */

function listingOf(a) {
  return {
    title: String(a.title || ""),
    highlights: String(a.highlights || ""),
    bullets: Array.isArray(a.bullets) ? a.bullets : String(a.bullets || "").split("\n").filter(Boolean),
    searchTerms: String(a.searchTerms || ""),
    description: String(a.description || ""),
  };
}

function ctxOf(a) {
  return {
    brand: String(a.brand || ""),
    primaryKeyword: String(a.primaryKeyword || ""),
    category: a.category ? String(a.category).toLowerCase() : undefined,
    isMedia: Boolean(a.isMedia),
  };
}

/* ── analyze_coverage 的两条路径（S-2 / G-8）────────────────────────
 * 🔴 legacyCoverage 是改动前 run() 的**逐字拷贝**。不传 useVault 时走它，
 *    输出必须与改动前逐字节一致 —— 这是「加词库闭环没有改坏旧覆盖度」的回归铁证。
 *    哪怕只是给对象多塞一个键、或把 key 换个顺序，JSON.stringify 的字节都会变，
 *    所以这里一个字都不敢优化：不要去重、不要加字段、不要换注释位置对应的键序。
 *
 * vaultCoverage 只在显式 useVault:true 时才跑，且**完全自包含在 MCP 层**：
 * 用已 import 的 readLatest() 读只读快照，再把合并后的词交给**同一份** analyzeCoverage
 * 判定（不写第二套覆盖判定，也不依赖 assets/listing.js 的任何新 API）。
 */
function legacyCoverage(a) {
  const r = analyzeCoverage(listingOf(a), {
    keywords: a.keywords,
    competitors: a.competitors,
    top: a.top,
  });
  return {
    coveragePct: r.coveragePct,
    covered: r.covered,
    total: r.total,
    gaps: r.gaps,
    minedGaps: r.minedGaps,
    weak: r.weak,
    unused: r.unused,
    competitorProvided: r.competitorProvided,
    competitorNames: r.competitorNames,
    // 🔴 底层那句「这不是搜索量、不是排名」的免责声明必须**原样透传**。
    //    换一句更顺口的话，等于把这句话里最值钱的部分删掉 —— 调用方会拿覆盖率当排名用。
    note: r.note,
    metricNote: "coveragePct 是按字段权重算的加权覆盖率，不是「有多少词出现过」。",
  };
}

function vaultCoverage(a) {
  // ① 用户词优先，原样保留展示大小写
  const userWords = Array.isArray(a.keywords)
    ? a.keywords.map((x) => String(x))
    : String(a.keywords || "").split(/[,，\n]/);

  // ② 词库：只读。没有 / 读坏 / 结构不对都**不失败** —— 只用 user 词继续跑。
  //    readLatest() 自己把所有异常折成 {ok:false}，这里再兜一层，绝不让工具级 isError 变 true。
  const vl = readLatest();
  const vault = { ok: false, reason: vl.ok ? "ok" : (vl.reason || "missing") };
  let vaultRows = [];
  if (vl.ok) {
    const cat = String(a.vaultCategory || "").trim().toLowerCase();
    const limit = Number(a.vaultLimit) > 0 ? Math.min(Math.floor(Number(a.vaultLimit)), 500) : 50;
    let rows = Array.isArray(vl.snapshot?.keywords) ? vl.snapshot.keywords : [];
    if (cat) {
      rows = rows.filter((k) => (Array.isArray(k.groups) ? k.groups : [])
        .some((g) => String(g || "").toLowerCase() === cat)
        || String(k.group || "").toLowerCase() === cat);
    }
    vaultRows = rows.slice(0, limit).map((k) => ({
      term: String(k.term || "").trim(),
      // 🔴 真实快照写的是旧名 `hits`，新名是 `rootCount`（G-6 留了别名）。两个都认，
      //    否则老快照上的 rootCount 会全变成 0，排序与「由几个词根带出」全错。
      rootCount: Number(k.rootCount ?? k.hits ?? 0) || 0,
      groups: Array.isArray(k.groups) ? k.groups : [],
    })).filter((k) => k.term);
    vault.ok = true;
    vault.reason = "ok";
    vault.category = cat || null;
    vault.limit = limit;
    vault.matched = rows.length;
    vault.used = vaultRows.length;
  } else {
    vault.error = vl.error;
  }

  // ③ user 词优先、vault 词去重后追加。三张表只记来源，判定仍然交给 analyzeCoverage。
  const origin = new Map();    // 小写词 → "user" | "vault"
  const rootOf = new Map();    // 小写词 → rootCount（仅 vault 词有）
  const groupsOf = new Map();  // 小写词 → groups（仅 vault 词有）
  const merged = [];
  const seen = new Set();
  for (const t of userWords) {
    const s = String(t).trim();
    if (!s || s.length < 2) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); merged.push(s); origin.set(k, "user");
  }
  for (const v of vaultRows) {
    const k = v.term.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); merged.push(v.term); origin.set(k, "vault");
    rootOf.set(k, v.rootCount); groupsOf.set(k, v.groups);
  }

  // ④ 用合并后的词跑**同一份** analyzeCoverage。top 放大到合并词数以上，
  //    否则新并进来的词会被默认 30 截掉（覆盖度算的就不是你看到的那一批）。
  const r = analyzeCoverage(listingOf(a), {
    keywords: merged,
    competitors: a.competitors,
    top: Math.max(merged.length + 100, Number(a.top) || 30),
  });
  // 竞品语料挖出来的 mined 词也在 r.rows 里，但覆盖率只按「我并进来的词」算。
  const mergedRows = r.rows.filter((x) => origin.has(String(x.term).toLowerCase()));
  const covered = mergedRows.filter((x) => x.score > 0).length;
  const total = mergedRows.length;

  // ⑤ coverageUser / coverageVault **分开两个数**，绝不混算。
  //    判定用的是同一份 r.rows[].score，只按来源分组，不是另写一套覆盖判定。
  const scoreOf = new Map(mergedRows.map((x) => [String(x.term).toLowerCase(), x.score]));
  const coverageOf = (src) => {
    const keys = [...origin].filter(([, v]) => v === src).map(([k]) => k);
    const c = keys.filter((k) => (scoreOf.get(k) || 0) > 0).length;
    return { covered: c, total: keys.length, pct: keys.length ? Math.round((c / keys.length) * 100) : 0 };
  };
  const cu = coverageOf("user");
  const cv = coverageOf("vault");

  // ⑥ 每条 gap 带 from / rootCount / groups / missingIn，按「rootCount × 未覆盖」排序：
  //    词库词由几个词根带出 → 越靠前越该先看；user 词没有 rootCount，垫底。
  const gapRows = mergedRows
    .filter((x) => x.score === 0)
    .map((x) => {
      const k = String(x.term).toLowerCase();
      const from = origin.get(k) || "user";
      return {
        term: x.term,
        from,
        rootCount: from === "vault" ? (rootOf.get(k) ?? 0) : null,
        groups: from === "vault" ? (groupsOf.get(k) || []) : [],
        missingIn: Object.entries(x.hit || {}).filter(([, hit]) => !hit).map(([f]) => f),
      };
    })
    .sort((p, q) => (q.rootCount || 0) - (p.rootCount || 0) || p.term.localeCompare(q.term));

  // 🔴 零行为变更（团队驳回「无词库降形」后定稿）：gaps **恒为对象数组**，
  //    与 vault.ok 无关 —— 空词库时 mergedRows 里只剩 user 词，映射出来的仍是
  //    {term,from,rootCount,groups,missingIn} 对象（from 全 user、rootCount 全 null、groups 空：
  //    信息本来就没有，不丢东西）。同一个 useVault 参数只对应一种形状，调用方只写一套解析。
  //    🔴 默认（不传 useVault）分支走 legacyCoverage，**不带 gapShape**、gaps 是字符串数组，
  //       逐字节不变 —— 这条硬验收不能为了「统一」而动它。
  const gaps = gapRows;

  return {
    coveragePct: total ? Math.round((covered / total) * 100) : 0,
    covered,
    total,
    gaps,
    // 🔴 恒值 "objects"：useVault 模式下 gaps 恒为对象数组，返回体自己说明形状（S-2 契约自证），
    //    无论词库可用与否都一样；与上面的 gaps 实际形状永远一致，调用方不必按 vault.ok 分流。
    gapShape: "objects",
    minedGaps: r.minedGaps,
    weak: mergedRows.filter((x) => x.priority === 2).map((x) => x.term),
    unused: mergedRows.filter((x) => x.priority === 3 && x.score === 0).map((x) => x.term),
    competitorProvided: r.competitorProvided,
    competitorNames: r.competitorNames,
    summary: {
      coverageUser: cu.pct,
      coverageVault: cv.pct,
      userTotal: cu.total,
      userCovered: cu.covered,
      vaultTotal: cv.total,
      vaultCovered: cv.covered,
      mergedTotal: total,
      mergedCovered: covered,
      // 🔴 两个覆盖率各自除以自己的分母，之和不等于混合覆盖率：混成一个数就会得出错误结论。
      note: "coverageUser / coverageVault 分别按本组候选词计算覆盖率，不是把 user 与 vault 两类词混算成一个数。",
    },
    vault,
    note: r.note,
    metricNote: "coveragePct 是按字段权重算的加权覆盖率，不是「有多少词出现过」。",
    // 🔴 文案也写清「恒值」，让人读文本就能看到 gapShape 自证，不靠解析返回体猜。
    vaultNote: "useVault 模式下 gaps 恒为对象数组（带 from / rootCount / groups / missingIn），gapShape 字段自证形状；默认模式 gaps 仍是字符串数组。"
      + "词库有无不改形状：无词库时这些对象里 from 全是 user、rootCount 全是 null、groups 空（信息本来就没有，不丢东西），"
      + "调用方按 useVault 只写一套解析即可。词库来自 readLatest() 的只读快照，rootCount 是词根覆盖广度，不是搜索量。",
  };
}

/* ── 参数校验：表驱动（P2#3）──────────────────────────────────────────
 * 改动前是 5 个平行的 `if (want === "number" && got !== "number") ...`，
 * 加一种约束就要再插一个 if，boolean 还**根本没校验**（isMedia/includeNgrams 是漏的）。
 * 现在类型判定收进一张表，约束（enum / minimum / maximum / maxItems）走另一张循环：
 * 新增类型只加一行 VALIDATORS，新增约束只加一段，不用碰分支结构。
 *
 * 🔴 报错文案是**契约**，不是随便写给人看的：自检断言 `/应为 array/`、`/缺少必填参数：text/`，
 *    验收还要求 "应为 number"、超出 maximum 时消息里带上限值。改文案＝改断言，别顺手润色。
 */
export const VALIDATORS = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number",
  array: (v) => Array.isArray(v),
  object: (v) => typeof v === "object" && !Array.isArray(v),
  boolean: (v) => typeof v === "boolean",
};

/** 类型名：与旧口径一致（数组算 array，null 归 object），只用于报错里的「实际」。 */
const typeNameOf = (v) => (Array.isArray(v) ? "array" : typeof v);

export function checkArgs(tool, args) {
  const schema = tool.inputSchema || {};
  for (const key of schema.required || []) {
    if (args[key] === undefined || args[key] === null || args[key] === "") {
      throw new Error(`缺少必填参数：${key}`);
    }
  }
  for (const [key, spec] of Object.entries(schema.properties || {})) {
    const v = args[key];
    if (v === undefined) continue;
    const want = spec.type;
    const validate = VALIDATORS[want];
    if (validate && !validate(v)) {
      throw new Error(`参数 ${key} 应为 ${want}，实际 ${typeNameOf(v)}`);
    }
    // 约束校验：只在类型对得上时才有意义，所以放在类型判定之后。
    if (Array.isArray(spec.enum) && !spec.enum.includes(v)) {
      throw new Error(`参数 ${key} 应为以下之一：${spec.enum.join(" / ")}，实际 ${String(v)}`);
    }
    if (typeof spec.minimum === "number" && typeof v === "number" && v < spec.minimum) {
      throw new Error(`参数 ${key} 不能小于下限 ${spec.minimum}，实际 ${v}`);
    }
    if (typeof spec.maximum === "number" && typeof v === "number" && v > spec.maximum) {
      throw new Error(`参数 ${key} 超过上限 ${spec.maximum}，实际 ${v}`);
    }
    if (typeof spec.maxItems === "number" && Array.isArray(v) && v.length > spec.maxItems) {
      throw new Error(`参数 ${key} 最多 ${spec.maxItems} 项，实际 ${v.length} 项`);
    }
  }
  return args;
}

/* ─────────────────────── 协议处理 ─────────────────────── */

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

/**
 * tools/list 里的**对外契约**（P2#1 / P2#2）。
 * 🔴 不写进 TOOLS 定义：TOOLS 是内部实现（带 run 函数），describeTool 才是协议体。
 *    🔴 描述文本一个字都不改 —— 自检按字节数卡「单条 ≤750 / 合计 ≤6000」，
 *       加字段可以，改描述会把 8 条选择回归与四段式断言一起打红。
 */
export function describeTool(t) {
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      // 只有 amazon_suggest 真的出网；其余 7 个都是纯本地判断。
      openWorldHint: t.name === "amazon_suggest" ? true : false,
    },
    outputSchema: { type: "object" },
  };
}

/**
 * 🔴 唯一的处理函数：stdio 与 HTTP **都调它**，返回 `Promise<response|null>`，
 *    null = 通知 / 不需要回包。它自己**不写 stdout**、不碰 socket —— 传输层负责发。
 *    两条链路 tools/list 逐字节相同靠的就是这一点：同一个函数、同一份 TOOLS、
 *    同一个 JSON.stringify。日志只走 stderr（log），HTTP 进程里也不污染 stdout。
 */
export function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      return Promise.resolve(ok({
        protocolVersion: negotiateProtocol(asked),
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      }));
    }
    // 2026-07-28 的发现入口。没有它，新客户端拿不到 supportedVersions，只能盲目试 initialize。
    case "server/discover":
      return Promise.resolve(ok({
        supportedVersions: SUPPORTED_PROTOCOLS,
        capabilities: { tools: {} },
        instructions: INSTRUCTIONS,
        ttlMs: 300000,
        cacheScope: "public",
        resultType: "complete",
        _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
      }));

    case "notifications/initialized":
    case "notifications/cancelled":
      return Promise.resolve(null); // 通知不需要回包

    case "ping":
      return Promise.resolve(isNotification ? null : ok({}));

    case "tools/list":
      return Promise.resolve(ok({ tools: TOOLS.map(describeTool) }));

    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments || {};
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        return Promise.resolve(ok({
          content: [{ type: "text", text: `没有这个工具：${name}。可用：${TOOLS.map((t) => t.name).join(", ")}` }],
          isError: true,
        }));
      }
      let out;
      try {
        out = tool.run(checkArgs(tool, args));
      } catch (e) {
        return Promise.resolve(ok({ content: [{ type: "text", text: `参数有问题：${e.message}` }], isError: true }));
      }
      return Promise.resolve(out).then((r) => {
        const text = JSON.stringify(r, null, 2);
        const result = { content: [{ type: "text", text }], isError: false };
        // P2#2：structuredContent 必须与 content[0].text 的 JSON 解析结果**深相等**。
        //        用同一份 text 反解，天然相等（不会因为 r 里某个 undefined 字段而漂移）。
        //        content 仍保留文本 JSON —— 老客户端只读 content，行为不变。
        //        isError:true 的工具级错误文本不是 JSON，按规范不给 structuredContent。
        if (typeof text === "string") {
          try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) result.structuredContent = parsed;
          } catch { /* 返回值不是 JSON 对象：不给 structuredContent，绝不猜 */ }
        }
        return ok(result);
      }).catch((e) => {
        log(`tools/call ${name} 失败：${e.message}`);
        return ok({ content: [{ type: "text", text: `执行失败：${e.message}` }], isError: true });
      });
    }

    // 客户端可能顺手探测这些；不实现也要给个空结果，否则它会以为服务坏了
    case "resources/list":
      return Promise.resolve(ok({ resources: [] }));
    case "prompts/list":
      return Promise.resolve(ok({ prompts: [] }));

    default:
      return Promise.resolve(isNotification ? null : fail(-32601, `未实现的方法：${method}`));
  }
}

/* ─────────────────────── stdio 主循环 ─────────────────────── */

if (!HTTP_IMPORT) {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try {
      msg = JSON.parse(s);
    } catch {
      log("收到非 JSON 的一行，已忽略（stdout 协议通道不受影响）");
      return;
    }
    // handle() 返回 Promise；用一条链同时兜住同步抛错与异步 reject。
    Promise.resolve()
      .then(() => handle(msg))
      .then((res) => { if (res) send(res); })
      .catch((e) => {
        log(`处理 ${msg?.method} 时抛错：${e.message}`);
        if (msg?.id !== undefined) {
          send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: e.message } });
        }
      });
  });
  rl.on("close", () => process.exit(0));
  log(`ready（工具 ${TOOLS.length} 个，联网=${NO_NET ? "off" : "on"}）`);
}
