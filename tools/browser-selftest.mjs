#!/usr/bin/env node
/**
 * 浏览器侧端到端自检（真起服务 + 真起浏览器）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────
 * 在它之前，这个项目的前端只有"源码级断言"（grep 一下 app.js 里有没有那行代码）。
 * 但源码里有那行 ≠ 跑起来不出错。而这台机器上：
 *   · Node 里没有 IndexedDB → 本地产物的**读写能力**根本测不到；
 *   · 页面里一个模板串写错、一个 id 打错，只有真跑才炸。
 * 更关键的是：本轮实测发现 **file:// 下 ES 模块被 CORS 拦掉，整个应用不启动**
 * （file:// 的 DOM 23.9KB 纯骨架 vs http:// 的 322KB 真渲染）——
 * 这种"页面看起来在、其实一行 JS 没跑"的事，只有真浏览器能证伪。
 *
 * ── 怎么做到的（零依赖）──────────────────────────────────────
 * 用 Edge/Chrome 自带的 CDP：`--remote-debugging-port` 起无头浏览器，
 * 再用 Node 22 内置的全局 `WebSocket` 直连 CDP 端点，收 `Runtime.exceptionThrown`
 * 事件 + 执行 `Runtime.evaluate`。不装 puppeteer / playwright（零依赖是项目硬约束）。
 *
 * ⚠️ 会临时起一个服务(默认 8793)与一个浏览器进程，跑完全部关掉；
 *    全程只**读**项目文件，唯一写入是浏览器自己的临时 profile 目录（在系统 temp 下）。
 *    自检页里会写 IndexedDB，那是浏览器沙箱里的数据，不碰仓库。
 *
 * ⚠️ 网络依赖：只有"第 ⑦ 卡"那一节会真的去抓一次亚马逊榜单，**允许失败**
 *    （改结构 / 断网 / 限流都属正常）。但失败必须**如实报错**，不许假装有数据 ——
 *    所以那一节的断言条数会随网络环境浮动，全绿的含义是"两种结局都诚实"。
 *
 * 运行：node tools/browser-selftest.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkAssertCount } from "./assert-count.mjs";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.SMOKE_PORT || 8793);
const CDP_PORT = Number(process.env.SMOKE_CDP_PORT || 8794);
const PROFILE = path.join(os.tmpdir(), "clx-browser-selftest-profile");

const BROWSERS = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

let pass = 0, fail = 0;
const ck = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? "  " + extra : ""}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browserPath = BROWSERS.find((p) => fs.existsSync(p));
if (!browserPath) {
  console.log("找不到 Edge / Chrome，跳过浏览器侧自检（不算失败）。");
  process.exit(0);
}
console.log(`浏览器：${browserPath}`);

/* ── 极简 CDP 客户端（Node 内置 WebSocket，不装依赖）────────── */
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; this.dialogs = []; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error(`连不上 CDP：${wsUrl}`));
      setTimeout(() => rej(new Error("CDP 连接超时")), 10000);
    });
    const c = new Cdp(ws);
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id != null && c.pending.has(msg.id)) {
        const { resolve, reject } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message || "CDP 出错")) : resolve(msg.result);
      } else if (msg.method) {
        c.events.push(msg);
        // 🔴 原生 alert/confirm/prompt 会**阻塞渲染进程的 JS 线程** ——
        //    Runtime.evaluate 从此不再返回，整个自检卡在 30s 超时上，报错还指向下一条断言，
        //    排查方向完全错（这是 10/25 真实栽过的一次）。
        //    所以这里一律自动「取消」，并记下原文；由断言去判断"这一步本来该不该弹"。
        if (msg.method === "Page.javascriptDialogOpening") {
          c.dialogs.push(msg.params?.message || "");
          c.send("Page.handleJavaScriptDialog", { accept: false }).catch(() => {});
        }
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP ${method} 超时`)); }
      }, 30000);
    });
  }
  /** 在页面里跑一段 JS 并取回值。awaitPromise 让页面里的 Promise 也能直接返回。 */
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`页面异常：${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description || ""}`);
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function jget(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await wait(250);
  }
  return null;
}

/* ── 起服务 + 起浏览器 ─────────────────────────────────────── */

// 🔴 数据目录重定向到临时目录：本脚本会读到"图片库空态"，如果指到用户的 data/gen，
//    那条断言就取决于"用户碰巧没生成过图"——是状态依赖，不是产品行为。
//    重定向后：① 断言稳定；② 全程不碰用户真实数据；③ 分享包接收者跑自检也不留垃圾。
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "clx-browser-data-"));

const srv = spawn(process.execPath, [path.join(HERE, "server.mjs")], {
  cwd: HERE,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", LISTING_DATA: TMP_DATA,
    // 词库目录也重定向到临时目录（那里没有 latest.json）—— 目的是让"没有词库"这一态
    // 成为**确定性**输入，而不是"取决于本机有没有跑过采集器"。
    LISTING_KEYWORDS: path.join(TMP_DATA, "keywords") },
  stdio: "ignore",
});
const health = await jget(`http://127.0.0.1:${PORT}/api/health`, 20);
if (!health) {
  srv.kill();
  console.log(`服务起不来（端口 ${PORT}），自检中止。`);
  process.exit(1);
}
console.log(`本地服务：http://127.0.0.1:${PORT}/`);

fs.rmSync(PROFILE, { recursive: true, force: true });
const br = spawn(browserPath, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "--disable-background-networking", "--mute-audio",
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
  "--window-size=1280,900",
  "about:blank",
], { stdio: "ignore" });

