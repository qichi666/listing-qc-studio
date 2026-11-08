/**
 * 词库快照 —— **纯函数层**（无网络、无文件系统、无 DOM）。
 *
 * 谁用它：
 *   · `tools/collect-keywords.mjs` —— 把本周抓到的原始数据合并成一份快照；
 *   · `assets/keywords-store.js` —— 服务端读盘后做陈旧判定；
 *   · `mcp/server.mjs` 的 `keyword_snapshot` 工具；
 *   · `assets/app.js` —— 前端「载入本周词库」按钮。
 *
 * 为什么把合并逻辑单独抽出来：它是**唯一**决定"第一次见 / 本周新增 / 掉了"的地方。
 * 如果采集器和界面各算一遍，两边会对不上，而且没人会立刻发现。
 */

export const SCHEMA = 1;

/** 上限是**防爆炸**的闸门，不是目标值。超了按相关性截断，并在 note 里写明截了。 */
export const CAPS = {
  keywords: 5000,
  asins: 3000,
  rootsPerKeyword: 4,
};

/** 超过这么多天没更新就算「陈旧」—— 每周一次的话，10 天能容忍一次失败。 */
export const MAX_AGE_DAYS = 10;

/**
 * 超过这么多天算「死了」。
 *
 * 为什么要有第四档：`stale` 的动作是"这周的数据可能不完整，别当本周用"，
 * 而三周没更新的时候，动作已经不是"注意"，是"先别用，去修任务"。
 * 两档合一会让界面只能给一句含糊的黄字，用户不知道该不该信。
 */
export const DEAD_AGE_DAYS = 21;

/**
 * 一次最多给多少条关键词。**唯一常量，三个入口都从这里取**。
 *
 * 🔴 以前是三套数字：README 写「上限 2000」、`server.mjs` 夹到 2000、这里夹到 500。
 *    调用方要 1000 条，拿到 500 条**且不知道被截了** —— 文档承诺的量和代码给的量不是一回事，
 *    这比不写上限更糟（不写至少不会骗人）。
 */
export const MAX_KEYWORD_LIMIT = 500;

/** 词面归一：只用于**比较**，展示永远用原始大小写。 */
export const termKey = (t) => String(t == null ? "" : t).toLowerCase().replace(/\s+/g, " ").trim();

/**
 * 站点 → 域名。**只在这里写一份**：`bestsellers.js` 返回的条目没有 url，
 * 而 ASIN 的详情页地址是纯派生值（`/dp/<ASIN>`），不需要网络也不需要抓。
 * 放两处写的后果是：一处改了、另一处还是老域名，链接静默指向错站。
 */
export const SITE_DOMAIN = {
  US: "www.amazon.com",
  UK: "www.amazon.co.uk",
  DE: "www.amazon.de",
  FR: "www.amazon.fr",
  ES: "www.amazon.es",
  IT: "www.amazon.it",
  JP: "www.amazon.co.jp",
  CA: "www.amazon.ca",
};

export function asinUrl(asin, site = "US") {
  const host = SITE_DOMAIN[String(site || "US").toUpperCase()] || SITE_DOMAIN.US;
  return `https://${host}/dp/${String(asin || "").toUpperCase()}`;
}

export function emptySnapshot(site = "US") {
  return {
    schema: SCHEMA,
    site,
    generatedAt: null,
    keywords: [],
    asins: [],
    sources: {},
    summary: { keywordCount: 0, asinCount: 0, newKeywords: [], droppedKeywords: [], topCategories: [] },
  };
}

/**
 * 把「这一周抓到的原始命中」合并成快照。
 *
 * @param {object} p
 * @param {string} p.site
 * @param {Array<{term:string, root:string, group?:string}>} p.keywordHits  原始命中（可重复）
 * @param {Array<object>} p.asins   本周榜单条目（可重复、可缺字段）
 * @param {object} [p.prev]         上一份快照（用来保 firstSeen、算新增/掉了）
 * @param {Date}   [p.now]
 * @param {object} [p.sources]      各数据源的状态，原样带进快照
 * @param {object} [p.meta]         额外字段（market / roots 等）
 * @param {Array<string>} [p.extraNotes] 调用方带进来的告警（放 note 最前面）
 * @param {Set<string>|Map<string,string>} [p.everSeen]
 *        历史里出现过的词（低位投影的并集）。**没传就写 `unknown`，不猜** ——
 *        "首次出现"与"回归"的区别只能靠历史，凭空断言会把老词算成新词。
 */
