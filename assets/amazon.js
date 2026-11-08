/**
 * Amazon 商品数据采集层。
 *
 * 为什么不用后端爬虫：
 *   亚马逊有反爬（UA 指纹、验证码、频控），服务端直抓在美国站会被拦，
 *   而且抓到的是"我看到的价格/评价"，与真实用户所见未必一致。
 *   本模块改用两条**用户侧**路径，都不依赖爬虫：
 *     A. 书签脚本（bookmarklet）：在真实商品页一键抽取结构化数据 → 剪贴板 → 粘回工作台。
 *        选择器全部来自两个参考项目的实战代码（见 SELECTORS 注释）。
 *     B. 粘贴页面 HTML / 纯文本：用 DOMParser 离线解析，走同一套选择器。
 *   两者输出同一份 Product 结构，工作台只认这个结构。
 *
 * 站点的标题长度等平台差异用 SITES 表描述，不做"全球一刀切"。
 */

/* ─────────────────────── 选择器（合并两个参考项目）─────────────────────── */
/**
 * 来源标注：
 *   [amzai]  = github.com/liangdiyuan/AMZAIBrowserPlugin  utils/index.ts
 *   [cbr]    = github.com/libowenhemonesy-svg/cross-border-ai
 *              amazon-ai-product-analyzer/content.js
 *   [common] = 两处一致
 */
export const SELECTORS = {
  title: ["#productTitle"],                                   // [common]
  brand: ["#bylineInfo"],                                     // [amzai]
  bullets: [
    "#feature-bullets .a-unordered-list .a-list-item",        // [common] 主路径
    "#productFactsDesktopExpander .a-unordered-list .a-list-item", // [common] 新版页面兜底
  ],
  description: ["#productDescription"],                        // [amzai]
  price: [
    "#corePriceDisplay_desktop_feature_div .a-offscreen",
    "#corePrice_feature_div .a-offscreen",
    ".a-price .a-offscreen",
    "#priceblock_ourprice",
    "#priceblock_dealprice",
  ],
  rating: [
    "#acrPopover .a-icon-alt",                                 // [common]
    "span[data-hook='rating-out-of-text']",
    "#averageCustomerReviews .a-icon-alt",
  ],
  reviewCount: ["#acrCustomerReviewText"],                     // [common]
  image: [
    "#landingImage",                                           // [cbr] 主图
    "#imgTagWrapperId img",
    "#imageBlock img",                                         // [cbr] 兜底
    "img[data-old-hires]",                                     // [cbr] 高清图属性
  ],
  specTables: [
    "#productDetails_expanderTables_depthLeftSections .a-expander-container",  // [amzai]
    "#productDetails_expanderTables_depthRightSections .a-expander-container", // [amzai]
  ],
  breadcrumbs: ["#wayfinding-breadcrumbs_feature_div a"],
  bestSellersRank: ["#SalesRank", "#detailBullets_feature_div"],
  asin: ["#ASIN", "input[name='ASIN']"],
};

/**
 * 各站点的平台差异。
 *
 * `lang` 是**站点主要语种**，不是"标题语言" —— 用途只有一个：
 * 让关键词挖掘套用正确的停用词表（amazon.de 的标题里满篇 mit/für/und，
 * 不套德语表就会把虚词当卖点关键词推给用户）。
 * 它是**提示**不是判定：卖家可以在界面上改。表里没有的站点 = 空串 = 只套英文表。
 *
 * 🔴 `titleLimit` / `titleAdvice` 是**展示用**（站点表上给个参照），
 *    真正参与判定的上限在 `listing.js` 的 `LIMITS.title` / `titleLimit(ctx)` —— 别拿这里当判据。
 *    2026-09-29 更新：2026-07-27 生效的标题新规把口径从 200 砍到 **75（含空格）**，
 *    且它**是全局的**（除 media 外全类目、各站点一致），所以 21 个站点统一成 75 / 70，
 *    不再做"站点差异化" —— 差异化那套在 200 字符时代就没有官方依据，现在更是没有了。
 *    两道口径由回归里的断言锁在一起（`SITES[*].titleLimit === LIMITS.title`），改一处忘另一处会红。
 */
