#!/usr/bin/env node
/**
 * 回归自检。
 *
 * 存在意义：本项目的核心主张是「规则用代码算，不靠模型自觉」。
 * 那就必须能被机器证明 —— 每条铁律、每个约束都要有断言。
 * 断言的对象是**行为**（输出的 Prompt 里到底有没有那串约束），不是实现细节。
 *
 * 运行：node tools/selftest.mjs
 */

import { strict as assert } from "node:assert";
import { checkAssertCount } from "./assert-count.mjs";
import { crc32 } from "node:zlib";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  TEMPLATES, TEMPLATE_LIST, matchTemplate, diagnoseConversionDriver, detectCategory,
  composePrompt, composeImg2ImgPrompt, planImagePack, auditPlan, assignAngles,
  buildStyleLock, hexify, infoArchitecture, negativeConstraints, FIGURE_SPEC,
  detectLang, AMAZON_MAIN_IMAGE, SLOTS, PROMPT_MAX_CHARS, SIZE_BY_FIGURE,
  detectScript, LANG_SUPPORT,
  scoreTemplate, TEMPLATE_ALIASES, CATEGORY_TEMPLATE_AFFINITY, TEMPLATE_FIGURE, figureForTemplate,
  RATIO_PIXELS, PIXEL_TO_RATIO, toRatioText,
  SYNC_CANVAS, syncCanvasFor, resolveSendSize,
} from "../assets/prompt-engine.js";
import {
  mineKeywords, buildSearchTerms, lintListing, generateListingDraft, byteLength, LIMITS, RULES,
  PROMO_WORDS, BAD_SYMBOLS, CLAIM_WORDS, DISEASE_TERMS, PESTICIDE_CLAIMS, ENV_CLAIMS,
  SELF_EVIDENT_CLAIMS, CATEGORY_CLAIMS, findHtmlMarkers, matchWords,
  exportListingFields, exportFlatFileCsv, AMAZON_FIELDS, BENEFIT_WORDS_ZH, precheckForUpload,
  analyzeCoverage, hasTerm, FIELD_WEIGHT, normalizeCompetitors, compareCompetitors,
  STOPWORDS_BY_LANG, SITE_LANG, stopwordsFor, quantityText,
  // 2026-07-27 标题新规相关
  titleLimit, SUBJECTIVE_TITLE_WORDS, OFF_SITE_PATTERNS, SOFT_CONTACT_PATTERNS,
} from "../assets/listing.js";
// P2#10：CSV 导出 / 解析（浏览器与 Node 共用同一份纯函数）。
import { toCsv, parseCsv, looksLikeFormula, parseRecords, sniffDelimiter } from "../assets/csv.js";
// 2026-11 P2 三项：A+ 骨架 / 批量质检 / 竞品 CSV 导入。
import { buildAplusPlan, aplusToText, lintAplusText, APLUS_MODULES, APLUS_BUDGET, APLUS_NOTE } from "../assets/aplus.js";
import { parseBatch, batchLint, batchCsv, BATCH_MAX } from "../assets/batch-lint.js";
import { importKeywordCsv, parseVolume, detectColumns, keywordList, withVolumes, CSV_MAX_ROWS } from "../assets/csv-import.js";
import {
  extractAny, bookmarkletSource, detectSite, SELECTORS, SITES, siteLang,
  decodeEntities, detectPageKind, extractSearchResults,
  searchItemsToCompetitors, searchItemsCorpus, searchItemsSummary,
  productToWorkbenchInput, diffSnapshots,
} from "../assets/amazon.js";
import { renderMarkdown, escapeHtml } from "../assets/md.js";
import { extractSubject, runLocalTurn, parseRatio, isNegative, isGenerateIntent, isPackIntent, packPayload } from "../assets/orchestrator.js";
import { probeCacheFresh, PROBE_TTL_MS, PROBE_TTL_FAIL_MS } from "../assets/api.js";
import {
  buildZip, inspectZip, assertZipWithinLimits, MAX_ENTRIES, MAX_BYTES,
} from "../assets/zip.js";
import {
  fingerprint, trimPayload, makeRecord, sortRecords, pickEvictions,
  formatSize, summarize, isValidKind, KINDS, MAX_PAYLOAD_CHARS, MAX_RECORDS_PER_KIND,
  isAvailable as storeAvailable, save as storeSave, list as storeList,
  get as storeGet, stats as storeStats, remove as storeRemove, clear as storeClear,
  toExport as storeExport, importFrom as storeImport, EXPORT_SCHEMA,
} from "../assets/store.js";
// 2026-11 新增的四块纯函数（健康分 / 评论分析 / 成图体检 / 趋势图）。
// 🔴 全部是纯函数，所以能在 Node 里直接测，不需要浏览器 —— 这是把它们单独成文件的另一个原因。
import { scoreListing, SCORE_DIMS, SCORE_TOTAL_WEIGHT, SCORE_CAP, gradeOf } from "../assets/score.js";
import { analyzeReviews, reviewsFromPayload, REVIEW_ASPECTS, REVIEW_SAMPLE_MIN } from "../assets/reviews.js";
import { auditPixels, auditFileMeta, combineAudit, IMAGE_RULES } from "../assets/image-audit.js";
import { sparklinePath, seriesDigest, seriesOf, normalizeSnapshot } from "../assets/snapshots.js";
// Rufus 生产入口：用命名空间导入（不是具名 import）—— 这样即使某个导出（如 termRanges）还没落地，
// 也只是该字段为 undefined，不会因为"具名导出不存在"让整个 selftest.mjs 在加载期崩溃。
import * as RUFUS_FACTS from "../assets/rufus-facts.js";
import * as RUFUS from "../assets/rufus.js";
// ⑦ 竞品关键词 → 文案提示词（模块二）。三个模块分工固定：
//   bestsellers（抓取 + 出网白名单）/ competitor-keywords（纯算法）/ copy-prompts（纯拼装）
import * as BEST from "../assets/bestsellers.js";
const { MAX_PAGES } = BEST;
import * as CKW from "../assets/competitor-keywords.js";
import * as CPROMPT from "../assets/copy-prompts.js";
// Rufus 数据地基（纯数据、零 import）；其余 rufus 逻辑文件的断言待实现落地后补。
import {
  CATEGORY_ATTRIBUTES, CATEGORY_QUESTIONS, UNIT_GROUPS, MATERIAL_CONFLICTS, NUMBER_UNIT_RE,
} from "../assets/rufus-data.js";

/**
 * 仓库根目录。
 * 🔴 定义必须放在文件**顶部**：多个小节都要用它读源码做静态断言，而 `const` 在同一模块内
 *    是有 TDZ 的 —— 定义在文件中部的话，排在它前面的测试一引用就直接 ReferenceError。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 去掉整行注释后的源码，专供静态断言。
 *
 * 🔴 为什么需要它：项目里的注释大量使用"反面教材"写法 ——
 *    `// 不能写 import { crc32 } from "node:zlib"`、
 *    `// 原来这里有一份 RATIO_OF_PIXELS`。
 *    直接对原文做正则，会被这些**解释缺陷的注释**判成缺陷仍然存在，
 *    于是"修好了反而红"，人会开始怀疑断言而不是代码。
 */
const codeOf = (src) => String(src)
  .split(/\r?\n/)
  .filter((line) => {
    const s = line.trim();
    return s && !s.startsWith("//") && !s.startsWith("*") && !s.startsWith("/*");
  })
  .join("\n");

// 三个源码快照也一律放顶部，理由同 ROOT（2026-09-29 又栽了一次：新的「标题新规」小节
// 排在前面，一引用 HTML/APP 就 ReferenceError。与其每次把断言挪来挪去，
// 不如让"做静态断言用的源码快照"从一开始就全部就位）。
const HTML = readFileSync(path.join(ROOT, "index.html"), "utf8");
const APP = readFileSync(path.join(ROOT, "assets/app.js"), "utf8");

let pass = 0, fail = 0;
const failures = [];
function t(name, fn, tag) {
  try {
    fn();
    pass++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (e) {
    fail++;
    // tag：标记「已知未修闸门」（如 G4 / B3）。带 tag 的失败进「已知闸门」栏，
    // 无 tag 的失败一律进「其它失败」栏 = 新增回归。修好前禁止用 skip / 放宽 / 移出本文件的方式变绿。
    failures.push({ name, msg: e.message, tag });
    process.stdout.write(`  ✗ ${name}\n      ${e.message.split("\n")[0]}\n`);
  }
}
const section = (s) => process.stdout.write(`\n${s}\n`);
/** 异步版 t：给「浏览器专属能力在 Node 下的降级路径」用（例如 IndexedDB）。 */
async function ta(name, fn) {
  try {
    await fn();
    pass++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (e) {
    fail++;
    failures.push({ name, msg: e.message });
    process.stdout.write(`  ✗ ${name}\n      ${e.message.split("\n")[0]}\n`);
  }
}

/* ─────────────── 1. 模板数据 ─────────────── */
section("1. 模板数据（25 个，来自参考仓自动生成）");

t("模板数量为 25", () => assert.equal(TEMPLATE_LIST.length, 25));
t("每个模板字段齐全", () => {
  const REQUIRED = ["id", "name", "keywords", "trigger_phrases", "prompt_template", "defaults", "variants", "category_tips", "examples", "anti_ai_tips", "supports_image_reference"];
  for (const tpl of TEMPLATE_LIST) {
    for (const k of REQUIRED) assert.ok(k in tpl, `${tpl.id} 缺字段 ${k}`);
  }
});
t("order 序号 01..25 连续且唯一", () => {
  const orders = TEMPLATE_LIST.map((x) => x.order);
  assert.deepEqual(orders, [...Array(25)].map((_, i) => String(i + 1).padStart(2, "0")));
});
t("每个模板至少 3 个风格变体且带 overrides", () => {
  for (const tpl of TEMPLATE_LIST) {
    const vs = Object.values(tpl.variants || {});
    assert.ok(vs.length >= 3, `${tpl.id} 变体只有 ${vs.length} 个`);
    for (const v of vs) assert.ok(v.overrides && typeof v.overrides === "object", `${tpl.id} 的变体缺 overrides`);
  }
});
t("每个模板至少 2 个示例", () => {
  for (const tpl of TEMPLATE_LIST) assert.ok((tpl.examples || []).length >= 2, `${tpl.id} 示例不足`);
});

/* ─────────────── 2. 模板匹配 ─────────────── */
section("2. 模板匹配");

const MATCH_CASES = [
  ["帮我做一张白底主图", "hero-image"],
  ["设计一款咖啡杯的小红书氛围图", "social-media"],
  ["做一个护肤品的详情页信息图", "infographic"],
  ["给我一张买家秀风格的照片", "ugc-style"],
  ["来一张产品的爆炸图", "exploded-view"],
  ["做一张促销海报 banner", "poster-banner"],
  ["平铺俯拍摆拍图", "flat-lay"],
  ["直播间场景图", "livestream"],
  // 服装类：曾经 100% 回落到白底主图（词表里没有任何服装词）
  ["给这件黑色T恤做一张图", "ghost-mannequin"],
  ["不露脸展示服装的隐形模特图", "ghost-mannequin"],
  ["模特上身展示这件衣服", "model-showcase"],
];
for (const [q, want] of MATCH_CASES) {
  t(`「${q}」→ ${want}`, () => assert.equal(matchTemplate(q).id, want));
}
t("完全无关的输入回落 hero-image", () => assert.equal(matchTemplate("zzz qqq").id, "hero-image"));
t("显式指定优先于关键词", () => assert.equal(matchTemplate("白底主图", "livestream").id, "livestream"));

/* ── 自动匹配（第二版）：别名层 / 上下文 / 多级回落 / 并列候选 ──
 * 🔴 这一组断言对应 2026-09-29 的一次真实用户反馈：「要自动匹配，别让我每次手选模板」。
 *    实测发现旧实现虽然"已经是自动的"，但它是**聋的** —— 只从当轮文本里找最长子串，
 *    既不接同一轮自己刚算出来的品类，也没有任何回落策略，服装类需求全被丢给白底主图。
 */

t("服装类词必须能命中某个模板（曾经 T恤/衣服/tee/shirt/apparel 全部 0 命中）", () => {
  const GARMENT = ["T恤", "衣服", "tee", "shirt", "apparel", "garment", "clothing"];
  for (const w of GARMENT) {
    const hit = TEMPLATE_LIST.some((tpl) => {
      const al = TEMPLATE_ALIASES[tpl.id] || {};
      const pool = [
        ...(tpl.keywords || []), ...(tpl.trigger_phrases || []),
        ...(al.zh || []), ...(al.en || []),
      ];
      return pool.some((k) => String(k).toLowerCase().includes(w.toLowerCase()));
    });
    assert.ok(hit, `「${w}」在全部 25 个模板（含别名层）里仍然 0 命中`);
  }
});

t("服装类需求不再被丢给白底主图", () => {
  const QS = [
    "给这件黑色T恤做一张图",
    "帮我生成一款关于黄色鸭子的logo印在黑色衣服的T恤上",
    "这件衬衫怎么拍",
  ];
  for (const q of QS) {
    const m = matchTemplate(q);
    assert.notEqual(m.id, "hero-image", `「${q}」又回落白底主图了`);
    assert.equal(m.source, "keyword", `「${q}」应当是词命中，实际 ${m.source}`);
  }
});

t("别名层的权重夹在 keyword 与 trigger_phrase 之间（不能压掉上游词表）", () => {
  // 两句都只靠别名层区分：「模特上身」（4 字）比「衣服」（2 字）更具体
  assert.equal(matchTemplate("模特上身展示这件衣服").id, "model-showcase");
  assert.equal(matchTemplate("不露脸展示服装的隐形模特图").id, "ghost-mannequin");
});

t("🔴 上下文接管：无词命中时按品类选图型，而不是无脑回落白底主图", () => {
  const q = "给这款宠物自动喂食器做一整套图";
  assert.equal(matchTemplate(q).source, "fallback", "先确认纯文本下它确实没有任何词命中");
  const m = matchTemplate(q, { context: { category: "pet" } });
  assert.equal(m.source, "context", "有品类时应当由上下文接管");
  assert.notEqual(m.id, "hero-image", "宠物品类不该还是白底主图");
  assert.ok(CATEGORY_TEMPLATE_AFFINITY.pet.includes(m.id), `选出的「${m.id}」不在 pet 的亲和表里`);
});

t("上下文不能推翻用户明说的词（品类是 fashion 也不改判「促销海报」）", () => {
  const m = matchTemplate("做一张促销海报", { context: { category: "fashion" } });
  assert.equal(m.id, "poster-banner");
  assert.equal(m.source, "keyword");
});

t("有参考图时偏向「吃参考图」的模板，hero-image 不参与加分", () => {
  const ctx = { category: "electronics" };
  const noRef = matchTemplate("蓝牙耳机怎么拍", { context: ctx });
  const withRef = matchTemplate("蓝牙耳机怎么拍", { context: { ...ctx, hasReference: true } });
  assert.equal(noRef.id, "infographic");
  assert.equal(withRef.id, "device-mockup", "有参考图时应当偏向能吃参考图的模板");
});

t("彻底无线索时回落 01-hero-image，并如实说明是兜底（不假装匹配上了）", () => {
  const m = matchTemplate("zzz qqq");
  assert.equal(m.id, "hero-image");
  assert.equal(m.source, "fallback");
  assert.ok(/兜底|回落/.test(m.reason), "reason 里要说清这是兜底");
  assert.equal(m.matched, null, "没命中就不该编一个 matched 出来");
});

t("并列候选：降序、不含自己、分数为正", () => {
  const m = matchTemplate("给这件黑色T恤做一张图", { context: { category: "fashion" } });
  assert.ok(m.candidates.length > 0, "服装类输入应当有备选模板");
  assert.ok(!m.candidates.some((c) => c.id === m.id), "候选里不该出现第一名自己");
  for (let i = 1; i < m.candidates.length; i++) {
    assert.ok(m.candidates[i - 1].score >= m.candidates[i].score, "候选必须按分数降序");
  }
  assert.ok(m.candidates.every((c) => c.score > 0), "0 分的模板不该进候选");
});

t("🔴 排序键顺序：词长 > 位置 > 词权重（把权重当主排序键会判错模板）", () => {
  // 「直播间场景图」：lifestyle-scene 的 trigger_phrase「场景图」权重更高（+6），
  // 但正确答案是句首的「直播间」。第一版实现把权重加进主排序键，这里当场判成 lifestyle-scene。
  const m = matchTemplate("直播间场景图");
  assert.equal(m.id, "livestream");
  assert.equal(m.matched, "直播间", "主证据应当是句首的「直播间」，不是后面的「场景图」");
});

t("scoreTemplate 是纯函数，且把「凭什么选它」摊开成 signals", () => {
  const s = scoreTemplate(TEMPLATES["ghost-mannequin"], "给这件黑色t恤做一张图", { category: "fashion" });
  assert.ok(s.termScore > 0);
  assert.equal(s.ctxScore, 6, "fashion 是 ghost-mannequin 的亲和品类");
  assert.equal(s.total, s.termScore + s.ctxScore);
  assert.ok(s.signals.some((x) => x.includes("t恤")), "signals 里要能看出命中了哪个词");
  assert.ok(s.signals.some((x) => x.includes("fashion")), "signals 里要能看出上下文加成");
  assert.equal(
    scoreTemplate(TEMPLATES["ghost-mannequin"], "给这件黑色t恤做一张图", {}).ctxScore, 0,
    "不传上下文时 ctxScore 必须为 0（保证纯文本口径与旧行为一致）",
  );
});

t("旧的字符串第二参数（显式指定）必须继续可用", () => {
  assert.equal(matchTemplate("白底主图", "livestream").id, "livestream");
  assert.equal(matchTemplate("白底主图", { explicitId: "livestream" }).id, "livestream");
  assert.equal(matchTemplate("白底主图", "livestream").source, "explicit");
  assert.equal(matchTemplate("白底主图", "livestream").auto, false);
  assert.equal(matchTemplate("白底主图").auto, true, "不指定时必须处于自动模式");
});

t("每个模板都有图型归属（别再出现「25 个模板只认 2 个」）", () => {
  const missing = TEMPLATE_LIST.filter((x) => !TEMPLATE_FIGURE[x.id]).map((x) => x.id);
  assert.deepEqual(missing, [], `这些模板没有图型映射：${missing.join(", ")}`);
  for (const tpl of TEMPLATE_LIST) {
    assert.ok(FIGURE_SPEC[figureForTemplate(tpl.id)], `${tpl.id} 映射到了一个不存在的图型`);
  }
  assert.equal(figureForTemplate("infographic"), "pdp");
  assert.equal(figureForTemplate("poster-banner"), "feedAd");
  assert.equal(figureForTemplate("lifestyle-scene"), "scene");
  assert.equal(figureForTemplate("ghost-mannequin"), "hero", "隐形模特是干净背景展示产品本体，贴 hero 口径");
  assert.equal(figureForTemplate("不存在的模板"), "benefit", "未列入的模板回落 benefit（与历史行为一致）");
});

t("没识别出驱动力时不许把它当匹配依据（源码级：兜底不能被当成证据）", () => {
  const src = readFileSync(path.join(ROOT, "assets/orchestrator.js"), "utf8");
  assert.match(
    src, /driver\.confidence > 0 \? driver\.driver : null/,
    "把 diagnoseConversionDriver 兜底返回的 visual 直接当成了上下文证据",
  );
});

t("乱码输入的简报不许声称有上下文依据（行为级：说假话比报错更伤）", () => {
  const evs = [];
  const r = runLocalTurn({ message: "zzz qqq", onEvent: (e) => evs.push(e) });
  const mt = evs.find((e) => e.type === "tool_result" && e.name === "match_template");
  assert.ok(mt, "没有发出 match_template 事件");
  assert.equal(r.templateId, "hero-image");
  assert.ok(!/驱动常用图型/.test(mt.content), `乱码输入却报出了上下文依据：\n${mt.content}`);
  assert.match(mt.content, /兜底|回落/, "应当如实说明这是兜底");
});

t("orchestrator 真的把上下文喂给了匹配器（不是只改了签名）", () => {
  const src = readFileSync(path.join(ROOT, "assets/orchestrator.js"), "utf8");
  assert.match(src, /matchTemplate\(message,\s*\{[\s\S]{0,240}?context:\s*\{/, "没把 context 传给 matchTemplate");
  assert.match(
    src, /detectCategory\(message\)[\s\S]{0,400}?matchTemplate\(/,
    "品类必须在模板匹配**之前**算出来，否则上下文永远是空的",
  );
  assert.ok(!/tpl\.id === "hero-image" \? "hero"/.test(src), "又回到「只认两个模板」的图型三元表达式");
});

t("显式模板通道在两条路径上都接通了（浏览器直连 / 服务端 SSE）", () => {
  const app = readFileSync(path.join(ROOT, "assets/app.js"), "utf8");
  const api = readFileSync(path.join(ROOT, "assets/api.js"), "utf8");
  const srv = readFileSync(path.join(ROOT, "server.mjs"), "utf8");
  assert.match(app, /explicitTemplateId: null/, "默认值必须是 null（＝自动匹配）");
  assert.match(app, /S\.explicitTemplateId = null;\s*\n\s*renderTplLock\(\);/, "用完必须清掉，否则自动匹配会被静默覆盖");
  assert.match(api, /templateId/, "api.js 没把 templateId 带上");
  assert.match(srv, /explicitTemplateId/, "server.mjs 没接 templateId");
});

/* ─────────────── 3. 转化驱动力诊断 ─────────────── */
section("3. 转化驱动力诊断");

t("痛点词 → pain", () => assert.equal(diagnoseConversionDriver("解决漏水堵塞、反复清理很麻烦").driver, "pain"));
t("视觉词 → visual", () => assert.equal(diagnoseConversionDriver("高级质感的礼物，外观精致好看").driver, "visual"));
t("情绪词 → emotion", () => assert.equal(diagnoseConversionDriver("给孩子陪伴和安全感，亲子仪式感").driver, "emotion"));
t("无命中 → 默认 visual 且置信度 0", () => {
  const d = diagnoseConversionDriver("asdfghjkl");
  assert.equal(d.driver, "visual");
  assert.equal(d.confidence, 0);
});
t("三种驱动力都给出推进顺序", () => {
  for (const s of ["好看质感", "解决漏水", "陪伴安全感"]) assert.ok(diagnoseConversionDriver(s).order.length > 10);
});

/* ─────────────── 4. 品类 & 颜色 ─────────────── */
section("4. 品类识别与铁律 1（颜色 hex 化）");

t("识别宠物品类", () => assert.equal(detectCategory("宠物自动喂食器 for cat").category, "pet"));
t("识别电子品类", () => assert.equal(detectCategory("蓝牙耳机 earbud").category, "electronics"));
t("未识别返回 null", () => assert.equal(detectCategory("qwerty").category, null));
t("形容词被换成 hex", () => {
  const r = hexify("白底 + 金色点缀 + 深绿色背景");
  assert.ok(r.text.includes("#FFFFFF"), "白底未换成 #FFFFFF");
  assert.ok(r.text.includes("#D4AF37"), "金色未换成 #D4AF37");
  assert.ok(r.text.includes("#1A3A2E"), "深绿未换成 #1A3A2E");
  assert.equal(r.applied.length, 3);
});
// 🔴 铁律 1 最容易露馅的地方：颜色表只覆盖 beige/sage/navy 这类设计色名，
//    漏掉最常用的通用色词 → 用户写"高级灰背景"，Prompt 里留着中文形容词，铁律 1 当场失效。
t("通用中文色词也能换（灰/黑/红/蓝/绿/橙/粉/黄/棕/紫）", () => {
  const r = hexify("高级灰背景 + 黑色阴影 + 红色点缀 + 蓝色 + 绿色 + 橙色 + 粉色 + 黄色 + 棕色 + 紫色");
  for (const hex of ["#888888", "#111111", "#C0392B", "#12243A", "#7A9E7E", "#D97706", "#E8B4B8", "#E8C547", "#7B5540", "#6B4E8F"]) {
    assert.ok(r.text.includes(hex), `缺 ${hex}：${r.text}`);
  }
});
t("英文色词也能换", () => {
  const r = hexify("black background with dark gray shadows, pure white studio");
  assert.ok(r.text.includes("#111111"), r.text);
  assert.ok(r.text.includes("#2D2D2D"), r.text);
  assert.ok(r.text.includes("#FFFFFF"), r.text);
});
t("同一色词出现多次要全换（不是只换第一处）", () => {
  const r = hexify("深灰文字配深灰线条");
  assert.ok(!r.text.includes("深灰"), `只换了第一处：${r.text}`);
  assert.equal(r.applied.length, 2);
});
t("单字色词不误伤产品描述（金属/粉末/网红/黑科技）", () => {
  const r = hexify("金属质感拉丝面板，纳米粉末涂层，网红同款，黑科技机身");
  assert.ok(r.text.includes("金属"), `误伤金属：${r.text}`);
  assert.ok(r.text.includes("粉末"), `误伤粉末：${r.text}`);
  assert.ok(r.text.includes("网红"), `误伤网红：${r.text}`);
  assert.ok(r.text.includes("黑科技"), `误伤黑科技：${r.text}`);
  assert.equal(r.applied.length, 0);
});
t("米白不会被「白色」规则吃掉", () => {
  const r = hexify("米白色底");
  assert.ok(r.text.includes("#FAF7F2"), r.text);
  assert.ok(!r.text.includes("#FFFFFF"), r.text);
});
t("已用 hex 的文本不被二次改写", () => {
  const r = hexify("background #FFFFFF");
  assert.ok(r.text.includes("#FFFFFF"));
});

/* ─────────────── 5. Prompt 组装：六条铁律 ─────────────── */
section("5. Prompt 组装 —— GPT-Image-2 六条铁律逐条断言");

const lock = buildStyleLock({});
const c = composePrompt({ subject: "brushed stainless steel water bottle", templateId: "hero-image", figure: "hero", styleLock: lock, headline: "Stays Cold", evidence: ["24h cold", "BPA free"], cta: "Buy now" });
const P = c.prompt;

t("铁律 1 · 使用 hex 颜色码", () => assert.match(P, /#[0-9A-F]{6}/));
t("铁律 2 · 产品占比是数字区间", () => assert.match(P, /product occupies \d+-\d+% of the frame/));
t("铁律 3 · 显式声明留白下限", () => assert.match(P, /at least \d+% of the image must stay as clean empty whitespace/));
t("铁律 4 · 结尾有具体否定清单", () => {
  assert.match(P, /Do NOT add:/);
  assert.match(P, /watermarks/);
  assert.match(P, /fake logos/);
});
t("铁律 5 · 可开启平台预留区（国内电商）", () => {
  const c2 = composePrompt({ subject: "x", styleLock: lock, includePlatformReserve: true });
  assert.match(c2.prompt, /200x100 px/);
  assert.match(c2.prompt, /top center/i);
});
t("铁律 6 · 3 层信息架构（标题/证据/CTA）", () => {
  assert.match(P, /headline in #2D2D2D/);
  assert.match(P, /thin-line icon labels/);
  assert.match(P, /CTA button placeholder/);
});
t("多图任务第一段必须是同一段 Style Lock", () => assert.ok(P.startsWith(lock.slice(0, 40))));
t("角度关键词被显式写进 Prompt", () => assert.match(P, /3\/4 angle|overhead angle|side profile|45-degree/));
t("画幅比例被写进 Prompt", () => assert.match(P, /aspect ratio \d+:\d+/));

t("信息架构超限会被判不合格", () => {
  // 三层各自越界一次：headline 19 字 > 15、evidence 4 个 > 3、CTA 12 字 > 8
  const a = infoArchitecture("这是一个明显超过十五个字的核心承诺文案", ["1", "2", "3", "4"], "立即下单购买超值套装优惠");
  assert.equal(a.ok, false);
  assert.equal(a.problems.length, 3, "三层各越界一次，应报 3 条：" + a.problems.join("；"));
  assert.equal(a.evidence.length, 3, "证据应被裁到 3 个");
});
t("信息架构未超限时判合格（反向测试）", () => {
  const a = infoArchitecture("轻松收纳", ["加厚材质", "可拆洗"], "立即购买");
  assert.equal(a.ok, true, "不该报错：" + a.problems.join("；"));
  assert.deepEqual(a.problems, []);
});

t("anti-AI 只在规定场景出现", () => {
  const ugc = composePrompt({ subject: "x", templateId: "ugc-style", styleLock: lock });
  assert.match(ugc.prompt, /iPhone 14 Pro/);
  assert.match(ugc.prompt, /NOT retouched/);
  const hero = composePrompt({ subject: "x", templateId: "hero-image", styleLock: lock });
  assert.ok(!/iPhone 14 Pro/.test(hero.prompt), "白底主图不该出现 anti-AI 手机型号");
});

t("详情页走信息图结构（不是纯产品图）", () => {
  const pdp = composePrompt({ subject: "x", templateId: "infographic", figure: "pdp", styleLock: lock, headline: "Core Benefits" });
  assert.match(pdp.prompt, /infographic/i);
});

/* ─────────────── 6. 多角度约束 ─────────────── */
section("6. 多角度镜头规则（可机械验证）");

t("主图 5 张：≥3 种角度、≥1 张特写/微距、不连续 3 张同角度、全景 ≤40%", () => {
  const a = assignAngles(5, { kind: "hero" });
  assert.equal(a.slots.length, 5);
  assert.ok(a.audit.distinctAngles >= 3, `只有 ${a.audit.distinctAngles} 种角度`);
  assert.ok(a.audit.closeShots >= 1);
  assert.ok(a.audit.wideRatio <= 0.4, `全景占比 ${a.audit.wideRatio}`);
  assert.ok(a.audit.ok);
  for (let i = 2; i < a.slots.length; i++) {
    const same = a.slots[i].angle === a.slots[i - 1].angle && a.slots[i].angle === a.slots[i - 2].angle;
    assert.ok(!same, `第 ${i - 1}~${i + 1} 张角度相同`);
  }
});
t("详情页 9 张：≥4 种角度、≥2 张特写/微距", () => {
  const a = assignAngles(9, { kind: "pdp" });
  assert.ok(a.audit.distinctAngles >= 4, `只有 ${a.audit.distinctAngles} 种`);
  assert.ok(a.audit.closeShots >= 2, `只有 ${a.audit.closeShots} 张特写`);
  assert.ok(a.audit.wideRatio <= 0.4);
});
t("角度分配是确定性的（同输入两次结果一致）", () => {
  assert.deepEqual(assignAngles(9, { kind: "pdp" }).slots, assignAngles(9, { kind: "pdp" }).slots);
});
t("俯视与仰视至少各出现一次", () => {
  const keys = assignAngles(9, { kind: "pdp" }).slots.map((s) => s.angle);
  assert.ok(keys.includes("topdown") || keys.includes("high45"), "缺少俯视");
  assert.ok(keys.includes("lowup"), "缺少仰视");
});

/* ─────────────── 7. 整套图片包 ─────────────── */
section("7. 整套图片包规划与机械自检");

const plan = planImagePack({ subject: "pet automatic feeder", driver: "pain", styleLock: lock, pack: "pdp" });
t("5 张主图 + 9 张详情页 = 14 张", () => {
  assert.equal(plan.counts.hero, 5);
  assert.equal(plan.counts.pdp, 9);
  assert.equal(plan.counts.total, 14);
});
t("每张图共用同一段 Style Lock", () => {
  for (const it of plan.items) assert.ok(it.prompt.startsWith(lock.slice(0, 40)), `${it.code} 未以 Style Lock 开头`);
});
t("机械自检通过（auditPlan 返回空）", () => {
  const probs = auditPlan(plan);
  assert.deepEqual(probs, [], "自检问题：" + probs.join("；"));
});
t("背景色交替（不连续相同）", () => {
  for (let i = 1; i < plan.items.length; i++) {
    assert.notEqual(plan.items[i].background, plan.items[i - 1].background, `第 ${i + 1} 张背景与上一张相同`);
  }
});
t("详情页画幅为竖版、主图为方图", () => {
  const hero = plan.items.filter((i) => i.group === "hero");
  const pdp = plan.items.filter((i) => i.group === "pdp");
  assert.ok(hero.every((i) => i.size === "1024x1024"));
  assert.ok(pdp.every((i) => i.size === "768x1024"));
});

t("自检能抓到人为破坏（反向测试）", () => {
  const broken = JSON.parse(JSON.stringify(plan));
  broken.styleLock = "XXX " + broken.styleLock;
  const probs = auditPlan(broken);
  assert.ok(probs.length >= 14, `反转后只报了 ${probs.length} 个问题，说明断言没生效`);
});
t("自检能抓到缺留白（反向测试）", () => {
  const broken = JSON.parse(JSON.stringify(plan));
  broken.items[3].prompt = broken.items[3].prompt.replace(/at least \d+% of the image/, "some of the image");
  assert.ok(auditPlan(broken).some((p) => p.includes("留白")));
});
t("自检能抓到详情页缺信息图结构（反向测试）", () => {
  const broken = JSON.parse(JSON.stringify(plan));
  const pdp = broken.items.find((i) => i.group === "pdp");
  pdp.prompt = pdp.prompt.replace("E-commerce infographic layout — ", "");
  assert.ok(auditPlan(broken).some((p) => p.includes("E-commerce infographic")));
});
t("Prompt 里写的是画幅比例、不是像素尺寸", () => {
  for (const it of plan.items) {
    assert.match(it.prompt, /aspect ratio \d+:\d+/, `${it.code} 未写比例`);
    assert.ok(!/aspect ratio \d+x\d+/.test(it.prompt), `${it.code} 把像素当比例写进去了`);
  }
});
t("详情页每张都带信息图元素", () => {
  for (const it of plan.items.filter((i) => i.group === "pdp")) {
    assert.match(it.prompt, /E-commerce infographic/, `${it.code} 缺 infographic 起头`);
    assert.match(it.prompt, /feature callout icons/, `${it.code} 缺 callout icons`);
  }
});

/* ─────────────── 8. 图生图 ─────────────── */
section("8. 图生图（保留产品身份，不保留构图）");

const i2i = composeImg2ImgPrompt({ target: "换成 ins 风室内坐姿图", scene: "beige linen sofa near a large window", styleLock: lock });
t("包含 preserving the original product identity...", () => assert.match(i2i.prompt, /preserving the original product identity, pattern, colors and material/));
t("明确不写 preserving composition", () => assert.ok(!/preserving the original composition/i.test(i2i.prompt)));
t("仍然应用铁律（占比/留白/否定清单）", () => {
  assert.match(i2i.prompt, /product occupies \d+-\d+%/);
  assert.match(i2i.prompt, /at least \d+%/);
  assert.match(i2i.prompt, /Do NOT add:/);
});

/* ─────────────── 9. 关键词挖掘 ─────────────── */
section("9. 关键词挖掘");

const corpus = `Stainless Steel Insulated Water Bottle. Keep drinks cold for 24 hours. 
The stainless steel bottle is BPA free and leak proof. 
Insulated bottle with double wall vacuum. Perfect water bottle for gym.`;
const mined = mineKeywords(corpus, { top: 30 });
t("挖掘出词条", () => assert.ok(mined.terms.length > 5));
t("识别出高频短语 water bottle", () => assert.ok(mined.terms.some((x) => x.term.includes("water bottle"))));
t("停用词被过滤", () => assert.ok(!mined.terms.some((x) => x.term === "the" || x.term === "for")));
t("结果确定性（两次一致）", () => assert.deepEqual(mined.terms, mineKeywords(corpus, { top: 30 }).terms));

t("Search Terms 按字节计长度", () => {
  const cn = "咖啡杯保温杯";
  assert.ok(byteLength(cn) > cn.length, "中文应按 UTF-8 字节计");
  assert.equal(byteLength("abc"), 3);
});
t("Search Terms 超限会截断并记录丢弃原因", () => {
  const r = buildSearchTerms([...Array(60)].map((_, i) => `keyword${i}`), { limit: 60 });
  assert.ok(r.bytes <= 60, `实际 ${r.bytes} 字节`);
  assert.ok(r.dropped.length > 0);
  assert.ok(r.dropped.every((d) => d.why.includes("超出")));
});
t("Search Terms 排除品牌词", () => {
  const r = buildSearchTerms(["acme bottle", "water bottle"], { exclude: ["acme"] });
  assert.ok(!r.value.includes("acme"));
});

/* ─────────────── 10. Listing 质检 ─────────────── */
section("10. Listing 质检（机械判定，可反向验证）");

t("规则集完整且都带 why / source", () => {
  assert.ok(RULES.length >= 15, `只有 ${RULES.length} 条`);
  for (const r of RULES) {
    assert.ok(r.why && r.why.length > 8, `${r.id} 缺 why`);
    assert.ok(r.source, `${r.id} 缺 source`);
    assert.ok(["P", "C"].includes(r.level), `${r.id} level 不合法`);
  }
});

const BAD = {
  title: "FREE SHIPPING Hot Sale Best Seller Water Bottle!!! buy now 100% GUARANTEE SUPER CHEAP",
  bullets: ["water bottle is good", "this is nice", "A: x", "B: y", "C: z"],
  searchTerms: "a".repeat(300),
};
const badRes = lintListing(BAD, { brand: "Acme", primaryKeyword: "water bottle" });
t("差 listing 命中多条硬规则", () => assert.ok(badRes.summary.hitP >= 4, `只命中 ${badRes.summary.hitP} 条`));
t("P2 抓到促销词", () => assert.ok(badRes.results.find((r) => r.id === "P2").status === "命中"));
t("P3 抓到特殊符号", () => assert.ok(badRes.results.find((r) => r.id === "P3").status === "命中"));
t("P6 抓到保证性用语", () => assert.ok(badRes.results.find((r) => r.id === "P6").status === "命中"));
t("P6 不误报 cure 的子串（secure / manicure）", () => {
  const r = lintListing({ title: "Secure Manicure Kit for Travel", bullets: [], searchTerms: "" }, {});
  const p6 = r.results.find((x) => x.id === "P6");
  assert.equal(p6.status, "通过", "词边界失效，误报了：" + p6.detail);
});
t("P2 不误报 free 的子串（freedom）", () => {
  const r = lintListing({ title: "Freedom Bluetooth Speaker", bullets: [], searchTerms: "" }, {});
  assert.equal(r.results.find((x) => x.id === "P2").status, "通过");
});
t("P10 抓到 Search Terms 超字节", () => assert.ok(badRes.results.find((r) => r.id === "P10").status === "命中"));
t("结论明确要求修改", () => assert.match(badRes.summary.conclusion, /必须修改/));

// ⚠️ 2026-09-29：这份「好 listing」的标题原来是 80 字符
//    （"Acme Insulated Water Bottle 24oz Stainless Steel Vacuum Flask for Gym and Travel"），
//    在 200 字符时代是合格的，在新规下会被 P1 直接判超限 —— 回归当场把它抓了出来。
//    这不是"为了过测试而改数据"：fixture 本来就该是"当下真实合格"的样子，
//    所以标题压到 75 以内，并把挤出去的用途信息放进 Item Highlights（官方推荐的搬家方向）。
const GOOD = {
  title: "Acme Insulated Water Bottle 24oz Stainless Steel Vacuum Flask",
  highlights: "Stainless steel, BPA free, for gym and travel",
  bullets: [
    "KEEPS DRINKS COLD 24H: Double-wall vacuum insulation holds temperature all day so you stop refilling.",
    "FOOD-GRADE STEEL: 304 stainless steel body, 350ml capacity, BPA free and leak proof for daily commutes.",
    "EASY TO CARRY: Slim 7cm diameter fits standard cup holders, so you can take it anywhere.",
    "SIMPLE TO CLEAN: Wide 5cm mouth makes rinsing fast without special brushes.",
    "BUILT TO LAST: Reusable design replaces single-use bottles and lasts for years.",
  ],
  searchTerms: "insulated water bottle stainless steel flask vacuum travel gym",
};
const goodRes = lintListing(GOOD, { brand: "Acme", primaryKeyword: "water bottle" });
t("好 listing 硬规则全过", () => assert.equal(goodRes.summary.hitP, 0, JSON.stringify(goodRes.results.filter((r) => r.status === "命中" && r.level === "P"))));
t("未命中的规则也被列出（不是只报错）", () => assert.equal(goodRes.results.length, RULES.length));
t("字段为空时标记为跳过而不是通过", () => {
  const r = lintListing({ title: "", bullets: [], searchTerms: "" });
  assert.equal(r.results.every((x) => x.status === "跳过"), true);
  assert.equal(r.summary.hit, 0);
});

/* ─── 10a'. 状态语义：跳过 / 异常都不得算作「通过」（N1）───
 * 缺陷形态：规则内部"前提不足"时返回 `hit:false`，外层统一记成 `status:"通过"`，
 * 于是 summary.skipped 永远是 0，结论还能说出「全部通过」—— 系统在说假话。
 * 下面四条断言把四种状态钉死，并双向锁住"真全过时仍要说全部通过"。
 */
section("10a'. 质检状态语义：跳过 / 异常 ≠ 通过");

t("未填品牌 → P11 是「跳过」，不是「通过」，且计入 summary.skipped", () => {
  const r = lintListing({ title: "Acme Insulated Bottle 24oz Steel Flask", bullets: [], searchTerms: "bottle steel" }, { primaryKeyword: "bottle" });
  const p11 = r.results.find((x) => x.id === "P11");
  assert.equal(p11.status, "跳过", "缺品牌时 P11 被当成了通过（N1 未修）");
  assert.ok(r.summary.skipped >= 1, "summary.skipped 没有统计到这条跳过");
});

t("中文标题（字母 <8）→ P5 是「跳过」，不是「通过」", () => {
  const r = lintListing({ title: "不锈钢保温杯 24oz 双层真空", bullets: [], searchTerms: "" }, {});
  assert.equal(r.results.find((x) => x.id === "P5").status, "跳过", "字母过少时 P5 被当成了通过");
});

t("summary.checked = total - skipped - errored；通过数 = checked - hit（口径自洽）", () => {
  const r = lintListing({ title: "Acme Insulated Bottle 24oz Steel Flask", bullets: [], searchTerms: "bottle" }, {});
  const s = r.summary;
  assert.equal(s.checked, s.total - s.skipped - s.errored, "checked 与 total/skipped/errored 对不上");
  const pass = r.results.filter((x) => x.status === "通过").length;
  assert.equal(pass, s.checked - s.hit, "「通过」条数与 checked - hit 不一致（说明有状态没归到四类里）");
});

t("前提缺失时结论不得是「全部通过」，且必须写明未判定条数", () => {
  const r = lintListing({ title: "Acme Insulated Bottle 24oz Steel Flask", bullets: [], searchTerms: "bottle" }, {});
  assert.notEqual(r.summary.conclusion, "全部通过", "有未判定项却报「全部通过」= 说假话");
  assert.match(r.summary.conclusion, /未判定|无可检查项/, `结论没交代未判定项：${r.summary.conclusion}`);
});

t("规则抛异常 → status 为「异常」，不计入通过，结论不得说全过", () => {
  const ctx = Object.defineProperty({}, "brand", { enumerable: true, get() { throw new Error("boom"); } });
  const r = lintListing({ title: "Acme Insulated Bottle 24oz Steel Flask", bullets: [], searchTerms: "bottle" }, ctx);
  const bad = r.results.find((x) => x.id === "P11");
  assert.equal(bad.status, "异常", "规则崩了却被记成通过（原缺陷：catch 里 hit:false）");
  assert.match(bad.detail, /boom/, "异常原因没带出来");
  assert.ok(r.summary.errored >= 1, "summary.errored 没统计到异常");
  assert.notEqual(r.summary.conclusion, "全部通过", "存在异常时仍说「全部通过」");
});

t("双向锁：28 条全判且全过时，结论仍是「全部通过」、skipped/errored 都必须为 0", () => {
  // 注意：上面那份 GOOD 会命中 C8（"BPA free" 属需举证声明），结论文案本来就是
  // 「硬规则全过，软规则有可优化项」——不能拿它当"全过"的样本。这里单造一份零命中的。
  const CLEAN = {
    title: "Acme Cotton Bath Towel Set 3 Piece",
    highlights: "Cotton, for bathroom and travel",
    bullets: [
      "SOFT TOUCH: Combed cotton loop pile feels plush against skin every day.",
      "QUICK DRY: Thin loop weave dries fast between uses so it stays fresh.",
      "STAYS PUT: 500gsm weight holds shape after repeated washing and drying.",
      "GENTLE WASH: Machine wash warm with like colors, tumble dry low heat.",
      "GREAT GIFT: Neutral colors fit most bathroom decor and make an easy present.",
    ],
    searchTerms: "cotton bath towel set soft absorbent",
  };
  const r = lintListing(CLEAN, { brand: "Acme", primaryKeyword: "bath towel" });
  assert.equal(r.summary.hit, 0, "CLEAN fixture 不该有命中");
  assert.equal(r.summary.skipped, 0, `CLEAN fixture 不该有跳过项：${r.results.filter((x) => x.status === "跳过").map((x) => x.id)}`);
  assert.equal(r.summary.errored, 0, "CLEAN fixture 不该有异常项");
  assert.equal(r.summary.checked, r.summary.total, "全判时 checked 应等于 total");
  assert.equal(r.summary.conclusion, "全部通过", "真有可检查项且全通过时，结论却没说「全部通过」");
});
t("GOOD fixture（含 BPA free）不得有跳过 / 异常项 —— 字段是齐的", () => {
  assert.equal(goodRes.summary.skipped, 0, `GOOD 出现跳过：${goodRes.results.filter((x) => x.status === "跳过").map((x) => x.id)}`);
  assert.equal(goodRes.summary.errored, 0, "GOOD 出现异常");
});

t("草稿生成：标题不超过建议上限", () => {
  const d = generateListingDraft({
    brand: "Acme", primaryKeyword: "insulated water bottle",
    features: ["keeps cold 24h", "304 steel", "leak proof", "easy clean", "gift ready", "extra one"],
    sizeSpec: "24oz", quantity: "2", audience: "commuters",
  });
  assert.ok(d.title.length <= LIMITS.titleStrict, `标题 ${d.title.length} 字符`);
  assert.equal(d.bullets.length, LIMITS.bulletCount);
});
t("草稿生成：五点以引导词: 开头（可被 C9 通过）", () => {
  const d = generateListingDraft({ brand: "A", primaryKeyword: "bottle", features: ["keeps cold", "steel body", "easy clean"] });
  for (const b of d.bullets) assert.match(b, /^[A-Z][A-Z0-9 &'/-]{2,40}:/);
  const res = lintListing({ title: d.title, bullets: d.bullets, searchTerms: d.searchTerms }, {});
  assert.equal(res.results.find((r) => r.id === "C9").status, "通过");
});
t("C9 已降级为软规则（行业惯例不该报成「必须修改」）", () => {
  const c9 = RULES.find((r) => r.id === "C9");
  assert.equal(c9.level, "C", "C9 又被放回硬规则了");
  assert.equal(RULES.find((r) => r.id === "P9"), undefined, "P9 应该已经不存在（编号已让给 C9）");
});
t("C9 放宽了引导词正则（允许首词后接小写）", () => {
  const r = lintListing({ title: "X", bullets: ["Easy to clean: wide mouth rinses fast"], searchTerms: "" }, {});
  assert.equal(r.results.find((x) => x.id === "C9").status, "通过");
});

/* ─────────────── 10b. 合规词表与新增规则 ─────────────── */
section("10b. 合规词表（官方口径）与新增规则");

t("规则集分档：P 是硬规则、C 是软规则，编号不重叠", () => {
  const ids = RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "规则 id 有重复");
  assert.ok(RULES.filter((r) => r.level === "P").length >= 10, "硬规则太少");
  assert.ok(RULES.filter((r) => r.level === "C").length >= 8, "软规则太少");
  for (const r of RULES) assert.match(r.id, /^[PC]\d+$/);
});

t("疾病词表来自官方列表且有足够覆盖", () => {
  for (const w of ["cancer", "diabetes", "autism", "epilepsy", "dementia", "tumor", "hiv", "hpv", "covid-19", "alzheimer", "depression", "obesity"]) {
    assert.ok(DISEASE_TERMS.includes(w), `疾病词表漏了 ${w}`);
  }
  assert.ok(DISEASE_TERMS.length >= 60, `疾病词表只有 ${DISEASE_TERMS.length} 条`);
});

t("🔴 刻意剔除的高频歧义词不在疾病表里（防大面积误报）", () => {
  for (const w of ["add", "sad", "mono", "pid", "crabs", "tbi", "ngu"]) {
    assert.ok(!DISEASE_TERMS.includes(w), `${w} 被收进疾病表，会产生误报`);
  }
});

t("P6 不误报：Add to cart / Sad puppy / PID controller / Mono cable", () => {
  const cases = [
    "Add to Cart Button Replacement Part for Camera",
    "Sad Puppy Plush Toy for Kids",
    "PID Temperature Controller for Home Brewing",
    "Mono Audio Cable 6.35mm Instrument Cord",
  ];
  for (const title of cases) {
    const r = lintListing({ title, bullets: [], searchTerms: "" }, {});
    const p6 = r.results.find((x) => x.id === "P6");
    assert.equal(p6.status, "通过", `误报「${title}」：${p6.detail}`);
  }
});

t("P6 三桶都能报出来（疾病 / 农药抗菌 / 保证性）", () => {
  const r = lintListing({
    title: "Herbal Tea That Cures Diabetes",
    bullets: ["ANTIBACTERIAL: kills 99 percent of germs on contact and is clinically proven"],
    searchTerms: "",
  }, {});
  const p6 = r.results.find((x) => x.id === "P6");
  assert.equal(p6.status, "命中");
  assert.match(p6.detail, /疾病\/医疗声明/, "没报出疾病桶");
  assert.match(p6.detail, /农药\/抗菌声明/, "没报出农药桶");
  assert.match(p6.detail, /保证性\/绝对化/, "没报出保证桶");
});

t("P6 覆盖整块文案（标题干净、五点写疗效也要抓到）", () => {
  const r = lintListing({ title: "Herbal Tea 100g Loose Leaf", bullets: ["FIGHTS CANCER: daily herbal blend"], searchTerms: "" }, {});
  const p6 = r.results.find((x) => x.id === "P6");
  assert.equal(p6.status, "命中", "只查标题、漏掉了五点");
  assert.match(p6.detail, /疾病\/医疗声明/, `疾病词来自五点却没报出来：${p6.detail}`);
});

t("品类差异化：同一个词在有的品类报、有的品类不报", () => {
  const noCat = lintListing({ title: "Hypoallergenic Cotton Socks 3 Pairs", bullets: [], searchTerms: "" }, {});
  const pet = lintListing({ title: "Vet Approved Dog Harness", bullets: [], searchTerms: "" }, {});
  const petP6 = pet.results.find((x) => x.id === "P6");
  assert.equal(petP6.status, "命中", "宠物类 vet approved 应命中");
  assert.match(petP6.detail, /品类\(pet\)/, `没走品类分支：${petP6.detail}`);
  // 显式传入品类时优先用传入值
  const forced = lintListing({ title: "Vet Approved Dog Harness", bullets: [], searchTerms: "" }, { category: "home" });
  assert.equal(forced.results.find((x) => x.id === "P6").status, "通过", "显式 category=home 时不该再按 pet 判");
  assert.equal(noCat.results.length, RULES.length);
});

t("CATEGORY_CLAIMS 覆盖 prompt-engine 的全部品类键（两边不能漂移）", () => {
  for (const cat of ["beauty", "electronics", "food", "fashion", "home", "jewelry", "pet", "outdoor"]) {
    assert.ok(CATEGORY_CLAIMS[cat], `CATEGORY_CLAIMS 缺品类 ${cat}（detectCategory 能识别它）`);
    assert.ok(CATEGORY_CLAIMS[cat].words.length >= 4, `${cat} 词太少`);
    assert.ok(CATEGORY_CLAIMS[cat].why, `${cat} 缺 why`);
  }
});

t("P12 抓 HTML / 脚本标记（合规 + 注入双重风险）", () => {
  const cases = [
    "<b>Water Bottle</b> 500ml",
    "Water Bottle</p>",
    "Water Bottle <img src=x onerror=alert(1)>",
    "javascript:alert(1)",
    "Water Bottle &#65;",
  ];
  for (const title of cases) {
    const r = lintListing({ title, bullets: [], searchTerms: "" }, {});
    const p12 = r.results.find((x) => x.id === "P12");
    assert.equal(p12.status, "命中", `漏报 HTML 标记：${title}`);
  }
  assert.equal(findHtmlMarkers("Plain Water Bottle 500ml"), "");
  assert.equal(findHtmlMarkers("BPA-free 2+1 Pack, 100% Cotton"), "");
});

t("P3 抓到新补的解析/注入符号", () => {
  const r = lintListing({ title: "Water Bottle | 500ml", bullets: [], searchTerms: "" }, {});
  assert.equal(r.results.find((x) => x.id === "P3").status, "命中");
  for (const s of ["|", "<", ">", "`"]) assert.ok(BAD_SYMBOLS.includes(s), `BAD_SYMBOLS 缺 ${s}`);
});

t("C7 用「符号密度」而不是逐符号黑名单（100% Cotton / Model #A 不该报）", () => {
  for (const title of ["100% Cotton Bath Towel 70x140cm", "Replacement Model #A Filter", "BPA Free 2+1 Pack Bottle"]) {
    const r = lintListing({ title, bullets: [], searchTerms: "" }, {});
    assert.equal(r.results.find((x) => x.id === "C7").status, "通过", `符号密度误报：${title}`);
  }
  const dense = lintListing({ title: "New~Sale*Best^500ml#A+B%2@Home!", bullets: [], searchTerms: "" }, {});
  assert.equal(dense.results.find((x) => x.id === "C7").status, "命中");
});

t("C8 环境/自证声明是软规则（提示备证据，不是逼删）", () => {
  const r = lintListing({ title: "Eco-Friendly Biodegradable Bamboo Straws", bullets: [], searchTerms: "" }, {});
  const c8 = r.results.find((x) => x.id === "C8");
  assert.equal(c8.status, "命中");
  assert.equal(c8.level, "C");
  assert.equal(r.summary.hitP, 0, "环境声明不该进硬规则桶");
});

t("C3 利益词表按语言切换，且中文表不含单字过宽词", () => {
  assert.ok(!BENEFIT_WORDS_ZH.includes("更"), "「更」还在中文表里（会命中「更衣室」）");
  assert.ok(!BENEFIT_WORDS_ZH.includes("省"), "「省」还在中文表里（会命中「省份」）");
  assert.ok(BENEFIT_WORDS_ZH.every((w) => w.length >= 2), "中文表出现了单字词");
  const zh = lintListing({ title: "X", bullets: ["轻松收纳：无需工具，省时省心", "耐用材质，持久使用", "方便清洁"], searchTerms: "" }, {});
  assert.equal(zh.results.find((x) => x.id === "C3").status, "通过", "中文利益词没认出来");
  const bad = lintListing({ title: "X", bullets: ["材质：304 不锈钢", "尺寸：350ml"], searchTerms: "" }, {});
  assert.equal(bad.results.find((x) => x.id === "C3").status, "命中", "纯参数表应报缺利益点");
});

t("促销词表补了徽章词与大促名", () => {
  for (const w of ["amazon's choice", "best seller", "prime day", "black friday", "top rated"]) {
    assert.ok(PROMO_WORDS.includes(w), `PROMO_WORDS 缺 ${w}`);
  }
  const r = lintListing({ title: "Acme Bottle Amazon's Choice Best Seller", bullets: [], searchTerms: "" }, {});
  assert.equal(r.results.find((x) => x.id === "P2").status, "命中");
});

t("词表里没有会误伤常见词的单词条（2 字符必须是符号型）", () => {
  for (const [name, list] of [["PROMO", PROMO_WORDS], ["CLAIM", CLAIM_WORDS], ["DISEASE", DISEASE_TERMS], ["PESTICIDE", PESTICIDE_CLAIMS]]) {
    for (const w of list) {
      const s = String(w).trim();
      assert.ok(s.length >= 2, `${name} 里有过短词条：${JSON.stringify(w)}`);
      if (s.length === 2) {
        assert.ok(/[^a-z]/i.test(s), `${name} 里的 2 字符词条必须是符号型（如 #1），否则会大面积误报：${JSON.stringify(w)}`);
      }
    }
  }
});

t("mineKeywords 显式声明「这不是搜索量」", () => {
  const r = mineKeywords("dog harness nylon adjustable dog harness padded", { top: 5 });
  assert.equal(r.disclaimer.isSearchVolume, false);
  assert.match(r.note, /不是搜索量/);
  assert.ok(r.disclaimer.doesNotMeasure.includes("搜索量"));
});

/* ─────────────── 10c. 关键词覆盖度分析 ─────────────── */
section("10c. 关键词覆盖度分析（analyzeCoverage）");

t("hasTerm 走词边界：cat 不命中 category、mug 不命中 smug", () => {
  assert.equal(hasTerm("cat", "Category Page Only"), false);
  assert.equal(hasTerm("cat", "Cat Bed for Large Cats"), true);
  assert.equal(hasTerm("mug", "Smug Design Coffee"), false);
  assert.equal(hasTerm("mug", "Ceramic Mug 350ml"), true);
});

t("hasTerm 对中文走子串（中文没有词边界概念）", () => {
  assert.equal(hasTerm("保温杯", "不锈钢保温杯 500ml"), true);
  assert.equal(hasTerm("保温杯", "不锈钢水壶 500ml"), false);
});

t("hasTerm 对 #1 / 2+1 pack / bpa-free 这类词按形态分流", () => {
  // 以符号开头/结尾的词不能用 \b，否则永远匹配不上
  assert.equal(hasTerm("#1", "Rated #1 Best Seller"), true);
  assert.equal(hasTerm("2+1 pack", "BPA Free 2+1 Pack Bottle"), true);
  assert.equal(hasTerm("bpa-free", "100% BPA-Free Tritan"), true);
  assert.equal(hasTerm("bpa-free", "BPA Free Tritan"), false);
  assert.equal(hasTerm("", "anything"), false);
  assert.equal(hasTerm("cat", ""), false);
});

t("FIELD_WEIGHT 的次序：标题 > 五点 > 描述 = 后台词", () => {
  assert.ok(FIELD_WEIGHT.title > FIELD_WEIGHT.bullets, "标题权重应高于五点");
  assert.ok(FIELD_WEIGHT.bullets > FIELD_WEIGHT.description, "五点权重应高于描述");
  assert.equal(FIELD_WEIGHT.description, FIELD_WEIGHT.searchTerms, "后台词与描述同级");
});

t("analyzeCoverage 空输入不抛错，给出明确的 0 值", () => {
  const r = analyzeCoverage({}, {});
  assert.equal(r.total, 0);
  assert.equal(r.covered, 0);
  assert.equal(r.coveragePct, 0);
  assert.deepEqual(r.gaps, []);
  assert.deepEqual(r.weak, []);
  assert.equal(r.competitorProvided, false);
});

t("analyzeCoverage 抓出「竞品在打、我一个字都没提」的词（缺口优先）", () => {
  const listing = {
    title: "Acme Dog Harness No-Pull Adjustable",
    bullets: [
      "Padded chest plate: no chafing on long walks",
      "Reflective stitching for night visibility",
    ],
    searchTerms: "pet harness vest",
    description: "A dog harness built for daily walks.",
  };
  const competitor = "No-Pull Dog Harness with padded chest plate. Anti-pull harness for small dogs reduces pulling.";
  const r = analyzeCoverage(listing, { keywords: "anti-pull, small dogs, dog harness, reflective", competitorText: competitor });
  assert.ok(r.gaps.includes("anti-pull"), `anti-pull 应被报成缺口，实际 gaps=${JSON.stringify(r.gaps)}`);
  assert.ok(r.gaps.includes("small dogs"), `small dogs 应被报成缺口，实际 gaps=${JSON.stringify(r.gaps)}`);
  assert.ok(!r.gaps.includes("dog harness"), "已覆盖的词不该进缺口");
  assert.equal(r.rows[0].priority, 1, "缺口必须排在最前（排序是可执行的）");
  assert.ok(r.coveragePct > 0 && r.coveragePct < 100);
});

t("analyzeCoverage：我覆盖得好、竞品没提的词不该进缺口（不对称）", () => {
  const listing = { title: "Acme Insulated Tumbler", bullets: [], searchTerms: "", description: "" };
  const r = analyzeCoverage(listing, { keywords: "insulated", competitorText: "Plain Plastic Cup with straw", includeMined: false });
  const row = r.rows.find((x) => x.term === "insulated");
  assert.equal(row.hit.title, true);
  assert.equal(row.competitor, false);
  assert.equal(row.priority, 4);
  assert.deepEqual(r.gaps, [], "我覆盖了而竞品没覆盖的词，不该被报成缺口");

  // 反过来：默认会把竞品语料挖出的词也并入候选，但它们进的是 minedGaps 而不是 gaps
  const r2 = analyzeCoverage(listing, { keywords: "insulated", competitorText: "Plain Plastic Cup with straw" });
  assert.ok(r2.minedCount > 0, "默认应从竞品语料挖词");
  assert.ok(r2.minedGaps.includes("straw"), `竞品独有词应进 minedGaps，实际 ${JSON.stringify(r2.minedGaps)}`);
  assert.deepEqual(r2.gaps, [], "竞品语料挖出的词不该混进「真缺口」—— 否则会淹掉用户自己选的那几个词");
  assert.ok(!r2.minedGaps.includes("insulated"), "我覆盖了的词永远不该进缺口");
});

t("analyzeCoverage：gaps 只收「用户自己选的候选词」，minedGaps 单列噪声线索", () => {
  const listing = { title: "Acme Dog Harness", bullets: [], searchTerms: "", description: "" };
  const competitor = "Anti-pull harness for small dogs. Extra padded handle included.";
  const r = analyzeCoverage(listing, { keywords: "anti-pull, small dogs", competitorText: competitor });
  // 两个候选词都是竞品有我没有 → 进真缺口
  assert.deepEqual(r.gaps.sort(), ["anti-pull", "small dogs"]);
  // 竞品语料里其他没被覆盖的词只在 minedGaps
  assert.ok(r.minedGaps.length > 0, "竞品语料的其他词应进 minedGaps");
  for (const noise of r.minedGaps) {
    assert.ok(!r.gaps.includes(noise), `${noise} 不该出现在真缺口里`);
  }
  assert.ok(r.rows.every((x) => x.source === "given" || x.source === "mined"), "每行都要标来源");
});

t("analyzeCoverage：竞品语料按句挖掘，不产生跨句假短语", () => {
  const r = analyzeCoverage({ title: "x" }, {
    keywords: "",
    competitorText: "First sentence about cups. Second sentence about dogs.",
  });
  assert.ok(!r.minedGaps.includes("cups second"), `出现跨句假短语：${JSON.stringify(r.minedGaps)}`);
  assert.ok(r.minedGaps.includes("cups"), "正常的单词应该还是挖得到");
});

t("analyzeCoverage：只在后台词里覆盖 → 单列 weak（后台词权重最低）", () => {
  const r = analyzeCoverage(
    { title: "Acme Pet Supply", bullets: [], searchTerms: "dog harness", description: "" },
    { keywords: "dog harness", competitorText: "" },
  );
  assert.deepEqual(r.weak, ["dog harness"]);
  assert.equal(r.rows[0].priority, 2);
  assert.ok(r.rows[0].score === FIELD_WEIGHT.searchTerms);
});

t("analyzeCoverage：没给竞品语料时 competitor 是 null，不能拿 false 冒充「竞品没覆盖」", () => {
  const r = analyzeCoverage({ title: "Cat Bed" }, { keywords: "cat bed", competitorText: "" });
  assert.equal(r.competitorProvided, false);
  assert.equal(r.minedCount, 0);
  assert.equal(r.rows[0].competitor, null);
});

t("analyzeCoverage：top 截断生效 + 长度 <2 的候选词被丢弃", () => {
  const many = Array.from({ length: 50 }, (_, i) => `term${i}`).join(",");
  assert.equal(analyzeCoverage({ title: "x" }, { keywords: many, top: 10 }).total, 10);
  assert.equal(analyzeCoverage({ title: "x" }, { keywords: "a,b,c" }).total, 0, "单字符候选词应丢弃（噪声）");
  assert.equal(analyzeCoverage({ title: "x" }, { keywords: "mug, mug, MUG" }).total, 1, "候选词应去重（大小写无关）");
});

t("analyzeCoverage 的免责声明与来源标注必须存在", () => {
  const r = analyzeCoverage({ title: "Cat Bed" }, { keywords: "cat bed" });
  assert.match(r.note, /不是搜索排名/);
  assert.match(r.note, /不是搜索量/);
  assert.match(r.source, /行业通行做法/);
  assert.match(r.source, /不是亚马逊官方明文/);
});

t("按亚马逊后台字段导出：三种计法（字符 / 字节）分开算", () => {
  const listing = {
    title: "Acme Insulated Water Bottle 24oz Stainless Steel",
    bullets: ["A: one", "B: two", "C: three", "D: four", "E: five"],
    searchTerms: "insulated water bottle stainless steel flask",
    description: "A description.",
  };
  const out = exportListingFields(listing, { brand: "Acme", primaryKeyword: "water bottle" });
  assert.equal(out.fields.length, AMAZON_FIELDS.length);
  const t1 = out.fields.find((f) => f.key === "item_name");
  assert.equal(t1.unit, "字符");
  assert.equal(t1.used, listing.title.length);
  assert.equal(t1.over, false);
  const st = out.fields.find((f) => f.key === "generic_keywords");
  assert.equal(st.unit, "字节");
  assert.equal(st.used, byteLength(listing.searchTerms));
  assert.equal(out.fields.find((f) => f.key === "bullet1").value, "A: one");
  assert.match(out.text, /【Title（商品名称）】/);
  assert.equal(out.overflows.length, 0);
  assert.equal(out.missingRequired.length, 0);
});

t("按亚马逊后台字段导出：超限与缺必填会被点出来", () => {
  const out = exportListingFields({ title: "x".repeat(LIMITS.title + 5), bullets: [], searchTerms: "" }, {});
  assert.equal(out.overflows.length, 1);
  assert.equal(out.overflows[0].key, "item_name");
  assert.ok(out.overflows[0].remaining < 0);
  assert.ok(out.missingRequired.some((f) => f.key === "bullet1"));
});

t("后台字段的阿拉伯数字/中文计数口径：标题按字符而非字节", () => {
  // 全角字符在字节口径下是 3 字节，在字符口径下是 1 —— 后台标题是**字符**口径
  const zhTitle = "保温".repeat(20); // 40 个汉字
  const out = exportListingFields({ title: zhTitle, bullets: [], searchTerms: "" }, {});
  const f = out.fields.find((x) => x.key === "item_name");
  assert.equal(f.used, 40, "标题被按字节算了");
  assert.equal(f.over, false);
  assert.ok(byteLength(zhTitle) > f.used, "字节数应大于字符数");
});

/* ─────────────── 10d. 多竞品对比 ─────────────── */
section("10d. 多竞品对比（normalizeCompetitors / compareCompetitors）");

t("四个竞品输入形态都归一成 [{name,text}]（归一化只写一处）", () => {
  const a = normalizeCompetitors([{ name: "A", text: "  dog harness  " }, { name: "", text: "cat bed" }]);
  assert.equal(a.length, 2);
  assert.equal(a[0].name, "A");
  assert.equal(a[1].name, "竞品 2", "没名字的要自动补编号，不能留空");
  const b = normalizeCompetitors(["dog harness", "cat bed"]);
  assert.deepEqual(b.map((x) => x.text), ["dog harness", "cat bed"]);
  const c = normalizeCompetitors({ 竞品A: "dog harness", 竞品B: "cat bed" });
  assert.deepEqual(c.map((x) => x.name), ["竞品A", "竞品B"]);
  assert.deepEqual(normalizeCompetitors(""), []);
  assert.deepEqual(normalizeCompetitors(null), []);
});

t("对比 3 个竞品：count = 有几个竞品用到它，全中的才算共识词", () => {
  const r = compareCompetitors([
    { name: "A", text: "Insulated Water Bottle 24oz Stainless Steel" },
    { name: "B", text: "Insulated Water Bottle 32oz Leak Proof" },
    { name: "C", text: "Insulated Water Bottle with Straw Lid" },
  ]);
  assert.equal(r.size, 3);
  const ins = r.rows.find((x) => x.term === "insulated");
  assert.equal(ins.count, 3);
  assert.equal(ins.consistency, 1);
  assert.equal(ins.consensus, true, "3/3 都用 = 全类目共识词");
  assert.ok(r.consensus.includes("insulated"), `共识词表应含 insulated，实际 ${JSON.stringify(r.consensus)}`);
  // 只有 A 用的词 → count 1，是差异化/品牌词线索，不能算共识
  assert.ok(!r.consensus.includes("steel"), "只有 3 个竞品里的 1 个提到，不该算共识");
  assert.equal(ins.hits.length, 3, "要能回查是哪几个竞品在打这个词");
  assert.deepEqual(ins.hits.map((h) => h.name).sort(), ["A", "B", "C"]);
});

t("排序把共识词放前面（共识 > 差异化，这是可执行的优先级）", () => {
  const r = compareCompetitors([
    { name: "A", text: "Insulated Bottle stainless cap" },
    { name: "B", text: "Insulated Bottle bamboo lid" },
  ]);
  assert.ok(r.rows[0].count >= r.rows[r.rows.length - 1].count, "count 必须单调不增");
  assert.equal(r.rows[0].term, "insulated bottle", "两个竞品都有的短语应排最前");
});

t("单竞品时明确说清「这等于单竞品词频」，不假装是对比", () => {
  const r = compareCompetitors([{ name: "A", text: "dog harness anti pull" }]);
  assert.equal(r.size, 1);
  assert.equal(r.consensus.length, 0, "只有一个竞品时没有共识可言");
  assert.match(r.note, /至少要两个竞品/);
  assert.equal(compareCompetitors([]).rows.length, 0);
});

t("对比口径的免责声明与来源标注必须存在", () => {
  const r = compareCompetitors([{ name: "A", text: "x y" }, { name: "B", text: "x z" }]);
  assert.match(r.note, /不是搜索量/);
  assert.match(r.source, /不是平台规则/);
});

t("多竞品覆盖度：coveredBy 指出「是哪几个竞品在打这个词」", () => {
  const r = analyzeCoverage(
    { title: "Acme Dog Harness", bullets: [], searchTerms: "", description: "" },
    {
      keywords: "anti-pull",
      competitors: [
        { name: "A", text: "Anti-pull harness for small dogs" },
        { name: "B", text: "Padded dog harness with reflective trim" },
      ],
    },
  );
  const row = r.rows.find((x) => x.term === "anti-pull");
  assert.deepEqual(row.coveredBy, ["A"], "只有竞品 A 打了这个词");
  assert.equal(row.competitor, true);
  assert.equal(row.priority, 1, "竞品有我没有 → 优先级 1");
  assert.deepEqual(r.competitorNames, ["A", "B"]);
});

t("多竞品 + 旧单段 competitorText 可以并存（向后兼容）", () => {
  const r = analyzeCoverage(
    { title: "Acme Dog Harness", bullets: [], searchTerms: "", description: "" },
    { keywords: "anti-pull", competitorText: "Anti-pull harness for small dogs", includeMined: false },
  );
  assert.deepEqual(r.competitorNames, ["竞品"], "旧字段应被当成一个名叫「竞品」的竞品");
  assert.equal(r.rows[0].competitor, true);
});

t("德语竞品对比：不套德语停用词表时 mit/für/und 会污染共识词", () => {
  const comps = [
    { name: "A", text: "Thermoskanne für Kaffee und Tee mit Ausguss" },
    { name: "B", text: "Thermoskanne für Tee und Kaffee mit Deckel" },
  ];
  const bad = compareCompetitors(comps);
  assert.ok(bad.consensus.includes("mit"), "对照组：不传 lang 时 mit 会被当成共识词（这就是问题本身）");
  const good = compareCompetitors(comps, { lang: "de" });
  assert.ok(!good.consensus.includes("mit"));
  assert.ok(!good.consensus.includes("für"));
  assert.ok(!good.consensus.includes("und"));
  assert.ok(good.consensus.includes("thermoskanne"), "实词不能被误删");
});


/* ─────────────── 10e. 2026-07 标题新规 ─────────────── */
section("10e. 2026-07-27 标题新规（75 字符 + Item Highlights）");

t("🔴 反向测试：旧口径会放过的 80 字符标题，新规必须判超限", () => {
  // 这条断言的价值在于"它会因为旧口径而失败"。写 100 字符被判通过，
  // 正是这份工作台此前最危险的错判 —— 界面说通过、后台被改写。
  const r = lintListing({ title: "A".repeat(40) + " " + "B".repeat(39) });
  const p1 = r.results.find((x) => x.id === "P1");
  assert.equal(p1.status, "命中", `80 字符标题被判 ${p1.status} —— 标题上限可能又回到 200 了`);
  assert.match(p1.detail, /上限 75/);
});

t("标题边界：75 通过 / 76 命中（含空格，一个字符都不能多）", () => {
  assert.equal(lintListing({ title: "A".repeat(75) }).results.find((x) => x.id === "P1").status, "通过");
  assert.equal(lintListing({ title: "A".repeat(76) }).results.find((x) => x.id === "P1").status, "命中");
});

t("LIMITS 三个新常量都在，且 titleStrict 是项目自定而不是平台值", () => {
  assert.equal(LIMITS.title, 75);
  assert.equal(LIMITS.itemHighlights, 125);
  assert.equal(LIMITS.titleTotal, 200);
  assert.equal(LIMITS.titleMedia, 200, "media 是唯一例外，必须仍为 200");
  assert.ok(LIMITS.titleStrict < LIMITS.title, "保守口径必须比硬顶严，否则等于没有余量");
  // 75 + 125 = 200：官方原文是「两个字段共享 200 字符」，这个等式不是巧合，是设计。
  assert.equal(LIMITS.title + LIMITS.itemHighlights, LIMITS.titleTotal);
  assert.equal(titleLimit({}), 75);
  assert.equal(titleLimit({ isMedia: true }), 200);
});

t("media 是唯一例外：换成 media 口径后同样的标题就不超限了", () => {
  const t150 = "A".repeat(150);
  assert.equal(lintListing({ title: t150 }).results.find((x) => x.id === "P1").status, "命中");
  assert.equal(lintListing({ title: t150 }, { isMedia: true }).results.find((x) => x.id === "P1").status, "通过");
  // 反过来也要测：media 口径下 P4（保守建议）不该再报，因为它按的是 75 的余量逻辑
  const p4 = lintListing({ title: t150 }, { isMedia: true }).results.find((x) => x.id === "P4");
  assert.match(p4.detail, /不适用/, "media 口径下 P4 还在按 75 判，会给图书卖家报假警报");
});

t("P1 的 why 必须讲对后果（是「被 AI 改写」不是「被拒收」）", () => {
  const p1 = RULES.find((x) => x.id === "P1");
  // 🔴 这条断言防的是"把后果写狠一点以显得重要"：官方原文是超 75 仍可提交、
  //    Amazon 会 reconcile（自动拆分改写）。写成"拒收"就是造谣，会让人做错决策。
  assert.match(p1.why, /不是/);
  assert.match(p1.why, /自动(拆分)?改写|reconcile/);
  assert.ok(/14 天/.test(p1.why), "要提到品牌方的复核期，否则用户不知道自己还有挽救窗口");
  assert.match(p1.why, /title_differentiation|Item Highlights/, "要讲清「超限会连带丢掉 Item Highlights 提交资格」这条因果");
});

t("Item Highlights 上限：125 通过 / 126 命中", () => {
  const at = (n) => lintListing({ title: "X", highlights: "m".repeat(n) }).results.find((x) => x.id === "P13");
  assert.equal(at(125).status, "通过");
  assert.equal(at(126).status, "命中");
  assert.match(at(126).detail, /超出 1/);
});

t("Item Highlights 与标题同口径：禁用语 / 特殊符号照样报", () => {
  const r = lintListing({ title: "X", highlights: "USB-C, best seller | BPA free" }).results.find((x) => x.id === "P14");
  assert.equal(r.status, "命中");
  assert.match(r.detail, /禁用语/);
  assert.match(r.detail, /特殊符号/);
});

t("🔴 copy scope 已纳入 Item Highlights（否则会是新的绕过口子）", () => {
  // 引号内是 JS 源码里的模板/正则字面量，不涉及中文引号规则。
  const src = readFileSync(path.join(ROOT, "assets/listing.js"), "utf8");
  assert.match(src, /copy: \(\) => \[title, \.\.\.bullets, highlights\]/, "copy scope 没带上 highlights");
  // 行为级再确认一次：标题与五点都干净、疗效只写在 Highlights 里
  const r = lintListing({ title: "Cotton Socks", bullets: ["SOFT: comfy cotton"], highlights: "Helps cure athlete foot" });
  assert.equal(r.results.find((x) => x.id === "P6").status, "命中", "Highlights 里的疗效声明漏了");
});

t("C10：空 Highlights 要报，但**整张表都空**时不报（不许在空表上乱叫）", () => {
  const filled = lintListing({ title: "X", bullets: ["A: b"] });
  assert.equal(filled.results.find((x) => x.id === "C10").status, "命中", "emptyOk 失效，这条规则会永远静默不报");
  const withHl = lintListing({ title: "X", highlights: "Silicone, for gym" });
  assert.equal(withHl.results.find((x) => x.id === "C10").status, "通过");
  const blank = lintListing({ title: "", bullets: [], searchTerms: "" });
  assert.equal(blank.results.find((x) => x.id === "C10").status, "跳过", "空表上弹出「未填写 Highlights」是噪音");
  assert.equal(blank.results.every((x) => x.status === "跳过"), true);
});

t("C11：两段分工 —— 复述标题要报，分工正确不报", () => {
  const dup = lintListing({
    title: "Stainless Steel Water Bottle Insulated",
    highlights: "stainless steel water bottle insulated vacuum",
  }).results.find((x) => x.id === "C11");
  assert.equal(dup.status, "命中");
  assert.match(dup.detail, /100%/);
  const ok = lintListing({
    title: "Stainless Steel Water Bottle Insulated",
    highlights: "Silicone seal, for gym and office",
  }).results.find((x) => x.id === "C11");
  assert.equal(ok.status, "通过");
  // 词量太少的标题不参与判定（否则「Mug x」这种会被误报）
  // 🔴 N1 之后这里是「跳过」而不是「通过」：没判定 ≠ 合格，否则 summary.skipped 永远为 0。
  const tiny = lintListing({ title: "Mug", highlights: "ceramic mug" }).results.find((x) => x.id === "C11");
  assert.equal(tiny.status, "跳过");
});

t("P15：站外引流是硬规则（网址 / 邮箱 / 引流话术 / 中文加微信）", () => {
  const hitP15 = (text) => lintListing({ title: "X", bullets: [text] }).results.find((x) => x.id === "P15").status === "命中";
  for (const s of [
    "Visit our website for more",
    "support@brand.com",
    "see www.brand.com",
    "Contact us for a discount",
    "加微信 领取优惠",
    "https://example.com/xyz",
  ]) assert.equal(hitP15(s), true, `漏报站外引流：${s}`);
  // 反向：正常文案不能误报（误报会让人不再信质检结果）
  for (const s of [
    "Stainless steel body, 500ml",
    "Includes 2 replacement filters",
    "Ships in recyclable packaging",
  ]) assert.equal(hitP15(s), false, `误报：${s}`);
});

t("C12：疑似联系方式是软规则，且不误伤规格串", () => {
  const c12 = (text) => lintListing({ title: "X", bullets: [text] }).results.find((x) => x.id === "C12");
  assert.equal(c12("Call +86 138-1234-5678 today").status, "命中");
  assert.equal(c12("Follow us on Instagram").status, "命中");
  // 🔴 这条是"为什么电话只能做软规则"的证据：三段规格串数字量就有 10 位，硬禁必误报
  assert.equal(c12("Dim 350-500-1000 mm").status, "通过", "规格串被误判成电话，说明电话判定过宽");
  assert.equal(c12("Follow us on Instagram").level, "C");
});

t("C13 / C14：标题重复词与主观修饰词（75 字符时代它们直接吃额度）", () => {
  const c13 = lintListing({ title: "Dog Treats Dog Training Dog Snacks" }).results.find((x) => x.id === "C13");
  assert.equal(c13.status, "命中");
  assert.match(c13.detail, /dog×3/);
  // 品牌词不算重复（品牌前置本来就是官方推荐写法）
  const branded = lintListing({ title: "Acme Acme Water Bottle" }, { brand: "Acme" }).results.find((x) => x.id === "C13");
  assert.equal(branded.status, "通过", "把品牌词算成重复词了");
  assert.equal(lintListing({ title: "Premium Ceramic Mug 350ml" }).results.find((x) => x.id === "C14").status, "命中");
  // 与 PROMO_WORDS 重叠的词只在 PROMO 报，不重复报两遍
  assert.ok(!SUBJECTIVE_TITLE_WORDS.includes("best seller"), "best seller 已在 PROMO_WORDS，重复收词会同一件事报两次");
});

t("规则表规模：新增规则没有把 P/C 比例搞失衡", () => {
  const p = RULES.filter((r) => r.level === "P").length;
  const c = RULES.filter((r) => r.level === "C").length;
  assert.ok(p >= 14 && c >= 12, `P ${p} / C ${c}`);
  // 每条新规则都必须有 why/source（第 10 节已统一断言过，这里只确认新加的在内）
  for (const id of ["P13", "P14", "P15", "C10", "C11", "C12", "C13", "C14"]) {
    const r = RULES.find((x) => x.id === id);
    assert.ok(r, `规则 ${id} 不见了`);
    assert.ok(r.why.length > 12, `${id} 的 why 太短`);
    assert.ok(r.source, `${id} 缺 source`);
  }
});

t("草稿：标题溢出搬进 Highlights，而不是丢掉", () => {
  const d = generateListingDraft({
    brand: "Nordveil", productName: "Insulated Water Bottle",
    primaryKeyword: "Insulated Water Bottle",
    features: ["Double-wall vacuum insulation keeps drinks cold 24 hours", "Food-grade 304 stainless steel, BPA free", "Leak-proof silicone lid with carry loop"],
    audience: "daily commuters and gym goers", sizeSpec: "500ml", quantity: "2",
  });
  assert.ok(d.title.length <= LIMITS.titleStrict, `标题 ${d.title.length} 字符`);
  assert.ok(d.highlights.length > 0, "标题放不下的片段被丢掉了（旧版本就是这么丢的）");
  assert.ok(d.highlights.length <= LIMITS.itemHighlights, `Highlights ${d.highlights.length} 字符`);
  // 官方格式要求是「逗号分隔短语」，不是句子
  assert.ok(!/[.。]$/.test(d.highlights), `Highlights 写成了句子：${d.highlights}`);
  // 材质与规格要进 Highlights（这是官方给这个字段的定位）
  assert.match(d.highlights, /stainless steel/);
  assert.match(d.highlights, /500ml/);
  // 长卖点句**不该**被搬进来 —— 它们本来就要进五点，搬过来只是重复
  assert.ok(!d.highlights.includes("Double-wall vacuum insulation keeps drinks cold"), "长卖点句被重复搬进 Highlights 了");
  assert.equal(d.headlineChars, d.title.length + d.highlights.length);
  // 生成的草稿必须硬规则全过（草的"及格线"就是这个）
  const lint = lintListing(d);
  assert.equal(lint.summary.hitP, 0, JSON.stringify(lint.results.filter((x) => x.status === "命中" && x.level === "P")));
});

t("草稿：没填规格、卖点里也没材质时，Highlights 留空并**如实说明原因**", () => {
  const d = generateListingDraft({ brand: "A", primaryKeyword: "bottle", features: ["keeps cold", "easy clean"] });
  assert.equal(d.highlights, "");
  const note = d.notes.join("\n");
  assert.match(note, /Item Highlights 还是空的/);
  assert.match(note, /没填规格|没有材质/, "要说清是「你没提供素材」，不是「我们忘了做」");
  // 反过来说清"补上有什么好处"，否则用户不知道为什么要管它
  assert.match(note, /参与搜索/);
});

t("后台字段：title_differentiation 用官方属性名，且排在 item_name 之后", () => {
  const keys = AMAZON_FIELDS.map((f) => f.key);
  assert.ok(keys.includes("title_differentiation"), "Item Highlights 不在后台字段表里");
  assert.equal(keys.indexOf("title_differentiation"), keys.indexOf("item_name") + 1,
    "两个字段的相邻顺序就是它们的依赖顺序（标题≤75 才有资格提交亮点），不能被打散");
  const f = AMAZON_FIELDS.find((x) => x.key === "title_differentiation");
  assert.equal(f.limit, 125);
  assert.equal(f.unit, "字符", "Highlight 按字符计，别写成字节");
  assert.equal(f.required, false, "官方说它不是必填，不该标成必填");
});

t("exportListingFields：两段式总账 + 标题超限时点明 Highlights 提交不上去", () => {
  const ok = exportListingFields({ title: "Ceramic Mug", highlights: "Ceramic, 350ml", bullets: [], searchTerms: "" });
  assert.equal(ok.budget.used, ok.budget.title + ok.budget.highlights);
  assert.equal(ok.budget.limit, 200);
  assert.equal(ok.budget.highlightsBlocked, false);
  assert.equal(ok.overflows.length, 0);
  const blocked = exportListingFields({ title: "A".repeat(80), highlights: "x" });
  assert.equal(blocked.budget.highlightsBlocked, true);
  assert.match(blocked.notes.join("\n"), /无法提交/);
  // 空 Highlights 也要有一句说明（这是新规最容易白丢的一块额度）
  assert.match(exportListingFields({ title: "Mug" }).notes.join("\n"), /留空等于放弃索引额度/);
});

t("Flat File CSV：列名用官方属性名，且按 RFC 4180 转义", () => {
  const out = exportFlatFileCsv(
    { title: "Mug", bullets: ['He said "hi", then left'], highlights: "Ceramic, 350ml", searchTerms: "mug" },
    { brand: "Acme", primaryKeyword: "mug" },
  );
  const [header, row] = out.csv.trim().split("\n");
  assert.match(header, /^item_name,title_differentiation,bullet1,/);
  assert.ok(header.includes("generic_keywords"));
  // 逗号要整体加引号、内部双引号要翻倍 —— 五点带逗号是常态，不转义会直接把一行撑成多列
  assert.ok(row.includes('"Ceramic, 350ml"'), `含逗号的字段没加引号：${row}`);
  assert.ok(row.includes('"He said ""hi"", then left"'), `双引号没翻倍：${row}`);
  // 必须说清它不是可直接提交的官方模板（各品类列名不同，说成模板会害人）
  assert.match(out.note, /不是|以你.*类目.*模板为准/);
});

/* ─── 16-CSV / 9-预校验：导出环节的两类"看起来没事"的缺陷 ───
 * ① 公式注入：以 = + - @ 开头的单元格在 Excel / Sheets 里会被**当公式执行**。
 * ② 预校验三层不分：把"本工具不检查"的项（UPC/价格/库存/主图）混进"全部通过"。
 */
t("CSV 公式注入：= + - @ 开头的单元格必须前置单引号（否则 Excel 会执行它）", () => {
  for (const evil of ["=cmd|' /C calc'!A0", "+1+1", "-2+3", "@SUM(1+1)"]) {
    const out = exportFlatFileCsv({ title: evil, bullets: ["a", "b", "c"], searchTerms: "" }, { brand: "Acme" });
    const row = out.csv.trim().split("\n")[1];
    assert.ok(row.startsWith(`"'${evil}"`) || row.startsWith(`'${evil}`), `未转义：${row.slice(0, 40)}`);
  }
  // 正常内容不许被无端加引号（加了也不算安全，只是污染数据）
  const ok = exportFlatFileCsv({ title: "Mug", bullets: ["a", "b", "c"], searchTerms: "" }, { brand: "Acme" });
  assert.ok(ok.csv.split("\n")[1].startsWith("Mug,"), `普通标题被改写了：${ok.csv.split("\n")[1].slice(0, 30)}`);
});

t("上传前预校验：三层分开报（硬缺口 / 建议改 / 本工具不检查）", () => {
  const bad = precheckForUpload({ title: "", bullets: [], searchTerms: "", highlights: "", description: "" }, {});
  assert.equal(bad.ok, false, "空表却报通过");
  assert.ok(bad.blockers.length >= 2, "空标题/空五点/空品牌至少要报出来");
  assert.ok(bad.blockers.some((b) => b.field === "item_name"), "没报标题为空");
  assert.ok(bad.blockers.some((b) => b.field === "brand"), "没报品牌为空");
  // 五点必须合并成一条，不能连报三条一样的错
  const bKeys = bad.blockers.filter((b) => /^bullet\d$/.test(b.field));
  assert.equal(bKeys.length, 0, "五点是逐条报的（应合并成一条 bullet_point）");

  // 三层里的第三层必须存在且说得具体 —— 这是"通过"这个词的边界
  assert.ok(bad.externals.length >= 4, "缺少「本工具不检查」清单");
  assert.ok(bad.externals.some((x) => /UPC|GTIN/i.test(x)), "没提 UPC/GTIN");
  assert.ok(bad.externals.some((x) => /价格|库存/.test(x)), "没提价格/库存");
  assert.match(bad.note, /文本字段/, "note 没限定覆盖范围");
});

t("上传前预校验：文本齐全时 ok=true，但仍保留 externals（不许说「可以提交了」）", () => {
  const good = precheckForUpload(
    { title: "Acme Steel Bottle 24oz", highlights: "Steel, for gym", bullets: ["A: x", "B: y", "C: z", "D: w", "E: v"], searchTerms: "bottle steel", description: "desc" },
    { brand: "Acme" },
  );
  assert.equal(good.ok, true, `不该有硬缺口：${JSON.stringify(good.blockers)}`);
  assert.ok(good.externals.length >= 4, "ok=true 时也必须保留「不检查项」");
});

t("前端接线：预校验按钮与页数选择都在，且 CSV 导出前会拦一道", () => {
  assert.match(HTML, /id="btnPrecheck"/, "页面缺预校验按钮");
  assert.match(HTML, /id="cpPages"/, "页面缺抓取页数选择");
  assert.match(APP, /precheckForUpload/, "前端没调用 precheckForUpload");
  assert.match(APP, /confirm\(/, "有硬缺口时没有确认环节（点一下就出一份传不上去的文件）");
});

t("多页抓取的页数上限是一个常量（服务端与自检共用，不写第二份）", () => {
  assert.equal(MAX_PAGES, 3, "页数上限被改动了？");
  const srv = codeOf(readFileSync(path.join(ROOT, "server.mjs"), "utf8"));
  assert.match(srv, /MAX_PAGES/, "server.mjs 没有引用 MAX_PAGES（自己写死了数字）");
  assert.ok(!/Math\.min\(3,/.test(srv), "server.mjs 里出现了字面量 3 的上限（第二份口径）");
});

t("体检报告：单文件 HTML、内容经过转义、且必须带边界声明", () => {
  const app = codeOf(readFileSync(path.join(ROOT, "assets/app.js"), "utf8"));
  assert.match(HTML, /id="btnHealth"/, "页面缺体检报告按钮");
  assert.match(app, /function healthReportHtml/, "没有报告生成函数");
  assert.match(app, /<!DOCTYPE html>/, "不是完整 HTML 文档（转发后打不开）");
  // 用户内容必须转义：报告会被转发/打开，未转义的标题就是一处 XSS
  assert.match(app, /esc\(x\.detail\)/, "规则明细没转义");
  assert.match(app, /esc\(name\)/, "标题没转义");
  // 边界声明三件套
  assert.match(app, /不是平台官方评分|不是\*\*.*官方评分|不是.{0,6}官方评分/, "没声明「不是官方评分」");
  assert.match(app, /UPC/, "没列「本工具不检查 UPC」");
  assert.match(app, /不预测排名/, "没声明不预测排名");
});

t("断言数守卫：减少即失败、增加只提示（防「删掉一条正在失败的断言」）", () => {
  assert.ok(existsSync(path.join(ROOT, "tools/expected-counts.json")), "缺期望值文件");
  const j = JSON.parse(readFileSync(path.join(ROOT, "tools/expected-counts.json"), "utf8"));
  for (const k of ["selftest", "verify-server", "browser-selftest"]) {
    assert.equal(typeof j[k], "number", `expected-counts.json 缺 ${k}`);
  }
  // 三套都必须真的接上守卫，否则文件形同虚设
  for (const f of ["selftest.mjs", "verify-server.mjs", "browser-selftest.mjs"]) {
    const src = readFileSync(path.join(ROOT, "tools", f), "utf8");
    assert.match(src, /checkAssertCount\(/, `${f} 没有接入断言数守卫`);
  }
});

t("前端接线：媒体口径开关 / Highlights 输入框 / 实时计数 / CSV 按钮都在", () => {
  assert.match(HTML, /id="lMedia"/, "页面缺类目口径开关");
  assert.match(HTML, /id="lHighlights"/, "页面缺 Item Highlights 输入框");
  assert.match(HTML, /id="lHighlightsCount"/, "页面缺 Highlights 实时计数");
  assert.match(HTML, /id="btnExportCsv"/, "页面缺 CSV 导出按钮");
  assert.match(APP, /highlights: \(\$\("#lHighlights"\)\?\.value \|\| ""\)\.trim\(\)/, "currentListing 没读 Highlights");
  assert.match(APP, /isMedia: \(\$\("#lMedia"\)\?\.value \|\| ""\) === "media"/, "lintCtx 没传 isMedia");
  // 计数必须用 listing.js 的 titleLimit，不能在 app.js 里重写一遍三元（两处口径会漂）
  assert.match(APP, /L\.titleLimit\(\{ isMedia: media \}\)/, "前端自己重算了标题上限");
  assert.match(HTML, /id="lTitleCount"/);
  assert.match(HTML, /id="lBudgetCount"/);
});

t("采集数据回填时会带上媒体口径判断（图书/音乐/影像不能被按 75 卡）", () => {
  const inp = productToWorkbenchInput({
    title: "Atomic Habits",
    breadcrumbs: ["Books", "Self-Help"],
    bullets: ["A book about habits"],
  });
  assert.equal(inp.isMedia, true, "图书类采集数据没被识别成 media");
  const normal = productToWorkbenchInput({ title: "Water Bottle", breadcrumbs: ["Home & Kitchen", "Drinkware"] });
  assert.equal(normal.isMedia, false);
  // 刻意不把 Video Games / Software 算进去 —— 公告只写了 media，猜错方向会让超限标题被报"通过"
  const games = productToWorkbenchInput({ title: "Racing Game", breadcrumbs: ["Video Games", "PC"] });
  assert.equal(games.isMedia, false, "Video Games 不该被当成 media（口径拿不准时宁可从严）");
});


/* ─────────────── 11. 数据采集 ─────────────── */
section("11. 亚马逊数据采集");

t("选择器表覆盖两个参考项目的关键路径", () => {
  assert.ok(SELECTORS.title.includes("#productTitle"));
  assert.ok(SELECTORS.bullets.some((s) => s.includes("#feature-bullets")));
  assert.ok(SELECTORS.bullets.some((s) => s.includes("#productFactsDesktopExpander")));
  assert.ok(SELECTORS.image.some((s) => s.includes("#landingImage")));
  assert.ok(SELECTORS.specTables.some((s) => s.includes("prodDetTable") || s.includes("depthLeftSections")));
});
t("识别站点并给出站点差异", () => {
  assert.equal(detectSite("https://www.amazon.de/dp/B00X").label, "德国站");
  assert.equal(detectSite("https://www.amazon.co.jp/dp/B00X").currency, "JPY");
});
t("书签脚本自包含（不引用本应用模块）", () => {
  const src = bookmarkletSource();
  assert.ok(!/import |require\(/.test(src));
  assert.match(src, /navigator\.clipboard/);
  assert.match(src, /productTitle/);
});
t("解析 JSON 输入", () => {
  const p = extractAny(JSON.stringify({ title: "T", bullets: ["a", "b"] }));
  assert.equal(p.title, "T");
  assert.equal(p.bullets.length, 2);
});
t("解析纯文本输入", () => {
  const p = extractAny("Title:\nAcme Water Bottle 24oz\n\n- keeps cold 24 hours\n- 304 stainless steel");
  assert.ok(p.title.includes("Acme"));
  assert.equal(p.bullets.length, 2);
});
t("空输入报错而不是静默返回空对象", () => assert.throws(() => extractAny("   ")));
t("JSON 里没有 title/bullets 时报错", () => assert.throws(() => extractAny('{"foo":1}')));

/* ─────────────── 11b. 搜索结果页批量采集（实时抓取的"批量"通道）───────────────
 * 这段刻意用**真实形态的 HTML 片段**做输入：这条通道的全部价值就是
 * "在亚马逊搜索结果页点一下 → 拿到整页竞品"。所以断言必须打在解析结果上，
 * 而不是"函数存在"这种空断言。
 */
section("11b. 搜索结果页批量采集（正则解析，可在 Node 断言）");

/** 一页 4 张卡片：正常 / 广告位 / 缺价格评分 / 与第 1 张同 ASIN（验证去重） */
const SEARCH_HTML = `
<div class="s-main-slot s-result-list">
  <div class="sg-col-4-of-12" data-component-type="s-search-result" data-asin="B0AAAAAAAA">
    <h2 aria-label="Stainless Steel Insulated Water Bottle 24oz, Leak Proof, Keeps Cold for 24 Hours"><a class="a-link-normal s-no-outline" href="/dp/B0AAAAAAAA/ref=sr_1_1"><span class="a-size-medium a-color-base a-text-normal">Stainless Steel Insulated Water Bottle 24oz</span></a></h2>
    <div class="a-row a-size-base a-color-base"><span class="a-price"><span class="a-offscreen">$20.00</span></span></div>
    <span aria-label="4.5 out of 5 stars"><i class="a-icon a-icon-star-small"></i></span>
    <div class="a-row"><a class="a-link-normal s-underline-text" href="#customerReviews"><span aria-label="1,234 ratings" class="a-size-base">1,234</span></a></div>
    <img class="s-image" src="https://m.media-amazon.com/images/I/bottle.jpg" alt="">
  </div>
  <div class="sg-col-4-of-12" data-component-type="s-search-result" data-asin="B0BBBBBBBB">
    <h2 aria-label="Bamboo Travel Mug 16oz with Lid, Spill Proof Coffee Cup"><a class="a-link-normal" href="/dp/B0BBBBBBBB/ref=sr_1_2"><span class="a-text-normal">Bamboo Travel Mug 16oz with Lid</span></a></h2>
    <span class="a-price"><span class="a-offscreen">$30.00</span></span>
    <span aria-label="4.8 out of 5 stars"></span>
    <a class="a-link-normal s-underline-text" href="#"><span aria-label="89 ratings">89</span></a>
    <span class="a-color-secondary">Sponsored</span>
    <img class="s-image" src="https://m.media-amazon.com/images/I/mug.jpg" alt="">
  </div>
  <div data-component-type="s-search-result" data-asin="B0CCCCCCCC">
    <h2 aria-label="Glass Water Carafe with Bamboo Lid, 1 Liter"><a class="a-link-normal" href="/dp/B0CCCCCCCC/ref=sr_1_3"><span class="a-text-normal">Glass Water Carafe with Bamboo Lid</span></a></h2>
    <img class="s-image" src="https://m.media-amazon.com/images/I/carafe.jpg" alt="">
  </div>
  <div data-component-type="s-search-result" data-asin="B0AAAAAAAA">
    <h2 aria-label="Stainless Steel Insulated Water Bottle 24oz, Leak Proof"><a class="a-link-normal" href="/dp/B0AAAAAAAA/ref=sr_1_9"><span class="a-text-normal">重复卡片</span></a></h2>
  </div>
</div>`;

t("一次解析整页商品：标题/价格/评分/评论数/ASIN 都拿到", () => {
  const r = extractSearchResults(SEARCH_HTML, "https://www.amazon.com/s?k=water+bottle");
  assert.equal(r.kind, "search");
  assert.equal(r.site, "amazon.com");
  assert.equal(r.keyword, "water bottle");
  assert.equal(r.items.length, 3, "4 张卡片里有 1 张是重复 ASIN，应去重成 3");
  const a = r.items.find((x) => x.asin === "B0AAAAAAAA");
  assert.equal(a.title, "Stainless Steel Insulated Water Bottle 24oz, Leak Proof, Keeps Cold for 24 Hours");
  assert.equal(a.price, "$20.00");
  assert.equal(a.rating, 4.5);
  assert.equal(a.reviewCount, 1234);
  assert.equal(a.url, "https://amazon.com/dp/B0AAAAAAAA/ref=sr_1_1", "相对链接要补成绝对链接");
  assert.equal(a.text, a.title, "标题即竞品文案（下游词频/覆盖度都吃这个）");
});
t("广告位被标记出来（而不是混在自然位里骗人）", () => {
  const r = extractSearchResults(SEARCH_HTML, "https://www.amazon.com/s?k=water+bottle");
  assert.equal(r.stats.sponsored, 1);
  const ad = r.items.find((x) => x.sponsored);
  assert.equal(ad.asin, "B0BBBBBBBB");
  assert.ok(r.note.includes("广告位"), "提示语里要写明有几个广告位");
});
t("统计口径一致：blocks 是卡片数，parsed/withAsin 是去重后的商品数", () => {
  const r = extractSearchResults(SEARCH_HTML, "https://www.amazon.com/s?k=water+bottle");
  assert.equal(r.stats.blocks, 4);
  assert.equal(r.stats.parsed, 3);
  assert.equal(r.stats.withAsin, 3, "withAsin 不能把重复卡片也算进去");
});
t("诚实边界写进 note：搜索页没有五点与描述", () => {
  const r = extractSearchResults(SEARCH_HTML, "https://www.amazon.com/s?k=x");
  assert.ok(/没有五点与描述/.test(r.note), r.note);
});
t("缺价格/评分/评论数时给 null，不编 0（0 会让「这一页均价」直接失真）", () => {
  const r = extractSearchResults(SEARCH_HTML, "https://www.amazon.com/s?k=x");
  const c = r.items.find((x) => x.asin === "B0CCCCCCCC");
  assert.equal(c.price, "");
  assert.equal(c.rating, null);
  assert.equal(c.reviewCount, null);
});
t("空 HTML 不抛错，给出可读提示（降级而不是崩）", () => {
  const r = extractSearchResults("", "https://www.amazon.de/s?k=kissen");
  assert.equal(r.items.length, 0);
  assert.equal(r.note, "没有输入 HTML。");
  assert.equal(r.site, "amazon.de", "没 HTML 时站点信息仍应解析出来");
  assert.equal(r.keyword, "kissen");
});
t("不是搜索结果页时给出 0 条而不是瞎猜", () => {
  const r = extractSearchResults("<html><body><h1>Amazon.com</h1></body></html>", "https://www.amazon.com/");
  assert.equal(r.items.length, 0);
  assert.equal(r.stats.blocks, 0);
});

t("页面类型判定：search / detail / unknown 三态", () => {
  assert.equal(detectPageKind(SEARCH_HTML), "search");
  assert.equal(detectPageKind('<div><span id="productTitle">T</span></div>'), "detail");
  assert.equal(detectPageKind('<div id="feature-bullets"></div>'), "detail");
  assert.equal(detectPageKind("<html><body>hello</body></html>"), "unknown");
  assert.equal(detectPageKind(""), "unknown");
});
t("HTML 实体只解码一次（&amp;lt; 不能变成 <）", () => {
  assert.equal(decodeEntities("A &amp; B"), "A & B");
  assert.equal(decodeEntities("&amp;lt;script&amp;gt;"), "&lt;script&gt;", "递归解码会吃掉用户数据里的转义");
  assert.equal(decodeEntities("&#39;q&#x27;"), "'q'");
  assert.equal(decodeEntities("&#8217;"), "\u2019");
  assert.equal(decodeEntities("&nbsp;"), " ");
  assert.equal(decodeEntities("&#1114112;"), "&#1114112;", "超出码点范围要原样保留，而不是产出非法字符");
  assert.equal(decodeEntities(null), "");
});

t("搜索结果 → 多竞品输入（name 用 ASIN，便于回查商品）", () => {
  const r = extractSearchResults(SEARCH_HTML, "https://www.amazon.com/s?k=x");
  const comps = searchItemsToCompetitors(r.items);
  assert.equal(comps.length, 3);
  assert.equal(comps[0].name, "B0AAAAAAAA");
  assert.ok(comps[0].text.includes("Insulated Water Bottle"));
  const corpus = searchItemsCorpus(r.items);
  assert.equal(corpus.split("\n").length, 3);
  assert.ok(corpus.includes("Bamboo Travel Mug"));
});
t("搜索结果概览统计：价位 / 评分 / 评论数量级", () => {
  const r = extractSearchResults(SEARCH_HTML, "https://www.amazon.com/s?k=x");
  const s = searchItemsSummary(r.items);
  assert.equal(s.total, 3);
  assert.equal(s.sponsored, 1);
  assert.equal(s.withAsin, 3);
  assert.deepEqual(s.price, { min: 20, max: 30, median: 25, avg: 25, n: 2 }, "缺价格的那条不能算进均价");
  assert.equal(s.rating.n, 2);
  assert.equal(s.reviewCount.n, 2);
  assert.equal(s.reviewCount.max, 1234);
});
t("概览统计在空列表上返回 null 而不是 NaN", () => {
  const s = searchItemsSummary([]);
  assert.equal(s.total, 0);
  assert.equal(s.price, null);
  assert.equal(s.rating, null);
  assert.equal(s.reviewCount, null);
});

t("书签脚本同时支持搜索结果页与详情页两条通道", () => {
  const src = bookmarkletSource();
  assert.match(src, /s-search-result/, "要能识别搜索结果页");
  assert.match(src, /kind:"search"/, "搜索结果页要输出带 kind 的载荷");
  assert.match(src, /productTitle/, "详情页通道不能被删掉");
  assert.match(src, /keyword:kw\(\)/, "搜索结果页要带回搜索词");
  // 自包含性：不能引用本应用模块，否则书签一贴到亚马逊就 ReferenceError
  assert.ok(!/import |require\(/.test(src));
});
t("书签脚本的搜索分支把「广告位数量」讲给用户听", () => {
  const src = bookmarkletSource();
  assert.match(src, /广告位/);
  assert.match(src, /多竞品对比/);
});

/* ─────────────── 11c. 多语种站点与词表 ─────────────── */
section("11c. 多语种：站点覆盖 / 停用词按语种 / 非 ASCII 不被拆成残词");

t("站点表覆盖主要 Marketplace（缺站点会让卖家选不到自己的站）", () => {
  for (const h of ["amazon.com", "amazon.co.uk", "amazon.de", "amazon.fr", "amazon.co.jp", "amazon.ca",
    "amazon.com.au", "amazon.in", "amazon.sg", "amazon.ae", "amazon.sa", "amazon.nl", "amazon.it",
    "amazon.es", "amazon.se", "amazon.pl", "amazon.com.be", "amazon.com.mx", "amazon.com.br", "amazon.com.tr"]) {
    assert.ok(SITES[h], `缺少站点 ${h}`);
    assert.ok(SITES[h].label && SITES[h].currency, `${h} 缺 label/currency`);
    assert.ok(Number.isInteger(SITES[h].titleLimit), `${h} 缺 titleLimit`);
    // 🔴 站点表是**展示用**的第二份口径，最容易忘改。用断言把它钉在 LIMITS 上：
    //    标题新规是全局的（除 media 外全类目、各站点一致），两边必须是同一个数。
    assert.equal(SITES[h].titleLimit, LIMITS.title, `${h} 的 titleLimit 与 LIMITS.title 不一致（旧口径 200 的残留？）`);
  }
});
t("站点 → 语种：只给「标题里满是虚词」的站点标语种，其余留空", () => {
  assert.equal(siteLang("amazon.de"), "de");
  assert.equal(siteLang("www.amazon.co.jp"), "ja", "要能容忍 www. 前缀");
  assert.equal(siteLang("amazon.com"), "", "美国站没有额外语种，别乱标");
  assert.equal(siteLang("amazon.com.au"), "");
  assert.equal(siteLang("example.com"), "", "未知站点返回空串而不是猜");
  assert.equal(siteLang(""), "");
  // SITE_LANG 与 SITES 必须自洽：一个表里有的语种，另一个表也得认
  for (const [host, lang] of Object.entries(SITE_LANG)) {
    assert.equal(SITES[host]?.lang, lang, `${host} 在 SITES 与 SITE_LANG 里不一致（同一事实写两遍就会漂）`);
  }
});
t("多语种停用词表不误伤英文同形词（这些在英语里是正当商品词）", () => {
  // 这是一条**反向断言**：曾经想把各语种并成一张大表，那样会把下面这些真词删掉
  // ⚠️ "will"/"in"/"of"/"is"/"was" 在**英文基础表**里本来就有（不是同形词问题），所以不列入本断言
  const CONFLICT = ["car", "son", "main", "man", "kind", "tag", "arm", "band", "ring", "boot",
    "hand", "note", "tank", "rock", "van", "door", "over", "fur", "solo", "plus", "war", "era"];
  for (const lang of ["de", "fr", "es", "it", "nl", "ja"]) {
    const set = stopwordsFor(lang);
    for (const w of CONFLICT) {
      assert.ok(!set.has(w), `${lang} 表里不该有 ${w}（会删掉英语里的真实关键词）`);
    }
  }
});

t("已知取舍被写下来而不是藏着：die 留在 de/nl 表里", () => {
  // 「die」是德语/荷兰语第一大虚词，去掉它德语挖掘就白做；但它是英语的 die（die-cut）。
  // 这是一个**有意为之**的取舍，所以用断言把它固定住 —— 免得日后有人"顺手"删掉，
  // 也免得有人以为这是漏改。代价与理由写在 STOPWORDS_BY_LANG 的注释里。
  assert.equal(stopwordsFor("de").has("die"), true);
  assert.equal(stopwordsFor("nl").has("die"), true);
  assert.equal(stopwordsFor("").has("die"), false, "英文基础表里没有 die，所以这只影响显式指定 de/nl 的情况");
});
t("stopwordsFor：不认识的语言退化成纯英文表，而不是抛错", () => {
  assert.equal(stopwordsFor("").has("the"), true);
  assert.equal(stopwordsFor("xx").has("the"), true);
  assert.equal(stopwordsFor(null).has("with"), true);
  assert.equal(stopwordsFor("de").has("mit"), true);
  assert.equal(stopwordsFor("de").has("the"), true, "英文基础表要一直在");
  assert.equal(stopwordsFor("DE").has("mit"), true, "大小写不敏感");
});
t("mineKeywords 默认行为不变（不传 lang 就还是纯英文表）", () => {
  const r = mineKeywords("Mug with Lid und mit Tee", {});
  const terms = r.terms.map((x) => x.term);
  assert.ok(terms.includes("mit"), "对照组：不传 lang 时 mit 会被当关键词（证明这是按需而非全局改）");
  assert.ok(terms.includes("und"));
  assert.ok(!terms.includes("with"), "英文停用词照旧生效");
});
t("mineKeywords 传 lang=de：「für」保留完整词形且虚词被清掉", () => {
  const r = mineKeywords("Edelstahl Thermoskanne für Kaffee und Tee mit Ausguss, Kühlschrank geeignet", { lang: "de" });
  const terms = r.terms.map((x) => x.term);
  assert.ok(terms.includes("kühlschrank"), `带变音符的词必须完整保留，实际 ${JSON.stringify(terms.slice(0, 8))}`);
  assert.ok(!terms.includes("fr"), "旧的 a-z0-9 清洗会把 für 拆成 fr（这正是被修掉的 bug）");
  for (const w of ["mit", "und", "für"]) assert.ok(!terms.includes(w), `${w} 是德语虚词，不该进关键词`);
});
t("mineKeywords 传 lang=ja：日语整串仍是 token，并显式告知「没做分词」", () => {
  const r = mineKeywords("ステンレス 水筒 保温 保冷 ステンレス 水筒 から まで", { lang: "ja" });
  assert.ok(r.stats.cjkTokens > 0);
  assert.ok(r.scriptNote.length > 0, "中日文必须给「不做分词」的说明，不能让用户把噪声当结论");
  assert.ok(!r.terms.map((x) => x.term).includes("から"), "两字助词应从日语表里清掉");
  const en = mineKeywords("stainless steel water bottle with lid", {});
  assert.equal(en.scriptNote, "", "英文语料不该出现中日文提示");
});
t("Search Terms 字段保留变音符与日文（不能把用户要投的词静默改错）", () => {
  const de = buildSearchTerms(["für", "Kühlschrank", "mit"]);
  assert.ok(de.terms.includes("kühlschrank"));
  assert.ok(de.terms.includes("für"));
  assert.ok(!de.terms.includes("fr"), "不能留下被剥掉变音符的残词");
  assert.equal(de.bytes, 21, "für(4) + 空格(1) + kühlschrank(12) + 空格(1) + mit(3) = 21 字节；按字符算会算成 19");
  const ja = buildSearchTerms(["水筒", "保温"]);
  assert.equal(ja.terms.length, 2, "日文词不能被清成空串后丢掉");
  assert.equal(ja.bytes, 13, "水筒(6) + 空格(1) + 保温(6) = 13 字节，按字符算会低估");
});
t("byteLength 正确处理 2/3/4 字节档（emoji 与 CJK 扩展区是 4 字节）", () => {
  assert.equal(byteLength("abc"), 3);
  assert.equal(byteLength("é"), 2);
  assert.equal(byteLength("水"), 3);
  assert.equal(byteLength("😀"), 4, "emoji 是 4 字节，当成 3 字节会低估长度导致超限");
  assert.equal(byteLength("\u{2000B}"), 4, "CJK 扩展 B 区也是 4 字节");
});

/* ─────────────── 12. Markdown 渲染安全 ─────────────── */
section("12. Markdown 渲染（含 XSS 防护）");

t("script 标签被转义", () => {
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!html.includes("<script>"), html);
  assert.ok(html.includes("&lt;script&gt;"));
});
t("img onerror 被转义", () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>');
  assert.ok(!/<img /.test(html), html);
});
t("表格渲染成 table", () => {
  const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
  assert.match(html, /<table>/);
  assert.match(html, /<th>a<\/th>/);
});
t("代码块内容不被当成 markdown", () => {
  const html = renderMarkdown("```text\n# not a heading\n**not bold**\n```");
  assert.match(html, /<pre><code>/);
  assert.ok(!html.includes("<h1>"));
  assert.ok(!html.includes("<strong>"));
});
t("行内 code 里的星号不被解析", () => {
  const html = renderMarkdown("use `a*b*c` here");
  assert.match(html, /<code>a\*b\*c<\/code>/);
});
t("escapeHtml 覆盖 5 个危险字符", () => {
  assert.equal(escapeHtml(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
});

/* ─────────────── 13. 编排层（主体抽取 + 离线一轮） ─────────────── */
section("13. 编排层：主体抽取与离线编排");

// 🔴 这节是补的 —— 之前编排层零覆盖，"主语抽脏"这类缺陷能一路溜到 14 张图的 Prompt 里。
t("主体抽取：去掉礼貌语/动词/量词", () => {
  assert.equal(extractSubject("帮我给这款宠物自动喂食器做一整套主图和详情页，走痛点驱动"), "宠物自动喂食器");
  assert.equal(extractSubject("给这款宠物自动喂食器做一整套主图和详情页，走痛点驱动"), "宠物自动喂食器");
  assert.equal(extractSubject("给我们的硅胶婴儿餐盘出一套图，情绪价值方向"), "硅胶婴儿餐盘");
  assert.equal(extractSubject("给我宠物喂食器做图"), "宠物喂食器");
});
t("主体抽取：风格从句不会被当成产品名", () => {
  assert.equal(extractSubject("宠物自动喂食器，风格高级一点"), "宠物自动喂食器");
  assert.equal(extractSubject("给这款折叠露营桌做一张爆款主图，情绪价值方向，要高级感"), "折叠露营桌");
});
t("主体抽取：前一句洗空时退到后一句", () => {
  assert.equal(extractSubject("帮我出一张白底主图，产品是无线蓝牙耳机"), "无线蓝牙耳机");
  assert.equal(extractSubject("我要做一张买家秀风格的照片，产品：折叠露营桌"), "折叠露营桌");
});
t("主体抽取：图类型前缀标签能切掉", () => {
  assert.equal(extractSubject("主图：不锈钢保温杯"), "不锈钢保温杯");
});
t("主体抽取：纯风格句返回空，而不是半截垃圾", () => {
  assert.equal(extractSubject("做一张促销海报 banner，走视觉驱动"), "");
  assert.equal(extractSubject("帮我出一张主图"), "");
  assert.equal(extractSubject(""), "");
});
t("主体抽取：不误杀带风格词的品名", () => {
  assert.equal(extractSubject("氛围灯"), "氛围灯");
  assert.equal(extractSubject("不锈钢保温杯"), "不锈钢保温杯");
});

const turn = runLocalTurn({ message: "帮我给这款宠物自动喂食器做一整套主图和详情页，走痛点驱动", pack: true });
t("离线一轮不发起网络请求就产出完整简报", () => {
  assert.equal(turn.subject, "宠物自动喂食器");
  assert.ok(turn.packPlan, "应产出图片包");
  assert.equal(turn.packPlan.counts.total, 14);
  assert.deepEqual(turn.audit, [], "自检问题：" + turn.audit.join("；"));
  assert.ok(turn.styleLock.startsWith("Campaign Style Lock"));
});
t("离线一轮的简报里产品名出现在 Prompt 上", () => {
  assert.match(turn.packPlan.items[0].prompt, /宠物自动喂食器/);
});
t("简报里外显机械自检结论（不能只字不提）", () => {
  let md = "";
  runLocalTurn({
    message: "帮我给这款宠物自动喂食器做一整套主图和详情页，走痛点驱动",
    pack: true,
    onEvent: (ev) => { if (ev.type === "ai_response") md = ev.content; },
  });
  assert.match(md, /机械自检\*\*：14 条 Prompt 逐条核过/, "通过时也要说清查了哪几条");
  assert.ok(!/机械自检未通过/.test(md), "不该有问题");
  // 🔴 A1：核的是 Prompt，不能说成"14 张逐张核过……通过"——那会被读成 14 张图都出好了。
  assert.ok(!/14 张逐张核过/.test(md), "把「核 Prompt」写成了「核成图」");
  assert.match(md, /核的是 Prompt，不是成图/, "没有把核查对象的边界说清");
  assert.match(md, /本次只出第 1 张成图/, "一次只执行 1 张，简报里必须声明（否则用户以为 14 张都在生成）");
});

/* ─── A1 的另一半：给出「逐张生成」的能力，而不是只解释为什么只出 1 张 ─── */
t("整套出图：packPayload 只发比例不发像素，且两端共用同一份", () => {
  const p = planImagePack({ subject: "x", driver: "visual", styleLock: buildStyleLock({}), pack: "full", amazonMain: true });
  const pp = packPayload(p);
  assert.equal(pp.total, p.items.length);
  assert.equal(pp.items.length, p.items.length);
  assert.ok(pp.items.every((x) => /^\d+:\d+$/.test(x.ratio)), "ratio 不是比例文本：" + pp.items.map((x) => x.ratio).join(","));
  assert.ok(pp.items.every((x) => x.code && x.prompt && x.prompt.length > 80), "缺 code/prompt");
  assert.equal(packPayload(null), null);
  assert.equal(packPayload({ items: [] }), null);
});

t("整套出图的界面入口：不自动开跑 / 有成本确认 / 可停止 / 单张失败不中断", () => {
  const app = codeOf(readFileSync(path.join(ROOT, "assets/app.js"), "utf8"));
  assert.match(app, /case "pack_ready"/, "界面没有处理 pack_ready 事件");
  // 成本确认：不许静默开跑。走统一 uiConfirm（原生 confirm 已全项目收口），
  // 判据是「确认框在身上 + 文案提到计费」——锁行为，不锁某个函数名的写法。
  const packHead = app.slice(app.indexOf("async function runPack"), app.indexOf("async function runPack") + 900);
  assert.match(packHead, /uiConfirm\(/, "开跑前没有成本确认（N 张就是 N 次计费）");
  assert.match(packHead, /计费|额度/, "成本确认里没提到「会花钱」这件事");
  assert.match(app, /data-pack-stop/, "没有「停止」按钮");
  assert.match(app, /p\.failed\.push/, "单张失败被吞掉了（应记录并继续）");
  // 串行：for 循环里 await，不许 Promise.all 并发打上游
  const runBody = app.slice(app.indexOf("async function runPack"), app.indexOf("/* ─────────────────────── 输入区"));
  assert.ok(!/Promise\.all/.test(runBody), "整套出图用了并发（会被上游限流）");
  assert.match(runBody, /for \(const it of p\.items\)/, "不是逐张串行");
  // 服务端也要发同一个事件，否则在线模式看不到入口
  const srv = codeOf(readFileSync(path.join(ROOT, "server.mjs"), "utf8"));
  assert.match(srv, /pack_ready/);
  assert.match(srv, /packPayload\(pack\)/, "服务端没复用 packPayload（自己拼了一份）");
});
t("抽不到主体时给占位符并在简报里显式告警", () => {
  let md = "";
  const bad = runLocalTurn({
    message: "做一张促销海报 banner，走视觉驱动",
    pack: true,
    onEvent: (ev) => { if (ev.type === "ai_response") md = ev.content; },
  });
  assert.match(bad.subject, /\{PRODUCT\}/, "应给占位符而不是半截垃圾");
  assert.ok(bad.single.prompt.includes("{PRODUCT}"), "Prompt 里应能看到占位符");
  assert.match(md, /没有识别到产品名/, "简报必须显式告警，否则用户会以为这是成品");
});

// 🔴 源码级断言：本项目最容易犯的错就是「同一份派生逻辑写两遍」。
//    这次就发生了 —— 主体抽取在 orchestrator 和 server 各有一份，
//    修好离线路径后服务端还在跑旧逻辑（浏览器里看到的仍是脏主体）。
t("服务端复用同一套编排，没有第二份主体抽取/简报实现", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(path.join(root, "server.mjs"), "utf8");
  assert.match(src, /runLocalTurn/, "服务端应调用 orchestrator 的 runLocalTurn");
  assert.ok(!/message\.replace\(\/\^\(帮我/.test(src), "服务端又出现了一份手写主体抽取");
  assert.ok(!/lines\.push\("### ① 匹配场景模板"\)/.test(src), "服务端又自己拼了一份简报 Markdown");
});
t("关键文件齐全（index / server / 5 个 assets / 自检脚本）", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (const f of ["index.html", "server.mjs", "package.json", ".env.example",
    "assets/app.js", "assets/app.css", "assets/templates.js", "assets/prompt-engine.js",
    "assets/listing.js", "assets/amazon.js", "assets/api.js", "assets/orchestrator.js",
    "assets/md.js", "tools/build-templates.mjs", "tools/selftest.mjs"]) {
    assert.ok(existsSync(path.join(root, f)), `缺文件：${f}`);
  }
});

/* ─────────────── 14. 英文支持与颜色识别加固 ─────────────── */
section("14. 英文支持与颜色识别（词边界 / 语序 / 未识别上报）");

t("语言判定：中文句判 zh、英文句判 en", () => {
  assert.equal(detectLang("帮我给这款宠物喂食器做主图"), "zh");
  assert.equal(detectLang("make a product photo for wireless earbuds"), "en");
  assert.equal(detectLang(""), "zh", "空串按中文兜底");
});

/* ── 语种边界（10/25）：日文里的汉字会让二元判定误判成中文，进而拿中文词表去套日文 ── */

t("书写系统判别：日文（有假名）判 ja、韩文判 ko、西里尔等判 other，不猜具体语种", () => {
  assert.equal(detectScript("セラミックマグ 350ml"), "ja");
  assert.equal(detectScript("食洗機対応のマグカップ"), "ja", "汉字+假名混排也必须判 ja，不能按汉字占比判 zh");
  assert.equal(detectScript("세라믹 머그 350ml"), "ko");
  assert.equal(detectScript("Керамическая кружка 350 мл"), "other");
  assert.equal(detectScript("陶瓷马克杯 350ml"), "zh");
  assert.equal(detectScript("Ceramic Mug 350ml"), "en");
  assert.equal(detectScript("350"), "zh", "纯数字（连字母都没有）沿用既定的中文兜底");
  assert.equal(detectScript("350ml"), "en", "带拉丁字母的规格串按英文走 —— 这是既有行为，不许因为新增语种而漂移");
});

t("detectLang 仍保持二元兼容（旧入口不变），利益词表已扩到 4 套", () => {
  assert.equal(detectLang("セラミックマグ 350ml"), "en", "二元入口的兼容行为，不能因为新增语种就改");
  assert.equal(LANG_SUPPORT.benefitWords.join(","), "zh,en,de,ja", "利益词表口径必须能被读到（界面与文档都引用它）");
});

t("🔴 日语五点：C3 用日语词表判，不拿中文/英文词表判死", () => {
  const good = lintListing(
    { title: "セラミックマグ 350ml", bullets: ["食洗機対応で毎日使えます", "軽量で持ち運びに便利", "保温性が高い"] },
    { brand: "Acme" },
  );
  const c3 = good.results.find((x) => x.id === "C3");
  assert.equal(c3.status, "通过", `日语利益词没被认出来：${c3.status} / ${c3.detail}`);
  assert.ok(/日语/.test(c3.detail), `detail 没说明用了哪套词表：${c3.detail}`);
  assert.ok(!/\*\*/.test(c3.detail), "detail 里不许出现 Markdown 星号（界面是纯文本渲染）");

  const bad = lintListing(
    { title: "セラミックマグ 350ml", bullets: ["容量は350mlです", "重さは280gです"] },
    { brand: "Acme" },
  );
  assert.equal(bad.results.find((x) => x.id === "C3").status, "命中", "没有任何利益词的日语五点应该被报出来");

  const ko = lintListing({ title: "세라믹 머그", bullets: ["세척이 쉽고 가벼워요", "전자레인지 사용 가능"] }, {});
  const koC3 = ko.results.find((x) => x.id === "C3");
  assert.equal(koC3.status, "跳过", "没有词表的语种必须跳过，不能猜");
  assert.ok(/未判定|未覆盖/.test(koC3.detail), "跳过必须说明原因");
});

t("🔴 德语五点：必须按所选语种判（拉丁字母不能被当成英文）", () => {
  const good = lintListing(
    { title: "Kaffeebecher 350ml", bullets: ["Spart Zeit im Alltag und hält Getränke lange warm", "Mühelos zu reinigen und spülmaschinenfest"] },
    { brand: "Acme", lang: "de" },
  );
  const c3 = good.results.find((x) => x.id === "C3");
  assert.equal(c3.status, "通过", `德语利益词没被认出来（很可能又退回英文表了）：${c3.detail}`);

  // 法/西/意/荷没有词表：必须明确「未覆盖」，不许拿英文表硬套
  const fr = lintListing({ title: "Mug", bullets: ["Gagne du temps et reste chaud longtemps", "Facile à nettoyer"] }, { lang: "fr" });
  const frC3 = fr.results.find((x) => x.id === "C3");
  assert.equal(frC3.status, "跳过", "法语没有词表，必须跳过而不是硬判");
  assert.ok(/未覆盖|未判定/.test(frC3.detail), "必须写清是「未覆盖」而不是含糊的失败");
});

t("语言边界写进了界面（不能只在代码里）", () => {
  assert.ok(/中 \/ 英 \/ 德 \/ 日 4 套/.test(HTML), "index.html 没写清有四套利益词表");
  assert.ok(/未覆盖/.test(HTML), "没告诉用户其余语种会被标成未覆盖");
});

t("🔴 英文色词必须带词边界（否则 hundred → 被 red 命中）", () => {
  const cases = [
    ["hundred items in stock", "hundred"],
    ["blueprint for the design", "blueprint"],
    ["blackberry and blacklist", "blackberry"],
    ["wooden table surface", "wooden"],
    ["screaming loud colors", "screaming"],
    ["rosemary extract", "rosemary"],
    ["reduce stress and refund policy", "reduce stress and refund policy"],
  ];
  for (const [input, keep] of cases) {
    const r = hexify(input);
    assert.ok(r.text.includes(keep), `「${input}」被误改了 → ${r.text}`);
    assert.equal(r.applied.length, 0, `「${input}」不该换色，却换了：${r.applied.join(",")}`);
  }
});

t("英文真色词仍然识别（a red mat with blue trim）", () => {
  const r = hexify("a red mat with blue trim");
  assert.equal(r.applied.length, 2, `只识别到 ${r.applied.length} 个：${r.applied.join(",")}`);
  assert.ok(!/\bred\b/.test(r.text), "red 没被替换");
  assert.ok(!/\bblue\b/.test(r.text), "blue 没被替换");
});

t("颜色概念词（莫兰迪/大地色/渐变）走 unrecognized 上报，不静默跳过", () => {
  const r = hexify("莫兰迪色系的地毯，低饱和大地色，渐变背景");
  assert.ok(r.unrecognized.includes("莫兰迪色系"), `没上报莫兰迪：${JSON.stringify(r.unrecognized)}`);
  assert.ok(r.unrecognized.length >= 2, `只上报了 ${r.unrecognized.length} 个`);
  assert.equal(new Set(r.unrecognized).size, r.unrecognized.length, "上报项有重复");
});

t("hexify 返回值结构稳定（text / applied / unrecognized / preExistingHex）", () => {
  const r = hexify("红色的杯子 #AABBCC");
  for (const k of ["text", "applied", "unrecognized", "preExistingHex"]) {
    assert.ok(k in r, `hexify 少了字段 ${k}`);
  }
  assert.equal(r.preExistingHex, 1, "已存在的 hex 没被统计");
});

t("色板至少 40 个色值（跨境文案的色词覆盖）", () => {
  const r = hexify("cream bronze copper forest olive mint teal taupe maroon burgundy coral magenta mauve plum lilac indigo");
  assert.equal(r.applied.length, 16, `只识别到 ${r.applied.length} 个色词`);
});

/* ─────────────── 15. 亚马逊合规首图（法规层与设计口径分离） ─────────────── */
section("15. 亚马逊合规首图（法规层 vs 设计构图口径）");

const mainLock = buildStyleLock({});
const mainPack = planImagePack({ subject: "ceramic coffee mug", driver: "visual", styleLock: mainLock, pack: "pdp", amazonMain: true });

t("法规常量与亚马逊官方图片要求一致", () => {
  assert.deepEqual(AMAZON_MAIN_IMAGE.productPct, [85, 100], "产品占幅应为 85-100%");
  assert.equal(AMAZON_MAIN_IMAGE.background, "#FFFFFF");
  assert.equal(AMAZON_MAIN_IMAGE.backgroundRgb, "RGB(255,255,255)");
  assert.equal(AMAZON_MAIN_IMAGE.maxEmptyPct, 15, "留白上限应为 15%");
  assert.equal(AMAZON_MAIN_IMAGE.minLongSidePx, 1000);
  assert.ok(AMAZON_MAIN_IMAGE.recommendLongSidePx >= AMAZON_MAIN_IMAGE.minLongSidePx);
  assert.ok(AMAZON_MAIN_IMAGE.disclosure, "缺少 AI 生成人像的披露要求");
});

/* ── 15a. AI 图片合规：补上「主图禁 AI」与「XMP 打标」两项 ──
 * 原实现只有一条 disclosure（AI 人像披露），主图用 AI 生成图、以及生成图不做元数据标记
 * 这两件事在系统里完全没有痕迹。新增两项后必须同时锁住**证据强度**：
 * 主图禁 AI 只有合并推论、没有原文，所以 sourceTier 必须写着"待核实"，
 * 否则界面与文档会把它讲成官方硬规定 —— 那正是本项目最反对的那种"说假话"。
 */
t("新增两项：主图禁 AI 生成 + AI 图元数据打标（都有独立字段）", () => {
  assert.ok(AMAZON_MAIN_IMAGE.mainImageNoAi, "缺少「主图不得是 AI 生成图」字段");
  assert.match(AMAZON_MAIN_IMAGE.mainImageNoAi, /do not use AI-generated/i);
  assert.ok(AMAZON_MAIN_IMAGE.aiMetadata, "缺少 AI 图元数据打标说明");
  assert.match(AMAZON_MAIN_IMAGE.aiMetadata, /trainedAlgorithmicMedia/, "没写 IPTC 的 DigitalSourceType 取值");
  assert.match(AMAZON_MAIN_IMAGE.aiMetadata, /C2PA|xmpMM/, "没给 C2PA / XMP 的落点");
});

t("证据强度如实标注：主图禁 AI 写的是「待核实」，不是「官方规定」", () => {
  const tier = AMAZON_MAIN_IMAGE.sourceTier;
  assert.ok(tier?.mainImageNoAi && tier?.aiMetadata, "sourceTier 缺项");
  assert.match(tier.mainImageNoAi, /待核实/, "把推论讲成了确证");
  assert.match(tier.mainImageNoAi, /推论/, "没写清这是两条官方要求合并出来的推论");
  assert.match(tier.aiMetadata, /未取得官方原文|行业规范/, "元数据那条没标证据来源");
});

t("主图 Prompt 含「不得用 AI 生成图」，且不套用人像披露（主体是产品不是人）", () => {
  const m = mainPack.items.find((x) => x.slot === "main");
  assert.match(m.prompt, /do not use AI-generated/i, "主图 Prompt 没禁止 AI 生成图");
  assert.ok(!/AI-generated people/.test(m.prompt), "主图不该出现人像披露句（会误导成「主图可以放 AI 人像」）");
});

t("主图交付清单：要求实物拍摄，并带「待核实」口径", () => {
  const m = mainPack.items.find((x) => x.slot === "main");
  assert.ok(Array.isArray(m.meta.deliveryChecklist) && m.meta.deliveryChecklist.length, "主图缺 deliveryChecklist");
  assert.match(m.meta.deliveryChecklist.join("\n"), /实物拍摄/);
  assert.match(m.meta.deliveryChecklist.join("\n"), /待核实/);
});

t("非主图交付清单：含 XMP 打标（且不塞进 Prompt —— 模型不会写元数据）", () => {
  const hero = mainPack.items.find((x) => x.slot !== "main");
  assert.ok(hero.meta.deliveryChecklist.join("\n").includes("trainedAlgorithmicMedia"), "非主图缺 XMP 打标提示");
  assert.ok(!hero.prompt.includes("trainedAlgorithmicMedia"), "元数据说明被塞进了 Prompt（模型无法执行，只是噪音）");
});

t("简报里把「交付前核对」单独成段（不能混在 Prompt 里让人以为已经做了）", () => {
  // 注意：说「做一张主图」走的是 white-bg 设计口径（slot=design），不是亚马逊首图；
  // 要 amazonMain 得说「亚马逊首图」——这里两条都测，分别对应两种交付清单。
  let md = "";
  runLocalTurn({
    message: "帮我给这款陶瓷马克杯做一张亚马逊首图",
    onEvent: (ev) => { if (ev.type === "ai_response") md = ev.content; },
  });
  assert.match(md, /交付前核对/, "简报没有交付前核对段");
  assert.match(md, /实物拍摄/, "亚马逊首图的交付核对没提实物拍摄");
});
t("非首图的简报里给的是 XMP 打标清单（两种图位的清单不同，不许混用）", () => {
  let md = "";
  runLocalTurn({
    message: "帮我给这款陶瓷马克杯做一张白底主图",
    onEvent: (ev) => { if (ev.type === "ai_response") md = ev.content; },
  });
  assert.match(md, /交付前核对/);
  assert.match(md, /trainedAlgorithmicMedia/, "非首图没给元数据打标清单");
  assert.ok(!/实物拍摄/.test(md), "非首图（设计口径）不该套用首图的实物拍摄口径");
});

t("图位口径表覆盖 design / main / secondary / aplus", () => {
  for (const k of ["design", "main", "secondary", "aplus"]) {
    assert.ok(SLOTS[k], `SLOTS 缺 ${k}`);
    assert.equal(typeof SLOTS[k], "string", `SLOTS.${k} 应该是人读的口径说明`);
  }
  assert.match(SLOTS.main, /85-100%/, "首图口径没写明 85-100%");
  assert.match(SLOTS.main, /纯白底|main image/);
});

t("开启 amazonMain 后多出 M0 首图，且总数 +1", () => {
  assert.equal(mainPack.counts.main, 1, "没有生成 M0");
  assert.equal(mainPack.items[0].slot, "main");
  assert.equal(mainPack.items[0].group, "main");
  const plain = planImagePack({ subject: "x", driver: "visual", styleLock: mainLock, pack: "pdp" });
  assert.equal(mainPack.items.length, plain.items.length + 1);
  assert.equal(plain.counts.main || 0, 0, "不开首图时不该有 main 项");
});

t("🔴 首图 Prompt 写的是 85-100% 占幅 + 纯白底 + 最多 15% 留白", () => {
  const p = mainPack.items[0].prompt;
  assert.match(p, /product occupies 85-100% of the frame/, "缺 85-100% 占幅");
  assert.match(p, /at most 15% of the frame may stay empty/, "缺 15% 留白上限");
  assert.match(p, /#FFFFFF/, "缺纯白底");
  assert.match(p, /RGB 255,255,255/, "缺 RGB 口径");
  assert.match(p, /1000/, "缺最短边像素要求");
  assert.match(p, /aspect ratio 1:1/, "缺 1:1 画幅声明");
});

t("🔴 首图禁止图内文字（平台法规优先于铁律 6 的三层文字架构）", () => {
  const p = mainPack.items[0].prompt;
  assert.match(p, /In-image text: NONE/, "首图没禁文字");
  assert.doesNotMatch(p, /28-48pt/, "首图还在给图内文字指定字号");
  assert.match(p, /overrides the usual 3-layer in-image text architecture/, "没显式声明优先级");
});

t("🔴 首图里出现 35-40% 只能是「明确否定」的语境", () => {
  const p = mainPack.items[0].prompt;
  // 允许写"这是亚马逊要求，故意不用副图那套 35-40%"，但不允许把 35-40% 当成首图的占幅要求
  assert.match(p, /NOT the 35-40% design-composition ratio/, "没有显式否定设计稿口径");
  for (const m of p.matchAll(/35-40%/g)) {
    const before = p.slice(Math.max(0, m.index - 30), m.index);
    assert.match(before, /NOT|not |而非|不是/, `35-40% 出现在非否定语境：…${before}35-40%`);
  }
  // 设计档（非首图）必须保留原口径
  const hero = mainPack.items.find((i) => i.group === "hero" && i.slot !== "main");
  assert.ok(hero, "缺少 hero 分组");
  assert.match(hero.prompt, /35-40%/, "设计档的 35-40% 口径被误删");
});

t("首图画幅固定 1:1（不受 heroRatio / pdpRatio 影响）", () => {
  const p = planImagePack({ subject: "x", driver: "visual", styleLock: mainLock, amazonMain: true, heroRatio: "4:5", pdpRatio: "9:16" });
  const m0 = p.items.find((i) => i.slot === "main");
  assert.equal(m0.size, SIZE_BY_FIGURE.main, `首图被改成 ${m0.size}`);
  assert.match(m0.prompt, /aspect ratio 1:1/);
});

t("首图 meta 带 slot / amazonMain / 合规注记", () => {
  const m0 = mainPack.items[0];
  assert.equal(m0.meta.slot, "main");
  assert.equal(m0.meta.amazonMain, true);
  assert.ok(m0.meta.complianceNotes, "缺少合规注记");
});

t("auditPlan 不报首图问题；反向测：动任一条首图硬约束都必须报错", () => {
  assert.equal(auditPlan(mainPack).length, 0, JSON.stringify(auditPlan(mainPack)));
  const clone = () => JSON.parse(JSON.stringify(mainPack));
  const cases = [
    ["去掉 85-100% 占幅", (m) => { m.items[0].prompt = m.items[0].prompt.replace(/product occupies 85-100% of the frame/, "product occupies a lot of the frame"); }],
    ["换成米白底", (m) => { m.items[0].prompt = m.items[0].prompt.replace(/#FFFFFF/g, "#F5F1E8").replace(/background #FFFFFF/g, "background #F5F1E8"); }],
    ["塞进图内文字", (m) => { m.items[0].prompt = m.items[0].prompt.replace("In-image text: NONE.", "In-image text: headline at 28-48pt reading Sale"); }],
    ["去掉 15% 留白上限", (m) => { m.items[0].prompt = m.items[0].prompt.replace(/at most 15% of the frame may stay empty/, "keep generous empty space"); }],
    ["去掉 1:1 画幅声明", (m) => { m.items[0].prompt = m.items[0].prompt.replace(/aspect ratio 1:1;/, "aspect ratio 4:5;"); }],
  ];
  for (const [name, mutate] of cases) {
    const m = clone();
    mutate(m);
    assert.ok(auditPlan(m).length > 0, `「${name}」竟然没报错`);
  }
});

t("auditPlan 主体健全性：占位符 / 过长主体都会报", () => {
  const withPh = JSON.parse(JSON.stringify(mainPack));
  withPh.subject = "{PRODUCT}";
  assert.ok(auditPlan(withPh).some((x) => /占位|PRODUCT/.test(JSON.stringify(x))), "占位符没报");
  const tooLong = JSON.parse(JSON.stringify(mainPack));
  tooLong.subject = "帮".repeat(40);
  assert.ok(auditPlan(tooLong).length > 0, "40 个汉字的主体（权重 80）应报过长");
});

t("自定义画幅只在非首图组生效", () => {
  const c = planImagePack({ subject: "x", driver: "visual", styleLock: mainLock, heroRatio: "4:5", pdpRatio: "9:16", amazonMain: true });
  assert.deepEqual([...new Set(c.items.filter((i) => i.group === "hero").map((i) => i.size))], ["4:5"]);
  assert.deepEqual([...new Set(c.items.filter((i) => i.group === "pdp").map((i) => i.size))], ["9:16"]);
  assert.equal(c.items.find((i) => i.slot === "main").size, SIZE_BY_FIGURE.main);
});

t("首图 Prompt 长度不超过 PROMPT_MAX_CHARS", () => {
  assert.ok(PROMPT_MAX_CHARS >= 1000);
  for (const it of mainPack.items) {
    assert.ok(it.prompt.length <= PROMPT_MAX_CHARS, `${it.id} 的 Prompt ${it.prompt.length} 字符超限`);
  }
});

t("SIZE_BY_FIGURE / FIGURE_SPEC 都含 main 档且与法规一致", () => {
  assert.equal(SIZE_BY_FIGURE.main, "1024x1024", "首图是平台合规位，固定方形");
  assert.ok(FIGURE_SPEC.main, "FIGURE_SPEC 缺 main 档");
  assert.deepEqual(FIGURE_SPEC.main.productPct, [85, 100]);
  assert.equal(FIGURE_SPEC.main.maxEmptyPct, 15);
  // 设计档必须与首图档**不同**，否则说明两套口径被合并了
  assert.notDeepEqual(FIGURE_SPEC.main.productPct, FIGURE_SPEC.hero.productPct);
});

/* ─────────────── 16. 英文主体抽取 ─────────────── */
section("16. 英文指令的主体抽取（语序 / 词边界 / 判空）");

t("英文「图类型 + of/for + 产品」语序（不能照搬中文的切片方向）", () => {
  const cases = [
    ["make a product photo for wireless bluetooth earbuds", "wireless bluetooth earbuds"],
    ["a product photo of the pet feeder", "pet feeder"],
    ["hero image for ceramic coffee mug", "ceramic coffee mug"],
    ["generate 5 images for a bamboo cutting board", "bamboo cutting board"],
    ["I need a product shot of stainless steel water bottle", "stainless steel water bottle"],
    ["create images of a leather wallet", "leather wallet"],
    ["a lifestyle photo for a dog harness", "dog harness"],
  ];
  for (const [input, want] of cases) {
    assert.equal(extractSubject(input), want, `「${input}」抽成了别的`);
  }
});

t("整句只有图类型词时判空，而不是把半截词当主体", () => {
  for (const s of ["hero image", "main image", "make me a product photo", "product photo", "white background"]) {
    assert.equal(extractSubject(s), "", `「${s}」应判空`);
  }
});

t("英文纯风格句判空（go premium / make it look premium）", () => {
  for (const s of ["go premium", "make it look premium", "keep it minimal"]) {
    assert.equal(extractSubject(s), "", `「${s}」应判空`);
  }
});

t("英文前导词的词边界：do 不能啃 dog、the 不能啃 theory", () => {
  assert.equal(extractSubject("a product photo for a dog harness"), "dog harness");
  assert.equal(extractSubject("product photo for theory craft book"), "theory craft book");
});

t("中文回归：图钉/图书架这类含「图」的品名不被自己的字误伤", () => {
  assert.equal(extractSubject("图钉"), "图钉");
  assert.equal(extractSubject("帮我给图钉做一张主图"), "图钉");
  assert.equal(extractSubject("白底主图"), "");
  assert.equal(extractSubject("主图：无线蓝牙耳机"), "无线蓝牙耳机");
});

t("中英混排：英文从句与中文从句都能各自抽干净", () => {
  assert.equal(extractSubject("帮我给这款宠物自动喂食器做一整套主图和详情页，走痛点驱动"), "宠物自动喂食器");
  assert.equal(extractSubject("product photo for a yoga mat, go premium"), "yoga mat");
});

/* ─────────────── 17. 服务端安全（导出/校验只有一份实现） ─────────────── */
section("17. 服务端安全：出网校验与静态白名单");

t("SSRF 判据模块被服务端引用（不是两份实现）", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(path.join(root, "server.mjs"), "utf8");
  assert.match(src, /from "\.\/assets\/net-guard\.js"/, "服务端没引用 net-guard");
  // 10/25 起 downloadToGen 走 downloadPinned（内含 resolvePublicHost + IP 钉死 + 逐跳复检），
  // 所以不再直接调 assertPublicUrl。断言改成「唯一的出口是 downloadPinned、且没有裸抓」。
  assert.match(src, /await downloadPinned\(url,/, "downloadToGen 没走 downloadPinned（SSRF 关口没了）");
  const i = src.indexOf("async function downloadToGen");
  const body = src.slice(i, src.indexOf("\n}", i));
  for (const raw of ["await fetch(", "https.get(", "http.get("]) {
    assert.ok(!body.includes(raw), `downloadToGen 里出现裸请求 ${raw} —— 绕过了内网校验`);
  }
  // 重定向改为 net-guard 里「逐跳重新解析 + 重新判内网」，不是直接拒绝 3xx、也不是放给 fetch 自动跟：
  const guard = readFileSync(path.join(root, "assets/net-guard.js"), "utf8");
  assert.match(guard, /res\.status >= 300 && res\.status < 400/, "net-guard 没有自己处理 3xx");
  assert.match(guard, /maxRedirects/, "net-guard 没设跳转上限（开放重定向会无限跟）");
  assert.ok(!/redirect: "follow"/.test(src), "服务端又放给自动重定向了");
  assert.ok(!/const PRIVATE_V4/.test(src), "服务端又内联了一份内网段判断");
});

t("静态服务是白名单（只放行 index.html 与 assets/）", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(path.join(root, "server.mjs"), "utf8");
  assert.match(src, /posix !== "index\.html" && !posix\.startsWith\("assets\/"\)/, "静态服务白名单不见了");
  assert.ok(!/if \(!full\.startsWith\(HERE\)\) return json\(res, 403/.test(src), "又回到只挡 .. 的旧逻辑");
});

t("Host 头校验存在（挡 DNS rebinding）", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(path.join(root, "server.mjs"), "utf8");
  // 不断言具体写法（10/25 起先取 reqHost 再复用），只断言两件缺一不可的事：
  //   ① 真的从 req.headers.host 取值（没取 = 校验没有输入，必然失效）；
  //   ② 真的用白名单挡（ALLOWED_HOSTS && !ALLOWED_HOSTS.has(...)）。
  assert.match(src, /bareHost\(req\.headers\.host\)/, "没从 req.headers.host 取 Host，校验拿不到输入");
  assert.match(src, /ALLOWED_HOSTS\s*&&\s*!ALLOWED_HOSTS\.has\(/, "Host 白名单校验缺失");
});

t(".env.local 是原子写入（tmp + rename），不是直接覆盖", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(path.join(root, "server.mjs"), "utf8");
  assert.match(src, /fs\.renameSync\(tmp, ENV_LOCAL\)/, "没做原子替换");
  assert.doesNotMatch(src, /fs\.writeFileSync\(ENV_LOCAL,/, "还在直接覆盖 .env.local");
});

t("net-guard 与服务端安全脚本都在仓库里", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (const f of ["assets/net-guard.js", "tools/verify-server.mjs"]) {
    assert.ok(existsSync(path.join(root, f)), `缺文件：${f}`);
  }
});

/* ─────────────── 18. 前端接线（浏览器跑不起来，只能做源码级断言） ─────────────── */
section("18. 前端接线（源码级断言）");

// HTML / APP 两个快照已提到文件顶部（见那里的注释）。

t("页面上每个 button id 都在 app.js 里被绑定（防「按钮点了没反应」）", () => {
  const ids = [...HTML.matchAll(/<button[^>]*id="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 10, `只找到 ${ids.length} 个按钮`);
  const missing = ids.filter((id) => !APP.includes(`"#${id}"`));
  assert.deepEqual(missing, [], `这些按钮没有绑定事件：${missing.join(", ")}`);
});

t("app.js 引用的 #id 必须真实存在（静态页面或自己渲染的模板里）", () => {
  const refs = [...new Set([...APP.matchAll(/\$\("#([A-Za-z0-9_-]+)"\)/g)].map((m) => m[1]))];
  // 有一批 id 是 app.js 自己 innerHTML 出来的（btnMineToKey / rmAttach 等），
  // 所以判定范围是"页面 + app.js 生成的模板"，不是只有 index.html。
  const declared = (id) => new RegExp(`id="${id}"`).test(HTML) || new RegExp(`id="${id}"`).test(APP);
  const missing = refs.filter((id) => !declared(id));
  assert.deepEqual(missing, [], `app.js 引用了不存在的 id：${missing.join(", ")}`);
});

t("Listing 质检把品类传给规则（否则 P6 品类分支永远走不到）", () => {
  assert.match(APP, /function lintCtx\(\)/, "没有统一的 ctx 构造函数");
  assert.match(APP, /category: \$\("#lCategory"\)/, "lintCtx 没带 category");
  assert.match(APP, /const r = L\.lintListing\(S\.listing, lintCtx\(\)\)/, "runLint 没用 lintCtx");
});

t("后台字段导出与复制按钮已接线，且超限/缺必填会被提示", () => {
  assert.match(APP, /L\.exportListingFields\(/, "没调用 exportListingFields");
  assert.match(APP, /out\.overflows/, "复制时不提示超限");
  assert.match(APP, /out\.missingRequired/, "复制时不提示缺必填");
  assert.match(APP, /navigator\.clipboard\.writeText/, "没做剪贴板复制");
  assert.match(APP, /downloadText\("listing-后台字段\.txt"/, "剪贴板不可用时没有降级路径");
});

t("词频的「不是搜索量」声明会显示在界面上（不能只写在代码注释里）", () => {
  assert.match(APP, /escapeHtml\(r\.note\)/, "mineKeywords 的免责声明没渲染到界面");
});

t("关键词覆盖度分析已接线，且缺口与免责声明都会渲染", () => {
  assert.match(HTML, /id="btnCoverage"/, "页面缺覆盖度分析按钮");
  assert.match(HTML, /id="coverOut"/, "页面缺覆盖度结果容器");
  assert.match(APP, /L\.analyzeCoverage\(/, "没调用 analyzeCoverage");
  assert.match(APP, /r\.gaps/, "没把「竞品有我没有」的缺口单独提示出来");
  assert.match(APP, /escapeHtml\(r\.note\)/, "覆盖度的免责声明没渲染到界面");
  // 候选词必须取用户填的关键词 + ③ 卡的竞品语料，不能只取一个
  assert.match(APP, /keywords:[\s\S]{0,80}lKeywords/, "没接用户关键词输入");
  assert.match(APP, /competitorText:[\s\S]{0,80}lCorpus/, "没接竞品语料输入");
});

t("描述字段贯通：页面有输入框、草稿会填充、导出会带", () => {
  assert.match(HTML, /id="lDesc"/, "页面缺描述输入框");
  // 窗口从 300 放宽到 700：窗口的作用是"限定在同一个函数里"，不是"限定字符数"。
  // 2026-09-29 加了 highlights 字段 + 一段注释后 300 就够不着了 —— 这种失败是假警报，
  // 但**不能删掉这条断言**：它真正防的是"新加的字段把 description 挤掉了"。
  assert.match(APP, /function currentListing\(\)[\s\S]{0,700}description:/, "currentListing 没带 description");
  // 2026-11-08：草稿落盘改成表驱动（draftFields），因为写入前要能比对冲突、写入后要能撤销。
  // 断言跟着改成"表里必须有 lDesc ← d.description" —— 防的东西没变：新字段不许把描述挤掉。
  assert.match(APP, /\["lDesc",\s*d\.description/, "草稿没填充描述（draftFields 里缺 lDesc）");
});

t("前端只引用真实存在的导出（import 的名字不能写错）", () => {
  const listingSrc = readFileSync(path.join(ROOT, "assets/listing.js"), "utf8");
  const exported = new Set(
    [...listingSrc.matchAll(/^export (?:function|const) ([A-Za-z0-9_]+)/gm)].map((m) => m[1]),
  );
  assert.ok(exported.size >= 15, `只解析到 ${exported.size} 个导出，正则可能失效了`);
  const used = [...new Set([...APP.matchAll(/\bL\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))];
  const missing = used.filter((n) => !exported.has(n));
  assert.deepEqual(missing, [], `app.js 用了 listing.js 没导出的名字：${missing.join(", ")}`);
});

/* ─── 18b. 本轮新增功能的接线（批量采集 → 多竞品对比 → 留档 → 图片库）─── */

t("采集结果按 kind 分流：搜索页载荷不能交给商品渲染器", () => {
  // 允许中间有注释/收起评论卡等语句，但必须是**同一个分支**（404 字符内）
  assert.match(APP, /r\.kind === "search"[\s\S]{0,400}renderSearch\(r\)/, "没有按 kind 分流");
  assert.match(APP, /S\.search = r/, "搜索结果没被记住（后面的一键对比要用）");
  assert.match(APP, /function renderSearch\(r\)/, "缺整页商品表的渲染函数");
  assert.match(HTML, /id="btnExportProduct"/, "导出按钮还在（两种载荷都要能导出）");
  assert.match(APP, /S\.search \|\| S\.product/, "导出/保存没覆盖搜索结果这条分支");
});

t("批量采集有闭环：整页 → 多竞品对比 / 词频，且语种自动带过去", () => {
  assert.match(APP, /\$\("#btnSearchToCompare"\)\.onclick/, "缺「整页送去多竞品对比」按钮的接线");
  assert.match(APP, /btnSearchToCompare"\)\.onclick[\s\S]{0,900}\$\("#btnCompare"\)\.click\(\)/, "一键对比没有真的触发对比");
  assert.match(APP, /\$\("#btnSearchToCorpus"\)\.onclick[\s\S]{0,900}\$\("#btnMine"\)\.click\(\)/, "一键词频没有真的触发挖掘");
  assert.match(APP, /A\.searchItemsToCompetitors\(items\)/, "没复用 amazon.js 的转换函数（会写出第二份实现）");
  assert.match(APP, /A\.siteLang\(r\.site\)/, "没有按采集到的站点自动选语种");
  assert.match(APP, /searchItemsSummary\(items\)/, "没有展示整页的价位/评分概览");
});

t("多竞品对比已接线，且共识词能一键回填关键词框", () => {
  assert.match(HTML, /id="btnCompare"/, "页面缺多竞品对比按钮");
  assert.match(HTML, /id="compareOut"/, "页面缺对比结果容器");
  assert.match(APP, /L\.compareCompetitors\(/, "没调用 compareCompetitors");
  assert.match(APP, /r\.consensus/, "没把「全类目共识词」单独呈现（这是对比的核心结论）");
  assert.match(APP, /x\.consensus \?[\s\S]{0,80}全类目共识/, "没区分共识词与差异化词");
  assert.match(APP, /escapeHtml\(r\.source\)/, "对比口径的来源没渲染到界面");
  assert.match(HTML, /id="lLang"/, "页面缺语种选择（缺了就只能靠英文停用词表挖德语）");
});

t("语种一路传到底：挖掘 / 对比 / 覆盖度三处都吃这个参数", () => {
  assert.match(APP, /mineKeywords\(text, \{ top: 40, lang \}\)/, "词频挖掘没传 lang");
  assert.match(APP, /compareCompetitors\(raw, \{ top: 40, lang \}\)/, "多竞品对比没传 lang");
  assert.match(APP, /analyzeCoverage\(S\.listing, \{[\s\S]{0,400}lang:/, "覆盖度分析没传 lang");
  // 中日文「不做分词」的诚实说明必须显示，不能只写在代码注释里
  assert.match(APP, /r\.scriptNote/, "scriptNote 没渲染到界面");
});

t("本地产物接线：三类产物会自动留档，且能看到/导出/删除", () => {
  assert.match(APP, /import \* as STORE from "\.\/store\.js"/, "没引入持久化层");
  assert.match(APP, /function saveArtifact\(/, "缺统一的留档入口");
  assert.match(APP, /STORE\.save\(kind, title, payload, meta\)/, "saveArtifact 没落到 store.save");
  assert.ok((APP.match(/saveArtifact\("/g) || []).length >= 4, "至少采集/词频/对比/覆盖度四处要留档");
  assert.match(APP, /STORE\.summarize\(rec\)/, "列表没用人话摘要（只给 id 等于没法用）");
  assert.match(APP, /STORE\.toExport\(rows\)/, "缺导出全部（产物必须能带走）");
  assert.match(APP, /STORE\.importFrom\(/, "缺导入");
  assert.match(HTML, /id="vaultList"/, "页面缺产物列表容器");
  assert.match(APP, /!st\.available[\s\S]{0,200}不受影响/, "浏览器不支持时要讲清「别的功能不受影响」，而不是让它看起来像坏了");
});

t("图片库接线：缩略图墙 / 单个下载 / 删除 / 打包下载 / 离线提示", () => {
  assert.match(HTML, /id="libGrid"/, "页面缺缩略图墙容器");
  assert.match(APP, /fetch\(apiUrl\("\/api\/library"\)\)/, "没调列表接口");
  assert.match(APP, /method: "DELETE"/, "没做删除");
  assert.match(APP, /apiUrl\("\/api\/library\?zip=1"\)/, "没做打包下载");
  assert.match(APP, /confirm\(/, "删除本机文件前必须点名确认");
  assert.match(HTML, /id="libOffline"/, "缺离线提示（看不到 ≠ 丢了，必须说清）");
  assert.match(APP, /\$\("#libOffline"\)[\s\S]{0,300}if \(!S\.probe\.online\)/, "离线提示节点没有接到探活结果上");
});

t("采集结果可以手动存快照，并给出可读回执", () => {
  assert.match(HTML, /id="btnSaveCapture"/, "页面缺保存按钮");
  assert.match(APP, /saveArtifact\("capture"/, "保存按钮没落到 capture 类型");
  assert.match(APP, /已存入本地产物|存不了/, "保存后没有回执（用户不知道成没成）");
});

t("file:// 死页面被正面处理：经典脚本提示 + 不再声称「双击就能用」", () => {
  // 实测（Edge 153 headless --dump-dom）：file:// 下 DOM 只有 23.9KB（静态骨架，JS 一行没跑），
  // http:// 下 322KB。所以"双击 index.html 也能用"是假的，必须挡住这个误导。
  const scripts = [...HTML.matchAll(/<script([^>]*)>/g)].map((m) => m[1]);
  const classic = scripts.filter((a) => !/type\s*=\s*["']module["']/.test(a));
  assert.ok(classic.length >= 1, "index.html 里至少要有一段**经典**脚本 —— 用 module 写的提示在 file:// 下加载不了，提示自己也跑不起来");
  assert.match(HTML, /location\.protocol !== "file:"/, "没有检测 file://");
  assert.ok(/file:[\s\S]{0,1500}node server\.mjs/.test(HTML), "提示里要给出正确的启动命令");
  assert.ok(!/直接双击\s*index\.html\s*也可以/.test(HTML), "仍然在声称「双击 index.html 也可以」—— 实测是死页面");
  assert.ok(!/本机离线模式/.test(APP), "界面不该再叫「本机离线模式」—— 那个模式并不存在（file:// 下应用根本不启动）");
  assert.match(HTML, /id="lLang"/, "语种选择要在页面上");
});

/* ─────────────── 19. 本地持久化（store.js）───────────────
 * 浏览器专属能力（IndexedDB）在 Node 里跑不了。所以这一层的断言分两半：
 *   ① 纯函数层 —— 记录构造 / 裁剪 / 排序 / 淘汰 / 指纹 / 摘要，全部可直接断言；
 *   ② 降级路径 —— 在没有 IndexedDB 的环境里，每个 API 都必须给出**明确的否定返回值**
 *      而不是抛错。否则整页别的功能会被一个"存不了"拖垮。
 */
section("19. 本地持久化（IndexedDB 层 + 可断言的纯函数）");

t("产物类型表：四种 kind 都有展示用的 label/icon（历史面板要用）", () => {
  assert.deepEqual(Object.keys(KINDS).sort(), ["capture", "coverage", "listing", "plan"]);
  for (const [k, v] of Object.entries(KINDS)) {
    assert.ok(v.label && v.icon, `${k} 缺 label/icon`);
  }
  assert.equal(isValidKind("plan"), true);
  assert.equal(isValidKind("__proto__"), false, "原型链上的键不算合法 kind");
  assert.equal(isValidKind("nope"), false);
});

t("指纹稳定：同样的输入给同样的值，不同输入给不同的值", () => {
  assert.equal(fingerprint("abc"), fingerprint("abc"));
  assert.notEqual(fingerprint("abc"), fingerprint("abd"));
  assert.equal(fingerprint(""), fingerprint(""));
  assert.equal(fingerprint(null), fingerprint(""));
  assert.match(fingerprint("x"), /^[0-9a-z]+$/);
});

t("载荷超限时裁剪，并**显式标记**被裁剪过（静默截断会让用户以为存全了）", () => {
  const small = trimPayload("hello", 100);
  assert.equal(small.truncated, false);
  assert.equal(small.payload, "hello");
  assert.equal(small.chars, 5);
  const big = trimPayload("x".repeat(50), 10);
  assert.equal(big.truncated, true);
  assert.equal(big.chars, 10);
  assert.equal(big.payload.__truncated, true);
  assert.equal(big.payload.__originalChars, 50);
  assert.equal(big.payload.preview.length, 10);
  assert.match(big.payload.note, /超出单条上限/);
  // 对象载荷也要能量长度（存的是 JSON 字符串）
  assert.equal(trimPayload({ a: 1 }).chars, JSON.stringify({ a: 1 }).length);
});

t("构造记录：未知 kind 报错、空标题有兜底、超长标题截断、时间可注入", () => {
  assert.throws(() => makeRecord("bogus", "t", {}), /未知的产物类型/);
  const r = makeRecord("plan", "   ", { a: 1 }, {}, 1700000000000);
  assert.equal(r.title, "（未命名）");
  assert.equal(r.createdAt, 1700000000000);
  assert.equal(r.kind, "plan");
  assert.equal(r.truncated, false);
  assert.ok(r.fingerprint);
  const long = makeRecord("plan", "题".repeat(300), {}, {});
  assert.equal(long.title.length, 120, "标题要截到 120 字符，否则历史列表会被撑爆");
  assert.equal(makeRecord("plan", "t", {}, "not-an-object").meta.constructor, Object, "meta 必须是对象");
});

t("排序：新的在前（不依赖 IndexedDB 游标方向）", () => {
  const rows = [{ id: 1, createdAt: 100 }, { id: 2, createdAt: 300 }, { id: 3, createdAt: 200 }];
  assert.deepEqual(sortRecords(rows).map((r) => r.id), [2, 3, 1]);
  assert.deepEqual(rows.map((r) => r.id), [1, 2, 3], "不能原地改传入的数组");
  assert.deepEqual(sortRecords(null), []);
  assert.deepEqual(sortRecords([{ id: 1 }]), [{ id: 1 }], "缺 createdAt 时按 0 处理，不抛错");
});

t("淘汰策略：只留最新 N 条，返回要删的 id（且跳过没有 id 的脏数据）", () => {
  const rows = [1, 2, 3, 4, 5].map((i) => ({ id: i, createdAt: i }));
  assert.deepEqual(pickEvictions(rows, 3), [2, 1], "createdAt 最小的两条要被淘汰");
  assert.deepEqual(pickEvictions(rows, 10), [], "没超上限就不删");
  assert.deepEqual(pickEvictions([{ createdAt: 1 }, { createdAt: 2 }], 1), [], "没有 id 的记录不能被当成待删项");
  assert.equal(MAX_RECORDS_PER_KIND, 60);
  assert.ok(MAX_PAYLOAD_CHARS >= 100_000, "单条上限太小会存不下一份完整图像方案");
});

t("体量格式化与历史摘要（历史面板要讲清「存了什么」而不是只给 id）", () => {
  assert.equal(formatSize(0), "0 B");
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(1024), "1.0 KB");
  assert.equal(formatSize(1024 * 1024), "1.0 MB");
  assert.equal(formatSize(null), "0 B");
  const s = summarize({
    id: 7, kind: "coverage", title: "Dog Harness 覆盖度",
    meta: { coveragePct: 62, rules: 20 }, payload: { a: 1 },
    createdAt: Date.UTC(2026, 0, 2, 3, 4), truncated: true,
  });
  assert.equal(s.id, 7);
  assert.equal(s.label, "覆盖度");
  assert.equal(s.icon, KINDS.coverage.icon);
  assert.match(s.time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.ok(s.detail.includes("覆盖 62%"), s.detail);
  assert.ok(s.detail.includes("⚠️ 已裁剪"), "裁剪标记必须出现在列表摘要里");
  assert.match(s.sizeText, /B|KB|MB/);
  assert.equal(summarize(null), null);
});

t("导出结构自带来源与条数（产物是用户的，必须能带走）", () => {
  const txt = storeExport([{ id: 1, kind: "plan", title: "t", payload: {}, createdAt: 1, meta: {} }]);
  const j = JSON.parse(txt);
  assert.equal(j.count, 1);
  assert.equal(j.items.length, 1);
  assert.match(j.app, /Listing/);
  assert.ok(j.exportedAt);
  // 🔴 A4：没有版本号 = 以后改字段含义时，老文件导回来会"看起来成功、内容全错"
  assert.equal(j.schemaVersion, EXPORT_SCHEMA, "导出物没有版本号");
  assert.equal(typeof EXPORT_SCHEMA, "number");
});

await ta("Node 里没有 IndexedDB：所有 API 都给明确否定值，而不是抛错", async () => {
  assert.equal(storeAvailable(), false, "自检环境本来就不该有 IndexedDB");
  assert.deepEqual(await storeList(), []);
  assert.equal(await storeGet(1), null);
  assert.deepEqual(await storeSave("plan", "t", {}, {}), { ok: false, reason: "unavailable" });
  assert.deepEqual(await storeRemove(1), { ok: false, reason: "unavailable" });
  assert.deepEqual(await storeClear(), { ok: false, reason: "unavailable" });
  const st = await storeStats();
  assert.equal(st.total, 0);
  assert.equal(st.available, false);
  assert.equal(st.quota, null);
  assert.deepEqual(Object.keys(st.byKind).sort(), ["capture", "coverage", "listing", "plan"], "即使存不了也要给出完整的四类计数");
});

await ta("导入：坏 JSON / 缺 items 都返回可读错误；非法 kind 计入 skipped 而不是崩", async () => {
  assert.equal((await storeImport("not json")).ok, false);
  assert.match((await storeImport("not json")).error, /不是合法 JSON/);
  assert.equal((await storeImport('{"foo":1}')).ok, false);
  assert.match((await storeImport('{"foo":1}')).error, /items/);
  const r = await storeImport(JSON.stringify({ items: [{ kind: "bogus" }, { kind: "plan", title: "t", payload: {} }] }));
  assert.equal(r.ok, true);
  assert.equal(r.added, 0, "存不了的环境里 added 应该是 0");
  assert.equal(r.skipped, 2, "非法 kind 与存不进去的都要算 skipped");
  assert.equal((await storeImport(JSON.stringify([{ kind: "plan", title: "t" }]))).ok, true, "也接受裸数组");
});

await ta("导入按 schemaVersion 分流：旧文件兼容并提示，未来版本直接拒绝", async () => {
  const one = JSON.stringify({ items: [{ kind: "plan", title: "t", payload: {} }] });

  // ① 有版本号且等于当前版本 → 正常，不该有 warning
  const cur = await storeImport(JSON.stringify({ schemaVersion: EXPORT_SCHEMA, ...JSON.parse(one) }));
  assert.equal(cur.ok, true);
  assert.equal(cur.warning, undefined, "当前版本不该报警告");

  // ② 没有版本号（v1 之前导出的）→ 继续能吃，但必须说清是旧格式
  const legacy = await storeImport(one);
  assert.equal(legacy.ok, true, "旧文件必须还能导入");
  assert.ok(legacy.warning, "吃下旧格式却不提示 = 让用户以为文件本来就有版本号");
  assert.match(legacy.warning, /旧格式|版本号/);

  // ③ 更高版本 → 拒绝，且说清为什么（强行导入会静默丢字段）
  const future = await storeImport(JSON.stringify({ schemaVersion: EXPORT_SCHEMA + 1, items: [] }));
  assert.equal(future.ok, false, "未来版本被硬吃进来，会静默丢字段");
  assert.match(future.error, /更新的版本/);
  assert.equal(future.schemaVersion, EXPORT_SCHEMA + 1);

  // ④ 非法版本号 → 拒绝（不猜"大概是想写 1"）
  for (const bad of ["1", 0, -1, 1.5]) {
    const r = await storeImport(JSON.stringify({ schemaVersion: bad, items: [] }));
    assert.equal(r.ok, false, `schemaVersion=${JSON.stringify(bad)} 应当被拒`);
    assert.match(r.error, /schemaVersion/);
  }
});

/* ─────────────── 20. 静默失败加固 ─────────────── */
section("20. 静默失败加固（识图降级要醒目 / 探活缓存要会过期）");

const SERVER_SRC = readFileSync(path.join(ROOT, "server.mjs"), "utf8");
const API_SRC = readFileSync(path.join(ROOT, "assets/api.js"), "utf8");
const CSS_SRC = readFileSync(path.join(ROOT, "assets/app.css"), "utf8");

t("识图失败不再静默降级：先查 HTTP 状态、再查空内容", () => {
  assert.ok(SERVER_SRC.includes("识图接口 HTTP"), "原来不看 resp.ok，401/429 会被当成「识图成功但内容为空」");
  assert.ok(SERVER_SRC.includes("识图返回空内容"));
  // 必须有"响应不 ok 就抛"的分支，否则 json() 成功取到空串仍会静默退回纯文本生图
  assert.match(SERVER_SRC, /if \(!resp\.ok\) \{[\s\S]{0,200}throw new Error/);
});
t("降级事件带 level:\"warn\"，并在文案里说清「没有参考你的图」", () => {
  assert.ok(SERVER_SRC.includes('level: "warn"'), "服务端要标出这是降级不是成功");
  assert.ok(SERVER_SRC.includes("参考图里产品的真实外观没有被参考"), "必须明说后果，不能只写「识图失败」");
  assert.ok(SERVER_SRC.includes("未参考原图"), "图片卡片上也要带这个标记");
});
t("前端把 warn 单独一档渲染（不能混进绿色的「已完成」）", () => {
  assert.match(APP, /ev\.level === "warn"\s*\?\s*"warn"\s*:\s*"ok"/);
  assert.match(APP, /st === "warn" \? " warn" : ""/, "渲染时要挂上 warn 样式类");
  assert.ok(CSS_SRC.includes(".bubble-tool.warn"), "CSS 里要有对应的视觉区分");
  assert.ok(CSS_SRC.includes(".tdot.warn"));
});
t("探活缓存有 TTL，且失败结果过期更快（否则服务起起来了页面还显示未连接）", () => {
  assert.ok(PROBE_TTL_MS > 0 && PROBE_TTL_FAIL_MS > 0);
  assert.ok(PROBE_TTL_FAIL_MS < PROBE_TTL_MS, "失败要比成功更快失效");
  const ok = { online: true, capabilities: {} };
  const bad = { online: false, reason: "连不上" };
  const at = 1_000_000;
  assert.equal(probeCacheFresh(ok, at, at), true);
  assert.equal(probeCacheFresh(ok, at, at + PROBE_TTL_MS - 1), true);
  assert.equal(probeCacheFresh(ok, at, at + PROBE_TTL_MS + 1), false, "成功结果过期后必须重新探活");
  assert.equal(probeCacheFresh(bad, at, at + PROBE_TTL_FAIL_MS - 1), true);
  assert.equal(probeCacheFresh(bad, at, at + PROBE_TTL_FAIL_MS + 1), false, "失败缓存不能赖着不走");
  assert.equal(probeCacheFresh(null, at, at), false, "没有缓存就该探活");
});
t("probeServer 走的是同一个判据（不是另写一份 if）", () => {
  assert.match(API_SRC, /probeCacheFresh\(probeCache, probeAt\)/, "TTL 判据只有一处实现");
  assert.match(API_SRC, /clearProbeCache\(\) \{ probeCache = null; probeAt = 0; \}/, "清缓存必须同时清时间戳");
  assert.match(APP, /clearProbeCache\(\);[\s\S]{0,120}probeServer\(\{ force: true \}\)/, "改完配置要清缓存并强制重探");
});

/* 🔴 界面不许说假话 —— 这两条是 2026-09-29 诊断真实用户问题时抓出来的：
 * ① 右上角标签只看「服务端在线」就写「可出图」，而没配图片 key 时其实出不了；
 * ② 简报里让用户「点下方的**生成图片**按钮」，但那个按钮在界面上根本不存在。
 * 两者都会让用户以为「我点了/我能点」，然后什么也没发生 —— 比报错更伤。
 */
const ORCH_SRC = readFileSync(path.join(ROOT, "assets/orchestrator.js"), "utf8");

t("「可出图」的判据必须与出图前的检查同源（不能只看服务端在线）", () => {
  assert.match(APP, /function canGenerateImage\(\)/, "缺统一的 canGenerateImage()");
  const used = (APP.match(/canGenerateImage\(\)/g) || []).length;
  assert.ok(used >= 3, `canGenerateImage() 至少要用于「侧栏状态 / 右上角标签 / 出图前检查」三处，实际 ${used} 处`);
  assert.ok(!/probe\.online\s*\?\s*"服务端编排 · 可出图"/.test(APP), "又回到只看 online 就显示「可出图」");
  assert.ok(APP.includes("未配图片 Key"), "没配 key 时要说清是「未配 Key」，而不是默默显示可出图");
});
t("简报不许指向界面上不存在的按钮", () => {
  assert.ok(!/\*\*生成图片\*\*\s*按钮/.test(ORCH_SRC), "又让用户去点不存在的「生成图片」按钮");
  assert.ok(!/或点下方按钮/.test(ORCH_SRC), "「或点下方按钮」同样是指路失效");
  assert.ok(!/点「\*\*导出图片包\*\*」/.test(ORCH_SRC), "「导出图片包」按钮也不存在（第三处同类问题）");
  assert.match(ORCH_SRC, /把话里加上「\*\*直接出图\*\*」/, "得给出真实可行的做法：在消息里带上出图词");
});

/* ─────────────── 21. 图片库打包（零依赖 ZIP）───────────────
 * 为什么值得单独一节：ZIP 的头字段写错一个偏移，解压器就报"文件损坏"，
 * 而这种错**在浏览器里点一下是看不出来的**（下载下来才发现打不开）。
 * 所以这里把结构断言做满，另外用 Python 的 zipfile 做过一次真解压验证。
 */
section("21. 图片库打包（零依赖 ZIP 打包器）");

t("空输入也产出合法 ZIP（22 字节，只有 EOCD）", () => {
  const b = buildZip([]);
  assert.equal(b.length, 22);
  assert.equal(b.readUInt32LE(0), 0x06054b50);
  const info = inspectZip(b);
  assert.equal(info.ok, true);
  assert.deepEqual(info.entries, []);
});
t("本地头 / 中央目录 / EOCD 的偏移互相对得上（错一个解压器就报损坏）", () => {
  const b = buildZip([{ name: "a.txt", data: "hello" }, { name: "b.png", data: Buffer.from([1, 2, 3]) }]);
  assert.equal(b.readUInt32LE(0), 0x04034b50, "必须以本地文件头开头");
  const info = inspectZip(b);
  assert.equal(info.ok, true, info.reason);
  assert.equal(info.entries.length, 2);
  assert.equal(info.entries[0].name, "a.txt");
  assert.equal(info.entries[0].size, 5);
  assert.equal(info.entries[1].offset, info.entries[0].offset + 30 + 5 + 5, "第二条的本地头偏移要接在第一条数据之后");
});
t("文件名按 UTF-8 写，且置了 bit 11（不置中文名会解成乱码）", () => {
  const b = buildZip([{ name: "商品图-主图.png", data: "x" }]);
  const flags = b.readUInt16LE(6);
  assert.equal(flags & 0x0800, 0x0800, "通用位标记 bit 11 必须置上");
  assert.ok(b.includes(Buffer.from("商品图-主图.png", "utf8")), "文件名要以 UTF-8 字节写入");
  assert.equal(inspectZip(b).entries[0].name, "商品图-主图.png");
});
t("CRC32 与内容一致（写错会让解压报「CRC 校验失败」）", () => {
  const data = Buffer.from("hello zip");
  const b = buildZip([{ name: "x", data }]);
  assert.equal(b.readUInt32LE(14), crc32(data) >>> 0, "本地头里的 CRC 要和 node:zlib 算的一致");
  assert.equal(inspectZip(b).entries[0].crc, crc32(data) >>> 0);
});
t("method=0 存储：压缩后大小 == 原始大小", () => {
  const data = Buffer.alloc(4096, 7);
  const b = buildZip([{ name: "big.bin", data }]);
  assert.equal(b.readUInt16LE(8), 0, "压缩方法必须是 0（存储）");
  assert.equal(b.readUInt32LE(18), 4096);
  assert.equal(b.readUInt32LE(22), 4096);
});
t("时间可注入，且 1980 年之前会被夹住（ZIP 的日期从 1980 起算）", () => {
  const a = buildZip([{ name: "x", data: "1" }], new Date(2026, 8, 29, 12, 5, 6));
  const b = buildZip([{ name: "x", data: "1" }], new Date(1970, 0, 1));
  assert.notEqual(a.readUInt16LE(12), b.readUInt16LE(12));
  assert.ok(b.readUInt16LE(12) > 0, "1970 被夹到 1980 后日期字段不该是 0");
});
t("脏输入不崩：缺名字自动补、非 Buffer 数据按 UTF-8 转、null 项跳过", () => {
  const b = buildZip([null, { data: "x" }, { name: "n", data: 123 }]);
  const info = inspectZip(b);
  assert.equal(info.ok, true, info.reason);
  assert.equal(info.entries.length, 2, "null 项应被跳过");
  assert.ok(info.entries[0].name.startsWith("file-"), "缺名字要给兜底名");
  assert.equal(info.entries[1].size, 3, "123 转成字符串是 3 字节");
});
t("inspectZip 能识破坏数据（而不是报 ok）", () => {
  assert.equal(inspectZip(Buffer.from("not a zip")).ok, false);
  assert.equal(inspectZip(Buffer.alloc(0)).ok, false);
  const good = buildZip([{ name: "a", data: "b" }]);
  const tampered = Buffer.from(good);
  tampered.writeUInt32LE(0x02014b50, 0); // 把本地头签名改成中央目录签名
  assert.equal(inspectZip(tampered).ok, false);
});
t("ZIP64 边界必须响亮报错（不能让 4 字节字段静默回绕）", () => {
  // 上限值不是随手写的，必须与 ZIP 字段宽度吻合
  assert.equal(MAX_ENTRIES, 0xffff, "EOCD 的条目数字段是 2 字节");
  assert.equal(MAX_BYTES, 0xffffffff, "本地头里的大小/偏移字段是 4 字节");
  // 正好卡在上限要放行（否则正常大包会被误伤）
  assert.doesNotThrow(() => assertZipWithinLimits(MAX_ENTRIES, MAX_BYTES), "卡在上限不该抛");
  // 越界即抛，且是 RangeError（调用方能借此区分"参数越界"与"IO 出错"）
  assert.throws(() => assertZipWithinLimits(MAX_ENTRIES + 1, 0), RangeError, "条目数越界要抛");
  assert.throws(() => assertZipWithinLimits(0, MAX_BYTES + 1), RangeError, "体积越界要抛");
});
t("buildZip 真接了这道闸（造 65536 个条目必须抛，不能静默产出坏包）", () => {
  const many = Array.from({ length: MAX_ENTRIES + 1 }, () => ({ name: "f", data: "" }));
  assert.throws(() => buildZip(many), /ZIP64/, "报错信息里要出现 ZIP64，用户才知道该怎么绕");
  // 反向：卡在上限之内必须正常产出（证明闸门不会误伤）
  const ok = buildZip([{ name: "f", data: "" }]);
  assert.equal(inspectZip(ok).ok, true, "单个小条目必须仍然正常");
});
t("服务端接上了打包接口，且沿用了同一道路径校验", () => {
  assert.ok(SERVER_SRC.includes('import { buildZip }'), "服务端没引入 zip 模块");
  assert.match(SERVER_SRC, /searchParams\.get\("zip"\)/, "没有 ?zip=1 分支");
  assert.match(SERVER_SRC, /"Content-Type": "application\/zip"/, "没设 zip 的 Content-Type");
  assert.match(SERVER_SRC, /Content-Disposition[\s\S]{0,80}attachment/, "没设下载文件名，浏览器会直接内联打开");
  assert.match(SERVER_SRC, /full\.startsWith\(GEN \+ path\.sep\)[\s\S]{0,120}continue/, "打包时没做路径越界校验");
});

/* ─────────────── 22. 浏览器侧自检设施本身 ─────────────── */
section("22. 浏览器侧自检设施（真起浏览器，不再只有源码级断言）");

t("自检页与自检脚本都在仓库里（别被误删）", () => {
  assert.ok(existsSync(path.join(ROOT, "assets", "selftest-browser.html")), "缺浏览器侧自检页");
  assert.ok(existsSync(path.join(ROOT, "tools", "browser-selftest.mjs")), "缺浏览器自检脚本");
  const smoke = readFileSync(path.join(ROOT, "assets", "selftest-browser.html"), "utf8");
  assert.match(smoke, /import \* as STORE from "\.\/store\.js"/, "自检页要真的测持久化层");
  assert.match(smoke, /window\.__SMOKE_DONE__/, "自检页要有完成标记（否则驱动器只能靠猜时间）");
});
t("浏览器自检保持零依赖（用内置 WebSocket 直连 CDP）", () => {
  const drv = readFileSync(path.join(ROOT, "tools", "browser-selftest.mjs"), "utf8");
  assert.ok(!/from ["'](puppeteer|playwright|chrome-remote-interface)/.test(drv), "引入了浏览器自动化依赖（违背零依赖）");
  assert.match(drv, /new WebSocket\(/, "应该用 Node 内置的全局 WebSocket");
  assert.match(drv, /Runtime\.exceptionThrown|Runtime\.enable/, "没有监听页面异常（那就白跑了）");
  assert.match(drv, /先开监听再导航/, "注释里要写明「先开监听再导航」这个坑");
  assert.match(drv, /Page\.navigate/, "没有导航动作");
  assert.match(drv, /浏览器侧自检失败 0 条/, "没有把自检页的失败透传成退出码");
});
t("浏览器自检跑完会把服务与浏览器都关掉（不留孤儿进程）", () => {
  const drv = readFileSync(path.join(ROOT, "tools", "browser-selftest.mjs"), "utf8");
  assert.match(drv, /finally \{[\s\S]{0,200}br\.kill\(\)[\s\S]{0,80}srv\.kill\(\)/, "没有在 finally 里收尾");
  assert.match(drv, /fs\.rmSync\(PROFILE/, "浏览器临时 profile 没清理");
});

/* ─────────────── 23. Rufus 信息架构检查 ─────────────── */
// 结构：23/23b/23d = 数据与契约；23c/23f = 打**生产入口**（rufus-facts.materialConflicts / rufus.lintRufus）；
//   23e/23g = 数据健康度；23h = R4 覆盖判据（已接真函数 rufus.judgeCoverage）；
//   23i = 事实层等价锁；23j = AC-13 行数预算；23k = 规则层常量成员数漂移锁。
section("23. Rufus 数据层：出处 / 结构 / 自洽（数据级断言，零依赖实现）");

const RUFUS_DATA_SRC = readFileSync(path.join(ROOT, "assets", "rufus-data.js"), "utf8");
const RUFUS_SOURCE_WHITELIST = ["amazon-guide", "amazon-schema", "practitioner"];

// 收集所有"带 source 字段的对象"，用于出处白名单与计数自洽两条断言。
function rufusCollectSourced() {
  const out = [];
  for (const [pt, def] of Object.entries(CATEGORY_ATTRIBUTES))
    for (const tier of ["required", "recommended"])
      for (const e of def[tier]) out.push({ where: `${pt}.${tier}.${e.key}`, source: e.source });
  for (const [pt, arr] of Object.entries(CATEGORY_QUESTIONS))
    for (const q of arr) out.push({ where: `${pt}.${q.id}`, source: q.source });
  for (const g of UNIT_GROUPS) out.push({ where: `UNIT_GROUPS.${g.id}`, source: g.source });
  for (const c of MATERIAL_CONFLICTS) out.push({ where: `MATERIAL_CONFLICTS.${c.a}`, source: c.source });
  out.push({ where: "NUMBER_UNIT_RE", source: NUMBER_UNIT_RE.source });
  return out;
}

t("出处枚举白名单：每个 source 只能是 amazon-guide / amazon-schema / practitioner", () => {
  const bad = rufusCollectSourced().filter((x) => !RUFUS_SOURCE_WHITELIST.includes(x.source));
  assert.deepEqual(bad, [], `越界的 source 取值：${JSON.stringify(bad)}`);
});

t("source 计数自洽：带 source 的对象总数 = 各分项之和（防漏标/多标）", () => {
  const attrN = Object.values(CATEGORY_ATTRIBUTES).reduce((a, d) => a + d.required.length + d.recommended.length, 0);
  const qN = Object.values(CATEGORY_QUESTIONS).reduce((a, arr) => a + arr.length, 0);
  const expect = attrN + qN + UNIT_GROUPS.length + MATERIAL_CONFLICTS.length + 1;
  const actual = rufusCollectSourced().length;
  assert.equal(actual, expect, `总数对不上：实收 ${actual}，按分项应为 ${expect}`);
});

t("同类型下属性 key 唯一且非空（重复会让「空字段清单」漏报）", () => {
  for (const [pt, def] of Object.entries(CATEGORY_ATTRIBUTES)) {
    assert.ok(Array.isArray(def.required) && Array.isArray(def.recommended), `${pt} 缺 required/recommended 数组`);
    const seen = new Set();
    for (const tier of ["required", "recommended"]) {
      for (const e of def[tier]) {
        assert.ok(typeof e.key === "string" && e.key.trim() !== "", `${pt}/${tier} 存在空 key`);
        assert.ok(typeof e.label === "string" && e.label.trim() !== "", `${pt}/${e.key} 缺 label`);
        assert.ok(!seen.has(e.key), `${pt} 下重复 key：${e.key}`);
        seen.add(e.key);
      }
    }
  }
});

t("单位组结构完整：id/label/source 为串，imperial/metric/units 为非空数组", () => {
  for (const g of UNIT_GROUPS) {
    for (const k of ["id", "label", "source"]) assert.equal(typeof g[k], "string", `单位组缺 ${k}`);
    for (const k of ["imperial", "metric", "units"])
      assert.ok(Array.isArray(g[k]) && g[k].length > 0, `单位组 ${g.id} 的 ${k} 必须是非空数组`);
  }
});

t("单位组自洽：imperial ∩ metric === ∅，且 units ⊇ imperial ∪ metric", () => {
  for (const g of UNIT_GROUPS) {
    const inter = g.imperial.filter((u) => g.metric.includes(u));
    assert.deepEqual(inter, [], `${g.id} 英制与公制单位重叠：${inter.join(",")}`);
    const union = new Set([...g.imperial, ...g.metric]);
    const missing = [...union].filter((u) => !g.units.includes(u));
    assert.deepEqual(missing, [], `${g.id} 的 units 漏了：${missing.join(",")}`);
  }
});

t("问题矩阵品类与属性表品类一一对应，且每类问题条数 ∈ [8,12]", () => {
  assert.deepEqual(Object.keys(CATEGORY_QUESTIONS).sort(), Object.keys(CATEGORY_ATTRIBUTES).sort(),
    "问题矩阵品类与属性表品类不一致");
  for (const [pt, arr] of Object.entries(CATEGORY_QUESTIONS))
    assert.ok(arr.length >= 8 && arr.length <= 12, `${pt} 问题条数 ${arr.length} 越界`);
});

t("每条问题含 id/question/why/source，answerHints 非空，id 规范且全局唯一", () => {
  const seen = new Set();
  for (const [pt, arr] of Object.entries(CATEGORY_QUESTIONS)) {
    for (const q of arr) {
      for (const k of ["id", "question", "why", "source"])
        assert.ok(typeof q[k] === "string" && q[k].trim() !== "", `${pt} 有问题缺 ${k}`);
      assert.ok(Array.isArray(q.answerHints) && q.answerHints.length > 0, `${q.id} answerHints 为空`);
      assert.match(q.id, new RegExp(`^${pt}-q\\d+$`), `${q.id} 命名不符合 {type}-q{n}`);
      assert.ok(!seen.has(q.id), `问题 id 重复：${q.id}`);
      seen.add(q.id);
    }
  }
});

t("每条问题的 answerHints 至少含 1 个同 productType 的 key 类 hint（不许整题全是概念名）", () => {
  // 数据驱动：key 集合从 CATEGORY_ATTRIBUTES 现算，禁止硬编码问题 id 或数量。
  const offenders = [];
  for (const [pt, arr] of Object.entries(CATEGORY_QUESTIONS)) {
    const keys = new Set();
    for (const tier of ["required", "recommended"])
      for (const e of CATEGORY_ATTRIBUTES[pt][tier]) keys.add(e.key);
    for (const q of arr)
      if (!q.answerHints.some((h) => keys.has(h))) offenders.push(`${q.id} -> ${JSON.stringify(q.answerHints)}`);
  }
  assert.deepEqual(offenders, [],
    `这些问题的 answerHints 全是概念名（至少要有 1 个同类型真实 key）：\n      ${offenders.join("\n      ")}`);
});

t("材质冲突对结构完整、无重复对、条数达下限", () => {
  assert.ok(MATERIAL_CONFLICTS.length >= 10, `材质冲突对仅 ${MATERIAL_CONFLICTS.length} 条，偏少`);
  const seen = new Set();
  for (const c of MATERIAL_CONFLICTS) {
    for (const k of ["a", "b", "note", "source"])
      assert.ok(typeof c[k] === "string" && c[k].trim() !== "", `${c.a} / ${c.b} 缺 ${k}`);
    assert.ok(Array.isArray(c.guards) && c.guards.length > 0, `${c.a} / ${c.b} 的 guards 必须是非空数组`);
    const key = `${c.a}|${c.b}`;
    assert.ok(!seen.has(key), `重复的材质对：${key}`);
    seen.add(key);
  }
});

t("NUMBER_UNIT_RE 可由 pattern + flags 无损重建（regex.source/flags 三者一致）", () => {
  assert.equal(NUMBER_UNIT_RE.regex.source, NUMBER_UNIT_RE.pattern, "regex.source 与 pattern 不一致");
  assert.equal(NUMBER_UNIT_RE.regex.flags, NUMBER_UNIT_RE.flags, "regex.flags 与 flags 字段不一致");
  const re = new RegExp(NUMBER_UNIT_RE.pattern, NUMBER_UNIT_RE.flags);
  assert.equal(re.source, NUMBER_UNIT_RE.regex.source, "重建实例 source 不一致");
  assert.equal(re.flags, NUMBER_UNIT_RE.regex.flags, "重建实例 flags 不一致");
});

t("rufus 三文件零 node: 前缀 import（浏览器侧也要能直接跑）", () => {
  assert.ok(existsSync(path.join(ROOT, "assets", "rufus-data.js")), "rufus-data.js 不存在");
  for (const f of ["assets/rufus-data.js", "assets/rufus.js", "assets/rufus-facts.js"]) {
    const p = path.join(ROOT, f);
    if (!existsSync(p)) continue; // rufus.js / rufus-facts.js 尚未落地，落地后自动纳入
    const src = readFileSync(p, "utf8");
    assert.ok(!/from\s*["']node:/.test(src) && !/require\(\s*["']node:/.test(src),
      `${f} 含 node: 依赖（浏览器侧会直接崩，参照 zip.js 的反面教材）`);
  }
});

// 只扫「会渲染 / 会外发」的字符串字面量，不扫注释：
// 本项目工具文件约定用 🔴 / ⚠ 做注释标记（selftest.mjs 自身亦然），整文件扫会把注释标记
// 误报成 P0 —— 那是误报，不是缺陷。收窄为字符串字面量 = 提高真阳性，不是放宽判据。
const RUFUS_STRINGS = RUFUS_DATA_SRC.match(/'[^'\n]*'|"[^"\n]*"/g) || [];

t("rufus-data.js 的数据串里无 emoji（禁 emoji 当功能图标 / 窜入用户可见文案；注释标记不算）", () => {
  const bad = RUFUS_STRINGS.filter((s) => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(s));
  assert.deepEqual(bad, [], `字符串字面量里出现 emoji：${JSON.stringify(bad)}`);
});

t("rufus-data.js 的数据串里无弯引号（文案纪律；只查会渲染的串）", () => {
  const bad = RUFUS_STRINGS.filter((s) => /[\u2018\u2019\u201C\u201D]/.test(s));
  assert.deepEqual(bad, [], `字符串字面量里出现弯引号：${JSON.stringify(bad)}`);
});

/* ─── 23b. 回归保护：新模块不得改动既有契约 ─── */
section("23b. Rufus 新增不得回归既有契约（源码级断言）");

t("listing.js 的 RULES 仍为 28 条，且全部 sourceTier === undefined（不许回填成两套口径）", () => {
  assert.equal(RULES.length, 28, `RULES 变成 ${RULES.length} 条`);
  const backfilled = RULES.filter((r) => r.sourceTier !== undefined).map((r) => r.id);
  assert.deepEqual(backfilled, [], `这些规则被回填了 sourceTier：${backfilled.join(",")}`);
});

t("导航为 8 个 data-view（Rufus 仍并入 listing，不单独占视图；第 8 个是本周词库）", () => {
  const views = [...HTML.matchAll(/<button[^>]*data-view="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(views.length, 8, `导航变成 ${views.length} 个：${views.join(",")}`);
  assert.ok(!views.includes("rufus"), "新增了 rufus 视图，违背 ADR D4");
  // 词库是**全品类**能力，跟具体商品无关 —— 它必须有自己的入口，而不是寄在 listing 的抽屉里。
  assert.ok(views.includes("words"), "缺少本周词库视图");
});

/* ─── 23c. 对抗性契约断言：一律打生产入口（不再本地复刻实现）─── */
// 原来这里有三段「本地复刻」（rufusHasTerm / rufusMaterialConflicts / rufusExtractUnits）——
// 那等于"测我自己写的第二实现"，且边界规则已与 listing.js:hasTerm 漂移。现全部删除，改打生产入口。
// 红 = 真实现的问题，照实报，不为转绿放宽。
section("23c. 对抗性断言：材质冲突与单位制（打 rufus-facts / rufus 生产入口）");

const rufusMaterial = (listing) => RUFUS_FACTS.materialConflicts(RUFUS_FACTS.fieldTexts(listing));
const rufusRule = (listing, id, ctx) => RUFUS.lintRufus(listing, ctx || {}).results.find((r) => r.id === id);

/* — 缺陷 A 回归锁：另一字段的 guard 不得整对压掉本字段的真冲突（ADR L200「逐提及」）— */
t("缺陷A 回归锁：title 的真冲突不被 description 的 guard 整对压掉", () => {
  const hits = rufusMaterial({
    title: "Genuine Leather and Faux Leather",
    description: "with leather blend trim on the handle",
  });
  assert.ok(hits.length > 0, "标题里的真材冲突被 description 的 blend 整对压掉（跨字段越权）——L200 明禁");
});

/* — 缺陷 D 回归锁：a ⊂ b 的自命中（只说人造革/人造麂皮的正确 listing 被判冲突）— */
t("缺陷D-1 回归锁：'Faux Leather Sofa' 不得判材质冲突（a='leather' 是 b='faux leather' 的子串）", () => {
  assert.deepEqual(rufusMaterial({ title: "Faux Leather Sofa" }), [], "只说了人造革，却报了真皮×人造革冲突");
});
t("缺陷D-2 回归锁：'Vegan Leather Sofa' 不得判材质冲突", () => {
  assert.deepEqual(rufusMaterial({ title: "Vegan Leather Sofa" }), [], "只说了素皮，却报了冲突");
});
t("缺陷D-3 回归锁：'Faux Suede Shoes' 不得判材质冲突", () => {
  assert.deepEqual(rufusMaterial({ title: "Faux Suede Shoes" }), [], "只说了人造麂皮，却报了冲突");
});
/* — 反例：修缺陷 D 不得修成"永不命中" — */
t("反例（防永不命中）：'Genuine Leather and Faux Leather' 必须命中", () => {
  assert.ok(rufusMaterial({ title: "Genuine Leather and Faux Leather" }).length > 0, "真皮×人造革同现却没报");
});
t("反例（防永不命中）：'Faux Leather'(title) + 'Genuine Leather'(description) 跨字段必须命中", () => {
  assert.ok(rufusMaterial({ title: "Faux Leather", description: "Genuine Leather" }).length > 0, "跨字段真冲突没报");
});
t("混纺不是冲突：'cotton blend with polyester' 必须被 guards 挡住", () => {
  assert.deepEqual(rufusMaterial({ title: "cotton blend with polyester" }), [], "混纺被误报成冲突");
});
t("纯涤纶不误报：'polyester blend' 不含 cotton，不该命中该词对", () => {
  assert.ok(!rufusMaterial({ title: "polyester blend" }).some((h) => h.a === "cotton" && h.b === "polyester"), "纯涤纶被误报");
});

/* — 缺陷 H 回归锁：跨字段「主体+部件」复合商品不得误报（部件词 lining/base/lid/frame… 须对全部 15 对生效）；
     期望「不命中」。team-lead 实测 8 例 6 中误报；PM 数据侧补齐后已转绿（不带 tag）。 */
const RUFUS_H_NOHIT = [
  ["H1 陶瓷主体 + 塑料底座", { title: "Ceramic Flower Vase", description: "Plastic Base" }],
  ["H2 羊毛外套 + 腈纶内衬", { title: "Wool Winter Coat", description: "Soft Acrylic Lining" }],
  ["H3 不锈钢瓶 + 塑料盖", { title: "Stainless Steel Bottle", description: "BPA-Free Plastic Lid" }],
  ["H4 玻璃罐 + 腈纶盖", { title: "Glass Storage Jar", description: "Acrylic Lid" }],
  ["H5 陶瓷碗 + 塑料盖", { title: "Ceramic Bowl", description: "Plastic Lid" }],
  ["H6 羊毛毯 + 腈纶纱", { title: "Wool Throw Blanket", description: "Acrylic Yarn Weave" }],
];
for (const [label, l] of RUFUS_H_NOHIT) {
  t(`缺陷H 回归锁（期望不命中）：${label} —— 部件不是主体材质冲突`, () => {
    assert.deepEqual(rufusMaterial(l), [], `${label}：部件材质被当成主体材质冲突（跨字段复合商品误报）`);
  });
}

/* — 反向锁（期望「命中」，防把跨字段一律压掉）：无部件词的纯主体双材质 / 真冲突词对跨字段，仍须报 — */
const RUFUS_H_HIT = [
  ["R1 纯主体双材质：'100% Cotton' / '100% Polyester'", { title: "100% Cotton", description: "100% Polyester" }],
  ["R2 纯主体双材质：'Wool Coat' / 'Acrylic Coat'", { title: "Wool Coat", description: "Acrylic Coat" }],
  ["R3 真冲突词对跨字段：'Organic Cotton Towel' / 'Regular Cotton Towel'", { title: "Organic Cotton Towel", description: "Regular Cotton Towel" }],
];
for (const [label, l] of RUFUS_H_HIT) {
  t(`反向锁（期望命中）：${label} —— 修 H 不得修成'跨字段一律不报'`, () => {
    assert.ok(rufusMaterial(l).length > 0, `${label}：无部件词的真跨字段冲突被误压（H 修过头 → 大面积漏报）`);
  });
}

/* — E 组（同字段并列豁免 → 不命中；SPEC §2 R2 行 / §8 #10；team-lead 实测照抄）—
   同一字段内并列 a/b 是「复合商品 / 成分披露」，不是跨字段不一致；报它属误报。 */
const RUFUS_E_NOHIT = [
  "Wool Acrylic Sweater",
  "60% Cotton 40% Polyester",
  "Ceramic and Plastic Bowl",
  "Glass Vase with Acrylic Base",
  "Genuine Leather with Synthetic Lining",
  "Silicone and Latex Free Gloves",
];
for (const title of RUFUS_E_NOHIT) {
  t(`E 组（期望不命中）：同字段并列「${title}」是复合/成分披露，不是跨字段冲突`, () => {
    assert.deepEqual(rufusMaterial({ title }), [], `同字段并列被误报成跨字段冲突（SPEC §8 #10 明禁）`);
  });
}

/* — G 组（同一材质两侧都写 ≠ 冲突 → 不命中；SPEC §8 #11 提及归并）— */
t("G 组（期望不命中）：'Faux Leather Sofa' / 'Faux Leather Lining' 两侧说的是同一材质", () => {
  assert.deepEqual(rufusMaterial({ title: "Faux Leather Sofa", description: "Faux Leather Lining" }), [],
    "同一材质在两侧各写一次被误判为冲突（SPEC §8 #11：提及归并必须先逐字段做）");
});

/* — AC-15 / SPEC §8 #12、#13：钉死「已知漏报边界」两侧，防后人当成 bug 顺手修坏另一侧 — */
t("C15-1 已知漏报边界（SPEC §8 #12）：'Leather Belt' / 'Faux Leather Strap' → 不命中", () => {
  // 根因：strap 落在 33 个通用词池里，guard 是字段级二值 → 整片压掉 description 的提及。
  // 这是**已知漏报**（宁可漏、不可误报的刻意取舍），不是期望行为之外的意外 —— 断言里写明，防被"修"。
  assert.deepEqual(rufusMaterial({ title: "Leather Belt", description: "Faux Leather Strap" }), [],
    "已知漏报边界被改变：要么修了漏报（须同步改 SPEC §8 #12 并复核 C15-2 不得变误报），要么 guard 词池被改动");
});
t("C15-1 同批通用词 cover/shell/sole/legs/collar 同样漏报（SPEC §8 #12 实测定格）", () => {
  for (const w of ["cover", "shell", "sole", "legs", "collar"])
    assert.deepEqual(rufusMaterial({ title: "Leather Belt", description: `Faux Leather ${w}` }), [],
      `'${w}' 的漏报边界变了（SPEC §8 #12 明列该批词同样漏报）`);
});
t("C15-2 反向锁（SPEC §8 #12）：'Wool Coat' / 'Acrylic lining' 合法部件 → 不命中，不得被'修漏报'改成命中", () => {
  assert.deepEqual(rufusMaterial({ title: "Wool Coat", description: "Acrylic lining" }), [],
    "为救 C15-1 把 guard 收窄 → 这条合法「主体羊毛/里料腈纶」变误报（误报比漏报更贵，SPEC §8 #12）");
});
t("C15-3（SPEC §8 #13）：'Down Jacket' / 'Polyester fill, better than alternatives' → 命中（裸 alternatives 已删）", () => {
  assert.ok(rufusMaterial({ title: "Down Jacket", description: "Polyester fill, better than alternatives" }).length > 0,
    "裸 'alternatives' 又被塞回逐对 guard 池 → 通用营销词把它静默压成漏报（SPEC §8 #13 反面教材）");
});

/* — G4 否定窗口（已落地转绿 → 按"gate tag 只在当前红时佩戴"的规则，撤掉 tag）— */
t("G4 否定句不误报：'not cotton, polyester' 必须不判冲突（G4 否定窗口已落地）", () => {
  assert.deepEqual(rufusMaterial({ title: "not cotton, polyester" }), [],
    "把'不是棉、是涤纶'误报成材质冲突（误报＝工具失信）");
});
t("G4 否定只向前看：后置 'not the cheap kind' 不得撤前面的 genuine leather（ADR L415）", () => {
  assert.ok(rufusMaterial({ title: "genuine leather, not the cheap kind", description: "synthetic" }).length > 0,
    "后置否定把前面的提及撤掉了（应只向前看）");
});
t("G4 否定不跨字段：title 'not genuine leather' + desc 'synthetic' → 不命中（ADR L416）", () => {
  assert.deepEqual(rufusMaterial({ title: "not genuine leather", description: "synthetic" }), [],
    "否定跨了字段，把别的字段的提及也撤了");
});
t("G4 未定义否定不撤：'supposedly genuine leather' 不在 NEGATION_WORDS，不得撤提及（ADR L417）", () => {
  assert.ok(rufusMaterial({ title: "supposedly genuine leather", description: "synthetic" }).length > 0,
    "未知否定词被当成否定 → 静默漏报真冲突");
});
t("G4 多词否定整体匹配：'not made of genuine leather' 撤 → 不命中", () => {
  assert.deepEqual(rufusMaterial({ title: "not made of genuine leather", description: "synthetic" }), [],
    "多词否定 'not made of' 未按整体匹配（占 1 个窗口位）");
});

/* — B3 单字母单位（打 lintRufus 的 R3-01；每个反例配「对侧单位」以便暴露误判。已转绿 → 撤 tag）— */
// 断言取**恰为「通过」**而不是「≠命中」：否则规则若整体返回「跳过」，断言会假绿。
t("B3 'Ready in 12 m' / 'ships in 3 m' 不得被当成米（配英制量 → R3-01 恰为「通过」）", () => {
  for (const bad of ["Ready in 12 m", "ships in 3 m"])
    assert.equal(rufusRule({ title: bad, description: "10 inches long" }, "R3-01").status, "通过",
      `'${bad}' 里的 m(分钟) 被当成米，误判英制+公制并存（应=通过，=命中即误报）`);
});
t("B3 'Available in 5 in stock' 不得被当成英寸（配公制量 → R3-01 恰为「通过」）", () => {
  assert.equal(rufusRule({ title: "Available in 5 in stock", description: "30 centimeters wide" }, "R3-01").status, "通过",
    "'5 in stock' 里的 in 被当成英寸（应=通过，=命中即误报）");
});
t("B3 'meets 4 g signal' 不得被当成克（配英制量 → R3-01 恰为「通过」）", () => {
  assert.equal(rufusRule({ title: "meets 4 g signal", description: "10 inches long" }, "R3-01").status, "通过",
    "'4 g signal' 里的 g 被当成克（应=通过，=命中即误报）");
});

/* — 合法单位不得被误杀（防 B3 收紧成"什么都识别不出"）— */
t("B3 约束不得误杀合法单位：'32 oz' / '1.5 kg' / '10-12 inches' 仍要抽到 measure", () => {
  const units = (s) => RUFUS_FACTS.extractFacts(s).filter((x) => x.kind === "measure").map((x) => x.unit);
  assert.ok(units("32 oz").includes("oz"), "32 oz 没抽到 oz");
  assert.ok(units("1.5 kg").includes("kg"), "1.5 kg 没抽到 kg");
  assert.ok(units("10-12 inches").includes("inches"), "区间尺寸 10-12 inches 没抽到");
});

/* — R3 口径：同 UNIT_GROUPS 组内英制+公制才报；跨组不报（正/反对照）— */
t("R3-01 正对照：同 length 组 英制(inches)+公制(centimeters) 并存 → 必须命中", () => {
  assert.equal(rufusRule({ title: "10 inches long", description: "30 centimeters wide" }, "R3-01").status, "命中",
    "同组英制+公制并存没报（口径：同组内才报）");
});
t("R3-01 反对照：跨组 length(inches) × weight(kilograms) → 恰为「通过」（跨组证明不了'同一事实'）", () => {
  assert.equal(rufusRule({ title: "10 inches long", description: "Net weight 1.5 kilograms" }, "R3-01").status, "通过",
    "跨组被误报成单位制冲突（应=通过；=命中即误报，=跳过即没测到）");
});
t("R3-01 cm 属 ADR 排除的 ≤2 字符单位：'10 inches' + '30 cm' → 恰为「通过」（cm 不参与判定）", () => {
  assert.equal(rufusRule({ title: "10 inches long", description: "30 cm wide" }, "R3-01").status, "通过",
    "cm 参与了判定（ADR B3 明确 ≤2 字符单位排除，除非在 oz/lb/kg 白名单）");
});
t("R3-01 同制不报：'10 inches' + '1.5 feet' 同属 length imperial → 恰为「通过」", () => {
  assert.equal(rufusRule({ title: "10 inches long", description: "1.5 feet wide" }, "R3-01").status, "通过",
    "同为英制被误报成'单位制并存'");
});
/* — R3 正对照补强：直接锚 ADR 附表里明列的「命中」范例（不靠自造样例，防实现悄悄收窄成永不命中）— */
t("R3-01 ADR L441 正例：title '32 fl oz' + desc '1 liter'（同 volume 组、跨字段）→ 必须命中", () => {
  assert.equal(rufusRule({ title: "32 fl oz", description: "1 liter" }, "R3-01").status, "命中",
    "ADR 附表 L441 明列的同组跨字段命中范例没命中（正对照失守）");
});
t("R3-01 ADR L442 正例：title '5 lb' + desc '2 kg'（同 weight 组、跨字段）→ 必须命中", () => {
  assert.equal(rufusRule({ title: "5 lb", description: "2 kg" }, "R3-01").status, "命中",
    "ADR 附表 L442 明列的同组跨字段命中范例没命中（正对照失守）");
});
t("R3-01 ADR L444 反例：'5 lb'(weight) + '30 cm'(length) 跨组 → 恰为「通过」（ADR 明列，且 cm 属排除单位）", () => {
  assert.equal(rufusRule({ title: "5 lb", description: "30 cm" }, "R3-01").status, "通过",
    "跨组被误报（ADR L444 明列不报）");
});

/* ─── 23d. 反向测试 fixture（形态先就位；「零命中」待 rufus.js 落地后启用）─── */
section("23d. 反向测试 fixture 形态（完整 fixture 零命中，待 rufus.js 落地后启用）");

const RUFUS_FIXTURE_TYPE = "home_kitchen";
const RUFUS_FIXTURE = (() => {
  const def = CATEGORY_ATTRIBUTES[RUFUS_FIXTURE_TYPE];
  const o = {};
  for (const tier of ["required", "recommended"]) for (const e of def[tier]) o[e.key] = "sample " + e.key;
  return o;
})();

t("反向 fixture 覆盖该品类全部 required + recommended 字段且非空（防 fixture 残缺导致零命中测试空过）", () => {
  const def = CATEGORY_ATTRIBUTES[RUFUS_FIXTURE_TYPE];
  for (const tier of ["required", "recommended"]) {
    for (const e of def[tier]) {
      assert.ok(typeof RUFUS_FIXTURE[e.key] === "string" && RUFUS_FIXTURE[e.key].length > 0,
        `fixture 缺字段 ${e.key}（会让未来的「零命中」测试变成空断言）`);
    }
  }
});

/* ─── 23e. guards 词表纪律（数据级；ADR §消费约束 3 明文要求的"数据健康度断言"）─── */
// 这批是 ADR 自己点名"只有数据独立成文件才写得出"的断言：把"guard 词不得是通用连接词"
// 变成机械可判。它现在绿；将来有人把 and/with/% 塞回 guards，这里立刻红。
section("23e. guards 词表纪律（数据级，防真冲突被通用词静默压掉）");

// GUARD_STOPLIST = ADR 定稿的契约常量（规格，不是实现产物）：通用连接词 / 标点 / 纯符号。
const RUFUS_GUARD_STOPLIST = ["and", "or", "with", "&", "+", "%", "/", ","];

t("E1 guards ∩ GUARD_STOPLIST === ∅（通用词当 guard 会把 'a and b' 这类真冲突整对压掉）", () => {
  const bad = [];
  for (const c of MATERIAL_CONFLICTS)
    for (const g of c.guards)
      if (RUFUS_GUARD_STOPLIST.includes(g.toLowerCase())) bad.push(`${c.a}|${c.b} -> ${g}`);
  assert.deepEqual(bad, [], `以下 guards 落进禁用表：\n      ${bad.join("\n      ")}`);
});

t("E2 每对 guards 至少含 1 个材质语境词（len>=3 且 ∉ GUARD_STOPLIST）", () => {
  const bad = [];
  for (const c of MATERIAL_CONFLICTS) {
    const ctx = c.guards.filter((g) => g.trim().length >= 3 && !RUFUS_GUARD_STOPLIST.includes(g.toLowerCase()));
    if (ctx.length === 0) bad.push(`${c.a}|${c.b} -> ${JSON.stringify(c.guards)}`);
  }
  assert.deepEqual(bad, [], `这些对的 guards 全是通用词、没有材质语境词（抑制来自巧合而非语义）：\n      ${bad.join("\n      ")}`);
});

t("E3 trim 保留为合法 guard（ADR 明文裁决：饰边=材质语境词，非连接词）", () => {
  const pair = MATERIAL_CONFLICTS.find((c) => c.a === "leather" && c.b === "faux leather");
  assert.ok(pair, "找不到 leather|faux leather 词对");
  assert.ok(pair.guards.includes("trim"), "trim 被移除，'genuine leather trim' 与 'faux leather' 并存会误报");
  assert.ok(!RUFUS_GUARD_STOPLIST.includes("trim"), "trim 不该出现在禁用表里");
});

t("E4 guards 全部小写（大小写不敏感判定的数据前提；含大写会让本该命中的漏掉）", () => {
  const bad = [];
  for (const c of MATERIAL_CONFLICTS) for (const g of c.guards) if (g !== g.toLowerCase()) bad.push(`${c.a}|${c.b} -> ${g}`);
  assert.deepEqual(bad, [], `以下 guard 含大写：\n      ${bad.join("\n      ")}`);
});

/* ─── 23f. R2 字段级窗口（打生产入口 materialConflicts；口径=L200：检测跨字段、抑制逐提及）─── */
section("23f. R2 字段级窗口（打生产入口；口径=L200：检测跨字段 / 抑制逐提及）");

// 口径（ADR L200 更正条，team-lead 裁定）：命中看"全文有没有这一对"（可跨字段）；
// 抑制看"该词所在字段里有没有语境词"（逐提及，guard 不跨字段、不得救别的字段的提及）。
const rufusR2 = (listing) => RUFUS_FACTS.materialConflicts(RUFUS_FACTS.fieldTexts(listing));

t("F1 跨字段冲突必命中：title '100% Cotton' + description '100% Polyester'（ADR 明示）", () => {
  assert.ok(rufusR2({ title: "100% Cotton", description: "100% Polyester" }).length > 0,
    "跨字段材质冲突没被抓住 —— 这正是 R2 要抓的本体");
});
t("F2 同字段有 guard 即跳过：'cotton-poly blend'（ADR 明示）", () => {
  assert.deepEqual(rufusR2({ title: "cotton-poly blend fabric" }), [], "混纺被误报成冲突");
});
t("F3 guard 不跨字段越权：冲突分处两字段、guard 落在无关第三字段时仍须命中（ADR 明示）", () => {
  assert.ok(rufusR2({ title: "100% cotton", description: "100% polyester", bullets: ["a soft blend of fabrics"] }).length > 0,
    "别的字段的 guard 把本字段的真冲突压掉了 —— 等于给'标题和描述各说一个材质'开后门");
});
t("F4 guards 逐对生效、不做全局并集：外对材质特定词（alloy）不得抑制 cotton|polyester", () => {
  assert.ok(rufusR2({ title: "100% Cotton", description: "100% Polyester, alloy reinforced" }).length > 0,
    "外对的 guard 被并集进本对 —— 逐对规则被全局并集稀释（大面积漏报）");
});
t("F5 guard 抑制大小写不敏感：'100% COTTON Blend' 仍须被 blend 抑制", () => {
  assert.deepEqual(rufusR2({ title: "100% COTTON Blend" }), [], "大写 Blend 没抑制住，说明判定区分了大小写");
});
t("F6 逐提及边界：title 'cotton blend' + bullet 'cotton' + description 'polyester' → 命中（L200：别字段的 blend 不得救本字段的 cotton）", () => {
  assert.ok(rufusR2({ title: "cotton blend", bullets: ["cotton"], description: "polyester" }).length > 0,
    "另一字段的 guard 把本字段的提及整对压掉（整对 vs 逐提及）——L200 要求逐提及");
});

/* ─── 23g. Guard B：key 类 hint 数上限（数据级防"OR 稀释"）─── */
section("23g. Guard B：每题 key 类 hint 数 <= 3（防 OR 被堆 hint 稀释成'永远通过'）");

function rufusKeyClassHints(q, pt) {
  const keys = new Set();
  for (const tier of ["required", "recommended"]) for (const e of CATEGORY_ATTRIBUTES[pt][tier]) keys.add(e.key);
  return q.answerHints.filter((h) => keys.has(h));
}

t("G1 每题 key 类 hint 数 <= 3（数据驱动，禁硬编码 id/数量；实测当前最大 = 3）", () => {
  const over = [];
  for (const [pt, arr] of Object.entries(CATEGORY_QUESTIONS))
    for (const q of arr) {
      const n = rufusKeyClassHints(q, pt).length;
      if (n > 3) over.push(`${q.id} -> ${n} 个 key 类 hint`);
    }
  assert.deepEqual(over, [], `以下问题装了 2 个以上的问法（堆 hint 会让 OR 必然通过，应拆题）：\n      ${over.join("\n      ")}`);
});

t("G2 突变自检：装 4 个 key hint 的样本必须被 G1 的判据抓到（证明该断言不是空过）", () => {
  const keys4 = [...new Set([...CATEGORY_ATTRIBUTES.home_kitchen.required, ...CATEGORY_ATTRIBUTES.home_kitchen.recommended].map((e) => e.key))].slice(0, 4);
  const synth = { id: "synthetic-qX", answerHints: keys4 };
  assert.equal(rufusKeyClassHints(synth, "home_kitchen").length, 4, "突变样本没造对");
  assert.ok(rufusKeyClassHints(synth, "home_kitchen").length > 3, "G1 的判据抓不到 4-hint 坏样本 = 空断言");
});

t("G3 非 key hint 不参与判定（线索不是待办，也无需第三份词表）：key+概念名混合时只数 key", () => {
  const synth = { id: "s-q", answerHints: ["dimensions", "material", "unit", "compatibility"] };
  assert.deepEqual(rufusKeyClassHints(synth, "home_kitchen"), ["material"], "非 key 概念名被错误计入 key 类");
});

/* ─── 23h. R4 覆盖判据（打真函数 rufus.judgeCoverage；ADR §R4 定稿口径）─── */
section("23h. R4 覆盖判据：OR + 守卫 A + 状态值域（打真函数 rufus.judgeCoverage）");

// K = 该题 key 类 hint；C = 其中已覆盖者。判定逐条来自 ADR §R4：
//   K 空 -> 跳过；|K|==1 -> 覆盖即通过、否则命中；|K|>=2 -> 全未覆盖=命中 / 部分=通过（部分） / 全覆盖=通过。
// 已接真函数（红线：本轮只换被测对象，**H1–H9 的断言与期望值一字未改**）。
//   当初从契约 oracle 切到真函数：实测逐条一致、零期望值改动。
const rufusJudgeCoverage = (q, pt, covered) => RUFUS.judgeCoverage(q, pt, covered);
const RUFUS_R4_STATUS = ["命中", "通过", "通过（部分）", "跳过"];
const rufusQ = (pt, id) => CATEGORY_QUESTIONS[pt].find((x) => x.id === id);

t("H1 key 类 hint 为 0 -> 跳过（无可用判据，仅作线索，不得误报）", () => {
  const synth = { id: "s-q", answerHints: ["dimensions", "compatibility"], question: "?" };
  assert.equal(rufusJudgeCoverage(synth, "home_kitchen", new Set()).status, "跳过");
});
t("H2 单 hint 被覆盖 -> 通过", () => {
  assert.equal(rufusJudgeCoverage(rufusQ("home_kitchen", "home_kitchen-q7"), "home_kitchen", new Set(["included_components"])).status, "通过");
});
t("H3 单 hint 未覆盖 -> 命中", () => {
  assert.equal(rufusJudgeCoverage(rufusQ("home_kitchen", "home_kitchen-q2"), "home_kitchen", new Set()).status, "命中");
});
t("H4 多 hint 全未覆盖 -> 命中（OR：一个都没答才报）", () => {
  assert.equal(rufusJudgeCoverage(rufusQ("baby", "baby-q6"), "baby", new Set()).status, "命中");
});
t("H5 多 hint 部分覆盖 -> 通过（部分），detail 逐个列出未覆盖 key（守卫 A，ADR 明示例）", () => {
  const r = rufusJudgeCoverage(rufusQ("baby", "baby-q6"), "baby", new Set(["batteries_required"])); // "requires 2 AA"
  assert.equal(r.status, "通过（部分）", "部分覆盖被误报成未覆盖（AND 反模式）");
  assert.ok(r.uncovered.includes("batteries_included"), "未覆盖 key 没进线索 = 少报被藏起来了");
  assert.notEqual(r.status, "通过", "通过（部分）与全通过同形 = 守卫 A 失效");
});
t("H6 多 hint 全覆盖 -> 通过（OR 全中）", () => {
  assert.equal(rufusJudgeCoverage(rufusQ("baby", "baby-q6"), "baby", new Set(["batteries_required", "batteries_included", "num_batteries"])).status, "通过");
});
t("H7 OR/AND 区分自检：部分覆盖下 OR 给'通过（部分）'，而 AND 会给'命中' —— 判据必须落在 OR 一侧", () => {
  const q = rufusQ("baby", "baby-q6");
  const covered = new Set(["batteries_required"]);
  const K = rufusKeyClassHints(q, "baby");
  const underAnd = K.every((k) => covered.has(k)) ? "通过" : "命中"; // AND 对照模型：全中才通过，否则命中
  const underOr = rufusJudgeCoverage(q, "baby", covered).status;
  assert.equal(underAnd, "命中", "AND 对照模型在这组输入下应给'命中'（作为反例锚点）");
  assert.notEqual(underOr, underAnd, "本判据在 OR/AND 之间不敏感 = 区分不出两种语义");
  assert.equal(underOr, "通过（部分）", "契约要求 OR -> 通过（部分）");
});
t("H8 status 值域恰为 命中/通过/通过（部分）/跳过（通过（部分）仅 R4 产生）", () => {
  const q = rufusQ("baby", "baby-q6");
  const got = [
    rufusJudgeCoverage(q, "baby", new Set()).status,
    rufusJudgeCoverage(q, "baby", new Set(["batteries_required", "batteries_included", "num_batteries"])).status,
    rufusJudgeCoverage(q, "baby", new Set(["batteries_required"])).status,
    rufusJudgeCoverage({ id: "s", answerHints: ["dimensions"] }, "home_kitchen", new Set()).status,
  ];
  for (const s of got) assert.ok(RUFUS_R4_STATUS.includes(s), `越界 status: ${s}`);
  assert.ok(got.includes("通过（部分）"), "判据没产出 通过（部分）");
});
t("H9 部分覆盖的另一种排列：只答话 'batteries_included'，未覆盖线索须含 batteries_required 与 num_batteries", () => {
  const r = rufusJudgeCoverage(rufusQ("baby", "baby-q6"), "baby", new Set(["batteries_included"]));
  assert.equal(r.status, "通过（部分）");
  assert.deepEqual(r.uncovered.sort(), ["batteries_required", "num_batteries"], "未覆盖线索集合不对");
});

/* ─── 23i. 事实层等价性：termRanges ≡ listing.js hasTerm（锁边界规则不漂移）─── */
// listing.js:hasTerm 是既有真源且不许改；rufus-facts.termRanges 必须逐字复刻它的边界规则，
// 否则"a ⊂ b 自命中"这类缺陷会反复出现。这条断言就是两份实现的等价锁。
section("23i. 事实层等价性：termRanges 与 hasTerm 判定必须一致（防边界规则两处漂移）");

t("termRanges(term,text) 命中与否 === hasTerm(term,text)（跨形态抽样）", () => {
  assert.equal(typeof RUFUS_FACTS.termRanges, "function", "rufus-facts.js 未导出 termRanges（实现席位待加）");
  const samples = [
    // 纯字母单词（含词首/词尾/标点相邻）
    ["leather", "Genuine LEATHER sofa"], ["leather", "faux leather"], ["leather", "leatherette"],
    ["leather", "Leather."], ["leather", " leather"], ["leather", "leather "],
    // 多词
    ["faux leather", "Faux Leather Sofa"], ["faux leather", "faux-leather sofa"], ["faux leather", "fauxleather"],
    ["stainless steel", "100% Stainless Steel body"], ["stainless steel", "stainless_steel"],
    // 带非字母字符的词
    ["poly-cotton", "poly-cotton blend"], ["poly-cotton", "polycotton"], ["°f", "rated 120°F max"], ["°f", "keeps 100 °f"],
    // a ⊂ b 的嵌套串
    ["faux leather", "Faux Leather"], ["leather", "Faux Leather"],
  ];
  const bad = samples
    .filter(([term, text]) => (RUFUS_FACTS.termRanges(term, text).length > 0) !== hasTerm(term, text))
    .map(([term, text]) => `${term} @ "${text}"`);
  assert.deepEqual(bad, [], `termRanges 与 hasTerm 判定不一致（边界规则漂移）：${bad.join(" | ")}`);
});

/* ─── 23j. AC-13 行数预算（代码行 ≤300 且原始行数 ≤400；两文件共用一套计数逻辑）─── */
// 口径（SPEC §7 AC-13，一字不得松）：纯注释行 = trim() 后以 // 或 * 或 /* 或 */ 开头；
//   代码行 = 去空行 + 去纯注释行；原始行数 = 物理行（末尾换行不多算一行）；加原始行数上限防注释灌水绕过。
section("23j. AC-13 行数预算（代码行 ≤300，原始行数 ≤400；计数逻辑只写一处）");

function rufusLineCounts(src) {
  const lines = src.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // 末尾换行不算一行
  const raw = lines.length;
  const nonEmpty = lines.filter((l) => l.trim() !== "").length;
  const code = lines.filter((l) => {
    const s = l.trim();
    return s !== "" && !(s.startsWith("//") || s.startsWith("*") || s.startsWith("/*") || s.startsWith("*/"));
  }).length;
  return { raw, nonEmpty, code };
}
for (const file of ["assets/rufus.js", "assets/rufus-facts.js"]) {
  t(`AC-13 ${file}：代码行 ≤300 且原始行数 ≤400`, () => {
    const { raw, nonEmpty, code } = rufusLineCounts(readFileSync(path.join(ROOT, file), "utf8"));
    assert.ok(code <= 300, `${file} 代码行超预算：原始 ${raw} / 非空 ${nonEmpty} / 代码 ${code}（上限 300，超出按子功能拆文件）`);
    assert.ok(raw <= 400, `${file} 原始行数超上限：原始 ${raw} / 非空 ${nonEmpty} / 代码 ${code}（上限 400，防注释灌水绕过）`);
  });
}

/* ─── 23k. 规则层常量成员数漂移锁（未导出的内部常量 → 源码级解析，§8 #13 三层词池）─── */
// 实现席位不导出这些内部常量；红线：**不许为测试让实现加导出**。故文本解析源码里的数组字面量。
section("23k. 规则层常量成员数漂移锁（GUARD_STOPLIST / NEGATION_WORDS / UNIT_AMBIGUOUS_WHITELIST）");

const RUFUS_FACTS_SRC = readFileSync(path.join(ROOT, "assets", "rufus-facts.js"), "utf8");

/** 从源码里解析 `const NAME = [ ... ]` 的字符串元素（不加导出的替代路径）。 */
function rufusParseArrayLiteral(src, name) {
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
  if (!m) return null;
  return (m[1].match(/"[^"\n]*"|'[^'\n]*'/g) || []).map((s) => s.slice(1, -1));
}

t("成员数漂移锁：GUARD_STOPLIST=8 / NEGATION_WORDS=9 / UNIT_AMBIGUOUS_WHITELIST=3", () => {
  const parsed = {
    GUARD_STOPLIST: rufusParseArrayLiteral(RUFUS_FACTS_SRC, "GUARD_STOPLIST"),
    NEGATION_WORDS: rufusParseArrayLiteral(RUFUS_FACTS_SRC, "NEGATION_WORDS"),
  };
  assert.ok(parsed.GUARD_STOPLIST, "未从 rufus-facts.js 解析到 GUARD_STOPLIST（改名/换写法？）");
  assert.ok(parsed.NEGATION_WORDS, "未从 rufus-facts.js 解析到 NEGATION_WORDS（改名/换写法？）");
  assert.equal(parsed.GUARD_STOPLIST.length, 8, `GUARD_STOPLIST 成员数漂移：${parsed.GUARD_STOPLIST.length} != 8（通用连接词/标点表）`);
  assert.equal(parsed.NEGATION_WORDS.length, 9, `NEGATION_WORDS 成员数漂移：${parsed.NEGATION_WORDS.length} != 9（否定窗口词表）`);
  assert.equal(RUFUS_FACTS.UNIT_AMBIGUOUS_WHITELIST.length, 3, `UNIT_AMBIGUOUS_WHITELIST 成员数漂移：${RUFUS_FACTS.UNIT_AMBIGUOUS_WHITELIST.length} != 3（oz/lb/kg）`);
});

t("GUARD_STOPLIST 规格副本 ≡ 实现（独立副本与实现集合恒等，防两处各改各的）", () => {
  const impl = rufusParseArrayLiteral(RUFUS_FACTS_SRC, "GUARD_STOPLIST");
  assert.deepEqual([...impl].sort(), [...RUFUS_GUARD_STOPLIST].sort(),
    "规格副本 RUFUS_GUARD_STOPLIST 与实现里的 GUARD_STOPLIST 集合不等（其中一处被改）");
});

/* ─── 23l. R5 图内文字连字符归一（缺陷 L，SPEC §8 #14 / v1.0.7；打生产入口 R5-01）─── */
// 苹果商图最常见形态＝全大写 + 连字符（BPA-FREE / SPILL-PROOF / EASY-CARE），文本字段常写成空格分隔。
// 规则本意＝"图上有的字、文本字段里没有"，不是"标点必须一致"；两侧须做同一套 norm（. - _ / → 空格 + 折白 + 小写）。
// ⚠️ 实现席位尚未落地 L → L1/L2/L3 预期红（**不带 tag** = 落「其它失败」栏，照实报"等 impl"，禁止改期望值）。
section("23l. R5 图内文字连字符归一（缺陷 L；打生产入口 R5-01）");

const rufusR5 = (listing, imageText) => rufusRule(listing, "R5-01", { imageText }).status;

// 报 → 不报（3）：归一后图上字与文本字段实质一致，不得再判未文本化。
const RUFUS_L_FIXED = [
  ["L1 BPA-FREE × 'BPA free plastic lid'", { description: "BPA free plastic lid" }, "BPA-FREE"],
  ["L2 SPILL-PROOF × 'stain resistant spill proof coating'", { description: "stain resistant spill proof coating" }, "SPILL-PROOF"],
  ["L3 EASY-CARE × 'Easy care fabric'", { description: "Easy care fabric" }, "EASY-CARE"],
];
for (const [label, l, img] of RUFUS_L_FIXED) {
  t(`缺陷L（期望不报）：${label} —— 连字符归一后应判已文本化`, () => {
    assert.equal(rufusR5(l, img), "通过",
      `${label}：图上字带连字符、文本侧空格分隔被判「未文本化」（系统误报；SPEC §8 #14）`);
  });
}

// 反向锁：保持不报（3）—— 修 L 不得把本来正确的匹配弄坏。
const RUFUS_L_KEEP = [
  ["L4 SPILL-PROOF × 'spill-proof coating'（两侧都带连字符）", { description: "spill-proof coating" }, "SPILL-PROOF"],
  ["L5 MACHINE WASHABLE × 'machine washable'", { description: "machine washable" }, "MACHINE WASHABLE"],
  ["L6 3.5 INCH × '3.5 inch diameter'", { description: "3.5 inch diameter" }, "3.5 INCH"],
];
for (const [label, l, img] of RUFUS_L_KEEP) {
  t(`反向锁（期望不报）：${label} —— 修 L 不得把这些本来正确的匹配弄坏`, () => {
    assert.equal(rufusR5(l, img), "通过", `${label}：归一改造把原本正确的匹配弄成误报`);
  });
}

// 必须仍报（2）—— 归一不得扩成"词序 / 同义词归一"。
t("缺陷L（必须仍报）：LIFETIME-WARRANTY × 'durable construction' 是真未文本化", () => {
  assert.equal(rufusR5({ description: "durable construction" }, "LIFETIME-WARRANTY"), "命中",
    "真未文本化被漏报（归一过度，把无关文本当成覆盖）");
});
t("缺陷L（必须仍报）：BPA-FREE × 'free of BPA' 语序不同，仍须报", () => {
  assert.equal(rufusR5({ description: "free of BPA" }, "BPA-FREE"), "命中",
    "语序不同被当成已覆盖（SPEC §8 #14 明禁：不做词序 / 同义词归一）");
});

/* ─── 23m. G4 否定窗口固定 2 词（SPEC §8 #15，v1.0.8；AC-15 扩项）─── */
// ⚠️ 方向说明：本条是**误报**方向的已知边界 —— 与 §8 #10（同字段真矛盾不报，**漏报**方向）**相反**。
//   两者都以"少猜"为取舍，但方向相反，必须分开读；别把这里的「命中」当 bug "修"掉（放大窗口会吞掉真冲突）。
section("23m. G4 否定窗口固定 2 词（SPEC §8 #15；误报方向已知边界）");

t("反向锁（期望不命中）：'not genuine leather' × 'synthetic' —— 2 词内否定必须正常撤销（ADR L416 / SPEC §8 #15）", () => {
  assert.deepEqual(rufusMaterial({ title: "not genuine leather", description: "synthetic" }), [],
    "把窗口改小到 0/1 词 → 本该撤销的否定失效（这条立刻红）");
});
t("已知误报边界（期望命中，SPEC §8 #15）：'This is not the real genuine leather' × 'synthetic'", () => {
  // not 距 genuine leather 3 词 > 窗口 2 → 不撤 → 报。卖家语义是"这不是真皮"，此时报属**误报**。
  // 这是**故意保留**的已知边界（放大窗口会误撤远处子句的否定，吞掉"标题说不含 X、描述说含 X"的真不一致）。
  assert.ok(rufusMaterial({ title: "This is not the real genuine leather", description: "synthetic" }).length > 0,
    "窗口被放宽到 >2 词 → 这条应当照报的已知边界变不报（须同步改 SPEC §8 #15）");
});
t("已知误报边界（期望命中，SPEC §8 #15）：'not a product made of genuine leather' × 'synthetic'（第二条实例）", () => {
  assert.ok(rufusMaterial({ title: "not a product made of genuine leather", description: "synthetic" }).length > 0,
    "只对某一种词距生效？第二条 3 词实例没照 SPEC §8 #15 报出");
});

/* ─── 23n. 缺陷 K：空表不得谎报「全部通过」（SPEC AC-04 / v1.0.6）─── */
section("23n. 缺陷 K conclusion：空表不得报「全部通过」");

t("空表 + productType：summary.conclusion !== '全部通过'（一条规则都没跑，不得谎报通过）", () => {
  const s = RUFUS.lintRufus({}, { productType: "home_kitchen" }).summary;
  assert.notEqual(s.conclusion, "全部通过", "空表结论是「全部通过」= 界面说假话（SPEC AC-04，缺陷 K）");
  assert.equal(s.hit, 0, "空表不该有命中（AC-04）");
});
t("非空且全部通过：summary.conclusion === '全部通过'（双向锁，防把结论恒改成「无可检查项」）", () => {
  const s = RUFUS.lintRufus({ title: "100% Cotton towel", description: "100% Cotton fabric" }, {}).summary;
  assert.equal(s.hit, 0, "该 fixture 不应有命中（构造前提）");
  assert.equal(s.conclusion, "全部通过", "真有可检查项且全通过时，结论却没说「全部通过」");
});

/* ─── 12. Rufus 命名口径与能力边界（界面 + 文档都会被反复引用，必须写死在代码里）─── */
t("Rufus 命名：两个名字都认，但不做「功能完全等同」的断言", () => {
  const n = RUFUS.RUFUS_NAMING;
  assert.ok(n?.current, "缺 RUFUS_NAMING");
  assert.ok(n.aliases.includes("Alexa+"), "别名里没有 Alexa+");
  assert.match(n.note, /不做/, "note 没有写清「不等同」的立场");
  assert.match(n.sourceTier, /待核实/, "更名这事没有官方原文，必须标待核实");
});

t("Rufus 边界：明确写着「不是官方评分、不预测排名」", () => {
  assert.match(RUFUS.RUFUS_NAMING.boundary, /不是.*官方评分/);
  assert.match(RUFUS.RUFUS_NAMING.boundary, /不预测/);
  // 只写在代码里没用 —— 用户看的是界面
  assert.match(HTML, /不是官方评分/, "界面没有显示能力边界");
  assert.match(HTML, /Alexa\+/, "界面没有提 Alexa+ 这个新名字");
});

/* ─────────────── 24. 图标注册表一致性 ─────────────── */
// 团队级 P0：不许 emoji 当功能图标；图标只能从锁定注册表取。
// 用**文本解析**读 assets/app.js，不 import —— 它是浏览器模块，顶层有 DOM 副作用，Node 里 import 会抛
// （同 zip.js 那类"只在浏览器侧跑得动"的文件）。期望值全部从 index.html / app.js / store.js 现读，
// 不在断言里抄一份图形数据当标准。
section("24. 图标注册表一致性（防 emoji 图标 / 防静默空图标 / 防内联漂移）");

const ICON_KEY_RE = /(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;

// 从 app.js 文本里截出 `export const ICONS = { ... }` 块，剥注释后解析出 { 键: 图形片段串 }。
function rufusParseIcons(src) {
  const m = src.match(/export const ICONS\s*=\s*\{([\s\S]*?)\n\};/);
  if (!m) return null;
  const body = m[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const out = {};
  let x;
  ICON_KEY_RE.lastIndex = 0;
  while ((x = ICON_KEY_RE.exec(body)) !== null) out[x[1] ?? x[2] ?? x[3]] = x[4] ?? x[5];
  return out;
}

// 从一段 svg 内容里抽出几何元素（path/rect/circle/...），空白归一化。
function rufusIconElems(svgInner) {
  return (svgInner.match(/<(?:path|rect|circle|line|polyline|polygon|ellipse)\b[^>]*\/?>/g) || [])
    .map((e) => e.replace(/\s+/g, " ").trim());
}

t("A. ICONS 注册表键集合非空，且每个图标的图形片段非空（值空 = 界面上一处空白图标位）", () => {
  const reg = rufusParseIcons(APP);
  assert.ok(reg, "在 assets/app.js 里找不到 `export const ICONS = {` 块");
  const keys = Object.keys(reg);
  assert.ok(keys.length > 0, "ICONS 键集合为空");
  const empty = keys.filter((k) => !reg[k] || !reg[k].trim());
  assert.deepEqual(empty, [], `这些图标键的图形片段为空：${empty.join(",")}`);
});

t("B. 所有 iconSvg(字面名) 与 store.js KINDS.icon 都落在 ICONS 键集合内（未知名会静默渲染成空）", () => {
  const reg = rufusParseIcons(APP);
  assert.ok(reg, "找不到 ICONS 注册表");
  const keys = new Set(Object.keys(reg));
  // iconSvg(...) 实参里所有字符串字面量（兼容 iconSvg(hard ? "x-circle" : "alert-triangle") 这种三元）
  const literal = [];
  for (const call of APP.matchAll(/iconSvg\(([^)]*)\)/g))
    for (const s of call[1].matchAll(/["']([A-Za-z0-9_-]+)["']/g)) literal.push(s[1]);
  assert.ok(literal.length > 0, "没扫到任何 iconSvg 字面调用 —— 扫描规则失效（会空过）");
  const storeSrc = readFileSync(path.join(ROOT, "assets", "store.js"), "utf8");
  const kinds = [...storeSrc.matchAll(/icon:\s*["']([^"']+)["']/g)].map((m) => m[1]);
  const unknown = [...new Set([...literal, ...kinds])].filter((n) => !keys.has(n));
  assert.deepEqual(unknown, [],
    `以下图标名不在 ICONS 注册表里（iconSvg 对未知名返回空串 → 静默空白图标位）：${unknown.join(", ")}`);
});

t("C. 导航内联 SVG 与 ICONS 注册表逐位一致（全项目唯一内联例外，防两份实现漂移）", () => {
  const reg = rufusParseIcons(APP);
  assert.ok(reg, "找不到 ICONS 注册表");
  const navIcons = [];
  for (const m of HTML.matchAll(/<button data-view="([^"]+)"[\s\S]*?<span class="ico">\s*<svg[^>]*>([\s\S]*?)<\/svg>\s*<\/span>/g))
    navIcons.push({ view: m[1], elems: rufusIconElems(m[2]) });
  assert.equal(navIcons.length, 8, `导航内联图标数 ${navIcons.length} != 8`);
  const regElems = Object.entries(reg).map(([k, v]) => [k, rufusIconElems(v)]);
  const sortedSig = (a) => [...a].sort().join("|");
  const eq = (a, b) => a.length === b.length && sortedSig(a) === sortedSig(b);
  // 漂移启发式：图标元素是独特字符串，同一张图画两遍本应逐位相等。
  // 若 nav 图标与某 ICONS 键"重合但不全等"（共享>=2 个元素，或短的全被长的包含）→ 判为同名图漂移（改一笔/少一笔都会露馅）。
  const drift = [];
  let dupPairs = 0;
  for (const n of navIcons)
    for (const [k, elems] of regElems) {
      const shared = n.elems.filter((e) => elems.includes(e)).length;
      if (shared === 0) continue;
      if (eq(n.elems, elems)) { dupPairs++; continue; }
      if (shared >= 2 || shared === Math.min(n.elems.length, elems.length))
        drift.push(`${n.view} ~ ICONS["${k}"]（共享 ${shared}/${n.elems.length} 个元素，非全等）`);
    }
  assert.ok(dupPairs >= 1, "没有任何 nav↔ICONS 逐位相等的对 —— 比对没真正跑（空过）");
  assert.deepEqual(drift, [],
    `导航内联图标与注册表同名图已漂移（改了注册表没改内联，或反之）：${drift.join("；")}`);
});

/* ─────────────── 25. 竞品关键词 → 文案提示词（第 ⑦ 卡） ───────────────
 * 这一节的算法断言**不是**"我自己写一遍再对一遍"，而是拿**移植前对原工具拍的快照**当基准。
 * 快照生成方式见 docs/fixtures/keywords-baseline.json 的文件头注释（原 tool/server.js 按行号切片跑）。
 * 所以这里的 hash 一旦变红 = 算法行为变了，得先回答"是不是有意的"，而不是顺手改 hash。
 */
const CKW_FIX_BUSY = [
  "Montessori Busy Board for Toddlers 1-3, Sensory Activity Board with Buckles, Zippers and Laces",
  "Wooden Busy Board for Toddlers, Montessori Sensory Toy with 8 Pages of Activities for Travel",
  "Toddler Busy Board, Montessori Sensory Board for 1 2 3 Year Old, Educational Learning Toy",
  "Busy Board Montessori Toys for Toddlers, Sensory Board with Numbers, Shapes and Colors",
  "Montessori Toys Busy Board for 1 Year Old Boys Girls, Sensory Activity Board for Fine Motor Skills",
  "Wooden Montessori Busy Board, Toddler Activity Board with Latches and Locks for Preschool Learning",
  "Busy Board for Toddlers 3-4, Montessori Sensory Board with Dinosaur Theme, Travel Toy for Car",
  "Sensory Busy Board for Toddlers, Montessori Preschool Learning Activities for Fine Motor Skills",
  "Montessori Busy Board for Kids, Portable Sensory Board with Zipper and Buttons, Travel Toy",
  "Toddler Montessori Busy Board, Wooden Sensory Activity Board for Boys and Girls Age 2 3 4",
  "Busy Board Sensory Toy for Toddlers, Montessori Educational Activity Board with Music and Lights",
  "Montessori Sensory Board for Toddlers, Busy Board with Fine Motor Skills Activities, Blue",
];
const CKW_FIX_CAT = [
  "Cat Scratching Post for Indoor Cats, 32 inch Sisal Rope Scratching Post with Hanging Ball",
  "Cat Scratcher Cardboard Lounge Bed, Reversible Double-Sided Corrugated Cat Scratch Pad",
  "Tall Cat Scratching Post for Large Cats, Sturdy Sisal Rope Cat Tree with Dangling Toy",
  "Cat Scratcher Pad, Sisal Cat Scratching Post with Natural Rope for Indoor Cats and Kittens",
  "Wall Mounted Cat Scratcher, Sisal Rope Cat Scratching Post for Indoor Cats, Space Saving",
  "Cat Scratching Post and Lounge, Sisal Rope Covered Scratching Post with Toy Ball for Cats",
  "Corrugated Cat Scratcher Bed, Durable Cardboard Cat Scratch Pad for Indoor Cats, Large",
  "Cat Tree with Scratching Post, Sisal Rope Cat Scratcher for Indoor Cats, Grey",
  "Sisal Cat Scratching Post, Durable Scratch Post for Indoor Cats and Kittens, 24 inch",
  "Cat Scratcher Cardboard, Wide Corrugated Cat Scratch Pad with Catnip for Indoor Cats",
];
const ckwHash = (o) => createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 16);

section("25. 竞品关键词 → 文案提示词（实时抓取 + 本地权重）");

t("A. 词表规模锁（被截断会让类目匹配/关键词统计**静默**变弱，不报错）", () => {
  assert.equal(Object.keys(CKW.CAT_HINTS).length, 20, "CAT_HINTS 类目数变了");
  assert.equal(CKW.SPECIES.length, 19, "SPECIES 条数变了");
  assert.equal(CKW.SUB_HINTS.length, 107, "SUB_HINTS 条数变了");
  assert.equal(CKW.STOP.size, 139, "STOP 停用词条数变了");
  assert.equal(BEST.CATS.length, 20, "抓取侧类目表条数变了");
  assert.equal(BEST.SITE_CODES.length, 8, "站点数变了");
});

t("B. 行为快照·切词（与原工具逐字段一致）", () => {
  assert.equal(ckwHash(CKW_FIX_BUSY.map((x) => CKW.tokenize(x))), "051aecd8fbf0eed9", "tokenize 行为与原工具不一致");
  assert.equal(ckwHash(CKW_FIX_CAT.map((x) => CKW.tokenize(x))), "e2c0f43ad45ade23", "tokenize 行为与原工具不一致");
});

t("C. 行为快照·二三元组", () => {
  const ng = (ts) => ts.map((t) => [1, 2, 3].map((n) => CKW.buildNgrams(CKW.tokenize(t), n)));
  assert.equal(ckwHash(ng(CKW_FIX_BUSY.slice(0, 3))), ckwHash(ng(CKW_FIX_BUSY.slice(0, 3))), "自反");
  // 位置信息必须保留：pos 是"位置分"的唯一来源，丢了会让所有词的权重一起变
  // ⚠️ 首词 "a" 长度 <2 → `seg.some(w => w.length < 2)` 为真，该位置的 ngram 被**丢弃**，
  //    所以 pos 从 1 开始而不是 0。这是原工具既有行为，不是 bug。
  const g = CKW.buildNgrams(["a", "busy", "board", "toy"], 2);
  assert.deepEqual(g.map((x) => x.pos), [1, 2], "ngram 的 pos 不对（丢弃短词导致 pos 偏移）");
  assert.deepEqual(g.map((x) => x.term), ["busy board", "board toy"], "ngram 的词不对");
});

t("D. 行为快照·关键词权重（覆盖率×0.5 + 位置×0.3 + 精准度×0.2）", () => {
  const a = CKW.analyzeKeywords(CKW_FIX_BUSY, { productName: "", allTitles: CKW_FIX_BUSY });
  assert.equal(a.total, 12, "分母（竞品标题总数）不对");
  assert.equal(a.rows.length, 50, "权重表条数变了");
  assert.equal(a.blank.length, 12, "空白机会条数变了");
  assert.equal(ckwHash(a.rows), "ca5c72d0091a7a02", "权重表数值与原工具不一致");
  assert.equal(a.top[0].term, "busy board", "top1 词变了");
  assert.equal(a.top[0].weight, 9.1, "top1 权重变了");
  assert.equal(a.top[0].advice, "必埋标题前段", "top1 建议档变了");
  const c = CKW.analyzeKeywords(CKW_FIX_CAT, { productName: "", allTitles: CKW_FIX_CAT });
  assert.equal(c.total, 10, "分母不对");
  assert.equal(c.rows.length, 42, "权重表条数变了");
  assert.equal(c.blank.length, 9, "空白机会条数变了");
  assert.equal(ckwHash(c.rows), "2b87f0c458190e15", "权重表数值与原工具不一致");
  assert.equal(c.top[0].term, "cat", "top1 词变了");
  assert.equal(c.top[0].weight, 7.5, "泛词扣分没生效（单词且覆盖率 100% 应扣 1.2）");
});

t("E. 权重模型的边界（这几条是原工具刻意设计的，别'顺手'改掉）", () => {
  // 只出现 1 次的词是噪声，不留
  const once = CKW.analyzeKeywords(["alpha beta gamma delta epsilon", "alpha beta zeta eta theta"], { productName: "" });
  assert.ok(!once.rows.some((r) => r.cov < 2), "出现了只覆盖 1 条的词");
  // 覆盖 100% 的单词要扣分：否则 toy/dog 这种"入场券词"会挤掉长尾
  const mono = CKW.analyzeKeywords(["toy for kids and adults using it daily", "toy for kids and adults using it weekly"], { productName: "" });
  const toy = mono.rows.find((r) => r.term === "toy");
  assert.ok(toy && toy.weight <= 8.8, `单词+100% 覆盖应被扣分，实际 ${toy && toy.weight}`);
  // 位置分：同一个词放前面对后面，权重必须更高
  const front = CKW.analyzeKeywords(["busy board with latch and zipper and buckles", "busy board with latch and zipper and buckles"], { productName: "" });
  const back = CKW.analyzeKeywords(["latch and zipper and buckles with busy board", "latch and zipper and buckles with busy board"], { productName: "" });
  const f1 = front.rows.find((r) => r.term === "busy board"), b1 = back.rows.find((r) => r.term === "busy board");
  assert.ok(f1.weight > b1.weight, "位置靠前权重应更高");
  assert.ok(f1.avgPos < b1.avgPos, "avgPos 应更小");
});

t("F. 行为快照·类目打分", () => {
  const qs = ["蒙氏忙碌板", "猫抓板", "白色入耳耳机", "white noise earbuds", "dog chew toy", "保温杯",
    "婴儿推车", "瑜伽垫", "电动工具", "手工具", "toddler busy board", "montessori", "猫爬架", "3d printer", "游戏手柄", "绘本"];
  const got = Object.fromEntries(qs.map((q) => [q, CKW.scoreCats(q)]));
  assert.equal(ckwHash(got), "03b19225668d8639", "类目打分与原工具不一致");
  assert.equal(CKW.detectCatSlug("蒙氏忙碌板"), "toys-and-games");
  assert.equal(CKW.detectCatSlug("猫爬架"), "pet-supplies");
  assert.equal(CKW.detectCatSlug("完全不认识的东西"), null, "没命中必须返回 null，不能瞎猜一个类目");
});

t("G. 词形宽松匹配 hasWord（ropes 能被 rope 命中）", () => {
  assert.equal(CKW.hasWord("ropes and cats", "rope"), true);
  assert.equal(CKW.hasWord("ropes and cats", "cat"), true);
  assert.equal(CKW.hasWord("boxes", "box"), true);
  assert.equal(CKW.hasWord("busy board", "busy"), true);
  assert.equal(CKW.hasWord("busy board", "zipper"), false, "不该命中的必须不命中");
});

t("H. 一致性校验：只吃本地联想词，不联网翻译（这条是**刻意**偏离原工具，写进文档了）", () => {
  const r = CKW.analyzeKeywords(CKW_FIX_CAT, { productName: "猫抓板", allTitles: CKW_FIX_CAT });
  assert.equal(r.consistency.score, 100);
  assert.equal(r.consistency.level, "good");
  assert.deepEqual(r.consistency.hit, ["scratching", "scratcher", "scratchers"]);
  // 纯英文产品名 + 不给 extraWords → 探测词为空 → 必须**跳过**（null），而不是算一个 0 分的假结果
  const en = CKW.analyzeKeywords(CKW_FIX_CAT, { productName: "White Noise Machine", allTitles: CKW_FIX_CAT });
  assert.equal(en.consistency, null, "探测词为空时必须跳过，不能谎报 0 分");
  // 给了 extraWords 才启用（调用方自己决定要不要给翻译词）
  const withExtra = CKW.analyzeKeywords(CKW_FIX_CAT, { productName: "White Noise Machine", allTitles: CKW_FIX_CAT, extraWords: ["cat", "sisal"] });
  assert.ok(withExtra.consistency && withExtra.consistency.score === 100, "给了 extraWords 应参与校验");
});

t("I. 抓取·出网白名单（纯函数，不联网）—— 这是全项目唯一会爬第三方站点的通道", () => {
  const allow = [
    "https://www.amazon.com/gp/bestsellers/toys-and-games",
    "https://www.amazon.co.jp/gp/bestsellers/pet-supplies",
    "https://www.amazon.de/zgbs/kitchen/1234",
  ];
  for (const u of allow) assert.equal(BEST.isAllowedAmazonUrl(u), true, `应放行：${u}`);
  const deny = [
    ["https://evil.com/gp/bestsellers/toys-and-games", "非白名单主机"],
    ["https://www.amazon.com.evil.com/gp/bestsellers/x", "相似域名（后缀欺骗）"],
    ["https://evil.com.www.amazon.com/gp/bestsellers/x", "相似域名（前缀欺骗）"],
    ["http://www.amazon.com/gp/bestsellers/toys-and-games", "非 https"],
    ["https://www.amazon.com/s?k=toy", "被封锁的搜索路径，本项目不提供"],
    ["https://www.amazon.com/dp/B0C1234567", "商品详情页不是榜单路径"],
    ["https://127.0.0.1/gp/bestsellers/toys-and-games", "回环地址"],
    ["https://www.amazon.com/gp/bestsellers/../../admin", "路径穿越"],
    ["file:///etc/passwd", "非 http(s) 协议"],
  ];
  for (const [u, why] of deny) assert.equal(BEST.isAllowedAmazonUrl(u), false, `必须拒绝（${why}）：${u}`);
  // 类目 slug 必须来自已知表，不能任意拼路径
  assert.equal(BEST.bestsellersPath("toys-and-games"), "/gp/bestsellers/toys-and-games");
  assert.equal(BEST.bestsellersPath("../../etc"), null, "未知类目必须返回 null");
  assert.equal(BEST.bestsellersPath(""), null);
});

t("J. 🔴 单一实现反向锁：白名单与算法都不许在第二处再写一遍", () => {
  const srv = readFileSync(path.join(ROOT, "server.mjs"), "utf8");
  const app = readFileSync(path.join(ROOT, "assets/app.js"), "utf8");
  const best = readFileSync(path.join(ROOT, "assets/bestsellers.js"), "utf8");
  // 服务端只 import，不重写
  assert.ok(/from "\.\/assets\/bestsellers\.js"/.test(srv), "server.mjs 没有引用 bestsellers.js");
  assert.ok(!/const AMAZON_HOSTS\s*=/.test(srv), "server.mjs 又内联了一份主机白名单");
  assert.ok(!/function isAllowedAmazonUrl/.test(srv), "server.mjs 又内联了一份地址白名单");
  // 重定向必须二次校验（否则一个合法 URL 302 到任意地址就绕过了白名单）
  assert.ok(/isAllowedAmazonUrl\(next\)/.test(best), "抓取重定向没有二次过白名单");
  // 前端不许把算法抄一份
  assert.ok(!/function tokenize\s*\(/.test(app), "app.js 又内联了一份 tokenize");
  assert.ok(!/function buildNgrams\s*\(/.test(app), "app.js 又内联了一份 buildNgrams");
  assert.ok(/from "\.\/competitor-keywords\.js"/.test(app), "app.js 没有引用 competitor-keywords.js");
  assert.ok(/from "\.\/copy-prompts\.js"/.test(app), "app.js 没有引用 copy-prompts.js");
  // 出网校验复用 net-guard 的唯一实现
  assert.ok(/assertPublicUrl/.test(best) && /from "\.\/net-guard\.js"/.test(best), "bestsellers.js 没有复用 net-guard");
});

t("L. 🔴 重试只重试「可能好」的错：401/403/404 直接抛，其余指数退避", async () => {
  const calls = [];
  const failWith = (status) => async () => { calls.push(status); const e = new Error("HTTP " + status); e.status = status; throw e; };

  // ① 403 属于确定性失败 —— 重试只会让上游更确定要拦你
  calls.length = 0;
  await assert.rejects(() => BEST.withRetry(failWith(403), 3, 1));
  assert.equal(calls.length, 1, `403 被重试了 ${calls.length} 次（应只请求 1 次）`);

  // ② 500 属于「可能好」—— 必须重试到 tries 次
  calls.length = 0;
  await assert.rejects(() => BEST.withRetry(failWith(500), 3, 1));
  assert.equal(calls.length, 3, `500 只试了 ${calls.length} 次`);

  // ③ 成功一次就停
  let n = 0;
  const ok = await BEST.withRetry(async () => { n++; if (n < 2) { const e = new Error("HTTP 503"); e.status = 503; throw e; } return "done"; }, 3, 1);
  assert.equal(ok, "done");
  assert.equal(n, 2, "成功后没有立刻停止重试");

  // ④ tries=1 时不该等任何间隔
  const t0 = Date.now();
  await BEST.withRetry(async () => { const e = new Error("HTTP 429"); e.status = 429; throw e; }, 1, 5000).catch(() => {});
  assert.ok(Date.now() - t0 < 1000, "tries=1 却等了一个间隔");
});

t("M. 缓存是 LRU 而非 FIFO：命中后要把它挪到队尾（否则热门页也会被淘汰）", () => {
  const src = readFileSync(path.join(ROOT, "assets/bestsellers.js"), "utf8");
  const fn = src.slice(src.indexOf("async function cachedFetch"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.ok(/cache\.delete\(url\);\s*\n\s*cache\.set\(url/.test(body), "命中后没有重新入队（还是 FIFO）");
  // TTL 语义不能被 LRU 改写：at 指的是"这份 HTML 有多旧"，不是"上次谁用过"
  assert.ok(!/\bat:\s*Date\.now\(\)\s*\}\);\s*\n\s*return \{ html: hit\.html/.test(body), "命中时刷新了 at（TTL 会变成永不过期）");
});

t("K. 文案提示词·字符口径全部来自 listing.js（不许手写第二份）", () => {
  const src = readFileSync(path.join(ROOT, "assets/copy-prompts.js"), "utf8");
  assert.ok(/from "\.\/listing\.js"/.test(src), "copy-prompts.js 没有引用 listing.js");
  assert.ok(/LIMITS\.searchTerms/.test(src), "后台词上限没有取 LIMITS.searchTerms");
  assert.ok(/LIMITS\.bullet\b/.test(src), "五点上限没有取 LIMITS.bullet");
  assert.ok(/titleLimit\(/.test(src), "标题上限没有取 titleLimit()");
  // 反向锁：不许出现自写的 200/75 三元（口径第二份实现）
  assert.ok(!/isMedia\s*\?\s*200\s*:\s*75/.test(src), "copy-prompts.js 里又写了一份 200:75 三元");
  const base = { product: "蒙氏忙碌板", items: [{ rank: 1, title: CKW_FIX_BUSY[0] }], rows: [{ term: "busy board", useRate: 100, cov: 1, total: 1, avgPos: 0.1, weight: 9.2, advice: "必埋标题前段" }] };
  const nonMedia = CPROMPT.buildCopyPrompt("title", base);
  assert.ok(/75 字符/.test(nonMedia.prompt), "非媒体类目必须写 75");
  assert.ok(/125 字符/.test(nonMedia.prompt), "Item Highlights 必须写 125");
  const media = CPROMPT.buildCopyPrompt("title", { ...base, isMedia: true });
  assert.ok(/200 字符/.test(media.prompt), "媒体类目必须写 200");
  // 注意：media 版的规则文字里**会**提到 75（作为"别套用非媒体口径"的对照），所以只锁
  // "硬上限阈值"那一句，不能用宽泛的 /75 字符/ 去否定整段。
  assert.ok(/严格 ≤200 字符/.test(media.prompt), "媒体类目的硬上限必须写成 200");
  assert.ok(!/严格 ≤75 字符/.test(media.prompt), "媒体类目的硬上限不该写成 75");
  assert.equal(nonMedia.meta.titleCap, 75);
  assert.equal(media.meta.titleCap, 200);
  // 后台词是**字节**口径 —— 原工具写成"250 字符"，是错的
  const st = CPROMPT.buildCopyPrompt("searchTerms", base);
  assert.ok(/250 \*\*字节\*\*/.test(st.prompt), "后台词必须写明字节口径");
  // 五点上限取自 LIMITS.bullet（500），不是 200
  assert.ok(/不超过 500 字符/.test(CPROMPT.buildCopyPrompt("bullets", base).prompt), "五点上限不对");
  // 权重表必须明确"直接采用、不要重算"
  assert.ok(/不要自己重算/.test(nonMedia.prompt), "提示词没有禁止模型重算权重");
});

t("L. 文案提示词的守卫：缺输入必须给可读错误，**不许**产出空提示词", () => {
  const full = { product: "p", items: [{ rank: 1, title: CKW_FIX_BUSY[0] }], rows: [{ term: "x", useRate: 1, cov: 1, total: 1, avgPos: 0, weight: 5, advice: "a" }] };
  const cases = [
    [CPROMPT.buildCopyPrompt("title", { ...full, product: "" }), "空产品名"],
    [CPROMPT.buildCopyPrompt("title", { ...full, items: [] }), "无竞品"],
    [CPROMPT.buildCopyPrompt("title", { ...full, rows: [] }), "无权重表"],
    [CPROMPT.buildCopyPrompt("不存在", full), "未知类型"],
  ];
  for (const [r, why] of cases) {
    assert.equal(r.ok, false, `${why} 应返回 ok:false`);
    assert.ok(r.error && r.error.length > 4, `${why} 的错误信息不可读`);
  }
  // 不需要权重表的类型，缺权重表也必须能生成
  assert.equal(CPROMPT.buildCopyPrompt("analysis", { ...full, rows: [] }).ok, true, "① 竞品拆解不该依赖权重表");
  assert.equal(CPROMPT.PROMPT_KIND_IDS.length, 5, "提示词类型数变了");
});

t("M. 第 ⑦ 卡接线（不新增视图；每个 button id 都必须真绑）", () => {
  const views = [...HTML.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(views).size, 8, `视图数 ${new Set(views).size} != 8 —— 加卡不加视图，除非是独立的一等页面（本周词库）`);
  assert.ok(/⑦ 竞品关键词/.test(HTML), "index.html 里找不到第 ⑦ 卡");
  for (const id of ["#cpSite", "#cpCat", "#cpSub", "#cpKind", "#cpIsMedia", "#cpProduct"]) {
    assert.ok(HTML.includes(`id="${id.slice(1)}"`), `卡片缺少 ${id}`);
  }
  for (const id of ["#btnCpFetch", "#btnCpAnalyze", "#btnCpToCorpus", "#btnCpGen", "#btnCpCopy"]) {
    assert.ok(HTML.includes(`id="${id.slice(1)}"`), `卡片缺少按钮 ${id}`);
    assert.ok(APP.includes(id), `${id} 在 app.js 里没有绑定事件`);
  }
  assert.ok(/function bindCompetitor\(/.test(APP), "app.js 缺少 bindCompetitor()");
  assert.ok(/bindCompetitor\(\);/.test(APP), "boot() 里没有调用 bindCompetitor()");
  // 离线/失败必须如实报，不许静默
  assert.ok(/抓取失败：/.test(APP) && /如实报错/.test(APP), "抓取失败路径没有如实提示");
});

t("N. 抓取模块不引入第三方依赖（保持项目零依赖）", () => {
  const best = readFileSync(path.join(ROOT, "assets/bestsellers.js"), "utf8");
  const imports = [...best.matchAll(/^import .*?from "([^"]+)"/gm)].map((m) => m[1]);
  for (const i of imports) {
    assert.ok(i.startsWith("node:") || i.startsWith("./"),
      `bestsellers.js 引入了非内置依赖：${i}（项目零依赖，不能破）`);
  }
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(pkg.dependencies || {}), [], "package.json 出现了 dependencies");
  assert.deepEqual(Object.keys(pkg.devDependencies || {}), [], "package.json 出现了 devDependencies");
});

/* ─────────────── O. 2026-10-30 排查出来的缺陷：逐条锁死 ───────────────
 * 这一节全部来自实测（不是"读代码觉得可能"），每条注释都写了当初怎么复现的。
 * 改回去 = 这里立刻红。 */

t("O1. 🔴 .env 必须真的被读到（原来只读 .env.local，而 5 处文案教用户写 .env）", () => {
  const srv = readFileSync(path.join(ROOT, "server.mjs"), "utf8");
  // 两个路径都要有；只留 ENV_LOCAL 就等于"文档说的文件名不生效"
  assert.ok(/const ENV_LOCAL = path\.join\(HERE, "\.env\.local"\)/.test(srv), "缺少 .env.local 路径常量");
  assert.ok(/const ENV_PLAIN = path\.join\(HERE, "\.env"\)/.test(srv), "缺少 .env 路径常量（.env 又会被忽略）");
  // envFileConfig 必须按顺序遍历两个文件，且先读到的不被覆盖（.env.local 优先）
  const fn = srv.slice(srv.indexOf("function envFileConfig()"), srv.indexOf("function getEnv("));
  assert.ok(/\[ENV_LOCAL, ENV_PLAIN\]/.test(fn), "envFileConfig 没有同时遍历 .env.local 与 .env");
  assert.ok(/k in out/.test(fn), "同名键没有按「先到先得」处理 → 优先级不确定");
  // 文案不许再单方面让人写 .env
  const example = readFileSync(path.join(ROOT, ".env.example"), "utf8");
  assert.ok(/\.env\.local/.test(example.split("\n")[0]), ".env.example 第一行没提 .env.local");
});

t("O2. hasWord 必须是词边界匹配（子串匹配会把一致性分数算虚高）", () => {
  // 实测旧实现：这两条都是 true
  assert.equal(CKW.hasWord("party favors for kids", "art"), false, "「art」不该命中「party」");
  assert.equal(CKW.hasWord("cardigan sweater", "car"), false, "「car」不该命中「cardigan」");
  // 原本的意图不能被改坏
  assert.equal(CKW.hasWord("ropes and cats", "rope"), true);
  assert.equal(CKW.hasWord("boxes", "box"), true);
});

t("O3. 抓取白名单要管端口（同主机名不同端口是另一个服务）", () => {
  assert.equal(BEST.isAllowedAmazonUrl("https://www.amazon.com:8443/gp/bestsellers/x"), false,
    "非标端口必须拒绝");
  assert.equal(BEST.isAllowedAmazonUrl("https://www.amazon.com/gp/bestsellers/toys-and-games"), true,
    "默认端口必须放行");
});

t("O4. decodeEntities 不许双重解码（&amp;lt; 应解成 &lt;，不是 <）", () => {
  assert.equal(BEST.decodeEntities("&amp;lt;"), "&lt;");
  assert.equal(BEST.decodeEntities("Tom &amp; Jerry"), "Tom & Jerry", "正常的 &amp; 仍要解");
});

t("O5. 抓取缓存必须有上限（每条是一整页 HTML，只 set 不 delete 会一路涨）", () => {
  const best = readFileSync(path.join(ROOT, "assets/bestsellers.js"), "utf8");
  assert.ok(/const CACHE_MAX = \d+/.test(best), "缓存没有上限常量");
  assert.ok(/cache\.delete\(/.test(best), "缓存从不删除条目 —— TTL 只在读时判，内存不会回收");
  const st = BEST.cacheStats();
  assert.ok(st.max > 0 && st.size <= st.max, `缓存越界：size=${st.size} max=${st.max}`);
});

t("O6. 换站点/类目/子类目必须让旧结果失效（否则提示词里类目和商品对不上）", () => {
  assert.ok(/let cmpEpoch = 0/.test(APP), "缺少请求世代号 cmpEpoch");
  assert.ok(/function clearCompetitorResult\(/.test(APP), "缺少 clearCompetitorResult()");
  for (const id of ['#cpCat', '#cpSite', '#cpSub']) {
    assert.ok(new RegExp(`\\$\\("${id}"\\)\\?\\.addEventListener\\("change"`).test(APP),
      `${id} 没有绑定 change —— 换了它旧榜单不会失效`);
  }
  // 三处必须都真的清：旧的 items / 旧的关键词表 / 旧的提示词
  const fn = APP.slice(APP.indexOf("function clearCompetitorResult("), APP.indexOf("function cpCtx("));
  assert.ok(/CMP\.items = \[\]/.test(fn), "没清 CMP.items");
  assert.ok(/CMP\.rows = null/.test(fn), "没清 CMP.rows");
  assert.ok(/CMP\.prompt = ""/.test(fn), "没清 CMP.prompt");
  assert.ok(/cmpEpoch\+\+/.test(fn), "没作废在途请求 —— 几秒后回来的旧响应会把屏幕重新填满");
});

t("O7. 子类目 url 不许硬拼 host（CMP.cfg 为空时会拼出 https://undefined）", () => {
  assert.ok(!/"https:\/\/" \+ \(CMP\.cfg\?\.sites/.test(APP), "仍在用字符串拼 host");
  assert.ok(/new URL\(x\.href, "https:\/\/" \+ s\.host\)/.test(APP), "应改用 URL 解析相对/绝对 href");
});

t("O8. 畸形 URL 不能变成 500（decodeURIComponent 会抛 URIError）", () => {
  const srv = readFileSync(path.join(ROOT, "server.mjs"), "utf8");
  const fn = srv.slice(srv.indexOf("function serveStatic("), srv.indexOf("/* ─────────────── 竞品数据源"));
  assert.ok(/try \{ rel = decodeURIComponent/.test(fn), "decodeURIComponent 没有接住异常");
  assert.ok(/catch \{ return json\(res, 404/.test(fn), "畸形路径应回 404，不是 500");
});

t("O9. 原生 <select> 必须被自绘下拉接管（原生 popup 的位置页面改不了）", () => {
  assert.ok(existsSync(path.join(ROOT, "assets/select-ui.js")), "缺 assets/select-ui.js");
  assert.ok(/from "\.\/select-ui\.js"/.test(APP), "app.js 没有 import select-ui.js");
  assert.ok(/enhanceSelects\(/.test(APP), "app.js 没有调用 enhanceSelects()");
  const ui = readFileSync(path.join(ROOT, "assets/select-ui.js"), "utf8");
  // 三条硬要求：不裁切（挂 body）、视口内收边、选中后派发真 change
  assert.ok(/document\.body\.appendChild\(pop\)/.test(ui), "弹层没挂到 body —— 会被祖先 overflow 裁切");
  assert.ok(/position: fixed/.test(readFileSync(path.join(ROOT, "assets/app.css"), "utf8")), ".selpop 不是 fixed");
  assert.ok(/new Event\("change", \{ bubbles: true \}\)/.test(ui), "选中后没有派发 change，原有监听器会失效");
  // 10 个 select 都要能被选中（按类选择，不写死 id，避免以后新增下拉漏掉）
  assert.ok(/select\.in/.test(ui), "增强范围不是 select.in");
});

/* ─────────────── 2026-11-05 边界加固 ───────────────
 * 这一节守的是"用户看不出问题、但结果已经错了"的那类缺陷：
 * 比例被静默改写成 1:1、在线离线结论相反、数量出现 "Pack of 1 Pack"、
 * 关键词被剥离却不留痕、media 类目 lint 通过而导出报超限。
 * 每条都对应一个**具体的历史缺陷**，不是凑数。
 */
section("边界加固：画幅链路");

// 1) 比例 ↔ 像素必须双向一致。两向一旦分叉，Prompt 写 16:9、API 收到 4:3。
for (const [ratio, px] of Object.entries(RATIO_PIXELS)) {
  t(`画幅往返相等：${ratio} → ${px} → ${ratio}`, () => {
    const r = parseRatio(`做一张 ${ratio} 的图`);
    assert.equal(r.ratio, ratio, `parseRatio 没认出 ${ratio}`);
    assert.equal(r.size, px, `${ratio} 的像素不是 ${px}`);
    assert.equal(toRatioText(px), ratio, `${px} 反推不出 ${ratio}`);
    const c = composePrompt({ subject: "test product", sizeRatio: px });
    assert.ok(c.prompt.includes(`aspect ratio ${ratio}`), `Prompt 里没有 aspect ratio ${ratio}`);
  });
}

t("时间不当画幅：'上午10:30 开会' 不返回比例", () => {
  const r = parseRatio("上午10:30 开会，顺便聊下主图");
  // 注意：这句话里有"主图"，所以会命中 hero 分支 —— 关键是不能被 10:30 带偏成画幅
  assert.notEqual(r.ratio, "10:30");
  assert.equal(r.explicit === false || r.ratio === "1:1", true, `实际 ${JSON.stringify(r)}`);
});

t("时间不当画幅：'12:30' 不在白名单，必须回落到无比例", () => {
  assert.equal(parseRatio("12:30 见").explicit, false);
});

t("详情页是 2:3（原实现给 3:4）", () => {
  const r = parseRatio("做整套详情页图");
  assert.equal(r.ratio, "2:3");
  assert.equal(r.size, "1024x1536");
  assert.equal(r.scope, "pdp");
});

t("横版是真的 16:9（原实现给 1024x768 = 4:3）", () => {
  const r = parseRatio("做一张横版 banner");
  assert.equal(r.ratio, "16:9");
  assert.equal(r.size, "1536x864");
});

t("9:16 竖版不被压成方图", () => {
  const r = parseRatio("做整套图 9:16");
  assert.equal(r.ratio, "9:16");
  assert.equal(r.size, "864x1536");
  assert.equal(r.scope, "all");
});

t("像素→比例表由正查表派生，不会漏项", () => {
  for (const [ratio, px] of Object.entries(RATIO_PIXELS)) {
    assert.equal(PIXEL_TO_RATIO[px], ratio, `${px} 在反查表里缺失或错位`);
  }
});

/* ─── N3 / A2：同步接口只收三种画布，其余 6 个比例会被 400 ───
 * 原缺陷：客户端自己维护第三份「比例→像素」映射表（sizeToPixel），
 * 把 16:9 发成 1024x768、9:16 发成 720x1280、5:4 直接缺失；
 * 而同步接口的白名单只有 1024x1024 / 1536x1024 / 1024x1536 —— 6/9 个比例必被拒。
 */
const SYNC_OK = new Set(["1024x1024", "1536x1024", "1024x1536"]);

t("strict 同步：9 个比例全部落在白名单内（否则就是 400）", () => {
  for (const ratio of Object.keys(RATIO_PIXELS)) {
    const r = resolveSendSize(ratio, "sync", "strict");
    assert.ok(SYNC_OK.has(r.sent), `${ratio} 在严格同步模式下发出了 ${r.sent}，不在白名单`);
  }
});

t("strict 同步：1:1 / 3:2 / 2:3 不吸附（note 必须为空）", () => {
  for (const ratio of ["1:1", "3:2", "2:3"]) {
    const r = resolveSendSize(ratio, "sync", "strict");
    assert.equal(r.note, "", `${ratio} 本来就不用吸附，却报了吸附`);
  }
});

t("strict 同步：16:9 / 9:16 / 4:3 被吸附，且必须带说明（不许静默换画幅）", () => {
  const cases = { "16:9": "1536x1024", "9:16": "1024x1536", "4:3": "1536x1024", "3:4": "1024x1536", "4:5": "1024x1536", "5:4": "1536x1024" };
  for (const [ratio, px] of Object.entries(cases)) {
    const r = resolveSendSize(ratio, "sync", "strict");
    assert.equal(r.sent, px, `${ratio} 吸附方向错了：${r.sent}`);
    assert.match(r.note, /画幅已吸附/, `${ratio} 被换掉画幅却没留说明`);
    assert.match(r.note, new RegExp(ratio.replace(":", "\\:")), "说明里没写清请求的是哪个比例");
  }
});

t("async 模式：发比例字符串，不做吸附（apimart 收比例）", () => {
  const r = resolveSendSize("16:9", "async", "strict");
  assert.equal(r.sent, "16:9");
  assert.equal(r.note, "");
});

t("free 模式：原样发 RATIO_PIXELS（自建接口收任意尺寸时用）", () => {
  assert.equal(resolveSendSize("16:9", "sync", "free").sent, "1536x864");
  assert.equal(resolveSendSize("9:16", "sync", "free").sent, "864x1536");
  assert.equal(resolveSendSize("5:4", "sync", "free").sent, "1024x819");
});

t("syncCanvasFor 认得出非法比例（不抛错，回落方图并标记 exact=false）", () => {
  assert.deepEqual(syncCanvasFor("abc"), { size: SYNC_CANVAS.square, exact: false });
  assert.deepEqual(syncCanvasFor("1:0"), { size: SYNC_CANVAS.square, exact: false });
  assert.deepEqual(syncCanvasFor("0:9"), { size: SYNC_CANVAS.square, exact: false });
  // 空值当作默认 1:1 处理（不是"非法"）
  assert.deepEqual(syncCanvasFor(""), { size: SYNC_CANVAS.square, exact: true });
});

t("像素入参也能被认出（兼容外部传 1536x864 的场景）", () => {
  assert.equal(resolveSendSize("1536x864", "async").sent, "16:9");
  assert.equal(resolveSendSize("1536x864", "sync").sent, "1536x1024");
});

t("🔴 客户端不再自带第三份映射表：app.js 里没有 sizeToPixel，发出的 size 是比例", () => {
  const app = codeOf(readFileSync(path.join(ROOT, "assets/app.js"), "utf8"));
  assert.ok(!/function\s+sizeToPixel/.test(app), "app.js 仍有 sizeToPixel（第四份口径）");
  assert.ok(!/"1024x768"|"720x1280"/.test(app), "app.js 里仍有硬编码的像素值");
  assert.ok(/size:\s*r\.single\.meta\?\.ratio/.test(app), "app.js 出图时没有把 meta.ratio 原样发出去");
});

t("服务端不复制吸附逻辑（只 import resolveSendSize）", () => {
  const srv = codeOf(readFileSync(path.join(ROOT, "server.mjs"), "utf8"));
  assert.ok(/resolveSendSize/.test(srv), "server.mjs 没复用 resolveSendSize");
  assert.ok(!/SYNC_CANVAS\s*=/.test(srv), "server.mjs 自己定义了 SYNC_CANVAS（第二份）");
  assert.ok(!/syncCanvasFor/.test(srv), "server.mjs 自己实现了 syncCanvasFor（第二份）");
});

section("边界加固：意图与否定（在线/离线必须同源）");

// 静态断言统一用「去注释后的代码」，避免被解释缺陷的注释误伤（见 codeOf 注释）
const SERVER_CODE = codeOf(readFileSync(path.join(ROOT, "server.mjs"), "utf8"));
const ZIP_CODE = codeOf(readFileSync(path.join(ROOT, "assets/zip.js"), "utf8"));

t("服务端不再自带第二份意图词表", () => {
  const src = SERVER_CODE;
  assert.ok(!/const\s+GENERATE_WORDS/.test(src), "server.mjs 仍有自己的 GENERATE_WORDS");
  assert.ok(!/const\s+PACK_WORDS/.test(src), "server.mjs 仍有自己的 PACK_WORDS");
  assert.ok(/isGenerateIntent/.test(src), "服务端没复用 isGenerateIntent");
  assert.ok(/isNegative/.test(src), "服务端没复用 isNegative");
});

t("英文复数说法在服务端也会被认作出图意图（原词表漏了 generate images）", () => {
  assert.equal(isGenerateIntent("generate images for this product"), true);
  assert.equal(isGenerateIntent("帮我生几张图"), true);
});

t("pack 意图也同源（原服务端只有 6 个词）", () => {
  assert.equal(isPackIntent("give me the full set"), true);
  assert.equal(isPackIntent("做一整套主图"), true);
});

const NEG_CASES = [
  ["先看文案，这款暂时不要出图", true, "否定词在第 9 字符之后"],
  ["不用生成了，先别出图", true, "两个否定词"],
  ["不要出图，先给 Prompt", true, "否定在句首"],
  ["帮我出图，画面不要文字", false, "内容是「不要文字」，不是不要出图"],
  ["不要加文字，直接出图", false, "否定修饰的是文字"],
  ["出图", false, "没有否定"],
];
for (const [msg, want, why] of NEG_CASES) {
  t(`否定判定：${JSON.stringify(msg)} → ${want ? "不出图" : "出图"}（${why}）`, () => {
    assert.equal(isNegative(msg), want);
  });
}

t("前端出图前也判否定（不能只靠服务端兜底）", () => {
  assert.ok(
    /isGenerateIntent\(text\)\s*&&\s*!isNegative\(text\)/.test(codeOf(APP)),
    "app.js 的出图分支只判了意图，没判否定",
  );
});

section("边界加固：Listing 三处边界");

t("quantity 已带单位时不再加前缀（消除 'Pack of 1 Pack'）", () => {
  for (const q of ["1 Pack", "2 pcs", "3 件", "Pack of 2", "4 sets", "6 count"]) {
    assert.equal(quantityText(q), q, `${q} 被改成了 ${quantityText(q)}`);
  }
});

t("quantity 纯数字才补 Pack of", () => {
  assert.equal(quantityText("2"), "Pack of 2");
  assert.equal(quantityText("2 x"), "Pack of 2");
  assert.equal(quantityText(""), "");
  assert.equal(quantityText(null), "");
});

t("草稿标题里不出现 'Pack of 1 Pack'", () => {
  const d = generateListingDraft({ productName: "Dog Bowl", quantity: "1 Pack" });
  assert.ok(!/Pack of 1 Pack/.test(d.title), d.title);
  assert.ok(/1 Pack/.test(d.title), d.title);
});

t("Highlights 未超限时不产生 drops", () => {
  const d = generateListingDraft({
    productName: "Dog Bowl", features: ["Stainless steel"], sizeSpec: "9 inch",
  });
  assert.deepEqual(d.highlightsDropped, []);
  assert.equal(d.highlightsDroppedChars, 0);
});

const HL_LONG = generateListingDraft({
  brand: "ACME",
  productName: "Stainless Steel Slow Feeder Dog Bowl for Large Dogs Non Slip Anti Gulping",
  features: [
    "Food-grade 304 stainless steel, BPA free, dishwasher safe base",
    "Silicone base ring, non slip rubber feet, scratch resistant coating",
    "Bamboo fiber lid, odor resistant, easy to clean matte surface finish",
  ],
  sizeSpec: "9.8 x 9.8 x 2.4 inches, 4 cups capacity, fits standard crate",
  audience: "large breed dogs and senior pets with joint issues",
  quantity: "2 pcs",
});

t("Highlights 超限被挤出的短语必须留痕（不能静默丢词）", () => {
  assert.ok(HL_LONG.highlights.length <= LIMITS.itemHighlights, `实际 ${HL_LONG.highlights.length}`);
  assert.ok(HL_LONG.highlightsDropped.length >= 1, "没有记录任何被挤出的短语");
  for (const d of HL_LONG.highlightsDropped) {
    assert.ok(d.text && d.text.trim(), "被挤出项缺少文本");
    assert.ok(d.why && d.why.trim(), "被挤出项缺少原因");
  }
});

t("被挤出短语的长度合计与 highlightsDroppedChars 一致", () => {
  const sum = HL_LONG.highlightsDropped.reduce((n, d) => n + d.text.length, 0);
  assert.equal(HL_LONG.highlightsDroppedChars, sum);
});

t("导出 JSON 带上被挤出的短语（否则字段看起来是填满的）", () => {
  const f = exportListingFields({
    title: "T", highlights: "a, b", bullets: [], searchTerms: "", description: "",
    highlightsDropped: [{ text: "c", why: "超限" }],
  });
  assert.equal(f.highlightsDropped.length, 1);
  assert.ok(f.notes.some((n) => n.includes("被挤出")), f.notes.join(" | "));
});

t("media 类目：158 字符标题 lint 通过、导出也不得报超限", () => {
  const listing = {
    title: "A".repeat(158), highlights: "", bullets: ["a", "b", "c"],
    searchTerms: "", description: "",
  };
  const f = exportListingFields(listing, { isMedia: true });
  const item = f.fields.find((x) => x.key === "item_name");
  assert.equal(item.limit, LIMITS.titleMedia);
  assert.equal(item.over, false, `media 类目下仍报超限（limit=${item.limit}）`);
  assert.equal(f.budget.highlightsBlocked, false, "media 类目下不该说 Highlights 被标题卡住");
});

t("普通类目同一份数据必须超限（两条口径不能一起松）", () => {
  const listing = {
    title: "A".repeat(158), highlights: "", bullets: ["a", "b", "c"],
    searchTerms: "", description: "",
  };
  const f = exportListingFields(listing, { isMedia: false });
  const item = f.fields.find((x) => x.key === "item_name");
  assert.equal(item.limit, LIMITS.title);
  assert.equal(item.over, true);
  assert.equal(f.budget.highlightsBlocked, true);
});

section("边界加固：依赖与配置写入");

t("zip.js 不用命名导入 crc32（低版本 Node 会在模块链接期整站起不来）", () => {
  const src = ZIP_CODE;
  assert.ok(!/import\s*\{\s*crc32\s*\}\s*from\s*["']node:zlib["']/.test(src),
    "仍是 `import { crc32 } from \"node:zlib\"` —— Node < 20.15 会直接 SyntaxError");
  assert.ok(/import\s+zlib\s+from\s+["']node:zlib["']/.test(src), "应改为默认导入");
  assert.ok(/typeof fn !== "function"/.test(src), "缺少运行时探测（低版本要能给出人话）");
});

t("package.json 的 Node 下限是 20.15.0（zlib.crc32 的最低版本）", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.engines.node, ">=20.15.0");
});

t("服务端不再自己抄一份像素→比例表（P2-8 的根因）", () => {
  const src = SERVER_CODE;
  assert.ok(!/RATIO_OF_PIXELS/.test(src), "server.mjs 仍有 RATIO_OF_PIXELS");
  assert.ok(/PIXEL_TO_RATIO/.test(src), "server.mjs 没从 prompt-engine 取映射表");
});

t("服务端没有 child_process 死导入", () => {
  assert.ok(!/execFileSync/.test(SERVER_CODE), "execFileSync 仍被导入但从未使用");
  assert.ok(!/node:child_process/.test(SERVER_CODE), "仍引入了 node:child_process");
});

t("/api/config 具备三层防护：同源 + Content-Type + 合并写盘", () => {
  const src = SERVER_CODE;
  assert.ok(/sameOriginViolation/.test(src), "缺同源校验");
  assert.ok(/sec-fetch-site/i.test(src), "缺 Sec-Fetch-Site 判断");
  assert.ok(/requireJson:\s*true/.test(src), "缺 Content-Type 校验");
  assert.ok(/readEnvLocal/.test(src), "没有读取 .env.local 现状（会覆盖掉其他键）");
  assert.ok(!/Object\.entries\(runtimeConfig\)\.map/.test(src),
    "仍在用 runtimeConfig 重建整个文件 —— 提交一个键就会删掉其余键");
});

t("/api/config 空对象必须是 400（不能把文件重写成只剩注释）", () => {
  assert.ok(/请求体是空对象/.test(SERVER_CODE));
});

t("/api/config 支持空值删除（原来密钥永远删不掉）", () => {
  const src = SERVER_CODE;
  assert.ok(/patch\[envKey\] = ""/.test(src), "空值没有进入删除分支");
  assert.ok(/delete merged\[k\]/.test(src), "没有真正从合并结果里删除");
});

t("写盘后立刻失效配置缓存（否则会有「保存成功但没生效」的窗口）", () => {
  const iRename = SERVER_CODE.indexOf("fs.renameSync(tmp, ENV_LOCAL)");
  const iInvalid = SERVER_CODE.indexOf("invalidateEnvCache();", iRename);
  assert.ok(iRename > 0, "找不到原子替换那一行");
  assert.ok(iInvalid > iRename, "缓存失效没有发生在 rename 之后");
});

/* ═══════════════ 22. 快照对比（同一件商品前后两次采集）═══════════════
 * 这一节锁的是三件事：
 *   ① **只比抓到的内容** —— 不出现"可能 / 大概 / 说明对方在优化"这类推断；
 *   ② **不是同一件商品必须明说** —— 否则一张差异表会被读成"它改了"；
 *   ③ **数组字段要给出增删明细** —— 只回一句"五点变了"等于没比。
 */

const BASE_SNAP = {
  asin: "B0TEST0001",
  title: "Ceramic Mug 12oz",
  brand: "Acme",
  price: "$12.99",
  rating: "4.5",
  reviewCount: "128",
  bestSellersRank: "#1,024 in Kitchen",
  bullets: ["Holds 12oz", "Dishwasher safe", "Microwave safe"],
  specs: { Capacity: "12oz", Material: "Ceramic" },
  description: "A mug.",
};

t("快照对比：同 ASIN 只改标题 → 只报 1 个字段，且不编造原因", () => {
  const b = { ...BASE_SNAP, title: "Ceramic Mug 12oz - Matte Finish" };
  const d = diffSnapshots(BASE_SNAP, b);
  assert.equal(d.changedCount, 1, `应只命中标题，实际 ${d.changedCount} 项`);
  assert.equal(d.rows[0].key, "title");
  assert.equal(d.sameAsin, true);
  assert.equal(d.note, "", "同 ASIN 不该有警示语");
  assert.ok(!("reason" in d.rows[0]) && !("why" in d.rows[0]), "差异行里不该有原因字段");
});

t("快照对比：九字段全同 → 0 行变化，且 unchanged 必须列满 9 项", () => {
  const d = diffSnapshots({ ...BASE_SNAP }, { ...BASE_SNAP });
  assert.equal(d.changedCount, 0);
  assert.equal(d.unchanged.length, 9, `unchanged 应 9 项，实际 ${d.unchanged.join("/")}`);
});

t("快照对比：ASIN 不同 → 必须明说「不是同一件商品」，不许静默给差异表", () => {
  const d = diffSnapshots({ ...BASE_SNAP, price: "$9.99" }, { ...BASE_SNAP, asin: "B0OTHER002" });
  assert.equal(d.sameAsin, false);
  assert.ok(/不是同一件商品/.test(d.note), `note 措辞不够明确：${d.note}`);
  assert.ok(d.note.includes("B0TEST0001") && d.note.includes("B0OTHER002"), "note 要带出两个 ASIN");
});

t("快照对比：缺 ASIN → 必须说「无法确认是同一件」，不能当作同款前后对比", () => {
  const d = diffSnapshots({ ...BASE_SNAP, asin: "" }, { ...BASE_SNAP, asin: "" });
  assert.equal(d.sameAsin, false);
  assert.ok(/无法确认/.test(d.note), `note 没提无法确认：${d.note}`);
});

t("快照对比：五点增删 → 必须给出 added / removed 明细（不是只回一句「变了」）", () => {
  const b = { ...BASE_SNAP, bullets: ["Holds 12oz", "Microwave safe", "Leak-proof lid"] };
  const d = diffSnapshots(BASE_SNAP, b);
  const row = d.rows.find((r) => r.key === "bullets");
  assert.ok(row, "五点变化没被报出来");
  assert.deepEqual(row.added, ["Leak-proof lid"], "新增项不对");
  assert.deepEqual(row.removed, ["Dishwasher safe"], "删掉的项不对");
});

t("快照对比：五点只是换了顺序也算变（前台展示顺序变了），但 added/removed 必须为空", () => {
  const b = { ...BASE_SNAP, bullets: ["Microwave safe", "Holds 12oz", "Dishwasher safe"] };
  const d = diffSnapshots(BASE_SNAP, b);
  const row = d.rows.find((r) => r.key === "bullets");
  assert.ok(row, "顺序变化没被报出来");
  assert.deepEqual(row.added, []);
  assert.deepEqual(row.removed, []);
});

t("快照对比：规格（对象）改了值必须被发现（原来的 String(对象) 让它永远相等）", () => {
  const b = { ...BASE_SNAP, specs: { Capacity: "12oz", Material: "Bamboo" } };
  const d = diffSnapshots(BASE_SNAP, b);
  const row = d.rows.find((r) => r.key === "specs");
  assert.ok(row, "规格变化没被报出来 —— 归一化可能又退回了 String(对象)");
  assert.ok(row.added.includes("Material: Bamboo"), `新增项不对：${JSON.stringify(row.added)}`);
  assert.ok(row.removed.includes("Material: Ceramic"), `删掉的项不对：${JSON.stringify(row.removed)}`);
  // 键序不同但内容相同 → 不许报成变化（规格是 map，键序无语义）
  assert.equal(diffSnapshots(BASE_SNAP, { ...BASE_SNAP, specs: { Material: "Ceramic", Capacity: "12oz" } }).changedCount, 0);
});

t("快照对比：null / 缺失 / 空白等价（不制造假差异）", () => {
  const a = { ...BASE_SNAP, description: "A mug." };
  const b = { ...BASE_SNAP, description: "  A mug.  " };
  assert.equal(diffSnapshots(a, b).changedCount, 0, "首尾空格不该算变化");
  const c = { ...BASE_SNAP };
  delete c.description;
  assert.equal(diffSnapshots(c, { ...BASE_SNAP, description: "" }).changedCount, 0, "缺失与空串不该算变化");
});

t("快照对比：源码里不许出现推断原因的措辞（只比事实，不猜动机）", () => {
  const src = codeOf(readFileSync(path.join(ROOT, "assets/amazon.js"), "utf8"));
  const i = src.indexOf("export function diffSnapshots");
  assert.ok(i > 0, "找不到 diffSnapshots");
  const body = src.slice(i, src.indexOf("\nexport function", i + 10));
  for (const w of ["可能是因为", "说明对方", "看来对方", "应该是想", "推测"]) {
    assert.ok(!body.includes(w), `差异逻辑里出现了解释性措辞：「${w}」`);
  }
});

t("快照对比 UI：勾选上限 2 条，且按采集时间排（不按勾选顺序）", () => {
  assert.ok(/diffSel: \[\],/.test(APP), "S 里没有初始化 diffSel");
  assert.ok(/slice\(-2\)/.test(APP), "勾选没有限制在 2 条以内");
  assert.ok(/got\.sort\(\(x, y\) => \(x\.createdAt \|\| 0\) - \(y\.createdAt \|\| 0\)\)/.test(APP),
    "没有按 createdAt 排序 —— 勾选顺序反了会把「改前/改后」读反");
});

t("快照对比 UI：必须写清比较范围（9 个文本字段），主图 / A+ 不在范围内", () => {
  assert.ok(/只比这 9 个文本字段/.test(APP), "界面没写比较范围");
  assert.ok(/主图、A\+ 内容、变体结构不在比较范围内/.test(APP), "没交代不覆盖什么");
  assert.ok(/搜索页对搜索页/.test(HTML) || /勾选两条/.test(HTML), "index.html 缺使用提示");
});

/* ─────────── 批四 P2#9 / 批三接口：源码级锁死 ─────────── */

// P2#9 是方案里唯一的「零改动」项：代码天然免疫 cwd，但**免疫会被后来的人写回去**。
// 留一条断言把它钉住，比在文档里写「请勿使用 process.cwd()」有用得多。
t("P2#9：assets/ 与 mcp/ 的业务代码里 0 处 process.cwd()（防将来有人写回去）", () => {
  const hits = [];
  for (const d of ["assets", "mcp"]) {
    for (const f of readdirSync(path.join(ROOT, d))) {
      if (!/\.(js|mjs)$/.test(f)) continue;
      if (/process\.cwd\s*\(/.test(readFileSync(path.join(ROOT, d, f), "utf8"))) hits.push(`${d}/${f}`);
    }
  }
  assert.deepEqual(hits, [], `出现 process.cwd()：${hits.join(", ")}`);
});

t("批三：服务端登记了词根覆盖层与 CSV 导出两条新路由", () => {
  const src = readFileSync(path.join(ROOT, "server.mjs"), "utf8");
  assert.ok(/\/api\/keyword-roots/.test(src), "server.mjs 没有 /api/keyword-roots");
  assert.ok(/\/api\/export/.test(src), "server.mjs 没有 /api/export");
});
t("🔴 词根覆盖层的 POST 必须进 WRITE_ROUTES（只读演示版才会 403）", () => {
  const src = readFileSync(path.join(ROOT, "server.mjs"), "utf8");
  const block = src.slice(src.indexOf("const WRITE_ROUTES"), src.indexOf("const isWriteRoute"));
  assert.ok(/\["POST", "\/api\/keyword-roots"\]/.test(block), "WRITE_ROUTES 里没有这条");
});

/* ═════════ 批五：判断层改造（S-6 / S-2 / P2#10）正式断言 ═════════
 * 🔴 存在理由：这批改动原先只靠临时脚本验过；不进主回归套件，将来改 assets/listing.js
 *    没人拦得住。断言只增不减，且逐条可定位（尤其 28 条 fix 不许用一条 every() 糊过去）。
 */
section("批五：判断层改造（S-6 逐条 fix / S-2 词库来源 / P2#10 CSV）正式断言");

/* ── ① S-6 / P2#11：逐条「为什么 + 怎么改」 ── */

// 🔴 把 28 个 id 写死在这里：id 集合/顺序一变，断言立刻失败（不是「能跑就行」）。
const J26_RULE_IDS = [
  "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "C9",
  "P10", "P11", "P12", "P13", "P14", "P15",
  "C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C10", "C11", "C12", "C13", "C14",
];
const J26_EXT_KEYS = ["gapsDetail", "coverageUser", "coverageVault", "vault"];
const J26_BASE_KEYS = [
  "rows", "total", "covered", "coveragePct", "gaps", "minedGaps", "weak", "unused",
  "competitorProvided", "competitorNames", "minedCount", "note", "source",
];

t("S-6：RULES 仍为 28 条，且 id 集合与顺序逐项不变", () => {
  assert.equal(RULES.length, 28, `RULES 变成 ${RULES.length} 条`);
  assert.deepEqual(RULES.map((r) => r.id), J26_RULE_IDS, "规则 id 集合/顺序被改了");
});

t("S-6：28 条规则的 sourceTier 仍全部 undefined（不许回填成两套口径）", () => {
  const backfilled = RULES.filter((r) => r.sourceTier !== undefined).map((r) => r.id);
  assert.deepEqual(backfilled, [], `这些规则被回填了 sourceTier：${backfilled.join(",")}`);
});

// 🔴 逐条断言、不用一条 every() 糊过去：单条缺 fix 要能从测试名直接定位到 id。
for (const id of J26_RULE_IDS) {
  t(`S-6：规则 ${id} 带非空 fix（逐条定位，缺哪条一眼可见）`, () => {
    const r = RULES.find((x) => x.id === id);
    assert.ok(r, `规则 ${id} 不存在`);
    assert.ok(typeof r.fix === "string" && r.fix.trim().length > 0, `${id} 缺 fix 或 fix 为空`);
    // fix 必须是一句可执行的话，不是「请修改 / 请优化」这类空话
    assert.ok(!/^(请修改|请优化|注意优化|请检查)/.test(r.fix.trim()), `${id} 的 fix 是空话：${r.fix}`);
  });
}

const J26_BAD = {
  title: "FREE SHIPPING Hot Sale Best Seller Water Bottle!!! buy now 100% GUARANTEE SUPER CHEAP",
  bullets: ["water bottle is good", "this is nice", "A: x", "B: y", "C: z"],
  searchTerms: "a".repeat(300),
};

t("S-6：lintListing 的每条命中项都同时带非空 why 与 fix，且取自该规则", () => {
  const res = lintListing(J26_BAD, { brand: "Acme", primaryKeyword: "water bottle" });
  const hits = res.results.filter((x) => x.status === "命中");
  assert.ok(hits.length > 0, "样例没有任何命中项，这条断言会空过（等于没测）");
  for (const h of hits) {
    const rule = RULES.find((r) => r.id === h.id);
    assert.ok(rule, `命中项 ${h.id} 在 RULES 里找不到`);
    assert.ok(typeof h.why === "string" && h.why.trim(), `${h.id} 命中项缺 why 或 why 为空`);
    assert.ok(typeof h.fix === "string" && h.fix.trim(), `${h.id} 命中项缺 fix 或 fix 为空`);
    assert.equal(h.why, rule.why, `${h.id} 的 why 不是来自该规则`);
    assert.equal(h.fix, rule.fix, `${h.id} 的 fix 不是来自该规则`);
  }
});

t("S-6：lintListing 全部 28 条结果（含通过/跳过）都带 why + fix，且 results 长度不变", () => {
  const res = lintListing(J26_BAD, { brand: "Acme", primaryKeyword: "water bottle" });
  assert.equal(res.results.length, 28, "results 长度变了（只能加字段，不许增删元素）");
  for (const r of res.results) {
    assert.ok(typeof r.why === "string" && r.why.trim(), `${r.id} 结果缺 why`);
    assert.ok(typeof r.fix === "string" && r.fix.trim(), `${r.id} 结果缺 fix`);
  }
});

/* ── ② S-2 向后兼容：默认输出零新增字段 ── */
t("S-2：不传 targetsFrom / targets 时，返回键集合与扩展字段零交集（多形态样本）", () => {
  const samples = [
    [{}, {}],
    [{ title: "Cat Bed" }, { keywords: "cat bed" }],
    [{ title: "Acme Dog Harness" }, { keywords: "anti-pull, small dogs", competitorText: "Anti-pull harness for small dogs." }],
    [{ title: "x" }, { keywords: "mug, cup", top: 10, includeMined: false }],
    [{ title: "x" }, { keywords: ["a", "bb"], competitors: [{ name: "A", text: "dog harness" }] }],
  ];
  for (const [listing, opts] of samples) {
    const r = analyzeCoverage(listing, opts);
    const overlap = Object.keys(r).filter((k) => J26_EXT_KEYS.includes(k));
    assert.deepEqual(overlap, [], `默认模式出现扩展字段：${overlap.join(",")}`);
    // 连 undefined 值的隐藏键都不许有（JSON 会藏掉，但 deepEqual 看得见）
    assert.ok(Object.values(r).every((v) => v !== undefined), "默认模式存在 undefined 值字段");
  }
});

t("S-2：默认模式键集合恰为原来的 13 个键（零新增、零删减）", () => {
  const r = analyzeCoverage({ title: "Cat Bed" }, { keywords: "cat bed" });
  assert.deepEqual(Object.keys(r).sort(), [...J26_BASE_KEYS].sort());
});

t("S-2：gaps 仍是字符串数组（默认模式；前端与 MCP 都依赖它）", () => {
  for (const [listing, opts] of [
    [{}, {}],
    [{ title: "Acme Dog Harness" }, { keywords: "anti-pull, small dogs", competitorText: "Anti-pull harness for small dogs." }],
    [{ title: "x" }, { keywords: "mug, cup" }],
  ]) {
    const gaps = analyzeCoverage(listing, opts).gaps;
    assert.ok(Array.isArray(gaps), "gaps 不是数组");
    assert.ok(gaps.every((x) => typeof x === "string"), `gaps 混入了非字符串：${JSON.stringify(gaps)}`);
  }
});

/* ── ③ S-2 扩展正确性 ── */
const J26_LISTING = { title: "Acme Insulated Bottle 24oz", bullets: ["A: keeps cold"], searchTerms: "steel", description: "" };
const J26_TARGETS = [
  { term: "insulated", from: "user", rootCount: 5, groups: ["bottle"] },
  { term: "vacuum", from: "vault", rootCount: 9, groups: ["kitchen", "top20"] },
  { term: "steel", from: "vault", rootCount: 2, groups: [] },
  { term: "flask", from: "vault", rootCount: 1, groups: [] },
];
const J26_ext = () => analyzeCoverage(J26_LISTING, { keywords: "insulated, steel", targetsFrom: "vault", targets: J26_TARGETS });

t("S-2：coverageUser / coverageVault 都是 0..100 的有限数", () => {
  const r = J26_ext();
  for (const k of ["coverageUser", "coverageVault"]) {
    assert.equal(typeof r[k], "number", `${k} 不是 number`);
    assert.ok(Number.isFinite(r[k]) && r[k] >= 0 && r[k] <= 100, `${k} 越界：${r[k]}`);
  }
});

t("S-2：两个覆盖率各自只按本组分母算，不混成一个数", () => {
  const r = J26_ext();
  // user 组 1 个词全覆盖 → 100；vault 组 3 个词覆盖 1 个 → 33。
  assert.equal(r.coverageUser, 100, "user 覆盖率没按 user 分母算");
  assert.equal(r.coverageVault, 33, "vault 覆盖率没按 vault 分母算");
  assert.notEqual(r.coverageUser, r.coverageVault, "两个覆盖率被混成同一个数");
  const blended = Math.round((2 / 4) * 100); // 若混算 4 个词覆盖 2 个 → 50
  assert.notEqual(r.coverageUser + r.coverageVault, blended, "两数之和等于混合覆盖率 = 混算嫌疑");
});

t("S-2：gapsDetail 覆盖全部 targets，每项带 from / rootCount / groups / missingIn", () => {
  const r = J26_ext();
  assert.ok(Array.isArray(r.gapsDetail), "gapsDetail 不是数组");
  assert.equal(r.gapsDetail.length, J26_TARGETS.length, "gapsDetail 没覆盖全部 targets");
  const terms = new Set(J26_TARGETS.map((x) => x.term));
  for (const d of r.gapsDetail) {
    assert.deepEqual(Object.keys(d).sort(), ["from", "groups", "missingIn", "rootCount", "term"]);
    assert.ok(terms.has(d.term), `gapsDetail 出现非 targets 的词：${d.term}`);
    assert.ok(d.from === "user" || d.from === "vault", `from 非法：${d.from}`);
    assert.equal(typeof d.rootCount, "number", "rootCount 不是 number");
    assert.ok(Array.isArray(d.groups), "groups 不是数组");
    assert.ok(Array.isArray(d.missingIn), "missingIn 不是数组");
  }
  assert.ok(r.gapsDetail.some((d) => d.from === "user") && r.gapsDetail.some((d) => d.from === "vault"), "来源标记没区分 user/vault");
});

t("S-2：gapsDetail 按 rootCount × missingIn.length 降序", () => {
  const weights = J26_ext().gapsDetail.map((d) => d.rootCount * d.missingIn.length);
  assert.deepEqual(weights, [...weights].sort((a, b) => b - a), `排序不是按 rootCount × 未覆盖 降序：${weights}`);
});

t("S-2：扩展模式下 gaps 仍是字符串数组（只增新字段，不改旧字段）", () => {
  const gaps = J26_ext().gaps;
  assert.ok(Array.isArray(gaps) && gaps.every((x) => typeof x === "string"), "gaps 在扩展模式下变形了");
});

t("S-2：只传 targetsFrom:'vault'（有词）→ 派生词全标 vault、vault.ok 如实为 true", () => {
  const r = analyzeCoverage(J26_LISTING, { keywords: "insulated, vacuum", targetsFrom: "vault" });
  assert.ok(Array.isArray(r.gapsDetail) && r.gapsDetail.length === 2, "派生词没进 gapsDetail");
  assert.ok(r.gapsDetail.every((d) => d.from === "vault"), "派生词来源没按 targetsFrom 标记");
  assert.equal(r.coverageUser, 0, "没传 user 词时 coverageUser 应如实为 0，不许编数");
  assert.equal(typeof r.coverageVault, "number");
  assert.deepEqual(r.vault, { ok: true, reason: "ok" });
});

t("S-2：只传 targetsFrom:'vault' 但无词 → vault.ok:false / reason:'missing'（不编 ok:true）", () => {
  const r = analyzeCoverage({ title: "x" }, { keywords: "", targetsFrom: "vault" });
  assert.deepEqual(r.vault, { ok: false, reason: "missing" }, "没有 vault 词却报了 ok:true = 编数");
  assert.deepEqual(r.gapsDetail, [], "无词时 gapsDetail 应为空");
});

t("S-2：显式 targets 全是 user 却声明 from vault → vault 如实反映拿不到 vault 词", () => {
  const r = analyzeCoverage(J26_LISTING, {
    keywords: "x", targetsFrom: "vault",
    targets: [{ term: "insulated", from: "user", rootCount: 1, groups: [] }],
  });
  assert.deepEqual(r.vault, { ok: false, reason: "missing" });
});

/* ── ④ P2#10 CSV ── */
const J26_CSV_COLS = ["k1", "k2", "k3", "k4", "k5", "k6"].map((k) => ({ key: k, label: k }));
const J26_CSV_ROWS = [
  { k1: "a,b", k2: 'he said "hi"', k3: "line1\nline2", k4: "中文,测试", k5: "crlf\r\ninside", k6: "" },
  { k1: 'only "quotes"', k2: "尾,列", k3: "第二行\n还有第三行", k4: "纯中文", k5: "x", k6: "z" },
];
const J26_csv = () => toCsv(J26_CSV_ROWS, J26_CSV_COLS);

t("P2#10：toCsv / parseCsv 导出名固定，且首三字节为 UTF-8 BOM（EF BB BF）", () => {
  assert.equal(typeof toCsv, "function", "toCsv 导出名不对");
  assert.equal(typeof parseCsv, "function", "parseCsv 导出名不对");
  const buf = Buffer.from(J26_csv(), "utf8");
  assert.equal(buf[0], 0xEF);
  assert.equal(buf[1], 0xBB);
  assert.equal(buf[2], 0xBF);
});

t("P2#10：含逗号/双引号/换行/CRLF/中文/空字段往返相等", () => {
  assert.deepEqual(parseCsv(J26_csv()), J26_CSV_ROWS);
});

t("P2#10：含逗号/引号/换行的字段按 RFC 4180 正确转义（文本级）", () => {
  const csv = J26_csv();
  assert.ok(csv.includes('"a,b"'), "含逗号字段没加双引号");
  assert.ok(csv.includes('"he said ""hi"""'), "双引号没转义成两个（\"\"）");
  assert.ok(csv.includes('"line1\nline2"'), "含换行字段没加双引号");
  assert.ok(csv.includes("\r\n"), "行分隔不是 CRLF");
  assert.ok(!csv.endsWith("\r\n"), "不该写尾部 CRLF（会多出空记录）");
});

t("P2#10：空表只出表头（parseCsv 返回 []，无多余数据行）", () => {
  const csv = toCsv([], J26_CSV_COLS);
  assert.equal(csv, "\uFEFF" + J26_CSV_COLS.map((c) => c.label).join(","));
  assert.deepEqual(parseCsv(csv), []);
});

t("P2#10：parseCsv 能剥掉 BOM（带/不带 BOM 结果一致）", () => {
  const csv = J26_csv();
  assert.equal(csv.charCodeAt(0), 0xFEFF, "toCsv 没加 BOM，这条断言会空过");
  assert.deepEqual(parseCsv(csv), J26_CSV_ROWS, "parseCsv 没剥掉 BOM");
  assert.deepEqual(parseCsv(csv.slice(1)), J26_CSV_ROWS, "不带 BOM 的文本也应能解析");
});

t("P2#10：label≠key 时传 cols 还原原键，表头含逗号/引号也被正确转义", () => {
  const cols2 = [
    { key: "k1", label: "列,一" }, { key: "k2", label: '列"二' }, { key: "k3", label: "备注" },
    { key: "k4", label: "中文" }, { key: "k5", label: "CRLF" }, { key: "k6", label: "空列" },
  ];
  assert.deepEqual(parseCsv(toCsv(J26_CSV_ROWS, cols2), cols2), J26_CSV_ROWS);
});

t("S-6：lint 结果在界面上同时渲染 why 与 fix（不能只有「为什么」、没有「怎么改」）", () => {
  const i = APP.indexOf("function runLint()");
  assert.ok(i >= 0, "assets/app.js 里找不到 runLint()");
  const body = APP.slice(i, i + 4000);
  assert.ok(/x\.why/.test(body), "runLint 没渲染 x.why");
  assert.ok(/x\.fix/.test(body), "runLint 没渲染 x.fix —— 底层规则与 MCP 都带「怎么改」，界面不显示等于白做");
});

/* ─────────────── 批六：2026-11-08 全面审查的修复（P0 数据丢失 / 口径自相矛盾 / 空态）─────────────── */

section("批六：草稿不丢、覆盖要问、口径只一个");

t("P0：表单草稿自动存本机，打开页面时还原（修「刷新即丢」）", () => {
  assert.match(APP, /const FORM_KEY = "clx_listing_form_v1"/, "没有草稿 keys");
  assert.match(APP, /localStorage\.setItem\(FORM_KEY/, "saveFormNow 没写 localStorage");
  assert.match(APP, /function restoreForm\(\)/, "没有 restoreForm");
  assert.match(APP, /function bindFormPersistence\(\)[\s\S]{0,600}restoreForm\(\)/, "bindFormPersistence 没调用 restoreForm");
  // 必须在 bindListing 里、且在其余绑定之前 —— 先还原再渲染，否则计数与结果都是旧的。
  const i = APP.indexOf("function bindListing()");
  const head = APP.slice(i, i + 400);
  assert.match(head, /bindFormPersistence\(\)/, "boot 链路里没接上草稿还原");
  assert.ok(head.indexOf("bindFormPersistence()") < head.indexOf('$("#btnDraft")'), "还原必须排在按钮绑定之前");
});

t("P0：清空草稿是两步确认，不用 window.confirm", () => {
  const i = APP.indexOf("function clearForm(");
  const body = APP.slice(i, i + 1200);
  assert.match(body, /dataset\.armed/, "没有两步确认的 armed 标记");
  assert.ok(!/window\.confirm|(?<![.\w])confirm\(/.test(body), "清空用了原生 confirm（会阻塞主线程）");
});

t("视图与 URL 同步：hash 可分享、F5 不跳回创作台、后退键能走", () => {
  assert.match(APP, /addEventListener\("hashchange"/, "没监听 hashchange");
  assert.match(APP, /hashSelfWrite = true;\s*\n\s*location\.hash = name/, "goView 没把视图写进 hash");
  assert.match(APP, /const VIEW_NAMES = new Set\(\$\$\("\.view"\)/, "视图名必须从 DOM 取，不许另抄一份清单");
  assert.match(APP, /VIEW_NAMES\.has\(wantedView\)\) goView\(wantedView, \{ fromHash: true \}\)/, "boot 没按 hash 落位");
});

t("P0：生成草稿前先比对冲突，不许静默覆盖手改内容", () => {
  assert.match(APP, /function draftConflicts\(/, "没有冲突检测");
  assert.match(APP, /function applyDraft\(d, mode = "fill"\)/, "默认必须是「只补空白」，不能默认覆盖");
  assert.match(APP, /id="btnDraftFill"/, "缺「只补空白」选项");
  assert.match(APP, /id="btnDraftOver"/, "缺「全部覆盖」选项");
  assert.match(APP, /id="btnDraftCancel"/, "缺「取消」选项");
  assert.match(APP, /if \(conflicts\.length && !opts\.mode\)/, "有冲突却没走确认分支");
  // 「生成并质检」必须等写入完成后再跑质检，否则检的是生成前的内容
  assert.match(APP, /#btnLintDraft"\)\.addEventListener\("click", \(\) => generateDraft\(\{ after: runLint \}\)\)/, "生成并质检的顺序不对");
});

t("P0：覆盖后可撤销（写之前留字段快照）", () => {
  // snapshotForm 必须是**真函数**：这一条是补的 —— 曾用注释写了它却没定义，
  // 源码级断言全绿、真浏览器一点就 ReferenceError。静态断言管不了"函数存不存在"以外的事。
  assert.match(APP, /function snapshotForm\(\)/, "没有 snapshotForm（撤销与自动保存共用的字段快照）");
  assert.match(APP, /const before = snapshotForm\(\);/, "覆盖前没留快照");
  assert.match(APP, /S\.draftUndo = \{ fields: before, at: Date\.now\(\) \}/, "没记录撤销点");
  assert.match(APP, /function undoDraft\(\)/, "没有撤销函数");
  assert.match(APP, /id="btnDraftUndo"/, "界面上没有撤销入口");
});

t("media 口径下草稿摘要不再硬写 75（同屏两个上限=两个答案）", () => {
  const i = APP.indexOf("function renderDraftPanel(");
  const body = APP.slice(i, i + 900);
  assert.match(body, /L\.titleLimit\(/, "摘要没用 titleLimit(ctx)");
  assert.ok(!/L\.LIMITS\.title\} 字符（建议/.test(body), "摘要里还硬写 LIMITS.title");
  assert.match(body, /media 类目/, "media 分支没有说明");
});

t("空输入不许宣称「结构合规」", () => {
  const src = readFileSync(path.join(ROOT, "assets/listing.js"), "utf8");
  assert.match(src, /title\s*\n\s*\? "这是规则式草稿：结构合规/, "草稿 notes 没按有无标题分岔");
  assert.match(src, /空骨架，不是合规草稿/, "缺空输入的诚实说法");
  assert.ok(!/规则式草稿已生成。结构合规，但\*\*/.test(APP), "面板文案里还留着 Markdown 星号");
});

t("Markdown 星号不许漏进 HTML（innerHTML 不解析 **）", () => {
  const src = readFileSync(path.join(ROOT, "assets/listing.js"), "utf8");
  assert.ok(!/才\*\*有资格\*\*/.test(src), "listing.js 的 note 里还有 **");
  assert.ok(!/\*\*参与搜索\*\*/.test(src), "listing.js 的 note 里还有 **");
  assert.ok(!/\*\*无法提交\*\*/.test(src), "listing.js 的 note 里还有 **");
});

t("图片库空态跨满整行（否则被 186px 栅格折成三行）", () => {
  const css = readFileSync(path.join(ROOT, "assets/app.css"), "utf8");
  assert.match(css, /\.lib-empty \{[^}]*grid-column: 1 \/ -1/, ".lib-empty 没有跨列");
});

/* ═══════════════ 批七：体验收口（原生弹窗 / 搜索 / 粘性 / 公式注入 / 探活）═══════════════ */

t("原生 alert / confirm 全项目清零，统一走 uiConfirm / uiToast", () => {
  const app = codeOf(APP);
  // \b 让 uiConfirm( 不被误判：uiConfirm 里 "C" 前面是 "i"，两者都是词字符，没有词边界
  assert.ok(!/\balert\s*\(/.test(app), "app.js 里还有原生 alert（阻塞主线程、样式不可控）");
  assert.ok(!/\bconfirm\s*\(/.test(app), "app.js 里还有原生 confirm");
  assert.match(APP, /function uiToast\(/, "缺统一的轻提示实现");
  assert.match(APP, /function uiConfirm\(/, "缺统一的确认框实现");
  // 两个原语必须是"只有一份"：别处再写一个弹窗就等于没收口
  assert.equal((APP.match(/function uiConfirm\(/g) || []).length, 1, "uiConfirm 被实现了不止一次");
  assert.equal((APP.match(/function uiToast\(/g) || []).length, 1, "uiToast 被实现了不止一次");
});

t("确认框正文用 textContent 写入（文件名等第三方文本不许拼进 innerHTML）", () => {
  assert.match(APP, /querySelector\("\.ui-dlg-body"\)\.textContent = body/, "正文不是用 textContent 写的");
  // 正文里的 \n\n 要真生效，靠 CSS 的 white-space: pre-line
  const css = readFileSync(path.join(ROOT, "assets/app.css"), "utf8");
  assert.match(css, /\.ui-dlg-body \{[^}]*white-space: pre-line/, "正文换行没有生效（缺 pre-line）");
  assert.match(css, /\.ui-dlg-back \{[^}]*position: fixed/, "确认框不是覆盖层");
});

t("图片库搜索：纯前端过滤，且栅格与「复制路径」共用同一个结果集", () => {
  assert.match(HTML, /id="libQ"/, "图片库没有搜索框");
  assert.match(APP, /function libVisible\(/, "没有统一的筛选函数（两处各写一遍会漂）");
  assert.match(APP, /\$\("#libQ"\)\.addEventListener\("input"/, "搜索框没绑 input 事件（要边打边筛）");
  // 只检查「过滤 + 画格子」这一段：删除按钮的处理函数当然要发请求，不算在内
  const i = APP.indexOf("function renderLibGrid(");
  const body = APP.slice(i, APP.indexOf("grid.innerHTML = list.map(", i));
  assert.ok(i > 0 && body.length > 200, "找不到 renderLibGrid");
  assert.ok(!/fetch\(/.test(body), "筛选渲染里还在发请求（应只过滤内存里的 lastLibrary）");
  assert.match(body, /libVisible\(\)/, "栅格没走统一的筛选函数");
});

t("词库表：表头吸顶 + 列名是「词根数」而不是「词根」", () => {
  const css = readFileSync(path.join(ROOT, "assets/app.css"), "utf8");
  assert.match(css, /\.wt thead th \{[^}]*position: sticky/, "表头没有吸顶");
  assert.match(css, /\.wt thead th \{[^}]*background: #fff/, "吸顶表头没有不透明背景（滚动时会透字）");
  assert.match(css, /\.wt thead th \{[^}]*box-shadow: inset/, "border-collapse 下边框会跟着滚走（应改用 inset shadow）");
  assert.match(APP, /<th class="n"[^>]*>词根数<\/th>/, "表头仍写「词根」，与单元格内容（数量）不符");
});

t("CSV 公式注入：只对落地文件开防护，且不把负数当公式", () => {
  const cols = [{ key: "a", label: "a" }];
  const plain = toCsv([{ a: "=1+1" }], cols);
  assert.ok(plain.includes("=1+1") && !plain.includes("'=1+1"), "默认编码被加了前缀（往返相等会坏）");
  const guarded = toCsv([{ a: "=1+1" }], cols, { guard: true });
  assert.ok(guarded.includes("'=1+1"), "guard:true 没有加防护前缀");
  // 负数是数据，不是公式：加了前缀 Excel 会当文本，排序/求和全废
  assert.equal(looksLikeFormula("-12.5"), false, "负小数被当成公式");
  assert.equal(looksLikeFormula("-1+1"), true, "负号开头的表达式应被拦截");
  assert.equal(looksLikeFormula("@SUM(A1)"), true, "@ 开头的公式没拦");
  assert.equal(looksLikeFormula("Phone Stand"), false, "普通词被误伤");
  // 普通数据开了 guard 也必须能原样往返
  const rows = [{ a: "a,b" }, { a: "中文" }, { a: "-12.5" }];
  assert.deepEqual(parseCsv(toCsv(rows, cols, { guard: true })), rows, "开了 guard 后普通数据往返不等");
  const srv = readFileSync(path.join(ROOT, "server.mjs"), "utf8");
  assert.match(srv, /toCsv\(rows, cols, \{ guard: true \}\)/, "/api/export 落地成文件时没开 guard");
});

t("test:all 必须跑满五套（原来漏了 mcp / keywords 共 384 条）", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const all = String(pkg.scripts?.["test:all"] || "");
  for (const f of ["selftest", "verify-server", "browser-selftest", "mcp-selftest", "keywords-selftest"]) {
    assert.ok(all.includes(`tools/${f}.mjs`), `test:all 漏了 ${f}`);
  }
});

t("fmtStamp：非法时间显示「—」，不许显示 1970", () => {
  const i = APP.indexOf("function fmtStamp(");
  const body = APP.slice(i, i + 700);
  assert.ok(i > 0, "找不到 fmtStamp");
  assert.ok(!/new Date\(t \|\| 0\)/.test(body), "还在用 `t || 0`（缺值会变成 1970-01-01）");
  assert.match(body, /Number\.isNaN\(d\.getTime\(\)\)/, "没有校验非法日期");
  assert.match(body, /< 1971/, "没有拦 1970 年（那是 0 被当 epoch 的症状）");
  assert.match(body, /return "—"/, "缺值时没有返回「—」");
});

t("设置页「测试连接」：只探 /models，不生成图片、不写盘", () => {
  assert.match(HTML, /id="btnTestImg"/, "图片 API 卡没有测试按钮");
  assert.match(HTML, /id="btnTestChat"/, "对话模型卡没有测试按钮");
  assert.match(APP, /function testConfigConn\(/, "没有共用的测试函数");
  assert.match(APP, /\/api\/config\/test/, "前端没调自检接口");
  // 三档结果：绿 / 黄（可达但没验证）/ 红，不许压成两档
  assert.match(APP, /j\.verified === false/, "没有处理「端点可达但密钥没被验证」这一档");

  const srv = readFileSync(path.join(ROOT, "server.mjs"), "utf8");
  assert.match(srv, /async function handleConfigTest\(/, "服务端没有自检处理函数");
  const i = srv.indexOf("async function handleConfigTest(");
  const body = srv.slice(i, srv.indexOf("/* ═══════════════════ 外部数据源"));
  assert.match(body, /\/models/, "探活没打 /models");
  assert.ok(!/images\/generations/.test(body), "自检里出现了生图调用（会花钱）");
  assert.ok(!/writeEnvLocal|runtimeConfig\[/.test(body), "自检写盘了（测试不该有副作用）");
  // 只读演示版必须挡住：这是"拿站长凭据出网"的入口
  assert.match(srv, /\["POST", "\/api\/config\/test"\]/, "自检入口没进只读白名单");
});

t("Listing 右栏在两栏形态下吸顶，窄屏不吸（否则内容被压死）", () => {
  const css = readFileSync(path.join(ROOT, "assets/app.css"), "utf8");
  assert.match(css, /@media \(min-width: 781px\) \{\s*\.workbench > \.wb-col:last-child \{\s*position: sticky/,
    "右栏 sticky 没写进两栏断点");
  assert.match(css, /\.workbench > \.wb-col:last-child \{[^}]*max-height: calc\(100vh/, "吸顶后没有限高，长内容会溢出屏幕");
});

/* ─────────────── 19. 健康分 / 评论分析 / 成图体检 / 趋势图（2026-11）───────────────
 * 这一批的共同点：**全是纯函数**。所以断言直接喂数据、直接看输出，
 * 不靠"读源码里有没有某个字符串"来假装验证过。
 */

/* ── 19a. 健康分 ── */

/** 造一份"全绿"的 lint 结果（形状与 lintListing 返回一致的最小集）。 */
const lintFixture = (hits = []) => ({
  results: [
    { id: "P1", level: "P", scope: "title", status: "通过", why: "w", fix: "f", source: "平台公开规则" },
    { id: "C1", level: "C", scope: "title", status: "通过", why: "w", fix: "f", source: "行业通行做法" },
    { id: "C3", level: "C", scope: "bullets", status: "通过", why: "w", fix: "f", source: "行业通行做法" },
    { id: "C10", level: "C", scope: "highlights", status: "通过", why: "w", fix: "f", source: "平台公开规则" },
    ...hits,
  ],
  summary: { hit: hits.length, hitP: hits.filter((h) => h.level === "P").length },
});
const rufusFixture = (hitCount = 0) => ({
  results: Array.from({ length: hitCount }, (_, i) => ({
    id: `R${i + 1}`, group: "g", level: "C", status: "命中",
    detail: "缺", why: "为什么缺不行", source: "官方问答页", sourceTier: "官方",
  })),
  summary: {
    byGroup: {
      g: { total: 3, hit: hitCount, pass: 3 - hitCount, partial: 0, skipped: 0, covered: 3 - hitCount, miss: hitCount },
    },
  },
});
const fieldsFixture = (over = false) => [
  { label: "标题", limit: 75, used: over ? 90 : 40, empty: false, over },
  { label: "亮点", limit: 125, used: 60, empty: false, over: false },
  { label: "五点", limit: 0, used: 300, empty: false, over: false },
];

t("健康分：8 个维度、权重合计 100（权重只有一处来源）", () => {
  assert.equal(SCORE_DIMS.length, 8, "维度数不是 8");
  assert.equal(SCORE_TOTAL_WEIGHT, 100, `权重合计 ${SCORE_TOTAL_WEIGHT}，归一化会失真`);
  assert.deepEqual(SCORE_DIMS.map((d) => d.id), [
    "compliance", "structure", "keywords", "title", "bullets", "highlights", "searchTerms", "budget",
  ], "维度顺序变了（界面按这个顺序画）");
});

t("健康分：全绿且维度齐 → 100 分 A 档", () => {
  const r = scoreListing({
    lint: lintFixture(), rufus: rufusFixture(), coverage: { total: 10, covered: 10, coveragePct: 100 },
    listing: { searchTerms: "mug cup" }, fields: fieldsFixture(),
  });
  assert.equal(r.score, 100, `全绿却不是 100：${r.score}；${r.skipped.map((s) => s.why).join(" / ")}`);
  assert.equal(r.grade, "A");
  assert.equal(r.skippedWeight, 0, "有维度没参与计分却说满分");
  assert.equal(r.top3.length, 0);
});

t("🔴 健康分：硬规则命中 → 封顶 55、D 档（不给「改改措辞还能 80」的错觉）", () => {
  const r = scoreListing({
    lint: lintFixture([{ id: "P1", level: "P", scope: "title", status: "命中", detail: "标题 90 字符超 75", why: "w", fix: "砍到 75 以内", source: "平台公开规则" }]),
    rufus: rufusFixture(), coverage: { total: 10, covered: 10, coveragePct: 100 },
    listing: { searchTerms: "x" }, fields: fieldsFixture(),
  });
  assert.equal(r.score, SCORE_CAP.score, `没有封顶：${r.score}`);
  assert.equal(r.grade, "D");
  assert.ok(r.cap && r.cap.applied !== false, "cap 信息没返回（界面无法解释为什么分这么低）");
  assert.equal(r.top3[0].ruleId, "P1", "Top3 第一条不是最严重的硬规则");
  assert.ok(r.top3[0].delta < 0 && r.top3[0].fix, "扣分项没有负数 delta 或没有改法");
});

t("🔴 健康分：缺覆盖度 → 该维度 skipped，不按 0 分算（归一化而不是瞎扣）", () => {
  const withCov = scoreListing({
    lint: lintFixture(), rufus: rufusFixture(), coverage: { total: 10, covered: 10, coveragePct: 100 },
    listing: { searchTerms: "x" }, fields: fieldsFixture(),
  });
  const noCov = scoreListing({
    lint: lintFixture(), rufus: rufusFixture(), coverage: null,
    listing: { searchTerms: "x" }, fields: fieldsFixture(),
  });
  assert.equal(noCov.skippedWeight, 14, "缺覆盖度时应该有 14 分权重标为未参与");
  assert.equal(noCov.score, withCov.score, "缺数据被当成 0 分扣掉了（应该按已计分权重归一）");
  const dim = noCov.dims.find((d) => d.id === "keywords");
  assert.equal(dim.status, "skipped");
  assert.equal(dim.earned, null, "跳过维度给了分数");
  assert.ok(/覆盖度/.test(noCov.skipped[0].why), "没说明为什么跳过");
});

t("🔴 健康分：没有 lint 结果 → score 为 null（不给假数字）", () => {
  const r = scoreListing({});
  assert.equal(r.score, null, "没有质检结果却算出了分");
  assert.equal(r.grade, null);
  assert.ok(r.dims.every((d) => d.status === "skipped"));
  assert.ok(r.note && r.disclaimer, "缺数据时也要有说明与免责声明");
});

t("健康分：扣分项必须带 ruleId / source / why / fix（否则界面只能显示一个数）", () => {
  const r = scoreListing({
    lint: lintFixture([
      { id: "C5", level: "C", scope: "title", status: "命中", detail: "mug×3", why: "堆砌观感", fix: "删重复", source: "项目自定义" },
      { id: "C7", level: "C", scope: "title", status: "命中", detail: "无数字", why: "缺规格", fix: "补容量", source: "行业通行做法" },
    ]),
    rufus: rufusFixture(1), coverage: null, listing: {}, fields: fieldsFixture(),
  });
  for (const d of r.deductions) {
    assert.ok(d.ruleId && d.source && d.why && typeof d.delta === "number" && d.delta < 0, `扣分项不完整：${JSON.stringify(d)}`);
  }
  assert.ok(r.deductions.length >= 3, "规则命中 + 信息架构未覆盖都应进扣分清单");
  assert.ok(r.top3.length <= 3, "Top3 超过 3 条");
  assert.deepEqual([...r.top3].map((x) => x.delta), [...r.top3].map((x) => x.delta).sort((a, b) => a - b), "Top3 没按扣分从大到小");
});

t("健康分：档位边界与封顶逻辑（90/75/60）", () => {
  assert.equal(gradeOf(90).grade, "A");
  assert.equal(gradeOf(89).grade, "B");
  assert.equal(gradeOf(75).grade, "B");
  assert.equal(gradeOf(74).grade, "C");
  assert.equal(gradeOf(60).grade, "C");
  assert.equal(gradeOf(59).grade, "D");
  assert.equal(gradeOf(null), null);
});

t("健康分接进了主流程：质检后自动重算，而不是单独一个按钮", () => {
  assert.match(APP, /function renderHealthScore\(/, "没有渲染函数");
  const i = APP.indexOf("function runLint(");
  const body = APP.slice(i, i + 2600);
  assert.match(body, /renderHealthScore\(/, "跑完质检没有重算健康分（分数会停在上一次）");
  assert.match(HTML, /id="scoreCard"/, "页面上没有健康分卡");
  assert.match(APP, /SCORE_DISCLAIMER/, "界面没有引用统一的免责声明（可能自己另写了一份）");
  // 分数不能是"存下来的"：它必须每次按当前文案重算
  assert.ok(!/localStorage[\s\S]{0,80}score/i.test(APP), "健康分被持久化了（会展示过期结论）");
});

/* ── 19b. 评论（VOC）分析 ── */

const REVIEW_FIXTURE = [
  { rating: 1, title: "Too noisy", body: "The motor is very loud. Does it come with a quieter mode?" },
  { rating: 1, title: "Broke", body: "It broke after two weeks. Cheaply made. Very noisy too." },
  { rating: 2, title: "Leaks", body: "It leaks in my bag." },
  { rating: 5, title: "Great for travel", body: "Lightweight and easy to clean. Fits perfectly." },
  { rating: 5, title: "Love it", body: "Easy to clean, quiet, and the color is beautiful. Great gift." },
  { rating: 4, title: "", body: "Works well but heavy." },
];

t("评论分析：痛点按低星提及聚类，最集中的排第一", () => {
  const r = analyzeReviews(REVIEW_FIXTURE);
  assert.equal(r.sampleSize, 6);
  assert.equal(r.painClusters[0].id, "noise", `第一名不是噪音：${r.painClusters.map((c) => c.label).join(",")}`);
  assert.equal(r.painClusters[0].painCount, 2);
  assert.ok(r.painClusters[0].painAvg < 3, "痛点没按低星评论的均分呈现");
  assert.ok(r.painClusters[0].quotes.length >= 1, "痛点没有原话（只有标签等于让用户自己去翻评论）");
  assert.ok(/噪音/.test(r.conclusion), "结论没点名最集中的抱怨");
});

t("评论分析：好评簇只来自 4–5 星（别把抱怨当卖点）", () => {
  const r = analyzeReviews(REVIEW_FIXTURE);
  const clean = r.praiseClusters.find((c) => c.id === "clean");
  assert.ok(clean && clean.praiseCount >= 2, "好评里的「好清洁」没被识别");
  const noise = r.praiseClusters.find((c) => c.id === "noise");
  assert.ok(!noise || noise.praiseCount === 1, "「噪音」出现在好评簇里了（那是 1 条 5 星说 quiet 造成的）");
});

t("🔴 评论分析：痛点里的「原话」必须来自低星（不能贴一句好评当抱怨）", () => {
  const r = analyzeReviews([
    { rating: 5, title: "Great", body: "Easy to clean and smells fresh." },
    { rating: 2, title: "Smell", body: "Hard to clean, and there is a chemical smell." },
    { rating: 1, title: "Stink", body: "The smell never goes away." },
  ]);
  const clean = r.painClusters.find((c) => c.id === "clean");
  assert.ok(clean, "没识别出清洁相关的抱怨");
  assert.ok(clean.quotes.length >= 1, "痛点没有原话");
  assert.ok(!clean.quotes.some((q) => /Easy to clean/i.test(q)), `痛点贴了好评原话：${clean.quotes.join(" | ")}`);
  assert.ok(clean.quotes.some((q) => /Hard to clean|smell/i.test(q)), `原话不是低星那条：${clean.quotes.join(" | ")}`);
  assert.ok(clean.praiseQuotes.some((q) => /Easy to clean/i.test(q)), "好评侧的原话没单独留一份");
});

t("🔴 评论分析：样本 <5 只出线索，不给比例结论", () => {
  const r = analyzeReviews(REVIEW_FIXTURE.slice(0, 3));
  assert.equal(r.reliability.level, "insufficient");
  assert.ok(/线索/.test(r.reliability.why), "没说明样本不足");
  assert.equal(analyzeReviews(REVIEW_FIXTURE).reliability.level, "signal");
});

t("评论分析：空样本不崩、明确说没法分析", () => {
  const r = analyzeReviews([]);
  assert.equal(r.sampleSize, 0);
  assert.equal(r.avgRating, null, "没有星级却给了均分");
  assert.ok(/无法分析/.test(r.conclusion));
  assert.ok(r.limits.length >= 2, "边界说明没了");
});

t("评论分析：三种载荷形态都能取到评论（书签 / 手贴 / 直接数组）", () => {
  assert.equal(reviewsFromPayload(REVIEW_FIXTURE).length, 6);
  assert.equal(reviewsFromPayload({ kind: "reviews", reviews: REVIEW_FIXTURE }).length, 6);
  assert.equal(reviewsFromPayload({ reviews: REVIEW_FIXTURE }).length, 6);
  assert.equal(reviewsFromPayload({ title: "x" }).length, 0, "商品载荷被误当成评论");
  // 归一化：星级能从 "5.0 out of 5 stars" 里取出来
  const one = reviewsFromPayload([{ rating: "5.0 out of 5 stars", title: "ok", body: "good" }])[0];
  assert.equal(one.rating, 5);
});

t("评论分析：评论里的疑问句被单独列出来（详情页该答的问题）", () => {
  const r = analyzeReviews(REVIEW_FIXTURE);
  assert.ok(r.questions.length >= 1, "没识别出疑问句");
  assert.ok(/quieter mode|Does it/i.test(r.questions[0].text), `疑问句取错了：${r.questions[0].text}`);
});

t("评论分析接进了采集页：有评论才显示，不新增第 9 个视图", () => {
  assert.match(HTML, /id="vocCard"/, "采集页没有 VOC 卡");
  assert.equal((HTML.match(/<section class="view[^"]*" data-view=/g) || []).length, 8, "视图数量变了（本项目固定 8 个）");
  const i = APP.indexOf("function renderProduct(");
  assert.match(APP.slice(i, i + 4200), /renderVoc\(p\)/, "解析商品后没有渲染评论分析");
  assert.match(APP, /if \(!list\.length\) \{[\s\S]{0,120}card\.hidden = true/, "没有评论时应整卡隐藏，而不是摆一个空壳");
});

/* ── 19c. 成图体检 ── */

/** 造一张合成图：paint(x,y) → [r,g,b,a]。 */
function makeImage(w, h, paint) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const [r, g, b, a] = paint(x, y);
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = a;
    }
  }
  return { width: w, height: h, data };
}

t("成图体检：白底 + 88% 商品 → 背景与占比都通过", () => {
  const m = 30; // 1000px 图留 30px 白边 ≈ 88% 占比（官方要求 ≥85%）
  const r = auditPixels(makeImage(1000, 1000, (x, y) => (
    x > m && x < 1000 - m && y > m && y < 1000 - m ? [200, 60, 40, 255] : [255, 255, 255, 255]
  )));
  assert.equal(r.checks.find((c) => c.id === "background").status, "pass");
  const fill = r.checks.find((c) => c.id === "fill");
  assert.equal(fill.status, "pass", `占比 ${fill.value} 应通过`);
  assert.equal(r.checks.find((c) => c.id === "size").status, "pass");
  assert.equal(r.ok, true);
});

t("成图体检：整张全白 → 商品占比 0%，必须报出来（不是「没查出问题」）", () => {
  const r = auditPixels(makeImage(1000, 1000, () => [255, 255, 255, 255]));
  assert.equal(r.checks.find((c) => c.id === "fill").status, "fail");
  assert.equal(r.ok, false, "全白图被判成合格了");
  assert.equal(r.fill, 0);
});

t("成图体检：800px / 420px 按官方口径分档（无缩放 / 传不上去）", () => {
  const at = (n) => auditPixels(makeImage(10, 10, () => [255, 255, 255, 255]), { sourceWidth: n, sourceHeight: n })
    .checks.find((c) => c.id === "size");
  assert.equal(at(1200).status, "pass");
  assert.equal(at(800).status, "warn");
  assert.equal(at(420).status, "fail");
});

t("成图体检：透明通道要给警告（转 JPG 会变黑底）", () => {
  const r = auditPixels(makeImage(50, 50, () => [200, 200, 200, 0]));
  assert.equal(r.checks.find((c) => c.id === "alpha").status, "warn");
});

t("成图体检：格式 / 体积判据（WebP 主图不接受、>10MB 直接拦）", () => {
  const webp = auditFileMeta({ name: "a.webp", type: "image/webp", size: 1024 });
  assert.equal(webp.find((c) => c.id === "mime").status, "fail");
  const big = auditFileMeta({ name: "a.jpg", type: "image/jpeg", size: IMAGE_RULES.maxBytes + 1 });
  assert.equal(big.find((c) => c.id === "bytes").status, "fail");
  const ok = auditFileMeta({ name: "a.jpg", type: "image/jpeg", size: 1024 * 1024 });
  assert.equal(ok.find((c) => c.id === "bytes").status, "pass");
});

t("成图体检：像素缺失不崩，给 error 而不是假装通过", () => {
  const r = auditPixels({ width: 0, height: 0, data: [] });
  assert.equal(r.ok, false);
  assert.ok(r.error, "没有 error 说明");
  const merged = combineAudit(r, []);
  assert.equal(merged.ok, false);
  assert.ok(merged.error, "合成后丢了 error");
});

t("🔴 成图体检：不内置 OCR、不判 Logo —— 文字只给线索", () => {
  const src = readFileSync(path.join(ROOT, "assets/image-audit.js"), "utf8");
  assert.ok(!/tesseract|ocr\.js|createWorker/i.test(src), "引入了 OCR 依赖（违背零依赖，且首次要下 6–8MB）");
  const m = makeImage(60, 60, (x) => (x % 2 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const text = auditPixels(m).checks.find((c) => c.id === "text");
  assert.equal(text.status, "hint", "文字必须是 hint（线索），不能当 fail");
  assert.ok(/线索/.test(text.measured), "没有说明这是线索不是结论");
});

t("成图体检接进了图片库：既有「体检」按钮，也支持上传任意图", () => {
  assert.match(HTML, /id="auditFile"/, "没有「体检一张本地图」入口");
  assert.match(APP, /data-audit=/, "图片库卡片没有体检按钮");
  assert.match(APP, /auditImageBlob/, "没有调用体检模块");
  // 体检必须只读：不许为了体检上传图片
  const i = APP.indexOf("async function runAudit(");
  const body = APP.slice(i, i + 700);
  assert.ok(!/\/api\/upload/.test(body), "体检路径里出现了上传（图片不该离开本机）");
});

/* ── 19d. 历史快照与趋势图 ── */

t("趋势图：1 个点画不出线，返回空 path + 说明（不假装有趋势）", () => {
  const sp = sparklinePath([{ v: 19.9 }]);
  assert.equal(sp.d, "");
  assert.equal(sp.count, 1);
  assert.ok(/2 次|2 个/.test(sp.note), "没说明为什么画不出来");
});

t("趋势图：2 个点成线，change / pct 算得对", () => {
  const sp = sparklinePath([{ v: 20 }, { v: 18 }]);
  assert.match(sp.d, /^M[\d.]+ [\d.]+L[\d.]+ [\d.]+$/, `path 形状不对：${sp.d}`);
  assert.equal(sp.change, -2);
  assert.equal(sp.pct, -10);
  assert.equal(seriesDigest([{ v: 20 }, { v: 18 }]).direction, "down");
});

t("🔴 趋势图：中间缺数据必须断开（不插值连成一条假曲线）", () => {
  const sp = sparklinePath([{ v: 10 }, { v: null }, { v: 14 }, { v: null }, { v: 9 }]);
  assert.equal((sp.d.match(/M/g) || []).length, 3, `断点数不对：${sp.d}`);
  assert.ok(sp.gaps >= 2, "没有记录断了几段");
  assert.ok(!/[CQTS]/.test(sp.d), "path 里出现了曲线/平滑指令（会插值）");
  assert.ok(/没有连线|缺失/.test(sp.note), "没说明断点");
});

t("趋势图：x 轴优先用时间，时间不全时退回序号轴并说明", () => {
  const timed = sparklinePath([{ t: "2026-11-01", v: 20 }, { t: "2026-11-08", v: 18 }]);
  assert.equal(timed.xMode, "time");
  const mixed = sparklinePath([{ t: "2026-11-01", v: 20 }, { v: 18 }]);
  assert.equal(mixed.xMode, "index");
  assert.ok(/顺序/.test(mixed.note), "退回序号轴时没告诉用户横轴含义");
});

t("快照：字段归一不补 0（缺就是 null）", () => {
  const n = normalizeSnapshot({ ts: "2026-11-08", price: "$19.99", rating: "", reviews: "1,234" });
  assert.equal(n.price, 19.99);
  assert.equal(n.rating, null, "空字符串被当成 0 了");
  assert.equal(n.reviewCount, 1234);
  assert.equal(n.bsr, null);
  assert.deepEqual(seriesOf([{ price: "$1" }, { price: "" }], "price").map((p) => p.v), [1, null]);
});

t("快照接口：写盘去重、ASIN 校验、只读演示版关闭", () => {
  const srv = readFileSync(path.join(ROOT, "server.mjs"), "utf8");
  assert.match(srv, /async function handleSnapshotPost\(/, "没有写入处理函数");
  assert.match(srv, /SNAP_DIR/, "快照没有落盘目录");
  assert.match(srv, /last\[k\] === row\[k\]|same = last/, "没有「值没变就不写」的判断（趋势图会出现无意义重复点）");
  assert.match(srv, /ASIN_OK/, "没有 ASIN 格式校验");
  assert.match(srv, /\["POST", "\/api\/snapshots"\]/, "快照写入没进只读白名单");
});

t("快照差额用文字不用箭头（11px 下 ↑ 会被读成数字 1）", () => {
  const i = APP.indexOf("function snapshotDigest(");
  // 用 codeOf 去掉注释：这段代码的注释里**故意**写着「别用 ↑ ↓」，直接查原文会自伤
  const body = codeOf(APP.slice(i, i + 1200));
  assert.ok(i > 0, "找不到 snapshotDigest");
  assert.ok(!/[↑↓]/.test(body), "差额还在用箭头（截图实测「↑64」被看成「164」）");
  assert.match(body, /升|降|持平/, "没有可读的升降文案");
});

/* ── 19e. 可选插件：抠图代理的安全边界 ── */

t("🔴 抠图代理只允许回环/私网目标（否则就是个 SSRF 跳板）", () => {
  const srv = readFileSync(path.join(ROOT, "server.mjs"), "utf8");
  const i = srv.indexOf("function isLocalTarget(");
  assert.ok(i > 0, "没有目标校验函数");
  const body = srv.slice(i, srv.indexOf("function findLocalImage("));
  for (const s of ["127.0.0.1", "localhost", "::1", "192\\.168\\.", "^10\\.", "172\\."]) {
    assert.ok(body.includes(s), `白名单缺少 ${s}`);
  }
  assert.match(srv, /code: "bad-target"/, "非法目标没有明确错误码");
  assert.match(srv, /code: "not-configured"/, "未配置时没有明确错误码");
  assert.match(srv, /\["POST", "\/api\/plugins\/rembg"\]/, "抠图没进只读白名单");
  // 不打包模型：仓库里不许出现 onnx / rembg 的二进制或依赖
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(pkg.dependencies || {}), [], "出现了 npm 依赖");
  assert.ok(!JSON.stringify(pkg).includes("rembg"), "package.json 里出现了 rembg 依赖");
});

/* ═══════════════ 20. P2 三项：A+ 骨架 / 批量质检 / 竞品 CSV 导入 ═══════════════
 * 这三块都是"看起来能出内容"的功能，最容易滑向"生成了但没用"。
 * 所以断言只盯四件事：**有没有从真实输入派生**、**算不出来时会不会编**、
 * **口径有没有写清**、**有没有偷偷引入第二份词表/第二套判定**。
 */

/* ── 20a. A+ 骨架 ── */

t("A+：三块模块固定（品牌故事 / 对比表 / 模块网格）", () => {
  assert.equal(APLUS_MODULES.length, 3);
  assert.deepEqual(APLUS_MODULES.map((m) => m.id), ["brandStory", "compare", "grid"]);
  const cmp = APLUS_MODULES.find((m) => m.id === "compare");
  assert.equal(cmp.cols, 6, "对比表列数上限应与后台一致（6 列）");
  assert.ok(cmp.rows.length >= 4, "对比维度太少，等于没给骨架");
});

t("A+：字数预算必须自称「建议值」，不许冒充平台硬限制", () => {
  assert.match(APLUS_NOTE, /建议值/, "预算口径没写清");
  assert.match(APLUS_NOTE, /不是平台硬限制|以模块编辑页/, "没交代硬限制以后台为准");
  // 每个 slot 都带 budget，否则界面上的「x/y」是假的
  for (const m of APLUS_MODULES) {
    for (const s of m.slots || []) assert.ok(s.budget > 0, `${m.id} 的 ${s.key} 没有字数预算`);
  }
  assert.ok(APLUS_BUDGET.headline > 0 && APLUS_BUDGET.body > 0);
});

t("A+：骨架从真实输入派生，不是通用模板", () => {
  const p = buildAplusPlan({
    brand: "MUTO", name: "Montessori Busy Board",
    features: ["8-in-1 sensory activities", "Food-grade felt, no sharp edges", "Portable 30x30cm"],
    material: "felt and beech wood", scene: "living room floor",
  });
  const story = p.modules.find((m) => m.id === "brandStory");
  assert.ok(story.slots[0].text.includes("MUTO"), "品牌名没进标题");
  assert.ok(story.slots[0].text.includes("8-in-1"), "核心利益没从卖点里取");
  for (const m of p.modules) {
    assert.ok(m.imagePrompt.includes("Montessori Busy Board"), `${m.id} 的提示词里没有产品名`);
    assert.match(m.imagePrompt, /no text|no watermark/, "提示词没写负面约束");
  }
  assert.equal(p.missing.length, 0, "输入齐全却报了缺失项");
});

t("A+：缺输入就留【待填】，不编品牌与卖点", () => {
  const p = buildAplusPlan({});
  assert.equal(p.missing.length, 3, `缺失项应有 3 条，实际 ${p.missing.length}`);
  const story = p.modules.find((m) => m.id === "brandStory");
  assert.match(story.slots[0].text, /待填/, "没有品牌名却编了一个标题");
  assert.match(p.modules.find((m) => m.id === "grid").cards[0].title, /待填/);
});

t("A+：自检复用 listing.js 的词表，不另造第二份", () => {
  const src = readFileSync(path.join(ROOT, "assets/aplus.js"), "utf8");
  assert.match(src, /from "\.\/listing\.js"/, "没复用 listing.js");
  assert.ok(!/const PROMO_WORDS\s*=/.test(src), "aplus.js 里又定义了一份促销词表");
  assert.ok(!/const CLAIM_WORDS\s*=/.test(src), "aplus.js 里又定义了一份声明词表");
  // 行为上也必须命中（词表复用不能只是 import 了没用）
  const ids = lintAplusText("Free shipping and 100% safe, better than others, #1 best seller").map((c) => c.id);
  for (const id of ["promo", "claim", "rival", "rank"]) assert.ok(ids.includes(id), `没命中 ${id}`);
});

t("A+：词边界匹配，别把 wholesale 判成 sale", () => {
  const ids = lintAplusText("Wholesale orders welcome, bestow gifts").map((c) => c.id);
  assert.ok(!ids.includes("promo"), "误报：wholesale / bestow 被当成促销词");
});

t("A+：可导出为纯文本，三块都在且不留 undefined", () => {
  const p = buildAplusPlan({ brand: "MUTO", name: "Busy Board", features: ["8-in-1 activities"] });
  const txt = aplusToText(p, { product: "Busy Board", brand: "MUTO" });
  for (const kw of ["品牌故事", "对比表", "模块网格", "配图提示词"]) assert.ok(txt.includes(kw), `导出文本缺 ${kw}`);
  assert.ok(!/undefined/.test(txt), "导出文本里出现了 undefined");
  assert.match(txt, /≤\d+ 字/, "没把字数预算写进导出文本");
});

/* ── 20b. 批量质检 ── */

t("批量：按 --- 分块，ASIN 与项目符号都剥掉", () => {
  const { items, errors } = parseBatch([
    "B0ABC12345",
    "Premium Ceramic Mug 350ml Double Wall",
    "- Keeps hot 6 hours",
    "2) Fits cup holders",
    "---",
    "Montessori Busy Board for Toddlers",
    "* Safe felt",
  ].join("\n"));
  assert.equal(errors.length, 0);
  assert.equal(items.length, 2);
  assert.equal(items[0].asin, "B0ABC12345");
  assert.equal(items[0].title, "Premium Ceramic Mug 350ml Double Wall");
  assert.deepEqual(items[0].bullets, ["Keeps hot 6 hours", "Fits cup holders"], "项目符号没剥干净");
  assert.equal(items[1].title, "Montessori Busy Board for Toddlers");
});

t("批量：认「标题：/ 五点：」标签写法（中文冒号也认）", () => {
  const { items } = parseBatch("标题：Montessori Busy Board 30cm\n五点：\n安全毛毡\n可带上飞机");
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Montessori Busy Board 30cm");
  assert.equal(items[0].bullets.length, 2);
});

t("🔴 批量：没标题就报错，不拿第一行五点冒充标题", () => {
  const { items, errors } = parseBatch("---\n短\n---\n");
  assert.equal(items.length, 0, "把不完整的内容也检了");
  assert.ok(errors.length >= 1);
  assert.ok(errors.every((e) => /标题/.test(e.reason)), "报错没说清是标题的问题");
});

t("批量：超过上限直接报错，不静默截断", () => {
  const blocks = Array.from({ length: BATCH_MAX + 1 }, (_, i) => `Product number ${i} for testing purposes\n- a\n- b`);
  const { items, errors } = parseBatch(blocks.join("\n---\n"));
  assert.equal(items.length, 0);
  assert.match(errors[0].reason, new RegExp(String(BATCH_MAX)), "报错里没写上限");
  assert.match(errors[0].reason, /不.*静默截断|分批/);
});

t("批量：有硬规则的排第一（先改哪条，不是分最低的）", () => {
  const long = "Premium Ceramic Coffee Mug 350ml Double Wall Insulated Stainless Steel Travel Cup with Lid and Handle for Office Home Camping and Gift";
  const r = batchLint(`${long}\n- a\n- b\n---\nSimple Ceramic Mug 350ml\n- a\n- b`, {});
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].pHits > 0, true, "硬规则命中没有排在最前");
  assert.ok(r.rows[0].pRuleIds.includes("P1"), "长标题没命中 P1");
  for (const row of r.rows) {
    assert.ok(row.score === null || (row.score >= 0 && row.score <= 100), "分数越界");
  }
});

t("批量：必须说清是「同口径部分维度分」", () => {
  const r = batchLint("Ceramic Mug 350ml\n- a\n- b", {});
  assert.match(r.note, /同口径|可比/, "没说分行之间是否可比");
  assert.match(r.note, /不要.*单条|不.*单条页面/, "没拦住「拿批量分对比单条健康分」");
  assert.ok(r.summary.scoredWeight > 0 && r.summary.scoredWeight < 100, "权重口径不是部分维度");
  assert.equal(r.summary.scoredWeight + r.summary.skippedWeight, 100, "权重加总不是 100");
});

t("批量：汇总 CSV 带 BOM、含硬规则列", () => {
  const r = batchLint("Ceramic Mug 350ml\n- a\n- b", {});
  const csv = batchCsv(r.rows);
  assert.equal(csv.charCodeAt(0), 0xfeff, "缺 BOM，Excel 打开中文会乱码");
  assert.match(csv, /ASIN\/序号/, "表头不对");
  assert.match(csv, /硬规则命中/);
  assert.equal(csv.trim().split("\r\n").length, r.rows.length + 1, "行数对不上");
});

/* ── 20c. 竞品 CSV 导入 ── */

t("CSV：分隔符嗅探（逗号 / 分号 / 制表符）", () => {
  assert.equal(sniffDelimiter("a,b,c\n1,2,3"), ",");
  assert.equal(sniffDelimiter("a;b;c\n1;2;3"), ";");
  assert.equal(sniffDelimiter("a\tb\tc\n1\t2\t3"), "\t");
  // 引号里的逗号不算分隔符
  assert.equal(sniffDelimiter('"a,b";"c,d"\n1;2'), ";");
});

t("CSV：parseRecords 处理引号内的逗号与换行", () => {
  const recs = parseRecords('k,v\n"mug, large",1\n"two\nlines",2\n');
  assert.equal(recs.length, 3);
  assert.equal(recs[1][0], "mug, large");
  assert.equal(recs[2][0], "two\nlines");
});

t("CSV：表头识别（英文 / 中文 / 括号说明）", () => {
  const en = detectColumns(["Keyword Phrase", "ABA Total Click Share", "Search Volume", "Sponsored ASINs"]);
  assert.equal(en.mapping.keyword, 0);
  assert.equal(en.mapping.volume, 2);
  assert.equal(en.mapping.asin, null, "Sponsored ASINs 被误认成 ASIN 列");
  const cn = detectColumns(["关键词", "月搜索量(精确)", "购买率"]);
  assert.equal(cn.mapping.keyword, 0);
  assert.equal(cn.mapping.volume, 1);
  assert.deepEqual(cn.unknown, ["购买率"]);
});

t("CSV：搜索量解析（千分位 / K / 万 / NA），解析不了给 null 不填 0", () => {
  assert.equal(parseVolume("1,200").value, 1200);
  assert.equal(parseVolume("12K").value, 12000);
  assert.equal(parseVolume("1.2万").value, 12000);
  assert.equal(parseVolume("N/A").value, null);
  assert.equal(parseVolume("").value, null);
  assert.equal(parseVolume("约一百").value, null);
});

t("🔴 CSV：找不到关键词列就报错并列出表头，不猜第一列", () => {
  const r = importKeywordCsv("ASIN,Title\nB01,abc\n");
  assert.equal(r.rows.length, 0);
  assert.match(r.problems[0], /没找到/, "没给出明确错误");
  assert.match(r.problems[0], /ASIN \| Title/, "没把实际表头告诉用户");
});

t("CSV：重复词保留搜索量更大的那条", () => {
  const r = importKeywordCsv('Keyword,Search Volume\nceramic mug,"1,000"\nCeramic Mug,"5,000"\n');
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].volume, 5000);
});

t("🔴 CSV：千分位逗号没加引号 → 标存疑并提示，不假装读对", () => {
  const r = importKeywordCsv("关键词,月搜索量\n保温杯,8,500\n");
  assert.equal(r.rows[0].volume, 8, "解析行为变了？");
  assert.equal(r.rows[0].volumeSuspect, true, "没标记存疑");
  assert.ok(r.problems.some((p) => /千分位|列数/.test(p)), "没提示列数不一致");
});

t("CSV：超过上限报数并截断（与批量质检的处理不同，这里有明说）", () => {
  const lines = ["Keyword,Search Volume"];
  for (let i = 0; i < CSV_MAX_ROWS + 5; i++) lines.push(`kw${i},${i + 1}`);
  const r = importKeywordCsv(lines.join("\n"));
  assert.equal(r.rows.length, CSV_MAX_ROWS);
  assert.equal(r.truncated, true);
  assert.ok(r.problems.some((p) => /截断/.test(p)), "截断了却没告诉用户");
});

t("CSV：并搜索量只加列、不改判定，未匹配留空", () => {
  const cov = [{ term: "ceramic mug", score: 3, hit: { title: true } }, { term: "unknown term", score: 0, hit: {} }];
  const imp = importKeywordCsv('Keyword,Search Volume\nCeramic Mug,"12,000"\n');
  const w = withVolumes(cov, imp, { sourceName: "cerebro.csv", source: imp.source });
  assert.equal(w.matched, 1);
  assert.equal(w.missing, 1);
  assert.equal(w.rows[0].volume, 12000, "大小写不一致时没匹配上");
  assert.equal(w.rows[1].volume, null, "未匹配的词被填成了 0");
  assert.equal(w.rows[0].score, 3, "并搜索量时改动了覆盖判定");
  assert.match(w.sourceLabel, /cerebro\.csv/);
});

t("CSV：导入说明必须自称「来自文件、不是本工具估算」", () => {
  const r = importKeywordCsv('Keyword,Search Volume\nmug,100\n', { sourceName: "x.csv" });
  assert.match(r.note, /不是本工具估算/, "搜索量来源没交代");
  assert.match(r.note, /x\.csv/, "没写文件名");
});

t("CSV：keywordList 过滤空值，顺序保持文件顺序", () => {
  assert.deepEqual(keywordList([{ keyword: "a" }, { keyword: "" }, { keyword: "b" }]), ["a", "b"]);
});

/* ─────────────── 批七：一份输入，全站共用 ───────────────
 * 起因：⑥⑦⑧ 三块其实吃的是同一份数据（品牌/产品名/卖点/规格），但 ⑦ 还挂着
 * 一个独立的「产品名」输入框 —— 同一件事问两遍，用户看到的就是「每个窗口都要重填」。
 * 这组断言锁三件事：不再出现第二个输入框、三块都有共用状态条、批量能带当前这条。
 */
section("批七：一份输入，全站共用");

t("🔴 ⑦ 的产品名不再是第二个输入框（同一件事不问两遍）", () => {
  const block = HTML.slice(HTML.indexOf('id="drawerCp"'), HTML.indexOf('id="drawerAplus"'));
  assert.match(block, /<input type="hidden" id="cpProduct">/, "cpProduct 不是隐藏字段，界面上又多了个输入框");
  assert.ok(!/<input(?![^>]*hidden)[^>]*id="cpProduct"/.test(block), "⑦ 里还有一个可见的 cpProduct 输入框");
  assert.match(block, /id="cpProductEcho"/, "没有回显：用户看不出这个值来自左栏");
});

t("三块下游抽屉都带「共用数据」状态条（缺项要能一眼看到）", () => {
  for (const id of ["drawerRufus", "drawerCp", "drawerAplus"]) {
    const i = HTML.indexOf(`id="${id}"`);
    assert.ok(i > 0, `找不到 ${id}`);
    const body = HTML.slice(i, i + 900);
    assert.match(body, /data-shared-bar/, `${id} 里没有共用状态条`);
  }
});

t("左栏改动会镜像到 ⑦ 的产品名，且缺项可跳转", () => {
  assert.match(APP, /function syncSharedInputs\(\)/, "没有 syncSharedInputs");
  assert.match(APP, /cp\.value !== name/, "镜像时不比对，会把光标位置打乱");
  assert.match(APP, /function focusFirstMissing\(\)/, "没有「去补」的跳转");
  assert.match(APP, /const SHARED_ORDER = \["lBrand", "lName", "lFeatures", "lSize"\]/, "缺项检查顺序被改");
});

t("批量质检能带上当前这条（读右栏标题，不是左栏产品名）", () => {
  assert.match(APP, /function fillBatchCurrent\(\)/, "没有 fillBatchCurrent");
  const fn = APP.slice(APP.indexOf("function fillBatchCurrent()"));
  assert.match(fn.slice(0, 700), /\$\("#lTitle"\)/, "没读右栏标题：带进来的会是产品名而不是已写好的标题");
  assert.match(fn, /\\n---\\n/, "块之间没加分隔符，批量和单条会串成一条");
});

t("规则卡的「依据与来源」默认收起，但没被删掉", () => {
  // 判据层的硬要求是「每条都要有 why + source」，不是「每条都要一直占三行」。
  // 这条锁的是「收起」而不是「删除」：DOM 里必须还在，只是 details 默认不展开。
  const fn = APP.slice(APP.indexOf("function renderRufus()"), APP.indexOf("function renderRufus()") + 4000);
  assert.match(fn, /<details class="rule-ref">/, "没有用 details 收起");
  assert.match(fn, /<summary>依据与来源<\/summary>/, "没有可点开的入口");
  assert.match(fn, /class="why"/, "把 why 删了 —— 那是「为什么有这条规则」的唯一解释");
  assert.match(fn, /class="src">来源：/, "把来源删了 —— 判据必须能追到出处");
  assert.ok(!/<details class="rule-ref"\s+open/.test(fn), "默认展开等于没收起");
});

/* ─────────────── 汇总 ─────────────── */
process.stdout.write(`\n${"─".repeat(60)}\n`);
process.stdout.write(`共 ${pass + fail} 条断言：通过 ${pass}，失败 ${fail}\n`);
// 断言数守卫：少于期望 = 有断言被删掉（算失败）；多于期望 = 提示更新期望值。
fail += checkAssertCount("selftest", pass + fail);
if (fail) {
  // 两栏分列：带 tag 的是「已知未修闸门」（G4 / B3，数据/契约修好后应自己转绿，不需要改断言）；
  // 不带 tag 的一律是「其它失败」= 新增回归，必须处理。二者不得混为一谈。
  const known = failures.filter((f) => f.tag);
  const other = failures.filter((f) => !f.tag);
  const TAG_DESC = {
    "G4": "G4 否定窗口条款（待契约落地，落点=规则层，不是改 guards）",
    "B3": "B3 单字母单位歧义",
    "B2": "B2 guards 窗口语义",
  };
  const knownTags = [...new Set(known.map((f) => f.tag))].map((t) => TAG_DESC[t] || t);
  process.stdout.write(`\n失败明细（两栏分开计，不合并成 ×1）\n`);
  process.stdout.write(`  一、已知未修闸门（${known.length} 条：${knownTags.join(" / ")}）\n`);
  if (known.length === 0) process.stdout.write(`    （无）\n`);
  for (const f of known) process.stdout.write(`    · [${f.tag}] ${f.name}\n      ${f.msg}\n`);
  process.stdout.write(`  二、其它失败（新增回归，必须处理）（${other.length} 条）\n`);
  if (other.length === 0) process.stdout.write(`    （无）\n`);
  for (const f of other) process.stdout.write(`    · ${f.name}\n      ${f.msg}\n`);
  process.exit(1);
}
process.stdout.write(`全部通过 ✓\n`);
