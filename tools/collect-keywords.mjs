#!/usr/bin/env node
/**
 * 每周词库采集器（词根 → 长尾建议词 + 榜单 → ASIN）。
 *
 * 这是**唯一**会写 `data/keywords/` 的进程。服务端与 MCP 都只读。
 *
 * ── 它为什么存在 ───────────────────────────────────────────────────
 * 原来的问题是「关键词得你自己输进去」。答案不是做个输入框，是**没人需要输**：
 * 词根由 `assets/keyword-seeds.js` 里的人工表给出，长尾由搜索建议接口给出，
 * ASIN 由公开榜单页给出，每周合一份快照，前端与 MCP 都读它。
 *
 * ── 四条纪律 ──────────────────────────────────────────────────────
 *   ① **失败不覆盖**：本周一条都没抓到 → 不写 latest.json，退出码 2，让定时任务红。
 *      用空数据覆盖好数据，是这类采集器最常见的自毁方式（而且没人会发现）。
 *   ② **一个词根失败不影响其他**：逐条 catch，最后按成功率判定整体状态。
 *   ③ **有节流**：每次请求之间 sleep，绝不并发打。宁可慢，也不进风控。
 *   ④ **复用唯一实现**：建议词走 `assets/amazon-suggest.js`，榜单走
 *      `assets/bestsellers.js`（含 8 站主机白名单 + SSRF 判据）—— 这里不另写抓取。
 *
 * ── 站点与词根覆盖层（P1-2 / G-4）───────────────────────────────────
 *   · 默认 `--site com` 仍只写 `latest.json` + `history/YYYY-MM-DD.json`（兼容态）；
 *     显式 `--site com,de` 才按站点产出 `latest-US.json` / `latest-DE.json`
 *     与 `history/US/` / `history/DE/`。**只做结构，不真开 8 站**。
 *   · 词根以 `assets/keyword-roots.js` 的 `resolveRoots()` 为准：运营改
 *     `data/keywords/roots.json` 即可增删词根，源码不动；覆盖层读不出来按基线跑。
 *
 * ── 用法 ──────────────────────────────────────────────────────────
 *   node tools/collect-keywords.mjs                       # 正常采集（US / 220 请求 / 2 页）
 *   node tools/collect-keywords.mjs --site com --pages 2
 *   node tools/collect-keywords.mjs --site com,de --out /tmp/kw --dry-run   # 两站产物
 *   node tools/collect-keywords.mjs --dry-run             # 用固定 fixture 跑完整管线，不联网
 *   node tools/collect-keywords.mjs --out /tmp/kw --dry-run
 *   node tools/collect-keywords.mjs --categories kitchen,beauty --max-requests 40
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync, existsSync, appendFileSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";

import { suggest, normalizeSite } from "../assets/amazon-suggest.js";
import { fetchBestsellers, SITES, CATS } from "../assets/bestsellers.js";
import { ROOTS, ROOT_GROUPS, ROOT_TO_GROUP } from "../assets/keyword-seeds.js";
import { buildSnapshot, digestOf, isEmpty, staleness, SCHEMA, termKey } from "../assets/keyword-vault.js";
import { resolveRoots } from "../assets/keyword-roots.js";
import { nextHistoryPath, HISTORY_KEEP } from "../assets/keywords-store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, "..");

/* ───────────────────────── 参数 ───────────────────────── */

function parseArgs(argv) {
  const get = (k, d) => {
    const i = argv.indexOf(`--${k}`);
    if (i < 0) return d;
    const v = argv[i + 1];
    return v && !v.startsWith("--") ? v : true;
  };
  // `--site com,de` 拆成站点列表；不传仍等价于单站 `com`（默认行为逐字节不变）。
  const sites = String(get("site", "com")).split(",").map((s) => s.trim()).filter(Boolean);
  if (!sites.length) sites.push("com");
  return {
    site: sites[0],
    sites,
    // 🔴 **不再写死魔法数**：不传就由「词根数 + 深挖数」推导（见 collectSite）。
    //    留 220 的后果是**默认配置永远不够**：194 条词根吃完只剩 26 个槽，而深挖要 27 个
    //    —— 第 221 次请求被静默跳过，报告里只多一行"预算跳过 1 个词根"，而设计容量明明写着 224。
    //    null = 没给 = 推导；给了数字才按人给的（并在产物里标 budgetSource:"cli"，可审计）。
    maxRequests: numOrNull(get("max-requests", null)),
    deep: Number(get("deep", 0)) || 0,
    pages: Number(get("pages", 2)) || 2,
    delay: Number(get("delay", 1200)) || 0,
    // P2#7：非 US 站点只做过结构验证，没在真实榜单上实测过类目映射。
    // 想真跑必须显式加 --allow-unverified，否则静默产出一份"看起来能用"的错数据。
    allowUnverified: Boolean(get("allow-unverified", false)),
    categories: String(get("categories", "")).split(",").map((s) => s.trim()).filter(Boolean),
    out: String(get("out", process.env.LISTING_KEYWORDS || join(PROJECT, "data", "keywords"))),
    dryRun: argv.includes("--dry-run"),
    fixture: String(get("fixture", join(HERE, "fixtures", "keywords", "dry-run.json"))),
    quiet: argv.includes("--quiet"),
  };
}

