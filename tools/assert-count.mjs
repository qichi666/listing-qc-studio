/**
 * 断言数守卫。
 *
 * 存在理由：这套回归的价值来自"断言只增不减"。删掉一条断言（尤其是删掉一条**正在失败**
 * 的断言）不会留下任何痕迹 —— 测试照样是绿的，只是它已经不再证明那件事了。
 *
 * 语义刻意不对称：
 *   · 实际 < 期望  → **失败**（有人删了断言，或者某个 for 循环的集合变小了）
 *   · 实际 > 期望  → 只提示（很正常：新加了断言），确认后更新 expected-counts.json
 *   · 没有登记     → 只提示（新接一套测试时先跑一次再登记）
 *
 * 不做"自动写回"：测试脚本顺手改自己的期望值，等于把守卫关掉了。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILE = path.join(HERE, "tools", "expected-counts.json");

/** @returns {number} 需要计入失败数的条数（0 或 1） */
export function checkAssertCount(suite, actual) {
  let expected;
  try {
    expected = JSON.parse(fs.readFileSync(FILE, "utf8"))[suite];
  } catch {
    expected = undefined;
  }
  if (typeof expected !== "number") {
    console.log(`\n[断言数] ${suite} 尚未登记期望值 → 首次运行请把 ${actual} 写进 tools/expected-counts.json`);
    return 0;
  }
  if (actual < expected) {
    console.log(`\n✗ 断言数减少：${suite} 期望 ≥${expected}，实际 ${actual}（少了 ${expected - actual} 条）`);
    console.log("  常见原因：删了断言 / 某个 for 循环的集合变小了 / 用例被条件跳过。确认是有意为之再下调期望值。");
    return 1;
  }
  if (actual > expected) {
    console.log(`\n[断言数] ${suite} 新增 ${actual - expected} 条（期望 ${expected} → 实际 ${actual}）。确认无误后更新 tools/expected-counts.json`);
  }
  return 0;
}
