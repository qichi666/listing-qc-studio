#!/usr/bin/env node
/**
 * 本地服务（零 npm 依赖，只用 Node 内置模块）。
 *
 * 为什么不用 Express / Hono / EdgeOne：
 *   1. 本机没有 docker，用户要"能跑起来"而不是"能部署"；
 *   2. 装 node_modules 会引入几百 MB 与版本漂移风险，而这里只需要 5 个接口；
 *   3. 密钥不出本机 —— 服务只监听 127.0.0.1，与用户既有的"本地优先"项目约定一致。
 *
 * 编排逻辑复用 assets/prompt-engine.js，与浏览器端**同一份代码**，
 * 所以服务端与离线模式产出的 Prompt 一定一致（不会出现两套行为）。
 *
 * 接口：
 *   GET  /                     静态页面
 *   GET  /assets/*             静态资源
 *   GET  /api/health           能力探测
 *   POST /api/config           运行时写入密钥（内存 + .env.local）
 *   POST /api/upload           multipart 上传参考图 → data/uploads/
 *   GET  /api/blob?key=        图片代理（gen/ 与 uploads/ 前缀白名单）
 *   GET  /api/library          生图结果清单（?zip=1 打包下载）
 *   POST /api/image            生图（OpenAI 同步 / apimart 异步双适配）
 *   POST /api/vision           图片识别
 *   POST /api/llm              chat completions 代理
 *   POST /api/chat             SSE 编排流
 *   GET  /api/competitor/categories   竞品数据源：站点/类目清单 + 抓取开关状态
 *   GET  /api/competitor/bestsellers  竞品数据源：实时抓 Amazon Best Sellers 榜单
 *   GET  /api/competitor/subs         竞品数据源：某类目页的子类目列表
 *   GET  /api/keywords              本周词库（?q / limit / category / sort / asins / site / compare=prev）
 *   GET  /api/keyword-roots         词根覆盖层：读基线 + 运营改动（只读）
 *   POST /api/keyword-roots         词根覆盖层：增删改名（原子写，只读演示版 403）
 *   GET  /api/export?kind=...       词表 / ASIN 导出为带 BOM 的 CSV（RFC 4180）
 *   GET  /api/external/providers      外部数据源（第三方 MCP）：清单 + 是否已配密钥
 *   POST /api/external/test           外部数据源：握手 + 列出工具（诊断用）
 *   POST /api/external/call           外部数据源：调一个工具，原样回传
 *   POST /api/external/import         外部数据源：调工具 → 归一成词表 → 存本地
 *   GET  /api/external/terms          外部数据源：读上一次导入的词表
 *
 * ⚠️ 竞品数据源是全项目**唯一会主动爬第三方站点**的通道，边界写死在
 *    `assets/bestsellers.js`：主机硬白名单（8 个 amazon 域）+ 地址形状白名单 +
 *    过 assertPublicUrl + 10 分钟缓存。可用 COMPETITOR_SCRAPE=0 整体关掉。
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
// zlib 只在打包下载那一条路径上用得到，且 wrap 在 assets/zip.js 里做了运行时可探测，
// 所以这里不需要再引 child_process 之类的东西（原来那个 execFileSync 是死导入）。

import {
  composeImg2ImgPrompt, TEMPLATES, PIXEL_TO_RATIO, resolveSendSize,   // 其余编排能力一律走 orchestrator，不在服务端重写
} from "./assets/prompt-engine.js";
// 🔴 确定性编排（模板匹配/驱动诊断/Style Lock/主体抽取/简报拼装）只允许有一处实现。
//    服务端与浏览器端共用 orchestrator，避免"离线修好了、在线还是旧行为"。
import { runLocalTurn, isGenerateIntent, isPackIntent, isNegative, packPayload } from "./assets/orchestrator.js";
// 🔴 出网校验与 Host 校验只有这一处实现（自检脚本也从这里取，保证"测的就是跑的那份"）。
import { assertPublicUrl, allowedHosts, bareHost, downloadPinned } from "./assets/net-guard.js";
// 零依赖 zip 打包（纯拼接 + node:zlib 的 crc32），供"图片库打包下载"用
import { buildZip } from "./assets/zip.js";
// 竞品数据源：实时抓 Amazon Best Sellers（Node 内置 https，零第三方依赖）。
// 🔴 出网白名单与缓存只有这一个实现，服务端与自检都从这里取。
//    DEFAULT_SITE 也必须从模块拿 —— 界面下拉框的第一项就是它拼出来的，
//    这里再写一个字面量 "com" 就是第二份口径（改了模块这个不报错、静默跑偏）。
import {
  SITES, CATS, CAT_SLUGS, DEFAULT_SITE, fetchBestsellers, fetchSubs, isAllowedAmazonUrl, cacheStats, MAX_PAGES,
} from "./assets/bestsellers.js";
// 本周词库：**读**在服务端（写快照只在 tools/collect-keywords.mjs 里）。
// 查询/陈旧判定/历史对比/ASIN 变动复用 keyword-vault.js 的纯函数，界面与 MCP 用同一份口径。
import { readLatest, readStatus } from "./assets/keywords-store.js";
import { queryKeywords, staleness, termKey, digestOf, diffAsins, compareSnapshots, SITE_DOMAIN } from "./assets/keyword-vault.js";
// 词根覆盖层（G-4）：运营改 data/keywords/roots.json，不改源码也不用重启。
// 这里只用它的 resolveRoots 做校验与合并，**不把校验结果写回源码**。
import { resolveRoots, OVERLAY_SCHEMA } from "./assets/keyword-roots.js";
// CSV 导出（P2#10）：RFC 4180 + UTF-8 BOM，浏览器与 Node 复用同一份实现。
import { toCsv } from "./assets/csv.js";
// 外部数据源（卖家精灵这类第三方 MCP）走 Streamable HTTP。
// 🔴 这个模块**只做传输**：白名单与密钥由本文件决定，它不认识任何具体厂商 ——
//    否则"换个数据源"就得改传输层，改错一次就是全网通。
import { HttpMcp, HttpMcpError } from "./assets/mcp-http.js";
import { normalizeTerms } from "./assets/term-normalize.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";   // 只监听本机，不对外暴露
// 🔴 数据目录允许重定向。默认仍是项目内的 data/（双击启动时行为一字不变）；
//    设了 LISTING_DATA 就整块换目录 —— 自检脚本靠它把落盘全部挪到临时目录，
//    保证"验证脚本不碰用户真实数据"这条不被破例，也让分享包接收者跑自检时不留垃圾。
const DATA = process.env.LISTING_DATA
  ? path.resolve(process.env.LISTING_DATA)
  : path.join(HERE, "data");
const UPLOADS = path.join(DATA, "uploads");
const GEN = path.join(DATA, "gen");
const ENV_LOCAL = path.join(HERE, ".env.local");
// 🔴 两个名字都读，`.env.local` 优先。
//    原因（2026-10-30 实测）：原来只读 `.env.local`，但 `.env.example` 第一行、启动日志、
//    「未配置图片 API」的报错、设置页说明、README 一共 5 处都在教用户写 `.env`。
//    照着做的人会得到 image=false，且**没有任何报错** —— 看起来像工具坏了。
//    对照实验：只写 .env → capabilities.image=false；只写 .env.local → true。
const ENV_PLAIN = path.join(HERE, ".env");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const VERSION = "listing-studio/1.0.0";

/**
 * Node 版本门槛：20.15.0。
 *
 * 为什么是 20.15 而不是 20：`zlib.crc32` 是 20.15 才有的 API，图片库"打包下载"要用它。
 * 🔴 但这里**只警告不退出**。核心能力（Prompt / 质检 / 关键词 / 模板）在 Node 20.0 上
 *    完全可用，为了一个可选下载功能把整个工具停掉是过度惩罚 ——
 *    "能跑起来"比"版本洁癖"重要。zip.js 里也做了运行时可探测，只有真点下载才报错。
 */
const [NODE_MAJOR = 0, NODE_MINOR = 0] = String(process.versions.node).split(".").map(Number);
const NODE_OK = NODE_MAJOR > 20 || (NODE_MAJOR === 20 && NODE_MINOR >= 15);

fs.mkdirSync(UPLOADS, { recursive: true });
fs.mkdirSync(GEN, { recursive: true });

/* ─────────────────────── 配置 ─────────────────────── */

function parseEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i < 0) continue;
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[s.slice(0, i).trim()] = v;
  }
  return out;
}

const runtimeConfig = {};   // /api/config 写入（内存，重启即失效）

/* ── .env 读取缓存 ──────────────────────────────────────────────
 * 🔴 原来 getEnv 每次调用都重新 open + read + parse 两个文件。
 *    而 imgCfg() 一次要调 5 次 getEnv ⇒ /api/health 一次请求就是 10 次读盘。
 *    前端每次探活、每个操作都会打 health，文件虽小，"每个请求读两遍配置"没有必要。
 *
 * 失效用**双保险**：mtime 变化立刻失效（外部编辑器改 .env 能感知），
 * 再加 500ms TTL 兜底（同一毫秒内多次调用不重复 stat）。
 * 两条都保留，是因为它们解决的是不同问题：mtime 管"内容变了"，
 * TTL 管"内容没变但被问了 10 次"。
 */
let envCache = { at: 0, mLocal: -1, mPlain: -1, cfg: null };
const ENV_CACHE_MS = 500;

function statMtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return -1; }
}

function invalidateEnvCache() {
  envCache = { at: 0, mLocal: -1, mPlain: -1, cfg: null };
}

function envFileConfig() {
  const now = Date.now();
  const mLocal = statMtime(ENV_LOCAL);
  const mPlain = statMtime(ENV_PLAIN);
  if (
    envCache.cfg && now - envCache.at < ENV_CACHE_MS &&
    mLocal === envCache.mLocal && mPlain === envCache.mPlain
  ) {
    return envCache.cfg;
  }
  // 优先级：.env.local > .env（同名键，前者赢）
  const out = {};
  for (const f of [ENV_LOCAL, ENV_PLAIN]) {
    try {
      if (!fs.existsSync(f)) continue;
      const cfg = parseEnv(fs.readFileSync(f, "utf8"));
      for (const [k, v] of Object.entries(cfg)) if (!(k in out)) out[k] = v;
    } catch { /* 读不到就当没有，不阻塞启动 */ }
  }
  envCache = { at: now, mLocal, mPlain, cfg: out };
  return out;
}

function getEnv(name, fallback = "") {
  const aliases = {
    IMG_BASE_URL: ["OPENAI_BASE_URL", "OPENAI_API_BASE"],
    IMG_MODEL: ["OPENAI_IMAGE_MODEL", "OPENAI_MODEL"],
    IMG_API_KEY: ["OPENAI_API_KEY"],
  };
  const names = [name, ...(aliases[name] || [])];
  const fileCfg = envFileConfig();
  for (const n of names) {
    if (runtimeConfig[n]) return runtimeConfig[n];
    if (process.env[n]) return process.env[n];
    if (fileCfg[n]) return fileCfg[n];
  }
  return fallback;
}

const imgCfg = () => ({
  baseUrl: (getEnv("IMG_BASE_URL", "") || "").replace(/\/$/, ""),
  model: getEnv("IMG_MODEL", "gpt-image-2"),
  apiKey: getEnv("IMG_API_KEY", ""),
  mode: getEnv("IMG_API_MODE", "auto"),
  resolution: getEnv("IMG_RESOLUTION", "2k"),
  // strict（默认）= 同步模式按方向吸附到三种画布；free = 原样发送 RATIO_PIXELS
  syncSizeMode: getEnv("IMG_SYNC_SIZE_MODE", "strict"),
  chatModel: getEnv("IMG_CHAT_MODEL", "agnes-2.0-flash"),
});
const llmCfg = () => ({
  baseUrl: (getEnv("CHAT_BASE_URL", "") || getEnv("IMG_BASE_URL", "")).replace(/\/$/, ""),
  model: getEnv("CHAT_MODEL", ""),
  apiKey: getEnv("CHAT_API_KEY", "") || getEnv("IMG_API_KEY", ""),
});

/* ─────────────────── 只读演示模式（公网部署）───────────────────
 * 原实现只把 /api/config 关了，其余"写磁盘 / 花额度"的入口照开：
 *   · POST /api/upload   → 任何人都能往 data/upload 里塞任意图片（还能撑爆磁盘）
 *   · DELETE /api/library→ 能删掉站长生成的图
 *   · POST /api/image|vision|llm → 一旦站长配了 key，就是给陌生人白嫖额度
 * 所以改成白名单式：**列出来的全部 403**，不在表里的才放行。
 * /api/chat 刻意留在外面 —— 它是在线体验的文字主链路（纯本地编排，不花钱），
 * 里面的"出图"分支由 handleChat 自己再判一次 RO_PUBLIC（见那里的注释）。
 */
const RO_PUBLIC = process.env.LISTING_NO_KEY_WRITE === "1";
const WRITE_ROUTES = [
  ["POST", "/api/config"],
  // 配置自检会拿「本机配的 key」出网探活。虽然不产生额度，但它是一个
  // 「用站长的凭据对外发请求」的入口 —— 只读演示版一律关掉。
  ["POST", "/api/config/test"],
  ["POST", "/api/upload"],
  ["POST", "/api/image"],
  ["POST", "/api/vision"],
  ["POST", "/api/llm"],
  ["DELETE", "/api/library"],
  // 外部数据源：都花"本机配的那把密钥"的额度（有的还写盘）。
  // 线上演示版是给陌生人看的，不能让访客用站长的账号去调第三方的付费接口。
  ["POST", "/api/external/test"],
  ["POST", "/api/external/call"],
  ["POST", "/api/external/import"],
  // 词根覆盖层：写用户数据目录里的 roots.json，线上演示版同样不许写。
  ["POST", "/api/keyword-roots"],
  // 历史快照：写 data/snapshots/*.jsonl。
  ["POST", "/api/snapshots"],
  // 抠图代理：用站长本机的 rembg 服务出图（可能吃 CPU 几十秒），线上演示版一律关。
  ["POST", "/api/plugins/rembg"],
];
const isWriteRoute = (p, method) => WRITE_ROUTES.some(([m, path]) => m === method && path === p);

/* ─────────────────────── 工具 ─────────────────────── */

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8",
};

/* ─────────────────────── 生成图片库 ───────────────────────
 * 列 / 删本地生成的图。给前端做缩略图墙用。
 * 🔴 删除是本服务里**唯一**的破坏性接口，所以校验刻意做重：
 *    name 必须是纯文件名（无任何路径成分）+ 扩展名白名单 + 拼出来还要做一次前缀检查。
 */

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

/* 打包下载的**资源闸门**。buildZip 是全内存实现（每张图一个 Buffer，再拼一份 zip），
 * 所以必须在上限处拦住 —— 否则"图片库攒多了"会以一次 OOM 的形式表现为"服务莫名消失"。
 * 单张 40MB 是"上游给了 8K 原图"的量级；总量 300MB 已经远超正常运营场景。 */
const ZIP_MAX_FILES = 300;
const ZIP_MAX_FILE_BYTES = 40 * 1024 * 1024;
const ZIP_MAX_TOTAL_BYTES = 300 * 1024 * 1024;

