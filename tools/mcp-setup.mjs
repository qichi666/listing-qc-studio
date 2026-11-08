#!/usr/bin/env node
/**
 * MCP 一键接入：把 `mcp/clients/` 里的模板换成"本机可直接用"的配置。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * 竞品的接入形态是「60 秒 / 0 行代码 / 复制一个 URL」（亚马逊官方、Helium 10、
 * 卖家精灵都是这样）。而我们的做法是**本地 stdio**，用户必须自己：
 *   找到模板 → 打开 → 把 `<PROJECT_DIR>` 改成绝对路径 → 找到客户端配置目录 → 粘贴 → 重启。
 * 对不写代码的运营，这不是"繁琐"，是"这件事我做不了"。
 *
 * 这个脚本把第 2–4 步做掉，只留"粘到哪、怎么重启"两句人话。
 *
 * ── 三条硬约束 ──────────────────────────────────────────────────────
 *   ① **绝不覆盖**客户端已有配置。只写 `data/mcp-setup/`，目标文件只做"存在性检查 + 打印指令"。
 *      覆盖别人的配置是不可逆事故，而且会连累他所有其他 MCP。
 *   ② **command 必须是绝对路径**。GUI 启动的客户端 PATH 里常常没有 node —— 这是
 *      "MCP 连不上、还看不到任何报错"的第一大原因。
 *   ③ 路径一律用**正斜杠**。Windows 反斜杠在 JSON 里要转义，在 TOML 里是转义符，
 *      写错一个 `\` 就整份配置解析失败。
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *   node tools/mcp-setup.mjs              # 生成到 data/mcp-setup/ 并打印粘贴指引
 *   node tools/mcp-setup.mjs --print      # 只打印，不写文件
 *   node tools/mcp-setup.mjs --out DIR    # 换输出目录
 *
 * ── 接入方式二（P0-B2）─────────────────────────────────────────────
 * 上面这套是 **stdio**：客户端 spawn 进程，必须改配置 + 绝对路径。
 * 如果客户端支持「填一个 MCP URL」，可以完全不改配置 —— 本脚本结尾会打印
 * `node mcp/http.mjs` 的启动命令与 token 位置（回环 HTTP，只绑 127.0.0.1）。
 * 🔴 这条只做**打印引导**：不启动常驻进程、不写 token（token 由 http.mjs 自己生成落盘），
 *    绝不覆盖已有配置这条硬约束在两条接入方式里都成立。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, "..");
const TEMPLATE_DIR = join(PROJECT, "mcp", "clients");
const argv = process.argv.slice(2);
const PRINT_ONLY = argv.includes("--print");
const OUT_DIR = (() => {
  const i = argv.indexOf("--out");
  return i >= 0 && argv[i + 1] ? resolve(argv[i + 1]) : join(PROJECT, "data", "mcp-setup");
})();

/** 正斜杠 + 绝对路径。`process.execPath` 在 Windows 上是 `C:\...\node.exe`，直接塞进 JSON 会多一层转义。 */
const toPosix = (p) => String(p).replace(/\\/g, "/");
const NODE_BIN = toPosix(process.execPath);
const PROJECT_POSIX = toPosix(PROJECT);

/**
 * 每个客户端：配置文件放哪、怎么让它生效。
 * `path` 只用于"存在就提醒你别覆盖"，**从不写它**。
 */
const TARGETS = {
  "claude-desktop": {
    label: "Claude Desktop",
    path: process.env.APPDATA ? join(process.env.APPDATA, "Claude", "claude_desktop_config.json") : null,
    how: "把生成的 mcpServers 合并进上面这个文件（已有内容不要删），然后完全退出并重开 Claude。",
  },
  cursor: {
    label: "Cursor",
    path: join(homedir(), ".cursor", "mcp.json"),
    how: "整份替换或合并进这个文件，然后在 Cursor 设置 → MCP 里点刷新。",
  },
  "claude-code": {
    label: "Claude Code (CLI)",
    path: null,
    how: "在项目目录里执行：claude mcp add listing-studio -- node \"" + toPosix(join(PROJECT, "mcp", "server.mjs")) + "\"",
  },
  vscode: {
    label: "VS Code",
    path: join(PROJECT, ".vscode", "mcp.json"),
    how: "放进项目的 .vscode/mcp.json（只对这个项目生效），命令面板执行 MCP: Restart Servers。",
  },
  codex: {
    label: "Codex",
    path: join(homedir(), ".codex", "config.toml"),
    how: "把 [mcp_servers.listing-studio] 这一段**追加**到文件末尾（TOML 重复键会报错，先确认没有同名段）。",
  },
  workbuddy: {
    label: "WorkBuddy",
    path: null,
    how: "在连接器/自定义 MCP 入口里选「本地命令」，command 填 node 的绝对路径，args 填 server.mjs 的绝对路径。",
  },
};

