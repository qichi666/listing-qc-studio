# listing-studio MCP server

把「跨境 Listing 质检工作台」的**判断层**暴露成一个标准 MCP server。任何支持 MCP 的客户端（Claude Desktop / Cursor / VS Code Copilot / Codex / Claude Code / WorkBuddy）拉下这个仓库、改一行路径，就能调用。

**零依赖、零密钥、只读、不联网也能跑。** 不需要 `npm install` —— `dependencies` 是空的。

---

## 一句话说清它是什么、不是什么

| | |
|---|---|
| **是** | 拿到文案之后**怎么判断**：28 条文案规则质检、三层上传前预校验、关键词覆盖度、图片 Prompt 组装、两次快照对比、词频挖掘、亚马逊搜索建议、读本周词库快照 |
| **不是** | **不是关键词数据源**。没有搜索量、没有 ABA 排行；`keyword_snapshot` 读的是随仓库分发的**周更快照**，不是实时数据源 |

这一点必须先说清楚，否则接上去第一句话就会失望：

> 你问它「ceramic mug 这个词有多少搜索量」，它答不出来 —— 它没有这个数据。
> 你问它「我这条标题哪里会违规、还差什么才能上架、我埋的词漏了哪些」，它逐条给结论和依据。

需要搜索量 / 反查排名这类数据，得另接数据源（见文末「接第三方数据」）。**本 server 的价值是：数据到位之后，判断不用再靠人肉。**

---

## 30 秒接入

前置：Node.js ≥ 20.15（`node -v` 看一眼）。**不需要安装任何 npm 包。**

```bash
git clone <本仓库>            # 或者直接解压 zip
cd 跨境Listing优化工作台
node mcp/server.mjs --no-net  # 手动跑一下，看到 ready 就说明能起来
```

正常启动会在 **stderr** 打一行：

```
[mcp] ready（工具 8 个，联网=on）
```

然后把这个 server 写进客户端配置（下面的 `<项目绝对路径>` 换成你 clone 下来的目录，用**正斜杠**，Windows 也一样）：

```json
{
  "mcpServers": {
    "listing-studio": {
      "command": "node",
      "args": ["<项目绝对路径>/mcp/server.mjs"]
    }
  }
}
```

想彻底断网（比如在内网 / 审计环境里跑），加上 `"--no-net"`：工具数从 8 变 7，`amazon_suggest` 消失，此时进程**一个外部请求都不会发**。

### 想先看它跑起来是什么样？

```bash
node examples/mcp-demo.mjs            # 8 个工具全调一遍（含联网）
node examples/mcp-demo.mjs --no-net   # 离线版（7 个工具）
```

那是个**零依赖的最小 MCP 客户端**（起进程 → 握手 → 列工具 → 逐个调用 → 校验），退出码 0/1 可直接当冒烟测试用。


现成的配置文件按客户端放在 [`clients/`](clients/) 里，复制粘贴即可：

| 客户端 | 文件 | 放到哪里 |
|---|---|---|
| Claude Desktop | `clients/claude-desktop.json` | `%APPDATA%\Claude\claude_desktop_config.json`（macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`） |
| Claude Code | `clients/claude-code.json` | 项目根目录的 `.mcp.json` |
| Cursor | `clients/cursor.json` | 项目根目录的 `.cursor/mcp.json`，或全局 `~/.cursor/mcp.json` |
| VS Code（Copilot） | `clients/vscode.json` | 项目根目录的 `.vscode/mcp.json` |
| Codex CLI | `clients/codex.toml` | `~/.codex/config.toml`，把两行追加到文件末尾 |
| WorkBuddy | `clients/workbuddy.json` | `~/.workbuddy/mcp.json`，**已有内容要合并，不要覆盖** |

> 🔴 配置里**不要**写相对路径。MCP 客户端启动子进程时的工作目录由客户端自己决定，不一定是项目根目录。写成绝对路径就不会踩这个坑。

### 接入方式二：只填一个 URL（回环 HTTP，P0-B2）

不想改任何配置文件、且客户端支持「填一个 MCP URL」时，改用本机回环 HTTP：

```bash
node mcp/http.mjs                       # 默认 http://127.0.0.1:8790/mcp
MCP_HTTP_PORT=9000 node mcp/http.mjs   # 改端口（默认 8790，避开 server.mjs 的 8787）
```

启动后 **stderr** 会打印接入 URL 与本次随机 token；token 同时写入 `data/mcp-setup/token.txt`（`0600`，每次重启都换新）。
> 关于 `0600`：Linux / macOS 上是真正的 `0600`（`writeFileSync` 的 `mode` + `chmodSync` 双写）。Windows 的 NTFS 用 ACL 而不是 POSIX 位，Node 只能改只读标志，实测 `statSync().mode` 仍报 `666` —— 这是平台限制，不是忘了设；本机单用户 + 只绑回环的前提下，密钥不落 URL、不进日志这条仍然成立。
客户端优先用请求头 `Authorization: Bearer <token>`；只有「只能填一个 URL」的客户端才降级到
`http://127.0.0.1:8790/mcp?token=<token>` —— 这条 URL 含密钥，**别截图、别贴日志、别发给别人**，
且只在服务启动后 12 小时内有效、带非空 `Referer` 的请求一律拒绝。