/** 只接受"纯文件名"。任何路径成分都拒绝 —— 目录穿越的第一道门。 */
function safeImageName(raw) {
  const name = String(raw || "").trim();
  if (!name) return null;
  if (name !== path.basename(name)) return null;          // 含目录 → 拒
  if (name.includes("..") || /[\\/\u0000]/.test(name)) return null;
  if (!IMAGE_EXT.test(name)) return null;
  return name;
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + " B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
  return (v / 1024 / 1024).toFixed(1) + " MB";
}

function handleLibrary(req, res, url) {
  // 打包下载：GET /api/library?zip=1
  // 下载 14 张图点 14 次，是"玩具感"的典型来源；一次给一个 zip 才算工具。
  if (url.searchParams.get("zip")) {
    if (!fs.existsSync(GEN)) return json(res, 404, { error: "还没有生成过图片" });
    let names = [];
    try {
      names = fs.readdirSync(GEN).filter((f) => IMAGE_EXT.test(f));
    } catch (e) {
      return json(res, 500, { error: `读目录失败：${e.message}` });
    }
    if (!names.length) return json(res, 404, { error: "图片库是空的" });
    // 🔴 资源闸门：buildZip 是**全内存**实现（entries 里每条都是整张图的 Buffer，
    //    再拼一份 zip），不设上限时"图片库攒了 2000 张"就是一次必然的内存爆掉。
    //    先 stat 求和再读，超限就给 413 + 可执行建议，而不是让进程 OOM 后整个服务消失。
    const files = [];
    let totalBytes = 0, tooBig = [];
    for (const f of names.sort()) {
      const full = path.join(GEN, f);
      if (!full.startsWith(GEN + path.sep)) continue;   // 与列表接口同一道门
      try {
        const st = fs.statSync(full);
        if (st.size > ZIP_MAX_FILE_BYTES) { tooBig.push(f); continue; }
        totalBytes += st.size;
        files.push({ name: f, full, size: st.size });
      } catch { /* 并发删除忽略 */ }
    }
    if (files.length > ZIP_MAX_FILES) {
      return json(res, 413, {
        error: `图片太多（${files.length} 张，上限 ${ZIP_MAX_FILES} 张）。zip 是内存打包的，一次打这么多会把服务撑爆 —— 请分批下载，或直接去 data/gen 目录复制。`,
        files: files.length, maxFiles: ZIP_MAX_FILES,
      });
    }
    if (totalBytes > ZIP_MAX_TOTAL_BYTES) {
      return json(res, 413, {
        error: `总大小 ${fmtBytes(totalBytes)} 超过打包上限 ${fmtBytes(ZIP_MAX_TOTAL_BYTES)}（内存打包）。请分批下载，或直接去 data/gen 目录复制。`,
        bytes: totalBytes, maxBytes: ZIP_MAX_TOTAL_BYTES,
      });
    }
    const entries = [];
    for (const f of files) {
      try { entries.push({ name: f.name, data: fs.readFileSync(f.full) }); } catch { /* 并发删除忽略 */ }
    }
    if (!entries.length) {
      return json(res, 404, {
        error: tooBig.length
          ? `没有可打包的图：${tooBig.length} 张单张超过 ${fmtBytes(ZIP_MAX_FILE_BYTES)}，已跳过`
          : "图片都读不出来了（可能正在被别的程序占用）",
      });
    }
    // 打包失败（典型原因：Node < 20.15 没有 zlib.crc32）要回 501 且说清原因，
    // 不能让它冒成 500 —— 500 的意思是"我出 bug 了"，而这里其实是"环境不支持"。
    let zip;
    try {
      zip = buildZip(entries);
    } catch (e) {
      return json(res, 501, { error: e.message });
    }
    const stamp = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Length": zip.length,
      "Content-Disposition": `attachment; filename="listing-images-${stamp}.zip"`,
      "Cache-Control": "no-store",
    });
    return res.end(zip);
  }

  if (req.method === "DELETE") {
    const name = safeImageName(url.searchParams.get("name"));
    if (!name) return json(res, 400, { error: "name 必须是纯文件名，且扩展名是 .png/.jpg/.webp/.gif" });
    const full = path.join(GEN, name);
    // 第二道门：即使 safeImageName 被绕过，这里也不允许跑到 GEN 之外
    if (!full.startsWith(GEN + path.sep)) return json(res, 403, { error: "路径越界" });
    if (!fs.existsSync(full)) return json(res, 404, { error: `不存在：${name}` });
    try {
      fs.unlinkSync(full);
      return json(res, 200, { ok: true, deleted: name });
    } catch (e) {
      return json(res, 500, { error: `删除失败：${e.message}` });
    }
  }

  if (!fs.existsSync(GEN)) return json(res, 200, { files: [], total: 0, bytes: 0, bytesText: "0 B" });
  let names = [];
  try {
    names = fs.readdirSync(GEN).filter((f) => IMAGE_EXT.test(f));
  } catch (e) {
    return json(res, 500, { error: `读目录失败：${e.message}` });
  }
  const files = names
    .map((f) => {
      let st = null;
      try { st = fs.statSync(path.join(GEN, f)); } catch { /* 并发删除时可能消失 */ }
      if (!st || !st.isFile()) return null;
      return {
        name: f,
        key: "gen/" + f,
        size: st.size,
        sizeText: fmtBytes(st.size),
        mtime: st.mtimeMs,
        url: "/api/blob?key=" + encodeURIComponent("gen/" + f),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  const bytes = files.reduce((s, f) => s + f.size, 0);
  return json(res, 200, { files, total: files.length, bytes, bytesText: fmtBytes(bytes) });
}

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
  res.end(body);
}

function readBody(req, limitBytes = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error("请求体过大")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** 带 HTTP 状态码的错误：让上层能区分 415 / 400，而不是把一切都报成 400。 */
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const JSON_CT = /^application\/(?:[\w.+-]+\+)?json\b/i;

/**
 * 读 JSON 请求体。
 *
 * 🔴 为什么要校验 Content-Type（2026-11-05 加固，P0-1）
 *    只检查"body 是不是合法 JSON"挡不住 CSRF：跨站页面可以用
 *    `fetch(url, {method:"POST", mode:"no-cors", headers:{"Content-Type":"text/plain"}})`
 *    发一个**简单请求** —— 不触发预检，浏览器会真的把请求打到 127.0.0.1。
 *    要求 application/json 之后，跨站就必须先过预检；而本服务从不回 CORS 头，
 *    预检必然失败，这条写入通道从源头上被掐断。
 */
async function readJSON(req, { requireJson = false } = {}) {
  if (requireJson) {
    const ct = String(req.headers["content-type"] || "");
    if (!JSON_CT.test(ct)) {
      throw httpError(415, `Content-Type 必须是 application/json（收到：${ct || "空"}）`);
    }
  }
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch (e) {
    throw httpError(400, `请求体不是合法 JSON：${e.message}`);
  }
}

/** 安全地把 key 映射到磁盘路径：只允许 gen/ 与 uploads/ 两个前缀，且禁止 .. */
function keyToPath(key) {
  const k = String(key || "");
  if (!k.startsWith("gen/") && !k.startsWith("uploads/")) return null;
  const rel = k.replace(/^gen\//, "").replace(/^uploads\//, "");
  if (rel.includes("..") || rel.includes("\\") || path.isAbsolute(rel)) return null;
  const dir = k.startsWith("gen/") ? GEN : UPLOADS;
  return path.join(dir, rel);
}

function inferExt(contentType, filename) {
  const m = /\.(png|jpe?g|webp|gif)$/i.exec(filename || "");
  if (m) return m[1].toLowerCase() === "jpg" ? "jpg" : m[1].toLowerCase();
  if (/png/.test(contentType || "")) return "png";
  if (/jpe?g/.test(contentType || "")) return "jpg";
  if (/webp/.test(contentType || "")) return "webp";
  if (/gif/.test(contentType || "")) return "gif";
  return "png";
}

/**
 * 带超时的 fetch，并支持**外部中断**（客户端断开）。
 *
 * 🔴 原来只有超时，没有断开监听：用户在浏览器里点了「停止」或关掉标签页，
 *    服务端的 180s 出图请求照跑 —— 额度照扣、轮询照继续，只是没人在等。
 *    传 outer（AbortSignal）进来，断开即中止。
 */
async function fetchWithTimeout(url, opts = {}, timeoutMs = 180000, outer = null) {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(outer.reason || new Error("客户端已断开，已取消上游请求"));
  if (outer) {
    if (outer.aborted) onAbort();
    else outer.addEventListener("abort", onAbort, { once: true });
  }
  const t = setTimeout(() => ctl.abort(new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(t);
    if (outer) outer.removeEventListener("abort", onAbort);
  }
}

/** 可被中断的等待。断连时立刻返回，不必等满 12s / 4s 的间隔。 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error("aborted"));
    const done = () => { clearTimeout(t); signal?.removeEventListener("abort", onAbort); };
    const onAbort = () => { done(); reject(signal.reason || new Error("aborted")); };
    const t = setTimeout(() => { done(); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 给一次请求挂上「客户端断开」的中断器。
 *
 * 🔴 为什么用 res 的 close 而不是 req 的：Node 里 req 是请求体流，POST 读完就结束了，
 *    拿它判断"用户还在不在"会在请求体读完的瞬间就误判成断开。res 的 close 才是连接生命周期。
 *    close 在正常结束（已 end）时也会触发，所以必须用 writableEnded 区分。
 */
function abortOnDisconnect(res) {
  const ctl = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ctl.abort(new Error("客户端已断开，已取消上游请求"));
  });
  return ctl;
}

/* ─────────────────────── 出网安全：SSRF 防护 ───────────────────────
 * 实现与理由见 assets/net-guard.js 顶部注释（OWASP 优先级：白名单 > 按 IP 判内网 > 字符串匹配）。
 * 这里只强调一点：`downloadToGen` 拿到的 url 是**上游服务给的**，不是用户手打的，必须当成不可信输入。
 */


/* ─────────────────────── multipart 解析（最小实现） ─────────────────────── */

function parseMultipart(buf, boundary) {
  const delim = Buffer.from(`--${boundary}`);
  const parts = [];
  let idx = buf.indexOf(delim);
  if (idx < 0) throw new Error("找不到 multipart 边界");
  idx += delim.length;
  while (idx < buf.length) {
    if (buf.slice(idx, idx + 2).toString() === "--") break;
    if (buf.slice(idx, idx + 2).toString() === "\r\n") idx += 2;
    const headEnd = buf.indexOf("\r\n\r\n", idx);
    if (headEnd < 0) break;
    const headers = buf.slice(idx, headEnd).toString("utf8");
    const next = buf.indexOf(delim, headEnd);
    if (next < 0) break;
    let bodyEnd = next;
    if (buf.slice(bodyEnd - 2, bodyEnd).toString() === "\r\n") bodyEnd -= 2;
    parts.push({ headers, body: buf.slice(headEnd + 4, bodyEnd) });
    idx = next + delim.length;
  }
  return parts;
}

function headerValue(headers, name) {
  const re = new RegExp(`^${name}:\\s*(.+)$`, "im");
  const m = re.exec(headers);
  return m ? m[1].trim() : "";
}

/* ─────────────────────── 图片生成适配器 ─────────────────────── */

/**
 * 像素 → 比例。**映射表在 assets/prompt-engine.js，这里不重复定义。**
 *
 * 🔴 原来这里有一份 RATIO_OF_PIXELS，和浏览器侧 PIXEL_TO_RATIO 集合不一致：
 *    服务端不认 1536x1024 / 864x1536，`toRatio()` 查不到就静默回落成 1:1。
 *    更要命的是表里还有 `"1024x1024 "`（尾随空格）这种重复键 —— 它永远不会被命中，
 *    只是把"这里没人管"这件事藏了起来。
 */
function toRatio(size) {
  const s = String(size || "").trim();
  if (!s) return "1:1";
  if (s.includes(":")) return s;
  return PIXEL_TO_RATIO[s] || "1:1";
}

/* 画幅 → 实际发送尺寸的判定**只有一处实现**（assets/prompt-engine.js 的 resolveSendSize），
 * 服务端只调用、不复制。原因见那边的注释：同步接口只收三种画布，9 个比例里有 6 个会被 400。 */

function detectMode(baseUrl, explicit) {
  if (explicit === "sync" || explicit === "async") return explicit;
  if (explicit === "auto" || !explicit) return /apimart/i.test(baseUrl) ? "async" : "sync";
  return /apimart/i.test(baseUrl) ? "async" : "sync";
}

async function callImageAPI({ prompt, size, imageDataUri, onProgress, signal }) {
  const cfg = imgCfg();
  if (!cfg.baseUrl || !cfg.apiKey) throw new Error("缺少 IMG_BASE_URL / IMG_API_KEY 配置");
  const mode = detectMode(cfg.baseUrl, cfg.mode);
  const endpoint = `${cfg.baseUrl}/images/generations`;
  const send = resolveSendSize(size, mode, cfg.syncSizeMode);
  onProgress?.(`提交到 ${endpoint} | model=${cfg.model} | mode=${mode} | size=${send.sent}${send.note ? `（${send.note}）` : ""}`);

  if (mode === "async") {
    const payload = { model: cfg.model, prompt, n: 1, size: send.sent, resolution: cfg.resolution };
    if (imageDataUri) payload.image_urls = [imageDataUri];
    const resp = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify(payload),
    }, 60000, signal);
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`提交失败 HTTP ${resp.status}: ${JSON.stringify(j).slice(0, 300)}`);
    if (j.code && j.code !== 200) throw new Error(`提交失败 code=${j.code}: ${j?.error?.message || JSON.stringify(j).slice(0, 200)}`);
    const taskId = j?.data?.[0]?.task_id;
    if (!taskId) throw new Error(`提交响应缺少 task_id: ${JSON.stringify(j).slice(0, 200)}`);
    onProgress?.(`任务已提交 task_id=${taskId}，等待 12s 后开始轮询…`);
    await sleep(12000, signal);
    const started = Date.now();
    while (Date.now() - started < 180000) {
      if (signal?.aborted) throw signal.reason || new Error("客户端已断开，停止轮询");
      const q = await fetchWithTimeout(`${cfg.baseUrl}/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${cfg.apiKey}`, "User-Agent": UA },
      }, 30000, signal);
      const t = await q.json().catch(() => ({}));
      const d = t.data || {};
      if (d.status === "completed") {
        const url = d?.result?.images?.[0]?.url?.[0];
        if (!url) throw new Error(`任务完成但没拿到图片 URL: ${JSON.stringify(d).slice(0, 200)}`);
        onProgress?.(`任务完成，耗时 ${d.actual_time ?? "?"}s，费用 $${(d.cost ?? 0).toFixed(4)}`);
        return { imageUrl: url, mode: "async", cost: d.cost, actualTime: d.actual_time, sizeSent: send.sent, ratio: send.ratio, sizeNote: send.note };
      }
      if (d.status === "failed") throw new Error(`任务失败：${d?.error?.message || JSON.stringify(d).slice(0, 200)}`);
      onProgress?.(`轮询中… status=${d.status} progress=${d.progress ?? 0}% elapsed=${((Date.now() - started) / 1000).toFixed(0)}s`);
      await sleep(4000, signal);
    }
    throw new Error(`任务 ${taskId} 轮询超时（180s）`);
  }

  // 同步模式（OpenAI 兼容）
  const payload = { model: cfg.model, prompt, n: 1, size: send.sent };
  if (imageDataUri) payload.image_urls = [imageDataUri];
  const resp = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify(payload),
  }, 180000, signal);
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${JSON.stringify(j).slice(0, 300)}`);
  const item = j?.data?.[0];
  if (!item) throw new Error(`响应缺少 data[0]: ${JSON.stringify(j).slice(0, 200)}`);
  if (item.b64_json) {
    return { imageB64: item.b64_json, mode: "sync", sizeSent: send.sent, ratio: send.ratio, sizeNote: send.note };
  }
  if (item.url) return { imageUrl: item.url, mode: "sync", sizeSent: send.sent, ratio: send.ratio, sizeNote: send.note };
  throw new Error("响应既没有 b64_json 也没有 url");
}

async function downloadToGen(url, b64) {
  const name = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  if (b64) {
    const ext = "png";
    const file = `${name}.${ext}`;
    fs.writeFileSync(path.join(GEN, file), Buffer.from(b64, "base64"));
    return { key: `gen/${file}`, filename: file };
  }
  // 🔴 SSRF 关口 + IP 钉死：url 由**上游服务**给出，不能信。
  //    downloadPinned 会解析一次 → 判内网 → 把 IP 钉进 socket（lookup 钩子），
  //    校验的 IP 与连的 IP 是同一个，DNS rebinding 的 TOCTOU 窗口关掉了。
  //    每一跳重定向都重新解析 + 重新判内网（原来直接拒绝 3xx，把正常 CDN 跳转也拒了）。
  const dl = await downloadPinned(url, { headers: { "User-Agent": UA }, timeoutMs: 120000 });
  const ext = inferExt(dl.contentType, new URL(dl.finalUrl || url).pathname);
  const file = `${name}.${ext}`;
  fs.writeFileSync(path.join(GEN, file), dl.body);
  return { key: `gen/${file}`, filename: file };
}

/* ─────────────────────── 各接口 ─────────────────────── */

async function handleHealth(req, res) {
  const c = imgCfg();
  const l = llmCfg();
  json(res, 200, {
    ok: true, version: VERSION, node: process.version, nodeOk: NODE_OK, pid: process.pid,
    capabilities: {
      image: Boolean(c.baseUrl && c.apiKey),
      imageKeyConfigured: Boolean(c.baseUrl && c.apiKey),
      imageMode: detectMode(c.baseUrl, c.mode),
      imageModel: c.model || null,
      chat: Boolean(l.baseUrl && l.apiKey && l.model),
      vision: Boolean(c.baseUrl && c.apiKey),
      storage: true,
      // 只读演示模式：前端据此提示"写操作已关闭"，而不是等用户点了才弹 403
      readonly: RO_PUBLIC,
      // 竞品实时抓取是否可用（前端据此决定第 ⑦ 卡是"可抓"还是"照实显示已关闭"）
      competitor: COMPETITOR_ENABLED,
      // 历史快照：本地 JSONL，永远可用（只读演示版不可写，由 WRITE_ROUTES 拦）
      snapshots: true,
      // 抠图：只有配了 REMBG_URL 才算有（界面据此显示"未启用"而不是"点一下试试"）
      rembg: Boolean(rembgUrl()),
    },
    templates: Object.keys(TEMPLATES).length,
  });
}

/* ─────────────────────── 配置写入：同源校验 ─────────────────────── */

/**
 * 判断这次 /api/config 请求是否同源。
 * 返回 null = 通过；返回字符串 = 拒绝原因（调用方回 403）。
 *
 * 三类请求分开对待：
 *   1. `Sec-Fetch-Site` 存在时只认 `same-origin` / `none`。
 *      `cross-site` 是浏览器明确标注的跨站；`same-site` 也不放行 ——
 *      同一个注册域下的另一个子域/端口，对"本机密钥文件"没有正当写入理由。
 *   2. `Origin` 存在时必须与 `Host` 同源（含端口）。`Origin: null`
 *      （sandbox iframe、部分 file:// 场景）直接拒。
 *   3. 两个头都没有：放行。curl / 本机 CLI / 老浏览器属于这类，
 *      它们不构成"受害者的浏览器被借用"的场景；真正的闸门是 Content-Type。
 */
function sameOriginViolation(req) {
  const site = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  if (site && site !== "same-origin" && site !== "none") {
    return `拒绝跨站写入（Sec-Fetch-Site: ${site}）`;
  }
  const origin = req.headers.origin;
  if (origin === undefined) return null;
  if (!origin || origin === "null") return "拒绝来源不明的写入（Origin: null）";
  let oUrl;
  try {
    oUrl = new URL(origin);
  } catch {
    return `Origin 格式不合法：${origin}`;
  }
  const host = String(req.headers.host || "");
  if (oUrl.host.toLowerCase() !== host.toLowerCase()) {
    return `Origin 与 Host 不同源（${oUrl.host} ≠ ${host || "空"}）`;
  }
  return null;
}

/* ─────────────────────── 外部数据源：常量白名单 ───────────────────────
 * 第三方 MCP（Streamable HTTP）—— 用来补上本地算不出来的东西：
 * 真实搜索量、ABA 排名、竞品流量词。**这是唯一一处外部端点的事实来源。**
 *
 * 🔴 URL 只在这里出现，请求体里**没有** url 字段可传。
 *    一旦允许调用方指定 URL，这个路由就变成了通用 SSRF 跳板
 *    （`http://127.0.0.1:8787/api/config`、云厂商元数据地址都能被塞进来）。
 *    加一个数据源 = 这里加一行 + 在 .env.local 配一个 key，别处不用改。
 *
 * 密钥走 `keyEnv` 指向的环境变量名，读法与其它配置完全一致
 * （`.env.local` > `.env` > process.env），所以设置页写进去就能立刻生效。
 */