export const SITES = {
  "amazon.com": { label: "美国站", currency: "USD", lang: "", titleLimit: 75, titleAdvice: 70 },
  "amazon.ca": { label: "加拿大站", currency: "CAD", lang: "", titleLimit: 75, titleAdvice: 70 },
  "amazon.co.uk": { label: "英国站", currency: "GBP", lang: "", titleLimit: 75, titleAdvice: 70 },
  "amazon.com.au": { label: "澳大利亚站", currency: "AUD", lang: "", titleLimit: 75, titleAdvice: 70 },
  "amazon.de": { label: "德国站", currency: "EUR", lang: "de", titleLimit: 75, titleAdvice: 70 },
  "amazon.at": { label: "奥地利站", currency: "EUR", lang: "de", titleLimit: 75, titleAdvice: 70 },
  "amazon.fr": { label: "法国站", currency: "EUR", lang: "fr", titleLimit: 75, titleAdvice: 70 },
  "amazon.it": { label: "意大利站", currency: "EUR", lang: "it", titleLimit: 75, titleAdvice: 70 },
  "amazon.es": { label: "西班牙站", currency: "EUR", lang: "es", titleLimit: 75, titleAdvice: 70 },
  "amazon.nl": { label: "荷兰站", currency: "EUR", lang: "nl", titleLimit: 75, titleAdvice: 70 },
  "amazon.com.be": { label: "比利时站", currency: "EUR", lang: "nl", titleLimit: 75, titleAdvice: 70 },
  "amazon.se": { label: "瑞典站", currency: "SEK", lang: "", titleLimit: 75, titleAdvice: 70 },
  "amazon.pl": { label: "波兰站", currency: "PLN", lang: "", titleLimit: 75, titleAdvice: 70 },
  "amazon.co.jp": { label: "日本站", currency: "JPY", lang: "ja", titleLimit: 75, titleAdvice: 70 },
  "amazon.in": { label: "印度站", currency: "INR", lang: "", titleLimit: 75, titleAdvice: 70 },
  "amazon.sg": { label: "新加坡站", currency: "SGD", lang: "", titleLimit: 75, titleAdvice: 70 },
  "amazon.ae": { label: "阿联酋站", currency: "AED", lang: "", titleLimit: 75, titleAdvice: 70 },
  "amazon.sa": { label: "沙特站", currency: "SAR", lang: "", titleLimit: 75, titleAdvice: 70 },
  "amazon.com.mx": { label: "墨西哥站", currency: "MXN", lang: "", titleLimit: 75, titleAdvice: 70 },
  "amazon.com.br": { label: "巴西站", currency: "BRL", lang: "", titleLimit: 75, titleAdvice: 70 },
  "amazon.com.tr": { label: "土耳其站", currency: "TRY", lang: "", titleLimit: 75, titleAdvice: 70 },
};

/** 站点 → 语种（未知站点返回空串 = 只套英文停用词表）。 */
export function siteLang(host) {
  const h = String(host || "").replace(/^www\./, "").toLowerCase();
  return SITES[h]?.lang || "";
}


export function detectSite(url) {
  const host = (() => {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
  })();
  // 表外站点的兜底也用同一套口径（写成 200 会让"没收录的站点"显示一个过时的上限）
  return { host, ...(SITES[host] || { label: host ? "未知站点" : "未知站点", currency: "?", titleLimit: 75, titleAdvice: 70 }) };
}

/* ─────────────────────── HTML 解析 ─────────────────────── */

const ASIN_RE = /(?:\/dp\/|\/gp\/product\/|\/product\/)([A-Z0-9]{10})/i;

function firstMatch(doc, selectors, pick = (el) => el.textContent) {
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    if (el) {
      const v = pick(el);
      if (v != null && String(v).trim() !== "") return String(v).trim();
    }
  }
  return "";
}

function cleanText(s) {
  return String(s || "").replace(/\u200e|\u200f/g, "").replace(/\s+/g, " ").trim();
}

