# Spec — P0-1「Rufus / Alexa 信息架构检查」v1.0

> 生成日期：2026-10-01
> 依据：v2 修订方案 §4「P0-1」+ ADR-001（`docs/decisions/ADR-001-rufus-module.md`）+ 数据层 `assets/rufus-data.js`
> 状态：**已锁定**（team-lead 签发）
> 本 Spec 是团队内部契约。后续实现、测试均以本文件 + ADR-001 为唯一依据。冲突时：**本 Spec > ADR > 其他**。

---

## 1. 一句话定义

给工作台加一层**「准入层」检查**：Rufus / Alexa for Shopping 是**先做结构化比对、再决定要不要引用你的文案**。现有 28 条规则检查的是「引用层」（文案好不好、合不合规），本模块检查「**能不能被纳入对比**」——字段有没有空、事实有没有自相矛盾、同一事实有没有两种单位、买家高频问题有没有答案、图里的字有没有文本化。

---

## 2. MVP 范围（锁定）

| 组 | 名称 | 判据 | 数据依赖 |
|---|---|---|---|
| `R1` | attributes 完整性 | 该填的字段空着 → 点名 | `CATEGORY_ATTRIBUTES` |
| `R2` | 跨字段事实一致性 | title / bullets / Highlights / description 之间同一事实不许冲突。**两侧表述必须分处不同字段**才判冲突；同字段并列视为复合商品/成分披露（`"Wool Acrylic Sweater"` / `"60% Cotton 40% Polyester"`）→ 不报 | `MATERIAL_CONFLICTS` + 自建事实三元组抽取 |
| `R3` | 单位制一致性 | **同一 `UNIT_GROUPS` 组内**只允许一个单位制（同组内 "12 inches" 与 "30 cm" 并存即报；**跨组不报** —— "5 lb" + "20 cm" 是不同维度，跨组并存不能证明是同一事实，报它就是猜） | `UNIT_GROUPS` + `NUMBER_UNIT_RE` |
| `R4` | 买家问题覆盖矩阵 | 按品类的高频问题，逐条查有没有对应的答案句 | `CATEGORY_QUESTIONS` |
| `R5` | 图内文字未文本化 | A+ 图 / 信息图里的规格、兼容性、成分、尺码表须在文本字段里也出现 | `ctx.imageText`（人工粘贴，**不做 OCR**） |

**新增文件（3 个，全部新建，不改任何已有文件的结构）**

| 文件 | 归属 | 职责 | 行数预算 |
|---|---|---|---|
| `assets/rufus.js` | 实现者 | `RUFUS_GROUPS` / `RUFUS_RULES` / `lintRufus(listing, ctx)` | ≤ 300 |
| `assets/rufus-facts.js` | 实现者 | 纯函数：`extractFacts()` / `unitSystemOf()` / `sameFact()`，无 I/O、无 `node:` import | ≤ 300 |
| `assets/rufus-data.js` | 已产出（PM） | 纯数据，零 import、零函数 | 不计 |

---

## 3. 明确不做（Out-of-Scope — 锁定）

| 不做 | 原因 | 何时考虑 |
|---|---|---|
| **自动填属性值** | 属性值有**闭集约束**（官方错误码 90057：值必须来自下拉清单）。生成式填值是高危动作 | 不做 |
| **OCR / 图像解析** | R5 只吃 `ctx.imageText`（人工粘贴）。解析图需要模型或重型依赖 | 不做 |
| **解析官方 Bulk 模板 Excel（路 B）** | ADR D5：`assets/zip.js` 实测**只有打包能力、没有解压**，且 `import node:zlib` 是 Node 专属、浏览器不能 import → 双端一致的 deflate 路径不存在 | 三个前置同时满足时：① 双端 deflate-raw 解压路径 ② 模板 90 天版本闸门 ③ ≥1 份真实类目模板 fixture |
| **新增第 8 个视图** | ADR D4：输入与「文案与质检」同源，新增视图＝复制输入，违反"同一事实只有一处实现" | 仅当做 P2-1 批量 ASIN 对比时才升格 |
| **回填现有 28 条规则的 `sourceTier`** | ADR D3：会动 289 条源码级断言引用的文件，回归面不可控；且 28 条的口径已写在 `source` 文本里，无信息损失 | 不做 |
| **SP-API 写回（G-27）** | 属 P1，本期不动 | P1 |
| 引入任何 npm 包 / 图标库 / 框架 | 零依赖是项目硬约束 | 不做 |

