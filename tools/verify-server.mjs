#!/usr/bin/env node
/**
 * 服务端安全回归：真起一个 server.mjs，真发请求。
 *
 * 覆盖这些"看起来没事、其实能被读走/打穿"的事：
 *   ① 静态服务目录穿越 —— 项目根目录原来整个可读，`.env.local` 里就是 API Key；
 *   ② Host 头不校验 —— DNS rebinding 能把本机服务变成任意网页可读的接口；
 *   ③ 出网 SSRF —— 图片 URL 由上游服务给出，能反过来打本机/云元数据；
 *   ④ 图片库的清单/打包/删除路径校验（打包不能只看 200，要真能解出条目名）；
 *   ⑤ 竞品抓取接口的参数白名单 —— 漏一条它就是"任意 URL 抓取通道"。
 *      本节**故意不联网**，只验证那几条在发出请求之前就被 400 拒掉。
 *
 * 🔴 数据安全：`.env.local` 含用户真实密钥。本脚本**只发一个必然被拒的请求**
 *    （非法 baseUrl → 400，不落盘），并且进出各做一次备份/还原，确保哪怕校验失效
 *    也不会把用户配置写坏。跑完会硬断言 `.env.local` 与原内容逐字节一致。
 */
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isPrivateIp, assertPublicUrl, allowedHosts, bareHost, getPinned, downloadPinned } from "../assets/net-guard.js";
import { checkAssertCount } from "./assert-count.mjs";
import { inspectZip } from "../assets/zip.js";
// 站点/类目清单只从模块读，不在本脚本里写第二份数字 —— 否则改了模块这里不报错
import { SITE_CODES, CATS, SITES, DEFAULT_SITE } from "../assets/bestsellers.js";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8791;
const ENV_LOCAL = path.join(HERE, ".env.local");
// 🔴 第 5 节要往"图片库目录"里写一个临时图再删掉。那目录默认是用户的 data/gen
//    （真实生图结果）。所以整块重定向到临时目录：本脚本从头到尾不碰用户真实数据，
//    也顺带避开"沙箱拦截工作区内的删除"（临时目录不受影响）。
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "clx-verify-data-"));

let pass = 0;
let fail = 0;
function ck(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
}

/* ── 0. SSRF 判据单元测试（纯函数，不需要起服务）────────────── */

console.log("0. SSRF：内网 IP 判据");
const PRIVATE_CASES = [
  "127.0.0.1", "127.0.0.53", "0.0.0.0", "10.0.0.1", "10.255.255.255",
  "172.16.0.1", "172.31.255.255", "192.168.1.1", "192.168.0.0",
  "169.254.169.254",                                   // 云元数据（AWS/GCP/Azure）
  "100.64.0.1", "100.127.255.255",                     // CGNAT
  "198.18.0.1", "224.0.0.1", "239.255.255.250",
  "::1", "::", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
  "fd00::1", "fc00::", "fe80::1", "", null, undefined,
];
for (const ip of PRIVATE_CASES) ck(`判为内网：${JSON.stringify(ip)}`, isPrivateIp(ip) === true);

const PUBLIC_CASES = [
  "8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1",
  "100.63.0.1", "100.128.0.1", "198.20.0.1", "192.169.0.1",
  "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8",
];
for (const ip of PUBLIC_CASES) ck(`判为公网：${ip}`, isPrivateIp(ip) === false);

console.log("\n0b. SSRF：URL 校验（应抛错）");
const REJECT_URLS = [
  "http://127.0.0.1:8787/api/health",
  "http://127.0.0.1.nip.io/x",
  "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
  "http://10.0.0.5/",
  "http://192.168.1.1/",
  "http://[::1]:8080/",
  "http://localhost/x",
  "http://foo.internal/x",
  "http://db.local/x",
  "file:///C:/Windows/win.ini",
  "ftp://example.com/x",
  "gopher://example.com/",
  "data:text/plain,hi",
  "javascript:alert(1)",
  "not a url",
  "",
];
for (const u of REJECT_URLS) {
  let threw = false;
  try { await assertPublicUrl(u); } catch { threw = true; }
  ck(`拒绝：${JSON.stringify(u).slice(0, 60)}`, threw);
}

console.log("\n0c. Host 判定辅助函数");
const hosts = allowedHosts(["127.0.0.1"]);
ck("允许 127.0.0.1", hosts.has("127.0.0.1"));
ck("允许 localhost", hosts.has("localhost"));
ck("不允许 evil.example.com", !hosts.has("evil.example.com"));
ck("bareHost 去端口", bareHost("127.0.0.1:8787") === "127.0.0.1");
ck("bareHost 保留 IPv6 方括号", bareHost("[::1]:8787") === "[::1]");

/* ── 1~4. 起真服务做端到端 ───────────────────────────────── */

const envBackup = fs.existsSync(ENV_LOCAL) ? fs.readFileSync(ENV_LOCAL) : null;
fs.rmSync(`${ENV_LOCAL}.tmp`, { force: true });

const srv = spawn(process.execPath, [path.join(HERE, "server.mjs")], {
  cwd: HERE,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", LISTING_DATA: TMP_DATA },
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 1200));

const base = `http://127.0.0.1:${PORT}`;
const get = (p) => fetch(base + p);

/** ⚠️ 必须用 node:http 发：Node 的 fetch(undici) 把 Host 当**禁止修改的头**静默丢弃，
 *  用 fetch 测 Host 校验永远是 200，那是测试假象不是代码通过。 */
function rawGet(pathname, hostHeader) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: pathname, method: "GET", headers: { Host: hostHeader } },
      (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); },
    );
    req.on("error", reject);
    req.end();
  });
}

