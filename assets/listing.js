/**
 * Listing 工作台：关键词挖掘 + 文案草稿生成 + 合规质检。
 *
 * 三条设计原则（对齐"跨境 Listing 优化"这个主题的本质）：
 *   1. 平台硬规则（字符数、促销词、特殊符号）必须**机械判定**，不能交给模型"觉得没问题"。
 *      这些是会直接导致 listing 被压制/下架的规则，判错代价高。
 *   2. 生成与质检分离：质检器不关心文案是谁写的（人、AI、竞品），只按规则判。
 *   3. 判据必须可追溯 —— 每条规则都带 why（为什么定这条）和 source（口径来源）。
 *      ⚠️ 区分「平台公开规则」与「项目自定义阈值」，后者显式标注，避免被当成官方标准。
 *
 * 🔴 品类从哪来：直接复用 prompt-engine 的 detectCategory（同一套词表，不重写第二份），
 *    这样"出图时识别的品类"和"质检时用的品类"永远是同一个，不会出现两处结论打架。
 */

// 品类识别 / 语种判定只有一处实现：prompt-engine 的 CATEGORY_WORDS 与 detectScript/detectLang。
// 这里引用，不复制。C3 用 detectScript（要区分"没把握"），detectLang 是二元的兼容入口。
import { detectCategory, detectScript, LANG_SUPPORT } from "./prompt-engine.js";

/* ─────────────────────── 平台常量（来源：亚马逊卖家后台公开规则）─────────────────────── */

/**
 * 🔴 2026-07-27 标题新规：标题从 200 字符砍到 **75 字符**，腾出的额度改由
 *    **Item Highlights**（后台显示名）承载，两个字段构成「两段式标题」。
 *
 * 口径来源（三处互相印证，取**官方开发者文档**为准）：
 *   · Amazon SP-API Developer Docs《Submit modular titles》
 *     —— 字段名与上限是官方白纸黑字：
 *        item_name          ≤ 75 字符   （core product identity）
 *        title_differentiation ≤ 125 字符（Item Highlights）
 *        "The total character limit is **200** across both fields."
 *        "You can only submit title_differentiation when item_name is 75 characters or fewer."
 *   · Seller Central《Product title requirements and guidelines》FAQ
 *   · Seller Central Europe 公告《Updates to improve your product titles begin on July 27》
 *     —— "starting July 27, 2026, titles in all categories **except for media** will need to be
 *        75 characters or less **including spaces**"；Item Highlights "additional 125 characters
 *        for sharing materials or recommended use cases"、"**searchable** and visible with titles
 *        in search results and on product detail pages"。
 *
 * ⚠️ 三条容易被传错、这里刻意写准的细节：
 *  1. **不是"拒收"**。官方原文：超 75（最多 200）**仍可提交且被接受**，Amazon 会
 *     "reconcile … splitting it across item_name and title_differentiation"（自动拆分改写）；
 *     存量 listing 是**渐进式** rollout，你不提交更新就不动它。真实代价是**失去标题控制权**
 *     （拿到的是 AI 建议版本；品牌方有 14 天在 Review Listings Changes 复核），不是报错。
 *  2. **例外只有 media**（图书 / 音乐 / 影像）—— 它仍走 200 且没有 title_differentiation。
 *  3. **Item Highlights 生效有前置条件**：title 必须 ≤75 才能提交该字段。
 *     所以"标题压到 76 字符、Highlights 写满"是最差的组合 —— 两边都落空。
 *
 * 🔴 titleStrict 是**项目自定义**的保守口径，不是平台规则：75 是硬顶，但标题一旦踩到 76
 *    就同时丢掉 Item Highlights 的提交资格，所以生成草稿时按 70 留 5 字符余量。
 */
export const LIMITS = {
  title: 75,             // 平台硬上限（普通类目，2026-07-27 生效，含空格）
  titleMedia: 200,       // 唯一例外：media 类目（图书 / 音乐 / 影像）仍是 200
  itemHighlights: 125,   // Item Highlights 上限（后台显示名；API 属性名 title_differentiation）
  titleTotal: 200,       // 标题 + Item Highlights **合计**上限（官方明文，两张字段共享 200）
  titleStrict: 70,       // 项目自定义保守口径：给硬顶留 5 字符余量
  bullet: 500,           // 单条五点描述上限
  bulletCount: 5,        // 标准五点数量
  searchTerms: 250,      // Search Terms 字节上限（注意是 byte 不是 char）
  description: 2000,
};

/**
 * 标题上限随类目口径变化 —— media 是**唯一**例外，其它一切类目都是 75。
 * 抽成函数而不是在三处各写一遍三元：口径只有一处，界面和规则不会打架。
 */
export function titleLimit(ctx = {}) {
  return ctx.isMedia ? LIMITS.titleMedia : LIMITS.title;
}

/**
 * 口径来源：亚马逊官方《Misleading and prohibited claims》(Seller Central 帮助页 202024200)
 * 中 "Comparison & superlatives" 一节 —— 直接或隐含的比较、以及 best / 100% pure / guaranteed
 * 这类最高级表述，**只有在有客观可核实证据时**才能使用；listing 文案里默认按风险处理。
 * 另外三类平台明确禁止卖家挪用的词：
 *   · 徽章词（Amazon's Choice / Best Seller / #1）—— 是平台自有标识，卖家不得写进文案；
 *   · 大促名（Prime Day / Black Friday / Cyber Monday）—— 商标受限；
 *   · 促销/价格表述（free shipping / sale / buy now）—— 不属于标题与五点该有的内容位。
 *
 * ⚠️ 为什么**没有**收 `perfect`：`perfect for gifting` 是海量合规 listing 的正常写法，
 *    硬禁会产生大面积误报，误报会直接消耗对质检器的信任。同理不收 `#`/`%`/`+`
 *    （`Model #A` / `100% Cotton` / `2+1 Pack` 都是合法高频写法），另用 C7 符号密度规则兜。
 */
export const PROMO_WORDS = [
  // A. 价格与促销表述
  "free shipping", "free delivery", "free gift", "free returns", "sale", "on sale",
  "hot sale", "clearance", "discount", "cheap", "cheapest", "lowest price", "price drop",
  "buy now", "order now", "limited time", "limited offer", "new arrival", "just launched",
  "flash sale", "lightning deal", "deal of the day", "clearance sale",
  // B. 最高级 / 绝对化（无证据即违规）
  "best", "bestseller", "best seller", "top rated", "top seller",
  "#1", "no.1", "number one",
  // C. 平台徽章词（卖家不得挪用平台标识）
  "amazon's choice", "amazon choice", "amazon best seller", "amazon's best seller",
  "#1 best seller", "editor's choice", "editors choice",
  // D. 大促名（商标受限，需授权）
  "prime day", "black friday", "cyber monday", "big deal days",
];

/**
 * 标题 / 五点里不该出现的特殊符号。
 *   · 前一组（! ? $ _ { } ^ ¬ ¦ ~ * ★ ☆ ✅ 🔥 @）＝平台明列 + 表情符号解析风险；
 *   · 后一组（| < > `）＝**本项目补充**，理由是解析与注入风险：
 *     `|` 会被当成表格分隔符、`<`/`>`/`` ` `` 会被当标记/代码，
 *     而且在"导出为 HTML 预览 / 粘贴到表格"的链路上是现成的注入面。
 */
export const BAD_SYMBOLS = [
  "!", "?", "$", "_", "{", "}", "^", "¬", "¦", "~", "*", "★", "☆", "✅", "🔥", "@",
  "|", "<", ">", "`",
];

/**
 * HTML / 脚本标记 —— 单列成规则，因为它是**双重风险**：
 *   ① 合规：亚马逊会拒绝或清洗标题里的 HTML/脚本；
 *   ② 安全：这条文案在"导出 HTML 预览 / 复制到别处"的链路上会被当代码执行。
 * 用不区分大小写的模式，且不要求闭合标签也命中（只要出现 `<xxx` 开头就算）。
 */
