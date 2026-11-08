/**
 * 亚马逊搜索建议接口 —— **唯一实现**。
 *
 * 被两处复用（同一份代码，不写第二份）：
 *   · `mcp/server.mjs` 的 `amazon_suggest` 工具（交互式，一次一个词根）
 *   · `tools/collect-keywords.mjs` 的每周采集（批量，带节流）
 *
 * ── 为什么这个接口值得单独成模块 ──────────────────────────────────
 * 它返回的是**真实买家在搜索框里看到的词**，零 Key、零费用、零账号。
 * 对「词根 → 长尾」这件事来说，它是最便宜的入口。所以它被允许存在于这个项目里。
 *
 * ── 克制设计（都是刻意的，改成"更努力"会出事）────────────────────
 *   · 每次调用**只发 1 个请求**，8 秒超时，**不重试、不翻页**；
 *   · 响应超 256KB 立刻中止（正常响应 1–4KB，超了说明拿到的不是这个接口）；
 *   · 取不到就抛错，**绝不返回空数组冒充「没有建议词」**；
 *   · 返回 0 条时给 `note` 明说「分不清是没词还是参数没对上」。
 *
 * ⚠️ mid / lop 只有 US、DE 实测过。其余站点可能返回空，属于"参数没对上"，
 *    不是"没有人搜"。`verifiedMarket` 字段就是用来告诉调用方这一点的。
 */
import { request as httpsRequest } from "node:https";

export const MARKET = {
  US: { host: "completion.amazon.com", mid: "ATVPDKIKX0DER", lop: "en_US", verified: true },
  DE: { host: "completion.amazon.de", mid: "A1PA6795UKMFR9", lop: "de_DE", verified: true },
  UK: { host: "completion.amazon.co.uk", mid: "A1F83G8C2ARO7P", lop: "en_GB", verified: false },
  FR: { host: "completion.amazon.fr", mid: "A13V1IB3VIYZZH", lop: "fr_FR", verified: false },
  ES: { host: "completion.amazon.es", mid: "A1RKKUPIHCS9HS", lop: "es_ES", verified: false },
  IT: { host: "completion.amazon.it", mid: "APJ6JRA9NG5V4", lop: "it_IT", verified: false },
  JP: { host: "completion.amazon.co.jp", mid: "A1VC38T7YXB528", lop: "ja_JP", verified: false },
  CA: { host: "completion.amazon.ca", mid: "A2EUQ1WTGCTBG2", lop: "en_CA", verified: false },
};

export const SITE_KEYS = Object.keys(MARKET);
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const TIMEOUT_MS = 8000;

/**
 * 站点代码归一。接受 `US` / `us` / `com`（bestsellers.js 用的是 `com` 这一套）
 * —— 两套站点编码在本项目里同时存在，这里做**唯一**的转换点。
 */
export function normalizeSite(site) {
  const s = String(site || "US").trim().toUpperCase();
  if (MARKET[s]) return s;
  if (s === "COM") return "US";
  if (s === "CO.UK") return "UK";
  return "US";
}

/** 建议词请求 URL。**单独成函数**，自检可以只验 URL 形状而不联网。 */
export function suggestUrl(prefix, site = "US", limit = 11) {
  const key = normalizeSite(site);
  const m = MARKET[key];
  const n = Math.min(20, Math.max(1, Math.floor(Number(limit) || 11)));
  return `https://${m.host}/api/2017/suggestions`
    + `?mid=${m.mid}&alias=aps&lop=${m.lop}`
    + `&prefix=${encodeURIComponent(String(prefix || ""))}&limit=${n}`
    + "&suggestion-type=KEYWORD";
}

/** 从接口响应 JSON 里取词。**纯函数**，自检直接喂 fixture。 */
export function parseSuggestions(json) {
  const arr = Array.isArray(json?.suggestions) ? json.suggestions : [];
  const out = [];
  const seen = new Set();
  for (const s of arr) {
    const v = typeof s === "string" ? s : s?.value;
    const t = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/**
 * 取一次建议词。
 * @returns {Promise<{site:string,prefix:string,count:number,suggestions:string[],verifiedMarket:boolean,note:string}>}
 */
export function suggest(prefix, site = "US", limit = 11) {
  const key = normalizeSite(site);
  const m = MARKET[key];
  const url = suggestUrl(prefix, key, limit);
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, {
      method: "GET",
      timeout: TIMEOUT_MS,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          + "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept-Language": `${m.lop.replace("_", "-")},en;q=0.8`,
      },
    }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on("data", (c) => {
        bytes += c.length;
        if (bytes > MAX_RESPONSE_BYTES) { req.destroy(new Error("响应超过 256KB，已中止")); return; }
        chunks.push(c);
      });
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        let j;
        try { j = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
          return reject(new Error("返回不是 JSON（可能被风控页拦住）"));
        }
        const items = parseSuggestions(j);
        resolve({
          site: key,
          prefix: String(prefix || ""),
          count: items.length,
          suggestions: items,
          verifiedMarket: m.verified,
          note: items.length
            ? ""
            : "接口返回 0 条。可能是该站点 mid/lop 没对上，也可能这个词真的没有建议词 —— 两种情况本工具分不出来，别当成「没人搜」。",
        });
      });
    });
    req.on("timeout", () => req.destroy(new Error("请求超时（8s）")));
    req.on("error", reject);
    req.end();
  });
}