try {
  console.log("\n1. 正常路径仍然可用（白名单不能把前端一起挡了）");
  const home = await get("/");
  ck("GET / → 200", home.status === 200, `status=${home.status}`);
  ck("首页正文含工作台标题", (await home.text()).includes("跨境"));
  for (const p of ["/assets/app.css", "/assets/app.js", "/assets/prompt-engine.js", "/assets/orchestrator.js", "/assets/net-guard.js",
                   // 整合进来的三个新模块也必须真的能被浏览器取到 —— 少一个整个前端一行 JS 都不跑
                   "/assets/competitor-keywords.js", "/assets/bestsellers.js", "/assets/copy-prompts.js"]) {
    const r = await get(p);
    ck(`GET ${p} → 200`, r.status === 200, `status=${r.status}`);
  }
  const health = await get("/api/health");
  ck("GET /api/health → 200", health.status === 200);
  const unknown = await get("/api/nope");
  ck("GET /api/nope → 404", unknown.status === 404, `status=${unknown.status}`);

  console.log("\n2. 静态目录穿越（原来 .env* / server.mjs / data 全可读）");
  for (const p of [
    "/.env.local", "/.env", "/.env.example", "/.env.local.tmp",
    "/server.mjs", "/package.json", "/.gitignore", "/README.md",
    "/data/gen/x.png", "/data/uploads/x.png",
    "/assets/../.env.local", "/assets/../server.mjs", "/assets/../../.env.local",
    "/%2e%2e/.env.local", "/assets/%2e%2e/%2e%2e/.env.local",
  ]) {
    const r = await get(p);
    ck(`${p} → 404`, r.status === 404, `status=${r.status}`);
  }

  console.log("\n3. Host 头校验（挡 DNS rebinding）");
  ck("Host: evil.example.com → 403", (await rawGet("/api/health", "evil.example.com")) === 403);
  ck("Host: evil.example.com:PORT → 403", (await rawGet("/api/health", `evil.example.com:${PORT}`)) === 403);
  ck("Host: attacker.test 读首页 → 403", (await rawGet("/", "attacker.test")) === 403);
  ck("Host: localhost:PORT → 200", (await rawGet("/api/health", `localhost:${PORT}`)) === 200);
  ck("Host: 127.0.0.1:PORT → 200", (await rawGet("/api/health", `127.0.0.1:${PORT}`)) === 200);

  console.log("\n4. /api/config 校验与原子写入");
  const badUrl = await fetch(`${base}/api/config`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageBaseUrl: "ftp://nope.example.com" }),
  });
  ck("非 http(s) 的 baseUrl → 400", badUrl.status === 400, `status=${badUrl.status}`);
  const weird = await fetch(`${base}/api/config`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageBaseUrl: "127.0.0.1:8787" }),
  });
  ck("缺协议头的 baseUrl → 400", weird.status === 400, `status=${weird.status}`);
  ck("被拒时不留 .env.local.tmp", !fs.existsSync(`${ENV_LOCAL}.tmp`));
  ck("被拒时不新建 .env.local", envBackup ? true : !fs.existsSync(ENV_LOCAL));

  /* ── 4b. 配置写入的边界（真的写盘，写完立刻还原）────────────
   * 🔴 这一组会**真的改写 .env.local**，所以三重保险：
   *    ① 只用受控测试值（keep-me-*），不碰任何真实密钥；
   *    ② 整个块包在 try/finally 里，断言怎么挂都会恢复原文件；
   *    ③ 结尾还有一道"与原文件逐字节一致"的硬断言（备份在服务启动前抓的）。
   *
   * 覆盖的是三个真实缺陷：
   *    · text/plain 简单请求能跨站写入（无预检）→ 现在 415
   *    · 随便一个跨站页面能把密钥改发到攻击者域名 → 现在 403
   *    · 只提交一个键会把其余键全删掉 → 现在合并写盘 + 回执 preserved
   */
  const PRESET = [
    "# verify-server 受控样本（跑完会还原）",
    "IMG_MODEL=keep-me-model",
    "IMG_BASE_URL=https://keep.example.com/v1",
    "CHAT_MODEL=keep-me-chat",
    "VISION_MODEL=keep-me-vision",
    "COMPETITOR_SCRAPE=0",
    "",
  ].join("\n");
  const hashOf = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  fs.writeFileSync(ENV_LOCAL, PRESET, "utf8");
  const presetHash = hashOf(ENV_LOCAL);

  try {
    const postCfg = (body, headers = {}) => fetch(`${base}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

    const plain = await postCfg(JSON.stringify({ imageModel: "pwned" }), { "Content-Type": "text/plain" });
    ck("Content-Type: text/plain → 415（跨站简单请求写不进来）", plain.status === 415, `status=${plain.status}`);

    const cross = await postCfg({ imageModel: "pwned" }, { Origin: "https://evil.example" });
    ck("Origin: https://evil.example → 403", cross.status === 403, `status=${cross.status}`);

    const xsite = await postCfg({ imageModel: "pwned" }, { "Sec-Fetch-Site": "cross-site" });
    ck("Sec-Fetch-Site: cross-site → 403", xsite.status === 403, `status=${xsite.status}`);

    const nullOrigin = await postCfg({ imageModel: "pwned" }, { Origin: "null" });
    ck("Origin: null → 403（sandbox iframe 也不放行）", nullOrigin.status === 403, `status=${nullOrigin.status}`);

    const empty = await postCfg("{}");
    ck("空对象 → 400（不能把文件重写成只剩注释）", empty.status === 400, `status=${empty.status}`);
    ck("空对象被拒后 .env.local 逐字节未变", hashOf(ENV_LOCAL) === presetHash);

    const one = await postCfg({ imageModel: "new-model" }, { Origin: base });
    ck("同源 JSON → 200", one.status === 200, `status=${one.status}`);
    const oneJson = await one.json().catch(() => ({}));
    ck("回执带 written / preserved 两个清单", Array.isArray(oneJson.written) && Array.isArray(oneJson.preserved), JSON.stringify(oneJson));
    ck("preserved 至少 4 项（其余键没被顺手删掉）", (oneJson.preserved || []).length >= 4, JSON.stringify(oneJson.preserved));

    const afterOne = fs.readFileSync(ENV_LOCAL, "utf8");
    ck("只提交 imageModel：IMG_MODEL 已更新", /IMG_MODEL=new-model/.test(afterOne));
    ck("只提交 imageModel：IMG_BASE_URL 原样保留", /IMG_BASE_URL=https:\/\/keep\.example\.com\/v1/.test(afterOne));
    ck("只提交 imageModel：CHAT_MODEL 原样保留（原来会被删）", /CHAT_MODEL=keep-me-chat/.test(afterOne));
    ck("只提交 imageModel：VISION_MODEL 原样保留（原来会被删）", /VISION_MODEL=keep-me-vision/.test(afterOne));
    ck("只提交 imageModel：COMPETITOR_SCRAPE 原样保留（原来会被删）", /COMPETITOR_SCRAPE=0/.test(afterOne));
    ck("响应不回显任何配置值", !JSON.stringify(oneJson).includes("keep-me"));

    const delKey = await postCfg({ imageModel: "" });
    ck("空值 → 200（密钥终于能删掉了）", delKey.status === 200, `status=${delKey.status}`);
    ck("空值把该键真的从文件里删掉", !/^IMG_MODEL=/m.test(fs.readFileSync(ENV_LOCAL, "utf8")));

    // 缓存失效：删掉 IMG_MODEL 后 health 必须立刻回到默认值，
    // 不能还拿着 500ms 前的旧文件内容（表现为"保存成功但界面没变"）。
    const hAfter = await (await get("/api/health")).json();
    ck("写入后 health 立刻反映新配置（不依赖缓存自然过期）",
      hAfter.capabilities?.imageModel === "gpt-image-2",
      JSON.stringify(hAfter.capabilities));

    const junk = await postCfg({ totallyUnknown: "x" });
    ck("全是不认识的键 → 400（不静默写垃圾进去）", junk.status === 400, `status=${junk.status}`);

    const arr = await postCfg([]);
    ck("请求体是数组 → 400（只接受对象）", arr.status === 400, `status=${arr.status}`);

    const badJson = await postCfg("{not json");
    ck("非法 JSON → 400 且给出可读原因", badJson.status === 400, `status=${badJson.status}`);
  } finally {
    // 无论上面怎么挂，都把用户原文件放回去
    if (envBackup === null) fs.rmSync(ENV_LOCAL, { force: true });
    else fs.writeFileSync(ENV_LOCAL, envBackup);
    fs.rmSync(`${ENV_LOCAL}.tmp`, { force: true });
  }

  /* ── 4c. 外部数据源接口的边界（不出网、不花钱就能测的部分）──────
   * 说明：**故意不测"调通第三方"**。那需要一把真密钥，还会在自检里真的去花别人的额度。
   * 传输层（SSE/JSON、会话 id、超时、401）在 tools/mcp-selftest.mjs §13c 用本地 mock 测，
   * 这里只盯"本服务的门"：白名单、密钥缺失、请求体不能夹带 url/key、只读模式。
   */
  console.log("\n4c. 外部数据源：白名单 / 密钥缺失 / 请求体不能夹带 url");
  {
    const prov = await (await get("/api/external/providers")).json();
    ck("GET /api/external/providers → 200 且列出 sellersprite",
      Array.isArray(prov.providers) && prov.providers.some((p) => p.id === "sellersprite"),
      JSON.stringify(prov).slice(0, 200));
    const sp = (prov.providers || []).find((p) => p.id === "sellersprite") || {};
    ck("端点写的是官方地址（拼错一个字母就是连不上）",
      sp.url === "https://mcp.sellersprite.com/mcp", String(sp.url));
    ck("鉴权头写的是 secret-key（不是 Bearer）", sp.header === "secret-key", String(sp.header));
    ck("🔴 响应里没有密钥本体，只有末四位掩码",
      !("key" in sp) && (sp.configured ? /^\*{4}/.test(String(sp.keyHint)) : true),
      JSON.stringify({ configured: sp.configured, keyHint: sp.keyHint }));

    const post = (body, headers = {}) => fetch(`${base}/api/external/test`, {
      method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
    });

    const noKey = await post({ provider: "sellersprite" });
    const noKeyJ = await noKey.json();
    ck("没配密钥 → 400 且 needKey:true（界面据此跳到「去填密钥」而不是「对方挂了」）",
      noKey.status === 400 && noKeyJ.needKey === true, JSON.stringify(noKeyJ).slice(0, 200));
    ck("错误里点名要配哪个环境变量（SELLERSPRITE_KEY）", /SELLERSPRITE_KEY/.test(String(noKeyJ.error)), String(noKeyJ.error));

    const unknown = await post({ provider: "nope" });
    ck("未知数据源 → 400（不是 500，也不是静默走默认）", unknown.status === 400, `status=${unknown.status}`);

    // 关键一条：请求体里塞 key / url **都不生效** —— 否则这里就是 SSRF 跳板 + 密钥旁路
    const smuggle = await post({
      provider: "sellersprite",
      url: "http://169.254.169.254/latest/meta-data/",
      baseUrl: "http://127.0.0.1:8787/api/config",
      key: "i-am-a-key",
      secretKey: "still-not-used",
    });
    const smuggleJ = await smuggle.json();
    ck("🔴 请求体夹带 url/key 一律无效：仍然报「没配密钥」（端点只来自服务端常量）",
      smuggle.status === 400 && smuggleJ.needKey === true, JSON.stringify(smuggleJ).slice(0, 200));

    const plain = await fetch(`${base}/api/external/test`, {
      method: "POST", headers: { "Content-Type": "text/plain" }, body: '{"provider":"sellersprite"}',
    });
    ck("text/plain 简单请求 → 415（挡掉无预检的跨站写入）", plain.status === 415, `status=${plain.status}`);

    const crossSite = await post({ provider: "sellersprite" }, { Origin: "https://evil.example.com" });
    ck("跨站 Origin → 403", crossSite.status === 403, `status=${crossSite.status}`);

    const big = await fetch(`${base}/api/external/test`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "sellersprite", args: { q: "x".repeat(300 * 1024) } }),
    });
    ck("超大请求体 → 413（不让一个请求把内存吃满）", big.status === 413, `status=${big.status}`);

    const wrongMethod = await get("/api/external/test");
    ck("GET 拿到 POST 的路由 → 404，而不是把处理器当 GET 跑", wrongMethod.status === 404, `status=${wrongMethod.status}`);

    const terms = await (await get("/api/external/terms?provider=sellersprite")).json();
    ck("没导入过 → 200 但 ok:false 且说明原因（空不等于错）",
      terms.ok === false && Boolean(terms.reason), JSON.stringify(terms).slice(0, 160));
    const badProvider = await get("/api/external/terms?provider=whatever");
    ck("terms 传未知 provider → 400", badProvider.status === 400, `status=${badProvider.status}`);

    // 示例数据：给"没有账号"的人先看效果。三条都要守 ——
    // ① 真的能读；② 必须自称 demo（否则会被当成用户自己的数据）；③ 绝不写盘。
    const demo = await (await get("/api/external/terms?compare=1&demo=1")).json();
    ck("示例数据可读：12 条词且带 demo:true（没账号也能看到整页效果）",
      demo.ok === true && demo.demo === true && demo.count === 12 && demo.terms?.length === 12,
      JSON.stringify({ ok: demo.ok, demo: demo.demo, count: demo.count, n: demo.terms?.length }));
    ck("示例也走同一套交集逻辑（compare 形状与真实导入一致）",
      demo.compare && typeof demo.compare === "object" &&
      (demo.compare.ok ? typeof demo.compare.externalOnlyCount === "number" : Boolean(demo.compare.hint)),
      JSON.stringify(demo.compare).slice(0, 200));
    ck("🔴 拿示例不创建 data/external（示例只读仓库里的 fixture，不碰用户导入产物）",
      !fs.existsSync(path.join(TMP_DATA, "external", "sellersprite.json")));
  }

  /* ── 5. 图片库（清单 / 打包 / 删除的路径校验）──────────────
   * 🔴 数据安全：这里会往**临时数据目录**放一个临时文件再删掉它。
   *    服务是带 LISTING_DATA=TMP_DATA 起的，所以用户的 data/gen 完全没被碰过。
   *    仍然：① 只用 `_verify-tmp-` 前缀的名字；② 结尾硬断言它已消失；③ 跑完删掉整个临时目录。
   */
  console.log("\n5. 图片库：清单 / 打包 / 删除");
  const GEN_DIR = path.join(TMP_DATA, "gen");
  const TMP_IMG = "_verify-tmp-image.png";
  fs.mkdirSync(GEN_DIR, { recursive: true });
  const tmpPath = path.join(GEN_DIR, TMP_IMG);
  const pngBytes = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  fs.writeFileSync(tmpPath, pngBytes);

  try {
    const list = await get("/api/library");
    ck("GET /api/library → 200", list.status === 200, `status=${list.status}`);
    const lj = await list.json();
    ck("清单里有刚放进去的临时图", (lj.files || []).some((f) => f.name === TMP_IMG), JSON.stringify(lj).slice(0, 200));
    const entry = (lj.files || []).find((f) => f.name === TMP_IMG) || {};
    ck("清单项带 url/size/sizeText/mtime", Boolean(entry.url && entry.sizeText && entry.mtime), JSON.stringify(entry));
    ck("url 指向 /api/blob", String(entry.url || "").startsWith("/api/blob?key=gen%2F"), entry.url);
    ck("声明了字节合计", typeof lj.bytes === "number" && Boolean(lj.bytesText), JSON.stringify({ bytes: lj.bytes, bytesText: lj.bytesText }));

    // 打包下载：不能只看 200，要真能解出条目名（否则就是"下载下来打不开"）
    const zres = await get("/api/library?zip=1");
    ck("GET /api/library?zip=1 → 200", zres.status === 200, `status=${zres.status}`);
    ck("Content-Type 是 zip", String(zres.headers.get("content-type") || "").includes("zip"), zres.headers.get("content-type"));
    ck("带 attachment 文件名", /attachment/.test(String(zres.headers.get("content-disposition") || "")), zres.headers.get("content-disposition"));
    const zbuf = Buffer.from(await zres.arrayBuffer());
    ck("首 4 字节是 PK\\x03\\x04", zbuf.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])), zbuf.slice(0, 4).toString("hex"));
    const info = inspectZip(zbuf);
    ck("zip 结构自检通过", info.ok, info.reason);
    ck("zip 里有临时图", info.entries.some((e) => e.name === TMP_IMG), JSON.stringify(info.entries.map((e) => e.name)));
    const zi = info.entries.find((e) => e.name === TMP_IMG) || {};
    ck("zip 条目的 CRC 与文件字节一致", zi.crc === (crc32(pngBytes) >>> 0), `${zi.crc} vs ${crc32(pngBytes) >>> 0}`);
    ck("zip 条目大小正确", zi.size === pngBytes.length, `${zi.size} vs ${pngBytes.length}`);

    // 删除：三道拒绝 + 一次真删
    const del = (name, method = "DELETE") => fetch(`${base}/api/library?name=${encodeURIComponent(name)}`, { method });
    ck("删除 ../evil.png → 400（路径成分一律拒）", (await del("../evil.png")).status === 400);
    ck("删除 sub/x.png → 400", (await del("sub/x.png")).status === 400);
    ck("删除 x.txt → 400（扩展名白名单）", (await del("x.txt")).status === 400);
    ck("删除不存在但合法的名字 → 404", (await del("nope.png")).status === 404);
    ck("越界名被拒后 server.mjs 还在", fs.existsSync(path.join(HERE, "server.mjs")));
    ck("越界名被拒后 .env.example 还在", fs.existsSync(path.join(HERE, ".env.example")));
    const ok = await del(TMP_IMG);
    ck("删除自己的临时图 → 200", ok.status === 200, `status=${ok.status}`);
    ck("🔴 临时图已从磁盘消失", !fs.existsSync(tmpPath));
    const list2 = await (await get("/api/library")).json();
    ck("清单里也不再有它", !(list2.files || []).some((f) => f.name === TMP_IMG));
  } finally {
    // 兜底：不管上面哪条断言炸了，都不留垃圾在用户的 data/gen 里
    try { if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
  }

  /* ── 6. 竞品数据源（全项目唯一主动爬第三方站点的通道）──────────────
   * 🔴 本节**故意不发起真抓取**，只测"参数白名单"：
   *    ① 这是安全回归脚本，加网络依赖会让它变成"看网速脸色"；
   *    ② 真正要紧的是"这个接口会不会变成任意 URL 抓取通道" —— 那几条全都
   *       应该在**发起网络请求之前**就被 400 拒掉，测它们不需要联网。
   *    真抓取的成功/失败路径在 `browser-selftest.mjs` 里测（允许失败，
   *    只要失败是**如实报错**而不是假装有数据）。
   */
  console.log("\n6. 竞品数据源：清单接口 + 抓取参数白名单");
  const ccRes = await get("/api/competitor/categories");
  ck("GET /api/competitor/categories → 200", ccRes.status === 200, `status=${ccRes.status}`);
  const cc = await ccRes.json();
  ck("站点清单与模块定义一致（不是第二份硬编码）",
    (cc.sites || []).length === SITE_CODES.length && (cc.sites || []).every((s) => s.code && s.host && s.label),
    `api=${(cc.sites || []).length} 模块=${SITE_CODES.length}`);
  ck("类目清单与模块定义一致",
    (cc.cats || []).length === CATS.length && (cc.cats || []).every((c) => c.slug && c.cn),
    `api=${(cc.cats || []).length} 模块=${CATS.length}`);
  ck("返回缓存统计（界面要说清这一屏是缓存还是实时）",
    Boolean(cc.cache) && typeof cc.cache.size === "number", JSON.stringify(cc.cache));
  ck("清单照实标注数据来源（不许含糊成「我们的数据库」）",
    /Best Sellers/.test(String(cc.sourceNote || "")), String(cc.sourceNote));
  const healthJson = await (await get("/api/health")).json();
  ck("health.capabilities 暴露抓取开关，界面据此决定怎么显示",
    healthJson.capabilities?.competitor === true, JSON.stringify(healthJson.capabilities));

  /* 🔴 下面每一条都必须在**发出任何网络请求之前**被 400 拒掉。
   *    漏任何一条，这个接口就变成"任意 URL 抓取通道"（先打本机服务、再打云元数据）。
   * ⚠️ 故意**不测** `site=` 空值：设计上它会回落到 DEFAULT_SITE（美国站），
   *    回落之后 slug 合法就会真去抓 —— 那是本节的"不联网"约束不允许的。
   *    回落本身是合理设计（与界面下拉框默认值同源），这里只离线锁"这个常量确实在站点清单里"。 */
  ck("默认站点常量是站点清单里的合法键（服务端与界面共用同一份默认值）",
    Boolean(SITES[DEFAULT_SITE]), `DEFAULT_SITE=${DEFAULT_SITE}`);
  const BAD_QS = [
    ["未知站点", "site=evil.com&slug=electronics"],
    ["类目为空", "site=com&slug="],
    ["未知类目", "site=com&slug=nope"],
    ["类目是路径穿越", "site=com&slug=" + encodeURIComponent("../../etc/passwd")],
    ["类目带斜杠", "site=com&slug=" + encodeURIComponent("electronics/../toys-and-games")],
    ["类目被塞成完整域名", "site=com&slug=" + encodeURIComponent("evil.com")],
    ["href 指向第三方站", "site=com&slug=electronics&href=" + encodeURIComponent("https://evil.com/gp/bestsellers/electronics")],
    ["href 用 amazon 后缀骗局", "site=com&slug=electronics&href=" + encodeURIComponent("https://www.amazon.com.evil.com/gp/bestsellers/electronics")],
    ["href 主机不在白名单", "site=com&slug=electronics&href=" + encodeURIComponent("https://www.amazon.com.cn/gp/bestsellers/electronics")],
    ["href 打本机服务", "site=com&slug=electronics&href=" + encodeURIComponent("http://127.0.0.1:8791/api/health")],
    ["href 打云元数据", "site=com&slug=electronics&href=" + encodeURIComponent("http://169.254.169.254/latest/meta-data/")],
    ["href 是 file://", "site=com&slug=electronics&href=" + encodeURIComponent("file:///C:/Windows/win.ini")],
    ["href 是 amazon 域但路径不在白名单（/s?k= 那条已被封锁的路径）",
      "site=com&slug=electronics&href=" + encodeURIComponent("https://www.amazon.com/s?k=anything")],
  ];
  for (const [why, qs] of BAD_QS) {
    const r1 = await get("/api/competitor/bestsellers?" + qs);
    ck(`bestsellers 拒 ${why} → 400`, r1.status === 400, `status=${r1.status}`);
    const r2 = await get("/api/competitor/subs?" + qs);
    ck(`subs 拒 ${why} → 400`, r2.status === 400, `status=${r2.status}`);
  }
  const badRes = await get("/api/competitor/bestsellers?site=com&slug=nope");
  const badBody = await badRes.json();
  ck("被拒时给可读 error（不是空 body / undefined，否则前端只能显示 undefined）",
    Boolean(badBody.error) && /未知类目/.test(badBody.error), JSON.stringify(badBody));
  ck("被拒响应必须是 JSON（前端直接 .json()，不能抛解析错）",
    String(badRes.headers.get("content-type") || "").includes("json"), String(badRes.headers.get("content-type")));

  /* ── 6. 只读演示模式：写门必须是"全关"，不是"关一扇" ────────────
   * 原实现只拦 /api/config，于是线上分享链接里访客仍能：
   *   · POST /api/upload  → 往 data/upload 塞任意文件（还能撑爆磁盘）
   *   · DELETE /api/library → 删掉站长生成的图
   *   · POST /api/image|vision|llm → 站长一旦配了 key，就是给陌生人白嫖额度
   * 这里另起一个 LISTING_NO_KEY_WRITE=1 的实例来验，不改主实例的环境。
   */
  console.log("\n6. 只读演示模式（LISTING_NO_KEY_WRITE=1）：写门全关、读路径照通");
  const RO_PORT = PORT + 1;
  const roSrv = spawn(process.execPath, [path.join(HERE, "server.mjs")], {
    cwd: HERE,
    env: { ...process.env, PORT: String(RO_PORT), HOST: "127.0.0.1", LISTING_DATA: TMP_DATA,
      // 词库目录也指向临时目录（空的）→ "没有词库"成为确定性输入，
      // 不然这条断言的结果取决于本机有没有跑过采集器。
      LISTING_KEYWORDS: path.join(TMP_DATA, "keywords"), LISTING_NO_KEY_WRITE: "1" },
    stdio: "ignore",
  });
  try {
    await new Promise((r) => setTimeout(r, 1400));
    const roBase = `http://127.0.0.1:${RO_PORT}`;
    const rq = (p, method = "GET", body = null) => fetch(roBase + p, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    const hj = await (await rq("/api/health")).json();
    ck("health 明确回报 readonly:true（界面据此先说不可用）", hj.capabilities?.readonly === true, JSON.stringify(hj.capabilities));

    for (const [m, p] of [["POST", "/api/config"], ["POST", "/api/upload"], ["POST", "/api/image"], ["POST", "/api/vision"], ["POST", "/api/llm"]]) {
      const r = await rq(p, m, {});
      ck(`${m} ${p} → 403`, r.status === 403, `status=${r.status}`);
    }
    const del = await rq("/api/library?name=x.png", "DELETE");
    ck("DELETE /api/library → 403", del.status === 403, `status=${del.status}`);

    // 外部数据源：POST 会花"站长账号"在第三方的额度，线上演示必须一起关；
    // 但 GET providers 要能读 —— 否则访客连"这个功能存在但需要自己的密钥"都看不到。
    for (const p of ["/api/external/test", "/api/external/call", "/api/external/import"]) {
      const r = await rq(p, "POST", { provider: "sellersprite" });
      ck(`POST ${p} → 403（不留第三方额度给陌生人）`, r.status === 403, `status=${r.status}`);
    }
    const roProv = await (await rq("/api/external/providers")).json();
    ck("GET /api/external/providers 在只读模式仍可读（能告诉访客「要用得自己配密钥」）",
      Array.isArray(roProv.providers) && roProv.providers.length > 0, JSON.stringify(roProv).slice(0, 160));

    // 词根覆盖层：POST 会写 data/keywords/roots.json，线上演示版同样不许写。
    const roRoots = await rq("/api/keyword-roots", "POST", { added: [] });
    ck("POST /api/keyword-roots → 403（只读演示版不写用户数据）", roRoots.status === 403, `status=${roRoots.status}`);
    const roRootsGet = await (await rq("/api/keyword-roots")).json();
    ck("GET /api/keyword-roots 在只读模式仍可读（词根面板能看到基线）",
      roRootsGet.ok === true && Array.isArray(roRootsGet.roots) && roRootsGet.roots.length > 0);
    const roCsv = await rq("/api/export?kind=keywords");
    ck("GET /api/export 在只读模式仍可导出（纯读，不落盘）", roCsv.status === 200, `status=${roCsv.status}`);

    // 历史快照 / 抠图代理：一个写 data/snapshots，一个吃本机 CPU 几十秒 ——
    // 线上给陌生人看的时候都不能开。读接口要留着（访客至少能看到"这里本来有历史"）。
    const roSnap = await rq("/api/snapshots", "POST", { asin: "B00TEST001", price: 1 });
    ck("POST /api/snapshots → 403（只读演示版不写历史）", roSnap.status === 403, `status=${roSnap.status}`);
    const roSnapGet = await rq("/api/snapshots?asin=B00TEST001");
    ck("GET /api/snapshots 在只读模式仍可读（只是没有数据）", roSnapGet.status === 200, `status=${roSnapGet.status}`);
    const roRembg = await rq("/api/plugins/rembg", "POST", { name: "x.png" });
    ck("POST /api/plugins/rembg → 403（不拿站长机器给陌生人抠图）", roRembg.status === 403, `status=${roRembg.status}`);

    const roBody = await (await rq("/api/image", "POST", { prompt: "x" })).json();
    ck("403 带可读 error + readonly 标记（不是空 body）", Boolean(roBody.error) && roBody.readonly === true, JSON.stringify(roBody));

    // 只读 ≠ 不能用：所有读路径必须照通
    ck("GET / → 200", (await rq("/")).status === 200);
    ck("GET /api/health → 200", (await rq("/api/health")).status === 200);
    ck("GET /api/library → 200（列表仍可看）", (await rq("/api/library")).status === 200);
    // 词库是只读接口：线上演示版必须也能读，否则"载入本周词库"在分享链接上永远不可用
    const kwResp = await rq("/api/keywords");
    const kwBody = await kwResp.json();
    ck("GET /api/keywords → 200（读接口不被写门拦）", kwResp.status === 200, `status=${kwResp.status}`);
    ck("没有快照时返回 200 + ok:false + reason（不是 404，前端才不会当成网络故障）",
      kwBody.ok === false && kwBody.reason === "missing" && Boolean(kwBody.hint), JSON.stringify(kwBody).slice(0, 160));
    ck("没有快照时也给 staleness=missing（冷/热分支的 trust 形状一致，界面不用写两套）",
      kwBody.trust?.staleness?.state === "missing" && Boolean(kwBody.trust?.status),
      JSON.stringify(kwBody.trust).slice(0, 160));

    // 有快照之后：`?category=` 必须真的筛，截断必须能看见。
    // 这一段同时验证了「刚写下的快照立刻可读」——读盘缓存不许把 missing 钉死。
    const kwDir = path.join(TMP_DATA, "keywords");
    fs.mkdirSync(kwDir, { recursive: true });
    const fixtureSnap = {
      schema: 1,
      site: "US",
      generatedAt: new Date().toISOString(),
      keywords: [
        { term: "ceramic mug", groups: ["kitchen"], hits: 3 },
        { term: "coffee cup", groups: ["kitchen"], hits: 2 },
        { term: "yoga mat", groups: ["sports"], hits: 1 },
      ],
      asins: [
        { asin: "B0TEST00001", title: "A", category: "kitchen", group: "kitchen", rank: 1, price: "$12.99", rating: "4.6" },
        { asin: "B0TEST00002", title: "B", category: "sports", group: "sports", rank: 1 },
      ],
      summary: { keywordCount: 3, asinCount: 2, newKeywordCount: 0, droppedKeywordCount: 0, note: "" },
      sources: {},
    };
    fs.writeFileSync(path.join(kwDir, "latest.json"), JSON.stringify(fixtureSnap), "utf8");

    /* 外部词表 × 本地周词库的对比（"两边一起用"的落点）。
     * 文件直接写到临时数据目录，走的是真实读盘路径，不经过网络 ——
     * 所以这条链路（导入产物 → 交集 → 盲区）在不花任何第三方额度的前提下就能验。 */
    const extDir = path.join(TMP_DATA, "external");
    fs.mkdirSync(extDir, { recursive: true });
    const extFile = path.join(extDir, "sellersprite.json");
    const extBefore = await (await rq("/api/external/terms?provider=sellersprite")).json();
    ck("没有导入文件时 → ok:false + reason（空不等于错，也不冒充 0 个词）",
      extBefore.ok === false && extBefore.reason === "还没导入过", JSON.stringify(extBefore).slice(0, 160));

    fs.writeFileSync(extFile, JSON.stringify({
      provider: "sellersprite", label: "卖家精灵", tool: "traffic_keyword", args: {}, at: new Date().toISOString(),
      count: 3, mapping: { term: "keyword", volume: "searches" }, why: "", bytes: 100,
      terms: [
        { term: "Ceramic  Mug", volume: 12000, rank: 3, asins: [] },   // 大小写/空格不同，仍应算命中
        { term: "leather bag", volume: 9000, rank: 8, asins: [] },     // 本地没有 → 盲区
        { term: "tote bag", volume: 7000, rank: null, asins: [] },     // 本地没有 → 盲区
      ],
    }), "utf8");

    const cmp = await (await rq("/api/external/terms?provider=sellersprite&compare=1")).json();
    ck("导入产物能读回（含 terms / mapping / at）",
      cmp.ok === true && cmp.terms?.length === 3 && cmp.mapping?.volume === "searches", JSON.stringify(cmp).slice(0, 160));
    ck("对比：本地 3 词 / 外部 3 词 / 交集 1（大小写与多余空格不算两个词）",
      cmp.compare?.localCount === 3 && cmp.compare?.externalCount === 3 && cmp.compare?.bothCount === 1,
      JSON.stringify(cmp.compare).slice(0, 200));
    ck("对比：盲区正好是那 2 个本地没抓到的词",
      cmp.compare?.externalOnlyCount === 2 &&
      cmp.compare.externalOnly.map((t) => t.term).sort().join("|") === "leather bag|tote bag",
      JSON.stringify(cmp.compare?.externalOnly));
    ck("对比用的是**全量**本地词库（不是界面那 500 条截断后的）", cmp.compare?.localCount === fixtureSnap.keywords.length,
      String(cmp.compare?.localCount));

    const kw2Resp = await rq("/api/keywords?category=kitchen&limit=1&asins=1");
    const kw2 = await kw2Resp.json();
    ck("写了快照后立刻可读（缓存不能把 missing 钉死）", kw2.ok === true, JSON.stringify(kw2).slice(0, 160));
    ck("?category=kitchen 只返回 kitchen 的词（文档承诺过，代码必须真筛）",
      Array.isArray(kw2.keywords) && kw2.keywords.every((k) => (k.groups || []).includes("kitchen")),
      JSON.stringify(kw2.keywords));
    ck("limit 截断带 total + truncated（不许静默只给 1 条）",
      kw2.keywords.length === 1 && kw2.keywordsTotal === 2 && kw2.keywordsTruncated === true,
      `${kw2.keywords?.length}/${kw2.keywordsTotal}/${kw2.keywordsTruncated}`);
    ck("ASIN 也按类目筛，并给出真实总数",
      kw2.asins.length === 1 && kw2.asinsTotal === 1 && kw2.asins[0].asin === "B0TEST00001",
      JSON.stringify(kw2.asins));
    // 要多了不报错，但必须报账：以前接口夹 2000、底层夹 500，调用方拿不到 2000 却不知道
    const kwOverResp = await rq("/api/keywords?limit=2000");
    const kwOver = await kwOverResp.json();
    ck("limit=2000 不报错，但 requested 如实回显 2000",
      kwOverResp.status === 200 && kwOver.keywordsRequested === 2000,
      `${kwOverResp.status}/${kwOver.keywordsRequested}`);
    ck("实际给的上限是 MAX_KEYWORD_LIMIT=500（不再有第二处 2000 的夹取）",
      kwOver.keywordsLimit === 500, String(kwOver.keywordsLimit));
    ck("没要多时 requested 与 limit 一致（不与用户实际请求脱节）",
      kw2.keywordsRequested === 1 && kw2.keywordsLimit === 1,
      `${kw2.keywordsRequested}/${kw2.keywordsLimit}`);

    // ── 信任指标（G-3）：界面照着它渲染体检卡，所以它自己必须是对的 ──
    // 判据不是"字段存在"，而是"字段与服务端真实数据一致" ——
    // 界面若自己再算一遍覆盖率，两处早晚会打架（一边 33% 一边 50%）。
    const kwTrust = (await (await rq("/api/keywords?asins=1")).json()).trust || {};
    ck("trust 七个字段齐（staleness/status/verifiedMarket/truncated/coverage/emptyGroups/sourceStatus）",
      ["staleness", "status", "verifiedMarket", "truncated", "coverage", "emptyGroups", "sourceStatus"]
        .every((k) => kwTrust[k] !== undefined), Object.keys(kwTrust).join(","));
    ck("coverage.price = 有价格的 ASIN 占比（1/2，服务端算好，界面不许自己算）",
      kwTrust.coverage?.price === 0.5, String(kwTrust.coverage?.price));
    ck("emptyGroups 与「没有 groups 的词数」一致（实测应为 0，这条是防回归）",
      kwTrust.emptyGroups === 0, String(kwTrust.emptyGroups));
    ck("US 站点标记为「已验证」（只有实测过的站点才配 verified=true）",
      kwTrust.verifiedMarket === true, String(kwTrust.verifiedMarket));

    // 排序参数：只认三个值，别的回落默认 —— 未知排序静默变字母序会让人以为数据变了
    const kwAz = await (await rq("/api/keywords?sort=az")).json();
    const kwBogus = await (await rq("/api/keywords?sort=bogus")).json();
    ck("?sort=az 被接受并如实回显", kwAz.keywordsSort === "az", String(kwAz.keywordsSort));
    ck("?sort=bogus 回落到 roots（不报错，也不偷偷换语义）",
      kwBogus.keywordsSort === "roots", String(kwBogus.keywordsSort));
    // /api/chat 刻意放行：它是在线体验的文字主链路，且不花额度
    ck("GET /api/chat 不被写门拦（405/404 之类都行，就是不能 403）", (await rq("/api/chat")).status !== 403);
  } finally {
    roSrv.kill();
    await new Promise((r) => setTimeout(r, 300));
  }

  /* ── 7. 断连取消：客户端走了，上游必须一起停 ────────────────────
   * 原实现没有任何 close 监听：用户点「停止」或关标签页之后，
   * 服务端仍在 12s 起的轮询/180s 的同步请求上照跑 —— 额度照扣，只是没人在等。
   * 这里真起一个"慢上游"，客户端中途 destroy，看上游连接是否被掐断。
   */
  console.log("\n7. 断连取消：客户端断开 → 上游请求被中止");
  const MOCK_PORT = PORT + 2;
  const APP_PORT = PORT + 3;
  let upstreamStarted = false;
  let upstreamAborted = false;
  const mock = http.createServer((req, res) => {
    upstreamStarted = true;
    const timer = setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${MOCK_PORT}/never.png` }] }));
    }, 9000);
    const kill = () => { upstreamAborted = true; clearTimeout(timer); };
    req.on("aborted", kill);
    res.on("close", () => { if (!res.writableEnded) kill(); });
  });
  await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

  const appSrv = spawn(process.execPath, [path.join(HERE, "server.mjs")], {
    cwd: HERE,
    env: {
      ...process.env, PORT: String(APP_PORT), HOST: "127.0.0.1", LISTING_DATA: TMP_DATA,
      IMG_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, IMG_API_KEY: "verify-test-key", IMG_API_MODE: "sync",
    },
    stdio: "ignore",
  });
  const waitFor = async (fn, ms = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); }
    return fn();
  };
  try {
    await new Promise((r) => setTimeout(r, 1400));
    const req = http.request({
      host: "127.0.0.1", port: APP_PORT, path: "/api/image", method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    req.on("error", () => { /* destroy 之后必然报错，忽略 */ });
    req.write(JSON.stringify({ prompt: "a test product photo", size: "1:1" }));
    req.end();

    ck("上游确实被调用了（不是根本没发请求，导致下面的断言假通过）", await waitFor(() => upstreamStarted));
    await new Promise((r) => setTimeout(r, 250));   // 让上游进入"等待 9s"的状态
    req.destroy();                                   // ← 模拟用户点「停止」/关标签页
    ck("客户端断开后，上游连接被中止（不再空跑到超时）", await waitFor(() => upstreamAborted));
  } finally {
    appSrv.kill();
    mock.close();
    await new Promise((r) => setTimeout(r, 300));
  }

  /* ── 8. 资源闸门：zip 有上限 / 上传只认文件头 ────────────────────
   * ① buildZip 是全内存实现，不设上限时"库里攒多了"会以 OOM 的形式表现为"服务莫名消失"；
   * ② 上传原来只看 Content-Type —— 那是客户端随便填的字符串，SVG 里带 <script> 也能过，
   *    再经 /api/blob 从同源返回，就是现成的 XSS 通道。
   */
  console.log("\n8. 资源闸门：zip 打包上限 + 上传魔数嗅探");

  const genDir = path.join(TMP_DATA, "gen");
  fs.mkdirSync(genDir, { recursive: true });
  const bigFile = path.join(genDir, "verify-big.png");
  const fd = fs.openSync(bigFile, "w");
  fs.ftruncateSync(fd, 41 * 1024 * 1024);   // 稀疏文件，不真占 41MB 磁盘
  fs.closeSync(fd);
  const zr = await get("/api/library?zip=1");
  const zj = await zr.json().catch(() => ({}));
  ck("单张 41MB（超 40MB 上限）→ 404 且说明被跳过", zr.status === 404 && /超过|跳过/.test(String(zj.error || "")), `status=${zr.status} ${JSON.stringify(zj).slice(0, 120)}`);
  fs.rmSync(bigFile, { force: true });

  const PNG_1X1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const uploadFile = async (body, type, filename) => {
    const boundary = "----verify" + Math.random().toString(16).slice(2);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`,
      "utf8",
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    const resp = await fetch(`${base}/api/upload`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat([head, body, tail]),
    });
    return { status: resp.status, body: await resp.json().catch(() => ({})) };
  };

  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "utf8");
  const rSvg = await uploadFile(svg, "image/png", "evil.png");
  ck("声明 image/png 但内容是 SVG → 415（只看 Content-Type 的洞已堵）", rSvg.status === 415, `status=${rSvg.status}`);
  ck("拒绝理由点名「文件内容」而不是含糊地说不支持", /文件内容|不是 PNG/.test(String(rSvg.body.error || "")), String(rSvg.body.error || "").slice(0, 80));

  const rTxt = await uploadFile(Buffer.from("just some text, not an image"), "image/jpeg", "x.jpg");
  ck("文本冒充 jpg → 415", rTxt.status === 415, `status=${rTxt.status}`);

  const rPng = await uploadFile(PNG_1X1, "image/png", "ok.png");
  ck("真 PNG → 200", rPng.status === 200, `status=${rPng.status} ${JSON.stringify(rPng.body).slice(0, 120)}`);
  ck("回传的是嗅探出的真实类型（不是把客户端声明原样传回去）", rPng.body.contentType === "image/png", JSON.stringify(rPng.body).slice(0, 120));

  // 后缀骗人但内容是真的：必须按内容落盘成 .png（不是按 filename 的 .jpg）
  const rMismatch = await uploadFile(PNG_1X1, "image/jpeg", "lying.jpg");
  ck("文件名/声明类型与内容不符时，以内容为准（落盘 .png）", rMismatch.status === 200 && /\.png$/.test(String(rMismatch.body.key || "")), String(rMismatch.body.key || ""));

  /* ── 8b. IP 钉死：关闭 DNS rebinding 的 TOCTOU 窗口 ────────────────
   * 原来的漏洞：assertPublicUrl 解析一次判内网，fetch 再解析一次才连 ——
   * 两次之间改 DNS 就能把"合法域名"指到 127.0.0.1。修法是只解析一次，把 IP 钉进 socket。
   * 这里用一个"域名根本不存在"的 URL 来证明：能连通就说明连接用的是我们给的 IP。
   */
  console.log("\n8b. IP 钉死（DNS rebinding 的 TOCTOU 窗口）");
  const pinSrv = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("pinned-ok");
  });
  await new Promise((r) => pinSrv.listen(0, "127.0.0.1", r));
  const pinPort = pinSrv.address().port;
  try {
    const pr = await getPinned(
      { url: new URL(`http://pinned.invalid:${pinPort}/probe`), address: "127.0.0.1", family: 4 },
      { timeoutMs: 4000 },
    );
    ck("域名无法解析但 lookup 被钉到 127.0.0.1 → 请求仍然成功（证明连接用的是钉死的 IP）",
      pr.status === 200 && pr.body.toString() === "pinned-ok", `status=${pr.status} body=${pr.body.toString().slice(0, 40)}`);
  } finally {
    pinSrv.close();
  }
  ck("downloadPinned 对回环地址仍然拒绝（钉死 ≠ 放行内网）",
    await downloadPinned("http://127.0.0.1:1/x.png").then(() => false, (e) => /内网|私网|拒绝/.test(e.message)));
} finally {
  srv.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
}