let cdp = null;
let exitCode = 0;
try {
  const ver = await jget(`http://127.0.0.1:${CDP_PORT}/json/version`, 40);
  if (!ver) throw new Error(`浏览器没起来（CDP 端口 ${CDP_PORT}）`);
  const list = await jget(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const page = (list || []).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("找不到可用的页面 target");
  cdp = await Cdp.connect(page.webSocketDebuggerUrl);

  // 关键：**先开监听再导航** —— 否则加载期的异常一条都收不到
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Page.enable");

  const exceptions = () => cdp.events
    .filter((e) => e.method === "Runtime.exceptionThrown")
    .map((e) => e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text || "?");
  const consoleErrors = () => cdp.events
    .filter((e) => e.method === "Log.entryAdded" && e.params.entry.level === "error")
    .map((e) => e.params.entry.text);

  /**
   * 打开页面，并等到**应用真的跑起来**。
   *
   * 🔴 只等 `readyState === 'complete'` 不够（2026-11-05 修）：
   *    boot() 里 DOM 完成后还要 `await probeServer()` 打一次 /api/health，
   *    回来才 renderStatus()。这段空窗里 `#status` 还是初态「探测中…」，
   *    紧接着就读它 → 断言随机变红。
   *    随机红比没有测试更糟：红过两次，人就开始忽略所有红色。
   *
   * 判据用**具体产物**（状态栏变成「本地服务在线 / 未连接」）而不是定时，
   * 12 × 250ms = 3s 上限；超时也照常往下走，让断言自己报错（附实际文本）。
   */
  const goto = async (url) => {
    cdp.events.length = 0;
    await cdp.send("Page.navigate", { url });
    // 1) HTML 与子资源加载完
    for (let i = 0; i < 80; i++) { await wait(250); if (await cdp.eval("document.readyState === 'complete'")) break; }
    // 2) 首轮探活结束（#status 从「探测中…」变成终态文案）
    for (let i = 0; i < 12; i++) {
      const txt = String(await cdp.eval("(document.getElementById('status')||{}).innerText || ''"));
      if (/本地服务/.test(txt)) break;
      await wait(250);
    }
  };

  /* ── 1. 主页面能加载、JS 真的跑了 ─────────────────────────── */
  console.log("\n1. 主页面（http://）");
  await goto(`http://127.0.0.1:${PORT}/`);
  const booted = await cdp.eval("document.querySelectorAll('#nav button').length");
  ck("导航按钮渲染出来了（说明模块加载成功）", booted >= 7, `实际 ${booted} 个`);
  const status = await cdp.eval("document.getElementById('status').innerText");
  ck("侧栏状态显示「本地服务在线」", /在线/.test(String(status)), JSON.stringify(status));
  ck("欢迎消息渲染到了聊天区", /跨境/.test(String(await cdp.eval("document.getElementById('chatInner').innerText"))));
  ck("规则表渲染出来了", /规则总数/.test(String(await cdp.eval("document.getElementById('limTable').innerText"))));
  ck("加载期没有未捕获异常", exceptions().length === 0, exceptions().join(" | "));
  ck("加载期没有 console.error", consoleErrors().length === 0, consoleErrors().join(" | "));

  /* ── 2. 逐个视图点一遍（防"切过去是空白"）────────────────── */
  console.log("\n2. 每个视图都点一遍");
  const VIEWS = ["chat", "templates", "library", "capture", "listing", "words", "vault", "settings"];
  for (const v of VIEWS) {
    await cdp.eval(`[...document.querySelectorAll('#nav button')].find(b=>b.dataset.view==='${v}').click()`);
    await wait(400);
    const info = await cdp.eval(`(()=>{const s=document.querySelector('.view[data-view="${v}"]');return {on:s.classList.contains('on'),len:s.innerText.trim().length}})()`);
    ck(`切到「${v}」：可见且有内容`, info && info.on && info.len > 30, JSON.stringify(info));
  }
  ck("点完一圈没有未捕获异常", exceptions().length === 0, exceptions().join(" | "));

  /* ── 2b. 本周词库：冷态也必须说清"为什么没有" ────────────────
   * 本节把 LISTING_KEYWORDS 指到空目录（见起服务处），所以这里**必然**是冷分支。
   * 冷态最容易被写成一句"加载失败"—— 那等于什么都没说。断言要的正是：
   * 四格体检仍然在、并且必须带上"上次采集怎么了"这一句可照着修的话。
   */
  console.log("\n2b. 本周词库（冷态）");
  await cdp.eval("[...document.querySelectorAll('#nav button')].find(b=>b.dataset.view==='words').click()");
  await wait(600);
  const wCells = await cdp.eval("document.querySelectorAll('#wordsStat .wcell').length");
  ck("词库页四格数据体检渲染出来了（冷态也占位，不是空白页）", wCells === 4, `实际 ${wCells} 格`);
  const wBody = await cdp.eval("document.getElementById('wordsTable').innerText");
  ck("没有词库时直说「暂时没有词库」并给出来源", /暂时没有词库/.test(String(wBody)), JSON.stringify(String(wBody).slice(0, 80)));
  ck("没有词库时必须交代上次采集怎么了（不是一句「加载失败」）",
    /采集/.test(String(wBody)), JSON.stringify(String(wBody).slice(0, 120)));
  const wNoop = await cdp.eval(`(()=>{const b=document.getElementById('btnWordsToCopy');const dis=b.disabled;b.click();return {dis,still:document.querySelector('.view[data-view="words"]').classList.contains('on')}})()`);
  ck("没有词时「送进文案页」是灰的（不是点了没反应），且点了也不会跳走",
    wNoop && wNoop.dis === true && wNoop.still === true, JSON.stringify(wNoop));

  /* ── 2c. 外部数据源：没有账号也得有东西可看 ────────────────────
   * 这一节起服务时词库是空的、也没有任何第三方密钥 —— 正是"新人第一次打开"的状态。
   * 如果这时候设置页只有"填密钥"一条路，这个功能对他们就是一块死路。
   * 所以断言：示例入口在，点了真能跳到词库页，并且那块对比真的渲染出来。
   */
  console.log("\n2c. 外部数据源：没有账号时的示例入口");
  await cdp.eval("[...document.querySelectorAll('#nav button')].find(b=>b.dataset.view==='settings').click()");
  await wait(600);
  const hasDemoBtn = await cdp.eval("Boolean(document.getElementById('btnExtDemo'))");
  ck("设置页有「没有账号？看示例对比」入口（不是只有填密钥一条路）", hasDemoBtn === true);
  const extProv = await cdp.eval("document.getElementById('extProvider')?.options.length || 0");
  ck("外部数据源下拉真的读到了服务端清单（不是空 select）", extProv >= 1, `实际 ${extProv} 项`);
  await cdp.eval("document.getElementById('btnExtDemo').click()");
  await wait(1600);
  const demoInfo = await cdp.eval(`(()=>{const v=document.querySelector('.view[data-view="words"]');const b=document.getElementById('wordsExt');return {on:v.classList.contains('on'),text:(b.innerText||'').slice(0,240)}})()`);
  ck("点示例 → 跳到词库页，且外部词表块真的渲染了（不是空 div）",
    demoInfo.on === true && /示例数据/.test(String(demoInfo.text)), JSON.stringify(demoInfo).slice(0, 200));
  ck("示例必须自报家门（用户不能把它当成自己账户的数据）",
    /不是你账户里的数据/.test(String(demoInfo.text)), JSON.stringify(String(demoInfo.text).slice(0, 120)));
  ck("没有本地词库时，示例也如实说「暂时没法对比」，而不是给 0",
    /暂时没法对比/.test(String(demoInfo.text)) || /两边都有/.test(String(demoInfo.text)),
    JSON.stringify(String(demoInfo.text).slice(0, 160)));

  /* ── 2d. 空输入点按钮：必须给反馈，不许"点了没反应" ──────────────
   * 这两处原来是 `if (!x) return;`，点击后界面毫无变化 —— 用户只会以为按钮坏了。
   * 项目铁律是"没数据也要说清原因"。此处刻意在**还没解析任何商品**时点快照按钮。 */
  console.log("\n2d. 空输入的两个按钮：必须说清为什么没动作");
  {
    await cdp.eval("document.getElementById('btnSnapSave').click()");
    await wait(350);
    const toast = String(await cdp.eval("(document.getElementById('uiToast')||{}).textContent||''"));
    ck("🔴 没采集商品时点「记一条快照」→ 弹出原因（不再静默 return）",
      /还没有商品数据/.test(toast) && /采集/.test(toast), toast.slice(0, 160));
  }

  /* ── 3. 本轮新增功能真的渲染出东西 ────────────────────────── */
  console.log("\n3. 本轮新增功能的界面");
  await cdp.eval("[...document.querySelectorAll('#nav button')].find(b=>b.dataset.view==='library').click()");
  await wait(1200);
  const libMeta = await cdp.eval("document.getElementById('libMeta').innerText");
  ck("图片库读到了服务端清单（空库也要有明确的「共 0 张」）", /共\s*\d+\s*张/.test(String(libMeta)), JSON.stringify(libMeta));
  ck("图片库空态有指引文案", /还没有图片/.test(String(await cdp.eval("document.getElementById('libGrid').innerText"))));

  await cdp.eval("[...document.querySelectorAll('#nav button')].find(b=>b.dataset.view==='vault').click()");
  await wait(600);
  const vault = await cdp.eval("document.getElementById('vaultStat').innerText");
  ck("本地产物页给出了 IndexedDB 状态（可用/不可用都要讲清）", /本地共|IndexedDB/.test(String(vault)), JSON.stringify(vault).slice(0, 120));

  /* ── 3b. 模板自动匹配：默认机制，得在界面上真的看得见、真的会跑 ── */
  console.log("\n3b. 模板自动匹配（默认机制）");
  await cdp.eval("[...document.querySelectorAll('#nav button')].find(b=>b.dataset.view==='templates').click()");
  await wait(500);
  ck("自动匹配预览有初始引导文案", /输入一句话/.test(String(await cdp.eval("document.getElementById('autoMatchOut').innerText"))));

  // 真敲一句话进去，看预览会不会实时算（不是静态文案）
  const auto = await cdp.eval(`(() => {
    const box = document.getElementById("autoMatchInput");
    box.value = "给这件黑色T恤做一张图";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    return document.getElementById("autoMatchOut").innerText;
  })()`);
  ck("输入服装类需求 → 预览算出 ghost-mannequin（不再回落白底主图）", /ghost-mannequin/.test(String(auto)), String(auto).slice(0, 160));
  ck("预览同时摊开「依据」与「也可考虑」", /依据/.test(String(auto)) && /也可考虑/.test(String(auto)), String(auto).slice(0, 200));

  const autoJunk = await cdp.eval(`(() => {
    const box = document.getElementById("autoMatchInput");
    box.value = "zzz qqq";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    return document.getElementById("autoMatchOut").innerText;
  })()`);
  ck("乱码输入如实报「规则兜底」，不编造匹配依据", /兜底/.test(String(autoJunk)) && !/驱动常用图型/.test(String(autoJunk)), String(autoJunk).slice(0, 200));

  // 「固定用这个模板」必须真的改变状态、且能一键撤回（否则等于给用户挖坑）
  const lock = await cdp.eval(`(() => {
    document.getElementById("tplUse").click();
    const btn = document.getElementById("tplLockBtn");
    const on = { shown: btn.style.display !== "none", text: btn.textContent, atChat: document.querySelector(".view[data-view='chat']").classList.contains("on") };
    btn.click();
    return { ...on, after: document.getElementById("tplLockBtn").style.display };
  })()`);
  ck("点「固定用这个模板」→ 顶栏出现提示并切到创作台", lock.shown && lock.atChat && /固定用/.test(lock.text), JSON.stringify(lock).slice(0, 200));
  ck("点提示本身即可恢复自动匹配（提示消失）", lock.after === "none", JSON.stringify(lock).slice(0, 120));

  /* ── 3c. 2026-07 标题新规：额度要看得见、超限要联动报警 ─────────── */
  console.log("\n3c. 标题新规（75 字符 + Item Highlights）");
  await cdp.eval("[...document.querySelectorAll('#nav button')].find(b=>b.dataset.view==='listing').click()");
  await wait(500);

  // 规则表在页面底部的抽屉里（默认收起）—— 先用用户的方式打开它。
  // 这里也顺带锁住一件事：抽屉必须真的能展开，否则下面拿到的是空字符串。
  const refOpen = await cdp.eval(`(()=>{const d=document.getElementById('drawerRef'); if(!d) return false; d.open=true; return true})()`);
  ck("规则表抽屉能展开（默认收起，但不是不可达）", refOpen === true);

  const limText = String(await cdp.eval("document.getElementById('limTable').innerText"));
  ck("限值表已改成新规口径（75 / 125 / 200 三个数都在）",
    /75/.test(limText) && /125/.test(limText) && /200/.test(limText), limText.replace(/\s+/g, " ").slice(0, 160));
  // 这条断言防的是"只改了数字、没讲后果"：光把 200 改成 75，用户不知道超限会连带丢掉什么。
  ck("限值表点明了「标题超限 → Item Highlights 提交不上去」这条因果",
    /提交不上去/.test(limText), limText.replace(/\s+/g, " ").slice(0, 300));

  ck("Item Highlights 输入框存在", await cdp.eval("!!document.getElementById('lHighlights')"));
  ck("初始计数显示 0 / 75", /0\s*\/\s*75/.test(String(await cdp.eval("document.getElementById('lTitleCount').innerText"))),
    String(await cdp.eval("document.getElementById('lTitleCount').innerText")));

  // 真敲 80 个字符进去，看三件事同时发生：计数变红、总额度联动、亮点格报警
  const over = await cdp.eval(`(() => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
    set("lTitle", "A".repeat(40) + " " + "B".repeat(39));   // 80 字符
    const t = document.getElementById("lTitleCount");
    return { cls: t.className, text: t.innerText,
             hl: document.getElementById("lHighlightsCount").innerText,
             budget: document.getElementById("lBudgetCount").innerText };
  })()`);
  ck("80 字符标题 → 计数立刻变红（不用点按钮）", /\br\b/.test(String(over.cls)), JSON.stringify(over));
  ck("标题超限时 Highlights 那一格明说「提交不上去」", /提交不上去/.test(String(over.hl)), String(over.hl));
  ck("两段合计同步更新", /合计\s*80/.test(String(over.budget)), String(over.budget));

  const at75 = await cdp.eval(`(() => {
    const el = document.getElementById("lTitle");
    el.value = "A".repeat(75); el.dispatchEvent(new Event("input", { bubbles: true }));
    return document.getElementById("lTitleCount").className;
  })()`);
  ck("改回 75 字符 → 不再报警（边界不能差一个字符）", !/\br\b/.test(String(at75)), String(at75));

  // Highlights 自己的 125 上限也要实时报
  const hlOver = await cdp.eval(`(() => {
    const el = document.getElementById("lHighlights");
    el.value = "m".repeat(126); el.dispatchEvent(new Event("input", { bubbles: true }));
    return { cls: document.getElementById("lHighlightsCount").className, text: document.getElementById("lHighlightsCount").innerText };
  })()`);
  ck("Item Highlights 写 126 字符 → 该格变红", /\br\b/.test(String(hlOver.cls)), JSON.stringify(hlOver));

  // 真点「跑质检」，确认规则在浏览器里也命中（不是只有 Node 报了）
  const lint = await cdp.eval(`(() => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
    set("lTitle", "A".repeat(40) + " " + "B".repeat(39));
    set("lHighlights", "m".repeat(126));
    document.getElementById("btnLint").click();
    return document.getElementById("lintOut").innerText;
  })()`);
  ck("点「跑质检」→ P1（标题超限）当场命中", /P1\b/.test(String(lint)) && /上限 75/.test(String(lint)), String(lint).replace(/\s+/g, " ").slice(0, 200));
  ck("点「跑质检」→ P13（亮点超限）当场命中", /P13\b/.test(String(lint)) && /上限 125/.test(String(lint)), String(lint).replace(/\s+/g, " ").slice(0, 200));
  ck("质检面板把新 scope 的中文名渲染出来了",
    /Item Highlights/.test(String(lint)) && !/undefined/.test(String(lint)), String(lint).replace(/\s+/g, " ").slice(0, 300));

  // 切 media 口径：同样 150 字符的标题，判定必须反过来
  const media = await cdp.eval(`(() => {
    const sel = document.getElementById("lMedia");
    sel.value = "media"; sel.dispatchEvent(new Event("change", { bubbles: true }));
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
    set("lTitle", "A".repeat(150));
    set("lHighlights", "");
    const chip = document.getElementById("lTitleCount");
    document.getElementById("btnLint").click();
    return { chip: chip.innerText, chipCls: chip.className, out: document.getElementById("lintOut").innerText };
  })()`);
  ck("切到 media 口径 → 计数上限变成 200", /200/.test(String(media.chip)), JSON.stringify(media.chip));
  // 🔴 这条是"口径开关真的接进判据"的证据：同一个 150 字符标题，换个口径结论必须反过来。
  //    只改界面数字、判据还按 75 判，是这类改造最常见的假完成。
  // ⚠️ 注意断言必须打**判定结果那一行**，不能整段搜 "75" ——
  //    P1 自己的 why 里就写着"标题上限 75 字符（含空格，media 类目除外）"，
  //    整段搜会被这句解释文案命中而误报失败（第一次就是这么写错的）。
  // 打 detail 的格式本身（"150 字符 / 上限 200（media 类目）"），
  // 而不是"P1 到 detail 之间不超过 N 个字符" —— 后者会因为中间的标签文案变长而假失败。
  ck("media 口径下 150 字符标题改按 200 判（判据真的用上了 ctx.isMedia）",
    /\d+ 字符 \/ 上限 200（media 类目）/.test(String(media.out)),
    String(media.out).replace(/\s+/g, " ").slice(0, 200));

  // CSV 导出按钮：点了要有反馈，且说清它"不是官方模板"
  // 先填满三个必填（品牌 / 标题 / 至少三条五点），这样测的是「正常导出」这条路；
  // 「有缺口被拦住」是另一条路，下面单独测。
  const csv = await cdp.eval(`(() => {
    const sel = document.getElementById("lMedia"); sel.value = ""; sel.dispatchEvent(new Event("change", { bubbles: true }));
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
    set("lBrand", "Acme");
    set("lTitle", "Ceramic Mug 350ml"); set("lHighlights", "Ceramic, 350ml, for office");
    set("lBullets", "Ceramic body\\n350ml capacity\\nDishwasher safe");
    document.getElementById("btnExportCsv").click();
    return document.getElementById("csvOut").innerText;
  })()`);
  ck("点「导出 Flat File CSV」→ 有导出回执与列名", /amazon-flatfile-listing\.csv/.test(String(csv)) && /title_differentiation/.test(String(csv)), String(csv).replace(/\s+/g, " ").slice(0, 220));
  ck("CSV 回执说清了「不是可直接提交的官方模板」", /不是可直接提交|以你.*类目/.test(String(csv)), String(csv).replace(/\s+/g, " ").slice(0, 300));

  // 🆕 硬缺口必须**拦住**导出，而且是用界面内的一块面板拦，不是原生 confirm：
  //    原生对话框会阻塞渲染进程的 JS 线程（自检直接卡死，真实用户也会看到一条什么都说
  //    不清的确认框）。这里同时验证「拦住了」「给了仍然导出」「点了才真写」三点。
  const gate = await cdp.eval(`(() => {
    const b = document.getElementById("lBullets"); b.value = ""; b.dispatchEvent(new Event("input", { bubbles: true }));
    const out = document.getElementById("csvOut"); out.innerHTML = "";
    document.getElementById("btnExportCsv").click();
    return { text: out.innerText, hasForce: Boolean(document.getElementById("btnCsvForce")) };
  })()`);
  ck("有硬缺口时导出被拦下，并给出「仍然导出」按钮（不用原生 confirm）",
    !/已导出/.test(String(gate.text)) && /硬缺口/.test(String(gate.text)) && gate.hasForce === true,
    JSON.stringify(gate).replace(/\s+/g, " ").slice(0, 260));
  const forced = await cdp.eval(`(() => { document.getElementById("btnCsvForce").click(); return document.getElementById("csvOut").innerText; })()`);
  ck("点「仍然导出」才真的落盘，且缺口照样贴在回执里（不是导出后才想起来说）",
    /amazon-flatfile-listing\.csv/.test(String(forced)) && /硬缺口/.test(String(forced)),
    String(forced).replace(/\s+/g, " ").slice(0, 260));
  ck("导出这条路全程没弹过原生对话框（会阻塞页面线程）", cdp.dialogs.length === 0, cdp.dialogs.join(" | "));

  // 浏览器里直接跑一遍纯函数：证明导出内容在真实浏览器里也对（不只看界面文案）
  const csvBody = await cdp.eval(`(async () => {
    const m = await import("/assets/listing.js");
    const out = m.exportFlatFileCsv({ title: "Mug", bullets: ['He said "hi", then left'], highlights: "Ceramic, 350ml" }, { brand: "Acme" });
    return out.csv;
  })()`);
  ck("浏览器里导出的 CSV：表头是官方属性名、含逗号的字段被引号包住",
    /^item_name,title_differentiation,bullet1,/.test(String(csvBody)) && String(csvBody).includes('"He said ""hi"", then left"'),
    String(csvBody).replace(/\s+/g, " ").slice(0, 240));

  ck("标题新规这一段也没有未捕获异常", exceptions().length === 0, exceptions().join(" | "));

  /* ── 3d. 第 ⑦ 卡：竞品关键词 → 文案提示词（整合进来的那一半）──────────
   * 🔴 这一节里"抓取"是唯一联网动作，**允许失败**（亚马逊改页面结构 / 断网 / 限流
   *    都属正常）。但它**不允许"失败还假装成功"** —— 所以断言的核心是
   *    「状态文案 ↔ 表格内容」这条一致性不变量，而不是"必须抓到 30 条"。
   *    因此本节断言条数会随网络环境浮动；全绿的含义是"两种结局都诚实"。
   */
  console.log("\n3d. 第 ⑦ 卡（竞品关键词 → 文案提示词）");
  await cdp.eval("[...document.querySelectorAll('#nav button')].find(b=>b.dataset.view==='listing').click()");
  await wait(300);

  const navCount = await cdp.eval("document.querySelectorAll('#nav button').length");
  ck("第 ⑦ 卡加在视图内、没有为它新增导航视图（现为 8 个：7 个原有 + 本周词库）", navCount === 8, `实际 ${navCount} 个`);

  // 站点/类目/类型三个下拉都是**本地**填的（走 /api/competitor/categories），不依赖外网
  // ⑦ 现在收在页脚抽屉里：先展开（用户点一下就是这么做的），否则 innerText 全是空串。
  const cpOpen = await cdp.eval(`(()=>{const d=document.getElementById('drawerCp'); if(!d) return false; d.open=true; return true})()`);
  ck("竞品抓取抽屉能展开", cpOpen === true);
  const CP_IDS = ["cpSite", "cpCat", "cpSub", "cpKind", "cpIsMedia", "cpProduct",
                  "cpItems", "cpKwWrap", "cpKwOut", "cpStatus", "cpPromptOut",
                  "btnCpFetch", "btnCpAnalyze", "btnCpToCorpus", "btnCpGen", "btnCpCopy"];
  let cp = null;
  for (let i = 0; i < 20; i++) {
    cp = await cdp.eval(`(() => {
      const ids = ${JSON.stringify(CP_IDS)};
      const sel = (id) => { const e = document.getElementById(id); return e ? e.options.length : -1; };
      const s = document.getElementById("cpSite");
      return { miss: ids.filter((id) => !document.getElementById(id)),
               sites: sel("cpSite"), cats: sel("cpCat"), kinds: sel("cpKind"),
               firstSite: s && s.options[0] ? s.options[0].textContent : "" };
    })()`);
    if (cp && cp.miss.length === 0 && cp.sites === 8) break;
    await wait(300);
  }
  ck("⑦ 卡的 16 个控件一个不少（缺一个界面就是残缺的）", cp && cp.miss.length === 0, JSON.stringify(cp && cp.miss));
  ck("站点下拉被服务端清单填满（8 个站点）", cp && cp.sites === 8, `实际 ${cp && cp.sites}`);
  ck("类目下拉被服务端清单填满（不是空下拉，空下拉点不动）", cp && cp.cats > 10, `实际 ${cp && cp.cats}`);
  ck("文案提示词类型下拉有 5 类（来自 PROMPT_KINDS，不是手写 option）", cp && cp.kinds === 5, `实际 ${cp && cp.kinds}`);
  ck("站点下拉显示的是「中文站名 + 主机」，不是站点代码 com/de",
    cp && /站（.*amazon/.test(String(cp.firstSite)), String(cp && cp.firstSite));

  // 守卫：缺输入必须给可读错误，**绝不**产出一份空提示词让用户去复制
  const cpGuard1 = await cdp.eval(`(() => {
    document.getElementById("cpProduct").value = "";
    document.getElementById("btnCpGen").click();
    return { t: document.getElementById("cpPromptOut").innerText,
             pre: document.querySelectorAll("#cpPromptOut pre").length };
  })()`);
  ck("没填产品名就点「生成提示词」→ 给可读错误，且不产出空提示词",
    /先把产品名填上/.test(String(cpGuard1.t)) && cpGuard1.pre === 0, JSON.stringify(cpGuard1).slice(0, 160));

  const cpGuard2 = await cdp.eval(`(() => {
    document.getElementById("cpProduct").value = "蒙氏忙碌板";
    document.getElementById("btnCpGen").click();
    return { t: document.getElementById("cpPromptOut").innerText,
             pre: document.querySelectorAll("#cpPromptOut pre").length };
  })()`);
  ck("还没抓竞品就点生成 → 如实说「请先抓取竞品」，不编一份提示词出来",
    /请先抓取竞品|建议先跑一次关键词权重分析/.test(String(cpGuard2.t)) && cpGuard2.pre === 0,
    JSON.stringify(cpGuard2).slice(0, 160));

  // 浏览器里直接跑纯函数：证明文案提示词在真实浏览器里也对，不只看界面文案
  const cpPure = await cdp.eval(`(async () => {
    const m = await import("/assets/copy-prompts.js");
    const items = [{ rank: 1, title: "Montessori Busy Board for Toddlers", rating: 4.7, reviews: 1280, price: "$25.99" }];
    const rows = [{ term: "busy board", useRate: 100, cov: 1, total: 1, avgPos: 1, weight: 9, advice: "写进标题" }];
    const base = { product: "Montessori Busy Board", items, rows };
    const a = m.buildCopyPrompt("title", { ...base, isMedia: false });
    const b = m.buildCopyPrompt("title", { ...base, isMedia: true });
    const st = m.buildCopyPrompt("searchTerms", base);
    return { aOk: !!a.ok, aCap: a.meta && a.meta.titleCap,
             a75: /严格 ≤75 字符/.test(a.prompt), a125: /严格 ≤125 字符/.test(a.prompt),
             bCap: b.meta && b.meta.titleCap, b200: /严格 ≤200 字符/.test(b.prompt),
             // ⚠️ 这里**不能**用 /75/ 判"有没有 75" —— media 版里**本来就有**一个 75，
             //    在否定句里（"不要套用非媒体类目的 75 字符上限"）。要锁的是**硬上限那句**。
             //    （这个坑在 selftest 第 25 节 K 已经踩过一次，别再犯。）
             bNoHard75: !/严格 ≤75 字符/.test(b.prompt),
             bWarnsAgainst75: /不要.{0,4}套用非媒体类目的 75 字符上限/.test(b.prompt),
             stBytes: /250 \\*\\*字节\\*\\*/.test(st.prompt),
             kinds: m.PROMPT_KINDS.map((k) => k.id) };
  })()`);
  ck("文案提示词模块在浏览器里也能跑（不是只在 Node 里过）",
    cpPure && cpPure.aOk && cpPure.aCap === 75, JSON.stringify(cpPure && { ok: cpPure.aOk, cap: cpPure.aCap }));
  ck("非媒体口径写 75 上限，同时给出 Item Highlights 的 125",
    cpPure && cpPure.a75 && cpPure.a125, JSON.stringify(cpPure && { a75: cpPure.a75, a125: cpPure.a125 }));
  ck("媒体口径改成 200，且不再出现 75 的**硬上限句**（口径开关真的接进了文案层）",
    cpPure && cpPure.bCap === 200 && cpPure.b200 && cpPure.bNoHard75,
    JSON.stringify(cpPure && { cap: cpPure.bCap, b200: cpPure.b200, bNoHard75: cpPure.bNoHard75 }));
  ck("媒体口径还额外提醒「别把非媒体的 75 套过来」（只改数字不写这句，模型会自己混用两套口径）",
    cpPure && cpPure.bWarnsAgainst75, String(cpPure && cpPure.bWarnsAgainst75));
  ck("后台搜索词按**字节**计数（平台口径；按字符算中文会超 3 倍）",
    cpPure && cpPure.stBytes, String(cpPure && cpPure.stBytes));
  ck("五类提示词 id 齐备且顺序稳定",
    cpPure && cpPure.kinds.join(",") === "analysis,title,bullets,searchTerms,localize",
    JSON.stringify(cpPure && cpPure.kinds));

  // 真点一次抓取：允许失败，但必须"诚实"
  const cpFetch = await cdp.eval(`(async () => {
    const sel = document.getElementById("cpCat");
    const opt = [...sel.options].find((o) => o.value === "toys-and-games") || sel.options[0];
    sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("btnCpFetch").click();
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const st = document.getElementById("cpStatus").innerText;
      if (st && !/正在抓取/.test(st)) break;
    }
    return { status: document.getElementById("cpStatus").innerText,
             rows: document.querySelectorAll("#cpItems tbody tr").length,
             emptyNote: /还没抓取/.test(document.getElementById("cpItems").innerText) };
  })()`);

  const got = /抓到 (\d+) 条/.exec(String(cpFetch.status));
  if (got) {
    const n = Number(got[1]);
    ck("抓取成功：状态说的条数与表格实际行数一致（文案不许比数据多）",
      n === cpFetch.rows && n > 0, `状态=${n} 表格=${cpFetch.rows}`);
    ck("抓取成功：表头带榜单名次/评论数/价格（是真实抓下来的字段，不是占位）",
      await cdp.eval(`(()=>{const t=document.getElementById("cpItems").innerText;return /评论数/.test(t)&&/价格/.test(t)&&/星级/.test(t)})()`));
    ck("抓取成功：状态标明这一屏是实时还是缓存（不许含糊）",
      /实时|缓存/.test(String(cpFetch.status)), String(cpFetch.status).slice(0, 120));
    // 🔴 本机 IP 在中国，不显式带 i18n cookie 时亚马逊会返回 CNY 价 —— 这条锁死那个修复
    const prices = await cdp.eval(`[...document.querySelectorAll("#cpItems tbody tr")].map(r=>r.children[4].innerText)`);
    ck("价格是美元（不带 i18n cookie 会整列变成 CNY，那是本机 IP 导致的假数据）",
      // 不能要求每一行都以 $ 开头：无价商品 / 广告位在结果页里就是「—」，属正常显示。
      // 真正的判据是：① 至少出现一个美元价；② 整列不出现 ¥ / ￥ / CNY。
      prices.length > 0
        && prices.some((p) => /^\$/.test(String(p)))
        && !prices.some((p) => /[¥￥]|CNY/.test(String(p))),
      JSON.stringify(prices.slice(0, 6)));

    // 关键词权重：纯本地算，断网也能跑
    await cdp.eval("document.getElementById('btnCpAnalyze').click()");
    await wait(500);
    const kw = await cdp.eval(`(() => {
      const t = document.getElementById("cpKwOut").innerText;
      return { t, rows: document.querySelectorAll("#cpKwOut tbody tr").length,
               shown: document.getElementById("cpKwWrap").style.display !== "none",
               covs: [...document.querySelectorAll("#cpKwOut tbody tr")].slice(0, 40).map((r) => r.children[3].innerText) };
    })()`);
    ck("点「算关键词权重」→ 表渲染出来且列名齐全",
      /权重/.test(kw.t) && /用法建议/.test(kw.t) && /平均位置/.test(kw.t) && kw.rows > 0 && kw.shown,
      JSON.stringify({ rows: kw.rows, shown: kw.shown }).slice(0, 120));
    ck("权重表只保留出现 ≥2 条的词（出现 1 次是噪声，进了表就是没按规则过滤）",
      kw.covs.length > 0 && kw.covs.every((c) => Number(String(c).split("/")[0]) >= 2),
      JSON.stringify(kw.covs.slice(0, 8)));
    ck("权重分落在 1–10 且保留一位小数（界面上不许出现 0 分或 11 分）",
      await cdp.eval(`[...document.querySelectorAll("#cpKwOut tbody tr")].every(r=>{const w=parseFloat(r.children[5].innerText);return w>=1&&w<=10})`),
      await cdp.eval(`[...document.querySelectorAll("#cpKwOut tbody tr")].slice(0,8).map(r=>r.children[5].innerText).join(",")`));
    // 状态里报的条数必须与"真实算出来的条数"一致 —— 表格为了可读截断到 40 行，
    // 所以对不上 40 的时候要看是不是"被截断了"，不是"数错了"。
    const kwStat = /关键词 (\d+) 条 · 空白机会 (\d+) 条/.exec(String(await cdp.eval("document.getElementById('cpStatus').innerText")));
    ck("「算关键词权重」后状态如实报出关键词条数与空白机会条数",
      Boolean(kwStat), String(await cdp.eval("document.getElementById('cpStatus').innerText")).slice(0, 140));
    ck("状态条数与表格行数吻合（>40 视为表格截断，不算不一致）",
      kwStat && (Number(kwStat[1]) === kw.rows || (Number(kwStat[1]) > 40 && kw.rows === 40)),
      `状态=${kwStat && kwStat[1]} 表格=${kw.rows}`);

    // 生成提示词：这一条是"整条链子真的通了"的最终证据
    const gen = await cdp.eval(`(() => {
      const sel = document.getElementById("cpKind");
      sel.value = "title"; sel.dispatchEvent(new Event("change", { bubbles: true }));
      document.getElementById("cpProduct").value = "Montessori Busy Board";
      document.getElementById("btnCpGen").click();
      const pre = document.querySelector("#cpPromptOut pre");
      const head = document.getElementById("cpPromptOut").innerText.split("\\n")[0];
      return { hasPre: !!pre, head, body: pre ? pre.innerText : "" };
    })()`);
    ck("有真实竞品数据后点「生成提示词」→ 真的产出提示词（不再报错）", gen.hasPre, String(gen.head).slice(0, 160));
    ck("回执里摊开了条数/权重词数/标题上限这几个数",
      /竞品 \d+ 条/.test(String(gen.head)) && /权重词 \d+ 个/.test(String(gen.head)) && /标题上限 75/.test(String(gen.head)),
      String(gen.head).slice(0, 200));
    ck("提示词带着工具算好的权重表，并明确要求模型「直接采用、不要自己重算」",
      /直接采用这个结论，不要自己重算/.test(gen.body), gen.body.slice(0, 200));
    ck("提示词里的标题上限跟当前口径一致（非 media = 75 / 亮点 125 / 合计 200）",
      /严格 ≤75 字符/.test(gen.body) && /严格 ≤125 字符/.test(gen.body) && /合计不超过 200 字符/.test(gen.body),
      gen.body.replace(/\s+/g, " ").slice(0, 200));
    const topN = /Top (\d+) 的标题/.exec(gen.body);
    ck("提示词里嵌的竞品样本条数与抓到的条数一致（不是空样本区）",
      topN && Number(topN[1]) === n, `提示词=${topN && topN[1]} 抓到=${n}`);

    // 送进上方语料框 → 与既有「多竞品共识」链打通
    await cdp.eval("document.getElementById('btnCpToCorpus').click()");
    await wait(300);
    const corpus = String(await cdp.eval("document.getElementById('lCorpus').value"));
    ck("点「把标题送进竞品语料」→ 真写进上方语料框（--- 分隔，条数对得上）",
      corpus.split("---").length === n, `语料 ${corpus.split("---").length} 段 vs 抓到 ${n} 条`);
    ck("送完语料后照实回报（用户知道下一步该点哪儿）",
      /竞品语料/.test(String(await cdp.eval("document.getElementById('cpStatus').innerText"))),
      String(await cdp.eval("document.getElementById('cpStatus').innerText")).slice(0, 140));
  } else {
    ck("抓取失败时界面**如实报错**，不是静默无响应",
      /抓取失败/.test(String(cpFetch.status)), String(cpFetch.status).slice(0, 200));
    ck("抓取失败时表格里没有伪造数据（只留「还没抓取」提示，不摆假行）",
      cpFetch.rows === 0 && cpFetch.emptyNote, JSON.stringify(cpFetch).slice(0, 200));
    console.log("  ℹ️ 本次抓取未成功（外网或亚马逊侧原因）—— 已按「如实报错」验收，未计为失败。");
  }
  ck("第 ⑦ 卡这一段也没有未捕获异常", exceptions().length === 0, exceptions().join(" | "));

  // 采集页：喂一个搜索结果页载荷，验证"整页 → 多竞品对比"这条闭环真的通
  console.log("\n4. 采集 → 多竞品对比闭环（真点按钮）");
  await cdp.eval("[...document.querySelectorAll('#nav button')].find(b=>b.dataset.view==='capture').click()");
  await wait(300);
  await cdp.eval(`(()=>{
    const payload = { kind:"search", url:"https://www.amazon.de/s?k=kissen", site:"amazon.de", keyword:"kissen",
      items:[
        {asin:"B0AAAAAAA1",title:"Kissen für Sofa Kissenbezug 40x40",text:"Kissen für Sofa Kissenbezug 40x40",sponsored:false},
        {asin:"B0AAAAAAA2",title:"Kissen für Bett Kissenbezug 80x80",text:"Kissen für Bett Kissenbezug 80x80",sponsored:false}
      ],
      stats:{blocks:2,parsed:2,sponsored:0,withAsin:2} };
    document.getElementById("pasteBox").value = JSON.stringify(payload);
    document.getElementById("btnParse").click();
  })()`);
  await wait(600);
  const capOut = String(await cdp.eval("document.getElementById('captureOut').innerText"));
  ck("搜索结果被解析成整页商品表（不是空表）", /B0AAAAAAA1/.test(capOut) && /2\s*商品/.test(capOut.replace(/\s+/g, " ")), capOut.slice(0, 120));
  ck("概览统计给出了价格中位数", /价格中位数/.test(capOut));
  ck("提示了「搜索页没有五点与描述」的边界", /没有五点/.test(capOut));

  await cdp.eval("document.getElementById('btnSearchToCompare').click()");
  await wait(700);
  const cmp = String(await cdp.eval("document.getElementById('compareOut').innerText"));
  const lang = await cdp.eval("document.getElementById('lLang').value");
  ck("一键跳到了 Listing 页并跑出了对比结果", /全类目共识词/.test(cmp), cmp.slice(0, 120));
  ck("整页真的被填进了竞品框（--- 分隔）", /---/.test(String(await cdp.eval("document.getElementById('lCorpus').value"))));
  ck("站点语种被自动带成德语（否则 für/mit 会被当关键词）", lang === "de", `lang=${lang}`);
  ck("共识词里有实词、没有德语虚词", /kissen/i.test(cmp) && !/「für」|für\s*<\/?/.test(cmp.replace(/[\s\S]*?全类目共识词/, "")), cmp.slice(0, 200));
  ck("这一步也没有未捕获异常", exceptions().length === 0, exceptions().join(" | "));

  // 头部词频
  await cdp.eval("document.getElementById('btnMine').click()");
  await wait(500);
  ck("整页作为竞品语料也能跑词频", /Top1/.test(String(await cdp.eval("document.getElementById('mineOut').innerText"))));

  /* ── 4a1. 语料为空时的词频挖掘：说清原因，而不是点了没反应 ──────
   * 先备份语料、清空、点按钮、断言，再把语料写回去 —— 后面的用例还要用它。 */
  {
    const keepCorpus = String(await cdp.eval("document.getElementById('lCorpus').value"));
    await cdp.eval(`(()=>{
      const t=document.getElementById('lCorpus');
      t.value=''; t.dispatchEvent(new Event('input',{bubbles:true}));
      document.getElementById('mineOut').innerHTML='';
      document.getElementById('btnMine').click();
    })()`);
    await wait(400);
    const mineEmpty = String(await cdp.eval("document.getElementById('mineOut').textContent"));
    ck("🔴 语料为空时点「词频挖掘」→ 给出原因与下一步（不再静默 return）",
      /还没有语料/.test(mineEmpty) && /类目语料/.test(mineEmpty), mineEmpty.slice(0, 160));
    ck("并且不产出任何词条 chip（空输入不许凑一张空表出来）",
      (await cdp.eval("document.querySelectorAll('#mineOut .chip').length")) === 0);
    await cdp.eval(`(()=>{
      const t=document.getElementById('lCorpus');
      t.value=${JSON.stringify(keepCorpus)}; t.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
  }

  /* ── 4a2. 本周词库：**没有数据时必须说清"还没生成"** ──
   * 本脚本把 LISTING_KEYWORDS 指到一个空的临时目录（见起服务处），所以这里必然是"没有快照"。
   * 这条断言要的不是"能显示数字"，而是**三种状态别混成一句"加载失败"**：
   *   没有词库 → 告诉你去跑采集器；词库过期 → 告诉你别当本周数据用；正常 → 显示数量。
   * 一句话都是错的那句"加载失败"，因为它不指向任何下一步动作。 */
  await cdp.eval("document.getElementById('btnLoadVault').click()");
  await wait(700);
  const vaultTxt = String(await cdp.eval("document.getElementById('vaultOut').innerText"));
  ck("没有词库时界面说「暂时没有词库」并给出下一步（不是含混的「加载失败」）",
    /暂时没有词库/.test(vaultTxt) && /collect-keywords|Actions/.test(vaultTxt), vaultTxt.slice(0, 200));
  ck("读词库这条路没有未捕获异常", exceptions().length === 0, exceptions().join(" | "));

  /* ── 4a3. 本周词库体检卡（G-3）：**数据不新 / 不全 / 没验证，界面必须说出来** ──
   * 造一份"样样都不好"的快照当输入，比用真实快照可靠 —— 真实快照今天是新鲜的，
   * 那么"陈旧要提示"这条断言就永远测不到（状态依赖，不是产品行为）。
   * 这份数据刻意同时踩四个坑：15 天没更新（stale）、价格只有 1/3、有词没归词根、超 300 条截断。 */
  const kwDir = path.join(TMP_DATA, "keywords");
  fs.mkdirSync(kwDir, { recursive: true });
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const filler = Array.from({ length: 317 }, (_, i) => ({
    term: `kw ${String(i).padStart(3, "0")}`, roots: ["filler"], groups: ["home"],
    rootCount: 1, hits: 1, firstSeen: daysAgo(40), lastSeen: daysAgo(15).slice(0, 10),
    recurring: true, newly: "stable",
  }));
  fs.writeFileSync(path.join(kwDir, "latest.json"), JSON.stringify({
    schema: 1, site: "US", market: "US", generatedAt: daysAgo(15),
    keywords: [
      { term: "zebra mat", roots: ["mat"], groups: ["home"], rootCount: 9, hits: 9, firstSeen: daysAgo(40), lastSeen: daysAgo(15).slice(0, 10), recurring: false, newly: "new" },
      { term: "alpha cup", roots: ["cup"], groups: ["kitchen"], rootCount: 5, hits: 5, firstSeen: daysAgo(40), lastSeen: daysAgo(15).slice(0, 10), recurring: false, newly: "returned", returnedFrom: daysAgo(60).slice(0, 10) },
      { term: "middle bowl", roots: ["bowl"], groups: [], rootCount: 2, hits: 2, firstSeen: daysAgo(40), lastSeen: daysAgo(15).slice(0, 10), recurring: true, newly: "stable" },
      ...filler,
    ],
    asins: [
      { asin: "B000000001", title: "a", category: "home", group: "home", rank: 1, price: "$9.99", rating: "4.5", reviewCount: "10", url: "https://www.amazon.com/dp/B000000001" },
      { asin: "B000000002", title: "b", category: "home", group: "home", rank: 2, price: "", rating: "4.6", reviewCount: "11", url: "https://www.amazon.com/dp/B000000002" },
      { asin: "B000000003", title: "c", category: "home", group: "home", rank: 3, price: "", rating: "4.7", reviewCount: "12", url: "https://www.amazon.com/dp/B000000003" },
    ],
    sources: {
      suggest: { status: "ok", requests: 7, ok: 7, empty: 0, failed: 0, skipped: 0,
        budget: 8, budgetSource: "derived", rootsPlanned: 6, rootsRun: 6,
        deepPlanned: 2, deepCandidates: 2, deepAttempted: 1, deepSkippedDuplicate: 1 },
      bestsellers: { status: "ok" },
    },
    summary: { keywordCount: 320, asinCount: 3, newKeywordCount: 2, droppedKeywordCount: 0,
      firstTimeCount: 1, returnedCount: 1, returnedUnknown: false, note: "" },
  }));
  // 采集状态：**上次失败、上次成功在 15 天前** —— 这才是"词库为什么不新"的证据。
  fs.writeFileSync(path.join(kwDir, "_status.json"), JSON.stringify({
    ok: false, reason: "HTTP 503", exitCode: 2,
    lastAttemptAt: daysAgo(1), lastSuccessAt: daysAgo(15), durationMs: 42000, host: "test-box",
  }));

  await cdp.eval("document.getElementById('btnLoadVault').click()");
  await wait(700);
  const card = String(await cdp.eval("document.getElementById('vaultOut').innerText"));
  ck("陈旧 15 天时卡片明确写出「新鲜度 stale（15 天）」并给出去处",
    /新鲜度\s*stale（15 天）/.test(card) && /没更新/.test(card), card.slice(0, 240));
  ck("采集失败要说失败原因，并保留「上次成功」时间（否则只看到一行红字，判断不了烂了多久）",
    /上次采集失败：HTTP 503/.test(card) && /上次成功/.test(card), card.slice(0, 240));
  ck("价格字段只有 1/3 时点名「价格字段 33%」并说清后果（不能静默）",
    /价格字段\s*33%/.test(card) && /价格字段只有 33%/.test(card), card.slice(0, 300));
  ck("超过 300 条要说「取了前 300 条、不是只有这么多」",
    /共 320 条/.test(card) && /取了前 300 条/.test(card), card.slice(0, 300));
  ck("有词没归到词根、预算没跑满，各有一行（这两条最容易被忽略）",
    /1 个词没归到任何词根/.test(card) && /请求 7\/8 次/.test(card), card.slice(0, 300));
  ck("首次 / 回归分开报（不把回归词算成新需求）",
    /首次\s*1/.test(card) && /回归\s*1/.test(card), card.slice(0, 200));

  // G-7：三个排序 tab 真的重新取数（不是只改高亮）。
  const tabN = await cdp.eval("document.querySelectorAll('#vaultOut [data-vsort]').length");
  ck("界面上有 roots / new / az 三个排序切换", tabN === 3, `tabs=${tabN}`);
  const firstKw = () => cdp.eval(`(() => {
    const c = [...document.querySelectorAll('#vaultOut .chip')].filter((e) => String(e.title).startsWith('词根'));
    return c.length ? c[0].innerText.trim() : '';
  })()`);
  const before = await firstKw();
  await cdp.eval("document.querySelector('#vaultOut [data-vsort=\"az\"]').click()");
  await wait(700);
  const after = await firstKw();
  const active = await cdp.eval("document.querySelector('#vaultOut [data-vsort=\"az\"]').className");
  ck("切到字母序后首词从价值序变成 alpha cup（证明真的重新取了数，不只是改高亮）",
    /^zebra mat/.test(before) && /^alpha cup/.test(after) && /primary/.test(active),
    `${before} → ${after} / ${active}`);
  ck("体检卡这一路没有未捕获异常", exceptions().length === 0, exceptions().join(" | "));

  /* ── 4b. 原生下拉的替身（原生 popup 的位置页面改不了，见 assets/select-ui.js 文件头）──
   * 这一节测的正是当初那个 bug 的判据：弹层必须**紧贴触发按钮**且**完全在视口内**。
   * 原生下拉做不到这一点（实测偏移 (−938,−194) / (−518,−272)），所以只能自己画。 */
  console.log("\n4b. 下拉替身（紧贴按钮 + 不出视口）");
  const selN = await cdp.eval(`({ sels: document.querySelectorAll('select.in').length,
                                   ui: document.querySelectorAll('.selui').length,
                                   btns: document.querySelectorAll('.selui-btn').length })`);
  // 🔴 断言的是**不变量**（每个 select.in 都有自己的自绘控件），不是"正好 10 个"：
  //    写死数量的话，以后加一个下拉就会红，而红的原因跟"下拉没被接管"毫无关系 ——
  //    这种红只会教会人忽略红色。下限 10 用来兜住"整块被删掉"。
  ck("页面上每个 select.in 都被自绘控件接管（不靠写死 id）",
    selN.sels >= 10 && selN.sels === selN.ui && selN.ui === selN.btns, JSON.stringify(selN));

  const popPos = await cdp.eval(`(async () => {
    const sel = document.getElementById('lLang');
    const btn = sel.parentNode.querySelector('.selui-btn');
    btn.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 150));
    const b = btn.getBoundingClientRect();
    btn.click();
    await new Promise((r) => setTimeout(r, 250));
    const p = document.querySelector('.selpop');
    if (!p) return { open: false };
    const r = p.getBoundingClientRect();
    return { open: true,
             dx: Math.round(r.x - b.x),
             gapBelow: Math.round(r.y - b.bottom),
             gapAbove: Math.round(b.top - r.bottom),
             inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
             onBody: p.parentElement === document.body };
  })()`);
  ck("点按钮能弹出下拉", popPos.open === true);
  ck("🔴 弹层挂在 body 上（不被任何祖先 overflow 裁切）", popPos.onBody === true);
  ck("🔴 弹层紧贴触发按钮（横向 ≤2px、纵向 ≤8px，不飞走）",
    Math.abs(popPos.dx) <= 2 && (Math.abs(popPos.gapBelow) <= 8 || Math.abs(popPos.gapAbove) <= 8),
    `dx=${popPos.dx} 下=${popPos.gapBelow} 上=${popPos.gapAbove}`);
  ck("🔴 弹层完全落在视口内", popPos.inView === true);

  const selPick = await cdp.eval(`(async () => {
    const sel = document.getElementById('lLang');
    const before = sel.value;
    const p = document.querySelector('.selpop');
    const item = [...p.querySelectorAll('.opt')].find((o) => o.dataset.v === 'fr');
    item.click();
    await new Promise((r) => setTimeout(r, 200));
    return { before, after: sel.value, gone: !document.querySelector('.selpop'),
             btn: sel.parentNode.querySelector('.selui-txt').textContent };
  })()`);
  ck("选中后 select.value 真的变了（原有取值代码一行不用改）",
    selPick.after === 'fr', `${selPick.before} → ${selPick.after}`);
  ck("选中后弹层自动关闭", selPick.gone === true);
  ck("按钮文字跟着变", /法语/.test(String(selPick.btn)), String(selPick.btn));

  // 程序直接赋值（设置页「恢复默认」就是这条路）不会触发 change，按钮文字也必须跟上
  const progLabel = await cdp.eval(`(() => {
    const s = document.getElementById('lLang');
    s.value = 'ja';
    return s.parentNode.querySelector('.selui-txt').textContent;
  })()`);
  ck("程序赋值 select.value 也会刷新按钮文字", /日语/.test(String(progLabel)), String(progLabel));

  // 复原，避免影响后面的断言
  await cdp.eval(`(() => { const s = document.getElementById('lLang'); s.value = 'de';
                   s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  ck("这一步没有未捕获异常", exceptions().length === 0, exceptions().join(" | "));

  /* ── 5. 浏览器侧自检页（IndexedDB 真往返只有这里能测）────── */
  console.log("\n5. 浏览器侧自检页（本地产物 + 解析 + 书签脚本）");
  await goto(`http://127.0.0.1:${PORT}/assets/selftest-browser.html`);
  let smoke = "";
  for (let i = 0; i < 60; i++) {
    smoke = String(await cdp.eval("document.getElementById('out').innerText"));
    if (/共 \d+ 条/.test(smoke)) break;
    await wait(500);
  }
  for (const line of smoke.split("\n")) {
    if (line.startsWith("✓")) ck(line.slice(2), true);
    else if (line.startsWith("✗")) ck(line.slice(2), false);
  }
  ck("浏览器侧自检确实跑完了（不是卡在 running…）", /共 \d+ 条/.test(smoke), smoke.slice(0, 80));
  ck("自检页没有未捕获异常", exceptions().length === 0, exceptions().join(" | "));

  const summary = /共 (\d+) 条：通过 (\d+)，失败 (\d+)/.exec(smoke);
  if (summary) ck("浏览器侧自检失败 0 条", Number(summary[3]) === 0, summary[0]);
} catch (e) {
  fail++;
  console.log(`  ✗ 自检中断：${e.message}`);
} finally {
  cdp?.close();
  br.kill();
  srv.kill();
  await wait(400);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
}

/* ── 6. UI 改造固化（静态源码断言，只读、不依赖 CDP）──────────────────
 * 把 2026-11-08「本周词库」6 组折叠改造里那些「改了不会立刻报错、过两周没人发现」
 * 的结构性事实钉死：8 视图 / 折叠区默认收起 / 24 个 id / loadWords 默认请求逐字节原样。
 * 🔴 断言只增不减；任何一条不成立都如实 FAIL —— 不改实现去迁就断言、不写成恒真。
 *    放在 try/finally 之后，这样即便浏览器那一侧中断，这一节照样计数。
 */
console.log("\n6. UI 改造固化（静态源码断言）");
const HTML_SRC = fs.readFileSync(path.join(HERE, "index.html"), "utf8");
const APP_SRC = fs.readFileSync(path.join(HERE, "assets", "app.js"), "utf8");

/** 截一个顶层函数的源码体（到下一个顶层 function 声明为止），用来判断「某请求在不在它里面」。 */
const fnBody = (name) => {
  let i = -1;
  for (const s of [`async function ${name}(`, `function ${name}(`]) {
    i = APP_SRC.indexOf(s);
    if (i >= 0) break;
  }
  if (i < 0) return "";
  const ends = ["\nasync function ", "\nfunction "].map((s) => {
    const k = APP_SRC.indexOf(s, i + 10);
    return k < 0 ? APP_SRC.length : k;
  });
  return APP_SRC.slice(i, Math.min(...ends));
};
const LW = fnBody("loadWords");
/** <details> 上是否真的写了独立的 open 属性（不把 data-open 之类误判进去） */
const hasOpenAttr = (tag) => /\sopen(?=[\s/>])/.test(tag);

/* 6.1 视图数恰好 8；词库是独立的第 8 个一等页面；不许出现第 9 个视图 */
const sectionViews = [...HTML_SRC.matchAll(/<section[^>]*class="view[^"]*"[^>]*data-view="([^"]+)"/g)].map((m) => m[1]);
const viewNames = [...new Set([...HTML_SRC.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]))];
ck("6.1 <section> 视图恰好 8 个（不许出现第 9 个视图）", sectionViews.length === 8,
  `实际 ${sectionViews.length} 个：${sectionViews.join(",")}`);
ck("6.1 全页 data-view 唯一名字也是 8 个（nav 与 section 不各带一套）", viewNames.length === 8,
  `实际 ${viewNames.length} 个：${viewNames.join(",")}`);
ck("6.1 8 个视图里含「本周词库」words（新增的第 8 个一等页面）",
  viewNames.includes("words") && sectionViews.includes("words"));
ck("6.1 words 在导航里是独立入口（不是寄生在 listing 抽屉里）",
  /<button[^>]*data-view="words"/.test(HTML_SRC));

/* 6.2 6 个折叠区存在且默认收起 */
const DRAWERS = ["dWCover", "dWCompare", "dWAsin", "dWSite", "dWRoots", "dWExport"];
ck("6.2 词库页 6 个 <details> 的 id 全部存在",
  DRAWERS.every((id) => new RegExp(`id="${id}"`).test(HTML_SRC)),
  `缺失：${DRAWERS.filter((id) => !new RegExp(`id="${id}"`).test(HTML_SRC)).join(",")}`);
ck("6.2 这 6 个 <details> 全部默认收起（不带 open 属性）",
  DRAWERS.every((id) => {
    const m = new RegExp(`<details[^>]*id="${id}"[^>]*>`).exec(HTML_SRC);
    return m && !hasOpenAttr(m[0]);
  }));
ck("6.2 全页带 open 属性的 <details> 数量为 0",
  [...HTML_SRC.matchAll(/<details([^>]*)>/g)].filter((m) => hasOpenAttr(m[1])).length === 0);

/* 6.3 24 个新增 id 逐个存在（不是只数个数） */
const NEW_IDS = [
  "wordsExtras", "dWCover", "dWCompare", "dWAsin", "dWSite", "dWRoots", "dWExport",
  "btnWCoverRun", "wCoverOut", "wCompareOut", "wAsinOut", "wSiteSel", "wSiteNote",
  "wRootAdd", "wRootAddGroup", "btnWRootAdd", "wRootDel", "btnWRootDel", "btnWRootSave",
  "wRootsMsg", "wRootsOut", "btnWExpKeywords", "btnWExpAsins", "wExpOut",
];
for (const id of NEW_IDS) ck(`6.3 id="${id}" 在 index.html 真实存在`, new RegExp(`id="${id}"`).test(HTML_SRC));

/* 6.4 6 个新按钮都有事件绑定（防「HTML 有按钮、JS 没反应」） */
const NEW_BUTTONS = ["btnWCoverRun", "btnWRootAdd", "btnWRootDel", "btnWRootSave", "btnWExpKeywords", "btnWExpAsins"];
ck("6.4 6 个新按钮都以 \"#id\" 字面量出现在 app.js（selftest 2311 口径）",
  NEW_BUTTONS.every((id) => APP_SRC.includes(`"#${id}"`)),
  `缺：${NEW_BUTTONS.filter((id) => !APP_SRC.includes(`"#${id}"`)).join(",")}`);
ck("6.4 6 个新按钮都挂了 on(\"#id\", handler) 的 click 绑定",
  NEW_BUTTONS.every((id) => new RegExp(`on\\("#${id}"\\s*,`).test(APP_SRC)),
  `未绑定：${NEW_BUTTONS.filter((id) => !new RegExp(`on\\("#${id}"\\s*,`).test(APP_SRC)).join(",")}`);
ck("6.4 S-3 / G-4 由 <details> 的 toggle 驱动取数（不挂在 loadWords 上）",
  /toggleLoad\("#dWCompare"\s*,\s*loadWordsCompare\)/.test(APP_SRC) &&
  /toggleLoad\("#dWRoots"\s*,\s*loadRootsPanel\)/.test(APP_SRC));

/* 6.5 loadWords() 的默认请求行逐字节保持 */
const DEFAULT_REQ = 'apiUrl(`/api/keywords?limit=${W_LIMIT}&sort=${sort}` + (q ? `&q=${encodeURIComponent(q)}` : ""))';
ck("6.5 loadWords() 默认请求行逐字节保持（limit/sort + 可选 q）", LW.includes(DEFAULT_REQ),
  `loadWords 函数体长度 ${LW.length}`);
ck("6.5 默认路径里没有夹带 compare / site / roots / export 参数",
  !/(compare|site|roots|export)\s*=/.test(LW));
ck("6.5 loadWords() 里只有一次 fetch（默认那一次）",
  (LW.match(/fetch\(/g) || []).length === 1, `实际 ${(LW.match(/fetch\(/g) || []).length} 次`);

/* 6.6 5 个新增请求都不在 loadWords 默认路径，且各在对应触发函数里 */
ck("6.6 S-2 的 q=&limit=500 只在 runWordsCoverage() 里、不在 loadWords()",
  /q=&limit=500/.test(fnBody("runWordsCoverage")) && !/q=&limit=500/.test(LW));
// 🔴 判据必须是「真实 fetch 调用」，不能用全文件字面串计数：
//    S-3 函数头注释里也写了 `/api/keywords?compare=prev`，那是说明文字不是请求。
//    首跑用字面串计数误报过一次，改成只数 fetch(apiUrl(...compare=prev...)) 更严也更准。
ck("6.6 S-3 的 ?compare=prev 只有 1 处真实 fetch、只在 loadWordsCompare() 里、不在 loadWords()",
  (APP_SRC.match(/fetch\(apiUrl\([^)]*compare=prev/g) || []).length === 1 &&
  /compare=prev/.test(fnBody("loadWordsCompare")) && !/compare=prev/.test(LW),
  `真实 fetch ${(APP_SRC.match(/fetch\(apiUrl\([^)]*compare=prev/g) || []).length} 处`);
ck("6.6 G-4 的 /api/keyword-roots 只在 loadRootsPanel() / saveRoots() 里",
  /\/api\/keyword-roots/.test(fnBody("loadRootsPanel")) &&
  /\/api\/keyword-roots/.test(fnBody("saveRoots")) && !/\/api\/keyword-roots/.test(LW));
ck("6.6 CSV 的 /api/export?kind= 只在 exportWordsCsv() 里、不在 loadWords()",
  /\/api\/export\?kind=/.test(fnBody("exportWordsCsv")) && !/\/api\/export/.test(LW));

/* 6.7 G-9 站点「可见但不承诺」 */
ck("6.7 未实测站点带 data-verified=\"false\"（静态页与 app.js 模板里都有）",
  /data-verified="false"/.test(HTML_SRC) && /data-verified="false"/.test(APP_SRC));
ck("6.7 UI 有「○ 未实测」与「类目映射可能不准，仅 US 经过实测」说明文案",
  /○ 未实测/.test(APP_SRC) && /类目映射可能不准，仅 US 经过实测/.test(APP_SRC));
ck("6.7 选中项会把 data-verified 同步到 <select> 上",
  /sel\.dataset\.verified\s*=\s*verified\s*\?\s*"true"\s*:\s*"false"/.test(APP_SRC));

/* 6.8 CSV 导出按钮 / 覆盖度体检按钮的落地路径 */
ck("6.8 两个 CSV 导出按钮存在且走 /api/export?kind=",
  /id="btnWExpKeywords"/.test(HTML_SRC) && /id="btnWExpAsins"/.test(HTML_SRC) &&
  /\/api\/export\?kind=/.test(APP_SRC));
ck("6.8 覆盖度体检按钮存在且调 analyzeCoverage 的 vault 路径",
  /id="btnWCoverRun"/.test(HTML_SRC) &&
  /L\.analyzeCoverage\(S\.listing,\s*\{[^}]*targetsFrom:\s*"vault"/.test(APP_SRC));

/* 6.9 既有固定文案一个都不许删 */
ck("6.9 index.html 仍保留「只有中文、英文两套」", /只有中文、英文两套/.test(HTML_SRC));
ck("6.9 index.html 仍保留「⑦ 竞品关键词」", /⑦ 竞品关键词/.test(HTML_SRC));
ck("6.9 index.html 仍保留「勾选两条」", /勾选两条/.test(HTML_SRC));
ck("6.9 index.html 不含「直接双击 index.html 也可以」",
  !/直接双击\s*index\.html\s*也可以/.test(HTML_SRC));

/* 6.10 S-2 覆盖度扩展的「真实消费方」—— 防止有人把 targets 删掉、
 * 让 coverageUser 分母恒为 0，参数白挂、功能悬空。 */
const COV = fnBody("runWordsCoverage");
ck("6.10 runWordsCoverage() 传了结构化 targets（不是只挂个 targetsFrom 白参数）",
  /keywords,\s*targets,\s*targetsFrom:\s*"vault"/.test(COV));
ck("6.10 user 词来自后台词 S.listing.searchTerms，按逗号/换行/分号拆",
  COV.includes("S.listing.searchTerms") && /split\(\/\[,，/.test(COV));
ck("6.10 user / vault 分开标记，且 user 先入、按词面小写去重（user 优先）",
  /from:\s*"user"/.test(COV) && /from:\s*"vault"/.test(COV) &&
  COV.indexOf('from: "user"') < COV.indexOf('from: "vault"') && /seen\.has\(key\)/.test(COV));
ck("6.10 wCoverOut 渲染路径引用了 coverageUser / coverageVault / vault.ok",
  /coverageUser/.test(COV) && /coverageVault/.test(COV) && /vault\?\.ok/.test(COV));
ck("6.10 两个覆盖率复用现有 .wstat / .wcell（不新增组件 class）",
  /class="wstat"/.test(COV) && /class="wcell"/.test(COV));
ck("6.10 分母为 0 / vault 没取到时如实显示「—」，不显示 0%",
  /这一组没有词/.test(COV) && /没取到/.test(COV) &&
  /userCount === 0/.test(COV) && /vaultCount === 0/.test(COV));
ck("6.10 读了 gapsDetail，补 missingIn 中文字段名，并按 rootCount × 漏字段数排序",
  /gapsDetail/.test(COV) && /missingIn/.test(COV) && /FIELD_CN/.test(COV) &&
  /weight\(gb\) - weight\(ga\)/.test(COV));
ck("6.10 口径说明写明「各按自己的分母算、不混成一个覆盖率」",
  /各按<b>自己的分母<\/b>算/.test(COV) && /不是把两类词混成一个覆盖率/.test(COV));
ck("6.10 不传 targets 的旧调用点仍是 opt-in（runCoverage 未被改成传 targets）",
  !/targets/.test(fnBody("runCoverage")));

/* 6.11 listing-eng 最终契约同步：gaps 保持字符串数组、来源标记在新增兄弟字段 gapsDetail、
 * 显示词根数用自己的 meta（引擎「派生形态」的 rootCount 是中性占位 1，不能拿去显示）。
 * 只钉住「我的渲染路径怎么消费」+「引擎 opt-in 分支没把 gaps 换成对象数组」。 */
const LISTING_SRC = fs.readFileSync(path.join(HERE, "assets", "listing.js"), "utf8");
const LISTING_EXT = LISTING_SRC.slice(LISTING_SRC.indexOf("if (opts.targetsFrom"));
ck("6.11 app.js 对 gaps 仍按字符串数组兜底（不在 gaps 里读 from/rootCount 对象）",
  /typeof x === "string" \? \{ term: x \}/.test(COV));
ck("6.11 每条来源标记优先取 gapsDetail 的 from（g.from 在前）",
  /g\.from\s*\|\|/.test(COV));
ck("6.11 「由 N 个词根带出」用自己的 meta，不用 gapsDetail.rootCount 的中性占位 1",
  /由 \$\{own\.rootCount\} 个词根带出/.test(COV) && /own\.rootCount/.test(COV));
ck("6.11 gapsDetail 缺失时有 fromMap 兜底，user 词不被误标成「词库词」",
  /fromMap\s*=\s*new Map/.test(COV) && /fromMap\.get\(/.test(COV));
ck("6.11 引擎 opt-in 分支不重赋值 result.gaps（gaps 保持原字符串数组类型）",
  LISTING_SRC.includes("if (opts.targetsFrom") && !/result\.gaps\s*=/.test(LISTING_EXT));
ck("6.11 来源数据只在新增兄弟字段 gapsDetail（并同时给 coverageUser/coverageVault/vault）",
  /result\.gapsDetail\s*=/.test(LISTING_EXT) && /result\.coverageUser\s*=/.test(LISTING_EXT) &&
  /result\.coverageVault\s*=/.test(LISTING_EXT) && /result\.vault\s*=/.test(LISTING_EXT));

console.log("\n" + "─".repeat(60));
console.log(`共 ${pass + fail} 条断言：通过 ${pass}，失败 ${fail}`);
fail += checkAssertCount("browser-selftest", pass + fail);
console.log(fail ? "有失败项 ✗" : "全部通过 ✓");
exitCode = fail ? 1 : 0;
process.exit(exitCode);
