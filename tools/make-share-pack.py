# -*- coding: utf-8 -*-
"""生成对外分享包 —— 白名单收集 + 形态化自检 + 端到端验证。

设计纪律（来自 privacy-safe-share-packaging 技能）：
  1. **白名单**，不是黑名单：新增文件默认不进包，必须显式登记。
  2. **打包器自身不进包** —— 它含排除清单，外发等于把"哪些是敏感件"的原件送出去。
  3. 自检按**形态**扫（绝对路径 / 用户名 / 疑似密钥 / 临时产物名），不靠穷举敏感值清单。
  4. 命中即**中止**，不产出有问题的包。
  5. 自检通过 ≠ 包能用 —— 必须解压到干净临时目录实地跑一遍。

用法：
  python tools/make-share-pack.py            # 扫描 + 打包 + 验证
  python tools/make-share-pack.py --check    # 只扫描，不打包
"""
import io
import os
import posixpath
import re
import sys
import shutil
import zipfile
import tempfile
import subprocess
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

def _find_node():
    """不写死机器路径：先环境变量，再 PATH，最后常见托管位置（找不到就跳过语法检查）。"""
    if os.environ.get("NODE_BIN") and Path(os.environ["NODE_BIN"]).exists():
        return os.environ["NODE_BIN"]
    w = shutil.which("node")
    if w:
        return w
    import glob
    for pat in ("~/.workbuddy/binaries/node/versions/*/node.exe",):
        hit = sorted(glob.glob(os.path.expanduser(pat)))
        if hit:
            return hit[-1]
    return None


NODE = _find_node()
ROOT = Path(__file__).resolve().parent.parent          # …/跨境Listing优化工作台
OUT = ROOT.parent / (ROOT.name + "-分享版.zip")
TOPDIR = ROOT.name
SELF = Path(__file__).resolve()

CHECK_ONLY = "--check" in sys.argv

# ── 1. 白名单（新增文件默认不进包）────────────────────────────────
CODE_FILES = ["index.html", "server.mjs", "server-public.mjs", "package.json", ".env.example", ".gitignore", "README.md",
              # 最新一份词库随包发：收件人打开就能看到「载入本周词库」有数据，
              # 也才知道这个按钮不是摆设。历史摘要不发（可由 latest 重新生成，且只是趋势冗余）。
              "data/keywords/latest.json",
              # G-4 词根覆盖层：一份空的初始文件，收件人打开就知道格式长什么样，
              # 不用先去文档里翻 schema。内容等价基线（194 条词根、零改动），不是编的数据。
              # POST /api/keyword-roots 会原子覆盖它；线上只读演示版不许写。
              "data/keywords/roots.json"]
# `mcp/` 必须进包：它存在的全部意义就是「别人拉下来就能接」。少一个 clients/*.json，
# 收件人就得自己猜路径往哪儿写 —— 那正是这个目录要消除的成本。
CODE_DIRS = ["assets", "mcp", "examples", "docs", ".github", "tools/fixtures"]
TOOL_FILES = [
    "tools/build-templates.mjs",
    "tools/selftest.mjs",
    "tools/verify-server.mjs",
    "tools/browser-selftest.mjs",
    "tools/mcp-selftest.mjs",
    # 每周词库的两件：采集器（别人可以自己跑一次）+ 它的自检。
    # 少 collect-keywords.mjs，`npm run collect:keywords` 与 Actions 工作流就都是死链。
    "tools/collect-keywords.mjs",
    "tools/keywords-selftest.mjs",
    # 🔴 三套自检都 `import "./assert-count.mjs"`，并读 expected-counts.json。
    #    这两个少一个，包里的自检一跑就 ERR_MODULE_NOT_FOUND —— 而收件人第一步就是跑自检。
    "tools/assert-count.mjs",
    "tools/expected-counts.json",
    "tools/_export-sources.mjs",
    "tools/_export-details.mjs",
    "tools/_sync-details-doc.mjs",
    "tools/check-doc-numbers.py",
    # 一键接入：把 6 份客户端配置渲染到 data/mcp-setup/，收件人不用手改占位符。
    # 不含任何本机路径（运行时才取 process.execPath），所以可以随包发。
    "tools/mcp-setup.mjs",
    # 本机定时（GitHub Actions 那条要求仓库有 .git 与远端，很多收件人没有）。
    # 只注册计划任务，不含路径常量，路径都由 $PSScriptRoot 推出来。
    "tools/schedule-weekly.ps1",
    "tools/export-sources.mjs",
    "tools/export-guide-html.mjs",
    "tools/_keywords-snapshot.json",
]
# 旧版《给AI审阅-源码合集.md》不进包：它按"审阅批次"组织、行号与条数会滞后，
# 且与新的《跨境Listing优化工作台-源码合集.md》内容重叠 —— 两份同时外发，
# 收件人无从判断以哪份为准。
DOC_FILES = [
    "给AI审阅-功能细节与技术实现.md",
    "跨境Listing优化工作台-功能详细介绍.md",
    "跨境Listing优化工作台-功能详细介绍.html",
    "跨境Listing优化工作台-源码合集.md",
]
EMPTY_DIRS = ["data/gen", "data/uploads", "data/keywords/history"]   # 留空目录条目，不含内容

