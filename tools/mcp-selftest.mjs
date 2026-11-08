#!/usr/bin/env node
/**
 * MCP server 协议自检：真起一个 `node mcp/server.mjs` 进程，真往 stdin 灌 JSON-RPC。
 *
 * 为什么不能只做"能连上"：
 *   MCP（stdio）的失败模式几乎都是**静默**的 —— 客户端不会报"你的 server 逻辑错了"，
 *   它只会显示"0 个工具"或者干脆卡住。所以这套断言盯的是三件最容易悄悄坏掉的事：
 *     ① **stdout 纯度**：一个 console.log 就能让整条协议流解析失败，而且排查时看不到任何报错；
 *     ② **工具契约**：tools/list 里的 name / inputSchema 与实际 run() 的参数对不上，
 *        客户端会按 schema 构造参数，然后每次都失败 —— 但错在 schema，不在参数；
 *     ③ **"未判定 ≠ 通过"**：这条口径散落在各工具的输出里，一旦有人把它简化成
 *        "没命中就是通过"，报告会变好看，结论会变错。
 *
 * 🔴 本脚本**只读**：进程起来后不写任何文件。结尾会硬断言 `data/` 目录一个字节都没动，
 *    因为 MCP 的定位是"判断层"，一旦它开始落盘，"零副作用"这个卖点就没了。
 *
 * 用法：
 *   node tools/mcp-selftest.mjs           # 全离线可跑（联网工具只验契约，不要求取到数据）
 *   node tools/mcp-selftest.mjs --net     # 额外真打一次搜索建议接口
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { checkAssertCount } from "./assert-count.mjs";
import { RULES } from "../assets/listing.js";
import { buildSnapshot } from "../assets/keyword-vault.js";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER = path.join(HERE, "mcp", "server.mjs");
const DATA_DIR = path.join(HERE, "data");
const WANT_NET = process.argv.includes("--net");

let pass = 0;
let fail = 0;
function ck(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
}

/** 目录快照：用来证明"跑了一整套 MCP 调用，用户数据一个字节都没变"。
 *
 * ⚠️ **排除 `data/keywords`**：那个目录由每周采集器（`tools/collect-keywords.mjs`）写，
 *    MCP 只是读它。把它算进来，本地一边跑采集器一边跑本脚本时就会随机报红 ——
 *    而红的原因跟 MCP 有没有写盘毫无关系。判断"MCP 只读"的判据是源码里没有写入口
 *    （第 12 节），不是这个快照。
 */
function snapDir(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (p === path.join(dir, "keywords")) continue;
      if (e.isDirectory()) walk(p);
      else {
        const st = fs.statSync(p);
        out.push(`${path.relative(dir, p)}|${st.size}|${st.mtimeMs}`);
      }
    }
  };
  walk(dir);
  return out.join("\n");
}

/* ── 一个够用的 stdio JSON-RPC 客户端 ───────────────────────── */

class Client {
  constructor(args = [], { cwd = HERE, env = process.env, script = SERVER } = {}) {
    this.proc = spawn(process.execPath, [script, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.buf = "";
    this.lines = [];       // stdout 的每一行（原样）
    this.bad = [];         // 解析不了的行 —— 出现任何一条都是致命错误
    this.msgs = [];
    this.stderr = "";
    this.seq = 0;
    this.waiters = new Map();
    this.exited = null;

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        this.lines.push(line);
        let m;
        try { m = JSON.parse(line); } catch { this.bad.push(line); continue; }
        this.msgs.push(m);
        const w = this.waiters.get(m.id);
        if (w) { this.waiters.delete(m.id); w(m); }
      }
    });
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (c) => { this.stderr += c; });
    this.proc.on("exit", (code) => {
      this.exited = code;
      for (const w of this.waiters.values()) w({ __exited: code });
      this.waiters.clear();
    });
  }

  notify(method, params) {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })}\n`);
  }

  raw(line) { this.proc.stdin.write(`${line}\n`); }

  request(method, params, timeoutMs = 10000) {
    const id = ++this.seq;
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`${method} 超时（${timeoutMs}ms 无响应）`));
      }, timeoutMs);
      this.waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
    });
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`);
    return p;
  }

  call(name, args) { return this.request("tools/call", { name, arguments: args }); }

  close() {
    try { this.proc.stdin.end(); } catch { /* ignore */ }
    try { this.proc.kill(); } catch { /* ignore */ }
  }
}

/** tools/call 的结果里，第一个 text content 是 JSON 字符串（也可能是纯错误文本）。 */
function payload(m) {
  const text = m?.result?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  try { return JSON.parse(text); } catch { return text; }
}
const errText = (m) => String(m?.result?.content?.[0]?.text || "");

/* ───────────────────────────────────────────────────────────── */

const before = snapDir(DATA_DIR);

const c = new Client();
await sleep(400); // 等进程把 ready 打到 stderr

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* 0. 握手 ─────────────────────────────────────────────────── */

console.log("0. 握手：initialize");
const init = await c.request("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "mcp-selftest", version: "1.0.0" },
});
ck("能起来并回包（不是卡死）", Boolean(init?.result), JSON.stringify(init).slice(0, 200));
ck("protocolVersion 回显为 2024-11-05", init?.result?.protocolVersion === "2024-11-05", String(init?.result?.protocolVersion));
ck("serverInfo.name 稳定（客户端会拿它做展示与去重）", init?.result?.serverInfo?.name === "listing-studio", String(init?.result?.serverInfo?.name));
ck("声明了 tools 能力", Boolean(init?.result?.capabilities?.tools), JSON.stringify(init?.result?.capabilities));
ck("instructions 里保留了「跳过 ≠ 通过」的口径（删掉它，模型就会把未判定当通过）",
  /跳过|未判定/.test(String(init?.result?.instructions || "")), String(init?.result?.instructions || "").slice(0, 80));
ck("stderr 打了 ready 日志（而不是 stdout）", /\[mcp\] ready/.test(c.stderr), c.stderr.trim().slice(0, 120));

// 客户端发完 initialize 必发这条通知；服务端不许回包，否则 id 会错位
c.notify("notifications/initialized");

const init2025 = await c.request("initialize", {
  protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-selftest", version: "1" },
});
ck("客户端要 2025-06-18 就还 2025-06-18（不硬返回旧版本）",
  init2025?.result?.protocolVersion === "2025-06-18", String(init2025?.result?.protocolVersion));

const initOld = await c.request("initialize", {
  protocolVersion: "2023-01-01", capabilities: {}, clientInfo: { name: "x", version: "1" },
});
ck("客户端要一个不认识的版本 → 回落到 2024-11-05（不是报错，也不是原样返回）",
  initOld?.result?.protocolVersion === "2024-11-05", String(initOld?.result?.protocolVersion));

// P1-1：版本协商要**双向**。上面测的是"太旧"，这里测"太新"——
// 照抄客户端版本会声称支持一个我们没实现的协议；报错则新版客户端直接连不上。
const initFuture = await c.request("initialize", {
  protocolVersion: "2027-01-01", capabilities: {}, clientInfo: { name: "x", version: "1" },
});
ck("客户端要 2027-01-01（比我们都新）→ 协商到我们支持的最高版 2025-11-25",
  initFuture?.result?.protocolVersion === "2025-11-25", String(initFuture?.result?.protocolVersion));

// 中间档才是真正考验"比较函数会不会算日期"的那一条：
// 2025-08-01 比 2025-06-18 新、比 2025-11-25 旧 —— 应该给 2025-06-18。
// 如果 cmpVersion 把版本号解析成 NaN→0（`split(".")` + `|| 0` 的老写法），这里会错答 2025-11-25。
const initMid = await c.request("initialize", {
  protocolVersion: "2025-08-01", capabilities: {}, clientInfo: { name: "x", version: "1" },
});
ck("客户端要 2025-08-01（夹在中间）→ 给不超过它的最高版 2025-06-18，而不是最新的",
  initMid?.result?.protocolVersion === "2025-06-18", String(initMid?.result?.protocolVersion));

/* 0b. server/discover：无状态路径 ─────────────────────────────
 * 2026-07-28 起 initialize 不再是必需步骤。这条路径必须**单独**测：
 * 已经握过手的连接走不到它，而新版客户端恰恰不发 initialize。 */
console.log("\n0b. server/discover（不握手也能用）");
const stateless = new Client();
await sleep(300);
const disc = await stateless.request("server/discover");
ck("不 initialize 也能 server/discover", Boolean(disc?.result), JSON.stringify(disc).slice(0, 200));
ck("discover 七个字段齐全（supportedVersions/capabilities/instructions/_meta/ttlMs/cacheScope/resultType）",
  ["supportedVersions", "capabilities", "instructions", "_meta", "ttlMs", "cacheScope", "resultType"]
    .every((k) => disc?.result?.[k] !== undefined),
  Object.keys(disc?.result || {}).join(","));
ck("discover 里的 serverInfo.name 与 initialize 一致（两处说法不能漂移）",
  disc?.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name === init?.result?.serverInfo?.name,
  JSON.stringify(disc?.result?._meta || {}));
const statelessTl = await stateless.request("tools/list");
ck("不 initialize 直接 tools/list 也能拿到完整工具表（无状态调用路径）",
  (statelessTl?.result?.tools || []).length === 8,
  `拿到 ${(statelessTl?.result?.tools || []).length} 个`);
stateless.close();

/* 1. stdout 纯度 ──────────────────────────────────────────── */

console.log("\n1. stdout 纯净度（协议通道）");
ck("到目前为止 stdout 没有一行解析失败", c.bad.length === 0, c.bad.map((s) => s.slice(0, 80)).join(" ｜ "));
ck("每条 stdout 消息都带 jsonrpc:\"2.0\"", c.msgs.every((m) => m.jsonrpc === "2.0"),
  JSON.stringify(c.msgs.filter((m) => m.jsonrpc !== "2.0").slice(0, 2)));
ck("每条消息要么有 result 要么有 error（没有半截消息）",
  c.msgs.every((m) => m.result !== undefined || m.error !== undefined));
ck("通知（无 id）没有产生回包 —— 回包会把后续请求的 id 全部错位",
  c.msgs.every((m) => m.id !== undefined && m.id !== null));

/* 2. tools/list ───────────────────────────────────────────── */