/** 从 HTML 里抽出商品结构。同一套函数同时服务「书签脚本」与「粘贴 HTML」。 */
export function extractFromDoc(doc, url = "") {
  const title = cleanText(firstMatch(doc, SELECTORS.title));

  // 五点：第一个有内容的候选列表
  let bullets = [];
  for (const sel of SELECTORS.bullets) {
    const nodes = [...doc.querySelectorAll(sel)];
    const texts = nodes.map((n) => cleanText(n.textContent)).filter(Boolean);
    if (texts.length) { bullets = texts; break; }
  }

  const description = cleanText(firstMatch(doc, SELECTORS.description));
  const brand = cleanText(firstMatch(doc, SELECTORS.brand, (el) => el.textContent?.replace(/^(Brand:|Visit the |Store:)/i, "")));

  // 主图：优先 data-old-hires（高清原图），否则 src
  let image = "";
  for (const sel of SELECTORS.image) {
    const el = doc.querySelector(sel);
    if (!el) continue;
    const hires = el.getAttribute?.("data-old-hires");
    if (hires && hires.startsWith("http")) { image = hires; break; }
    const src = el.getAttribute?.("src") || "";
    if (src.startsWith("http") && !src.includes("sprite")) { image = src; break; }
  }

  // 规格表：展开容器里的 key-value 表
  const specs = {};
  for (const sel of SELECTORS.specTables) {
    for (const box of doc.querySelectorAll(sel)) {
      const label = cleanText(box.querySelector(".a-expander-prompt")?.textContent);
      const table = box.querySelector(".a-keyvalue.prodDetTable");
      if (!table) continue;
      for (const tr of table.querySelectorAll("tr")) {
        const th = cleanText(tr.querySelector("th")?.textContent);
        const td = cleanText(tr.querySelector("td")?.textContent);
        if (th && td) specs[th] = td;
      }
      if (label && Object.keys(specs).length === 0) specs["_section"] = label;
    }
  }

  const breadcrumbs = [...doc.querySelectorAll(SELECTORS.breadcrumbs[0])].map((a) => cleanText(a.textContent)).filter(Boolean);

  const asin =
    cleanText(firstMatch(doc, SELECTORS.asin, (el) => el.value || el.textContent)) ||
    (ASIN_RE.exec(url || doc.baseURI || "") || [])[1] ||
    "";

  const rankText = cleanText(firstMatch(doc, SELECTORS.bestSellersRank));

  return {
    url: url || doc.baseURI || "",
    site: detectSite(url || doc.baseURI || "").host,
    asin,
    title,
    brand,
    bullets,
    description,
    specs,
    breadcrumbs,
    bestSellersRank: rankText,
    rating: cleanText(firstMatch(doc, SELECTORS.rating)).replace(/out of 5 stars/i, "").trim(),
    reviewCount: cleanText(firstMatch(doc, SELECTORS.reviewCount)).replace(/[^\d,]/g, ""),
    price: cleanText(firstMatch(doc, SELECTORS.price)),
    image,
    capturedAt: new Date().toISOString(),
  };
}

/** 粘贴的 HTML → Product。用 DOMParser，全程离线，不发任何请求。 */
export function extractFromHTML(html) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  const p = extractFromDoc(doc, "");
  p._source = "pasted-html";
  // 粘 HTML 时往往拿不到 baseURI 里的 ASIN，从 canonical 再抓一次
  if (!p.asin) {
    const canonical = doc.querySelector("link[rel='canonical']")?.getAttribute("href") || "";
    p.asin = (ASIN_RE.exec(canonical) || [])[1] || "";
    if (canonical) p.url = canonical;
  }
  return p;
}

/** 纯文本兜底：至少把标题和五点看出来 */
export function extractFromText(text) {
  const raw = String(text || "").trim();
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bullets = [];
  const titleCandidates = [];
  for (const l of lines) {
    if (/^[\-•·*]\s+/.test(l) || /^About this item/i.test(l)) {
      bullets.push(l.replace(/^[\-•·*]\s+/, ""));
    } else if (l.length > 20 && l.length < 260 && !/^(title|about this item|productDescription)\s*:/i.test(l)) {
      titleCandidates.push(l);
    }
  }
  const labelled = /title:\s*\n?([^\n]+)/i.exec(raw);
  return {
    url: "", site: "", asin: "", brand: "",
    title: (labelled?.[1] || titleCandidates[0] || "").trim(),
    bullets: bullets.slice(0, 8),
    description: "", specs: {}, breadcrumbs: [], bestSellersRank: "",
    rating: "", reviewCount: "", price: "", image: "",
    capturedAt: new Date().toISOString(),
    _source: "pasted-text",
  };
}

/**
 * 统一入口：自动判断粘贴的是 HTML / JSON / 纯文本。
 *
 * 返回值有**两种形态**，用 `kind` 区分（前端必须按 kind 分流）：
 *   · 商品详情 → Product 对象（有 title / bullets）
 *   · 搜索结果 → `{ kind: "search", items: [...] }`（没有 title/bullets，但有整页商品）
 * 🔴 用 `kind` 显式分流，而不是让调用方猜"解析出来是不是空的"——
 *    把搜索页载荷交给商品渲染器会渲染出一张空表，用户只会以为是解析失败。
 */