# ── 2. 排除表（每条写清理由；这张表本身就是给人复核用的）──────────
EXCLUDE = [
    ("data/gen/**、data/uploads/**", "★ 用户本地产物（生成的图 / 上传的参考图）"),
    ("data/external/**", "★ 用户从第三方（卖家精灵等）导入的词表 —— 含他自己的查询参数与来源，不随包外发"),
    (".env.local、.env.local.tmp、.env.*.local", "★ 真实 API Key"),
    ("node_modules/**、dist/**", "本项目零依赖，正常不存在；兜底"),
    ("tools/_*.out、tools/_*.run、tools/_*.err、tools/_*.new", "自检与文档同步的中间产物，可随时重新生成"),
    ("tools/make-share-pack.py", "★ 打包器自身 —— 含排除清单，外发等于交出原件"),
    ("tools/_chk_sync.py 等一次性探针脚本", "开发期临时脚本，不属于交付物"),
    ("*.zip、*.log、*.pid、*.port、*.lnk", "构建/运行期产物"),
]

# ── 3. 形态化自检规则（不靠穷举敏感值）────────────────────────────
ABS_PATH = re.compile(r"[A-Za-z]:[\\/](?:Users|用户)[\\/][^\s\"'`)\\]+")
USERNAME = re.compile(r"\bjs161\b")
KEYLIKE = re.compile(r"^[ \t]*([A-Z0-9_]*(?:API_KEY|APIKEY|TOKEN|SECRET)[A-Z0-9_]*)[ \t]*=[ \t]*(.*)$", re.M)
# 相对导入说明符：`from "./x.js"` / `import("./x.js")` / `import "./x.js"`
# ⚠️ 只认 `.` 开头的。`/assets/x.js` 是浏览器按 HTTP 根解析的 URL（出现在 browser-selftest.mjs
#    注入到页面里的字符串中），**不是**文件系统相对路径，别把它算进闭包。
REL_IMPORT = re.compile(r"""(?:from|import)\s*\(?\s*['"]([^'"]+)['"]""")
TEXT_EXT = {".js", ".mjs", ".html", ".css", ".json", ".md", ".py", ".yml", ".yaml", ".example", ".gitignore", ""}


def collect():
    """按白名单收集 → [(绝对路径, 包内相对路径)]"""
    items = []
    for f in CODE_FILES:
        p = ROOT / f
        if p.is_file():
            items.append((p, f))
    for d in CODE_DIRS:
        base = ROOT / d
        if not base.is_dir():
            continue
        for p in sorted(base.rglob("*")):
            if p.is_file() and not p.name.startswith("_details.") and p.suffix != ".pyc":
                items.append((p, p.relative_to(ROOT).as_posix()))
    for f in TOOL_FILES + DOC_FILES:
        p = ROOT / f
        if p.is_file():
            items.append((p, f))
    # 去重 + 剔除自己
    seen, out = set(), []
    for p, rel in items:
        if p.resolve() == SELF:
            continue
        if rel in seen:
            continue
        seen.add(rel)
        out.append((p, rel))
    return sorted(out, key=lambda x: x[1])


