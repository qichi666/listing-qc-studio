/**
 * 本地 Prompt 引擎 —— 把 ecom-details-image 的 SKILL.md 规则工程化。
 *
 * 为什么要在本地用代码算，而不是"让模型自己记得"：
 *   SKILL.md 有 6 条铁律 + Style Lock 10 维度 + 多角度约束 + 详情页信息图结构，
 *   共 20 多条硬约束。靠 LLM 在自由生成里同时满足它们，命中率不稳定、不可验证。
 *   把「规则」与「文案」拆开：规则由本模块确定性计算（可单测、可断言），
 *   LLM 只在需要时负责「把产品描述润色成更准确的一句英文」。
 *
 * 结果：不配任何 API key，也能产出完全合规的可执行 Prompt。
 */

import { TEMPLATES, TEMPLATE_LIST, KEYWORD_INDEX } from "./templates.js";

/* ───────────────────────── 铁律常量表 ───────────────────────── */

/** 铁律 1：颜色必须用 hex，不用形容词 */
export const HEX = {
  white: "#FFFFFF",
  offWhite: "#FAF7F2",
  lightBeige: "#F5F1E8",
  cream: "#F2E8D5",
  black: "#111111",
  deepCharcoal: "#2D2D2D",
  midGray: "#888888",
  lightGray: "#D8D8D8",
  gold: "#D4AF37",
  amber: "#FFBF00",
  bronze: "#CD7F32",
  copper: "#B87333",
  deepGreen: "#1A3A2E",
  forest: "#2E5B3E",
  sage: "#7A9E7E",
  olive: "#808000",
  mint: "#98FF98",
  lime: "#9ACD32",
  seafoam: "#9FE2BF",
  teal: "#008080",
  turquoise: "#40E0D0",
  wood: "#8B6F47",
  taupe: "#8B7D6B",
  navy: "#12243A",
  royalBlue: "#2A4B8D",
  denim: "#4A6C8C",
  sky: "#87CEEB",
  red: "#C0392B",
  maroon: "#800000",
  burgundy: "#6D1A36",
  coral: "#FF7F50",
  pink: "#E8B4B8",
  magenta: "#C2185B",
  mauve: "#B784A7",
  plum: "#8E4585",
  yellow: "#E8C547",
  orange: "#D97706",
  purple: "#6B4E8F",
  lilac: "#C8A2C8",
  indigo: "#3F51B5",
  brown: "#7B5540",
  khaki: "#C3B091",
};

/**
 * 形容词 → hex 的替换表（中文/英文都兜）。
 *
 * 🔴 四条规则，都是踩出来的：
 *   ① 更具体的写在更笼统的前面（米白 先于 白；深灰/高级灰 先于 灰；深绿 先于 绿），
 *      否则"米白色"会被"白色"吃掉、"深灰"会被"灰"吃掉。
 *   ② 不写裸的 `白` —— 会把"米白"打成"米#FFFFFF"。
 *   ③ 🔴 单字色词**必须带后缀**（色/调/底/背景），不写裸的 金/粉/红/黑。
 *      否则会误伤产品描述里更常见的词：金**属**、粉**末**、网**红**、黑**科技**。
 *      宁可有漏网（用户写"背景用灰"不转换），也不能把"金属质感"改成"#D4AF37属质感"。
 *   ④ 🔴 **英文色词必须加 `\b` 词边界**（中文不需要，`\b` 是 ASCII 词边界）。
 *      加之前：`/red/i` 命中 hun**dred** / p**red**ict → "hundred items" 变成 "hun#C0392B items"；
 *      `/blue/i` 吃 blueprint / blueberry；`/black/i` 吃 blackberry / blacklist；
 *      `/wood/i` 吃 wooden；`/cream/i` 吃 s**cream**ing；`/rose/i` 吃 rosemary。
 *      代价是 "wooden / golden" 这类**材质形容词**不再转换 —— 这是对的，
 *      因为铁律 1 要转的是**颜色**，"wooden table" 说的是材质不是颜色。
 */
const COLOR_WORDS = [
  // —— 无彩色 ——
  [/米白|象牙白|燕麦|奶油白|\boff.?white\b|\boatmeal\b/i, HEX.offWhite],
  [/浅米|米色|奶油色|\bbeige\b|\bcream\b/i, HEX.lightBeige],
  [/纯白|白色背景|白底|白色|\bwhite\b/i, HEX.white],
  [/深灰|炭黑|暗灰|\bcharcoal\b|\bdark ?gr[ae]y\b/i, HEX.deepCharcoal],
  [/高级灰|浅灰|银灰|中灰|灰色|灰调|灰系|灰底|灰背景|\bgr[ae]y\b|\bsilver\b|\blight ?gr[ae]y\b/i, HEX.midGray],
  [/黑色|黑色调|黑调|\bblack\b/i, HEX.black],
  // —— 暖色 ——
  [/金色|黄金|香槟金|金调|\bgold\b|\bgolden\b|\bchampagne\b/i, HEX.gold],
  [/琥珀|琥珀色|\bamber\b/i, HEX.amber],
  [/古铜|青铜|\bbronze\b/i, HEX.bronze],
  [/紫铜|红铜|\bcopper\b/i, HEX.copper],
  [/橙色|橘色|橙调|\borange\b/i, HEX.orange],
  [/酒红|枣红|勃艮第|\bburgundy\b/i, HEX.burgundy],
  [/红色|红调|正红|\bred\b|\bcrimson\b/i, HEX.red],
  [/砖红|栗色|栗棕|\bmaroon\b/i, HEX.maroon],
  [/珊瑚|珊瑚色|\bcoral\b/i, HEX.coral],
  [/粉色|粉调|玫粉|\bpink\b|\brose\b/i, HEX.pink],
  [/洋红|品红|玫红|\bmagenta\b/i, HEX.magenta],
  [/藕荷|藕紫|淡紫红|\bmauve\b/i, HEX.mauve],
  [/梅子|李子紫|\bplum\b/i, HEX.plum],
  [/黄色|黄调|\byellow\b/i, HEX.yellow],
  [/棕色|咖啡色|褐色|\bbrown\b|\btan\b/i, HEX.brown],
  [/卡其|\bkhaki\b/i, HEX.khaki],
  [/原木|木色|胡桃|橡木|\bwood\b|\bwalnut\b/i, HEX.wood],
  [/灰褐|灰棕|驼色|\btaupe\b/i, HEX.taupe],
  // —— 冷色（深在先，浅/笼统在后）——
  [/深绿|墨绿|暗绿|祖母绿|森林绿|\bforest green\b|\bdeep green\b|\bdark green\b|\bemerald\b/i, HEX.deepGreen],
  [/森林|松绿|\bforest\b/i, HEX.forest],
  [/浅绿|鼠尾草|薄荷|绿色|绿调|\bsage\b|\bmint\b|\bgreen\b/i, HEX.sage],
  [/橄榄|橄榄绿|\bolive\b/i, HEX.olive],
  [/柠檬绿|青柠|莱姆|\blime\b/i, HEX.lime],
  [/海沫|薄荷绿|\bseafoam\b/i, HEX.seafoam],
  [/青绿|蓝绿|湖蓝|\bteal\b/i, HEX.teal],
  [/绿松石|土耳其蓝|\bturquoise\b/i, HEX.turquoise],
  [/深蓝|藏青|午夜蓝|\bnavy\b/i, HEX.navy],
  [/宝蓝|皇家蓝|\broyal blue\b/i, HEX.royalBlue],
  [/牛仔蓝|丹宁|\bdenim\b/i, HEX.denim],
  [/天蓝|浅蓝|粉蓝|\bsky blue\b|\blight blue\b/i, HEX.sky],
  [/蓝色|蓝调|\bblue\b/i, HEX.navy],
  [/紫色|紫调|\bpurple\b|\bviolet\b|薰衣草|\blavender\b/i, HEX.purple],
  [/丁香紫|淡紫|\blilac\b/i, HEX.lilac],
  [/靛蓝|靛青|\bindigo\b/i, HEX.indigo],
];

/**
 * 颜色**概念**词 —— 无法映射成单一 hex，必须显式提示用户补。
 *
 * 为什么单列：这些词要么是一整**色系**（莫兰迪、大地色），要么是**趋势名**（美拉德、多巴胺），
 * 要么是**材质/透明度**（金属、透明、渐变）。静默跳过等于让铁律 1 悄悄失效；
 * 硬塞一个 hex 又是编数据。正确做法是**报出来让人补**。
 */
const COLOR_CONCEPTS = [
  [/莫兰迪/i, "莫兰迪色系"],
  [/美拉德/i, "美拉德色系"],
  [/多巴胺色|多巴胺配色/i, "多巴胺配色"],
  [/大地色/i, "大地色系"],
  [/低饱和|高饱和|饱和度/i, "饱和度描述"],
  [/撞色|跳色/i, "撞色"],
  [/渐变色|渐变|\bgradient\b/i, "渐变色"],
  [/双色|拼色|双拼/i, "双色/拼色"],
  [/暖色|冷色|中性色|色调/i, "冷暖/色调"],
  [/复古色|果冻色|奶油风|微水泥|马卡龙/i, "风格化配色"],
  [/\bmulticolor|\bmulti-color|\bcolorful|\bassorted\b/i, "多色"],
  [/\biridescent|\bholographic|\bmetallic|\bpearlescent\b/i, "特殊质感色"],
  [/\btransparent|\btranslucent|透明|半透明/i, "透明/半透明"],
];

/**
 * 语种边界（写死在代码里，因为界面和文档都会反复引用它）。
 *
 * 这个工作台的语种支持是**不对称**的，必须说清，否则"支持多语种"会被听成"什么语种都能用"：
 *   · 词频 / 停用词：en + de/fr/es/it/nl/ja 共 7 套（listing.STOPWORDS_BY_LANG）
 *   · 利益词表（C3 判据）：en / zh / de / ja 共 4 套（listing.BENEFIT_WORDS_BY_LANG）
 *   · Prompt 输出：**只有中 / 英两套**
 *   · 因此法/西/意/荷 的文案可以抓、可以算词频，但 C3 只能「跳过并说明未覆盖」，
 *     不能拿英文词表硬套 —— 那会给出一个看似通过、实际没判过的结论。
 *     （德语必须靠显式语种开关：拉丁字母单看字形会被判成 en。）
 */
