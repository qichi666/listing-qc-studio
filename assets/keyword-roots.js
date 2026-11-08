/**
 * 词根覆盖层 —— 把「这一周该抓哪些词根」从代码里搬到数据里。
 *
 * ── 它解决的是什么 ────────────────────────────────────────────────
 * `assets/keyword-seeds.js` 里 194 条词根写死在 JS 里。运营想加一个品类词根，
 * 得改源码、发版、重启 —— 而「词根是人的判断」本来就该由运营来做，不是开发者。
 * 覆盖层是 `data/keywords/roots.json` 里的一小段 JSON：加几条、删几条、改个名，
 * 采集器每次跑之前先合一次，源码一行不动。
 *
 * 🔴 为什么是「覆盖层」而不是「另起一份完整词根表」：
 *    基线（`ROOT_GROUPS`）是人工挑过、经过实测的种子，是可信的**下限**。
 *    覆盖层只表达「相对基线的增量」；覆盖层丢了、写坏了、schema 不认识，
 *    一律**退回基线继续跑**，而不是让整周采集失败或产出一份空词库。
 *    "读不出来"必须写进 notes —— 静默退回等于运营以为自己改生效了。
 *
 * ── 纯函数边界 ────────────────────────────────────────────────────
 * 无网络、无文件系统、无 DOM；不修改 `base`（深拷贝后才动），不碰全局的
 * `ROOT_TO_GROUP`。`overlay` 既可以是解析好的对象，也可以是一段 JSON 文本 ——
 * 后者让「文件写坏了」这种失败也落在纯函数里，好测、且保证不抛异常。
 *
 * ── 三条冲突语义（写进代码，不靠文档约定）────────────────────────
 *   ① `removed` 优先于 `added`：同一个词根两边都写了，按**删除**处理，notes 说明。
 *      理由：删除是「这个词根不该再抓」，是更强的意图；加回来会让运营的删除失效。
 *   ② `renamed` 是**原子**的一条操作：`from` 必须存在、`to` 不能已存在、且 `to` 本身合法；
 *      任一不满足 → 整条进 rejected（既不删 from，也不加 to），绝不半改。
 *      半改的后果是词根凭空消失，比报错难查得多。
 *   ③ `added` 里已经存在的词根 = **幂等成功**：不算错误、不重复，notes 记一句即可。
 *      覆盖层会被反复编辑，重复写一条不该把整次采集判成失败。
 *
 * 非法项（长度 / 大小写 / 品牌 / 组不存在 / 重复）只让**自己**进 rejected，
 * 合法项照常生效 —— 部分成功好过整体失败，与采集器「一个词根失败不影响其他」同源。
 */
import { ROOT_GROUPS } from "./keyword-seeds.js";

/** 覆盖层格式版本。只认这一个；不认识的版本按「读不出来」退回基线，绝不猜着解析。 */
export const OVERLAY_SCHEMA = 1;

/**
 * 品牌黑名单 —— 自己定的一份**保守**小名单，只挡最典型的品牌词。
 * 🔴 为什么要有：`keyword-seeds.js` 明写「不写品牌名：品牌词的长尾是品牌自己的」。
 *    覆盖层是运营填的，没有代码评审把关，这一条必须在数据入口再守一次。
 *    按**独立单词**匹配（\b），避免把 `pineapple` 当成 `apple` —— 即便如此，
 *    名单仍可能误伤（例如 `apple slicer` 是品类词），所以只放最不会歧义的几个。
 */
const BRAND_BLACKLIST = [
  "anker", "dyson", "bose", "logitech", "samsung", "sony",
  "nike", "adidas", "philips", "bosch", "amazon", "google",
];
const BRAND_RE = new RegExp(`\\b(?:${BRAND_BLACKLIST.join("|")})\\b`, "i");

/** 全 ASCII 可打印字符（小写字母 + 数字 + 空格 + 常见标点）；大写由下一行单独挡。 */
const ASCII_PRINTABLE = /^[\x20-\x7e]+$/;
const HAS_UPPER = /[A-Z]/;