def scan(items):
    """形态化自检：返回 (致命, 提示) 两份清单；每处命中都带上下文。"""
    fatal, warn = [], []
    for p, rel in items:
        if p.suffix not in TEXT_EXT:
            continue
        try:
            txt = p.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for m in ABS_PATH.finditer(txt):
            fatal.append((rel, "绝对路径泄漏", txt[max(0, m.start() - 40):m.end() + 20].replace("\n", " ")))
        for m in USERNAME.finditer(txt):
            fatal.append((rel, "用户名泄漏", txt[max(0, m.start() - 40):m.end() + 20].replace("\n", " ")))
        for m in KEYLIKE.finditer(txt):
            val = m.group(2).strip().strip('"').strip("'")
            if val and "your" not in val.lower() and val not in ("", "<空>"):
                fatal.append((rel, "疑似密钥有值", "%s = %s" % (m.group(1), val[:12] + ("…" if len(val) > 12 else ""))))
        if p.name.startswith("_") and p.suffix in (".mjs", ".py"):
            warn.append((rel, "下划线开头的工具脚本（确认是文档工具链而非临时探针）", str(rel)))
    return fatal, warn


def build(items, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".zip.part")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for d in EMPTY_DIRS:
            if (ROOT / d).is_dir():
                zi = zipfile.ZipInfo(TOPDIR + "/" + d + "/")
                zi.external_attr = (0o40755 << 16) | 0x10
                # 固定时间戳：writestr 默认取**当前时间**，会让每次重打都换一个哈希 ——
                # 于是"内容有没有变"就失去判据（源文件 mtime 没动，哈希却变了）。
                # 钉成 1980-01-01（zip 纪元）后：源码不变 → zip 字节不变，可比对。
                zi.date_time = (1980, 1, 1, 0, 0, 0)
                zi.compress_type = zipfile.ZIP_STORED
                z.writestr(zi, b"")
        for p, rel in items:
            # 第三方大文件走直拷，不做文本 round-trip
            z.write(p, TOPDIR + "/" + rel)
    tmp.replace(dest)
    return dest