const EXTERNAL_MCP = {
  sellersprite: {
    label: "卖家精灵",
    url: "https://mcp.sellersprite.com/mcp",
    keyEnv: "SELLERSPRITE_KEY",
    header: "secret-key",      // 该服务的鉴权头，不是 Bearer
    note: "关键词反查 / 流量词 / ABA 榜单。需自己的账号（付费套餐 + 调用额度），本项目不代付、不内置。",
  },
};

/* ─────────────────────── 配置写入：.env.local 读写 ─────────────────────── */

/** 设置页能写的键。不在这张表里的键一律忽略（带 ignored 回执，便于排查拼错）。 */
const CONFIG_KEYS = {
  imageBaseUrl: "IMG_BASE_URL",
  imageModel: "IMG_MODEL",
  imageApiKey: "IMG_API_KEY",
  imageMode: "IMG_API_MODE",
  imageResolution: "IMG_RESOLUTION",
};
// 每个外部数据源的密钥单独一个环境变量（`sellerspriteKey` → `SELLERSPRITE_KEY`）。
// 用循环生成而不是手写：加数据源时忘了在设置页登记，症状会是"填了密钥但没有生效"，
// 而且不报错 —— 这类"配置被静默忽略"最费时间。
for (const [id, p] of Object.entries(EXTERNAL_MCP)) CONFIG_KEYS[`${id}Key`] = p.keyEnv;

/**
 * 只读 `.env.local`。
 * 🔴 刻意**不**合并 `.env`：那是用户手写的文件，把里面的密钥搬进 .env.local
 *    等于替用户复制了一份明文密钥，超出"设置页只改自己写过的东西"的边界。
 */
function readEnvLocal() {
  try {
    if (!fs.existsSync(ENV_LOCAL)) return {};
    return parseEnv(fs.readFileSync(ENV_LOCAL, "utf8"));
  } catch {
    return {};
  }
}

/**
 * 原子写 `.env.local`：先写 `.tmp` 再 rename。
 * 直接 'w' 覆盖的话，写到一半崩溃/断电会留下**半截文件**，
 * 密钥与 URL 一起丢，下次启动读到的还是残缺配置。
 */