export const LANG_SUPPORT = {
  promptOutput: ["zh", "en"],
  benefitWords: ["zh", "en", "de", "ja"],
  stopwords: ["en", "de", "fr", "es", "it", "nl", "ja"],
  /**
   * detectScript 的取值域。"other" = 认得出不是拉丁/汉字/假名/谚文（西里尔、希腊、泰文…），
   * 一律不猜具体语种 —— 猜错比不猜更糟。
   */
  scripts: ["zh", "en", "ja", "ko", "other"],
};

/**
 * 判别**书写系统**（比语种保守，只为回答"能不能套中文/英文词表"）。
 *
 * 🔴 三个刻意的取舍：
 *   ① 只要有假名就是日文。中文里不出现平假名/片假名，这条判据零误伤；
 *      **纯汉字的日文标题与中文无法区分**，仍按 zh 处理 —— 这是已知的、写明的边界。
 *   ② 谚文（韩文）单独认，别让它落进 "en"。
 *   ③ 西里尔/希腊等一律归 "other"，不猜语种。
 */
export function detectScript(text) {
  const s = String(text || "");
  const kana = (s.match(/[\u3040-\u30ff]/g) || []).length;
  const hangul = (s.match(/[\uac00-\ud7af\u1100-\u11ff]/g) || []).length;
  const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  const other = (s.match(/[\u0400-\u04ff\u0370-\u03ff\u0e00-\u0e7f]/g) || []).length;
  if (kana > 0) return "ja";
  if (hangul > 0) return "ko";
  // 🔴 三者都为 0（空串 / 纯标点 / 纯数字）时兜底 "zh"：
  //    这个工作台的使用者是中文用户，纯数字输入（"350ml"）不该被翻成英文模式。
  if (cjk === 0 && latin === 0) return other > 0 ? "other" : "zh";
  if (other > latin) return "other";
  return cjk > latin ? "zh" : "en";
}

/**
 * 判断这段文字该用**中文词表还是英文词表**。
 *
 * ⚠️ 契约是二元的（zh / en），只在 zh·en 两种文案下有意义。日语、韩语等会落到 "en"，
 *    那不是"判成英文"，而是"没有第三套词表可选"。需要知道具体语种请用 detectScript()，
 *    需要"没把握就别判"请用 detectScript() 然后跳过（C3 就是这么做的）。
 */
export function detectLang(text) {
  return detectScript(text) === "zh" ? "zh" : "en";
}

/**
 * 铁律 2 + 3：图型 → 产品占比 / 留白下限
 * 数字来自 SKILL.md 的「产品占比黄金区间」与「留白必须显式声明」两节。
 */
export const FIGURE_SPEC = {
  // 🔴 main 的数值来自**亚马逊官方**（85-100% 占幅），不是 SKILL.md 的构图口径。
  //    其余图型是"设计构图"数值（来自 SKILL.md 的产品占比黄金区间）。
  main: { label: "亚马逊合规首图", productPct: [85, 100], whitespacePct: 0, maxEmptyPct: 15 },
  hero: { label: "白底主图", productPct: [35, 40], whitespacePct: 45 },
  benefit: { label: "卖点副图", productPct: [25, 30], whitespacePct: 45 },
  scene: { label: "场景氛围图", productPct: [20, 25], whitespacePct: 50 },
  feedAd: { label: "信息流广告", productPct: [40, 40], whitespacePct: 45 },
  searchAd: { label: "搜索广告", productPct: [45, 45], whitespacePct: 45 },
  sku: { label: "SKU 多规格卡", productPct: [60, 70], whitespacePct: 30 },
  pdp: { label: "详情页信息图", productPct: [30, 40], whitespacePct: 48 },
};

/**
 * 模板 → 图型（FIGURE_SPEC 的 key）的自动映射。
 *
 * 🔴 为什么必须有这张表：编排层原来是这么写的 ——
 *      `figure = tpl.id === "hero-image" ? "hero" : tpl.id === "lifestyle-scene" ? "scene" : "benefit"`
 *    也就是说 **25 个模板里只有 2 个被真正认出来**，剩下 23 个全被压成 `benefit`（卖点副图 25-30%）。
 *    后果举例：`infographic`（信息图）本该走详情页口径，却按"卖点副图"算占比；
 *    `poster-banner`（促销海报）本该按信息流广告口径，也被压成卖点副图。
 *    选了模板却不认模板，等于选型白做 —— 这属于"自动匹配"没做全。
 *
 * 默认回落 `benefit`（与旧行为一致，保证不改动未列入模板的表现）。
 */
export const TEMPLATE_FIGURE = {
  // 主图位
  "hero-image": "hero",
  "flat-lay": "hero",
  "detail-macro": "hero",
  "multi-angle-grid": "hero",
  "multi-product": "hero",
  "model-showcase": "hero",
  // 场景位
  "lifestyle-scene": "scene",
  "ugc-style": "scene",
  "livestream": "scene",
  "storefront": "scene",
  "try-on-virtual": "scene",
  // 广告位
  "poster-banner": "feedAd",
  "social-media": "feedAd",
  "creative-concept": "feedAd",
  "sports-campaign": "feedAd",
  "seasonal-campaign": "feedAd",
  // 详情页 / 说明位
  "infographic": "pdp",
  "size-spec": "pdp",
  "exploded-view": "pdp",
  // 干净背景展示产品本体 —— 语义上贴着 hero（主图口径），不是 benefit（带卖点的副图）
  "ghost-mannequin": "hero",
  "packaging": "benefit",
  "before-after": "benefit",
  "magazine-editorial": "benefit",
  "luxury-atmospherics": "benefit",
  "device-mockup": "benefit",
};

/** 模板的默认图型（未列入上表时回落 benefit，与历史行为一致） */
export function figureForTemplate(templateId) {
  return TEMPLATE_FIGURE[templateId] || "benefit";
}

/** 铁律 5：平台预留空间 */
const PLATFORM_RESERVE =
  "Reserve a completely empty 200x100 px area at top center (marketplace price overlay zone) and keep the top-left 200x100 px area fully clear (logo zone).";

/* ───────────────────── 亚马逊主图的"官方法规层" ─────────────────────
 * 🔴 为什么单列一层：SKILL.md 的"产品占比 35-40% + 留白 45%"是**设计构图**口径，
 *    它描述的是副图 / A+ / 广告素材，**不是**亚马逊首图（main image）的口径。
 *    亚马逊首图的硬要求是「产品占画幅 85-100%、纯白背景 RGB(255,255,255)、
 *    不得出现文字/水印/logo/边框/道具/多件」。
 *    两者相差极大：35% 的首图会直接被判不合规，而 45% 留白 + 85% 产品 = 130%（算术上就矛盾）。
 *    所以必须把「图位」和「构图占比」分开：图位决定合规约束，构图只在非首图成立。
 *
 * 来源（2026-09 核对）：
 *   · Amazon Seller Central「产品图片要求」：纯白背景 RGB 255,255,255；
 *     产品占画幅 85%-100%；最长边 ≥1000px 才能开启放大镜（建议 1600+，上限 10000）；
 *     首图不得有文字/logo/水印/边框/促销语；只展示可购买内容，不放未含道具。
 *   · Amazon Seller Central 2026 年 AI 图片披露规则：若图片含**照片级写实 AI 人像**
 *     （全身/面部/手部等），A+ 上传时必须勾选「AI-generated」「AI-generated people」披露。
 */
export const AMAZON_MAIN_IMAGE = {
  productPct: [85, 100],
  background: "#FFFFFF",
  backgroundRgb: "RGB(255,255,255)",
  maxEmptyPct: 15,
  minLongSidePx: 1000,
  recommendLongSidePx: 1600,
  maxLongSidePx: 10000,
  rule:
    "Amazon main-image compliance (hard requirements): pure white background #FFFFFF (RGB 255,255,255) with no shadows, " +
    "gradients or background props; the product must occupy 85-100% of the frame and be fully visible without cropping; " +
    "no text, no typography, no logos, no badges, no watermarks, no borders, no promotional overlays; " +
    "show only the purchasable unit (no extra props or accessories not included in the order); " +
    "longest side at least 1000 px (1600 px+ recommended for zoom, 10000 px max).",
  disclosure:
    "If this image contains photorealistic AI-generated people (full body, face, hands), Amazon requires an AI-generated disclosure at upload time (A+ Content: check both \"AI-generated\" and \"AI-generated people\").",
  /**
   * 🆕 主图不得是 AI 生成/重绘的成品图。
   *
   * 🔴 这条的**证据强度低于上面几条**：上面每一条都能指到官方图片指南的原文，
   *    而「商品主图禁止 AI 生成」目前只拿到二手口径（平台真实性要求 + 主图须为摄影作品
   *    这两条是官方的，把它们合并推到"禁 AI"是推论）。所以它单独成一个字段，
   *    并在 sourceTier 里标明待核实 —— 不混进 rule，免得把"确定"和"待核实"写在同一句里。
   */
  mainImageNoAi:
    "Amazon main image (slot 1) must truthfully show the actual product that ships: do not use AI-generated, " +
    "fully re-rendered or 3D-rendered imagery as the main image, because the main image must be a professional " +
    "photograph of the real item rather than an illustration or a reconstruction. AI assistance limited to " +
    "retouching a real photograph (background cleanup, dust removal) is the only safe zone.",
  /**
   * 🆕 AI 生成图的元数据标记 —— 这是**文件层面**的事，不是 Prompt 层面的事。
   *
   * 写成 Prompt 没有意义（模型不会替你写 XMP），所以它只进 meta.deliveryChecklist，
   * 在简报里作为"交付前核对"出现。本项目**不做**自动写 EXIF：纯浏览器没有写文件权限，
   * 承诺"我帮你打好标"就是空头支票。
   */
  aiMetadata:
    "若成图由 AI 生成或 AI 合成，上传前给文件打标：IPTC `DigitalSourceType` = `trainedAlgorithmicMedia`" +
    "（XMP 里是 `Iptc4xmpExt:DigitalSourceType`），并保留/附加一份 C2PA 清单或 `XMP-xmpMM:History` 生成记录；" +
    "不要顺手清掉原有的相机/XMP 元数据。",
  /** 每条口径的取证强度。界面与文档都按这个说，不许把"待核实"讲成"官方规定"。 */
  sourceTier: {
    mainImageNoAi: "官方两条（主图须为摄影作品、图片须如实代表商品）合并推论；「禁 AI 生成」专项原文未取得 → 待核实",
    aiMetadata: "IPTC / C2PA 行业规范；亚马逊是否强校验未取得官方原文",
  },
};