const opt = parseArgs(process.argv.slice(2));
// dry-run 是本地验证，不需要避让风控；1200ms 的礼貌间隔白等 10 秒没意义。
if (opt.dryRun) opt.delay = 0;
const log = (...a) => { if (!opt.quiet) console.log(...a); appendLog(a.join(" ")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 日志落盘。为什么必须有：从计划任务跑的时候，stdout 没有任何人接收 ——
 * 跑挂了等于什么都没留下，第二天只能看到"词库没更新"，看不到原因。
 * 一行一个文件（按 UTC 日期），自然轮转，不需要额外清理逻辑。
 * 写不进去也不能让采集失败：日志是旁证，不是产物。 */
function appendLog(text) {
  if (!run.logFile) return;
  try { appendFileSync(run.logFile, `${text}\n`, "utf8"); } catch { /* 无视 */ }
}
/** 错误同时进 stderr 与日志。 */
const elog = (...a) => { const s = a.join(" "); console.error(...a); appendLog(s); };

/** `--max-requests` 只在真的给了正整数时才认；其余（没给 / 给错 / 给 0）一律交回推导。 */
function numOrNull(v) {
  if (typeof v !== "string") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/* ───────────── 退出收尾：状态文件 + 文件锁，一处收口 ─────────────
 * 为什么不能在各处直接 process.exit：
 *   ① `process.exit()` **不会执行 finally** —— 想在 finally 里写状态是行不通的；
 *   ② 界面唯一能回答"昨晚到底跑没跑、为什么挂了"的东西就是 _status.json，
 *      它必须在**每条**退出路径上都写（成功也写，否则"上次成功时间"永远不更新）。
 */
const run = {
  startTs: Date.now(),
  statusFile: null,
  lockFile: null,
  logFile: null,   // <out>/logs/YYYY-MM-DD.log；计划任务里 stdout 没人接收，只能靠它留证据
  status: {
    schema: 1,
    site: null,
    lastAttemptAt: new Date().toISOString(),
    lastSuccessAt: null,
    ok: false,
    exitCode: null,
    reason: "",
    host: hostname(),
    budget: null,
    requests: 0,
    keywordCount: 0,
    asinCount: 0,
    durationMs: 0,
  },
};

function finish(code, reason = "") {
  try {
    run.status.exitCode = code;
    run.status.ok = code === 0;
    run.status.durationMs = Date.now() - run.startTs;
    if (reason) run.status.reason = reason;
    if (code === 0) run.status.lastSuccessAt = run.status.lastAttemptAt;
    // 失败时保留上一次的 lastSuccessAt，不清空 —— 清空会把"上次什么时候是好的"这条线索也弄丢。
    if (code !== 0) run.status.lastSuccessAt = run.status.lastSuccessAt || null;
    if (run.statusFile) {
      const tmp = `${run.statusFile}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(run.status, null, 2)}\n`, "utf8");
      renameSync(tmp, run.statusFile);
    }
  } catch (e) {
    console.error(`[status] 状态文件写不进去：${e.message}`);
  }
  try { if (run.lockFile) unlinkSync(run.lockFile); } catch { /* 删不掉也不影响结果 */ }
  // 收尾一行写清结局：日志末尾没有这行，说明进程是被强杀的（不是正常跑完）。
  appendLog(`[exit ${code}] ${reason || "ok"}（${run.status.durationMs}ms，词 ${run.status.keywordCount} / ASIN ${run.status.asinCount}）`);
  process.exit(code);
}

/** 抢锁。阈值**从参数推导**（不是"30 分钟"这种魔法数）：跑满预算要多久 + 2 分钟缓冲。 */
function acquireLock(file, timeoutMs) {
  if (existsSync(file)) {
    try {
      const held = JSON.parse(readFileSync(file, "utf8"));
      const age = Date.now() - Date.parse(held.startedAt);
      if (Number.isFinite(age) && age >= 0 && age < timeoutMs) return { ok: false, held, age };
      return { ok: true, stale: held, age };   // 超时 = 僵死，可覆盖
    } catch {
      return { ok: true, stale: null, age: null };  // 坏锁当僵死（否则一次崩溃就永久锁死）
    }
  }
  return { ok: true, stale: null, age: null };
}

/**
 * 从历史摘要里拼「这个词以前出现过吗」。
 *
 * 只读 `history/*.json` 的 `topTerms`（词级投影）——**没有投影就返回 null**，
 * 由合并层写成 `newly: "unknown"`。宁可说"分不出"，也不能把回归词算成本周新增。
 * 倒序遍历 + 首次赋值：Map 里存的是**最近一次**出现日期（正序会得到最老的那次）。
 *
 * 目录由调用方传进来：单站是 `history/`，多站点是 `history/<SITE>/`，
 * 这样才能读到"本站点"的历史，而不是把 8 个站点的投影混成一锅。
 */
function loadEverSeen(histDir, maxFiles = HISTORY_KEEP) {
  if (!existsSync(histDir)) return null;
  const files = readdirSync(histDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}(-\d+)?\.json$/.test(f))
    .sort().reverse().slice(0, maxFiles);
  const map = new Map();
  let used = 0;
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(join(histDir, f), "utf8"));
      const rows = d.topTerms || [];
      if (rows.length) used++;
      for (const r of rows) {
        const t = Array.isArray(r) ? r[0] : r?.term;
        if (!t) continue;
        const k = termKey(t);
        if (!map.has(k)) map.set(k, String(d.generatedAt || "").slice(0, 10) || null);
      }
    } catch { /* 坏历史文件跳过：它只影响"回归"判定，不该让本周采集失败 */ }
  }
  return used ? map : null;
}

