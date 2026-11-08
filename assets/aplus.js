/**
 * A+ 内容模块骨架（P2-1）。
 *
 * 定位：A+ 是**品牌备案之后**才有的板块，很多人卡在「打开编辑器，三栏空白，不知道先写哪句」。
 * 这里给的是三块模块的**结构与写作预算 + 配图提示词**，不是可直接提交的模块代码，
 * 也不生成图片 —— 后台的模块编辑器只认它自己的字段，任何"导出即上传"的说法都是假的。
 *
 * 🔴 三条边界（界面与文档都必须照这个说）：
 *   1. 下面的字数预算是**本工具的建议值**，用来防"一句话写 400 字"。平台各模块字段的
 *      硬限制以**模块编辑页当前显示的计数**为准，本文件不冒充官方值。
 *   2. 只做骨架与自检，**不调用任何模型**：没有 API Key 也能用，断网也能用。
 *   3. A+ 里的文字同样受 Listing 的合规约束（促销语、保证性疗效、贬低竞品、他人商标）。
 *      所以自检直接复用 listing.js 的 PROMO_WORDS / CLAIM_WORDS / BAD_SYMBOLS，
 *      **不另写第二份词表** —— 两份词表迟早会分叉，然后一处判红一处判绿。
 */

import { PROMO_WORDS, CLAIM_WORDS, BAD_SYMBOLS, findHtmlMarkers, matchWords } from "./listing.js";

/** 写作预算：我们的建议值，不是平台硬限制。改这里 = 改全站口径。 */
export const APLUS_BUDGET = {
  headline: 40,
  sub: 70,
  body: 300,
  cardTitle: 30,
  cardBody: 80,
  cell: 40,
};

export const APLUS_NOTE =
  "字数预算是本工具的建议值（防一句话写太长），平台各模块的硬限制以模块编辑页显示的计数为准。";

/**
 * 三块模块的定义。`slots` 是逐字段骨架，`cards` / `rows` 是结构化块的维度。
 * `why` 写"为什么需要这块"，因为 A+ 最常见的浪费是把三块写成同一件事说三遍。
 */
export const APLUS_MODULES = [
  {
    id: "brandStory",
    name: "品牌故事（Brand Story）",
    where: "A+ 内容管理器 → 品牌故事（通常显示在详情页顶部轮播）",
    why: "回答「你是谁、为什么做这个」。它不承担参数说明 —— 参数留给对比表与模块网格。",
    slots: [
      { key: "headline", label: "标题", budget: APLUS_BUDGET.headline, hint: "品牌 + 一句立场，别写公司简介" },
      { key: "sub", label: "副标题", budget: APLUS_BUDGET.sub, hint: "把立场落到具体做法上" },
      { key: "body", label: "正文", budget: APLUS_BUDGET.body, hint: "3 句以内：做什么 / 怎么做 / 对买家意味着什么" },
    ],
    cards: 3,
    imageSpec: "三张等尺寸卡片图（后台按 1:1 或 3:2 裁剪，以编辑器提示为准）",
  },
  {
    id: "compare",
    name: "对比表（Comparison Table）",
    where: "A+ 模块 → 对比表（最多 6 列）",
    why: "把「我这款和别的型号差在哪」一次说清，减少来回翻详情页。它也是**最容易出事**的模块：口径不一致或贬低竞品都会被投诉。",
    slots: [
      { key: "headline", label: "表头标题", budget: APLUS_BUDGET.headline, hint: "例：选对型号，一张表看清" },
    ],
    rows: ["核心用途", "关键规格", "材质 / 成分", "适用场景", "包装内容", "售后与保修"],
    cols: 6,
    imageSpec: "每列一张白底产品图（后台统一裁切，比例不一致会显得歪）",
  },
  {
    id: "grid",
    name: "模块网格（图 + 文）",
    where: "A+ 模块 → 标准三图 / 图文模块",
    why: "把三条卖点各配一张图。它的作用是「让不看字的人也能懂」，所以每格只讲一件事。",
    slots: [],
    cards: 3,
    cardSlots: [
      { key: "title", label: "小标题", budget: APLUS_BUDGET.cardTitle, hint: "一个卖点，不要塞两个" },
      { key: "body", label: "说明", budget: APLUS_BUDGET.cardBody, hint: "场景 + 结果，不写形容词堆砌" },
    ],
    imageSpec: "三张同风格实拍 / 场景图（同一光线与背景，避免像三家店拼的）",
  },
];

