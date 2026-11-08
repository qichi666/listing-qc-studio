/**
 * 文档同步工具：把《给AI审阅-功能细节与技术实现.md》§2.4 的参数附录
 * 换成 `tools/_export-details.mjs` 的**当前**输出（参数从代码导出，不手抄）。
 *
 * 用法（两步，顺序不能换）：
 *   node tools/_export-details.mjs > tools/_details.out
 *   node tools/_sync-details-doc.mjs
 *
 * ⚠️ 为什么不合成一条命令：`execFileSync(process.execPath, ...)` 在 Windows 上
 *    会 EBUSY（同 exe 自调用，踩过）。所以由调用方分两步。
 * ⚠️ 也别用 /tmp 当中转：Git Bash 的 /tmp 与 Node 看到的 /tmp 不是同一个目录（踩过）。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DOC = join(ROOT, "给AI审阅-功能细节与技术实现.md");
const FRAG = join(ROOT, "tools", "_details.out");

if (!existsSync(FRAG)) {
  console.error(`先生成片段文件：node tools/_export-details.mjs > ${FRAG}`);
  process.exit(1);
}

const doc = readFileSync(DOC, "utf8");

// 附录在正文里用的是 #### （比导出脚本的 ### 低一级）
const block = readFileSync(FRAG, "utf8")
  .trimEnd()
  .split("\n")
  .map((l) => (l.startsWith("### ") ? "#" + l : l))
  .join("\n");

// 附录的起止锚点：到「## 3. 模块二：编排层」之前。
// 起点兼容多代：每加一节**新的首节**，都要把它的标题**加到这个列表最前面**。
// ⚠️ 别写死一个 —— 否则**首次加入新首节**时会报"锚点没对上"（真踩到）；
//    更坏的情况是漏加：同步会把新首节整段**跳过**而不报错（新首节还在 `_details.out` 里，只是没进文档）。
const START_CANDIDATES = [
  "#### 竞品实时抓取 · 站点与出网白名单",
  "#### 模板自动匹配 · 别名层",
  "#### 铁律 1 · HEX 色板",
];
const START = START_CANDIDATES.find((s) => doc.includes(s));
if (!START) {
  console.error(`附录起点锚点一个都没找到：${START_CANDIDATES.join(" / ")}`);
  process.exit(1);
}
const END_MARK = "\n## 3. 模块二：编排层";
const i = doc.indexOf(START);
const j = doc.indexOf(END_MARK);
if (i < 0 || j < 0 || j < i) {
  console.error(`锚点没对上：start=${i} end=${j}`);
  console.error("（文档结构调整过？改掉 START / END_MARK 再跑。）");
  process.exit(1);
}

const next = doc.slice(0, i) + block + "\n" + doc.slice(j);

// 原子替换：先写临时文件再 rename，避免写到一半崩掉留下半截文档
const tmp = DOC + ".tmp";
writeFileSync(tmp, next, "utf8");
try {
  renameSync(tmp, DOC);
} catch (e) {
  // Windows 上目标被占用时 rename 会失败 —— 清理临时文件再抛，别留下垃圾
  if (existsSync(tmp)) unlinkSync(tmp);
  throw e;
}

console.log(`参数附录已同步（${block.length} 字符）→ ${DOC}`);