export const HTML_MARKERS = [/<[a-z!/]/i, /<\/(?:p|b|i|br|span|div|a|script|style)\s*>/i, /javascript:/i, /on(?:error|load|click)\s*=/i, /&#\d+;/];

/**
 * 站外引流 / 联系方式 —— **无歧义**的那批，定 P 级。
 *
 * 口径：卖家行为准则 + 《Misleading and prohibited claims》明列禁止在 listing 中出现
 *   ① 站外链接与网址（把买家带离亚马逊）
 *   ② 邮箱 / 电话等可直接联系的方式
 *   ③ 引导"访问我的网站 / 联系客服"的措辞
 * 为什么值得单列成规则：这类内容**不是"措辞好不好"的问题，而是入口级违规** ——
 * 被抓住是绩效问题，不是优化建议。而它又完全可以机械判定，正合本项目"硬规则不交给模型"的原则。
 *
 * ⚠️ 刻意**不**把裸 `@`、`#` 收进来：`@` 已在 BAD_SYMBOLS 里按符号管，裸 `#` 有
 *    `Model #A` 这类合法写法。邮箱必须写成 `local@domain.tld` 形态才算。
 */
export const OFF_SITE_PATTERNS = [
  { re: /\bhttps?:\/\/\S+/i, label: "网址（http/https）" },
  { re: /\bwww\.[a-z0-9-]+(?:\.[a-z]{2,})+/i, label: "网址（www.）" },
  { re: /\b[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/i, label: "邮箱地址" },
  { re: /\b(?:visit|check out|shop at|order from|buy from)\s+(?:our|my|the)?\s*(?:website|web site|site|store|shop|online store)\b/i, label: "引导去站外店铺" },
  { re: /\b(?:contact us|email us|call us|reach us|message us)\b/i, label: "引导联系（contact/email/call us）" },
  { re: /(?:扫码|扫一扫|加微信|加微|微信号|联系方式|联系客服|关注公众号|私聊)/, label: "中文站外引流用语" },
];

/**
 * 疑似电话 / 社交平台名 —— **有歧义**，定 C 级（提示人工确认），不进硬规则。
 *
 * 为什么不硬禁电话：`\d{9,}` 这种形态在**规格类文案**里是合法的 ——
 * 「350-500-1000」这种三段规格串数字量就到 10 位，硬禁会大面积误报。
 * 所以这里只挑"形态更像电话"的：带 `+` 区号、带括号、或含分隔符且数字量 9–15 位。
 * 判不准就报"疑似 + 请人工确认"，不报"违规" —— 宁可弱一点，也不能让质检器说假话。
 */
export const SOFT_CONTACT_PATTERNS = [
  { re: /\+\d[\d\s().-]{7,}\d/, kind: "带国际区号的号码" },
  { re: /\(\d{2,4}\)\s*\d{3,4}[-\s]?\d{3,4}/, kind: "带括号的号码" },
  { re: /\b(?:whatsapp|wechat|weixin|telegram|skype|line id|viber|messenger)\b/i, kind: "站外社交/通讯应用名" },
  { re: /\b(?:facebook|instagram|tiktok|youtube|twitter|linkedin|pinterest|snapchat)\b/i, kind: "站外社交平台名" },
];

/**
 * 标题里的**主观修饰词**（官方《Product title requirements》的 "Subjective commentary" 一节：
 * 不要用主观表述，官方举例 HOT ITEM / BEST SELLER）。
 *
 * ⚠️ 边界要说清楚：**官方只给了原则和两个例子，没给词表**；下面这张表是本项目按该原则自定的。
 *    所以定 **C 级**（提示），不是硬规则。
 * 🔴 为什么在 75 字符时代这件事变重要了：标题额度被砍到 75，"Premium" 一个词就吃掉
 *    8 个字符（约 11%），而它不提供任何可供搜索的区分信息 —— 字符预算第一次变得这么贵。
 * 与 PROMO_WORDS 重叠的词（best seller / top rated）只在 PROMO_WORDS 报，这里不重复。
 */
export const SUBJECTIVE_TITLE_WORDS = [
  "premium", "high quality", "high-quality", "best in class", "top quality",
  "professional grade", "professional-grade", "amazing", "hot item", "must have",
  "must-have", "world class", "world-class", "unbeatable", "superior quality",
  "quality guaranteed", "top of the line", "cutting edge", "cutting-edge",
];

/**
 * 保证性 / 绝对化 / 医疗承诺用语（易触发合规问题）。
 * 🔴 "guarantee" 必须单列裸词 —— 只写 "guaranteed results" 会漏掉 "100% GUARANTEE"，
 *    而裸词恰恰是卖家最常写、平台最常抓的形态（回归测试曾漏报这里）。
 */
export const CLAIM_WORDS = [
  // 保证性 / 绝对化
  "guarantee", "guaranteed", "money back", "100% guarantee", "100% safe", "100% pure",
  "100% satisfaction", "satisfaction guaranteed", "risk free", "risk-free",
  "no side effects", "side effect free", "clinically proven", "clinically tested",
  "doctor recommended", "doctor approved", "medically proven", "medically approved",
  "hospital grade", "medical grade", "pharmaceutical grade", "scientifically proven",
  "proven to", "instantly", "permanently", "eliminates all", "kills 99",
  // 医疗 / 治疗动词
  "cure", "cures", "curative", "heal", "heals", "healing", "treat", "treats", "treating",
  "treatment", "therapy", "therapeutic", "diagnose", "remedy", "prescription",
  "detox", "detoxify", "immunity booster", "immune system boost", "weight loss",
  "fat burner", "appetite suppressant", "antibiotic",
  // 认证类（需举证，无凭证即违规）
  "fda approved", "fda cleared", "fda registered", "fda certified",
  "usda organic", "made in usa", "made in the usa", "gmp certified",
  // 中文（工作台允许中文草稿）
  "包治", "根治", "治愈", "治疗", "疗效", "药效", "防癌", "抗癌", "无副作用",
  "永久有效", "立竿见影", "权威认证", "国家免检",
];

/**
 * 🔴 疾病 / 抗菌 / 农药类声明词表。
 *
 * 口径来源：亚马逊官方《Misleading and prohibited claims》(202024200) 的
 * 「Prohibited Product Claims for Diseases」逐条列表 —— 未经 FDA 批准，
 * **不得声称诊断/治愈/缓解/治疗/预防**下列疾病。原文还单列了三块同类：
 *   · Environmental claims（环境声明，需 FTC Green Guides 级别的证据）
 *   · Pesticide claims（农药：prevent / destroy / repel / mitigate a pest）
 *   · FDA claims（FDA Cleared / approved / logo 需满足额外要求）
 *
 * ⚠️ 官方表里有 7 个词**被本项目刻意剔除**，因为它们在日常英语/商品语境里是高频正常词，
 *    收进来会让质检器天天误报（误报＝工具失去信任）：
 *      `add`   → 会命中 "Add to cart"、"Add-on"
 *      `sad`   → 会命中所有 "Sad puppy" 类玩具/绘本描述
 *      `mono`  → 会命中音频设备的 "mono output"
 *      `pid`   → 会命中温控器的 "PID controller"
 *      `crabs` → 会命中海鲜与螃蟹玩具
 *      `tbi` / `ngu` → 纯缩写、日常无意义且非疾病全称，收益为零
 *    对应地保留其**无歧义全称**：attention deficit / seasonal affective disorder /
 *    mononucleosis / pelvic inflammatory disease / pubic lice / traumatic brain injury。
 *    抗细菌/抗真菌/抗微生物三词按平台的"农药声明"归类，见 PESTICIDE_CLAIMS。
 *
 * ⚠️ `stroke`（中风）与 `gout` 在极少数语境下有日常义（画笔的"笔触"），
 *    所以规则文案写「疑似」并要求人工确认，不写「确定违规」。
 */
export const DISEASE_TERMS = [
  "aids", "acquired immune deficiency syndrome", "addictive substance withdrawal",
  "als", "amyotrophic lateral sclerosis", "lou gehrig",
  "alzheimer", "alzheimer's",
  "attention deficit", "adhd",
  "autism", "cancer", "cancroid", "cataract", "celiac", "chlamydia", "concussion",
  "coronavirus", "covid-19", "covid", "crohn", "crohn's", "cystic fibrosis",
  "cytomegalovirus", "cmv", "dementia", "depression", "diabetes", "diabetic",
  "diabetic neuropathy", "epilepsy", "flu", "influenza", "glaucoma", "gonorrhea",
  "gout", "hepatitis", "herpes", "hsv1", "hsv2", "hodgkin", "hodgkin's lymphoma",
  "hiv", "hpv", "human immunodeficiency virus", "human papilloma virus",
  "kidney cirrhosis", "kidney disease", "liver disease", "lupus",
  "lymphogranuloma venereum", "lgv", "meningitis", "monkeypox", "mononucleosis",
  "multiple sclerosis", "muscular dystrophy", "mycoplasma genitalium", "nano silver",
  "nongonococcal urethritis", "obesity", "parkinson", "parkinson's",
  "pelvic inflammatory disease", "pubic lice", "scabies",
  "seasonal affective disorder", "seizure", "seizures", "stroke", "syphilis",
  "traumatic brain injury", "traumatic brain injuries", "trichomoniasis", "tumor", "tumour",
];

/**
 * 农药 / 抗菌 / 消毒类声明（口径：Pest control products and pesticides policy）。
 * 这类词不是"不能写"，而是"写了就进入需注册/需举证的范畴"，标题与五点里默认应删。
 */
export const PESTICIDE_CLAIMS = [
  "antibacterial", "anti-bacterial", "antimicrobial", "anti-microbial", "antifungal", "anti-fungal",
  "insecticide", "pesticide", "rodenticide", "fungicide", "herbicide", "repellent",
  "disinfectant", "disinfects", "sanitizer", "sterilizer", "sterilizes",
  "kills germs", "kills bacteria", "kills viruses", "kills insects", "kills bugs",
  "repels pests", "repels insects", "repels mosquitoes", "pest control", "germ free",
];

/**
 * 环境声明（口径同上：Environmental claims 一节）。
 * ⚠️ 平台并未"一律禁止"，要求的是**真实、不误导、有证据**（FTC Green Guides）。
 *    所以这条定成 **C（软规则）**，文案是"需备好证据"，不是"必须删"。
 */
export const ENV_CLAIMS = [
  "eco-friendly", "eco friendly", "environmentally friendly", "sustainable", "sustainability",
  "biodegradable", "compostable", "carbon neutral", "carbon-neutral", "zero waste",
  "100% recyclable", "recycled content", "plastic free", "plastic-free", "green product",
  "climate friendly", "cruelty free", "cruelty-free", "vegan",
];

/**
 * "不证自明"声明（口径：平台"不证自明的声明"一节）——
 * 把**强制性/通用特征**包装成卖点来营销是被禁止的：
 * "CE 认证""不含有毒材料""已通过有害物质检测""BPA free" 这类。
 * ⚠️ 同样定 C：BPA free 在很多类目被普遍接受，硬禁会误伤，但需要提示风险。
 */
export const SELF_EVIDENT_CLAIMS = [
  "ce certified", "ce marked", "ukca", "rohs", "reach compliant",
  "non-toxic", "nontoxic", "non toxic", "toxin free", "toxin-free",
  "tested for harmful substances", "no harmful substances",
  "bpa free", "bpa-free", "phthalate free", "lead free", "food safe", "food-safe",
];

/**
 * 品类差异化词表：同一个词在不同品类风险完全不同。
 * 例：`antibacterial` 用在厨房清洁剂上是**必需**的注册声明，用在袜子上就是违规抗菌宣传；
 *     `detox` 用在普通食品上是健康声明违规，用在"砧板去味"文案里则是擦边表述。
 * 这里只补「该品类**额外**要盯的词」；通用表（疾病/保证性/促销）仍然全品类生效。
 * 键名与 prompt-engine 的 CATEGORY_WORDS 保持一致，方便共用 detectCategory 的结果。
 */
export const CATEGORY_CLAIMS = {
  beauty: {
    words: ["anti-aging", "anti aging", "anti-wrinkle", "anti wrinkle", "wrinkle", "acne", "pimple",
      "eczema", "psoriasis", "rosacea", "hair loss", "hair regrowth", "baldness", "cellulite",
      "whitening", "skin lightening", "collagen boost", "dermatologist tested", "hypoallergenic"],
    why: "美妆个护里的「抗老/祛痘/生发/美白」属于药品或疗效声明，无 FDA 批准即违规；dermatologist tested 属于需举证的功效声明。",
  },
  food: {
    words: ["detox", "detoxifies", "immunity", "immune", "superfood", "weight loss", "slimming",
      "fat burning", "cholesterol", "blood sugar", "blood pressure", "hangover", "organic",
      "natural cure", "probiotic", "antioxidant rich"],
    why: "食品/保健品的健康与营养声明必须在官方注册簿内（英/欧为 NHC 注册簿），自造功效声明是高风险区；organic 需有机认证凭证。",
  },
  pet: {
    words: ["vet approved", "veterinarian approved", "vet recommended", "veterinarian recommended",
      "flea", "flea treatment", "tick", "dewormer", "deworming", "parasite", "antiparasitic",
      "pet supplement cures", "hip dysplasia", "arthritis"],
    why: "宠物用品的驱虫/寄生虫/关节类表述同时踩「动物疾病声明」与「农药声明」两条线，且 vet approved 类背书需可核实。",
  },
  home: {
    words: ["disinfect", "disinfectant", "sterilize", "sanitize", "kills germs", "germ free",
      "mold removal", "mildew", "antibacterial", "sterilization"],
    why: "家居清洁类一旦宣称杀菌/消毒/除霉，即进入 EPA 农药与抗菌产品注册范畴，普通家居品不允许这样写。",
  },
  electronics: {
    words: ["anti-radiation", "anti radiation", "radiation free", "emf protection", "emf blocker",
      "blocks radiation", "cancer prevention", "medical device"],
    why: "电子类宣称防辐射/阻断电磁波属于无依据的健康声明；宣称医疗器械属性还需要器械注册。",
  },
  fashion: {
    words: ["antibacterial", "antimicrobial", "hypoallergenic", "antibiotic", "healing fabric"],
    why: "纺织品的抗菌/防过敏表述需要检测报告支撑，且抗菌属于农药类声明范畴。",
  },
  jewelry: {
    words: ["healing", "heals", "chakra", "aura", "energy balance", "crystal therapy",
      "feng shui cure", "lucky stone cures"],
    why: "首饰类的「能量/疗愈/脉轮」表述是玄学疗效声明，平台按误导性健康声明处理。",
  },
  outdoor: {
    words: ["lifetime warranty", "lifetime guarantee", "100% waterproof", "waterproof guarantee"],
    why: "户外类的永久质保/绝对防水属于需举证的绝对化承诺，写进标题即可能被判误导。",
  },
};

/** 判定是否出现 HTML/脚本标记；命中返回命中的片段，未命中返回 "" */
export function findHtmlMarkers(text) {
  const s = String(text || "");
  for (const re of HTML_MARKERS) {
    const m = re.exec(s);
    if (m) return m[0];
  }
  return "";
}

/**
 * 按「词边界」匹配词表。
 * 🔴 不能用 includes —— "secure"/"manicure" 会命中 "cure"、"freedom" 会命中 "free"。
 * 质检器误报会直接消耗对工具的信任，宁可多写一行正则。
 */
export function matchWords(text, words) {
  const t = String(text || "").toLowerCase();
  return words.filter((w) => {
    const wl = String(w).toLowerCase().trim();
    if (!wl) return false;
    const esc = wl.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${esc}(?![a-z0-9])`).test(t);
  });
}

/** 英文基础停用词（原表，**未改动** —— 保证既有行为零回归）。 */
const STOPWORDS_EN = ("a an the and or but for with without of to in on at by from as is are was were be been being this that these those it its your you our we they them their he she his her not no nor so than then too very can will just do does did doing have has had having i me my mine more most other some such only own same s t don now d ll m o re ve y ain aren couldn didn doesn hadn hasn haven isn ma mightn mustn needn shan shouldn wasn weren won wouldn").split(" ");

/**
 * 其他语种的停用词（按语种分开，**不合并**）。
 *
 * 🔴 为什么不能并成一张大表：这些词与英语**同形但异义**，合并就会把卖家的真实关键词删掉 ——
 *    car(法=因为，英=车)、son(法=他的，英=儿子)、main(法=手，英=主要的)、
 *    man(德=人称代词，英=男人)、kind(德=孩子，英=种类)、tag(德=天，英=标签)、
 *    arm/band/ring/boot/hand/note/tank/rock/will/war/in(德英同形)。
 *    所以：① 每张表**手工排除了与英文同形的词**；② 只有显式指定语种时才生效。
 *    这正是「误报＝工具失信」那条铁律在词表层的样子。
 *
 * ⚠️ 一个**有意为之的例外**：`die` 保留在 de / nl 表里。
 *    它是德语/荷兰语第一大虚词（der/die/das），去掉它这两门语言的挖掘基本白做；
 *    代价是英语的 "die cut stickers" 里的 die 会被一起清掉。
 *    这个取舍在自检里有断言固定（`已知取舍被写下来而不是藏着：die 留在 de/nl 表里`），
 *    别"顺手"删掉它 —— 删了要连那边一起改。
 */
export const STOPWORDS_BY_LANG = {
  // ⚠️ 刻意不收 war/waren：德语过去式在商品文案里几乎不出现，
  //    而 war 是英语里的真词（war hammer / war game）—— 收益远小于误删风险。
  de: "und der die das den dem des ein eine einen einem einer eines mit für ohne auf aus bei nach von vom zum zur über unter zwischen durch gegen ist sind sein seine seinen ihrem ihren wird werden wurde nicht kein keine keinen oder aber auch sehr mehr meist sowie damit dass dieser diese dieses wenn wie als nur noch schon sich sie ihr ihre wir uns kann können bzw ca inkl inklusive ggf evtl".split(" "),
  // ⚠️ 刻意不收 son（法/西=他是/他们是）：son 是英语里的真词（son gifts / dad & son）。
  fr: "le la les un une des du de et ou pour avec sans sur sous dans par au aux en est sont etre être ce cet cette ces votre vos notre nos mon ma mes tout tous toute toutes aussi tres très mais comme qui que dont ne pas se sa ses il elle ils elles nous vous chez vers depuis pendant entre chaque autre meme même ainsi alors donc".split(" "),
  // ⚠️ 刻意不收 son / era / eran：这三个都是英语真词（son、Victorian era），
  //    而西语的产品文案几乎不用过去时，收进去是净损失。
  es: "el la los las un una unos unas de del y o para con sin sobre bajo en por al es ser estar este esta estos estas su sus nuestro nuestra muy mas más pero como que quien donde no se le les lo ni también tambien cada otro misma mismo entre desde hasta según segun además ademas".split(" "),
  it: "il lo la gli le un uno una di del della dei degli delle per con senza su sotto in al allo alla agli alle sono essere questo questa questi queste suo sua suoi loro molto più piu ma come che chi dove non si mi ti ci vi né ne anche ogni altro stessa stesso tra fra da fino secondo inoltre".split(" "),
  nl: "de het een en of voor met zonder op aan bij naar uit onder tussen tegen zijn waren wezen deze die dit dat uw ons onze mijn meer meest ook maar zeer als dan nog al niet geen ofwel zodat omdat zoals terwijl hun zij wij kan kunnen worden werd".split(" "),
  // 日文：本工具不引入分词词典（几 MB 依赖，违背零依赖），
  // 所以只清掉"两字以上的助词/机能语"，剩下的实词照旧按空格切分。
  ja: "から まで より など こと もの する され した して です ます ある いる この その あの これ それ あれ また および 及び ならびに 並びに ため 場合 つき 付き について による として において における さらに それぞれ すべて 全て とても たいへん".split(" "),
};

/**
 * 站点 → 语种。只覆盖"标题里会大量出现当地虚词"的站点；
 * 不在表里的站点一律走英文表（= 旧行为），所以加这张表不会改变任何现有结果。
 */
export const SITE_LANG = {
  "amazon.de": "de", "amazon.at": "de",
  "amazon.fr": "fr",
  "amazon.es": "es",
  "amazon.it": "it",
  "amazon.nl": "nl", "amazon.com.be": "nl",
  "amazon.co.jp": "ja",
};

/** 某语种的停用词集合（英文基础 + 该语种补充）。语种不认识 → 只返回英文表。 */
export function stopwordsFor(lang) {
  const k = String(lang || "").toLowerCase().slice(0, 2);
  const extra = STOPWORDS_BY_LANG[k] || [];
  return new Set([...STOPWORDS_EN, ...extra]);
}

/** 兼容旧调用点（C5 规则等）——英文集合，行为与改动前一致。 */
const STOPWORDS = new Set(STOPWORDS_EN);

/** 是否含中日韩文字（用来判断"这堆 token 根本没法切词"）。 */
const CJK_RE = /[\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/;


/* ─────────────────────── 关键词挖掘 ─────────────────────── */

/**
 * 从一段文本（竞品标题+五点、类目页文案、评论）挖掘关键词。
 * 做法：清洗 → 去除停用词 → 统计 1/2/3-gram 频次 → 按「频次 × 长度权重」排序。
 * 不调 LLM —— 词频是可复现的客观量，交给模型反而不可验证。
 *
 * @param {string} text
 * @param {{top?:number, minCount?:number, includeNgrams?:boolean, lang?:string}} opts
 *   `lang` 传站点语种（如 "de" / "ja"），会额外套用该语种的停用词；
 *   不传 = 只套英文表 = 改动前的行为。
 */
export function mineKeywords(text, { top = 40, minCount = 1, includeNgrams = true, lang = "" } = {}) {
  const stop = stopwordsFor(lang);
  const clean = String(text || "")
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, " ")
    // 🔴 用 \p{L}\p{N} 而不是 a-z0-9：否则 amazon.de 的 "für" 会被拆成 "fr"、
    //    法语 "qualité" 变 "qualit"、日语标题整段消失 —— 词频表里全是残词。
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = clean.split(" ").filter((w) => w && w.length > 1 && !stop.has(w) && !/^\d+$/.test(w));

  const counts = new Map();
  const bump = (k, w) => counts.set(k, (counts.get(k) || 0) + w);

  for (const t of tokens) bump(t, 1);
  if (includeNgrams) {
    for (let n = 2; n <= 3; n++) {
      for (let i = 0; i + n <= tokens.length; i++) {
        const gram = tokens.slice(i, i + n).join(" ");
        // 只保留两端都不是停用词的 n-gram，避免 "of the" 这类噪声
        if (stop.has(tokens[i]) || stop.has(tokens[i + n - 1])) continue;
        bump(gram, n === 2 ? 1.4 : 1.2);
      }
    }
  }

  const list = [...counts.entries()]
    .filter(([, v]) => v >= minCount)
    .map(([term, weight]) => ({ term, weight: +weight.toFixed(2), words: term.split(" ").length, chars: term.length }))
    .sort((a, b) => b.weight - a.weight || b.words - a.words)
    .slice(0, top);

  const cjkTokens = tokens.filter((w) => CJK_RE.test(w));
  const cjkShare = tokens.length ? cjkTokens.length / tokens.length : 0;

  return {
    terms: list,
    stats: {
      inputChars: String(text || "").length,
      tokens: tokens.length,
      uniqueTokens: new Set(tokens).size,
      topTerm: list[0]?.term || null,
      cjkTokens: cjkTokens.length,
    },
    // 🔴 必须显式声明这不是搜索量 —— 否则用户会把 weight 当成"月搜索量"去排序投放预算。
    //    词频高只说明"竞品文案里这个词出现得多"，与真实搜索需求是两件事。
    //    要真实搜索量只能接官方 Brand Analytics / 第三方关键词工具。
    note: "这是**词频**权重，不是搜索量、不是竞争度、不是转化率。它只回答「竞品文案里哪些词反复出现」，属于选词的第一层筛子。真实搜索量需另接官方 Brand Analytics 或第三方关键词工具。",
    // 诚实边界：中日文没有空格，本工具不装分词词典（MeCab/Kuromoji 都是几十 MB，
    // 违背"零依赖"）。所以 CJK 连续串会整体当一个 token —— 高频短语仍可读，
    // 但**词形切分不可靠**。这时给用户一句明说，而不是让他把噪声当结论。
    scriptNote: cjkShare > 0.3
      ? `这段语料里 ${Math.round(cjkShare * 100)}% 的词是中日文连续串。本工具不做分词（不引入词典依赖），所以这些"词"是整段连写、只能当短语看：**频次可参考，词形不可直接拿去填 Search Terms**。要精确切词请用日语/中文分词工具。`
      : "",
    disclaimer: {
      isSearchVolume: false,
      measures: "输入语料内的加权词频（1-gram 权重 1，2-gram 1.4，3-gram 1.2）",
      doesNotMeasure: ["搜索量", "搜索排名", "竞争度", "转化率", "季节性"],
    },
  };
}

/** Search Terms 字段专用：去重、去品牌、去标点、按字节算长度 */
export function buildSearchTerms(terms, { exclude = [], limit = LIMITS.searchTerms } = {}) {
  const ex = new Set(exclude.map((e) => String(e).toLowerCase().trim()).filter(Boolean));
  const seen = new Set();
  const kept = [];
  let bytes = 0;
  const dropped = [];
  for (const t of terms) {
    // 🔴 保留 \p{L}\p{N}（而不是只留 a-z0-9）：亚马逊允许带变音符的词，
    //    而 DE/FR 站的 "für"/"qualité"、JP 站的日文词被剥掉就只剩残词，
    //    等于把用户真实要投的词静默改错。字节数由 byteLength 按 UTF-8 算，不虚报。
    const term = String(t).toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, "").trim();
    if (!term || seen.has(term)) continue;
    if (ex.has(term) || [...ex].some((e) => e && term.includes(e))) { dropped.push({ term, why: "含品牌词" }); continue; }
    const b = byteLength(term + (kept.length ? " " : ""));
    if (bytes + b > limit) { dropped.push({ term, why: `超出 ${limit} 字节上限` }); continue; }
    seen.add(term);
    kept.push(term);
    bytes += b;
  }
  return { value: kept.join(" "), terms: kept, bytes, limit, dropped };
}

/** 计算 UTF-8 字节数（Search Terms 是 byte 限制，中文字符不能按 char 算） */
function byteLength(s) {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    // 4 字节档不能漏：emoji 与 CJK 扩展 B 区（如「𠀋」）都是 4 字节，漏了就会低估长度
    n += c > 0x7f ? (c > 0xffff ? 4 : c > 0x7ff ? 3 : 2) : 1;
  }
  return n;
}
export { byteLength };

/* ─────────────────────── 质检规则表 ─────────────────────── */

export const LEVELS = { P: "硬规则（平台级，直接对应限制/压制风险）", C: "软规则（转化/可读性，影响点击与转化）" };

/**
 * 每条规则：
 *   id / level / scope / test(value, ctx) → {hit, detail}
 *   why    —— 为什么定这条
 *   source —— "平台公开规则" | "项目自定义" | "行业通行做法"
 *
 * scope 四档：
 *   title       标题
 *   bullets     五点（数组）
 *   searchTerms Search Terms
 *   copy        标题 + 五点拼成的整块文案 —— 合规类规则（声明/HTML）看这一整块，
 *               因为"标题干净但五点写疗效"是最常见的绕过形态。
 */
export const RULES = [
  {
    id: "P1", level: "P", scope: "title", source: "平台公开规则（2026-07-27 生效）",
    why: `标题上限 75 字符（含空格，media 类目除外）。超限的真实后果要写准：**不是"被拒收"** —— 官方原文是超 75（最多 200）仍可提交并被接受，但 Amazon 会按 AI 建议**自动拆分改写**你的标题，你拿到的是它给的版本（品牌方另有 14 天复核期）。也就是说，超限的代价是**失去标题控制权 + 丢掉 Item Highlights 的提交资格**（官方：只有 item_name ≤75 才能提交 title_differentiation），不是报错。`,
    test: (v, ctx) => {
      const cap = titleLimit(ctx);
      const scope = ctx.isMedia ? "media 类目" : "普通类目";
      return { hit: v.length > cap, detail: `${v.length} 字符 / 上限 ${cap}（${scope}）` };
    },
  },
  {
    id: "P2", level: "P", scope: "title", source: "平台公开规则",
    why: "标题含促销词 / 最高级 / 平台徽章词（free shipping、best seller、Amazon's Choice）属于违规表述：前两类无证据即误导，后一类是挪用了平台自有标识。",
    test: (v) => {
      const found = matchWords(v, PROMO_WORDS);
      return { hit: found.length > 0, detail: found.join(", ") || "无" };
    },
  },
  {
    id: "P3", level: "P", scope: "title", source: "平台公开规则",
    why: "特殊符号（! ? $ _ | < > 等）会造成解析异常，且平台明文不建议使用；< > ` 另有注入风险。",
    test: (v) => {
      const found = BAD_SYMBOLS.filter((s) => v.includes(s));
      return { hit: found.length > 0, detail: found.join(" ") || "无" };
    },
  },
  {
    id: "P4", level: "P", scope: "title", source: "项目自定义（保守口径）",
    why: `标题踩到 76 字符就会**同时丢掉两样东西**：Item Highlights 的提交资格，以及标题的自主权（会被 AI 建议改写）。所以按 ${LIMITS.titleStrict} 字符留 ${LIMITS.title - LIMITS.titleStrict} 字符余量 —— 后面想补一个规格、换一个核心词，都不会当场越线。⚠️ 这 ${LIMITS.titleStrict} 是本项目自定的，不是平台规则；media 类目不走这条。`,
    test: (v, ctx) => {
      if (ctx.isMedia) return { skip: true, detail: "media 类目，不适用 75 口径" };
      return { hit: v.length > LIMITS.titleStrict && v.length <= LIMITS.title, detail: `${v.length} 字符 > 建议 ${LIMITS.titleStrict}（离硬顶还剩 ${LIMITS.title - v.length}）` };
    },
  },
  {
    id: "P5", level: "P", scope: "title", source: "平台公开规则",
    why: "标题应避免全大写（ALL CAPS），平台会判为不规范并影响可读性。",
    test: (v) => {
      const letters = v.replace(/[^A-Za-z]/g, "");
      if (letters.length < 8) return { skip: true, detail: "字母过少（<8），无判定意义" };
      const upper = v.replace(/[^A-Z]/g, "").length;
      return { hit: upper / letters.length > 0.6, detail: `大写占比 ${(upper / letters.length * 100).toFixed(0)}%` };
    },
  },
  {
    id: "P6", level: "P", scope: "copy", source: "平台公开规则",
    why: "禁止性声明三桶：①疾病/医疗（亚马逊官方 202024200 明列 80+ 疾病名，未经 FDA 批准不得声称诊断/治愈/缓解/治疗/预防）②农药/抗菌（进入 EPA 注册范畴）③保证性绝对化（guarantee / 100% safe / clinically proven，无客观证据即误导）。⚠️ stroke 等少数词有日常义，命中后需人工确认。",
    test: (v, ctx) => {
      const buckets = [];
      const dis = matchWords(v, DISEASE_TERMS);
      const pes = matchWords(v, PESTICIDE_CLAIMS);
      const clm = matchWords(v, CLAIM_WORDS);
      if (dis.length) buckets.push(`疾病/医疗声明：${dis.join(", ")}`);
      if (pes.length) buckets.push(`农药/抗菌声明：${pes.join(", ")}`);
      if (clm.length) buckets.push(`保证性/绝对化：${clm.join(", ")}`);
      // 品类差异化：同一词在不同品类风险不同（抗菌用在清洁剂是必需、用在袜子上是违规）
      const cat = ctx.category || detectCategory(v).category;
      const extra = cat && CATEGORY_CLAIMS[cat] ? matchWords(v, CATEGORY_CLAIMS[cat].words) : [];
      if (extra.length) buckets.push(`品类(${cat})专属高风险：${extra.join(", ")}`);
      return { hit: buckets.length > 0, detail: buckets.join(" ｜ ") || "无", category: cat || null };
    },
  },
  {
    id: "P7", level: "P", scope: "bullets", source: "平台公开规则",
    why: `单条五点超过 ${LIMITS.bullet} 字符会被截断，尾部内容在移动端不可见。`,
    test: (v) => ({
      hit: v.some((b) => b.length > LIMITS.bullet),
      detail: v.map((b, i) => `第${i + 1}条 ${b.length}`).join(" / "),
    }),
  },
  {
    id: "P8", level: "P", scope: "bullets", source: "平台公开规则",
    why: "五点是产品属性描述位，写入价格/促销/物流信息属于违规内容。",
    test: (v) => {
      const found = matchWords(v.join(" "), PROMO_WORDS);
      return { hit: found.length > 0, detail: found.join(", ") || "无" };
    },
  },
  {
    // ⚠️ 原编号 P9，2026-09-28 降级为软规则（C9）：
    //    「大写引导词 + 冒号」是**行业惯例**，不是平台硬规则 —— 没有任何平台文档要求这么做。
    //    把惯例放硬规则会让"五点全过、只有格式不合惯例"的 listing 被报成"发布前必须修改"，
    //    结论强度与真实风险不匹配。同时放宽正则，允许首词后接小写（"Easy to clean:" 也合理）。
    id: "C9", level: "C", scope: "bullets", source: "行业通行做法",
    why: "五点以大写引导词 + 冒号开头（BENEFIT: ...）便于移动端扫读，是主流写法；不这么做不影响合规，只影响扫读效率。",
    test: (v) => {
      const bad = v.filter((b) => !/^[A-Z][\w &'/-]{2,40}:/.test(b.trim()));
      return { hit: bad.length > 0, detail: `${bad.length}/${v.length} 条不是「引导词:」开头` };
    },
  },
  {
    id: "P10", level: "P", scope: "searchTerms", source: "平台公开规则",
    why: `Search Terms 按字节计数，上限 ${LIMITS.searchTerms} 字节；超出部分会被静默丢弃。`,
    test: (v) => ({ hit: byteLength(v) > LIMITS.searchTerms, detail: `${byteLength(v)} 字节 / 上限 ${LIMITS.searchTerms}` }),
  },
  {
    id: "P11", level: "P", scope: "searchTerms", source: "平台公开规则",
    why: "Search Terms 中重复品牌名会挤占额度（品牌名已在 Brand 字段生效），且平台不建议堆砌。",
    test: (v, ctx) => {
      const brand = (ctx.brand || "").toLowerCase().trim();
      if (!brand) return { skip: true, detail: "未填品牌，无从比对" };
      return { hit: v.toLowerCase().includes(brand), detail: v.toLowerCase().includes(brand) ? `含品牌词 "${ctx.brand}"` : "无" };
    },
  },
  {
    id: "P12", level: "P", scope: "copy", source: "平台公开规则 + 项目自定义",
    why: "文案含 HTML/脚本标记（<b>、</p>、javascript:、onerror=、&#xxx;）会被平台清洗或拒收；更关键的是这条文案在「导出 HTML 预览 / 复制到别处」的链路上会被当代码执行 —— 合规与注入是同一个入口。",
    test: (v) => {
      const hit = findHtmlMarkers(v);
      return { hit: Boolean(hit), detail: hit ? `命中标记片段：${hit}` : "无" };
    },
  },
  {
    id: "P13", level: "P", scope: "highlights", source: "平台公开规则（2026-07-27 生效）",
    why: `Item Highlights（API 属性名 title_differentiation）上限 ${LIMITS.itemHighlights} 字符。🔴 它不只是展示字段 —— 官方原文是 "This content is searchable"，它**参与搜索索引**。所以超限被截断＝已经把关键词挖出来了又白丢一次，比普通"文字被截"更可惜。`,
    test: (v) => ({
      hit: v.length > LIMITS.itemHighlights,
      detail: `${v.length} 字符 / 上限 ${LIMITS.itemHighlights}${v.length > LIMITS.itemHighlights ? `，超出 ${v.length - LIMITS.itemHighlights}` : ""}`,
    }),
  },
  {
    id: "P14", level: "P", scope: "highlights", source: "平台公开规则",
    why: "Item Highlights 与标题同属「买家可见 + 参与搜索」的字段，禁用语口径**完全一致**：促销 / 最高级 / 平台徽章词同样违规，特殊符号同样造成解析异常。不能因为它是新字段就放松 —— 官方也明说 Highlights 会被按同样的内容政策审查。",
    test: (v) => {
      const buckets = [];
      const promo = matchWords(v, PROMO_WORDS);
      const sym = BAD_SYMBOLS.filter((s) => v.includes(s));
      if (promo.length) buckets.push(`禁用语：${promo.join(", ")}`);
      if (sym.length) buckets.push(`特殊符号：${sym.join(" ")}`);
      return { hit: buckets.length > 0, detail: buckets.join(" ｜ ") || "无" };
    },
  },
  {
    id: "P15", level: "P", scope: "copy", source: "平台公开规则（卖家行为准则）",
    why: "文案里出现网址 / 邮箱 / 引导去站外或「联系我们」的措辞 —— 平台禁止把买家带离亚马逊、禁止在 listing 里放可直接联系的方式。这类内容不是「措辞好不好」，是入口级违规，后果是绩效问题；而它又完全可以机械判定，正合本项目「硬规则不交给模型」的原则。",
    test: (v) => {
      const hits = OFF_SITE_PATTERNS.filter((p) => p.re.test(String(v))).map((p) => p.label);
      return { hit: hits.length > 0, detail: hits.length ? `${hits.join("、")}　→ 必须删除` : "无" };
    },
  },
  {
    id: "C1", level: "C", scope: "title", source: "行业通行做法",
    why: "标题前 5 个词决定移动端首屏可见性，核心搜索词应尽量前置。",
    test: (v, ctx) => {
      const kw = (ctx.primaryKeyword || "").toLowerCase().trim();
      if (!kw) return { skip: true, detail: "未填核心关键词，无从比对" };
      const head = v.toLowerCase().split(/\s+/).slice(0, 8).join(" ");
      return { hit: !head.includes(kw.split(" ")[0]), detail: `前 8 个词：${head}` };
    },
  },
  {
    id: "C2", level: "C", scope: "title", source: "行业通行做法",
    why: "标题包含数字/规格（容量、数量、尺寸）能显著降低购买不确定性，提升点击。",
    test: (v) => ({ hit: !/\d/.test(v), detail: /\d/.test(v) ? "含数字" : "无任何数字/规格" }),
  },
  {
    id: "C3", level: "C", scope: "bullets", source: "行业通行做法",
    why: `五点是利益点而非参数表：应出现利益导向词，否则只是规格罗列。中文/英文/德语/日语**各用一套词表**，英文与德语走词边界匹配（避免 easy 命中 uneasy），中日文走子串匹配（没有词边界）。🔴 只有这四套（${LANG_SUPPORT.benefitWords.join(" / ")}）—— 法/西/意/荷等语种的五点**不判**，明确标「未覆盖·跳过」，不用英文词表硬套。`,
    test: (v, ctx = {}) => {
      const t = v.join("\n");
      // ① 显式声明的语种优先：德语是拉丁字母，单看字形会被判成 "en"，
      //    然后拿英文词表去套 —— 合格的德语五点被判「没有任何利益词」，是错判不是发现。
      const declared = String(ctx.lang || "").toLowerCase().slice(0, 2);
      const script = detectScript(t);
      let lang = "";
      if (declared) {
        if (BENEFIT_WORDS_BY_LANG[declared]) lang = declared;
        else {
          return {
            skip: true,
            detail: `你选的语种是 ${declared}，本工具**没有该语种的利益词表**（现有 ${LANG_SUPPORT.benefitWords.join(" / ")}）—— 这条未覆盖、未判定；未判定不等于通过，也不等于不合格`,
          };
        }
      } else if (script === "zh" || script === "en") {
        lang = script;
      } else if (BENEFIT_WORDS_BY_LANG[script]) {
        lang = script;
      } else {
        // 日文假名占比高时 detectScript 会给 "ja"，直接可用；韩文/西里尔等仍跳过。
        return {
          skip: true,
          detail: `五点语种判为 ${script}：本工具有 ${LANG_SUPPORT.benefitWords.join(" / ")} 四套利益词表，这条未判定 —— 未判定不等于通过，也不等于不合格`,
        };
      }
      const words = BENEFIT_WORDS_BY_LANG[lang];
      // ② 中日文没有词边界，只能子串匹配；拉丁语种必须走词边界，否则 "secure" 会命中 "cure"。
      const hits = lang === "zh" || lang === "ja"
        ? words.filter((w) => t.includes(w))
        : matchWords(t, words);
      const tag = BENEFIT_LANG_LABEL[lang] || lang;
      return {
        hit: hits.length < 2,
        detail: hits.length
          ? `（${tag}）命中利益词 ${hits.length} 个：${hits.slice(0, 6).join(", ")}`
          : `（${tag}）没有任何利益导向词`,
      };
    },
  },
  {
    id: "C4", level: "C", scope: "bullets", source: "行业通行做法",
    why: "五条长度差异过大（最短 < 40% 最长）说明结构不匀，扫读节奏会乱。",
    test: (v) => {
      if (v.length < 2) return { skip: true, detail: "五点不足 2 条，长度差异无意义" };
      const lens = v.map((b) => b.length);
      const min = Math.min(...lens), max = Math.max(...lens);
      return { hit: min / max < 0.4, detail: `最短 ${min} / 最长 ${max} = ${(min / max * 100).toFixed(0)}%` };
    },
  },
  {
    id: "C5", level: "C", scope: "title", source: "项目自定义",
    why: "标题里同一实词重复 ≥3 次属于关键词堆砌观感，平台不建议且降低可读性。",
    test: (v) => {
      const words = v.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOPWORDS.has(w));
      const c = {};
      for (const w of words) c[w] = (c[w] || 0) + 1;
      const dup = Object.entries(c).filter(([, n]) => n >= 3);
      return { hit: dup.length > 0, detail: dup.map(([w, n]) => `${w}×${n}`).join(", ") || "无" };
    },
  },
  {
    id: "C6", level: "C", scope: "bullets", source: "项目自定义",
    why: "五点不含任何具体材质/规格/工艺词时，容易被判定为空洞文案，买家无法建立信任。",
    test: (v) => {
      const concrete = ["cm", "mm", "inch", "oz", "ml", "g ", "kg", "material", "cotton", "silicone", "steel", "abs", "bpa", "pcs", "pack", "ipx", "mah", "watt", "year", "month"];
      const t = v.join(" ").toLowerCase();
      const hits = concrete.filter((w) => t.includes(w));
      return { hit: hits.length === 0, detail: hits.length ? `命中具体词 ${hits.length} 个` : "无材质/规格/工艺词" };
    },
  },
  {
    id: "C7", level: "C", scope: "title", source: "项目自定义",
    why: "符号密度过高（≥4 个非字母数字符号）影响可读性与解析。⚠️ 这里刻意用「密度」而不是「黑名单」：单个 % / # / + 是高频合法写法（100% Cotton、Model #A、2+1 Pack），逐符号硬禁会造成大面积误报。",
    test: (v) => {
      // 统计"非字母数字、且不是常见合法分隔符（, - . / ( ) & ' : ）"的符号个数
      const marks = (v.match(/[^A-Za-z0-9\s,\-.\/()&':]/g) || []);
      const uniq = [...new Set(marks)];
      return {
        hit: marks.length >= 4,
        detail: marks.length ? `${marks.length} 个：${uniq.join(" ")}` : "无多余符号",
      };
    },
  },
  {
    id: "C8", level: "C", scope: "copy", source: "平台公开规则（需举证，非禁用）",
    why: "环境声明（eco-friendly / biodegradable / carbon neutral）与「不证自明声明」（non-toxic / BPA free / CE certified）平台**并非一律禁止**，要求的是真实、不误导、能提交证据（FTC Green Guides / 加州环境营销法）。所以定成软规则：提示你准备好证据，而不是逼你删词。",
    test: (v) => {
      const env = matchWords(v, ENV_CLAIMS);
      const se = matchWords(v, SELF_EVIDENT_CLAIMS);
      const parts = [];
      if (env.length) parts.push(`环境声明：${env.join(", ")}`);
      if (se.length) parts.push(`不证自明声明：${se.join(", ")}`);
      return { hit: parts.length > 0, detail: parts.length ? `${parts.join(" ｜ ")}　→ 需保留可提交的证据` : "无" };
    },
  },
  {
    // 🆕 随 2026-07 标题新规加入。🔴 emptyOk 是**这条规则存在的理由**：
    //    其余规则遇到"字段为空"会直接跳过，但这条要报的恰恰就是"空"本身。
    //    没有 emptyOk，它永远不会命中 —— 一条静默失效的规则比没有更坏。
    id: "C10", level: "C", scope: "highlights", source: "平台公开规则（2026-07-27 生效）", emptyOk: true,
    why: `Item Highlights 是**额外 ${LIMITS.itemHighlights} 字符、且与标题同等参与搜索**的位置（官方：searchable，并显示在搜索结果与详情页标题下方）。而标题被砍到 ${LIMITS.title} 之后，这里是唯一能把「材质 / 推荐用途 / 兼容性」重新放回可搜索位置的地方。留空＝主动放弃 ${LIMITS.itemHighlights} 字符的索引额度。⚠️ 它**不是必填项**，所以这条是提示，不是「必须改」。`,
    test: (v, ctx) => {
      const t = String(v || "").trim();
      return { hit: !t, detail: t ? `已填 ${t.length} 字符` : `未填写（可用额度 ${LIMITS.itemHighlights} 字符，且它是搜索输入）` };
    },
  },
  {
    id: "C11", level: "C", scope: "titleHighlights", source: "平台公开规则 + 项目自定义阈值",
    why: "官方明确：新规**不是**把同一批信息切成两半 —— 原文 Each one should add something different。标题该说「这是什么」（品牌 + 品名 + 关键属性），Highlights 该说「材质 / 推荐用途 / 兼容性」。两边说一样的话，等于花两次额度买同一个词。⚠️ 这里 80% 的阈值是本项目自定，官方只给了分工原则。",
    test: (v) => {
      const tokens = (s) => String(s || "").toLowerCase().match(/[a-z0-9]+/g) || [];
      const tw = [...new Set(tokens(v.title))];
      const hw = new Set(tokens(v.highlights));
      if (tw.length < 4 || hw.size < 2) return { skip: true, detail: "标题或 Highlights 词量过少，重合率不可计算" };
      const overlap = tw.filter((w) => hw.has(w));
      const ratio = overlap.length / tw.length;
      return {
        hit: ratio > 0.8,
        detail: `标题有 ${overlap.length}/${tw.length} 个词被 Highlights 复述（${(ratio * 100).toFixed(0)}%）${overlap.length ? `：${overlap.slice(0, 8).join(", ")}` : ""}`,
      };
    },
  },
  {
    id: "C12", level: "C", scope: "copy", source: "平台公开规则（需人工确认）",
    why: "疑似电话号 / 站外社交平台名。**刻意定为软规则**：`350-500-1000` 这种三段规格串数字量就能到 10 位，硬禁会造成大面积误报（还会让卖家不再相信质检结果）。所以只挑「形态更像电话」的报出来让你自己确认 —— 判不准就报疑似，不报违规。",
    test: (v) => {
      const hits = [];
      for (const p of SOFT_CONTACT_PATTERNS) {
        const m = String(v).match(p.re);
        if (m) hits.push(`${p.kind}：${String(m[0]).trim().slice(0, 24)}`);
      }
      return { hit: hits.length > 0, detail: hits.length ? `${hits.join(" ｜ ")}　→ 请人工确认是否要保留` : "无" };
    },
  },
  {
    id: "C13", level: "C", scope: "title", source: "行业通行做法（第三方合规清单，非官方明文）",
    why: `标题里同一个词反复出现（第三方清单举的例：Dog Treats Dog Training Dog Snacks 里三个 Dog）。在 200 字符时代它只是不优雅，在 **75 字符**时代它直接吃掉额度 —— 重复一次就少放一个规格或一个长尾词。⚠️ 不计品牌词：品牌名前置本来就是官方推荐写法。`,
    test: (v, ctx) => {
      const brand = new Set(String(ctx.brand || "").toLowerCase().match(/[a-z0-9]+/g) || []);
      const toks = (String(v).toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 2 && !brand.has(w));
      const seen = new Map();
      for (const t of toks) seen.set(t, (seen.get(t) || 0) + 1);
      const dup = [...seen.entries()].filter(([, n]) => n > 1);
      return { hit: dup.length > 0, detail: dup.length ? dup.map(([t, n]) => `${t}×${n}`).join(", ") : "无重复词" };
    },
  },
  {
    id: "C14", level: "C", scope: "title", source: "官方原则 + 项目自定义词表",
    why: `官方《Product title requirements》的 Subjective commentary 一节要求不要用主观表述（官方举例 HOT ITEM / BEST SELLER）。⚠️ 官方**只给了原则和两个例子、没给词表** —— 下面命中用的是本项目按该原则自定的词表，所以定 C 级而不是硬规则。在 75 字符时代这件事更贵：一个 Premium 吃掉 7 个字符（约 9% 额度），却不提供任何可被搜索的区分信息。`,
    test: (v) => {
      const hits = matchWords(v, SUBJECTIVE_TITLE_WORDS);
      return { hit: hits.length > 0, detail: hits.length ? `${hits.join(", ")}　→ 主观修饰，优先让位给规格/材质` : "无" };
    },
  },
];

/**
 * 逐条「怎么改」：与 RULES 的 why（为什么定这条）一一对应，id 即键。
 *
 * 🔴 设计理由（为什么集中挂一张表、而不是散进 28 个规则字面量）：
 *    ① why 文案很长、带 markdown 和反引号，内联插入 28 次极易误碰现有文案 ——
 *       而「现有 why 保持原样」是硬约束；挂表能做到**一个字都不改** RULES 字面量。
 *    ② 28 条 fix 集中一处，一眼能核对「是否齐全、有没有写废话」，便于评审。
 *    ③ lintListing 每条结果都会带 r.fix，命中时能直接落到「下一步做什么」。
 * 🔴 铁律：fix 必须**一句话、可执行、具体到这一条规则**，禁止「请修改 / 注意优化」这类空话；
 *    id 必须与 RULES 完全对应（由自测逐条校验非空、且规则 id 集合不变）。
 */
const FIXES = {
  P1: "把标题压到 75 字符（含空格）以内，或确认是否 media 类目走 200 上限；删掉冗余修饰词，别等 Amazon 自动改写。",
  P2: "从标题里删掉 free shipping / best seller / Amazon's Choice 等促销词、最高级与平台徽章词，换成可核实的材质或规格。",
  P3: "把标题里的 ! ? $ _ | < > 等特殊符号换成空格或普通标点，尤其别留 < > 和反引号。",
  P4: "把标题再压到 70 字符以内，给以后补规格留 5 字符余量（media 类目不适用）。",
  P5: "把全大写标题改成正常大小写（首字母大写即可），只在型号/缩写上保留大写。",
  P6: "删除 cure / antibacterial / 100% safe 等医疗、抗菌、保证性声明；确需保留时先备好 FDA/EPA 或检测证据。",
  P7: "把超过 500 字符的那条五点精简或拆开，把最关键的信息移到句首。",
  P8: "删掉五点里的价格、促销、物流表述，改写成产品属性或利益点。",
  C9: "给每条五点加大写引导词和冒号（如 BENEFIT:）；这只是扫读优化，不改也不影响合规。",
  P10: "把 Search Terms 压到 250 字节以内（中文按 3 字节/字），去掉重复词和标点。",
  P11: "从 Search Terms 里删掉品牌名（它已在 Brand 字段生效），腾出的字节放长尾词。",
  P12: "删除文案里的 <b>、</p>、javascript:、onerror=、&#xxx; 等标记，只留纯文本。",
  P13: "把 Item Highlights 压到 125 字符以内，优先保留参与搜索的材质/用途词，删掉凑字修饰。",
  P14: "清掉 Item Highlights 里的促销词、徽章词和特殊符号，口径与标题完全一致。",
  P15: "删除网址、邮箱、电话和「联系我们」等站外引流措辞，避免入口级违规。",
  C1: "把核心关键词挪到标题前 5 个词内，让移动端首屏就能看到。",
  C2: "在标题补上容量/数量/尺寸等数字规格（如 24oz、2 Pack、350ml）。",
  C3: "每条五点至少用 2 个利益导向词（中文「省时/耐用」、英文 easy/save/helps），别只罗列参数。",
  C4: "把最短的那条五点补到接近其它条长度，让各条长度比不低于 40%。",
  C5: "把标题里重复 3 次以上的实词删到最多 2 次，换成长尾词或规格。",
  C6: "在五点里补具体材质/规格/工艺词（如 304 不锈钢、500ml、BPA free）。",
  C7: "把标题里多余的非字母数字符号减到 3 个以内，只留必要的 - / , 分隔符。",
  C8: "为 eco-friendly / BPA free 等声明备好可提交的检测或认证证据，无法举证就删词或改中性表述。",
  C10: "填写 Item Highlights，把材质/推荐用途/兼容性写进这 125 字符的可搜索额度（非必填，但别白白浪费）。",
  C11: "让 Item Highlights 说标题没说的内容（材质/用途/兼容性），把重复词换掉、重合率压到 80% 以下。",
  C12: "人工确认命中的数字串或社交平台名：不是电话就保留，是联系方式就删。",
  C13: "把标题里重复的非品牌词合并成一个（品牌词前置可保留），省下的字符放长尾词。",
  C14: "删掉 Premium / HOT ITEM 这类主观修饰词，把腾出的字符换成规格或材质。",
};
// 🔴 挂到每条规则对象上（模块加载期一次完成），让 lintListing 能取到 r.fix。
//    只**加**属性，不改动 id / level / scope / source / why / test 任何现有字段。
for (const r of RULES) r.fix = FIXES[r.id];

/**
 * 利益导向词表：中英文分开。
 * 🔴 英文走词边界匹配（matchWords），中文走子串匹配 —— 中文没有词边界，
 *    所以中文表的每个词都必须**两字以上**，否则一定会误命中。
 */
export const BENEFIT_WORDS_EN = [
  "so you", "lets you", "allows you", "helps you", "keep", "keeps", "save", "saves", "saving",
  "easy", "easier", "easiest", "no more", "without", "helps", "protect", "protects",
  "lasts", "durable", "comfortable", "reusable", "convenient", "effortless", "quick",
  "simple", "enjoy", "fits", "safe",
];
export const BENEFIT_WORDS_ZH = [
  "避免", "无需", "不用", "省时", "省心", "省事", "持久", "耐用", "方便", "轻松",
  "舒服", "舒适", "可重复", "一手", "更适合", "无需担心", "不用担心", "长期",
];

/**
 * 德语利益词（2026-11 补）。
 *
 * 🔴 为什么必须补：德语五点是拉丁字母，`detectScript` 判成 "en"，
 *    于是**用英文词表去套德语文案** —— "spart Zeit / hält dicht / mühelos" 一个都认不出，
 *    最后报「没有任何利益导向词」。那不是发现，是**错判**：一份合格的德语五点被判死。
 *    这比"跳过"更有害，因为用户会照着提示去改本来没问题的文案。
 *
 * 词表口径：只收「动作 → 好处」的词与短语，不收纯形容词之外的名词；
 * 全部两音节以上，避免 "gut"/"neu" 这种在复合词里到处误命中的短词。
 */
export const BENEFIT_WORDS_DE = [
  "spart", "sparen", "schont", "hält", "halten", "bleibt", "einfach", "mühelos",
  "bequem", "komfortabel", "langlebig", "stabil", "rutschfest", "spülmaschinenfest",
  "wiederverwendbar", "ohne", "damit", "sodass", "ideal", "perfekt", "praktisch",
  "schützt", "reinigt", "verhindert", "passt", "geeignet",
];

/**
 * 日语利益词（2026-11 补）。
 *
 * 🔴 日语不引入分词词典（几 MB，违背零依赖），所以这里走**子串匹配**：
 *    每个词都写成 2 字以上的固定表达，命中即算（"簡単"能命中"簡単に"）。
 *    代价是极少数词形会被误命中，但比起"整段跳过"，这个代价换来的是真能判。
 */
export const BENEFIT_WORDS_JA = [
  "丈夫", "軽量", "防水", "持ち運び", "お手入れ", "簡単", "便利", "長持ち",
  "安心", "快適", "使いやすい", "洗える", "繰り返し", "節約", "時短",
  "省スペース", "滑り止め", "大容量", "コンパクト", "衛生的",
];

/**
 * 语种 → 词表。**这是唯一的口径来源**：C3 与界面提示都从这里取，
 * 不要在别处再写一份"支持哪些语种"。
 */
export const BENEFIT_WORDS_BY_LANG = {
  en: BENEFIT_WORDS_EN,
  zh: BENEFIT_WORDS_ZH,
  de: BENEFIT_WORDS_DE,
  ja: BENEFIT_WORDS_JA,
};

const BENEFIT_LANG_LABEL = { en: "英文", zh: "中文", de: "德语", ja: "日语" };

/**
 * 跑质检。ctx 可提供 brand / primaryKeyword 以启用依赖上下文的规则。
 * 返回逐条结果（含 why/fix/source），**不隐藏未命中的规则** —— 让人看见"检查过什么"。
 *
 * 🔴 why（为什么是问题）+ fix（怎么改，一句可执行）都**取自该规则本身**，随每条结果一起返回：
 *    命中项能直接落到「下一步做什么」，但**只新增字段，不改/删任何已有字段** ——
 *    前端、MCP 与既有断言都依赖固定的返回形状。
 */
export function lintListing(listing, ctx = {}) {
  const { title = "", bullets = [], searchTerms = "", highlights = "" } = listing;
  // scope → 取值。抽成表而不是三元链：新增 scope 时只改一处，
  // 也不容易出现"加了规则但忘了给值"的静默漏判。
  const SCOPES = {
    title: () => title,
    bullets: () => bullets,
    searchTerms: () => searchTerms,
    // 🆕 Item Highlights（后台显示名）＝ API 属性 title_differentiation
    highlights: () => highlights,
    // 标题 + 五点 + Item Highlights：合规类规则看这一整块。
    // 🔴 Highlights 必须进 copy —— 它同样是买家可见 + 参与搜索的字段，
    //    不收进来就会出现「标题干净、五点干净、疗效写在 Highlights 里」的绕过形态。
    copy: () => [title, ...bullets, highlights].filter(Boolean).join("\n"),
    // 🆕 标题 + Item Highlights 的**合体视角**。新规把两个字段并成「两段式标题」，
    //    分工检查（C11）必须同时看见两边，所以单独给一个对象型 scope。
    titleHighlights: () => ({ title, highlights }),
  };
  // 空值判定要能处理三种形态：数组（五点）、对象（titleHighlights）、字符串。
  const isBlank = (value) => {
    if (Array.isArray(value)) return value.length === 0;
    if (value && typeof value === "object") return !Object.values(value).some((x) => String(x || "").trim());
    return !String(value || "").trim();
  };
  // 🔴 hasContent：整张表一个字都没填 → emptyOk 规则也不放行（见下面循环里的注释）。
  //    ⚠️ 这里**不能**复用 isBlank(数组)：它对数组判的是"长度是否为 0"，
  //    而 ["", "", ""] 长度是 3 —— 会得出"有内容"的错误结论（回归当场抓到过）。
  //    要的是"有没有任一字段非空"，就老老实实逐项 trim 后再判。
  const hasContent = [title, highlights, searchTerms, ...bullets].some((s) => String(s == null ? "" : s).trim());
  const results = [];
  for (const r of RULES) {
    const pick = SCOPES[r.scope];
    if (!pick) {
      results.push({ id: r.id, level: r.level, scope: r.scope, status: "跳过", detail: `未知 scope：${r.scope}`, why: r.why, fix: r.fix, source: r.source });
      continue;
    }
    const value = pick();
    // 🔴 emptyOk：个别规则要报的就是「这个字段是空的」（如 C10），普通规则遇到空字段
    //    跳过是对的，但这类规则必须放行，否则它会永远静默失效。
    //    但放行有**前提**：`hasContent` —— 整张表一个字都没填时不放行。
    //    否则第一次打开工作台就会看到一条"未填写 Item Highlights"，那是噪音不是信息，
    //    而"在空表上乱叫"是质检器丢掉信任最快的方式。
    if (isBlank(value) && !(r.emptyOk && hasContent)) {
      results.push({ id: r.id, level: r.level, scope: r.scope, status: "跳过", detail: "对应字段为空", why: r.why, fix: r.fix, source: r.source });
      continue;
    }
    let out;
    try {
      out = r.test(value, ctx);
    } catch (e) {
      // 🔴 规则抛异常＝**这条没判定出来**，绝不能被记成"通过"。
      //    原来的写法 `out = { hit: false }` 会让一条崩掉的规则看起来像合格，
      //    而 `summary.skipped` 永远是 0、结论还能说出「全部通过」—— 这就是系统在说假话。
      out = { error: true, detail: `规则执行异常：${e.message}` };
    }
    // 状态语义（唯一产出点，界面不另判一套）：
    //   命中 = 判过且不合格 ｜ 通过 = 判过且合格 ｜ 跳过 = 前提不足，没判 ｜ 异常 = 判的过程崩了
    // 「跳过 / 异常」都**不属于通过**，它们参与 total，但不计入 checked。
    const status = out.error ? "异常" : out.skip ? "跳过" : out.hit ? "命中" : "通过";
    results.push({
      id: r.id, level: r.level, scope: r.scope,
      status,
      detail: out.detail, why: r.why, fix: r.fix, source: r.source,
      ...(out.category ? { category: out.category } : {}),
    });
  }
  const hit = results.filter((r) => r.status === "命中");
  const skipped = results.filter((r) => r.status === "跳过").length;
  const errored = results.filter((r) => r.status === "异常").length;
  const checked = results.length - skipped - errored;   // 真正判过的条数
  const hitP = hit.filter((r) => r.level === "P").length;
  const hitC = hit.filter((r) => r.level === "C").length;
  // 🔴 结论文案在这里一次成型，界面只负责显示（不再自己拼"通过 / 不通过"）。
  //    规则：未判定的条数必须**出现在结论里**，不能靠用户去数 KPI ——
  //    "6 条通过" 和 "6 条通过 + 4 条没判" 是两种可信度完全不同的结论。
  const unjudged = skipped + errored;
  const tail = unjudged
    ? `（另有 ${unjudged} 条未判定：跳过 ${skipped}${errored ? ` / 异常 ${errored}` : ""}，不计入通过）`
    : "";
  const conclusion = hitP > 0
    ? `存在硬规则命中，发布前必须修改${tail}`
    : hitC > 0
      ? `硬规则全过，软规则有可优化项${tail}`
      : checked === 0
        ? `无可检查项：${results.length} 条全部未判定（先填文案或补上品牌 / 核心关键词），这不等于通过`
        : unjudged
          ? `已判定的 ${checked} 条全部通过${tail}`
          : "全部通过";
  return {
    results,
    summary: {
      total: results.length,
      hit: hit.length,
      hitP,
      hitC,
      skipped,
      errored,
      checked,
      conclusion,
    },
  };
}

/* ─────────────────────── 草稿生成（本地、无需 LLM）─────────────────────── */

/**
 * 材质 / 结构词 —— 用来从用户**自己填的**卖点里挑出该进 Item Highlights 的那一条。
 *
 * 🔴 这是「搬运用户输入」，不是「编造材质」。用户没写材质，这里就什么都挑不出来，
 *    草稿的 Highlights 会留空并在 notes 里提示"自己补" —— 绝不替用户编一个材质出来。
 *    官方对 Highlights 的定位就是 materials / recommended use cases / compatibility / specs，
 *    所以"材质句"是最该往里搬的一类内容。
 */
const MATERIAL_RE = /stainless steel|304|316|silicone|bamboo|cotton|linen|wool|leather|polyester|nylon|spandex|glass|ceramic|aluminum|aluminium|\babs\b|\bpp\b|tpu|tpe|canvas|mesh|memory foam|microfiber|hardwood|solid wood|材质|面料|不锈钢|纯棉|真皮|皮革|硅胶|竹|玻璃|陶瓷|铝合金/;

/**
 * 数量的规范写法。
 *
 * 🔴 用户填的 `quantity` 是自由文本，实际会出现 "1 Pack" / "2 pcs" / "3 件" / "Pack of 2"。
 *    原来无条件套 `Pack of ${quantity}`，于是 "1 Pack" 变成 **"Pack of 1 Pack"** ——
 *    这个短语会同时进标题和 Item Highlights，是那种一眼就能看出是机器写的痕迹。
 *
 * 规则：已经自带单位就原样返回；纯数字（可带 x/×）才补 "Pack of"。
 * 拿不准时**不加前缀** —— 少一个词比多一个病句好。
 */
export function quantityText(quantity) {
  const q = String(quantity == null ? "" : quantity).replace(/\s+/g, " ").trim();
  if (!q) return "";
  const HAS_UNIT = /\b(?:pack|packs|pcs|pc|piece|pieces|set|sets|count|ct|pair|pairs)\b|件|只|个|套|入|枚|箱|盒/i;
  if (HAS_UNIT.test(q)) return q;
  const n = /^(\d+(?:\.\d+)?)\s*(?:x|×)?$/i.exec(q);
  return n ? `Pack of ${n[1]}` : q;
}

/**
 * 规则式 Listing 草稿生成。
 *
 * ⚠️ 诚实声明：这是**机械填空**，不是创意文案。它的作用是给你一个
 * 「结构正确、硬规则全过」的骨架，省掉从零排版的时间；卖点措辞仍需人工改写。
 * 有 LLM 时可在设置里开启「AI 润色」，由模型改写措辞，但结构仍由这里决定。
 */
export function generateListingDraft(input) {
  const {
    brand = "", productName = "", category = "", primaryKeyword = "",
    features = [], audience = "", sizeSpec = "", quantity = "",
    keywords = [], competitorText = "",
  } = input;

  const mined = competitorText ? mineKeywords(competitorText, { top: 20 }) : { terms: [] };
  const kwList = [...new Set([primaryKeyword, ...keywords, ...mined.terms.map((t) => t.term)].filter(Boolean))];

  // 标题公式：品牌 + 核心词 + 关键特性 + 规格/数量 + 适用人群
  // 🔴 每段带 role 不是为了好看 —— 下面要按 role 决定「标题放不下时它去哪」：
  //    规格 / 人群 / 材质该进 Item Highlights；**长卖点句不该**，因为它本来就要进五点，
  //    再搬进 Highlights 只是重复（官方明说两段要各说各的，C11 也会把它报出来）。
  const titleParts = [
    { text: brand, role: "brand" },
    { text: primaryKeyword || productName, role: "core" },
    ...features.slice(0, 3).map((f) => ({ text: f, role: "feature" })),
    { text: sizeSpec, role: "spec" },
    { text: quantityText(quantity), role: "spec" },
    { text: audience ? `for ${audience}` : "", role: "audience" },
  ].filter((p) => String(p.text || "").trim());
  const joinParts = (ps) => ps.map((p) => String(p.text).trim()).join(" ").replace(/\s+/g, " ").trim();

  const kept = titleParts.slice();
  let title = joinParts(kept);
  // 🔴 标题溢出的部分**不丢弃** —— 新规的官方示例就是「把标题盖不下的细节挪进 Item Highlights」
  //    （官方 Before/After：item_name 只留 Fast Charger Adapter，其余进 USB-C, PPS Support,
  //     Cable not included）。旧版本这里是把 pop 掉的部分直接扔掉 —— 在 200 字符时代无所谓，
  //    在 75 字符时代那等于每生成一次就静默删掉一批关键词。
  const titleOverflow = [];
  if (title.length > LIMITS.titleStrict) {
    // 超长就从尾部剥，而不是任意截断
    while (title.length > LIMITS.titleStrict && kept.length > 2) {
      titleOverflow.unshift(kept.pop());
      title = joinParts(kept);
    }
    if (title.length > LIMITS.titleStrict) {
      // 连「品牌 + 核心词」都超了 —— 这是核心词本身过长，不是这里能修的，只能硬截，
      // 并把被截掉的部分也记下来（不丢）。
      const cut = title.slice(LIMITS.titleStrict).trim();
      title = title.slice(0, LIMITS.titleStrict).trim();
      if (cut) titleOverflow.unshift({ text: cut, role: "cut" });
    }
  }

  // 🔴 回填：剥完不能就停手。
  //    实测缺陷（2026-11-09）：五条卖点里第一条 56 字符，塞不进 70 就被整段剥走，
  //    算法随即停在 "MUGO Ceramic Coffee Mug" —— **23 / 70 字符**，
  //    而同一份输入里明明还有 45 字符的卖点完全塞得下。
  //    结果就是：自己生成的稿子，被自己的 P4 判据提示「离硬顶还剩 52 字符」。
  //
  //    两条规则：
  //    ① 只要还有余量，就用**最短的**候选（被剥下来的 + 没用上的卖点）回填；
  //    ② 一条都塞不下时允许**让位**：按 audience → spec → feature 的顺序挤掉低价值段
  //       （brand / core 永不让位），只要换完更长、且不超限就接受。
  //       被挤掉的规格/人群不会消失 —— 它们留在 titleOverflow 里，
  //       由下面的 ② 步搬进 Item Highlights（官方新规正是这么建议的）。
  {
    const ROLE_RANK = { brand: 0, core: 1, feature: 2, spec: 3, audience: 4 };
    const rank = (r) => (ROLE_RANK[r] == null ? 9 : ROLE_RANK[r]);
    const insertByRole = (list, part) => {
      const at = list.findIndex((p) => rank(p.role) > rank(part.role));
      if (at < 0) list.push(part); else list.splice(at, 0, part);
    };
    const used = new Set(kept.map((p) => String(p.text).trim()));
    const pool = [
      ...titleOverflow.filter((p) => p.role !== "cut"),
      // 卖点里第 4、5 条原来根本没机会进标题（只取前 3 条）—— 短的完全可以补进去
      ...features.slice(3).map((f) => ({ text: f, role: "feature" })),
    ]
      .filter((p) => String(p.text || "").trim() && !used.has(String(p.text).trim()))
      .sort((a, b) => String(a.text).length - String(b.text).length);

    for (const cand of pool) {
      if (title.length >= LIMITS.titleStrict) break;
      let working = kept.slice();
      let accepted = false;
      // 最多让位 working.length 次（每次都少一段，必然收敛）
      for (let guard = 0; guard <= working.length; guard += 1) {
        const trial = working.slice();
        insertByRole(trial, cand);
        const len = joinParts(trial).length;
        if (len <= LIMITS.titleStrict) {
          // 只有"换完更长"才接受，避免把长的换成短的（那不是回填）
          if (len > title.length) {
            working = trial;
            accepted = true;
          }
          break;
        }
        // 找一项可以牺牲的：角色优先级最低、且不高于候选（同级可换同级）
        let idx = -1;
        let worst = -1;
        working.forEach((p, i) => {
          if (p === cand) return;
          if (p.role === "brand" || p.role === "core") return;
          if (rank(p.role) < rank(cand.role)) return;
          if (rank(p.role) > worst) { worst = rank(p.role); idx = i; }
        });
        if (idx < 0) break;              // 没有可让位的 → 这条塞不进
        working.splice(idx, 1);
      }
      if (!accepted) continue;
      // 被挤出去的段必须留痕（后面 Highlights 还会用到它们）
      for (const p of kept) {
        if (!working.includes(p) && !titleOverflow.includes(p)) titleOverflow.push(p);
      }
      kept.splice(0, kept.length, ...working);
      title = joinParts(kept);
      used.add(String(cand.text).trim());
      const oi = titleOverflow.indexOf(cand);
      if (oi >= 0) titleOverflow.splice(oi, 1);
    }
  }

  // 五点：引导词 + 利益 + 支撑细节（结构对齐 C9 的「引导词:」）
  const BULLET_LEADS = [
    "EFFORTLESS EVERYDAY USE", "BUILT TO LAST", "THOUGHTFUL DETAILS",
    "SIZED RIGHT", "EASY TO CARE FOR", "PERFECT FOR GIFTING",
  ];
  const bullets = features.slice(0, LIMITS.bulletCount).map((f, i) => {
    const lead = BULLET_LEADS[i] || `FEATURE ${i + 1}`;
    // 🔴 实测缺陷（2026-11-09）：原来是 `body + " Measures 350ml."` 直接空格拼接，
    //    得到 "…silicone ring Measures 350ml." —— 两句粘连、缺句号、句首还小写，
    //    一眼就是机器拼的。现在补句号、并把句首字母大写（中文输入不受影响）。
    const raw = String(f == null ? "" : f).replace(/[.!。！]+$/, "").trim();
    const body = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "";
    const tail = sizeSpec && i === 0 ? `Measures ${sizeSpec}.` : "";
    let b = body ? `${lead}: ${body}.${tail ? ` ${tail}` : ""}` : `${lead}: ${tail}`;
    if (b.length > LIMITS.bullet) b = b.slice(0, LIMITS.bullet - 1).trim() + ".";
    return b;
  });
  while (bullets.length < Math.min(3, LIMITS.bulletCount)) {
    bullets.push(`${BULLET_LEADS[bullets.length]}: Add a concrete product benefit here — this row is a placeholder, not finished copy.`);
  }

  const st = buildSearchTerms(kwList, { exclude: [brand] });

  // Item Highlights 草稿。
  // 官方两条要求都要照顾到：① 上限 125 字符 ② **写成逗号分隔的短语，不是完整句子**。
  // 所以这里只搬"短语"，不加工成句子 —— 一加工就会出现句号，反而违反格式要求。
  const clean = (s) => String(s == null ? "" : s).replace(/[\s.。！!；;]+$/g, "").trim();
  // ① 材质句：把用户自填卖点里的材质部分**按逗号拆成短语**。
  //    「Food-grade 304 stainless steel, BPA free」正好拆成两条标准 Highlight，比整句搬更像官方示例。
  const hlMaterial = [...new Set(
    features.filter((f) => MATERIAL_RE.test(String(f)))
      .flatMap((f) => String(f).split(/[,，]/))
      .map(clean)
      .filter(Boolean),
  )].slice(0, 3);
  // ② 标题放不下的规格 / 数量 / 人群 —— 它们**只出现在标题里**，标题容不下就真的没地方去了。
  const hlFromOverflow = titleOverflow
    .filter((p) => p.role === "spec" || p.role === "audience")
    .map((p) => clean(p.text))
    .filter(Boolean);
  // ③ 兜底：上面两条都空时，才拿溢出的「短片段」。长的卖点句宁可不要 ——
  //    Highlights 变成五点的复制品，比短一点更糟。
  const hlFallback = titleOverflow
    .filter((p) => String(p.text).length <= 40)
    .map((p) => clean(p.text))
    .filter(Boolean);
  const hlParts = hlFromOverflow.length + hlMaterial.length === 0
    ? hlFallback
    : [...hlMaterial, ...hlFromOverflow];   // 材质在前：官方举的就是 materials 优先
  // 🔴 **每个 part 是不可再分的一段**，剥的时候按 part 剥，不能拿拼好的字符串再按 ", " 切。
  //    实测缺陷（2026-11-09）：人群填「office workers, home coffee drinkers」，
  //    拼成 "for office workers, home coffee drinkers" 后超 125，按 ", " 一切 →
  //    后半截被当成独立短语整段丢进 highlightsDropped。用户填的是**一个字段**，
  //    却被拆成两条、还少了一条，而界面上只是淡淡一句"1 段被挤出"。
  let hlSegs = [...new Set(hlParts)];
  let highlights = hlSegs.join(", ");
  // 🔴 剥离必须留痕。项目的铁律是"算不出来宁可给 None，不给假数字"；
  //    同理，"被删掉的词"必须能被看见 —— 静默丢词会让用户以为关键词已经覆盖了，
  //    上架后才发现某个材质/规格根本没进去，而界面上一切正常。
  const highlightsDropped = [];
  if (highlights.length > LIMITS.itemHighlights) {
    // 按 part 整段剥，避免留下半截短语；剥不动（只剩一段）才硬截。
    while (highlights.length > LIMITS.itemHighlights && hlSegs.length > 1) {
      const gone = hlSegs.pop();
      if (gone) highlightsDropped.unshift({ text: gone, why: `超出 ${LIMITS.itemHighlights} 字符，整段移除` });
      highlights = hlSegs.join(", ");
    }
    if (highlights.length > LIMITS.itemHighlights) {
      const cut = highlights.slice(LIMITS.itemHighlights);
      highlights = highlights.slice(0, LIMITS.itemHighlights).replace(/[\s,]+$/, "");
      const lost = cut.replace(/^[\s,]+/, "").trim();
      if (lost) highlightsDropped.push({ text: lost, why: "单段就超上限，末尾硬截" });
    }
  }

  // 商品描述：把卖点串成一段可读文字。
  // ⚠️ 刻意**不编造**任何材质/认证/数据 —— 只说结构，细节留给用户填。
  const descParts = [
    productName ? `${productName}${brand ? ` by ${brand}` : ""}` : "",
    audience ? `Made for ${audience}.` : "",
    features.length ? features.slice(0, LIMITS.bulletCount).map((f) => String(f).replace(/[.!。！]$/, "")).join(". ") + "." : "",
  ].filter(Boolean);
  let description = descParts.join(" ").replace(/\s+/g, " ").trim();
  if (description.length > LIMITS.description) description = description.slice(0, LIMITS.description).trim();

  return {
    title,
    highlights,
    highlightsChars: highlights.length,
    // 被挤出去的短语（逐条列出，含原因）。空数组 = 没有任何词被丢。
    highlightsDropped,
    highlightsDroppedChars: highlightsDropped.reduce((n, d) => n + d.text.length, 0),
    // 两段式标题的合计占用（官方：两个字段共享 200 字符额度）。
    // ⚠️ 命名带 Chars 不带 Bytes —— 标题与 Highlights 都按**字符**计，别和 Search Terms 的字节混。
    headlineChars: title.length + highlights.length,
    bullets,
    searchTerms: st.value,
    searchTermsBytes: st.bytes,
    searchTermsDropped: st.dropped,
    description,
    keywords: kwList,
    minedTerms: mined.terms,
    aplus: [
      { screen: 1, headline: "Who this is for", body: `${productName} is built for ${audience || "everyday users"}.` },
      { screen: 2, headline: "What it solves", body: "State the specific friction this replaces — no invented numbers." },
      { screen: 3, headline: "How it works", body: "Explain the mechanism visually. Do not fabricate test data or certifications." },
      { screen: 4, headline: "Core benefits", body: features.slice(0, 4).map((f) => `- ${f}`).join("\n") || "- Add 2-4 benefit rows" },
      { screen: 5, headline: "Materials & quality", body: "List only materials you can actually document. Otherwise write: proof placeholder." },
      { screen: 6, headline: "How to use it", body: "3-4 steps, one short line each." },
      { screen: 7, headline: "Still deciding?", body: "Address the most common hesitation, then a single clear CTA." },
    ],
    notes: [
      // 🔴 没有产品名时**不许**说"结构合规"：结构合规的前提是字段有内容。
      //    之前空输入也会打这句，等于系统在说假话（标题 0 字符也叫合规）。
      title
        ? "这是规则式草稿：结构合规，措辞需人工改写。"
        : "还没填「产品名 / 核心词」—— 这是空骨架，不是合规草稿。先补产品名再生成。",
      "所有材质/认证/数据必须在有真实证据时才能写，否则保留 proof placeholder。",
      `标题 ${title.length} 字符（项目建议 ≤${LIMITS.titleStrict}，平台硬顶 ${LIMITS.title}；media 类目例外为 ${LIMITS.titleMedia}）。`,
      // 被挤出去的词要明说。没有这一条，用户只能从"少了点什么"里去猜。
      ...(highlightsDropped.length
        ? [`⚠️ Item Highlights 有 ${highlightsDropped.length} 段被挤出（共 ${highlightsDropped.reduce((n, d) => n + d.text.length, 0)} 字符）：${highlightsDropped.map((d) => `「${d.text}」`).join("、")}。这些词没有进入任何字段 —— 请决定是压短前面的短语，还是舍弃它们。`]
        : []),
      highlights
        ? `标题放不下的规格 / 用途、以及卖点里的材质已搬进 Item Highlights（${highlights.length}/${LIMITS.itemHighlights} 字符）—— 这正是官方示例的做法：长标题里的规格细节挪进 Highlights，而不是删掉。长卖点句刻意没搬，因为那些本来就要进五点，搬过来只是重复。`
        : `Item Highlights 还是空的（没填规格、卖点里也没有材质词）。官方给的这 ${LIMITS.itemHighlights} 字符是放「材质 / 推荐用途 / 兼容性 / 关键规格」的位置，而且同样参与搜索，建议补上。`,
      `🔴 标题必须 ≤${LIMITS.title} 才有资格提交 Item Highlights（官方明文：You can only submit title_differentiation when item_name is 75 characters or fewer）。所以这两个字段是一起改的，不是二选一。`,
      `Highlights 要写成逗号分隔的短语（官方格式要求），不要写成完整句子；也不要复述标题已经说过的词 —— 官方说得很清楚，两段要各说各的。`,
    ],
  };
}

/* ─────────────────────── 后台字段导出 ─────────────────────── */

/**
 * 亚马逊卖家后台字段定义。
 * 🔴 为什么需要这个：原来的"导出"只有一份质检 JSON，是给**我自己复盘**用的；
 *    真正上线要用的是"逐字段可粘贴"的形态 —— 后台是**一个字段一个框**，
 *    拿着整段 JSON 是没法往里填的。这里把字段名、上限、计法都对齐后台。
 *
 * 计法（三种口径，这是最容易被搞混的地方）：
 *   · 标题 / Item Highlights / 五点 / 描述：按**字符**计（character-based，任何语言都一样，全角按 1 个算）
 *   · Search Terms：按**字节**计（byte-based）
 *   · 其余：不限制
 *
 * 🔴 key 用**官方 API 属性名**而不是后台显示名：item_name / title_differentiation 是
 *    SP-API《Submit modular titles》里的正式属性名，走 Listings Items API 或
 *    JSON_LISTINGS_FEED 时直接用得上；后台界面上显示的则是 "Title" 与 "Item Highlights"。
 *    两套名字对应同一个字段，这里两个都写进 label/hint，避免只知其一的人对不上。
 *    批量表里的完整路径形如
 *      title_differentiation[marketplace_id=<ID>][language_tag=en_US]#1.value
 *    —— 直接贴 CSV 到模板时，列名要以**你自己类目的官方模板**为准，别照搬这里的 key。
 */
export const AMAZON_FIELDS = [
  { key: "item_name", label: "Title（商品名称）", limit: LIMITS.title, unit: "字符", required: true, hint: `品牌 + 核心词 + 关键属性；硬顶 ${LIMITS.title}，media 类目例外为 ${LIMITS.titleMedia}` },
  // 🆕 2026-07-27 新规。放在 item_name 后面不是排版偏好，而是**依赖顺序**：
  //    官方明文「只有 item_name ≤75 才能提交 title_differentiation」，两者的位置关系就是这个因果。
  { key: "title_differentiation", label: "Item Highlights（商品亮点）", limit: LIMITS.itemHighlights, unit: "字符", required: false, hint: `逗号分隔短语，不要整句；放材质 / 推荐用途 / 兼容性 / 关键规格。参与搜索，显示在标题下方` },
  { key: "bullet1", label: "Bullet Point 1（要点 1）", limit: LIMITS.bullet, unit: "字符", required: true },
  { key: "bullet2", label: "Bullet Point 2（要点 2）", limit: LIMITS.bullet, unit: "字符", required: true },
  { key: "bullet3", label: "Bullet Point 3（要点 3）", limit: LIMITS.bullet, unit: "字符", required: true },
  { key: "bullet4", label: "Bullet Point 4（要点 4）", limit: LIMITS.bullet, unit: "字符", required: false },
  { key: "bullet5", label: "Bullet Point 5（要点 5）", limit: LIMITS.bullet, unit: "字符", required: false },
  { key: "generic_keywords", label: "Search Terms（搜索词）", limit: LIMITS.searchTerms, unit: "字节", required: false, hint: "空格分隔，不要逗号，不要重复品牌" },
  { key: "product_description", label: "Product Description（商品描述）", limit: LIMITS.description, unit: "字符", required: false },
];

/**
 * 把 listing 拍平成"后台逐字段"的导出结构。
 * @returns {{fields: Array, text: string, overflows: Array}}
 */
export function exportListingFields(listing = {}, ctx = {}) {
  const { title = "", bullets = [], searchTerms = "", description = "", highlights = "" } = listing;
  const values = {
    item_name: title,
    title_differentiation: highlights,
    bullet1: bullets[0] || "", bullet2: bullets[1] || "", bullet3: bullets[2] || "",
    bullet4: bullets[3] || "", bullet5: bullets[4] || "",
    generic_keywords: searchTerms,
    product_description: description,
  };
  // 🔴 item_name 的上限随类目变：media 类目（图书 / 音乐 / 影像）仍是 200，其余 75。
  //    原来 AMAZON_FIELDS 把 limit 写死成 75，于是 media 类目下会出现荒诞结论：
  //    lint 判"通过"，同一份数据导出却报 `over: true` —— 同一件事两个答案，
  //    用户不知道该信哪个，最后只能两个都不信。
  const titleCap = titleLimit(ctx);
  const fields = AMAZON_FIELDS.map((f) => {
    const limit = f.key === "item_name" ? titleCap : f.limit;
    const value = String(values[f.key] || "");
    const used = f.unit === "字节" ? byteLength(value) : value.length;
    return {
      ...f,
      limit,
      hint: f.key === "item_name"
        ? `品牌 + 核心词 + 关键属性；当前上限 ${titleCap} 字符（${ctx.isMedia ? "media 类目" : "普通类目"}）`
        : f.hint,
      value,
      used,
      remaining: limit - used,
      over: used > limit,
      empty: !value.trim(),
    };
  });
  const overflows = fields.filter((f) => f.over);
  const missingRequired = fields.filter((f) => f.required && f.empty);
  // 🌟 两段式标题的**总账**。官方口径是「两个字段共享 200 字符」，
  //    所以这里必须把 title + highlights 当一个整体报出来 —— 单看任一字段都看不出额度还剩多少。
  const budget = {
    limit: LIMITS.titleTotal,
    title: title.length,
    highlights: highlights.length,
    used: title.length + highlights.length,
    remaining: LIMITS.titleTotal - (title.length + highlights.length),
    // 🔴 这条因果链是本项目最想让用户看到的一句：标题超 75 → 不只是标题超限，
    //    Highlights 整个字段**提交不上去**。两个问题其实是一个问题。
    highlightsBlocked: title.length > titleCap,
  };
  const notes = [];
  if (budget.highlightsBlocked) {
    notes.push(`标题 ${title.length} 字符超过 ${titleCap} —— 按官方规则此时 title_differentiation（Item Highlights）无法提交，先压标题再填亮点。`);
  }
  if (!highlights.trim()) {
    notes.push(`Item Highlights 为空。它是额外 ${LIMITS.itemHighlights} 字符、且参与搜索的位置，留空等于放弃索引额度。`);
  }
  // 草稿阶段被挤出去的短语，导出时也要跟着说 —— 否则 JSON 看起来"字段都填满了"，
  // 实际少了几个词，等用户在后台对比时才会发现。
  const drops = Array.isArray(listing.highlightsDropped) ? listing.highlightsDropped : [];
  if (drops.length) {
    notes.push(`Item Highlights 有 ${drops.length} 段因超过 ${LIMITS.itemHighlights} 字符被挤出：${drops.map((d) => d.text).join("、")}。这些词没有进入任何字段。`);
  }
  // 纯文本块：直接全选复制，粘到后台对应框里
  const text = fields
    .map((f) => `【${f.label}】(${f.used}/${f.limit} ${f.unit})\n${f.value || "—"}`)
    .join("\n\n");
  return {
    fields, text, overflows, missingRequired, budget, notes,
    // 跟着一起导出：导出的 JSON 也要能看出"哪些词没进去"
    highlightsDropped: drops,
    brand: ctx.brand || "",
    primaryKeyword: ctx.primaryKeyword || "",
    exportedAt: new Date().toISOString(),
    note: `标题/Item Highlights/五点/描述按【字符】计，Search Terms 按【字节】计 —— 三种口径不要混。两段式标题合计上限 ${LIMITS.titleTotal} 字符（${LIMITS.title} + ${LIMITS.itemHighlights}）。`,
  };
}

/**
 * 导出**亚马逊 Flat File 风格**的 CSV（一行表头 + 一行数据），给"批量表上传"用。
 *
 * ⚠️ 边界必须说清楚，别让用户以为这是"官方模板"：
 *   · 这里只是**按官方属性名**排好列，方便你对照着填；
 *   · 真正上传要用的模板**必须从你自己的类目下载**（Add Products → Spreadsheet），
 *     因为不同类目的列名/必填项不同（批量表里 Item Highlights 的完整路径形如
 *     `title_differentiation[marketplace_id=XXX][language_tag=en_US]#1.value`）；
 *   · 所以这份 CSV 的用途是「对照 / 搬数据 / 存档」，不是「直接传上去就完事」。
 *
 * CSV 转义按 RFC 4180：字段含逗号 / 双引号 / 换行就整体加双引号，内部双引号写成两个。
 * 🔴 这一步不能省 —— 五点里带逗号是常态，不转义会直接把一行撑成好几列。
 */
export function exportFlatFileCsv(listing = {}, ctx = {}) {
  const { fields } = exportListingFields(listing, ctx);
  // 🔴 CSV 公式注入：以 = + - @ 或制表符/回车开头的单元格，Excel / Google Sheets 会**当公式执行**。
  //    Listing 里出现 "= 2 Pack"「-20%」这类开头完全正常，所以不能假设"我们导出的数据是安全的"。
  //    标准缓解是前置一个单引号（单元格变文本，内容不变）。
  const RISKY = /^[=+\-@\t\r]/;
  const esc = (s) => {
    let v = String(s == null ? "" : s);
    if (RISKY.test(v)) v = `'${v}`;
    return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const header = [...fields.map((f) => f.key), "brand", "primary_keyword"].join(",");
  const row = [...fields.map((f) => f.value), ctx.brand || "", ctx.primaryKeyword || ""].map(esc).join(",");
  return {
    csv: `${header}\n${row}\n`,
    filename: "amazon-flatfile-listing.csv",
    columns: fields.map((f) => f.key),
    note: "列名用的是官方属性名（item_name / title_differentiation / generic_keywords …）。上传前请以你**自己类目**的官方模板列名为准 —— 这份文件是对照用的，不是可直接提交的模板。",
  };
}

/**
 * 上传前预校验：把"这份东西能不能真的传上去"分成三层说清楚。
 *
 * 🔴 三层刻意分开，因为它们**证据强度完全不同**：
 *   ① blockers  —— 本工具能判断、且传上去一定失败（标题空/超限、品牌空）
 *   ② warnings  —— 能判断、但不至于上传失败（Highlights 空、五点太少、描述空）
 *   ③ externals —— **本工具判断不了**，但后台确实必需（UPC/GTIN、类目节点、价格、库存、主图）
 * 把 ③ 混进 ① 是常见的骗人方式：给一张"全部通过"的绿表，让用户以为可以直接提交。
 * 所以这里明确输出"我不检查这些"，并且不返回任何"全部通过"的字样。
 */
export function precheckForUpload(listing = {}, ctx = {}) {
  const { fields, overflows, missingRequired } = exportListingFields(listing, ctx);
  const get = (k) => fields.find((f) => f.key === k);
  const blockers = [];
  const warnings = [];

  const title = get("item_name");
  if (title?.empty) blockers.push({ field: "item_name", label: "标题", why: "标题为空，后台会直接拒收" });
  if (title?.over) blockers.push({ field: "item_name", label: "标题", why: `标题 ${title.used} 字符，超过上限 ${title.limit}` });
  if (!String(ctx.brand || "").trim()) blockers.push({ field: "brand", label: "品牌", why: "brand 为空；没有品牌无法建立 Listing（无品牌要先用品牌备案或填 Generic）" });
  // 五点的必填是逐条定义的（bullet1-3），但用户看到的是"五点"这一个概念 ——
  // 报三条一样的错只会让人以为是系统坏了，所以合并成一条。
  const missingBullets = missingRequired.filter((f) => /^bullet\d$/.test(f.key));
  if (missingBullets.length) {
    blockers.push({
      field: "bullet_point", label: "五点",
      why: `第 ${missingBullets.map((f) => f.key.slice(-1)).join(" / ")} 条为空（后台至少要求 3 条）`,
    });
  }
  for (const f of missingRequired) {
    if (f.key === "item_name" || /^bullet\d$/.test(f.key)) continue;  // 上面已单独报过
    blockers.push({ field: f.key, label: f.label, why: "必填字段为空" });
  }

  const hl = get("title_differentiation");
  if (hl?.empty) warnings.push({ field: "title_differentiation", label: "Item Highlights", why: "留空 = 放弃一段参与搜索的索引额度（不是必填，但很亏）" });
  if (hl?.over) warnings.push({ field: "title_differentiation", label: "Item Highlights", why: `${hl.used} 字符，超过 ${hl.limit}，超出部分会被截断` });
  const bullets = Array.isArray(listing.bullets) ? listing.bullets.filter((b) => String(b || "").trim()) : [];
  if (bullets.length >= 3 && bullets.length < 5) {
    warnings.push({ field: "bullet_point", label: "五点", why: `填了 ${bullets.length} 条（常见做法是 5 条，两条空位等于浪费）` });
  }
  for (const f of overflows) {
    if (f.key === "item_name") continue;
    warnings.push({ field: f.key, label: f.label, why: `${f.used} / ${f.limit} ${f.unit}，超出 ${f.used - f.limit}` });
  }
  const st = get("generic_keywords");
  if (st?.empty) warnings.push({ field: "generic_keywords", label: "Search Terms", why: "留空 = 少一层补漏；但它是最后手段，别为了填而填" });

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    // ② 这层是**本工具明确不覆盖**的。列出来不是为了吓人，是为了让"通过"这个词有边界。
    externals: [
      "external_product_id（UPC / EAN / GTIN）或品牌备案豁免 —— 本工具不生成、也不校验",
      "类目节点 / product_type（决定模板列名与必填属性）",
      "standard_price、币种、quantity（库存）",
      "主图 slot 1（本工具只出 Prompt，不产出成图）",
      "类目相关的合规文件（如儿童品 CPC、化妆品 FDA、电池 UN38.3）",
    ],
    note: "本预校验只覆盖**文本字段**。上面 externals 那几项必须在上传前自己核一遍 —— 它们不在这个工具的检查范围内。",
  };
}

/* ─────────────────────── 关键词覆盖度分析 ─────────────────────── */

/**
 * 字段权重 —— **行业通行做法，不是平台官方明文**。
 * 理由：标题是 A9 权重最高的字段；五点参与搜索与转化；后台 Search Terms
 * 的权重低于任何可见文本（它主要作用是补漏，不是主要流量来源）。
 * ⚠️ 这组数字是**相对重要性的次序**，不要当成官方给出的分值。
 */
export const FIELD_WEIGHT = { title: 3, bullets: 2, description: 1, searchTerms: 1 };

/** 字段 → 中文标签（前端与文案共用，避免各处手写） */
export const FIELD_LABEL = {
  title: "标题", bullets: "五点", description: "描述", searchTerms: "后台词",
};

/**
 * 单个词是否出现在某段文本里。
 * 🔴 ASCII 词走**词边界**（否则 `cat` 会命中 `category`、`mug` 会命中 `smug`），
 *    中文没有词边界概念，走子串匹配。
 * ⚠️ 边界只在「两端都是字母数字」时可用：`#1`、`2+1 pack`、`bpa-free` 这类词
 *    加了 `\b` 反而匹配不上，所以按形态分流。
 */
export function hasTerm(term, text) {
  const t = String(text || "");
  const needle = String(term || "").trim();
  if (!t || !needle) return false;
  const lower = t.toLowerCase();
  const n = needle.toLowerCase();
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bounded = /^[a-z0-9]/i.test(needle) && /[a-z0-9]$/i.test(needle);
  if (bounded) return new RegExp(`(^|[^a-z0-9])${esc}(?![a-z0-9])`).test(lower);
  return lower.includes(n);
}

/**
 * 把各种"竞品输入形态"归一成 `[{ name, text }]`。
 * 支持：`[{name,text}]` / `["文案"]` / `{ 竞品A: "文案", 竞品B: "文案" }`。
 * 🔴 归一化放在一处，别让每个调用方各写一遍 —— 这是"同一逻辑写两遍"的老坑。
 */
export function normalizeCompetitors(input) {
  const out = [];
  const push = (name, text) => {
    const t = String(text ?? "").trim();
    if (!t) return;
    out.push({ name: String(name ?? "").trim() || `竞品 ${out.length + 1}`, text: t });
  };
  if (Array.isArray(input)) {
    for (const it of input) {
      if (typeof it === "string") push("", it);
      else if (it && typeof it === "object") push(it.name || it.title || it.asin || "", it.text ?? it.copy ?? it.body ?? "");
    }
  } else if (input && typeof input === "object") {
    for (const [k, v] of Object.entries(input)) push(k, v);
  } else if (typeof input === "string") {
    // 换行 + 分隔线切成多段（粘贴多个竞品文案的常见形态）
    for (const seg of input.split(/\n\s*[-=]{3,}\s*\n/)) push("", seg);
  }
  return out;
}

/**
 * 跨竞品词频对比 —— 回答"**哪些词是全类目共识、哪些只是某家在用**"。
 *
 * 这是多竞品输入真正的价值所在，比"多粘几段文案"多出来的那一层判断：
 *   · `count === 竞品数`（全体一致）→ **类目通用核心词，必须覆盖**
 *   · `count === 1` → 可能是差异化词，也可能是某家的品牌词/长尾噪声
 *
 * @returns {{ competitors: string[], rows: Array, size, note }}
 *   row = `{ term, count, total, hits: [{ name, weight }], consistency }`
 */
export function compareCompetitors(input, { top = 30, includeNgrams = true, minCount = 2, lang = "" } = {}) {
  const list = normalizeCompetitors(input);
  const perMap = list.map(
    // lang 一路传下去：德国站竞品的 "mit/für/und" 不该出现在共识词里
    (c) => new Map(mineKeywords(c.text, { top: 200, includeNgrams, lang }).terms.map((t) => [t.term, t.weight])),
  );

  const agg = new Map();
  for (let i = 0; i < perMap.length; i++) {
    for (const [term, weight] of perMap[i]) {
      // 长度 <2 的词与纯数字不作候选（与覆盖度分析的准入规则一致）
      if (term.length < 2 || /^\d+$/.test(term)) continue;
      if (!agg.has(term)) agg.set(term, { term, hits: [], total: 0 });
      const row = agg.get(term);
      row.hits.push({ name: list[i].name, weight });
      row.total = +(row.total + weight).toFixed(2);
    }
  }

  const size = list.length;
  const rows = [...agg.values()]
    .map((r) => ({
      ...r,
      count: r.hits.length,
      consistency: size ? +(r.hits.length / size).toFixed(2) : 0,
      consensus: size > 1 && r.hits.length === size,
    }))
    .filter((r) => r.total >= minCount || r.count >= 2)
    .sort((a, b) => b.count - a.count || b.total - a.total || a.term.localeCompare(b.term))
    .slice(0, top);

  const consensus = rows.filter((r) => r.consensus).map((r) => r.term);

  return {
    competitors: list.map((c) => c.name),
    rows,
    size,
    consensus,
    note: size < 2
      ? "至少要两个竞品才能对比 —— 现在只有一个，结果等同于单竞品词频。"
      : `共 ${size} 个竞品。\`count\` 是"有几个竞品用到这个词"：等于 ${size} 的是**全类目共识词**（优先保证覆盖），等于 1 的可能是差异化词或品牌词，需人工判断。⚠️ 这是**词频**，不是搜索量。`,
    source: "共识/差异化 的划分是本项目的分析口径（按出现竞品数），不是平台规则。",
  };
}

/**
 * 关键词覆盖度分析：我的 listing 覆盖了哪些词、漏了哪些、哪些只在后台。
 *
 * @param {object} listing  { title, bullets, searchTerms, description }
 * @param {object} opts
 *   - keywords       我的候选词（数组，或逗号/换行分隔的字符串）
 *   - competitorText 竞品文案（整段粘贴；用来判断"竞品已覆盖而我没有"）
 *   - top            取前 N 个词
 *   - includeMined   是否把 competitorText 挖出的词也并入候选（默认 true）
 *   - targetsFrom    可选："user" | "vault"，声明候选词来源（触发词库闭环扩展）
 *   - targets        可选：[{ term, from, rootCount, groups }]，结构化词库目标词
 *
 * @returns {{rows, total, covered, coveragePct, gaps, weak, unused, note, source}}
 *   传入 targetsFrom / targets 时**额外**返回：
 *   { gapsDetail:[{term,from,rootCount,groups,missingIn}], coverageUser, coverageVault, vault:{ok,reason} }。
 *
 * 🔴 诚实边界：这是**文本覆盖**判定，只回答"这个词有没有出现在我的文案里"。
 *    它**不是**搜索排名、不是搜索量、不代表排名会上升。
 * 🔴 向后兼容：不传 targetsFrom / targets 时，返回对象与改动前**逐字段深相等**；
 *    gaps 始终是字符串数组，不因词库扩展而变形。
 */
export function analyzeCoverage(listing = {}, opts = {}) {
  const { title = "", bullets = [], searchTerms = "", description = "" } = listing;
  const bulletText = Array.isArray(bullets) ? bullets.join("\n") : String(bullets || "");
  const places = { title, bullets: bulletText, description, searchTerms };

  // ① 候选词：用户给的 + 从竞品文案挖的（去重、保序、原样保留大小写用于展示）
  //    🔴 必须记录**每个词从哪来**：用户自己选的词没覆盖，是"真缺口"；
  //       竞品语料挖出来的 n-gram 没覆盖，可能只是无意义片段（如 "dogs reduces"）。
  //       把两者混在一个 gaps 里，会把真缺口淹掉 —— 这就是"报得越多、越没人看"。
  const given = Array.isArray(opts.keywords)
    ? opts.keywords
    : String(opts.keywords || "").split(/[,，\n]/);
  const pool = [];
  const seen = new Set();
  const origin = new Map();
  const push = (term, src) => {
    const t = String(term || "").trim();
    if (!t || t.length < 2) return;
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    origin.set(k, src);
    pool.push(t);
  };
  for (const w of given) push(w, "given");

  // 竞品：支持**多个**（competitors 数组/对象），并兼容旧的单段 competitorText
  const compList = normalizeCompetitors(opts.competitors);
  const legacy = String(opts.competitorText || "").trim();
  if (legacy) compList.unshift({ name: "竞品", text: legacy });
  const mined = compList.map((c) => c.text).join("\n");
  const includeMined = opts.includeMined !== false;
  // 🔴 按句拆分后再挖：整段直接跑 n-gram 会产生跨句的假短语（"dogs reduces"）。
  const minedTerms = mined && includeMined
    ? [...new Set(
        mined
          .split(/[.\n;!?]+/)
          .flatMap((seg) => mineKeywords(seg, { top: 60, includeNgrams: true, lang: opts.lang || "" }).terms.map((x) => x.term)),
      )]
    : [];
  for (const w of minedTerms) push(w, "mined");

  const top = Number(opts.top) > 0 ? Number(opts.top) : 30;
  const terms = pool.slice(0, top);

  // ② 逐词判定 4 个位置 + 竞品是否覆盖
  const rows = terms.map((term) => {
    const hit = {
      title: hasTerm(term, places.title),
      bullets: hasTerm(term, places.bullets),
      description: hasTerm(term, places.description),
      searchTerms: hasTerm(term, places.searchTerms),
    };
    const score = Object.entries(FIELD_WEIGHT).reduce((sum, [f, w]) => sum + (hit[f] ? w : 0), 0);
    // 竞品覆盖：任一竞品覆盖到就算 true，同时记下**是哪几个竞品**在打这个词
    const coveredBy = compList.filter((c) => hasTerm(term, c.text)).map((c) => c.name);
    const competitor = mined ? coveredBy.length > 0 : null;

    // ③ 给一条**可执行**的动作，而不是只报分数
    let action, priority;
    const visible = hit.title || hit.bullets || hit.description;
    if (score === 0 && competitor === true) {
      action = "竞品已覆盖，我完全没有 → 优先补进标题或五点";
      priority = 1;
    } else if (score === 0) {
      action = "候选中，我没有使用";
      priority = 3;
    } else if (!visible) {
      action = "只在后台词里 → 权重最低，建议提到五点";
      priority = 2;
    } else if (hit.title) {
      action = "标题已覆盖（权重最高）";
      priority = 4;
    } else {
      action = "可见文本已覆盖，可考虑上标题";
      priority = 3;
    }

    return { term, hit, score, competitor, coveredBy, action, priority, weight: FIELD_WEIGHT, source: origin.get(term.toLowerCase()) || "given" };
  });

  const sorted = rows.slice().sort((a, b) => a.priority - b.priority || b.score - a.score || a.term.localeCompare(b.term));
  const covered = rows.filter((r) => r.score > 0).length;
  const total = rows.length;
  const gapRows = sorted.filter((r) => r.priority === 1);

  const result = {
    rows: sorted,
    total,
    covered,
    coveragePct: total ? Math.round((covered / total) * 100) : 0,
    /** 🔴 真缺口：**用户自己选定的**候选词里，竞品在打、我完全没有 —— 这是最该先处理的 */
    gaps: gapRows.filter((r) => r.source === "given").map((r) => r.term),
    /** ⚠️ 竞品语料挖出、我没有的词。**含噪声 n-gram**，只作线索，不当待办清单 */
    minedGaps: gapRows.filter((r) => r.source === "mined").map((r) => r.term),
    /** 只在后台词里、可见文本没有 */
    weak: sorted.filter((r) => r.priority === 2).map((r) => r.term),
    /** 候选词里我完全没用到的 */
    unused: sorted.filter((r) => r.priority === 3 && r.score === 0).map((r) => r.term),
    competitorProvided: Boolean(mined),
    competitorNames: compList.map((c) => c.name),
    minedCount: minedTerms.length,
    note: "这是**文本覆盖**判定 —— 只回答「这个词有没有出现在我的文案里」。它不是搜索排名、不是搜索量，覆盖上去也不代表排名会上升；它只用来避免「竞品在打的核心词我一个字都没提」这类低级漏失。⚠️ 从竞品语料挖出的短语里混有 n-gram 噪声（例如「dogs reduces」这种跨词片段），所以它们单列在 minedGaps，只当线索看。",
    source: `字段权重 ${FIELD_WEIGHT.title}/${FIELD_WEIGHT.bullets}/${FIELD_WEIGHT.description}/${FIELD_WEIGHT.searchTerms}（标题/五点/描述/后台词）是**行业通行做法**，不是亚马逊官方明文。`,
  };

  /* ───── S-2：词库来源 → 覆盖度闭环（**可选**扩展；零传参时整段不执行）─────
   * 🔴 向后兼容铁律：上面 `result` 的字段、类型、取值在**不传 targetsFrom / targets**
   *    时，必须与改动前逐字段深相等 —— 所以新字段一律走下面 `if` 分支**只增不改**；
   *    `gaps` 仍是原来的字符串数组（前端与 MCP 都依赖它），绝不换成对象数组。
   *
   * 设计理由：光知道「有缺口」不够，还要知道「这个词从哪来（user 自选 / vault 本周词库）、
   *    带出多少词根、漏在哪些字段」。coverageUser / coverageVault **分开算两个百分比**
   *    （各自只用自己的来源子集），绝不混成一个数 —— 混算会掩盖「词库词整体没覆盖」这类信号。
   */
  if (opts.targetsFrom !== undefined || opts.targets !== undefined) {
    // ① 归一化 targets：给了结构化数组就用它（每条自带 from），否则从候选词派生。
    //    派生时统一按 targetsFrom 声明的来源标记，供 `{keywords, targetsFrom:"vault"}` 简调用。
    //    🔴 派生形态下 `opts.keywords` 只是词面、不带词根元数据，所以 rootCount 统一取
    //       中性占位 1、groups 为空 —— **不是真实词根数**，别拿去显示「由 N 个词根带出」。
    //       要真实 rootCount/groups 请走高级形态传 `targets:[{term,from,rootCount,groups}]`。
    const defaultFrom = opts.targetsFrom === "vault" ? "vault" : "user";
    const targets = (Array.isArray(opts.targets) && opts.targets.length > 0
      ? opts.targets
      : terms.map((term) => ({ term }))
    ).map((t) => ({
      term: String(t.term == null ? "" : t.term).trim(),
      from: t.from === "vault" || t.from === "user" ? t.from : defaultFrom,
      rootCount: Number(t.rootCount) > 0 ? Number(t.rootCount) : 1,
      groups: Array.isArray(t.groups) ? t.groups : (t.groups == null ? [] : [t.groups]),
    })).filter((t) => t.term);

    // ② 逐词算「漏在哪些字段」。字段名与 places / FIELD_WEIGHT 对齐，口径只此一处。
    //    covered = 4 个位置里至少命中 1 个（与 coveragePct 的 score>0 一致）。
    const placeKeys = ["title", "bullets", "description", "searchTerms"];
    const detail = targets.map((t) => {
      const missingIn = placeKeys.filter((k) => !hasTerm(t.term, places[k]));
      return {
        term: t.term, from: t.from, rootCount: t.rootCount, groups: t.groups,
        missingIn,
        covered: missingIn.length < placeKeys.length,
      };
    });

    // ③ 排序：rootCount × 未覆盖字段数（缺口越大越靠前），同权重按 rootCount、term 稳定收尾。
    //    🔴 「未覆盖」取 missingIn.length（漏了几个字段），不是「有没有缺口」的 0/1 ——
    //       这样「词根多且全字段都漏」的词排最前，符合方案「按 rootCount × 未覆盖」的口径。
    //    完全覆盖的项 missingIn 为空、权重 0，排在末尾（gapsDetail 覆盖全部 targets，便于回查）。
    const gapWeight = (d) => d.rootCount * d.missingIn.length;
    detail.sort((a, b) => gapWeight(b) - gapWeight(a) || b.rootCount - a.rootCount || a.term.localeCompare(b.term));

    // ④ 两个覆盖率分开算：各自只用自己来源的子集，绝不合并成一个数。
    const pct = (list) => list.length ? Math.round(list.filter((d) => d.covered).length / list.length * 100) : 0;
    const vaultTargets = detail.filter((d) => d.from === "vault");

    // ⑤ 只把**新增字段**挂到 result；gaps / rows / coveragePct 等原字段一个都不碰。
    result.gapsDetail = detail.map(({ term, from, rootCount, groups, missingIn }) => ({ term, from, rootCount, groups, missingIn }));
    result.coverageUser = pct(detail.filter((d) => d.from === "user"));
    result.coverageVault = pct(detail.filter((d) => d.from === "vault"));
    // 无词库不失败：显式声明从 vault 取词却拿不到 vault 词 → ok:false, reason:"missing"（方案 §5 验收）。
    result.vault = vaultTargets.length > 0
      ? { ok: true, reason: "ok" }
      : opts.targetsFrom === "vault"
        ? { ok: false, reason: "missing" }
        : { ok: false, reason: "not-requested" };
  }
  return result;
}