console.log("\n2. tools/list：契约");
const tl = await c.request("tools/list");
const tools = tl?.result?.tools || [];
const names = tools.map((t) => t.name);
const EXPECT = [
  "lint_listing", "precheck_upload", "analyze_coverage", "mine_keywords",
  "build_image_prompt", "diff_snapshots", "amazon_suggest",
  "keyword_snapshot",   // 读每周词库快照：本地文件，不联网，--no-net 下也保留
];
ck("工具数 = 8（联网开着时）", tools.length === 8, `实际 ${tools.length}：${names.join(", ")}`);
ck("工具名集合与预期完全一致（多一个少一个都要显式改这条）",
  JSON.stringify([...names].sort()) === JSON.stringify([...EXPECT].sort()), names.join(", "));
ck("工具名无重复（重名时客户端只认第一个，另一个永远调不到）", new Set(names).size === names.length);
ck("tools/list 里不泄漏 run 函数（把实现塞进协议体，任何客户端都能看到源码字符串）",
  !JSON.stringify(tl).includes("\"run\""));

for (const t of tools) {
  const okSchema = t.inputSchema?.type === "object" && t.inputSchema?.properties && typeof t.inputSchema.properties === "object";
  ck(`${t.name}：inputSchema 是 object 且带 properties`, Boolean(okSchema), JSON.stringify(t.inputSchema).slice(0, 120));
  ck(`${t.name}：description ≥ 30 字（模型靠它决定要不要调用）`, String(t.description || "").length >= 30, `${String(t.description || "").length} 字`);
  ck(`${t.name}：required 里的键都在 properties 里（否则客户端永远构造不出合法参数）`,
    (t.inputSchema?.required || []).every((k) => k in (t.inputSchema?.properties || {})),
    JSON.stringify(t.inputSchema?.required || []));
}

/* 2b. stdout 闸门 ─────────────────────────────────────────── */

// 红线 8 原来是十条里唯一"纯自觉 + 失败静默"的：任何模块一句 console.log，
// 客户端就显示「0 个工具」而且不报错。这一节证明闸门真的动过 —— 不是"恰好没噪声"。
console.log("\n2b. stdout 闸门：混入 console.log 也不能变 0 个工具");
const GUARD_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-guard-"));
const guardWrapper = path.join(GUARD_TMP, "noisy.mjs");
fs.writeFileSync(
  guardWrapper,
  `import ${JSON.stringify(pathToFileURL(SERVER).href)};\n`
  + `console.log("rogue console.log");\n`
  + `console.log(JSON.stringify({ hello: "not-jsonrpc" }));\n`,
  "utf8",
);
const cg = new Client([], { script: guardWrapper });
const tlGuard = await cg.request("tools/list");
ck("有 console.log 混入时仍拿到完整工具表（闸门只放行合法 JSON-RPC）",
  (tlGuard?.result?.tools || []).length === tools.length,
  `${(tlGuard?.result?.tools || []).length}/${tools.length}`);
ck("混入的行被转 stderr 并留痕（不是静默丢弃）", /stdout blocked:/.test(cg.stderr), cg.stderr.slice(0, 200));
ck("留痕里带原文（能据此定位是谁在 print）", /rogue console\.log/.test(cg.stderr));
ck("非法 JSON-RPC（有 jsonrpc 字段但没 method/result/error）也会被拦",
  /not-jsonrpc/.test(cg.stderr));
ck("协议通道仍然干净：客户端一行都没解析失败", cg.bad.length === 0, cg.bad.join(" | "));
cg.close();
fs.rmSync(GUARD_TMP, { recursive: true, force: true });

/* 2c. 工具描述：四段式 + 互相点名（S-1）──────────────────────
 * 模型选工具只看 name + description。八条描述像八个各自为政的广告，
 * 模型就只能靠猜 —— 猜错的代价是"问合规却拿到覆盖率"这种答非所问。
 * 所以描述必须：① 四段固定顺序；② 在「别用我当」里**点名**该换哪个工具。
 * 这条约束无法靠人工 review 守住（改一句描述就破），只能断言。 */
console.log("\n2c. 工具描述：四段式 + 互相点名");
const DESC_MAX = 750;      // 单个硬上限：再长客户端会折叠，模型也读不完
const DESC_TOTAL_MAX = 6000; // 八条合计的软目标
const SEGS = ["用我当", "别用我当", "你会拿到", "口径"];
const descOf = (n) => String(tools.find((t) => t.name === n)?.description || "");
const bytes = (s) => Buffer.byteLength(s, "utf8");

const missingSegs = tools.filter((t) => !SEGS.every((s) => String(t.description || "").includes(s)));
ck("8 条描述都含四段（用我当 / 别用我当 / 你会拿到 / 口径）",
  missingSegs.length === 0, missingSegs.map((t) => t.name).join(", ") || "全齐");
const badOrder = tools.filter((t) => {
  const d = String(t.description || "");
  const pos = SEGS.map((s) => d.indexOf(s));
  return pos.some((p) => p < 0) || pos.some((p, i) => i > 0 && p <= pos[i - 1]);
});
ck("四段顺序固定（顺序变了，「先看能干什么、再看别用」的因果就断了）",
  badOrder.length === 0, badOrder.map((t) => t.name).join(", ") || "全对");
const tooLong = tools.filter((t) => bytes(t.description || "") > DESC_MAX);
ck(`每条描述 ≤ ${DESC_MAX} 字节（超了客户端会折叠，模型读到的是截断版）`,
  tooLong.length === 0, tooLong.map((t) => `${t.name}=${bytes(t.description)}`).join(", ") || "全部达标");
const totalDesc = tools.reduce((n, t) => n + bytes(t.description || ""), 0);
ck(`八条描述合计 ≤ ${DESC_TOTAL_MAX} 字节（tools/list 每次都整包发，膨胀会拖慢每一轮）`,
  totalDesc <= DESC_TOTAL_MAX, `${totalDesc} 字节`);

// 「别用我当」必须点名**别的工具**，否则那段话等于"别用我，去别处"——没有下一步。
const notMe = (d) => {
  const i = d.indexOf("别用我当");
  const j = d.indexOf("你会拿到");
  return i >= 0 && j > i ? d.slice(i, j) : "";
};
const noSibling = tools.filter((t) => {
  const seg = notMe(String(t.description || ""));
  return !names.some((n) => n !== t.name && seg.includes(n));
});
ck("每条「别用我当」都点名了至少一个兄弟工具（给出替代，而不是只说「别用」）",
  noSibling.length === 0, noSibling.map((t) => t.name).join(", ") || "全部点名");

// 「你会拿到」必须落到具体字段名，不能写成"会返回结果"——那等于没说。
const noField = tools.filter((t) => {
  const d = String(t.description || "");
  const seg = d.slice(d.indexOf("你会拿到"), d.indexOf("口径"));
  return !/[a-zA-Z]{3,}/.test(seg.replace(/^你会拿到：/, ""));
});
ck("每条「你会拿到」都点了具体字段名（不是「返回结果」这种空话）",
  noField.length === 0, noField.map((t) => t.name).join(", ") || "全部具体");

// 12 条选择回归：这些是真实会被问混的搭配。谁改描述把指路删了，这里立刻红。
// 格式 [困惑场景, 该被点名的工具]：前者描述的「别用我当」里必须出现后者。
const ROUTE = [
  ["lint_listing", "precheck_upload"],        // 哪里不合规 vs 现在能不能传
  ["precheck_upload", "lint_listing"],        // 差什么 vs 具体怎么改
  ["lint_listing", "analyze_coverage"],       // 文案合规 vs 关键词覆盖
  ["analyze_coverage", "lint_listing"],       // 覆盖 vs 合规
  ["analyze_coverage", "mine_keywords"],      // 我给的词覆盖了吗 vs 竞品在打什么
  ["analyze_coverage", "keyword_snapshot"],   // 覆盖 vs 本周有哪些词
  ["mine_keywords", "analyze_coverage"],      // 词频 vs 覆盖
  ["mine_keywords", "amazon_suggest"],        // 从竞品文案挖 vs 从真实搜索取
  ["mine_keywords", "keyword_snapshot"],
  ["diff_snapshots", "keyword_snapshot"],     // 竞品改版对比 vs 两份词库周报
  ["keyword_snapshot", "amazon_suggest"],     // 周快照 vs 实时单词根
  ["amazon_suggest", "keyword_snapshot"],     // 实时 vs 批量
];
const routeFail = ROUTE.filter(([from, to]) => !notMe(descOf(from)).includes(to));
ck("12 条易混场景都留了指路（谁该换谁，写在「别用我当」里）",
  routeFail.length === 0, routeFail.map(([a, b]) => `${a}→${b}`).join(", ") || "12/12");



/* 3. lint_listing ─────────────────────────────────────────── */

console.log("\n3. lint_listing：28 条规则的四态计数");
const GOOD = {
  title: "Ceramic Mug 350ml Insulated Coffee Cup with Handle",
  highlights: "ceramic, 350ml, dishwasher safe",
  bullets: [
    "KEEPS DRINKS HOT: double-wall ceramic body holds heat for about 2 hours.",
    "EASY TO CLEAN: smooth glaze interior, dishwasher safe.",
    "COMFORTABLE GRIP: wide handle fits most hands.",
    "NO ODOUR RETENTION: glazed interior does not keep coffee smell.",
    "GIFT READY: comes in a plain kraft box.",
  ],
  searchTerms: "ceramic mug coffee cup insulated 350ml",
  brand: "Acme",
  primaryKeyword: "ceramic mug",
};
const lint = await c.call("lint_listing", GOOD);
const L = payload(lint);
ck("lint_listing：isError = false", lint?.result?.isError === false, errText(lint).slice(0, 120));
ck("lint_listing：返回体是 JSON（不是一段人类可读的话术）", L && typeof L === "object", typeof L);
ck("counts.total 等于 RULES.length（单一事实源：加了规则不用改这里）",
  L?.counts?.total === RULES.length, `${L?.counts?.total} vs ${RULES.length}`);
ck("checked = total − skipped − errored（这条恒等式是四态口径的地基）",
  L?.counts?.checked === L?.counts?.total - L?.counts?.skipped - L?.counts?.errored,
  JSON.stringify(L?.counts));