function writeEnvLocal(obj) {
  const lines = Object.entries(obj).map(([k, v]) => `${k}=${v}`);
  const text = `# 由工作台设置页写入，请勿提交到版本库\n${lines.join("\n")}\n`;
  const tmp = `${ENV_LOCAL}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, ENV_LOCAL);   // 同目录 rename，原子替换
  // 🔴 必须立刻失效缓存：否则同一毫秒内的下一次 getEnv 还会读到旧文件，
  //    表现为"保存成功但状态没变"，直到 500ms 后才自己好 —— 这种"等一会儿就好了"
  //    的 bug 最难被当成 bug 报出来。
  invalidateEnvCache();
  return lines.length;
}

async function handleConfig(req, res) {
  // 1) 来源：挡住"受害者浏览器被借去写密钥"这条跨站路径
  const violation = sameOriginViolation(req);
  if (violation) return json(res, 403, { ok: false, error: violation });

  // 2) Content-Type + 解析（非 application/json → 415）
  let body;
  try {
    body = await readJSON(req, { requireJson: true });
  } catch (e) {
    return json(res, e.status || 400, { ok: false, error: e.message });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json(res, 400, { ok: false, error: "请求体必须是一个 JSON 对象" });
  }

  const entries = Object.entries(body);
  if (!entries.length) {
    // 🔴 空对象必须是 400，不能"顺手把文件重写成只剩一行注释"（原来的缺陷）
    return json(res, 400, { ok: false, error: "请求体是空对象，没有要写入的键（.env.local 未被修改）" });
  }

  // 3) 先整体校验，全部通过才动磁盘 —— 避免"内存已生效、磁盘没写"的中间态
  const patch = {};       // ENV 键 → 值；"" 表示删除
  const ignored = [];
  for (const [k, v] of entries) {
    const envKey = CONFIG_KEYS[k];
    if (!envKey) { ignored.push(k); continue; }
    if (v === null || v === "" || (typeof v === "string" && !v.trim())) {
      patch[envKey] = "";   // 空值 = 删除。原来直接 continue，导致密钥永远删不掉
      continue;
    }
    if (typeof v !== "string") {
      return json(res, 400, { ok: false, error: `${k} 必须是字符串（收到 ${typeof v}）` });
    }
    const val = v.trim();
    // baseUrl 之后会被拼进 `${baseUrl}/images/generations` 再出网，格式必须在这里卡住
    if (k === "imageBaseUrl" && !/^https?:\/\/[^\s]+$/i.test(val)) {
      return json(res, 400, { ok: false, error: "imageBaseUrl 必须以 http:// 或 https:// 开头，且不能含空白字符" });
    }
    if (k === "imageMode" && !/^(auto|sync|async)$/i.test(val)) {
      return json(res, 400, { ok: false, error: "imageMode 只能是 auto / sync / async" });
    }
    patch[envKey] = val;
  }
  if (!Object.keys(patch).length) {
    return json(res, 400, {
      ok: false,
      error: `没有可识别的配置项${ignored.length ? `（未识别：${ignored.join("、")}）` : ""}`,
    });
  }

  // 4) 与磁盘现状合并：只覆盖本次提交的键，其余原样保留
  const before = readEnvLocal();
  const merged = { ...before };
  const written = [];
  const removed = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === "") {
      if (k in merged) { delete merged[k]; removed.push(k); }
    } else {
      merged[k] = v;
      written.push(k);
    }
  }
  const preserved = Object.keys(before).filter((k) => !(k in patch));

  // 5) 落盘成功后才更新内存 —— 反过来会留下"内存生效、重启失效"的假象
  try {
    writeEnvLocal(merged);
  } catch (e) {
    return json(res, 500, { ok: false, error: `写入 .env.local 失败：${e.message}（内存配置未改动）` });
  }
  for (const k of removed) delete runtimeConfig[k];
  for (const [k, v] of Object.entries(patch)) if (v !== "") runtimeConfig[k] = v;

  // 绝不回显任何密钥值，只回执键名
  json(res, 200, {
    ok: true,
    written,
    removed,
    preserved,
    ignored,
    count: Object.keys(merged).length,
    file: ".env.local",
  });
}

/* ═════════════════ 配置自检：只探活，不花钱 ═════════════════
 *
 * 为什么需要它：设置页原来只有「保存」，用户填完密钥**没有任何办法知道它对不对**，
 * 直到真的点一次「生成」才失败 —— 而失败原因（域名错 / key 错 / 模型名错）
 * 全都藏在一次 400 的响应里，还顺带可能扣了一次额度。
 *
 * 探活方式：`GET {baseUrl}/models`。这是 OpenAI 兼容网关的**免费端点**，
 * 不产生 token、不生成图片，但足以分辨三种失败：
 *   · 连不上      → 域名 / 代理 / 防火墙
 *   · 401 / 403   → 密钥不认
 *   · 200         → 通了，还能顺便核对「配的模型在不在清单里」
 *
 * 🔴 两种"不能下结论"的情况必须如实说，不许假装成功：
 *   ① 对方 404/405（不提供 /models）：端点可达，但**密钥没被验证过**；
 *   ② 200 但没解析出模型清单：同上。回 `verified:false`，由界面用黄字呈现。
 *   这跟"数据不足不算通过"是同一条原则。
 *
 * 🔴 允许请求体带 baseUrl/apiKey 覆盖：用户刚在输入框里改完就想知道对不对，
 *    强制"先保存再测试"会多一步，而且容易忘。覆盖值**只在这一次请求里用**，
 *    不写 runtimeConfig、不写 .env.local —— 测试不应该有副作用。
 */
const TEST_MODELS_TIMEOUT = 9000;

function maskHost(u) {
  try { return new URL(u).host; } catch { return String(u || ""); }
}

async function handleConfigTest(req, res) {
  const violation = sameOriginViolation(req);
  if (violation) return json(res, 403, { ok: false, error: violation });

  let body;
  try {
    body = await readJSON(req, { requireJson: true });
  } catch (e) {
    return json(res, e.status || 400, { ok: false, error: e.message });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json(res, 400, { ok: false, error: "请求体必须是一个 JSON 对象" });
  }

  const target = String(body.target || "image");
  if (target !== "image" && target !== "chat") {
    return json(res, 400, { ok: false, error: `target 只能是 image 或 chat（收到 ${target}）` });
  }

  const pick = (k, fallback) => (typeof body[k] === "string" && body[k].trim() ? body[k].trim() : fallback);
  const c = imgCfg();
  const l = llmCfg();
  const cfg = target === "chat"
    ? {
      label: "对话模型",
      env: "CHAT_BASE_URL / CHAT_API_KEY",
      baseUrl: pick("baseUrl", l.baseUrl).replace(/\/$/, ""),
      apiKey: pick("apiKey", l.apiKey),
      model: pick("model", l.model),
    }
    : {
      label: "图片 API",
      env: "IMG_BASE_URL / IMG_API_KEY",
      baseUrl: pick("baseUrl", c.baseUrl).replace(/\/$/, ""),
      apiKey: pick("apiKey", c.apiKey),
      model: pick("model", c.model),
    };

  if (!cfg.baseUrl || !cfg.apiKey) {
    return json(res, 400, {
      ok: false, code: "unconfigured",
      error: `还没配 ${cfg.label}：缺 ${cfg.baseUrl ? "密钥" : "接口地址"}（${cfg.env}）`,
    });
  }
  // 和 /api/config 同一条校验：这个地址会被拼进 URL 再出网
  if (!/^https?:\/\/[^\s]+$/i.test(cfg.baseUrl)) {
    return json(res, 400, { ok: false, code: "bad-url", error: "接口地址必须以 http:// 或 https:// 开头，且不能含空白字符" });
  }

  const url = `${cfg.baseUrl}/models`;
  const t0 = Date.now();
  let resp;
  try {
    resp = await fetchWithTimeout(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "User-Agent": UA, Accept: "application/json" },
    }, TEST_MODELS_TIMEOUT);
  } catch (e) {
    const msg = e?.message || String(e);
    const timedOut = /超时/.test(msg);
    return json(res, 502, {
      ok: false, code: timedOut ? "timeout" : "network",
      error: timedOut ? `${TEST_MODELS_TIMEOUT / 1000}s 内没有响应` : msg,
      hint: timedOut
        ? "对方很慢或网络不通；确认一下本机代理 / 防火墙。"
        : "连不上这个域名（DNS / 代理 / 防火墙）。地址写错时也会落到这里。",
      host: maskHost(cfg.baseUrl), ms: Date.now() - t0,
    });
  }

  const text = await resp.text().catch(() => "");
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* 非 JSON 就走下面的分支 */ }

  if (resp.status === 401 || resp.status === 403) {
    return json(res, 200, {
      ok: false, code: "auth", status: resp.status,
      error: `密钥不被接受（HTTP ${resp.status}）`,
      hint: "确认 key 没写错、没过期，且套餐还有额度。注意有的服务用非 Bearer 的鉴权头（例如 secret-key）。",
      host: maskHost(cfg.baseUrl), ms: Date.now() - t0,
    });
  }
  if (resp.status === 404 || resp.status === 405) {
    // 端点活着但没这个接口：能连上，但密钥**没被验证**。如实说。
    return json(res, 200, {
      ok: true, verified: false, code: "no-models", status: resp.status,
      error: `端点是通的，但它不提供 /models（HTTP ${resp.status}），所以密钥没能被验证`,
      hint: "这种情况只能靠真正生成一张小图来验证；本次不会花额度，所以到此为止。",
      host: maskHost(cfg.baseUrl), ms: Date.now() - t0,
    });
  }
  if (!resp.ok) {
    return json(res, 200, {
      ok: false, code: "http", status: resp.status,
      error: `探测失败：HTTP ${resp.status}${text ? ` — ${text.replace(/\s+/g, " ").slice(0, 200)}` : ""}`,
      host: maskHost(cfg.baseUrl), ms: Date.now() - t0,
    });
  }

  // 200：尽量把模型清单读出来（形状各家略有不同，两种都认）
  const raw = parsed?.data ?? parsed?.models ?? null;
  const models = Array.isArray(raw)
    ? raw.map((m) => (typeof m === "string" ? m : m?.id || m?.name || "")).filter(Boolean)
    : [];
  // 🔴 modelFound 三态：true / false / null（没拿到清单，不下结论）
  const modelFound = !cfg.model || !models.length ? null : models.includes(cfg.model);
  json(res, 200, {
    ok: true,
    verified: true,
    code: "ok",
    host: maskHost(cfg.baseUrl),
    ms: Date.now() - t0,
    model: cfg.model || null,
    modelFound,
    modelCount: models.length,
    // 只回前 12 个，界面上够用；整份清单可能有几百项，没必要塞进浏览器
    models: models.slice(0, 12),
    ...(modelFound === false
      ? { warning: `清单里没有「${cfg.model}」—— 可能写错名字，也可能是网关自己改写模型名。` }
      : {}),
    ...(models.length ? {} : { note: "接口通了，但这个网关没返回模型清单，所以只验证了密钥与连通性。" }),
  });
}


/* ═══════════════════ 外部数据源（第三方 MCP，服务端代理）═══════════════════
 *
 * 为什么不让浏览器直连：
 *   ① **密钥必须留在服务端**。直连意味着 secret-key 要进 localStorage / 网络面板，
 *      任何一次 XSS 或一张截图分享都会泄露，而它是按调用量计费的。
 *   ② 对方端点不开 CORS 时，浏览器连请求都发不出去（这一条就足以否掉直连方案）。
 *   ③ 白名单只有服务端常量一个来源（见 EXTERNAL_MCP），请求体里没有 url 字段 ——
 *      不然这里就是通用 SSRF 跳板。
 *
 * 这里**不做任何业务判断**：调哪个工具、传什么参数由使用者决定，
 * 返回原样回传；只有 `/api/external/import` 会做一次"归一成词表"的搬运。
 * 界面上"填密钥"和"调工具"是两件事，失败时也能分清是没配还是对方不认。
 */

const EXT_DIR = path.join(DATA, "external");
const EXT_BODY_LIMIT = 256 * 1024;      // 请求体（工具参数）上限
const EXT_TEXT_LIMIT = 200 * 1024;      // 回传原文上限（有些工具一次吐几百 KB）
const EXT_TIMEOUT = 25000;

/** 只露末四位：够确认"填的是哪一把"，不够拿去用。 */
function maskSecret(s) {
  const v = String(s || "");
  if (!v) return "";
  return v.length < 8 ? "****" : `****${v.slice(-4)}`;
}

function externalProvider(id) {
  const p = EXTERNAL_MCP[id];
  if (!p) return null;
  return { ...p, id, key: String(getEnv(p.keyEnv, "") || "").trim() };
}

/** GET /api/external/providers —— 界面据此渲染卡片（绝不回传密钥本体）。 */
function handleExternalProviders(req, res) {
  json(res, 200, {
    ok: true,
    providers: Object.entries(EXTERNAL_MCP).map(([id, p]) => {
      const key = String(getEnv(p.keyEnv, "") || "").trim();
      return {
        id, label: p.label, url: p.url, keyEnv: p.keyEnv, note: p.note,
        header: p.header,
        configured: Boolean(key),
        keyHint: maskSecret(key),
      };
    }),
    note: "密钥只在本机服务进程里用：不回传浏览器、不写页面、不进日志。",
  });
}

/** 一次外部调用的公共前半段：同源 + JSON + 白名单 + 密钥。失败时直接回包并返回 null。 */
async function externalPreflight(req, res, { needKey = true } = {}) {
  // 与 /api/config 同一套同源判定：这两个接口都会花掉"本机配置的额度"
  const violation = sameOriginViolation(req);
  if (violation) { json(res, 403, { ok: false, error: violation }); return null; }

  const declared = Number(req.headers["content-length"] || 0);
  if (declared > EXT_BODY_LIMIT) {
    json(res, 413, { ok: false, error: `请求体过大（${declared} 字节，上限 ${EXT_BODY_LIMIT}）` });
    return null;
  }

  let body;
  try {
    body = await readJSON(req, { requireJson: true });
  } catch (e) {
    json(res, e.status || 400, { ok: false, error: e.message });
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    json(res, 400, { ok: false, error: "请求体必须是一个 JSON 对象" });
    return null;
  }
  if (Buffer.byteLength(JSON.stringify(body)) > EXT_BODY_LIMIT) {
    json(res, 413, { ok: false, error: "工具参数过大，请缩小范围（例如减少返回条数）" });
    return null;
  }

  const id = String(body.provider || "");
  const cfg = externalProvider(id);
  if (!cfg) {
    json(res, 400, {
      ok: false,
      error: `未知数据源「${id || "空"}」，可选：${Object.keys(EXTERNAL_MCP).join(" / ")}`,
    });
    return null;
  }
  if (needKey && !cfg.key) {
    // 这句要具体到"去配哪个环境变量"，否则使用者只看到"失败"
    json(res, 400, {
      ok: false,
      needKey: true,
      error: `还没配置 ${cfg.label} 的密钥（设置页「外部数据源」，或项目根目录 .env.local 写 ${cfg.keyEnv}=...）`,
    });
    return null;
  }
  return { cfg, body };
}

/** 把 HttpMcp 的错误翻译成"下一步该干什么"，而不是把栈丢回去。 */
function externalError(res, e, ms) {
  const status = e instanceof HttpMcpError ? e.status : undefined;
  const msg = e?.message || String(e);
  let hint = "";
  if (/鉴权失败/.test(msg)) hint = "密钥无效或已过期；也确认一下套餐是否还有额度。";
  else if (/超时|timeout|aborted/i.test(msg)) hint = "对方响应慢或网络不通；可以稍后重试，或把参数范围缩小。";
  else if (/fetch failed|ENOTFOUND|ECONNREFUSED/i.test(msg)) hint = "本机连不上该端点（DNS / 代理 / 防火墙）。";
  else if (/SSE|JSON/.test(msg)) hint = "对方返回的不是标准 Streamable HTTP 帧，先把原文看一眼再判断。";
  // 一律 502：错在**上游**，不是本服务的请求有问题。调用方据此能分清"我填错了"和"对面挂了"。
  json(res, 502, { ok: false, error: msg, hint, upstreamStatus: status ?? null, ms });
}

/* 允许调用的工具名形状。不是安全边界（真正的边界是对方鉴权），
 * 而是"别把用户拼错的怪字符串发出去" —— 对方回 404 比这里拦住更难解释。 */
const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** POST /api/external/test —— 握手 + tools/list。诊断用，不调业务工具。 */
async function handleExternalTest(req, res) {
  const pre = await externalPreflight(req, res);
  if (!pre) return;
  const { cfg } = pre;

  const t0 = Date.now();
  try {
    const out = await HttpMcp.once(
      { url: cfg.url, headers: { [cfg.header]: cfg.key }, timeout: EXT_TIMEOUT },
      async (c) => ({ server: c.serverInfo, tools: await c.listTools() }),
    );
    json(res, 200, {
      ok: true,
      provider: cfg.id,
      label: cfg.label,
      ms: Date.now() - t0,
      server: out.server,
      toolCount: out.tools.length,
      // 只说名字 / 用途 / 必填参数，不回传 inputSchema 全量（有的服务端给得很大）。
      // 必填参数必须带上：界面靠它告诉使用者"这个工具要填什么"，
      // 否则界面上只能给一个空白 JSON 框，等于让使用者去猜。
      tools: out.tools.map((t) => {
        const sch = t?.inputSchema || {};
        const req = Array.isArray(sch.required) ? sch.required : [];
        const props = sch.properties || {};
        return {
          name: String(t?.name || ""),
          description: String(t?.description || "").replace(/\s+/g, " ").slice(0, 200),
          params: Object.keys(props).slice(0, 20).map((k) => ({
            name: k,
            type: String(props[k]?.type || ""),
            required: req.includes(k),
            description: String(props[k]?.description || "").replace(/\s+/g, " ").slice(0, 80),
          })),
        };
      }),
    });
  } catch (e) {
    externalError(res, e, Date.now() - t0);
  }
}

/** POST /api/external/call —— 调一个工具，原样回传（不解释、不改写）。 */
async function handleExternalCall(req, res) {
  const pre = await externalPreflight(req, res);
  if (!pre) return;
  const { cfg, body } = pre;

  const tool = String(body.tool || "");
  if (!TOOL_NAME_RE.test(tool)) {
    return json(res, 400, { ok: false, error: `工具名不合法：${tool || "空"}` });
  }
  const args = body.args === undefined ? {} : body.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return json(res, 400, { ok: false, error: "args 必须是一个 JSON 对象" });
  }

  const t0 = Date.now();
  try {
    const out = await HttpMcp.once(
      { url: cfg.url, headers: { [cfg.header]: cfg.key }, timeout: EXT_TIMEOUT },
      (c) => c.callTool(tool, args),
    );
    const ms = Date.now() - t0;
    const text = String(out.text || "");
    json(res, 200, {
      ok: !out.isError,
      isError: out.isError,
      provider: cfg.id,
      tool,
      ms,
      // 字节数按 UTF-8 算：界面上"这次拉回来多大"直接对应 token 成本的量级
      bytes: Buffer.byteLength(text),
      truncated: text.length > EXT_TEXT_LIMIT,
      text: text.length > EXT_TEXT_LIMIT ? text.slice(0, EXT_TEXT_LIMIT) : text,
      data: out.data,
    });
  } catch (e) {
    externalError(res, e, Date.now() - t0);
  }
}

/**
 * POST /api/external/import —— 调工具 → 归一成词表 → 存到 data/external/<provider>.json
 *
 * 落盘的理由：外部额度按次计费，同一份数据不该因为"刷新页面"再买一次；
 * 而且导入之后词表要能和本地周词库做交集（该打未打 / 盲区），那需要两份数据同时在。
 * 🔴 这里只存**归一后的词**，不存原始返回 —— 原始返回可能有几百 KB，
 *    留着既占地方又需要另一套解析，而使用者要的只是"哪些词"。
 */
async function handleExternalImport(req, res) {
  const pre = await externalPreflight(req, res);
  if (!pre) return;
  const { cfg, body } = pre;

  const tool = String(body.tool || "");
  if (!TOOL_NAME_RE.test(tool)) {
    return json(res, 400, { ok: false, error: `工具名不合法：${tool || "空"}` });
  }
  const args = body.args === undefined ? {} : body.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return json(res, 400, { ok: false, error: "args 必须是一个 JSON 对象" });
  }

  const t0 = Date.now();
  try {
    const out = await HttpMcp.once(
      { url: cfg.url, headers: { [cfg.header]: cfg.key }, timeout: EXT_TIMEOUT },
      (c) => c.callTool(tool, args),
    );
    if (out.isError) {
      return json(res, 502, {
        ok: false,
        error: `对方工具返回错误：${String(out.text || "").slice(0, 300)}`,
        raw: true,
      });
    }

    const norm = normalizeTerms(out.data ?? out.text);
    const snapshot = {
      provider: cfg.id,
      label: cfg.label,
      tool,
      args,
      at: new Date().toISOString(),
      count: norm.count,
      mapping: norm.mapping,
      why: norm.why,
      bytes: Buffer.byteLength(String(out.text || "")),
      terms: norm.terms,
    };

    // 与 .env.local 同一套原子写：先 tmp 再 rename，避免半截 JSON
    fs.mkdirSync(EXT_DIR, { recursive: true });
    const file = path.join(EXT_DIR, `${cfg.id}.json`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 0), "utf8");
    fs.renameSync(tmp, file);

    json(res, 200, {
      ok: true,
      provider: cfg.id,
      label: cfg.label,
      tool,
      ms: Date.now() - t0,
      count: norm.count,
      // 把"猜了哪些字段"明明白白回报：猜对了看得见，猜错了也看得见
      mapping: norm.mapping,
      why: norm.why,
      bytes: snapshot.bytes,
      file: `data/external/${cfg.id}.json`,
      // 只回前 20 条做预览，整份在 /api/external/terms
      preview: norm.terms.slice(0, 20),
      terms: norm.terms,
    });
  } catch (e) {
    externalError(res, e, Date.now() - t0);
  }
}

/** GET /api/external/terms?provider= —— 读上一次导入（没导入过就如实说没导入）。
 *
 * `?compare=1` 追加一次**与本地周词库求交集**：这是"两边一起用"的落点 ——
 * 外部有、本地没有的词＝本地采集的盲区（值得单独看）；
 * 两边都有的词＝可以互相印证，不用怀疑是采集噪声。
 * 对比在服务端做（不是浏览器），因为浏览器只能拿到 limit 截断后的 500 条，
 * 用截断后的数据算"盲区"会把大量真实覆盖算成盲区 —— 那种数字比不给更糟。
 */
function handleExternalTerms(req, res, url) {
  const id = String(url.searchParams.get("provider") || "").trim() || Object.keys(EXTERNAL_MCP)[0];
  if (!EXTERNAL_MCP[id]) {
    return json(res, 400, { ok: false, error: `未知数据源「${id}」` });
  }
  // `?demo=1` 读**仓库里的示例数据**，不碰 data/external：
  // 这样"没账号的人"也能先看清导入之后长什么样，而真实导入不会被示例覆盖。
  // 🔴 示例必须能被界面识别（返回里带 demo:true），否则会被当成自己的数据。
  const useDemo = url.searchParams.get("demo") === "1";
  const file = useDemo
    ? path.join(HERE, "tools", "fixtures", "external", `${id}-demo.json`)
    : path.join(EXT_DIR, `${id}.json`);
  if (!fs.existsSync(file)) {
    return json(res, 200, {
      ok: false,
      provider: id,
      reason: useDemo ? "没有示例数据" : "还没导入过",
      hint: useDemo
        ? "这个数据源没有配示例；本地跑 `node tools/collect-keywords.mjs` 先有词库，再用自己的密钥导一次。"
        : "在「设置 → 外部数据源」配好密钥后，选一个工具点「导入词表」。",
    });
  }
  let snap;
  try {
    snap = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return json(res, 200, { ok: false, provider: id, reason: "文件损坏", error: e.message });
  }

  // `count` 以 terms 实际条数为准：手写的 fixture / 旧版本文件可能没有这个字段，
  // 界面就会显示「0 词」—— 数据明明在，却报成空的，比不显示更糟。
  if (snap.count == null) snap.count = Array.isArray(snap.terms) ? snap.terms.length : 0;
  const out = { ok: true, ...snap };
  if (url.searchParams.get("compare") === "1") {
    const local = readLatest();
    if (!local.ok) {
      // 本地没有词库不是错误，但**不能**于是说"全部都是盲区" —— 那是 0 覆盖率的另一种说法
      out.compare = {
        ok: false,
        reason: local.reason,
        hint: "本地还没有周词库快照，无法对比。先跑一次 `node tools/collect-keywords.mjs`。",
      };
    } else {
      const localSet = new Set(local.snapshot.keywords.map((k) => termKey(k.term)));
      const extKeys = new Set(snap.terms.map((t) => termKey(t.term)));
      const both = snap.terms.filter((t) => localSet.has(termKey(t.term)));
      const onlyExt = snap.terms.filter((t) => !localSet.has(termKey(t.term)));
      const onlyLocal = local.snapshot.keywords.filter((k) => !extKeys.has(termKey(k.term)));
      out.compare = {
        ok: true,
        localCount: local.snapshot.keywords.length,
        externalCount: snap.terms.length,
        bothCount: both.length,
        // 盲区：外部词表里有、本地周词库没抓到的词
        externalOnlyCount: onlyExt.length,
        externalOnly: onlyExt.slice(0, 100),
        localOnlyCount: onlyLocal.length,
        generatedAt: local.snapshot.generatedAt || null,
      };
    }
  }
  json(res, 200, out);
}

/**
 * 魔数嗅探：**只信文件头，不信声明的 Content-Type**。
 *
 * 🔴 原来只看 `content-type: image/*` —— 那是一个客户端随便填的字符串。
 *    于是 `image/svg+xml` 能过关，而 SVG 里可以带 `<script>`；文件被写进 uploads/
 *    再由 /api/blob 从**同源**返回，就是一条现成的 XSS 通道（还能顺带读 localStorage 里的配置）。
 *    只接受四种位图的文件头，其余一律 415。
 */
const IMAGE_MAGIC = [
  { mime: "image/png", ext: "png", ok: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: "image/jpeg", ext: "jpg", ok: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/gif", ext: "gif", ok: (b) => b.length > 6 && b.subarray(0, 4).toString("latin1") === "GIF8" },
  { mime: "image/webp", ext: "webp", ok: (b) => b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
];

function sniffImage(buf) {
  for (const m of IMAGE_MAGIC) if (m.ok(buf)) return { mime: m.mime, ext: m.ext };
  return null;
}

async function handleUpload(req, res) {
  try {
    const ct = req.headers["content-type"] || "";
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
    if (!m) return json(res, 400, { error: "缺少 multipart boundary" });
    const boundary = m[1] || m[2];
    const buf = await readBody(req, 12 * 1024 * 1024);
    const parts = parseMultipart(buf, boundary);
    const filePart = parts.find((p) => /name="file"/i.test(p.headers));
    if (!filePart) return json(res, 400, { error: "缺少 file 字段" });
    const filename = headerValue(filePart.headers, "filename") || "upload";
    const contentType = headerValue(filePart.headers, "Content-Type") || "";
    if (filePart.body.length > 8 * 1024 * 1024) return json(res, 413, { error: "文件过大（上限 8MB）" });
    const sniff = sniffImage(filePart.body);
    if (!sniff) {
      return json(res, 415, {
        error: `文件内容不是 PNG / JPEG / WebP / GIF（声明类型是 ${contentType || "未填"}）。只接受位图：SVG 及其它格式一律拒绝 —— SVG 可以带脚本，存成同源静态文件就是一条 XSS 通道。`,
        declaredType: contentType || null,
      });
    }
    const file = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}.${sniff.ext}`;
    fs.writeFileSync(path.join(UPLOADS, file), filePart.body);
    const key = `uploads/${file}`;
    json(res, 200, {
      key, url: `/api/blob?key=${encodeURIComponent(key)}`,
      // 回传的是**嗅探结果**（真实类型），声明值单独保留，方便排查"文件被改了后缀"这类事
      contentType: sniff.mime, declaredType: contentType || null,
      size: filePart.body.length, originalName: filename,
    });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
}

function handleBlob(req, res, url) {
  const key = url.searchParams.get("key");
  const p = keyToPath(key);
  if (!p) return json(res, 403, { error: "key 前缀不合法（只允许 gen/ 与 uploads/）" });
  if (!fs.existsSync(p)) return json(res, 404, { error: `not found: ${key}` });
  const bytes = fs.readFileSync(p);
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(p).toLowerCase()] || "application/octet-stream",
    "Content-Length": bytes.length,
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  res.end(bytes);
}

async function handleImage(req, res) {
  const t0 = Date.now();
  try {
    const { prompt, size = "1024x1024", imageKey } = await readJSON(req, { requireJson: true });
    if (!prompt || !String(prompt).trim()) return json(res, 400, { error: "prompt 不能为空" });
    let imageDataUri;
    let mode = "txt2img";
    if (imageKey) {
      const p = keyToPath(imageKey);
      if (!p || !fs.existsSync(p)) return json(res, 400, { error: `imageKey 无效或不存在：${imageKey}` });
      const ext = path.extname(p).slice(1).toLowerCase();
      const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
      imageDataUri = `data:${mime};base64,${fs.readFileSync(p).toString("base64")}`;
      mode = "img2img";
    }
    const progress = [];
    const ac = abortOnDisconnect(res);
    const r = await callImageAPI({ prompt, size, imageDataUri, onProgress: (m) => progress.push(m), signal: ac.signal });
    const { key, filename } = await downloadToGen(r.imageUrl, r.imageB64);
    json(res, 200, {
      url: `/api/blob?key=${encodeURIComponent(key)}`,
      filename, key, mode,
      // 实际发出去的尺寸 / 调用方请求的尺寸 / 吸附说明 —— 三个都回传，前端不许自己猜
      size: r.sizeSent || size,
      sizeRequested: size,
      ratio: r.ratio || toRatio(size),
      sizeNote: r.sizeNote || "",
      elapsedMs: Date.now() - t0,
      cost: r.cost != null ? `$${Number(r.cost).toFixed(4)}` : null,
      progress,
    });
  } catch (e) {
    json(res, e.status || 500, { error: e.message, elapsedMs: Date.now() - t0 });
  }
}

async function handleVision(req, res) {
  try {
    const { imageKey } = await readJSON(req, { requireJson: true });
    const p = keyToPath(imageKey);
    if (!p || !fs.existsSync(p)) return json(res, 400, { error: `imageKey 无效：${imageKey}` });
    const cfg = imgCfg();
    if (!cfg.baseUrl || !cfg.apiKey) return json(res, 500, { error: "缺少 IMG_BASE_URL / IMG_API_KEY" });
    const ext = path.extname(p).slice(1).toLowerCase();
    const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
    const dataUri = `data:${mime};base64,${fs.readFileSync(p).toString("base64")}`;

    const visionPrompt = `你是电商视觉分析助手。分析这张参考图，只输出 JSON（不要 markdown 代码块、不要其他文字），结构：
{"product":"产品类型中文描述","colors":["#RRGGBB 颜色名，最多4个"],"material":"材质与纹理","composition":"构图（角度、产品占比%、留白%）","lighting":"光线（方向、强度、色温K）","style":"风格","background":"背景（颜色+材质+道具）","key_features":["可见卖点 2-4 条"],"summary":"一句话（≤60字）"}
要求：颜色必须用 hex 码，不要写"深绿色"；如果不是产品图如实说明；JSON 必须可解析。`;

    const resp = await fetchWithTimeout(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: getEnv("IMG_CHAT_MODEL", "agnes-2.0-flash"),
        temperature: 0.3,
        max_tokens: 800,
        messages: [{ role: "user", content: [{ type: "text", text: visionPrompt }, { type: "image_url", image_url: { url: dataUri } }] }],
      }),
    }, 120000, abortOnDisconnect(res).signal);
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) return json(res, 500, { error: `vision HTTP ${resp.status}: ${JSON.stringify(j).slice(0, 300)}` });
    const raw = j?.choices?.[0]?.message?.content || "";
    let analysis = null;
    try { analysis = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, "")); } catch { /* 保底给原始文本 */ }
    json(res, 200, { raw, analysis, model: getEnv("IMG_CHAT_MODEL", "agnes-2.0-flash") });
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
}

async function handleLLM(req, res) {
  try {
    const { system = "", user = "", temperature = 0.6 } = await readJSON(req, { requireJson: true });
    const cfg = llmCfg();
    if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
      return json(res, 500, { error: "未配置 CHAT_BASE_URL / CHAT_MODEL / CHAT_API_KEY（这三项是可选的，不配也能用本地规则）" });
    }
    const resp = await fetchWithTimeout(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.model, temperature,
        messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: user }],
      }),
    }, 120000, abortOnDisconnect(res).signal);
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) return json(res, 500, { error: `HTTP ${resp.status}: ${JSON.stringify(j).slice(0, 300)}` });
    json(res, 200, { text: j?.choices?.[0]?.message?.content || "", model: cfg.model });
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
}

/* ─────────────────────── SSE 编排 ─────────────────────── */

function sseHead(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}
const ev = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

/* 🔴 意图词表不在这里定义。
 *
 * 原来服务端自己有一份（`生图/生成图片/生成图/出图/画一张/做一张/render/generate image`），
 * 比浏览器侧少 6 个说法（`generate images` / `生几张` / `directly generate` …）。
 * 后果是同一句话**在线与离线结论相反**：
 *   "generate images for this product" → 离线：出图；在线：只出 Prompt。
 * 用户看到的是"同一个工具，接了服务端反而变笨"，而且没有任何报错。
 *
 * 现在两边都从 assets/orchestrator.js 取，物理上不可能再分叉。
 */

async function handleChat(req, res) {
  let body;
  try { body = await readJSON(req, { requireJson: true }); } catch (e) { return json(res, e.status || 400, { error: e.message }); }
  const message = String(body.message || "").trim();
  const imageKey = typeof body.imageKey === "string" ? body.imageKey : undefined;
  // 可选：用户在模板库里显式点了某个模板。不传 = 走自动匹配（默认行为）。
  const explicitTemplateId = typeof body.templateId === "string" && body.templateId ? body.templateId : null;
  if (!message) return json(res, 400, { error: "'message' 必填" });

  sseHead(res);
  const beat = setInterval(() => { try { res.write(ev({ type: "ping", ts: Date.now() })); } catch { /* closed */ } }, 5000);
  const send = (o) => { try { res.write(ev(o)); } catch { /* closed */ } };
  const t0 = Date.now();
  // 一次请求一个中断器：用户点「停止」/关标签页 → 上游请求立刻中止（不再白跑 180s、白扣额度）
  const ac = abortOnDisconnect(res);

  try {
    const wantGenerate = isGenerateIntent(message);
    const wantPack = isPackIntent(message);

    // 参考图 → 先识图
    let vision = null;
    let visionError = "";
    if (imageKey) {
      send({ type: "tool_call", name: "vision_analyze", input: { imageKey } });
      try {
        const p = keyToPath(imageKey);
        if (!p || !fs.existsSync(p)) throw new Error(`imageKey 不存在：${imageKey}`);
        const cfg = imgCfg();
        const ext = path.extname(p).slice(1).toLowerCase();
        const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
        const resp = await fetchWithTimeout(`${cfg.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: getEnv("IMG_CHAT_MODEL", "agnes-2.0-flash"), temperature: 0.3, max_tokens: 800,
            messages: [{ role: "user", content: [
              { type: "text", text: `分析这张商品图，只输出 JSON：{"product":"","colors":["#hex"],"material":"","composition":"","lighting":"","style":"","background":"","key_features":[],"summary":""}` },
              { type: "image_url", image_url: { url: `data:${mime};base64,${fs.readFileSync(p).toString("base64")}` } },
            ] }],
          }),
        }, 120000, ac.signal);
        // 🔴 原来这里不看 resp.ok：401/429/500 时 json() 也能成功（返回错误体），
        //    raw 取到空串 → `vision?.raw` 为假 → **静默**退回纯文本生图。
        //    用户只看到"图生成了"（其实完全没参考他的产品），这是最坏的一类失败。
        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          throw new Error(`识图接口 HTTP ${resp.status}${body ? `：${body.slice(0, 200)}` : ""}`);
        }
        const j = await resp.json().catch(() => ({}));
        const raw = String(j?.choices?.[0]?.message?.content || "").trim();
        if (!raw) throw new Error("识图返回空内容（常见原因：该模型不支持图片输入 / 图片过大 / 被内容策略拦截）");
        vision = { raw };
        send({ type: "tool_result", name: "vision_analyze", content: raw.slice(0, 500) });
      } catch (e) {
        vision = null;
        visionError = e.message;
        // 降级可以，**静默**降级不行 —— 让用户明确知道"这次没参考你的图"。
        send({
          type: "tool_result",
          name: "vision_analyze",
          level: "warn",
          content: `⚠️ 识图失败：${e.message}\n→ 本次已降级为「纯文本生图」：**参考图里产品的真实外观没有被参考**，生成结果可能与你的产品不一致。请在预览里核对主图细节（logo、颜色、结构），必要时重试识图，或先手动把产品特征写进指令里。`,
        });
      }
    }

    // 🔴 确定性编排只有一处实现：直接复用浏览器端同一个 runLocalTurn。
    //    这里曾经自己重写了一遍主体抽取 + 简报拼装，结果离线路径修好了、服务端还是旧的
    //    （症状：产品位写着"给这款宠物自动喂食器一整套和，走痛点驱动"）。不要再复制第二份。
    const turn = runLocalTurn({
      message,
      pack: wantPack,
      explicitTemplateId,
      onEvent: send,
    });
    const pack = turn.packPlan;
    // 🆕 整套出图的入口：规划好 N 条 Prompt 之后，把"逐张生成"的能力交给界面。
    // 🔴 这里**只发计划、不自动开跑** —— 一次 14 张是真金白银，必须由用户点确认。
    const pp = packPayload(pack);
    if (pp && pp.total > 1) send({ type: "pack_ready", pack: pp });
    // 有参考图 → 走图生图（保留产品身份，只换场景），场景描述用识图结果；
    // 没有参考图 → 用同一套编排算出来的 Prompt（整包取第 1 张）。
    const finalPrompt = imageKey && vision?.raw
      ? composeImg2ImgPrompt({
          target: message,
          scene: String(vision.raw).slice(0, 600),
          styleLock: turn.styleLock,
          templateId: "lifestyle-scene",
          figure: "scene",
        }).prompt
      : (pack ? pack.items[0].prompt : turn.single.prompt);

    // 出图
    if (wantGenerate && !isNegative(message)) {
      const cfg = imgCfg();
      if (RO_PUBLIC) {
        // 线上演示版不代客出图：Prompt 已经在上面，额度是站长的。说清楚原因，别只说"失败"。
        send({ type: "error_message", content: "线上演示版不调用生图接口（避免消耗站长额度），文字与 Prompt 全部正常生成 —— 可以直接把上面那段 Prompt 复制到任意生图工具使用。clone 到本地并填入自己的 key 即可端到端出图。" });
      } else if (!cfg.baseUrl || !cfg.apiKey) {
        send({ type: "error_message", content: "检测到出图意图，但还没配置图片 API。去「设置」里填 IMG_BASE_URL / IMG_MODEL / IMG_API_KEY，或写进项目根目录的 .env.local（.env 也认，.env.local 优先）后重启服务。" });
      } else {
        send({ type: "tool_call", name: "generate_image", input: { mode: imageKey ? "img2img" : "txt2img" } });
        try {
          let imageDataUri;
          if (imageKey) {
            const p = keyToPath(imageKey);
            const ext = path.extname(p).slice(1).toLowerCase();
            const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
            imageDataUri = `data:${mime};base64,${fs.readFileSync(p).toString("base64")}`;
          }
          const r = await callImageAPI({
            prompt: finalPrompt, size: turn.size || "1024x1024", imageDataUri,
            onProgress: (msg) => send({ type: "tool_result", name: "generate_image", content: msg }),
            signal: ac.signal,
          });
          const { key, filename } = await downloadToGen(r.imageUrl, r.imageB64);
          const secs = ((Date.now() - t0) / 1000).toFixed(1);
          send({ type: "file_output", filename, url: `/api/blob?key=${encodeURIComponent(key)}`, description: `${r.mode} · ${r.ratio || turn.size || ""} · ${secs}s${r.cost != null ? ` · $${Number(r.cost).toFixed(4)}` : ""}${visionError ? " · ⚠️ 未参考原图（识图失败）" : ""}` });
          // 🔴 画幅被吸附过就必须说：悄悄给一张比例不对的图，用户会拿去直接上架。
          if (r.sizeNote) send({ type: "tool_result", name: "generate_image", level: "warn", content: `⚠️ ${r.sizeNote}` });
          // 🔴 口径对齐（A1）：整套规划 N 条，本链路只执行第 1 条。
          //    简报里如果不声明这一点，用户会对着一张图以为后面 13 张也在生成队列里。
          if (pack && pack.items.length > 1) {
            send({
              type: "tool_result", name: "generate_image", level: "warn",
              content: `本次只生成了第 1 张（\`${pack.items[0].code}\`）。整套规划共 ${pack.items.length} 张，其余 ${pack.items.length - 1} 张的 Prompt 在简报 ④ 的表里，状态是**待生成**——它们还没有出图。`,
            });
          }
        } catch (e) {
          send({ type: "error_message", content: `生图失败：${e.message}` });
        }
      }
    }

    if (!ac.signal.aborted) res.write("data: [DONE]\n\n");
  } catch (e) {
    // 断开导致的 abort 不是"错误"，不必再往一个已经关掉的 socket 里写错误
    if (!ac.signal.aborted) send({ type: "error_message", content: e.message });
  } finally {
    clearInterval(beat);
    try { res.end(); } catch { /* already closed */ }
  }
}