安全四条（一条都不能少，§4 P0-B2 / §10.3）：

1. **只绑 `127.0.0.1`**：`server.listen(port, "127.0.0.1")`，启动后再用 `server.address().address === "127.0.0.1"` 硬断言一次，不是回环就拒绝启动。
2. **Host 白名单**只认 `127.0.0.1` / `localhost`（精确匹配），防 DNS rebinding —— `Host: evil.com` → 403。
3. **Origin 校验**：有 `Origin` 且非本机 → 403；另外所有响应都不回 `Access-Control-Allow-*`，浏览器跨站 fetch 的预检在第一道就被拦掉。
4. **Bearer token**：无 token / token 错 → 401。token 不进 URL 是首选，URL 降级只是兼容。

只实现 `POST /mcp` 的 **Streamable HTTP「单响应 JSON」模式**：`GET /mcp` → 405。
理由写进代码注释：本项目 8 个工具**全是单轮请求/响应**，没有服务端主动推送场景，
所以不实现 SSE 流、不实现 GET 长连接、不处理 `Mcp-Session-Id`（`handle()` 本身无状态）。

🔴 它**只监听回环**，不给公网用、也不做多用户。带正确 token 的 `tools/list` 与 stdio 版**逐字节相同** ——
两条传输复用 `mcp/server.mjs` 里**同一个** `handle(msg)`，不是第二份实现。这是「同一份判断层」最直接的证据。

> 实现分三层，别混：`mcp/server.mjs`（协议层，stdio 与 HTTP 共用）、`mcp/handler.mjs`（HTTP 请求层，纯函数：Host/Origin/token/路由）、`mcp/http.mjs`（进程层：token 落盘、`server.listen`）。

---

## 八个工具

参数里凡是以 `listing` 打头的那一组字段（`title` / `highlights` / `bullets` / `searchTerms` / `description` / `brand` / `primaryKeyword` / `category` / `isMedia`）在 `lint_listing`、`precheck_upload`、`analyze_coverage` 三个工具里是**同一套**，含义完全一致。

### 1. `lint_listing` — 28 条文案规则质检

```json
{
  "name": "lint_listing",
  "arguments": {
    "title": "Ceramic Mug 350ml Insulated Coffee Cup with Handle",
    "highlights": "ceramic, 350ml, dishwasher safe",
    "bullets": ["KEEPS DRINKS HOT: ...", "EASY TO CLEAN: ...", "COMFORTABLE GRIP: ..."],
    "searchTerms": "ceramic mug coffee cup insulated 350ml",
    "brand": "Acme",
    "primaryKeyword": "ceramic mug"
  }
}
```

返回：

```json
{
  "conclusion": "存在硬规则命中，发布前必须修改（P2 标题含促销词）",
  "counts": { "total": 28, "hit": 1, "hitP": 1, "hitC": 0, "checked": 27, "skipped": 1, "errored": 0 },
  "hits": [{ "id": "P2", "level": "P", "scope": "title", "detail": "best seller", "source": "平台公开规则" }],
  "unjudged": [{ "id": "P5", "status": "跳过", "detail": "字母过少（<8），无判定意义" }]
}
```

**四态计数必须一起看**：

- `checked = total − skipped − errored`
- `skipped`（跳过）= **未判定**。字母太少判不了全大写、没填品牌判不了品牌堆砌 —— 这些是「没查」，不是「查了没问题」。
- 结论里会明写「这不等于通过」。做自动化时**不要**把 `hit === 0` 当成通过，要看 `checked === total`。