/** 单条词根校验。返回归一后的词面，不合法时给出**具体**原因（不静默）。 */
function validateRoot(raw) {
  const root = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
  if (root.length < 2 || root.length > 40) {
    return { ok: false, root, reason: `词根长度 ${root.length}，要求 2..40` };
  }
  if (!ASCII_PRINTABLE.test(root) || HAS_UPPER.test(root)) {
    return { ok: false, root, reason: "词根必须是全小写 ASCII（不能含大写或非 ASCII 字符）" };
  }
  if (BRAND_RE.test(root)) {
    return { ok: false, root, reason: "词根含品牌名（品牌长尾是品牌自己的，不是选品要的）" };
  }
  return { ok: true, root, reason: "" };
}

/** 基线深拷贝。🔴 绝不修改入参：调用方传进来的可能就是全局 `ROOT_GROUPS` 本身。 */
function cloneGroups(base) {
  const src = Array.isArray(base) ? base : ROOT_GROUPS;
  return src.map((g) => ({ ...g, roots: Array.isArray(g?.roots) ? [...g.roots] : [] }));
}

/** 与 `ROOTS` 完全同构的扁平去重词根表（保序）。 */
function flatten(groups) {
  return [...new Set(groups.flatMap((g) => g.roots))];
}

function groupOf(groups, root) {
  return groups.find((g) => g.roots.includes(root)) || null;
}

/**
 * 覆盖层解析。任何「读不出来」都返回 ok:false 并写同一句 note：
 * 「覆盖层读不出来，已按基线跑」—— 上层据此知道这一跑没吃到运营的改动。
 */
