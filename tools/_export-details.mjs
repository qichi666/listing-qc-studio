/**
 * 临时采集脚本：把关键常量 dump 成 markdown 片段，供「功能细节说明」文档使用。
 * 目的：文档里的参数一律从代码导出，不手抄（手抄必错）。
 * 只读，不写任何数据。用完即删。
 *
 * 注意：全文用双引号普通字符串拼接，不用模板字符串 ——
 * 因为要输出 markdown 的行内 code（反引号），模板字符串里嵌反引号会截断字符串（踩过）。
 */
import * as P from "../assets/prompt-engine.js";
import * as L from "../assets/listing.js";
import * as A from "../assets/amazon.js";
import * as Api from "../assets/api.js";
import * as STORE from "../assets/store.js";
import { TEMPLATES, TEMPLATE_LIST } from "../assets/templates.js";
import * as RD from "../assets/rufus-data.js";
import * as RF from "../assets/rufus-facts.js";
import * as RU from "../assets/rufus.js";
import * as CK from "../assets/competitor-keywords.js";
import * as BS from "../assets/bestsellers.js";
import * as CP from "../assets/copy-prompts.js";

const out = [];
const w = (s = "") => out.push(s);
const BT = String.fromCharCode(96);                 // 反引号
const C = (s) => BT + s + BT;                       // markdown 行内 code

/* ── 竞品实时抓取（2026-10-02 整合） ──
 * ⚠️ 这三节是**新的首节**。新增首节时必须同步更新 `_sync-details-doc.mjs`
 *    的 START_CANDIDATES，否则同步会静默跳过（见该文件注释）。 */
w("### 竞品实时抓取 · 站点与出网白名单（`SITES` / `AMAZON_HOSTS`）");
w("");
w("> 🔴 这是全项目**唯一**会主动爬第三方站点的通道。任何传入的 " + C("href") + " 都要同时过三关：");
w("> ① 主机在**硬编码的 8 个** amazon 域内；② 协议必须是 https；③ 路径必须是 " + C("/gp/bestsellers/") + " 或 " + C("/zgbs/") + "。");
w("> 之后还要过 " + C("assertPublicUrl") + "（DNS 解析后判内网 IP，防 rebinding），**重定向之后再判一遍白名单**。");
w("> 原工具（" + C("tool/server.js") + "）任何传入 href 都会去抓、且没有 SSRF 层 —— 这三处是本项目**有意加强**，不是照抄。");
w("");
w("| 站点代码 | 主机 | 名称 |");
w("|---|---|---|");
for (const [code, s] of Object.entries(BS.SITES)) {
  w("| " + C(code) + " | " + C(s.host) + " | " + s.label + " |");
}
w("");
w("- 默认站点 " + C("DEFAULT_SITE = " + JSON.stringify(BS.DEFAULT_SITE)) + " —— **服务端与前端下拉共用这一个常量**（服务端不再写第二份字面量）。");
w("- 类目 slug 白名单 " + C("CAT_SLUGS") + " 共 " + BS.CAT_SLUGS.length + " 个；不在名单里的 slug 一律 400，不拼进路径。");
w("- 缓存：" + C("cacheStats().ttlMs = " + BS.cacheStats().ttlMs) + " ms（10 分钟）；" + C("size") + " = 当前缓存条目数。");
w("- 单页解析出的字段：" + ["rank", "asin", "title", "rating", "reviews", "price"].map(C).join(" / ") + "。");
w("- 出网请求头**必须**带 " + C("Cookie: i18n-prefs=USD; lc-main=en_US") + " —— 不带时亚马逊按请求方 IP 返回本地化结果（本机在中国会整列变成 CNY 价，实测踩过）。");
w("");

w("### 竞品抓取 · 类目清单（`CATS`，" + BS.CATS.length + " 个）");
w("");
w("| 中文名 | slug | 说明 |");
w("|---|---|---|");
for (const c of BS.CATS) w("| " + c.cn + " | " + C(c.slug) + " | " + (c.note || "—") + " |");
w("");

w("### 竞品关键词 · 词表规模与权重模型（`competitor-keywords.js`）");
w("");
w("口径来自 " + C("tool/server.js") + "（原「竞品销量榜」）的纯本地部分，**联网翻译那一支没搬**");
w("（原 " + C("probeWordsSync") + " 会读联网填充的缓存）—— 改成由调用方传 " + C("extraWords") + "，于是这个模块断网也能算。");
w("");
w("| 表 | 规模 | 用途 |");
w("|---|---|---|");
w("| " + C("CAT_HINTS") + " | " + Object.keys(CK.CAT_HINTS).length + " | 类目关键词提示（" + C("detectCatSlug") + " / " + C("scoreCats") + " 用） |");
w("| " + C("SPECIES") + " | " + CK.SPECIES.length + " | 品类实词（判断切出来的词是不是真品类词） |");
w("| " + C("SUB_HINTS") + " | " + CK.SUB_HINTS.length + " | 子类目/场景提示 |");
w("| " + C("STOP") + " | " + CK.STOP.size + " | 停用词（虚词/连接词，不进权重表） |");
w("");
w("切词与权重（" + C("analyzeKeywords") + " 是唯一实现）：");
w("");
w("- 切词：" + C("tokenize") + " → 小写化 + 拆非字母数字 + **丢掉长度 <2 的词** + 去停用词 + 去纯数字。");
w("  ⚠️ 丢掉短词会让 n-gram 的 " + C("pos") + " 偏移（首词是 " + C("a") + " 时第一条 bigram 从位置 1 起）—— 这是原工具既有行为，已按它锁快照。");
w("- n-gram 只做 **1 / 2 / 3 阶**（" + C("buildNgrams") + "）；同一标题内同一个词只计一次覆盖。");
w("- 权重公式：" + C("w = covScore*0.5 + posScore*0.3 + lenScore*0.2") + "，其中");
w("  " + C("covScore = 覆盖率*10") + "、" + C("posScore = (1 - 平均位置)*10") + "、" + C("lenScore = 1gram→4 / 2gram→7.5 / 3gram→10") + "。");
w("- 单词且覆盖率 ≥0.9 再 " + C("-1.2") + "（泛词扣分，防「入场券词」挤掉长尾）；最后 " + C("clamp(1, 10)") + " 并保留一位小数。");
w("- **只保留出现 ≥2 次的词**（" + C("cov < 2") + " 直接丢弃）—— 所以它会漏真长尾，这是取舍不是 bug。");
w("- 空白机会（差异化）口径：" + C("useRate <= 25 && n >= 2") + "，最多列 12 个。");
w("");