### 2. `precheck_upload` — 上传前还差什么（三层）

```json
{ "ok": false, "blockers": [...], "warnings": [...], "externals": [...] }
```

- `blockers` —— 现在一定传不上去（标题空、品牌空、五点不足 3 条、超上限）。
- `warnings` —— 能传，但吃亏（Highlights 留空＝白丢一段参与搜索的索引额度）。
- `externals` —— **本工具明确不查**的 5 件事：UPC/GTIN、类目节点、价格库存、主图成图、类目合规文件。

`ok: true` 只代表「文本字段没硬缺口」。把它当成「可以上架了」是误读 —— 这也是 `externals` 一直返回、且永远非空的原因。

### 3. `analyze_coverage` — 关键词覆盖度

```json
{
  "name": "analyze_coverage",
  "arguments": {
    "title": "...", "bullets": ["..."],
    "keywords": ["ceramic mug", "insulated tumbler"],
    "competitors": [{ "name": "竞品A", "text": "Insulated tumbler with leak proof lid..." }]
  }
}
```

返回 `coveragePct`（**按字段权重**的加权覆盖率，权重 标题3 / 五点2 / 描述1 / 后台词1）、`gaps`、`minedGaps`、`weak`、`unused`。

- `gaps` —— **你自己给的词**里，竞品在打、你完全没提的。这是真缺口，优先处理。
- `minedGaps` —— 从竞品语料挖出来的片段。**含 n-gram 噪声**（会出现 "dogs reduces" 这种跨词碎片），只当线索，不要当待办清单。
- 两者刻意分开：混在一起报，真缺口会被噪声淹掉。

⚠️ 它回答的只是「这个词有没有出现在我的文案里」。**不是排名、不是搜索量。** 覆盖上去了也不代表排名会涨。

#### 用本周词库做覆盖度体检（S-2 / G-8，`useVault`）

显式传 `useVault: true`，工具会用只读的 `readLatest()` 把**本周词库快照**的词并进候选词：
**user 词优先、vault 词去重后追加**，再交给同一份 `analyzeCoverage` 判定。

```json
{
  "name": "analyze_coverage",
  "arguments": {
    "title": "...", "bullets": ["..."],
    "keywords": ["ceramic mug"],
    "useVault": true,
    "vaultLimit": 50,
    "vaultCategory": "kitchen"
  }
}
```

| 参数 | 类型 | 说明 |
|---|---|---|
| `useVault` | boolean | 默认 `false`。**不传时走旧路径，输出与改动前逐字节一致**（回归铁证）。⚠️ 开启后 `gaps` 恒为对象数组，见下方 `gapShape` 契约。 |
| `vaultLimit` | number | 最多并入多少个词库词，默认 50，`maximum: 500`。 |
| `vaultCategory` | string | 只取某个分组/类目（如 `kitchen`），留空不筛。 |

返回里几样新的东西：

- `summary.coverageUser` / `summary.coverageVault` —— **分开两个覆盖率**，各自按本组词算，
  绝不把两类词混算成一个数（两者之和不等于 `coveragePct` 是刻意的）。
- `vault` —— `{ok, reason, ...}`。**没有词库时不失败**：`isError: false` +
  `vault: {ok: false, reason: "missing"}`（如实透出 `readLatest()` 的 `reason`，不编成空数组导致「覆盖率 0」），
  只用 user 词继续跑（数据没生成 ≠ 工具坏了）。
- 🔴 **`gapShape` + `gaps` 是一对，必须一起看**：`useVault` 模式下 `gaps` **恒为对象数组**，
  与词库有无无关；返回体带恒值 `gapShape: "objects"` **自己**说明这次的形状，**不要只靠文档**。
  同一个 `useVault` 参数只对应一种形状，调用方只写一套解析：

  | `gapShape` | 出现条件 | `gaps` 的实际形状 |
  |---|---|---|
  | **不带此字段** | 不传 `useVault`（默认） | 字符串数组：原来的真缺口，**逐字节不变** |
  | `"objects"`（恒值） | 传 `useVault: true`（词库可用 / 无词库都一样） | **恒为对象数组**：`{term, from:"user"\|"vault", rootCount, groups, missingIn}`，按 `rootCount × 未覆盖` 排序 |

  无词库时 `readLatest()` 返回 `vault: {ok:false, reason:"missing"}`，但**不失败、不降形**：
  `gaps` 仍是对象数组，只是对象里 `from` 全是 `user`、`rootCount` 全是 `null`、`groups` 空
  （信息本来就没有，不丢东西）；`isError` 保持 `false`，只用 user 词继续跑。
  `useVault` 的参数描述与返回体 `vaultNote` 里也写明了这一点。