---

## 4. 契约（锁定）

### 4.1 数据层（`assets/rufus-data.js`，已产出，**不再改契约**）

```js
export const CATEGORY_ATTRIBUTES = {
  home_kitchen: { label, required: [{key,label,source}], recommended: [{key,label,source}] },
  // 8 类：home_kitchen / apparel / electronics / pet_supplies / beauty / sports_outdoors / baby / office
};
export const CATEGORY_QUESTIONS = {
  home_kitchen: [{ id, question, answerHints: [...], why, source }],   // 每类 10 条
};
export const UNIT_GROUPS        = [{ id, label, imperial, metric, units, source }];  // 6 组
export const MATERIAL_CONFLICTS = [{ a, b, guards, source }];                        // 15 对
export const NUMBER_UNIT_RE     = { regex, pattern, flags, unit, note, source };     // 描述对象
```

### 4.2 口径分级：**契约两档、证据三级**

- **数据层 `source` 有三级**（来源强度）：
  - `amazon-guide` — 官方帮助文档**正文**明确举例/定义
  - `amazon-schema` — 亚马逊一方的**结构性产物**：Flat File 模板列名 / SP-API schema 字段名 / 后台表单字段名
  - `practitioner` — 无官方明文，行业通行
- **规则层 `sourceTier` 只有两档**：`official` | `practitioner`
- 🔴 **`tierOf(source)` 是唯一映射点**，只允许在 `rufus.js` 里出现一处：
  `amazon-guide`→`official`、`amazon-schema`→`official`、`practitioner`→`practitioner`。
  **传入未知值必须抛异常**，不许静默归为 official（这是"界面不说假话"的底线）。
- 🔴 **UI 展示规则（team-lead 裁定，ADR D3 维持不变）**：
  - **分栏/计数按两档**（`official` / `practitioner`）—— 用户不需要理解 guide 与 schema 的区别
  - **单条规则的明细里必须写出证据档的实际值**（如"依据：官方帮助文档" / "依据：官方模板字段名" / "依据：行业通行"）—— 需要追究时查得到
  - 🔴 **证据引用串必须随档不同，不许共用笼统的"官方文档"字样**（此条由数据层作者提出，team-lead 采纳并升格为硬约束）：
    - `amazon-guide` → 引「帮助文档正文」，并给出文档标识（如《Attributes guide》）
    - `amazon-schema` → 引「Flat File 模板列名 / SP-API schema 字段名 / 后台表单字段名」，**不得写成"官方文档"或"官方规则"**
    - `practitioner` → 写「行业通行，无官方明文」
    - 理由：把「模板列名」说成「官方正文」是**失真**，会摧毁本项目"每条规则可追溯出处"这条唯一的差异化。
  - 综上：**分栏是为了可用，明细是为了可追责。两件事都要，但不能混在同一层，也不能让明细串失真。**

### 4.3 规则层（`assets/rufus.js`）

```js
export const RUFUS_GROUPS = [{ id:"R1".."R5", name }];
export const RUFUS_RULES  = [{ id, group, level, scope, test(listing, ctx) -> {hit, detail}, why, source, sourceTier }];
export function lintRufus(listing = {}, ctx = {}) -> { results, summary }
```

- `id` = `R<组号>-<两位序号>`（`R1-01`…），全表唯一，组内从 `01` 连续
- `scope` ∈ `attributes | facts | units | coverage | imageText`，**仅作展示分组**；引擎始终把**整个 `listing` 对象**传进 `test(listing, ctx)`
- `results[i]` = `{ id, group, level, scope, status, detail, why, source, sourceTier }`，`status ∈ {命中, 通过, 跳过}`
- `summary` = `{ total, hit, hitP, hitC, skipped, byGroup, conclusion }` —— **`byGroup` 必须按 R1–R5 分组计数**（team-lead 采纳架构师建议：R 组默认全 C，靠分组计数让"R 组有 12 条提示"这件事可见，而不是混进总命中数里）
- `ctx` = `{ productType, imageText, category, brand }`

### 4.4 `level` 判定规则（锁定，不许自由裁量）

