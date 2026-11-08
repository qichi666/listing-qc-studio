/**
 * 文案提示词组装 —— 纯函数、零依赖、零网络。
 *
 * 来源：`tool/public/index.html:959-1079`（原「竞品销量榜」的提示词模板 T）
 *       + `Listing优化-AI提示词工作台.html` 的 5 条人工打磨提示词。
 *
 * 🔴 为什么单独一个文件，而不是塞进 `prompt-engine.js`：
 *    `prompt-engine.js` 是**图像**提示词引擎（图型 / Style Lock / 画幅 / 亚马逊首图法规），
 *    文案侧与它没有一行共享逻辑。混在一起只会让两边都难改。
 *
 * 🔴 顺手修掉 A 的**两处字符口径错误**（不是抄错，是它原本就写错了）：
 *    · 后台搜索词：A 写「250 字符」，平台口径是 **250 字节**（`LIMITS.searchTerms`）。
 *      中文字符占 3 字节，按字符算会超 3 倍。
 *    · 五点描述：A 写「200 字符」，`LIMITS.bullet` 是 **500**。200 是别处抄来的数字。
 *    本模块的字符上限**全部**取自 `listing.js` 的 `LIMITS` / `titleLimit()`，
 *    一处都不手写 —— 否则界面说 75、规则判 70，两边打架。
 *
 * ⚠️ 这里只**拼文本**，不调用任何模型。产出的是给人复制去用的提示词。
 */
import { LIMITS, titleLimit } from "./listing.js";

/** 五类文案提示词（界面按此顺序渲染） */
export const PROMPT_KINDS = [
  { id: "analysis", name: "① 竞品标题拆解 + 关键词提取", needsKeywords: false, needsItems: true },
  { id: "title", name: "② 标题 + 产品亮点（Item Highlights）", needsKeywords: true, needsItems: true },
  { id: "bullets", name: "③ 五点描述（Bullet Points）", needsKeywords: true, needsItems: true },
  { id: "searchTerms", name: "④ 后台搜索词（Search Terms）", needsKeywords: true, needsItems: true },
  { id: "localize", name: "⑤ 多语言本地化", needsKeywords: false, needsItems: true },
];

export const PROMPT_KIND_IDS = PROMPT_KINDS.map((k) => k.id);

/** 产品信息 + 竞品样本。评论数当销量代理指标 —— 这是从业者口径，不是官方口径，措辞里已标明。 */
export function buildHead({ product, siteLabel = "美国站", categoryPath = "", items = [] } = {}) {
  const blob = (items || []).map((it, i) => {
    const meta = [];
    if (it.rank) meta.push("榜单#" + it.rank);
    if (it.rating) meta.push(it.rating + "星");
    if (it.reviews) meta.push(it.reviews + "评");
    if (it.price) meta.push(it.price);
    let line = i + 1 + ". " + it.title;
    if (meta.length) line += "  [" + meta.join(" · ") + "]";
    return line;
  }).join("\n");

  return "你是跨境电商 Listing 优化专家，服务的是 " + siteLabel + "。\n\n" +
    "【我的产品】" + (product || "（未填）") + "\n" +
    (categoryPath ? "【目标类目】" + categoryPath + "\n" : "") +
    "【竞品样本】以下是该类目亚马逊销量榜 Top " + (items || []).length + " 的标题，按榜单名次排列。\n" +
    "方括号里依次是「榜单名次 · 星级 · 评论数 · 价格」。\n" +
    "⚠️ 亚马逊**不公开**具体销量数字。评论数与累计销量强相关（这是从业者经验口径，非官方口径），" +
    "埋词时可优先参考评论数高的竞品，评论数很低的适当降低参考权重。\n\n" +
    blob + "\n\n";
}

/** 通用硬性约束（A 的 rule，逐条保留 —— 尤其是"只统计不联想"和"不许编参数"） */
export function buildRules({ product } = {}) {
  return "【硬性约束 · 必须遵守】\n" +
    "1. 所有产出必须围绕【我的产品：" + (product || "（未填）") + "】展开，不得生成与该产品无关的内容。\n" +
    "2. 如果上面的竞品标题里有明显跟我的产品不是一类东西的条目，请**先单独列出来**告诉我哪个不像，" +
    "并在后续分析中跳过它们，不要把它们的词混进我的 Listing。\n" +
    "3. 只统计我给你的文本，不要自行添加或联想没出现过的词。\n" +
    "4. 不确定的参数（尺寸 / 材质 / 认证）用方括号标出来让我补，**不要编**。\n\n";
}