`rootCount` 是「这周被几个词根带出」的词根覆盖广度，**不是搜索量、不是热度**。
真实快照里旧名是 `hits`，新名是 `rootCount`（G-6 留了别名），两个都认。

### 4. `mine_keywords` — 词频（本地）

```json
{ "name": "mine_keywords", "arguments": { "text": "竞品标题 + 五点，多段用 --- 或换行分隔", "top": 40, "lang": "de" } }
```

1–3 gram 词频，7 套停用词（en/de/fr/es/it/nl/ja）。**中文不做分词**。返回按 `weight` 降序（长短词做了加权，不是裸频次）。

### 5. `build_image_prompt` — 图片 Prompt 组装

```json
{ "name": "build_image_prompt", "arguments": { "subject": "ceramic mug", "slot": "main" } }
```

`slot` 的取值决定口径：

- `main`（亚马逊首图）→ 强制 `1:1`、**图内禁止任何文字/角标/水印**、主体占比按平台要求。平台法规**优先于**设计惯例。
- `secondary` / `aplus` / `design` → 按 `ratio` 走，图内文字用三层信息架构（headline / evidence / cta）。

返回 `{ prompt, meta: { ratio, pixels, ... } }`。**只出 Prompt，不出图，不含任何 API Key。**

### 6. `diff_snapshots` — 两次采集对比

```json
{ "name": "diff_snapshots", "arguments": { "before": {...}, "after": {...} } }
```

比 9 个字段：标题 / 品牌 / 价格 / 星级 / 评论数 / 类目排名 / 五点 / 规格 / 描述。
`specs` 是对象，会拍平成 `键: 值` 再比 —— 所以「对方把材质从 ceramic 改成 porcelain」这种变化比得出来。

返回里的 `note` 要说清一件事：两份 ASIN 不同或缺失时，**这不是同一件商品的前后对比**，差异只供参考。

### 7. `amazon_suggest` — 亚马逊搜索建议（唯一联网工具）

```json
{ "name": "amazon_suggest", "arguments": { "prefix": "ceramic mug", "site": "US", "limit": 10 } }
```

返回的是**真实买家在搜索框里输入/看到的词**，零 Key、免费。克制设计：

- 每次调用**只发 1 个请求**，8 秒超时，不重试、不翻页；
- 响应超 256KB 立刻中止；
- 取不到就 `isError: true` + 原因，**绝不返回空数组冒充「没有建议词」**；
- 返回 0 条时给 `note`：可能是该站点的 mid/lop 没对上，也可能这个词真的没有建议词 —— **本工具分不出来，别当成「没人搜」**；
- `verifiedMarket` 告诉你这个站点的参数是否实测过：US、DE 是 `true`，其余站点是 `false`（可能返回空）。

不想联网就 `--no-net`，这个工具直接不注册。

### 8. `keyword_snapshot` — 读本周词库（词面 + ASIN）

```json
{ "name": "keyword_snapshot", "arguments": { "query": "ceramic", "limit": 50, "category": "kitchen", "includeAsins": true } }
```

读的是仓库里的 `data/keywords/latest.json` —— 由 `tools/collect-keywords.mjs` **每周**写一次
（GitHub Actions 周一 02:17 UTC）。所以它**不是数据源**，是「一份已经采好的本地快照」。

返回里三样东西必须一起看：

- `generatedAt` / `ageDays` / `stale` —— 超过 10 天就 `stale: true`，`staleNote` 会明说**别当本周数据用**；
- `counts` + `keywords[]` —— 每条带 `hits`（这周被几个词根带出来）与 `firstSeen` / `recurring`；
- `note` —— 每次都会重复那句边界：**这是词面清单，不是搜索量**；ASIN 的 `rank` 是榜单名次，不是销量。

两个参数值得单独说：

- `category` **同时**筛关键词（按 `groups`）与 ASIN；只筛 ASIN 的旧行为已改掉；
- `keywordsTotal` / `keywordsTruncated` / `asinsTotal` / `asinsTruncated` 告诉你**有没有被截断**：
  单次最多 500 条词、200 条 ASIN。不带这几个字段的话，模型会把"500 条"当成"全部只有 500 条"。
