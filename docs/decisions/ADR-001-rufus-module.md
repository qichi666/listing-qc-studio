# ADR-001: Rufus / Alexa 信息架构检查模块的边界、数据分层与口径分级

## Status

Accepted（2026-10-01）

适用范围：v2 方案 §4「P0-1」新增的 5 组规则（attributes 完整性 / 跨字段事实一致性 / 单位制一致性 / 买家问题覆盖矩阵 / 图内文字未文本化）。
本 ADR 只约束**新增**代码；项目内**已有文件一个都不改**（含 `assets/listing.js` 的 28 条规则、`index.html` 的导航、`assets/app.js` 的路由）。

---

## Background

本项目现状（已实测，直接采信）：

| 事实 | 值 |
|---|---|
| 源码规模 | 12,352 行 |
| 运行依赖 | 0 个（`dependencies: {}` / `devDependencies: {}`，Node ≥ 20） |
| 自检基线 | 469 条全绿（`selftest.mjs` 289 / `verify-server.mjs` 113 / `browser-selftest.mjs` 67） |
| `assets/listing.js` | 1,456 行，28 条规则（14 P + 14 C），导出 `lintListing(listing, ctx)` |
| `assets/app.js` | 1,431 行，7 视图路由（`chat` / `templates` / `library` / `listing` / `capture` / `vault` / `settings`） |
| `index.html` | 451 行（实际 29,925 字节），导航为 `#nav button[data-view]`，视图为 `.view[data-view]` |
| attributes 覆盖 | 0（`grep -rn "attributes" assets/*.js server.mjs` → 0 命中）；`AMAZON_FIELDS` 只有 9 个字段 |
| `assets/zip.js` | 176 行，`import { crc32 } from "node:zlib"` —— **Node 专属，不可在浏览器 import**；只导出 `buildZip` / `inspectZip`，**不含解压能力** |

需求来源（v2 已定稿，本 ADR 是它的执行规格）：

- §0 V1：attributes 官方明文影响 Rufus（Amazon Seller Central《Attributes guide》）；V12：本项目 attributes 零覆盖。
- §0 V3 / V8 / V9：跨字段一致性、OCR 读图、问题矩阵均为**从业者口径，非官方明文**。
- §4 P0-1 验收标准：规则 ≥5 组、新增断言 ≥40 条、每条规则带 `source`、**官方明文与从业者口径必须分开标注、不许把行业口径写成平台规则**、反向测试（完整 fixture 必须一条都不报）、三套自检全绿且总数 469 → ≥510。
- §5 A14：凡行业口径必须标注「从业者口径，非官方明文」，与官方明文分栏。
- §7 O-1：类目属性 schema 从哪来（待决）。

项目铁律（本 ADR 的所有结论都以此为约束）：

1. 派生逻辑 / 同一事实**只有一处实现**，绝不写第二份。
2. **每条规则必须有 `source`** 出处字段。
3. **界面不许说假话**（说得到必须做得到）。
4. **零依赖**（不引 npm 包、不引框架、不引图标库）。
5. **ESM 双端**：同一份代码浏览器与 Node 都能直接跑。
6. 算不出来宁可给 `null` / "数据不足"，**不给假数字**。
7. 数据目录可被环境变量 `LISTING_DATA` 重定向（测试用）。

代码组织基线（`references/01-standards/code-organization.md` §4）：**单文件 ≤ 300 行**是硬上限（不含空行注释），超限必须按子功能拆文件；单一职责；依赖只向下。

---

## Decision

### D1 模块边界：新建 `assets/rufus.js`（及配套纯函数文件），**不追加进 `assets/listing.js`**

**结论（可执行）**：本期新增 2 个代码文件 + 1 个数据文件，均为 `assets/` 下新文件：

| 文件 | 归属 | 职责（单一） | 行数预算 |
|---|---|---|---|
| `assets/rufus.js` | 实现者新建 | R 组规则表 `RUFUS_RULES` + 引擎 `lintRufus(listing, ctx)`，返回**与 `lintListing` 同构**的结构 | ≤ 300 |
| `assets/rufus-facts.js` | 实现者新建 | 纯函数：事实三元组抽取 `extractFacts()` + 单位制归一 `unitSystemOf()` / `sameFact()`。无 I/O、无 `node:` import | ≤ 300 |
| `assets/rufus-data.js` | 数据成员产出（**已产出**） | 纯数据：属性清单 `CATEGORY_ATTRIBUTES` / 问题矩阵 `CATEGORY_QUESTIONS` / 单位组 `UNIT_GROUPS` / 材质冲突对 `MATERIAL_CONFLICTS` / 数值单位正则 `NUMBER_UNIT_RE`（**零 import、零副作用**），同 `templates.js` 属"数据产物"，不受 300 行硬规则约束 | 不计 |

**依赖方向（只向下，无环）**：

```
index.html（仅在 listing 视图内新增一张卡片，不动导航）
   └─ assets/app.js（视图层：bindNav / render / 绑定按钮）
         ├─ assets/listing.js   （已有 28 条质检，本期不动）
         └─ assets/rufus.js     （新增：R 组规则引擎 lintRufus）
               ├─ assets/rufus-facts.js（新增：纯事实抽取 / 单位归一）
               ├─ assets/rufus-data.js （新增：纯数据）
               ├─ assets/listing.js    （只读复用 LIMITS / byteLength / matchWords / hasTerm）
               └─ assets/prompt-engine.js（只读复用 detectCategory / detectLang）
```

`assets/listing.js` **不 import** `assets/rufus.js` —— 依赖单向，无环，不产生"改一处牵全身"。

**接口契约（按真实定义写，实现者照此签名）**：

```js
// assets/rufus.js
export const RUFUS_GROUPS = [/* { id:"R1".."R5", name } —— 见下方「规则编号方案」 */];
export const RUFUS_RULES = [
  { id, group, level, scope, test(listing, ctx) -> {hit, detail}, why, source, sourceTier },
];
export function lintRufus(listing = {}, ctx = {}) -> { results, summary };
// ctx: { productType, imageText, category, brand }
// 返回结构与 lintListing 严格同构：
//   results[i] = { id, group, level, scope, status, detail, why, source, sourceTier }
//   status ∈ {"命中","通过","跳过"}
//   summary = { total, hit, hitP, hitC, skipped, byGroup, conclusion }
```

**规则编号方案（完整，实现者照此编号）**：

- 沿用项目既有风格（`listing.js` 用 `P` / `C` 前缀 + 数字），Rufus 组统一用 **`R` 前缀**。
- 组标识 `group` 取 **`R1`–`R5`**，与 v2 §4 P0-1 的 5 组一一对应：
  - `R1` attributes 完整性（该填的字段空着 → 点名）
  - `R2` 跨字段事实一致性（title / bullets / Highlights / description 之间同一事实不许冲突）
  - `R3` 单位制一致性（同一事实只允许一个单位制）
  - `R4` 买家问题覆盖矩阵（按品类的高频问题逐条查答案）
  - `R5` 图内文字未文本化（A+ 图 / 信息图里的规格、兼容性、成分、尺码表须在文本字段里也出现）
- 规则 `id` 取 **`R<组号>-<两位序号>`**，组内从 `01` 起连续，**全表唯一**：`R1-01`…`R1-0n`、`R2-01`…、`R3-01`…、`R4-01`…、`R5-01`…。
- `level` 沿用 `listing.js` 的 P / C 语义（P = 平台级风险，C = 转化 / 可读性 / 需举证），**判据不变**。Rufus 组出厂默认 **C 级**；唯 `R1` 中"守卫的字段落在 `CATEGORY_ATTRIBUTES` 的 `required` 数组、**且该属性 `source === "amazon-guide"`**（即官方帮助文档**正文**明文，不含 `amazon-schema`）"的规则可判 **P 级**，其余一律 C（v2 明确跨字段一致性 / OCR / 问题矩阵是**从业者口径**，不能报"发布前必须修改"）。注：判据是**结构性**的 —— 字段在两档间移动、或 `source` 由 `amazon-schema` 改 `amazon-guide`，都会自动改变其 P 资格，规则侧与 ADR 均无需改动。
- `scope` 沿用字段名语义，值域为 `"attributes" | "facts" | "units" | "coverage" | "imageText"`，仅作展示分组用；引擎始终把整个 `listing` 对象传进 `test(listing, ctx)`（R 组天生跨字段）。

**判据（为什么职责真的不同）**：

1. **输入契约不同**。`lintListing` 的 `test(value, ctx)` 只吃"当前 scope 的单个字段值"（`SCOPES` 表把 scope 映射成一个值）；R 组①②③天生是**跨字段**的（要在 title / bullets / highlights / description 之间比对同一事实），④⑤还要吃**外部数据**（`ctx.productType` 的属性表、`ctx.imageText`）。把跨字段规则塞进只吃单字段的 `SCOPES` 模型，要么改 `lintListing` 的入参模型（=改已有文件），要么在 `SCOPES` 里再挂一个全局对象（=制造第二套取值口径）。两种都是「同一事实写两遍」。
2. **计算形态不同**。28 条规则是**正则/词表匹配**（输入文本 → 命中词表）；R 组②③是**归一 + 结构化比对**（文本 → 事实三元组 `<kind, value, unit>` → 跨字段求差）。后者需要一层 28 条规则没有的"事实抽取"中间层。
3. **数据依赖不同**。R 组①④依赖 `rufus-data.js` 的属性表与问题矩阵；28 条规则零外部数据。混在一起会让 `listing.js` 从"纯文案质检"变成"文案质检 + 类目 schema 消费"，单一职责被破坏（code-organization §4 规则 1）。
4. **300 行硬上限**。`listing.js` 已 1,456 行。再追加 40+ 条规则与事实抽取层，只会把既有的超限问题继续放大，且违反 code-organization §4 规则 2"超限必须拆分"。
5. **回归隔离**。新文件独立 → 469 条基线**结构上不可能因新增而变红**（不修改任何被现有断言引用的文件）。

**被否方案 A：追加进 `assets/listing.js`**。否因：违反 300 行硬上限与单一职责（上列 1/3/4）；且必须修改一个被 289 条源码级断言与多处渲染引用的既有文件，回归面不可控。唯一被认可的理由是"R 组也算 Listing 质检"——但"算质检"不等于"同一模块"，R 组是**信息架构**检查（准入层），28 条是**文案合规**检查（引用层），v2 §2 分歧 1 已把两者定性为**两个不同环节**。

