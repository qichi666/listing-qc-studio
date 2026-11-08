#!/usr/bin/env node
/**
 * 回环 HTTP 的**纯请求处理层**（P0-B2）。不监听端口、不写文件、不碰 req/res 对象。
 *
 * ── 为什么要单独一层 ──────────────────────────────────────────────
 * `mcp/server.mjs` 里的 `handle(msg)` 是协议层（一条 JSON-RPC → 一个响应对象），
 * stdio 与 HTTP 都复用它。但 HTTP 还多出四件与协议无关的事：Host 白名单、
 * Origin 校验、Bearer token、方法/路径路由。把这些塞进 server.mjs 会污染 stdio
 * 那份「只读、零副作用」的源码（自检第 12 节静态查它），也会让安全逻辑没法单测。
 * 所以拆成：server.mjs（协议）→ handler.mjs（HTTP 请求，纯函数）→ http.mjs（进程/监听/落盘）。
 *
 * 🔴 三层都不做第二份判断：tools/list 的字节来自 `dispatch`（即 server.mjs 的 handle），
 *    handler.mjs 只负责"拦不拦 / 怎么把结果装进 HTTP 响应"，一个工具定义一个字都不复制。
 *
 * ── 安全四条（一条都不能少，§4 P0-B2 / §10.3）──────────────────────
 *   ① 绑定只认 127.0.0.1 —— 由 http.mjs 用 server.address() 硬断言；
 *   ② Host 白名单只认 127.0.0.1 / localhost —— 防 DNS rebinding，`Host: evil.com` → 403；
 *   ③ 有 Origin 且非本机 → 403 —— 浏览器跨站 fetch 的第二道（第一道是不回 CORS 头）；
 *   ④ Bearer token —— 优先 `Authorization: Bearer`，只支持"填一个 URL"的客户端才降级
 *      `?token=`，且降级必须同时满足短效 12h + 拒绝非空 Referer。
 *
 * 🔴 只实现 POST：8 个工具全是单轮请求/响应，没有服务端主动推送场景，
 *    因此只做 Streamable HTTP 的「单响应 JSON」模式，不实现 SSE 流、不实现 GET 长连接。
 *    OPTIONS 也不回任何 `Access-Control-Allow-*`：浏览器预检在第一道就被拦掉，零代码。
 */

import { timingSafeEqual } from "node:crypto";

/** 本机 Host / Origin 白名单：精确匹配，绝不用 endsWith（否则 127.0.0.1.evil.com 会混进来）。 */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

/** `?token=` 降级的有效期。token 每次启动都换，所以"启动后 12h"就是它的生存期。 */
export const URL_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

/** 从 Host 头剥掉端口。IPv6 字面量也处理，但只绑 127.0.0.1 时其实走不到。 */
function hostName(host) {
  let h = String(host || "").trim().toLowerCase();
  if (!h) return "";
  if (h.startsWith("[")) {
    const i = h.indexOf("]");
    return h.slice(1, i < 0 ? undefined : i);
  }
  const i = h.lastIndexOf(":");
  if (i > 0 && /^\d+$/.test(h.slice(i + 1))) h = h.slice(0, i);
  return h;
}