/** 图位 → 适用口径。`main` 走亚马逊首图法规层，其余走设计构图口径。 */
export const SLOTS = {
  design: "设计构图（副图 / A+ / 广告素材）—— 允许文字、信息图、留白",
  main: "亚马逊首图（main image）—— 纯白底、85-100% 占幅、禁止任何文字与叠加",
  secondary: "亚马逊副图（slot 2-9）—— 允许场景、文字、尺寸图、信息图",
  aplus: "A+ 内容模块 —— 允许图文混排；文字对 COSMO 语义层有效，纯图模块无效",
};

/** 铁律 5 的平台变体：国内电商是价格浮层，亚马逊首图是"别放任何东西" */
export function platformReserve(platform = "domestic") {
  if (platform === "amazon-main") {
    return "Keep the entire frame free of any overlay, badge, border or text — Amazon main images must contain nothing except the product on pure white.";
  }
  return PLATFORM_RESERVE;
}

/** 铁律 6：3 层信息架构 */
export function infoArchitecture(headline, evidence = [], cta = "") {
  const h = String(headline || "").trim();
  const problems = [];
  if (h && h.length > 15) problems.push(`核心承诺 ${h.length} 字 > 15 字上限`);
  if (evidence.length > 3) problems.push(`关键证据 ${evidence.length} 个 > 3 个上限`);
  const c = String(cta || "").trim();
  if (c && c.length > 8) problems.push(`CTA ${c.length} 字 > 8 字上限`);
  return {
    headline: h,
    evidence: evidence.slice(0, 3),
    cta: c,
    problems,
    ok: problems.length === 0,
  };
}

/** 铁律 4：否定清单（按场景追加具体禁止项，不写笼统的"不要多余的"） */
const BASE_NEGATIVE = [
  "props not requested",
  "hands",
  "watermarks",
  "fake logos",
  "extra text",
  "decorative elements",
  "gradient backgrounds",
];
const NEGATIVE_BY_SCENE = {
  "ugc-style": ["professional studio lighting", "flawless smooth skin", "perfect symmetry", "AI-generated look"],
  livestream: ["fake UI overlays that look like a real broadcast", "unreadable gibberish text"],
  "social-media": ["stock-photo look", "over-polished retouching"],
  "model-showcase": ["distorted anatomy", "extra fingers", "plastic skin"],
  "detail-macro": ["dust", "scratches", "visible fingerprints"],
  infographic: ["dense body text", "illegible small copy", "columns of paragraph text"],
};

export function negativeConstraints(templateId, extra = []) {
  const list = [...BASE_NEGATIVE, ...(NEGATIVE_BY_SCENE[templateId] || []), ...extra];
  return `Do NOT add: ${[...new Set(list)].join(", ")}.`;
}

/** Anti-AI 技巧（UGC / 直播 / 社媒 / 模特场景必用） */
export const ANTI_AI = [
  "Shoot on an iPhone 14 Pro (visible phone-camera rendering)",
  "Keep visible imperfection: real pores, slight sensor noise, warm color shift, casually imperfect framing",
  "NOT professional photography, NOT AI-generated look, NOT retouched, NOT smoothed",
  "Slightly lived-in real environment: everyday objects, small messiness, water marks",
  "Kodak Portra 400 color feel",
];
const ANTI_AI_SCOPES = new Set(["ugc-style", "livestream", "social-media", "model-showcase", "storefront"]);

/* ───────────────────────── 镜头语言 ───────────────────────── */

export const ANGLES = [
  { key: "front34", label: "正面 3/4", text: "at a slight 3/4 angle showing the full front facade", use: "主图、首图" },
  { key: "topdown", label: "正上方俯视", text: "photographed directly from above at a 90-degree overhead angle", use: "布局、内部结构、平铺" },
  { key: "side90", label: "侧面 90°", text: "photographed from a clean 90-degree side profile", use: "深度、层次、侧面细节" },
  { key: "rear45", label: "后侧 45°", text: "photographed from behind at a 45-degree rear angle", use: "背面细节、尾部构造" },
  { key: "lowup", label: "仰视低角度", text: "photographed from a very low angle looking upward", use: "英雄镜头、气势感" },
  { key: "high45", label: "高角度俯视", text: "photographed from a high 45-degree angle looking down", use: "顶部、整体规模、桌面视角" },
];

export const SHOTS = [
  { key: "full", label: "全景", text: "full product visible", kind: "wide" },
  { key: "mid", label: "中景", text: "showing the featured section area", kind: "mid" },
  { key: "close", label: "特写", text: "tight zoom on the key detail", kind: "close" },
  { key: "macro", label: "微距", text: "extreme close-up macro shot, shallow depth of field", kind: "macro" },
  { key: "part", label: "局部", text: "close-up detail shot focusing on a single part", kind: "close" },
];

/**
 * 多角度分配：满足 SKILL.md 的五条约束
 *   1. 不连续 3 张同角度
 *   2. 全景 ≤ 40%
 *   3. 仰视/俯视各 ≥ 1
 *   4. 主图序列 ≥3 种角度（其中 1 张特写/微距）；详情页 ≥4 种（其中 2 张特写/微距）
 * 做法：确定性轮转而不是随机 —— 随机每次结果不同，无法回归测试。
 */
export function assignAngles(count, { kind = "hero" } = {}) {
  const needDistinct = kind === "pdp" ? 4 : 3;
  const needClose = kind === "pdp" ? 2 : 1;
  const wideBudget = Math.max(1, Math.floor(count * 0.4));

  // 角度轮转顺序：保证俯视/仰视一定出现，且同角度不连排
  const rotation = ["front34", "high45", "side90", "lowup", "topdown", "rear45", "front34", "high45", "side90"];
  const out = [];
  let wideUsed = 0;
  for (let i = 0; i < count; i++) {
    let angle = i < rotation.length ? rotation[i] : "side90";
    // 特写/微距位：第 2 张与（pdp 时）倒数第 2 张
    const closeSlots = kind === "pdp" ? [1, count - 2] : [1];
    let shot;
    if (closeSlots.includes(i)) {
      shot = i === 1 ? "macro" : "close";
    } else if (wideUsed < wideBudget) {
      shot = "full";
      wideUsed++;
    } else {
      shot = i % 2 === 0 ? "mid" : "close";
    }
    // 不连续 3 张同角度
    if (i >= 2 && out[i - 1].angle === angle && out[i - 2].angle === angle) {
      const alt = ANGLES.map((a) => a.key).find((k) => k !== angle && k !== out[i - 1].angle);
      angle = alt || angle;
    }
    out.push({ angle, shot });
  }
  const distinct = new Set(out.map((o) => o.angle)).size;
  const closeCount = out.filter((o) => o.shot === "macro" || o.shot === "close").length;
  return {
    slots: out,
    audit: {
      distinctAngles: distinct,
      needDistinct,
      closeShots: closeCount,
      needClose,
      wideRatio: +(wideUsed / count).toFixed(3),
      ok: distinct >= needDistinct && closeCount >= needClose && wideUsed / count <= 0.4,
    },
  };
}

/* ───────────────────────── 转化驱动力诊断 ───────────────────────── */

const DRIVER_KEYWORDS = {
  visual: ["好看", "质感", "颜值", "设计感", "礼物", "礼盒", "高级", "精致", "外观", "搭配", "审美", "beautiful", "premium design", "gift"],
  pain: ["难用", "费时", "麻烦", "漏", "痛", "伤", "易坏", "清理", "异味", "打结", "缠", "发霉", "掉色", "过敏", "堵塞", "反复", "损失", "风险", "解决", "防", "避免", "不再", "省时", "leak", "clog", "tangle", "irritation", "waste"],
  emotion: ["自信", "归属", "身份", "陪伴", "快乐", "治愈", "仪式感", "安全感", "成长", "亲子", "独处", "社交", "炫耀", "couple", "family", "confidence"],
};

export function diagnoseConversionDriver(text) {
  const t = String(text || "").toLowerCase();
  const score = { visual: 0, pain: 0, emotion: 0 };
  const hits = { visual: [], pain: [], emotion: [] };
  for (const [k, words] of Object.entries(DRIVER_KEYWORDS)) {
    for (const w of words) {
      if (t.includes(w.toLowerCase())) {
        score[k]++;
        hits[k].push(w);
      }
    }
  }
  const winner = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  const total = score.visual + score.pain + score.emotion;
  const driver = total === 0 ? "visual" : winner[0];
  const META = {
    visual: { label: "视觉驱动型", order: "一眼吸引力 → 质感细节 → 使用场景 → 对比 → 优惠/CTA" },
    pain: { label: "痛点驱动型", order: "痛点快照 → 解决机制 → 利益证明 → 信任画面 → 优惠+紧迫 CTA" },
    emotion: { label: "情绪价值驱动型", order: "情绪场景钩子 → 身份表达 → 产品作为实现方式 → 社交信号 → 情绪化 CTA" },
  };
  return {
    driver,
    label: META[driver].label,
    order: META[driver].order,
    scores: score,
    hits,
    confidence: total === 0 ? 0 : +(winner[1] / total).toFixed(2),
    reason: total === 0
      ? "没有命中任何驱动力关键词，默认按视觉驱动型处理（最保守的电商通用序列）"
      : `命中关键词：${hits[driver].join("、")}`,
  };
}