/* ─────────────────────── 静态资源 ─────────────────────── */

/**
 * 静态资源：**白名单**，不是黑名单。
 *
 * 🔴 原来是"项目根目录下随便读"：`full.startsWith(HERE)` 只挡了 `..` 逃逸，
 *    挡不住根目录里的**普通文件**。于是这些都能被一条 GET 拿走：
 *      · /.env.local   → 里面就是 IMG_API_KEY（设置页写入的明文）
 *      · /.env         → 同上
 *      · /server.mjs   → 服务端源码
 *      · /data/gen/*   → 用户自己生图的结果（本应走 /api/blob 的前缀白名单）
 *    再叠上"不校验 Host 头"，本机服务就能被 DNS rebinding 从任意网页读一遍。
 *
 * 所以改成只放行两类路径，其余一律 404（不报 403 —— 不告诉探测方"这里有个东西"）：
 *   · index.html
 *   · assets/ 前缀
 * 页面本身只引用 assets/app.css 与 assets/app.js，够用。
 */
function serveStatic(req, res, url) {
  // 🔴 decodeURIComponent 会对畸形百分号编码抛 URIError（实测 `GET /%E0%A4%A`）。
  //    不接住就会冒到外层 catch 变成 500「URI malformed」——这是**请求路径不合法**，
  //    不是服务崩了，按 404 处理（也顺带不把内部错误文本回显出去）。
  let rel;
  try { rel = decodeURIComponent(url.pathname); }
  catch { return json(res, 404, { error: "not found: (malformed path)" }); }
  if (rel === "/" || rel === "") rel = "/index.html";
  const safe = path.normalize(rel).replace(/^([/\\])+/, "");
  // ⚠️ Windows 上 path.normalize 会把 `/` 换成 `\`，白名单必须比**转成正斜杠后**的形态，
  //    否则 "assets\app.css".startsWith("assets/") 恒为 false，整个前端直接 404（踩过）。
  const posix = safe.replace(/\\/g, "/");
  // 白名单判定放在 normalize **之后**：`assets/../.env.local` 归一成 `.env.local`，照样被挡
  if (posix !== "index.html" && !posix.startsWith("assets/")) {
    return json(res, 404, { error: `not found: ${rel}` });
  }
  const full = path.join(HERE, safe);
  if (!full.startsWith(HERE + path.sep)) return json(res, 404, { error: `not found: ${rel}` });
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return json(res, 404, { error: `not found: ${rel}` });
  }
  const bytes = fs.readFileSync(full);
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream",
    "Content-Length": bytes.length,
    "Cache-Control": "no-cache",
  });
  res.end(bytes);
}

