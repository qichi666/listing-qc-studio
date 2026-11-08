/**
 * Rufus / Alexa 信息架构检查 —— 规则引擎（准入层）。
 *
 * 与 listing.js 的 28 条「引用层」质检并列：这里查的是「能不能被纳入结构化比对」——
 *   字段有没有空 / 跨字段事实有没有自相矛盾 / 同一事实有没有两种单位制 /
 *   买家高频问题有没有答案 / 图里的字有没有文本化。
 *
 * 三条纪律（违反即失真）：
 *   1. 数据与逻辑分离：本文件不写死任何属性 key、问题句、单位词，一律从 rufus-data.js 读。
 *   2. 出处分两档：sourceTier ∈ {"official","practitioner"}，只由 tierOf() 一处映射；
 *      未知档位码必须抛异常，绝不静默归为 official。
 *      证据引用串随档不同（帮助文档正文 / 模板列名与 schema），不共用笼统的「亚马逊官方文档」。
 *   3. 分级保守：R 组出厂默认 C 级；唯 R1 的 required 档、且守卫字段 source === "amazon-guide" 者可判 P。
 *      跨字段一致性 / 单位制 / 图内文字都是从业者口径，报「发布前必须修改」就是撒谎。
 *
 * 返回结构与 lintListing 同构：results[i] = { id, group, level, scope, status, detail, why, source, sourceTier }，
 *   status ∈ {"命中","通过","通过（部分）","跳过"}，summary = { total, hit, hitP, hitC, skipped, byGroup, conclusion }。
 */

import { CATEGORY_ATTRIBUTES, CATEGORY_QUESTIONS, MATERIAL_CONFLICTS, NUMBER_UNIT_RE } from "./rufus-data.js";
import {
  hasContent, fieldTexts, textCorpus, extractFacts, materialConflicts, uncoveredImageText,
  attrFilled, coveredKeys, judgeCoverage,
} from "./rufus-facts.js";

// R4 覆盖判定的真源在事实层（纯判定）；这里透出同名入口，供 QA / UI 从规则层直接取用。
export { keyClassHints, judgeCoverage } from "./rufus-facts.js";

/**
 * 命名口径 + 能力边界。
 *
 * 🔴 两件事必须写死在代码里，因为它们在**界面和文档里都会被反复引用**：
 *   ① 名字：亚马逊 2025 年起把购物助手收到 Alexa+ 品牌下，Rufus 这个旧名仍被卖家广泛使用。
 *      本项目两个名字都认，但**不宣称**"Rufus 与 Alexa+ 功能完全等同" —— 那是没有依据的等价声明。
 *      官方更名公告的原文没有拿到，所以 sourceTier 如实标"待核实"。
 *   ② 边界：这是一个**基于公开规范与帮助文档的启发式检查**，不是官方评分，也不预测排名。
 *      它只回答一句话：按公开规则，这份 listing 有没有明显不具备"被结构化比对"的条件。
 *      不写这句，用户很容易把"跑完了没红"当成"平台会给流量"。
 */
export const RUFUS_NAMING = {
  current: "Rufus / Alexa for Shopping",
  aliases: ["Rufus", "Alexa for Shopping", "Alexa+"],
  note: "2025 年起亚马逊把购物助手逐步收进 Alexa+ 品牌，Rufus 这个旧名仍被卖家与工具广泛使用。本项目两个名字都认，指的是同一类**购物助手信息架构**能力；但不做「Rufus 与 Alexa+ 功能完全等同」的断言 —— 官方更名公告原文未取得。",
  sourceTier: "行业通行叫法（媒体 / 卖家社区）；官方命名变更原文未取得 → 待核实",
  boundary: "本模块是基于公开字段规范与帮助文档的**启发式准入检查**，不是亚马逊官方评分，也不预测排名或流量。它只回答一件事：按公开规则，这份 listing 有没有明显不具备「被结构化比对」的条件。",
};

/* ─────────────────── 出处分级：唯一映射点 ─────────────────── */

const TIER_OF = { "amazon-guide": "official", "amazon-schema": "official", practitioner: "practitioner" };

/** 数据层三值 source → 规则层两档 sourceTier。未知值抛异常，不静默归为 official。 */
export function tierOf(source) {
  const t = TIER_OF[source];
  if (!t) throw new Error(`未知 source 档位：${source}`);
  return t;
}

// 证据引用串随档不同（硬约束）：模板列名不许说成帮助文档正文、更不许说成笼统的「官方文档」。
const SOURCE_REF = {
  "amazon-guide": "Amazon Seller Central 帮助文档正文（《Attributes guide》/《目录属性规范化》）",
  "amazon-schema": "Amazon Flat File 模板列名 / SP-API Product Type Definition schema 字段名 / 后台表单字段名",
  practitioner: "行业通行，无官方明文",
};