/** 没有 Origin 时交给 Host + token 两道；有 Origin 就必须解析出本机 hostname。 */
function isLocalOrigin(origin) {
  if (!origin) return true;
  if (origin === "null") return false; // opaque origin，不认
  try {
    return LOCAL_HOSTS.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** 定时安全比较。`timingSafeEqual` 长度不同会抛，所以必须先判长度。 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * 工厂：把 token / 启动时刻 / dispatch 注入，返回一个**纯函数**
 *   ({ method, url, headers, body }) → { status, headers, body }
 * 🔴 不 import server.mjs（那会触发 stdio 副作用），也不接受 req/res 原生对象 ——
 *    所以临时脚本可以直接 new 一个 handler 单测四条安全规则，不用起端口。
 *
 * @param {object} cfg
 * @param {(msg:object)=>Promise<object|null>} cfg.dispatch 与 stdio 完全相同的处理函数
 * @param {string}  cfg.token       本次启动的随机 token
 * @param {number}  [cfg.startedAt] 启动时刻（ms），用于 12h 降级有效期；可注入以便单测
 * @param {number}  [cfg.urlTtlMs]  降级有效期，默认 12h
 */
export function createRequestHandler({ dispatch, token, startedAt = Date.now(), urlTtlMs = URL_TOKEN_TTL_MS }) {
  const json = (status, obj, extra = {}) => ({
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    },
    body: obj === null ? "" : JSON.stringify(obj),
  });
  const text = (status, msg, extra = {}) => ({
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra },
    body: msg,
  });
  const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  return async function handleHttp(parts) {
    const method = String(parts.method || "GET").toUpperCase();
    const headers = parts.headers || {};
    const url = String(parts.url || "/");
    const pathname = url.split("?")[0];

    // ① 只认 POST /mcp
    if (pathname !== "/mcp") return text(404, "Not Found");
    if (method !== "POST") {
      // 🔴 GET /mcp → 405 的理由（§10.3）：8 个工具全是单轮请求/响应，没有服务端主动推送，
      //    只实现「单响应 JSON」模式，不实现 SSE 流 / GET 长连接。OPTIONS 也不回 CORS 头，
      //    浏览器跨站 fetch 的预检在这第一道就被拦掉。
      return text(405, "Method Not Allowed: 只实现 POST /mcp（Streamable HTTP 单响应 JSON 模式，无 SSE 流）", { allow: "POST" });
    }

    // ② Host 白名单（防 DNS rebinding）。curl 能伪造 Host，所以这道必须在服务端做。
    if (!LOCAL_HOSTS.has(hostName(headers.host))) {
      return text(403, "Forbidden: Host 不在白名单（只认 127.0.0.1 / localhost）");
    }

    // ③ Origin 校验：有 Origin 且非本机一律 403（浏览器发起的跨站请求在这里被拒）。
    if (!isLocalOrigin(headers.origin)) {
      return text(403, "Forbidden: Origin 非本机");
    }

    // ④ Bearer token
    const auth = String(headers.authorization || "").trim();
    let authed = false;
    if (auth) {
      // 优先 Authorization: Bearer <token>。只要带了这个头就**不降级**到 ?token=，
      // 免得一个错的头被 URL 里的 token 悄悄兜底。
      const m = /^Bearer\s+(.+)$/i.exec(auth);
      if (m && safeEqual(m[1].trim(), token)) authed = true;
    } else {
      // 降级路径：只支持「填一个 URL」的客户端才用。三个条件必须同时满足：
      //   token 正确 / 启动后 12h 内 / Referer 为空。
      const qs = new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?") + 1) : "");
      const qToken = qs.get("token");
      const referer = String(headers.referer || "").trim();
      if (qToken) {
        if (referer) {
          return text(403, "Forbidden: ?token= 降级不接受非空 Referer（URL 含密钥，别让它进 Referer / 日志 / 浏览器历史）");
        }
        if (Date.now() - startedAt >= urlTtlMs) {
          return text(403, "Forbidden: ?token= 降级已超过 12 小时，请重启服务或改用 Authorization: Bearer");
        }
        if (safeEqual(qToken, token)) authed = true;
      }
    }
    if (!authed) {
      return json(401, rpcError(null, -32001, "Unauthorized: 缺少或错误的 Bearer token（读 data/mcp-setup/token.txt）"), { "www-authenticate": "Bearer" });
    }

    // ⑤ 解析请求体：只接受**单条** JSON-RPC 消息对象，不实现批量（8 工具都是单轮，没必要）。
    let msg;
    try {
      msg = JSON.parse(String(parts.body || ""));
    } catch {
      return json(400, rpcError(null, -32700, "Parse error: 请求体不是合法 JSON"));
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      return json(400, rpcError(null, -32600, "Invalid Request: 只接受单条 JSON-RPC 消息对象"));
    }

    // ⑥ 复用 stdio 的**同一个** handle()：这是 tools/list 逐字节相同的直接证据。
    let res;
    try {
      res = await dispatch(msg);
    } catch (e) {
      return json(500, rpcError(msg.id, -32603, `Internal error: ${e.message}`));
    }
    // 通知（无 id）→ 202 Accepted + 空 body（Streamable HTTP 的规定，客户端不等回包）。
    if (res === null || res === undefined) {
      return { status: 202, headers: { "cache-control": "no-store" }, body: "" };
    }
    return json(200, res);
  };
}
