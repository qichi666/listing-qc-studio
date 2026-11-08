#!/usr/bin/env node
/**
 * 词库链路自检：种子表 → 快照合并 → 陈旧判定 → 采集器实跑（dry-run，不联网）。
 *
 * 为什么单独一套而不是塞进 selftest：这一套要**真起一个子进程**（采集器）并读写临时目录，
 * 与 selftest「纯函数、不写盘」的定位不同。混在一起会让 selftest 变慢、变脆。
 *
 * 盯的四件事：
 *   ① 合并口径只有一份（firstSeen 继承、新增/消失、ASIN 去重保最小名次）；
 *   ② **失败不覆盖**：一条都没抓到时采集器必须拒绝写盘（这是这类采集器最常见的自毁方式）；
 *   ③ 陈旧判定三态（missing / stale / fresh）不许含糊；
 *   ④ 词面契约：建议词只有词面，别在任何地方被写成"搜索量"。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkAssertCount } from "./assert-count.mjs";
import {
  buildSnapshot, emptySnapshot, isEmpty, staleness, digestOf, lookup, queryKeywords, termKey, CAPS, SCHEMA,
  MAX_KEYWORD_LIMIT, diffAsins, compareSnapshots,
} from "../assets/keyword-vault.js";
import { readLatest, latestPath, nextHistoryPath } from "../assets/keywords-store.js";
import { resolveRoots, OVERLAY_SCHEMA } from "../assets/keyword-roots.js";
import { ROOTS, ROOT_GROUPS, ROOT_TO_GROUP } from "../assets/keyword-seeds.js";
import { suggestUrl, parseSuggestions, normalizeSite, MARKET, SITE_KEYS } from "../assets/amazon-suggest.js";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const COLLECTOR = path.join(HERE, "tools", "collect-keywords.mjs");
const FIXTURE = path.join(HERE, "tools", "fixtures", "keywords", "dry-run.json");

let pass = 0;
let fail = 0;
function ck(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
}

/* ── 1. 词根种子表 ─────────────────────────────────────────── */

console.log("1. 词根种子表");
ck(`词根 ≥120 条（现在 ${ROOTS.length}）—— 太少的话"每周词库"就只是几个词的循环`, ROOTS.length >= 120, String(ROOTS.length));
ck("词根无重复（重复 = 白花一次请求，还会让 hits 虚高）", new Set(ROOTS).size === ROOTS.length);
ck("每个分组都有词根且 ≥8 条（少于 8 条撑不起一个类目）",
  ROOT_GROUPS.every((g) => g.roots.length >= 8), ROOT_GROUPS.map((g) => `${g.key}:${g.roots.length}`).join(" "));
ck("词根长度 2–4 个词（太短噪声大，太长接口直接返回 0 条）",
  ROOTS.every((r) => { const n = r.split(/\s+/).length; return n >= 2 && n <= 4; }),
  ROOTS.filter((r) => { const n = r.split(/\s+/).length; return n < 2 || n > 4; }).slice(0, 5).join(", "));
ck("词根表里没有品牌名那种首字母大写的写法（长尾是品牌自己的，不是选品要的）",
  ROOTS.every((r) => r === r.toLowerCase()), ROOTS.filter((r) => r !== r.toLowerCase()).slice(0, 5).join(", "));
ck("每个词根都能查到所属分组", ROOTS.every((r) => Boolean(ROOT_TO_GROUP.get(r))));

/* ── 2. 快照合并 ───────────────────────────────────────────── */

console.log("\n2. 快照合并（唯一的一份合并口径）");
const hits = [
  { term: "ceramic mug", root: "ceramic mug", group: "kitchen" },
  { term: "Ceramic  Mug", root: "coffee cup", group: "kitchen" },   // 大小写+多空格 → 同一条
  { term: "yoga mat", root: "yoga mat", group: "sports" },
  { term: "ab", root: "ceramic mug" },                              // 太短，丢弃
];
const asins = [
  { asin: "B0FIX00001", title: "A", category: "kitchen", rank: 3 },
  { asin: "B0FIX00001", title: "A", category: "kitchen", rank: 1 },  // 同名次更靠前 → 覆盖
  { asin: "B0FIX00002", title: "B", category: "kitchen", rank: 2 },
  { asin: "NOTANASIN", title: "C", category: "kitchen", rank: 1 },   // 形状不对，丢弃
  { asin: "B0FIX00003", title: "D", category: "beauty", rank: 1 },
];
const s1 = buildSnapshot({ site: "US", keywordHits: hits, asins, now: new Date("2026-11-03T00:00:00Z") });

ck("schema 固定", s1.schema === SCHEMA, String(s1.schema));
ck("同一词的不同写法合并成一条（大小写/空格不算两个词）", s1.summary.keywordCount === 2, String(s1.summary.keywordCount));
ck("展示用原始大小写，比较用小写",
  s1.keywords.some((k) => k.term === "ceramic mug" || k.term === "Ceramic  Mug"), s1.keywords.map((k) => k.term).join(" / "));
ck("过短的词（<3 字符）被丢掉", !s1.keywords.some((k) => k.term.length < 3));
ck("hits 记的是「被几个词根带出来」，不是次数", s1.keywords.find((k) => termKey(k.term) === "ceramic mug")?.hits === 2,
  String(s1.keywords.find((k) => termKey(k.term) === "ceramic mug")?.hits));