export function buildSnapshot({
  site = "US", keywordHits = [], asins = [], prev = null, now = new Date(), sources = {}, meta = {}, extraNotes = [],
  everSeen = null,
} = {}) {
  const stamp = toISO(now);
  const prevKg = new Map((prev?.keywords || []).map((k) => [termKey(k.term), k]));
  const ever = (everSeen instanceof Map || everSeen instanceof Set) ? everSeen : null;
  const seenBefore = (k) => Boolean(ever && ever.has(k));

  // ① 关键词：按 term 归并，记下它是由哪些词根带出来的
  const kg = new Map();
  for (const h of keywordHits) {
    const term = String(h?.term || "").replace(/\s+/g, " ").trim();
    if (term.length < 3) continue;          // 1–2 个字符的建议词没有检索价值
    const key = termKey(term);
    if (!kg.has(key)) {
      kg.set(key, { term, roots: [], groups: [], hits: 0 });
    }
    const row = kg.get(key);
    row.hits++;
    const root = String(h?.root || "").trim();
    if (root && row.roots.length < CAPS.rootsPerKeyword && !row.roots.includes(root)) row.roots.push(root);
    const g = String(h?.group || "").trim();
    if (g && !row.groups.includes(g)) row.groups.push(g);
  }

  const keywords = [...kg.values()].map((row) => {
    const key = termKey(row.term);
    const old = prevKg.get(key);
    // 🔴 `hits` 与热度无关（它是"被几个词根带出来"）。`rootCount` 是这个意思的正式名字，
    //    `hits` 保留为**兼容别名**，等下一个 breaking 版本再删 —— 直接改名会让旧快照读不出排序。
    const rc = row.hits;
    // 三态：上周也有 = stable；上周没有但历史里出现过 = returned（回归）；都没有过 = new。
    // 没有历史投影时给 unknown，**不猜**（猜的结果是"回归词被算成本周新增"，正是要修的缺陷）。
    const newly = old ? "stable" : (ever ? (seenBefore(key) ? "returned" : "new") : "unknown");
    return {
      term: row.term,
      roots: row.roots,
      groups: row.groups,
      rootCount: rc,
      hits: rc,
      firstSeen: old?.firstSeen || stamp.slice(0, 10),
      lastSeen: stamp.slice(0, 10),
      // 上一周也出现过 → 稳定词；否则看历史（见上）。
      recurring: Boolean(old),
      newly,
      // 回归词上一次出现的时间（Map 才给得出，Set 只知道"出现过"）
      returnedFrom: newly === "returned" && ever instanceof Map ? (ever.get(key) || null) : null,
    };
  }).sort((a, b) => b.rootCount - a.rootCount || a.term.localeCompare(b.term));

  const prevKeys = new Set(prevKg.keys());
  const nowKeys = new Set(keywords.map((k) => termKey(k.term)));
  const newKeywords = keywords.filter((k) => !prevKeys.has(termKey(k.term))).map((k) => k.term);
  const droppedKeywords = [...prevKg.values()].filter((k) => !nowKeys.has(termKey(k.term))).map((k) => k.term);
  // 「上周没有」里还要分两种：真首次 / 回归。混在一起说"新增 200"会骗人 ——
  // 运营据此判断"这周冒出来一批新需求"，而实际可能是老词回来了。
  const firstTimeKeywords = keywords.filter((k) => k.newly === "new").map((k) => k.term);
  const returnedKeywords = keywords.filter((k) => k.newly === "returned").map((k) => k.term);

  // ② ASIN：按 asin 去重；同一个 ASIN 出现在多个类目时保留**名次最靠前**的那条
  const ag = new Map();
  for (const it of asins) {
    const asin = String(it?.asin || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin)) continue;   // 亚马逊 ASIN 固定 10 位，形状不对的别进库
    const rank = Number(it.rank) > 0 ? Number(it.rank) : 999;
    const old = ag.get(asin);
    if (!old || rank < old.rank) {
      ag.set(asin, {
        asin,
        title: String(it.title || "").trim(),
        category: String(it.category || it.slug || "").trim(),
        group: String(it.group || "").trim(),
        rank,
        price: String(it.price || "").trim(),
        // 🔴 `price === ""` 有两种含义：这个商品没标价 / 这页 HTML 没带价格段。
        //    实测只有 33% 的条目录到了价格 —— 把「没抓到」读成「便宜」是硬错误。
        //    `priceKnown` 只说一件事：**解析器有没有真的匹配到价格节点**。
        //    老快照没有这个字段 → 退回按 price 是否有值判断（与旧行为一致，不制造回归）。
        priceKnown: it.priceKnown === true || (it.priceKnown === undefined && Boolean(String(it.price || "").trim())),
        rating: String(it.rating ?? "").trim(),
        // 🔴 榜单解析器叫 `reviews`，快照里叫 `reviewCount`。两个名字必须在这里对齐一次 ——
        //    之前只读 `reviewCount`，于是 769 条 ASIN 的评论数**全是空字符串**（真实事故）。
        reviewCount: String(it.reviewCount ?? it.reviews ?? "").trim(),
        // url 同样：榜单里没有这个字段，按 ASIN 派生，避免界面拿到空链接。
        url: String(it.url || "").trim() || asinUrl(asin, site),
      });
    }
  }
  const asinRows = [...ag.values()].sort(
    (a, b) => (a.group || a.category).localeCompare(b.group || b.category) || a.rank - b.rank,
  );

  // ③ 截断（防爆炸），并如实记下截了多少
  const cappedK = keywords.slice(0, CAPS.keywords);
  const cappedA = asinRows.slice(0, CAPS.asins);
  // 调用方带进来的告警（例如"上一份快照读不出来，firstSeen 重新开始"）放在最前面：
  // 它解释的是**整份数据可不可信**，比"截断了多少条"更要紧。
  const notes = [...extraNotes];
  if (keywords.length > cappedK.length) {
    notes.push(`关键词 ${keywords.length} 条超过上限 ${CAPS.keywords}，按命中词根数截断，丢了 ${keywords.length - cappedK.length} 条`);
  }
  if (asinRows.length > cappedA.length) {
    notes.push(`ASIN ${asinRows.length} 条超过上限 ${CAPS.asins}，按类目与名次截断，丢了 ${asinRows.length - cappedA.length} 条`);
  }
  if (!cappedK.length) notes.push("本周没有抓到一个关键词 —— 要么词根全失败，要么接口被拦；这份快照不能当「这周没有新词」用");

  const catCount = new Map();
  for (const a of cappedA) {
    const g = a.group || a.category || "unknown";
    catCount.set(g, (catCount.get(g) || 0) + 1);
  }

  return {
    schema: SCHEMA,
    site,
    ...meta,
    generatedAt: stamp,
    keywords: cappedK,
    asins: cappedA,
    sources,
    summary: {
      keywordCount: cappedK.length,
      asinCount: cappedA.length,
      newKeywordCount: newKeywords.length,
      droppedKeywordCount: droppedKeywords.length,
      newKeywords: newKeywords.slice(0, 50),
      droppedKeywords: droppedKeywords.slice(0, 50),
      // 三态的计数：firstTime + returned + (unknown 不计) 与 newKeywordCount 的关系见下。
      firstTimeCount: firstTimeKeywords.length,
      returnedCount: returnedKeywords.length,
      firstTimeKeywords: firstTimeKeywords.slice(0, 50),
      returnedKeywords: returnedKeywords.slice(0, 50),
      // 没有历史投影 → 分不出首次与回归。**如实说**，别让读者以为 returnedCount=0 就是"没有回归词"。
      returnedUnknown: !ever,
      topCategories: [...catCount.entries()].sort((a, b) => b[1] - a[1]).map(([group, n]) => ({ group, count: n })),
      note: notes.join(" ｜ "),
    },
  };
}