- `dataNote` 是采集器自己写的数据质量说明（例如"上一份快照损坏，firstSeen 重新开始"）。
  非空时**必须转述给用户**，否则这份数据看起来完好、其实是打了折的。

没有快照时返回 `ok: false` + `reason` + `hint`，**但 `isError` 保持 false**：
「定时任务还没跑过」是数据状态，不是工具故障。报成 `isError` 会让模型以为工具坏了、反复重试。

---

## 一次完整调用（可直接粘贴到终端验证）

```bash
cd 跨境Listing优化工作台
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"lint_listing","arguments":{"title":"BEST SELLER Ceramic Mug","brand":"Acme","primaryKeyword":"ceramic mug"}}}' \
  | node mcp/server.mjs
```

你会看到三行输出，其中第二行（`id: 2`）就是质检结果。看到 `"isError": false` 就说明整条链路通了。

---

## 传输与协议

- 传输一：**stdio**（`node mcp/server.mjs`）。每行一条 JSON-RPC 2.0 消息 —— 不是 LSP 那种 `Content-Length` 分帧。自己写客户端时最容易在这里写错。
- 传输二：**回环 HTTP**（`node mcp/http.mjs`，见上文「接入方式二」）。`POST /mcp`，一请求一响应 `application/json`；`GET /mcp` → 405。
- 🔴 两条传输复用 `mcp/server.mjs` 里**同一个** `handle(msg)`：它返回 `Promise<response|null>`，自己不写 stdout。stdio 主循环把返回对象 `send()` 出去，HTTP 层把它 `JSON.stringify` 成响应体 —— 所以 `tools/list` 逐字节相同。
- 版本：`2025-11-25` / `2025-06-18` / `2024-11-05`（降序）。客户端要哪个给哪个，要一个不认识的版本双向协商（太新给最新、太老给最老、夹中间给不超过它的最高版）。`server/discover` 提供无状态发现入口。
- 实现的方法：`initialize` / `server/discover` / `notifications/initialized` / `ping` / `tools/list` / `tools/call`；`resources/list` 与 `prompts/list` 返回空数组（客户端会顺手探测，不实现也得回，否则它以为服务坏了）。
- 还没实现的方法返回 JSON-RPC `-32601`，不是 `result: null`。
- **stdio 下 stdout 只能有协议消息。** 所有日志走 stderr（一行 `[mcp] ready`）。自己改这个文件时，一句 `console.log` 就能让客户端显示「0 个工具」，而且不报错。源码里装了 stdout 闸门：只有合法 JSON-RPC 才放行，其余转 stderr 并留痕。

---

## 协议细节（P2 增广，只动外壳不动 8 条描述一个字）

| # | 项 | 契约 |
|---|---|---|
| 1 | `annotations` | `tools/list` 里 8 个工具都带 `{readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:<只有 amazon_suggest 为 true>}`。出网的只有它一个。 |
| 2 | `outputSchema` + `structuredContent` | 每个工具 `outputSchema.type === "object"`；`tools/call` 成功时带 `structuredContent`，与 `content[0].text` 的 JSON 解析结果**深相等**（同一份 stringify 反解）。`content` 仍保留文本 JSON —— 老客户端只读 `content`，行为不变。工具级错误（`isError:true`）不返回 `structuredContent`（错误文本不是 JSON）。 |
| 3 | 参数校验表驱动 | `VALIDATORS = {string, number, array, object, boolean}` + `enum / minimum / maximum / maxItems`。传 `limit: "abc"` → `isError` 且消息含「应为 number」；超 `maximum` → `isError` 且含上限值。旧版漏掉的 `boolean` 现在也校验。 |

🔴 三条描述文本的字节数被自检卡死（单条 ≤750、八条合计 ≤6000、四段式 + 12 条指路回归），
所以**加字段可以，改描述不行** —— 上面这些协议字段都在 `describeTool()` 里给出，没有动 `TOOLS` 里的描述。

---

