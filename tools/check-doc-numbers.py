# -*- coding: utf-8 -*-
"""核对《给AI审阅-功能细节与技术实现.md》里的「当前状态数字」是否与磁盘/代码一致。

为什么需要它：那张「文件 → 行数」表是**手写**的，不在任何生成器里。
已实测腐烂过两轮（app.js 1431→1645、index.html 451→486、selftest.mjs 2435→3232 …），
而且**不会有任何报错** —— 文档会安静地说出一个过期的数字。这正是这类表最危险的地方。

用法：
  python tools/check-doc-numbers.py                 # 静态核对（快）
  python tools/check-doc-numbers.py --with-suites   # 额外顺序跑三套自检，核对断言条数（约 30s）
"""
import io
import os
import re
import sys
import json
import subprocess
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
DOC = ROOT / "给AI审阅-功能细节与技术实现.md"
WITH_SUITES = "--with-suites" in sys.argv

fails, oks = [], []


def ck(label, got, want):
    if str(got) == str(want):
        oks.append("%s = %s" % (label, got))
    else:
        fails.append("%s：文档写 %s，实际 %s" % (label, want, got))


def wc_lines(p: Path):
    """与 wc -l 同口径：数换行符（末尾没有换行时最后一个不完整行也算一行）。"""
    b = p.read_bytes()
    n = b.count(b"\n")
    if b and not b.endswith(b"\n"):
        n += 1
    return n


doc = DOC.read_text(encoding="utf-8")

# ── 1. §1.3 「文件 → 行数」表 ──────────────────────────────────────
row_re = re.compile(r"^\| (?:🆕 )?`([^`]+)` \| (?:(\d+) 行|生成物) \|", re.M)
rows = [(m.group(1), m.group(2)) for m in row_re.finditer(doc)]
strip = lambda s: s.replace("**", "").strip()
for f, n in rows:
    if n is None:
        continue
    p = ROOT / f
    if not p.is_file():
        fails.append("§1.3 表里列了不存在的文件：%s" % f)
        continue
    ck("§1.3 %s 行数" % f, wc_lines(p), n)

# ── 2. 文件数与总体量（§1.1）────────────────────────────────────
m = re.search(r"\*\*(\d+) 个源码 / 工具文件\*\*，约 (\d+) KB", doc)
if m:
    total = sum((ROOT / f).stat().st_size for f, _ in rows if (ROOT / f).is_file())
    ck("§1.1 文件数", len(rows), m.group(1))
    ck("§1.1 总体量 KB（四舍五入）", round(total / 1024), m.group(2))
else:
    fails.append("§1.1 「N 个源码 / 工具文件，约 X KB」未匹配到")

# ── 3. 视图数（§1.3 / §8.1）─────────────────────────────────────
html = (ROOT / "index.html").read_text(encoding="utf-8")
views = sorted(set(re.findall(r'data-view="([a-z-]+)"', html)))
print("index.html 视图（%d 个）：%s" % (len(views), " / ".join(views)))
for pat, where in [(r"(\d+) 个视图", "§1.3"), (r"单页 (\d+) 视图", "§8.1")]:
    for mm in re.finditer(pat, doc):
        line = doc[: mm.start()].count("\n") + 1
        # §8.1 里那句「真实值是 7」的口径说明本身带数字，跳过历史引述
        if "历史上" in doc[mm.start(): mm.start() + 80]:
            continue
        ck("%s（第 %d 行）视图数" % (where, line), len(views), mm.group(1))

# ── 4. 断言条数：**全量**核对（不许只查第一次出现）────────────────────
# 🔴 2026-11-08 修的一个真 bug：原来三个指标都用 re.search 取**第一次出现**，
#    于是 §0.2 的数字是对的、§10.2 的命令速查块整段过期，脚本照样报「全部一致」。
#    结果是同一份对外文档里同时存在「三套合计 1021 条（509 + 237 + 134）」（括号内相加只有 880）
#    和「509 + 211 + 129 = 849」。任何评审扫一眼就会判定这份材料不可信 —— 而这正是
#    "数字不许手抄"这个卖点最不该出现的失效方式。
#
# 口径（重要）：
#   · §0–§13 是**当前状态**，逐处核对；
#   · §14 起是带日期的**变更记录**（"2026-09-29：…"），里面的数字是当时的，按今天核是错的。
#     跳过，但把跳过的行号打出来 —— 静默跳过和没写这条检查是一回事。
CURRENT_LAST = 13
sec_re = re.compile(r"^## (\d+)\.", re.M)
sec_starts = [(m.start(), int(m.group(1))) for m in sec_re.finditer(doc)]