w("### 文案提示词 · 五类与字符口径（`PROMPT_KINDS` / `buildCopyPrompt`）");
w("");
w("| id | 名称 | 要关键词表 | 要竞品样本 |");
w("|---|---|---|---|");
for (const k of CP.PROMPT_KINDS) {
  w("| " + C(k.id) + " | " + k.name + " | " + (k.needsKeywords ? "✅" : "—") + " | " + (k.needsItems ? "✅" : "—") + " |");
}
w("");
w("三条守卫（缺输入一律返回 " + C("ok:false") + " + 可读中文原因，**绝不产出一份空提示词**）：");
w("未知类型 → 先填产品名 → 需要样本的必须先有竞品 → 需要埋词依据的必须先跑过权重分析。");
w("");
w("全部字符上限**取自 " + C("listing.js") + "**，文案层一行都不手写（自检第 25 节有**反向锁**，禁在文案层出现字面量）：");
w("");
w("| 口径 | 值 | 出处 |");
w("|---|---|---|");
w("| 标题（非 media） | " + L.titleLimit({ isMedia: false }) + " | " + C("titleLimit({isMedia:false})") + " |");
w("| 标题（media 类目例外） | " + L.titleLimit({ isMedia: true }) + " | " + C("titleLimit({isMedia:true})") + " |");
w("| 产品亮点 Item Highlights | " + L.LIMITS.itemHighlights + " | " + C("LIMITS.itemHighlights") + " |");
w("| 标题 + 亮点合计 | " + L.LIMITS.titleTotal + " | " + C("LIMITS.titleTotal") + " |");
w("| 后台搜索词 | " + L.LIMITS.searchTerms + " **字节** | " + C("LIMITS.searchTerms") + " |");
w("| 五点单条 | " + L.LIMITS.bullet + " | " + C("LIMITS.bullet") + " |");
w("| 五点条数 | " + L.LIMITS.bulletCount + " | " + C("LIMITS.bulletCount") + " |");
w("");
w("> 顺手修掉原工具的两处**字符口径错误**：后台搜索词原文写「250 字符」（平台口径是**字节**，");
w("> 中文字符占 3 字节，按字符算会超 3 倍）；五点原文写「200」（" + C("LIMITS.bullet") + " 是 500，200 是别处抄来的数字）。");
w("> ⚠️ media 版提示词里**会**出现 " + C("75") + "，但在**否定句**里（\"不要套用非媒体类目的 75 字符上限\"）——");
w("> 断言锁的是**硬上限那句**（" + C("严格 ≤200 字符") + "），不是整段搜 " + C("75") + "（这个坑在 selftest 与 browser-selftest 各踩过一次）。");
w("");

/* ── 模板自动匹配（2026-09-29 第二版） ── */
w("### 模板自动匹配 · 别名层（`TEMPLATE_ALIASES`）");
w("");
w("> 上游 25 个模板 JSON 来自参考仓（别人的仓库），`build-templates.mjs` 的铁律是**只消费不改写**。");
w("> 但实测该词表里 `T恤` / `衣服` / `tee` / `shirt` / `apparel` / `garment` / `clothing` **全部 0 命中**，");
w("> 服装类需求全被丢给白底主图。所以补在**读法层** —— 上游文件零改动。");
w("");
w("| 模板 | 中文别名 | 英文别名 |");
w("|---|---|---|");
for (const [id, al] of Object.entries(P.TEMPLATE_ALIASES)) {
  w("| " + C(id) + " | " + ((al.zh || []).join(" / ") || "—") + " | " + ((al.en || []).join(" / ") || "—") + " |");
}
w("");

w("### 模板自动匹配 · 上下文亲和表（`CATEGORY_TEMPLATE_AFFINITY`）");
w("");
w("品类命中 → **+6 分**。上下文**只做补位**：词证据打平时用它决胜，一个词都没命中时由它接管（这就是多级回落）。");
w("");
w("| 品类 | 亲和模板（按优先级） |");
w("|---|---|");
for (const [cat, ids] of Object.entries(P.CATEGORY_TEMPLATE_AFFINITY)) {
  w("| " + C(cat) + " | " + ids.map(C).join(" → ") + " |");
}
w("");

w("### 模板 → 图型映射（`TEMPLATE_FIGURE`，25 个模板全有归属）");
w("");
w("> 编排层原来是一串硬编码嵌套三元，**25 个模板里只认 hero-image / lifestyle-scene 两个**，");
w("> 其余 23 个全被压成 `benefit`（卖点副图 25-30%）。选了模板却不认模板的构图口径，等于选型白做。");
w("");
w("| 模板 | 图型 key | 中文标签 | 产品占比 | 留白下限 |");
w("|---|---|---|---|---|");
for (const t of TEMPLATE_LIST) {
  const f = P.figureForTemplate(t.id);
  const spec = P.FIGURE_SPEC[f] || {};
  w("| " + C(t.id) + " | " + C(f) + " | " + (spec.label || "—") + " | " +
    ((spec.productPct || []).join("-") || "—") + "% | " +
    (spec.whitespacePct == null ? "—" : spec.whitespacePct + "%") + " |");
}
w("");