ck("hit = hitP + hitC", L?.counts?.hit === L?.counts?.hitP + L?.counts?.hitC, JSON.stringify(L?.counts));
ck("一条干净的文案不会报出硬规则命中", L?.counts?.hitP === 0, `hitP=${L?.counts?.hitP}`);
ck("命中项带 level / scope / detail / source（缺 source 就不算证据）",
  (L?.hits || []).every((h) => h.level && h.scope && h.detail && h.source), JSON.stringify((L?.hits || [])[0] || {}));
ck("note 里写明了 checked 的算法（否则调用方会自己乱猜）", /checked\s*=\s*total/.test(String(L?.note || "")), String(L?.note || ""));

const EMPTY = await c.call("lint_listing", {});
const E = payload(EMPTY);
ck("空输入：checked = 0", E?.counts?.checked === 0, JSON.stringify(E?.counts));
ck("空输入：结论里必须出现「未判定」", /未判定/.test(String(E?.conclusion || "")), String(E?.conclusion || ""));
ck("空输入：结论里必须出现「不等于通过」（这是最容易被人简化掉的一句）",
  /不等于通过/.test(String(E?.conclusion || "")), String(E?.conclusion || ""));

const BAD = await c.call("lint_listing", {
  title: "BEST SELLER Ceramic Mug #1 Top Rated Free Shipping",
  brand: "Acme",
  primaryKeyword: "ceramic mug",
});
const B = payload(BAD);
ck("标题塞促销词 / 徽章词 → 命中硬规则（P2）", (B?.counts?.hitP || 0) > 0, JSON.stringify(B?.counts));
ck("命中明细里能定位到具体规则 id", (B?.hits || []).some((h) => h.id === "P2"), (B?.hits || []).map((h) => h.id).join(","));
ck("结论措辞是「必须修改」而不是「建议优化」（硬规则与软规则不能混为一谈）",
  /必须修改/.test(String(B?.conclusion || "")), String(B?.conclusion || ""));

const LONG = await c.call("lint_listing", { title: "A".repeat(30) + " " + "ceramic mug ".repeat(6) });
const LG = payload(LONG);
ck("标题超长 → 命中 P1（75 字符口径）", (LG?.hits || []).some((h) => h.id === "P1"), (LG?.hits || []).map((h) => h.id).join(","));
const media = await c.call("lint_listing", { title: "x".repeat(120), isMedia: true, brand: "Acme" });
ck("isMedia=true 时 120 字符标题不再命中 P1（media 走 200 口径）",
  !(payload(media)?.hits || []).some((h) => h.id === "P1"));

/* 4. precheck_upload ──────────────────────────────────────── */

console.log("\n4. precheck_upload：三层结论");
const pre = await c.call("precheck_upload", {});
const P = payload(pre);
ck("空输入 → ok = false（不能因为「没东西可查」就返回通过）", P?.ok === false, JSON.stringify(P).slice(0, 120));
ck("空输入 → blockers 里至少点名品牌与标题", (P?.blockers || []).some((b) => b.field === "brand")
  && (P?.blockers || []).some((b) => b.field === "item_name"), (P?.blockers || []).map((b) => b.field).join(","));
ck("external 那层始终非空（「通过」必须有边界，否则等于假承诺）", (P?.externals || []).length >= 3, `${(P?.externals || []).length} 条`);
ck("external 里明确写了 UPC / 类目节点 / 主图这几件本工具不管的事",
  (P?.externals || []).join(" ").includes("UPC") && (P?.externals || []).join(" ").includes("类目节点"),
  (P?.externals || []).join(" ｜ ").slice(0, 160));
const preOk = await c.call("precheck_upload", GOOD);
ck("填齐的文案 → ok = true", payload(preOk)?.ok === true, JSON.stringify(payload(preOk)?.blockers || []));

/* 5. analyze_coverage ─────────────────────────────────────── */

console.log("\n5. analyze_coverage：真缺口与噪声必须分开");
const cov = await c.call("analyze_coverage", {
  ...GOOD,
  keywords: ["ceramic mug", "insulated tumbler", "travel mug"],
  // 竞品文案是 gaps 成立的前提：没有"谁在打这个词"的信号，就没法说"我漏了"。
  // 所以这一组必须给竞品 —— 不给竞品时 gaps 为空**是设计**，不是 bug。
  competitors: [{ name: "竞品A", text: "Insulated tumbler with leak proof lid. Travel mug keeps drinks cold." }],
});
const C = payload(cov);
ck("coveragePct 落在 0–100", typeof C?.coveragePct === "number" && C.coveragePct >= 0 && C.coveragePct <= 100, String(C?.coveragePct));
ck("gaps 只含用户自己给的词（从竞品挖出来的噪声不许混进来）",
  Array.isArray(C?.gaps) && C.gaps.every((g) => ["ceramic mug", "insulated tumbler", "travel mug"].includes(g)),
  JSON.stringify(C?.gaps));
ck("竞品在打、我完全没有的候选词 → 出现在真缺口 gaps 里", (C?.gaps || []).length > 0, JSON.stringify(C?.gaps));
ck("note 原样透传了底层那句「不是搜索量 / 不是排名」（换成顺口话就等于删掉免责声明）",
  /不是搜索量|不是搜索排名/.test(String(C?.note || "")), String(C?.note || "").slice(0, 80));
ck("coveragePct 的算法另用 metricNote 说明，不占用 note 的位置", /字段权重/.test(String(C?.metricNote || "")));

const cov2 = await c.call("analyze_coverage", {
  ...GOOD,
  keywords: ["ceramic mug"],
  competitors: [{ name: "竞品A", text: "Insulated travel tumbler with leak proof lid. Keeps drinks cold for 24 hours." }],
});
const C2 = payload(cov2);
ck("给了竞品语料 → minedGaps 出现且与 gaps 分开列",
  Array.isArray(C2?.minedGaps) && C2.minedGaps.length > 0 && Array.isArray(C2?.gaps), `mined=${JSON.stringify(C2?.minedGaps)}`);
ck("minedGaps 里的词不会同时出现在 gaps 里（同一句词不该被报两次）",
  !(C2?.minedGaps || []).some((x) => (C2?.gaps || []).includes(x)));
ck("competitorProvided 标记为 true", C2?.competitorProvided === true);

/* 6. mine_keywords ────────────────────────────────────────── */

console.log("\n6. mine_keywords：词频");
const mine = await c.call("mine_keywords", { text: "ceramic mug ceramic mug insulated mug with lid", top: 5 });
const M = payload(mine);
ck("返回 terms 数组", Array.isArray(M?.terms), typeof M?.terms);
// 排序键是 weight（长短词的加权分），不是裸频次 —— 断言按真实契约写，不按我以为的写
ck("按 weight 降序（等权时出现次数多的在前）",
  (M?.terms || []).length >= 2 && M.terms.every((t, i) => i === 0 || M.terms[i - 1].weight >= t.weight),
  JSON.stringify((M?.terms || []).slice(0, 3)));
ck("top 生效（≤ 请求的条数）", (M?.terms || []).length <= 5, String((M?.terms || []).length));
const mineDe = await c.call("mine_keywords", { text: "Kaffeetasse Keramik mit Henkel und Deckel", lang: "de", top: 5 });
ck("换语种不报错（七套停用词里没有的语言会退回英文表，而不是崩）", Array.isArray(payload(mineDe)?.terms));

/* 7. build_image_prompt ───────────────────────────────────── */

console.log("\n7. build_image_prompt：画幅与首图铁律");
const ip = await c.call("build_image_prompt", { subject: "ceramic mug", slot: "main" });
const IP = payload(ip);
ck("返回 prompt 字符串", typeof IP?.prompt === "string" && IP.prompt.length > 100, String(IP?.prompt || "").slice(0, 80));
ck("首图（slot=main）强制 1:1", /aspect ratio 1:1/.test(String(IP?.prompt || "")), String(IP?.prompt || "").slice(-200));
ck("首图明确禁止图内文字（平台法规压过设计惯例）", /In-image text: NONE/i.test(String(IP?.prompt || "")));
ck("meta.pixels 给出具体像素口径", Boolean(IP?.meta?.pixels), JSON.stringify(IP?.meta || {}));
const ip2 = await c.call("build_image_prompt", { subject: "ceramic mug", slot: "secondary", ratio: "16:9", headline: "Holds heat", evidence: ["double wall"] });
const IP2 = payload(ip2);
ck("非首图时画幅按传入比例走", /aspect ratio 16:9/.test(String(IP2?.prompt || "")), String(IP2?.prompt || "").slice(-160));
ck("图内文字走三层结构（headline 进 prompt）", String(IP2?.prompt || "").includes("Holds heat"));
ck("meta.ratio 回显为 16:9", IP2?.meta?.ratio === "16:9", JSON.stringify(IP2?.meta || {}));

/* 8. diff_snapshots ───────────────────────────────────────── */

console.log("\n8. diff_snapshots：规格（对象）也要比得出来");
const d1 = await c.call("diff_snapshots", {
  before: { asin: "B000000001", title: "Mug", specs: { material: "ceramic", capacity: "350ml" } },
  after: { asin: "B000000001", title: "Mug", specs: { material: "porcelain", capacity: "350ml" } },
});
const D1 = payload(d1);
ck("同一 ASIN → sameAsin = true", D1?.sameAsin === true, JSON.stringify(D1).slice(0, 120));
ck("规格里改了一个键 → 被检出（对象 String(v) 会得到 [object Object]，这个坑修过）",
  (D1?.rows || []).some((r) => r.key === "specs"), JSON.stringify(D1?.rows || []));
ck("规格差异能说清是哪个键变了", JSON.stringify(D1?.rows || []).includes("porcelain"));
const d2 = await c.call("diff_snapshots", { before: { asin: "B000000001" }, after: { asin: "B000000002" } });
ck("ASIN 不同 → note 明说「不是同一件商品」", /不是同一件商品/.test(String(payload(d2)?.note || "")), String(payload(d2)?.note || ""));
const d3 = await c.call("diff_snapshots", { before: {}, after: {} });
ck("两份都没 ASIN → note 说「无法确认」，不假装是同款", /无法确认/.test(String(payload(d3)?.note || "")), String(payload(d3)?.note || ""));

/* 9. 错误路径（客户端最容易踩到的四类）──────────────────── */

