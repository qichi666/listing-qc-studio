/**
 * Listing 健康分（**项目自定义**加权分）。
 *
 * 为什么要有这个数：
 *   现有质检只给「26 条里命中 3 条」这种原始计数。会看的人能读出严重程度，
 *   不会看的人只会问一句「那我这链接到底行不行」。健康分就是回答这一句的，
 *   并且**必须**同时给出扣分项 —— 只给分不给原因的分数，比不给分更糟。
 *
 * 🔴 三条不可越过的边界（写在这里，是因为界面文案最容易走样）：
 *   1. 这是**本项目的启发式加权**，不是亚马逊官方评分（官方没有公开的 Listing 分）。
 *   2. 分高**不代表**有流量、有排名、能过审。它只说明「按本工具的规则，没查出明显问题」。
 *   3. 缺数据的维度**不参与计分**（按权重归一），绝不用"假设满分/零分"去凑一个 100 或 0。
 *      —— 「算不出来就给 None」是本项目的既有铁律，分数同样适用。
 *
 * 权重只在这里写一份：界面、报告、MCP 都从这里取，避免三处各写一套比例。
 */

export const SCORE_DISCLAIMER =
  "这是本项目自定义的加权分（权重见下方维度表），不是亚马逊官方评分，也不预测排名、流量或转化。缺数据的维度不参与计分。";

/** 8 个维度 + 权重，合计 100。改权重只改这里。 */
export const SCORE_DIMS = [
  {
    id: "compliance", label: "合规硬门槛", weight: 26,
    hint: "P 级规则：超限、禁用语、站外引流、HTML、特效符号、类目词",
  },
  {
    id: "structure", label: "信息架构", weight: 18,
    hint: "Rufus 准入层：字段齐不齐、事实自不自洽、单位混不混、高频问题有没有答案",
  },
  {
    id: "keywords", label: "关键词覆盖", weight: 14,
    hint: "候选词在标题/五点/描述/后台词的加权覆盖（要先跑一次覆盖度分析）",
  },
  {
    id: "title", label: "标题可读性", weight: 10,
    hint: "C 级标题规则：核心词前置、不堆砌、含规格数字",
  },
  {
    id: "bullets", label: "五点说服力", weight: 10,
    hint: "C 级五点规则：利益导向、结构均匀、有具体参数",
  },
  {
    id: "highlights", label: "Item Highlights", weight: 8,
    hint: "新规第二段：有没有用、有没有和标题重复",
  },
  {
    id: "searchTerms", label: "后台搜索词", weight: 7,
    hint: "有没有填（字节上限与重复词已由 P10/P11 在合规维度计过，这里不重复扣）",
  },
  {
    id: "budget", label: "长度预算", weight: 7,
    hint: "标题 75 / Highlights 125 / 合计 200 的用量是否留了余量",
  },
];

/** 权重校验：改了维度表但权重加起来不是 100 时，自检会红。 */
export const SCORE_TOTAL_WEIGHT = SCORE_DIMS.reduce((n, d) => n + d.weight, 0);

/** 硬规则命中时的封顶分：一票降档，不给"改改措辞还能拿 80"的错觉。 */
export const SCORE_CAP = { score: 55, reason: "存在硬规则（P 级）命中：发布前必须改，分数封顶 55" };

/** 档位。区间左闭右开，最后一段兜底。 */
export const SCORE_GRADES = [
  { min: 90, grade: "A", label: "文本层没查出明显问题" },
  { min: 75, grade: "B", label: "能用，有几处可优化" },
  { min: 60, grade: "C", label: "能传，但会丢点击或转化" },
  { min: 0, grade: "D", label: "先改再传" },
];

export function gradeOf(score) {
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  return SCORE_GRADES.find((g) => score >= g.min) || SCORE_GRADES[SCORE_GRADES.length - 1];
}

/* 单条命中的扣分。只在这里写一份 —— 同一类规则在不同维度里扣不同分，
 * 是"看起来算了、其实凭感觉"的典型来源。 */
const PENALTY = {
  P: 13,            // 硬规则：一条就够呛
  copyC: 4,         // 合规域的软规则（需举证 / 人工确认类）
  Ctitle: 4,
  Cbullets: 3,
  Chighlights: 4,
  default: 3,
};

const round1 = (n) => Math.round(n * 10) / 10;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const str = (v) => String(v == null ? "" : v).trim();
const bytes = (s) => new TextEncoder().encode(String(s || "")).length;

/**
 * @param {object} input
 * @param {{results:Array, summary:object}} input.lint     lintListing 的返回值（必需）
 * @param {{results:Array, summary:object}} [input.rufus]  lintRufus 的返回值
 * @param {{coveragePct?:number, total?:number}} [input.coverage] analyzeCoverage 的返回值
 * @param {object} [input.listing]   {title, bullets, searchTerms, highlights}
 * @param {Array}  [input.fields]    exportListingFields(...).fields（算长度预算用）
 * @returns {object} 见文件底部注释
 */