/* ── 铁律 1 ── */
w("### 铁律 1 · HEX 色板");
w("");
w("| 常量名 | hex |");
w("|---|---|");
for (const [k, v] of Object.entries(P.HEX)) w("| " + C("HEX." + k) + " | " + v + " |");
w("");
w("色板共 " + Object.keys(P.HEX).length + " 个色值。另有颜色词表 `COLOR_WORDS` 把中英文颜色形容词映射到这些 hex。");
w("");

/* ── 铁律 2/3 ── */
w("### 铁律 2/3 · 图型 → 产品占比 / 留白下限（`FIGURE_SPEC`）");
w("");
w("| figure key | 中文标签 | 产品占比区间 | 留白下限 |");
w("|---|---|---|---|");
for (const [k, v] of Object.entries(P.FIGURE_SPEC)) {
  w("| " + C(k) + " | " + v.label + " | " + v.productPct[0] + "–" + v.productPct[1] + "% | ≥" + v.whitespacePct + "% |");
}
w("");

/* ── 铁律 4 ── */
w("### 铁律 4 · 否定清单");
w("");
w("基础否定项（`BASE_NEGATIVE`，7 项）+ 按模板追加。示例（hero-image）：");
w("");
const negSample = P.negativeConstraints("hero-image");
w("```text");
w(negSample);
w("```");
w("");

/* ── 铁律 6 ── */
w("### 铁律 6 · 三层信息架构上限");
w("");
w("- 核心承诺 headline：≤15 字");
w("- 关键证据 evidence：≤3 个（超出被 slice 截断）");
w("- CTA：≤8 字");
w("");
w("超限时 `infoArchitecture()` 返回 `problems[]`，由 `auditPlan()` 汇总。");
w("");

/* ── 角度 / 景别 ── */
w("### 多角度镜头规则 · 角度全集（`ANGLES`，" + P.ANGLES.length + " 种）");
w("");
w("| key | 中文标签 | 写进 Prompt 的描述 |");
w("|---|---|---|");
for (const a of P.ANGLES) w("| " + C(a.key) + " | " + a.label + " | " + a.text + " |");
w("");
w("### 多角度镜头规则 · 景别全集（`SHOTS`，" + P.SHOTS.length + " 种）");
w("");
w("| key | 中文标签 | 写进 Prompt 的描述 |");
w("|---|---|---|");
for (const s of P.SHOTS) w("| " + C(s.key) + " | " + s.label + " | " + s.text + " |");
w("");

/* ── 角度分配审计口径 ── */
const haSample = P.assignAngles(5, { kind: "hero" });
const paSample = P.assignAngles(9, { kind: "pdp" });
w("### 角度分配审计口径（`assignAngles(count, {kind})`）");
w("");
w("| kind | 要求角度种数 | 要求特写/微距张数 | 实测（count 对应值） |");
w("|---|---|---|---|");
w("| hero（5 张） | ≥" + haSample.audit.needDistinct + " | ≥" + haSample.audit.needClose + " | 实得 " + haSample.audit.distinctAngles + " 种 / 特写 " + haSample.audit.closeShots + " 张 |");
w("| pdp（9 张） | ≥" + paSample.audit.needDistinct + " | ≥" + paSample.audit.needClose + " | 实得 " + paSample.audit.distinctAngles + " 种 / 特写 " + paSample.audit.closeShots + " 张 |");
w("");
w("另有约束：不能连续 3 张同角度；全景占比 ≤40%。主图序列的 5 个角度槽位实测为："
  + haSample.slots.map((s) => s.angle).join(" → "));
w("");

/* ── Style Lock ── */
w("### Campaign Style Lock · " + P.STYLE_LOCK_DIMENSIONS.length + " 个维度（`STYLE_LOCK_DIMENSIONS`）");
w("");
P.STYLE_LOCK_DIMENSIONS.forEach((d, i) => w((i + 1) + ". " + d));
w("");
w("默认 Style Lock 全文（`DEFAULT_STYLE_LOCK`）：");
w("");
w("```text");
w(P.DEFAULT_STYLE_LOCK);
w("```");
w("");
w("`buildStyleLock()` 默认值：");
w("");
w("```text");
w(P.buildStyleLock({}));
w("```");
w("");

/* ── 序列 ── */
w("### 主图序列（`HERO_SEQUENCES`，按转化驱动力三选一，各 5 张）");
w("");
for (const [drv, arr] of Object.entries(P.HERO_SEQUENCES)) {
  w("**驱动 = " + drv + "**");
  w("");
  w("| code | 用途 | figure | 模板 | headline |");
  w("|---|---|---|---|---|");
  for (const h of arr) w("| " + h.code + " | " + h.purpose + " | " + C(h.figure) + " | " + C(h.template) + " | " + h.headline + " |");
  w("");
}
w("### 详情页序列（`PDP_SEQUENCE`，固定 " + P.PDP_SEQUENCE.length + " 张）");
w("");
w("| code | 用途 | 模板 | headline |");
w("|---|---|---|---|");
for (const d of P.PDP_SEQUENCE) w("| " + d.code + " | " + d.purpose + " | " + C(d.template) + " | " + d.headline + " |");
w("");