**被否方案 B：只新建 `assets/rufus.js` 一个文件（不拆 `rufus-facts.js`）**。否因：40+ 条规则表 + 事实抽取 + 单位归一 + 引擎装配，实测量级 ≥380 行，超 300 行上限。若实现期间 `rufus.js` 逼近 300 行，**必须**把 `extractFacts` / `unitSystemOf` / `sameFact` 整体移入 `assets/rufus-facts.js`（按子功能拆文件，不是拆函数凑数）。这是本决策的强制拆点，不留自由裁量。

### D2 数据与逻辑分离：属性表 / 问题矩阵放进**纯数据文件 `assets/rufus-data.js`**，不写死在规则代码里

**结论（可执行）**：`assets/rufus-data.js` 只导出 `const` 数据，**零 import、零副作用、无函数**（极小的查表逻辑一律放 `rufus-facts.js`）。规则代码里**不得出现任何属性 key / 问题句 / 单位字符串字面量**（由附表「规则代码无数据字面量」这条源码级断言锁死）。

**分层线（数据层 vs 规则层的切分判据，team-lead 要求成文）**：**类目知识 → 数据层 `assets/rufus-data.js`**（`CATEGORY_ATTRIBUTES` / `CATEGORY_QUESTIONS` / `UNIT_GROUPS` / `MATERIAL_CONFLICTS` / `NUMBER_UNIT_RE` —— 它们随类目或官方模板变化）；**通用语言与符号标记 → 规则层 `assets/rufus-facts.js`**（`GUARD_STOPLIST`（`and` / `or` / `with` / `&` / `+` / `%` / `/` / `,` 这类与类目无关的连接词与符号）、`NEGATION_WORDS`（前置否定词表）、`UNIT_AMBIGUOUS` 判定规则、`°` 归一化 —— 换任何类目都不变）。一句话判据：**换个类目就得改 → 数据层；任何类目都不改 → 规则层**。据此，`GUARD_STOPLIST` 与 `NEGATION_WORDS` 落在 `rufus-facts.js` **不违反本决策**：本决策禁止进规则代码的是**类目相关**的数据字面量（属性 key / 问题句 / 单位串），而这两张表是**与类目无关的通用标记**；放进规则层，恰是为了让「guard 不得用连接词充数」「否定只用固定词表」这两条纪律能被**源码级断言**锁死（放数据层反而会被数据成员在增补时无意改动）。

该文件**已由数据成员产出**（603 行）。本 ADR **采信既有契约**，按它的真实形态写规则侧的消费接口，不另造名字。真实导出如下（节选，键名以文件为准）：

```js
// assets/rufus-data.js —— 纯数据，零 import
export const CATEGORY_ATTRIBUTES = {
  home_kitchen: {
    label: "家居厨房（Home & Kitchen）",
    required:    [{ key, label, source }, ...],   // source ∈ {"amazon-guide","amazon-schema","practitioner"}
    recommended: [{ key, label, source }, ...],
  },
  // 共 8 个 productType：home_kitchen / apparel / electronics / pet_supplies
  //                    / beauty / sports_outdoors / baby / office
};
export const CATEGORY_QUESTIONS = {
  home_kitchen: [
    { id, question, answerHints: [attrKey, ...], why, source }, ...   // 每类 10 条
  ],
};
export const UNIT_GROUPS = [
  // 6 组：weight / length / volume / temperature / power / battery_capacity
  { id, label, imperial:[...], metric:[...], units:[...], source },
];
export const MATERIAL_CONFLICTS = [
  { a, b, note, guards:[...], source },   // guards = 允许两者共存的词，命中即不报冲突
];
export const NUMBER_UNIT_RE = { regex, pattern, flags, unit, note, source };
```

四条**必须照做**的消费约束：