console.log("\n9. 错误路径：报错要能自己解释");
const unknown = await c.call("no_such_tool", {});
ck("未知工具 → isError = true", unknown?.result?.isError === true);
ck("未知工具 → 报错里列出可用工具（调用方不用去翻文档）",
  /可用：/.test(errText(unknown)) && errText(unknown).includes("lint_listing"), errText(unknown).slice(0, 120));

const missing = await c.call("mine_keywords", {});
ck("缺必填参数 → isError = true", missing?.result?.isError === true);
ck("缺必填参数 → 报错点名是哪个参数", /缺少必填参数：text/.test(errText(missing)), errText(missing).slice(0, 120));

const wrongType = await c.call("lint_listing", { bullets: "只要一条" });
ck("类型不对（bullets 传 string）→ isError = true 而不是静默按字符串处理",
  wrongType?.result?.isError === true, errText(wrongType).slice(0, 120));
ck("类型报错说清了期望类型", /应为 array/.test(errText(wrongType)), errText(wrongType).slice(0, 120));

const nf = await c.request("logging/setLevel", { level: "info" });
ck("未实现的方法 → JSON-RPC error（-32601），不是 result:null",
  nf?.error?.code === -32601, JSON.stringify(nf).slice(0, 120));

const ping = await c.request("ping");
ck("ping → 空 result（客户端拿它做保活，不能报错）",
  ping?.result && Object.keys(ping.result).length === 0, JSON.stringify(ping).slice(0, 80));

// 客户端发一行非 JSON（比如日志混进来）时，服务端不能崩
c.raw("this is not json");
const afterJunk = await c.request("tools/list");
ck("收到非 JSON 行后仍能正常响应（脏输入不能把进程搞死）", Array.isArray(afterJunk?.result?.tools));
ck("脏输入也没有污染 stdout（坏行不会被回写出去）", c.bad.length === 0, c.bad.join(" ｜ "));

/* 10. 联网工具的契约（不要求取到数据）──────────────────── */

console.log("\n10. amazon_suggest：允许失败，但不许假装成功");
const sug = await c.call("amazon_suggest", { prefix: "ceramic mug", site: "US", limit: 5 });
const S = payload(sug);
const sugIsErr = sug?.result?.isError === true;
const sugOk = S && typeof S === "object" && typeof S.count === "number";
ck("要么给出 count 与 suggestions 数组，要么 isError + 原因（不许返回裸 null）",
  sugIsErr || sugOk, errText(sug).slice(0, 120));

// 🔴 下面的断言必须**与网络是否可用无关**，否则断网跑一次就会少两条、断言数守卫会误报。
//    所以不写「成功才算过」，而是「成功路径查契约，失败路径查它有没有说清原因」——
//    两条路径各出一条断言，总数恒定。
if (sugOk) {
  ck("成功路径：count ≤ limit、verifiedMarket 是 boolean 且 US 为 true、0 条时带「分不清」说明",
    S.count <= 5 && typeof S.verifiedMarket === "boolean" && S.verifiedMarket === true
      && (S.count > 0 || /分不清|别当成/.test(String(S.note || ""))),
    JSON.stringify({ count: S.count, verifiedMarket: S.verifiedMarket, note: String(S.note || "").slice(0, 80) }));
} else {
  ck("失败路径：报错文本非空且说清了原因（不是空字符串 / 不是「未知错误」）",
    errText(sug).trim().length >= 8, errText(sug));
}

// 未知站点回落 US 的断言放在**源码层**而不是行为层：行为层要看返回里的 site，
// 而断网时返回的是 isError，site 根本不存在 —— 那就会变成"断网即红"，与本次改动无关。
const sugSrc = fs.readFileSync(SERVER, "utf8");
// 搜索建议的实现搬到了 `assets/amazon-suggest.js`（与每周采集器共用一份）。
// 断言也跟着搬 —— 留在 MCP 源码里查，会变成一条永远为真的空断言。
const sugLib = fs.readFileSync(path.join(HERE, "assets", "amazon-suggest.js"), "utf8");
ck("未知站点回落到 US（不因为客户端写错站点就崩）",
  /normalizeSite/.test(sugLib) && /return "US";/.test(sugLib));
ck("MCP 不再自己拼建议词 URL（复用 amazon-suggest，避免两份实现漂移）",
  /from "\.\.\/assets\/amazon-suggest\.js"/.test(sugSrc) && !/api\/2017\/suggestions/.test(sugSrc));

if (WANT_NET) {
  console.log("\n10b. --net：真打一次接口");
  const live = payload(await c.call("amazon_suggest", { prefix: "ceramic mug", site: "US", limit: 10 }));
  ck("真联网时能拿到 ≥1 条真实建议词", (live?.count || 0) >= 1, JSON.stringify(live).slice(0, 200));
  ck("真联网时返回的都是非空字符串", (live?.suggestions || []).every((s) => typeof s === "string" && s.trim().length > 0));
}

/* 10c. keyword_snapshot：真读一份快照文件 ─────────────────── */

console.log("\n10c. keyword_snapshot：读每周词库（真文件，临时目录）");
const KW_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-kw-"));
const KW_NONE = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-kw-none-"));
const KW_OLD = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-kw-old-"));

const kwHits = [
  { term: "ceramic mug with lid", root: "ceramic mug", group: "kitchen" },
  { term: "insulated travel tumbler", root: "travel tumbler", group: "kitchen" },
];
const kwAsins = [
  { asin: "B0KW000001", title: "Ceramic Mug with Lid", category: "kitchen", group: "kitchen", rank: 1, price: "$18.99" },
  { asin: "B0KW000002", title: "Reflective Dog Leash", category: "pet-supplies", group: "pet", rank: 2 },
];
const kwSnap = buildSnapshot({ site: "US", keywordHits: kwHits, asins: kwAsins, meta: { market: "美国站" } });
fs.writeFileSync(path.join(KW_TMP, "latest.json"), JSON.stringify(kwSnap), "utf8");
// 30 天前的快照：用来验证"过期要说出来"，而不是把旧数据当本周数据
const oldSnap = buildSnapshot({
  site: "US", keywordHits: kwHits, asins: kwAsins,
  now: new Date(Date.now() - 30 * 86400000),
});
fs.writeFileSync(path.join(KW_OLD, "latest.json"), JSON.stringify(oldSnap), "utf8");

const kwc = new Client([], { env: { ...process.env, LISTING_KEYWORDS: KW_TMP } });
await sleep(400);
await kwc.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "kw", version: "1" } });

const ks = payload(await kwc.call("keyword_snapshot", {}));
ck("有快照 → ok = true", ks?.ok === true, JSON.stringify(ks).slice(0, 160));
ck("counts 与文件一致（2 词 / 2 ASIN）", ks?.counts?.keywords === 2 && ks?.counts?.asins === 2, JSON.stringify(ks?.counts));
ck("关键词带词根来源（缺了就没法回答「这词怎么来的」）",
  (ks?.keywords?.[0]?.roots || []).length > 0, JSON.stringify(ks?.keywords?.[0] || {}));
ck("新生成的快照不算过期", ks?.stale === false && ks?.ageDays === 0, JSON.stringify({ stale: ks?.stale, ageDays: ks?.ageDays }));

const ksQ = payload(await kwc.call("keyword_snapshot", { query: "mug" }));
ck("query 过滤生效（只剩含 mug 的词）",
  ksQ?.keywords?.length === 1 && /mug/.test(ksQ.keywords[0].term), JSON.stringify(ksQ?.keywords?.map((k) => k.term)));
const ksC = payload(await kwc.call("keyword_snapshot", { category: "pet" }));
const ksK = payload(await kwc.call("keyword_snapshot", { category: "kitchen" }));
// 契约：`category` **同时**筛关键词与 ASIN（2026-11-07 之前只筛 ASIN，而工具描述写着"可按词面 / 类目筛选"）。
// 夹具里两个词都属于 kitchen；pet 只有一条 ASIN —— 于是这一次调用能同时证明两件事。
ck("category 同时筛关键词与 ASIN（kitchen 两类都有 / pet 只剩 ASIN）",
  ksC?.asins?.length === 1 && ksC.asins[0].asin === "B0KW000002" && ksC.keywords.length === 0
  && ksK?.keywords?.length === 2 && ksK.asins?.length === 1 && ksK.asins[0].asin === "B0KW000001",
  JSON.stringify({ pet: { asins: ksC?.asins?.length, kw: ksC?.keywords?.length }, kitchen: { asins: ksK?.asins?.length, kw: ksK?.keywords?.length } }));
const ksNo = payload(await kwc.call("keyword_snapshot", { includeAsins: false }));
ck("includeAsins=false → asins 是空数组（不是 undefined，省得客户端再判一次）",
  Array.isArray(ksNo?.asins) && ksNo.asins.length === 0);
ck("note 明写「词面清单，不是搜索量榜单」",
  /词面清单/.test(String(ks?.note || "")) && /不是搜索量/.test(String(ks?.note || "")), String(ks?.note || "").slice(0, 80));
kwc.close();

// 没有快照：这是**正常状态**，不是工具坏了
const kwn = new Client([], { env: { ...process.env, LISTING_KEYWORDS: KW_NONE } });
await sleep(400);
await kwn.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "kw", version: "1" } });
const ksn = payload(await kwn.call("keyword_snapshot", {}));
ck("没有快照 → ok = false 且 reason = missing",
  ksn?.ok === false && ksn?.reason === "missing", JSON.stringify(ksn).slice(0, 160));
ck("没有快照 → isError 保持 false（数据没生成 ≠ 工具坏了，报错会让模型反复重试）",
  (await kwn.call("keyword_snapshot", {}))?.result?.isError === false);
ck("没有快照 → hint 告诉下一步怎么办（跑采集器 / 触发工作流）",
  /collect-keywords/.test(String(ksn?.hint || "")), String(ksn?.hint || "").slice(0, 80));
kwn.close();

// 过期快照：必须自己说出来
const kwo = new Client([], { env: { ...process.env, LISTING_KEYWORDS: KW_OLD } });
await sleep(400);
await kwo.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "kw", version: "1" } });
const kso = payload(await kwo.call("keyword_snapshot", {}));
ck("30 天前的快照 → stale = true", kso?.stale === true, JSON.stringify({ stale: kso?.stale, age: kso?.ageDays }));
ck("过期时给出人话解释（「别把它当本周数据用」）",
  /天没更新/.test(String(kso?.staleNote || "")), String(kso?.staleNote || ""));