/** 快照是否"什么都没抓到"。**空快照绝不能覆盖上一份**。 */
export function isEmpty(snap) {
  return !snap || ((snap.keywords?.length || 0) === 0 && (snap.asins?.length || 0) === 0);
}

/**
 * 陈旧判定 —— 界面与 MCP 都必须照这个口径说话。
 * 三态：`fresh`（在容忍期内）/ `stale`（过期）/ `missing`（没有快照）。
 * 🔴 没有 `unknown` 之外的兜底：拿不到时间就当 missing，不猜。
 */
export function staleness(snap, now = new Date(), maxAgeDays = MAX_AGE_DAYS) {
  if (!snap || !snap.generatedAt) {
    return { state: "missing", ageDays: null, note: "没有词库快照：去跑一次采集，或检查定时任务是否成功。" };
  }
  const t = Date.parse(snap.generatedAt);
  if (!Number.isFinite(t)) {
    return { state: "missing", ageDays: null, note: `快照时间读不出来（${snap.generatedAt}），按「没有」处理，不猜。` };
  }
  const ageDays = Math.floor((now.getTime() - t) / 86400000);
  if (ageDays > DEAD_AGE_DAYS) {
    return {
      state: "dead", ageDays,
      note: `词库已经 ${ageDays} 天没更新（超过 ${DEAD_AGE_DAYS} 天）—— 先别拿它判断本周市场，去修定时任务。`,
    };
  }
  if (ageDays > maxAgeDays) {
    return {
      state: "stale", ageDays,
      note: `词库已 ${ageDays} 天没更新（容忍上限 ${maxAgeDays} 天）—— 定时任务多半失败了，别把它当本周数据用。`,
    };
  }
  return { state: "fresh", ageDays, note: "" };
}

