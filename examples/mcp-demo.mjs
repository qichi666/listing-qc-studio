#!/usr/bin/env node
/**
 * MCP 接入示例 —— 一个最小但完整的客户端，把 8 个工具逐个真调一遍。
 *
 * ── 这个文件是干什么的 ──────────────────────────────────────────────
 * 它不是"再写一遍服务端"，而是**从调用方视角**演示 MCP 怎么接：
 * 起进程 → 握手 → 列工具 → 逐个调用 → 校验返回值 → 收尾。
 * 整个过程零依赖（只用 node: 内置模块），因为项目本身零依赖。
 *
 * 为什么值得单独放一个文件而不是写在文档里：
 *   MCP（stdio）最常见的失败是**静默**的 —— 客户端不会说"你的 server 逻辑错了"，
 *   它只会显示「0 个工具」或者卡住。所以"能跑一遍"必须是一个可执行的东西，
 *   而不是一段贴不进去的代码片段。这个文件就是那个"能跑一遍"。
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *   node examples/mcp-demo.mjs             # 8 个工具全调（含联网的 amazon_suggest）
 *   node examples/mcp-demo.mjs --no-net    # 跳过联网工具（离线/断网时用这个）
 *   node examples/mcp-demo.mjs --json      # 逐帧打印原始 JSON-RPC，排查协议问题用
 *   node examples/mcp-demo.mjs --quiet     # 只打印结论行
 *
 * 退出码：0 = 全部通过；1 = 有断言失败（会指出是哪一条）。
 *
 * ── 协议要点（看代码前先记住这三条）──────────────────────────────────
 *   ① 传输是 **stdio + 每行一条 JSON**（NDJSON），不是 HTTP。所以必须自己按 \n 切行缓冲；
 *   ② **stdout 是协议通道**：server 的任何一句 console.log 都会污染它。本文件把
 *      server 的 stderr 原样转出来（那是它允许写日志的地方），stdout 只用来收协议帧；
 *   ③ 请求与回包靠 `id` 配对，**通知**（notifications/*）没有 id、天然没有回包 ——
 *      对着通知等回包会永远挂住，这是新手最常踩的坑。
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, "mcp", "server.mjs");

const ARGV = process.argv.slice(2);
const NO_NET = ARGV.includes("--no-net");
const SHOW_JSON = ARGV.includes("--json");
const QUIET = ARGV.includes("--quiet");

/* ─────────────────── ① 一个够用的 stdio 客户端 ───────────────────
 * 只有 60 行，但它覆盖了 MCP 客户端的全部必要动作：
 *   起进程 / 切行缓冲 / id 配对 / 发通知 / 调工具 / 超时 / 收尾。
 * 生产用请直接装官方 SDK —— 这里手写是为了让"协议长什么样"可见。
 */