kwo.close();
for (const d of [KW_TMP, KW_NONE, KW_OLD]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }

/* 11. 离线模式 ───────────────────────────────────────────── */

console.log("\n11. --no-net：去掉联网工具");
const off = new Client(["--no-net"]);
await sleep(400);
await off.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "x", version: "1" } });
const offTools = (await off.request("tools/list"))?.result?.tools || [];
ck("--no-net 时工具数 = 7（只砍掉联网那一个）", offTools.length === 7, `${offTools.length}：${offTools.map((t) => t.name).join(",")}`);
ck("--no-net 时没有 amazon_suggest（离线跑就真的一个请求都不发）",
  !offTools.map((t) => t.name).includes("amazon_suggest"));
ck("--no-net 时其余 7 个工具仍在（不是把功能砍掉，只砍出网那一个）",
  offTools.length === 7 && offTools.every((t) => EXPECT.includes(t.name)));
ck("--no-net 时 stderr 标明 联网=off", /联网=off/.test(off.stderr), off.stderr.trim().slice(0, 120));
const offCall = await off.call("lint_listing", GOOD);
ck("--no-net 下非联网工具照常工作", payload(offCall)?.counts?.total === RULES.length);
off.close();

/* 12. 源码级约束 ─────────────────────────────────────────── */

console.log("\n12. 源码级约束：只读、零依赖、不偷写 stdout");
const src = fs.readFileSync(SERVER, "utf8");
ck("源码里没有 console.log（唯一的 stdout 出口必须是 send()）",
  !/(?<![.\w])console\.log\s*\(/.test(src),
  (src.match(/.*console\.log.*/g) || []).slice(0, 2).join(" ｜ "));
ck("源码里没有写盘调用（MCP 是判断层，不许落盘）",
  !/writeFileSync|createWriteStream|appendFileSync|fs\.writeFile|fs\.rm|fs\.unlink/.test(src));
ck("源码只 import node: 内置模块与 ../assets（零 npm 依赖，clone 下来就能跑）",
  [...src.matchAll(/from\s+["']([^"']+)["']/g)].every(([, s]) => s.startsWith("node:") || s.startsWith("../")),
  [...src.matchAll(/from\s+["']([^"']+)["']/g)].map(([, s]) => s).join(", "));
const pkg = JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8"));
ck("package.json 的 dependencies 仍为空（没为了 MCP 引入任何包）",
  Object.keys(pkg.dependencies || {}).length === 0, JSON.stringify(pkg.dependencies || {}));

/* 13. 客户端配置："别人拉下来就能用"到底靠什么保证 ────────── */

console.log("\n13. clients/ 配置样例：路径与形状都对着");
const CLIENTS = path.join(HERE, "mcp", "clients");
const cfgFiles = fs.readdirSync(CLIENTS).filter((f) => f.endsWith(".json")).sort();
ck("至少有 5 份 JSON 配置样例（Claude Desktop / Code / Cursor / VS Code / WorkBuddy）",
  cfgFiles.length >= 5, cfgFiles.join(","));

const resolved = [];
for (const f of cfgFiles) {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(path.join(CLIENTS, f), "utf8")); } catch { /* 下面这条断言会红 */ }
  ck(`${f}：是合法 JSON（配置写坏时客户端只会静默忽略，不会告诉你哪里错了）`, Boolean(j));
  const servers = j?.mcpServers || j?.servers;
  const entry = servers?.["listing-studio"];
  ck(`${f}：有 listing-studio 这一项`, Boolean(entry), JSON.stringify(Object.keys(servers || {})));
  ck(`${f}：command 是 node`, entry?.command === "node", String(entry?.command));
  ck(`${f}：args 只有一项，且指向 mcp/server.mjs`,
    Array.isArray(entry?.args) && entry.args.length === 1 && /\/mcp\/server\.mjs$/.test(entry.args[0]),
    JSON.stringify(entry?.args));
  // 占位符必须留着 —— 换成某台机器上的真实路径发出去，别人拿到只会得到 0 个工具
  ck(`${f}：路径仍是占位符 <PROJECT_DIR>（不许把本机路径写死进样例）`,
    String(entry?.args?.[0] || "").startsWith("<PROJECT_DIR>"), String(entry?.args?.[0] || ""));
  resolved.push({ f, abs: String(entry?.args?.[0] || "").replace("<PROJECT_DIR>", HERE) });
}
const uniq = [...new Set(resolved.map((r) => r.abs))];
ck("把占位符换成本项目路径后，5 份配置指向同一个真实存在的文件",
  uniq.length === 1 && fs.existsSync(uniq[0]), uniq.join(" ｜ "));

// 真按配置文件里的 command/args 起一次进程 —— 这条才算"别人照着配能跑通"
const cfgSpawn = spawn("node", [resolved[0].abs], { stdio: ["pipe", "pipe", "pipe"] });
const cfgOut = await new Promise((res) => {
  let buf = "";
  const t = setTimeout(() => res({ ok: false, why: "5s 无输出" }), 5000);
  cfgSpawn.stderr.setEncoding("utf8");
  cfgSpawn.stderr.on("data", (d) => {
    buf += d;
    if (/\[mcp\] ready/.test(buf)) { clearTimeout(t); res({ ok: true, why: buf.trim() }); }
  });
  cfgSpawn.on("exit", (code) => { clearTimeout(t); res({ ok: false, why: `提前退出 code=${code} ${buf.slice(0, 120)}` }); });
});
cfgSpawn.kill();
ck("照 clients 配置真起一次进程：打出了 ready（<PROJECT_DIR> 换成真实路径后可直接用）",
  cfgOut.ok, cfgOut.why);

// 从**别的工作目录**起一次：MCP 客户端不会把 cwd 设成项目根，所以路径必须绝对、
// 且模块内的 `../assets/*` 必须按文件位置解析（不能用 process.cwd() 拼）。
const anyCwd = new Client([], { cwd: os.tmpdir() });
await sleep(400);
const cwdInit = await anyCwd.request("initialize", {
  protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "cwd-probe", version: "1" },
});
ck("从任意工作目录（这里是系统临时目录）启动也能握手 —— 客户端 cwd 不固定是常态",
  cwdInit?.result?.serverInfo?.name === "listing-studio", JSON.stringify(cwdInit).slice(0, 120));
anyCwd.close();

const toml = path.join(CLIENTS, "codex.toml");
ck("Codex 的 config.toml 样例存在且段落名正确",
  fs.existsSync(toml) && /\[mcp_servers\.listing-studio\]/.test(fs.readFileSync(toml, "utf8")));
ck("Codex 样例里也是占位符路径", fs.existsSync(toml) && /<PROJECT_DIR>/.test(fs.readFileSync(toml, "utf8")));

const mcpReadme = fs.readFileSync(path.join(HERE, "mcp", "README.md"), "utf8");
ck("README 明确写了「不是关键词数据源」（缺这句，接上去第一句话就是失望）",
  /不是关键词数据源/.test(mcpReadme));
// 断言按**事实**写：不写死「7 个」这种会随工具增减而过期的数字，
// 而是要求「tools/list 里每个名字都在 README 里出现过」——
// 这样加一个工具忘了写文档会红，加完顺手写了文档就不会红。
const readmeMissing = names.filter((n) => !mcpReadme.includes(n));
ck("README 逐个写了工具名，并说明 --no-net 的差异",
  readmeMissing.length === 0 && /--no-net/.test(mcpReadme), readmeMissing.join(","));
ck("README 说明了标准输入是「每行一条 JSON」而不是 Content-Length（自写客户端的第一个坑）",
  /每行一条 JSON-RPC/.test(mcpReadme));
ck("README 解释了第三方数据为什么要各自 Token（这是本项目自建 MCP 的根本原因）",
  /谁用谁配/.test(mcpReadme));

/* 13b. 接入示例可运行 ─────────────────────────────────────────
 * 为什么把它也纳入自检：示例是**文档的一部分**（教程里贴的就是它的真实输出）。
 * 示例烂掉不会让任何断言变红，但会让照着做的人第一步就失败 —— 这种"文档性的腐烂"
 * 比代码 bug 更难发现，因为没人会去跑文档。所以在这里真跑一次。
 */
console.log("\n13b. examples/mcp-demo.mjs：示例真的能跑（它自己带 28 条断言）");
const demoPath = path.join(HERE, "examples", "mcp-demo.mjs");
ck("示例文件存在", fs.existsSync(demoPath));
const demoRun = spawnSync(process.execPath, [demoPath, "--no-net", "--quiet"], {
  cwd: HERE, encoding: "utf8", timeout: 90000,
});
const demoOut = `${demoRun.stdout || ""}${demoRun.stderr || ""}`;
ck("示例以 --no-net 跑完且退出码 0", demoRun.status === 0,
  `status=${demoRun.status} ${demoOut.slice(-400)}`);
ck("示例结论行是「示例全部通过」", /示例全部通过/.test(demoOut), demoOut.slice(-200));

/* 13c. 外部数据源的传输层 ─────────────────────────────────────
 * 这条链路（我们当客户端去连第三方的 Streamable HTTP MCP）**没有密钥就永远测不到**，
 * 而它恰好是失败模式最刁的一段：
 *   · 对方可能回 JSON，也可能回 SSE —— 只认一种的实现会"永远没回包"；
 *   · `initialize` 响应头里的 Mcp-Session-Id 不回带，后续请求全 400；
 *   · SSE 流里可能先来一条通知（没有 id），naive 实现会把通知当成结果。
 * 所以这里起一个**本地 mock MCP 服务**，把这四种情况各跑一遍。
 * 🔴 mock 只监听 127.0.0.1 的随机端口，不碰网络；跑完即关。
 */