/* ── 画幅映射 ── */
w("### 画幅规则");
w("");
w("- 主图组（hero）：一律 `1024x1024`（1:1，亚马逊主图/副图要求）");
w("- 详情页组（pdp）：一律 `768x1024`（3:4 竖版）");
w("- Prompt 里写的是**比例**不是像素（`toRatioText()` 转换），如 `aspect ratio 1:1`");
w("");
w("视觉节奏：`rhythmBackground(index)` 按 `#FFFFFF → #F5F1E8 → #1A3A2E` 循环取背景色。");
w("");

/* ── Listing 参数 ── */
w("### Listing · 字段上限（`LIMITS`）");
w("");
w("| 字段 | 上限 | 说明 |");
w("|---|---|---|");
w("| title | " + L.LIMITS.title + " | 标题硬上限（**2026-07-27 生效**，含空格） |");
w("| titleMedia | " + L.LIMITS.titleMedia + " | **唯一例外**：media 类目（图书 / 音乐 / 影像） |");
w("| itemHighlights | " + L.LIMITS.itemHighlights + " | Item Highlights（后台显示名 / API 属性名 `title_differentiation`），**参与搜索** |");
w("| titleTotal | " + L.LIMITS.titleTotal + " | 标题 + Item Highlights **合计**上限（官方明文：两项共享） |");
w("| titleStrict | " + L.LIMITS.titleStrict + " | 保守建议上限（**项目自定义**口径，非平台值） |");
w("| bullet（单条） | " + L.LIMITS.bullet + " | 五点描述单条上限 |");
w("| bulletCount | " + L.LIMITS.bulletCount + " | 标准五点数量 |");
w("| searchTerms | " + L.LIMITS.searchTerms + " | **字节**上限（非字符） |");
w("| description | " + L.LIMITS.description + " | 描述上限 |");
w("");
w("关系式（不是巧合，是官方设计）：`title + itemHighlights = titleTotal` → **"
  + L.LIMITS.title + " + " + L.LIMITS.itemHighlights + " = " + L.LIMITS.titleTotal + "**。");
w("另有 `titleLimit(ctx)` 集中处理类目口径（`ctx.isMedia` → " + L.LIMITS.titleMedia + "，否则 " + L.LIMITS.title + "），界面与判据共用一处，不各写一遍三元。");
w("");
w("### Listing · 词表（12 张）");
w("");
w("**① 促销与最高级 `PROMO_WORDS`（" + L.PROMO_WORDS.length + " 个）** —— 分四组：价格促销 / 最高级 / 平台徽章词 / 大促名（后两类分别是「挪用平台标识」与「商标受限」）：");
w("");
w(L.PROMO_WORDS.join(" / "));
w("");
w("> ⚠️ 刻意**不收** `perfect`：`perfect for gifting` 是海量合规 listing 的正常写法，收进来会造成大面积误报。");
w("");
w("**② 特殊符号 `BAD_SYMBOLS`（" + L.BAD_SYMBOLS.length + " 个）**：" + L.BAD_SYMBOLS.join(" "));
w("");
w("> 前 16 个＝平台明列 + 表情符号解析风险；后 4 个（竖线 / 尖括号 / 反引号）＝本项目补充，理由是解析与注入（这条文案还会走「导出 HTML 预览 / 粘贴到表格」的链路）。单个 `%` / `#` / `+` **不在黑名单里**（100% Cotton、Model #A、2+1 Pack 都是合法写法），改由 C7「符号密度」兜底。");
w("");
w("**③ 保证性/绝对化 `CLAIM_WORDS`（" + L.CLAIM_WORDS.length + " 个，含中文）**：");
w("");
w(L.CLAIM_WORDS.join(" / "));
w("");
w("**④ 疾病/医疗声明 `DISEASE_TERMS`（" + L.DISEASE_TERMS.length + " 个）**：官方文档「Prohibited Product Claims for Diseases」逐条列表。**刻意剔除 7 个高频歧义词** —— `add`（Add to cart）/ `sad`（Sad puppy）/ `mono`（mono output）/ `pid`（PID controller）/ `crabs`（海鲜与螃蟹玩具）/ `tbi` / `ngu`（纯缩写、收益为零），并保留其无歧义全称（`attention deficit` / `seasonal affective disorder` / `mononucleosis` / `pelvic inflammatory disease` / `pubic lice` / `traumatic brain injury`）。**误报＝工具失去信任**，所以宁可漏收缩写。");
w("");
w("**⑤ 农药/抗菌声明 `PESTICIDE_CLAIMS`（" + L.PESTICIDE_CLAIMS.length + " 个）**：进入 EPA 注册范畴的表述。");
w("");
w("**⑥ 环境声明 `ENV_CLAIMS`（" + L.ENV_CLAIMS.length + " 个）**：" + L.ENV_CLAIMS.join(" / "));
w("");
w("**⑦ 不证自明声明 `SELF_EVIDENT_CLAIMS`（" + L.SELF_EVIDENT_CLAIMS.length + " 个）**：" + L.SELF_EVIDENT_CLAIMS.join(" / "));
w("");
w("**⑧ 品类专属高风险 `CATEGORY_CLAIMS`（" + Object.keys(L.CATEGORY_CLAIMS).length + " 个品类）**：" + Object.keys(L.CATEGORY_CLAIMS).join(" / "));
w("");
w("> 同一个词在不同品类风险不同：`antibacterial` 用在清洁剂是必需描述、用在袜子上是违规声明。所以品类专属词表只在识别出对应品类时才参与判定。");
w("");
w("**⑨ 利益导向词 `BENEFIT_WORDS_EN`（" + L.BENEFIT_WORDS_EN.length + " 个）/ `BENEFIT_WORDS_ZH`（" + L.BENEFIT_WORDS_ZH.length + " 个）**：供 C3 使用，按 `detectLang()` 结果二选一。中文表每个词都**两字以上**（中文无词边界，单字如「更」「省」会命中「更衣」「省份」）。");
w("");
w("**⑩ 站外引流/联系方式 `OFF_SITE_PATTERNS`（" + L.OFF_SITE_PATTERNS.length + " 条，**P 级硬规则**）**：");
w("");
for (const p of L.OFF_SITE_PATTERNS) w("- `" + String(p.re.source) + "` → " + p.label);
w("");
w("> 以**模式**而不是词表：网址/邮箱的形态本身就是判据，列词反而不全。刻意**不**把裸 `@` 收进来（已在 `BAD_SYMBOLS` 按符号管），邮箱必须写成 `local@domain.tld` 才算。");
w("");
w("**⑪ 疑似联系方式 `SOFT_CONTACT_PATTERNS`（" + L.SOFT_CONTACT_PATTERNS.length + " 条，**C 级软规则**）**：");
w("");
for (const p of L.SOFT_CONTACT_PATTERNS) w("- `" + String(p.re.source) + "` → " + p.kind);
w("");
w("> 🔴 **为什么电话只能做软规则**：`350-500-1000` 这种三段规格串数字量就有 10 位，硬禁必然误报，而误报会让卖家不再相信整个质检结果。所以只挑「形态更像电话」的（带 `+` 区号 / 带括号 / 带分隔符）报出来并标「请人工确认」。**判不准就报疑似，不报违规。**");
w("");
w("**⑫ 标题主观修饰词 `SUBJECTIVE_TITLE_WORDS`（" + L.SUBJECTIVE_TITLE_WORDS.length + " 个，C 级）**：" + L.SUBJECTIVE_TITLE_WORDS.join(" / "));
w("");
w("> ⚠️ 边界要说清：官方只给了**原则**（Subjective commentary 一节）和两个例子（HOT ITEM / BEST SELLER），**没给词表** —— 这张表是本项目按该原则自定的，所以定 C 级、`source` 里写明。与 `PROMO_WORDS` 重叠的词只在 PROMO 侧报（有断言锁住，同一件事不报两遍）。");
w("");
w("所有英文词表共用 `matchWords()` 做**词边界**匹配（避免 secure 命中 cure、freedom 命中 free）；中文表走子串匹配。");
w("");

