/**
 * 亚马逊 Best Sellers 榜单抓取 —— **零第三方依赖**（只用 Node 内置 https/zlib/dns）。
 *
 * 来源：`tool/server.js`（原「竞品销量榜」）2026-10-02 整合进本工作台：
 *   · SITES / CATS .......................... 原 server.js:24-57
 *   · httpGet / withRetry / decodeEntities ... 原 server.js:268-332
 *   · parseItems / parseSubs ................ 原 server.js:335-427
 *   · 缓存 TTL 10 分钟 ....................... 原 server.js:430-442
 *
 * 🔴 与原实现的三处**有意加强**（不是照抄）：
 *   1. **主机硬白名单**：只允许下面 8 个 amazon 域。原实现任何传入的 href 都会去抓。
 *   2. **过 `assertPublicUrl`**（复用 `net-guard.js` 的唯一实现）：DNS 解析后判内网 IP，
 *      防 DNS rebinding。原实现没有这层。
 *   3. **不搬关键词搜索**：原 `/api/search` 走 `/s?k=` + Python scrapling 子进程，
 *      原代码注释自己写着"已被亚马逊封锁（503）"。搬进来只会带来一个 Python 运行时依赖。
 *
 * ⚠️ 边界说明（界面必须照实写，不许说假话）：
 *   数据来自 Amazon Best Sellers **公开榜单页**，实时抓取。页面结构变化时解析会失效 ——
 *   那时表现为"抓到 0 条"，不是静默出错（`fetchBestsellers` 会抛 `抓取为空`）。
 *   自用选品研究用途；请遵守目标站点的使用条款，不要高频轮询（本模块自带 10 分钟缓存）。
 */
import https from "node:https";
import http from "node:http";
import zlib from "node:zlib";
import { assertPublicUrl } from "./net-guard.js";

// ---------- 站点 ----------
export const SITES = {
  com: { host: "www.amazon.com", label: "美国站" },
  "co.uk": { host: "www.amazon.co.uk", label: "英国站" },
  de: { host: "www.amazon.de", label: "德国站" },
  fr: { host: "www.amazon.fr", label: "法国站" },
  jp: { host: "www.amazon.co.jp", label: "日本站" },
  ca: { host: "www.amazon.ca", label: "加拿大站" },
  it: { host: "www.amazon.it", label: "意大利站" },
  es: { host: "www.amazon.es", label: "西班牙站" },
};

export const DEFAULT_SITE = "com";
export const SITE_CODES = Object.keys(SITES);

/** 🔴 唯一出网白名单 —— 除这 8 个主机，一个都不许抓 */
export const AMAZON_HOSTS = Object.freeze(Object.values(SITES).map((s) => s.host));

// ---------- 类目（实测可用的服务端 slug） ----------
export const CATS = [
  { cn: "玩具与游戏", slug: "toys-and-games", note: "益智玩具 / 毛绒 / 模型 / 户外玩具" },
  { cn: "宠物用品", slug: "pet-supplies", note: "狗猫鸟鱼小动物用品" },
  { cn: "电子产品", slug: "electronics", note: "耳机 / 智能设备 / 影音" },
  { cn: "家居厨房", slug: "home-garden", note: "家居用品 / 收纳 / 装饰" },
  { cn: "厨房餐具", slug: "kitchen", note: "厨具 / 餐具 / 小家电" },
  { cn: "运动户外", slug: "sporting-goods", note: "健身 / 露营 / 球类" },
  { cn: "美妆个护", slug: "beauty", note: "护肤 / 彩妆 / 美发" },
  { cn: "健康家居", slug: "hpc", note: "日用品 / 保健品 / 清洁" },
  { cn: "母婴用品", slug: "baby-products", note: "婴儿护理 / 喂养 / 推车" },
  { cn: "办公用品", slug: "office-products", note: "文具 / 打印 / 办公家具" },
  { cn: "家用电器", slug: "appliances", note: "大家电 / 小家电" },
  { cn: "汽车用品", slug: "automotive", note: "车载配件 / 养护" },
  { cn: "艺术手工", slug: "arts-crafts", note: "绘画 / 手工 / 缝纫" },
  { cn: "乐器", slug: "musical-instruments", note: "乐器 / 配件" },
  { cn: "服饰鞋包", slug: "fashion", note: "服装 / 鞋 / 珠宝" },
  { cn: "电子游戏", slug: "videogames", note: "游戏机 / 游戏软件" },
  { cn: "图书", slug: "books", note: "图书 / 教材" },
  { cn: "食品杂货", slug: "grocery", note: "食品 / 饮料 / 生鲜" },
  { cn: "工业科研", slug: "industrial", note: "工业仪器 / 科研耗材" },
  { cn: "工具五金", slug: "tools", note: "手工具 / 电动工具" },
];