- R 组**出厂默认 C 级**
- **只有同时满足两条才可判 P**：① 属 `R1` ② 守卫的字段落在该品类的 `required` 数组 **且** 该属性的 `sourceTier === "official"`
- **R2 / R3 / R4 / R5 一律 C 级**。理由：v2 §0 已核验 —— 跨字段一致性 / OCR / 问题矩阵**都是从业者口径**，没有官方明文。报"发布前必须修改"就是**说谎**。

---

## 5. 🔴 三条实现红线（来自数据层作者的实测提醒，违反会造成误报）

1. **材质冲突必须先判 `guards`，命中即跳过整对。**
   `MATERIAL_CONFLICTS` 每对都带 `guards`（混纺/复合保护词）。若不先判，`"cotton blend with polyester"`（混纺）会被误判成 cotton vs polyester 冲突 —— **这正是"反向测试一条都不报"的关键点**。

2. **单字母单位优先不匹配。**
   `m` / `l` / `w` / `v` 在 `i` 标志下天然歧义（`"12 m"` 可能是分钟）。规则：**先匹配多字母单位**（`mm` / `cm` / `kg` / `lb` / `fl oz` / `mL` …），单字母单位**只在"数字 + 空格 + 单字母"的明确上下文**里才使用，且不与时间/型号等其它同形词混判。

3. **`answerHints` 的语义必须区分对待（待 QA 审计结论确认后落地）。**
   它可能**是**该产品类型下存在的字段 key，也可能是**语义标签**（如 `dimensions` / `compatibility`）。
   - 精确命中的 hint → 强证据，可用于"该问题已覆盖"的判定
   - 语义标签型 hint → 弱证据，**只能作线索，不得单独据此判"未覆盖"**
   - 🔴 QA 正在做交叉比对审计（`assets/rufus-data.js` 审计项 2）。**结论出来前，R4 不允许定稿**；R1 / R2 / R3 / R5 不受影响，可先行实现。

---

## 6. 交付顺序（为什么这样排）

| 序 | 内容 | 依赖 | 可否现在开始 |
|---|---|---|---|
| 1 | `rufus-facts.js`（事实抽取 / 单位归一 / 同事实判定） | 无 | ✅ 可 |
| 2 | `rufus.js` 的 R1 / R2 / R3 / R5 四组规则 + 引擎装配 | 序 1 | ✅ 可 |
| 3 | R4（问题覆盖矩阵） | QA 审计项 2 的结论 | ⏳ 等 |
| 4 | UI 接入（「文案与质检」视图第 ⑥ 卡） | 图标合规化完成（同一批文件 `index.html` / `app.js`） | ⏳ 等 |
| 5 | ≥59 条断言进 `tools/selftest.mjs` 第 23 节 | 序 2–4 | ⏳ 等 |

---

## 7. 验收标准（锁定 — QA 以此为唯一依据）

