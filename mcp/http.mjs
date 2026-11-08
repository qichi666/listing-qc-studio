#!/usr/bin/env node
/**
 * listing-studio MCP · 回环 HTTP（P0-B2：一个 URL 接入，零 npm 依赖）
 *
 * ── 为什么要有它 ──────────────────────────────────────────────────
 * stdio 版要求客户端 spawn 一个进程、写绝对路径配置；竞品（卖家精灵 / Helium 10）
 * 是「复制一个 URL」就接上。我们**不能把数据搬到云端**（本地优先、数据可整包带走），
 * 所以只把「URL 形态」搬到本机：客户端填 `http://127.0.0.1:8790/mcp` 即可。
 * 代价是多一个常驻进程，以及必须自己做 Host / Origin / token 三层防护 ——
 * 本机 HTTP 服务天然对浏览器可见，一个恶意网页就能 fetch 它。
 *
 * ── 启动 ──────────────────────────────────────────────────────────
 *   node mcp/http.mjs                      # 默认端口 8790（避开 server.mjs 的 8787）
 *   MCP_HTTP_PORT=9000 node mcp/http.mjs  # 改端口
 *   MCP_TOKEN_FILE=<路径> node mcp/http.mjs  # 改 token 落盘位置（仅供自测，默认不用）
 *
 * 🔴 铁律
 *   ① 只绑 `127.0.0.1`，不用 `0.0.0.0`；启动后用 `server.address().address` 再硬断言一次。
 *   ② 只实现 `POST /mcp` 的**单响应 JSON** 模式；`GET /mcp` → 405，不提供 SSE 流。
 *      理由：8 个工具全是单轮请求/响应，没有服务端主动推送场景。
 *   ③ token 每次启动随机生成、写 `data/mcp-setup/token.txt`（0600）；重启即换新。
 *      客户端优先 `Authorization: Bearer`；只支持「填一个 URL」的客户端才用 `?token=`，
 *      降级短效 12h 且拒绝非空 Referer（详见 handler.mjs）。
 *   ④ `mcp/server.mjs` 的 stdio 闸门 / readline 主循环在 HTTP 进程里**不能启动**。
 *      做法：先设 `MCP_HTTP_NO_STDIO=1`，再 **动态** import（静态 import 会被提升，
 *      环境变量来不及设）。协议处理函数 `handle` 与 stdio 版是同一个，不复制第二份。
 *   ⑤ 日志一律走 stderr。stdout 在这条链路上不承载任何东西（响应走 socket）。
 */

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createRequestHandler } from "./handler.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(HERE, "..");
const MCP_PATH = "/mcp";
const DEFAULT_PORT = 8790;
const PORT = Number(process.env.MCP_HTTP_PORT) > 0
  ? Math.floor(Number(process.env.MCP_HTTP_PORT))
  : DEFAULT_PORT;
const TOKEN_FILE = process.env.MCP_TOKEN_FILE || join(PROJECT, "data", "mcp-setup", "token.txt");

// 🔴 顺序是硬的：先设开关，再动态 import。见文件头铁律 ④。
process.env.MCP_HTTP_NO_STDIO = "1";
const { handle: dispatch, TOOLS } = await import("./server.mjs");

const token = randomBytes(32).toString("hex");
const startedAt = Date.now();

// token 落盘：0600。Windows 上 POSIX mode 是 best-effort（ACL 继承自目录），
// 但 writeFileSync 的 mode 与随后的 chmodSync 都写上，Linux/macOS 上是真 0600。
mkdirSync(dirname(TOKEN_FILE), { recursive: true });
writeFileSync(TOKEN_FILE, token, { encoding: "utf8", mode: 0o600 });
try { chmodSync(TOKEN_FILE, 0o600); } catch { /* Windows 上不致命，不为此中断启动 */ }

const handleHttp = createRequestHandler({ dispatch, token, startedAt });
const log = (...a) => process.stderr.write(`[mcp-http] ${a.join(" ")}\n`);

const server = createServer(async (req, res) => {
  // 请求体上限 1MB：8 个工具的参数都是文案级文本，超了就是异常输入，别让内存被打爆。
  const chunks = [];
  let size = 0;
  try {
    for await (const c of req) {
      size += c.length;
      if (size > 1024 * 1024) {
        res.writeHead(413, { "content-type": "text/plain; charset=utf-8" });
        res.end("Payload Too Large");
        return;
      }
      chunks.push(c);
    }
  } catch {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("Bad Request");
    return;
  }

  let out;
  try {
    out = await handleHttp({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    });
  } catch (e) {
    log(`处理请求时抛错：${e.message}`);
    out = {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: e.message } }),
    };
  }
  res.writeHead(out.status, out.headers);
  res.end(out.body);
});

server.on("error", (e) => {
  log(`✗ 监听失败：${e.message}（端口 ${PORT} 被占用？用 MCP_HTTP_PORT 换一个）`);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  const addr = server.address();
  // ① 绑定事实自证：不是 127.0.0.1 就拒绝启动（不是"打一行日志就算了"）。
  if (!addr || addr.address !== "127.0.0.1") {
    log(`✗ 绑定地址不是 127.0.0.1（实际 ${addr?.address}），拒绝启动`);
    server.close();
    process.exit(1);
  }
  const url = `http://127.0.0.1:${addr.port}${MCP_PATH}`;
  process.stderr.write([
    "",
    "─".repeat(70),
    "  listing-studio MCP · 回环 HTTP（Streamable HTTP · 单响应 JSON 模式）",
    `  监听      ${addr.address}:${addr.port}  ·  工具 ${TOOLS.length} 个  ·  server.address().address=${addr.address}（已断言为回环）`,
    `  接入 URL  ${url}`,
    `  token     ${token}`,
    `  token 文件 ${TOKEN_FILE}（0600；重启服务会换 token）`,
    "",
    "  客户端优先用请求头：Authorization: Bearer <token>",
    "  只支持「填一个 URL」的客户端才用下面这条 —— URL 含密钥，别截图、别贴日志，12 小时后失效：",
    `  ${url}?token=${token}`,
    "",
    "  文档：mcp/README.md（安全四条 / 不做清单）",
    "─".repeat(70),
    "",
  ].join("\n"));
});