/* ── 规则表 ── */
w("### Listing · 全部规则（`RULES`，" + L.RULES.length + " 条）");
w("");
w("| id | 级别 | 作用域 | 空值也判定 | 来源 | 判定逻辑（`test` 摘要） |");
w("|---|---|---|---|---|---|");
for (const r of L.RULES) {
  const why = String(r.why).replace(/\|/g, "/");
  // emptyOk：个别规则要报的就是「字段是空的」本身（如 C10），所以它不能被"空值即跳过"挡住。
  const eo = r.emptyOk ? "✅" : "—";
  w("| " + r.id + " | " + r.level + " | " + C(r.scope) + " | " + eo + " | " + r.source + " | " + why + " |");
}
w("");
w("> ⚠️ 「空值也判定」列：一般规则遇到字段为空**跳过**是对的（空字段算跳过、不算通过）；");
w("> 但 `C10`（Item Highlights 为空）要报的恰恰就是「空」本身 —— 没有这个放行口，它会**永远静默不报**，");
w("> 而一条静默失效的规则比没有这条规则更坏。放行有个前提：`hasContent` —— **整张表一个字都没填时不放行**，");
w("> 否则第一次打开工作台就会看到「未填写 Item Highlights」，那是噪音不是信息。");
w("");
const byScope = L.RULES.reduce((a, r) => { (a[r.scope] = a[r.scope] || []).push(r.id); return a; }, {});
w("**作用域分布**：");
w("");
for (const [s, ids] of Object.entries(byScope)) w("- `" + s + "`（" + ids.length + " 条）：" + ids.join(", "));
w("");
const bySource = L.RULES.reduce((a, r) => { a[r.source] = (a[r.source] || 0) + 1; return a; }, {});
w("**来源分布**：" + Object.entries(bySource).map(([k, v]) => k + " " + v + " 条").join("；"));
w("");

/* ── 模板数据 ── */
const tpls = Object.values(TEMPLATES);
const variants = tpls.reduce((n, x) => n + Object.keys(x.variants || {}).length, 0);
const examples = tpls.reduce((n, x) => n + (x.examples || []).length, 0);
const ptKeys = new Set();
tpls.forEach((x) => Object.keys(x.prompt_template || {}).forEach((k) => ptKeys.add(k)));
w("### 模板数据（`assets/templates.js`，由 `tools/build-templates.mjs` 生成）");
w("");
w("- 模板数：**" + tpls.length + "**｜变体合计：**" + variants + "**｜示例合计：**" + examples + "**｜`prompt_template` 字段种类：**" + ptKeys.size + "**");
w("- 每个模板必填 11 个字段");
w("");
w("| order | id | 名称 | keywords 数 | trigger_phrases 数 | 变体数 | 支持参考图 |");
w("|---|---|---|---|---|---|---|");
for (const t of TEMPLATE_LIST) {
  w("| " + t.order + " | " + C(t.id) + " | " + t.name + " | " + (t.keywords || []).length
    + " | " + (t.trigger_phrases || []).length + " | " + Object.keys(t.variants || {}).length
    + " | " + (t.supports_image_reference ? "支持" : "—") + " |");
}
w("");
w("`prompt_template` 字段种类（" + ptKeys.size + " 种，说明它是**开放式 schema**，各场景字段不同）：");
w("");
w([...ptKeys].sort().join(" / "));
w("");