function parseOverlay(overlay, notes) {
  if (overlay == null) return { ok: true, value: null };     // 没有覆盖层 = 纯基线，不是错误
  let v = overlay;
  if (typeof overlay === "string") {
    try {
      v = JSON.parse(overlay);
    } catch (e) {
      notes.push(`覆盖层读不出来，已按基线跑（JSON 解析失败：${e.message}）`);
      return { ok: false, value: null };
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    notes.push("覆盖层读不出来，已按基线跑（不是一个对象）");
    return { ok: false, value: null };
  }
  if (v.schema != null && v.schema !== OVERLAY_SCHEMA) {
    notes.push(`覆盖层读不出来，已按基线跑（schema=${v.schema}，本版只认 ${OVERLAY_SCHEMA}）`);
    return { ok: false, value: null };
  }
  return { ok: true, value: v };
}

function reject(rejected, notes, op, root, reason) {
  rejected.push({ root, reason, op });
  notes.push(`${op}「${root}」未生效：${reason}`);
}

/**
 * 合并基线 + 覆盖层。
 *
 * @param {{base?:Array, overlay?:object|string|null}} [opt]
 * @returns {{groups:Array, roots:string[], notes:string[], rejected:Array<{root:string,reason:string,op:string}>}}
 *          `notes` / `rejected` 都是数组：采集器把 notes join 进 `summary.note`，
 *          rejected 逐条留证，运营能在快照里看到自己哪条改动没生效。
 */
export function resolveRoots(opt = {}) {
  // 最外层兜底：任何没预料到的输入都不许把采集器带挂（退回基线 + 说明，不抛）。
  try {
    return apply(opt);
  } catch (e) {
    const groups = cloneGroups(opt?.base);
    return {
      groups,
      roots: flatten(groups),
      notes: [`覆盖层读不出来，已按基线跑（${e.message}）`],
      rejected: [],
    };
  }
}

function apply({ base = ROOT_GROUPS, overlay = null } = {}) {
  const groups = cloneGroups(base);
  const notes = [];
  const rejected = [];

  const parsed = parseOverlay(overlay, notes);
  if (!parsed.ok) {
    return { groups, roots: flatten(groups), notes, rejected };
  }
  const ov = parsed.value;
  if (!ov) {
    // 纯基线：roots 必须与 ROOTS 等长且同序（验收 1）。
    return { groups, roots: flatten(groups), notes, rejected };
  }

  // 字段逐个人手：不是数组就忽略该字段并说明，其余字段照常生效（部分成功）。
  const field = (name) => {
    const arr = ov[name];
    if (arr == null) return [];
    if (!Array.isArray(arr)) {
      notes.push(`覆盖层字段 ${name} 不是数组，已忽略（其余照常生效）`);
      return [];
    }
    return arr;
  };
  const added = field("added");
  const removed = field("removed");
  const renamed = field("renamed");
  const groupKeys = new Set(groups.map((g) => g.key));

  // ① removed 先落地：这样 renamed / added 看到的都是「删完之后」的当前状态，
  //    "removed 优先" 才有确定的落点，而不是靠处理顺序碰巧撞对。
  const removedSet = new Set();
  for (const item of removed) {
    const raw = typeof item === "string" ? item : item?.root;
    const { ok, root, reason } = validateRoot(raw);
    if (!ok) { reject(rejected, notes, "removed", root, reason); continue; }
    if (removedSet.has(root)) { reject(rejected, notes, "removed", root, "removed 里重复"); continue; }
    removedSet.add(root);
    const g = groupOf(groups, root);
    if (!g) {
      // 🔴 删除不存在的词根必须报错，不能静默 —— 否则运营会以为「我删了但它还在」是 bug。
      reject(rejected, notes, "removed", root, "删除不存在的词根（基线里没有这一条）");
      continue;
    }
    g.roots = g.roots.filter((r) => r !== root);
  }

  // ② renamed：逐条原子。校验全过才动 `groups`，中间任何一步失败都整条丢弃。
  for (const item of renamed) {
    const f = validateRoot(item?.from);
    const t = validateRoot(item?.to);
    const label = `${f.root}→${t.root}`;
    const fail = (why) => reject(rejected, notes, "renamed", label, `${why}（整条不半改）`);
    if (!f.ok) { fail(`from 非法：${f.reason}`); continue; }
    if (!t.ok) { fail(`to 非法：${t.reason}`); continue; }
    const fg = groupOf(groups, f.root);
    if (!fg) { fail("from 不存在（可能已被 removed 删除）"); continue; }
    if (groupOf(groups, t.root)) { fail("to 已存在（不能覆盖已有词根）"); continue; }
    if (removedSet.has(f.root)) { fail("from 同时出现在 removed，removed 优先"); continue; }
    // 原子落地：在原位置替换，分组与顺序都继承 from。
    fg.roots[fg.roots.indexOf(f.root)] = t.root;
    notes.push(`renamed ${label} 已生效（分组 ${fg.key}）`);
  }

  // ③ added：幂等 + removed 优先 + 部分成功。
  const addedSeen = new Set();
  for (const item of added) {
    const isStr = typeof item === "string";
    const { ok, root, reason } = validateRoot(isStr ? item : item?.root);
    if (!ok) { reject(rejected, notes, "added", root, reason); continue; }
    // 冲突 ①：同一词根两边都写了，按删除处理（removed 已经先删过，这里不再加回）。
    if (removedSet.has(root)) {
      notes.push(`「${root}」同时出现在 added 与 removed，按删除处理（removed 优先）`);
      continue;
    }
    if (addedSeen.has(root)) { reject(rejected, notes, "added", root, "added 里重复"); continue; }
    addedSeen.add(root);
    // 冲突 ③：已存在 = 幂等成功，不算错误也不重复添加。
    if (groupOf(groups, root)) {
      notes.push(`added「${root}」已存在，幂等跳过（未重复添加）`);
      continue;
    }
    const group = isStr ? "" : String(item?.group || "").trim();
    if (!groupKeys.has(group)) { reject(rejected, notes, "added", root, `分组「${group || "未填"}」不存在`); continue; }
    groups.find((g) => g.key === group).roots.push(root);
  }

  return { groups, roots: flatten(groups), notes, rejected };
}
