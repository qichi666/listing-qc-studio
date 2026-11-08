/**
 * 把"任意厂商的关键词接口返回"归一成 `{ term, volume, rank }`。
 *
 * ── 为什么是"猜字段"而不是"按文档解析" ──────────────────────────────
 * 外部 MCP 是别人维护的：同一条数据在不同工具里可能叫 `keyword` / `keywordText` /
 * `searchTerm`（这些在本项目实测过的卖家精灵返回里都出现过），改版也不会通知我们。
 * 写死一套 schema 的结果是"某天开始安静地返回 0 条"，而界面只会显示"没有数据"，
 * 使用者会以为是自己没搜到，不会想到是字段改名了。
 *
 * 所以这里做的是**有原则的宽容**：
 *   ① 只认"长得像词"的字段名，不做语义猜测（不从 title 里抠词 —— 那是另一件事）；
 *   ② 认不出来就返回 0 条并说明为什么，**绝不编**（数据不足 ≠ 通过，同一个原则）；
 *   ③ 把实际用到的字段名回报给调用方（`mapping`），界面可以显示
 *      "按 keyword→term、searches→volume 认出 187 条" —— 猜对了看得见，猜错了也看得见。
 *
 * 🔴 纯函数、无 IO、无依赖：服务端归一、界面预览、自检断言用的是同一份实现。
 */

/* 字段候选按"越好用越靠前"排，不是按字母序。
 * 前面几个是本项目在卖家精灵返回里真实见到的；后面是常见别名。 */
const TERM_KEYS = [
  "keyword", "keywordText", "keyword_text", "searchTerm", "search_term",
  "term", "word", "phrase", "query", "kw", "name",
];
const VOL_KEYS = [
  "searchVolume", "search_volume", "searches", "volume",
  "monthlySearch", "monthly_search", "searchVolumeCurrent", "avgSearchVolume", "sv", "searchCount",
];
const RANK_KEYS = [
  "rank", "position", "organicRank", "organic_rank", "ranking", "seq", "order",
];
const ASIN_KEYS = ["asin", "parentAsin", "parent_asin"];

/* 容器字段：值是"一串词"时也要能认（`{ keywords: ["a","b"] }`）。 */
const LIST_KEYS = ["keywords", "terms", "words", "items", "list", "data", "results", "rows"];

const MAX_DEPTH = 8;
const MAX_NODES = 40000;
const MAX_TERMS = 2000;

function asText(v) {
  if (typeof v === "string") {
    const s = v.trim();
    return s && s.length <= 200 ? s : "";
  }
  return "";
}

function asNumber(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    // "1,234" / "12.3K" 这类展示值也认；认不出就给 null（不折算成 0）
    const s = v.trim().replace(/,/g, "");
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    const m = /^(-?\d+(?:\.\d+)?)\s*([kKmMwW])$/.exec(s);
    if (m) {
      const mul = { k: 1e3, m: 1e6, w: 1e4 }[m[2].toLowerCase()];
      return Number(m[1]) * mul;
    }
  }
  return null;
}

function firstBy(obj, keys) {
  for (const k of keys) {
    if (!(k in obj)) continue;
    const t = asText(obj[k]);
    if (t) return { value: t, key: k };
  }
  return null;
}

function firstNum(obj, keys) {
  for (const k of keys) {
    if (!(k in obj)) continue;
    const n = asNumber(obj[k]);
    if (n !== null) return { value: n, key: k };
  }
  return null;
}

/**
 * @param {unknown} payload 外部工具返回里 `data` 那一段（已 JSON.parse）
 * @returns {{terms:Array<{term:string,volume:number|null,rank:number|null,asins:string[]}>,
 *            mapping:Record<string,string>, count:number, scanned:number, why:string}}
 */
export function normalizeTerms(payload) {
  const mapping = {};        // 归一字段 → 原始字段名（取第一次命中的那个）
  const byTerm = new Map();  // 小写词 → 记录
  let scanned = 0;
  let nodes = 0;

  const note = (slot, key) => { if (!mapping[slot]) mapping[slot] = key; };

  const push = (term, volume, rank, asin) => {
    const k = term.toLowerCase();
    const cur = byTerm.get(k);
    if (!cur) {
      if (byTerm.size >= MAX_TERMS) return;
      byTerm.set(k, { term, volume: volume ?? null, rank: rank ?? null, asins: asin ? [asin] : [] });
      return;
    }
    // 同一个词出现多次：取"最大搜索量 + 最小排名"，并把 ASIN 合并去重。
    // 不取平均 —— 平均会把一个爆款词和一堆噪声拉平，而使用者要的是"这个词值不值得打"。
    if (volume !== null && (cur.volume === null || volume > cur.volume)) cur.volume = volume;
    if (rank !== null && (cur.rank === null || rank < cur.rank)) cur.rank = rank;
    if (asin && !cur.asins.includes(asin)) cur.asins.push(asin);
  };

  const walk = (node, depth) => {
    if (depth > MAX_DEPTH || nodes > MAX_NODES) return;
    nodes++;
    if (Array.isArray(node)) {
      // 纯字符串数组：`["leather bag", "tote bag"]` —— 没有搜索量，但词是真的
      for (const it of node) {
        if (typeof it === "string") {
          const t = asText(it);
          if (t) { scanned++; push(t, null, null, null); }
          else if (it && typeof it === "object") walk(it, depth + 1);
        } else if (it && typeof it === "object") {
          walk(it, depth + 1);
        }
      }
      return;
    }
    if (!node || typeof node !== "object") return;

    const term = firstBy(node, TERM_KEYS);
    if (term) {
      scanned++;
      note("term", term.key);
      const vol = firstNum(node, VOL_KEYS);
      const rk = firstNum(node, RANK_KEYS);
      const asin = firstBy(node, ASIN_KEYS);
      if (vol) note("volume", vol.key);
      if (rk) note("rank", rk.key);
      if (asin) note("asin", asin.key);
      push(term.value, vol?.value ?? null, rk?.value ?? null, asin?.value ?? null);
    }

    for (const [k, v] of Object.entries(node)) {
      if (!v || typeof v !== "object") continue;
      // 只往下走"看起来是容器"的字段，避免把 description 之类的大文本区整棵扫一遍。
      if (Array.isArray(v) || LIST_KEYS.includes(k) || TERM_KEYS.includes(k) || VOL_KEYS.includes(k)) {
        walk(v, depth + 1);
      } else if (depth < 2) {
        // 最上面两层的未知对象仍然下钻（各家的外壳层名字千奇百怪：
        // data / result / response / payload / items / page …）。
        walk(v, depth + 1);
      }
    }
  };

  walk(payload, 0);

  const terms = [...byTerm.values()];
  let why = "";
  if (!terms.length) {
    why = scanned
      ? "扫描到了对象，但没有一个字段像关键词（可能是返回结构变了，或被包在没走到的层级里）"
      : "返回里没有找到任何对象数组 —— 先看一眼原始返回，确认这个工具是不是返回词表";
  } else if (!mapping.volume) {
    why = "认出了关键词，但没认出搜索量字段 —— 可以按词用，但没法按热度排序";
  }

  return { terms, mapping, count: terms.length, scanned, why };
}

export const TERM_FIELDS = { TERM_KEYS, VOL_KEYS, RANK_KEYS, ASIN_KEYS };
