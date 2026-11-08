/**
 * Streamable HTTP 版 MCP 客户端（零依赖）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * 本项目的 MCP server 是 **stdio**（自己的判断层，客户端起进程来调）。
 * 但外部数据源（卖家精灵 / 西柚这类）走的是 **Streamable HTTP**：
 * 我们得当客户端去连它，才能拿到搜索量、ABA 排名这些本地算不出来的东西。
 *
 * ── 协议要点（全是踩过才知道的）─────────────────────────────────────
 *   ① 一个 POST 就是一条 JSON-RPC 消息，不是长连接。SSE 只是**单个请求的响应格式**：
 *      服务端可能回 `application/json`（一整个对象），也可能回 `text/event-stream`
 *      （若干 `data: {...}` 行），两种都得认 —— 只认 JSON 的实现在真服务上会"永远没回包"。
 *   ② `initialize` 的响应头可能带 `Mcp-Session-Id`，**后续每个请求都必须原样回带**，
 *      否则服务端当成新会话（表现是工具列表空、或者一直 400）。
 *   ③ 发完 `notifications/initialized` 不要等响应 —— 它是通知，没有 id。
 *      服务端通常回 202/204，也可能干脆不回 body。
 *   ④ 鉴权由调用方给 header（卖家精灵是 `secret-key`）。本模块不认任何具体厂商。
 *
 * 🔴 本模块**只做传输**：不读配置、不写盘、不做白名单。
 *    白名单必须在上层（server.mjs）用常量钉死 —— 否则 url 一旦来自请求体，
 *    这里就变成了一个通用的 SSRF 跳板。
 */

const DEFAULT_TIMEOUT = 30000;

/** 把 SSE 文本切成事件块，取出每个 `data:` 行拼起来的 JSON。 */
function parseSseChunk(text) {
  const out = [];
  for (const block of text.split(/\n\n/)) {
    const data = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try { out.push(JSON.parse(data)); } catch { /* 非法帧直接跳过，不猜 */ }
  }
  return out;
}

/**
 * 读一个响应体，返回其中的 JSON-RPC 消息数组。
 * 两种 Content-Type 都要认 —— 这是本模块存在的第一个理由。
 */
async function readMessages(res, wantId) {
  const ct = String(res.headers.get("content-type") || "").toLowerCase();

  if (ct.includes("text/event-stream")) {
    const reader = res.body?.getReader();
    if (!reader) throw new Error("服务端声明了 SSE 但没有响应体");
    const decoder = new TextDecoder();
    let buf = "";
    // 边读边判：只要拿到了对 id 的那条就停，不把整个流读完（有些服务端保持长连接不回 close）
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      const msgs = parseSseChunk(buf);
      const hit = msgs.find((m) => m.id === wantId);
      if (hit) {
        try { await reader.cancel(); } catch { /* 已经关了 */ }
        return [hit];
      }
      if (done) break;
    }
    const rest = parseSseChunk(buf);
    if (rest.length) return rest;
    throw new Error(`SSE 流结束了但没等到 id=${wantId} 的响应（协议不匹配？）`);
  }

  const text = await res.text();
  if (!text.trim()) return [];
  try {
    const j = JSON.parse(text);
    return Array.isArray(j) ? j : [j];
  } catch {
    // 有些网关会在 200 里塞 HTML 错误页
    throw new Error(`响应不是 JSON（前 120 字符）：${text.slice(0, 120).replace(/\s+/g, " ")}`);
  }
}

export class HttpMcpError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "HttpMcpError";
    this.status = status;
    this.body = body;
  }
}

export class HttpMcp {
  /**
   * @param {{url:string, headers?:Record<string,string>, timeout?:number}} opt
   */
  constructor({ url, headers = {}, timeout = DEFAULT_TIMEOUT }) {
    this.url = url;
    this.headers = headers;
    this.timeout = timeout;
    this.sessionId = null;
    this.protocolVersion = null;
    this.serverInfo = null;
    this._seq = 0;
  }

