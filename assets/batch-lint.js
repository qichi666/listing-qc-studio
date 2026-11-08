/**
 * 批量质检（P2-2）：一次粘贴多条 listing → 一张按分数排序的汇总表。
 *
 * 为什么需要它：单条质检回答"这条行不行"，批量质检回答"我 20 条里哪几条最该先改"。
 * 这两个问题的动作完全不同 —— 后者要的是**排序**，不是二十份详情。
 *
 * 🔴 口径边界（界面必须原样交代，否则分数会被当成"整条链接的健康分"）：
 *   批量模式只有标题 + 五点，**没有** Item Highlights / Search Terms / Rufus 字段 / 覆盖度，
 *   所以扣分维度只有「合规 + 标题 + 五点 + 长度预算」，其余维度按权重归一出分。
 *   行与行之间**可比**（同口径），但不能和单条页面上的健康分直接比大小。
 *
 * 🔴 不猜内容：解析不出标题的块报错并跳过，不拿 ASIN 或第一行五点冒充标题。
 */

import { lintListing } from "./listing.js";
import { scoreListing } from "./score.js";
import { toCsv } from "./csv.js";

/** 一次最多几条。超过就报错，不静默截断 —— 静默截断会让人以为全都检了。 */
export const BATCH_MAX = 30;

/** 块分隔线：--- / === / ─── 都认（项目文档里用的是 ─，用户从别处复制过来常是 -）。 */
const SEP = /^\s*[-=─—]{3,}\s*$/;
/** ASIN：优先 B0 开头的标准形态；"ASIN: XXXXXXXXXX" 这种显式标注也认。 */
const ASIN_EXPLICIT = /(?:^|\s)asin\s*[:：]?\s*([A-Z0-9]{10})(?![A-Z0-9])/i;
const ASIN_BARE = /^([B][0-9][A-Z0-9]{8})(?![A-Z0-9])/;
/** 字段标签：标题 / 五点 / 亮点。中英都认，冒号全角半角都认。 */
const LABEL = /^\s*(标题|title|五点|bullets?|亮点|highlights?)\s*[:：]\s*(.*)$/i;
/** 五点行首的项目符号：- • · * 1. 1) 1、 */
const BULLET_MARK = /^\s*(?:[-•·*–—]|\d{1,2}[.)、])\s*/;

/**
 * 把整段粘贴文本切成一条条 listing。
 *
 * 支持的两种写法（都来自真实粘贴习惯）：
 *   ① 纯文本块：第一行标题，其余行五点，块之间用 --- 分隔
 *   ② 带标签：标题：… / 五点：…（可跨多行）
 *
 * @returns {{items:Array, errors:Array<{block:number,reason:string}>}}
 */
export function parseBatch(text) {
  const src = String(text || "").replace(/\r\n?/g, "\n");
  const blocks = [];
  let cur = [];
  for (const line of src.split("\n")) {
    if (SEP.test(line)) {
      blocks.push(cur);
      cur = [];
    } else {
      cur.push(line);
    }
  }
  blocks.push(cur);

  const items = [];
  const errors = [];
  blocks.forEach((lines, bi) => {
    const block = lines.map((l) => l.trim()).filter((l, i, arr) => l || (i > 0 && i < arr.length - 1));
    if (!block.join("").trim()) return; // 空块（末尾分隔线造成）不算错

    let asin = "";
    let title = "";
    let bullets = [];
    let mode = "head";  // head → 还没遇到标题；bullets → 正在收五点
    let sawLabel = false;

    for (const raw of block) {
      const line = raw.trim();
      if (!line) continue;

      const a = line.match(ASIN_EXPLICIT) || line.match(ASIN_BARE);
      if (a && !asin && !title && mode === "head") {
        asin = a[1].toUpperCase();
        // 该行可能只剩 ASIN，也可能 ASIN 后面还跟着标题
        const rest = line.replace(a[0], "").replace(/^[\s:：-]+/, "").trim();
        if (!rest) continue;
        if (!LABEL.test(rest)) { title = rest; mode = "bullets"; continue; }
      }

      const m = line.match(LABEL);
      if (m) {
        sawLabel = true;
        const key = m[1].toLowerCase();
        const val = (m[2] || "").trim();
        if (/^(标题|title)$/.test(key)) { title = val; mode = "bullets"; }
        else if (val) bullets.push(val.replace(BULLET_MARK, ""));
        else mode = "bullets";
        continue;
      }

      if (!title && mode === "head") { title = line; mode = "bullets"; continue; }
      if (!sawLabel || mode === "bullets") bullets.push(line.replace(BULLET_MARK, ""));
    }

    bullets = bullets.map((b) => b.trim()).filter(Boolean);
    const index = items.length + 1;

    if (!title) {
      errors.push({ block: bi + 1, reason: "这一块没有标题（第一行被当成标题，但它是空的）" });
      return;
    }
    if (title.length < 10) {
      errors.push({ block: bi + 1, reason: `标题只有 ${title.length} 个字符，像是只贴了 ASIN 或标签 —— 已跳过，避免误报` });
      return;
    }
    items.push({
      index, block: bi + 1, asin,
      title,
      bullets,
      label: asin || `#${index}`,
      notes: bullets.length < 3 ? [`只有 ${bullets.length} 条五点，正常是 5 条 —— 缺的字段会让部分规则跳过`] : [],
    });
  });

  if (items.length > BATCH_MAX) {
    return {
      items: [],
      errors: [{ block: 0, reason: `一次最多 ${BATCH_MAX} 条（当前 ${items.length} 条）。请分批粘贴 —— 这里不做静默截断，免得你以为全都检了` }],
    };
  }
  // 重复 ASIN 提示（不是错误：同一 ASIN 的两版文案对比是合法用法）
  const seen = new Map();
  for (const it of items) {
    if (!it.asin) continue;
    if (seen.has(it.asin)) it.notes.push(`ASIN 与第 ${seen.get(it.asin)} 条重复 —— 当作两版文案对比处理`);
    else seen.set(it.asin, it.index);
  }
  return { items, errors };
}