/** 只留摘要字段的历史条目（仓库体积友好；完整数据只在 latest.json）。 */
export function digestOf(snap, { topTerms = 800, asinPerCat = 30 } = {}) {
  // 词级投影：只存 [词, rootCount] 元组。存对象会大一倍以上，而趋势/回归判定只需要这两个值。
  // 🔴 上限 800 而不是 400：2135 个词只投影 400 等于覆盖 19%，
  //    低于投影线的回归词会被算成"新增" —— 那就是 P1-6 要修的缺陷换了个形态回来。
  const terms = (snap.keywords || []).slice(0, topTerms)
    .map((k) => [k.term, k.rootCount ?? k.hits ?? 0]);
  // ASIN 投影同理：只存 [ASIN, rank]，按类目分组，每类取前 N（榜单名次本身就是排序依据）。
  const byCat = new Map();
  for (const a of snap.asins || []) {
    const g = a.group || a.category || "unknown";
    if (!byCat.has(g)) byCat.set(g, []);
    byCat.get(g).push([a.asin, a.rank]);
  }
  const asinRanks = {};
  for (const [g, list] of byCat) {
    asinRanks[g] = list.slice(0, asinPerCat);
  }
  return {
    schema: snap.schema,
    site: snap.site,
    generatedAt: snap.generatedAt,
    keywordCount: snap.summary?.keywordCount || 0,
    asinCount: snap.summary?.asinCount || 0,
    newKeywordCount: snap.summary?.newKeywordCount || 0,
    firstTimeCount: snap.summary?.firstTimeCount || 0,
    returnedCount: snap.summary?.returnedCount || 0,
    newKeywords: (snap.summary?.newKeywords || []).slice(0, 50),
    topCategories: snap.summary?.topCategories || [],
    sourceStatus: Object.fromEntries(Object.entries(snap.sources || {}).map(([k, v]) => [k, v?.status || "?"])),
    topTerms: terms,
    asinRanks,
  };
}

/**
 * 版本对比（S-3）—— 把两份快照摆在一起，说清「新增 / 回归 / 掉出」。
 *
 * 🔴 只比 `digestOf()` 的 `topTerms` 投影，不比完整 keywords：
 *    历史文件本来就只留投影（完整快照每周近 1MB），拿两份完整快照来比等于
 *    要求调用方先读两份大文件；而且「曾经出现过」的唯一证据就是历史投影，
 *    用同一份口径才不会两处各算一套。
 *
 * 🔴 没有 prev 时如实返回 `ok:false` + 原因，三个集合给 **null**，不编 0：
 *    "新增 0 / 回归 0" 会被当成"这周没变化"，而真实情况是"根本没得比"。
 *
 * `returnedTerms` 只能靠快照自带的三态标记（`newly` / `summary.returnedUnknown`）：
 *    投影里只有词面，没有"上次什么时候出现过"，凭两份投影**算不出**回归。
 *    分不出就给 null 并写明原因，绝不把回归词塞进 newTerms 冒充首次。
 *
 * `current` / `prev` 回的是摘要投影（不是 842KB 完整快照）：界面两列并排要的是
 * 计数与词面，完整 keywords 由 `/api/keywords` 单独给，别在这里重复灌一遍。
 *
 * @param {object} cur 当前快照
 * @param {object} prev 上一份快照（没有就传 null）
 * @returns {{ok:boolean, reason?:string, current:object|null, prev:object|null, delta:object}}
 */