function listTemplates() {
  if (!existsSync(TEMPLATE_DIR)) return [];
  return readdirSync(TEMPLATE_DIR).filter((f) => /\.(json|toml)$/i.test(f)).sort();
}

/** 模板 → 可用配置。**只做两处替换**，其余原样保留（所以模板改了这里不用跟）。 */
function render(text, file) {
  let out = text
    .replaceAll("<PROJECT_DIR>", PROJECT_POSIX)
    .replaceAll("<NODE_BIN>", NODE_BIN);
  if (file.endsWith(".json")) {
    // `"command": "node"` → 绝对路径。只在值恰好是 node 时替换，别动 args 里的字符串。
    out = out.replace(/"command"\s*:\s*"node"/g, `"command": ${JSON.stringify(NODE_BIN)}`);
  } else {
    out = out.replace(/^command\s*=\s*"node"/gm, `command = ${JSON.stringify(NODE_BIN)}`);
  }
  return out;
}

const files = listTemplates();
if (!files.length) {
  console.error(`✗ 没找到任何模板：${TEMPLATE_DIR}`);
  process.exit(2);
}

if (!PRINT_ONLY) mkdirSync(OUT_DIR, { recursive: true });

const generated = [];
for (const f of files) {
  const id = basename(f).replace(/\.(json|toml)$/i, "");
  const raw = readFileSync(join(TEMPLATE_DIR, f), "utf8");
  const out = render(raw, f);
  const dest = join(OUT_DIR, f);
  if (!PRINT_ONLY) writeFileSync(dest, out, "utf8");
  generated.push({ id, file: f, dest, text: out });
}

const line = "─".repeat(62);
console.log(`\nMCP 接入配置已生成（项目：${PROJECT}）`);
console.log(line);
for (const g of generated) {
  const t = TARGETS[g.id] || { label: g.id, path: null, how: "按客户端文档配置本地 stdio MCP。" };
  console.log(`\n【${t.label}】`);
  console.log(`  生成文件  ${PRINT_ONLY ? "(仅打印，未写盘)" : g.dest}`);
  if (t.path) {
    const exists = existsSync(t.path);
    console.log(`  目标位置  ${t.path}`);
    console.log(`  状态      ${exists ? "⚠️ 文件已存在 —— 不要整份覆盖，只合并 listing-studio 这一项" : "文件还不存在，可以直接把生成内容存成它"}`);
  }
  console.log(`  怎么生效  ${t.how}`);
}
console.log(`\n${line}`);
console.log("自检（不用打开客户端也能确认服务是活的）：");
console.log(`  echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | "${NODE_BIN}" "${toPosix(join(PROJECT, "mcp", "server.mjs"))}"`);
console.log("");
console.log("连不上时按这个顺序查（90% 是前两条）：");
console.log("  1) command 是不是**绝对路径**，且那个文件真的存在（GUI 客户端的 PATH 里通常没有 node）");
console.log("  2) args 里的 server.mjs 路径对不对，反斜杠有没有漏转义");
console.log("  3) Node 版本 ≥ 20.15（node -v）");
console.log("  4) 客户端是否要完整退出再重开（只关窗口不算）");
console.log("  5) 客户端日志里搜 listing-studio / mcp");
console.log("");
console.log("接入方式二（不想改配置、客户端支持填一个 MCP URL 时）：");
console.log(`  "${NODE_BIN}" "${toPosix(join(PROJECT, "mcp", "http.mjs"))}"`);
console.log("  客户端填 http://127.0.0.1:8790/mcp，token 从 data/mcp-setup/token.txt 读，");
console.log("  优先放进请求头 Authorization: Bearer <token>（改端口用 MCP_HTTP_PORT）。");
console.log("  只有「只能填一个 URL」的客户端才用 ?token=，且 12 小时后失效、拒绝非空 Referer。");
console.log("  🔴 只绑 127.0.0.1、不给公网用；细节见 mcp/README.md「接入方式二」与「明确不做」。");
console.log("");