export function scoreListing(input = {}) {
  const { lint, rufus, coverage, listing = {}, fields } = input;
  const results = Array.isArray(lint && lint.results) ? lint.results : null;

  // 没有质检结果 → 不算分。返回 null 而不是 0：0 会被读成"这链接很烂"。
  if (!results) {
    return {
      score: null,
      grade: null,
      gradeLabel: "",
      dims: SCORE_DIMS.map((d) => ({
        ...d, earned: null, max: d.weight, status: "skipped", basis: "缺少质检结果",
      })),
      deductions: [],
      top3: [],
      scoredWeight: 0,
      skippedWeight: SCORE_TOTAL_WEIGHT,
      cap: null,
      disclaimer: SCORE_DISCLAIMER,
      note: "没有质检结果，算不出分 —— 不给假数字。",
    };
  }

  const hit = results.filter((r) => r.status === "命中");
  const pHits = hit.filter((r) => r.level === "P");
  const deductions = [];
  const dims = [];
  const skipped = [];

  const addDeduction = (r, delta, dim) => {
    deductions.push({
      ruleId: r.id, source: r.source, delta,
      why: r.why || "", fix: r.fix || "", detail: r.detail || "", level: r.level, dim,
    });
  };

  /** 规则型维度：满权重起步，按命中逐条扣，扣到 0 为止。 */
  const ruleDim = (dim, pick, penaltyOf) => {
    const rules = hit.filter(pick);
    let earned = dim.weight;
    for (const r of rules) {
      const delta = penaltyOf(r);
      earned -= delta;
      addDeduction(r, -delta, dim.id);
    }
    earned = clamp(earned, 0, dim.weight);
    dims.push({
      ...dim, earned: round1(earned), max: dim.weight, status: "scored",
      basis: rules.length
        ? `${rules.length} 条命中：${rules.map((r) => r.id).join(" / ")}`
        : "无命中",
    });
  };

  const dimOf = (id) => SCORE_DIMS.find((d) => d.id === id);

  /* ① 合规：所有 P + copy 域的 C（需举证/人工确认类）。 */
  ruleDim(dimOf("compliance"), (r) => r.level === "P" || (r.level === "C" && r.scope === "copy"),
    (r) => (r.level === "P" ? PENALTY.P : PENALTY.copyC));

  /* ② 标题 / ③ 五点 / ④ Highlights：C 级按 scope 归位。 */
  ruleDim(dimOf("title"), (r) => r.level === "C" && r.scope === "title", () => PENALTY.Ctitle);
  ruleDim(dimOf("bullets"), (r) => r.level === "C" && r.scope === "bullets", () => PENALTY.Cbullets);
  ruleDim(dimOf("highlights"),
    (r) => r.level === "C" && (r.scope === "highlights" || r.scope === "titleHighlights"),
    () => PENALTY.Chighlights);

  /* ⑤ 信息架构：Rufus 分组覆盖率（跳过的不算分母，否则"没选产品类型"会被当成不合格）。 */
  const g = dimOf("structure");
  const groups = rufus && rufus.summary && rufus.summary.byGroup;
  if (groups && typeof groups === "object") {
    let judged = 0;
    let covered = 0;
    const emptyGroups = [];
    for (const [gid, b] of Object.entries(groups)) {
      const j = Math.max(0, (b.total || 0) - (b.skipped || 0));
      if (!j) { emptyGroups.push(gid); continue; }
      judged += j;
      covered += Math.min(j, b.covered || 0);
    }
    if (judged > 0) {
      const pct = covered / judged;
      dims.push({
        ...g, earned: round1(g.weight * pct), max: g.weight, status: "scored",
        basis: `已判定 ${judged} 条，覆盖 ${covered} 条（${Math.round(pct * 100)}%）`
          + (emptyGroups.length ? `；${emptyGroups.length} 个分组无已判条目，未计入` : ""),
      });
      // 未覆盖的每条也进扣分清单，让"为什么少这几分"有据可查。
      if (rufus && Array.isArray(rufus.results)) {
        for (const r of rufus.results) {
          if (r.status !== "命中") continue;
          const share = (g.weight * 1) / judged;
          deductions.push({
            ruleId: r.id, source: r.source || "信息架构规则", delta: -round1(share),
            why: r.why || "", fix: "补齐该字段或补上对应答案", detail: r.detail || "",
            level: r.level || "C", dim: g.id,
          });
        }
      }
    } else {
      skipped.push({ id: g.id, why: "信息架构检查全部跳过（未选产品类型或未填文案）" });
    }
  } else {
    skipped.push({ id: g.id, why: "本次没有运行信息架构检查" });
  }

  /* ⑥ 关键词覆盖：必须真的跑过覆盖度分析，否则跳过。 */
  const k = dimOf("keywords");
  if (coverage && Number(coverage.total) > 0 && typeof coverage.coveragePct === "number") {
    const pct = clamp(coverage.coveragePct / 100, 0, 1);
    dims.push({
      ...k, earned: round1(k.weight * pct), max: k.weight, status: "scored",
      basis: `${coverage.covered ?? "—"} / ${coverage.total} 个候选词被覆盖（${coverage.coveragePct}%，按字段权重加权）`,
    });
  } else {
    skipped.push({ id: k.id, why: "没跑覆盖度分析（点一次「关键词覆盖度分析」后重新计算即可参与）" });
  }

  /* ⑦ 后台搜索词：只判"有没有填"。字节与重复词已由 P10/P11 在合规维度扣过，不重复扣。 */
  const s = dimOf("searchTerms");
  const stText = str(listing.searchTerms);
  if (stText) {
    dims.push({ ...s, earned: s.weight, max: s.weight, status: "scored", basis: `已填 ${bytes(stText)} 字节` });
  } else {
    dims.push({ ...s, earned: round1(s.weight * 0.4), max: s.weight, status: "scored", basis: "未填（少一块不占点击位的关键词位）" });
  }

  /* ⑧ 长度预算：有上限的字段里，既没超限也没空的占比。 */
  const b = dimOf("budget");
  const limited = Array.isArray(fields) ? fields.filter((f) => Number(f.limit) > 0) : [];
  if (limited.length) {
    const ok = limited.filter((f) => !f.over && !f.empty);
    const over = limited.filter((f) => f.over);
    dims.push({
      ...b, earned: round1(b.weight * (ok.length / limited.length)), max: b.weight, status: "scored",
      basis: over.length
        ? `超限 ${over.map((f) => f.label || f.field).join(" / ")}`
        : `${ok.length} / ${limited.length} 个字段有内容且未超限`,
    });
  } else {
    skipped.push({ id: b.id, why: "没有字段用量数据" });
  }

  // 维度顺序固定按 SCORE_DIMS，避免"这次少一个维度"导致前端顺序漂移。
  const ordered = SCORE_DIMS.map((d) => dims.find((x) => x.id === d.id)
    || { ...d, earned: null, max: d.weight, status: "skipped", basis: "未参与计分" });

  const scoredWeight = ordered.filter((d) => d.status === "scored").reduce((n, d) => n + d.max, 0);
  const skippedWeight = SCORE_TOTAL_WEIGHT - scoredWeight;
  const raw = scoredWeight > 0
    ? (ordered.reduce((n, d) => n + (d.status === "scored" ? d.earned : 0), 0) / scoredWeight) * 100
    : null;
  let score = raw == null ? null : Math.round(clamp(raw, 0, 100));
  let cap = null;
  if (score != null && pHits.length > 0) {
    if (score > SCORE_CAP.score) {
      score = SCORE_CAP.score;
      cap = { ...SCORE_CAP, before: Math.round(raw) };
    } else {
      cap = { ...SCORE_CAP, before: Math.round(raw), applied: false };
    }
  }
  const grade = gradeOf(score);

  // top3：按扣分绝对值排序，取前三条。没有扣分项时返回空数组（界面照实说"没有扣分项"）。
  const top3 = [...deductions]
    .sort((a, z) => a.delta - z.delta)
    .slice(0, 3)
    .map((d) => ({ ...d }));

  return {
    score,
    grade: grade ? grade.grade : null,
    gradeLabel: grade ? grade.label : "",
    dims: ordered,
    deductions: deductions.sort((a, z) => a.delta - z.delta),
    top3,
    scoredWeight,
    skippedWeight,
    skipped,
    cap,
    disclaimer: SCORE_DISCLAIMER,
    note: score == null
      ? "没有任何维度参与计分，算不出分。"
      : skippedWeight > 0
        ? `有 ${skippedWeight} 分权重因缺数据未参与，当前分数按已计分的 ${scoredWeight} 分权重归一。`
        : "全部维度都参与了计分。",
  };
}

/**
 * 返回形状（供前端 / 报告 / MCP 共用，字段只增不改）：
 * {
 *   score: number|null,            // 0–100；缺数据时 null
 *   grade: "A"|"B"|"C"|"D"|null,
 *   dims: [{id,label,weight,hint,earned,max,status:"scored"|"skipped",basis}],
 *   deductions: [{ruleId,source,delta,why,fix,detail,level,dim}],  // delta 为负数
 *   top3: 同上，最多 3 条，按扣分从大到小,
 *   scoredWeight, skippedWeight, skipped:[{id,why}],
 *   cap: null | {score,reason,before,applied?},
 *   disclaimer, note
 * }
 */