/** 对比表里绝不能出现的表述：价格与时效类信息会过期，贬低竞品会被投诉。 */
export const APLUS_FORBIDDEN = [
  { id: "price", re: /(?:[$€£¥]\s?\d|\d+\s?%?\s*(?:off|discount|deal|coupon)|free shipping|免运费|包邮|立减|到手价)/i, why: "A+ 里写价格 / 折扣 / 运费会随活动过期，且属于促销信息", fix: "删掉价格与促销，把「值不值」交给参数与场景" },
  { id: "rival", re: /(?:better than|unlike|superior to|beat(?:s)?\s+(?:the\s+)?competitor|比\S{0,6}更好|秒杀|吊打|完胜)/i, why: "贬低竞品是明确的高风险表述，对比表只做事实并列", fix: "改成中性并列：写自己的参数，不评价对方" },
  { id: "rank", re: /(?:#\s?1\b|best[-\s]?sell(?:er|ing)|top[-\s]?rated|销量第一|全网第一)/i, why: "排名 / 畅销类表述需要可核验依据，A+ 里放这类话风险高于收益", fix: "删掉，或改成可核验的具体事实（如材质、认证编号）" },
  { id: "absolute", re: /\b(?:100%|never|always|guaranteed)\b|永久|绝对|100%有效/i, why: "绝对化承诺无法兑现，也属于保证性用语", fix: "给出条件与边界：在什么情况下、到什么程度" },
];

const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
const cut = (s, n) => {
  const t = clean(s);
  return t.length <= n ? t : t.slice(0, Math.max(0, n - 1)) + "…";
};

/** 从卖点里挑第一句当"核心利益"，挑不到就返回空串（不编）。 */
function coreBenefit(features) {
  const list = (Array.isArray(features) ? features : String(features || "").split(/\n/))
    .map(clean)
    .filter((x) => x.length >= 4);
  return list[0] || "";
}

/** 按模块生成一张配图提示词。英文写给模型，中文注释给人看。 */
function imagePromptFor(moduleId, { name, material, scene }) {
  const subject = name || "the product";
  const mat = material ? `, ${material}` : "";
  const sc = scene ? `, ${scene}` : "";
  const tail = "photorealistic, soft daylight, no text, no watermark, no third-party logos, leave clean copy space";
  if (moduleId === "brandStory") {
    return `Brand story hero: ${subject}${mat} on a minimal workbench${sc}, three-quarter angle, shallow depth of field, warm neutral palette, ${tail}`;
  }
  if (moduleId === "compare") {
    return `Consistent product lineup shot: ${subject}${mat}, identical background and lighting across all columns, centered, front view, plain light-grey backdrop, ${tail}`;
  }
  return `In-use scene: ${subject}${mat} being used${sc}, hands in frame without face, natural light, lived-in but tidy setting, ${tail}`;
}

/**
 * 生成 A+ 骨架。
 *
 * @param {object} input
 *   brand / name / features / bullets / material / scene
 * @returns {{modules:Array, missing:string[], checks:Array, note:string, budgetNote:string}}
 */
export function buildAplusPlan(input = {}) {
  const brand = clean(input.brand);
  const name = clean(input.name);
  const features = (Array.isArray(input.features) ? input.features : String(input.features || "").split(/\n/))
    .map(clean)
    .filter(Boolean);
  const bullets = (Array.isArray(input.bullets) ? input.bullets : String(input.bullets || "").split(/\n/))
    .map(clean)
    .filter(Boolean);
  const benefit = coreBenefit(features.length ? features : bullets);

  const missing = [];
  if (!brand) missing.push("品牌名 —— 品牌故事没有它就只能是空壳");
  if (!name) missing.push("产品名 —— 所有模块的配图提示词都要它");
  if (!features.length && !bullets.length) missing.push("卖点 / 五点 —— 模块网格与对比维度都从它派生");

  const pending = (label) => `【${label}待填】`;

  const modules = APLUS_MODULES.map((m) => {
    const slots = (m.slots || []).map((s) => {
      let text = "";
      if (s.key === "headline" && m.id === "brandStory") {
        text = brand ? `${brand}：${cut(benefit || "把一件事做扎实", APLUS_BUDGET.headline - brand.length - 1)}` : `${pending("品牌名")}：${cut(benefit || "把一件事做扎实", 20)}`;
      } else if (s.key === "sub" && m.id === "brandStory") {
        text = benefit ? `我们不堆功能，只把「${cut(benefit, 40)}」这件事做到可验证。` : pending("一句话立场");
      } else if (s.key === "body" && m.id === "brandStory") {
        text = features.length
          ? `从${cut(features[0] || benefit, 24)}出发，${cut(features[1] || "每一处细节都为日常使用让路", 40)}。${features[2] ? cut(features[2], 40) : "你拿到手就能感到差别。"}`
          : pending("三句话：做什么 / 怎么做 / 对买家意味着什么");
      } else if (s.key === "headline" && m.id === "compare") {
        text = "选对型号，一张表看清";
      }
      return { ...s, text: cut(text, s.budget), len: clean(text).length, over: clean(text).length > s.budget };
    });

    const cards = Array.isArray(m.cardSlots)
      ? Array.from({ length: m.cards || 3 }, (_, i) => {
          const f = features[i] || bullets[i] || "";
          return {
            index: i + 1,
            title: f ? cut(f, APLUS_BUDGET.cardTitle) : pending(`第 ${i + 1} 格小标题`),
            body: f ? `场景：${cut(f, 24)}；结果：${pending("一句话结果")}` : pending(`第 ${i + 1} 格说明`),
          };
        })
      : undefined;

    return {
      id: m.id,
      name: m.name,
      where: m.where,
      why: m.why,
      slots,
      cols: m.cols,
      rows: m.rows,
      cards,
      imageSpec: m.imageSpec,
      imagePrompt: imagePromptFor(m.id, {
        name,
        material: clean(input.material),
        scene: clean(input.scene),
      }),
      cardImagePrompts: m.id === "grid"
        ? Array.from({ length: m.cards || 3 }, (_, i) => imagePromptFor("grid", {
            name: name ? `${name}（卖点 ${i + 1}：${cut(features[i] || "", 30)}）` : "",
            material: clean(input.material),
            scene: clean(input.scene),
          }))
        : undefined,
    };
  });

  // 自检跑在"已经生成出来的骨架"上：骨架里带进来的卖点如果有促销词，现在就该看见。
  const checks = lintAplusText(
    modules.flatMap((m) => [...m.slots.map((s) => s.text), ...(m.cards || []).flatMap((c) => [c.title, c.body])]).join("\n")
  );

  return {
    modules,
    missing,
    checks,
    note: "这是骨架，不是成品：每个【待填】都要你补真实信息。A+ 的图与文案最终由品牌方在后台提交，本工具不代传。",
    budgetNote: APLUS_NOTE,
  };
}

/**
 * 拼成可粘贴的纯文本（交给设计师 / 代运营 / 自己贴进后台编辑器前先过一遍）。
 * 放在这里而不是 app.js：文案格式也要能被自检断言。
 */
export function aplusToText(plan, meta = {}) {
  if (!plan || !Array.isArray(plan.modules)) return "";
  const head = [
    "A+ 内容模块骨架",
    meta.product || meta.brand ? `产品：${meta.product || "—"}${meta.brand ? ` ｜ 品牌：${meta.brand}` : ""}` : "",
    `说明：${plan.budgetNote}`,
    plan.missing && plan.missing.length ? `还缺：${plan.missing.join("；")}` : "",
    "",
  ].filter(Boolean);

  const body = plan.modules.map((m) => {
    const lines = [`【${m.name}】`, `位置：${m.where}`, `为什么需要：${m.why}`];
    for (const s of m.slots || []) {
      lines.push(`${s.label}（≤${s.budget} 字，当前 ${s.len}）：${s.text || "【待填】"}`);
    }
    if (m.rows && m.rows.length) {
      lines.push(`对比维度（自上而下一行一个）：${m.rows.join(" / ")}`);
      lines.push(`列：本品 + 最多 ${Math.max(0, (m.cols || 6) - 1)} 个竞品（后台最多 6 列，口径必须一致）`);
      lines.push("⚠️ 对比表只做事实并列：不写价格、不写促销、不评价竞品。");
    }
    for (const c of m.cards || []) {
      lines.push(`第 ${c.index} 格：${c.title} —— ${c.body}`);
    }
    if (m.imageSpec) lines.push(`图：${m.imageSpec}`);
    lines.push(`配图提示词：${m.imagePrompt}`);
    if (m.cardImagePrompts) {
      m.cardImagePrompts.forEach((p, i) => lines.push(`  第 ${i + 1} 格：${p}`));
    }
    lines.push("");
    return lines.join("\n");
  });

  const checks = (plan.checks || []).length
    ? ["自检（骨架里已带入的文字）：", ...plan.checks.map((c) => `· ${c.label}：${c.detail} → ${c.fix}`), ""]
    : [];
  return [...head, ...body, ...checks].join("\n").trim() + "\n";
}

/**
 * A+ 文案自检：复用 Listing 的三张词表 + 本文件的高风险表述表。
 * @returns {Array<{id,label,hit,detail,why,fix,source}>}
 */
export function lintAplusText(text) {
  const t = String(text || "");
  if (!t.trim()) return [];
  const out = [];
  // 🔴 用 matchWords（词边界），不用 includes：否则 "best" 会命中 "bestseller" 之外的一切含串，
  //    而 "sale" 会命中 "wholesale" —— A+ 文案里 wholesale 是正常词。
  const promo = matchWords(t, PROMO_WORDS);
  if (promo.length) {
    out.push({
      id: "promo", label: "促销语", hit: true,
      detail: `出现：${promo.slice(0, 5).join(" / ")}`,
      why: "A+ 里的促销信息会随活动过期，过期后就是虚假描述",
      fix: "删掉促销词，把价值放回参数与使用场景",
      source: "与 Listing 质检共用 PROMO_WORDS（单一词表）",
    });
  }
  const claim = matchWords(t, CLAIM_WORDS);
  if (claim.length) {
    out.push({
      id: "claim", label: "保证性 / 疗效表述", hit: true,
      detail: `出现：${claim.slice(0, 5).join(" / ")}`,
      why: "无法兑现的保证与疗效表述是平台高发的下架原因",
      fix: "改成可验证的事实：材质、认证、测试条件",
      source: "与 Listing 质检共用 CLAIM_WORDS（单一词表）",
    });
  }
  const sym = BAD_SYMBOLS.filter((s) => t.includes(s));
  if (sym.length) {
    out.push({
      id: "symbol", label: "特殊符号", hit: true,
      detail: `出现：${sym.join(" ")}`,
      why: "装饰性符号在 A+ 排版里会被吞掉或错位，也容易被判为标题党",
      fix: "用普通标点",
      source: "与 Listing 质检共用 BAD_SYMBOLS",
    });
  }
  // findHtmlMarkers 返回**命中的那一段字符串**（没有则空串），不是数组。
  const htmlHit = findHtmlMarkers(t);
  if (htmlHit) {
    out.push({
      id: "html", label: "HTML 标签", hit: true,
      detail: htmlHit,
      why: "A+ 模块不支持任意 HTML，标签会原样显示成字符",
      fix: "删掉标签，只留纯文本",
      source: "listing.js findHtmlMarkers",
    });
  }
  for (const r of APLUS_FORBIDDEN) {
    const m = t.match(r.re);
    if (m) out.push({ id: r.id, label: "A+ 高风险表述", hit: true, detail: `命中「${m[0]}」`, why: r.why, fix: r.fix, source: "A+ 模块规范（价格 / 竞品 / 排名 / 绝对化）" });
  }
  return out;
}