export function sourceRef(source) {
  const r = SOURCE_REF[source];
  if (!r) throw new Error(`未知 source 档位：${source}`);
  return r;
}

// 判 P 的唯一结构条件（SPEC §4.4 / AC-06）：守卫字段落在 required 档且 source 为官方帮助文档正文。
const P_ELIGIBLE_SOURCE = "amazon-guide";

const uniq = (arr) => [...new Set(arr)];
const attrSources = (tier) => Object.values(CATEGORY_ATTRIBUTES).flatMap((d) => d[tier].map((e) => e.source));
const weakestTier = (srcs) => {
  const tiers = uniq(srcs.map(tierOf));
  return tiers.length === 1 ? tiers[0] : "practitioner"; // 宁低不许高
};
const refOf = (srcs) => uniq(srcs.map(sourceRef)).join("；");

/* ─────────────────── 规则表 ─────────────────── */

export const RUFUS_GROUPS = [
  { id: "R1", name: "attributes 完整性" },
  { id: "R2", name: "跨字段事实一致性" },
  { id: "R3", name: "单位制一致性" },
  { id: "R4", name: "买家问题覆盖矩阵" },
  { id: "R5", name: "图内文字未文本化" },
];

// 产品类型 → 属性表。三种落空都返回 skip 原因，绝不抛异常、绝不在空表上乱叫。
function categoryDef(ctx) {
  const pt = ctx && ctx.productType;
  if (!pt) return { why: "未选择产品类型（ctx.productType），无法定位属性表" };
  const def = CATEGORY_ATTRIBUTES[pt];
  if (!def) return { why: `无该产品类型的属性表：${pt}` };
  return { def };
}

const missingOf = (listing, def, tier) => def[tier].filter((e) => !attrFilled(listing, e));
const labelList = (arr) => arr.map((e) => `${e.label}（${e.key}）`).join("、");

/** R4 条目按问题展开：每个问题一条结果，id 为 R4-01…R4-0n（组内连续、全表唯一）。 */
function coverageResults(rule, listing, ctx, empty) {
  const pt = ctx && ctx.productType;
  const questions = pt ? CATEGORY_QUESTIONS[pt] : null;
  const base = (id, status, detail) => ({
    id, group: rule.group, level: rule.level, scope: rule.scope,
    status, detail, why: rule.why, source: rule.source, sourceTier: rule.sourceTier,
  });
  if (!questions) {
    const why = pt ? `无该产品类型的问题矩阵：${pt}` : "未选择产品类型（ctx.productType），无法定位问题矩阵";
    return [base(rule.id, "跳过", why)];
  }
  const covered = empty ? new Set() : coveredKeys(listing, pt);
  return questions.map((q, i) => {
    const id = `${rule.group}-${String(i + 1).padStart(2, "0")}`;
    if (empty) return base(id, "跳过", "整张表一个字段都没填，无从检查");
    const v = judgeCoverage(q, pt, covered);
    // 来源标记：让「已覆盖」能说清是结构化属性（详情表会渲染）还是文案里提到（不然 R4 读起来像复述 R1）。
    const attrN = v.covered.filter((x) => x.via === "attribute").length;
    const textN = v.covered.filter((x) => x.via === "text").length;
    const note = `已覆盖 ${v.covered.length}/${v.total}（属性 ${attrN} / 文本 ${textN}）`;
    const detail =
      v.status === "命中"
        ? `没有答案句：${q.question}` + (v.uncovered.length ? `（未覆盖 ${v.uncovered.join("、")}）` : "")
        : v.status === "通过（部分）"
          ? `部分覆盖，仍缺线索：${v.uncovered.join("、")}（${note}）（问题：${q.question}）`
          : v.status === "跳过"
            ? `无可用判据，仅作线索（问题：${q.question}）`
            : `已有答案（${note}）（问题：${q.question}）`;
    return {
      ...base(id, v.status, detail),
      why: q.why || rule.why,
      source: sourceRef(q.source || "practitioner"),
    };
  });
}