## 排错

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 客户端显示 **0 个工具** | ① 路径不是绝对路径；② `console.log` 污染了 stdout；③ Node 版本 < 20.15 | 先在终端跑 `node mcp/server.mjs`，看有没有 `ready`；再看 stderr 有没有报错 |
| 连上就断 / 一直转圈 | 客户端在等 `initialize` 的回包，而进程起不来（通常是 import 失败） | 终端直接跑一遍，import 错误会立刻打出来 |
| 中文变成 `??` 或乱码 | Windows 控制台代码页（GBK）在显示层面截断，协议里是 UTF-8 | 只影响终端显示；写文件时用 `--out` 重定向，别复制终端输出 |
| `amazon_suggest` 报 `HTTP 503` / 不是 JSON | 亚马逊风控页拦住了（`bm-verify`） | 这是概率性的，不是 bug；工具不会假装成功。要稳定取数就得用第三方接口 |
| 某站点返回 0 条 | mid / lop 没对上（除 US、DE 外都没实测） | 看 `verifiedMarket`；`false` 的站点就当「没测过」 |
| `python` / `npm` 相关报错 | 本项目零依赖，MCP 也不需要装包 | 只需要 `node` |

---

## 边界（诚实清单）

1. **没有搜索量、没有 ABA。** 唯一的数据入口是 `keyword_snapshot`，读的是本仓库里**已经采好的**词面快照，且只有拿到这份快照的机器上才查得到。想接真数据源看下一节。
2. **规则是判断，不是平台裁决。** 28 条规则里有一部分是**项目自定义的保守口径**（例如 75 字符要留到 72）。每条命中都带 `source`，标了「行业通行做法」的那几条不是平台明文。
3. **「跳过」不参与通过计算，但也别当成合格。** 四态口径的意义就在于不让未判定混进通过率。
4. **`analyze_coverage` 是文本覆盖，不是排名。** 它只能避免「竞品在打的核心词我一个字都没提」这种低级漏失。
5. **`amazon_suggest` 是搜索建议，不是搜索量。** 建议词只说明「这个词有人这么打」，不说明「有多少人搜」。
6. **不做自动调价、不写盘、不改你的文件。** 这个 server 从头到尾只读 —— `tools/mcp-selftest.mjs` 里有硬断言：跑完一整套调用，`data/` 目录一个字节都不许变。
7. **不做多用户。** stdio 是本地子进程模型，没有网络端口，也就没有鉴权问题。回环 HTTP 版虽然加了 Bearer token，但**只绑 `127.0.0.1`**、只服务本机单用户，不是给公网 / 多用户用的 —— 要挂公网得另做一整套鉴权与隔离。

---

## 明确不做（9 条，别被当成漏做）

方案 §7 把以下 9 条定为「明确不做」，写在这里防止以后有人以为漏实现、又去加一遍：

| 不做 | 理由 |
|---|---|
| 云端托管 MCP | stdio 是本地子进程模型；与「数据可整包带走」相悖 |
| 真实搜索量 / ABA 排名 | 需账号级付费 API；且「数据层需 Token 不能分发」是分发前提 |
| 按词库自动生成标题 | 生成是客户端的活，判断才是本工具的活；做了就变成「又一个文案生成器」 |
| 词库塞进 MCP resources | 每次传约 847KB；`keyword_snapshot` 已有 `query` / `limit` / `category` 三个筛选 |
| 搜索量评分 | 伪精确。立场是「不给数字给密度」 |
| `Mcp-Method` / `Mcp-Name` header 路由 | **stdio 没有 HTTP 头，实现无意义**（P2#12 / §6 #12） |
| MRTR（多轮往返） | 无 elicitation / sampling 需求，8 个工具都是单轮（P2#12 / §6 #12） |
| 真开 8 站 | 1,976 请求 ≈ 39.5min，失败面 ×8，无需求证据 |
| 词根 AI 自动扩充 | 会引入品牌名 / 型号噪声；「词根是人的判断」是设计立场，不是缺陷 |

其中两条**协议细节**要单独说清，因为最容易在评审里被当成「漏做」（P2#12 / 方案 §6 #12、§7）：

- **`Mcp-Method` / `Mcp-Name` header 路由不做**：这是 2026-07-28 规范里的 HTTP 头路由，
  而 stdio 传输**根本没有 HTTP 头**；回环 HTTP 版也只用一个 `POST /mcp` 端点、方法在 JSON-RPC body 里，
  不需要按头分发。实现了反而是死代码。
- **MRTR（多轮往返）不做**：本项目 8 个工具全是「一次请求 → 一次结果」，
  没有 elicitation / sampling 需求，也没有需要用户中途补输入的场景。

