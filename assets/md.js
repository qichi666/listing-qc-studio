/**
 * 极简 Markdown → HTML 渲染器。
 *
 * 为什么不引 marked / react-markdown：
 *   本应用要在断网、双击打开的场景下工作。任何 CDN 依赖都会静默变成空白页。
 *   这里只需要渲染我们自己产出的简报（标题 / 表格 / 代码块 / 列表 / 引用），
 *   支持范围收窄反而更可控 —— 也更容易做 XSS 转义。
 *
 * ⚠️ 安全：内容可能来自第三方 LLM 或剪贴板。**先整体转义，再按白名单放标签**，
 *    绝不做"先插 HTML 再清洗"。
 */

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
}

function inline(s) {
  let t = escapeHtml(s);
  // 行内代码优先，避免里面的 * _ 被当成强调
  const codes = [];
  t = t.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000C${codes.length - 1}\u0000`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  t = t.replace(/\u0000C(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
  return t;
}

/** 是否为表格分隔行：| --- | :--: | */
function isSep(line) {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-");
}
function splitRow(line) {
  return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
}

export function renderMarkdown(src) {
  const lines = String(src ?? "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++; // 跳过闭合
      out.push(`<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // 表格
    if (line.includes("|") && i + 1 < lines.length && isSep(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitRow(lines[i++]));
      }
      const th = head.map((h) => `<th>${inline(h)}</th>`).join("");
      const tb = rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("");
      out.push(`<div class="tblwrap"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`);
      continue;
    }

    // 标题
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }

    // 分隔线
    if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    // 引用（连续多行合并）
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${buf.map((b) => inline(b)).join("<br>")}</blockquote>`);
      continue;
    }

    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*[-*+]\s+/, ""));
      out.push(`<ul>${buf.map((b) => `<li>${inline(b)}</li>`).join("")}</ul>`);
      continue;
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*\d+\.\s+/, ""));
      out.push(`<ol>${buf.map((b) => `<li>${inline(b)}</li>`).join("")}</ol>`);
      continue;
    }

    // 空行
    if (line.trim() === "") { i++; continue; }

    // 段落（连续非空行合并）
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" &&
           !/^\s*(#{1,4}\s|```|>|[-*+]\s|\d+\.\s)/.test(lines[i]) &&
           !(lines[i].includes("|") && i + 1 < lines.length && isSep(lines[i + 1]))) {
      buf.push(lines[i++]);
    }
    out.push(`<p>${buf.map((b) => inline(b)).join("<br>")}</p>`);
  }

  return out.join("\n");
}

/** 挂到指定容器（内部先做 DOM 重建，避免残留事件监听） */
export function renderInto(el, src) {
  el.innerHTML = `<div class="md">${renderMarkdown(src)}</div>`;
  return el;
}