console.log("\n13c. 外部数据源：Streamable HTTP 客户端（本地 mock 服务）");
{
  const http = await import("node:http");
  const { HttpMcp, HttpMcpError } = await import("../assets/mcp-http.js");
  const { normalizeTerms } = await import("../assets/term-normalize.js");

  const SESSION = "sess-test-123";
  let sawSessionOnList = false;

  const mock = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const msg = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const sid = req.headers["mcp-session-id"];

    if (req.url === "/slow") return;                       // 永不回包 → 测超时

    if (req.url === "/nomatch") {                          // 回的 id 对不上 → 测可读报错
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 99999, result: {} })}\n\n`);
      return;
    }

    if (msg.method === "initialize") {
      if (req.headers["secret-key"] !== "good-key") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end('{"error":"invalid secret-key"}');
        return;
      }
      // SSE 分支：真实服务常这么回
      res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": SESSION });
      res.write(`event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: { protocolVersion: "2025-06-18", serverInfo: { name: "mock-sprite", version: "0.1" }, capabilities: { tools: {} } },
      })}\n\n`);
      res.end();
      return;
    }

    // 之后的每个请求都必须带会话 id（真实服务不带就是 400）
    if (sid !== SESSION) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end('{"error":"missing mcp-session-id"}');
      return;
    }
    if (msg.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }

    if (msg.method === "tools/list") {
      sawSessionOnList = true;
      // JSON 分支：同一个服务端混用两种响应格式是允许的
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: { tools: [
          { name: "traffic_keyword", description: "反查流量词" },
          { name: "keyword_research", description: "关键词研究" },
        ] },
      }));
      return;
    }

    if (msg.method === "tools/call") {
      if (msg.params?.name === "boom") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: "quota exceeded" }] } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      // 先来一条**没有 id** 的通知：客户端必须跳过它，否则会拿通知当结果
      res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } })}\n\n`);
      res.write(`data: ${JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: { content: [{ type: "text", text: JSON.stringify({ items: [{ keyword: "leather bag", searches: 12000, rank: 2 }] }) }] },
      })}\n\n`);
      res.end();
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method" } }));
  });

  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const BASE = `http://127.0.0.1:${mock.address().port}`;

  // ① 正常路径：握手(SSE) → 列表(JSON) → 调用(SSE，带干扰帧)
  let hs = null, tools = [], callRes = null;
  try {
    hs = await HttpMcp.once(
      { url: `${BASE}/mcp`, headers: { "secret-key": "good-key" }, timeout: 3000 },
      async (c) => ({ info: c.serverInfo, tools: await c.listTools(), call: await c.callTool("traffic_keyword", { keyword: "leather bag" }) }),
    );
    tools = hs.tools; callRes = hs.call;
  } catch (e) {
    console.log(`    （正常路径抛错：${e.message}）`);
  }
  ck("① initialize 走 SSE 分支能解析出 serverInfo", hs?.info?.name === "mock-sprite", JSON.stringify(hs?.info));
  ck("② 后续请求带上了 Mcp-Session-Id（不带的话真实服务一律 400）", sawSessionOnList === true);
  ck("③ tools/list 走 application/json 分支也能解析出工具", tools.length === 2 && tools[0].name === "traffic_keyword",
    JSON.stringify(tools.map((t) => t.name)));
  ck("④ tools/call 跳过了没有 id 的通知帧，拿到自己的结果",
    /leather bag/.test(callRes?.text || ""), String(callRes?.text).slice(0, 120));
  ck("⑤ content[0].text 被二次解析成对象（不是把 JSON 字符串丢给上层）",
    callRes?.data?.items?.[0]?.searches === 12000, JSON.stringify(callRes?.data));

  // ② 密钥错：必须说"鉴权失败"，而不是笼统的 HTTP 401
  let authErr = null;
  try {
    await HttpMcp.once({ url: `${BASE}/mcp`, headers: { "secret-key": "wrong" }, timeout: 3000 }, (c) => c.listTools());
  } catch (e) { authErr = e; }
  ck("⑥ 密钥错 → 报「鉴权失败」并带上 HTTP 状态（能直接指向「该换密钥了」）",
    authErr instanceof HttpMcpError && /鉴权失败/.test(authErr.message) && authErr.status === 401,
    String(authErr?.message));

  // ③ 工具级错误：isError 原样传出，不当成传输失败
  let boom = null;
  try {
    boom = await HttpMcp.once({ url: `${BASE}/mcp`, headers: { "secret-key": "good-key" }, timeout: 3000 },
      (c) => c.callTool("boom", {}));
  } catch (e) { boom = { threw: e.message }; }
  ck("⑦ 工具级错误（isError:true）不当成传输异常抛出，交给上层判断",
    boom?.isError === true && /quota/.test(boom.text || ""), JSON.stringify(boom).slice(0, 120));

  // ④ id 对不上 + 超时：两条都必须给出**能读懂的**错误
  let noMatch = null;
  try {
    await HttpMcp.once({ url: `${BASE}/nomatch`, headers: {}, timeout: 2000 }, (c) => c.listTools());
  } catch (e) { noMatch = e.message; }
  ck("⑧ 响应 id 对不上时给出可读错误（而不是静默空结果）",
    /没有 id=|没等到 id=/.test(noMatch || ""), String(noMatch));

  let timeoutMsg = "";
  try {
    await HttpMcp.once({ url: `${BASE}/slow`, headers: {}, timeout: 300 }, (c) => c.listTools());
  } catch (e) { timeoutMsg = e.message; }
  ck("⑨ 对方不回包 → 超时错误里带毫秒数（排查时能分清「慢」和「错」）",
    /超时/.test(timeoutMsg) && /300/.test(timeoutMsg), timeoutMsg);

  await new Promise((r) => mock.close(r));

  /* 13d. 外部词表归一 ─────────────────────────────────────────
   * 字段名是猜的（各家不一样），所以断言的重点不是"猜得准"，而是：
   * 猜对了要标出来、猜不出来要返回 0 条并说明原因 —— 绝不编数据。
   */
  console.log("\n13d. 外部词表归一（term-normalize）：认得出来，认不出来就说认不出来");
  const n1 = normalizeTerms({ data: { items: [{ keyword: "leather bag", searches: 12400, rank: 3, asin: "B01" }, { keyword: "tote bag", searches: 9000 }] } });
  ck("① 认出嵌套在 data.items 里的词，并记下用的是哪些字段",
    n1.count === 2 && n1.mapping.term === "keyword" && n1.mapping.volume === "searches",
    JSON.stringify(n1.mapping));
  ck("② 搜索量与排名进了对应槽位", n1.terms[0].volume === 12400 && n1.terms[0].rank === 3, JSON.stringify(n1.terms[0]));

  const n2 = normalizeTerms({ keywords: ["ceramic mug", "coffee cup"] });
  ck("③ 纯字符串数组也认（很多工具只回词，不回量）",
    n2.count === 2 && n2.terms.every((t) => t.volume === null), JSON.stringify(n2.terms));
  ck("④ 没有搜索量时明确说出来，而不是当成 0（0 会被排到最冷门，结论正好反了）",
    /没认出搜索量/.test(n2.why), n2.why);

  const n3 = normalizeTerms({ keywordText: "yoga mat", monthlySearch: "12.3K" });
  ck("⑤ 展示值 12.3K 被换算成 12300", n3.count === 1 && n3.terms[0].volume === 12300, JSON.stringify(n3.terms[0]));

  const n4 = normalizeTerms({ foo: { bar: 1 } });
  ck("⑥ 认不出来 → 0 条 + 原因（不编词，也不假装成功）",
    n4.count === 0 && Boolean(n4.why), n4.why);

  const n5 = normalizeTerms({ items: [{ keyword: "Bag", searches: 100 }, { keyword: "bag", searches: 300, rank: 9 }] });
  ck("⑦ 同一个词重复出现：取最大搜索量与最小排名，不重复计数",
    n5.count === 1 && n5.terms[0].volume === 300 && n5.terms[0].rank === 9, JSON.stringify(n5.terms));

  const n6 = normalizeTerms({ description: "a".repeat(100000), data: [{ keyword: "mug" }] });
  ck("⑧ 长文本块不会被当成词（description 里塞一万个字符也不影响）",
    n6.count === 1 && n6.terms[0].term === "mug", JSON.stringify(n6.terms));
}

/* 13e. P0-B2：回环 HTTP 四道门（真起 mcp/http.mjs 子进程）────────────
 * 13c 跑的是我们**当客户端**连第三方的 mock；这里跑的是产品自己的 HTTP 服务，
 * 不是替身。端口用 listen(0) 临时拿一个空闲回环端口（不占默认 8790，避免和别的
 * 测试 / 手动实例撞），token 用 MCP_TOKEN_FILE 指到临时目录 —— 否则它默认写进
 * data/mcp-setup/，第 14 节「data/ 逐字节未变」会红，而那跟 MCP 只读性无关。
 * 🔴 子进程与临时目录在 finally 里关干净，不留监听孤儿。
 */