| 编号 | EARS 格式验收标准 |
|---|---|
| AC-01 | `lintRufus` 的返回结构与 `lintListing` **严格同构**（字段名、`status` 取值域、`summary` 键），使得前端可以复用同一套渲染 |
| AC-02 | While 提供了 `ctx.productType` 且该品类的 `required` 字段为空，系统**必须**产生一条 `R1` 命中且 `detail` 含该字段中文 `label` |
| AC-03 | While 未提供 `ctx.productType`，系统**必须**让 R1 与 R4 全部 `status === "跳过"`，且 `detail` 说明原因，**不抛异常、不在空表上乱叫** |
| AC-04 | While 一张表**一个字都没填**，系统**必须**一条都不报（沿用 `listing.js` 的 `hasContent` 口径）。🔴 **且 `summary.conclusion` 不得为「全部通过」** —— 一条规则都没跑过却说"全部通过"是**界面上说假话**，必须落到「无可检查项」一类措辞（缺陷 K，v1.0.6 补） |
| AC-05 | If `tierOf()` 收到未知 `source` 值，系统**必须**抛异常，**禁止**静默归为 `official` |
| AC-06 | If 规则命中项 `level === "P"`，则它**必须**属 `R1` 且守卫属性同时满足 `sourceTier === "official"` 且在 `required` 数组内 |
| AC-07 | 反向测试：属性齐全 + 单位一致 + 事实一致 + 问题全覆盖 + 图文字已文本化的 fixture，`summary.hit === 0` |
| AC-08 | 三套自检全绿，且**断言总数 ≥ 510**（当前 469 + 新增 ≥41） |
| AC-09 | `rufus.js` / `rufus-facts.js` 均不含 `node:` 前缀 import，可在浏览器与 Node 双端同跑 |
| AC-10 | 源码级：`rufus.js` 的规则代码里**不出现属性 key / 单位字符串字面量**（全部经 `rufus-data.js` 导入） |
| AC-11 | 源码级：`assets/listing.js` 的 `RULES` 长度仍为 28，且全部 `sourceTier === undefined`（现有 28 条不回填） |
| AC-12 | `index.html` 的 `#nav button[data-view]` 数量保持 7（不新增视图） |
| AC-13 | `rufus.js` 与 `rufus-facts.js` 的**代码行**（去空行 + 去纯注释行）各 ≤ 300，且**原始行数**各 ≤ 400（防注释灌水绕过）。超出则按**子功能**拆文件，不是拆函数凑数。🔴 **必须落成断言**（口径不写清＝不可判定＝等于没有，v1.0.4 修正）。**贴近上限时的处置顺序**：① 先压注释密度（与 SPEC 已重复的说明删掉，SPEC 是单一事实源）→ ② 仍不行才按子功能拆文件。🔴 **不许上调上限**（上限本身就是防灌水的机制，逼近它是"该控注释密度"的信号，不是口径问题） |
| AC-14 | 全部新增产出中**无 emoji 功能图标**、无 emoji 数据标记 |
| AC-15 | §8 第 12、13 条的「已知漏报边界」**必须落成断言**（断言里写明是**已知边界**，不是期望行为之外的意外），钉住两侧：`title "Leather Belt"` + `description "Faux Leather Strap"` → 不命中（已知漏报，附理由注释）；`title "Wool Coat"` + `description "Acrylic lining"` → 不命中（合法部件，**不得**因"修漏报"被改成命中）；`title "Down Jacket"` + `description "Polyester fill, better than alternatives"` → **命中**（锁 `alternatives` 已删）。**另含 §8 第 14、15 条**：R5 连字符归一 8 条（3 转不报 + 3 反向锁 + 2 必须仍报）；G4 窗口 **误报**方向 2 条（`not genuine leather`×`synthetic` → 不命中；`This is not the real genuine leather`×`synthetic` → **命中**，标注为已知误报边界） |

---

## 8. 已知边界（诚实标注，写进 UI 提示与文档）