ck("同一词根重复出现不会让 roots 重复",
  new Set(s1.keywords.find((k) => termKey(k.term) === "ceramic mug")?.roots).size
  === s1.keywords.find((k) => termKey(k.term) === "ceramic mug")?.roots.length);
ck("ASIN 形状不对（非 10 位）被丢弃", s1.summary.asinCount === 3, String(s1.summary.asinCount));
ck("同一 ASIN 出现两次只留一条", s1.asins.length === 3);
ck("同一 ASIN 出现在不同名次时留**最靠前**的名次",
  s1.asins.find((a) => a.asin === "B0FIX00001")?.rank === 1, String(s1.asins.find((a) => a.asin === "B0FIX00001")?.rank));
ck("firstSeen 首次记为当天", s1.keywords.every((k) => k.firstSeen === "2026-11-03"));
ck("第一次跑时 recurring 全为 false", s1.keywords.every((k) => !k.recurring));

// ASIN 字段对齐（2026-11-07 真实事故：榜单解析器给的是 `reviews`，快照只读 `reviewCount`
//   → 769 条 ASIN 的评论数全是空字符串；同时榜单条目没有 url，界面拿到了空链接）
const s1b = buildSnapshot({
  site: "US",
  asins: [{ asin: "B0FIX00009", title: "E", category: "kitchen", rank: 1, reviews: 1234 }],
  now: new Date("2026-11-03T00:00:00Z"),
});
const a1b = s1b.asins[0];
ck("榜单的 `reviews` 会被对齐成 `reviewCount`（两个名字只在这里对齐一次）",
  a1b?.reviewCount === "1234", String(a1b?.reviewCount));
ck("榜单没有 url 时按站点派生详情页地址",
  a1b?.url === "https://www.amazon.com/dp/B0FIX00009", String(a1b?.url));
ck("派生 url 跟着站点走（DE → amazon.de）",
  buildSnapshot({ site: "DE", asins: [{ asin: "B0FIX00010", title: "F", rank: 1 }] }).asins[0]?.url
  === "https://www.amazon.de/dp/B0FIX00010");

// 第二周：只有 yoga mat 还在，另外多出一个新词
const s2 = buildSnapshot({
  site: "US",
  keywordHits: [
    { term: "yoga mat", root: "yoga mat", group: "sports" },
    { term: "cork yoga mat", root: "yoga mat", group: "sports" },
  ],
  asins: [],
  prev: s1,
  now: new Date("2026-11-10T00:00:00Z"),
});
ck("上一周存在的词 → recurring = true（判据是「上一份快照里有没有」，不是 hits 多少）",
  s2.keywords.find((k) => k.term === "yoga mat")?.recurring === true);
ck("firstSeen 继承上一份，不被覆盖（这是整条链路最值钱的字段）",
  s2.keywords.find((k) => k.term === "yoga mat")?.firstSeen === "2026-11-03",
  s2.keywords.find((k) => k.term === "yoga mat")?.firstSeen);
ck("lastSeen 更新为本周", s2.keywords.every((k) => k.lastSeen === "2026-11-10"));
ck("本周新增只算「上一份里没有的」", s2.summary.newKeywordCount === 1 && s2.summary.newKeywords[0] === "cork yoga mat",
  JSON.stringify(s2.summary.newKeywords));
ck("消失的词单独记（不许悄悄没了）",
  s2.summary.droppedKeywordCount === 1 && s2.summary.droppedKeywords[0].toLowerCase() === "ceramic mug",
  JSON.stringify(s2.summary.droppedKeywords));
ck("本周没有 ASIN → asinCount = 0 且不报错", s2.summary.asinCount === 0);

/* ── 3. 空快照与上限 ───────────────────────────────────────── */

console.log("\n3. 空快照：绝不能当成「这周没有新词」");
const empty = buildSnapshot({ site: "US", keywordHits: [], asins: [] });
ck("isEmpty 认得出空快照", isEmpty(empty) === true);
ck("空快照的 summary.note 明说「不能当这周没有新词用」",
  /不能当|没有抓到一个/.test(empty.summary.note), empty.summary.note);
ck("emptySnapshot() 结构完整（keywords/asins/summary 都在）",
  Array.isArray(emptySnapshot().keywords) && Array.isArray(emptySnapshot().asins) && Boolean(emptySnapshot().summary));

const many = Array.from({ length: CAPS.keywords + 20 }, (_, i) => ({ term: `word number ${i}`, root: "x", group: "g" }));
const capped = buildSnapshot({ site: "US", keywordHits: many, asins: [] });
ck(`关键词超过上限 ${CAPS.keywords} 会被截断`, capped.summary.keywordCount === CAPS.keywords, String(capped.summary.keywordCount));
ck("截断要写在 note 里（不许安静地丢数据）", /截断/.test(capped.summary.note), capped.summary.note);

/* ── 4. 陈旧判定 ───────────────────────────────────────────── */