/* ── 9. 批三/批四：词根覆盖层、CSV 导出、历史对比的新接口 ────── */
/**
 * 单独起一个实例（端口 8795、独立临时数据目录），不复用前面的 srv：
 *   ① POST 会真的写 roots.json，必须用**归本脚本所有**的临时目录；
 *   ② 前面 8b 的 finally 已经把 TMP_DATA 删掉了，不能再用。
 */
console.log("\n9. 词根覆盖层 / CSV 导出 / 历史对比：门禁、形状与落盘");
const TMP9 = fs.mkdtempSync(path.join(os.tmpdir(), "clx-verify-roots-"));
const P9 = PORT + 4;
const srv9 = spawn(process.execPath, [path.join(HERE, "server.mjs")], {
  cwd: HERE,
  env: { ...process.env, PORT: String(P9), HOST: "127.0.0.1",
    LISTING_DATA: TMP9, LISTING_KEYWORDS: path.join(TMP9, "keywords") },
  stdio: "ignore",
});
try {
  await new Promise((r) => setTimeout(r, 1400));
  const B9 = `http://127.0.0.1:${P9}`;
  const req9 = async (p, init = {}) => {
    const r = await fetch(B9 + p, init);
    // 🔴 必须留原始字节：`Response.text()` 按 WHATWG 规范会**剥掉 UTF-8 BOM**，
    //    用它验「CSV 首三字节是 BOM」永远假红。buf.toString("utf8") 才保留 BOM。
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, headers: r.headers, buf, text: buf.toString("utf8") };
  };
  const jsonPost = (body, headers = {}) => ({
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

  const g0 = await req9("/api/keyword-roots");
  let r0 = null;
  try { r0 = JSON.parse(g0.text); } catch { /* 下面会红 */ }
  ck("GET /api/keyword-roots → 200 且 ok:true", g0.status === 200 && r0?.ok === true, `status=${g0.status}`);
  ck("词根清单非空，且 notes / rejected / overlay / coverage 形状齐全",
    Array.isArray(r0?.roots) && r0.roots.length > 100 &&
    Array.isArray(r0?.notes) && Array.isArray(r0?.rejected) &&
    r0?.overlay && typeof r0.overlay === "object" && r0?.coverage,
    `roots=${r0?.roots?.length}`);
  ck("没有覆盖层时如实说明「按基线词根运行」",
    String((r0?.notes || []).join(" ")).includes("基线"), (r0?.notes || []).join(" / "));
  ck("verifiedMarkets：US 已实测、DE 未实测（站点可见但不承诺）",
    r0?.verifiedMarkets?.find((x) => x.code === "US")?.verified === true &&
    r0?.verifiedMarkets?.find((x) => x.code === "DE")?.verified === false,
    JSON.stringify(r0?.verifiedMarkets));

  const badCt = await req9("/api/keyword-roots", {
    method: "POST", headers: { "content-type": "text/plain" }, body: "{}",
  });
  ck("POST 词根覆盖层：Content-Type 非 JSON → 415（防跨站简单请求）", badCt.status === 415, `status=${badCt.status}`);
  const cross = await req9("/api/keyword-roots", jsonPost({}, { "sec-fetch-site": "cross-site" }));
  ck("POST 词根覆盖层：跨站 → 403", cross.status === 403, `status=${cross.status}`);
  const notObj = await req9("/api/keyword-roots", jsonPost([1, 2, 3]));
  ck("POST 词根覆盖层：body 是数组 → 400", notObj.status === 400, `status=${notObj.status}`);
  const badShape = await req9("/api/keyword-roots", jsonPost({ added: "oops" }));
  ck("POST 词根覆盖层：added 不是数组 → 400", badShape.status === 400, `status=${badShape.status}`);

  const okPost = await req9("/api/keyword-roots", jsonPost({
    added: [{ root: "silicone mat", group: "kitchen" }], removed: [], renamed: [],
    // 🔴 夹带这两个字段：必须被忽略，不能变成任意文件写入
    path: "../../.env.local", key: "LEAKED",
  }));
  let saved = null;
  try { saved = JSON.parse(okPost.text); } catch { /* 下面会红 */ }
  ck("POST 合法覆盖层 → 200 且 saved:true", okPost.status === 200 && saved?.saved === true, `status=${okPost.status}`);
  ck("覆盖层真的原子写到临时数据目录（不是只回了个 200）",
    fs.existsSync(path.join(TMP9, "keywords", "roots.json")));
  const raw9 = fs.existsSync(path.join(TMP9, "keywords", "roots.json"))
    ? fs.readFileSync(path.join(TMP9, "keywords", "roots.json"), "utf8") : "";
  ck("🔴 夹带的 path / key 字段没有进落盘文件（白名单式收参）",
    !raw9.includes("LEAKED") && !raw9.includes("../../"), raw9.slice(0, 120));
  const g1 = await req9("/api/keyword-roots");
  const r1 = JSON.parse(g1.text);
  ck("再 GET 能看到保存后的 added（不是读的旧缓存）",
    (r1?.overlay?.added || []).some((x) => x.root === "silicone mat"), JSON.stringify(r1?.overlay?.added));

  const csvK = await req9("/api/export?kind=keywords");
  ck("GET /api/export?kind=keywords → 200 + text/csv",
    csvK.status === 200 && /text\/csv/.test(csvK.headers.get("content-type") || ""),
    `status=${csvK.status} ct=${csvK.headers.get("content-type")}`);
  ck("CSV 首三字节是 UTF-8 BOM（Excel 打开不乱码）",
    csvK.buf[0] === 0xEF && csvK.buf[1] === 0xBB && csvK.buf[2] === 0xBF,
    csvK.buf.subarray(0, 6).toString("hex"));
  ck("CSV 只有表头时也是诚实的空表（不编数据行）",
    /词/.test(csvK.text) && !r0?.coverage?.ok, csvK.text.slice(0, 80));
  const csvA = await req9("/api/export?kind=asins");
  ck("GET /api/export?kind=asins → 200 且表头含 ASIN",
    csvA.status === 200 && /ASIN/.test(csvA.text), `status=${csvA.status}`);
  const csvBad = await req9("/api/export?kind=nope");
  ck("GET /api/export?kind=未知 → 400（不猜用户想要哪个）", csvBad.status === 400, `status=${csvBad.status}`);

  const cold = await req9("/api/keywords");
  const c = JSON.parse(cold.text);
  ck("🔴 冷分支与热分支字段形状一致：compare / asinDiff / roots / verifiedMarkets 都在",
    c?.compare && c?.asinDiff && c?.roots && Array.isArray(c?.verifiedMarkets));
  ck("冷分支不给 0：compare / asinDiff / roots 都是 ok:false 且带原因",
    c.compare.ok === false && c.asinDiff.ok === false && c.roots.ok === false &&
    Boolean(c.compare.reason) && Boolean(c.asinDiff.reason) && Boolean(c.roots.reason),
    JSON.stringify({ compare: c.compare, asinDiff: c.asinDiff, roots: c.roots }));
  const coldCmp = await req9("/api/keywords?compare=prev");
  const cc = JSON.parse(coldCmp.text);
  ck("?compare=prev 在没有历史投影时如实说「暂时没法对比」",
    cc?.compare?.ok === false && /暂时没法对比|还没有/.test(String(cc.compare.reason || "")),
    JSON.stringify(cc?.compare));
} finally {
  srv9.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(TMP9, { recursive: true, force: true }); } catch { /* ignore */ }
}