def line_no(pos):
    return doc[:pos].count("\n") + 1


def section_at(pos):
    cur = 0
    for s, n in sec_starts:
        if s <= pos:
            cur = n
        else:
            break
    return cur


def is_current(pos):
    return section_at(pos) <= CURRENT_LAST


skipped_hist = []

# 4.1 基线：`tools/expected-counts.json` 是断言数的**唯一事实源**（不在这里抄第二份）
_counts_raw = json.loads((ROOT / "tools" / "expected-counts.json").read_text(encoding="utf-8"))
CN = {k: int(v) for k, v in _counts_raw.items() if not k.startswith("_")}
THREE = CN["selftest"] + CN["verify-server"] + CN["browser-selftest"]
FIVE = THREE + CN["mcp-selftest"] + CN["keywords-selftest"]
nums = {"selftest": CN["selftest"], "server": CN["verify-server"], "browser": CN["browser-selftest"]}

SUITE_OF = [
    (r"npm test\b", "selftest"),
    (r"npm run test:server", "verify-server"),
    (r"npm run test:browser|tools/browser-selftest\.mjs", "browser-selftest"),
    (r"npm run test:mcp", "mcp-selftest"),
    (r"npm run test:keywords|tools/keywords-selftest\.mjs", "keywords-selftest"),
]


def suite_of(text):
    for pat, key in SUITE_OF:
        if re.search(pat, text):
            return key
    return None


# 4.2 §0.2 那种「`命令` → **N 条**」
for m in re.finditer(r"`(npm [^`]+|node tools/[^`]+)`\s*→\s*\*\*(\d+) 条\*\*", doc):
    key = suite_of(m.group(1))
    if not key:
        continue
    if not is_current(m.start()):
        skipped_hist.append((line_no(m.start()), "命令 → N 条（变更记录）"))
        continue
    ck("第 %d 行「%s」条数" % (line_no(m.start()), m.group(1).strip()), CN[key], int(m.group(2)))

# 4.3 §10.2 命令速查块：「命令 … # …（N 条）」
for m in re.finditer(r"^[^\n#]*?(npm [^\n#]+|node tools/[^\s#]+)[^\n#]*#[^\n]*?(\d+)\s*条", doc, re.M):
    key = suite_of(m.group(1))
    if not key:
        continue
    if not is_current(m.start()):
        skipped_hist.append((line_no(m.start()), "命令块（变更记录）"))
        continue
    ck("第 %d 行「%s」条数" % (line_no(m.start()), m.group(1).strip()), CN[key], int(m.group(2)))

# 4.4 「N 条断言 / M 个测试节」→ 断言数
for m in re.finditer(r"\*\*(\d+) 条断言 / \d+ 个测试节\*\*", doc):
    if not is_current(m.start()):
        skipped_hist.append((line_no(m.start()), "断言/测试节（变更记录）"))
        continue
    ck("第 %d 行 selftest 断言数" % line_no(m.start()), CN["selftest"], int(m.group(1)))

# 4.5 测试节数（以 selftest.mjs 里 section(" 的数量为准）
n_sec = len(re.findall(r'^section\("', (ROOT / "tools/selftest.mjs").read_text(encoding="utf-8"), re.M))
for m in re.finditer(r"(\d+) 个测试节", doc):
    if not is_current(m.start()):
        skipped_hist.append((line_no(m.start()), "测试节数（变更记录）"))
        continue
    ck("第 %d 行 测试节数" % line_no(m.start()), n_sec, int(m.group(1)))

