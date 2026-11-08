/**
 * 把《功能详细介绍》的 Markdown 渲染成**单文件 HTML**，用来直接转发。
 *
 * 为什么要这一步：`.md` 在聊天软件里是一堆井号和竖线，非技术读者看不懂；
 * 而单文件 HTML 双击就能开、样式内联、不依赖网络，发给谁都能看。
 *
 * 复用 `assets/md.js` 的渲染器（同一套规则，不另写一份 Markdown 解析），只做三件后处理：
 *   1. 给二/三级标题加 `id="sec-N"`；
 *   2. 用真实标题**重建目录**（原 md 里的目录是手写锚点，容易和标题对不上）；
 *   3. 把 `[文字](#锚点)` 这类内部链接补成 `<a>`（内置渲染器只认 http(s) 链接）。
 *
 * 用法：
 *   node tools/export-guide-html.mjs            # 读 md，输出同名 .html
 *   node tools/export-guide-html.mjs --out x.html
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdown, escapeHtml } from "../assets/md.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const MD = join(ROOT, "跨境Listing优化工作台-功能详细介绍.md");

const outIdx = process.argv.indexOf("--out");
const OUT = outIdx > -1 && process.argv[outIdx + 1]
  ? resolve(process.argv[outIdx + 1])
  : MD.replace(/\.md$/, ".html");

const md = readFileSync(MD, "utf8");
let html = renderMarkdown(md);

/* ── 1. 标题加 id，并收集目录 ─────────────────────────────────── */
const heads = [];
let n = 0;
html = html.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (m, lv, txt) => {
  n += 1;
  heads.push({ id: `sec-${n}`, lv: Number(lv), txt });
  return `<h${lv} id="sec-${n}">${txt}</h${lv}>`;
});

/* ── 2. 用真实标题重建目录（覆盖手写的那一段） ─────────────────── */
const toc = heads
  .filter((h) => h.lv === 2 && !/^目录$/.test(strip(h.txt)))
  .map((h) => `<a href="#${h.id}">${h.txt}</a>`)
  .join("");
if (toc) {
  html = html.replace(/<h2[^>]*>目录<\/h2>[\s\S]*?(?=<h2)/, `<nav class="toc">${toc}</nav>`);
}

/* ── 3. 内部链接：[文字](#x) → <a> ──────────────────────────── */
html = html.replace(/\[([^\]]+)\]\((#[^)\s]+)\)/g, '<a href="$2">$1</a>');

function strip(s) {
  return String(s).replace(/<[^>]*>/g, "");
}

/* ── 4. 外壳与样式 ───────────────────────────────────────────── */
const title = (md.match(/^#\s+(.+)$/m) || [, "功能详细介绍"])[1];
const css = `
:root{
  --ink:#1f2328; --ink-2:#4b5563; --ink-3:#6b7280;
  --line:#e5e7eb; --bg:#ffffff; --bg-2:#f7f8f7; --accent:#1a3a2e; --accent-2:#2f6f57;
  --warn:#b45309; --warn-bg:#fffbeb; --red:#b42318; --code:#f4f5f4;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; background:var(--bg); color:var(--ink);
  font:16px/1.85 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
}
.page{max-width:920px;margin:0 auto;padding:48px 28px 96px}
header.top{border-bottom:1px solid var(--line);padding-bottom:18px;margin-bottom:8px}
header.top .kicker{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);margin:0 0 6px}
h1{font-size:32px;line-height:1.3;margin:0 0 10px;letter-spacing:-.01em}
h2{font-size:23px;margin:52px 0 14px;padding-top:14px;border-top:1px solid var(--line);letter-spacing:-.01em}
h3{font-size:18px;margin:32px 0 10px}
h4{font-size:16px;margin:24px 0 8px}
p{margin:12px 0}
strong{font-weight:650}
a{color:var(--accent-2);text-decoration:none;border-bottom:1px solid rgba(47,111,87,.25)}
a:hover{border-bottom-color:var(--accent-2)}
hr{border:0;border-top:1px solid var(--line);margin:34px 0}
ul,ol{padding-left:24px;margin:12px 0}
li{margin:5px 0}
blockquote{
  margin:16px 0;padding:12px 16px;border-left:3px solid #cbd5cf;background:var(--bg-2);
  color:var(--ink-2);border-radius:0 6px 6px 0;
}
blockquote p{margin:6px 0}
code{
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  font-size:.9em;background:var(--code);border-radius:4px;padding:2px 5px;
}
pre{background:transparent;margin:16px 0;padding:0}
pre code{display:block;background:var(--code);padding:14px 16px;border-radius:8px;overflow-x:auto;
  font-size:13px;line-height:1.65;border:1px solid var(--line)}
.tblwrap{overflow-x:auto;margin:16px 0}
table{border-collapse:collapse;width:100%;font-size:14.5px}
th,td{border:1px solid var(--line);padding:9px 11px;text-align:left;vertical-align:top}
th{background:var(--bg-2);font-weight:650;white-space:nowrap}
tbody tr:nth-child(even){background:#fbfbfa}
nav.toc{
  display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:6px 18px;
  margin:26px 0 8px;padding:18px 20px;background:var(--bg-2);border-radius:10px;border:1px solid var(--line);
}
nav.toc a{display:block;padding:4px 0;border:0;font-size:14.5px;color:var(--ink-2)}
nav.toc a:hover{color:var(--accent-2)}
footer.end{margin-top:64px;padding-top:18px;border-top:1px solid var(--line);font-size:13px;color:var(--ink-3)}
@media (max-width:640px){
  .page{padding:28px 18px 64px}
  h1{font-size:26px} h2{font-size:20px;margin-top:40px}
}
@media print{
  .page{max-width:none;padding:0}
  nav.toc{break-inside:avoid}
  h2{break-after:avoid} table{break-inside:avoid}
  a{color:inherit;border:0}
}
`;

const doc = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(strip(title))}</title>
<style>${css}</style>
</head>
<body>
<div class="page">
<header class="top">
  <p class="kicker">跨境 Listing 质检工作台 · 使用说明</p>
  <p style="margin:0;color:var(--ink-3);font-size:13.5px">这份文档可以直接转发给同事或客户，不需要安装任何环境。</p>
</header>
${html}
<footer class="end">跨境 Listing 质检工作台 · 功能详细介绍 ｜ 生成于 ${new Date().toISOString().slice(0, 10)}</footer>
</div>
</body>
</html>
`;

writeFileSync(OUT, doc, "utf8");
process.stderr.write(`已写入 ${OUT}（${doc.length.toLocaleString("en-US")} 字符，${heads.length} 个标题）\n`);