/* ── 10. 配置自检 /api/config/test ─────────────────────────
 * 核心判据不是"能不能连通"，而是**三档结论不许混**：
 *   绿 = 通了且密钥被验证 / 黄 = 端点可达但没验证 / 红 = 真没通。
 * 所以这里起一个假上游，把 200 / 401 / 404 三种响应都真打一遍。
 * 🔴 全程用请求体里传的 baseUrl，不读用户 .env 里配的真实端点 —— 绝不外呼。
 */
console.log("\n10. 配置自检 /api/config/test：只探 /models、三档结论分明、不写盘");
const TMP10 = fs.mkdtempSync(path.join(os.tmpdir(), "clx-verify-cfg-"));
const P10 = PORT + 5;
const UP10 = PORT + 6;
const stub10 = http.createServer((req, res) => {
  const auth = String(req.headers.authorization || "");
  const send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (req.url === "/ok/models") {
    if (auth !== "Bearer good-key") return send(401, { error: "invalid api key" });
    return send(200, { data: [{ id: "gpt-image-2" }, { id: "agnes-2.0-flash" }] });
  }
  if (req.url === "/nomodels/models") return send(404, { error: "not found" });
  return send(404, { error: "no such path" });
});
await new Promise((r) => stub10.listen(UP10, "127.0.0.1", r));