export const RUFUS_RULES = [
  {
    id: "R1-01",
    group: "R1",
    level: "P",
    scope: "attributes",
    why: "官方明文要求必填的字段空着，商品进不了结构化比对，也进不了最细的浏览分类。",
    source: refOf(attrSources("required")),
    sourceTier: weakestTier(attrSources("required")),
    test(listing, ctx) {
      const { def, why } = categoryDef(ctx);
      if (!def) return { status: "跳过", detail: why, level: "C" };
      const miss = missingOf(listing, def, "required");
      const eligible = miss.every((e) => e.source === P_ELIGIBLE_SOURCE);
      if (!miss.length) return { status: "通过", detail: "required 字段均已填写", level: eligible ? "P" : "C" };
      return {
        status: "命中",
        detail: `缺失 ${miss.length} 个必填字段：${labelList(miss)}`,
        level: eligible ? "P" : "C",
        source: refOf(miss.map((e) => e.source)),
        sourceTier: weakestTier(miss.map((e) => e.source)),
      };
    },
  },
  {
    id: "R1-02",
    group: "R1",
    level: "C",
    scope: "attributes",
    why: "推荐字段不填不致命，但会让买家问题没有答案、让商品在筛选里消失。",
    source: refOf(attrSources("recommended")),
    sourceTier: weakestTier(attrSources("recommended")),
    test(listing, ctx) {
      const { def, why } = categoryDef(ctx);
      if (!def) return { status: "跳过", detail: why };
      const miss = missingOf(listing, def, "recommended");
      if (!miss.length) return { status: "通过", detail: "recommended 字段均已填写" };
      return {
        status: "命中",
        detail: `缺失 ${miss.length} 个推荐字段：${labelList(miss)}`,
        source: refOf(miss.map((e) => e.source)),
        sourceTier: weakestTier(miss.map((e) => e.source)),
      };
    },
  },
  {
    id: "R2-01",
    group: "R2",
    level: "C",
    scope: "facts",
    why: "同一 listing 里两处说两个互斥材质（如标题纯棉、描述纯涤纶），Rufus 会在比对阶段降权。",
    source: "行业通行口径：材质/成分互斥词对 + 混纺语境词（guards），字段级窗口、逐对判定，无官方明文。",
    sourceTier: weakestTier(MATERIAL_CONFLICTS.map((c) => c.source)),
    test(listing) {
      const fields = fieldTexts(listing);
      if (fields.length < 2) return { status: "跳过", detail: "文本字段不足两个，无法做跨字段比对" };
      const hits = materialConflicts(fields);
      if (!hits.length) return { status: "通过", detail: "未发现跨字段材质冲突" };
      return {
        status: "命中",
        detail: hits.map((h) => `材质冲突：${h.a} 与 ${h.b}（见 ${uniq(h.labels).join("、")}）`).join("；"),
      };
    },
  },
  {
    id: "R2-02",
    group: "R2",
    level: "C",
    scope: "facts",
    why: "标题说 2 件、五点说 3 件这类件数自相矛盾，是最常见的退货诱因之一。",
    source: "行业通行口径：件数事实（pack of N / set of N 等）跨字段取差，无官方明文。",
    sourceTier: "practitioner",
    test(listing) {
      const fields = fieldTexts(listing);
      if (fields.length < 2) return { status: "跳过", detail: "文本字段不足两个，无法做跨字段比对" };
      const counts = fields.flatMap((f) =>
        extractFacts(f.text)
          .filter((x) => x.kind === "count")
          .map((x) => ({ value: x.value, raw: x.raw, label: f.label })),
      );
      if (counts.length < 2) return { status: "跳过", detail: "未提取到两个以上的件数事实，无法比对" };
      if (uniq(counts.map((c) => c.value)).length <= 1) return { status: "通过", detail: "件数事实一致" };
      return { status: "命中", detail: `件数不一致：${counts.map((c) => `${c.raw}（${c.label}）`).join("、")}` };
    },
  },
  {
    id: "R3-01",
    group: "R3",
    level: "C",
    scope: "units",
    why: "同一维度（如重量）在 listing 里同时用英制与公制表述，比价与规格比对会取到互相打架的数值。",
    source: "行业通行口径：单位制一致性（UNIT_GROUPS），同一单位组内判定。官方只要求填单位，未要求跨字段统一，无官方明文。",
    sourceTier: weakestTier([NUMBER_UNIT_RE.source]),
    test(listing) {
      // 只取「非歧义」单位：长度 ≤2 且不在白名单的 token（in/g/w/mm/cm/ft…）不参与判定。
      const measures = fieldTexts(listing).flatMap((f) =>
        extractFacts(f.text).filter((x) => x.kind === "measure" && x.system && !x.ambiguous),
      );
      if (!measures.length) {
        return { status: "跳过", detail: "未提取到可判定的数值与单位（长度 ≤2 的歧义单位不参与判定）" };
      }
      // 判定窗口 = 同一 UNIT_GROUPS 组内。跨组（如重量 lb 与尺寸 cm）是不同维度，报它就是猜。
      const groups = new Map();
      for (const m of measures) {
        if (!groups.has(m.groupId)) groups.set(m.groupId, []);
        groups.get(m.groupId).push(m);
      }
      const conflicts = [];
      for (const list of groups.values()) {
        const imperial = list.filter((m) => m.system === "imperial");
        const metric = list.filter((m) => m.system === "metric");
        if (imperial.length && metric.length) conflicts.push({ label: list[0].groupLabel, imperial, metric });
      }
      if (!conflicts.length) return { status: "通过", detail: "单位制一致（同一维度组内未出现英制与公制并存）" };
      return {
        status: "命中",
        detail: conflicts
          .map((c) => `${c.label} 组内英制与公制并存：英制 ${uniq(c.imperial.map((m) => m.raw)).join("、")}；公制 ${uniq(c.metric.map((m) => m.raw)).join("、")}`)
          .join("；"),
      };
    },
  },
  {
    // perQuestion：本条目按该 productType 的问题矩阵展开为 R4-01…R4-0n，不产生自身的单条结果。
    id: "R4-01",
    group: "R4",
    level: "C",
    scope: "coverage",
    perQuestion: true,
    why: "买家高频问题在 listing 里找不到答案，Rufus 就没有可引用的句子，只能去别家找。",
    source: "行业通行口径：问题清单由评论 / Q&A / 客服收件箱归纳，无官方问题清单；覆盖判据见 ADR §R4。",
    sourceTier: "practitioner",
  },
  {
    id: "R5-01",
    group: "R5",
    level: "C",
    scope: "imageText",
    why: "规格 / 兼容性 / 成分 / 尺码只印在图上，机器读不到，等于这些信息不存在。",
    source: "项目自定义口径：只比对 ctx.imageText 与文本字段，不做 OCR，无官方明文。",
    sourceTier: "practitioner",
    test(listing, ctx) {
      const img = ctx && ctx.imageText;
      if (!String(img == null ? "" : img).trim()) {
        return { status: "跳过", detail: "未提供 ctx.imageText（本模块不解析图像，不猜图上内容）" };
      }
      const missed = uncoveredImageText(img, textCorpus(fieldTexts(listing)));
      if (!missed.length) return { status: "通过", detail: "图内文字均已在文本字段出现" };
      return { status: "命中", detail: `图内文字未文本化：${missed.join(" / ")}` };
    },
  },
];