/** 2026-07-27 标题新规。字符数全部取自 LIMITS，不手写。 */
export function buildRuleTitle({ isMedia = false } = {}) {
  const cap = titleLimit({ isMedia });
  if (isMedia) {
    return "【平台规则 · 媒体类目例外】\n" +
      "- 图书 / 音乐 / 影像（media）类目标题上限仍是 **" + cap + " 字符**，是唯一例外。\n" +
      "- 本次按 media 口径生成，**不要**套用非媒体类目的 " + LIMITS.title + " 字符上限。\n\n";
  }
  return "【平台规则 · 2026 年 7 月 27 日起生效】\n" +
    "- 亚马逊除媒体类目外，商品标题上限已从 200 字符降为 **" + cap + " 字符（含空格）**。\n" +
    "- 标题腾出的信息放进新增的「产品亮点 Item Highlights」，上限 **" + LIMITS.itemHighlights + " 字符**，且同样可被搜索。\n" +
    "- 两者**合计**上限 " + LIMITS.titleTotal + " 字符（两段式标题共享这个额度）。\n" +
    "- 🔴 标题超过 " + cap + " 字符时，Item Highlights 这个字段**提交不上去**；" +
    "而且超限不等于报错 —— 亚马逊会按 AI 建议**自动改写**你的标题，你拿到的是它给的版本。\n" +
    "- 所以：标题只能是「品牌 + 核心产品名 + 最关键属性 + 最强差异点」，其余全部下移到产品亮点 / 五点 / 后台词。\n\n";
}

/** 关键词权重表（已由工具算好，不让模型重算） */
export function buildKeywordBlock(rows, top = 20) {
  if (!rows || !rows.length) return "";
  const list = rows.slice(0, top);
  return "【关键词权重表 · 已由工具按竞品样本统计，直接采用这个结论，不要自己重算】\n" +
    "规则：覆盖率 × 50% + 位置 × 30% + 精准度 × 20%，满分 10 分。\n" +
    "关键词 | 使用率 | 出现条数 | 平均位置 | 权重分 | 用法建议\n" +
    list.map((r) =>
      "- " + r.term + " | " + r.useRate + "% | " + r.cov + "/" + r.total + " | " +
      r.avgPos + " | " + r.weight + " | " + r.advice).join("\n") + "\n\n";
}

/* ─────────────────────── 五类提示词 ─────────────────────── */

function analysisPrompt(ctx) {
  const { product, siteLabel, categoryPath, items } = ctx;
  return buildHead({ product, siteLabel, categoryPath, items }) +
    buildRules({ product }) +
    "请完成以下分析（全程用中文输出）：\n\n" +
    "【一】先做产品对口校验：指出上面哪些竞品标题跟【我的产品】不是一类，为什么。\n\n" +
    "【二】关键词分类：\n" +
    "  - 核心词：决定被搜到的范围（品类词）\n" +
    "  - 修饰词：决定精准度（属性 / 场景 / 人群 / 材质）\n" +
    "  - 每个词标注它出现在几条标题里，按出现条数从高到低排\n\n" +
    "【三】卖点提炼：竞品普遍在强调什么，按覆盖条数排序。\n\n" +
    "【四】差异化机会：哪些卖点／关键词几乎没人提（覆盖 ≤2 条），重点标注 —— 这是我切入的空间。\n\n" +
    "【五】最后单独输出一行「高频词 TOP 10」，格式：词 | 出现条数，方便我直接抄。";
}

function titlePrompt(ctx) {
  const { product, siteLabel, categoryPath, items, rows, isMedia } = ctx;
  const cap = titleLimit({ isMedia });
  return buildHead({ product, siteLabel, categoryPath, items }) +
    buildRules({ product }) + buildRuleTitle({ isMedia }) +
    buildKeywordBlock(rows) +
    "请为我的产品生成 5 个标题候选，每个标题配一段「产品亮点 Item Highlights」。\n\n" +
    "要求：\n" +
    "1. 5 个标题各采用不同角度（功能侧重 / 场景侧重 / 性价比 / 材质安全 / 差异化）\n" +
    "2. 按权重埋词，不要平均用力：\n" +
    "   - 权重 ≥8：必须全部出现，且放标题前 1/3\n" +
    "   - 权重 5–7：放标题中后段\n" +
    "   - 权重 <5：不要写进标题（留给产品亮点或后台词）\n" +
    "3. 每个标题末尾标注字符数，**严格 ≤" + cap + " 字符**\n" +
    "4. 每个标题下面配一段 Item Highlights，**严格 ≤" + LIMITS.itemHighlights + " 字符**，末尾同样标字符数\n" +
    "5. 标题 + 产品亮点合计不超过 " + LIMITS.titleTotal + " 字符\n" +
    "6. 不要堆砌关键词，保证可读性；不要加没在竞品标题里出现过的词\n\n" +
    "输出格式：\n" +
    "【标题 1】<标题内容> （XX 字符）\n" +
    "　└ 产品亮点：<内容> （XX 字符）\n" +
    "……（共 5 组）\n\n" +
    "最后附一行：每个标题用到的权重词清单。";
}