1. **属性条目的 required / recommended 由所在的数组决定**，条目本身**没有** `requirement` 字段 —— 规则在遍历时按下标所在数组判定档位，不要另加字段。
2. **问题的覆盖判据是 `answerHints`（属性 key 列表）**，不是正则。R4 的判定 = 该问题的每个 `answerHint` 是否在 listing 的文本/事实里被覆盖（复用 `hasTerm` 与 `extractFacts`），不新增第二套判据。
3. **`MATERIAL_CONFLICTS` 的 `guards` 必须生效，且 guard 词有词法纪律（R2 的首要误报源）**。本节四条纪律依序记为 **G1–G4**（team-lead 按此编号引用）：
   - **G1「命中语义」**：大小写不敏感命中，**逐对以该对自带的 `guards` 数组为准**（不同对 guard 词不同），命中**即整对跳过**，不做部分判定。
   - **G2「合法 guard = 材质 / 成分语境词」**（表达"部分材质 / 混纺 / 饰边 / 复合"）：**三层结构**（与数据侧 `MATERIAL_CONFLICTS[].guards` 的三段逐词对齐；**A ∪ B = 33 个共有词 = 每对 guard 的「地板」**。2026-10 实测 15 对 guard 数＝`37,33,33,33,35,33,33,33,33,33,33,34,33,33,33`）：
     - **子类 A「通用非主体部件 / 部位语境词」（普适语义 → 15 对全对共用）**：`lining` / `lid` / `base` / `frame` / `legs` / `handle` / `trim` / `coating` / `coated` / `insert` / `sole` / `strap` / `buckle` / `panel` / `cover` / `grip` / `rim` / `shell` / `filling` / `padding` / `cushion` / `sleeve` / `hood` / `collar`。语义＝"该材质仅用于某部件（非主体）"。例：`"Plastic Base"` 是「陶瓷花瓶的塑料底座」，不是"另一种主体材质"。**任何材质对都可能出现「主体 + 部件」复合商品，故本子类不绑定具体材质、必须逐对写全且逐对一致**（缺陷 H：8 例中 6 例误报，根因正是该子类词未对全部对生效）。
     - **子类 B「通用混纺 / 结构语境词」（普适语义 → 15 对全对共用）**：`blend` / `mixed` / `mix` / `combination` / `compound` / `weave` / `woven` / `knit` / `knitted`。语义＝"两种材质以混纺 / 织造方式共存"，本身不指向任一对。
     - **子类 C「材质特定语境词」（→ 逐对，只对该对生效）**：实测**只有 3 对有 C 词** —— `cotton`↔`polyester`＝`poly-cotton` / `cotton-poly` / `cotton blend` / `polyester blend`（+4）；`down`↔`polyester`＝`synthetic down` / `down alternative`（+2）；`aluminum`↔`carbon steel`＝`alloy`（+1）；其余 12 对 C 词为空。语义＝只在特定材质组合下才有意义（`down alternative` 对 cotton/polyester 毫无意义）。**纪律：C 词只能是「离开本对就无意义」的复合词** —— `alternatives` 是反面教材：会被通用营销句命中（实测 `title "Down Jacket"` + `description "Polyester fill, better than alternatives"` 被静默压成 `[]`），故**已删**；保留 `down alternative` / `synthetic down` 两个复合形式（SPEC §8 第 13 条）。
     - **为什么不收 `top` / `bottom`**：二者是**通用方位 / 质量形容**而非材质语境词 —— `top` 会命中 `"top quality cotton"` / `"top-rated"` 这类**质量形容**（修饰的是品质、不是部件）→ 属**误伤**，故**有意排除**（同 `GUARD_STOPLIST` 排除 `and` 的道理：词太泛，一旦当 guard 就把真冲突一起压掉）。2026-10 实测：二者在 15 对 `guards` 中出现 **0** 次。
     - （**裁定变更（保留）**：`free` / `free of` / `no ` **不列 guard** —— 其语义为「并未声称该材质」，归 G4 的 `NEGATION_WORDS`；留在 guard 表会与否定表重复成两份口径。**`trim` 仍保留**（归子类 A）：它表达"该材质仅用于饰边（非主体）"，是**材质语境词**而非通用连接词；`"genuine leather trim"` 与 `"faux leather"` 并存时不应报冲突。）
     - **guard 是「字段级二值」，不跨字段救场（缺陷 A 的修正方向）**：判定粒度是**整个字段** —— 某字段内命中该对的**任一** guard 词 → 该字段对该对的**全部**提及作废（不是只压命中的那一次、也不是 ±N 词窗口）。理由：guard 词（`lining` / `blend` / `strap` …）表达的是「本字段在做部件 / 混纺说明」，一个字段的语义基调是整段的；只压单个 token 在无标点长句与 A+ 文案上不可靠。**不跨字段救场**：guard 只在**它所在字段**生效（`title` 无 guard、`description` 有 guard 时，`title` 的提及**不被**后者拯救，反之亦然）。**落地形态**：`materialConflicts` 逐字段先算提及，字段内 `guards.some(hasTerm)` 命中即 `return` 跳过该字段（源码 `rufus-facts.js:270`）。
     - **代价（诚实边界，与 SPEC §8 第 12 条 / AC-15 对齐）**：`strap` / `cover` / `shell` / `sole` / `legs` / `collar` 这类词**在很多品类里就是商品本体而非部件**，一旦出现在描述字段就会把该字段的材质提及整片压掉。**实测漏报**：`title "Leather Belt"` + `description "Faux Leather Strap"` → `[]`（`strap` 触发字段级 guard；`cover` / `shell` / `sole` / `legs` / `collar` 同理）。**为什么不改**：若把 guard 收窄成「仅当同字段内**同时出现两种材质**才抑制」，则 `title "Wool Coat"` + `description "Acrylic lining"`（真实、常见、**合法**的「主体羊毛 / 里料腈纶」）会变成**误报** —— 误报比漏报贵。按项目铁律「误报不可接受、漏报可接受」**保留现状、登记为已知漏报边界**，并以反向锁 AC 钉住行为（见附表），防后人当 bug「顺手修」坏另一侧。
   - **G3「`GUARD_STOPLIST`」**（通用连接词 / 标点 / 纯符号，一律禁止充作 guard）：`and` / `or` / `with` / `&` / `+` / `%` / `/` / `,`。**已核对（2026-10 实测）**：数据文件 15 对 `guards` 现已不含 stoplist 任一字符（早前提示的 `and` / `with` / `%` 已清理）。理由：这些在任何文案里都出现，一旦当 guard 就会把真冲突一起压掉 —— 例：`"faux leather and genuine leather"` 若把 `and` 当 guard 就会被静默放过，而它**正是一条必须报的材质冲突**。**已清理（2026-10 实测）**：`silicone` / `latex` 对的 `guards` 已不含 `no ` / `free` / `free of` —— 这三个是**否定语义**不是 guard，已移出并归 **G4** 的 `NEGATION_WORDS`（见下方「交接项」）。
   - **G4「否定窗口 `NEGATION_WORDS`」**（G1–G4 之四；team-lead 实测残留红，ADR 初稿缺此成文条款）：
     - **是什么**：从字段文本提取到材质词（`a` / `b`）后，若**同一字段内**该词**前面 ≤2 个词**出现了否定词，则该次提及**被撤销**（视为「并未声称该材质」），不参与冲突判定。**对 `a` 侧与 `b` 侧同规则、对称适用**（每个存活提及各判各的窗口）。
     - **窗口三定（team-lead 实测批复，方向已写死无歧义）**：**同字段**（否定不跨字段 —— `title` 的否定不撤 `description` 的提及，反之亦然）、**方向＝只向前撤**（**否定词只撤销它后面 ≤2 个 token 内出现的提及；不撤销它前面的提及**。净结果：`"genuine leather, not synthetic"` → `not` 撤后面的 `synthetic`、**不撤**前面的 `genuine leather`；因 b 侧被撤空 → **整句不命中**，句意即「真皮，不是合成」）、**固定 2 词**（否定词与其后材质词至多间隔 2 个 token；多词否定词组如 `not made of` 占 1 个位置）。
     - **`NEGATION_WORDS`（唯一否定判据；通用英文标记，归规则层 `rufus-facts.js`）**：`not` / `no` / `non` / `never` / `without` / `excluding` / `instead of` / `rather than` / `not made of`。多词条目按**连续词组整体匹配**，占窗口的 1 个位置（故 `not made of genuine leather` 能被撤）。
     - **未定义否定 → 视为未否定**：只有命中 `NEGATION_WORDS` 才撤提及；其余 token（含未知否定表达）**不撤**。理由：若把未知词也当否定，等于「任意词都能静默压掉真冲突」，属静默漏报（比误报更坏）；故宁可保留提及、由白名单明确兜住。四用例断言见附表（R2 组）。
     - **与 guard 的分工（防重复口径）**：guard 表达「两者**共存**」（混纺 / 饰边），否定表达「**并未声称**」；二者都只做「压掉」，都不新增误报，判定互不依赖。
     - **诚实边界（误报方向，与 L179 的漏报方向分开陈述）**：否定词距材质词 >2 词时不撤（例：`not at all genuine leather` 的 `not` 距 `genuine` 3 词）→ 留下**残存误报**。**这是「误报方向」的已知边界 —— 与 L179 的 G6「同字段真矛盾 → 漏报」方向相反，二者必须分开陈述、不得混成一条**。**为什么不放宽窗口**：放大会让远处子句的否定词误撤**真**冲突的提及（「标题说不含 X、描述说含 X」这类真不一致会被吞掉）；而 listing 文案的否定基本都是短句（`not leather` / `not made of leather` 都在 2 词内）。放宽窗口列为备用项、**本期不做**；该已知误报**已登记为断言**（附表「已知边界锁C」，引 SPEC §8 第 15 条 / AC-15），钉住行为防后人当 bug 顺手「放宽窗口」。
   - **G5「提及归并：同一段文本只归属一个术语」**（缺陷 D + 缺陷 G 的成文契约；**逐字段计算**）：
     - **提及 = 原文区间**：每个材质提及表示为**原文区间** `[start, end)`，边界**逐字复刻 `listing.js` 的 `hasTerm`**（不另造一套边界）。
     - **归并规则（逐字段内、逐对）**：对冲突对 `(a, b)`，在**同一个字段**内，若 `a` 的某提及区间与 `b` 的某提及区间**相交**（含包含、相等）→ 判为**同一段文本** → **保留覆盖更长的那个（更具体的术语）**，被包含者删除；**区间完全相同**（无从判长短）→ **两边都删**（保守）。
     - **范围**：归并**只在同字段内**做（「逐字段计算」）；跨字段之间不存在「区间相交」概念，交由 **G6**。
     - **效果（缺陷 G 实测反例）**：`"Faux Leather Sofa"` / `"Faux Leather Recliner"` → 两侧都只剩 `faux leather`，裸 `leather` 被归并掉 → **不报**（2026-10 实测 `[]`）。注意 `"genuine leather"` 内的 `leather` **不**被归并（该对的 b 是 `faux leather`，与 `genuine leather` 无相交）→ 仍可作 `leather` 提及，故 `title "Faux Leather"` + `description "Genuine Leather"` **报**（实测 `["leather|faux leather"]`）。**范例用词纪律**：本例两侧均不得出现 G2 guard 词 —— 原稿的 `Lining` / `Frame` 各自触发字段级 guard、把 description 整片压掉，会使本例**假绿**（结论对、理由错），故换成 guard-clean 的 `Recliner`。
   - **G6「跨字段配对（同字段并列豁免）」**（R2 的最终成对条件）：
     - 冲突对 `(a, b)` 命中，须存在一对**区间不重叠（G5 归并后）**的 a 提及与 b 提及，且二者**分处不同字段**。
     - **同字段并列 → 豁免不报**：一个字段内并列出现 a 与 b（如 `"leather outer, faux leather lining"`、`"Wool Acrylic Sweater"`）→ 视为同一处商品描述，**不报**；只有**跨字段**分别声明才报（与 R3 的 B3c 同构）。理由：缺陷 G 的另一根因是「同一材质 / 同一描述在两字段都写却被当成两处声明」。
     - **诚实边界（有意，非待办）**：G6 令**同字段内的真矛盾会被漏报**（如一条 bullet 写 `"100% cotton 100% polyester"`）。**本期有意不做** —— 原因：要覆盖须新增一张「互斥语气词表」（`100%` / `pure` / `only` / `exclusively` …），那是**第三份词表**，违反 SPEC §5 红线与 ADR「不引入第三个词表」纪律；为一个小概率文案开一张新表不值。此边界已在 SPEC §8 第 10/11 条登记（非漏做）。
   - **处理顺序（写死，不可调换）**：**G4 否定撤销 → G5 逐字段归并 → guard 清字段（G1–G3）→ G6 跨字段配对**。G4 / G5 都在「成对」之前，且 **G5 作用于 G4 之后的提及**。
   - 结果（G1–G6 合流）：`"cotton blend with polyester"`（同字段，含 guard `blend`）→ **不报**；`"faux leather and genuine leather"`（**同字段并列**）按 G6 → **豁免不报**；把同一对拆到**跨字段**（title `"Faux Leather"` + description `"Genuine Leather"`）→ **必须报**（否则连接词当 guard 就成了静默滤除）。
4. **`source` 值只作档位码读取，不参与文本匹配**：`CATEGORY_*` / `UNIT_GROUPS` / `MATERIAL_CONFLICTS` / `NUMBER_UNIT_RE` 的 `source` 一律经 `tierOf()` 映射后使用；**证据引用串另由档位生成**（见 D3），不得把 `source` 原值直接当出处文案展示。

**交接项（数据成员，随 D2 落地；关联 G2 / G3 / G4）**：

1. **guards 清理与三段对齐（已完成，2026-10 实测）**：`MATERIAL_CONFLICTS` 中 `{silicone, latex}` 对的 `no ` / `free` / `free of` 已移出 `guards`（它们是**否定语义**，由 G4 的 `NEGATION_WORDS` 承担）。**同批**按缺陷 H 把全部 15 对统一为「子类 A 通用部件词 ∪ 子类 B 通用混纺词 ∪ 本对特定词」三段（见 G2 / A3；缺任一段 = 缺陷 H 按对复发）。每对清完**不得为空**（否则该对永不抑制、可能过报）。
2. **同义词收敛（覆盖缺口，实测）**：`faux leather` 侧当前**无** `PU leather` / `leatherette` 别名 → 这类亚马逊高频表述会**漏报**；建议数据侧补别名（`vegan leather` 已独立成对，保留）。`faux suede` / `faux fur` 同理。
3. **已完成（保留为回归项）**：2026-10 实测 15 对 `guards` 均不含 `GUARD_STOPLIST` 任一字符（`and` / `with` / `%` 等已清理），由附表「guards 不含通用连接词」持续锁死，勿回退。

**R4 hint 处理：两分类，不引入任何 hint 白名单（team-lead 裁决：不得新增第三份词表）**：

`CATEGORY_QUESTIONS[].answerHints` 里的值只分两类，判据是**是否需要外部白名单**——不需要：

1. hint ∈ 该 productType 的 `CATEGORY_ATTRIBUTES` 属性 `key` 集 → **key 类**（参与判定）。
2. 其余一切字符串 → **非 key，一律只作"买家关注维度"线索**，不报错、不建白名单、不参与判定。
   - 这样就不再新增任何词表：属性 key 是**已有事实**，其余靠"是不是 key"直接分流 —— 避免了第二份/第三份口径（Spec §5 红线）。

R4 覆盖判定（可执行，A1 定稿；`K` = 该题的 key 类 hint 集合，`C` = 其中已被覆盖者）：

1. 若 `K` 为空（该题没有可判的 key）→ `跳过`，`detail` 说明"无可用判据，仅作线索"，**不报未覆盖**。保留为守卫，**不写计数断言**。
2. 若 `|K| == 1` → 该 hint 被覆盖即 `通过`，否则 `命中`（单 hint 精确判定，无误报空间）。
3. 若 `|K| >= 2`：
   - `C` 为空（一个都没答）→ `命中`；
   - `C` 非空但**未覆盖全部**（部分覆盖）→ **`通过（部分）`**（**独立状态**，不得与"全通过"同形），且 `detail` **逐个列出未覆盖的 key 作为线索**；
   - `C` 覆盖全部 → `通过`。
   - **这是 OR 而非 AND，是刻意的**。多条 key hint 表示这是**复合问题**，hint 之间是**同位 / 备选承载**关系（例：`beauty-q8` "How many ounces…" → `capacity` 与 `net_content_volume` 是同一事实的两个可能字段；`apparel-q1` "What size should I order…" → `size` / `size_map` / `fit_type` 三条路答同一问）。用 AND 会把"答了尺寸、没答数量"误报成未覆盖 —— 直接踩铁律「误报＝工具失信」。v2 §4 P0-1 ④ 的原话也是"检查**有没有**对应的答案句"。