/**
 * 逐条质检 + 打分。
 *
 * @param {string} text 粘贴内容
 * @param {{lang?:string, media?:boolean}} ctx 与单条质检同一套上下文
 */
export function batchLint(text, ctx = {}) {
  const { items, errors } = parseBatch(text);
  const rows = items.map((it) => {
    const listing = { title: it.title, bullets: it.bullets, highlights: "", searchTerms: "", description: "" };
    const lint = lintListing(listing, ctx);
    const score = scoreListing({ lint, listing });
    const hits = (lint.results || []).filter((r) => r.status === "命中");
    const pHits = hits.filter((r) => r.level === "P");
    const firstFix = score.top3 && score.top3[0];
    return {
      index: it.index,
      asin: it.asin,
      label: it.label,
      title: it.title,
      bullets: it.bullets.length,
      score: score.score,
      grade: score.grade,
      pHits: pHits.length,
      cHits: hits.length - pHits.length,
      pRuleIds: pHits.map((r) => r.id),
      conclusion: lint.conclusion,
      topFix: firstFix ? `${firstFix.ruleId} ${firstFix.fix || firstFix.why}` : "",
      notes: it.notes,
      scoredWeight: score.scoredWeight,
      skippedWeight: score.skippedWeight,
    };
  });

  // 排序：有硬规则命中的排前面（这才是"先改哪条"），其次分低的在前。
  // 🔴 不能只按分数排：一条 92 分但命中 P1（标题超限）的链接，比 78 分全是软规则的更急。
  const sorted = rows.slice().sort((a, b) => {
    if (Boolean(a.pHits) !== Boolean(b.pHits)) return a.pHits ? -1 : 1;
    const sa = a.score == null ? 999 : a.score;
    const sb = b.score == null ? 999 : b.score;
    return sa - sb || a.index - b.index;
  });

  const scored = rows.filter((r) => r.score != null);
  const summary = {
    count: rows.length,
    scored: scored.length,
    withP: rows.filter((r) => r.pHits > 0).length,
    avg: scored.length ? Math.round(scored.reduce((n, r) => n + r.score, 0) / scored.length) : null,
    worst: sorted.find((r) => r.score != null) || null,
    best: scored.length ? scored.slice().sort((a, b) => b.score - a.score)[0] : null,
    scoredWeight: rows.length ? rows[0].scoredWeight : 0,
    skippedWeight: rows.length ? rows[0].skippedWeight : 0,
    errors,
  };

  return {
    rows: sorted,
    summary,
    note: `批量模式只判「标题 + 五点」能判的维度（合规 / 标题 / 五点 / 长度预算，权重 ${summary.scoredWeight}/100），`
      + `缺 Item Highlights、Search Terms、Rufus 字段与覆盖度，这 ${summary.skippedWeight} 分权重按归一口径不计入。`
      + "所以：行与行之间可比，**不要**拿这里的分数和单条页面的健康分比大小。",
  };
}

/** 汇总表导出（交给 Excel 排优先级用）。公式注入防护在写文件那一步才开。 */
export function batchCsv(rows) {
  return toCsv(rows, [
    { key: "label", label: "ASIN/序号" },
    { key: "title", label: "标题" },
    { key: "score", label: "分数" },
    { key: "grade", label: "档位" },
    { key: "pHits", label: "硬规则命中" },
    { key: "cHits", label: "软规则命中" },
    { key: "pRuleIds", label: "命中的硬规则" },
    { key: "conclusion", label: "结论" },
    { key: "topFix", label: "第一优先修改" },
  ], { guard: true });
}
