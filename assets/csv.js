/**
 * CSV 导出 / 解析（词库快照、ASIN 明细等表格下载用）。
 *
 * 🔴 设计理由（为什么自己写、不引第三方）：项目零 npm 依赖，且导出链路要能被
 *    「导出 → 再解析回来逐字段相等」这条自测锁死 —— 用现成库反而没法保证与服务端口径一致。
 *
 * 🔴 铁律：
 *   ① 遵循 RFC 4180：字段含 逗号 / 双引号 / CR / LF 时用双引号包裹，内部双引号写成两个（""）。
 *   ② 首部加 \uFEFF BOM —— Excel 打开中文不乱码（UTF-8 BOM 的三个字节正是 EF BB BF）。
 *   ③ 行分隔固定 \r\n，且**不写**尾部空行 —— 否则解析会多出一条空记录，往返不再相等。
 *   ④ CSV 无类型：所有值按字符串写出，parseCsv 也一律返回字符串；比较时别拿数字去比。
 *   ⑤ 公式注入防护是**可选项**，且只在真正落地成文件时打开 —— 见 looksLikeFormula 的注释。
 */

/**
 * 单字段转义：只有确实需要时才加引号，避免无谓的引号噪音。
 */
function escapeField(value) {
  const s = String(value == null ? "" : value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 这个值落地成 CSV 后，会不会被表格软件当成公式执行？
 *
 * 🔴 威胁模型：词表里的「词」来自亚马逊搜索结果页，是**第三方可控文本**。
 *    如果某个词叫 `=HYPERLINK("http://evil","点我")`，导出后在 Excel 里打开会
 *    真的变成一个可点击链接；`=cmd|'/c calc'!A1` 这类老 DDE 载荷同理。
 *    这不是"数据格式问题"，是"导出即执行"的问题。
 *
 * 🔴 为什么做成**显式开关**而不是默认生效：
 *    防护靠加前导单引号（表格软件视为强制文本），而 parseCsv 无法无歧义地
 *    判断「开头的 ' 是防护加的，还是本来就是这个字」—— 于是
 *    `toCsv → parseCsv` 的往返相等（本文件的核心契约）会被破坏。
 *    所以：**编码（encode）保持纯净，只在写文件那一步加防护**。
 *
 * 🔴 负号开头的纯数字不算公式：`-12.5` 是价格/名次变化，加前缀会让 Excel
 *    把它当文本，求和排序全废。只挡"负号 + 非数字"（`-1+1`、`-cmd|...`）。
 */
export function looksLikeFormula(value) {
  const s = String(value == null ? "" : value);
  if (!s) return false;
  const c = s[0];
  if (c === "=" || c === "+" || c === "@" || c === "\t" || c === "\r") return true;
  if (c === "-") return !/^-\d+(\.\d+)?$/.test(s);
  return false;
}

/** 加防护前缀（`'`）。表格软件见到它按文本处理，肉眼几乎看不出来。 */
function guardField(value) {
  const s = String(value == null ? "" : value);
  return looksLikeFormula(s) ? `'${s}` : s;
}

/**
 * 把对象数组导出成 CSV 文本。
 * @param {Array<object>} rows 每行一个对象，取值用 c.key
 * @param {Array<{key:string, label:string}>} cols 列定义：key 取数、label 作表头
 * @param {{guard?: boolean}} [opts] guard=true 时给公式样式的字段加 `'` 前缀。
 *        **只有要交给 Excel / WPS / Sheets 打开的落地文件才该打开**；
 *        要再解析回来的（测试、进程间交换）保持默认 false。
 * @returns {string} 带 BOM 的 CSV 文本
 */
export function toCsv(rows, cols, opts = {}) {
  const guard = Boolean(opts && opts.guard);
  const field = (v) => escapeField(guard ? guardField(v) : v);
  const lines = [cols.map((c) => field(c.label)).join(",")];
  for (const row of rows) {
    lines.push(cols.map((c) => field(row == null ? "" : row[c.key])).join(","));
  }
  return "\uFEFF" + lines.join("\r\n");
}

/**
 * 猜分隔符：逗号 / 分号 / 制表符 / 竖线。
 *
 * 为什么需要：第三方工具导出的 CSV 不统一 —— Helium 10、Jungle Scout 用逗号，
 * 欧洲区的 Excel 常把列表分隔符设成分号，从表格软件直接复制过来则是制表符。
 * 一律按逗号切会把整行切成 1 列，然后报「找不到关键词列」—— 用户以为是文件坏了。
 *
 * 只数**引号外**的分隔符：`"a,b"` 里的逗号不是分隔符。
 */
export function sniffDelimiter(text) {
  const s = String(text == null ? "" : text).replace(/^\uFEFF/, "");
  const head = s.split(/\r?\n/).slice(0, 5).join("\n").replace(/"(?:[^"]|"")*"/g, '""');
  let best = ",";
  let bestN = 0;
  for (const d of [",", ";", "\t", "|"]) {
    const n = head.split(d).length - 1;
    if (n > bestN) { best = d; bestN = n; }
  }
  return best;
}

/**
 * 解析成**二维数组**（含表头行），不做表头映射。
 *
 * 与 parseCsv 的分工：这个函数只负责「文本 → 单元格」，谁当表头、列叫什么由调用方决定。
 * 第三方 CSV 导入必须先看表头再决定取哪列，所以不能一上来就按 key 收敛成对象。
 *
 * @param {string} text
 * @param {{delimiter?: string}} [opts] delimiter 传 "auto" 时自动嗅探；默认 ","
 * @returns {string[][]}
 */
export function parseRecords(text, opts = {}) {
  let s = String(text == null ? "" : text);
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  const delimiter = opts.delimiter === "auto" ? sniffDelimiter(s) : (opts.delimiter || ",");

  const records = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { records.push(row); row = []; };

  while (i < s.length) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === delimiter) { pushField(); i += 1; continue; }
    if (ch === "\r" || ch === "\n") {
      pushField(); pushRow();
      if (ch === "\r" && s[i + 1] === "\n") i += 2; else i += 1;
      continue;
    }
    field += ch; i += 1;
  }
  if (field !== "" || row.length > 0) { pushField(); pushRow(); }
  return records;
}

/**
 * 把 toCsv（或任意 RFC 4180）文本解析回对象数组。
 *
 * @param {string} text CSV 文本（可带 / 不带 BOM）
 * @param {Array<{key:string, label:string}>} [cols] 可选：给了就用 c.key 作对象键
 *        （label ≠ key 时也能和原始 rows 深相等）；不给则把表头行当键。
 * @returns {Array<object>} 每项一个对象，值均为字符串
 *
 * 🔴 为什么是逐字符状态机、而不是 split(/\r?\n/) 再 split(",")：
 *    字段内部允许出现逗号、双引号、换行（铁律①），简单 split 会把 "a,b" 拆成两列、
 *    把 "line1\nline2" 拆成两行 —— 往返必然失败。只有带 inQuotes 状态逐字符扫，
 *    才能把「分隔符」和「字段内容」分开。
 */
export function parseCsv(text, cols) {
  const records = parseRecords(text);
  if (records.length === 0) return [];
  const keys = (Array.isArray(cols) && cols.length) ? cols.map((c) => c.key) : records[0];
  return records.slice(1).map((cells) => {
    const obj = {};
    keys.forEach((k, idx) => { obj[k] = cells[idx] == null ? "" : cells[idx]; });
    return obj;
  });
}