export const CAT_SLUGS = CATS.map((c) => c.slug);
export const CAT_BY_SLUG = Object.fromEntries(CATS.map((c) => [c.slug, c]));

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// ---------- 地址白名单（唯一判据，界面与自检都调它） ----------

/** 榜单页路径。slug 必须是已知类目，防止把任意路径拼进来。 */
export function bestsellersPath(slug) {
  if (!CAT_SLUGS.includes(slug)) return null;
  return `/gp/bestsellers/${slug}`;
}

/**
 * 只有**主机在白名单内 + 路径是 /gp/bestsellers 或 /zgbs/ 下的榜单路径**才放行。
 * @returns {boolean}
 */
export function isAllowedAmazonUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:") return false;
  if (!AMAZON_HOSTS.includes(u.hostname.toLowerCase())) return false;
  // 🔴 端口也要管：`https://www.amazon.com:8443/gp/bestsellers/x` 主机名合法，
  //    但连的是这台机器上另一个服务。白名单的语义是"只允许这 8 个站点的榜单页"，
  //    所以只认默认端口（URL 解析后缺省端口就是空串）。2026-10-30 实测：加了之前返回 true。
  if (u.port && u.port !== "443") return false;
  if (/^\/gp\/bestsellers\//.test(u.pathname)) return true;
  // 🔴 Amazon 子类目榜单的真实路径是 `/<类目名>/zgbs/<大类>/<id>`，**不是** `/zgbs/` 开头。
  //    `/api/competitor/subs` 返回的 href 正是那个格式，只认 `^/zgbs/` 会让"选子类目"永远 400。
  //    仍然保留了"必须是榜单路径"的约束：`/s?k=` 这类搜索页照样被拒。
  if (/(?:^|\/)zgbs\//.test(u.pathname)) return true;
  return false;
}

// ---------- 出网 ----------

/** 超时同时覆盖"连上但龟速"与"连不上"两种情况 */
export function fetchHtml(url, timeout = 25000, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error("地址不合法")); }
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.get(url, {
      family: 4,                                  // 部分环境 IPv6 不可达 → AggregateError
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        "Upgrade-Insecure-Requests": "1",
        // 🔴 必须显式指定币种与语言。不带这两个 cookie 时，亚马逊会按**请求方 IP 所在国**
        //    返回本地化结果 —— 本机实测抓到 "CNY 60.39"，而跨境运营看的是美金。
        //    （原工具在 scrape.py:143 里做了同样的事，Node 侧漏了。）
        Cookie: "i18n-prefs=USD; lc-main=en_US",
      },
      timeout,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        // 🔴 重定向必须重新过白名单 —— 否则可以用一个合法 URL 302 到任意地址
        let next;
        try { next = new URL(res.headers.location, url).toString(); } catch { return reject(new Error("跳转地址不合法")); }
        if (!isAllowedAmazonUrl(next)) return reject(new Error("跳转到了白名单之外的地址：" + next));
        // 跳转次数上限：白名单只能保证"还在亚马逊域内"，挡不住站内循环跳转
        if (redirects >= 3) return reject(new Error("跳转次数过多：" + next));
        return resolve(fetchHtml(next, timeout, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        const e = new Error("HTTP " + res.statusCode);
        // 带上状态码：调用方要据此判断"该不该重试"（401/403 重试只会更被拦）
        e.status = res.statusCode;
        const ra = Number(res.headers["retry-after"]);
        if (Number.isFinite(ra) && ra > 0) e.retryAfterMs = Math.min(ra * 1000, 10000);
        return reject(e);
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let buf = Buffer.concat(chunks);
        const enc = (res.headers["content-encoding"] || "").toLowerCase();
        try {
          if (enc.includes("gzip")) buf = zlib.gunzipSync(buf);
          else if (enc.includes("deflate")) buf = zlib.inflateSync(buf);
          else if (enc.includes("br")) buf = zlib.brotliDecompressSync(buf);
        } catch { /* 保持原样 */ }
        resolve(buf.toString("utf8"));
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("请求超时")));
  });
}