/* ───────────────────── 自动模板匹配（第二版：上下文感知） ───────────────────── */

/**
 * 别名层 —— 上游 25 个模板 JSON 是**别人的仓库**（ecom-details-image，MIT），
 * `tools/build-templates.mjs` 的铁律是"只消费不改写、不手抄不合并字段"，
 * 所以词表里的空洞只能在本层补。**本表加的是读法，不是数据。**
 *
 * 2026-09-29 实测出的两个真实空洞：
 *   ① **服装类词几乎为零**：`T恤 / 衣服 / tee / shirt / apparel / garment / clothing`
 *      在全部 25 个模板里 **0 命中**。于是"给这件 T 恤做图"被丢给 `hero-image`（白底主图），
 *      而 `ghost-mannequin`（隐形模特）才是服装类真正在用的常规打法。
 *   ② 词表只描述"图长什么样"，不描述"什么产品该配什么图" —— 那是上下文的事，见下面的亲和表。
 *
 * 权重：别名命中比 keyword 略重、比 trigger_phrase 略轻。
 * 🔴 只补**实测确认空缺**且**不与现有模板冲突**的词；每个词都要能被断言验证。
 */
export const TEMPLATE_ALIASES = {
  "hero-image": { zh: ["首图", "白底照"], en: ["main image"] },
  // ⬇️ 服装类：本次补的最大一块空洞
  "ghost-mannequin": {
    zh: ["t恤", "衣服", "上衣", "衬衫", "卫衣", "毛衣", "连衣裙", "半身裙", "外套", "裤子", "裙子", "成衣", "服装", "不露脸"],
    en: ["t-shirt", "tshirt", "tee", "shirt", "apparel", "garment", "clothing", "blouse", "hoodie", "sweater", "outfit", "wearable", "streetwear"],
  },
  "model-showcase": { zh: ["模特上身", "上身展示", "真人模特", "外模"], en: ["on-model"] },
  "try-on-virtual": { zh: ["虚拟试衣", "虚拟试穿", "换装", "试戴"], en: ["virtual try-on", "try-on"] },
  "social-media": { zh: ["种草图", "小红书图", "社交图"], en: ["instagram post"] },
  "ugc-style": { zh: ["买家晒图", "素人图"] },
};

/** 品类 → 该品类常用的图型（用于上下文加权，也是"无关键词时"的回落依据） */
export const CATEGORY_TEMPLATE_AFFINITY = {
  fashion: ["ghost-mannequin", "model-showcase", "flat-lay", "try-on-virtual"],
  jewelry: ["detail-macro", "luxury-atmospherics", "model-showcase"],
  beauty: ["detail-macro", "before-after", "lifestyle-scene"],
  electronics: ["device-mockup", "exploded-view", "infographic", "multi-angle-grid"],
  food: ["detail-macro", "packaging", "lifestyle-scene"],
  home: ["lifestyle-scene", "size-spec", "flat-lay"],
  pet: ["lifestyle-scene", "ugc-style", "before-after"],
  outdoor: ["lifestyle-scene", "sports-campaign", "multi-angle-grid"],
};

/** 转化驱动力 → 常用图型（次要权重：驱动是"这句话想解决什么"，不如品类具体） */
const DRIVER_TEMPLATE_AFFINITY = {
  pain: ["before-after", "infographic", "size-spec"],
  visual: ["luxury-atmospherics", "magazine-editorial", "hero-image"],
  emotion: ["lifestyle-scene", "ugc-style", "seasonal-campaign"],
};

/**
 * 手里有参考图（图生图）时，真正吃参考图的模板。
 * 🔴 `hero-image` **刻意不在内** —— 它是"从零画一张白底图"，把参考图当加分项会
 *    让每次上传参考图都反而更偏向白底主图，方向正好是反的。
 * 未列出的模板仍然可以图生图（`supports_image_reference` 决定），只是不加这份权重。
 */
const REFERENCE_FAVORED = new Set([
  "try-on-virtual", "lifestyle-scene", "ghost-mannequin", "model-showcase", "device-mockup", "multi-product",
]);

/**
 * 给单个模板打分。**纯函数**，无副作用 —— 便于自检直接断言中间结果。
 *
 * 返回两组互相独立的证据：
 *   termScore —— 词证据（上游 trigger_phrases / keywords + 本层别名）
 *   ctxScore  —— 上下文证据（品类 / 驱动 / 参考图）
 * 排序时 **termScore > 0 的一律排在 termScore === 0 之前**（见 matchTemplate 的排序 ①），
 * 所以上下文**永远不会推翻用户明说的词**，只在两种情况起作用：
 *   ① 词证据打平 → 用上下文做 tie-break；
 *   ② 完全没有词证据 → 上下文接管，这就是"多级回落"。
 */
export function scoreTemplate(tpl, lowerText, ctx = {}) {
  // ── ① 词证据 ──
  // 用 Map 按**精确词**去重：同一个词既在 keywords 又在别名表时取权重高的那个，
  // 否则"服装"这种两处都出现的词会被重复计分，分数虚高。
  const map = new Map();
  const add = (raw, kind, base) => {
    const kw = String(raw == null ? "" : raw).trim().toLowerCase();
    if (!kw) return;
    const idx = lowerText.indexOf(kw);
    if (idx < 0) return;
    const prev = map.get(kw);
    if (prev) {
      if (base > prev.base) { prev.base = base; prev.kind = kind; }
      return;
    }
    map.set(kw, { kind, base, len: kw.length, idx });
  };
  for (const k of tpl.trigger_phrases || []) add(k, "trigger_phrase", 6);
  for (const k of tpl.keywords || []) add(k, "keyword", 0);
  const ali = TEMPLATE_ALIASES[tpl.id];
  if (ali) {
    for (const k of ali.zh || []) add(k, "alias", 3);
    for (const k of ali.en || []) add(k, "alias", 3);
  }

  const terms = [...map.entries()].map(([term, v]) => ({ term, ...v }));
  // 主证据 = 分最高的那个词（越长越具体、权重越高越可信）
  // 次要证据 = 其余命中，每个 +1 且**封顶 +3** —— 不封顶会奖励"词多"，而词多往往是噪音
  terms.sort((a, b) =>
    (b.len + b.base) - (a.len + a.base) ||
    a.idx - b.idx ||
    Number(b.kind === "trigger_phrase") - Number(a.kind === "trigger_phrase"));
  const best = terms[0] || null;
  const support = Math.min(3, Math.max(0, terms.length - 1));
  const termScore = best ? best.len + best.base + support : 0;

  // ── ② 上下文证据 ──
  const signals = [];
  let ctxScore = 0;
  if (ctx.category && (CATEGORY_TEMPLATE_AFFINITY[ctx.category] || []).includes(tpl.id)) {
    ctxScore += 6;
    signals.push(`品类「${ctx.category}」的常用图型`);
  }
  if (ctx.driver && (DRIVER_TEMPLATE_AFFINITY[ctx.driver] || []).includes(tpl.id)) {
    ctxScore += 3;
    signals.push(`「${ctx.driver}」驱动常用图型`);
  }
  if (ctx.hasReference && REFERENCE_FAVORED.has(tpl.id)) {
    ctxScore += 3;
    signals.push("吃参考图（图生图）");
  }
  if (best) signals.unshift(`命中「${best.term}」(${best.kind})`);

  return {
    id: tpl.id,
    order: tpl.order,
    name: tpl.name,
    termScore,
    ctxScore,
    total: termScore + ctxScore,
    bestTerm: best ? best.term : null,
    bestKind: best ? best.kind : null,
    bestLen: best ? best.len : 0,
    // 🔴 bestBase 单独返回，**不能混进 total 去当主排序键** —— 见 matchTemplate 排序注释
    bestBase: best ? best.base : 0,
    // 没命中任何词时给一个"排在最后"的位置值，免得 tie-break 时被误判成"位置 0 最靠前"
    bestIdx: best ? best.idx : Number.MAX_SAFE_INTEGER,
    termCount: terms.length,
    signals,
  };
}

/**
 * 自动选模板。**默认就是自动的** —— 用户不需要先去模板库挑一个。
 *
 * 触发条件：每一轮对话都会跑一次（`runLocalTurn` 的第 ① 步），输入是当轮消息文本
 *           ＋ 同一轮已算出的上下文（品类 / 转化驱动力 / 是否带参考图）。
 *           没有"关闭自动"的开关；只有**显式指定**能覆盖它（用户真去模板库点了模板时）。
 *
 * 匹配规则与优先级（自上而下，先满足者胜）：
 *   ① 显式指定（explicitId）—— `score: Infinity`，一票通过。
 *   ② 词证据：`trigger_phrases`（权重 6）> 本层别名（3）> `keywords`（0）；
 *      同权重看词长，长词更具体；再同位看出现位置，靠前的更可能是主意图。
 *   ③ 上下文证据：品类亲和（+6）> 驱动亲和（+3）＝ 参考图加成（+3）。
 *   ④ 排序时 **termScore > 0 的一律优先于 termScore === 0** —— 上下文的定位是
 *      "补位"，不是"推翻"。用户明说"促销海报"时，品类是 fashion 也不会改判。
 *   ⑤ 全都没证据时按模板 order 升序 → 稳定回落 `01-hero-image`（白底主图是万能兜底）。
 *
 * 匹配不到合适模板时（没有任何词证据）：
 *   交给上下文，按品类/驱动选「该品类最常用的图型」——
 *   fashion → `ghost-mannequin`、electronics → `device-mockup`、pet → `lifestyle-scene` …
 *   连上下文也没有（例如纯乱码 "zzz qqq"）→ 回落 `01-hero-image`，
 *   并在 `reason` 里说明这是最终兜底，而不是假装匹配上了。
 *
 * 返回值里的 `candidates` 是并列候选（top 3），供简报提示"也可以考虑这几个"——
 * 自动匹配要**可审议**，不能是黑盒。
 *
 * @param {string} text
 * @param {string|{explicitId?:string, context?:{category?:string, driver?:string, hasReference?:boolean}}} explicitOrOptions
 *   ⚠️ 兼容旧签名：第二参数是**字符串**时当作 `explicitId`。
 */
