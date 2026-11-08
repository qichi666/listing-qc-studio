/**
 * 评论（VOC）本地分析 —— 把"能看见的评论"变成"能写进文案的判断"。
 *
 * 为什么值得做：
 *   竞品分析工具卖的最贵的一块就是"评论痛点"。但这件事并不需要联网：
 *   卖家在前台本来就能看到评论，书签脚本抓下来、本地做聚类，就够了。
 *   而且比第三方工具更可信 —— 抓的是**你眼前这 20 条**，不是某个数据库里的旧快照。
 *
 * 🔴 三条边界（写死在返回值的 limits 里，界面必须显示）：
 *   1. 只分析**已抓到的样本**。亚马逊前台默认 10 条/页、且"最有帮助"排序带偏，
 *      所以这不是全量评论，更不能当"满意度"用。
 *   2. 聚类是**词表匹配**，不是语义模型：它只会认出词表里有的方面（尺寸/耐用/噪音…），
 *      认不出的长尾就只看得到词频线索。词表在 REVIEW_ASPECTS 里，可以直接改。
 *   3. **不推断原因**。评论说"太吵"，工具不会替你猜是电机还是水泵；
 *      它只负责把「哪一类抱怨出现在多少条、平均几星」摆出来。
 *
 * 设计上刻意"同一套词表两种情感"：一个方面（比如 size）在低星评论里出现 = 痛点，
 * 在高星评论里出现 = 卖点。这比维护两份词表更不容易走样，也更符合评论的真实写法
 * （"fits perfectly" 和 "doesn't fit" 用的是同一个词）。
 */

import { matchWords, mineKeywords } from "./listing.js";

/** 低于这个样本量只出"线索"，不给百分比结论。 */
export const REVIEW_SAMPLE_MIN = 5;
/** 单次最多分析多少条（书签脚本也只抓这么多，保持一致）。 */
export const REVIEW_MAX = 20;

/** 评论文本里可以识别的"方面"。改这张表就是改工具的能力边界。 */
export const REVIEW_ASPECTS = [
  {
    id: "size", label: "尺寸 / 适配",
    terms: ["too small", "too big", "too large", "too tight", "too loose", "smaller than", "larger than",
      "doesn't fit", "didn't fit", "does not fit", "doesn’t fit", "did not fit", "runs small", "run small",
      "runs large", "run large", "true to size", "off size", "wrong size",
      "尺寸", "偏小", "偏大", "太小", "太大", "不合身", "不合适", "尺码"],
  },
  {
    id: "durability", label: "耐用度",
    terms: ["broke", "broken", "cracked", "fell apart", "falling apart", "stopped working", "quit working",
      "died after", "cheaply made", "flimsy", "durable", "durability", "lasted", "wore out", "worn out",
      "坏了", "断了", "裂了", "不耐用", "掉色", "褪色", "用了几天", "用不久"],
  },
  {
    id: "quality", label: "做工 / 材质",
    terms: ["quality", "material", "thin", "cheap", "flimsy", "stitching", "finish", "well made",
      "做工", "材质", "质感", "塑料感", "粗糙", "毛边", "手感"],
  },
  {
    id: "function", label: "功能 / 效果",
    terms: ["works great", "works well", "doesn't work", "didn't work", "does not work", "not work",
      "useless", "effective", "ineffective", "works",
      "好用", "不好用", "没用", "有效", "效果", "管用"],
  },
  {
    id: "ease", label: "使用 / 安装",
    terms: ["easy to use", "difficult to use", "hard to use", "confusing", "instructions", "manual",
      "setup", "set up", "assemble", "assembly", "install", "installation",
      "使用", "安装", "说明", "复杂", "难用", "上手", "装不上"],
  },
  {
    id: "clean", label: "清洁 / 气味",
    terms: ["easy to clean", "hard to clean", "wash", "dishwasher", "stain", "odor", "smell", "smells",
      "清洁", "清洗", "异味", "味道", "难洗", "掉毛", "沾灰"],
  },
  {
    id: "portability", label: "重量 / 便携",
    terms: ["heavy", "too heavy", "lightweight", "weight", "bulky", "portable", "travel", "compact",
      "太重", "很重", "轻便", "便携", "体积", "占地方", "小巧"],
  },
  {
    id: "noise", label: "噪音",
    terms: ["noisy", "noise", "loud", "quiet", "silent",
      "噪音", "很吵", "吵", "安静", "静音"],
  },
  {
    id: "battery", label: "电池 / 续航",
    terms: ["battery", "batteries", "charge", "charging", "rechargeable", "lasts long",
      "电池", "续航", "充电", "电量"],
  },
  {
    id: "leak", label: "密封 / 漏",
    terms: ["leak", "leaked", "leaking", "spill", "spilled", "seal", "sealed",
      "漏水", "漏", "密封", "洒"],
  },
  {
    id: "packaging", label: "包装 / 物流",
    terms: ["packaging", "package", "arrived damaged", "damaged", "box was", "broken in transit",
      "包装", "破损", "压坏", "物流", "到货"],
  },
  {
    id: "value", label: "性价比",
    terms: ["good value", "value for money", "worth", "worth it", "expensive", "overpriced", "cheap",
      "性价比", "价格", "贵", "不值", "划算"],
  },
  {
    id: "look", label: "外观 / 颜色",
    terms: ["color", "colour", "looks", "appearance", "beautiful", "ugly",
      "颜色", "色差", "外观", "好看", "丑"],
  },
  {
    id: "gift", label: "送礼场景",
    terms: ["gift", "present", "gifted",
      "送礼", "礼物", "送人"],
  },
];