所以对外口径始终是「**兼容 2026-07-28 的无状态调用路径**」（`server/discover` + 无 session），
**不是**「完全符合 2026-07-28」。规范正文说 `server/discover` 是 MUST、官方博客说 not required，
两处口径冲突，我们按更严格的一侧实现了它。

---

## 接第三方数据（可选）

**真实**关键词数据只有两条路，都要**你自己的账号**；只想先看清「接上之后长什么样」，
可以走下面 §「另一条路」末尾那条**不需要账号的示例路径**。

| 来源 | 能力 | 代价 | 能不能预置给别人 |
|---|---|---|---|
| 卖家精灵 API | 关键词反查 40,000 次/月 | 约 $999/月 | ❌ 需账号 Token |
| 西柚洞察 | 关键词挖掘 / 反查 | MCP 公测期有免费额度（20,000 Credit/月） | ❌ 需账号 Token；**免费额度只给 MCP，不给 API** |

这两家都提供官方 MCP server，配置方式和上面一样（把它们的 `command` / `args` 加进同一个 `mcpServers`），**但 Token 必须各自填** —— 谁用谁配，没法随代码发出去。这也是为什么本项目要自己做 MCP：判断层可以随代码走，数据层不能。

接法（客户端侧）：让模型先调它们的工具取词，再把取到的词作为 `keywords` 传给本 server 的 `analyze_coverage`。两个 server 并行注册即可，不需要写胶水代码。

### 另一条路：让工作台自己去连（已经做好了）

上面那种接法是"在 AI 客户端里挂两个 server"。但很多时候你只是想在**工作台网页里**少截一次图 ——
那就用「设置与诊断 → 外部数据源」：填上自己的 `secret-key`，点「保存并测试」，
工作台会以 **MCP 客户端**的身份去连对方的 **Streamable HTTP** 端点
（卖家精灵：`https://mcp.sellersprite.com/mcp`，鉴权头 `secret-key`），
然后把返回归一成词表、存到 `data/external/`，在「本周词库」页和本地词库求交集。

两条路的区别：

| | 客户端挂两个 server | 工作台内置的外部数据源 |
|---|---|---|
| 谁在调 | AI 客户端 | 工作台自己的服务端 |
| 密钥放哪 | 客户端配置（各自的 JSON） | 本机 `.env.local`（`0600`），不回传浏览器 |
| 结果落到哪 | 对话上下文 | `data/external/<id>.json`，可复用、可对比 |
| 适合 | 想让 AI 帮你编排两头 | 只想把数据取回来自己看 |

实现只有两个文件：`assets/mcp-http.js`（传输层，只做协议）与 `assets/term-normalize.js`（归一，纯函数）。
端点白名单是 `server.mjs` 里的一个**常量表**，请求体里没有 URL 字段 —— 别的数据源要接入，
加一行常量 + 配一个环境变量即可，传输层不用改。

**还没有账号也能先验收界面**：设置页点「没有账号？看示例对比」，会跳到「本周词库」并显示
`tools/fixtures/external/sellersprite-demo.json` 里那 12 个示例词与本地词库的**真实交集**
（琥珀提示条会明写"这是示例数据"）。它读仓库里的 fixture，**不写** `data/external/`、不碰本地词库，
所以只读演示版也能用。后端就是 `GET /api/external/terms?compare=1&demo=1`，走的是同一套归一与交集代码。

> 示例能验「界面怎么显示、三格怎么算」，**验不了「对方的字段叫什么」**。
> 真接上一个新工具时，仍然必须先点一次「调用」核对字段名再导入。

---

## 自检

```bash
node tools/mcp-selftest.mjs        # 248 条断言，全离线，约 5 秒
node tools/mcp-selftest.mjs --net  # 额外真打一次搜索建议接口（197 条）
```

它真起进程、真灌 JSON-RPC，盯的是三类**静默失败**：

1. **stdout 纯度** —— 一个 `console.log` 就让整条协议流解析失败，而客户端只会说「0 个工具」；
2. **工具契约** —— `inputSchema` 与实际 `run()` 的参数对不上时，客户端会按 schema 构造参数、然后每次都失败，但错在 schema 不在参数；
3. **「未判定 ≠ 通过」** —— 这条口径散落在各工具输出里，一旦被简化，报告会变好看、结论会变错。

外加一条硬断言：**跑完 248 条调用，`data/` 下用户数据（除采集器写的 `keywords/` 外）的大小与 mtime 逐项不变。**