4. **守卫 A（少报可以，但不许把少报藏起来）**：`|K| >= 2` 且部分覆盖时，`status` 必须是 `通过（部分）`（与全通过**不同形**），且 `detail` 逐个列出未覆盖的 key。禁止静默全通过。
5. **守卫 B（防 OR 被稀释成"永远通过"）**：**每条问题的 key 类 hint 数 ≤ 3**（实测当前最大值 = 3）。若某题需要 4 个以上 key hint → 说明这题**装了两个问题，应当拆题**，而不是继续堆 hint；否则只要堆够 hint，OR 必然通过，R4 就成了摆设。
6. 非 key 字符串只在 `detail` 作线索展示，一律不参与判定 —— 沿用项目既有原则「线索不是待办」。

**状态值域**：`status ∈ {命中, 通过, 通过（部分）, 跳过}`。前三个与 `listing.js` 一致，**第四个 `通过（部分）` 是本模块新增、仅 R4 产生**（用于承载守卫 A）。

**消费形状裁定（数据成员 B2 / A3 / A2 / B3 提问的正面回答）**：

- **B2 guards 窗口形状：检测跨字段（cross-field）、压掉字段级（field-scoped）** —— 二者**不是一回事**，ADR 初稿写「需同字段含 `a`、`b`」是**错的**，此处更正。对 listing 的每个文本字段（title / 每条 bullet / highlights / description）**独立**扫描，各自得到「本字段的材质提及元组」（先做 G4 否定撤销）；随后对每个冲突对 `(a, b)`，只要 `a` 侧与 `b` 侧的**存活提及**各自非空**且分处不同字段**（**G6**；同字段并列豁免）—— 即命中（除非被 guard 压掉）。`title` 说 `cotton`、`description` 说 `polyester` 而异字段，**正是一条必须报的跨字段不一致，也正是 R2 的本体**（附表「材质冲突命中」即此）。**压掉始终字段级、不跨字段**：某 guard / 某否定只作用于**它所在字段内**的提及；`title` 无 guard 而 `description` 有 guard 时，`title` 的提及不被后者拯救。理由：guard 若跨字段生效等于给"标题与描述各说一个材质"开后门。粒度取字段级而非句子级 / ±N 词窗口：句子切分对无标点长句与 A+ 文案不可靠，字段级最粗、最不易误判，且与"同字段内自洽即可"的直觉一致。
- **A3 guards 作用域 = 分两层（缺陷 H 的正面裁定：该共用的必须全对共用、该逐对的禁止跨对并集）**：
  - **子类 A（通用部件词）+ 子类 B（通用混纺词）＝ 普适语义 → 15 对强制共用**：**A ∪ B = 33 个共有词，即每对 `guards` 的「地板」**（2026-10 实测 15 对均 ⊇ 这 33 词）。每个材质对都可能出现「主体 + 部件」或「混纺」表述，故这两段词表在全部 15 对的 `guards` 里**必须逐对写全、逐对一致**（禁止「这对有 `lining`、那对没有」）。这不是"可选的并集"而是**契约**：任一对缺任一段 = 缺陷 H 按对复发。
  - **子类 C（材质特定词）＝ 逐对（per-pair），以该对自带数组为准，禁止跨对并集**：把**外对的 C 词**拿来当**本对** guard 就是「并集稀释」（如拿 `alloy` 去抑制 `cotton|polyester` → 大面积漏报）。实测仅 3 对有 C 词（见 G2）。**「不做全局并集」这条纪律只约束子类 C** —— 子类 A / B **本来就是全对共用**，不属于并集违规。
  - **共同纪律**：任一对 `guards` 清完不得为空（否则该对永不抑制、可能过报）；`GUARD_STOPLIST`（`and`/`or`/`with`/`&`/`+`/`%`/`/`/`,`）对全部子类一律禁入。**落地形态**见数据文件 `MATERIAL_CONFLICTS` 每对的「通用部件词 / 通用混纺词 / 本对特定词」三段注释。
- **B3 单位识别与歧义（team-lead 批复后重写，覆盖 4 个碰撞反例）**：
  - **识别前置**：单位 token 必须**紧跟数字**（允许中间一个空格；温度允许前导 `°`），识别时**大小写不敏感**；单位右侧到下一个字母之间不得再夹字母。仅此一条**不足以**挡住与英文词 / 缩写同形的碰撞（见下）。
  - **高危歧义单位（不参与冲突判定，只作线索）**：`UNIT_AMBIGUOUS` = **长度 ≤ 2 的字符 token，除白名单 `["oz","lb","kg"]` 之外全部归入**。这样按规则（而非靠枚举穷举）覆盖了团队实测的 4 个碰撞：
    - `"5 in stock"` → `in` 长度 2 且不在白名单 → 不判定（`in` 是介词）；
    - `"meets 4 g signal"` → `g` 不判定（G 是信号/重力）；
    - `"wait 2 w then retry"` → `w` 不判定（w 是周/宽度）；
    - `"Ready in 12 mm"` → `mm` 不判定（2 字符高危）。
  - **参与冲突判定的单位** = 长度 ≥ 3 的显式单位（`ounce(s)` / `pound(s)` / `gram(s)` / `kilogram(s)` / `inch(es)` / `foot` / `feet` / `yard(s)` / `meter(s)` / `liter(s)` / `gallon(s)` / `quart(s)` / `pint(s)` / `cup(s)` / `fahrenheit` / `celsius` / `watt(s)` / ……）**∪ 白名单 `["oz","lb","kg"]`**。白名单只放**英文里无词义碰撞**的短单位，故 `"32 fl oz"` 与 `"1 liter"`（v2 范例的**定稿形态**）仍能命中；**判据见 B3b**（严格同组：二者同属 `volume`）。
  - **代价（诚实标注）**：`ml` / `cm` / `ft` / `yd` / `pt` / `qt` / `mg` / `cl` 等 2 字符单位被排除在自动判定之外 → 相关单位制冲突会**漏报**。这是**有意的 少报**取舍（宁可漏、不可错）；如需纳入，必须逐个给出"与英文词无碰撞"的证据并显式加进白名单。
  - 数字后的量与任何 `UNIT_GROUPS` 组都归不上类时**忽略该数字**（不报、不猜）。
  - **歧义判据的归一化（`°`）**：提取单位 token 后**先剥掉前导 `°`，再做歧义判定与查表**；`°c` / `°f` 归入 `temperature` 组的 `c` / `f`，且**不受 `UNIT_AMBIGUOUS` 约束**（带度数符号即无词义碰撞，度数符号本身就是消歧标记）。**数据侧 `UNIT_GROUPS.temperature` 的 `units` 不需要新增 `°f` / `°c` 字面量** —— 由消费侧归一化负责，避免"同一事实写两遍"。若不写这条，`°F` / `°C` 会被"识别出来却归不了组"，净结果是**温度一致性检查整组消失**。
  - **B3b R3「比对窗口」= 严格同组 + 三条判据**（team-lead 实测裁决：**否掉 weight↔volume 桥**）：
    - **① 只吃非歧义提及**：仅长度 ≥3 的显式单位 ∪ 白名单 `["oz","lb","kg"]` 参与判定；`UNIT_AMBIGUOUS` 只作线索（见上）。
    - **② 同 `groupId` 桶内 imperial × metric 并存**：只在**同一个 `UNIT_GROUPS` 组**内比，**跨组一律不报** —— `"5 lb"`(weight) + `"30 cm"`(length) 不报。**不开 weight↔volume 桥**：实测反例 `"Net Weight 2 lb"`(weight/imperial) + `"Capacity 1 liter"`(volume/metric) 是一个**完全正确、完全常见**的瓶装/液体 listing（净重与容量是两个不同属性，同商品并存属常态）→ 桥一开即误报（与缺陷 D 同型）。
    - **③ 两制提及必须分处不同字段**：同组内 imperial 与 metric 出现在**同一字段**（如 `"5 lb (2.3 kg)"`，标准双单位披露）→ **豁免不报**；仅**跨字段**分别出现两套制（title `32 fl oz`、description `1 liter`）→ 报。
    - **范例（定稿）**：`"32 fl oz"` × `"1 liter"`（同 volume 组、跨字段）→ **命中**。v2 的 `32 oz` 之所以不成立**不是「跨组」**，而是数据里 `oz` 归 weight；改两个字符为 `fl oz`（`volume` 组自有 `fl oz`）即严格同组下照样命中，v2 原意完整保留。**判据来源是 R3 规则 + 数据归组，不是数据注释**；`assets/rufus-data.js` 那条「32 oz / 1 liter」自注本身就是待改数据（PM 已改）。
    - **诚实边界（本期）**：R3 **不做数值换算** → 同组跨字段双制一律判「并存」，故 `10 inches` + `25.4 cm`（数值其实等价）**也会被报**。根治需在数据层加换算表（属类目知识），**本期不做**；登记为已知边界（SPEC §11 / §8 相邻条目已标注）。取舍：宁可保留「提示型」命中，也不引入一张无官方明文的换算表。
- **A2 字段名对齐官方面**：`key` 一律取**亚马逊官方属性名**（snake_case，Flat File 列名 / SP-API 字段名形态）；**禁止自造 key**（含中文、意译）。中文说明放 `label`。可判据 = 格式正则 `^[a-z][a-z0-9_]*$` + 一张"已知错名"denylist（如 `product_dimensions`→应 `item_dimensions`、`weight`→应 `item_weight`、`title`→应 `item_name`）。**诚实边界**：本项目只保证"key 形态与官方列名一致且不含已知错名"，**未逐类目对照官方模板核对全量**（该限制写入 §11 诚实边界；这正是 O-1 路 B 存在的理由）。

**判据**：