function bulletsPrompt(ctx) {
  const { product, siteLabel, categoryPath, items, rows } = ctx;
  return buildHead({ product, siteLabel, categoryPath, items }) +
    buildRules({ product }) + buildKeywordBlock(rows) +
    "请为我的产品写 " + LIMITS.bulletCount + " 条卖点描述（五点描述 / Bullet Points）。\n" +
    "要求：\n" +
    "1. 每条格式：大写短语标题 + 冒号 + 「功能 → 对用户的好处」的展开\n" +
    "   （例：不是「采用 304 不锈钢」，而是「采用 304 不锈钢，长期接触食物不易生锈，用着安心」）\n" +
    "2. 每条不超过 " + LIMITS.bullet + " 字符，末尾标注字符数\n" +
    "3. 每条对应一个不同卖点，不要重复\n" +
    "4. 优先覆盖竞品没写的差异化点\n" +
    "5. 不要编造规格参数，不确定的用方括号标出来让我补\n\n" +
    "输出格式：\n1. 【大写短语】：正文内容 （XX 字符）";
}

function searchTermsPrompt(ctx) {
  const { product, siteLabel, categoryPath, items, rows } = ctx;
  return buildHead({ product, siteLabel, categoryPath, items }) +
    buildRules({ product }) + buildKeywordBlock(rows) +
    "请为我的产品生成后台搜索词（Search Terms）。\n" +
    "要求：\n" +
    "1. 输出一串关键词，用空格分隔，不要逗号，不要重复词\n" +
    "2. 选词原则：优先放「权重中等（4–7 分）」的词 ——\n" +
    "   权重 ≥8 的词已经写进标题了，重复等于浪费额度；权重 <4 的词不值得占位\n" +
    "3. 严禁包含上面竞品标题里已经原样出现过的词\n" +
    "4. 只输出买家真实可能搜的词，不要品牌词、不要拼写错误词\n" +
    "5. 总长度控制在 " + LIMITS.searchTerms + " **字节**以内（注意：平台按字节计数，" +
    "中文字符占 3 字节；纯英文单词约等于字符数），末尾标注总字节数\n" +
    "6. 优先补充长尾词、场景词、人群词、同义词、单复数变体\n\n" +
    "输出格式：先给一行关键词串，再用一行列出你选中的词及各自权重分。";
}

function localizePrompt(ctx) {
  const { product, siteLabel, categoryPath, items, isMedia, targets } = ctx;
  const cap = titleLimit({ isMedia });
  const langs = (targets && targets.length) ? targets : ["德语", "日语", "西班牙语"];
  return buildHead({ product, siteLabel, categoryPath, items }) +
    buildRules({ product }) + buildRuleTitle({ isMedia }) +
    "请把上述竞品标题体现出的共性，本地化为其他目标市场的标题。\n" +
    "要求：\n" +
    "1. 不是逐字翻译，而是按目标市场的搜索习惯重写\n" +
    "2. 必须标注字符数，**严格不超过 " + cap + " 字符**\n" +
    "3. 保留核心关键词，但换成当地买家的常用说法\n" +
    "4. 注意当地文化禁忌和计量单位习惯（英寸 / 厘米、磅 / 公斤）\n" +
    "5. 超限就主动精简，并在末尾说明砍掉了什么\n\n" +
    "请依次给" + langs.join("版、") + "版。每个语言输出：标题 + 字符数 + 产品亮点 + 本地化替换说明。";
}

const BUILDERS = {
  analysis: analysisPrompt,
  title: titlePrompt,
  bullets: bulletsPrompt,
  searchTerms: searchTermsPrompt,
  localize: localizePrompt,
};

/**
 * 统一入口。
 * @param {"analysis"|"title"|"bullets"|"searchTerms"|"localize"} kind
 * @param {object} ctx {product, siteLabel, categoryPath, items, rows, isMedia, targets}
 * @returns {{ok:boolean, id:string, name:string, prompt:string, meta:object}|{ok:false,error:string}}
 */
export function buildCopyPrompt(kind, ctx = {}) {
  const def = PROMPT_KINDS.find((k) => k.id === kind);
  if (!def) return { ok: false, error: "未知的提示词类型：" + kind };
  if (!ctx.product || !String(ctx.product).trim()) return { ok: false, error: "先把产品名填上 —— 不然 AI 不知道在为谁写" };
  if (def.needsItems && !(ctx.items || []).length) return { ok: false, error: "请先抓取竞品或手动补充标题" };
  if (def.needsKeywords && !(ctx.rows || []).length) return { ok: false, error: "建议先跑一次关键词权重分析 —— 否则提示词里没有埋词依据" };

  const prompt = BUILDERS[kind](ctx);
  return {
    ok: true,
    id: def.id,
    name: def.name,
    prompt,
    meta: {
      kind,
      chars: prompt.length,
      itemCount: (ctx.items || []).length,
      keywordCount: (ctx.rows || []).length,
      titleCap: titleLimit({ isMedia: !!ctx.isMedia }),
      // 出处分级：这一条是"平台公开规则"还是"项目自定义"，界面必须照实标
      tier: kind === "title" || kind === "localize" ? "official+project" : "official",
    },
  };
}