export function compareSnapshots(cur, prev) {
  const isSnap = (s) => Boolean(s && typeof s === "object" && Array.isArray(s.keywords));
  if (!isSnap(cur)) {
    return { ok: false, reason: "当前快照读不出来（缺 keywords 数组）", current: null, prev: null, delta: null };
  }
  const current = digestOf(cur);
  if (!isSnap(prev)) {
    return {
      ok: false,
      reason: "没有上一份快照：算不出新增 / 回归 / 掉出（不编 0，宁可说分不出）",
      current,
      prev: null,
      delta: {
        newTerms: null, returnedTerms: null, droppedTerms: null,
        note: "没有 prev，三个集合都算不出来，给 null 而不是 0。",
      },
    };
  }
  const prevDigest = digestOf(prev);

  // 投影 → 归一化词面集合；同时留一份「归一化词面 → 展示词面」的回显表。
  const project = (d) => {
    const keys = new Set();
    const display = new Map();
    for (const row of d.topTerms || []) {
      const term = Array.isArray(row) ? row[0] : row?.term;
      if (!term) continue;
      const k = termKey(term);
      keys.add(k);
      if (!display.has(k)) display.set(k, String(term));
    }
    return { keys, display };
  };
  const C = project(current);
  const P = project(prevDigest);
  const addedKeys = [...C.keys].filter((k) => !P.keys.has(k));
  const droppedKeys = [...P.keys].filter((k) => !C.keys.has(k));
  const face = (display, k) => display.get(k) || k;

  // 三态信息只可能来自当前快照本身。没有它 = 分不出首次 / 回归。
  const newlyOf = new Map((cur.keywords || []).map((k) => [termKey(k.term), k.newly]));
  const triAvailable = (cur.keywords || []).some((k) => k.newly != null);
  const returnedUnknown = cur.summary?.returnedUnknown === true || !triAvailable;
  const returnedKeys = returnedUnknown
    ? []
    : addedKeys.filter((k) => newlyOf.get(k) === "returned");
  const newKeys = returnedUnknown
    ? addedKeys
    : addedKeys.filter((k) => newlyOf.get(k) !== "returned");

  return {
    ok: true,
    current,
    prev: prevDigest,
    delta: {
      newTerms: newKeys.map((k) => face(C.display, k)),
      // 🔴 分不出就给 null：把回归词混进 newTerms 说成"本周新增"，正是 P1-6 修掉的那类缺陷。
      returnedTerms: returnedUnknown ? null : returnedKeys.map((k) => face(C.display, k)),
      droppedTerms: droppedKeys.map((k) => face(P.display, k)),
      returnedUnknown,
      curTerms: C.keys.size,
      prevTerms: P.keys.size,
      note: returnedUnknown
        ? "当前快照没有三态标记 / 历史投影，回归词分不出：returnedTerms 为 null，newTerms 是「相对上一份新增」的全部词（含可能的回归词）。"
        : "",
    },
  };
}

/**
 * ASIN 榜单监控（S-4）—— 两期 `asinRanks` 投影对比出「新进 / 掉出 / 留榜」。
 *
 * `asinRanks` 形状：`{ groupName: [[asin, rank], ...] }`，来自 `digestOf()`。
 *
 * 🔴 三个集合必须是**对全量 ASIN 的一个划分**：互不重叠、且并集 = 两快照并集。
 *    由此 `moved` 只能是「两期都在榜」的交集（**含名次没变的**），不是"只列变动的" ——
 *    否则"两期都在但没动"的 ASIN 没地方放，并集就凑不齐。
 *    真正名次变了多少看 `counts.changed` / `rankChanges`，别把 moved.length 当变动数。
 *
 * 同一 ASIN 出现在多个类目时按**最靠前**（rank 最小）的那条算，与 `buildSnapshot()` 口径一致。
 * 没有上一份投影时如实返回 `ok:false` + 原因，三个集合给 null，不编 0。
 * 名次缺一边就算不出 delta：给 null，不编 0（"没抓到名次" ≠ "名次没变"）。
 *
 * @returns {{ok:boolean, reason?:string, entered:string[]|null, left:string[]|null,
 *            moved:string[]|null, rankChanges:Array, counts:object|null}}
 */
