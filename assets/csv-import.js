/**
 * 第三方关键词 CSV 导入（P2-4）。
 *
 * 场景：卖家精灵 / Helium 10 / Jungle Scout 都能导出「关键词 + 搜索量」的 CSV。
 * 本工具不去抓、不估算搜索量（那是资源型差距，补了等于换产品），但**用户自己导出的数据**
 * 应当能直接进来 —— 否则他只能手工把 300 个词一个个敲进「自定义关键词」。
 *
 * 🔴 四条边界：
 *   1. **只做映射，不做推断**：认不出关键词列就报错并列出表头，不猜「第一列大概是词吧」。
 *      猜错的后果是拿 ASIN 当关键词进覆盖矩阵，然后整张表全红。
 *   2. **搜索量原样保留 + 标注来源**：显示时写「来自你导入的 xxx.csv（日期）」，
 *      绝不混进本工具自己的口径 —— 本工具没有任何搜索量数据。
 *   3. 表头别名是**多语言 + 多工具**的，且必须能说清"匹配到哪一列"。匹配不上就列出未知列。
 *   4. 超过上限**报数并截断**（与批量质检不同：这里截断是合理的，因为词表本来就只取前 N 个），
 *      但必须告诉用户截了多少。
 */

import { parseRecords, sniffDelimiter } from "./csv.js";

/** 一次导入的行数上限。词库再大，覆盖矩阵也只分析前 top 个词。 */
export const CSV_MAX_ROWS = 2000;

/**
 * 表头别名表。
 * 🔴 顺序有意义：先精确匹配，再"包含匹配"；同一类里长的别名排前面（"search volume" 要先于 "volume"）。
 */
export const HEADER_ALIASES = {
  keyword: [
    "keyword phrase", "search term phrase", "customer search term", "search term", "search terms",
    "keyword", "keywords", "phrase", "query", "词", "关键词", "搜索词", "关键字",
  ],
  volume: [
    "monthly search volume", "search volume", "est. searches", "estimated searches",
    "monthly searches", "searches", "volume", "搜索量", "月搜索量", "月搜索量(精确)", "月搜索量(广泛)", "搜索热度", "月均搜索量",
  ],
  asin: ["child asin", "product asin", "asin", "父asin", "子asin"],
};

const norm = (h) => String(h == null ? "" : h)
  .replace(/^\uFEFF/, "")
  .replace(/\s+/g, " ")
  .trim()
  .toLowerCase();

/** 去掉括号里的补充说明，只留主名："月搜索量(精确)" → "月搜索量"、"Search Volume (Exact)" → "search volume"。 */
const base = (h) => norm(h).replace(/[（(][^）)]*[）)]/g, "").trim();

/**
 * 表头 → 列下标。
 * @returns {{mapping:{keyword:number|null,volume:number|null,asin:number|null},
 *            matched:Array<{role:string,index:number,header:string,alias:string}>,
 *            unknown:string[]}}
 */
export function detectColumns(header = []) {
  const mapping = { keyword: null, volume: null, asin: null };
  const matched = [];
  const used = new Set();

  // 两轮：先精确、后包含。包含匹配必须带长度保护，否则 "volume" 会命中 "volume discount"。
  // 🔴 ASIN 只走精确匹配：Helium 10 的表头里有 "Sponsored ASINs"，按包含匹配会把它当成
  //    ASIN 列，然后每行都塞进一个数字（"34"），而且看起来毫无异常。
  for (const pass of ["exact", "contains"]) {
    for (const role of ["keyword", "volume", "asin"]) {
      if (mapping[role] != null) continue;
      if (role === "asin" && pass === "contains") continue;
      const aliases = HEADER_ALIASES[role];
      for (let idx = 0; idx < header.length; idx += 1) {
        if (used.has(idx)) continue;
        const nb = base(header[idx]);
        const hit = aliases.find((a) => (pass === "exact" ? nb === a : nb.includes(a)));
        if (hit) {
          mapping[role] = idx;
          used.add(idx);
          matched.push({ role, index: idx, header: String(header[idx] || "").trim(), alias: hit });
          break;
        }
      }
    }
  }

  const unknown = header
    .map((h, i) => ({ h: String(h == null ? "" : h).trim(), i }))
    .filter((x) => !used.has(x.i) && x.h)
    .map((x) => x.h);

  return { mapping, matched, unknown };
}