/** 疑问句的引导词（英文）+ 标点判定（中英通用）。 */
const Q_START = /^(can|could|does|do|is|are|will|would|should|how|what|where|when|why|which|anyone|has|have|did)\b/i;

/**
 * 星级要单独解析：`"5.0 out of 5 stars"` 直接剥非数字字符会得到 `"5.05"`（5.0 + 5），
 * 于是 5.05 > 5 被判成非法 → null —— 一条有星级的评论被当成"没星级"。
 * 这里只取**第一个**数字。
 */
const ratingOf = (v) => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const m = /(\d+(?:\.\d+)?)/.exec(String(v));
  return m ? Number(m[1]) : null;
};

/**
 * 把一条评论归一成固定形状。字段名兼容书签脚本、手贴 JSON、以及"从 HTML 里抠出来"的三种来源。
 * 评不出星级的条目仍然保留（正文有用），但 `rating:null` 不参与星级均值。
 */
export function normalizeReview(raw = {}, index = 0) {
  const rating = ratingOf(raw.rating != null ? raw.rating : raw.stars);
  const body = String(raw.body || raw.text || raw.content || "").replace(/\s+/g, " ").trim();
  const title = String(raw.title || raw.headline || "").replace(/\s+/g, " ").trim();
  return {
    id: String(raw.id || raw.reviewId || `r${index + 1}`),
    rating: rating != null && rating >= 0 && rating <= 5 ? rating : null,
    title,
    body,
    date: String(raw.date || "").trim(),
    vine: Boolean(raw.vine) || /vine customer review/i.test(String(raw.badge || "")),
    variant: String(raw.variant || raw.format || "").trim(),
    verified: raw.verified === undefined ? null : Boolean(raw.verified),
  };
}

/** 从任意粘贴物里取出评论数组：`{kind:"reviews", reviews:[…]}` / `{reviews:[…]}` / 直接是数组。 */
export function reviewsFromPayload(payload) {
  if (Array.isArray(payload)) return payload.map(normalizeReview);
  if (!payload || typeof payload !== "object") return [];
  const arr = Array.isArray(payload.reviews) ? payload.reviews
    : Array.isArray(payload.items) && payload.kind === "reviews" ? payload.items
      : [];
  return arr.map(normalizeReview);
}