1. 属性清单与问题矩阵是**参考事实**，不是逻辑。写进规则代码 = 事实与实现耦合，无法被数据级断言覆盖（例如"guard 词不得落在 `GUARD_STOPLIST`"、"每题 key 类 hint 数 ≤ 3"这类**数据健康度断言**，只有数据独立成文件才写得出）。
2. 项目已有先例：`templates.js`（1,994 行数据产物）与 `prompt-engine.js`（逻辑）分离，由 `tools/build-templates.mjs` 生成。本决策沿用同一形态，不发明新范式。
3. P0-3「空字段清单」交付物**直接消费数据表**，不 import 规则引擎 —— 关注点分离后，"列出某类目的空字段"这条链路完全不依赖规则代码能否跑。
4. 官方模板一旦更新，只需替换数据文件（"活规格"：先改数据再改代码，二者不冲突），不触碰规则与断言。

**被否方案：把属性表 / 问题矩阵写成规则代码里的常量**。否因：事实与逻辑耦合 -> 新增类目要改规则文件（改一处牵全身）；无法写数据级断言；P0-3 交付物被迫 import 规则引擎。**注意**：`rufus-data.js` 作为**数据产物**不受 code-organization §4 规则 2 的 300 行约束（该规则针对逻辑文件），与 `templates.js` 同等对待。

**被否方案：在规则代码内联"我需要的子集"**（只挑几条属性写进 `rufus.js`）。否因：与数据文件形成两份属性口径，改数据不改规则时静默不一致 —— 正是"同一事实写两遍"。

### D3 `source` 分级：数据层沿用既有三值 `source` 枚举，**规则层新增两档 `sourceTier`**，**现有 28 条不回填**

**结论（可执行）**：

1. **数据层**（`assets/rufus-data.js`，已产出）的 `source` **已经是档位代码**，取值恒为 `"amazon-guide" | "amazon-schema" | "practitioner"`（截至 2026-10-01 实测：77 / 52 / 148 条）。这是数据成员的既定契约，**本期不改数据文件**；规则侧**不得 hardcode 这些计数**（数据会随增补变化，断言只查"取值 ∈ 枚举"与"三档均存在"）。
2. **规则层**（`assets/rufus.js`）的每条规则与每条结果**新增 `sourceTier`**，取值 `"official" | "practitioner"`，由**唯一一处映射函数**派生（放 `rufus.js`，全项目只此一份）：
   ```js
   const TIER_OF = { "amazon-guide": "official", "amazon-schema": "official", "practitioner": "practitioner" };
   const tierOf = (s) => TIER_OF[s] ?? (() => { throw new Error(`未知 source 档位：${s}`); })();
   ```
   规则自身的 `source` 保留**人可读出处文本**（与 `listing.js` 的 `RULES.source` 同构，满足铁律「每条规则必须有 `source`」）。
3. **证据引用串必须随档不同（PM 追加的硬条件，不可省）**：规则层把档位码转成**出处引用串**时，`amazon-guide` 与 `amazon-schema` **不得共用一个笼统的"亚马逊官方文档"字样**：
   - `amazon-guide` 的条目，引用串写**帮助文档**（如"Amazon Seller Central《Attributes guide》正文"）；
   - `amazon-schema` 的条目，引用串写**结构化产物**（如"Amazon Flat File 模板列名 / SP-API Product Type Definition schema 字段名"）。
   理由：审阅者一追问"哪一条官方**正文**写了 `item_type_keyword`"，若答不出来，整段可信度会崩——这正是分档要防的事。
4. **`official` 徽标必须可展开 / 悬浮看到它究竟是 guide 还是 schema**（"证据不失真"，不可协商）。至于 UI 是把两档并成一栏加详情、还是分三栏平铺，属 UI 取舍，**由 team-lead 定**；本 ADR 只钉死"证据不失真"这条下限。
5. **现有 28 条不回填**：`assets/listing.js` 的 `RULES` 保持原样，`sourceTier === undefined` 对全部 28 条成立（由附表「现有 28 条不回填」锁死）。

**判据 —— 为什么规则层用 `sourceTier` 而不是直接复刻数据层的 `source` 枚举**：

- `listing.js` 的 `RULES.source` 是**自由文本出处**（`"平台公开规则（2026-07-27 生效）"`）。若 `rufus.js` 的 `RULES.source` 改成枚举，**同一个字段名会在两个规则模块里语义不同** —— 前端渲染、断言、`why/source` 展示全都要按模块分叉，等于第二套口径。故分层：`sourceTier` 承载**档位**（机器可判、UI 分栏用），`source` 承载**出处文本**（人可读）。

**判据 —— 为什么契约层两档、数据层三档（不是冲突，是分工）**：

- v2 §4 P0-1 / §5 A14 要求对外**分栏**的是「官方明文」与「从业者口径」**两栏**，UI 只分两栏。
- 数据层再把官方细分为 `amazon-guide`（帮助文档正文明确举例/定义）与 `amazon-schema`（Flat File 模板列名 / SP-API Product Type Definition 字段名 / 后台表单字段名）—— 这层细分**不丢也不许被抹平**：命中时带出**与该档对应的出处引用串**（帮助文档 vs 模板列名/schema），界面可展示"依据：帮助文档"还是"依据：模板列名"。即**契约两档、证据三级、引用串随档不同**。
- 项目自定义阈值归入 `practitioner`，采信数据文件既定纪律「宁可标低，不许标高」（其定义已含"项目自定义"）。**修订记录**：本 ADR 起草时曾设想给项目口径单列第三档 `project`；在核对已产出的数据文件后，**改为采信数据层既有的两档纪律**，避免为同一件事造两套档位。

**判据 —— 为什么新增字段而不是复用 `level`**：

- `level`（P/C）判的是**"错了会不会被打"**（平台级风险 vs 转化/可读性），回答"后果有多重"；`sourceTier` 回答"依据从哪来"。两者**正交**——存在 official-but-soft（C8 官方要求举证）与 practitioner-but-severe（跨字段硬冲突）。合并即抹掉一个维度。

**判据 —— 为什么不回填现有 28 条**：

- 现有 `source` 文本已**隐含**出处（`平台公开规则` vs `行业通行做法` vs `项目自定义`），信息未丢失；回填是纯形式改动，收益为 0。
- 基线 469 条已全绿。回填要动 28 处既有代码 + 28 条既有断言的上下文，是"改一处牵全身"的高风险低收益动作。
- 更重要的是：**回填会让新旧两套口径并存**。不回填 + 一条源码级断言（28 条 `sourceTier` 必须为 `undefined`）反而把"两套口径"这个风险堵死。
- 前端一致性：按"结果里有没有 `sourceTier`"决定是否渲染档位徽标，一处判断，不改旧渲染。

### D4 UI 落点：并入现有「文案与质检」视图（`data-view="listing"`）新增分区，**不新增第 8 个视图**

**结论（可执行）**：

1. 在 `index.html` 的 `<section class="view" data-view="listing">` 内、④⑤ 卡片所在的 `.grid.c2` **之后**，新增一个**全宽** `.card`：标题 `⑥ Rufus / Alexa 信息架构检查`，含 3 个控件：
   - `<select id="rProductType">`（选择 productType，选项由 `rufus-data.js` 的 `CATEGORY_ATTRIBUTES` 键渲染）
   - `<button class="btn primary sm" id="btnLintRufus">跑信息架构检查</button>`
   - `<div id="rufusOut"></div>`
2. `assets/app.js` 新增 `renderRufus()` 与 `btnLintRufus` 绑定；`renderRufus()` **必须复用**质检结果的渲染函数（若现有 `lintOut` 渲染是内联的，先抽成纯函数 `ruleResultHtml(results, opts)` 供两处调用）——不得复制第二份 HTML 拼装逻辑（铁律 1）。
3. **不改导航、不改路由**：`#nav button[data-view]` 一个不加，`bindNav` 一行不改，`S.view` 的 7 个值不动。

**判据**：

1. **输入同源**。R 组的输入就是 ④ 卡片里 `lTitle` / `lBullets` / `lHighlights` / `lDesc` 的同一批值。新增视图 = 要么复制一份输入（违反铁律 1），要么把 ④ 的字段状态提升到跨视图状态（改路由与状态模型）。并入则**零重复输入**。
2. **动作连续**。Rufus 检查是"质检"这个动作的下半场：先看 28 条文案合规（引用层），再看 R 组信息架构（准入层）。同屏并列正好落地 v2 §2 分歧 1 的"准入层 / 引用层"两环节表述。
3. **改动面（可执行对比）**：
   - 并入：`index.html` 加 1 卡（约 30 行）+ `app.js` 加 `renderRufus` 与 1 个绑定（约 40 行）。**不触碰** `#nav button` 相关断言与浏览器侧逐视图断言。
   - 新增视图：`index.html` 导航 1 行 + 新 `<section>`（约 40 行）+ `app.js` 的 `bindNav` 分支与视图切换分支各 1 处 + `renderX` + 按钮绑定 + **第 18 节"每个 `#nav button` 必须有绑定、每个被引用 id 必须存在"断言要同步** + `browser-selftest.mjs` 需新增第 8 个视图的点开核对。改动面约为并入的 3 倍，且新增两份"必须同步维护的清单"（导航项 / 视图节），是静默失效高发区。
4. 反面案例：项目历史上"服务端自己手写一份主体抽取"导致"离线修好、服务端仍旧"的缺陷，正是"两处实现 + 两份清单不同步"造成的。新增第 8 视图会把同一类风险再引一次。

**被否方案：新增第 8 个视图**。否因：见上述 1/3/4 —— 输入重复、改动面 3 倍、新增两份同步清单。**触发切换条件**（明确写死，不留裁量）：若产品侧要求 Rufus 检查支持"批量 ASIN 对比"（P2-1 批量质检模式），届时信息架构检查会变成**独立工作流**（不再依附单个 listing 的编辑态），**那时才**升格为独立视图；本期不做。

**图标与文案纪律（团队级 P0 规则在本期的落地）**：

- 本期新增 UI **不使用任何功能图标**（不新增导航项，故不新增图标位）。
- 若未来必须新增图标：采用**手写内联 SVG 符号集**（单一来源导出 path，全项目统一），**禁止 emoji 作功能图标、禁止引图标库 / npm / CDN** —— 这是"锁定一套 SVG 图标集"在零依赖铁律下的唯一可行落地（现有 `index.html` 导航沿用 emoji 属历史遗留，本期不修改；新增部分不引入）。
- 新增文案不得出现空泛占位；每句必须是可验证的陈述（铁律 3）。