class McpClient {
  constructor(script, args = []) {
    this.proc = spawn(process.execPath, [script, ...args], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.buf = "";
    this.seq = 0;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.stderr = "";
    this.exited = null;
    this.dead = new Promise((res) => {
      this.proc.on("exit", (code, sig) => { this.exited = { code, sig }; res(); });
    });

    // 🔴 必须按行缓冲：一次 data 事件可能只有半行，也可能一次来三行。
    //    直接 JSON.parse(chunk) 在真实环境里会随机失败 —— 而且失败时看起来像"服务端没回"。
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        if (SHOW_JSON) console.log(`   ← ${line}`);
        let msg;
        try { msg = JSON.parse(line); } catch {
          // 收到非 JSON = 有人往 stdout 写了日志。这是致命错误，但要说清楚原因。
          throw new Error(`stdout 出现非 JSON 内容（协议通道被污染）：${line.slice(0, 120)}`);
        }
        const slot = this.pending.get(msg.id);
        if (slot) {
          this.pending.delete(msg.id);
          clearTimeout(slot.timer);
          msg.error ? slot.reject(new Error(`${msg.error.code} ${msg.error.message}`)) : slot.resolve(msg.result);
        }
        // 没有 id 的是服务端主动通知（本 server 不发通知，这里留个位置）
      }
    });
    // stderr 是日志通道，原样转出（但不混进结论里）
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (s) => { this.stderr += s; });
  }

  send(method, params, { notify = false } = {}) {
    const msg = { jsonrpc: "2.0", method };
    if (params !== undefined) msg.params = params;
    if (!notify) msg.id = ++this.seq;
    const text = JSON.stringify(msg);
    if (SHOW_JSON) console.log(`   → ${text}`);
    this.proc.stdin.write(`${text}\n`);
    if (notify) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      // 超时给 20s：amazon_suggest 自己就要 8s，其余工具都是毫秒级。
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        reject(new Error(`${method} 超时（20s 没回包）`));
      }, 20000);
      this.pending.set(msg.id, { resolve, reject, timer });
    });
  }

  notify(method, params) { return this.send(method, params, { notify: true }); }

  /** 调工具：把协议壳剥掉，直接给你业务 JSON。 */
  async call(name, args) {
    const r = await this.send("tools/call", { name, arguments: args });
    const text = r?.content?.[0]?.text ?? "";
    let data = null;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { isError: Boolean(r?.isError), data };
  }

  async close() {
    try { this.proc.stdin.end(); } catch { /* 已经关了 */ }
    // 服务端监听 stdin 的 close 会自行退出；1.5s 还没退就强杀，避免脚本挂住。
    const t = setTimeout(() => { try { this.proc.kill(); } catch { /* ignore */ } }, 1500);
    await this.dead;
    clearTimeout(t);
  }
}

/* ─────────────────── 输出与断言的小工具 ─────────────────── */
let pass = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; if (!QUIET) console.log(`   ✓ ${name}`); }
  else { fails.push(`${name}${detail ? `  ${detail}` : ""}`); console.log(`   ✗ ${name}${detail ? `  ${detail}` : ""}`); }
};
const step = (n, title) => { if (!QUIET) console.log(`\n── ${n} ${title} ${"─".repeat(Math.max(2, 56 - String(title).length))}`); };
const brief = (s, max = 96) => {
  const one = String(s).replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
};
const kb = (o) => `${(JSON.stringify(o).length / 1024).toFixed(1)} KB`;

/* ─────────────────── ② 示例数据（刻意留了问题）───────────────────
 * 这份文案是"真实新手会写出来的样子"：堆形容词、标题塞关键词、
 * Search Terms 用逗号分隔（亚马逊按空格索引，逗号是浪费字节）、
 * 没有品牌、五点只有 4 条。目的不是夸它写得好，而是让质检**有东西可报**。
 */
const SAMPLE = {
  title: "Ceramic Mug 12oz Best Quality Coffee Cup for Office Home Kitchen Christmas Gift for Women Men Dad Mom Friends",
  highlights: "12oz capacity, Dishwasher safe, Microwave safe, Ceramic",
  bullets: [
    "PREMIUM CERAMIC: made of high-quality ceramic, durable and sturdy for daily use.",
    "PERFECT SIZE: 12oz capacity is ideal for coffee, tea, milk and hot chocolate.",
    "GREAT GIFT: a wonderful gift for Christmas, birthday, anniversary and holidays.",
    "EASY TO CLEAN: dishwasher safe and microwave safe, saving your time.",
  ],
  searchTerms: "ceramic mug, coffee cup, tea cup, office mug, gift mug, 12oz mug",
  description: "This ceramic mug is the best choice for your daily coffee. 100% satisfaction guaranteed.",
  brand: "",
  primaryKeyword: "ceramic mug",
  category: "home",
};

