/**
 * 词库快照的**只读**落盘层（Node 专用）。
 *
 * 🔴 这里**没有写函数**，是刻意的：写快照只发生在 `tools/collect-keywords.mjs` 里
 *    （定时任务那个进程）。服务与 MCP 都是只读的，让它们拿不到写入口，
 *    "MCP 只读" 这件事就不需要靠自觉。
 *
 * 路径：默认 `data/keywords/latest.json`，可用 `LISTING_KEYWORDS` 整个目录重定向
 *       （与 LISTING_DATA 同一个套路，自检用它把读写导向临时目录）。
 * 文件名是**写死**的，不接受外部传入 —— 没有拼接就没有穿越。
 *
 * ── 站点维度（P1-2，只做结构，不真开 8 站）─────────────────────────
 * 🔴 **不传 site = 完全保持旧行为**：`latestPath()` / `readLatest()` 仍读写
 *    `latest.json`。现有 `data/keywords/latest.json`、以及 `keywords-selftest` 的
 *    一整套 `latest.json` 断言都依赖这一点，改默认文件名等于把整条链路打断。
 *    只有**显式传了 site**（`readLatest(env, "US")`）才走 `latest-US.json`；
 *    它不存在而旧 `latest.json` 还在 → 读旧的并打 `legacy:true`（过渡态，不是错误）。
 *    "只做结构"的意思就是：站点文件名的能力先备好，默认仍跑单站 US 的兼容态。
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { staleness, isEmpty } from "./keyword-vault.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(HERE, "..");
export const LATEST_NAME = "latest.json";
/** 采集状态文件：成败都写。`latest.json` 只反映"最后一次成功"，它反映"最后一次尝试"。 */
export const STATUS_NAME = "_status.json";

/** 历史摘要保留份数。104 周 ≈ 两年：少于这个数就做不了"去年同期"。采集器复用同一个数。 */
export const HISTORY_KEEP = 104;

/**
 * 站点编码归一（本地版，不 import `amazon-suggest`）。
 * 🔴 两套站点编码在本项目里同时存在（`com` / `US`），这里与 `normalizeSite` 同口径：
 *    `com→US`、`co.uk→UK`、其余大写码原样、未知回落 `US`。
 *    只用于**拼文件名**，不参与任何抓取逻辑；单独一份是为了让只读层不依赖网络模块。
 */
const SITE_ALIAS = { COM: "US", "CO.UK": "UK", CO_UK: "UK" };
const SITE_CODES = new Set(["US", "UK", "DE", "FR", "ES", "IT", "JP", "CA"]);
function siteCode(site) {
  const s = String(site || "US").trim().toUpperCase();
  if (SITE_ALIAS[s]) return SITE_ALIAS[s];
  return SITE_CODES.has(s) ? s : "US";
}

/** 词库目录。环境变量优先，否则 `<项目>/data/keywords`。 */
export function keywordsDir(env = process.env) {
  const v = String(env.LISTING_KEYWORDS || "").trim();
  return v ? resolve(v) : join(PROJECT_ROOT, "data", "keywords");
}

/**
 * 最新快照路径。
 * @param {object} env
 * @param {string|null} [site] 显式站点 → `latest-<SITE>.json`；不传 → `latest.json`（默认不变）
 */
export function latestPath(env = process.env, site = null) {
  if (site == null || String(site).trim() === "") return join(keywordsDir(env), LATEST_NAME);
  return join(keywordsDir(env), `latest-${siteCode(site)}.json`);
}

export function statusPath(env = process.env) {
  return join(keywordsDir(env), STATUS_NAME);
}

/**
 * 读采集状态。**不缓存**：这个文件只有几百字节，缓存它换不来性能，只会换来"改了看不到"。
 *
 * 为什么必须存在：定时任务跑挂了，`latest.json` 还是上一份（甚至还是新鲜的），
 * 界面只会看到"数据正常" —— 唯一的证据就是"最后一次尝试失败了"。
 * 这正是红线 9「陈旧要说」缺的那一半：陈旧说的是数据老，状态说的是**采集挂**。
 */
export function readStatus(env = process.env) {
  const file = statusPath(env);
  if (!existsSync(file)) {
    return { ok: false, reason: "missing", error: "还没有采集状态（这台机器上还没跑过采集）", status: null, file };
  }
  try {
    const status = JSON.parse(readFileSync(file, "utf8"));
    if (!status || typeof status !== "object" || Array.isArray(status)) throw new Error("不是一个对象");
    return { ok: true, file, status };
  } catch (e) {
    return { ok: false, reason: "unreadable", error: `状态文件读不出来：${e.message}`, status: null, file };
  }
}