1. **属性表只覆盖 8 个产品类型**（automotive / toys / grocery 等未覆盖）。结构支持增量追加，未覆盖品类下 R1 应**跳过并说明"无该产品类型的属性表"**，不许假装通过。
2. **属性表是手工整理的，不是官方完整清单。** 官方模板才是权威；本表的作用是"提醒你有哪些字段容易漏"，不是"官方字段全集"。
3. **R2 的单位制/材质冲突词表必然不完备**，且 `MATERIAL_CONFLICTS` 的 guards 是启发式 —— **可能漏报，也可能误报**。全部标 C 级是刻意的。
4. **R4 无官方问题清单**，问题与判据均来自从业者口径归纳，必然含噪声。它**只作线索，不作待办**。
5. **R5 不做 OCR** —— 它只能检查"你**告诉我们**图上有什么字，而文本字段里没有"。不粘贴 `imageText` 就全跳过，不猜。
6. **R 组默认全 C 级，不等于"不重要"**，而是"证据强度不足以报必须改"。这正是本项目与"AI 说啥就是啥"的分野。
7. **R3 只认英文单位。** `NUMBER_UNIT_RE` 的 `UNIT_ALT` 是纯 ASCII 交替表，**不含任何中文单位**（毫升 / 升 / 安士 / 英寸 …）。理由：本工作台服务的是英文 listing，粘贴进来的中文内容本身就是要修的缺陷；而把中文并入同一个正则需把字符类扩到 CJK，属扩大面。**代价＝中文单位一律不参与判定（漏报）**，按"宁可漏报、不可误报"取舍。ADR 附表原有的「中文单位走同一表」断言**作废**。
8. **R3 的"同一维度组"是硬口径，不是保守估计。** `oz`（weight）与 `liter`（volume）分属两组，**不判冲突** —— SPEC v1.0 曾以 `"32 oz"` 与 `"1 liter"` 举例，该例**作废**（把不同维度的两种单位当成"同一事实的两种写法"是猜）。可用范例改为同属 volume 组的 `"32 fl oz"` × `"1 liter"`。
9. **R3 不做数值换算。** 判定只问"同组内两套单位制是否并存"，不问两处数值是否真的等价 —— 因此 `"10 inches"` + `"25.4 cm"`（数值其实一致）**也会被报**。要根治需在数据层加一张换算表（属类目知识，且无官方明文），**本期不做**，登记为已知边界。
10. **同字段并列豁免（R2 与 R3 共用的一条通则）。** 同一字段内同时出现"另一侧"的两处表述 —— 材质侧如 `"Wool Acrylic Sweater"` / `"60% Cotton 40% Polyester"` / `"Ceramic and Plastic Bowl"`，单位侧如 `"5 lb (2.3 kg)"` —— 视为**同一处的并列声明**（复合商品 / 成分配比 / 双单位披露），**不报**。只有分处不同字段才构成"跨字段不一致"。理由：跨字段才是本组规则的**本体**（"标题说 A、描述说 B"）；同字段并列通常是卖家在**主动说明**构成，报它属误报。诚实边界：同字段内的真矛盾（如 `"100% Cotton 100% Polyester"`）会被漏报，按"宁可漏报"取舍。
11. **同一材质两侧都写 ≠ 冲突（提及归并，必须逐字段先做）。** 同一段文本**只归属一个术语**：若某字段内 `a` 的某个提及与 `b` 的某个提及**区间相交**，则**被包含的较短那个不计**（同一段文本只算一个声明，取更具体的术语）。归并完成后再做跨字段配对。否则 `"Faux Leather Sofa"` 里那个裸的 `leather` 会与另一字段的 `"Faux Leather"` 配成假冲突 —— 实测 `title "Faux Leather Sofa"` + `description "Faux Leather Lining"` 会被误报（两侧说的是**同一个材质**）。反例必须同时成立：`title "Faux Leather"` + `description "Genuine Leather"` → 命中。
12. **guard 是「字段级二值」，且这是刻意的精度取舍 —— 由此产生一批已知漏报。** 现行机制：某字段内出现该对的**任一** guard 词 → 该字段对该对的**全部**提及作废（不跨字段救场）。后果实测：`strap` / `cover` / `shell` / `sole` / `legs` / `collar` 这类词**在很多品类里就是商品本体而非部件**，一旦出现在描述字段就会把该字段的材质提及整片压掉 —— 例如 `title "Leather Belt"` + `description "Faux Leather Strap"` **漏报**（实测 `[]`），同批 `cover`/`shell`/`sole`/`legs`/`collar` 五个词同样漏报，而去掉这类词的 `title "Wool Coat"` + `description "Acrylic Fabric"` **命中**。
    - **不改的理由**：若把 guard 收窄成"仅当同字段同时出现两种材质时才抑制"，则 `title "Wool Coat"` + `description "Acrylic lining"`（真实、常见、**合法**的"主体羊毛 / 里料腈纶"）会变成**误报** —— 而误报比漏报更贵。故按「误报不可接受、漏报可接受」保留现状，**登记为已知漏报边界**，且**必须写成断言**（钉住行为，防后人当成 bug 顺手"修"坏另一侧）。
    - **连带作废**：ADR 原用的两处范例 `... "Faux Leather Strap"` 与 `... "Genuine Leather Frame"` 均踩通用词池，**范例作废**。可用的 G6 跨字段范例改为 `title "Leather Belt"` + `description "Faux Leather"`（实测命中，且不踩任何 guard 词）。
13. **guard 词池是「三层结构」，逐对特有层不得收通用英文营销词。** 池 = ①通用部件词 24 个 ＋ ②通用混纺词 9 个（**15 对共用**，共 33）＋ ③该对材质特有话术（逐对，如 `cotton|polyester` 的 `poly-cotton`、`down|polyester` 的 `synthetic down`、`aluminum|carbon steel` 的 `alloy`）。
    - 🔴 ③ **只能放"离开本对就无意义"的复合词**。`alternatives` 是反面教材：它会被通用营销句命中 —— 实测 `title "Down Jacket"` + `description "Polyester fill, better than alternatives"` 被静默压成 `[]`（漏报），而同字段只写 `Polyester fill` 则**命中**。故 **`alternatives` 已删除**；`down alternative` 与 `synthetic down` 两个**复合形式保留**（它们才是"down 替代填充"的真实术语）。
    - 推论（写给后人）：新增 guard 前先问"这个词脱离本对还成立吗"；成立就不许放进 ③。