export function matchTemplate(text, explicitOrOptions) {
  const opts = typeof explicitOrOptions === "string"
    ? { explicitId: explicitOrOptions }
    : (explicitOrOptions || {});
  const explicitId = opts.explicitId;
  const ctx = opts.context || {};

  if (explicitId && TEMPLATES[explicitId]) {
    return {
      id: explicitId,
      score: Infinity,
      source: "explicit",
      reason: "用户显式指定（覆盖自动匹配）",
      templateName: TEMPLATES[explicitId].name,
      signals: ["显式指定"],
      candidates: [],
      auto: false,
    };
  }

  const lower = String(text == null ? "" : text).toLowerCase();
  const scored = TEMPLATE_LIST.map((tpl) => scoreTemplate(tpl, lower, ctx));
  // 🔴 排序键的顺序**极其敏感**，别随手调 —— 第一版实现把权重(base)加进 total 当主排序键，
  //    结果「直播间场景图」被判成 `lifestyle-scene`（"场景图"是它的 trigger_phrase，+6 分了），
  //    而正确答案是 `livestream`（"直播间"在句首，用户的主意图）。
  //    教训：**词长 > 位置 > 词权重**，词权重只能做同位决胜 —— 这与原实现定下的语义一致。
  scored.sort((a, b) => {
    // ① 用户明说的词 > 我推断的上下文（上下文永远不能推翻词证据）
    const ah = a.termScore > 0, bh = b.termScore > 0;
    if (ah !== bh) return ah ? -1 : 1;
    // ② 主证据词长 —— 越长越具体（"模特上身"比"模特"更明确）
    if (b.bestLen !== a.bestLen) return b.bestLen - a.bestLen;
    // ③ 出现位置 —— 越靠前越可能是主意图（中文意图通常头置）
    if (a.bestIdx !== b.bestIdx) return a.bestIdx - b.bestIdx;
    // ④ 词权重 —— trigger_phrase > alias > keyword，**仅在同长同位时决胜**
    if (b.bestBase !== a.bestBase) return b.bestBase - a.bestBase;
    // ⑤ 到这里才轮到上下文加成与次要证据（无词命中时全靠这一步产生"多级回落"）
    if (b.total !== a.total) return b.total - a.total;
    // ⑥ 最后按 order —— 保证"毫无证据"时稳定落到 01-hero-image
    return String(a.order).localeCompare(String(b.order));
  });

  const top = scored[0];
  const source = top.termScore > 0 ? "keyword" : top.ctxScore > 0 ? "context" : "fallback";
  const ctxSignals = top.signals.filter((s) => !s.startsWith("命中"));

  let reason;
  if (source === "keyword") {
    reason = `命中「${top.bestTerm}」（${top.bestKind}，长度 ${top.bestLen}，位置 ${top.bestIdx}）` +
      (ctxSignals.length ? `；另有上下文加成：${ctxSignals.join("、")}` : "");
  } else if (source === "context") {
    reason = `这句话里没有模板关键词，按上下文推断：${ctxSignals.join("、") || "（无）"}`;
  } else {
    reason = "无任何模板关键词、也无上下文线索，按 SKILL.md 规则回落 01-hero-image（白底主图是万能兜底）";
  }

  // 并列候选：只保留真的得了分的，且不含第一名自己
  const candidates = scored
    .slice(1, 4)
    .filter((s) => s.total > 0)
    .map((s) => ({ id: s.id, name: s.name, score: s.total, matched: s.bestTerm, why: s.signals.join("｜") }));

  return {
    id: top.id,
    score: top.total,
    reason,
    source,
    matched: top.bestTerm,
    templateName: top.name,
    signals: top.signals,
    candidates,
    auto: true,
  };
}

/** 品类判断（决定套用 category_tips） */
const CATEGORY_WORDS = {
  beauty: ["护肤", "精华", "面霜", "口红", "面膜", "洗面奶", "化妆品", "美妆", "skincare", "serum", "cream", "makeup"],
  electronics: ["耳机", "充电", "蓝牙", "音箱", "键盘", "鼠标", "手机", "电脑", "摄像头", "earbud", "charger", "speaker", "keyboard", "camera"],
  food: ["咖啡", "茶", "零食", "食品", "坚果", "调味", "饮料", "coffee", "tea", "snack", "food", "sauce"],
  fashion: ["衬衫", "连衣裙", "外套", "T恤", "裤", "鞋", "包", "帽", "shirt", "dress", "jacket", "shoes", "bag"],
  home: ["家居", "收纳", "厨房", "杯", "盘", "锅", "枕", "灯", "清洁", "home", "kitchen", "storage", "cup", "lamp"],
  jewelry: ["项链", "耳环", "戒指", "手链", "首饰", "宝石", "necklace", "earring", "ring", "bracelet", "jewelry"],
  pet: ["宠物", "猫", "狗", "猫砂", "牵引", "pet", "cat", "dog", "litter", "harness"],
  outdoor: ["户外", "露营", "登山", "帐篷", "背包", "outdoor", "camping", "hiking", "tent"],
};
export function detectCategory(text) {
  const t = String(text || "").toLowerCase();
  const hits = [];
  for (const [cat, words] of Object.entries(CATEGORY_WORDS)) {
    for (const w of words) if (t.includes(w.toLowerCase())) hits.push({ cat, w });
  }
  if (!hits.length) return { category: null, reason: "未识别出品类，跳过 category_tips" };
  const count = {};
  for (const h of hits) count[h.cat] = (count[h.cat] || 0) + 1;
  const category = Object.entries(count).sort((a, b) => b[1] - a[1])[0][0];
  return { category, reason: `命中品类词：${hits.filter((h) => h.cat === category).map((h) => h.w).join("、")}` };
}

/* ───────────────────────── 铁律 1：颜色规范化 ───────────────────────── */

/**
 * 铁律 1 执行器。
 *
 * 返回三样东西：
 *   text         —— 替换后的文本
 *   applied      —— 实际替换出的 hex 列表（用于简报里"hex 替换 ×N 处"）
 *   unrecognized —— 🔴 识别到"像颜色但没法映射"的词
 *
 * 为什么要有 unrecognized：静默跳过等于让铁律 1 悄悄失效。
 * 用户写"莫兰迪色系"，表里没有，如果什么都不说，他以为已经合规了。
 */