/* ── 采集 ── */
w("### 数据采集 · 选择器表（`SELECTORS`）");
w("");
w("| 字段 | 选择器（按优先级） |");
w("|---|---|");
for (const [k, v] of Object.entries(A.SELECTORS)) w("| " + C(k) + " | " + v.map(C).join(" · ") + " |");
w("");
w("### 数据采集 · 站点差异（`SITES`，21 个 Marketplace）");
w("");
w("| 域名 | 站点 | 币种 | 语种 | 标题上限 | 建议上限 |");
w("|---|---|---|---|---|---|");
for (const [k, v] of Object.entries(A.SITES)) w("| " + k + " | " + v.label + " | " + v.currency + " | " + (v.lang || "—") + " | " + v.titleLimit + " | " + v.titleAdvice + " |");
w("");
w("> `lang` 为 `—` ＝英语系站点，其停用词走英语表；其余按 `stopwordsFor(lang)` 取对应语种表。`siteLang(host)` 容忍 `www.` 前缀，未知站点返回空串（不猜）。");
w("");

/* ── 多语种停用词 ── */
w("### 关键词挖掘 · 多语种停用词（`STOPWORDS_BY_LANG` / `stopwordsFor`）");
w("");
w("| 语种 | 词表大小 | 代表虚词 |");
w("|---|---|---|");
for (const [k, v] of Object.entries(L.STOPWORDS_BY_LANG)) {
  const arr = [...v];
  w("| " + k + " | " + arr.length + " | " + arr.slice(0, 12).map(C).join(" · ") + " … |");
}
w("");
w("> 🔴 **各语种表绝不能合并**：`car` / `son` / `main` / `kind` / `tag` / `ring` / `boot` / `note` / `tank` / `rock` / `van` / `over` / `fur` / `solo` / `plus` / `war` / `era` 这些词在英语里是**真词**，混进非英语表会把真实关键词一起删掉。");
w("> ⚠️ `" + "die" + "`（德语第一大虚词 vs 英语 die-cut）是**有意保留的例外**，已被断言固定住，别当漏网之鱼去「修」。");
w("");

/* ── 搜索结果页批量解析 ── */
w("### 数据采集 · 搜索结果页批量解析（`detectPageKind` / `extractSearchResults`）");
w("");
w("| 函数 | 作用 |");
w("|---|---|");
w("| `detectPageKind(html)` | 判 `search` / `detail` / `unknown` —— **同一段 DOM 必须先分流再解析**，否则搜索页会被当成「缺字段的详情页」 |");
w("| `extractSearchResults(html, url)` | 整页解析：标题 / 价格 / 评分 / 评论数 / ASIN / 是否广告位 |");
w("| `searchItemsToCompetitors(items)` | 转成多竞品对比要的 `[{name,text}]` 形态 |");
w("| `searchItemsCorpus(items)` | 拼成可喂给关键词挖掘的一段语料 |");
w("| `searchItemsSummary(items)` | 价格/评分/评论数的 min/max/median/avg/n（**空列表返回 `null` 而不是 `NaN`**） |");
w("");
w("> ⚠️ 去重**必须放在计数之前** —— 同一商品可能出现重复卡片，先计数会把 `sponsored` / `withAsin` 刷高（实测踩到）。");
w("");

/* ── 本地持久化常量 ── */
w("### 本地产物 · 持久化常量（`assets/store.js`，IndexedDB）");
w("");
w("| 常量 | 值 | 说明 |");
w("|---|---|---|");
w("| `MAX_PAYLOAD_CHARS` | " + STORE.MAX_PAYLOAD_CHARS + " | 单条载荷上限，超了裁剪并打 `truncated` 标记 |");
w("| `MAX_RECORDS_PER_KIND` | " + STORE.MAX_RECORDS_PER_KIND + " | 每类最多留几条，超了淘汰最旧的 |");
w("");
w("| 类（`KINDS`） | 名称 |");
w("|---|---|");
for (const [k, v] of Object.entries(STORE.KINDS)) w("| " + C(k) + " | " + v.label + " |");
w("");
w("> 🔴 **产物与配置刻意分两层**：`store.js` 只存产物（采集/方案/草稿/覆盖度），**API Key 永不进这里**，仍走服务端 `.env.local`。");
w("> 这样「导出全部产物给同事」这条路径**从数据结构上就不可能夹带密钥**，不靠代码自觉。");
w("");

/* ── 配置项 ── */
w("### 设置项与默认值（`DEFAULT_CONFIG`，存 localStorage 键 `clx_listing_workbench_config`）");
w("");
w("| 配置项 | 默认值 |");
w("|---|---|");
for (const [k, v] of Object.entries(Api.DEFAULT_CONFIG)) w("| " + C(k) + " | " + (v === "" ? "（空）" : C(String(v))) + " |");
w("");

/* ═══════════ P0-1 · Rufus / Alexa 信息架构检查（2026-10-02） ═══════════ */

const rTypes = Object.keys(RD.CATEGORY_ATTRIBUTES);
const attrAll = rTypes.flatMap((t) => RD.CATEGORY_ATTRIBUTES[t].required.concat(RD.CATEGORY_ATTRIBUTES[t].recommended));
const attrReq = rTypes.flatMap((t) => RD.CATEGORY_ATTRIBUTES[t].required);
const sc = attrAll.reduce((a, e) => { a[e.source] = (a[e.source] || 0) + 1; return a; }, {});