/**
 * 失败重试。
 *
 * 🔴 原实现有两个问题（都是"看起来稳、实际有害"）：
 *   ① 固定 1.2s 间隔、次数写死 2 —— 上游真的拥塞时，两次请求间隔太短，等于帮着把门撞得更死；
 *   ② **401/403/404 也重试** —— 那是"没权限 / 被拦 / 页面不存在"，重试只会让上游更确定要拦你，
 *      而且把一个本该 1 秒返回的错误拖成 2.4 秒。
 * 现在：确定性 4xx 直接抛；其余指数退避（0.8s → 1.6s → 3.2s）+ 抖动（防多请求同时重试）；
 * 上游给了 Retry-After 就按它来（封顶 10s，别被一个离谱的值挂住）。
 */
const NO_RETRY_STATUS = new Set([400, 401, 403, 404, 405, 410, 451]);

export async function withRetry(fn, tries = 3, gap = 800) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (NO_RETRY_STATUS.has(e?.status)) throw e;
      if (i === tries - 1) break;
      const wait = e?.retryAfterMs ?? Math.round(gap * 2 ** i * (0.8 + Math.random() * 0.4));
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}

// ---------- 解析 ----------

/**
 * 实体解码。🔴 `&amp;` 必须**最后**替 —— 否则 `&amp;lt;` 会先变成 `&lt;` 再被下一行解成 `<`，
 * 一次双重解码（2026-10-30 实测旧顺序确实产出了 `<`）。标题里真出现 `<` 会污染展示与词频。
 */
export function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "–").replace(/&mdash;/g, "—")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}

/** 榜单页 HTML → 商品数组 */
export function parseItems(html) {
  const items = [];
  const seenTitle = new Set();
  const seenAsin = new Set();

  // 主路径：按 gridItemRoot 分块，块内取 title + asin
  let blocks = String(html).split(/id="gridItemRoot"/).slice(1);
  if (blocks.length < 3) {
    // 降级：按 faceout 分块
    blocks = String(html).split(/zg-grid-general-faceout/).slice(1);
  }

  for (const b of blocks) {
    const chunk = b.slice(0, 6000);
    let title = "";

    // 优先取完整标题节点（图片 alt 会被截断到 ~140 字符，不能用）
    let m = chunk.match(/class="_cDEzb_p13n-sc-css-line-clamp-\d+_[^"]*"[^>]*>([^<]{10,400})<\/div>/);
    if (!m) m = chunk.match(/aria-label="([^"]{18,300})"\s+class="a-link-normal aok-block"/);
    if (!m) m = chunk.match(/alt="([^"]{18,300})"/);
    if (!m) {
      m = chunk.match(/<span[^>]*class="[^"]*a-size-(?:base|small|medium)[^"]*"[^>]*>([^<]{18,300})<\/span>/);
    }
    if (!m) continue;
    title = decodeEntities(m[1]);
    if (!title || title.length < 18) continue;
    if (/^(amazon|best sellers|amazon\.com)/i.test(title) && title.length < 40) continue;
    if (seenTitle.has(title)) continue;

    const a = chunk.match(/data-asin="([A-Z0-9]{10})"/) || chunk.match(/\/dp\/([A-Z0-9]{10})/);
    const asin = a ? a[1] : "";
    if (asin && seenAsin.has(asin)) continue;

    // 星级 + 评论数（评论数是亚马逊公开的销量代理指标）
    let rating = 0, reviews = 0;
    const rm = chunk.match(/([\d.]+)\s+out of 5 stars,\s*([\d,]+)\s+ratings?/);
    if (rm) {
      rating = parseFloat(rm[1]) || 0;
      reviews = parseInt(rm[2].replace(/,/g, ""), 10) || 0;
    } else {
      const r2 = chunk.match(/([\d.]+)\s+out of 5 stars/);
      if (r2) rating = parseFloat(r2[1]) || 0;
      const r3 = chunk.match(/class="a-size-small"[^>]*>([\d,]+)<\/span>/);
      if (r3) reviews = parseInt(r3[1].replace(/,/g, ""), 10) || 0;
    }

    // 价格（可能是区间，如 $12.78 - $19.99）
    // 🔴 `price: ""` 是**二义**的：既可能是"这个商品没标价"，也可能是"榜单页这段 HTML 没带价格"。
    //    当前实测只有 33% 的条目录到了价格 —— 如果界面把它读成"便宜/免费"，那是彻头彻尾的误读。
    //    所以再记一个 `priceKnown`：**匹配到了价格节点才算知道**，没匹配到就是不知道。
    let price = "";
    const pm = chunk.match(/class="_cDEzb_p13n-sc-price_[^"]*">([^<]{1,24})<\/span>/) ||
      chunk.match(/class="p13n-sc-price">([^<]{1,24})<\/span>/);
    if (pm) price = decodeEntities(pm[1]).replace(/&nbsp;/g, " ").trim();

    seenTitle.add(title);
    if (asin) seenAsin.add(asin);
    items.push({ rank: items.length + 1, title, asin, rating, reviews, price, priceKnown: Boolean(price) });
  }

  // 兜底：全局 alt 提取
  if (items.length < 3) {
    const re = /alt="([^"]{18,300})"/g;
    let m2;
    while ((m2 = re.exec(String(html))) !== null) {
      const t = decodeEntities(m2[1]);
      if (t.length < 18) continue;
      if (/^(amazon|best sellers)/i.test(t) && t.length < 40) continue;
      if (seenTitle.has(t)) continue;
      seenTitle.add(t);
      items.push({ rank: items.length + 1, title: t, asin: "", price: "", priceKnown: false });
    }
  }

  return items.slice(0, 100);
}