/**
 * 搜索量解析：`1,234` / `12K` / `1.2万` / `-` / `N/A` 都要能处理。
 * 🔴 解析不出来就给 null 并记原因，**不填 0** —— 0 会被读成"这个词没人搜"。
 */
export function parseVolume(raw) {
  const s = String(raw == null ? "" : raw).trim().replace(/,/g, "").replace(/\s/g, "");
  if (!s) return { value: null, reason: "空值" };
  if (/^(?:-|—|n\/?a|null|none)$/i.test(s)) return { value: null, reason: "导出文件里就是空/NA" };
  const m = s.match(/^([0-9]*\.?[0-9]+)([kKmM万wW]?)$/);
  if (!m) return { value: null, reason: `不是数字：「${String(raw).trim().slice(0, 20)}」` };
  let n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === "k") n *= 1e3;
  else if (unit === "m") n *= 1e6;
  else if (unit === "万" || unit === "w") n *= 1e4;
  if (!Number.isFinite(n)) return { value: null, reason: "数值异常" };
  return { value: Math.round(n), reason: "" };
}

/** 从表头猜这是哪个工具的导出（只用于显示来源，不参与判定）。 */
export function guessSource(header = []) {
  const all = header.map(norm).join(" | ");
  if (/aba total click share|cerebro|helium/.test(all)) return "Helium 10";
  if (/jungle|js\b|keyword sales/.test(all)) return "Jungle Scout";
  if (/购买率|商品数|卖家精灵|sellersprite/.test(all)) return "卖家精灵 / SellerSprite";
  if (/关键词|搜索量/.test(all)) return "中文表格导出";
  return "通用 CSV";
}

/**
 * 导入。
 * @param {string} text CSV 原文
 * @param {{max?:number, sourceName?:string}} [opts]
 * @returns {{rows:Array<{keyword:string,volume:number|null,volumeRaw:string,asin:string}>,
 *            mapping:object, header:string[], unknownColumns:string[], delimiter:string,
 *            problems:string[], dropped:Array<{keyword:string,reason:string}>,
 *            total:number, truncated:boolean, source:string, sourceName:string,
 *            volumeColumn:boolean, note:string}}
 */