export function extractAny(inputText) {
  const s = String(inputText || "").trim();
  if (!s) throw new Error("粘贴内容为空");
  if (s.startsWith("{")) {
    const obj = JSON.parse(s);
    // 书签脚本在搜索结果页产出的载荷带 kind:"search"
    if (obj && (obj.kind === "search" || Array.isArray(obj.items))) {
      return {
        ...obj,
        kind: "search",
        site: obj.site || "",
        keyword: obj.keyword || "",
        items: obj.items || [],
        stats: obj.stats || { blocks: (obj.items || []).length, parsed: (obj.items || []).length, sponsored: 0, withAsin: 0 },
        note: obj.note || `这是搜索结果页载荷，共 ${(obj.items || []).length} 个商品。⚠️ 搜索页只有标题/价格/评分/评论数，没有五点与描述。`,
        _source: obj._source || "pasted-json-search",
      };
    }
    if (!obj.title && !obj.bullets) throw new Error("JSON 里没有 title / bullets 字段");
    obj._source = "pasted-json";
    return obj;
  }
  if (/<\/?[a-z][\s\S]*>/i.test(s) && /productTitle|feature-bullets|a-container|amazon|s-search-result/i.test(s)) {
    // 页面源码也分两种：搜索结果页与商品详情页的选择器完全不同
    if (detectPageKind(s) === "search") {
      const r = extractSearchResults(s, "");
      return { ...r, _source: "pasted-html-search" };
    }
    return extractFromHTML(s);
  }
  return extractFromText(s);
}

/* ─────────────────────── 书签脚本 ─────────────────────── */

/* ─────────────────────── 搜索结果页批量采集 ───────────────────────
 * 🔴 为什么加这条通道：详情页书签一次只拿 1 个商品，而"对比竞品"至少要 3-5 个 ——
 *    用户就得开 5 个标签页点 5 次书签。但**卖家本来就在看搜索结果页**：
 *    一页 16-24 个商品，一次点击就能拿到整页的标题/价格/评分/评论数/ASIN。
 *
 * 这些函数刻意做成**接受 HTML 字符串的正则解析**（不用 DOM）——
 * 这样 Node 里能用真实 HTML 片段直接断言，而不是只能靠"在浏览器里目测"。
 */

const ENTITY_MAP = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * 只解码**一次** HTML 实体。
 * ⚠️ 不递归解码：`&amp;lt;` 应当解成 `&lt;` 而不是 `<`（否则会把用户数据里的转义吃掉）。
 */
export function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&#(\d+);/g, (_, d) => {
      const n = Number(d);
      return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const n = Number.parseInt(h, 16);
      return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : _;
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (m, n) => ENTITY_MAP[n.toLowerCase()] ?? m);
}