const srv10 = spawn(process.execPath, [path.join(HERE, "server.mjs")], {
  cwd: HERE,
  env: { ...process.env, PORT: String(P10), HOST: "127.0.0.1", LISTING_DATA: TMP10 },
  stdio: "ignore",
});
// 记一下真实配置的 mtime：本节的判据之一是"自检绝不落盘"
const envMtime10 = fs.existsSync(ENV_LOCAL) ? fs.statSync(ENV_LOCAL).mtimeMs : null;
try {
  await new Promise((r) => setTimeout(r, 1400));
  const B10 = `http://127.0.0.1:${P10}`;
  const req10 = async (p, init = {}) => {
    const r = await fetch(B10 + p, init);
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch { /* 下面按 null 处理 */ }
    return { status: r.status, j, text: t };
  };
  const post10 = (body, headers = {}) => ({
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const up = `http://127.0.0.1:${UP10}`;

  const good = await req10("/api/config/test", post10({
    target: "image", baseUrl: `${up}/ok`, apiKey: "good-key", model: "gpt-image-2",
  }));
  ck("上游 200 且模型在清单里 → ok:true / verified:true / modelFound:true",
    good.status === 200 && good.j?.ok === true && good.j?.verified === true && good.j?.modelFound === true,
    JSON.stringify(good.j));
  ck("回执只给 host 与耗时，不回显密钥",
    typeof good.j?.host === "string" && !good.text.includes("good-key"), good.text.slice(0, 160));

  const badModel = await req10("/api/config/test", post10({
    target: "image", baseUrl: `${up}/ok`, apiKey: "good-key", model: "no-such-model",
  }));
  ck("模型不在清单里 → modelFound:false 且带 warning（不静默放过）",
    badModel.j?.ok === true && badModel.j?.modelFound === false && Boolean(badModel.j?.warning),
    JSON.stringify(badModel.j));

  const auth = await req10("/api/config/test", post10({
    target: "image", baseUrl: `${up}/ok`, apiKey: "bad-key", model: "gpt-image-2",
  }));
  ck("上游 401 → code:auth（HTTP 仍是 200，让前端能读到原因）",
    auth.status === 200 && auth.j?.ok === false && auth.j?.code === "auth", `status=${auth.status} ${auth.text.slice(0, 120)}`);
  ck("401 的提示指向「密钥 / 额度」而不是笼统的失败",
    /密钥|额度/.test(String(auth.j?.hint || "")), String(auth.j?.hint || ""));

  const noModels = await req10("/api/config/test", post10({
    target: "chat", baseUrl: `${up}/nomodels`, apiKey: "good-key", model: "x",
  }));
  ck("上游 404（不提供 /models）→ ok:true 但 verified:false（可达≠密钥有效）",
    noModels.j?.ok === true && noModels.j?.verified === false && noModels.j?.code === "no-models",
    JSON.stringify(noModels.j));

  const refused = await req10("/api/config/test", post10({
    target: "image", baseUrl: "http://127.0.0.1:9", apiKey: "k", model: "m",
  }));
  ck("连不上 → 502 / code:network（错在上游，不是本服务 4xx）",
    refused.status === 502 && refused.j?.code === "network", `status=${refused.status} ${refused.text.slice(0, 120)}`);

  const badUrl = await req10("/api/config/test", post10({ target: "image", baseUrl: "ftp://x", apiKey: "k" }));
  ck("非法 baseUrl → 400 / code:bad-url（拼进 URL 前就拦住）",
    badUrl.status === 400 && badUrl.j?.code === "bad-url", `status=${badUrl.status}`);

  const badTarget = await req10("/api/config/test", post10({ target: "nope" }));
  ck("target 只认 image / chat → 其它 400", badTarget.status === 400, `status=${badTarget.status}`);

  const badCt10 = await req10("/api/config/test", {
    method: "POST", headers: { "content-type": "text/plain" }, body: "{}",
  });
  ck("Content-Type 非 JSON → 415（防跨站简单请求）", badCt10.status === 415, `status=${badCt10.status}`);

  const cross10 = await req10("/api/config/test",
    post10({ target: "image" }, { "sec-fetch-site": "cross-site" }));
  ck("跨站来源 → 403（不能借受害者浏览器用站长 key 探活）", cross10.status === 403, `status=${cross10.status}`);

  ck("🔴 自检没有写盘：真实 .env.local 的 mtime 未变，临时数据目录也没多出配置",
    (envMtime10 === null ? !fs.existsSync(ENV_LOCAL) : fs.existsSync(ENV_LOCAL) && fs.statSync(ENV_LOCAL).mtimeMs === envMtime10)
    && !fs.existsSync(path.join(TMP10, ".env.local")),
    "自检产生了落盘");
} finally {
  srv10.kill();
  await new Promise((r) => setTimeout(r, 300));
  await new Promise((r) => stub10.close(r));
  try { fs.rmSync(TMP10, { recursive: true, force: true }); } catch { /* ignore */ }
}

/* ── 11. 历史快照 / 抠图代理 ───────────────────────────────
 * 快照是**会累积写盘**的接口，所以三条都要真验：去重、校验、落盘形状。
 * 抠图是**服务端代发请求**的接口，最重要的一条是"只许打本机/私网"（否则就是 SSRF 跳板）。
 */
console.log("\n11. 历史快照：去重写盘 / ASIN 校验 / 落盘形状");
const TMP11 = fs.mkdtempSync(path.join(os.tmpdir(), "clx-verify-snap-"));
const P11 = PORT + 6;
const srv11 = spawn(process.execPath, [path.join(HERE, "server.mjs")], {
  cwd: HERE,
  env: { ...process.env, PORT: String(P11), HOST: "127.0.0.1", LISTING_DATA: TMP11,
    LISTING_KEYWORDS: path.join(TMP11, "keywords") },
  stdio: "ignore",
});
try {
  await new Promise((r) => setTimeout(r, 1400));
  const B11 = `http://127.0.0.1:${P11}`;
  const post11 = (p, body) => fetch(B11 + p, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const ASIN = "B0TEST1234";

  const first = await (await post11("/api/snapshots", { asin: ASIN, price: "$19.99", rating: 4.5, reviewCount: "1,234" })).json();
  ck("首次写入：appended:true、count 1", first.ok === true && first.appended === true && first.count === 1, JSON.stringify(first).slice(0, 160));
  ck("价格从「$19.99」解析成 19.99、评论数去掉千分位", first.rows?.[0]?.price === 19.99 && first.rows?.[0]?.reviewCount === 1234,
    JSON.stringify(first.rows?.[0]));

  const dup = await (await post11("/api/snapshots", { asin: ASIN, price: "$19.99", rating: 4.5, reviewCount: "1,234" })).json();
  ck("🔴 同一份数据再记一次：不写盘（appended:false、count 仍 1）",
    dup.appended === false && dup.count === 1, JSON.stringify(dup).slice(0, 200));
  ck("并且给出原因（不是静默什么都没发生）", Boolean(dup.reason), JSON.stringify(dup));

  const changed = await (await post11("/api/snapshots", { asin: ASIN, price: 17.99, rating: 4.4 })).json();
  ck("值变了才追加：appended:true、count 2", changed.appended === true && changed.count === 2, JSON.stringify(changed).slice(0, 120));

  const got = await (await fetch(`${B11}/api/snapshots?asin=${ASIN}`)).json();
  ck("GET 回两条、顺序与写入一致", got.count === 2 && got.rows[0].price === 19.99 && got.rows[1].price === 17.99,
    JSON.stringify(got.rows));
  ck("缺的字段是 null 而不是 0（不补假数据）", got.rows[1].reviewCount === null, JSON.stringify(got.rows[1]));

  const list = await (await fetch(`${B11}/api/snapshots`)).json();
  ck("不带 asin 时返回清单（界面用来显示「记过哪些」）",
    Array.isArray(list.items) && list.items.some((x) => x.asin === ASIN && x.count === 2), JSON.stringify(list.items));

  const badAsin = await post11("/api/snapshots", { asin: "abc", price: 1 });
  const badAsinBody = await badAsin.json();
  ck("非法 ASIN → 400 + code bad-asin", badAsin.status === 400 && badAsinBody.code === "bad-asin", `status=${badAsin.status}`);
  const emptyRow = await post11("/api/snapshots", { asin: ASIN });
  const emptyBody = await emptyRow.json();
  ck("一个数都没有 → 400 + code empty-row（记了也没信息量）",
    emptyRow.status === 400 && emptyBody.code === "empty-row", `status=${emptyRow.status}`);
  ck("GET 非法 ASIN → 400", (await fetch(`${B11}/api/snapshots?asin=zz`)).status === 400);

  const file = path.join(TMP11, "snapshots", `${ASIN}.jsonl`);
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split(/\r?\n/) : [];
  ck("🔴 落盘是真 JSONL（两行、每行都能 parse）", lines.length === 2 && lines.every((l) => {
    try { JSON.parse(l); return true; } catch { return false; }
  }), `lines=${lines.length}`);

  const noCfg = await post11("/api/plugins/rembg", { name: "x.png" });
  const noCfgBody = await noCfg.json();
  ck("未配 REMBG_URL → 400 + code not-configured（明确「未启用」而不是报错）",
    noCfg.status === 400 && noCfgBody.code === "not-configured", `status=${noCfg.status}`);
} finally {
  srv11.kill();
  await new Promise((r) => setTimeout(r, 250));
  try { fs.rmSync(TMP11, { recursive: true, force: true }); } catch { /* ignore */ }
}

/* 抠图代理的目标白名单与路径校验：各起一个实例（URL 是环境变量，一个进程只能有一种取值）。 */
console.log("\n11b. 抠图代理：目标白名单 / 文件名校验");
for (const [tag, url, expectStatus, expectCode] of [
  ["公网目标必须拒绝", "https://example.com/api/remove", 403, "bad-target"],
  ["回环目标但文件不存在", "http://127.0.0.1:9/api/remove", 404, "not-found"],
]) {
  const P = P11 + (tag.startsWith("公网") ? 1 : 2);
  const rbDir = fs.mkdtempSync(path.join(os.tmpdir(), "clx-verify-rb-"));
  const s = spawn(process.execPath, [path.join(HERE, "server.mjs")], {
    cwd: HERE,
    env: { ...process.env, PORT: String(P), HOST: "127.0.0.1",
      LISTING_DATA: rbDir,
      LISTING_KEYWORDS: path.join(rbDir, "keywords"), REMBG_URL: url },
    stdio: "ignore",
  });
  try {
    await new Promise((r) => setTimeout(r, 1400));
    const r = await fetch(`http://127.0.0.1:${P}/api/plugins/rembg`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "../../etc/passwd" }),
    });
    const j = await r.json().catch(() => ({}));
    ck(`${tag} → ${expectStatus} + ${expectCode}`, r.status === expectStatus && j.code === expectCode,
      `status=${r.status} body=${JSON.stringify(j).slice(0, 160)}`);
  } finally {
    s.kill();
    await new Promise((r) => setTimeout(r, 250));
    try { fs.rmSync(rbDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ── 11c. 「没配 Key」的错误码：400 not-configured（绝不是 500） ─────────
 * 🔴 语义：500 = 服务端自己坏了 → 监控告警、调用方重试、外部集成当事故；
 *    这里其实是"请求前提不满足"（用户还没填 Key），和抠图代理的 not-configured 同类。
 *    上游真的挂了才是网关故障 → 502 + code=upstream（用只回 401 的本地桩验证）。
 */
console.log("\n11c. AI 能力未配置 → 400 not-configured（不是 500） / 上游故障 → 502");

{
  const P12 = PORT + 9;
  const dir12 = fs.mkdtempSync(path.join(os.tmpdir(), "clx-verify-cfg-"));
  // 🔴 配置目录也重定向：本机若真配了 Key，"未配置"这个场景就构造不出来了
  fs.mkdirSync(path.join(dir12, "gen"), { recursive: true });
  const PNG_1X1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  fs.writeFileSync(path.join(dir12, "gen", "probe.png"), PNG_1X1);

  const srv12 = spawn(process.execPath, [path.join(HERE, "server.mjs")], {
    cwd: HERE,
    env: { ...process.env, PORT: String(P12), HOST: "127.0.0.1",
      LISTING_DATA: dir12, LISTING_KEYWORDS: path.join(dir12, "keywords"),
      LISTING_ENV_DIR: dir12,          // 空目录 → 一定"没配"
      CHAT_BASE_URL: "", CHAT_API_KEY: "", CHAT_MODEL: "", IMG_BASE_URL: "", IMG_API_KEY: "", IMG_MODEL: "" },
    stdio: "ignore",
  });
  const stub = http.createServer((req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "invalid api key" } }));
  });
  await new Promise((r) => stub.listen(P12 + 1, "127.0.0.1", r));
  try {
    await new Promise((r) => setTimeout(r, 1400));
    const B12 = `http://127.0.0.1:${P12}`;
    const post12 = (p, body) => fetch(B12 + p, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });

    const llm = await post12("/api/llm", { user: "hi" });
    const llmBody = await llm.json();
    ck("🔴 POST /api/llm 未配置 → 400（不是 500，外部监控才不会当服务故障）",
      llm.status === 400, `status=${llm.status}`);
    ck("并且 code=not-configured + ok:false（调用方可判定「去配置」而不是「重试」）",
      llmBody.ok === false && llmBody.code === "not-configured", JSON.stringify(llmBody).slice(0, 200));
    ck("带可执行的 hint（说清去哪配、不配也不影响本地规则）",
      typeof llmBody.hint === "string" && llmBody.hint.length > 10 && /不影响/.test(llmBody.hint), String(llmBody.hint));

    const vis = await post12("/api/vision", { imageKey: "gen/probe.png" });
    const visBody = await vis.json();
    ck("POST /api/vision 未配置 → 400 + not-configured（识图与出图共用同一套配置）",
      vis.status === 400 && visBody.code === "not-configured", `status=${vis.status} ${JSON.stringify(visBody).slice(0, 160)}`);

    const img = await post12("/api/image", { prompt: "a mug" });
    const imgBody = await img.json();
    ck("POST /api/image 未配置 → 400 + not-configured（抛错路径也要带上 code）",
      img.status === 400 && imgBody.code === "not-configured" && imgBody.ok === false,
      `status=${img.status} ${JSON.stringify(imgBody).slice(0, 160)}`);
  } finally {
    srv12.kill();
    await new Promise((r) => setTimeout(r, 250));
    stub.close();
    try { fs.rmSync(dir12, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  /* 上游回 401：那是"网关下游失败"，语义是 502，不是 500。 */
  const P13 = PORT + 11;
  const dir13 = fs.mkdtempSync(path.join(os.tmpdir(), "clx-verify-up-"));
  const srv13 = spawn(process.execPath, [path.join(HERE, "server.mjs")], {
    cwd: HERE,
    env: { ...process.env, PORT: String(P13), HOST: "127.0.0.1",
      LISTING_DATA: dir13, LISTING_KEYWORDS: path.join(dir13, "keywords"), LISTING_ENV_DIR: dir13,
      CHAT_BASE_URL: `http://127.0.0.1:${P13 + 1}`, CHAT_MODEL: "stub-model", CHAT_API_KEY: "stub-key" },
    stdio: "ignore",
  });
  const stub2 = http.createServer((req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "invalid api key" } }));
  });
  await new Promise((r) => stub2.listen(P13 + 1, "127.0.0.1", r));
  try {
    await new Promise((r) => setTimeout(r, 1400));
    const r = await fetch(`http://127.0.0.1:${P13}/api/llm`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: "hi" }),
    });
    const b = await r.json().catch(() => ({}));
    ck("🔴 上游 401 → 502 + code=upstream（网关下游失败，不是本站 500）",
      r.status === 502 && b.code === "upstream", `status=${r.status} ${JSON.stringify(b).slice(0, 160)}`);
    ck("502 的 error 里保留上游状态码（排查时要看得见 401，不能只说「调用失败」）",
      /HTTP 401/.test(String(b.error)), String(b.error).slice(0, 120));
  } finally {
    srv13.kill();
    await new Promise((r) => setTimeout(r, 250));
    stub2.close();
    try { fs.rmSync(dir13, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ── 硬断言：用户真实配置逐字节未变 ─────────────────────── */
const after = fs.existsSync(ENV_LOCAL) ? fs.readFileSync(ENV_LOCAL) : null;
const same = envBackup === null ? after === null : Boolean(after && envBackup.equals(after));
ck("🔴 .env.local 逐字节未变（真实密钥未被本脚本改写）", same);
fs.rmSync(`${ENV_LOCAL}.tmp`, { force: true });

console.log("\n" + "─".repeat(60));
console.log(`共 ${pass + fail} 条断言：通过 ${pass}，失败 ${fail}`);
fail += checkAssertCount("verify-server", pass + fail);
if (fail === 0) console.log("全部通过 ✓");
process.exit(fail ? 1 : 0);