w("### Rufus 模块 · 属性清单（`CATEGORY_ATTRIBUTES`，" + rTypes.length + " 个产品类型）");
w("");
w("> `source` 只有三个合法取值：" + C("amazon-guide") + "（帮助文档正文明确举例或定义）/ "
  + C("amazon-schema") + "（Flat File 模板列名 / SP-API Product Type Definition schema 字段名 / 后台表单字段名）/ "
  + C("practitioner") + "（无官方明文，行业通行）。**宁可标低不许标高**：拿不准一律 practitioner。");
w("> " + C("required") + " 的语义是「官方帮助文档正文明确要求必填」，**不是**「常识上应该必填」—— "
  + "放进 required 必须能附上引用句，拿不出引用句的一律放 recommended。界面上写「必填」等于替亚马逊下断言，只有官方明文可证才允许这样说。");
w("");
w("| 产品类型 | 中文标签 | required | recommended | 合计 | required 字段（`key`） |");
w("|---|---|---|---|---|---|");
for (const t of rTypes) {
  const d = RD.CATEGORY_ATTRIBUTES[t];
  w("| " + C(t) + " | " + d.label + " | " + d.required.length + " | " + d.recommended.length + " | "
    + (d.required.length + d.recommended.length) + " | " + d.required.map((e) => C(e.key)).join("、") + " |");
}
w("");
w("字段条目合计 **" + attrAll.length + "**（required " + attrReq.length + " / recommended " + (attrAll.length - attrReq.length) + "）；"
  + "按 source 分布：" + Object.keys(sc).sort().map((k) => C(k) + " " + sc[k]).join(" / ") + "。");
w("");
w("> 只有 `item_name`（全部 " + rTypes.length + " 个类目）带 alias 读法层：`alias: ['title']`。"
  + "读「该字段填了没有」时 `listing[e.key]` 非空 **或** 别名键非空即视为已填。"
  + "没有它，用户在标题框填了标题、仍会被判「商品标题缺失」（必然误报）。"
  + "其余 key 都是结构化类目属性，草稿模型（title / highlights / bullets / description / searchTerms）里没有语义等价字段，故一律不加别名。");
w("> 另注：`bullet_point` / `product_description` / `title_differentiation` / `generic_keywords` 这几个内容类字段**本就不在**本清单里 —— "
  + "它们属 listing 内容模型，不是类目属性，因此没有为它们加 alias 的位置。");
w("");

w("### Rufus 模块 · 买家问题覆盖矩阵（`CATEGORY_QUESTIONS`）");
w("");
w("> 🔴 全部 `source` 都是 " + C("practitioner") + "。**我们没有任何官方问题清单** —— "
  + "这份清单是从业者口径（由评论 / Q&A / 客服收件箱归纳的经验值），绝不许写成官方。");
w("");
w("| 产品类型 | 问题数 | 本题材前 3 题（原文） |");
w("|---|---|---|");
for (const t of rTypes) {
  const qs = RD.CATEGORY_QUESTIONS[t] || [];
  w("| " + C(t) + " | " + qs.length + " | " + (qs.slice(0, 3).map((q) => q.question).join(" / ") || "—") + " |");
}
w("");
const qTotal = rTypes.reduce((n, t) => n + (RD.CATEGORY_QUESTIONS[t] || []).length, 0);
w("问题合计 **" + qTotal + "** 条。每条含 `id`（形如 " + C("<productType>-q<n>") + "）/ `question`（英文，模拟买家在 Rufus / Alexa 里的真实问法）"
  + " / `answerHints`（回答里应出现的关键信息类型，供机械匹配）/ `why` / `source`。");
w("");

w("### Rufus 模块 · 单位族（`UNIT_GROUPS`，" + RD.UNIT_GROUPS.length + " 族）");
w("");
w("> 判定窗口**只在一个族内**：族内同时出现英制与公制才报。跨族（如重量 " + C("lb") + " 与尺寸 " + C("cm") + "）是不同维度，报它就是猜。");
w("");
w("| 族 id | 中文 | 英制 | 公制 | 写法数 | source |");
w("|---|---|---|---|---|---|");
for (const g of RD.UNIT_GROUPS) {
  w("| " + C(g.id) + " | " + g.label + " | " + g.imperial.join(" / ") + " | " + g.metric.join(" / ") + " | " + g.units.length + " | " + C(g.source) + " |");
}
w("");
w("歧义单位白名单（`UNIT_AMBIGUOUS_WHITELIST`）：" + RF.UNIT_AMBIGUOUS_WHITELIST.map(C).join(" / ")
  + "。单位 token 长度 ≤2 且不在白名单者（" + ["in", "g", "w", "mm", "cm", "ft"].map(C).join("、") + " …）一律**不参与**判定，"
  + "因为它们同时可能是普通词（" + C("in") + " 是介词）；白名单里的三个虽同样短，但语义明确，仍参与判定。");
w("");

const pairs = RD.MATERIAL_CONFLICTS;
const floor = pairs.reduce((acc, p) => acc.filter((x) => p.guards.includes(x)), pairs[0].guards.slice());
w("### Rufus 模块 · 互斥材质词对（`MATERIAL_CONFLICTS`，" + pairs.length + " 对）");
w("");
w("> guards 对齐纪律：同一类语境事实在**所有**词对上必须写成同一份，禁止「这对有 " + C("lining") + "、那对没有」。"
  + "否则「主体 + 部件」复合商品（如主体陶瓷 + 塑料底座）会在词表不齐的那几对上误报。");