/** 判断这页 HTML 是什么页面 —— 书签脚本靠它决定走哪条采集路径。 */
export function detectPageKind(html) {
  const s = String(html || "");
  if (/data-component-type=["']s-search-result["']/i.test(s)) return "search";
  if (/id=["']productTitle["']/i.test(s) || /id=["']feature-bullets["']/i.test(s)) return "detail";
  return "unknown";
}

function textOf(seg, patterns) {
  for (const re of patterns) {
    const m = re.exec(seg);
    if (m && m[1]) {
      const t = decodeEntities(m[1]).replace(/\s+/g, " ").trim();
      if (t) return t;
    }
  }
  return "";
}

/**
 * 解析亚马逊**搜索结果页**，抽出整页商品列表。
 *
 * @param {string} html 页面源码
 * @param {string} url  可选，用来取站点与搜索词（`?k=`）
 * @returns {{kind, url, site, keyword, items, stats, note}}
 *
 * ⚠️ 诚实边界：搜索页**没有**五点与描述，只有标题/价格/评分/评论数。
 *    做词频与竞品对比够用（标题是关键词密度最高的字段），但**不能**替代详情页采集。
 */
export function extractSearchResults(html, url = "") {
  const src = String(html || "");

  let site = "", keyword = "";
  try {
    const u = new URL(url);
    site = u.hostname.replace(/^www\./, "");
    keyword = u.searchParams.get("k") || u.searchParams.get("field-keywords") || "";
  } catch { /* url 可缺省 */ }

  const empty = { kind: "search", url, site, keyword: decodeEntities(keyword), items: [], stats: { blocks: 0, parsed: 0, sponsored: 0, withAsin: 0 }, note: "" };
  if (!src) return { ...empty, note: "没有输入 HTML。" };

  // 按卡片切块。切完 `parts[0]` 是页头，其余每段开头就是一张卡片。
  const parts = src.split(/data-component-type=["']s-search-result["']/i);
  const blocks = parts.slice(1);

  const items = [];
  const seen = new Set();
  let sponsored = 0, withAsin = 0;

  for (const raw of blocks) {
    // 一张卡片通常 < 15KB；截断可避免尾部串到下一张卡片的内容
    const seg = raw.slice(0, 15000);

    const asin = (/(?:data-asin|data-csa-c-item-id)=["'](?:amzn1\.asin\.)?([A-Z0-9]{10})["']/i.exec(seg) || [])[1] || "";
    const title = textOf(seg, [
      /<h2[^>]*\baria-label=["']([^"']{5,400})["']/i,
      /class=["'][^"']*a-text-normal[^"']*["'][^>]*>([^<]{5,400})</i,
      /<h2[^>]*>[\s\S]{0,300}?<span[^>]*>([^<]{5,400})<\/span>/i,
    ]);
    if (!title && !asin) continue;

    const price = textOf(seg, [
      /class=["']a-offscreen["'][^>]*>([^<]{1,40})</i,
      /class=["'][^"']*a-price-whole[^"']*["'][^>]*>([^<]{1,20})</i,
    ]);
    const rating = textOf(seg, [/([\d.]+)\s*out of 5 stars/i]);
    const reviews = textOf(seg, [
      /aria-label=["']([\d,]+)\s*ratings?["']/i,
      /class=["'][^"']*s-underline-text[^"']*["'][^>]*>([\d,]{2,})</i,
    ]);
    const href = textOf(seg, [/href=["']([^"']*\/dp\/[A-Z0-9]{10}[^"']*)["']/i]);
    const image = textOf(seg, [/class=["'][^"']*\bs-image\b[^"']*["'][^>]*\bsrc=["']([^"']+)["']/i]);
    const isSponsored = /Sponsored|赞助/i.test(seg);

    // 去重放在计数之前 —— 否则同一个商品的重复卡片会把「广告位数量」也刷高。
    const dedupKey = asin || title.toLowerCase();
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    if (isSponsored) sponsored++;
    if (asin) withAsin++;

    items.push({
      asin,
      title,
      price,
      rating: rating ? Number(rating) : null,
      reviewCount: reviews ? Number(String(reviews).replace(/[^\d]/g, "")) || null : null,
      url: href ? (href.startsWith("http") ? href : `https://${site || "www.amazon.com"}${href}`) : "",
      image,
      sponsored: isSponsored,
      /** 标题即"竞品文案"，供词频与覆盖度分析用 */
      text: title,
    });
  }

  return {
    kind: "search",
    url,
    site,
    keyword: decodeEntities(keyword),
    items,
    stats: { blocks: blocks.length, parsed: items.length, sponsored, withAsin },
    note: `解析到 ${items.length} 个商品（页面共 ${blocks.length} 张卡片${
      sponsored ? `，其中 ${sponsored} 个是广告位` : ""
    }）。⚠️ 搜索页**只有标题/价格/评分/评论数**，没有五点与描述 —— 做竞品词频与覆盖度够用，但要完整文案请用详情页采集。`,
  };
}

/** 搜索结果 → 多竞品对比的输入（`[{name, text}]`）。 */
export function searchItemsToCompetitors(items = []) {
  return items
    .filter((it) => it && (it.title || it.text))
    .map((it, i) => ({
      name: it.asin || it.title.slice(0, 24) || `商品 ${i + 1}`,
      text: it.title || it.text || "",
    }));
}

/** 搜索结果 → 一段语料（丢给 mineKeywords / analyzeCoverage 当竞品文本）。 */
export function searchItemsCorpus(items = []) {
  return items.map((it) => it.title || it.text || "").filter(Boolean).join("\n");
}

/** 搜索结果 → 概览统计（前端展示"这一页什么价位、什么评分区间"）。 */
export function searchItemsSummary(items = []) {
  const prices = items.map((it) => {
    const m = /([\d.,]+)/.exec(it.price || "");
    if (!m) return null;
    const n = Number(m[1].replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }).filter((n) => n !== null);
  const ratings = items.map((it) => it.rating).filter((r) => typeof r === "number");
  const reviews = items.map((it) => it.reviewCount).filter((r) => typeof r === "number");
  const stat = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const mid = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
    return { min: s[0], max: s[s.length - 1], median: +mid.toFixed(2), avg: +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2), n: arr.length };
  };
  return {
    total: items.length,
    sponsored: items.filter((it) => it.sponsored).length,
    withAsin: items.filter((it) => it.asin).length,
    price: stat(prices),
    rating: stat(ratings),
    reviewCount: stat(reviews),
  };
}

/**
 * 生成 bookmarket 源码（自包含 IIFE，不依赖本应用任何模块）。
 * 在亚马逊商品页点一下 → 结构化数据进剪贴板 + 弹提示。
 * 之所以用剪贴板而不是 postMessage：跨站脚本无法读取本应用的 window，
 * 而剪贴板是唯一不需要装扩展、不需要 CORS、不需要后端的中转方式。
 */
export function bookmarkletSource() {
  const sel = JSON.stringify(SELECTORS);
  const asinRe = String(ASIN_RE);
  return `(function(){
  var S=${sel};
  function q(s,get){for(var i=0;i<s.length;i++){var e=document.querySelector(s[i]);if(e){var v=get?get(e):e.textContent;if(v&&String(v).trim())return String(v).trim();}}return "";}
  function c(x){return String(x||"").replace(/[\\u200e\\u200f]/g,"").replace(/\\s+/g," ").trim();}
  var u=location.href,host=location.hostname.replace(/^www\\./,"");
  function kw(){var m=/[?&]k=([^&]*)/.exec(u);return m?decodeURIComponent(m[1].replace(/\\+/g," ")):"";}
  function emit(payload,brief){
    var txt=JSON.stringify(payload,null,2);
    function done(ok){alert(ok?brief:"✗ 复制失败，请手动复制下面的 JSON，或改用「粘贴页面源码」方式。\\n\\n"+txt.slice(0,1200));}
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(txt).then(function(){done(true);},function(){done(false);});}
    else{
      var ta=document.createElement("textarea");ta.value=txt;document.body.appendChild(ta);ta.select();
      var ok=false;try{ok=document.execCommand("copy");}catch(e){}
      document.body.removeChild(ta);done(ok);
    }
  }
  // ① 搜索结果页 → 一次拿到整页商品（这是"批量采集"最省事的形态：
  //    卖家本来就在看搜索结果页，一次点击 = 十几个竞品）
  if(document.querySelector('[data-component-type="s-search-result"]')){
    var cards=document.querySelectorAll('[data-component-type="s-search-result"]');
    var list=[],seen={},spon=0;
    for(var ci=0;ci<cards.length;ci++){
      var card=cards[ci],asin=card.getAttribute("data-asin")||"";
      var h2=card.querySelector("h2"),title="";
      if(h2){var sp=h2.querySelector("span");title=c(h2.getAttribute("aria-label")||(sp?sp.textContent:"")||h2.textContent||"");}
      if(!title&&!asin)continue;
      var po=card.querySelector(".a-price .a-offscreen")||card.querySelector(".a-offscreen");
      var price=po?c(po.textContent):"";
      var ra=card.querySelector('[aria-label*="out of 5 stars"]'),rating=null;
      if(ra){var rm=/([\\d.]+)/.exec(ra.getAttribute("aria-label")||"");if(rm)rating=Number(rm[1]);}
      var rv=card.querySelector(".s-underline-text"),reviews=null;
      if(rv){var rn=String(rv.textContent||"").replace(/[^\\d]/g,"");if(rn)reviews=Number(rn);}
      var a=card.querySelector('h2 a[href*="/dp/"],a.a-link-normal[href*="/dp/"]'),href=a?(a.getAttribute("href")||""):"";
      var im=card.querySelector("img.s-image"),img=im?(im.getAttribute("src")||""):"";
      var isS=/Sponsored/i.test(card.textContent||"");
      if(isS)spon++;
      var key=asin||title.toLowerCase();
      if(seen[key])continue;seen[key]=1;
      list.push({asin:asin,title:title,price:price,rating:rating,reviewCount:reviews,
        url:href.indexOf("http")===0?href:(location.origin+href),image:img,sponsored:isS,text:title});
    }
    emit({kind:"search",url:u,site:host,keyword:kw(),items:list,
      stats:{blocks:cards.length,parsed:list.length,sponsored:spon},
      capturedAt:new Date().toISOString(),_source:"bookmarklet"},
      "✓ 已抓取整页 "+list.length+" 个商品并复制到剪贴板\\n\\n搜索词："+(kw()||"(无)")+"\\n广告位："+spon+" 个\\n\\n回到「跨境Listing质检工作台」→ 数据采集 → 粘贴，即可做多竞品对比。");
    return;
  }
  // ② 商品详情页 → 单条完整数据（含五点、规格表、BSR）
  var bullets=[];
  for(var i=0;i<S.bullets.length;i++){var ns=document.querySelectorAll(S.bullets[i]);var ts=[];for(var j=0;j<ns.length;j++){var t=c(ns[j].textContent);if(t)ts.push(t);}if(ts.length){bullets=ts;break;}}
  var img="";
  for(var i=0;i<S.image.length;i++){var e=document.querySelector(S.image[i]);if(!e)continue;var h=e.getAttribute("data-old-hires");if(h&&h.indexOf("http")===0){img=h;break;}var src=e.getAttribute("src")||"";if(src.indexOf("http")===0&&src.indexOf("sprite")<0){img=src;break;}}
  var specs={};
  for(var i=0;i<S.specTables.length;i++){var bs=document.querySelectorAll(S.specTables[i]);for(var j=0;j<bs.length;j++){var tb=bs[j].querySelector(".a-keyvalue.prodDetTable");if(!tb)continue;var trs=tb.querySelectorAll("tr");for(var k=0;k<trs.length;k++){var th=c(trs[k].querySelector("th")?trs[k].querySelector("th").textContent:"");var td=c(trs[k].querySelector("td")?trs[k].querySelector("td").textContent:"");if(th&&td)specs[th]=td;}}}
  var bc=[];var bcs=document.querySelectorAll(S.breadcrumbs[0]);for(var i=0;i<bcs.length;i++){var t=c(bcs[i].textContent);if(t)bc.push(t);}
  // ③ 评论区：只抓**当前这一页**（默认 10 条，最多 20 条）。
  //    为什么要抓：评论是唯一能直接读出"买家在抱怨什么"的免费数据。
  //    ⚠️ 这是首屏样本，不是全量；亚马逊按「最有帮助」排序，天然带偏 —— 界面必须写明这一点。
  var reviews=[],rvs=document.querySelectorAll('[data-hook="review"]');
  for(var ri=0;ri<rvs.length&&reviews.length<20;ri++){
    var rv=rvs[ri];
    var star=rv.querySelector('[data-hook="review-star-rating"] .a-icon-alt')||rv.querySelector('[data-hook="review-star-rating"]')||rv.querySelector("i.a-icon-star span");
    var starTxt=star?c(star.textContent):"";
    var rm=/([\\d.]+)/.exec(starTxt);
    var ttl=rv.querySelector('[data-hook="review-title"]');
    var bd=rv.querySelector('[data-hook="review-body"]');
    var dt=rv.querySelector('[data-hook="review-date"]');
    var titleTxt=ttl?c(ttl.textContent).replace(/^[\\d.]+\\s*out of 5 stars\\s*/i,""):"";
    var bodyTxt=bd?c(bd.textContent):"";
    if(!bodyTxt&&!titleTxt)continue;
    reviews.push({
      id:rv.getAttribute("data-review-id")||("r"+(ri+1)),
      rating:rm?Number(rm[1]):null,
      title:titleTxt,
      body:bodyTxt,
      date:dt?c(dt.textContent):"",
      verified:!!rv.querySelector('[data-hook="avp-badge"]'),
      vine:/Vine Customer Review/i.test(c(rv.textContent).slice(0,300)),
      variant:(function(){var fm=rv.querySelector('[data-hook="format-strip"]');return fm?c(fm.textContent):"";})()
    });
  }
  var m=(new RegExp(${JSON.stringify(ASIN_RE.source)},"i")).exec(u);
  var data={
    url:u,
    site:location.hostname.replace(/^www\\./,""),
    asin:c(q(S.asin,function(e){return e.value||e.textContent;}))||(m?m[1]:""),
    title:c(q(S.title)),
    brand:c(q(S.brand,function(e){return (e.textContent||"").replace(/^(Brand:|Visit the |Store:)/i,"");})),
    bullets:bullets,
    description:c(q(S.description)),
    specs:specs,
    breadcrumbs:bc,
    bestSellersRank:c(q(S.bestSellersRank)),
    rating:c(q(S.rating)).replace(/out of 5 stars/i,"").trim(),
    reviewCount:c(q(S.reviewCount)).replace(/[^\\d,]/g,""),
    price:c(q(S.price)),
    image:img,
    reviews:reviews,
    reviewSample:reviews.length,
    capturedAt:new Date().toISOString(),
    _source:"bookmarklet"
  };
  emit(data,"✓ 已抓取并复制到剪贴板\\n\\n标题："+String(data.title).slice(0,80)+"\\n五点："+data.bullets.length+" 条"+(reviews.length?"\\n评论样本："+reviews.length+" 条":"")+"\\n\\n回到「跨境Listing质检工作台」→ 数据采集 → 粘贴即可。");
})();`;
}

/** 生成可拖到书签栏的 javascript: 链接 */
export function bookmarkletHref() {
  const code = bookmarkletSource().replace(/\s*\n\s*/g, " ");
  return "javascript:" + encodeURIComponent(code);
}

/* ─────────────────────── 数据 → 工作台输入 ─────────────────────── */

/* ─────────────────────── 快照对比（同 ASIN 前后两次采集）─────────────────────── */

/**
 * 对比两份采集快照，回答"对方改了哪些字段"。
 *
 * 🔴 三条纪律：
 *   ① **只比抓到的内容**，不推断"为什么改"、不猜改前改后哪个更好；
 *   ② ASIN 不同时必须明说 —— 两件不同商品的对比没有意义，不能被当成"它改了标题"；
 *   ③ 数组字段（五点/规格）按顺序整体比较：顺序变了也算变（对应前台展示顺序），
 *      但详情里要能看出"新增了哪条"，而不是只给一句"变了"。
 */
export function diffSnapshots(a = {}, b = {}) {
  // 归一化：数组逐项 trim 去空；**对象（规格）拍平成 "键: 值" 数组**——
  // 🔴 原来直接 String(对象) 会得到 "[object Object]"，两侧永远相等，
  //    于是「对方改了材质」这种最该被看见的变化一辈子比不出来。
  const norm = (v) => {
    if (Array.isArray(v)) return v.map((x) => String(x == null ? "" : x).trim()).filter(Boolean);
    if (v && typeof v === "object") {
      // 规格是 map，键顺序没有语义 → 排序后再比，避免"两边内容一样但键序不同"被报成变化。
      // （五点那种有序数组**不排序**：前台展示顺序变了确实算变。）
      return Object.entries(v)
        .map(([k, val]) => `${k}: ${String(val == null ? "" : val).trim()}`)
        .filter((s) => !/:\s*$/.test(s))
        .sort();
    }
    return String(v == null ? "" : v).trim();
  };
  const FIELDS = [
    ["title", "标题"], ["brand", "品牌"], ["price", "价格"], ["rating", "星级"],
    ["reviewCount", "评论数"], ["bestSellersRank", "类目排名"],
    ["bullets", "五点"], ["specs", "规格"], ["description", "描述"],
  ];
  const rows = [];
  for (const [key, label] of FIELDS) {
    const before = norm(a[key]);
    const after = norm(b[key]);
    const same = Array.isArray(before) || Array.isArray(after)
      ? JSON.stringify(before) === JSON.stringify(after)
      : before === after;
    if (same) continue;
    const row = { key, label, before, after };
    if (Array.isArray(before) || Array.isArray(after)) {
      const bs = new Set(Array.isArray(before) ? before : []);
      const as = new Set(Array.isArray(after) ? after : []);
      row.added = (Array.isArray(after) ? after : []).filter((x) => !bs.has(x));
      row.removed = (Array.isArray(before) ? before : []).filter((x) => !as.has(x));
    }
    rows.push(row);
  }
  const unchanged = FIELDS.filter(([k]) => !rows.some((r) => r.key === k)).map(([, label]) => label);
  const asinA = String(a.asin || "").trim();
  const asinB = String(b.asin || "").trim();
  const sameAsin = Boolean(asinA && asinB && asinA === asinB);
  return {
    sameAsin, asinA, asinB,
    rows,
    changedCount: rows.length,
    unchanged,
    // 两份都缺 ASIN 时无法确认是同一件商品 —— 这句话必须出现在界面上
    note: !asinA || !asinB
      ? "两份记录里至少一份没有 ASIN，无法确认是同一件商品 —— 下面的差异只供参考。"
      : sameAsin
        ? ""
        : `两份记录的 ASIN 不同（${asinA || "空"} vs ${asinB || "空"}），这不是同一件商品的前后对比。`,
  };
}

/**
 * 把 Product 结构转成 Listing 工作台可用的输入（关键词自动来自标题+五点） */
export function productToWorkbenchInput(product) {
  const corpus = [product.title, ...(product.bullets || []), product.description, product.bestSellersRank, ...(product.breadcrumbs || [])]
    .filter(Boolean).join("\n");
  // 面包屑里出现 media 类目关键词 → 提示工作台切到 media 口径（标题 200 而不是 75）。
  // ⚠️ 只认**无歧义**的图书/音乐/影像词。刻意**不**把 Video Games / Software 算进来：
  //    这两类在新规公告里没被点名（公告只写 "all categories except for media"），
  //    把它们当 media 会让一个 180 字符的游戏标题被误判"通过" —— 猜错方向的代价更大。
  //    所以这里只做"能确定才切"，拿不准就留给用户在界面上自己选。
  const MEDIA_HINT = /\b(books?|kindle|audible|audiobooks?|comics?|manga|cds?\s*(?:&|and)?\s*vinyl|vinyl|music|movies?|tv|dvd|blu-?ray|digital music|sheet music)\b/i;
  const crumbText = [...(product.breadcrumbs || []), product.title].filter(Boolean).join(" ");
  return {
    brand: product.brand || "",
    productName: product.title || "",
    primaryKeyword: "",
    features: (product.bullets || []).slice(0, 6),
    category: (product.breadcrumbs || []).slice(-2, -1)[0] || "",
    competitorText: corpus,
    keywords: [],
    sizeSpec: Object.entries(product.specs || {}).find(([k]) => /size|dimension|length/i.test(k))?.[1] || "",
    isMedia: MEDIA_HINT.test(crumbText),
  };
}