const sentences = (text) => String(text || "")
  .split(/(?<=[.!?。！？])\s+|\n+/)
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * 分析评论。
 *
 * @param {Array} reviews  原始评论（会被 normalize）
 * @param {object} [opts]
 * @param {string} [opts.asin]  仅用于回显
 * @param {number} [opts.max]   最多分析多少条，默认 REVIEW_MAX
 * @returns {object} 见文件末尾
 */
export function analyzeReviews(reviews, opts = {}) {
  const max = Number(opts.max) > 0 ? Number(opts.max) : REVIEW_MAX;
  const list = (Array.isArray(reviews) ? reviews : [])
    .map((r, i) => (r && r.id && "body" in r ? r : normalizeReview(r, i)))
    .slice(0, max);

  const sampleSize = list.length;
  const rated = list.filter((r) => r.rating != null);
  const avgRating = rated.length ? Math.round((rated.reduce((n, r) => n + r.rating, 0) / rated.length) * 10) / 10 : null;
  const ratingDist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of rated) ratingDist[Math.round(r.rating)] = (ratingDist[Math.round(r.rating)] || 0) + 1;
  const lowStar = rated.filter((r) => r.rating <= 3).length;
  const withBody = list.filter((r) => r.body).length;

  // 每条的全文（标题 + 正文）：只在正文里出现的抱怨也算，因为很多差评标题是空的。
  const textOf = (r) => `${r.title} ${r.body}`.trim();

  const clusters = [];
  for (const aspect of REVIEW_ASPECTS) {
    const hits = list.filter((r) => matchWords(textOf(r), aspect.terms).length > 0);
    if (!hits.length) continue;
    const hitsRated = hits.filter((r) => r.rating != null);
    const pain = hits.filter((r) => r.rating != null && r.rating <= 3);
    const praise = hits.filter((r) => r.rating != null && r.rating >= 4);
    clusters.push({
      id: aspect.id,
      label: aspect.label,
      mentions: hits.length,
      painCount: pain.length,
      praiseCount: praise.length,
      avgRating: hitsRated.length
        ? Math.round((hitsRated.reduce((n, r) => n + r.rating, 0) / hitsRated.length) * 10) / 10
        : null,
      // 低星提及的平均星级：比"所有提及的平均"更能说明这条抱怨有多硬
      // （同一个方面既有人夸也有人骂时，混算会得到 4 星这种看起来不像抱怨的数）。
      painAvg: pain.length
        ? Math.round((pain.reduce((n, r) => n + r.rating, 0) / pain.length) * 10) / 10
        : null,
      sampleIds: hits.slice(0, 4).map((r) => r.id),
      // 🔴 原话必须来自**对应情感**的那几条：一个方面既有 5 星夸、也有 2 星骂时，
      //    痛点行里贴一句「easy to clean」是最典型的自相矛盾（截图时当场发现）。
      quotes: (pain.length ? pain : hits).slice(0, 2).map((r) => {
        const s = sentences(r.body).find((x) => matchWords(x, aspect.terms).length > 0) || r.body || r.title;
        return String(s || "").slice(0, 140);
      }).filter(Boolean),
      // 好评那一侧单独留一份，供"把夸的点搬进五点"时引用（界面暂不展示，但别丢）
      praiseQuotes: praise.slice(0, 2).map((r) => {
        const s = sentences(r.body).find((x) => matchWords(x, aspect.terms).length > 0) || r.body || r.title;
        return String(s || "").slice(0, 140);
      }).filter(Boolean),
      // 提到该方面的评论里，低星占比 —— 比"平均星级"更能说明"这功能到底招不招骂"
      painShare: hits.length ? Math.round((pain.length / hits.length) * 100) : null,
    });
  }

  // 痛点：低星提及数多的在前；同数量时低星平均星级低的在前（更可能是硬伤）。
  const painClusters = clusters
    .filter((c) => c.painCount > 0)
    .sort((a, b) => b.painCount - a.painCount || (a.painAvg ?? 9) - (b.painAvg ?? 9))
    .slice(0, 6);
  // 好评簇：4–5 星里被提到的方面，按提及数排 —— 这些词可以直接搬进五点。
  const praiseClusters = clusters
    .filter((c) => c.praiseCount > 0)
    .sort((a, b) => b.praiseCount - a.praiseCount)
    .slice(0, 6);

  // 高频疑问：评论里真有人问的问题（说明详情页没答），去重后按出现次数排。
  const qMap = new Map();
  for (const r of list) {
    for (const s of sentences(`${r.title}。${r.body}`)) {
      const isQ = /[?？]/.test(s) || Q_START.test(s);
      if (!isQ || s.length < 8) continue;
      const key = s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff?？]+/g, " ").trim();
      if (!key) continue;
      const cur = qMap.get(key) || { text: s.slice(0, 120), count: 0, ids: [] };
      cur.count += 1;
      if (cur.ids.length < 3) cur.ids.push(r.id);
      qMap.set(key, cur);
    }
  }
  const questions = [...qMap.values()].sort((a, b) => b.count - a.count).slice(0, 8);

  // 词频线索：只当线索，不当"关键词建议"。评论里的高频词有很多是抱怨词本身。
  const corpus = list.map((r) => `${r.title} ${r.body}`).join("\n");
  const mined = corpus
    ? mineKeywords(corpus, { top: 24, minCount: 2, includeNgrams: true, lang: opts.lang || "" }).terms
      .map((x) => ({ term: x.term, weight: x.weight, words: x.words }))
    : [];

  const reliability = sampleSize < REVIEW_SAMPLE_MIN
    ? { level: "insufficient", why: `样本只有 ${sampleSize} 条（<${REVIEW_SAMPLE_MIN}），只出线索，不给比例结论` }
    : sampleSize < 20
      ? { level: "signal", why: `样本 ${sampleSize} 条：能看出方向，不足以代表整体满意度` }
      : { level: "ok", why: `样本 ${sampleSize} 条：可作方向性判断，仍不是全量评论` };

  const topPain = painClusters[0];
  const conclusion = sampleSize === 0
    ? "没有评论样本，无法分析。"
    : painClusters.length === 0
      ? `这 ${sampleSize} 条评论里没有识别出明确的抱怨簇（词表判定，不是"没有差评"）。`
      : `最集中的抱怨是「${topPain.label}」：${topPain.painCount} 条低星提到，平均 ${topPain.painAvg ?? "—"} 星`
        + (painClusters[1] ? `；其次是「${painClusters[1].label}」（${painClusters[1].painCount} 条）。` : "。");

  return {
    asin: String(opts.asin || "").trim() || null,
    sampleSize,
    withBody,
    ratedCount: rated.length,
    avgRating,
    ratingDist,
    lowStarShare: rated.length ? Math.round((lowStar / rated.length) * 100) : null,
    painClusters,
    praiseClusters,
    questions,
    keywordCandidates: mined,
    reliability,
    conclusion,
    limits: [
      `只分析抓到的 ${sampleSize} 条，不是全量评论；亚马逊前台默认按「最有帮助」排序，天然带偏。`,
      "聚类靠词表匹配（REVIEW_ASPECTS），词表里没有的方面识别不出来；词频只是线索，不是关键词建议。",
      "不推断原因、不预测销量或转化。看到「噪音」就以为是电机，是分析者自己加的戏。",
    ],
  };
}

/**
 * 返回形状（字段只增不改）：
 * {
 *   asin, sampleSize, withBody, ratedCount, avgRating, ratingDist:{1..5}, lowStarShare,
 *   painClusters:[{id,label,mentions,painCount,praiseCount,avgRating,painAvg,painShare,sampleIds,quotes,praiseQuotes}],
 *   praiseClusters:[同形状],
 *   questions:[{text,count,ids}],
 *   keywordCandidates:[{term,weight,words}],
 *   reliability:{level:"insufficient"|"signal"|"ok", why},
 *   conclusion, limits:[string]
 * }
 */