/* ─────────────────── 引擎 ─────────────────── */

function summarize(results) {
  const hit = results.filter((r) => r.status === "命中");
  const byGroup = {};
  for (const g of RUFUS_GROUPS) byGroup[g.id] = { total: 0, hit: 0, pass: 0, partial: 0, skipped: 0 };
  for (const r of results) {
    const b = byGroup[r.group];
    if (!b) continue;
    b.total++;
    if (r.status === "命中") b.hit++;
    else if (r.status === "通过") b.pass++;
    else if (r.status === "通过（部分）") b.partial++;
    else if (r.status === "跳过") b.skipped++;
  }
  for (const b of Object.values(byGroup)) {
    b.covered = b.pass + b.partial; // 已覆盖（含部分）
    b.miss = b.hit;                 // 未覆盖
  }
  const hitP = hit.filter((r) => r.level === "P").length;
  const checked = results.length - results.filter((r) => r.status === "跳过").length;
  return {
    total: results.length,
    hit: hit.length,
    hitP,
    hitC: hit.filter((r) => r.level === "C").length,
    skipped: results.filter((r) => r.status === "跳过").length,
    byGroup,
    conclusion: hitP
      ? "存在硬规则命中，发布前必须修改"
      : hit.length
        ? "硬规则全过，软规则有可优化项"
        : checked === 0
          ? "无可检查项：全部跳过（请先填文案，或选择产品类型）"
          : "全部通过",
  };
}

/**
 * 跑信息架构检查。ctx = { productType, imageText, category, brand }。
 * 整张表一个字都没填时全部跳过（沿用 listing.js 的 hasContent 口径，不在空表上乱叫）。
 */
export function lintRufus(listing = {}, ctx = {}) {
  const empty = !hasContent(listing);
  const results = RUFUS_RULES.flatMap((r) => {
    if (r.perQuestion) return coverageResults(r, listing, ctx, empty);
    let out;
    if (empty) out = { status: "跳过", detail: "整张表一个字段都没填，无从检查" };
    else {
      try {
        out = r.test(listing, ctx) || {};
      } catch (e) {
        out = { status: "跳过", detail: `规则执行异常：${e.message}` };
      }
    }
    const status = out.status || (out.hit ? "命中" : "通过");
    return {
      id: r.id,
      group: r.group,
      level: out.level || r.level,
      scope: r.scope,
      status,
      detail: out.detail || "",
      why: r.why,
      source: out.source || r.source,
      sourceTier: out.sourceTier || r.sourceTier,
    };
  });
  return { results, summary: summarize(results) };
}
