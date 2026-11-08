/**
 * 传输层：本地服务（server.mjs）的客户端 + 能力探测。
 *
 * 设计约束：**服务端在跑的时候，本机能力全部可用；服务端不在，本机计算能力仍然可用。**
 *   在线（node server.mjs 提供的页面）→ 走 /api/*，可以真出图、真调 LLM、能看图片库。
 *   服务端不可达（把 serverUrl 指到别的端口 / 服务中途挂了）→ 模板库 / Prompt 引擎 /
 *   Listing 质检 / 采集解析全部照常在浏览器里跑，只是不能真出图。UI 必须明确显示当前状态，
 *   不能让用户以为"点了没反应是 bug"。
 *
 * ⚠️ 注意区分两件事：「服务端不可达」和「用 file:// 打开页面」不是一回事。
 *    后者会让浏览器以 CORS 为由拦掉 ES 模块，**整个应用都启动不了**（实测见 index.html 顶部注释）。
 *    所以那种情况下这段代码根本不会执行 —— index.html 里有一段经典脚本专门挡这个。
 */

const CONFIG_KEY = "clx_listing_workbench_config";

export const DEFAULT_CONFIG = {
  serverUrl: "",          // 空 = 同源（由 server.mjs 提供页面时）
  imageBaseUrl: "https://api.apimart.ai/v1",
  imageModel: "gpt-image-2",
  imageApiKey: "",
  imageMode: "auto",      // auto | sync | async
  imageResolution: "2k",
  chatBaseUrl: "https://api.openai.com/v1",
  chatModel: "gpt-4o-mini",
  chatApiKey: "",
  visionModel: "",
  enableAiPolish: false,  // 是否用 LLM 润色文案（默认关，走本地规则）
};

export function getConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return { ...DEFAULT_CONFIG, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function setConfig(patch) {
  const next = { ...getConfig(), ...patch };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
  return next;
}

export function hasImageKey() {
  return Boolean(getConfig().imageApiKey?.trim());
}

function base() {
  return (getConfig().serverUrl || "").replace(/\/$/, "");
}

export function apiUrl(path) {
  return base() + path;
}

/* ─────────────────────── 健康探测 ─────────────────────── */

/** 成功结果的缓存时长：1 分钟。 */
export const PROBE_TTL_MS = 60_000;
/** 失败结果的缓存时长：5 秒。 */
export const PROBE_TTL_FAIL_MS = 5_000;

let probeCache = null;
let probeAt = 0;

/**
 * 缓存是否仍然有效。抽成**纯函数**是为了能在 Node 里断言
 * —— 否则"TTL 到底会不会过期"只能靠人工盯着页面猜。
 *
 * 🔴 为什么失败结果 TTL 短得多：
 *    页面往往是**先打开、服务后启动**。如果"连不上"也缓存 1 分钟，
 *    用户启动完服务回到页面，看到的仍然是"未连接"，只能手动点重探活 ——
 *    这就是上一轮审查说的"缓存永不失效"，只是那时连 TTL 都没有，两个方向都赖着不走。
 */
export function probeCacheFresh(cache, at, now = Date.now()) {
  if (!cache) return false;
  const ttl = cache.online ? PROBE_TTL_MS : PROBE_TTL_FAIL_MS;
  return now - at < ttl;
}

export async function probeServer({ force = false } = {}) {
  if (!force && probeCacheFresh(probeCache, probeAt)) return probeCache;
  const url = apiUrl("/api/health");
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const resp = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    probeCache = { online: true, ...json };
  } catch (e) {
    probeCache = {
      online: false,
      reason: location.protocol === "file:"
        // ⚠️ 实测（Edge 153 headless）：file:// 下浏览器的 CORS 会把 ES 模块整个拦掉，
        //    所以这段提示正常情况下根本不会显示（JS 压根没跑）。留着是为了万一有环境能跑。
        ? "页面是以 file:// 打开的。浏览器不允许 file:// 页面访问本地服务，请改用 node server.mjs 启动后访问 http://127.0.0.1:8787/"
        : `连不上本地服务（${e.message}）。请先运行 node server.mjs`,
      capabilities: { image: false, chat: false, vision: false, storage: false },
    };
  }
  probeAt = Date.now();
  return probeCache;
}

export function clearProbeCache() { probeCache = null; probeAt = 0; }

/** 给界面用："这份探活结果是多少秒前的"。 */
export function probeCacheAge(now = Date.now()) {
  return probeCache ? Math.max(0, Math.round((now - probeAt) / 1000)) : null;
}

/* ─────────────────────── SSE ─────────────────────── */

/**
 * 解析 SSE 流。事件名与参考项目 ecom-details-image-ui 保持一致：
 *   ai_response / tool_call / tool_result / file_output / usage / ping / error_message
 * 这样做的好处：前端的 dispatch 逻辑结构可以直接对齐，行为可对照。
 */
export async function streamSSE(resp, onEvent, signal) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const seen = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";
    for (const raw of chunks) {
      const lines = raw.split("\n").filter((l) => l.startsWith("data:"));
      for (const line of lines) {
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const ev = JSON.parse(data);
          if (ev.type === "ping") continue;
          seen.push(ev.type);
          onEvent(ev);
        } catch {
          /* 单条坏帧不影响整条流 */
        }
      }
    }
  }
  return seen;
}

/* ─────────────────────── 具体接口 ─────────────────────── */

/**
 * @param {object} o
 * @param {string} [o.templateId] 可选：用户在模板库显式指定的模板 id。
 *   **不传就是自动匹配** —— 别把"当前浏览的模板"默认塞进来，那会让自动匹配永远失效。
 */
export async function postChat({ message, imageKey, templateId, onEvent, signal }) {
  const resp = await fetch(apiUrl("/api/chat"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, imageKey, templateId }),
    signal,
  });
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => "");
    throw new Error(`/api/chat HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  return streamSSE(resp, onEvent, signal);
}

export async function uploadImage(file) {
  const form = new FormData();
  form.append("file", file);
  const resp = await fetch(apiUrl("/api/upload"), { method: "POST", body: form });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json.error || `上传失败 HTTP ${resp.status}`);
  return json; // { key, url, contentType, size }
}

export async function generateImage({ prompt, size, imageKey, signal }) {
  const resp = await fetch(apiUrl("/api/image"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, size, imageKey }),
    signal,
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json.error || `生图失败 HTTP ${resp.status}`);
  return json; // { url, filename, mode, elapsedMs, cost? }
}

export async function callVision({ imageKey, signal }) {
  const resp = await fetch(apiUrl("/api/vision"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageKey }),
    signal,
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json.error || `识图失败 HTTP ${resp.status}`);
  return json;
}

export async function callLLM({ system, user, temperature = 0.6, signal }) {
  const resp = await fetch(apiUrl("/api/llm"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system, user, temperature }),
    signal,
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json.error || `对话失败 HTTP ${resp.status}`);
  return json; // { text, model }
}

/** 导出用：把任意文本存成本地文件（浏览器端 Blob 下载，不需要服务端） */
export function downloadText(filename, text, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadJSON(filename, obj) {
  downloadText(filename, JSON.stringify(obj, null, 2), "application/json;charset=utf-8");
}