/** US ↔ com 两套站点编码在本项目里同时存在，这里是**第二个**转换点（第一个在 amazon-suggest）。 */
function bestsellersSite(site) {
  const key = normalizeSite(site);
  return { US: "com", UK: "co.uk", DE: "de", FR: "fr", ES: "es", IT: "it", JP: "jp", CA: "ca" }[key] || "com";
}

/**
 * 读运营的词根覆盖层（`data/keywords/roots.json`）。
 *
 * 🔴 返回**原始文本**而不是解析后的对象：JSON 写坏了要由 `resolveRoots()` 统一判定并写
 *    「覆盖层读不出来，已按基线跑」的 note，采集器这里不能替它悄悄吞掉。
 *    文件不存在 = 没有覆盖层（纯基线，不是错误）；连读都读不出来单独给一句 error。
 */
function readOverlay(outDir) {
  const f = join(outDir, "roots.json");
  if (!existsSync(f)) return { text: null, error: null };
  try {
    return { text: readFileSync(f, "utf8"), error: null };
  } catch (e) {
    return { text: null, error: `覆盖层读不出来，已按基线跑（${e.message}）` };
  }
}

/* ─────────────────────── 数据源 ① 建议词 ─────────────────────── */

function suggestSource(FX, siteArg = opt.site) {
  if (opt.dryRun) {
    const map = FX.suggest || {};
    return async (root) => {
      const terms = map[root];
      if (!terms) throw new Error(`fixture 里没有词根「${root}」（dry-run 只认固定输入）`);
      return { site: "US", prefix: root, count: terms.length, suggestions: terms, verifiedMarket: true, note: "" };
    };
  }
  return (root) => suggest(root, siteArg, 11);
}

/* ─────────────────────── 数据源 ② 榜单 ─────────────────────── */

function asinSource(FX, siteArg = opt.site) {
  if (opt.dryRun) {
    const map = FX.bestsellers || {};
    return async (slug) => {
      const items = map[slug];
      if (!items) throw new Error(`fixture 里没有类目「${slug}」`);
      return { items };
    };
  }
  const site = bestsellersSite(siteArg);
  return (slug) => fetchBestsellers({ site, slug, pages: opt.pages });
}

/* ───────────────────────── 主流程 ───────────────────────── */

/**
 * 一次运行 = 一次锁 + 一份状态 + 一份日志 + 逐个站点各采一遍。
 *
 * 🔴 默认 `--site com`（单站）：产物仍是 `latest.json` + `history/YYYY-MM-DD.json`，
 *    与改造前逐字节一致 —— `keywords-selftest` 的整条链路、README 的路径说明、
 *    以及现有 `data/keywords/latest.json` 都靠这个兼容态活着。
 *    只有显式给多个站点（`--site com,de`）才启用站点文件名 `latest-<SITE>.json`
 *    与 `history/<SITE>/`：这是「只做结构」，不真开 8 站（8 站 ≈ 1976 请求 / 40 分钟）。
 */