### D5 attributes 检查的数据来源（v2 OPEN 项 O-1）：**本期做路 A**（`rufus-data.js` 手工属性表），路 B 须同时满足三个前置条件才做

**结论（可执行）**：本期 attributes 完整性（R1）的 schema 来源 = **路 A：`assets/rufus-data.js` 里手工整理、逐条标注 `sourceTier` 的属性表**。路 B **本期不做**。

**路 B 被推迟的三个验证结果（实测）**：

1. **`assets/zip.js` 不能解压，且是 Node 专属**。它只导出 `buildZip`（打包，method=0 存储）与 `inspectZip`（只读中央目录，列出条目名 / CRC / 大小 / 偏移），**没有任何解压函数**；且第 23 行 `import { crc32 } from "node:zlib"` 意味着它**在浏览器里 import 就报错**（实际引用方只有 `server.mjs` 与 `tools/*.mjs`，无一个浏览器资源引用它）。而 xlsx 内的 `xl/worksheets/sheetN.xml` 与 `xl/sharedStrings.xml` 是 **deflate 压缩**的（Excel 默认压缩）。"unzip + XML"里的 unzip 这一步，项目**没有现成能力**。
2. **补齐解压能力会立刻撞上两条铁律**。Node 侧可用 `node:zlib.inflateRawSync`，浏览器侧只能用 `DecompressionStream("deflate-raw")` —— 两条实现路径，直接违反铁律 5「ESM 双端同一份代码」与铁律 1「同一事实只有一处实现」。若把解析搬到 `server.mjs`，则 attributes 检查在**离线 / `file://` 场景不可用**，与项目定位（本地优先、离线可用）冲突。
3. **官方模板有时效闸门**。v2 O-1 自述"需 ≤90 天内的版本"。用户上传的模板可能是旧的，解析出的是**过期 schema**；据旧 schema 报"你缺字段 X"，比不报更坏（铁律 3）。

**判据 —— 为什么本期选路 A**：

- 数据由数据成员并行产出，逐条标 `sourceTier`；规则侧只做**机械判定**（该填的字段在本 listing 里有没有非空值）。
- **零依赖、双端同跑、可被断言**：数据级断言（required/recommended 键存在、key 唯一、official 必点名官方文档）全部可写、可跑。
- 直接支撑 P0-3"空字段清单"这个"唯一能一句话说清价值"的交付物。
- 成本与风险可控，不引入新的运行时分叉。

**路 B 的三个前置条件（须**同时**满足，缺一不做）**：

1. 拿到一条**双端一致、被断言覆盖**的 deflate-raw 解压路径（浏览器 `DecompressionStream("deflate-raw")` + Node ≥20 实测均可用），或明确接受"attributes 检查仅 HTTP/服务端可用"并把该限制写进 §11 诚实边界。
2. **模板版本闸门**：解析前必须能读出并展示模板生成日期，超过 90 天**拒绝采信**并明确提示，不许静默用旧 schema。
3. 有**≥1 份真实类目的官方模板做 fixture**，解析结果能与官方 Attributes guide 的字段名对齐（否则写不出断言）。

**路 B 之前最省的一步（记入路线图，本期不做）**：让用户把官方模板**另存为 CSV** 再上传（Excel / LibreOffice 自带能力，零依赖、零解析成本、双端天然一致）。它以最小代价拿到路 B 的"用户自带真实 schema"收益，可作为路 B 的低成本前身。本期亦不做，仅登记。

**被否方案：本期直接做路 B**。否因：上列三点 —— 缺解压能力、补解压会撞双端铁律或牺牲离线、模板时效无闸门。在三者未解决前做路 B，产出的"缺字段"提示可能是错的，直接违反铁律 3。

---

## Consequences

**正面**

- 新模块独立、可分测、可并行开发；**不改任何已有文件**，469 条基线结构上不会因新增而变红。
- 数据 / 逻辑 / 事实抽取三层分离：P0-3 交付物直接消费数据表；数据级与规则级断言各归其位。
- `lintRufus` 与 `lintListing` 返回结构同构 -> 前端**复用同一个渲染函数**，无第二份 HTML 拼装。
- `sourceTier` 三档把"官方明文 / 从业者口径 / 项目自定义"钉死为可断言的字段，v2 §5 A14 的分栏纪律由机器保证，不靠自觉。
- 新增断言预期把总数从 469 推到 ≥510，且新断言集中在 `rufus` 三文件与 UI 接线，回归定位成本低。

**负面 / 代价**

- 新增 3 个文件；`app.js` 需要把结果渲染抽成公共纯函数（一次性小重构）。
- R 组在 v2 定调下**默认全 C 级**（唯 R1 中字段落在 `required` 数组**且 `source === "amazon-guide"`** 者可判 P）。代价是"严重的跨字段冲突"在结论强度上不如 P 规则刺眼；**缓解**：UI 单列 R 组命中数并分栏展示，`summary.byGroup[g]` 单列每组 `hit/covered/miss/total`（并附 `pass/partial/skipped` 明细）。
- 路 A 的属性表是**人工整理的高频子集，非官方全量 schema**，必然不完备。**缓解**：在 `rufus-data.js` 与 UI 上明确标注"高频子集，非官方全量"，每条带 `sourceTier`；不完备性写入 §11 诚实边界。**这也是路 B 存在的理由**。
- R 组规则是纯函数、不读写文件，**不涉及 `LISTING_DATA` 数据目录重定向**；fixture 一律经函数入参注入（与 `store.js` 的纯函数层一致）。

**回归风险**

- 主要风险是 `app.js` 抽取公共渲染函数时误伤既有质检渲染 -> 由既有 289 条断言 + 第 18 节接线断言 + 浏览器侧 67 条端到端断言兜底；抽取后**先跑 `npm run test:all` 再动 Rufus 代码**。
- 次要风险是 `rufus.js` 误 import 浏览器不可用模块 -> 由断言"三文件不得出现 `node:` 前缀 import"结构性堵死（`zip.js` 是反面教材）。

**验收挂钩（对齐 v2 §4 P0-1）**

- 规则 ≥5 组、新增断言 ≥40 条（本 ADR 附 110 条草案，其中 R1=26 / R2=48 / R3=16 / R4=14 / R5=6）。
- 每条规则带 `source`，且带 `sourceTier` 两档（official / practitioner）；官方明文与从业者口径分栏。
- 反向测试：一份完整 fixture 跑 `lintRufus`，`summary.hit === 0`。
- 三套自检全绿，总数 469 → ≥510。

---

## Related ADRs

- 无其它 ADR（本文件为本项目首个决策记录）。
- 关联但非 ADR 的文档：`跨境Listing优化工作台-评审融合与修订方案（v2）.md` §4 P0-1、§5 A14、§7 O-1；`给AI审阅-功能细节与技术实现.md` §1 / §4 / §10 / §11。

---

## 附：新增断言清单草案（110 条）

`组` 列取值 R1–R5，对应 5 组规则：R1 attributes 完整性 / R2 跨字段事实一致性 / R3 单位制一致性 / R4 买家问题覆盖矩阵 / R5 图内文字未文本化。跨组通用断言挂在其最直接保护的组下。所有判据均为机械可判（等值 / 集合 / 正则 / 计数 / 源码文本匹配）。