/* ─────────────── 本周词库（定时任务写入，这里只读） ─────────────── */

/**
 * GET /api/keywords?q=&limit=&asins=1
 *
 * 数据来自 `data/keywords/latest.json`（由 `tools/collect-keywords.mjs` 每周写入，
 * 在 GitHub Actions 里跑）。本接口**不抓取、不写盘**，只把文件读出来。
 *
 * 🔴 「没有词库」返回的是 **200 + ok:false**，不是 404。
 *    因为"定时任务还没跑过"是一个**正常状态**，不是接口错误；用 404 会让前端
 *    把它当成网络故障，界面上就变成一句含混的"加载失败"。这里必须能说清原因。
 *    同理，`stale`（过期）也照实返回，不让界面把旧数据当本周数据展示。
 */
function handleKeywords(req, res, url) {
  // 🔴 默认路径**一字不变**（readLatest() 无参），只有显式 ?site=DE 这类请求才走站点维度。
  //    这样 P1-2 的新结构不会把已有 237 条服务端断言的默认行为碰坏。
  const wantedSite = String(url.searchParams.get("site") || "").toUpperCase();
  const r = wantedSite && wantedSite !== "US" ? readLatest(process.env, wantedSite) : readLatest();
  if (!r.ok) {
    // 没有快照时也要把"上次采集到底怎么了"带回去 —— 否则界面只能显示"暂时没有词库"，
    // 而真实原因可能是"昨晚跑挂了"，两种情况的下一步完全不同。
    const st = readStatus();
    return json(res, 200, {
      ok: false,
      reason: r.reason,
      error: r.error,
      hint: "词库由定时任务生成：本地可跑 `node tools/collect-keywords.mjs`，线上看 GitHub Actions 的每周任务。",
      // 🔴 冷分支的 trust 形状必须和热分支**一致**（staleness 给 missing）：
      //    少一个字段，界面就得写两套渲染；两套渲染迟早会各说一套。
      trust: {
        staleness: staleness(null),
        status: st.ok
          ? st.status
          : { ok: false, reason: st.reason, error: st.error, lastAttemptAt: null, lastSuccessAt: null },
      },
      // 🔴 冷分支的**字段形状**必须与热分支一致（G-3 的教训）：少一个字段，
      //    界面就得写两套渲染，两套渲染迟早各说一套。这里一律给 ok:false + 原因，不给 0。
      compare: { ok: false, reason: "还没有词库快照，暂时没法对比" },
      asinDiff: { ok: false, reason: "还没有词库快照，暂时没法看 ASIN 变动" },
      roots: { ok: false, reason: "还没有词库快照，暂时没有词根命中统计" },
      verifiedMarkets: verifiedMarketsList(),
    });
  }
  const snap = r.snapshot;
  const q = String(url.searchParams.get("q") || "");
  // README 早就写了 `?category=`，但代码里一直没实现 —— 参数被静默忽略，返回的是全部。
  // 这种"文档承诺了、代码没做"比没写更糟：调用方会以为筛过了。
  const group = String(url.searchParams.get("category") || "").trim();
  // 🔴 这里**不再夹 2000**：上限只由 `MAX_KEYWORD_LIMIT` 一处决定。夹两次的后果是
  //    "文档写 2000、代码给 500"，而夹在两层的人各自都以为自己在守规矩。
  //    要多了不报错，但必须报账 —— `keywordsRequested` 就是那句账。
  const limit = Math.max(1, Number(url.searchParams.get("limit")) || 300);
  // 排序维度：roots（默认，rootCount 降序）/ new（新词优先）/ az（字母序）。
  // 只接受这三个值，别的一律回落到默认 —— 未知排序静默变成"字母序"会让人以为数据变了。
  const SORTS = ["roots", "new", "az"];
  const askedSort = String(url.searchParams.get("sort") || "").toLowerCase();
  const sort = SORTS.includes(askedSort) ? askedSort : "roots";
  const kw = queryKeywords(snap, { q, limit, group, sort });
  const wantAsins = url.searchParams.get("asins") === "1";
  // 类目筛选对 ASIN 同样生效（关键词按 `groups`、ASIN 按 `group`/`category` 两个字段都可能存）。
  const asinPool = group
    ? snap.asins.filter((x) => [x.group, x.category].some((v) => String(v || "").toLowerCase() === group.toLowerCase()))
    : snap.asins;
  const asinPage = asinPool.slice(0, 500);

  // ── 批三：历史对比 / ASIN 监控 / 词根统计 ─────────────────────────────
  // 全部读**已有的投影文件**，不在这里抓取、不写盘。没有上一份就如实说没有，
  // 不返回一堆 0 —— 界面把 0 读成「本周没有新词」比不给数据更糟。
  const snapSite = String(snap.site || "US").toUpperCase();
  const prev = readPrevDigest(snapSite);
  let curDigest = null;
  try { curDigest = digestOf(snap); } catch { /* 老快照形状不齐：下面一律给 ok:false */ }
  const asinDiff = prev.ok && curDigest
    ? { ok: true, prevFile: prev.name, ...diffAsins(prev.digest?.asinRanks, curDigest.asinRanks) }
    : { ok: false, reason: prev.ok ? "当前快照算不出 ASIN 投影" : prev.reason };
  // 只在 ?compare=prev 时算版本对比（默认请求不付这份成本）
  const compare = url.searchParams.get("compare") === "prev"
    ? (prev.ok
        ? { ok: true, prevFile: prev.name, ...compareSnapshots(snap, asComparableSnapshot(prev.digest)) }
        : { ok: false, reason: prev.reason })
    : undefined;
  const roots = snap.sources?.roots
    ? { ok: true, ...snap.sources.roots }
    : { ok: false, reason: "本周快照还没有词根命中统计（跑一次采集即可生成）" };

  return json(res, 200, {
    ok: true,
    schema: snap.schema,
    site: snap.site,
    market: snap.market,
    generatedAt: snap.generatedAt,
    ageDays: r.staleness.ageDays,
    stale: r.staleness.state !== "fresh",
    staleNote: r.staleness.note,
    counts: {
      keywords: snap.summary?.keywordCount ?? snap.keywords.length,
      asins: snap.summary?.asinCount ?? snap.asins.length,
      newKeywords: snap.summary?.newKeywordCount ?? 0,
      droppedKeywords: snap.summary?.droppedKeywordCount ?? 0,
    },
    sources: snap.sources,
    summary: snap.summary,
    keywords: kw.rows,
    // 截断必须能看见：limit 再大，底层上限是 500；ASIN 一次最多给 500。
    // 不返回 total 的话，调用方会把"500 条"当成"全部只有 500 条"。
    keywordsTotal: kw.total,
    keywordsTruncated: kw.truncated,
    keywordsLimit: kw.limit,
    keywordsRequested: kw.requested,
    keywordsSort: sort,
    // ── 信任指标（G-3）───────────────────────────────────────────────
    // 判据：任何"数据可能不全/不新/不准"的事实，都必须在界面上出现一次。
    // 只放在 JSON 里等于没说 —— 运营不会去看返回体。
    trust: (() => {
      const st = readStatus();
      const n = snap.asins.length || 1;
      const ratio = (fn) => Math.round((snap.asins.filter(fn).length / n) * 100) / 100;
      return {
        staleness: r.staleness,
        status: st.ok
          ? st.status
          : { ok: false, reason: st.reason, error: st.error, lastAttemptAt: null, lastSuccessAt: null },
        // US 实测过，其余站点只是"能选"；快照里显式写了的优先（将来的 --allow-unverified）
        verifiedMarket: snap.verifiedMarket ?? (String(snap.site || "US").toUpperCase() === "US"),
        truncated: { keywords: kw.truncated, asins: asinPool.length > asinPage.length },
        // 价格覆盖率按 `priceKnown` 算（"解析器有没有匹配到价格节点"），不是 `Boolean(price)`。
        // 老快照没有该字段时退回旧判据，避免一升级就把覆盖率显示成 0%。
        coverage: {
          price: ratio((a) => a.priceKnown ?? Boolean(a.price)),
          rating: ratio((a) => Boolean(a.rating)),
          reviewCount: ratio((a) => Boolean(a.reviewCount)),
        },
        emptyGroups: snap.keywords.filter((k) => !(k.groups || []).length).length,
        sourceStatus: Object.fromEntries(Object.entries(snap.sources || {}).map(([k, v]) => [k, v?.status || "?"])),
        budget: snap.sources?.suggest
          ? { planned: snap.sources.suggest.budget ?? null, requests: snap.sources.suggest.requests ?? null, skipped: snap.sources.suggest.skipped ?? null }
          : null,
        returnedUnknown: snap.summary?.returnedUnknown ?? true,
      };
    })(),
    asins: wantAsins ? asinPage : undefined,
    asinsTotal: wantAsins ? asinPool.length : undefined,
    asinsTruncated: wantAsins ? asinPool.length > asinPage.length : undefined,
    // ── 批三/批四新增字段。前端必须容忍它们缺失（旧服务端 / 只读演示版）。──
    compare,
    asinDiff,
    roots,
    verifiedMarkets: verifiedMarketsList(),
    legacy: r.legacy ?? false,
    note: "关键词来自亚马逊搜索建议（真实买家搜索词），**不含搜索量**；ASIN 来自 Best Sellers 公开榜单页，名次是榜单名次，不是销量。",
  });
}

