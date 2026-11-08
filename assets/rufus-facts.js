/**
 * Rufus / Alexa 信息架构检查 —— 纯函数事实层。
 *
 * 只做三件事，全部是纯函数（同输入同输出，无 I/O、无时间、无随机、零 node: 依赖）：
 *   1. 把 listing 拆成「可选字段 → 文本」（fieldTexts）与「有没有填过内容」（hasContent）；
 *   2. 从文本里抽事实三元组 <kind, value, unit>（extractFacts），并做单位制归一（unitSystemOf）；
 *   3. 判材质冲突（materialConflicts，字段级窗口 + 逐对 guards）与图内文字覆盖（uncoveredImageText）。
 *
 * 【硬约束】判据一律从 rufus-data.js 读，本文件不写死任何属性 key、问题句或单位词。
 *    例外只有两处「规格常量」（ADR 明文）：单位歧义白名单与 GUARD_STOPLIST —— 它们是规格而非数据。
 * 【硬约束】单位歧义（ADR B3，宁可漏报不可误报）：
 *    · 长度 ≤ 2 的 token 一律不参与单位制判定（`in`/`g`/`w`/`mm` 全是英文里的常用词）；
 *    · 白名单 oz / lb / kg 是英文里无词义碰撞的短单位，照旧参与（32 oz 的范例才成立）；
 *    · °c / °f 先剥掉度数符号再查表，且天然免除歧义判定（不会与「c 是摄氏度还是别的」混淆）。
 */

import { CATEGORY_ATTRIBUTES, NUMBER_UNIT_RE, UNIT_GROUPS, MATERIAL_CONFLICTS } from "./rufus-data.js";
import { hasTerm } from "./listing.js";

const str = (v) => String(v == null ? "" : v);

/* ─────────────────── ① listing 取文本 · 有没有填过内容 ─────────────────── */

/**
 * 一张表有没有「一个字」。口径与 listing.js 的 hasContent 一致：
 * 逐项 trim 后再看有没有非空，而不是看数组长度（["",""] 长度是 2，但那不叫有内容）。
 */
export function hasContent(listing) {
  if (!listing || typeof listing !== "object") return false;
  return Object.values(listing).some((v) => {
    if (Array.isArray(v)) return v.some((x) => str(x).trim());
    if (v && typeof v === "object") return hasContent(v);
    return str(v).trim() !== "";
  });
}

/**
 * 抽出参与跨字段检查的文本字段（标题 / 每条五点 / Item Highlights / 描述）。
 * 返回 [{label, text}]，label 用于命中时点名是哪个字段。
 * 空字段不进数组 —— 上层据此判「字段不足两个就跳过」。
 */
export function fieldTexts(listing) {
  const out = [];
  const push = (label, v) => {
    const t = str(v).trim();
    if (t) out.push({ label, text: t });
  };
  if (!listing || typeof listing !== "object") return out;
  push("title", listing.title);
  const bullets = Array.isArray(listing.bullets) ? listing.bullets : [];
  bullets.forEach((b, i) => push("bullet" + (i + 1), b));
  push("highlights", listing.highlights);
  push("description", listing.description);
  return out;
}

export function textCorpus(fields) {
  return fields.map((f) => f.text).join("\n").toLowerCase();
}

/**
 * 文本里是否以「字段词语形」提到某属性 key（key 的下划线换成空格后按 listing.js 的 hasTerm 边界匹配）。
 * 仅供 R4 的覆盖判定使用；不新建任何词表 —— key 本身就是已有事实。
 */
export function mentionsKey(key, corpus) {
  return hasTerm(str(key).replace(/_/g, " "), corpus);
}

/* ─────────────────── ② 单位提取与单位制归一 ─────────────────── */

// 规格常量（ADR B3）：英文里无词义碰撞的短单位白名单。其余 ≤2 字符 token 一律不参与判定。
export const UNIT_AMBIGUOUS_WHITELIST = ["oz", "lb", "kg"];