| 断言名 | 判据（一句话，要机械可判） | 组 |
|---|---|---|
| 属性表覆盖面 | `CATEGORY_ATTRIBUTES` 键数 ≥3，且每个键下 `required` 与 `recommended` 两个数组都存在（可为空数组，但键必须存在） | R1 |
| 属性条目字段齐全 | 每条属性含 `key` / `label` / `source` 三字段，且 `key` 为 snake_case 英文列名 | R1 |
| 属性 key 唯一 | 同一 productType 下全部属性 `key` 不重复（required 与 recommended 合并去重后无重复） | R1 |
| 属性 key 官方命名格式 | 全部 `key` 匹配 `^[a-z][a-z0-9_]*$`，且不含已知错名 denylist（如 `product_dimensions`/`weight`/`title`） | R1 |
| 出处枚举白名单 | 数据文件内全部 `source` 取值 ∈ {`amazon-guide`,`amazon-schema`,`practitioner`}，无拼写变体 | R1 |
| 官方档位细分保留 | 数据中同时存在 `source==="amazon-guide"` 与 `source==="amazon-schema"` 的条目（契约两档、证据三级的前提） | R1 |
| required 字段空即命中 | required 字段为空的 fixture 跑 `lintRufus`，对应 R1 规则 `status==="命中"` 且 `detail` 含该字段 `label` | R1 |
| recommended 字段空即命中 | 同 fixture 针对 recommended 字段命中，且命中项 `level==="C"` | R1 |
| 属性齐全不误报 | 全字段填满的 fixture，R1 全部 `status!=="命中"` | R1 |
| 空 listing 全跳过 | 无任何输入时 R1 全部 `status==="跳过"`（沿用 `hasContent` 口径，不在空表上乱叫） | R1 |
| 未选 productType 跳过 | 未提供 `ctx.productType` 时 R1 全 `status==="跳过"` 且 `detail` 说明"未选择产品类型"，不抛异常 | R1 |
| 未知 productType 跳过 | 传入表外 productType 时 R1 全跳过，`detail` 点名"无该产品类型的属性表" | R1 |
| 仅官方明文 Required 可判 P | 遍历 R1 规则：`level==="P"` 者，其守卫属性必同时满足 `source === "amazon-guide"` 且落在 `required` 数组（`amazon-schema` 不支持判 P） | R1 |
| tierOf 映射唯一且正确 | 源码级：`TIER_OF` 映射表在 `rufus.js` 中只出现一处；`tierOf` 对 `amazon-guide`/`amazon-schema` 返回 `official`，对 `practitioner` 返回 `practitioner` | R1 |
| 未知档位响亮报错 | `tierOf("xxx")` 抛异常（不静默归为 official） | R1 |
| 证据引用串随档不同 | `amazon-schema` 条目的引用串必含"模板列名"或"schema"，`amazon-guide` 条目的引用串必含帮助文档名；全项目不存在共用的笼统串"亚马逊官方文档" | R1 |
| 档位码不直接当出处文案 | 源码级：`rufus.js` 不把 `source` 原值直接当引用串展示（必须经引用串映射生成） | R1 |
| 不做自动填值 | 源码级：`rufus.js` 内不出现对属性值的赋值写入（只读 `CATEGORY_ATTRIBUTES`） | R1 |
| 规则代码无数据字面量 | 源码级：`rufus.js` 的 `RUFUS_RULES` 里不出现属性 key / 单位字符串字面量（全部经 `rufus-data.js` 导入） | R1 |
| 返回结构与 lintListing 同构 | 每条 result 含 `{id,group,level,scope,status,detail,why,source,sourceTier}`，`status ∈ {命中,通过,通过（部分）,跳过}`（`通过（部分）` 仅 R4 产生），`summary` 含 `{total,hit,hitP,hitC,skipped,byGroup,conclusion}` | R1 |
| 三文件双端同跑 | 源码级：`rufus.js` / `rufus-facts.js` / `rufus-data.js` 均不含 `node:` 前缀 import | R1 |
| 现有 28 条不回填 | 源码级：`assets/listing.js` 的 `RULES` 长度仍为 28，且全部 `sourceTier === undefined` | R1 |
| 反向测试：完整 fixture 零命中 | 属性齐全 + 单位一致 + 事实一致 + 问题全覆盖 + 图文字已文本化的 fixture，`summary.hit === 0` | R1 |
| 不修改已有文件 | 源码级：`assets/listing.js` / `index.html` / `assets/app.js` 的既有导出与 `#nav button` 数量不因本期改动而变化 | R1 |
| 导航与路由不变 | `index.html` 中 `#nav button[data-view]` 数量保持 7；`app.js` 的 `S.view` 取值集合不含新值 | R1 |
| 单文件行数上限 | `rufus.js` 与 `rufus-facts.js` 实际行数（去空行注释）各自 ≤300 | R1 |
| 事实抽取可复现 | 同一文本调 `extractFacts()` 两次，输出深相等（纯函数，无时间/随机） | R2 |
| 材质冲突命中 | title "100% Cotton" + description "100% Polyester" 的 fixture 命中 R2 材质规则，`detail` 同时含 `a` 与 `b` 两个词 | R2 |
| guards 抑制不误报 | "cotton-poly blend" 同时含 `a`、`b` 与 guard 词 `blend` 时不命中 | R2 |
| guards 字段存在 | `MATERIAL_CONFLICTS` 每条含 `guards` 数组（可空，但键必须存在） | R2 |
| guards 大小写不敏感 | guards 命中判定对大小写不敏感（"Blend" 与 "blend" 等效抑制） | R2 |
| guards 命中即整对跳过 | guards 命中时该冲突对不做部分判定，不产生该对的任何命中项 | R2 |
| guards 窗口=字段级（缺陷 H 改判） | guard 抑制只作用于**同一字段内**：某字段的 guard 只压本字段的提及，不跨字段压制。**改判**（原判「命中」、缺陷 H 后改判为**不命中**）：`[{title:"100% Cotton Baby Blanket"},{description:"100% Polyester lining"}]` → **不命中** —— description 的 `lining`（G2 子类 A）压掉本字段的 `polyester`，b 侧无存活提及；title 的 `cotton` 未被压，但**跨字段成对须两侧各非空**，单侧不成对。跨字段检测本身不变，改的是「主体 + 部件」的识别 | R2 |
| guards 逐对不并集（仅子类 C，对齐 A3） | 判某对是否被抑制时，子类 C（材质特定词）**只用该对自带 `guards`、禁止跨对并集**；而子类 A/B（通用部件 / 混纺词）是**全对共用的强制并集**（见 A3），二者不可混谈 | R2 |
| guards 不含通用连接词 | 全部 `MATERIAL_CONFLICTS[].guards` 与 `GUARD_STOPLIST`（`and` `or` `with` `&` `+` `%` `/` `,`）交集为空 | R2 |
| guards 语境词下限 | 每对 `guards` 至少含 1 个材质语境词（长度 ≥3 且 ∉ `GUARD_STOPLIST`） | R2 |
| guard 正例：混纺不报 | `"cotton blend with polyester"` 不命中（由 `blend` 抑制，`with` 不作 guard 也不影响） | R2 |
| guard 反例：连接词不得抑制（跨字段） | `title "Faux Leather"` + `description "Genuine Leather & Real Cowhide"` → **必须命中**（`&` 不得当 guard 压掉 description 的提及；原同字段形态在 G6 下已改判为不报） | R2 |
| trim 保留为材质语境词 | `"leather trim"` 与 `"faux leather"` 并存时不命中（`trim` 仍在 guards） | R2 |
| 材质冲突条数下限 | `MATERIAL_CONFLICTS` 至少 5 组，覆盖棉/涤、真皮/人造革、不锈钢/塑料等 | R2 |
| 数量冲突命中 | title "Pack of 2" + bullets "set of 3" 的 fixture 必须命中 | R2 |
| 事实一致不误报 | 四字段事实一致的 fixture，R2 全部 `status!=="命中"` | R2 |
| 字段缺失即跳过 | 仅 title 有值（其余空）时，所有两字段比较规则 `status==="跳过"` | R2 |
| 大小写空格不误报 | "100% cotton" 与 "100%  COTTON" 判为同值，不命中 | R2 |
| 数值写法容差 | "32 oz" 与 "32oz" 判同值；"32 oz" 与 "33 oz" 判冲突 | R2 |
| R2 全 C 级 | R2 所有命中项 `level==="C"`（从业者口径不许报"发布前必须修改"） | R2 |
| R2 档位为从业口径 | R2 每条规则 `sourceTier==="practitioner"` | R2 |
| 否定词表归规则层 | 源码级：`NEGATION_WORDS` 定义在 `rufus-facts.js`，值域 ⊇ {`not`,`no`,`non`,`never`,`without`,`excluding`,`instead of`,`rather than`,`not made of`}，且与 `GUARD_STOPLIST` 无重复项（`no ` 已从 guards 移出） | R2 |
| 否定生效：同字段前置否定撤提及 | `"not cotton, polyester"`（单字段）不命中（`not` 撤销其窗口内的材质提及，该对两侧无法同时存活） | R2 |
| 否定只向前看 | 字段 1 `"genuine leather, not the cheap kind"` + 字段 2 `"synthetic"` → 命中（后置 `not` 不撤 `genuine leather` 的提及） | R2 |
| 否定不撤前项（方向可观测） | `[{title:"Cotton, not polyester"},{description:"Polyester Fabric"}]` → **必须命中**（2026-10 实测 `["cotton|polyester"]`；title 的 `cotton` 未被撤 —— `not` 在它**后面**；`polyester`@title 被 `not` 撤；`polyester`@description 存活 → a@title、b@description 跨字段成对。若实现误做成「双向撤销」，title 的 `cotton` 也被撤 → a 侧空 → 不命中，该 AC 变红）。**注**：原 description 词 `Filling` 属 G2 子类 A guard → 会把 description 压掉、使本 AC 假红，故改 `Fabric` | R2 |
| 否定不跨字段 | 字段 1 `"not genuine leather"` + 字段 2 `"synthetic"` → 不命中（字段 1 撤、字段 2 无对手）；字段 1 `"genuine leather"` + 字段 2 `"synthetic"` → 命中 | R2 |
| 未定义否定视为未否定 | 未命中 `NEGATION_WORDS` 的任何 token 都不撤提及（引擎不含「未知否定词」兜底分支），保证不被任意词静默压掉 | R2 |
| 已知边界锁C：否定窗口 >2 词 → 误报（已知，非待办） | `[{title:"This is not the real genuine leather"},{description:"synthetic"}]` → **命中**（2026-10 实测 `["genuine leather|synthetic"]`）；`[{title:"not a product made of genuine leather"},{description:"synthetic"}]` → **命中**（实测 `["genuine leather|synthetic"]`）。对照 2 词内：`[{title:"not genuine leather"},{description:"synthetic"}]` → **不命中**（实测 `[]`，正确撤提及）。**本锁是「误报方向」的已知边界**：`not` 距材质词 3 词时不撤 → 残存误报。**与 G6 的「同字段真矛盾 → 漏报」方向相反，须分开陈述**。**为什么不放宽窗口**：放大会让远处子句的否定词误撤**真**冲突的提及（「标题说不含 X、描述说含 X」会被吞掉）；listing 否定基本是短句（`not leather` / `not made of leather` 均在 2 词内）。引 SPEC §8 第 15 条 / AC-15 | R2 |
| 跨字段检测成对 | `title` 含 `genuine leather`、`description` 含 `synthetic`（异字段）→ 该材质对命中；`title` 含 `cotton`、`description` 含 `polyester` 亦命中（显式钉死「检测跨字段」） | R2 |
| 抑制=逐提及（字段级） | `title="cotton blend"` + `bullets=["cotton"]` + `description="polyester"` → **命中**（title 的 guard 只撤 title 的提及，`bullets` 的 `cotton` 未被撤、与 `description` 的 `polyester` 跨字段成对） | R2 |
| 提及归并去自命中（缺陷 G） | `[{title:"Faux Leather Sofa"},{description:"Faux Leather Recliner"}]` → **不命中**（2026-10 实测 `[]`；两侧同材质，裸 `leather` 被 G5 归并）；`[{title:"Faux Leather"},{description:"Genuine Leather"}]` → **命中**（实测 `["leather|faux leather"]`；G5 不归并 `genuine leather` 内的 `leather`，与 `faux leather` 跨字段成对）。原稿 `Lining` / `Frame` 踩 guard → 假绿，已换 guard-clean 词 | R2 |
| 归并同型（Vegan / Suede） | `[{title:"Vegan Leather Bag"},{description:"Vegan Leather Handbag"}]` → **不命中**（2026-10 实测 `[]`）；`[{title:"Faux Suede Shoes"},{description:"Faux Suede Upper"}]` → **不命中**（实测 `[]`）。原稿 `Strap` 属 G2 子类 A guard → 假绿，已换 guard-clean 词 | R2 |
| G6 同字段并列豁免 | 单字段 `"leather outer, faux leather lining"` → **不命中**（原判「命中」改判）；`[{title:"Wool Acrylic Sweater"}]`（单字段 wool+acrylic）→ **不命中** | R2 |
| G6 跨字段真冲突 | `title "Leather Belt"` + `description "Faux Leather"` → **命中**（2026-10 实测 `["leather|faux leather"]`；a/b 分处两字段）。原稿尾词 `Strap` 属 G2 子类 A guard → 假绿，已去掉 | R2 |
| 提及管线顺序写死 | 源码级：提及管线 = 否定撤销(G4) → 逐字段归并(G5) → guard 清字段(G1–G3) → 跨字段配对(G6)，四段顺序不可调换 | R2 |
| 缺陷H 回归锁：陶瓷主体 + 塑料底座 | `[{title:"Ceramic Flower Vase"},{description:"Plastic Base"}]` → **不命中**（`base` 属 G2 子类 A 部件词，压掉 description 的 `plastic` → 单侧不成对） | R2 |
| 缺陷H 回归锁：羊毛外套 + 腈纶内衬 | `[{title:"Wool Winter Coat"},{description:"Soft Acrylic Lining"}]` → **不命中**（`lining` 属子类 A） | R2 |
| 缺陷H 回归锁：不锈钢瓶 + 塑料盖 | `[{title:"Stainless Steel Bottle"},{description:"BPA-Free Plastic Lid"}]` → **不命中**（`lid` 属子类 A） | R2 |
| 缺陷H 回归锁：玻璃罐 + 腈纶盖 | `[{title:"Glass Storage Jar"},{description:"Acrylic Lid"}]` → **不命中**（`lid` 属子类 A） | R2 |
| 缺陷H 回归锁：陶瓷碗 + 塑料盖 | `[{title:"Ceramic Bowl"},{description:"Plastic Lid"}]` → **不命中**（`lid` 属子类 A） | R2 |
| 缺陷H 回归锁：羊毛毯 + 腈纶纱织 | `[{title:"Wool Throw Blanket"},{description:"Acrylic Yarn Weave"}]` → **不命中**（`weave` 属子类 B 混纺/结构词） | R2 |
| 反向锁①（G2 收窄后的新正例）：纯主体双材质跨字段仍报 | `[{title:"100% Cotton"},{description:"100% Polyester"}]` → **命中**（无部件/混纺词，两侧均为「主体声明」；锁死「修 H 不得修成跨字段一律不报」） | R2 |
| 反向锁②：真冲突词对跨字段仍报 | `[{title:"Wool Coat"},{description:"Acrylic Coat"}]` → **命中**（无部件词） | R2 |
| 反向锁③：同源词对跨字段仍报 | `[{title:"Organic Cotton Towel"},{description:"Regular Cotton Towel"}]` → **命中**（`organic cotton`↔`regular cotton` 真冲突对，无部件词） | R2 |
| G2 子类 A/B 逐对一致（缺陷 H 根因锁） | 源码级：全部 15 对 `MATERIAL_CONFLICTS[i].guards` 均含同一份子类 A 部件词 ∪ 子类 B 混纺词（逐对集合相等 = 33 词地板，不出现「这对有 `lining`、那对没有」）；实测 15 对 guard 数＝`37,33,33,33,35,33,33,33,33,33,33,34,33,33,33`；且不含 `top` / `bottom` | R2 |
| 已知边界锁A：合法部件不得报（防「修漏报」过头） | `[{title:"Wool Coat"},{description:"Acrylic lining"}]` → **不命中**（2026-10 实测 `[]`）。**这是合法的**「主体羊毛 / 里料腈纶」，**不得**因「修 SPEC §8 第 12 条漏报」被改成命中 —— 改则误报，比漏报贵 | R2 |
| 已知边界锁B：通用部件词当本体 → 漏报（已知，非待办） | `[{title:"Leather Belt"},{description:"Faux Leather Strap"}]` → **不命中**（实测 `[]`）。**已知漏报边界**：`strap` 在 G2 子类 A 通用部件词池里、被当作「部件说明」，而此处 `strap` 指的就是商品本体。按「误报不可接受」保留，**钉住行为防后人当 bug 顺手修坏另一侧**（SPEC §8 第 12 条 / AC-15） | R2 |
| `alternatives` 已删（营销句不再静默压掉） | `[{title:"Down Jacket"},{description:"Polyester fill, better than alternatives"}]` → **命中**（实测 `["down|polyester"]`）；锁死 `alternatives` 不在任何 `guards` 里（SPEC AC-15 第 3 例） | R2 |
| 单位制并存命中（同组跨字段） | title `"32 fl oz"` + description `"1 liter"`（同属 volume 组，异字段）→ 命中，`detail` 同时含两个单位。**注：R3 段本 5 条（本行 + 同组跨字段双制 / 同制不报 / 跨组不干扰 / 跨组不误报）已实测通过 —— team-lead 代跑，2026-10** | R3 |
| 同组跨字段双制命中 | `"5 lb"`（weight/imperial）与 `"2 kg"`（weight/metric）**分处不同字段** → 命中（同 groupId、跨字段） | R3 |
| 同制不报 | "32 oz" 与 "1.5 lb" 并存（同属 weight 组 imperial）不命中 | R3 |
| 跨组不干扰 | `"32 oz"`（weight）与 `"8 in"`（length）并存不命中；`"5 lb"`（weight）与 `"30 cm"`（length）并存亦不命中（跨组一律不报，impl 实测的误报源） | R3 |
| 跨组不误报（不同属性） | `"Net Weight 2 lb"` + `"Capacity 1 liter"`（cross-group：weight×volume，语义上是两个不同属性）→ **不命中**（否掉 weight↔volume 桥） | R3 |
| 单位组结构完整 | 每个 `UNIT_GROUPS[i]` 含 `id/label/imperial/metric/units/source` 六字段 | R3 |
| 单位集互斥且自洽 | 每个 `UNIT_GROUPS[i]` 满足 `imperial ∩ metric === ∅` 且 `units ⊇ imperial ∪ metric` | R3 |
| 单位碰撞反例不判定 | `"5 in stock"` / `"meets 4 g signal"` / `"wait 2 w then retry"` / `"Ready in 12 mm"` 均不产生参与判定的单位事实 | R3 |
| 短单位白名单生效 | `oz`/`lb`/`kg` 参与判定（白名单短单位进桶）；长度 ≤2 的其它单位（in/g/w/mm/ml/cm/ft…）不参与判定 | R3 |
| `°` 归一化后归组 | 先剥前导 `°` 再查表：`"72 °F"` → temperature 组 `f`、`"22 °C"` → temperature 组 `c`，二者并存命中温度单位制冲突 | R3 |
| `°` 不受歧义表约束 | `°c` / `°f` 不落入 `UNIT_AMBIGUOUS`（带度数符号即无词义碰撞）；数据侧 `temperature.units` 不含 `°` 字面量仍能命中（归一化在消费侧，不重复实现） | R3 |
| 无量纲数字不报 | "serves 2" 这类无单位数字不命中 | R3 |
| 换算同制不算冲突 | "1 L" 与 "1000 ml"（同属 volume 组 metric）不命中 | R3 |
| R3 比对窗口=严格同组 | R3 只在**同一 `UNIT_GROUPS` 组**内比对英制×公制；跨组一律不报（含 weight×length 与 weight×volume） | R3 |
| 同字段并列双制不报 | `"5 lb (2.3 kg)"`（同字段内 imperial+metric）不命中（正常双单位披露）；仅**跨字段**分别两套制才报 | R3 |
| R3 全 C 级且标从业口径 | R3 命中项 `level==="C"` 且 `sourceTier==="practitioner"` | R3 |
| 问题矩阵条数区间 | `CATEGORY_QUESTIONS` 每个 productType 的问题条数 ∈ [8,12] | R4 |
| 问题带出处与说明 | 每条问题含 `id/question/why/source`，且 `source==="practitioner"` | R4 |
| 问题有覆盖判据 | 每条问题含 `answerHints` 数组且长度 ≥1 | R4 |
| 非 key hint 只作线索 | 非 key hint 不产生"命中"、不报错、不依赖任何外部白名单（无第三份词表） | R4 |
| 无判据题跳过 | 该问题 key 类 hint 为空时 `status==="跳过"`，绝不产生"命中" | R4 |
| 单 hint 未覆盖即命中 | 该问题 key 类 hint 恰 1 个且未被覆盖 → `status==="命中"`，`detail` 含问题原文 | R4 |
| 多 hint 全未覆盖才命中 | 该问题 key 类 hint ≥2 个时，仅当**全部**未覆盖才 `命中`；任一被覆盖即非 `命中`（OR，禁止 AND） | R4 |
| 守卫 A：部分覆盖显式化 | key 类 hint ≥2 且部分覆盖时 `status==="通过（部分）"`（与全通过**不同形**），`detail` 逐个列出未覆盖 key | R4 |
| 守卫 A 具体例 | `"requires 2 AA"` 覆盖 `batteries_required` 未覆盖 `batteries_included` 时，结果含 `batteries_included` 线索串且 `status!=="通过"` | R4 |
| 守卫 B：key hint 数上限 | 每题 key 类 hint 数 ≤ 3（实测当前最大 = 3） | R4 |
| 守卫 B：>3 判为数据不合法 | 任一问题 key 类 hint 数 ≥4 → 该断言失败并提示"该题装了两个问题，应拆题" | R4 |
| 覆盖率自洽 | `summary.byGroup[g]` 满足 `hit + pass + partial + skipped === total`（恒等）；R4 另满足 `covered + miss === total - skipped`（`covered = pass + partial`，`miss = hit`） | R4 |
| 未选品类全跳过 | 无 `ctx.productType` 时 R4 全 `status==="跳过"` | R4 |
| 跨品类不串味 | 选 A 品类时，B 品类独有问题的 id 不出现在 results 里 | R4 |
| R5 不解析图像 | 源码级：`rufus.js` / `rufus-facts.js` 不 import 图像 / OCR 模块、不读文件、无 `node:` import | R5 |
| 图内文字比对 | `ctx.imageText` 含 "SIZE: M/L/XL" 且文本字段无对应内容时命中，`detail` 点名该文字 | R5 |
| 无图内文字全跳过 | 未提供 `ctx.imageText` 时 R5 全 `status==="跳过"`（不猜、不报） | R5 |
| 已文本化即通过 | 图内文字在 bullets 里也出现时，不命中 | R5 |
| R5 全 C 级 | R5 所有规则与命中项 `level==="C"`（v2 定为提示型） | R5 |
| 尺码表特例 | 图内 "SIZE: S/M/L" 且五点无尺码则命中；五点含 "Sizes S-L available" 则通过 | R5 |
