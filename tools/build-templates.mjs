#!/usr/bin/env node
/**
 * 从参考项目 ecom-details-image 的 25 个模板 JSON 生成 assets/templates.js。
 *
 * 设计原则：模板数据只有一个事实源（参考仓的 references/templates/*.json），
 * 应用侧只消费生成产物 —— 不手抄、不改写、不合并字段。
 *
 * 用法：
 *   node tools/build-templates.mjs [参考仓路径]
 * 默认参考仓路径：../_repos/ecom-details-image/.claude/skills/ecom-details-image
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "..");
const DEFAULT_SRC = resolve(APP_ROOT, "..", "_repos", "ecom-details-image", ".claude", "skills", "ecom-details-image");

const src = resolve(process.argv[2] || DEFAULT_SRC);
const tplDir = join(src, "references", "templates");

if (!existsSync(tplDir)) {
  console.error(`找不到模板目录：${tplDir}`);
  console.error(`请先把参考仓库克隆到 ../_repos/ecom-details-image（或用参数指定路径）。`);
  process.exit(1);
}

const files = readdirSync(tplDir).filter((f) => f.endsWith(".json")).sort();
if (files.length === 0) {
  console.error(`模板目录里没有 json：${tplDir}`);
  process.exit(1);
}

/** 必填字段校验 —— 生成前先证明数据结构符合预期，而不是生成后再猜。 */
const REQUIRED = [
  "id", "name", "keywords", "trigger_phrases", "prompt_template",
  "defaults", "variants", "category_tips", "examples", "anti_ai_tips",
  "supports_image_reference",
];

const templates = [];
const problems = [];

for (const f of files) {
  let data;
  try {
    data = JSON.parse(readFileSync(join(tplDir, f), "utf8"));
  } catch (e) {
    problems.push(`${f}: JSON 解析失败 — ${e.message}`);
    continue;
  }
  const missing = REQUIRED.filter((k) => !(k in data));
  if (missing.length) problems.push(`${f}: 缺字段 ${missing.join(", ")}`);
  if (data.id !== f.replace(/^\d+-/, "").replace(/\.json$/, "")) {
    problems.push(`${f}: id="${data.id}" 与文件名不一致`);
  }
  for (const [vk, vv] of Object.entries(data.variants || {})) {
    if (!vv || typeof vv.overrides !== "object") {
      problems.push(`${f}: variant "${vk}" 缺 overrides`);
    }
  }
  templates.push(data);
}

if (problems.length) {
  console.error("模板结构校验未通过：");
  for (const p of problems) console.error("  ✗ " + p);
  process.exit(2);
}

// 序号（01..25）从文件名取，用于 UI 排序与显示
const withOrder = templates.map((t) => {
  const file = files.find((f) => f.replace(/^\d+-/, "").replace(/\.json$/, "") === t.id);
  return { order: file.slice(0, 2), ...t, _file: file };
});

const lines = [];
lines.push("// ⚠️ 本文件由 tools/build-templates.mjs 自动生成，请勿手工编辑。");
lines.push("// 数据来源：https://github.com/liangdabiao/ecom-details-image （MIT License）");
lines.push("//   路径：.claude/skills/ecom-details-image/references/templates/*.json");
lines.push(`// 生成时间：${new Date().toISOString()}`);
lines.push(`// 模板数量：${withOrder.length}`);
lines.push("");
lines.push("export const TEMPLATES = {");
for (const t of withOrder) {
  lines.push(`  ${JSON.stringify(t.id)}: ${JSON.stringify(t, null, 2).split("\n").join("\n  ")},`);
}
lines.push("};");
lines.push("");
lines.push("/** 按 01..25 顺序排列的模板数组 */");
lines.push("export const TEMPLATE_LIST = Object.values(TEMPLATES).sort((a, b) => a.order.localeCompare(b.order));");
lines.push("");
lines.push("/** 关键词 → 模板 id 的倒排索引，用于本地兜底匹配 */");
lines.push("export const KEYWORD_INDEX = (() => {");
lines.push("  const idx = {};");
lines.push("  for (const t of TEMPLATE_LIST) {");
lines.push("    for (const kw of [...(t.keywords || []), ...(t.trigger_phrases || [])]) {");
lines.push("      const k = String(kw).trim().toLowerCase();");
lines.push("      if (k) (idx[k] ||= []).push(t.id);");
lines.push("    }");
lines.push("  }");
lines.push("  return idx;");
lines.push("})();");
lines.push("");

const out = join(APP_ROOT, "assets", "templates.js");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lines.join("\n"), "utf8");

// 生成后立刻回读校验：产物必须是可解析的模块，且条数一致
const check = readFileSync(out, "utf8");
const idCount = (check.match(/^  "[a-z0-9-]+": \{$/gm) || []).length;
console.log(`✓ 已生成 ${out}`);
console.log(`  模板数：${withOrder.length}`);
console.log(`  产物大小：${(Buffer.byteLength(check) / 1024).toFixed(1)} KB`);
console.log(`  回读校验：id 条目 ${idCount} 个 ${idCount === withOrder.length ? "（一致）" : "（不一致 ✗）"}`);
console.log(`  模板清单：${withOrder.map((t) => t.order + "-" + t.id).join(", ")}`);
if (idCount !== withOrder.length) process.exit(3);