export function importKeywordCsv(text, opts = {}) {
  const max = Number(opts.max) > 0 ? Number(opts.max) : CSV_MAX_ROWS;
  const src = String(text == null ? "" : text);
  const delimiter = sniffDelimiter(src);
  const records = parseRecords(src, { delimiter }).filter((r) => r.some((c) => String(c || "").trim()));

  const empty = {
    rows: [], mapping: { keyword: null, volume: null, asin: null }, header: [], unknownColumns: [],
    delimiter, problems: [], dropped: [], total: 0, truncated: false,
    source: "通用 CSV", sourceName: opts.sourceName || "", volumeColumn: false,
    note: "没有可导入的行 —— 文件是空的，或者只有表头。",
  };
  if (records.length < 2) {
    return { ...empty, problems: [records.length === 1 ? "只有表头，没有数据行" : "文件是空的"] };
  }

  const header = records[0].map((h) => String(h == null ? "" : h).trim());
  const { mapping, matched, unknown } = detectColumns(header);
  const source = guessSource(header);

  if (mapping.keyword == null) {
    return {
      ...empty,
      header,
      unknownColumns: unknown,
      source,
      problems: [
        "没找到「关键词」列。表头是：" + header.filter(Boolean).slice(0, 12).join(" | "),
        "把表头改成 Keyword / Search Term / 关键词 任意一种再导一次；本工具不猜列，猜错会把 ASIN 当关键词。",
      ],
    };
  }

  const rows = [];
  const dropped = [];
  const seen = new Map();   // 小写词 → rows 下标（重复词保留搜索量更大的那条）
  let total = 0;
  let ragged = 0;

  for (const cells of records.slice(1)) {
    const raw = cells[mapping.keyword] == null ? "" : String(cells[mapping.keyword]).trim();
    if (!raw) continue;
    total += 1;
    const key = raw.toLowerCase();
    const volRaw = mapping.volume == null ? "" : String(cells[mapping.volume] == null ? "" : cells[mapping.volume]).trim();
    const v = mapping.volume == null ? { value: null, reason: "文件里没有搜索量列" } : parseVolume(volRaw);
    if (v.reason && v.value == null && mapping.volume != null && volRaw) {
      dropped.push({ keyword: raw, reason: v.reason });
    }
    // 🔴 列数比表头多 = 某个字段里有未加引号的分隔符。最常见的就是千分位：
    //    `保温杯,8,500` 会被切成两格，搜索量读成 8（数字合法，所以**不会报错**）。
    //    这种行标成「存疑」，界面显示成 `8 ?` 并提示重量，不假装读对了。
    const isRagged = cells.length > header.length;
    if (isRagged) ragged += 1;
    const item = {
      keyword: raw,
      volume: v.value,
      volumeRaw: volRaw,
      volumeSuspect: Boolean(isRagged && mapping.volume != null),
      asin: mapping.asin == null ? "" : String(cells[mapping.asin] == null ? "" : cells[mapping.asin]).trim(),
    };
    if (seen.has(key)) {
      const at = seen.get(key);
      const prev = rows[at];
      if ((item.volume || 0) > (prev.volume || 0)) rows[at] = item;
      continue;
    }
    if (rows.length >= max) continue;
    seen.set(key, rows.length);
    rows.push(item);
  }

  const truncated = total > rows.length && rows.length >= max;
  const problems = [];
  if (!rows.length) problems.push("有关键词列，但一行都没取到词（单元格全空？）");
  if (mapping.volume == null) problems.push("没有搜索量列 —— 词能进覆盖矩阵，但不能按搜索量排序。想让搜索量显示出来，导出时把 Search Volume 一起勾上。");
  if (ragged) problems.push(`有 ${ragged} 行的列数比表头多，通常是数字里的千分位逗号没加引号（如 8,500）。这些行的搜索量标了「存疑」，请回导出工具改成加引号或用制表符分隔后重导。`);
  if (dropped.length) problems.push(`有 ${dropped.length} 行的搜索量读不出来（例如 ${dropped.slice(0, 3).map((d) => d.reason).join("；")}），这些词的搜索量留空而不是填 0。`);
  if (truncated) problems.push(`超过上限 ${max} 行，已截断；如需全部导入请先按搜索量排序再导。`);

  return {
    rows, mapping, header, unknownColumns: unknown, delimiter,
    problems, dropped,
    total, truncated, source, sourceName: opts.sourceName || "",
    volumeColumn: mapping.volume != null,
    matched,
    note: rows.length
      ? `共读入 ${rows.length} 个词（去重后，原始 ${total} 行）。搜索量来自你导入的文件（${opts.sourceName || "CSV"}，识别为 ${source}），**不是本工具估算的**。`
      : "没有可导入的词。",
  };
}

/** 取词列表：直接喂给 analyzeCoverage 的 keywords。 */
export function keywordList(rows = []) {
  return rows.map((r) => r.keyword).filter(Boolean);
}

/**
 * 把搜索量并进覆盖度结果。
 *
 * 🔴 只**附加**一列，不改判定：覆盖度仍然只看「词有没有出现在文案里」。
 *    把搜索量并进去是为了排序与取舍（哪些缺口更值得补），不是让分数变高。
 *
 * @returns {{rows:Array, matched:number, missing:number, sourceLabel:string}}
 */
export function withVolumes(coverageRows = [], imported, opts = {}) {
  const list = Array.isArray(imported) ? imported : (imported && imported.rows) || [];
  const map = new Map();
  for (const r of list) {
    const k = String(r.keyword || "").toLowerCase();
    if (!k) continue;
    if (!map.has(k) || (r.volume || 0) > (map.get(k).volume || 0)) map.set(k, r);
  }
  let matched = 0;
  const rows = coverageRows.map((r) => {
    const hit = map.get(String(r.term || "").toLowerCase());
    if (hit) matched += 1;
    return { ...r, volume: hit ? hit.volume : null, volumeRaw: hit ? hit.volumeRaw : "", volumeSuspect: Boolean(hit && hit.volumeSuspect) };
  });
  const sourceLabel = opts.sourceName
    ? `${opts.sourceName}${opts.source ? `（${opts.source}）` : ""}`
    : "导入的 CSV";
  return { rows, matched, missing: rows.length - matched, sourceLabel };
}