# 4.6 三套合计：**总数与括号里的三个加数都要对**（只对总数放过了「1021 = 509+237+134」）
for m in re.finditer(r"三套合计\s*[:：]?\s*(\d+)\s*条\s*(?:\*\*)?\s*（([\d\s+]+)）", doc):
    if not is_current(m.start()):
        skipped_hist.append((line_no(m.start()), "三套合计（变更记录）"))
        continue
    parts = [int(x) for x in re.findall(r"\d+", m.group(2))]
    ck("第 %d 行 三套合计" % line_no(m.start()), THREE, int(m.group(1)))
    if len(parts) == 3:
        ck("第 %d 行 三套分项" % line_no(m.start()),
           "%d + %d + %d" % (CN["selftest"], CN["verify-server"], CN["browser-selftest"]),
           "%d + %d + %d" % tuple(parts))

# 4.7 test:all 的「（A + B + C + D + E = N）」
# 🔴 2026-11-08 起 test:all 真的跑满五套（原来漏了 mcp / keywords 共 384 条），
#    所以这里对的是 FIVE，不是 THREE。判据跟着事实走 —— 否则文档写对了反而报红。
for m in re.finditer(r"test:all[^\n]*?（([\d\s+]+)=\s*(\d+)）", doc):
    if not is_current(m.start()):
        skipped_hist.append((line_no(m.start()), "test:all（变更记录）"))
        continue
    parts = [int(x) for x in re.findall(r"\d+", m.group(1))]
    ck("第 %d 行 test:all 合计" % line_no(m.start()), FIVE, int(m.group(2)))
    if len(parts) == 5:
        ck("第 %d 行 test:all 分项" % line_no(m.start()),
           "%d + %d + %d + %d + %d" % (CN["selftest"], CN["verify-server"], CN["browser-selftest"],
                                       CN["mcp-selftest"], CN["keywords-selftest"]),
           "%d + %d + %d + %d + %d" % tuple(parts))

# 4.12 §1.3 表里「**N 条断言**」单元格（每套一行，各自对自己的基线）
for m in re.finditer(r"\| `tools/([\w.-]+\.mjs)` \| (?:生成物|\d+ 行)[^\n]*?\*\*(\d+) 条断言", doc):
    key = m.group(1)[: -len(".mjs")]
    if key in CN:
        ck("§1.3 %s 条数" % m.group(1), CN[key], int(m.group(2)))

# 4.13 五套合计（如果正文写了）
for m in re.finditer(r"五套[^\n]{0,24}?(\d+)\s*条", doc):
    if not is_current(m.start()):
        skipped_hist.append((line_no(m.start()), "五套合计（变更记录）"))
        continue
    ck("第 %d 行 五套合计" % line_no(m.start()), FIVE, int(m.group(1)))

# 4.9 源码体量：这种"随手写在正文里"的数字最容易烂，且原来完全没人管
app_p = ROOT / "assets/app.js"
app_kb = "%.1f" % (app_p.stat().st_size / 1024)
for m in re.finditer(r"app\.js`?（\*\*(\d+) 行 / ([\d.]+) KB\*\*）", doc):
    ck("第 %d 行 app.js 行数" % line_no(m.start()), wc_lines(app_p), int(m.group(1)))
    ck("第 %d 行 app.js 体量 KB" % line_no(m.start()), app_kb, m.group(2))
for m in re.finditer(r"`assets/app\.js` \| ([\d.]+)KB \|([^\n]*)", doc):
    ck("第 %d 行 app.js 体量 KB（表格）" % line_no(m.start()), app_kb, m.group(1))
    mm = re.search(r"已达 (\d+) 行", m.group(2))
    if mm:
        ck("第 %d 行 app.js 行数（表格）" % line_no(m.start()), wc_lines(app_p), int(mm.group(1)))

# 4.10 expected-counts.json 的"文件内容"描述（读者会照着它去改文件）
for m in re.finditer(r"expected-counts\.json`?（\{([^}]*)\}）", doc):
    for k, v in re.findall(r"([\w-]+):\s*(\d+)", m.group(1)):
        if k in CN:
            ck("第 %d 行 expected-counts.%s" % (line_no(m.start()), k), CN[k], int(v))