console.log("\n4. 陈旧判定：界面与 MCP 必须同一口径");
const now = new Date("2026-11-20T00:00:00Z");
ck("没有快照 → missing", staleness(null, now).state === "missing");
ck("时间读不出来 → missing（不猜）", staleness({ generatedAt: "not-a-date" }, now).state === "missing");
ck("3 天前 → fresh", staleness({ generatedAt: "2026-11-17T00:00:00Z" }, now).state === "fresh");
ck("11 天前 → stale", staleness({ generatedAt: "2026-11-09T00:00:00Z" }, now).state === "stale");
ck("stale 时说清「多半是定时任务失败了」", /定时任务/.test(staleness({ generatedAt: "2026-11-09T00:00:00Z" }, now).note));
ck("ageDays 是整数天数", Number.isInteger(staleness({ generatedAt: "2026-11-09T00:00:00Z" }, now).ageDays));
// 四态的**边界**必须逐个钉住：10/11 与 21/22 各差一天，改错一个数字不会有人发现，
// 但后果是"刚过一周就报死"或"烂了三周还说没事"。
ck("10 天前 → fresh（容忍上限就是 10，不提前告警）",
  staleness({ generatedAt: "2026-11-10T00:00:00Z" }, now).state === "fresh");
ck("21 天前 → stale（还没到死线，但已经是「别当本周数据用」）",
  staleness({ generatedAt: "2026-10-30T00:00:00Z" }, now).state === "stale");
ck("22 天前 → dead（超过 21 天，换一档说法）",
  staleness({ generatedAt: "2026-10-29T00:00:00Z" }, now).state === "dead");
ck("dead 的提示是「去修定时任务」，不是「稍微有点旧」",
  /修定时任务/.test(staleness({ generatedAt: "2026-10-29T00:00:00Z" }, now).note),
  staleness({ generatedAt: "2026-10-29T00:00:00Z" }, now).note);

/* ── 5. 摘要与查询 ─────────────────────────────────────────── */

console.log("\n5. 摘要与查询");
const dg = digestOf(s2);
ck("摘要里不含完整 keywords 数组（历史文件要小）", dg.keywords === undefined);
ck("摘要保留了 counts 与来源状态", typeof dg.keywordCount === "number" && dg.sourceStatus && typeof dg.sourceStatus === "object");
ck("lookup 空 query 返回全部（受 limit）", lookup(s1, "", 1).length === 1);
ck("lookup 按词面模糊匹配", lookup(s1, "yoga").length === 1 && lookup(s1, "YOGA")[0].term === "yoga mat");
ck("lookup 查不到时返回空数组，不是 null", Array.isArray(lookup(s1, "nonexistent-word")));

// 类目筛 + 截断可见（2026-11-07：接口曾允许 limit=2000，底层却**静默**夹到 500）
const qkGroup = queryKeywords(s1, { group: "sports" });
ck("queryKeywords 按分组筛（只回 sports 的词）",
  qkGroup.total === 1 && qkGroup.rows[0]?.term === "yoga mat", JSON.stringify(qkGroup.rows));
const qkCap = queryKeywords(s1, { limit: 1 });
ck("超过 limit 时 truncated=true，且 total 仍是真实总数",
  qkCap.rows.length === 1 && qkCap.total === 2 && qkCap.truncated === true, JSON.stringify(qkCap));
ck("没超过 limit 时 truncated=false（不是恒为 true）",
  queryKeywords(s1, { limit: 50 }).truncated === false);
ck("lookup 是 queryKeywords 的薄壳（`?category=` 修好后两处口径一致）",
  lookup(s1, "", 1).length === queryKeywords(s1, { limit: 1 }).rows.length);

// 要多了不报错，但必须报账：requested 是你要的，limit 是实际给的（clamp 可以，撒谎不行）
const qkOver = queryKeywords(s1, { limit: 2000 });
ck("要 2000 条 → 实际最多给 MAX_KEYWORD_LIMIT，且 requested 如实回显 2000",
  qkOver.requested === 2000 && qkOver.limit === MAX_KEYWORD_LIMIT && qkOver.rows.length <= MAX_KEYWORD_LIMIT,
  `${qkOver.requested}/${qkOver.limit}/${qkOver.rows.length}`);
ck("没要多时 requested 也不撒谎（50 就是 50）",
  queryKeywords(s1, { limit: 50 }).requested === 50);

/* ── 6. 建议词接口（不联网，只验 URL 与解析）──────────────── */

console.log("\n6. 建议词接口：URL 形状与解析");
ck("站点表 8 个", SITE_KEYS.length === 8, SITE_KEYS.join(","));
ck("US/DE 标为已实测，其余为未实测",
  MARKET.US.verified === true && MARKET.DE.verified === true && MARKET.JP.verified === false);
ck("com → US（两套站点编码的唯一转换点）", normalizeSite("com") === "US" && normalizeSite("us") === "US");
ck("未知站点回落 US（不因为写错就崩）", normalizeSite("ZZ") === "US");
const u = suggestUrl("ceramic mug", "US", 11);
ck("URL 带 mid / lop / prefix / suggestion-type",
  /mid=ATVPDKIKX0DER/.test(u) && /lop=en_US/.test(u) && /prefix=ceramic%20mug/.test(u) && /suggestion-type=KEYWORD/.test(u), u);