/**
 * 读最新快照。**任何异常都折成 `{ok:false}`，不抛** ——
 * 调用方（`/api/keywords`、MCP 工具）面对的是"没有数据"这种正常状态，
 * 不是异常。抛错会让人以为服务坏了。
 *
 * 解析缓存：`latest.json` 实测 842 KB / 2,135 词 + 769 ASIN。
 * 每次点「载入本周词库」、每次 MCP 调 `keyword_snapshot` 都重新读 + `JSON.parse` 一遍，
 * 单次约 10–20 ms 的纯浪费（界面连点、模型连续调用时会叠加）。
 *
 * 🔴 缓存键是 **文件路径 + mtimeNs + size**，不是"读一次就永久记住"：
 *    · 采集器重写文件 → mtime 变 → 自动重读（"变了必须看见"）；
 *    · 文件没动 → 命中缓存（"没变不必重读"）。
 *    用 `mtimeMs` 不够：毫秒精度下"同一毫秒内写两次"会被判成没变，读到旧快照。
 *    NTFS / ext4 都有比毫秒细的时间戳，`{ bigint: true }` 才拿得到 `mtimeNs`。
 *
 * 🔴 站点回退（P1-2）：显式传 site 时优先读 `latest-<SITE>.json`；它不存在但
 *    旧 `latest.json` 还在 → 读旧的并给返回值加 `legacy:true`。默认不传 site 时
 *    **不会**触发这条分支，返回对象与旧版逐字段一致（不多一个字段、不改 file）。
 *
 * @param {object} env
 * @param {string|null} [site]
 */
let cache = null;

export function readLatest(env = process.env, site = null) {
  const file = latestPath(env, site);
  const legacyFile = join(keywordsDir(env), LATEST_NAME);
  let target = file;
  let legacy = false;
  if (site != null && !existsSync(target) && existsSync(legacyFile)) {
    target = legacyFile;      // 站点文件还没生成，读旧的单文件快照（过渡态）
    legacy = true;
  }
  if (!existsSync(target)) {
    cache = null;                       // 文件被删了：别让下一次读命中旧快照
    return { ok: false, file: target, reason: "missing", error: "还没有词库快照（定时任务还没跑过）", snapshot: null };
  }
  let stat;
  try {
    stat = statSync(target, { bigint: true });
  } catch (e) {
    return { ok: false, file: target, reason: "unreadable", error: `读不了快照：${e.message}`, snapshot: null };
  }

  let snap;
  let cached = false;
  if (cache && cache.file === target && cache.mtimeNs === stat.mtimeNs && cache.size === stat.size) {
    snap = cache.snapshot;
    cached = true;
  } else {
    let raw;
    try {
      raw = readFileSync(target, "utf8");
    } catch (e) {
      return { ok: false, file: target, reason: "unreadable", error: `读不了快照：${e.message}`, snapshot: null };
    }
    try {
      snap = JSON.parse(raw);
    } catch (e) {
      return { ok: false, file: target, reason: "corrupt", error: `快照不是合法 JSON：${e.message}`, snapshot: null };
    }
    if (!snap || !Array.isArray(snap.keywords) || !Array.isArray(snap.asins)) {
      return { ok: false, file: target, reason: "corrupt", error: "快照结构不对（缺 keywords / asins 数组）", snapshot: null };
    }
    cache = { file: target, mtimeNs: stat.mtimeNs, size: stat.size, snapshot: snap };
  }

  const out = {
    ok: true,
    file: target,
    bytes: Number(stat.size),
    cached,
    snapshot: snap,
    // 陈旧判定**不进缓存**：它依赖"现在几点"，缓存了就会把 ageDays 冻在第一次读的时刻。
    staleness: staleness(snap),
    empty: isEmpty(snap),
  };
  if (legacy) out.legacy = true;
  return out;
}

/**
 * 同日第 N 次采集该写哪份历史摘要（P2#5）。
 *
 * 🔴 同日重跑**不覆盖**第一次：`2026-11-07.json` 已存在就写 `2026-11-07-2.json`、
 *    第三次 `-3` …。覆盖会把当天第一次的真实结果抹掉，趋势图凭空多一个缺口。
 *    序号从 2 起（第一次不带序号，文件名可读）；到 99 封顶复用，不新建第 100 个。
 *
 * 🔴 只**算路径**，不建目录、不删文件：这一层是只读层，写与清理都归采集器。
 *    保留策略（只留最新 `HISTORY_KEEP` 份）由采集器按 (日期, 序号) 排序执行，
 *    **不靠 mtime** —— 文件名的日期就是时间，mtime 会被拷贝 / 同步工具改掉。
 *
 * @param {object} env 传 `{LISTING_KEYWORDS: outDir}` 即可把根目录指到采集器的 `--out`
 * @param {string|null} site 显式站点 → `history/<SITE>/`；不传 → `history/`（默认兼容态）
 * @param {string} date `YYYY-MM-DD`
 * @returns {string} 下一个可用的历史摘要绝对路径
 */
export function nextHistoryPath(env = process.env, site = null, date = new Date().toISOString().slice(0, 10)) {
  const dir = site == null || String(site).trim() === ""
    ? join(keywordsDir(env), "history")
    : join(keywordsDir(env), "history", siteCode(site));
  const day = String(date).slice(0, 10);
  const first = join(dir, `${day}.json`);
  if (!existsSync(first)) return first;
  for (let i = 2; i <= 99; i++) {
    const p = join(dir, `${day}-${i}.json`);
    if (!existsSync(p)) return p;
  }
  return join(dir, `${day}-99.json`);
}