14. **R5 的匹配必须做连字符归一 —— 已修（缺陷 L，v1.0.7）。** 苹果商图片上的字**最常见就是全大写 + 连字符**（`BPA-FREE` / `SPILL-PROOF` / `EASY-CARE`），而卖家在文本字段里通常写成空格分隔（`BPA free`）。原实现把 `"SPILL-PROOF"` 切成**一个含连字符的 token**，再要求文本字段出现**同样带连字符**的形式 → 判「未文本化」。这是**误报**：规则本意是"图上有的字、文本字段里没有"，**不是"标点必须一致"**。
    - **修法**：比较两侧前都过一遍 `norm()` —— 把 `.` `-` `_` `/` 换空格、折叠空白、转小写（**两侧对称**，不是只归一其中一侧）。
    - **实测（team-lead 现场）**：`BPA-FREE`×`BPA free plastic lid`、`SPILL-PROOF`×`stain resistant spill proof coating`、`EASY-CARE`×`Easy care fabric` 三条由**报**转**不报**；`SPILL-PROOF`×`spill-proof coating`、`MACHINE WASHABLE`×`machine washable`、`3.5 INCH`×`3.5 inch diameter` 保持不报；`LIFETIME-WARRANTY`×`durable construction`（真未文本化）与 `BPA-FREE`×`free of BPA`（**语序不同**）**仍照报**。
    - 🔴 **不做**：词序归一、同义词/词形归一。那两件属"未逐字文本化"，**保守报出**（R5 是提示型规则，报出来只是线索）。此项**必须落成断言**（报→不报 3 条 + 保持不报 3 条 + 仍报 2 条）。
15. **G4 否定窗口固定 2 词 —— 更远的否定词不撤提及，这是**误报**方向（已知边界，v1.0.8）。** `NEGATION_WORDS` 只撤销其**后面 ≤2 个 token** 内的提及。实测：`title "not genuine leather"` + `description "synthetic"` → 不报（撤了，正确）；但 `title "This is not the real genuine leather"` + `description "synthetic"` → **报**（`not` 距 `genuine leather` 有 3 词，不撤）—— 卖家语义是"这不是真皮"，此时报冲突属**误报**。
    - **为什么不放宽窗口**：窗口放大后，远处子句的否定词会误撤**真**冲突的提及（"标题说不含 X、描述说含 X"这类真不一致会被吞掉）；且 listing 文案里的否定基本都是短句（`not leather` / `not made of leather` 都落在 2 词内）。按现状保留，**登记为已知边界**。
    - 🔴 **与 §8 第 10 条不要混写**：#10 是**漏报**方向（同字段真矛盾不报），本条是**误报**方向（远处否定不撤）。两者都以"少猜"为取舍，但**方向相反**，文档与断言里必须分开写。

---

## 9. 变更记录

