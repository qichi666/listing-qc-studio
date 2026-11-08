/**
 * 本地持久化层（IndexedDB，**零依赖**）。
 *
 * ── 为什么要这一层 ─────────────────────────────────────────────
 * 采集到的竞品数据、算出来的 14 张 Prompt、质检报告 —— 刷新页面就全没了。
 * 卖家迭代一个 listing 通常跨多次 session，关掉浏览器从零开始 = 玩具，不是工具。
 *
 * ── 为什么不用 localStorage ────────────────────────────────────
 * ① 容量：localStorage 只有 ~5MB，而一份图像方案（14 张 Prompt + 简报）就有几十 KB，
 *    采集的竞品数据更大；② 它是**同步** API，几百 KB 的读写会卡住 UI。
 * IndexedDB 是异步 + 配额按磁盘比例给（几百 MB 起），这才是放产物的位置。
 *
 * ── 为什么不用服务端 ──────────────────────────────────────────
 * 项目原则是"本地优先、产物不出本机"。IndexedDB 就在浏览器里，符合这条。
 * ⚠️ 这里**不存 API Key** —— 密钥在 `api.js` 的配置里（localStorage），两者刻意分开：
 *    产物可以被导出/分享，密钥不行。
 *
 * ── 可测试性（重要）──────────────────────────────────────────
 * 自检跑在 Node 里，**没有 IndexedDB**。所以本模块：
 *   ① 顶层不碰任何浏览器 API（只是常量与函数定义）；
 *   ② 把记录构造 / 裁剪 / 排序 / 指纹 / 摘要做成**纯函数**并导出 → 可以在 Node 里直接断言；
 *   ③ `isAvailable()` 在 Node 里返回 false 而不是抛错，`save()/list()` 随之为无操作的安全返回值。
 * 这样"持久化"这件浏览器专属的事，仍然有可断言的部分，且降级路径被真实测到。
 */

const DB_NAME = "clx_listing_workbench";
const DB_VERSION = 1;
const STORE = "items";
/** 单条记录载荷上限（字符）。超了就裁剪 —— 宁可存不全，也不能一条撑爆配额。 */
export const MAX_PAYLOAD_CHARS = 400_000;
/** 历史保留条数上限（每类）。超出时淘汰最旧的。 */
export const MAX_RECORDS_PER_KIND = 60;

/**
 * 产物类型。`kind` 用单 store + 索引，比每类一个 store 更好做跨类清理与统计。
 *
 * `icon` 存的是**图标 id**（字符串），不是图形本身 —— 数据层不许夹带 SVG：
 * 图形只在 `app.js` 的 ICONS 注册表里写一遍，这里只声明"用哪一个"。
 * 改这里的 id 必须同步改那个注册表（改错的表现是图标位空掉，不会报错，所以别随手改）。
 */
export const KINDS = {
  capture: { label: "采集", icon: "download", desc: "从亚马逊页面抓到的商品数据" },
  plan: { label: "图像方案", icon: "image", desc: "整套 Prompt 规划与简报" },
  listing: { label: "Listing", icon: "file-text", desc: "文案 + 质检报告" },
  coverage: { label: "覆盖度", icon: "target", desc: "关键词覆盖分析结果" },
};

export function isValidKind(kind) {
  return Object.prototype.hasOwnProperty.call(KINDS, kind);
}

/* ─────────────────────── 纯函数层（可在 Node 里断言）─────────────────────── */

/**
 * 指纹：用来做"同一份产物不重复入库"。
 * 用 djb2 —— 不是密码学哈希，只需要稳定且够短。
 */
export function fingerprint(text) {
  const s = String(text ?? "");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * 裁剪载荷。返回 `{ payload, truncated, chars }`。
 * 🔴 必须**显式标记被裁剪过** —— 静默截断会让用户以为存全了。
 */
export function trimPayload(payload, maxChars = MAX_PAYLOAD_CHARS) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
  const chars = text.length;
  if (chars <= maxChars) return { payload, truncated: false, chars };
  return {
    payload: {
      __truncated: true,
      __originalChars: chars,
      note: `超出单条上限 ${maxChars} 字符，只保留了前 ${maxChars} 字符。完整内容请当场导出。`,
      preview: text.slice(0, maxChars),
    },
    truncated: true,
    chars: maxChars,
  };
}

/** 构造一条记录。`now` 可注入 → 断言时不必依赖真实时间。 */
export function makeRecord(kind, title, payload, meta = {}, now = Date.now()) {
  if (!isValidKind(kind)) throw new Error(`未知的产物类型：${kind}`);
  const t = String(title ?? "").trim() || "（未命名）";
  const { payload: body, truncated, chars } = trimPayload(payload);
  return {
    kind,
    title: t.slice(0, 120),
    payload: body,
    meta: meta && typeof meta === "object" ? meta : {},
    truncated,
    chars,
    createdAt: now,
    fingerprint: fingerprint(t + "\u0000" + String(chars) + "\u0000" + JSON.stringify(meta || {})),
  };
}