/* ─────── 词根覆盖层 / 历史对比 / CSV 导出（批三 + 批四） ─────── */

/**
 * 词根覆盖层落在 `data/keywords/roots.json`，是**运营可改的数据**，不是源码。
 * 服务端只做三件事：读、校验（交给 resolveRoots）、原子写。
 * 🔴 路径是常量，请求体里没有 path 字段 —— 否则这个接口就变成任意文件写入。
 */
const KW_DIR = path.join(DATA, "keywords");
const ROOTS_FILE = path.join(KW_DIR, "roots.json");
const ROOTS_BODY_LIMIT = 64 * 1024;
const ROOT_ITEM_LIMIT = 200;

function readOverlay() {
  try {
    if (!fs.existsSync(ROOTS_FILE)) return { overlay: null, reason: "还没有覆盖层，当前按基线词根运行" };
    const parsed = JSON.parse(fs.readFileSync(ROOTS_FILE, "utf8").replace(/^\uFEFF/, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("顶层不是对象");
    return { overlay: parsed, reason: "" };
  } catch (e) {
    // 覆盖层是手改文件，损坏是**预期内**的正常状态：退回基线继续跑，不中断采集。
    return { overlay: null, reason: `覆盖层读不出来，已按基线跑：${e.message}` };
  }
}

/** 站点「可见但不承诺」（G-9）：只有 US 经过实测，其余一律标未实测。 */
function verifiedMarketsList() {
  return Object.entries(SITE_DOMAIN).map(([code, host]) => ({ code, host, verified: code === "US" }));
}

/**
 * 历史投影文件列表。兼容两种布局：新的 `history/<SITE>/` 与旧的扁平 `history/`。
 * 🔴 排序必须按 **(日期, 序号数值)**，不能用纯文件名字典序：
 *    `'-'`(0x2D) < `'.'`(0x2E)，所以 `2026-11-08-2.json` 会排在 `2026-11-08.json` **前面**；
 *    而 `-10` 又排在 `-2` 前面。纯字典序的"最后一个"会是当天第一次的旧投影，
 *    正好把 P2#5「同日重跑不覆盖」的意义抵消掉，还会让 S-3/S-4 对不上最新数据。
 *    采集器的保留策略用的就是数值序，两处必须同一套口径。
 */
function historyDigestFiles(site = "US") {
  const dirs = [path.join(KW_DIR, "history", String(site).toUpperCase()), path.join(KW_DIR, "history")];
  const seen = new Map();
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}(-\d+)?\.json$/.test(n));
    } catch { continue; }
    for (const n of names) if (!seen.has(n)) seen.set(n, path.join(dir, n));
  }
  const keyOf = (f) => {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.json$/);
    return [m ? m[1] : f, m ? Number(m[2] || 1) : 1];
  };
  return [...seen.entries()].sort((a, b) => {
    const [da, na] = keyOf(a[0]);
    const [db, nb] = keyOf(b[0]);
    return da.localeCompare(db) || na - nb;
  });
}