export function diffAsins(prevRanks, curRanks) {
  const isRanks = (r) => Boolean(r && typeof r === "object" && !Array.isArray(r));
  if (!isRanks(prevRanks) || !isRanks(curRanks)) {
    return {
      ok: false,
      reason: "缺少上一份或当前 ASIN 投影：算不出新进 / 掉出 / 名次变化（不编 0）",
      entered: null, left: null, moved: null, rankChanges: [], counts: null,
    };
  }
  const flat = (ranks) => {
    const m = new Map();
    for (const [group, list] of Object.entries(ranks)) {
      if (!Array.isArray(list)) continue;
      for (const row of list) {
        const asin = String((Array.isArray(row) ? row[0] : row?.asin) || "").trim().toUpperCase();
        if (!/^[A-Z0-9]{10}$/.test(asin)) continue;       // 形状不对的不进集合
        const n = Number(Array.isArray(row) ? row[1] : row?.rank);
        const rank = Number.isFinite(n) && n > 0 ? n : null;
        const old = m.get(asin);
        if (!old || (rank != null && (old.rank == null || rank < old.rank))) {
          m.set(asin, { asin, group, rank });
        }
      }
    }
    return m;
  };
  const P = flat(prevRanks);
  const C = flat(curRanks);

  const entered = [];
  const left = [];
  const moved = [];
  const rankChanges = [];
  for (const [asin, c] of C) {
    if (!P.has(asin)) { entered.push(asin); continue; }
    const p = P.get(asin);
    const delta = (p.rank != null && c.rank != null) ? c.rank - p.rank : null;
    moved.push(asin);
    if (delta !== null && delta !== 0) {
      rankChanges.push({ asin, group: c.group || p.group, from: p.rank, to: c.rank, delta });
    }
  }
  for (const [asin] of P) {
    if (!C.has(asin)) left.push(asin);
  }
  const union = new Set([...P.keys(), ...C.keys()]);
  return {
    ok: true,
    entered,
    left,
    moved,
    rankChanges,
    counts: {
      union: union.size,
      entered: entered.length,
      left: left.length,
      moved: moved.length,
      changed: rankChanges.length,
    },
  };
}

/**
 * 查词 —— **唯一实现**（`lookup()` 只是它的薄壳，别在这里之外再写一份筛选）。
 *
 * 为什么要返回 `total` / `truncated`：上层接口允许 `limit=2000`，而这里为了不把
 * 整个词库灌给调用方，硬上限是 500。以前是**静默**截到 500 —— 用户看到 500 条会以为
 * 词库只有 500 条。现在截了就必须说得出来。
 *
 * @param {object} snap
 * @param {{q?:string, limit?:number, group?:string, sort?:string}} [opt]
 * @returns {{rows:Array, total:number, truncated:boolean, limit:number, requested:number}}
 */
export function queryKeywords(snap, { q = "", limit = 50, group = "", sort = "roots" } = {}) {
  const key = termKey(q);
  const g = termKey(group);
  let rows = snap?.keywords || [];
  // 类目筛的是**关键词的分组**（`groups`），不是 ASIN 的类目 —— 两件事在界面里是同一张卡，
  // 但数据结构上分属两个数组。上层要筛 ASIN 时自己按 group/category 过一遍。
  if (g) rows = rows.filter((k) => (k.groups || []).some((x) => termKey(x) === g));
  if (key) rows = rows.filter((k) => termKey(k.term).includes(key));

  // 排序维度。默认 `roots` = **不动**：快照本身就是按 rootCount 降序排好的，
  // 再排一次只会多一次拷贝，还可能因为稳定排序把同分词打乱。
  const mode = String(sort || "roots").toLowerCase();
  if (mode === "az") {
    rows = [...rows].sort((a, b) => a.term.localeCompare(b.term));
  } else if (mode === "new") {
    // 新词优先，其次回归，最后稳定；同组内仍按 rootCount 降序。
    const rank = (k) => (k.newly === "new" ? 0 : k.newly === "returned" ? 1 : 2);
    rows = [...rows].sort((a, b) => rank(a) - rank(b)
      || (b.rootCount ?? b.hits ?? 0) - (a.rootCount ?? a.hits ?? 0)
      || a.term.localeCompare(b.term));
  }

  const total = rows.length;
  const requested = Number(limit) || 50;
  const cap = Math.max(1, Math.min(MAX_KEYWORD_LIMIT, requested));
  const page = rows.slice(0, cap);
  // `requested` 与 `limit` 不等时，上层必须把"你要 N 条、实际给你 M 条"说出来 —— 这就是
  // 不静默降级的落地方式：clamp 可以，但 clamp 完必须报账。
  return { rows: page, total, truncated: total > page.length, limit: cap, requested };
}

/** 按词面模糊查（兼容旧签名）。空 query 返回全部（受 limit 限制）。 */
export function lookup(snap, query = "", limit = 50, opt = {}) {
  return queryKeywords(snap, { q: query, limit, group: opt.group }).rows;
}

function toISO(d) {
  const x = d instanceof Date ? d : new Date(d);
  return Number.isFinite(x.getTime()) ? x.toISOString() : new Date().toISOString();
}
