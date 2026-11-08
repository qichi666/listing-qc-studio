/**
 * 出网安全：SSRF 防护（供 server.mjs 与自检脚本共用，浏览器端不会引用到）。
 *
 * 🔴 为什么必须做：
 *   生图接口的响应里带 `url` 字段，服务端会去**下载它**（downloadToGen）。
 *   这个 url 完全由**上游服务**决定 —— 上游被投毒、被中间人改写、或前端直接塞进
 *   `imageUrl`，本机就会以**自己的身份**去访问：
 *     · http://127.0.0.1:xxxx/  → 打本机其它服务（本机这些内部接口没有鉴权）
 *     · http://169.254.169.254/ → 云元数据，AWS/GCP/Azure 都能从这掏出临时凭证
 *     · http://10.x / 192.168.x  → 内网横向
 *   这就是 SSRF。
 *
 * OWASP 给出的处置优先级：**域名白名单 > 解析后按 IP 判内网 > 只做字符串匹配**。
 *   本项目无法用白名单（用户可自配任意服务商），所以退到第二档：
 *   ① 只允许 http/https；
 *   ② DNS **解析**出全部 IP，逐个判内网段（不是拿域名字符串去猜）；
 *   ③ 禁自动重定向 —— 3xx 跳转是最常见的"绕过第一次校验"手法。
 *
 * ⚠️ 已知上限（2026-11 已修）：DNS rebinding 的 TOCTOU 窗口 —— 解析与 fetch 是两次独立查询，
 *   攻击者可以在两次之间把域名改指内网。光"解析后判内网"挡不住这一步。
 *   现在下载走 `downloadPinned()`：**解析一次 → 把 IP 钉进连接（lookup 钩子）→ TLS 用原域名做 SNI**，
 *   校验和连接用的是同一个 IP，窗口关闭。仍未做的是 HTTP/2 与连接复用场景（本项目不用）。
 */
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";

/** 内网 / 保留 / 不可路由 IPv4 段（RFC1918 + 回环 + 链路本地 + CGNAT + 基准测试 + 组播） */
export const PRIVATE_V4 = [
  /^0\./, /^10\./, /^127\./, /^169\.254\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,                 // 172.16.0.0/12
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,   // 100.64.0.0/10（CGNAT）
  /^198\.1[89]\./,                              // 198.18.0.0/15 基准测试
  /^22[4-9]\./, /^2[3-5]\d\./,                  // 224.0.0.0/4 起：组播 + 保留
];

/** 不该被本机主动访问的主机名（`.local` / `.internal` 在办公网里常指向内网设备） */
const BAD_HOSTNAME = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/;

/**
 * 单个 IP 是否属于"不该被本机主动访问"的范围。
 * 拿不到合法 IP 时返回 true —— 宁可误拒，也不放行一个没判明的目标。
 */
export function isPrivateIp(ip) {
  const s = String(ip || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!s) return true;
  if (s === "::" || s === "::1") return true;
  if (s.startsWith("::ffff:")) return isPrivateIp(s.slice(7));   // IPv4 映射地址，拆出来再判
  if (/^f[cd][0-9a-f]{2}:/.test(s)) return true;                 // fc00::/7 唯一本地地址
  if (/^fe[89ab][0-9a-f]:/.test(s)) return true;                 // fe80::/10 链路本地
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return PRIVATE_V4.some((re) => re.test(s));
  return false;                                                  // 其余视为公网 IPv6
}

/**
 * 校验要出网的 URL。不合法 / 指向内网 → 抛错。
 * 调用方应当把这个错误当普通失败处理，**不要**回显给外部（避免变成内网探测工具）。
 * @returns {Promise<URL>}
 */
export async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(String(raw || "")); } catch { throw new Error("图片地址不是合法 URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`不允许的协议：${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) throw new Error("图片地址缺少主机名");
  if (BAD_HOSTNAME.test(host)) throw new Error(`不允许的主机名：${host}`);

  let addrs = [];
  try { addrs = await dns.lookup(host, { all: true }); } catch { throw new Error(`域名解析失败：${host}`); }
  if (!addrs.length) throw new Error(`域名无解析结果：${host}`);
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error(`拒绝访问内网地址：${host} → ${a.address}`);
  }
  return u;
}