function readPrevDigest(site = "US") {
  const files = historyDigestFiles(site);
  if (!files.length) return { ok: false, reason: "还没有历史投影，暂时没法对比" };
  const [name, file] = files[files.length - 1];
  try {
    return { ok: true, name, digest: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (e) {
    return { ok: false, reason: `上一份历史投影读不出来：${e.message}` };
  }
}

/**
 * 历史文件里存的是 **digest 投影**（topTerms / asinRanks），不是完整快照；
 * 而 `compareSnapshots` 的入参契约是「有 keywords 数组的快照」。
 * 这里把投影还原成最小可比快照 —— 只还原词面与计数，不凭空补 ASIN / 时间：
 * 对比只用得上 topTerms，把别的东西编出来反而会让结论看起来比证据更足。
 */
function asComparableSnapshot(d) {
  if (!d || !Array.isArray(d.topTerms)) return null;
  return {
    schema: d.schema, site: d.site, generatedAt: d.generatedAt,
    keywords: d.topTerms.map(([term, count]) => ({ term, rootCount: count })),
    asins: [], sources: {},
    summary: {
      keywordCount: d.keywordCount ?? d.topTerms.length,
      asinCount: d.asinCount ?? 0,
      newKeywordCount: d.newKeywordCount ?? 0,
      firstTimeCount: d.firstTimeCount ?? 0,
      returnedCount: d.returnedCount ?? 0,
      newKeywords: d.newKeywords || [],
      topCategories: d.topCategories || [],
    },
  };
}

function rootsView() {
  const { overlay, reason } = readOverlay();
  const resolved = resolveRoots({ overlay });
  const snap = readLatest();
  return {
    ok: true,
    schema: OVERLAY_SCHEMA,
    groups: resolved.groups,
    roots: resolved.roots,
    notes: [...(reason ? [reason] : []), ...(resolved.notes || [])],
    rejected: resolved.rejected,
    overlay: overlay || { schema: OVERLAY_SCHEMA, added: [], removed: [], renamed: [] },
    coverage: snap.ok
      ? (snap.snapshot.sources?.roots || { ok: false, reason: "本周快照还没有词根命中统计" })
      : { ok: false, reason: "还没有词库快照" },
    verifiedMarkets: verifiedMarketsList(),
  };
}

function handleKeywordRootsGet(req, res) {
  return json(res, 200, rootsView());
}

async function handleKeywordRootsPost(req, res) {
  // 与 /api/config、/api/external/* 同一套门禁：同源 + 强制 JSON + 体积上限。
  const violation = sameOriginViolation(req);
  if (violation) return json(res, 403, { ok: false, error: violation });
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > ROOTS_BODY_LIMIT) {
    return json(res, 413, { ok: false, error: `请求体过大（${declared} 字节，上限 ${ROOTS_BODY_LIMIT}）` });
  }
  let body;
  try {
    body = await readJSON(req, { requireJson: true });
  } catch (e) {
    return json(res, e.status || 400, { ok: false, error: e.message });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json(res, 400, { ok: false, error: "请求体必须是一个 JSON 对象" });
  }
  // 🔴 只认三个字段，其余（path / key / url …）一律忽略 —— 白名单式收参，
  //    不是为了"更严格"，是为了让这个接口**不可能**被用来写别的文件。
  const clean = {
    schema: OVERLAY_SCHEMA,
    updatedAt: new Date().toISOString(),
    added: [], removed: [], renamed: [],
  };
  for (const key of ["added", "removed", "renamed"]) {
    const v = body[key];
    if (v === undefined) continue;
    if (!Array.isArray(v)) return json(res, 400, { ok: false, error: `${key} 必须是数组` });
    if (v.length > ROOT_ITEM_LIMIT) {
      return json(res, 413, { ok: false, error: `${key} 最多 ${ROOT_ITEM_LIMIT} 项` });
    }
    clean[key] = v;
  }
  // 先算一遍冲突语义再落盘：非法项会被放进 rejected，但**仍然保存** ——
  // 运营需要看到「我加的那条为什么没生效」，静默丢掉等于下一次还会再试一遍。
  const check = resolveRoots({ overlay: clean });
  const text = JSON.stringify(clean, null, 2);
  if (Buffer.byteLength(text) > ROOTS_BODY_LIMIT) {
    return json(res, 413, { ok: false, error: "覆盖层内容过大" });
  }
  fs.mkdirSync(KW_DIR, { recursive: true });
  const tmp = `${ROOTS_FILE}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, ROOTS_FILE);   // 同目录 rename，原子替换
  return json(res, 200, {
    ...rootsView(),
    saved: true,
    notes: [...(check.notes || []), ...(rootsView().notes || [])],
    rejected: check.rejected,
  });
}

/** P2#10：词表 / ASIN 导出成 RFC 4180 CSV（带 UTF-8 BOM，Excel 直接打开不乱码）。 */
function handleExport(req, res, url) {
  const kind = String(url.searchParams.get("kind") || "").toLowerCase();
  if (kind !== "keywords" && kind !== "asins") {
    return json(res, 400, { ok: false, error: "kind 只能是 keywords 或 asins" });
  }
  const KW_COLS = [
    { key: "term", label: "词" }, { key: "rootCount", label: "带出词根数" },
    { key: "newly", label: "状态" }, { key: "firstSeen", label: "首次出现" },
    { key: "groups", label: "类目组" },
  ];
  const ASIN_COLS = [
    { key: "asin", label: "ASIN" }, { key: "rank", label: "榜单名次" },
    { key: "title", label: "标题" }, { key: "price", label: "价格" },
    { key: "rating", label: "评分" }, { key: "reviewCount", label: "评论数" },
    { key: "group", label: "类目" },
  ];
  const cols = kind === "keywords" ? KW_COLS : ASIN_COLS;
  const r = readLatest();
  let rows = [];
  if (r.ok) {
    const source = kind === "keywords" ? r.snapshot.keywords : r.snapshot.asins;
    rows = (Array.isArray(source) ? source : []).map((x) => ({
      ...x,
      groups: Array.isArray(x.groups) ? x.groups.join(" / ") : String(x.groups || ""),
    }));
  }
  // 🔴 guard: true —— 这一份是**要落成 .csv 文件、被 Excel/WPS 打开**的，
  //    词表里的词来自第三方页面（第三方可控文本），必须按公式注入处理。
  //    库里其它地方（含自测的往返相等）保持默认 false，见 assets/csv.js 的注释。
  const csv = toCsv(rows, cols, { guard: true });
  res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="listing-${kind}.csv"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    // 没有快照时只给表头（诚实的空表），但把原因放进响应头，调用方可以如实提示。
    ...(r.ok ? {} : { "x-listing-empty": encodeURIComponent(r.reason || "还没有词库快照") }),
  });
  res.end(Buffer.from(csv, "utf8"));
}

/* ─────────────── 历史快照（同 ASIN 多次采集） ───────────────
 * 为什么落盘而不是只存浏览器：价格/星级/评论数是**跨设备、跨周**才有意义的数据，
 * 存在 IndexedDB 里换台电脑就没了；而且这类文件很小（一行一个 JSON，几百字节）。
 *
 * 🔴 两条纪律：
 *   ① **只在值真变了时才追加**。同一份数据点两次「记一条」，第二次不写盘
 *      —— 否则趋势图上会出现一串完全相同的点，"没变化"被画成"有历史"。
 *   ② 读的时候**不修补**：缺字段就是 null，前端画图时断点不连线（见 assets/snapshots.js）。
 */

const SNAP_DIR = path.join(DATA, "snapshots");
fs.mkdirSync(SNAP_DIR, { recursive: true });

const ASIN_OK = /^[A-Z0-9]{10}$/;
const SNAP_MAX_ROWS = 500;

const snapFile = (asin) => path.join(SNAP_DIR, `${asin}.jsonl`);

/** 宽容地取一个数字：`"$19.99"` → 19.99；取不到 → null（不补 0）。 */
function snapNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function readSnapshots(asin) {
  const file = snapFile(asin);
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && typeof o === "object") rows.push(o);
    } catch { /* 坏行跳过：一行写坏不该让整段历史作废 */ }
  }
  return rows.slice(-SNAP_MAX_ROWS);
}

async function handleSnapshotPost(req, res) {
  let body;
  try { body = await readJSON(req, { requireJson: true }); } catch (e) { return json(res, e.status || 400, { ok: false, error: e.message }); }
  const asin = String(body.asin || "").trim().toUpperCase();
  if (!ASIN_OK.test(asin)) return json(res, 400, { ok: false, code: "bad-asin", error: "ASIN 必须是 10 位字母数字" });

  const row = {
    ts: (() => {
      const t = body.ts ? Date.parse(String(body.ts)) : Date.now();
      return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
    })(),
    asin,
    price: snapNum(body.price),
    rating: snapNum(body.rating),
    reviewCount: snapNum(body.reviewCount ?? body.reviews),
    bsr: snapNum(body.bsr ?? body.rank),
    source: String(body.source || "manual").slice(0, 24),
  };
  if ([row.price, row.rating, row.reviewCount, row.bsr].every((x) => x == null)) {
    return json(res, 400, {
      ok: false, code: "empty-row",
      error: "至少要有一个可比的数（price / rating / reviewCount / bsr），否则记了也没有信息量",
    });
  }

  const rows = readSnapshots(asin);
  const last = rows[rows.length - 1];
  const same = last && ["price", "rating", "reviewCount", "bsr"].every((k) => last[k] === row[k]);
  let appended = false;
  if (!same) {
    fs.appendFileSync(snapFile(asin), `${JSON.stringify(row)}\n`, "utf8");
    rows.push(row);
    appended = true;
  }
  return json(res, 200, {
    ok: true, appended, asin,
    reason: appended ? null : "和上一条完全相同，没有重复写入（避免趋势图上出现无意义的重复点）",
    count: rows.length,
    rows: rows.slice(-SNAP_MAX_ROWS),
  });
}

function handleSnapshotGet(req, res, url) {
  const asin = String(url.searchParams.get("asin") || "").trim().toUpperCase();
  if (!asin) {
    // 不带 asin：给一份清单（界面用来显示"已经记过哪些 ASIN"）。
    let files = [];
    try { files = fs.readdirSync(SNAP_DIR).filter((f) => f.endsWith(".jsonl")); } catch { files = []; }
    const items = files.map((f) => {
      const a = f.replace(/\.jsonl$/, "");
      const rows = readSnapshots(a);
      return { asin: a, count: rows.length, lastTs: rows.length ? rows[rows.length - 1].ts : null };
    }).sort((x, y) => String(y.lastTs || "").localeCompare(String(x.lastTs || "")));
    return json(res, 200, { ok: true, items });
  }
  if (!ASIN_OK.test(asin)) return json(res, 400, { ok: false, code: "bad-asin", error: "ASIN 必须是 10 位字母数字" });
  const rows = readSnapshots(asin);
  return json(res, 200, { ok: true, asin, count: rows.length, rows, note: rows.length < 2 ? "少于 2 条记录：还画不出趋势" : null });
}

/* ─────────────── 可选插件：本地抠图（rembg） ───────────────
 * 定位：**给别人留的插槽**，不是内置能力。
 *   · 本项目不打包模型（rembg 要 Python + onnxruntime，几百 MB，违背"开箱能跑"）；
 *   · 用户自己在本机起一个 rembg 服务（默认 `http://127.0.0.1:7000/api/remove`），
 *     在 `.env.local` 写 `REMBG_URL=...` 就能用；
 *   · 没配 → 接口明确回 `not-configured`，界面照实显示"未启用"，不假装有这个功能。
 *
 * 🔴 安全边界：目标地址**只允许回环/私网**。这个代理是"服务端替浏览器发请求"，
 *    如果不加限制，任何能打开本页的人都能借它去打任意地址（SSRF）。
 */

function rembgUrl() {
  return String(getEnv("REMBG_URL", "") || "").trim();
}

/** 只允许本机/私网目标：127.0.0.1 / localhost / ::1 / 10.x / 192.168.x / 172.16–31.x。 */
function isLocalTarget(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "127.0.0.1") return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  const m = /^172\.(\d{1,3})\./.exec(h);
  if (m) {
    const n = Number(m[1]);
    if (n >= 16 && n <= 31) return true;
  }
  return false;
}

function findLocalImage(name) {
  const base = safeImageName(name);
  if (!base) return null;
  for (const dir of [GEN, UPLOADS]) {
    const p = path.join(dir, base);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

async function handleRembg(req, res) {
  const target = rembgUrl();
  if (!target) {
    return json(res, 400, {
      ok: false, code: "not-configured",
      error: "未启用抠图：在 .env.local 里写 REMBG_URL=http://127.0.0.1:7000/api/remove，并先在本机起好 rembg 服务",
    });
  }
  if (!isLocalTarget(target)) {
    return json(res, 403, {
      ok: false, code: "bad-target",
      error: "REMBG_URL 只允许本机或私网地址（127.0.0.1 / localhost / 10.x / 192.168.x / 172.16-31.x）—— 这个代理不能当公网跳板",
    });
  }
  let body;
  try { body = await readJSON(req, { requireJson: true }); } catch (e) { return json(res, e.status || 400, { ok: false, error: e.message }); }
  const file = findLocalImage(body.name);
  if (!file) return json(res, 404, { ok: false, code: "not-found", error: "找不到这张图（只支持 data/gen 与 data/uploads 里的文件名）" });

  const base = path.basename(file);
  const mime = MIME[path.extname(base).toLowerCase()] || "application/octet-stream";
  const started = Date.now();
  try {
    const buf = fs.readFileSync(file);
    if (buf.length > 30 * 1024 * 1024) return json(res, 413, { ok: false, code: "too-large", error: "图片超过 30MB，抠图前先压一下" });
    const fd = new FormData();
    fd.append("file", new Blob([buf], { type: mime }), base);
    const r = await fetch(target, { method: "POST", body: fd, signal: AbortSignal.timeout(90000) });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return json(res, 502, { ok: false, code: "upstream", error: `抠图服务返回 ${r.status}${text ? `：${text.slice(0, 200)}` : ""}` });
    }
    const out = Buffer.from(await r.arrayBuffer());
    if (!out.length) return json(res, 502, { ok: false, code: "empty", error: "抠图服务返回了空内容" });
    if (out.length > 40 * 1024 * 1024) return json(res, 502, { ok: false, code: "too-large", error: "抠图结果超过 40MB，已丢弃" });
    const ctype = String(r.headers.get("content-type") || "image/png").split(";")[0];
    const ext = ctype === "image/jpeg" ? ".jpg" : ctype === "image/webp" ? ".webp" : ".png";
    const outName = `${base.replace(/\.[^.]+$/, "")}-rembg${ext}`;
    fs.writeFileSync(path.join(GEN, outName), out);
    return json(res, 200, {
      ok: true, file: outName, bytes: out.length, ms: Date.now() - started,
      note: "抠好的图已存进 data/gen（图片库里能直接看到）；原图未改动",
    });
  } catch (e) {
    const msg = e && e.name === "TimeoutError" ? "抠图超时（90s）：大图或服务卡住，换个图或先缩小" : (e && e.message) || String(e);
    return json(res, 502, { ok: false, code: "network", error: msg });
  }
}

/* ─────────────── 竞品数据源（Amazon Best Sellers 实时抓取） ─────────────── */

// 🔴 抓取开关：默认**开**（工作台要展示实时数据）。设 COMPETITOR_SCRAPE=0 可整体关掉；
//    关掉后接口返回 `enabled:false` 而不是报错 —— 界面照实显示"已关闭"，不假装有数据。
const COMPETITOR_ENABLED = process.env.COMPETITOR_SCRAPE !== "0";

function handleCompetitorCategories(req, res) {
  return json(res, 200, {
    ok: true,
    enabled: COMPETITOR_ENABLED,
    sites: Object.entries(SITES).map(([code, s]) => ({ code, host: s.host, label: s.label })),
    cats: CATS,
    cache: cacheStats(),
    sourceNote: "数据来自 Amazon Best Sellers 公开榜单页，实时抓取，带 10 分钟缓存。",
  });
}

async function handleCompetitorBestsellers(req, res, url) {
  if (!COMPETITOR_ENABLED) {
    return json(res, 200, { ok: false, enabled: false, error: "竞品抓取已在服务端关闭（COMPETITOR_SCRAPE=0）" });
  }
  const site = url.searchParams.get("site") || DEFAULT_SITE;
  const slug = url.searchParams.get("slug") || "";
  const href = url.searchParams.get("href") || "";
  if (!SITES[site]) return json(res, 400, { ok: false, error: `未知站点：${site}` });
  if (!CAT_SLUGS.includes(slug)) return json(res, 400, { ok: false, error: `未知类目：${slug}` });
  // 🔴 手动传 href 时必须自己过白名单 —— 否则这个参数就是一条任意 URL 抓取通道
  if (href && !isAllowedAmazonUrl(href)) {
    return json(res, 400, { ok: false, error: "href 不在允许抓取的地址白名单内" });
  }
  // 🆕 多页合并：一页约 50 条，只看第一页会漏掉 51 名之后的长尾竞品。
  //    上限 3 页（MAX_PAGES），非法值一律当 1 —— 不因为参数乱写就去打上游 300 页。
  const pagesRaw = Number(url.searchParams.get("pages") || 1);
  const pages = Number.isFinite(pagesRaw) ? Math.max(1, Math.min(MAX_PAGES, Math.floor(pagesRaw))) : 1;
  try {
    const r = await fetchBestsellers({ site, slug, href, pages });
    return json(res, 200, { ok: true, enabled: true, ...r });
  } catch (e) {
    // 用 502 而不是 500：错在**上游**（亚马逊改结构 / 超时 / 拒绝），不是本服务崩了
    return json(res, 502, { ok: false, enabled: true, error: e.message });
  }
}

async function handleCompetitorSubs(req, res, url) {
  if (!COMPETITOR_ENABLED) {
    return json(res, 200, { ok: false, enabled: false, error: "竞品抓取已在服务端关闭（COMPETITOR_SCRAPE=0）" });
  }
  const site = url.searchParams.get("site") || DEFAULT_SITE;
  const slug = url.searchParams.get("slug") || "";
  const href = url.searchParams.get("href") || "";
  if (!SITES[site]) return json(res, 400, { ok: false, error: `未知站点：${site}` });
  if (!CAT_SLUGS.includes(slug)) return json(res, 400, { ok: false, error: `未知类目：${slug}` });
  if (href && !isAllowedAmazonUrl(href)) {
    return json(res, 400, { ok: false, error: "href 不在允许抓取的地址白名单内" });
  }
  try {
    const r = await fetchSubs({ site, slug, href });
    return json(res, 200, { ok: true, enabled: true, ...r });
  } catch (e) {
    return json(res, 502, { ok: false, enabled: true, error: e.message });
  }
}

/* ─────────────────────── 启动 ─────────────────────── */

// 🔴 Host 头白名单：只认回环。挡的是 DNS rebinding —— 攻击者把自己的域名
//    解析到 127.0.0.1，受害者的浏览器就会把请求发到本机服务，但 Host 是那个域名。
//
// 两种形态，但**都校验 Host**（这一点是 2026-11-05 修的）：
//   · 绑回环（127.0.0.1，默认）：名单 = 回环 + 显式声明的 PUBLIC_HOSTS；
//   · 绑 0.0.0.0（server-public.mjs 的线上形态）：名单 = 回环 + PUBLIC_HOSTS + 平台后缀。
//     原来这一支在没配 PUBLIC_HOSTS 时把名单设成 null → 校验整体跳过（fail-open）。
//     看似"方便"，实际是"配漏一个环境变量就等于没有防护"。
//     现在最坏结果是访问被 403 —— 那至少会有人来问"为什么打不开"，
//     而不是悄无声息地对任何 Host 敞开。
const LOOPBACK_BINDS = new Set(["127.0.0.1", "localhost", "::1"]);
// 托管平台的 Host 后缀白名单。这些域名由平台签发，我们无法伪造，所以按**后缀**放行：
// 攻击者用自己的域名做 rebinding 时，Host 不会落在这些后缀下，防护仍然成立。
//   · .app.workbuddy.host        —— 对外分享链接的域名
//   · .sandbox.cloudstudio.club  —— 平台反向代理转发进容器时使用的内部 Host
//     （实测：不带这一条，线上每个请求都会被自己的 Host 校验挡成 403）
const PLATFORM_HOST_SUFFIXES = [".app.workbuddy.host", ".sandbox.cloudstudio.club"];
const isPlatformHost = (h) => PLATFORM_HOST_SUFFIXES.some((s) => h.endsWith(s));
const PUBLIC_HOSTS = String(process.env.PUBLIC_HOSTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const BOUND_PUBLIC = !LOOPBACK_BINDS.has(String(HOST).toLowerCase());
/**
 * Host 白名单。
 * 🔴 原来在"绑 0.0.0.0 且没配 PUBLIC_HOSTS"时返回 `null`，而调用处见到 null 就
 *    **整体跳过校验** —— 那是一个 fail-open：任何域名解析到本机都能打通服务。
 *    现在永远返回一个集合（至少含回环），最坏情况是"配漏了导致访问被 403"。
 *    fail-closed 会当场喊出来，fail-open 只会静默地谁都能进。
 */
const ALLOWED_HOSTS = allowedHosts([HOST, ...PUBLIC_HOSTS]);

const server = http.createServer(async (req, res) => {
  const reqHost = bareHost(req.headers.host);
  if (ALLOWED_HOSTS && !ALLOWED_HOSTS.has(reqHost) && !isPlatformHost(reqHost)) {
    return json(res, 403, { error: "Host 头不被允许：本服务只对本机（127.0.0.1 / localhost）开放", gotHost: reqHost });
  }
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const p = url.pathname;
  try {
    if (p === "/api/health") return await handleHealth(req, res);
    // 🔴 只读演示模式（线上分享默认开）：**所有会改磁盘 / 花额度的入口一起关**。
    //    原来只关了 /api/config，于是访客仍能往 data/gen 里塞文件、删图库、
    //    以及（一旦配了 key）用站长的额度生成图片。门要么全关，要么不算门。
    if (RO_PUBLIC && isWriteRoute(p, req.method)) {
      return json(res, 403, {
        error: `线上演示版为只读：${req.method} ${p} 会写入磁盘或消耗额度，已关闭。把项目 clone 到本地运行即可使用全部功能。`,
        readonly: true,
      });
    }
    if (p === "/api/config" && req.method === "POST") return await handleConfig(req, res);
    if (p === "/api/config/test" && req.method === "POST") return await handleConfigTest(req, res);
    if (p === "/api/upload" && req.method === "POST") return await handleUpload(req, res);
    if (p === "/api/blob") return handleBlob(req, res, url);
    if (p === "/api/library") return handleLibrary(req, res, url);
    if (p === "/api/image" && req.method === "POST") return await handleImage(req, res);
    if (p === "/api/vision" && req.method === "POST") return await handleVision(req, res);
    if (p === "/api/llm" && req.method === "POST") return await handleLLM(req, res);
    if (p === "/api/chat" && req.method === "POST") return await handleChat(req, res);
    if (p === "/api/keywords") return handleKeywords(req, res, url);
    if (p === "/api/keyword-roots" && req.method === "GET") return handleKeywordRootsGet(req, res);
    if (p === "/api/keyword-roots" && req.method === "POST") return await handleKeywordRootsPost(req, res);
    if (p === "/api/export") return handleExport(req, res, url);
    // 历史快照：POST 会写 data/snapshots（只读演示版已由 WRITE_ROUTES 关掉）
    if (p === "/api/snapshots" && req.method === "POST") return await handleSnapshotPost(req, res);
    if (p === "/api/snapshots" && req.method === "GET") return handleSnapshotGet(req, res, url);
    // 可选插件：本地抠图代理（只在配了 REMBG_URL 且目标是回环/私网时可用）
    if (p === "/api/plugins/rembg" && req.method === "POST") return await handleRembg(req, res);
    // 外部数据源：GET 只读清单/已导入结果；POST 会出网并花密钥额度，故都过了同源校验
    if (p === "/api/external/providers") return handleExternalProviders(req, res);
    if (p === "/api/external/terms") return handleExternalTerms(req, res, url);
    if (p === "/api/external/test" && req.method === "POST") return await handleExternalTest(req, res);
    if (p === "/api/external/call" && req.method === "POST") return await handleExternalCall(req, res);
    if (p === "/api/external/import" && req.method === "POST") return await handleExternalImport(req, res);
    if (p === "/api/competitor/categories") return handleCompetitorCategories(req, res);
    if (p === "/api/competitor/bestsellers") return await handleCompetitorBestsellers(req, res, url);
    if (p === "/api/competitor/subs") return await handleCompetitorSubs(req, res, url);
    if (p.startsWith("/api/")) return json(res, 404, { error: `未知接口 ${p}` });
    return serveStatic(req, res, url);
  } catch (e) {
    try { json(res, 500, { error: e.message }); } catch { /* already sent */ }
  }
});

server.listen(PORT, HOST, () => {
  const c = imgCfg();
  console.log(`\n  跨境 Listing 质检工作台`);
  console.log(`  ────────────────────────────────────────────`);
  console.log(`  打开：http://${HOST}:${PORT}/`);
  console.log(`  模板：${Object.keys(TEMPLATES).length} 个（本地引擎，无需 API）`);
  console.log(`  图片 API：${c.baseUrl && c.apiKey ? `已配置 → ${c.baseUrl} (${detectMode(c.baseUrl, c.mode)})` : "未配置（仍可用 Prompt 模式与 Listing 质检）"}`);
  console.log(`  竞品数据源：${COMPETITOR_ENABLED ? `开启（实时抓 Amazon Best Sellers，${CAT_SLUGS.length} 个类目 / ${Object.keys(SITES).length} 个站点）` : "已关闭（COMPETITOR_SCRAPE=0）"}`);
  const extOn = Object.entries(EXTERNAL_MCP)
    .filter(([, p]) => String(getEnv(p.keyEnv, "") || "").trim())
    .map(([, p]) => p.label);
  console.log(`  外部数据源：${extOn.length ? `${extOn.join(" / ")}（已配密钥）` : "未配置（设置页「外部数据源」填自己的密钥后可用）"}`);
  console.log(`  Node：${process.version}${NODE_OK ? "" : "（⚠️ < 20.15，图片库「打包下载」不可用，其余功能正常）"}`);
  // Host 白名单打出来 —— 403 的时候用户能自己看出"是我没把域名加进去"，不用猜。
  console.log(`  Host 白名单：${[...ALLOWED_HOSTS].join(" / ")}${PUBLIC_HOSTS.length ? "" : "（可用 PUBLIC_HOSTS 追加）"}`);
  console.log(`  密钥从 .env.local / .env / 环境变量读取（同名键 .env.local 优先），监听 ${HOST}${BOUND_PUBLIC ? "（对外绑定，请确认 PUBLIC_HOSTS）" : "，不对外暴露"}\n`);
  if (!NODE_OK) {
    console.log(`  ⚠️ 当前 Node ${process.version} 低于 20.15：图片库「打包下载」会在点击时返回 501。`);
    console.log(`     其余功能（Prompt / 质检 / 关键词 / 模板）不受影响；升级 Node 或改用逐张下载即可。\n`);
  }
});