/** 按创建时间倒序（新的在前）。不依赖 IndexedDB 的游标方向，纯函数好断言。 */
export function sortRecords(rows) {
  return [...(rows || [])].sort((a, b) => (b?.createdAt || 0) - (a?.createdAt || 0));
}

/** 淘汰策略：保留最新的 `max` 条，返回要删掉的 id 列表。 */
export function pickEvictions(rows, max = MAX_RECORDS_PER_KIND) {
  const sorted = sortRecords(rows);
  return sorted.slice(max).map((r) => r.id).filter((id) => id !== undefined && id !== null);
}

/** 人类可读的体量。 */
export function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 历史面板的一行摘要（把"存了什么"讲清楚，而不是只给一个 id）。 */
export function summarize(record) {
  if (!record) return null;
  // 不认识 kind 时回落到"文档"图标 id（app.js 的 ICONS 里必须有这个键）
  const k = KINDS[record.kind] || { label: record.kind, icon: "file-text" };
  const d = new Date(record.createdAt || 0);
  const pad = (x) => String(x).padStart(2, "0");
  const time = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const bits = [];
  const m = record.meta || {};
  if (m.subject) bits.push(`主体：${m.subject}`);
  if (m.count != null) bits.push(`${m.count} 张`);
  if (m.asin) bits.push(m.asin);
  if (m.rules != null) bits.push(`规则 ${m.rules}`);
  if (m.coveragePct != null) bits.push(`覆盖 ${m.coveragePct}%`);
  if (record.truncated) bits.push("⚠️ 已裁剪");
  return {
    id: record.id,
    kind: record.kind,
    label: k.label,
    icon: k.icon,
    title: record.title,
    time,
    detail: bits.join(" · "),
    sizeText: formatSize(JSON.stringify(record.payload ?? "").length),
  };
}

/* ─────────────────────── IndexedDB 层 ─────────────────────── */

let dbPromise = null;

/** 环境是否支持 IndexedDB（Node / 隐私模式 / 老浏览器 → false）。 */
export function isAvailable() {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

function openDB() {
  if (!isAvailable()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        os.createIndex("kind", "kind", { unique: false });
        os.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    // 🔴 打不开就当没有持久化，**不要**把异常抛给调用方 —— 别的功能必须还能用。
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const os = t.objectStore(STORE);
    let out;
    try {
      out = fn(os);
    } catch (e) {
      reject(e);
      return;
    }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error || new Error("IndexedDB 事务失败"));
    t.onabort = () => reject(t.error || new Error("IndexedDB 事务被中止"));
  });
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB 请求失败"));
  });
}

async function allRows(os) {
  return reqToPromise(os.getAll());
}

/**
 * 保存一条产物。
 * @returns 成功 → `{ ok:true, id, evicted }`；不可用 → `{ ok:false, reason:"unavailable" }`
 *
 * 🔴 配额自愈：QuotaExceededError 时自动删掉本类最旧的记录再重试一次；
 *    仍失败就明确报错，而不是静默丢数据。
 */
export async function save(kind, title, payload, meta = {}, now = Date.now()) {
  const db = await openDB();
  if (!db) return { ok: false, reason: "unavailable" };
  const record = makeRecord(kind, title, payload, meta, now);
  try {
    const id = await tx(db, "readwrite", (os) => os.add(record));
    const evicted = await enforceQuota(db, kind);
    return { ok: true, id, evicted };
  } catch (e) {
    // 配额超限 → 清掉本类最旧的一半，再试一次
    if (isQuotaError(e)) {
      const dropped = await dropOldest(db, kind, Math.ceil(MAX_RECORDS_PER_KIND / 2));
      try {
        const id = await tx(db, "readwrite", (os) => os.add(record));
        return { ok: true, id, evicted: dropped, recovered: true };
      } catch (e2) {
        return { ok: false, reason: "quota", error: e2.message };
      }
    }
    return { ok: false, reason: "error", error: e.message };
  }
}

function isQuotaError(e) {
  return e && (e.name === "QuotaExceededError" || /quota/i.test(e.message || ""));
}

async function enforceQuota(db, kind) {
  const rows = (await tx(db, "readonly", (os) => allRows(os))).filter((r) => r.kind === kind);
  const victims = pickEvictions(rows);
  if (!victims.length) return 0;
  await tx(db, "readwrite", (os) => {
    for (const id of victims) os.delete(id);
  });
  return victims.length;
}

async function dropOldest(db, kind, n) {
  const rows = sortRecords((await tx(db, "readonly", (os) => allRows(os))).filter((r) => r.kind === kind));
  const victims = rows.slice(-n).map((r) => r.id);
  await tx(db, "readwrite", (os) => {
    for (const id of victims) os.delete(id);
  });
  return victims.length;
}

/** 列出产物（可按 kind 过滤），新的在前。不可用时返回 `[]`。 */
export async function list(kind = null, limit = 0) {
  const db = await openDB();
  if (!db) return [];
  try {
    const rows = await tx(db, "readonly", (os) => allRows(os));
    const filtered = kind ? rows.filter((r) => r.kind === kind) : rows;
    const sorted = sortRecords(filtered);
    return limit > 0 ? sorted.slice(0, limit) : sorted;
  } catch {
    return [];
  }
}