/** 单位归一：小写、剥掉度数符号、压平空白。°c / °f 归 temperature 组要靠这一步。 */
export function normalizeUnit(raw) {
  return str(raw).toLowerCase().replace(/°/g, "").replace(/\s+/g, " ").trim();
}

/** 是否为「高危歧义单位」：长度 ≤2 且不在白名单。带 ° 的温度单位天然免除。 */
export function isAmbiguousUnit(unit, raw) {
  if (str(raw).includes("°")) return false;
  return unit.length <= 2 && !UNIT_AMBIGUOUS_WHITELIST.includes(unit);
}

/** 单位落在哪个 UNIT_GROUPS 组里（用同一张表，不另建词表）。 */
export function unitGroupOf(unit) {
  for (const g of UNIT_GROUPS) if (g.units.some((u) => str(u).toLowerCase() === unit)) return g;
  return null;
}

/** 单位制：imperial / metric，归不上类返回 null（不猜）。 */
export function unitSystemOf(unit) {
  const g = unitGroupOf(unit);
  if (!g) return null;
  if (g.imperial.some((u) => str(u).toLowerCase() === unit)) return "imperial";
  if (g.metric.some((u) => str(u).toLowerCase() === unit)) return "metric";
  return null;
}

// 件数标记词（自建，SPEC §2 认可 R2 自带事实抽取）。仅用于「Pack of 2 / set of 3」这类件数事实。
const COUNT_MARKERS = ["pack", "set", "lot", "bundle", "pieces", "piece", "pcs", "count"];
const COUNT_ALT = COUNT_MARKERS.join("|");
const COUNT_PATTERN = "(?:" + COUNT_ALT + ")\\s*(?:of\\s*)?(\\d+)|(\\d+)\\s*[- ]?(?:" + COUNT_ALT + ")\\b";

const NUM = (s) => Number(str(s).replace(/,/g, ""));

function measureFacts(src) {
  const re = new RegExp(NUMBER_UNIT_RE.pattern, NUMBER_UNIT_RE.flags);
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const rawUnit = m[3] || "";
    const unit = normalizeUnit(rawUnit);
    const g = unitGroupOf(unit);
    out.push({
      kind: "measure",
      value: NUM(m[1]),
      upper: m[2] == null ? null : NUM(m[2]),
      unit,
      raw: m[0].trim(),
      groupId: g ? g.id : null,
      groupLabel: g ? g.label : null,
      system: unitSystemOf(unit),
      ambiguous: isAmbiguousUnit(unit, rawUnit),
    });
    if (out.length >= 40) break;
  }
  return out;
}

function countFacts(src) {
  const re = new RegExp(COUNT_PATTERN, "gi");
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const value = NUM(m[1] != null ? m[1] : m[2]);
    if (Number.isFinite(value)) {
      out.push({ kind: "count", value, upper: null, unit: "", raw: m[0].trim(), groupId: null, system: null, ambiguous: false });
    }
    if (out.length >= 40) break;
  }
  return out;
}

/**
 * 事实抽取：从一段文本抽出 <kind, value, unit> 三元组列表。
 * kind = "measure"（数值 + 单位）| "count"（件数）。纯函数，同输入两次调用深相等。
 */
export function extractFacts(text) {
  const src = str(text);
  if (!src) return [];
  return measureFacts(src).concat(countFacts(src));
}

/** 同一事实：kind / value / 归一后单位都相同。用于「32 oz 与 32oz 判同值、32 oz 与 33 oz 判冲突」。 */
export function sameFact(a, b) {
  if (!a || !b) return false;
  return a.kind === b.kind && a.value === b.value && str(a.unit) === str(b.unit);
}

/* ─────────────────── ③ 材质冲突（字段级窗口 + 逐对 guards）─────────────────── */

// 规格常量（ADR §消费约束 3 / G3）：通用连接词 / 标点 / 纯符号，禁止单独构成抑制。
const GUARD_STOPLIST = ["and", "or", "with", "&", "+", "%", "/", ","];
const isContextGuard = (g) => {
  const s = str(g).trim().toLowerCase();
  return s.length >= 3 && !GUARD_STOPLIST.includes(s);
};