w("");
w("| 词对 | 说明 | guards 合计 | 全对共用地板词 | 本对专有话术 | source |");
w("|---|---|---|---|---|---|");
for (const p of pairs) {
  const extra = p.guards.filter((x) => !floor.includes(x));
  w("| " + C(p.a) + " ↔ " + C(p.b) + " | " + p.note + " | " + p.guards.length + " | " + floor.length
    + " | " + (extra.length ? extra.map(C).join("、") : "—") + " | " + C(p.source) + " |");
}
w("");
w("**全对共用地板词（" + floor.length + " 个，实测为所有词对 guards 的交集）**：" + floor.map(C).join(" "));
w("");
w("> 逐对层**只能放「离开本对就无意义」的复合词**。" + C("alternatives") + " 是反面教材 —— "
  + "它会被 " + C("better than alternatives") + " 这类正常文案命中、把真冲突静默压掉，**已删除**。"
  + "另：通用连接词与纯符号一律不作 guard（stoplist = " + ["and", "or", "with", "&", "+", "%", "/", ","].map(C).join(" ")
  + "），它们在任何文案里都出现，当 guard 等于把真冲突一起放过。故意不收 " + C("top") + " / " + C("bottom")
  + " —— 会命中 " + C("top quality cotton") + " 这类质量形容，属误伤。");
w("");

w("### Rufus 模块 · 数值 + 单位提取（`NUMBER_UNIT_RE`）");
w("");
w("- `pattern`：" + C(RD.NUMBER_UNIT_RE.pattern) + "（第 3 捕获组与 `.unit` **同源**，只写一次，永远不漂移）");
w("- `flags` = " + C(RD.NUMBER_UNIT_RE.flags) + "｜`unit` 子模式枚举 " + RD.NUMBER_UNIT_RE.unit.split("|").length + " 个写法");
w("- 捕获组：`1` = 第一个数值（整数或小数）｜`2` = 区间上界（如 " + C("10-12 inches") + " 里的 " + C("12") + "）｜`3` = 单位文本");
w("");

w("### Rufus 模块 · 规则表（`RUFUS_RULES`，" + RU.RUFUS_RULES.length + " 条）");
w("");
w("| id | 组 | 级别 | 作用域 | 按问题展开 | sourceTier | why |");
w("|---|---|---|---|---|---|---|");
for (const r of RU.RUFUS_RULES) {
  w("| " + r.id + " | " + r.group + " | " + r.level + " | " + C(r.scope) + " | " + (r.perQuestion ? "✅" : "—")
    + " | " + C(r.sourceTier) + " | " + String(r.why).replace(/\|/g, "/") + " |");
}
w("");
w("> 🔴 分级保守：R 组**出厂默认 C 级**；唯 R1 的 required 档、且守卫字段 " + C("source === 'amazon-guide'") + " 者可判 P。"
  + "跨字段一致性 / 单位制 / 图内文字都是从业者口径，报「发布前必须修改」就是撒谎。"
  + "所以 `R1-01` 的级别是**运行时算出来的**（`test()` 返回的 `level` 覆盖静态值），静态表里写的 " + C("P") + " 只是上限。");
w("> " + C("R4-01") + " 的 " + C("perQuestion: true") + " 表示该条目**按 productType 的问题矩阵展开**为 R4-01…R4-0n，不产生自身的单条结果。");
w("");

w("### Rufus 模块 · 返回结构与分组口径（`lintRufus`）");
w("");
w("`results[i] = { id, group, level, scope, status, detail, why, source, sourceTier }`，与 " + C("lintListing") + " **同构**。");
w("");
w("| 项 | 取值 |");
w("|---|---|");
w("| `status` 四值 | " + ["命中", "通过", "通过（部分）", "跳过"].map(C).join(" / ") + " |");
w("| `summary` 键 | " + ["total", "hit", "hitP", "hitC", "skipped", "byGroup", "conclusion"].map(C).join(" / ") + " |");
w("| `byGroup[gid]` 键 | " + ["total", "hit", "pass", "partial", "skipped", "covered", "miss"].map(C).join(" / ") + "（其中 " + C("covered = pass + partial") + "、" + C("miss = hit") + "） |");
w("");
w("| 组 id | 名称 |");
w("|---|---|");
for (const g of RU.RUFUS_GROUPS) w("| " + C(g.id) + " | " + g.name + " |");
w("");
w("`conclusion` 三态（判定顺序自上而下，**不可换序**）：");
w("");
w("1. 有 P 级命中 → " + C("存在硬规则命中，发布前必须修改"));
w("2. 无 P 级但有命中 → " + C("硬规则全过，软规则有可优化项"));
w("3. 全无命中时再分两种：**已检查项（非跳过）为 0** → " + C("无可检查项：全部跳过（请先填文案，或选择产品类型）") + "；否则才是 " + C("全部通过"));
w("");
w("> 🔴 第 3 条的分叉是**缺陷修复**（缺陷 K）：空表本来会报「全部通过」—— 一条没查也叫全部通过，等于界面说假话。"
  + "已由 SPEC AC-04 锁住，自检 §23n 做双向锁（空表必须报「无可检查项」；全字段填满仍须能报「全部通过」）。");
w("");

w("### Rufus 模块 · 出处分级（`tierOf`，全项目唯一映射点）");
w("");
w("| 数据层 `source`（三值） | 规则层 `sourceTier`（两档） | 证据引用串（`sourceRef`） |");
w("|---|---|---|");
for (const k of ["amazon-guide", "amazon-schema", "practitioner"]) {
  w("| " + C(k) + " | " + C(RU.tierOf(k)) + " | " + RU.sourceRef(k) + " |");
}
w("");
w("未知 `source` 值 **必须抛异常**，绝不静默归为 official；"
  + "证据引用串随档不同，不共用笼统的「亚马逊官方文档」—— 模板列名不许说成帮助文档正文。");
w("");

process.stdout.write(out.join("\n") + "\n");