console.log("\n13e. P0-B2：回环 HTTP 四道门（真起 mcp/http.mjs）");
{
  const net = await import("node:net");
  const http = await import("node:http");
  const HTTP_SCRIPT = path.join(HERE, "mcp", "http.mjs");
  const HTTP_SRC = fs.readFileSync(HTTP_SCRIPT, "utf8");
  const HANDLER_SRC = fs.readFileSync(path.join(HERE, "mcp", "handler.mjs"), "utf8");
  const HTTP_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-http-"));
  const TOKEN_FILE = path.join(HTTP_TMP, "token.txt");

  // 与 13c 同策略：先 listen(0) 拿一个当前空闲的回环端口，关掉再交给产品进程绑定。
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const PORT = probe.address().port;
  await new Promise((r) => probe.close(r));

  const proc = spawn(process.execPath, [HTTP_SCRIPT], {
    cwd: HERE,
    env: { ...process.env, MCP_HTTP_PORT: String(PORT), MCP_TOKEN_FILE: TOKEN_FILE },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let httpErr = "";
  let procDead = false;
  proc.on("exit", () => { procDead = true; });
  proc.stderr.setEncoding("utf8");
  const ready = await new Promise((res) => {
    const t = setTimeout(() => res(false), 10000);
    proc.stderr.on("data", (d) => {
      httpErr += d;
      if (/接入 URL/.test(httpErr)) { clearTimeout(t); res(true); }
    });
    proc.on("exit", () => { clearTimeout(t); res(false); });
  });

  /** 用 node:http 发请求：Host / Origin / Referer 都能精确伪造（fetch 不许自定义 Host）。
   *  出错也 resolve 成 status:0，保证任何一条断言都照常跑完、断言数不因网络抖动而漂移。 */
  const req = (o = {}) => new Promise((resolve) => {
    const r = http.request({
      host: "127.0.0.1", port: PORT,
      method: o.method || "POST", path: o.path || "/mcp",
      headers: o.headers || {}, timeout: 5000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", (e) => resolve({ status: 0, headers: {}, body: "", error: String(e?.message || e) }));
    r.on("timeout", () => { r.destroy(); resolve({ status: 0, headers: {}, body: "", error: "timeout" }); });
    if (o.body) r.write(o.body);
    r.end();
  });

  // ① 绑定：源码里的 host 字面量 + 启动后的硬断言（不是打一行日志就算了）。
  ck("mcp/http.mjs 用 server.listen(PORT, \"127.0.0.1\", …) 只绑回环",
    /server\.listen\(\s*PORT\s*,\s*"127\.0\.0\.1"/.test(HTTP_SRC));
  ck("mcp/http.mjs 里没有把监听地址写成 0.0.0.0 / :: 的字符串字面量",
    !/["']0\.0\.0\.0["']|["']::["']/.test(HTTP_SRC));
  ck("mcp/http.mjs 启动后用 server.address().address 硬断言回环，否则拒绝启动",
    /addr\.address\s*!==\s*"127\.0\.0\.1"/.test(HTTP_SRC) && /process\.exit\(1\)/.test(HTTP_SRC));
  ck("HTTP 子进程起来了（stderr 打了接入 URL，不是端口占用提前退出）", ready && !procDead,
    httpErr.slice(-200));
  ck("启动后 stderr 自证 server.address().address=127.0.0.1（已断言为回环）",
    /server\.address\(\)\.address=127\.0\.0\.1/.test(httpErr), httpErr.slice(-200));

  let TOKEN = "";
  try { TOKEN = fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch { /* 下面这条会红 */ }
  ck("token 落盘到 MCP_TOKEN_FILE 指定的临时目录（不碰 data/，64 位十六进制）",
    /^[0-9a-f]{64}$/.test(TOKEN), TOKEN.slice(0, 20));

  const okHeaders = (extra = {}) => ({ "content-type": "application/json", ...extra });
  const AUTH = { authorization: `Bearer ${TOKEN}` };
  const TL_BODY = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

  try {
    let r;
    r = await req({ headers: okHeaders(), body: TL_BODY });
    ck("无 token 的 POST /mcp → 401", r.status === 401, `实际 ${r.status} ${r.error || ""}`);

    r = await req({ method: "GET", headers: okHeaders(AUTH), body: "" });
    ck("GET /mcp → 405（8 工具全单轮，不做 SSE 流）", r.status === 405, `实际 ${r.status}`);
    ck("405 带 Allow: POST（明确告诉客户端只收 POST）", r.headers.allow === "POST", String(r.headers.allow));

    r = await req({ headers: okHeaders({ ...AUTH, host: "evil.com" }), body: TL_BODY });
    ck("Host: evil.com → 403（DNS rebinding 第一道）", r.status === 403, `实际 ${r.status}`);
    r = await req({ headers: okHeaders({ ...AUTH, host: "127.0.0.1.evil.com" }), body: TL_BODY });
    ck("Host: 127.0.0.1.evil.com → 403（Host 校验是精确白名单，不可绕过）", r.status === 403, `实际 ${r.status}`);

    r = await req({ headers: okHeaders({ ...AUTH, origin: "https://evil.com" }), body: TL_BODY });
    ck("Origin: https://evil.com → 403（浏览器跨站 fetch 第二道）", r.status === 403, `实际 ${r.status}`);

    r = await req({ path: `/mcp?token=${TOKEN}`, headers: okHeaders({ referer: "https://evil.com/" }), body: TL_BODY });
    ck("?token=… 且带非空 Referer → 403（URL 含密钥，不许进 Referer）", r.status === 403, `实际 ${r.status}`);

    r = await req({ headers: okHeaders(AUTH), body: TL_BODY });
    let httpTl = null;
    try { httpTl = JSON.parse(r.body); } catch { /* 下面会红 */ }
    const httpNames = ((httpTl?.result?.tools) || []).map((t) => t.name);
    ck("合法 Bearer token 的 tools/list → 200", r.status === 200, `实际 ${r.status} ${r.body.slice(0, 120)}`);
    ck("HTTP 模式返回 8 个工具", httpNames.length === 8, `实际 ${httpNames.length}：${httpNames.join(",")}`);
    ck("HTTP 模式工具名集合与 stdio 模式完全相同",
      JSON.stringify([...httpNames].sort()) === JSON.stringify([...names].sort()),
      `http=${[...httpNames].sort().join(",")} stdio=${[...names].sort().join(",")}`);
    ck("HTTP 与 stdio 的 tools/list result 逐字节相同（同一个 handle()，不复制第二份工具表）",
      JSON.stringify(httpTl?.result) === JSON.stringify(tl?.result));

    // ⑦ 请求体里塞任意 URL 字段：不许触发对外请求。起本地 mock 当「外部目标」，
    //    只要它收到一个请求就说明有 SSRF 面。内层 finally 保证 mock 一定关掉。
    {
      let ssrfHits = 0;
      const ssrf = http.createServer((_q, s) => { ssrfHits++; s.writeHead(200); s.end("pwned"); });
      try {
        await new Promise((rs) => ssrf.listen(0, "127.0.0.1", rs));
        const SSRF_PORT = ssrf.address().port;
        const ssrfBody = JSON.stringify({
          jsonrpc: "2.0", id: 2, method: "tools/list",
          url: `http://127.0.0.1:${SSRF_PORT}/pwn`,
          endpoint: `http://127.0.0.1:${SSRF_PORT}/pwn`,
          callback: `http://127.0.0.1:${SSRF_PORT}/pwn`,
        });
        const ssrfRes = await req({ headers: okHeaders(AUTH), body: ssrfBody });
        await sleep(150);
        let ssrfTools = 0;
        try { ssrfTools = (JSON.parse(ssrfRes.body || "{}")?.result?.tools || []).length; } catch { /* 保持 0 */ }
        ck("请求体塞任意 URL 字段仍返回 200 + 8 工具（协议不使用可指定任意 URL 的字段）",
          ssrfRes.status === 200 && ssrfTools === 8, `实际 ${ssrfRes.status} / ${ssrfTools} 个工具`);
        ck("请求体里的 URL 字段没有触发任何对外请求（本地 mock 零命中，SSRF 面关闭）",
          ssrfHits === 0, `mock 被命中 ${ssrfHits} 次`);
      } finally {
        try { await new Promise((rs) => ssrf.close(rs)); } catch { /* ignore */ }
      }
    }

    // ⑧ handler 的 Host/Origin 校验不可绕过：源码层也不能用 endsWith 之类松匹配。
    ck("mcp/handler.mjs 的 Host 白名单是精确集合（无 endsWith 松匹配）",
      /LOCAL_HOSTS\s*=\s*new Set\(/.test(HANDLER_SRC) && !/endsWith\(/.test(HANDLER_SRC));
    ck("mcp/handler.mjs 里 Host / Origin 两道校验都在（headers.host / headers.origin）",
      /hostName\(headers\.host\)/.test(HANDLER_SRC) && /isLocalOrigin\(headers\.origin\)/.test(HANDLER_SRC));
  } catch (e) {
    ck("13e 四道门整段无未捕获异常（否则 HTTP 契约未被完整验证）", false, String(e?.message || e));
  } finally {
    try { proc.kill(); } catch { /* ignore */ }
    // 等子进程真的退出，避免留下监听端口的孤儿进程。
    await new Promise((res) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return res();
      const t = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* ignore */ } res(); }, 3000);
      proc.once("exit", () => { clearTimeout(t); res(); });
    });
    try { fs.rmSync(HTTP_TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* 13f. P2#1 annotations / P2#2 outputSchema + structuredContent ────────
 * 两个都是**协议外壳**，文档已对外承诺，必须机器可验。
 * annotations 的四键按 MCP 规范名（README:336）：readOnlyHint / destructiveHint /
 * idempotentHint / openWorldHint —— 只有 amazon_suggest 出网，故只有它 openWorldHint=true。
 */
console.log("\n13f. P2#1 annotations / P2#2 outputSchema + structuredContent");
const ANN_KEYS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
const annMissing = tools.filter((t) => !t.annotations || !ANN_KEYS.every((k) => k in t.annotations));
ck("8/8 工具都带 annotations 且含四键（readOnlyHint/destructiveHint/idempotentHint/openWorldHint）",
  annMissing.length === 0, annMissing.map((t) => t.name).join(", ") || "全齐");
ck("amazon_suggest.openWorldHint === true（8 个里唯一真出网的）",
  tools.find((t) => t.name === "amazon_suggest")?.annotations?.openWorldHint === true);
ck("其余 7 个工具 openWorldHint === false（不能把本地判断标成开放世界）",
  tools.filter((t) => t.name !== "amazon_suggest").every((t) => t.annotations?.openWorldHint === false));
ck("8/8 工具都带 outputSchema（输出契约进 tools/list，不是只在文档里说）",
  tools.every((t) => t.outputSchema && typeof t.outputSchema === "object"),
  tools.filter((t) => !t.outputSchema).map((t) => t.name).join(", "));

// P2#2：断言必须落在 tools/call 的结果上（不是 tools/list）。两者同源，序列化比较即深相等。
const scCall = await c.call("lint_listing", GOOD);
const scText = scCall?.result?.content?.[0]?.text;
const sc = scCall?.result?.structuredContent;
let scDeepEqual = false;
try { scDeepEqual = JSON.stringify(sc) === JSON.stringify(JSON.parse(scText)); } catch { /* 下面会红 */ }
ck("tools/call 成功结果带 structuredContent（不是只在 tools/list 里声明）",
  Boolean(sc) && typeof sc === "object" && !Array.isArray(sc), JSON.stringify(sc || {}).slice(0, 120));
ck("structuredContent 与 content[0].text 解析出的 JSON 深相等（同一份 stringify 反解）",
  scDeepEqual, JSON.stringify(sc || {}).slice(0, 160));
ck("content 仍保留（老客户端只读 content，行为不变）",
  Array.isArray(scCall?.result?.content) && typeof scText === "string"
  && Boolean(payload(scCall)) && typeof payload(scCall) === "object");
ck("isError:true 的工具级错误不返回 structuredContent（错误文本不是 JSON，不猜）",
  (await c.call("mine_keywords", {}))?.result?.structuredContent === undefined);
const scCall2 = await c.call("analyze_coverage", { ...GOOD, keywords: ["ceramic mug"] });
let sc2Equal = false;
try { sc2Equal = JSON.stringify(scCall2?.result?.structuredContent) === JSON.stringify(JSON.parse(scCall2?.result?.content?.[0]?.text)); } catch { /* 下面会红 */ }
ck("analyze_coverage 的 structuredContent 同样与 content[0].text 深相等", sc2Equal);

/* 13g. P2#3：VALIDATORS 表驱动参数校验 ───────────────────────────────
 * 旧版是 5 个平行 if，boolean 根本没校验（isMedia / includeNgrams 是漏的）。
 * 这四条分别钉住：number 类型、maximum 上限值、required、boolean 类型。
 */
console.log("\n13g. P2#3 VALIDATORS 表驱动参数校验");
const vNum = await c.call("keyword_snapshot", { limit: "abc" });
ck("limit:\"abc\"（number 传字符串）→ isError:true", vNum?.result?.isError === true);
ck("类型报错文案含「应为 number」", /应为 number/.test(errText(vNum)), errText(vNum).slice(0, 120));

const vMax = await c.call("keyword_snapshot", { limit: 501 });
ck("limit 超过 maximum(500) → isError:true", vMax?.result?.isError === true);
ck("超出上限的报错里带上限值 500", /500/.test(errText(vMax)), errText(vMax).slice(0, 120));

const vReq = await c.call("analyze_coverage", {});
ck("缺少必填参数（analyze_coverage 缺 keywords）→ isError:true", vReq?.result?.isError === true);
ck("缺参报错含「缺少必填参数」", /缺少必填参数/.test(errText(vReq)), errText(vReq).slice(0, 120));

const vBool = await c.call("lint_listing", { isMedia: "true" });
ck("isMedia 传字符串 → isError:true（旧版漏掉的 boolean 校验）", vBool?.result?.isError === true);
ck("boolean 类型校验生效，报错含「应为 boolean」", /应为 boolean/.test(errText(vBool)), errText(vBool).slice(0, 120));

/* 13h. S-2 / G-8：analyze_coverage.useVault 闭环 ──────────────────────
 * 三条分支都要验：默认（改动前 run() 的逐字拷贝，多一个键就是改坏老客户）/
 * 空词库 / 有词库。词库用 LISTING_KEYWORDS 指向临时目录（与 10c 同机制），不碰 data/。
 */
console.log("\n13h. S-2 / G-8 useVault 覆盖度闭环");
const V_NONE = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-vault-none-"));
const V_HAS = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-vault-has-"));
const vSnap = buildSnapshot({
  site: "US",
  keywordHits: [
    { term: "ceramic mug with lid", root: "ceramic mug", group: "kitchen" },
    { term: "insulated travel tumbler", root: "travel tumbler", group: "kitchen" },
    { term: "stainless steel bottle", root: "steel bottle", group: "kitchen" },
  ],
  asins: [],
  meta: { market: "美国站" },
});
fs.writeFileSync(path.join(V_HAS, "latest.json"), JSON.stringify(vSnap), "utf8");
const covArgs = {
  ...GOOD,
  keywords: ["ceramic mug", "insulated tumbler", "travel mug"],
  competitors: [{ name: "竞品A", text: "Insulated tumbler with leak proof lid. Travel mug keeps drinks cold." }],
};
const GAP_FIELDS = ["term", "from", "rootCount", "groups", "missingIn"];

// ① 默认分支：不传 useVault
const vDefault = payload(await c.call("analyze_coverage", covArgs));
ck("不传 useVault：gaps 是字符串数组（旧版逐字拷贝）",
  Array.isArray(vDefault?.gaps) && vDefault.gaps.every((g) => typeof g === "string"), JSON.stringify(vDefault?.gaps));
ck("不传 useVault：返回体里没有 gapShape / vault / summary（多一个键就是改坏了老客户）",
  vDefault && !("gapShape" in vDefault) && !("vault" in vDefault) && !("summary" in vDefault),
  Object.keys(vDefault || {}).join(","));

// ② useVault:true 且词库为空
const vcNone = new Client([], { env: { ...process.env, LISTING_KEYWORDS: V_NONE } });
await sleep(400);
await vcNone.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "vault", version: "1" } });
const vNoneRes = await vcNone.call("analyze_coverage", { ...covArgs, useVault: true });
const V0 = payload(vNoneRes);
ck("useVault:true 且词库为空 → isError:false（没词库不是工具坏了）", vNoneRes?.result?.isError === false, errText(vNoneRes).slice(0, 120));
ck("useVault:true 且词库为空 → vault.ok === false", V0?.vault?.ok === false, JSON.stringify(V0?.vault));
ck("useVault:true 且词库为空 → vault.reason === \"missing\"", V0?.vault?.reason === "missing", JSON.stringify(V0?.vault));
// 以下两条按定稿契约写：useVault 模式下 gaps **恒为对象数组**、gapShape 恒为 "objects"，
//    与词库可用与否无关（vaultCoverage 不再降形；无词库时对象里 from 全 user、rootCount 全 null）。
//    🔴 别与默认分支混淆：不传 useVault 走 legacyCoverage，gaps 是字符串数组且不带
//    gapShape / vault / summary —— 由本段前两条断言钉死，逐字节不变。
ck("useVault:true 且词库为空 → gapShape === \"objects\"", V0?.gapShape === "objects",
  `实际 ${String(V0?.gapShape)}`);
ck("useVault:true 且词库为空 → gaps 恒为对象数组（每项带 term/from/rootCount/groups/missingIn）",
  Array.isArray(V0?.gaps) && V0.gaps.length > 0
    && V0.gaps.every((g) => g && typeof g === "object" && GAP_FIELDS.every((k) => k in g)),
  JSON.stringify(V0?.gaps).slice(0, 200));
vcNone.close();

// ③ useVault:true 且有词库快照
const vcHas = new Client([], { env: { ...process.env, LISTING_KEYWORDS: V_HAS } });
await sleep(400);
await vcHas.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "vault", version: "1" } });
const vHasRes = await vcHas.call("analyze_coverage", { ...covArgs, useVault: true });
const V1 = payload(vHasRes);
ck("useVault:true 且有词库 → isError:false", vHasRes?.result?.isError === false, errText(vHasRes).slice(0, 120));
ck("有词库 → gapShape === \"objects\" 且 gaps 是每项带 5 键的对象数组",
  V1?.gapShape === "objects" && Array.isArray(V1?.gaps) && V1.gaps.length > 0
    && V1.gaps.every((g) => g && typeof g === "object" && GAP_FIELDS.every((k) => k in g)),
  JSON.stringify(V1?.gaps).slice(0, 200));
const cu = V1?.summary?.coverageUser, cv = V1?.summary?.coverageVault;
ck("summary.coverageUser / coverageVault 是两个独立的 0..100 数（不是混算成一个）",
  typeof cu === "number" && cu >= 0 && cu <= 100 && typeof cv === "number" && cv >= 0 && cv <= 100,
  JSON.stringify(V1?.summary));
ck("vault.used <= vault.limit（并入词数不超过上限）",
  typeof V1?.vault?.used === "number" && typeof V1?.vault?.limit === "number" && V1.vault.used <= V1.vault.limit,
  JSON.stringify(V1?.vault));
vcHas.close();
for (const d of [V_NONE, V_HAS]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }

/* 13i. 源码级静态约束：继续守住只读 / 零依赖 / handler 纯请求层 ───────── */
console.log("\n13i. 源码级静态约束（server.mjs / handler.mjs / clients）");
const handlerSrc = fs.readFileSync(path.join(HERE, "mcp", "handler.mjs"), "utf8");
ck("mcp/server.mjs 三条静态红线仍成立（imports 全为 node:/../、无裸 console.log(、无写盘调用）",
  [...src.matchAll(/from\s+["']([^"']+)["']/g)].every(([, s]) => s.startsWith("node:") || s.startsWith("../"))
  && !/(?<![.\w])console\.log\s*\(/.test(src)
  && !/writeFileSync|createWriteStream|appendFileSync|fs\.writeFile|fs\.rm|fs\.unlink/.test(src));
ck("mcp/handler.mjs 不 import node:http（它必须是纯请求处理，不监听端口）",
  !/from\s+["']node:http["']|require\(\s*["']node:http["']\s*\)/.test(handlerSrc));
ck("mcp/handler.mjs 不发对外请求（无 fetch / http.request / node:https，SSRF 面为零）",
  !/\bfetch\s*\(|\bhttps?\.request\s*\(|from\s+["']node:https["']/.test(handlerSrc));
// 第 13 节逐份 .json 已验 args；这里把 codex.toml 也钉住（此前只验了存在/段落/占位符）。
const codexToml = fs.readFileSync(path.join(HERE, "mcp", "clients", "codex.toml"), "utf8");
ck("codex.toml 的 args 也只有一项且以 /mcp/server.mjs 结尾",
  /args\s*=\s*\[\s*"<PROJECT_DIR>\/mcp\/server\.mjs"\s*\]/.test(codexToml),
  codexToml.split("\n").filter((l) => /args/.test(l)).join(" ｜ "));

/* 14. 副作用硬断言 ───────────────────────────────────────── */

console.log("\n14. 副作用：跑了一整套调用，data/ 未变");
const after = snapDir(DATA_DIR);
ck("🔴 用户数据（data/ 下除 keywords/ 外）逐项未变（大小 + mtime 全等）", before === after,
  before === after ? "" : `前 ${before.split("\n").length} 项 / 后 ${after.split("\n").length} 项`);

c.close();

console.log(`\n${"—".repeat(60)}`);
console.log(`共 ${pass + fail} 条断言：通过 ${pass}，失败 ${fail}`);
if (WANT_NET) {
  // --net 是人工诊断模式，会比登记值多 2 条（真打接口那两条）—— 故意不参与守卫，否则每次都会提示"新增"。
  console.log("[断言数] --net 模式不参与断言数守卫（联网那两条是额外加的）");
} else {
  fail += checkAssertCount("mcp-selftest", pass + fail);
}
if (fail === 0) console.log("全部通过 ✓");
process.exit(fail ? 1 : 0);