// 规格常量（ADR L162 / G4）：唯一否定判据。多词条目按连续词组整体匹配，占窗口的 1 个位置。
const NEGATION_WORDS = ["not", "no", "non", "never", "without", "excluding", "instead of", "rather than", "not made of"];

// 分词：字母数字串，允许词内连字符 / 撇号（non-stick 算一个 token）。
function tokenize(text) {
  const out = [];
  const re = /[a-z0-9]+(?:[-'][a-z0-9]+)*/gi;
  let m;
  while ((m = re.exec(text)) !== null) out.push({ t: m[0].toLowerCase(), start: m.index });
  return out;
}

/**
 * G4 否定窗口：同字段、只向前看、固定回看 ≤2 个 token。
 * 只有命中 NEGATION_WORDS 才撤提及；未定义否定一律视为「未否定」（宁可误报保留，不做静默漏报）。
 */
function isNegatedAt(tokens, i) {
  for (const neg of NEGATION_WORDS) {
    const parts = neg.split(" ");
    if (parts.length > 1) {
      const s = i - parts.length;
      if (s >= 0 && parts.every((p, k) => tokens[s + k].t === p)) return true;
    } else if ((i - 1 >= 0 && tokens[i - 1].t === neg) || (i - 2 >= 0 && tokens[i - 2].t === neg)) {
      return true;
    }
  }
  return false;
}

/**
 * 某词在一段文本里的全部提及区间 [{start,end}]（字符下标，左闭右开）。
 * 【硬约束 G5】边界规则逐字复刻 assets/listing.js:1242 的 hasTerm：
 *   纯字母（可含空格 / 连字符）走词边界正则，其余走 includes。
 *   故 `termRanges(t, s).length > 0` 恒等于 `hasTerm(t, s)`（由等价性断言锁死，listing.js 不改）。
 */
export function termRanges(term, text) {
  const t = str(text);
  const needle = str(term).trim();
  if (!t || !needle) return [];
  const lower = t.toLowerCase();
  const n = needle.toLowerCase();
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bounded = /^[a-z0-9]/i.test(needle) && /[a-z0-9]$/i.test(needle);
  const out = [];
  if (bounded) {
    const re = new RegExp(`(^|[^a-z0-9])${esc}(?![a-z0-9])`, "g");
    let m;
    while ((m = re.exec(lower)) !== null) {
      const start = m.index + m[1].length;
      out.push({ start, end: start + n.length });
      if (re.lastIndex <= m.index) re.lastIndex = m.index + 1;
    }
  } else {
    let i = lower.indexOf(n);
    while (i !== -1) {
      out.push({ start: i, end: i + n.length });
      i = lower.indexOf(n, i + n.length);
    }
  }
  return out;
}

// 两个区间是否重叠（同一字段内才用得上）
const overlaps = (x, y) => x.start < y.end && y.start < x.end;

// 两个术语是否有词形包含关系（leather ⊂ faux leather）。同字段配对是否成立要看它。
const containsTerm = (x, y) => {
  const a = str(x).toLowerCase();
  const b = str(y).toLowerCase();
  return a.includes(b) || b.includes(a);
};

/**
 * 材质冲突判定。**逐字段管线，顺序不可换**（ADR §消费形状 B2 + G4/G5/G6）：
 *   ① G4 否定撤销：本字段内、位于材质词之前 ≤2 个 token 的否定词 → 撤该次提及；
 *   ② G5 归并：**本字段内**相交的 a/b 提及，保留更长术语、被包含者删
 *      （`Faux Leather` 里的 `leather` 是 `faux leather` 的一部分，同一次提及不算两个材质）；
 *   ③ 该字段 guard 清空：本字段出现该对 guard 任一语境词 → 本字段提及整体作废（不跨字段救场）。
 *      这是缺陷 A 的修正方向：曾反着做（guard 命中即压掉整对），结果 title 的真冲突被
 *      description 的 guard 压掉 —— 故收敛为「字段级二值」，代价见下。
 *      注：已知漏报边界（SPEC §8 第 12 条，勿当 bug 修）。strap/cover/shell/sole/legs/collar
 *      等词在许多品类就是商品本体而非部件，故 title "Leather Belt" + description "Faux Leather Strap"
 *      实测漏报 []。不收窄的理由：若改成「仅同字段并存两种材质才抑制」，则合法表述
 *      title "Wool Coat" + description "Acrylic lining"（主体羊毛 / 里料腈纶）会变误报；
 *      按「误报不可接受、漏报可接受」保留现状，QA 已加断言钉住两侧行为。
 *   ④ G6 配对：a 侧与 b 侧各有存活提及，且二者**来自不同字段**；
 *      同字段内只有「两个术语互为词形包含」的对（如 leather / faux leather）才算两次独立提及 ——
 *      否则同一字段里并列的两个材质词（`Wool Acrylic`、`60% Cotton 40% Polyester`）是同一件东西的
 *      复合描述，不是跨字段不一致，报它就是猜。
 * fields: [{label, text}]；返回 [{a, b, note, source, labels}]。
 */
export function materialConflicts(fields) {
  const hits = [];
  for (const c of MATERIAL_CONFLICTS) {
    const sameFieldOk = containsTerm(c.a, c.b);
    const aliveA = [];
    const aliveB = [];
    fields.forEach((f, i) => {
      const tokens = tokenize(f.text);
      const at = new Map(tokens.map((tk, k) => [tk.start, k]));
      const keep = (r) => {
        const k = at.get(r.start);
        return k === undefined || !isNegatedAt(tokens, k);
      };
      const rawA = termRanges(c.a, f.text).filter(keep);
      const rawB = termRanges(c.b, f.text).filter(keep);
      if (!rawA.length && !rawB.length) return;
      if (c.guards.some((g) => isContextGuard(g) && hasTerm(g, f.text))) return;
      const a = rawA.filter((ra) => !(rawB.some((rb) => overlaps(ra, rb)) && c.a.length < c.b.length));
      const b = rawB.filter((rb) => !(rawA.some((ra) => overlaps(ra, rb)) && c.b.length < c.a.length));
      a.forEach((r) => aliveA.push({ ...r, field: i }));
      b.forEach((r) => aliveB.push({ ...r, field: i }));
    });
    const ra = aliveA.find((x) => aliveB.some((y) => x.field !== y.field || (sameFieldOk && !overlaps(x, y))));
    if (!ra) continue;
    const rb = aliveB.find((y) => ra.field !== y.field || (sameFieldOk && !overlaps(ra, y)));
    hits.push({
      a: c.a,
      b: c.b,
      note: c.note,
      source: c.source,
      labels: [...new Set([fields[ra.field].label, fields[rb.field].label])],
    });
  }
  return hits;
}

/* ─────────────────── ④ 字段覆盖判定 与 R4 hint 分类（纯判定，无规则元数据）─────────────────── */

/** 一个值算不算「填过」。数组 / 对象逐项看，字符串 trim 后非空。 */
export function isFilled(v) {
  if (Array.isArray(v)) return v.some((x) => str(x).trim());
  if (v && typeof v === "object") return Object.values(v).some((x) => str(x).trim());
  return str(v).trim() !== "";
}

/** 属性条目是否已填（ADR 裁定 4 的读法层别名）：listing[key] 非空，或 alias 中任一键非空。 */
export function attrFilled(listing, entry) {
  if (isFilled(listing ? listing[entry.key] : undefined)) return true;
  const alias = Array.isArray(entry.alias) ? entry.alias : [];
  return alias.some((k) => isFilled(listing ? listing[k] : undefined));
}

/** key 类 hint = 能在**同 productType** 的属性表里精确匹配到 key 的那些；其余一律只作线索。 */
export function keyClassHints(question, productType) {
  const def = CATEGORY_ATTRIBUTES[productType];
  if (!def) return [];
  const keys = new Set([...def.required, ...def.recommended].map((e) => e.key));
  return (question.answerHints || []).filter((h) => keys.has(h));
}

/**
 * 该问题「已覆盖的 key」→ 来源标记 Map<key, "attribute" | "text">。
 * 口径：属性在 listing 里有非空值（alias 感知，Amazon 详情表会把它渲染出来）→ "attribute"；
 * 否则该 key 的词形出现在文本字段里 → "text"。
 * 两者都算「买家在页面上看得到答案」，但来源要能在明细里分清（否则 R4 读起来像复述 R1）。
 */
export function coveredKeys(listing, productType) {
  const def = CATEGORY_ATTRIBUTES[productType];
  const out = new Map();
  if (!def) return out;
  const corpus = textCorpus(fieldTexts(listing));
  for (const tier of ["required", "recommended"]) {
    for (const e of def[tier]) {
      if (attrFilled(listing, e)) out.set(e.key, "attribute");
      else if (corpus && mentionsKey(e.key, corpus)) out.set(e.key, "text");
    }
  }
  return out;
}

/**
 * R4 覆盖判定（ADR §R4 定稿，逐条照抄；K = key 类 hint，C = 其中已覆盖者）：
 *   K 空 -> 跳过；|K|==1 -> 覆盖即通过、否则命中；
 *   |K|>=2 -> 全未覆盖=命中 / 部分=通过（部分）【独立状态，逐个列出未覆盖 key】/ 全覆盖=通过。
 * 判据是 OR 而非 AND：多条 key hint 是同一事实的几个可能字段，答了任一条即算有答案。
 */
export function judgeCoverage(question, productType, covered) {
  const keyOf = (x) => (typeof x === "string" ? x : x && x.key);
  const has = (k) =>
    covered instanceof Map || covered instanceof Set
      ? covered.has(k)
      : (covered || []).some((x) => keyOf(x) === k);
  // 来源标记：Map 给得出 attribute / text；Set / 数组入参（契约 oracle 用）无来源信息 → unknown。
  const viaOf = (k) => {
    if (covered instanceof Map) return covered.get(k) || "unknown";
    const hit = Array.isArray(covered) ? covered.find((x) => keyOf(x) === k) : null;
    return hit && typeof hit === "object" ? hit.via || "unknown" : "unknown";
  };
  const K = keyClassHints(question, productType);
  const wrap = (status, uncovered) => ({
    status,
    uncovered,
    total: K.length,
    covered: K.filter(has).map((k) => ({ key: k, via: viaOf(k) })),
  });
  if (K.length === 0) return wrap("跳过", []);
  const C = K.filter(has);
  if (K.length === 1) return C.length ? wrap("通过", []) : wrap("命中", K.slice());
  if (C.length === 0) return wrap("命中", K.slice());
  if (C.length === K.length) return wrap("通过", []);
  return wrap("通过（部分）", K.filter((k) => !has(k)));
}

/* ─────────────────── ⑤ 图内文字覆盖（不做 OCR）─────────────────── */

/**
 * ctx.imageText 里有哪些「行」没有在文本字段里出现过。
 * 覆盖判据取宽松侧（任一 token 命中即算这行已文本化）——本模块宁可漏报，不误报。
 * 单字母 token 不参与（SIZE: S/M/L 里的 S/M/L 命中任何含 s 的字都会误判），只留长度 ≥2 的片段。
 */
export function uncoveredImageText(imageText, corpus) {
  const low = str(corpus).toLowerCase();
  const norm = (s) => s.replace(/[.\-_\/]+/g, " ").replace(/\s+/g, " ").trim();
  const lowN = norm(low);
  const lines = str(imageText)
    .split(/[\n\r;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const line of lines) {
    const tokens = (line.match(/[a-z0-9][a-z0-9.\-]{1,}/gi) || []).map((t) => t.toLowerCase());
    if (!tokens.length) continue;
    if (!tokens.some((t) => low.includes(t) || lowN.includes(norm(t)))) out.push(line);
  }
  return out;
}