async function main() {
  const now = new Date();
  const outDir = resolve(opt.out);
  const DEFAULT_DIR = resolve(PROJECT, "data", "keywords");

  // 🔴 dry-run 用的是**假数据**。写进真词库目录，下周的界面就会把 fixture 当成"本周词库"，
  //    而且没有人会立刻发现（数字看着很合理）。所以强制要求另指定 --out。
  if (opt.dryRun && outDir === DEFAULT_DIR) {
    console.error("✗ --dry-run 会产出 fixture 假数据，必须用 --out 指到临时目录（例如 --out /tmp/kw-dry）。");
    console.error("  这条不是洁癖：假数据一旦落进 data/keywords，界面与 MCP 会把它当本周真实词库展示。");
    process.exit(3);
  }
  if (opt.dryRun && !existsSync(opt.fixture)) {
    console.error(`✗ fixture 不存在：${opt.fixture}`);
    process.exit(3);
  }
  const FX = opt.dryRun ? JSON.parse(readFileSync(opt.fixture, "utf8")) : null;

  // ── P2#7 未实测站点门禁（写在**任何落盘之前**）────────────────────
  // 项目只实测过 US：其余站点的类目映射、价格/评分解析器没有真机验证。
  // 静默跑出来一份 `latest-DE.json`，界面会把它和 US 一样展示，而里面的字段可能整列是空的 ——
  // 这比直接拒绝更糟。所以要么默认只跑 US，要么显式承认「我知道没实测过」。
  // exit 4 与「锁冲突 3」「空数据 2」分开，定时任务的告警才能一眼看出是哪种。
  const unverified = opt.sites.map((s) => normalizeSite(s)).filter((s) => s !== "US");
  if (unverified.length && !opt.allowUnverified) {
    console.error(`✗ 站点 ${unverified.join(" / ")} 未在真实榜单上实测过：类目映射、价格与评分字段可能缺失。`);
    console.error("  确认接受这个降级后，加 --allow-unverified 重跑；默认只跑 US。");
    console.error("  本次未生成任何 latest-<SITE>.json（宁可不产数据，也不产看起来能用的错数据）。");
    process.exit(4);
  }
  if (unverified.length) {
    console.error(`⚠️ 已显式允许未实测站点 ${unverified.join(" / ")}：快照会带 verifiedMarket:false，界面标「○ 未实测」。`);
  }

  /* ── 状态文件 + 文件锁（整次运行一份） ─────────────────────── */
  // 日志先开：后面的每一步都要留证据，包括"锁冲突直接退出"这种。
  // 放在 dry-run 守卫之后 —— 守卫自己报的错还没到该落盘的地方。
  run.logFile = join(outDir, "logs", `${new Date().toISOString().slice(0, 10)}.log`);
  try { mkdirSync(dirname(run.logFile), { recursive: true }); } catch { run.logFile = null; }
  appendLog(`\n═══ ${new Date().toISOString()} 开跑 ═══`);
  appendLog(`命令：node collect-keywords.mjs ${process.argv.slice(2).join(" ")}`);

  const sites = opt.sites;
  const multi = sites.length > 1;
  run.status.site = sites.map((s) => normalizeSite(s)).join(",");
  run.statusFile = join(outDir, "_status.json");
  // 上一次的状态：失败时要把 lastSuccessAt 继承下来（否则"上次成功"会被抹成 null）
  if (existsSync(run.statusFile)) {
    try { run.status.lastSuccessAt = JSON.parse(readFileSync(run.statusFile, "utf8")).lastSuccessAt || null; } catch { /* 坏文件忽略 */ }
  }

  /* ── 词根覆盖层（一次解析，所有站点共用同一份词根集合） ───────── */
  const ov = readOverlay(outDir);
  const resolved = resolveRoots({ overlay: ov.text });
  const rootToGroup = new Map(resolved.groups.flatMap((g) => g.roots.map((r) => [r, g.key])));
  const overlayNotes = ov.error ? [ov.error, ...resolved.notes] : [...resolved.notes];
  if (resolved.rejected.length) {
    overlayNotes.push(`覆盖层有 ${resolved.rejected.length} 条没生效：${resolved.rejected.map((x) => `${x.root}（${x.reason}）`).join("；")}`);
  }
  // 🔴 dry-run 的 diff：**只打印**，不把覆盖层写回 roots.json，也不因预览改任何文件。
  //    运营改完覆盖层先看这一行就能知道「+几条 −几条」，确认无误再正式跑。
  if (opt.dryRun) {
    const addedN = resolved.roots.filter((r) => !ROOTS.includes(r)).length;
    const removedN = ROOTS.filter((r) => !resolved.roots.includes(r)).length;
    log(`词根覆盖层 diff：基线 ${ROOTS.length} → 生效 ${resolved.roots.length}（+${addedN} −${removedN}）`
      + (ov.text == null ? "｜未加载覆盖层" : "｜来自 roots.json")
      + "｜仅预览，不写盘（不修改 roots.json）");
  }
  for (const n of overlayNotes) log(`[词根覆盖层] ${n}`);

  // 锁阈值：跑满预算需要多久 + 2 分钟缓冲。1 站约 11 分钟、8 站约 42 分钟，
  // 与真实运行时间同阶 —— 既不会把"跑到一半"误判成僵死，也不会让异常挂起等半小时。
  const rootsForLock = (opt.dryRun
    ? Object.keys(FX.suggest || {}).filter((r) => resolved.roots.includes(r)).length
    : resolved.roots.length);
  const lockTimeoutMs = (rootsForLock + Math.min(Math.max(0, opt.deep), rootsForLock))
    * Math.max(1, opt.delay) + 120000;
  mkdirSync(outDir, { recursive: true });
  run.lockFile = join(outDir, ".lock");
  const lock = acquireLock(run.lockFile, lockTimeoutMs);
  if (!lock.ok) {
    elog(`✗ 另一次采集正在运行（pid ${lock.held?.pid ?? "?"}，已 ${Math.round((lock.age || 0) / 1000)}s，阈值 ${Math.round(lockTimeoutMs / 1000)}s）`);
    finish(3, `另一次采集正在运行（pid ${lock.held?.pid ?? "?"}）`);
  }
  if (lock.stale) log(`⚠️ 清理了一个僵死锁（${lock.stale.startedAt}，pid ${lock.stale.pid}）`);
  writeFileSync(run.lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), timeoutMs: lockTimeoutMs }), "utf8");

  const started = Date.now();
  for (const siteArg of sites) {
    await collectSite(siteArg, { FX, outDir, now, started, multi, resolved, rootToGroup, overlayNotes });
  }
  finish(0);
}