# 4.11 《项目架构说明》里的套件条数表（同样是给 AI 读的"当前状态"）
ARCH = ROOT / "项目架构说明（供AI理解全貌）.md"
if ARCH.is_file():
    arch = ARCH.read_text(encoding="utf-8")
    for m in re.finditer(r"\| `tools/([\w.-]+\.mjs)` \| \*\*(\d+)\*\* \|", arch):
        key = m.group(1)[: -len(".mjs")]
        if key in CN:
            ck("架构说明 tools/%s 条数" % m.group(1), CN[key], int(m.group(2)))

# ── 4b. 面向使用者的《功能详细介绍》：规模类数字也要对得上 ──────────
# 这份文档给外部读者看，里面「25 个模板」「28 条规则」「7 个视图」这类数字
# 一旦过期就是**对外说错话**。所以逐项从代码里算，再和正文里的每一处比。
GUIDE = ROOT / "跨境Listing优化工作台-功能详细介绍.md"
if GUIDE.is_file():
    g = GUIDE.read_text(encoding="utf-8")

    def node_int(code):
        r = subprocess.run([os.environ.get("NODE_BIN") or "node", "-e", code],
                           cwd=str(ROOT), capture_output=True, text=True, encoding="utf-8")
        try:
            return int((r.stdout or "").strip())
        except ValueError:
            fails.append("算不出这个数字（node 输出：%r）" % (r.stdout or r.stderr)[:120])
            return -1

    tpl_n = node_int('import("./assets/templates.js").then(m=>console.log(Object.keys(m.TEMPLATES).length))')
    rule_n = node_int('import("./assets/listing.js").then(m=>console.log(m.RULES.length))')
    # 正文里同一件事可能写了好几处，**每一处**都必须等于实际值；不取第一次了事。
    for label, pat, got in [("模板数", r"(\d+) 个模板", tpl_n),
                            ("规则数", r"(\d+) 条规则", rule_n),
                            ("视图数", r"(\d+) 个视图", len(views))]:
        hits = re.findall(pat, g)
        if not hits:
            fails.append("《功能详细介绍》里找不到「%s」的写法" % label)
            continue
        ck("《功能详细介绍》%s（共 %d 处）" % (label, len(hits)),
           got, ",".join(sorted(set(hits), key=int)) if len(set(hits)) > 1 else hits[0])
else:
    fails.append("找不到《跨境Listing优化工作台-功能详细介绍.md》")

# ── 5. 可选：真跑三套，核对条数（必须顺序跑）──────────────────────
if WITH_SUITES:
    node = os.environ.get("NODE_BIN") or "node"
    for name, script in [("selftest", "tools/selftest.mjs"), ("server", "tools/verify-server.mjs"),
                         ("browser", "tools/browser-selftest.mjs")]:
        r = subprocess.run([node, script], cwd=str(ROOT), capture_output=True)
        out = (r.stdout + r.stderr).decode("utf-8", "replace")
        mm = re.search(r"共 (\d+) 条断言", out)
        if not mm:
            fails.append("%s 没跑出结论行（exit=%d）" % (script, r.returncode))
            continue
        if name in nums:
            ck("实跑 %s 条数" % script, mm.group(1), nums[name])

# ── 报告 ────────────────────────────────────────────────────────
print()
for o in oks:
    print("  ✓", o)
# 🔴 跳过的历史陈述必须打出来。静默跳过 = 让人以为"全查过了"，而这正是上一版失效的方式。
if skipped_hist:
    print()
    print("  · 跳过 %d 处变更记录里的历史数字（§%d 起，按当时口径保留）：" % (len(skipped_hist), CURRENT_LAST + 1))
    for ln, why in skipped_hist:
        print("      第 %d 行 %s" % (ln, why))
if fails:
    print()
    for f in fails:
        print("  ✗", f)
    print("\n共 %d 项通过 / %d 项不一致" % (len(oks), len(fails)))
    sys.exit(1)
print("\n全部一致（%d 项）✓" % len(oks))