/* ─────────── IP 钉死下载：关闭 DNS rebinding 的 TOCTOU 窗口 ───────────
 * 思路：**只解析一次**，把这个 IP 直接交给 socket（`lookup` 钩子），
 *      同时把原域名留给 TLS 的 SNI / 证书校验和 Host 头。
 * 这样"校验的 IP"和"连的 IP"必然是同一个 —— 中间人再改 DNS 也没用。
 */
export async function resolvePublicHost(raw) {
  const u = await assertPublicUrl(raw);                 // 协议 + 主机名 + 全部解析结果逐一判内网
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const addrs = await dns.lookup(host, { all: true });
  const pick = addrs.find((a) => a.family === 4) || addrs[0];   // 优先 IPv4（部分环境 IPv6 不可达）
  if (!pick) throw new Error(`域名无解析结果：${host}`);
  return { url: u, address: pick.address, family: pick.family };
}

/** 用钉死的 IP 发一次 GET。返回 { status, headers, body }。 */
export function getPinned(pinned, { headers = {}, timeoutMs = 120000 } = {}) {
  const { url, address, family } = pinned;
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const req = lib.request({
      protocol: url.protocol,
      hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { ...headers, Host: url.host },
      // 🔴 TLS 仍按**域名**握手（SNI + 证书校验都针对域名），只是 TCP 连到钉死的 IP
      ...(isHttps ? { servername: hostname } : {}),
      // 🔴 这个钩子就是"钉死"本身。Node 有两种调用形态（带 all 选项 / 不带），都要覆盖。
      lookup: (h, options, cb) => {
        if (typeof options === "function") { cb = options; options = {}; }
        if (options && options.all) return cb(null, [{ address, family }]);
        return cb(null, address, family);
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        let body = Buffer.concat(chunks);
        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        try {
          if (enc.includes("gzip")) body = zlib.gunzipSync(body);
          else if (enc.includes("deflate")) body = zlib.inflateSync(body);
          else if (enc.includes("br") && zlib.brotliDecompressSync) body = zlib.brotliDecompressSync(body);
        } catch { /* 解压失败就按原样返回，让上层按内容判断 */ }
        resolve({ status: res.statusCode || 0, headers: res.headers, body });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`下载超时（${Math.round(timeoutMs / 1000)}s）`)));
    req.end();
  });
}

/**
 * 下载一个"由上游给出"的 URL。每一跳都**重新解析 + 重新判内网 + 重新钉 IP**。
 * 允许有限次重定向（CDN 常见），但不允许跳到内网 —— 这是原来"直接拒绝 3xx"的升级版：
 * 拒绝虽然安全，却把正常 CDN 跳转也一起拒了；复检+钉死既安全又能用。
 */
export async function downloadPinned(rawUrl, { headers = {}, timeoutMs = 120000, maxRedirects = 2, maxBytes = 40 * 1024 * 1024 } = {}) {
  let current = String(rawUrl || "");
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const pinned = await resolvePublicHost(current);
    const res = await getPinned(pinned, { headers, timeoutMs });
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      try { current = new URL(String(res.headers.location), current).toString(); } catch { throw new Error("重定向地址不合法"); }
      continue;
    }
    if (res.status !== 200) throw new Error(`下载图片失败 HTTP ${res.status}`);
    if (res.body.length > maxBytes) throw new Error(`图片过大（${(res.body.length / 1024 / 1024).toFixed(1)}MB，上限 ${Math.round(maxBytes / 1024 / 1024)}MB）`);
    if (!res.body.length) throw new Error("下载到的内容为空");
    return { body: res.body, contentType: String(res.headers["content-type"] || ""), finalUrl: current };
  }
  throw new Error("重定向次数过多（可能被用来绕过内网校验）");
}

/**
 * Host 头校验值集合的构造。服务只对本机开放，所以只认回环与 localhost。
 * 用途：挡 DNS rebinding —— 攻击者用自己的域名解析到 127.0.0.1，
 * 浏览器把请求发到本机服务，此时 Host 是攻击者的域名，必须拒绝。
 */export function allowedHosts(extra = []) {
  const set = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  for (const h of extra) if (h) set.add(String(h).toLowerCase());
  return set;
}

/** 从 `Host: 127.0.0.1:8787` / `Host: [::1]:8787` 取出裸主机名（小写、去端口、去方括号） */
export function bareHost(hostHeader) {
  const h = String(hostHeader || "").trim().toLowerCase();
  if (!h) return "";
  const i = h.indexOf("]");
  if (h.startsWith("[") && i > 0) return h.slice(0, i + 1);
  return h.split(":")[0];
}