export function hexify(text) {
  let out = String(text || "");
  const applied = [];
  const globalize = (re) => new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");

  for (const [re, hex] of COLOR_WORDS) {
    // 用 global 副本：一段描述里同一个色词可能要换多处
    // （"深灰炭黑文字" 只换第一处就是漏网）。不直接给表里的正则加 g，
    // 是为了避免 test/lastIndex 在被反复调用时留下状态。
    const g = globalize(re);
    const hits = out.match(g);
    if (!hits) continue;
    for (let i = 0; i < hits.length; i++) applied.push(hex);
    out = out.replace(g, hex);
  }

  const unrecognized = [];
  for (const [re, label] of COLOR_CONCEPTS) {
    if (globalize(re).test(out) && !unrecognized.includes(label)) unrecognized.push(label);
  }
  // 原始文本里已经写了的 hex 不算"未识别"，但要在 applied 之外单独标出来
  const preExistingHex = (String(text || "").match(/#[0-9A-Fa-f]{6}/g) || []).length;

  return { text: out, applied, unrecognized, preExistingHex };
}

/* ───────────────────────── Campaign Style Lock ───────────────────────── */

export const DEFAULT_STYLE_LOCK =
  "Campaign Style Lock: consistent premium ecommerce visual system across the entire image set; " +
  "fixed palette of clean off-white background (#FAF7F2), deep charcoal text (#2D2D2D), one product-matched accent color, " +
  "and one soft secondary accent; neutral-cool studio lighting; modern geometric sans-serif headline placeholders only; " +
  "consistent rounded rectangular info labels; consistent thin-line icon style; clean high-end product photography " +
  "mixed with minimal infographic elements; stable product scale and placement; generous whitespace; " +
  "no color palette changes, no mixed fonts, no random backgrounds, no inconsistent lighting, no mismatched icon styles.";

export const STYLE_LOCK_DIMENSIONS = [
  "视觉方向", "固定色板（2-3 主色 + 1 强调色）", "冷暖调", "字体系统", "背景系统",
  "光线系统", "布局系统", "图标/插画系统", "产品呈现规则", "禁止漂移项",
];

export function buildStyleLock({ direction, background, textColor, accent, temperature, font, lighting, layout, icon, drift = [] } = {}) {
  const d = {
    direction: direction || "premium cross-border ecommerce",
    background: background || HEX.offWhite,
    textColor: textColor || HEX.deepCharcoal,
    accent: accent || HEX.deepGreen,
    temperature: temperature || "neutral-cool",
    font: font || "modern geometric sans-serif",
    lighting: lighting || "neutral studio lighting, soft directional key light from upper left",
    layout: layout || "rounded rectangular info labels with generous whitespace",
    icon: icon || "consistent thin-line icons, uniform 1.5px stroke",
  };
  const driftText = ["color palette changes", "mixed fonts", "random backgrounds", "inconsistent lighting", "mismatched icon styles", ...drift];
  return [
    "Campaign Style Lock:",
    `visual direction = ${d.direction};`,
    `fixed palette = background ${d.background}, text ${d.textColor}, accent ${d.accent};`,
    `temperature = ${d.temperature} (identical across the whole set);`,
    `typography = ${d.font} only, no serif/handwritten/retro/cartoon mix;`,
    `background system = ${d.background} continuous surface;`,
    `lighting system = ${d.lighting};`,
    `layout system = ${d.layout};`,
    `icon system = ${d.icon};`,
    `product presentation = stable scale, stable angle family, consistent material rendering;`,
    `never drift: ${driftText.join(", ")}.`,
  ].join(" ");
}

/* ───────────────────────── 视觉节奏（背景色交替）───────────────────────── */

const RHYTHM_PALETTE = [HEX.white, HEX.lightBeige, HEX.deepGreen];

/** 连续多张图背景不能完全一样，交替 2-3 种 */
export function rhythmBackground(index) {
  return RHYTHM_PALETTE[index % RHYTHM_PALETTE.length];
}

/* ───────────────────────── 主图 / 详情页序列 ───────────────────────── */

export const HERO_SEQUENCES = {
  visual: [
    { code: "H1", purpose: "一眼可懂的视觉主张", figure: "hero", template: "hero-image", headline: "Instant visual hook" },
    { code: "H2", purpose: "核心功能或质感特写", figure: "benefit", template: "detail-macro", headline: "Texture you can feel" },
    { code: "H3", purpose: "使用场景匹配", figure: "scene", template: "lifestyle-scene", headline: "Fits your everyday" },
    { code: "H4", purpose: "普通方案 vs 升级方案对比", figure: "benefit", template: "before-after", headline: "Old way vs this way" },
    { code: "H5", purpose: "优惠、物流、保障或 CTA", figure: "benefit", template: "poster-banner", headline: "Ready to upgrade" },
  ],
  pain: [
    { code: "H1", purpose: "问题快照", figure: "hero", template: "before-after", headline: "The problem, squared" },
    { code: "H2", purpose: "解决机制", figure: "benefit", template: "detail-macro", headline: "How it works" },
    { code: "H3", purpose: "利益证明", figure: "benefit", template: "infographic", headline: "Proof, not claims" },
    { code: "H4", purpose: "信任画面", figure: "benefit", template: "packaging", headline: "Built to be trusted" },
    { code: "H5", purpose: "优惠 + 紧迫 CTA", figure: "feedAd", template: "poster-banner", headline: "Fix it today" },
  ],
  emotion: [
    { code: "H1", purpose: "情绪场景钩子", figure: "scene", template: "lifestyle-scene", headline: "How it should feel" },
    { code: "H2", purpose: "身份 / 价值表达", figure: "scene", template: "model-showcase", headline: "Made for you" },
    { code: "H3", purpose: "产品作为实现方式", figure: "hero", template: "hero-image", headline: "The one object" },
    { code: "H4", purpose: "归属、地位或社交信号", figure: "scene", template: "social-media", headline: "Share the moment" },
    { code: "H5", purpose: "带情绪强化的优惠 + CTA", figure: "feedAd", template: "poster-banner", headline: "Bring it home" },
  ],
};

export const PDP_SEQUENCE = [
  { code: "D1", purpose: "首屏承接：延续主图卖点，说明为谁解决什么问题", template: "infographic", headline: "Who this is for" },
  { code: "D2", purpose: "痛点放大：展示用户当前的不便、损失、风险", template: "before-after", headline: "What it costs you now" },
  { code: "D3", purpose: "机制解释：视觉化说明产品如何发挥作用（不虚构数据）", template: "exploded-view", headline: "What's inside" },
  { code: "D4", purpose: "核心利益：2-4 个主要利益做成易扫读信息图", template: "infographic", headline: "Core benefits" },
  { code: "D5", purpose: "使用步骤：3-4 步说明怎么用", template: "size-spec", headline: "How to use it" },
  { code: "D6", purpose: "场景覆盖：典型使用场景、适用对象", template: "lifestyle-scene", headline: "Where it works" },
  { code: "D7", purpose: "对比选择：普通方案 vs 本产品", template: "before-after", headline: "Why this one" },
  { code: "D8", purpose: "信任背书：材料、包装、质检（无证据写 proof placeholder）", template: "detail-macro", headline: "Materials & quality" },
  { code: "D9", purpose: "FAQ / 风险逆转 / CTA", template: "poster-banner", headline: "Still deciding?" },
];

/* ───────────────────────── Prompt 组装 ───────────────────────── */

/**
 * 像素尺寸 → 比例文本。
 * SKILL.md 要求 Prompt 里写画幅比例，而前端的 size 是像素格式（1024x1024）。
 * 直接写 "aspect ratio 1024x1024" 是不合规的 —— 回归测试在这里报过 "缺少画幅比例"。
 */
/**
 * 比例 ↔ 像素：**全项目唯一的映射表**。
 *
 * 🔴 为什么必须只有一份（2026-11-05 修）
 *    server.mjs 原来自己写了一份 RATIO_OF_PIXELS，两边集合不一致：
 *    `1536x1024`（3:2）、`864x1536`（9:16）只在浏览器侧认识，服务端的 `toRatio()`
 *    查不到就**静默回落成 1:1** —— 用户要 3:2，拿到方图，且没有任何报错。
 *    现在服务端从这里 import，多一处映射就会被 selftest 拦下。
 *
 * 像素值的选择原则：比例必须精确（16:9 不能给成 1024x768），
 * 同时优先落在主流生图接口认识的尺寸上。
 */
export const RATIO_PIXELS = {
  "1:1": "1024x1024",
  "4:3": "1024x768",
  "3:4": "768x1024",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
  "16:9": "1536x864",
  "9:16": "864x1536",
  "4:5": "819x1024",
  "5:4": "1024x819",
};

/**
 * 像素 → 比例。由 RATIO_PIXELS 反查生成（保证两向永远一致），
 * 再补几个"历史值 / 外部传入值"做兜底 —— 它们不在正查表里，但必须认得出来，
 * 否则老数据或第三方 API 回传的尺寸会被判成 1:1。
 */
export const PIXEL_TO_RATIO = {
  ...Object.fromEntries(Object.entries(RATIO_PIXELS).map(([r, px]) => [px, r])),
  "2048x2048": "1:1",
  "768x1152": "2:3",
  "720x1280": "9:16",
  "1280x720": "16:9",
  "1024x576": "16:9",
  "1152x864": "4:3",
};

/** 像素 / 比例 任意输入 → 比例文本。非法输入兜底 1:1（这是最后一道，不是主链路）。 */
export function toRatioText(size) {
  if (!size) return "1:1";
  const s = String(size).trim();
  if (s.includes(":")) return s;
  return PIXEL_TO_RATIO[s] || "1:1";
}

/**
 * 同步生图接口（OpenAI 兼容 `/images/generations`）**只接受这三种画布**。
 *
 * 🔴 这是「画幅口径分叉」的第二半：异步接口收比例字符串（"16:9"），同步接口收像素，
 *    而像素白名单只有下面三个。RATIO_PIXELS 里的 9 个比例，有 6 个对应的像素
 *    （1024x768 / 1536x864 / 768x1024 / 819x1024 / 1024x819 / 864x1536）不在白名单里 ——
 *    原样发出去就是 400，而不是"出了一张奇怪的图"。所以同步模式必须按方向吸附。
 */
export const SYNC_CANVAS = { square: "1024x1024", landscape: "1536x1024", portrait: "1024x1536" };

/** 比例 → 同步画布。返回 { size, exact }；exact=false 表示被吸附过（比例变了）。 */
export function syncCanvasFor(ratio) {
  const [w, h] = String(ratio || "1:1").split(":").map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return { size: SYNC_CANVAS.square, exact: false };
  if (w === h) return { size: SYNC_CANVAS.square, exact: true };
  // 3:2 与 2:3 正好是 1536x1024 / 1024x1536，属于"不用改"；其余横竖比例都会被吸附。
  return w > h
    ? { size: SYNC_CANVAS.landscape, exact: w / h === 1.5 }
    : { size: SYNC_CANVAS.portrait, exact: h / w === 1.5 };
}

/**
 * 「想要的画幅」→「这次实际发出去的尺寸」。两种模式口径不同，这里一次算清：
 *   · async：发**比例字符串**，不用吸附；
 *   · sync free：发 RATIO_PIXELS 原文（自建/代理接口收任意尺寸时用）；
 *   · sync strict（默认）：吸附到 SYNC_CANVAS，并把吸附事实写进 note。
 * 🔴 note 非空时调用方**必须**把它显示出来 —— 悄悄换掉画幅比报错更坏。
 */
export function resolveSendSize(size, mode, syncMode = "strict") {
  const ratio = toRatioText(size);
  if (mode === "async") return { sent: ratio, ratio, note: "" };
  if (syncMode === "free") return { sent: RATIO_PIXELS[ratio] || SYNC_CANVAS.square, ratio, note: "" };
  const { size: px, exact } = syncCanvasFor(ratio);
  return {
    sent: px,
    ratio,
    note: exact ? "" : `画幅已吸附：请求 ${ratio}（${RATIO_PIXELS[ratio] || "未知"}），同步接口只接受 1024x1024 / 1536x1024 / 1024x1536，实际发送 ${px}，成图比例与请求不同`,
  };
}

/** 占比统一写法：区间写 35-40%，单值写 ~40%（避免 "40-40%" 这种读不通的输出） */
function pctText(range) {
  const [a, b] = range;
  return a === b ? `~${a}%` : `${a}-${b}%`;
}

/** 把模板的 prompt_template 拍平成自然语言（只保留有值的字段） */
export function flattenTemplate(template, vars = {}, { variant, category } = {}) {
  const applyVars = (s) =>
    String(s).replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null && vars[k] !== "" ? vars[k] : `{${k}}`));

  const merged = { ...(template.defaults || {}), ...(template.prompt_template || {}) };

  // 应用风格变体
  let variantNote = "";
  if (variant && template.variants?.[variant]) {
    const v = template.variants[variant];
    Object.assign(merged, v.overrides || {});
    variantNote = `Style variant "${variant}" (${v.description}): applied overrides — ${Object.keys(v.overrides || {}).join(", ")}.`;
  }

  // 应用品类建议
  let categoryNote = "";
  if (category && template.category_tips?.[category]) {
    categoryNote = `Category guidance (${category}): ${template.category_tips[category]}`;
  }

  const parts = Object.entries(merged)
    .filter(([, v]) => v != null && String(v).trim() !== "")
    .map(([k, v]) => `${k}: ${applyVars(v)}`);

  return {
    text: parts.join("; ") + ".",
    fields: Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, applyVars(v)])),
    variantNote,
    categoryNote,
    hexified: hexify(parts.join("; ")),
  };
}