/** 榜单页 HTML → 子类目数组 */
export function parseSubs(html) {
  const out = [];
  const seen = new Set();
  const re = /href="([^"]*\/zgbs\/[^"]*)"[^>]*>\s*([A-Z][^<]{1,60}?)\s*</g;
  let m;
  while ((m = re.exec(String(html))) !== null) {
    let href = m[1];
    const name = decodeEntities(m[2]);
    if (!name || name.length < 2 || name.length > 45) continue;
    if (/current|department|best sellers|see all|next page|previous page|\bprevious\b|ref=/i.test(name)) continue;
    if (/^[\d\s,\.]+$/.test(name)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    href = href.replace(/\/ref=[^/]*$/, "");
    out.push({ name, href });
  }
  return out;
}

// ---------- 缓存 + 取数 ----------

const CACHE_TTL_MS = 10 * 60 * 1000;
// 🔴 上限：每条是一整页榜单 HTML（实测 1–3 MB）。原来只 set 不 delete、TTL 只在读时判，
//    一个下午在 20 个类目 × 8 个站点之间来回点，进程内存会一路涨上去且永不回收。
const CACHE_MAX = 40;
const cache = new Map();

export function cacheStats() { return { size: cache.size, max: CACHE_MAX, ttlMs: CACHE_TTL_MS }; }
export function clearCache() { cache.clear(); }

function cachePut(url, html) {
  cache.set(url, { html, at: Date.now() });
  // Map 按插入序迭代 → 删掉最旧的；刚写进去的是最后一个，不会被误删
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

async function cachedFetch(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    // 🔴 LRU 而不是 FIFO：命中后把它挪到队尾（Map 按插入序迭代）。
    //    原来只看"最早进来"的，结果热门的类目页也会被淘汰，冷门的反而一直占着名额。
    //    at 不刷新 —— TTL 说的是"这份 HTML 有多旧"，跟"上次谁用过"是两件事。
    cache.delete(url);
    cache.set(url, { html: hit.html, at: hit.at });
    return { html: hit.html, cached: true };
  }
  if (hit) cache.delete(url);   // 过期条目立刻清掉，别占着名额等下一次淘汰
  const html = await withRetry(async () => {
    await assertPublicUrl(url);          // 🔴 纵深防御：DNS 解析后确认解析到公网 IP
    return fetchHtml(url);
  }, 3, 800);
  cachePut(url, html);
  return { html, cached: false };
}

/** 目标 URL 的统一出口：先白名单，再缓存，再抓 */
export async function fetchAllowed(url) {
  if (!isAllowedAmazonUrl(url)) throw new Error("不在允许抓取的地址白名单内：" + url);
  return cachedFetch(url);
}

/**
 * 抓某个类目的销量榜。
 * @param {{site?:string, slug:string, href?:string}} opts href 用于下钻到子类目
 */
/**
 * 抓某个类目的 Best Sellers 榜单。
 *
 * 🆕 `pages`（1–3）：榜单页一页约 50 条，只看第一页会把 51–150 名的长尾竞品整批漏掉。
 * 多页合并时的三条规则：
 *   ① **去重按 ASIN**（没有 ASIN 时退回标题）—— 同一商品在不同页重复出现是常见现象，
 *      不去重会让关键词覆盖率算高（同一个词被同一件商品重复计数）；
 *   ② **页间串行 + 间隔 600ms**，不并发打上游（并发是被封的直接原因）；
 *   ③ 单页失败**不整体失败**：已抓到的页照常返回，失败页写进 `failedPages` 让界面如实显示。
 *      全部失败才抛错 —— "3 页里成功了 2 页"是有用数据，不该被当成错误丢掉。
 */
export const MAX_PAGES = 3;
const PAGE_GAP_MS = 600;

function withPage(u, i) {
  if (i <= 1) return u;
  try {
    const url = new URL(u);
    url.searchParams.set("pg", String(i));
    return url.toString();
  } catch {
    return u;
  }
}

export async function fetchBestsellers({ site = DEFAULT_SITE, slug, href, pages = 1 } = {}) {
  const s = SITES[site];
  if (!s) throw new Error("未知站点：" + site);
  const path = href || bestsellersPath(slug);
  if (!path) throw new Error("未知类目：" + slug);
  // href 允许两种形态：相对榜单路径（内部调用）/ 完整 https URL（前端与接口传参）。
  // 只判一次前缀，别再无条件拼 host —— 否则完整 URL 会被拼成
  // "https://www.amazon.comhttps://www.amazon.com/..."，白名单必然拒掉。
  const url = /^https:\/\//i.test(path) ? path : "https://" + s.host + path;
  const want = Math.max(1, Math.min(MAX_PAGES, Math.floor(Number(pages) || 1)));

  if (want === 1) {
    const { html, cached } = await fetchAllowed(url);
    const items = parseItems(html);
    if (!items.length) throw new Error("榜单解析为空（可能亚马逊改了页面结构，或该子类目无数据）");
    return {
      items, url, cached, site, slug, pages: 1, requestedPages: 1, duplicates: 0, failedPages: [],
      fetchedAt: new Date().toISOString(), ttlMin: CACHE_TTL_MS / 60000,
    };
  }

  const merged = [];
  const seen = new Set();
  const failedPages = [];
  let duplicates = 0, okPages = 0, anyCached = false;
  for (let i = 1; i <= want; i++) {
    const u = withPage(url, i);
    try {
      const { html, cached } = await fetchAllowed(u);
      if (cached) anyCached = true;
      const items = parseItems(html);
      if (!items.length) throw new Error("解析为空（可能已到最后一页，或页面结构变了）");
      okPages++;
      for (const it of items) {
        const key = it.asin || `t:${it.title}`;
        if (seen.has(key)) { duplicates++; continue; }
        seen.add(key);
        // rank 重新按合并后的顺序编号；原始页内名次留在 rankOnPage，两件事分开记
        merged.push({ ...it, page: i, rank: merged.length + 1, rankOnPage: it.rank });
      }
    } catch (e) {
      failedPages.push({ page: i, reason: e.message });
    }
    if (i < want) await new Promise((r) => setTimeout(r, PAGE_GAP_MS));
  }
  if (!merged.length) {
    throw new Error(`前 ${want} 页都没抓到：${failedPages.map((f) => `第${f.page}页 ${f.reason}`).join("；")}`);
  }
  return {
    items: merged, url, cached: anyCached, site, slug,
    pages: okPages, requestedPages: want, duplicates, failedPages,
    fetchedAt: new Date().toISOString(), ttlMin: CACHE_TTL_MS / 60000,
  };
}

/** 抓某个类目页的子类目列表 */
export async function fetchSubs({ site = DEFAULT_SITE, slug, href } = {}) {
  const s = SITES[site];
  if (!s) throw new Error("未知站点：" + site);
  const path = href || bestsellersPath(slug);
  if (!path) throw new Error("未知类目：" + slug);
  const url = /^https:\/\//i.test(path) ? path : "https://" + s.host + path;
  const { html, cached } = await fetchAllowed(url);
  return { subs: parseSubs(html).slice(0, 40), url, cached };
}