const COMPETITOR_TEXT = [
  "Ceramic Coffee Mug 12 oz, Large Stoneware Cup with Handle for Office and Home, Matte Glaze",
  "Large Ceramic Mug 16oz, Microwave and Dishwasher Safe Coffee Cup, Speckled Stoneware, Gift Boxed",
  "Stoneware Coffee Mug Set of 2, 12oz Ceramic Cups with Comfortable Handle, Modern Farmhouse Kitchen",
].join("\n---\n");

const main = async () => {
  if (!QUIET) {
    console.log("MCP 接入示例 · 跨境 Listing 质检工作台");
    console.log(`服务端：${SERVER}`);
    console.log(`模式：${NO_NET ? "离线（--no-net，7 个工具）" : "全部（8 个工具，含 1 个联网）"}`);
  }

  const cli = new McpClient(SERVER, NO_NET ? ["--no-net"] : []);

  try {
    /* ── ③ 握手：initialize ──────────────────────────────────────
     * 这是**每个会话的第一步**，且必须在 notifications/initialized 之前。
     * 客户端在 params.protocolVersion 里报自己支持的版本，服务端回它选中的那个。
     * 本 server 的策略：比它支持的都新 → 给最新；都老 → 给最老；夹在中间 → 给不超过它的最高版。
     */
    step("①", "握手 initialize");
    const init = await cli.send("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-demo", version: "1.0.0" },
    });
    if (!QUIET) {
      console.log(`   serverInfo   ${init.serverInfo?.name} ${init.serverInfo?.version}`);
      console.log(`   协议版本     ${init.protocolVersion}（我们要 2025-06-18）`);
      console.log(`   能力         ${Object.keys(init.capabilities || {}).join(", ") || "—"}`);
      console.log(`   说明         ${brief(init.instructions, 160)}`);
    }
    check("initialize 返回 serverInfo.name = listing-studio", init.serverInfo?.name === "listing-studio");
    check("协议版本协商成功（落在服务端支持列表里）", /^\d{4}-\d{2}-\d{2}$/.test(String(init.protocolVersion)));
    check("声明了 tools 能力", Boolean(init.capabilities?.tools));

    // 🔴 通知：没有 id，所以**不要 await 回包**。发了就往下走。
    await cli.notify("notifications/initialized", {});

    /* ── ④ 发现：tools/list ─────────────────────────────────────
     * 客户端拿这份清单去喂模型（name + description + inputSchema）。
     * 描述里那句"用我当 / 别用我当"就是给模型看的路由提示 —— 少了它，模型会拿
     * lint_listing 去回答"能不能上传"这种它答不了的问题。
     */
    step("②", "列工具 tools/list");
    const list = await cli.send("tools/list", {});
    const tools = list.tools || [];
    if (!QUIET) {
      for (const t of tools) console.log(`   · ${t.name.padEnd(20)} ${t.title || ""}`);
      console.log(`   共 ${tools.length} 个工具`);
    }
    check(`工具数量 = ${NO_NET ? 7 : 8}`, tools.length === (NO_NET ? 7 : 8), `实际 ${tools.length}`);
    check("每个工具都有 inputSchema", tools.every((t) => t.inputSchema && t.inputSchema.type === "object"));
    check("联网工具随 --no-net 正确消失", NO_NET ? !tools.some((t) => t.name === "amazon_suggest") : tools.some((t) => t.name === "amazon_suggest"));

    /* ── ⑤ 逐个别调 ─────────────────────────────────────────────── */

    // 1) 质检
    step("③", "lint_listing · 28 条规则逐条判定");
    const lint = await cli.call("lint_listing", SAMPLE);
    if (!QUIET) {
      console.log(`   ← ${lint.isError ? "isError=true" : "isError=false"} · ${kb(lint.data)}`);
      console.log(`   结论 ${lint.data.conclusion} ｜ 命中 ${lint.data.counts?.hit} 条（硬 ${lint.data.counts?.hitC} / 软 ${lint.data.counts?.hitP}）`
        + ` ｜ 已判 ${lint.data.counts?.checked} / 跳过 ${lint.data.counts?.skipped}`);
      for (const h of (lint.data.hits || []).slice(0, 3)) console.log(`     - [${h.id}] ${brief(h.detail, 88)}`);
    }
    check("返回 28 条规则的统计", lint.data.counts?.total === 28, `实际 ${lint.data.counts?.total}`);
    check("有结论、有命中明细", typeof lint.data.conclusion === "string" && Array.isArray(lint.data.hits));
    check("命中项都带出处 source（改文案前先看它）", (lint.data.hits || []).every((h) => Boolean(h.source)));

    // 2) 上传前预校验
    step("④", "precheck_upload · 三层预校验");
    const pre = await cli.call("precheck_upload", SAMPLE);
    if (!QUIET) {
      console.log(`   ← ${kb(pre.data)}`);
      console.log(`   blockers ${pre.data.blockers?.length ?? "?"} ｜ warnings ${pre.data.warnings?.length ?? "?"} ｜ externals ${pre.data.externals?.length ?? "?"}`);
      // blockers / warnings 是 {field,label,why} 结构；externals 是纯字符串（本来就查不到的东西）。
      for (const b of (pre.data.blockers || []).slice(0, 2)) console.log(`     ! ${b.label || b.field}：${brief(b.why || b, 90)}`);
      for (const e of (pre.data.externals || []).slice(0, 2)) console.log(`     ? ${brief(e, 90)}`);
    }
    check("三层结构齐全（blockers / warnings / externals）",
      Array.isArray(pre.data.blockers) && Array.isArray(pre.data.warnings) && Array.isArray(pre.data.externals));
    check("externals 说清「本工具查不到」（不假装已通过）", (pre.data.externals || []).length > 0);

    // 3) 覆盖度
    step("⑤", "analyze_coverage · 词在四个位置出现没有");
    const cov = await cli.call("analyze_coverage", {
      ...SAMPLE,
      keywords: ["ceramic mug", "coffee cup", "stoneware", "gift box", "microwave safe", "farmhouse", "handle", "12oz"],
      competitors: [{ name: "竞品A", text: COMPETITOR_TEXT }],
      top: 8,
    });
    if (!QUIET) {
      console.log(`   覆盖率 ${cov.data.coveragePct}% ｜ 覆盖 ${cov.data.covered}/${cov.data.total}`);
      console.log(`   真缺口 ${JSON.stringify((cov.data.gaps || []).slice(0, 5))}`);
      console.log(`   竞品挖出的线索 ${JSON.stringify((cov.data.minedGaps || []).slice(0, 5))}`);
      console.log(`   口径 ${brief(cov.data.note, 150)}`);
    }
    check("覆盖率是 0–100 的数字", typeof cov.data.coveragePct === "number" && cov.data.coveragePct >= 0 && cov.data.coveragePct <= 100);
    check("总数 = 我给的候选词数", cov.data.total === 8, `实际 ${cov.data.total}`);
    check("gaps 只含我给的词（不夹带猜测）",
      (cov.data.gaps || []).every((g) => ["ceramic mug", "coffee cup", "stoneware", "gift box", "microwave safe", "farmhouse", "handle", "12oz"].includes(g)));

    // 4) 词频
    step("⑥", "mine_keywords · 竞品标题到底在打哪些词");
    const mine = await cli.call("mine_keywords", { text: COMPETITOR_TEXT, top: 10, lang: "en" });
    if (!QUIET) {
      const rows = mine.data.terms || [];
      console.log(`   ← ${kb(mine.data)} ｜ 语种 ${mine.data.lang || "en"} ｜ 词 ${mine.data.stats?.uniqueTokens} 个独特词`);
      for (const w of rows.slice(0, 6)) console.log(`     · ${w.term}  weight ${w.weight}${w.words > 1 ? `（${w.words} 词短语）` : ""}`);
      console.log(`   口径 ${brief(mine.data.note, 120)}`);
    }
    // 字段名是 terms[]，权重字段是 weight（不是 count/freq）—— 这里断言的是真实契约。
    check("词频结果非空，且带 weight 权重", ((mine.data.terms || []).length) > 0 && mine.data.terms.every((w) => typeof w.weight === "number"));
    check("明确声明「不是搜索量」", mine.data.disclaimer?.isSearchVolume === false);

    // 5) 生图 Prompt
    step("⑦", "build_image_prompt · 只出文字，不出图");
    const img = await cli.call("build_image_prompt", {
      subject: "ceramic mug",
      templateId: "hero-image",
      figure: "main",
      ratio: "1:1",
      slot: "main",
      purpose: "首图要让人一眼看出是陶瓷杯、有把手、容量 12oz",
      evidence: ["12oz", "dishwasher safe"],
      cta: "",
    });
    if (!QUIET) {
      console.log(`   ← ${kb(img.data)} ｜ 画幅 ${img.data.meta?.ratio} → ${img.data.meta?.pixels}`);
      console.log(`   ${brief(img.data.prompt, 300)}`);
    }
    check("prompt 是非空字符串", typeof img.data.prompt === "string" && img.data.prompt.length > 40);
    // meta.pixels 是 "1024x1024" 这样的字符串（不是 {w,h} 对象）—— 断言按真实契约写。
    check("带回画幅像素 meta.pixels（如 1024x1024）", /^\d+x\d+$/.test(String(img.data.meta?.pixels || "")));

    // 6) 快照对比
    step("⑧", "diff_snapshots · 同一件商品前后两次");
    const diff = await cli.call("diff_snapshots", {
      before: { asin: "B0DEMO1234", title: "Ceramic Mug 12oz", price: "$15.99", bullets: ["A", "B"], rating: "4.5" },
      after: { asin: "B0DEMO1234", title: "Ceramic Mug 12oz with Handle", price: "$13.99", bullets: ["A", "B", "C"], rating: "4.5" },
    });
    if (!QUIET) {
      console.log(`   变化字段 ${diff.data.changedCount} ｜ unchanged ${(diff.data.unchanged || []).length} ｜ 同 ASIN ${diff.data.sameAsin}`);
      for (const r of (diff.data.rows || []).slice(0, 4)) {
        console.log(`     · ${r.label}: ${brief(r.before ?? "—", 34)} → ${brief(r.after ?? "—", 34)}`);
      }
      console.log(`   口径 ${brief(diff.data.note, 140)}`);
    }
    check("认出是同一件商品（sameAsin）", diff.data.sameAsin === true);
    check("至少报出 3 个变化字段（标题/价格/五点）", diff.data.changedCount >= 3, `实际 ${diff.data.changedCount}`);
    check("五点增删给了 added / removed 明细",
      (diff.data.rows || []).some((r) => Array.isArray(r.added) && r.added.length > 0));

    // 7) 本周词库
    step("⑨", "keyword_snapshot · 只读，没有词库也要说清为什么");
    const snap = await cli.call("keyword_snapshot", { query: "mug", limit: 5, includeAsins: true });
    if (!QUIET) {
      if (snap.data.ok) {
        console.log(`   ← ${kb(snap.data)} ｜ 站点 ${snap.data.site} ｜ 采集于 ${String(snap.data.generatedAt).slice(0, 10)}（${snap.data.ageDays} 天前）`);
        console.log(`   词库共 ${snap.data.counts?.keywords} 条，本次命中 ${snap.data.keywordsTotal} 条，返回 ${snap.data.keywords?.length} 条`);
        console.log(`   示例：${(snap.data.keywords || []).map((k) => k.term).join(" / ")}`);
      } else {
        console.log(`   ok:false（不是报错）· 原因 ${snap.data.reason} —— ${brief(snap.data.hint, 120)}`);
      }
    }
    check("词库分支给了明确结论（有数据 ok:true / 没数据 ok:false + hint）",
      snap.data.ok === true || (snap.data.ok === false && Boolean(snap.data.hint)));
    if (snap.data.ok) {
      check("limit=5 真的生效，且截断有报账",
        (snap.data.keywords || []).length <= 5 && typeof snap.data.keywordsTruncated === "boolean");
      check("明确声明「不是搜索量」", /不是搜索量|搜索热度/.test(String(snap.data.note || "")));
    }

    // 8) 搜索建议（唯一联网工具）
    if (!NO_NET) {
      step("⑩", "amazon_suggest · 唯一联网工具（允许失败）");
      try {
        const sug = await cli.call("amazon_suggest", { prefix: "ceramic mug", site: "US", limit: 5 });
        if (sug.isError) {
          console.log(`   ⚠ 本次没取到（不是代码错）：${brief(sug.data.raw, 120)}`);
          check("失败时如实报错，而不是返回空数组冒充「没有词」", true);
        } else {
          console.log(`   ← ${kb(sug.data)} ｜ 站点 ${sug.data.site} ｜ ${sug.data.count} 条`);
          for (const s of (sug.data.suggestions || []).slice(0, 5)) console.log(`     · ${s}`);
          check("返回 suggestions 数组", Array.isArray(sug.data.suggestions));
          check("说明该站点是否实测过", typeof sug.data.verifiedMarket === "boolean");
        }
      } catch (e) {
        // 超时/网络不通都算"环境问题"，不算示例代码失败 —— 但必须说出来。
        console.log(`   ⚠ 联网调用未完成（环境问题，不是示例错）：${e.message}`);
      }
    }

    /* ── ⑥ 错误路径：故意调一个不存在的工具 ─────────────────────
     * MCP 的约定：**工具级的错误走 isError，不走 JSON-RPC error**。
     * 区别很重要 —— 前者模型能看见并自行纠正，后者客户端只当成"服务挂了"。
     */
    step("⑪", "错误路径（故意传错）");
    const bad = await cli.call("no_such_tool", {});
    if (!QUIET) console.log(`   ← isError=${bad.isError} · ${brief(bad.data.raw, 130)}`);
    check("不存在的工具返回 isError=true（不是 JSON-RPC error，模型能看见并自我纠正）", bad.isError === true);

    const missing = await cli.call("mine_keywords", { top: 5 });
    if (!QUIET) console.log(`   ← isError=${missing.isError} · ${brief(missing.data.raw, 130)}`);
    check("缺必填参数时给出可读原因（不是 500 / 不是空结果）", missing.isError === true && /text/.test(String(missing.data.raw)));

    /* ── ⑦ 收尾 ─────────────────────────────────────────────── */
    step("⑫", "收尾");
    await cli.close();
    check("关 stdin 后服务端自行退出（不留孤儿进程）", cli.exited !== null, JSON.stringify(cli.exited));
    if (NO_NET && /联网=off/.test(cli.stderr)) check("--no-net 生效（stderr 打印 联网=off）", true);

    // stderr 必须只有服务自己的日志。有任何异常堆栈都值得看一眼。
    const dirty = cli.stderr.split("\n").filter((l) => l && !l.startsWith("[mcp]"));
    if (dirty.length) console.log(`\n   stderr 里有非日志行（排查用）：\n   ${dirty.slice(0, 5).join("\n   ")}`);
  } catch (e) {
    fails.push(`示例脚本异常：${e.message}`);
    console.log(`\n✗ 示例脚本异常：${e.message}`);
    await cli.close().catch(() => {});
  }

  const total = pass + fails.length;
  console.log(`\n${"─".repeat(60)}`);
  console.log(`共 ${total} 条自检：通过 ${pass}，失败 ${fails.length}`);
  if (fails.length) {
    for (const f of fails) console.log(`  ✗ ${f}`);
    console.log("示例未通过 —— 先看上面第一条红色，别一次改十处。");
    process.exit(1);
  }
  console.log("示例全部通过 ✓");
};

main();