/**
 * 组装最终图片 Prompt。
 * 顺序严格按 SKILL.md「通用图片 Prompt 结构」的 9 段。
 */
export function composePrompt({
  subject,
  templateId = "hero-image",
  figure = "hero",
  variant,
  category,
  styleLock,
  angleKey = "front34",
  shotKey = "full",
  background,
  colorNote,
  headline = "",
  evidence = [],
  cta = "",
  includePlatformReserve = false,
  extraNegative = [],
  includeAntiAI,
  sizeRatio,
  infographic = false,
  purpose,
  mood,
  slot,                 // undefined/"design" | "main" | "secondary" | "aplus"
}) {
  const isMain = slot === "main";
  const template = TEMPLATES[templateId] || TEMPLATES["hero-image"];
  const flat = flattenTemplate(template, { product_description: subject, product: subject, color: colorNote || subject }, { variant, category });
  const spec = isMain ? FIGURE_SPEC.main : (FIGURE_SPEC[figure] || FIGURE_SPEC.hero);
  const angle = ANGLES.find((a) => a.key === angleKey) || ANGLES[0];
  const shot = SHOTS.find((s) => s.key === shotKey) || SHOTS[0];
  // 🔴 首图背景只能是纯白，不接受视觉节奏里的米白/深绿交替
  const bg = isMain ? AMAZON_MAIN_IMAGE.background : (background || HEX.white);

  const blocks = [];
  // 1. Campaign Style Lock（多图任务第一段，原样复制）
  if (styleLock) blocks.push(styleLock);
  // 2. 主体和场景 —— 详情页必须以 "E-commerce infographic" 起头（详情页信息图铁律）
  blocks.push(`Subject and scene: ${infographic && !isMain ? "E-commerce infographic layout — " : ""}${subject}. ${flat.text}${flat.variantNote ? " " + flat.variantNote : ""}${flat.categoryNote ? " " + flat.categoryNote : ""}`);
  if (infographic && !isMain) {
    blocks.push(`Infographic elements (required, do not omit): clean modular grid layout, feature callout icons, thin connecting lines, numbered circles, trust badges, generous whitespace between modules.`);
  }
  // 3. 目的与情绪
  blocks.push(`Purpose and mood: ${purpose || `${template.name} for e-commerce conversion`}${mood ? `; mood = ${mood}` : ""}.`);
  // 4. 构图 / 镜头 / 取景 —— 显式写角度关键词（SKILL.md 强制）
  blocks.push(`Composition, lens and framing: ${angle.text} (${angle.label}); ${shot.text}; camera positioned to keep the product centered with clean negative space.`);
  // 5. 光线、颜色、材质纹理
  blocks.push(`Lighting, color and material: background ${bg}; text ${HEX.deepCharcoal}; accent ${HEX.deepGreen}; soft directional key light from upper left with gentle falloff; clearly describe surface texture (matte, brushed metal, frosted glass, silk sheen where applicable).`);
  // 6. 风格与真实感等级
  blocks.push(`Style and realism: high-end commercial product photography, 8K detail, physically accurate materials.`);
  // 7. 平台限制与画幅 —— 铁律 2（数字占比）+ 铁律 3（显式留白）+ 铁律 5（预留区）
  //    ⚠️ 这里必须写比例（1:1）而不是像素（1024x1024），SKILL.md 的口径是比例
  const ratioText = isMain ? "1:1" : toRatioText(sizeRatio);
  if (isMain) {
    blocks.push(
      `Platform constraints: aspect ratio ${ratioText}; product occupies ${pctText(AMAZON_MAIN_IMAGE.productPct)} of the frame ` +
      `(this is the Amazon main-image requirement — deliberately NOT the 35-40% design-composition ratio used for secondary images); ` +
      `at most ${AMAZON_MAIN_IMAGE.maxEmptyPct}% of the frame may stay empty. ${AMAZON_MAIN_IMAGE.rule} ${platformReserve("amazon-main")}`
    );
  } else {
    blocks.push(`Platform constraints: aspect ratio ${ratioText}; product occupies ${pctText(spec.productPct)} of the frame; at least ${spec.whitespacePct}% of the image must stay as clean empty whitespace.${includePlatformReserve ? " " + PLATFORM_RESERVE : ""}`);
  }
  // 8. 图片内文字 —— 铁律 6（3 层信息架构）
  //    🔴 首图例外：亚马逊首图禁止任何文字/角标/水印。这里平台法规**优先于**铁律 6，
  //       否则会生成一张"设计上很规范、上架就被拒"的图。
  const arch = infoArchitecture(headline, evidence, cta);
  if (isMain) {
    blocks.push(`In-image text: NONE. Amazon main images must not contain any text, typography, labels, badges, icons, borders or watermarks — this rule overrides the usual 3-layer in-image text architecture.`);
  } else if (arch.headline || arch.evidence.length || arch.cta) {
    const lines = [];
    if (arch.headline) lines.push(`headline in ${HEX.deepCharcoal} at 28-48pt reading 「${arch.headline}」`);
    if (arch.evidence.length) lines.push(`2-3 thin-line icon labels at 12-14pt: ${arch.evidence.map((e) => `「${e}」`).join(", ")}`);
    if (arch.cta) lines.push(`CTA button placeholder reading 「${arch.cta}」`);
    blocks.push(`In-image text (3-layer architecture, short and readable, no dense body copy): ${lines.join("; ")}.`);
  } else if (["infographic", "poster-banner", "size-spec", "before-after"].includes(templateId)) {
    blocks.push(`In-image text: clean layout with short readable headline placeholders, no dense body text. Use 「」 CJK quotes for any Chinese copy.`);
  }
  // 9. 负面约束
  const extraNeg = isMain
    ? ["any text or typography", "logos or brand badges", "watermarks", "borders or frames", "promotional overlays", "props or accessories not included", "multiple units", "colored or gradient background", "shadows cast on the background", ...extraNegative]
    : extraNegative;
  blocks.push(negativeConstraints(templateId, extraNeg));

  const antiAI = includeAntiAI ?? (ANTI_AI_SCOPES.has(templateId) && !isMain);
  if (antiAI) blocks.push("Anti-AI treatment: " + ANTI_AI.join("; ") + ".");

  // 合规提示：走写实 AI 人像的图位，2026 起亚马逊要求上传时勾选 AI 披露
  const peopleScenes = antiAI || templateId === "model-showcase" || templateId === "ugc-style";
  const complianceNotes = [];
  if (!isMain && peopleScenes) complianceNotes.push(AMAZON_MAIN_IMAGE.disclosure);
  if (isMain) complianceNotes.push(
    AMAZON_MAIN_IMAGE.mainImageNoAi,
    `Upload checklist: filename must contain the product identifier (ASIN/UPC/EAN/ISBN); longest side >= ${AMAZON_MAIN_IMAGE.minLongSidePx} px (${AMAZON_MAIN_IMAGE.recommendLongSidePx} px+ enables zoom); only one image slot (slot 1) is bound by these main-image rules.`
  );
  if (complianceNotes.length) blocks.push("Compliance note: " + complianceNotes.join(" "));

  // 交付前核对：文件层面的事（元数据 / 打标 / 如实性），与 Prompt 无关，所以单独走一条通道。
  const deliveryChecklist = [];
  if (isMain) {
    deliveryChecklist.push(`slot 1 必须是**实物拍摄**。${AMAZON_MAIN_IMAGE.sourceTier.mainImageNoAi}`);
  } else {
    deliveryChecklist.push(AMAZON_MAIN_IMAGE.aiMetadata);
  }
  if (!isMain && peopleScenes) {
    deliveryChecklist.push("图里出现照片级写实 AI 人像时，A+ 上传要同时勾「AI-generated」和「AI-generated people」两项披露。");
  }

  return {
    prompt: blocks.join("\n"),
    meta: {
      templateId,
      templateName: template.name,
      figure,
      figureLabel: spec.label,
      slot: slot || "design",
      amazonMain: isMain,
      productPct: spec.productPct,
      whitespacePct: spec.whitespacePct,
      angle: angle.label,
      shot: shot.label,
      ratio: ratioText,
      infoArchitecture: arch,
      negative: negativeConstraints(templateId, extraNeg),
      antiAI,
      infographic: infographic && !isMain,
      hexApplied: flat.hexified.applied,
      hexUnrecognized: flat.hexified.unrecognized,
      complianceNotes,
      deliveryChecklist,
    },
  };
}

/** 图生图 Prompt：保留产品身份，改造场景/姿态/光线/风格 —— 不写 preserve composition */
export function composeImg2ImgPrompt({ target, scene, styleLock, templateId = "lifestyle-scene", figure = "scene", sizeRatio = "1:1", extraNegative = [] }) {
  const spec = FIGURE_SPEC[figure] || FIGURE_SPEC.scene;
  const blocks = [];
  if (styleLock) blocks.push(styleLock);
  blocks.push(`Change target: ${target}`);
  blocks.push(`New scene and styling: ${scene}`);
  blocks.push(`Composition: keep the product clearly readable; product occupies ${pctText(spec.productPct)}, at least ${spec.whitespacePct}% clean whitespace; aspect ratio ${toRatioText(sizeRatio)}.`);
  blocks.push(`Lighting and material: soft directional light, physically accurate material response.`);
  blocks.push(negativeConstraints(templateId, extraNegative));
  blocks.push("preserving the original product identity, pattern, colors and material.");
  return {
    prompt: blocks.join("\n"),
    meta: { mode: "img2img", templateId, figure, ratio: toRatioText(sizeRatio), preserved: ["product identity", "pattern", "colors", "material"] },
  };
}