| 日期 | 变更 | 原因 | 影响 |
|---|---|---|---|
| 2026-10-01 | v1.0 锁定 | P0-1 开工，PM 数据层与架构师 ADR 均已交付 | 实现与测试以此为唯一依据 |
| 2026-10-01 | v1.0.1 | 收窄 R3 口径为「同组内」、作废 `32 oz`/`1 liter` 范例、登记中文单位不支持（§2 / §8 第 7、8 条） | team-lead 实测：跨组并存（`5 lb` + `20 cm`）会被误报，违「误报不可接受」；中文单位并入正则需扩 CJK 字符类，属扩大面 |
| 2026-10-01 | v1.0.2 | 新增**同字段并列豁免**通则（§2 R2 行 / §8 第 10 条）；登记 R3 不做数值换算（§8 第 9 条） | team-lead 对抗性扫描：6 例合法复合表述（`"Wool Acrylic Sweater"` / `"60% Cotton 40% Polyester"` / `"Ceramic and Plastic Bowl"` / `"Glass Vase with Acrylic Base"` / `"Genuine Leather with Synthetic Lining"` / `"Silicone and Latex Free Gloves"`）全被误报；对照的跨字段 5 例全部正确命中 → 命中条件应为「分处不同字段」 |
| 2026-10-01 | v1.0.3 | 新增 §8 第 11 条「同一材质两侧都写 ≠ 冲突（提及归并，必须先逐字段做）」 | team-lead 实测：`title "Faux Leather Sofa"` + `description "Faux Leather Lining"` 被判冲突 —— 两侧说的是**同一个材质**。根因：G5 的"不重叠"只做在同字段内，跨字段时 `faux leather` 内部的裸 `leather` 被当成独立声明。对照 `title "Faux Leather"` + `description "Genuine Leather"` 须命中 |
| 2026-10-01 | v1.0.4 | AC-13 补「行数」口径（代码行 ≤300 且原始行数 ≤400）并注明必须落成断言 | team-lead 核验发现：AC-13 **全项目零断言**，且"行数"未定义口径（实测 `rufus.js` 原始 338 / 非空 320 / 代码 286；`rufus-facts.js` 原始 356 / 非空 321 / 代码 233）。属**规格模糊＝不可判定**，非放宽标准：同时加原始行数上限防注释灌水绕过 |
| 2026-10-01 | v1.0.5 | ① 裁定 F3/F4 冲突为**测试输入语义过期**（方案 a）；② 新增 §8 第 12 条 guard 字段级二值 → **已知漏报边界**，并作废 ADR 两处踩词池范例；③ 新增 §8 第 13 条 guard 三层结构 + 删 `alternatives`；④ 新增 AC-15 钉双侧行为 | team-lead 现场实测（真 `import` 生产模块）：F3/F4 单字段输入按 G6 **必然** `[]`，非实现缺陷；另抓到新漏报 `title "Leather Belt"` + `description "Faux Leather Strap"` → `[]`（根因 `strap` 在通用词池）、`title "Down Jacket"` + `description "Polyester fill, better than alternatives"` → `[]`（根因裸 `alternatives`）。词池实测 33 共有 ＋ 逐对特有话术（pair0 +4 / pair4 +3 / pair11 +1） |
| 2026-10-01 | v1.0.6 | 补 AC-04：空表时 `summary.conclusion` **不得**为「全部通过」（缺陷 K） | team-lead 探 `lintRufus` 输出契约时实测：空 listing + 给了 `productType` → `{total:16, hit:0, skipped:16, conclusion:"全部通过"}`；不给 `productType` → `{skipped:5, pass:2, conclusion:"全部通过"}`。前者**一条规则都没跑**却报"全部通过"，直接进 UI 就是界面说假话。原 AC-04 只约束"不报"，未约束**结论文案**，属规格漏项 |
| 2026-10-01 | v1.0.7 | 新增 §8 第 14 条：R5 匹配须做**连字符归一**（缺陷 L）；AC-15 口径扩到含此项 | 实现席位回报 `SPILL-PROOF` × `spill proof` 仍报，team-lead 顺着**读源码 + 现场实测 8 组**确认根因：`uncoveredImageText` 把 `"SPILL-PROOF"` 切成单个含连字符 token，故要求文本侧也带连字符。苹果商图最常见就是全大写+连字符 → 这是**最常见输入形态上的系统误报**。实测 8 组：3 条由报转不报、3 条保持不报、2 条仍报（真未文本化 / 语序不同） |
| 2026-10-01 | v1.0.8 | ① 新增 §8 第 15 条：G4 否定窗口固定 2 词 → **误报**方向已知边界（与 §8 #10 的**漏报**方向分开写）；② AC-15 扩到含 §8 第 14、15 条；③ AC-13 补「贴近上限的处置顺序（先压注释密度，后拆文件，不许上调上限）」 | 架构师申报 `L165→L172`「G4 窗口>2 词漏撤」为有意边界但未登记，team-lead 现场实测确认：`title "This is not the real genuine leather"` + `description "synthetic"` → **命中**（`not` 距材质词 3 词，不撤），语义上属误报。另：`rufus-facts.js` 原始行 394/400 逼近上限，QA 提议放宽 → 驳回，改在 AC-13 写死处置顺序 |