/** 单站采集 + 合并 + 写盘。失败（空快照）沿用原来的 finish(2) 退出码，默认路径话术不变。 */
async function collectSite(siteArg, { FX, outDir, now, started, multi, resolved, rootToGroup, overlayNotes }) {
  const site = normalizeSite(siteArg);
  // 站点文件名：单站（默认）保持 latest.json；多站点才带站点后缀。
  const latestFile = join(outDir, multi ? `latest-${site}.json` : "latest.json");
  const histDir = multi ? join(outDir, "history", site) : join(outDir, "history");
  const histSite = multi ? site : null;   // 传 null = nextHistoryPath 的兼容态 history/

  // 上一份快照（没有就 null）—— firstSeen 靠它延续
  let prev = null;
  // 覆盖层的告警放在最前面：它解释的是**整份数据可不可信**，比"截断了多少条"更要紧。
  const prevNotes = [...overlayNotes];
  if (existsSync(latestFile)) {
    try {
      prev = JSON.parse(readFileSync(latestFile, "utf8"));
      log(`[${site}] 读到上一份快照：${prev.generatedAt}（${prev.summary?.keywordCount ?? "?"} 词 / ${prev.summary?.asinCount ?? "?"} ASIN）`);
    } catch (e) {
      // 坏文件不当"没有"：留证据，继续跑（这一份会覆盖它，但报告里要写）。
      // 🔴 只打日志不够 —— 这一跑会把整份词表算成"本周新增"，摘要会变得很好看但全错，
      //    所以必须写进快照的 summary.note，让界面与 MCP 也看得见。
      prevNotes.push(`上一份快照读不出来（${e.message}），firstSeen 从本周重新开始，「本周新增」不是真的新增`);
      log(`⚠️ ${prevNotes[prevNotes.length - 1]}`);
    }
  } else {
    log(`[${site}] 没有历史快照：这是第一次采集，firstSeen 全部记为本周`);
  }

  // 历史投影（词级）：用来分「真首次」与「掉出又回来的回归词」。
  // 没有投影时合并层会写 newly:"unknown" —— 这条不是降级，是**拒绝瞎猜**。
  const everSeen = loadEverSeen(histDir);
  if (everSeen) log(`[${site}] 历史投影：${everSeen.size} 个词出现过（区分首次与回归用）`);
  else log(`[${site}] 历史里还没有词级投影：本次分不出「首次」与「回归」（新词数仍是「上周没有」的总数）`);

  /* ① 建议词：一轮词根 + 可选二轮扩词 */
  const getSuggest = suggestSource(FX, siteArg);
  // dry-run 只跑 fixture 里有的词根 —— 否则默认 175 个词根里 170 个会"失败"，
  // 报出来一片红，但那不是采集器的问题，是 fixture 故意只给了一小撮。
  const rootList = opt.dryRun
    ? Object.keys(FX.suggest || {}).filter((r) => resolved.roots.includes(r))
    : resolved.roots;
  const keywordHits = [];
  const sugStat = { requests: 0, ok: 0, empty: 0, failed: 0, errors: [] };
  const seenRoots = new Set();
  // 🔴 预算不够时**不许安静地少跑**：有人传 --max-requests 80 时，剩下 114 个词根会被跳过；
  //    不写进报告的话，那次快照看起来"词变少了"却查不出原因。
  const skippedRoots = [];
  // 预算从参数推导，不是常量：设计容量 = 词根数 + 深挖数。产物里落盘这组数，任何人可手算对账。
  const rootsPlanned = rootList.length;
  const deepPlanned = Math.min(Math.max(0, opt.deep), rootsPlanned);
  const budgetSource = opt.maxRequests == null ? "derived" : "cli";
  // 🔴 要留一份**未被消耗**的初值：`budget` 会在 runRoots 里逐次 --，写进产物时它已经是 0。
  //    第一版就是这么错的（产物里 budget 恒为 0，比没有更误导）。
  const budgetPlanned = opt.maxRequests == null ? rootsPlanned + deepPlanned : opt.maxRequests;
  let budget = budgetPlanned;
  if (budget < rootsPlanned) {
    log(`⚠️ 预算 ${budget} 小于词根数 ${rootsPlanned}：会有 ${rootsPlanned - budget} 个词根这一轮不跑（报告里会写"预算跳过"）`);
  }

  const runRoots = async (roots) => {
    for (const [root, group] of roots) {
      if (seenRoots.has(root)) continue;
      if (budget <= 0) { skippedRoots.push(root); continue; }
      seenRoots.add(root);
      budget--; sugStat.requests++;
      try {
        const r = await getSuggest(root);
        if (!r.count) { sugStat.empty++; }
        else {
          sugStat.ok++;
          for (const term of r.suggestions) keywordHits.push({ term, root, group });
        }
      } catch (e) {
        sugStat.failed++;
        if (sugStat.errors.length < 8) sugStat.errors.push(`${root}: ${e.message}`);
      }
      if (opt.delay) await sleep(opt.delay);
    }
    return true;
  };

  log(`\n[${site}] ① 建议词：${rootList.length} 个词根，预算 ${budget} 次请求（${budgetSource === "derived" ? "推导" : "手给"}）${opt.dryRun ? "（dry-run）" : `，间隔 ${opt.delay}ms`}`);
  await runRoots(rootList.map((r) => [r, rootToGroup.get(r) || ""]));
  const rootsRun = sugStat.requests;   // 一轮真正发出去的请求数（= 实际跑到的词根数）

  // 二轮扩词：拿第一轮里"多词短语"当新词根再问一次。
  // 目的不是"更全"，而是把「材质/用途」这类限定词打出来（`ceramic mug` → `ceramic mug with lid`）。
  let deepCandidates = 0;
  let deepSkippedDuplicate = 0;
  if (opt.deep > 0 && budget > 0) {
    const counts = new Map();
    for (const h of keywordHits) {
      const t = h.term;
      if (t.split(" ").length < 2) continue;
      const c = counts.get(t) || { n: 0, group: "" };
      c.n++;
      // 🔴 分组要**继承父词根**：二轮扩词出来的短语不在 rootToGroup 里，
      //    以前取到空串，于是这批词的 groups 是空的 —— 按类目筛（kitchen）会整批漏掉。
      if (!c.group && h.group) c.group = h.group;
      counts.set(t, c);
    }
    const deepRoots = [...counts.entries()].sort((a, b) => b[1].n - a[1].n)
      .slice(0, Math.min(opt.deep, budget)).map(([t, c]) => [t, c.group]);
    // 🔴 这一行解释了「设计容量 224、实发 221、差 3」：候选里有几个**本来就是词根**，
    //    runRoots 首行 `seenRoots.has()` 会直接 continue，既不消耗预算也不发请求。
    //    不数出来，这个 3 就永远说不清（上一轮评审正是卡在这里）。
    deepCandidates = deepRoots.length;
    deepSkippedDuplicate = deepRoots.filter(([t]) => seenRoots.has(t)).length;
    log(`[${site}] ② 二轮扩词：${deepCandidates} 个候选（其中 ${deepSkippedDuplicate} 个本就是词根，去重跳过；预算剩 ${budget}）`);
    await runRoots(deepRoots);
  }
  const deepAttempted = sugStat.requests - rootsRun;

  /* ② 榜单：ASIN */
  const getAsins = asinSource(FX, siteArg);
  const asins = [];
  const catStat = { requests: 0, ok: 0, failed: 0, items: 0, errors: [] };
  const catPool = opt.dryRun
    ? Object.keys(FX.bestsellers || {})
    : (opt.categories.length ? opt.categories : resolved.groups.map((g) => g.cat));
  const catSlugs = catPool
    .filter((c, i, a) => a.indexOf(c) === i && CATS.some((x) => x.slug === c));
  const groupOfCat = new Map(resolved.groups.map((g) => [g.cat, g.key]));

  log(`\n[${site}] ③ 榜单：${catSlugs.length} 个类目 × ${opt.pages} 页`);
  for (const slug of catSlugs) {
    catStat.requests++;
    try {
      const r = await getAsins(slug);
      const items = r.items || [];
      catStat.ok++;
      catStat.items += items.length;
      for (const it of items) {
        asins.push({ ...it, category: slug, group: groupOfCat.get(slug) || "" });
      }
    } catch (e) {
      catStat.failed++;
      if (catStat.errors.length < 8) catStat.errors.push(`${slug}: ${e.message}`);
    }
    if (opt.delay) await sleep(opt.delay);
  }

  /* ③ 词根覆盖层反馈（G-4）─────────────────────────────────────────
   * 每个词根本周带出多少个**不同的**词。planned 与 sources.suggest.rootsPlanned
   * 用同一个变量 rootsPlanned，杜绝两处各算一套（方案验收 7）。 */
  const rootHits = new Map();
  for (const h of keywordHits) {
    const root = String(h?.root || "").trim();
    if (!root) continue;
    if (!rootHits.has(root)) rootHits.set(root, new Set());
    rootHits.get(root).add(termKey(h.term));
  }
  const zeroHit = rootList.filter((r) => (rootHits.get(r)?.size || 0) === 0);
  const topRoots = [...rootHits.entries()]
    .map(([root, set]) => ({ root, terms: set.size }))
    .sort((a, b) => b.terms - a.terms || a.root.localeCompare(b.root))
    .slice(0, 10);
  const rootsStat = {
    planned: rootsPlanned,
    hit: rootList.length - zeroHit.length,
    zeroHit,
    top: topRoots,
  };

  /* ④ 合并成快照 */
  const keywordOk = sugStat.ok > 0;
  const asinOk = catStat.ok > 0;
  const sourceStatus = (ok, stat, extra = {}) => ({
    status: ok ? (stat.failed || stat.empty ? "partial" : "ok") : "failed",
    ...stat,
    ...extra,
  });

  const snap = buildSnapshot({
    site,
    keywordHits,
    asins,
    prev,
    now,
    sources: {
      suggest: sourceStatus(keywordOk, sugStat, {
        skipped: skippedRoots.length,
        // ── 预算自证（红线 3「预算要说」的完整形态）──────────────────────
        // 任何拿到 latest.json 的人都能用这几个数手算回来：
        //   requests === rootsRun + deepAttempted
        //   deepCandidates === deepAttempted + deepSkippedDuplicate
        //   budget >= requests，且 skipped > 0 时 requests === budget
        // 以前只有 requests，221 是多了还是少了**无从判断**。
        budget: budgetPlanned, budgetSource,
        rootsPlanned, rootsRun,
        deepPlanned, deepCandidates, deepAttempted, deepSkippedDuplicate,
      }),
      bestsellers: sourceStatus(asinOk, catStat),
      roots: rootsStat,
    },
    meta: {
      market: SITES[bestsellersSite(site)]?.label || site,
      siteCode: bestsellersSite(site),
      roots: seenRoots.size,
      // 🔴 只有 US 是本项目实测过的完整市场（建议词参数 + 榜单类目映射都对过）。
      //    与 server.mjs 的兜底 `snap.verifiedMarket ?? (site === "US")` 同口径：
      //    amazon-suggest 里 DE.verified=true 只说明**建议词接口**实测过，
      //    不代表整份词库快照的榜单类目映射也验证过，这里按更严的口径写 false。
      verifiedMarket: site === "US",
      dryRun: opt.dryRun || undefined,
    },
    extraNotes: prevNotes,
    everSeen,
  });

  const report = [
    "",
    "──────── 采集结果 ────────",
    `站点        ${site}（${snap.market}）`,
    `关键词      ${snap.summary.keywordCount} 条（本周新出现 ${snap.summary.newKeywordCount}：`
      + (snap.summary.returnedUnknown
        ? `其中首次/回归分不出（没有历史投影）`
        : `首次 ${snap.summary.firstTimeCount} + 回归 ${snap.summary.returnedCount}`)
      + `；消失 ${snap.summary.droppedKeywordCount}）`,
    `建议词      ${sugStat.ok} 个词根有结果 / ${sugStat.empty} 个空 / ${sugStat.failed} 个失败（共 ${sugStat.requests} 次请求）`,
    `预算        ${budgetPlanned} 次（${budgetSource === "derived" ? "推导" : "手给"}：${rootsPlanned} 词根 + ${deepPlanned} 深挖）`
      + `｜实发 ${sugStat.requests}＝${rootsRun}+${deepAttempted}｜跳过 ${skippedRoots.length}`
      + (deepCandidates ? `｜深挖候选 ${deepCandidates}（重复 ${deepSkippedDuplicate}）` : ""),
    `词根覆盖    ${rootsStat.planned} 计划 / ${rootsStat.hit} 命中 / ${rootsStat.zeroHit.length} 零命中`,
    `ASIN        ${snap.summary.asinCount} 条（${catStat.ok} 个类目成功 / ${catStat.failed} 个失败）`,
    ...(skippedRoots.length
      ? [`预算跳过    ${skippedRoots.length} 个词根（预算 ${budget} 不够；例如 ${skippedRoots.slice(0, 5).join(", ")}）`]
      : []),
    `耗时        ${((Date.now() - started) / 1000).toFixed(1)}s`,
  ];
  if (sugStat.errors.length) report.push(`建议词报错  ${sugStat.errors.join(" ｜ ")}`);
  if (catStat.errors.length) report.push(`榜单报错    ${catStat.errors.join(" ｜ ")}`);
  if (snap.summary.note) report.push(`备注        ${snap.summary.note}`);
  report.push("──────────────────────────");

  // 🔴 核心保护：一条都没抓到 → 不写盘，退出码 2。
  if (isEmpty(snap)) {
    elog(report.join("\n"));
    elog("\n✗ 本周什么都没抓到：**没有覆盖 latest.json**（用空数据盖掉好数据是最常见的自毁方式）。");
    elog("  先看上面的报错；如果是网络/风控问题，下一次定时任务会自动重试。");
    run.status.keywordCount = 0;
    run.status.asinCount = 0;
    finish(2, "本周一条都没抓到，已拒绝覆盖 latest.json");
  }

  mkdirSync(histDir, { recursive: true });
  // 报告里的 KB 必须量**真正写下去的那份文本**，不是紧凑版 JSON：
  // 紧凑版 578 KB、落盘的缩进版 842 KB，差 260 KB —— 报小了自己看不出来，用户会觉得"怎么占了这么大"。
  const latestText = `${JSON.stringify(snap, null, 2)}\n`;
  writeAtomic(latestFile, latestText);

  // 历史只留摘要：完整快照每周 1MB 级别，一年下来仓库会很难看。
  // 🔴 同一天跑第二次**不覆盖第一次**：手动重跑 + 定时任务撞在同一天时，
  //    覆盖会把当天第一次的真实结果抹掉，趋势图于是凭空多一个"缺口"。
  //    序号从 -2 开始（第一次不带序号，保持文件名可读）；路径由只读层的
  //    nextHistoryPath 统一算，服务端要展示历史时口径与这里完全一致。
  const day = snap.generatedAt.slice(0, 10);
  const histFile = nextHistoryPath({ LISTING_KEYWORDS: outDir }, histSite, day);
  // 🔴 历史投影**必须写紧凑 JSON**（不带缩进）。缩进版实测 63KB，超过方案 P1-3
  //    「单份 < 40KB」的防膨胀上限 —— 104 份会从 3.6MB 变成 6.5MB。
  //    这份文件只给机器读（趋势/对比/ASIN 监控），没有可读性需求；
  //    可读的那份是 latest.json，两者不要混为一谈。
  writeAtomic(histFile, `${JSON.stringify(digestOf(snap))}\n`);

  // 只留最近 HISTORY_KEEP 份（两年）。**按 (日期, 序号) 排序**，不靠 mtime：
  // 纯字符串排序会把 `-10` 排在 `-2` 前面，保留窗口边界上会删错。
  const histKey = (f) => {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.json$/);
    return [m[1], Number(m[2] || 1)];
  };
  const hist = readdirSync(histDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}(-\d+)?\.json$/.test(f))
    .sort((a, b) => {
      const [da, na] = histKey(a);
      const [db, nb] = histKey(b);
      return da.localeCompare(db) || na - nb;
    });
  for (const f of hist.slice(0, Math.max(0, hist.length - HISTORY_KEEP))) {
    try { unlinkSync(join(histDir, f)); } catch { /* 删不掉不影响本次结果 */ }
  }

  report.push(
    `已写入      ${latestFile}（${(Buffer.byteLength(latestText) / 1024).toFixed(0)} KB）`,
    `历史摘要    history/${multi ? site + "/" : ""}${basename(histFile)}（共 ${Math.min(hist.length, HISTORY_KEEP)} 份）`,
    `陈旧判定    ${staleness(snap, now).state}`,
  );
  console.log(report.join("\n"));

  // 成功也要写状态：界面上的「上次采集成功」靠它更新，不写就永远停在旧时间。
  run.status.budget = budgetPlanned;
  run.status.requests = sugStat.requests;
  run.status.keywordCount = snap.summary.keywordCount;
  run.status.asinCount = snap.summary.asinCount;

  // 部分失败也要让人看见，但不至于把整个任务判死（数据已经落盘了）。
  if (!keywordOk || !asinOk) {
    elog("\n⚠️ 有一路数据源完全失败，快照只含另一路 —— 详情看上面的 sources 状态。");
  }
}

/** 先写临时文件再 rename：写一半崩了也不会留下半截 JSON（沿用 server.mjs 的做法）。 */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

main().catch((e) => {
  elog(`✗ 采集器异常退出：${e.stack || e.message}`);
  // 异常也必须留状态：否则界面上只会看到"数据还在、也没说我挂了"。
  finish(1, `采集器异常：${e.message}`);
});