/* ───────────────────────── 整套图片包规划 ───────────────────────── */

const SIZE_BY_FIGURE = {
  main: "1024x1024",
  hero: "1024x1024",
  benefit: "1024x1024",
  scene: "1024x1024",
  feedAd: "1024x768",
  searchAd: "1024x768",
  sku: "1024x1024",
  pdp: "768x1024",
};

/**
 * 规划一套图片包。多图任务必先建立 Style Lock，每张复用同一段。
 * 返回每张的完整 Prompt，前端可逐张生成、也可整包导出。
 *
 * 画幅优先级：`pdpRatio` / `heroRatio`（分组建模） > `ratio`（全局覆盖，向后兼容） > 默认。
 * 🔴 首图永远是 1:1 —— 平台合规位不接受用户指定比例。
 */
export function planImagePack({ subject, driver, styleLock, variant, category, pack = "pdp", ratio, heroRatio, pdpRatio, amazonMain = false } = {}) {
  const d = driver || diagnoseConversionDriver(subject).driver;
  const lock = styleLock || buildStyleLock({});
  const hero = HERO_SEQUENCES[d];
  const items = [];

  // 亚马逊合规首图（可选）：排在最前，走 FIGURE_SPEC.main + slot="main" 的法规层
  if (amazonMain) {
    items.push({ group: "main", code: "M0", purpose: "亚马逊首图（合规位：纯白底 / 85-100% / 无文字）", figure: "main", template: "hero-image", headline: "" });
  }
  for (const h of hero) items.push({ group: "hero", ...h });
  if (pack === "pdp") {
    for (const p of PDP_SEQUENCE) items.push({ group: "pdp", ...p });
  }

  const heroCount = hero.length;
  const heroAngles = assignAngles(heroCount + (amazonMain ? 1 : 0), { kind: "hero" });
  const pdpCount = items.filter((i) => i.group === "pdp").length;
  const pdpAngles = assignAngles(pdpCount, { kind: "pdp" });
  const pool = { hero: heroAngles, pdp: pdpAngles };
  const cursor = { hero: 0, pdp: 0 };

  const planned = items.map((item, idx) => {
    const kind = item.group === "pdp" ? "pdp" : "hero";   // 首图与主图共用角度池
    const slot = item.group === "main" ? "main" : item.group === "pdp" ? "aplus" : "secondary";
    const slotIndex = cursor[kind]++;
    const slotData = pool[kind].slots[slotIndex];
    const figure = item.figure || (kind === "pdp" ? "pdp" : "hero");
    // ⚠️ 画幅按「组」定，不按 figure 定：亚马逊主图/副图一律 1:1，详情页一律竖版。
    //    figure 只决定产品占比与留白（铁律 2/3），不该把 feedAd 的 4:3 混进主图序列。
    const groupRatio = kind === "pdp" ? pdpRatio : heroRatio;
    const size = slot === "main"
      ? SIZE_BY_FIGURE.main
      : (groupRatio || ratio || (kind === "pdp" ? SIZE_BY_FIGURE.pdp : SIZE_BY_FIGURE.hero));
    const isInfographic = kind === "pdp" || item.template === "infographic";
    const headline = isInfographic ? `「${item.headline}」` : item.headline;
    const c = composePrompt({
      subject,
      templateId: isInfographic && item.template !== "before-after" && item.template !== "poster-banner" ? "infographic" : item.template,
      figure,
      slot,
      variant,
      category,
      styleLock: lock,
      angleKey: slotData.angle,
      shotKey: slotData.shot,
      background: rhythmBackground(idx),
      headline,
      evidence: item.evidence || [],
      cta: item.cta || "",
      sizeRatio: size,
      infographic: isInfographic,
      purpose: item.purpose,
      includePlatformReserve: false,
    });
    return {
      index: idx + 1,
      group: item.group,
      slot,
      code: item.code,
      purpose: item.purpose,
      templateId: c.meta.templateId,
      templateName: c.meta.templateName,
      size,
      angle: c.meta.angle,
      shot: c.meta.shot,
      background: c.meta.amazonMain ? AMAZON_MAIN_IMAGE.background : rhythmBackground(idx),
      headline: item.headline,
      prompt: c.prompt,
      meta: c.meta,
    };
  });

  return {
    driver: d,
    subject,
    styleLock: lock,
    amazonMain,
    counts: { main: amazonMain ? 1 : 0, hero: heroCount, pdp: pdpCount, total: planned.length },
    angleAudit: { hero: heroAngles.audit, pdp: pdpAngles.audit },
    items: planned,
  };
}

/* ───────────────────────── 自检 ───────────────────────── */

/**
 * 对一套规划做机械校验（对应 SKILL.md 的 QA 检查清单）。
 * 返回问题列表 —— 空数组表示通过。
 *
 * 🔴 分两类口径：
 *   slot === "main" → 按**亚马逊首图法规**判（85-100% 占幅、纯白、无文字）
 *   其余             → 按**设计构图口径**判（35-40% 占幅 + 显式留白）
 * 混用会导致"设计上合规、上架被拒"或反过来，所以必须分开。
 */
const PROMPT_MAX_CHARS = 4000;   // 项目自定义经验阈值：超长 Prompt 部分模型会静默截断

export function auditPlan(plan) {
  const problems = [];
  const items = plan.items || [];
  if (!items.length) return ["规划为空"];

  // 主体健全性 —— 主体会被拼进每一张的 "Subject and scene:"，抽脏了 14 张全脏
  // 🔴 中文按 2 计权：CJK 每字信息量更大，"宠物自动喂食器"(7 字) 已经是一个完整品名，
  //    而 40 个汉字必然是指令被整句抽了进来。
  const subj = String(plan.subject || "").trim();
  const subjWeight = [...subj].reduce((n, ch) => n + (/[\u4e00-\u9fa5]/.test(ch) ? 2 : 1), 0);
  if (!subj) {
    problems.push("主体缺失：没有产品名，整套 Prompt 的产品位是空的");
  } else if (/\{PRODUCT\}/.test(subj)) {
    problems.push("主体是 {PRODUCT} 占位符：请先替换成实际产品名再拿去出图");
  } else if (subjWeight > 50) {
    problems.push(`主体过长（${subj.length} 字符 / 计权 ${subjWeight}）：很可能把指令当成了产品名 —— "${subj.slice(0, 40)}…"`);
  }

  const lockHead = plan.styleLock.slice(0, 40);
  for (const it of items) {
    if (!it.prompt.startsWith(lockHead)) problems.push(`${it.code}: Prompt 未以同一段 Style Lock 开头`);
    if (!/product occupies (~\d+|\d+-\d+)%/.test(it.prompt)) problems.push(`${it.code}: 缺少数字化产品占比（铁律 2）`);
    if (!/Do NOT add:/.test(it.prompt)) problems.push(`${it.code}: 缺少否定清单（铁律 4）`);
    if (/#[0-9A-F]{6}/.test(it.prompt) === false) problems.push(`${it.code}: 未使用 hex 颜色（铁律 1）`);
    if (!/aspect ratio \d+:\d+/.test(it.prompt)) problems.push(`${it.code}: 缺少画幅比例`);
    if (it.prompt.length > PROMPT_MAX_CHARS) problems.push(`${it.code}: Prompt ${it.prompt.length} 字符 > ${PROMPT_MAX_CHARS}，部分模型会静默截断（项目自定义阈值）`);

    if (it.slot === "main") {
      // ── 亚马逊首图：法规口径 ──
      if (!/product occupies 85-100% of the frame/.test(it.prompt)) problems.push(`${it.code}: 首图未写「85-100% 占幅」（亚马逊硬要求）`);
      if (!/#FFFFFF/.test(it.prompt)) problems.push(`${it.code}: 首图背景必须是 #FFFFFF 纯白（RGB 255,255,255）`);
      if (!/In-image text: NONE/.test(it.prompt)) problems.push(`${it.code}: 首图必须显式声明禁止图内文字`);
      if (/headline in #/.test(it.prompt)) problems.push(`${it.code}: 首图不允许出现图内文字/标题`);
      if (!/Amazon main-image compliance/.test(it.prompt)) problems.push(`${it.code}: 首图缺少亚马逊图片规则声明`);
      if (!/aspect ratio 1:1/.test(it.prompt)) problems.push(`${it.code}: 首图画幅必须是 1:1`);
      if (!/no more than 15%|at most 15%/.test(it.prompt)) problems.push(`${it.code}: 首图缺少「留白上限 15%」声明`);
    } else {
      // ── 副图 / A+ / 广告：设计构图口径 ──
      if (!/at least \d+%/.test(it.prompt)) problems.push(`${it.code}: 缺少显式留白（铁律 3）`);
      if (!/E-commerce infographic/.test(it.prompt) && it.group === "pdp") problems.push(`${it.code}: 详情页未以 E-commerce infographic 起头`);
      if (!/feature callout icons/.test(it.prompt) && it.group === "pdp") problems.push(`${it.code}: 详情页缺少信息图元素（callout icons / 连线 / 序号圆点）`);
    }
  }
  // 连续 3 张同角度
  for (let i = 2; i < items.length; i++) {
    if (items[i].angle === items[i - 1].angle && items[i].angle === items[i - 2].angle) {
      problems.push(`${items[i].code}: 连续 3 张同角度（${items[i].angle}）`);
    }
  }
  // 全景占比
  const wide = items.filter((i) => i.shot === "全景").length;
  if (wide / items.length > 0.4) problems.push(`全景图占比 ${(wide / items.length * 100).toFixed(0)}% > 40%`);
  return problems;
}

export { TEMPLATES, TEMPLATE_LIST, SIZE_BY_FIGURE, PROMPT_MAX_CHARS };