def verify(dest):
    """解压到干净临时目录 → 语法检查 → 跑第一套自检（证明包自洽）。"""
    rep = []
    if not NODE:
        rep.append(("未找到 node", "跳过语法检查与包内自检 —— **自检通过 ≠ 包能用，请手动补跑**"))
        return rep
    with zipfile.ZipFile(dest) as z:
        bad = z.testzip()
        rep.append(("zipfile.testzip()", "OK" if bad is None else "损坏：" + str(bad)))
        names = z.namelist()
        rep.append(("包内条目数", str(len(names))))
        if any(n.startswith(TOPDIR + "/.env.local") for n in names):
            rep.append(("🔴 含 .env.local", "致命！"))
        # 🔴 相对导入闭包：包内每个 `./x.js` 都必须能在**包内**解析到。
        #    2026-10-02 真事故：包漏了 assets/rufus-*.js，而 app.js 已 import 它 →
        #    收件人打开页面**整个前端一行 JS 都不跑**（症状与 file:// 相同、原因不同）。
        #    光数文件个数查不出来 —— 只有把说明符解析成路径再看在不在包里才暴露。
        rel_tot, rel_miss = 0, []
        for n in names:
            if not n.endswith((".js", ".mjs")):
                continue
            try:
                body = z.read(n).decode("utf-8", "replace")
            except Exception:
                continue
            for spec in REL_IMPORT.findall(body):
                if not spec.startswith("."):
                    continue
                rel_tot += 1
                target = posixpath.normpath(posixpath.join(posixpath.dirname(n), spec))
                if target not in names:
                    rel_miss.append("%s → %s" % (n, spec))
        rep.append(("相对导入闭包", "%d 条，缺失 %d" % (rel_tot, len(rel_miss))))
        for m in rel_miss:
            rep.append(("🔴 包内缺文件（打开会整站不跑）", m))
    tmpd = tempfile.mkdtemp(prefix="sharepack-")
    try:
        with zipfile.ZipFile(dest) as z:
            z.extractall(tmpd)
        proj = Path(tmpd) / TOPDIR
        # 语法检查
        n_ok, n_bad, badlist = 0, 0, []
        for p in list(proj.rglob("*.js")) + list(proj.rglob("*.mjs")):
            r = subprocess.run([NODE, "--check", str(p)], capture_output=True)
            if r.returncode == 0:
                n_ok += 1
            else:
                n_bad += 1
                badlist.append(p.name + ": " + r.stderr.decode("utf-8", "replace")[:120])
        rep.append(("node --check 通过", "%d 个文件；失败 %d" % (n_ok, n_bad)))
        for b in badlist:
            rep.append(("🔴 语法失败", b))
        # 跑第一套自检（它在解压目录里跑，证明包内依赖齐全）
        r = subprocess.run([NODE, "tools/selftest.mjs"], cwd=str(proj), capture_output=True)
        out = (r.stdout + r.stderr).decode("utf-8", "replace")
        lines = [l for l in out.strip().split("\n") if l.strip()] or ["(无输出)"]
        rep.append(("tools/selftest.mjs exit", str(r.returncode)))
        rep.append(("自检结论行", lines[-1][:120]))
        # 🔴 失败时不能只给最后一行：Node 崩溃的最后一行永远是「Node.js v22.x」，
        #    等于什么都没说（2026-11-08 真踩过，只能靠手工解压复现）。给最后 8 行。
        if r.returncode != 0:
            for extra in lines[-8:-1]:
                rep.append(("  自检输出", extra[:160]))
        # MCP 协议自检也要在**解压目录里**跑一遍：这是「别人拉下来能不能调」的唯一证据。
        # 它会真起 mcp/server.mjs 子进程，并把 clients/*.json 的占位符换成本目录试一次。
        r = subprocess.run([NODE, "tools/mcp-selftest.mjs"], cwd=str(proj), capture_output=True, timeout=180)
        out = (r.stdout + r.stderr).decode("utf-8", "replace")
        lines = [l for l in out.strip().split("\n") if l.strip()] or ["(无输出)"]
        rep.append(("tools/mcp-selftest.mjs exit", str(r.returncode)))
        rep.append(("MCP 自检结论行", lines[-1][:120]))
        if r.returncode != 0:
            for extra in lines[-8:-1]:
                rep.append(("  MCP 自检输出", extra[:160]))
        if r.returncode != 0:
            rep.append(("🔴 MCP 自检失败", "包内 mcp/ 相关文件不齐，或协议契约被改坏"))
        # 后端能力：探活失败必须走 offline 分支（静态托管可行性）
        rep.append(("assets/api.js 有 offline 降级", "OK" if "online: false" in (proj / "assets/api.js").read_text(encoding="utf-8") else "未找到"))
    finally:
        shutil.rmtree(tmpd, ignore_errors=True)
    return rep


def main():
    items = collect()
    print("=" * 72)
    print("白名单收集：%d 个文件" % len(items))
    for _, rel in items:
        print("   +", rel)
    print()
    print("排除表（每条都写清理由）：")
    for pat, why in EXCLUDE:
        print("   -  %-46s %s" % (pat, why))
    print("=" * 72)

    fatal, warn = scan(items)
    print()
    print("形态化自检：")
    if warn:
        for rel, kind, ctx in warn:
            print("   [提示] %s | %s | %s" % (rel, kind, ctx))
    if fatal:
        print("   🔴 致命命中 %d 处，**不产出 zip**：" % len(fatal))
        for rel, kind, ctx in fatal:
            print("      %s | %s | %s" % (rel, kind, ctx))
        return 1
    print("   致命命中 0 处 ✓")
    if CHECK_ONLY:
        print("\n--check 模式：不打包。")
        return 0

    old = OUT.stat().st_size if OUT.exists() else 0
    build(items, OUT)
    print()
    print("已生成：%s" % OUT)
    print("  体积 %d 字节（上一版 %d 字节）" % (OUT.stat().st_size, old))
    print()
    print("端到端验证（解压到干净临时目录里跑）：")
    rep = verify(OUT)
    for k, v in rep:
        print("   %-28s %s" % (k, v))
    # 🔴 端到端验证不合格必须**以非 0 退出码收场** —— 否则脚本会"打印一堆红字然后 exit 0"，
    #    在 CI 或串起来的命令里等于静默放行（声明的失败必须真的是失败）。
    bad = [k for k, _ in rep if k.startswith("🔴")]
    if bad:
        print()
        print("🔴 端到端验证不合格 %d 项 —— 这个包不能发出去。" % len(bad))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