  /** 发一条消息，返回匹配 id 的 result；通知（id 为空）返回 null。 */
  async _post(method, params, { notify = false } = {}) {
    const msg = { jsonrpc: "2.0", method };
    if (params !== undefined) msg.params = params;
    const id = notify ? undefined : ++this._seq;
    if (!notify) msg.id = id;

    const h = {
      "content-type": "application/json",
      // 两个都要：服务端据此决定回 JSON 还是 SSE。只写 json 的客户端在部分实现上会 406。
      accept: "application/json, text/event-stream",
      ...this.headers,
    };
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    if (this.protocolVersion) h["mcp-protocol-version"] = this.protocolVersion;

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeout);
    let res;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: h,
        body: JSON.stringify(msg),
        signal: ctl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === "AbortError") throw new HttpMcpError(`请求超时（${this.timeout}ms）：${method}`);
      throw new HttpMcpError(`连不上 ${this.url}：${e.message}`);
    }

    // 会话 id 只在 initialize 的响应头里出现一次，必须抓住
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      clearTimeout(timer);
      if (res.status === 401 || res.status === 403) {
        throw new HttpMcpError(`鉴权失败（HTTP ${res.status}）—— 检查密钥是否有效/是否过期`, { status: res.status, body });
      }
      throw new HttpMcpError(`HTTP ${res.status} ${res.statusText}：${body.slice(0, 160).replace(/\s+/g, " ")}`, { status: res.status, body });
    }

    if (notify) {
      clearTimeout(timer);
      try { await res.body?.cancel(); } catch { /* 有的实现通知也回 SSE */ }
      return null;
    }

    try {
      const msgs = await readMessages(res, id);
      clearTimeout(timer);
      const hit = msgs.find((m) => m.id === id);
      if (!hit) throw new HttpMcpError(`响应里没有 id=${id} 的消息（收到 ${msgs.length} 条）`);
      if (hit.error) throw new HttpMcpError(`${hit.error.code ?? ""} ${hit.error.message || "JSON-RPC 错误"}`.trim());
      return hit.result;
    } catch (e) {
      clearTimeout(timer);
      if (e.name === "AbortError") throw new HttpMcpError(`读响应超时（${this.timeout}ms）：${method}`);
      throw e;
    }
  }

  /** 握手。之后这个实例就可以 listTools / callTool 了。 */
  async initialize(clientInfo = { name: "listing-studio", version: "1.0.0" }) {
    const r = await this._post("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo,
    });
    this.protocolVersion = r?.protocolVersion || "2025-06-18";
    this.serverInfo = r?.serverInfo || null;
    // 🔴 通知：没有 id，不等回包。等它就是最常见的"接上了但一直转圈"。
    await this._post("notifications/initialized", {}, { notify: true });
    return r;
  }

  async listTools() {
    const r = await this._post("tools/list", {});
    return r?.tools || [];
  }

  /**
   * 调一个工具，把协议壳剥掉。
   * 返回 { isError, text, data } —— data 是 text 里 JSON.parse 的结果（解析不了就给 null）。
   * 不同服务端把结果放在 text / structuredContent / resource 里，这里尽量都兼容。
   */
  async callTool(name, args = {}) {
    const r = await this._post("tools/call", { name, arguments: args });
    const isError = Boolean(r?.isError);
    const block = Array.isArray(r?.content) ? r.content.find((c) => c && c.type === "text") : null;
    const text = block?.text ?? (r?.structuredContent ? JSON.stringify(r.structuredContent) : "");
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = null; }
    }
    if (!data && r?.structuredContent) data = r.structuredContent;
    return { isError, text, data };
  }

  /** 一次性的快捷入口：连上 → 列表 → 调用 → 丢弃。用完不复用会话。 */
  static async once(opt, fn) {
    const c = new HttpMcp(opt);
    await c.initialize();
    try {
      return await fn(c);
    } finally {
      // Streamable HTTP 没有"关闭"这个词，会话靠服务端过期。这里只清本地引用。
      c.sessionId = null;
    }
  }
}