export async function get(id) {
  const db = await openDB();
  if (!db) return null;
  try {
    return await tx(db, "readonly", (os) => reqToPromise(os.get(Number(id))));
  } catch {
    return null;
  }
}

export async function remove(id) {
  const db = await openDB();
  if (!db) return { ok: false, reason: "unavailable" };
  try {
    await tx(db, "readwrite", (os) => os.delete(Number(id)));
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: "error", error: e.message };
  }
}

/** 清空。`kind` 省略时清空全部（前端要二次确认）。 */
export async function clear(kind = null) {
  const db = await openDB();
  if (!db) return { ok: false, reason: "unavailable" };
  try {
    if (!kind) {
      await tx(db, "readwrite", (os) => os.clear());
      return { ok: true, cleared: "all" };
    }
    const rows = (await tx(db, "readonly", (os) => allRows(os))).filter((r) => r.kind === kind);
    await tx(db, "readwrite", (os) => {
      for (const r of rows) os.delete(r.id);
    });
    return { ok: true, cleared: rows.length };
  } catch (e) {
    return { ok: false, reason: "error", error: e.message };
  }
}

/** 统计：各类条数 + 浏览器给出的配额占用。 */
export async function stats() {
  const rows = await list();
  const byKind = {};
  for (const k of Object.keys(KINDS)) byKind[k] = 0;
  for (const r of rows) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
  let quota = null;
  try {
    if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
      const e = await navigator.storage.estimate();
      quota = { usage: e.usage || 0, quota: e.quota || 0, usageText: formatSize(e.usage || 0) };
    }
  } catch {
    quota = null;
  }
  return { total: rows.length, byKind, quota, available: isAvailable() };
}

/* ─────────────────── 导出格式版本 ───────────────────
 * 🔴 原来导出物里**没有任何版本号**：以后改了字段含义（比如把 payload 从对象改成字符串），
 *    老文件导回来只会"看起来成功、内容全错"，而用户不会知道。版本号是唯一能提前拦住它的东西。
 * v1 = 当前结构（items[] 每项 {id?, kind, title, payload, meta, createdAt}）。
 * 导入时对 v0（没有 schemaVersion 的旧文件，含数组形态）**继续兼容**，但要在回执里说明。
 */
export const EXPORT_SCHEMA = 1;

/** 导出为可下载的 JSON（产物属于用户，必须能带走）。 */
export function toExport(rows) {
  return JSON.stringify(
    {
      app: "跨境 Listing 质检工作台",
      schemaVersion: EXPORT_SCHEMA,
      exportedAt: new Date().toISOString(),
      count: rows.length,
      items: rows,
    },
    null,
    2,
  );
}

/**
 * 导入：接受上面那份 JSON。返回 `{ ok, added, skipped, error, schemaVersion, warning? }`。
 *
 * 🔴 版本处理是**单向明确**的：认识的（1 / 无版本号的旧文件）→ 放行并说明；
 *    不认识的（更高版本）→ 直接拒绝，不要"尽力导入" —— 用未来的格式导进旧版本，
 *    丢字段是静默的，用户只会觉得"数据怎么少了一半"。
 */
export async function importFrom(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || ""));
  } catch (e) {
    return { ok: false, error: `不是合法 JSON：${e.message}` };
  }
  const items = Array.isArray(parsed) ? parsed : parsed?.items;
  if (!Array.isArray(items)) return { ok: false, error: "找不到 items 数组" };

  const rawVersion = Array.isArray(parsed) ? undefined : parsed?.schemaVersion;
  let schemaVersion = EXPORT_SCHEMA;
  let warning;
  if (rawVersion === undefined || rawVersion === null) {
    // 旧文件（本项目 v1 之前导出的）—— 就是现在的 items 结构，可以原样吃
    schemaVersion = 0;
    warning = "这份文件没有版本号（旧格式），已按 v0 兼容导入；建议现在重新导出一份带版本号的备份。";
  } else if (!Number.isInteger(rawVersion) || rawVersion < 1) {
    return { ok: false, error: `schemaVersion 非法：${JSON.stringify(rawVersion)}（应为正整数）` };
  } else if (rawVersion > EXPORT_SCHEMA) {
    return {
      ok: false,
      error: `这份备份来自更新的版本（schemaVersion ${rawVersion}，当前只认到 ${EXPORT_SCHEMA}）。请升级工作台后再导入 —— 强行导入会静默丢字段。`,
      schemaVersion: rawVersion,
    };
  }

  let added = 0, skipped = 0;
  for (const it of items) {
    if (!isValidKind(it?.kind)) { skipped++; continue; }
    const r = await save(it.kind, it.title, it.payload, it.meta || {}, it.createdAt || Date.now());
    if (r.ok) added++; else skipped++;
  }
  return warning
    ? { ok: true, added, skipped, schemaVersion, warning }
    : { ok: true, added, skipped, schemaVersion };
}