ck("limit 夹在 1–20（超了接口会忽略，不如自己夹住）", /limit=20/.test(suggestUrl("x", "US", 999)));
ck("解析时去掉空值并去重（同一个词出现两次只留一条）",
  JSON.stringify(parseSuggestions({ suggestions: [{ value: "a b" }, { value: "a  b" }, { value: "" }, { value: "c" }] })) === JSON.stringify(["a b", "c"]),
  JSON.stringify(parseSuggestions({ suggestions: [{ value: "a b" }, { value: "a  b" }, { value: "" }, { value: "c" }] })));
ck("响应不是 suggestions 数组时返回空数组（不抛）", Array.isArray(parseSuggestions({})));

/* ── 7. 采集器实跑（dry-run，写临时目录）──────────────────── */

console.log("\n7. 采集器实跑：dry-run 到临时目录");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kw-selftest-"));
const run = (args) => spawnSync(process.execPath, [COLLECTOR, ...args], { cwd: HERE, encoding: "utf8" });
// fixture 里有几个词根 —— 断言「跳过了几个」时要拿它做基准，而不是写死 6。
const FX_ROOT_COUNT = Object.keys(JSON.parse(fs.readFileSync(FIXTURE, "utf8")).suggest || {}).length;

try {
  ck("dry-run 不给 --out 会被拒（假数据不许落进真词库）",
    run(["--dry-run"]).status === 3, `exit=${run(["--dry-run"]).status}`);

  const r1 = run(["--dry-run", "--out", tmp, "--fixture", FIXTURE]);
  ck("dry-run 正常退出（exit 0）", r1.status === 0, `exit=${r1.status} ${(r1.stderr || "").slice(0, 200)}`);

  const latest = path.join(tmp, "latest.json");
  ck("写出 latest.json", fs.existsSync(latest));
  const snap = JSON.parse(fs.readFileSync(latest, "utf8"));
  ck("产物 schema 与模块一致", snap.schema === SCHEMA, String(snap.schema));
  ck("产物里关键词非空", (snap.keywords || []).length > 0, String(snap.keywords?.length));
  ck("产物里 ASIN 非空（fixture 的 10 位 ASIN 会被收下）", (snap.asins || []).length > 0, String(snap.asins?.length));
  ck("产物标记了 dryRun（避免被人当成真实抓取结果）", snap.dryRun === true, String(snap.dryRun));
  ck("sources 里两路都记了状态", snap.sources?.suggest?.status === "ok" && snap.sources?.bestsellers?.status === "ok",
    JSON.stringify(snap.sources));
  ck("历史摘要也写了", fs.existsSync(path.join(tmp, "history", `${snap.generatedAt.slice(0, 10)}.json`)));
  ck("ASIN 带 priceKnown（把「没标价」与「没抓到价格」分开）",
    snap.asins.every((a) => typeof a.priceKnown === "boolean"), JSON.stringify(snap.asins[0] || {}).slice(0, 120));

  // 同一输入跑第二次：新增必须是 0（这是"合并"而不是"累加"的判据）
  const r2 = run(["--dry-run", "--out", tmp, "--fixture", FIXTURE]);
  const snap2 = JSON.parse(fs.readFileSync(latest, "utf8"));
  ck("第二次跑同样输入 → 新增 0（合并而不是累加）",
    snap2.summary.newKeywordCount === 0, JSON.stringify(snap2.summary.newKeywords));
  ck("第二次跑 → 所有词都变成 recurring",
    snap2.keywords.every((k) => k.recurring === true));
  ck("第二次跑 exit 仍为 0", r2.status === 0, String(r2.status));
  ck("同一天跑第二次不覆盖第一次（写 -2，不抹掉当天第一份）",
    fs.existsSync(path.join(tmp, "history", `${snap.generatedAt.slice(0, 10)}-2.json`)));

  // 全失败：fixture 里没有这个词根 → 一路失败；再让 bestsellers 也空 → 必须拒写
  const badFixture = path.join(tmp, "bad.json");
  fs.writeFileSync(badFixture, JSON.stringify({ suggest: {}, bestsellers: {} }), "utf8");
  const tmp2 = path.join(tmp, "empty-run");
  const r3 = run(["--dry-run", "--out", tmp2, "--fixture", badFixture]);
  ck("一条都没抓到时退出码 = 2（让定时任务红，而不是悄悄成功）", r3.status === 2, String(r3.status));
  ck("🔴 一条都没抓到时不写 latest.json（不拿空数据盖掉好数据）",
    !fs.existsSync(path.join(tmp2, "latest.json")));
  ck("拒写时说清了「没有覆盖 latest.json」", /没有覆盖/.test(r3.stderr || ""), (r3.stderr || "").slice(-160));

  // 预算不够 → 必须写明跳过了哪些词根（默认 220 是够 194 条的，但 --max-requests 可以被调小）
  const tmp4 = path.join(tmp, "budget");
  const r4 = run(["--dry-run", "--out", tmp4, "--fixture", FIXTURE, "--max-requests", "2"]);
  const snap4 = JSON.parse(fs.readFileSync(path.join(tmp4, "latest.json"), "utf8"));
  ck("预算不够时报告里写明「预算跳过 N 个词根」", /预算跳过/.test(r4.stdout || ""), (r4.stdout || "").slice(-160));
  ck("sources.suggest.skipped 记下跳过数（不写就等于没跳过）",
    snap4.sources?.suggest?.skipped === FX_ROOT_COUNT - 2, String(snap4.sources?.suggest?.skipped));

  // ── 预算自证（P0-A）─────────────────────────────────────────────
  // 红线 3「预算要说」过去只说到一半：有 requests，没有 budget —— 221 是多了还是少了
  // 谁也无法判断。这一组断言要求产物**可徒手复算**。
  const derived = snap?.sources?.suggest || {};
  ck("默认不传 --max-requests 时预算是推导的（budgetSource=derived）",
    derived.budgetSource === "derived", String(derived.budgetSource));
  ck("推导值 = 词根数 + 深挖数（默认 deep=0）",
    derived.budget === derived.rootsPlanned + derived.deepPlanned,
    `${derived.budget} vs ${derived.rootsPlanned}+${derived.deepPlanned}`);
  ck("预算 ≥ 词根数（默认配置永远够跑完种子表 —— 220 那种「差一个」不再出现）",
    derived.budget >= derived.rootsPlanned, `${derived.budget}/${derived.rootsPlanned}`);
  ck("实发请求 = 一轮 + 二轮（requests === rootsRun + deepAttempted）",
    derived.requests === derived.rootsRun + derived.deepAttempted,
    `${derived.requests} vs ${derived.rootsRun}+${derived.deepAttempted}`);

  // 带 --deep 跑一次：二轮候选里"本来就是词根"的必须单独计数 ——
  // 那 3 个被 seenRoots 吃掉的候选，正是「设计容量 224 / 实发 221」的差。
  const tmpDeep = path.join(tmp, "deep");
  const rDeep = run(["--dry-run", "--out", tmpDeep, "--fixture", FIXTURE, "--deep", "3"]);
  const d = JSON.parse(fs.readFileSync(path.join(tmpDeep, "latest.json"), "utf8")).sources?.suggest || {};
  ck("二轮候选 = 实发 + 重复（deepCandidates === deepAttempted + deepSkippedDuplicate）",
    d.deepCandidates === d.deepAttempted + d.deepSkippedDuplicate,
    `${d.deepCandidates} vs ${d.deepAttempted}+${d.deepSkippedDuplicate}`);
  ck("--deep 3 时预算跟着参数走（budget = 词根数 + 3，不是常量）",
    d.budget === d.rootsPlanned + 3 && d.deepPlanned === 3,
    `${d.budget}/${d.rootsPlanned}/${d.deepPlanned}`);
  ck("报告里的「预算 N 次」与产物里的 budget 一致（两处不能各说一套）",
    new RegExp(`预算\\s+${d.budget}\\s+次`).test(rDeep.stdout || ""), (rDeep.stdout || "").slice(-200));

  ck("显式 --max-requests 2 → budgetSource=cli，预算就是 2（不偷偷放大）",
    snap4.sources?.suggest?.budget === 2 && snap4.sources?.suggest?.budgetSource === "cli",
    `${snap4.sources?.suggest?.budget}/${snap4.sources?.suggest?.budgetSource}`);
  ck("预算真被用光才跳过（requests === budget）",
    snap4.sources?.suggest?.requests === snap4.sources?.suggest?.budget,
    `${snap4.sources?.suggest?.requests}/${snap4.sources?.suggest?.budget}`);

  // 上一份快照损坏 → 不许把整份词表算成"本周新增"还不吭声
  const tmp5 = path.join(tmp, "corrupt");
  fs.mkdirSync(tmp5, { recursive: true });
  fs.writeFileSync(path.join(tmp5, "latest.json"), "{ this is not json", "utf8");
  run(["--dry-run", "--out", tmp5, "--fixture", FIXTURE]);
  const snap5 = JSON.parse(fs.readFileSync(path.join(tmp5, "latest.json"), "utf8"));
  ck("上一份快照损坏时写进 summary.note（摘要不能看着正常但其实全错）",
    /读不出来/.test(snap5.summary.note || ""), snap5.summary.note);

  // 读盘缓存：没变不重读 / 变了必须重读（两边都要测，否则会静默吞掉有效更新）
  const tmp6 = path.join(tmp, "cache");
  fs.mkdirSync(tmp6, { recursive: true });
  const cacheFile = path.join(tmp6, "latest.json");
  const mini = (terms) => JSON.stringify({ schema: 1, site: "US", generatedAt: "2026-11-07T00:00:00Z", keywords: terms, asins: [], summary: {}, sources: {} });
  fs.writeFileSync(cacheFile, mini([{ term: "ceramic mug", groups: ["kitchen"], hits: 1 }]), "utf8");
  const e1 = readLatest({ LISTING_KEYWORDS: tmp6 });
  const e2 = readLatest({ LISTING_KEYWORDS: tmp6 });
  ck("文件没变：第二次读命中缓存（cached=true）", e1.ok && e1.cached === false && e2.cached === true, `${e1.cached}/${e2.cached}`);
  fs.writeFileSync(cacheFile, mini([{ term: "ceramic mug", groups: ["kitchen"], hits: 1 }, { term: "yoga mat", groups: ["sports"], hits: 2 }]), "utf8");
  const e3 = readLatest({ LISTING_KEYWORDS: tmp6 });
  ck("文件变了：必须重读，缓存不许把旧数据钉死",
    e3.cached === false && e3.snapshot.keywords.length === 2, `${e3.cached}/${e3.snapshot?.keywords?.length}`);

  // ── 采集状态文件（P1-6）：成功的证据在 latest.json，**失败只有这里有** ──
  // 定时任务跑挂了，latest.json 还是上一份（甚至看着还新鲜），界面只会显示"数据正常"。
  // 唯一的证据就是"最后一次尝试失败了"——所以这个文件必须成功失败都写。
  const tmp8 = path.join(tmp, "status");
  run(["--dry-run", "--out", tmp8, "--fixture", FIXTURE]);
  const st1 = JSON.parse(fs.readFileSync(path.join(tmp8, "_status.json"), "utf8"));
  ck("采集成功也写 _status.json（ok / exitCode / lastSuccessAt 三件齐）",
    st1.ok === true && st1.exitCode === 0 && st1.lastSuccessAt === st1.lastAttemptAt,
    JSON.stringify(st1).slice(0, 200));
  const goodBytes = fs.readFileSync(path.join(tmp8, "latest.json"), "utf8");
  const goodMtime = fs.statSync(path.join(tmp8, "latest.json")).mtimeMs;
  const rFail = run(["--dry-run", "--out", tmp8, "--fixture", badFixture]);
  const st2 = JSON.parse(fs.readFileSync(path.join(tmp8, "_status.json"), "utf8"));
  ck("采集失败也写 _status.json（此时 latest.json 还是上一份，看着像正常）",
    st2.ok === false && st2.exitCode === 2 && Boolean(st2.reason), JSON.stringify(st2).slice(0, 200));
  ck("🔴 失败不覆盖 latest.json（字节与 mtime 都没变）",
    fs.readFileSync(path.join(tmp8, "latest.json"), "utf8") === goodBytes
      && fs.statSync(path.join(tmp8, "latest.json")).mtimeMs === goodMtime,
    `exit=${rFail.status}`);
  ck("失败不抹掉上次成功时间（否则「烂了多久」永远算不出来）",
    st2.lastSuccessAt === st1.lastSuccessAt, `${st2.lastSuccessAt} vs ${st1.lastSuccessAt}`);

  // 文件锁：另一次在跑时不许并发 —— 并发会两个进程各写一份 latest.json（后写的赢，前一份白跑）
  const tmp9 = path.join(tmp, "lock");
  fs.mkdirSync(tmp9, { recursive: true });
  fs.writeFileSync(path.join(tmp9, ".lock"),
    JSON.stringify({ pid: 424242, startedAt: new Date().toISOString() }), "utf8");
  const rLock = run(["--dry-run", "--out", tmp9, "--fixture", FIXTURE]);
  ck("另一个实例正在跑时退出码 = 3，并说清是谁占着（不静默并发写盘）",
    rLock.status === 3 && /另一次采集正在运行/.test(rLock.stderr || ""), (rLock.stderr || "").slice(-200));
  ck("正常跑完会自己删锁（否则下一次永远进不去，且没人知道为什么）",
    !fs.existsSync(path.join(tmp8, ".lock")));

  // ── 日志落盘（计划任务的唯一证据）──────────────────────────────────
  // 从计划任务跑的时候 stdout 没人接收：不留日志，第二天只能看到"词库没更新"，看不到原因。
  const logDir = path.join(tmp8, "logs");
  const logFiles = fs.existsSync(logDir) ? fs.readdirSync(logDir) : [];
  const logText = logFiles.length ? fs.readFileSync(path.join(logDir, logFiles[0]), "utf8") : "";
  ck("每次运行都落一份日志（logs/YYYY-MM-DD.log）",
    logFiles.length === 1 && /^\d{4}-\d{2}-\d{2}\.log$/.test(logFiles[0]), logFiles.join(","));
  ck("日志末尾有「[exit 0]」——没有这行就说明进程是被强杀的，不是正常跑完",
    /\[exit 0\]/.test(logText), logText.slice(-120));

  // ── 计划任务脚本（BT）────────────────────────────────────────────
  // 只做源码级断言：真注册会在使用者机器上留下任务，自检不许有这种副作用。
  const ps1Path = path.join(HERE, "tools", "schedule-weekly.ps1");
  ck("计划任务脚本存在", fs.existsSync(ps1Path));
  const ps1 = fs.existsSync(ps1Path) ? fs.readFileSync(ps1Path, "utf8") : "";
  ck("🔴 .ps1 带 UTF-8 BOM（Windows PowerShell 5.1 无 BOM 时按 GBK 读，中文全变乱码）",
    fs.existsSync(ps1Path)
      && fs.readFileSync(ps1Path)[0] === 0xEF
      && fs.readFileSync(ps1Path)[1] === 0xBB
      && fs.readFileSync(ps1Path)[2] === 0xBF);
  ck("用 <node 绝对路径> + <工作目录> 注册，不写裸 node（计划任务的 PATH 与终端不同）",
    /-Execute \$Node/.test(ps1) && /-WorkingDirectory \$Root/.test(ps1));
  ck("有 -DryRun 且在任何注册动作之前退出（自检/demo 时不许真的建任务）",
    /\[switch\]\$DryRun/.test(ps1)
      && ps1.indexOf("if ($DryRun)") > 0
      && ps1.indexOf("if ($DryRun)") < ps1.indexOf("Register-ScheduledTask -TaskName"),
    `${ps1.indexOf("if ($DryRun)")} < ${ps1.indexOf("Register-ScheduledTask -TaskName")}`);
  ck("并发策略是 IgnoreNew（配合采集器的 .lock，双保险）", /MultipleInstances IgnoreNew/.test(ps1));
  ck("日志目录指向 data\\keywords\\logs（不是随手一个临时目录）",
    /data\\keywords\\logs/.test(ps1), "路径片段");

  // 源码级：dry-run 必须强制 --out；写盘必须原子
  const src = fs.readFileSync(COLLECTOR, "utf8");
  ck("采集器源码里有 dry-run 拒写真词库的分支", /outDir === DEFAULT_DIR/.test(src));
  ck("写盘走临时文件 + rename（写一半崩了不留半截 JSON）",
    /writeFileSync\(tmp/.test(src) && /renameSync\(tmp/.test(src));
  ck("采集器复用 amazon-suggest，而不是自己再拼一份 URL",
    /from "\.\.\/assets\/amazon-suggest\.js"/.test(src) && !/api\/2017\/suggestions/.test(src));
  ck("采集器复用 bestsellers（不另写抓取通道）", /from "\.\.\/assets\/bestsellers\.js"/.test(src));
  ck("采集器里没有任何「搜索量」措辞（它只有词面）",
    !/搜索量\s*[:=]|searchVolume/i.test(src));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

/* ── 7b. 批三/批四：词根覆盖层、历史投影、ASIN 划分、站点结构 ──── */

console.log("\n7b. 批三/批四：词根可运营、历史对比、ASIN 监控、一站一文件");
const baseRoots = resolveRoots();
ck("G-4 无覆盖层时词根与基线等长且同序（改覆盖层不能悄悄改基线）",
  baseRoots.roots.length === ROOTS.length && JSON.stringify(baseRoots.roots) === JSON.stringify(ROOTS),
  `${baseRoots.roots.length} vs ${ROOTS.length}`);
const ov1 = resolveRoots({ overlay: {
  schema: OVERLAY_SCHEMA, added: [{ root: "silicone mat", group: "kitchen" }],
  removed: [ROOTS[0]], renamed: [],
} });
ck("G-4 added 生效且带对了分组", ov1.roots.includes("silicone mat") && ov1.groups.some((g) => g.roots.includes("silicone mat")));
ck("G-4 removed 生效（删掉的词根真的不在了）", !ov1.roots.includes(ROOTS[0]));
const both = resolveRoots({ overlay: {
  schema: OVERLAY_SCHEMA, added: [{ root: ROOTS[1], group: ROOT_TO_GROUP.get(ROOTS[1]) }],
  removed: [ROOTS[1]], renamed: [],
} });
ck("🔴 G-4 冲突① removed 优先于 added（同一词根两边都写 → 按删除）",
  !both.roots.includes(ROOTS[1]) && both.notes.some((n) => /按删除处理|removed 优先/.test(n)),
  JSON.stringify(both.notes));
const badOv = resolveRoots({ overlay: {
  schema: OVERLAY_SCHEMA,
  added: [{ root: "BAD UPPER", group: "kitchen" }, { root: "ok lowercase", group: "kitchen" }],
  removed: ["this-root-does-not-exist-at-all"],
  renamed: [{ from: "not-there", to: ROOTS[2] }],
} });
ck("G-4 非法词根 / 删不存在的 / 改名 from 不存在 → 全进 rejected 且 notes 有说明（不静默）",
  badOv.rejected.length >= 3 && badOv.notes.length >= 3,
  `rejected=${badOv.rejected.length} notes=${badOv.notes.length}`);
ck("G-4 部分成功：非法项被拒但合法项仍然生效", badOv.roots.includes("ok lowercase"));
const broken = resolveRoots({ overlay: "{ this is not json" });
ck("🔴 G-4 覆盖层 JSON 损坏 → 退回基线 + 说明，不抛异常中断采集",
  broken.roots.length === ROOTS.length && broken.notes.some((n) => /按基线跑|读不出来/.test(n)),
  JSON.stringify(broken.notes));
const idem = resolveRoots({ overlay: { schema: OVERLAY_SCHEMA, added: [ROOTS[0]], removed: [], renamed: [] } });
ck("G-4 冲突③ added 已存在 = 幂等成功（不重复、不报错）",
  idem.roots.filter((r) => r === ROOTS[0]).length === 1 && idem.rejected.length === 0);

const bigSnap = emptySnapshot("US");
bigSnap.keywords = Array.from({ length: 900 }, (_, i) => ({ term: `term-${i}`, rootCount: 1 }));
bigSnap.asins = Array.from({ length: 80 }, (_, i) => ({ asin: `B${String(i).padStart(9, "0")}`, rank: i + 1, group: "kitchen" }));
const before = JSON.stringify(bigSnap);
const bigDigest = digestOf(bigSnap);
ck("P1-3 历史投影 topTerms 上限 800（2135 词只投 400 会把回归词算成新增）",
  bigDigest.topTerms.length === 800 && bigDigest.topTerms.every((x) => Array.isArray(x) && x.length === 2));
ck("P1-3 asinRanks 每类 ≤30（防单份摘要膨胀）",
  Object.values(bigDigest.asinRanks).every((list) => list.length <= 30) && bigDigest.asinRanks.kitchen.length === 30);
ck("P1-3 digestOf 不修改入参（深比较）", JSON.stringify(bigSnap) === before);
ck("P1-3 单份投影 < 40KB（104 份约 3.6MB，不能悄悄涨成 40MB）",
  Buffer.byteLength(JSON.stringify(bigDigest)) < 40 * 1024, String(Buffer.byteLength(JSON.stringify(bigDigest))));

const ranksA = { A: [["B01ABCDEFG", 1], ["B02ABCDEFG", 2]] };
const ranksB = { A: [["B02ABCDEFG", 3], ["B04ABCDEFG", 1]] };
const ad = diffAsins(ranksA, ranksB);
ck("S-4 diffAsins 三个集合算对（新进 / 掉出 / 留榜）",
  JSON.stringify(ad.entered) === JSON.stringify(["B04ABCDEFG"]) &&
  JSON.stringify(ad.left) === JSON.stringify(["B01ABCDEFG"]) &&
  JSON.stringify(ad.moved) === JSON.stringify(["B02ABCDEFG"]), JSON.stringify(ad));
ck("🔴 S-4 三集合互不重叠，且并集 = 两快照并集（不是凑三个数组）",
  ad.entered.every((x) => !ad.left.includes(x) && !ad.moved.includes(x)) &&
  ad.left.every((x) => !ad.moved.includes(x)) &&
  ad.entered.length + ad.left.length + ad.moved.length === ad.counts.union);
ck("S-4 名次变化单独记，不把「留榜」当「变动」",
  ad.rankChanges.length === 1 && ad.rankChanges[0].delta === 1 && ad.counts.changed === 1);
ck("S-4 缺一侧投影时给 ok:false + null，不编 0",
  diffAsins(null, ranksB).ok === false && diffAsins(null, ranksB).entered === null);

const cmpNoPrev = compareSnapshots(bigSnap, null);
ck("🔴 S-3 没有上一份时 ok:false + 三个集合 null（「新增 0」会被误读成「本周没变化」）",
  cmpNoPrev.ok === false && cmpNoPrev.delta.newTerms === null &&
  cmpNoPrev.delta.returnedTerms === null && cmpNoPrev.delta.droppedTerms === null);
const prevSnap = emptySnapshot("US");
prevSnap.keywords = [{ term: "term-0", rootCount: 1 }, { term: "gone-term", rootCount: 1 }];
const cmp = compareSnapshots(bigSnap, prevSnap);
ck("S-3 有上一份时 ok:true，且算出新增与掉出",
  cmp.ok === true && cmp.delta.newTerms.includes("term-1") && cmp.delta.droppedTerms.includes("gone-term"),
  JSON.stringify(cmp.delta).slice(0, 160));

const siteEnv = { ...process.env, LISTING_KEYWORDS: fs.mkdtempSync(path.join(os.tmpdir(), "clx-kw-site-")) };
ck("🔴 P1-2 不传 site 时产物名仍是 latest.json（旧断言与旧快照都依赖它）",
  path.basename(latestPath(siteEnv)) === "latest.json");
ck("P1-2 显式 site 时按站分文件（latest-DE.json）",
  path.basename(latestPath(siteEnv, "DE")) === "latest-DE.json" &&
  path.basename(latestPath(siteEnv, "de")) === "latest-DE.json");
const histDir = path.join(siteEnv.LISTING_KEYWORDS, "history");
fs.mkdirSync(histDir, { recursive: true });
const d1 = "2026-11-08";
const p1 = nextHistoryPath(siteEnv, null, d1);
ck("P2#5 同日第一次 → YYYY-MM-DD.json", path.basename(p1) === `${d1}.json`);
fs.writeFileSync(p1, "{}");
const p2 = nextHistoryPath(siteEnv, null, d1);
ck("P2#5 同日第二次 → -2（不覆盖上一次）", path.basename(p2) === `${d1}-2.json`);
fs.writeFileSync(p2, "{}");
ck("P2#5 同日第三次 → -3", path.basename(nextHistoryPath(siteEnv, null, d1)) === `${d1}-3.json`);
try { fs.rmSync(siteEnv.LISTING_KEYWORDS, { recursive: true, force: true }); } catch { /* ignore */ }

/* ── 8. 词面契约 ───────────────────────────────────────────── */

console.log("\n8. 词面契约：别把「建议词」说成「搜索量」");
const vaultSrc = fs.readFileSync(path.join(HERE, "assets", "keyword-vault.js"), "utf8");
ck("vault 的注释里说明了 rootCount/hits 与热度无关",
  /跟热度无关|与(搜索)?热度无关|不是热度/.test(vaultSrc));
const serverSrc = fs.readFileSync(path.join(HERE, "server.mjs"), "utf8");
ck("接口 note 明写「不含搜索量」", /不含搜索量/.test(serverSrc));
ck("接口对「没有词库」返回 200 + ok:false（404 会让前端当成网络故障）",
  /ok:\s*false[\s\S]{0,200}reason/.test(serverSrc) || /reason: r\.reason/.test(serverSrc));

console.log(`\n${"—".repeat(60)}`);
console.log(`共 ${pass + fail} 条断言：通过 ${pass}，失败 ${fail}`);
fail += checkAssertCount("keywords-selftest", pass + fail);
if (fail === 0) console.log("全部通过 ✓");
process.exit(fail ? 1 : 0);
