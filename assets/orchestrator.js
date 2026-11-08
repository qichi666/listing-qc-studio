/**
 * 编排层（"Agent" 位）。
 *
 * ── 与参考项目的架构差异，以及为什么这么改 ───────────────────────────
 * 参考项目 ecom-details-image-ui 用 Claude Agent SDK + 自建 MCP 工具
 * （get_template / generate_image），由 LLM 决定调哪个工具、什么时候调。
 * 它的代价：
 *   1. 强依赖 Claude Agent SDK + EdgeOne Agent Node Runtime；
 *   2. 25 个模板要模型自己"记得"去调 get_template，漏调则 Prompt 质量掉档；
 *   3. 结果不可复现（同一句话两次跑出的 Prompt 不同），没法写回归测试；
 *   4. 没有 key 就完全跑不起来。
 *
 * 本项目的做法：把「编排」抽成确定性代码。一轮对话固定走四个可审计的步骤
 *   match_template → diagnose_conversion_driver → build_campaign_style_lock → compose_prompt
 * 每一步都产出中间结果并通过 SSE 推给前端（所以用户能看见"AI 在想什么"，
 * 观感与参考项目一致）。LLM 只承担一件它真正擅长的事：把产品描述润色成更准的一句英文。
 * 于是：无 key 可用、结果可复现、每步可断言。
 *
 * 对外事件名刻意与参考项目保持一致：
 *   tool_call / tool_result / ai_response / file_output / usage / error_message
 */

import {
  matchTemplate, diagnoseConversionDriver, buildStyleLock, composePrompt,
  composeImg2ImgPrompt, planImagePack, auditPlan, detectCategory, TEMPLATES,
  ANGLES, SHOTS, FIGURE_SPEC, infoArchitecture, figureForTemplate,
  RATIO_PIXELS,
} from "./prompt-engine.js";
import { probeServer, postChat, generateImage, callVision, callLLM, hasImageKey, getConfig } from "./api.js";

/* ─────────────────────── 意图判断 ─────────────────────── */

const GENERATE_WORDS = ["生图", "生成图片", "生成图", "出图", "画一张", "做一张", "直接生成", "render", "generate image", "generate images", "generate picture", "生几张"];
const PACK_WORDS = ["整套", "全套", "详情页", "pdp", "主图堆栈", "一整套", "9 张", "9张", "五张主图", "5 张主图", "full set", "whole set", "detail page", "image set", "set of images", "all images", "5 main images", "9 images"];

export function isGenerateIntent(message) {
  const t = String(message || "").toLowerCase();
  return GENERATE_WORDS.some((w) => t.includes(w.toLowerCase()));
}
export function isPackIntent(message) {
  const t = String(message || "").toLowerCase();
  return PACK_WORDS.some((w) => t.includes(w.toLowerCase()));
}

/** 否定词。只用于判断"出图意图是否被否掉"，不要拿去过滤 Prompt 内容。 */
const NEGATION = /(?:不要|不用|不需要|不必|无需|先别|暂时不|暂时别|先不|别|no need|don'?t|do not|not yet)/i;

/**
 * 用户是否在**否定出图**（"先看文案，这款暂时不要出图""不用生成了"）。
 *
 * 🔴 判据是「出图意图词**前面 12 个字符内**有否定词」，不是全句扫否定词。
 *    原因：Prompt 场景里"不要文字""画面不要阴影"是**内容要求**，
 *    全句扫会把"生成主图，画面不要文字"误判成"不要出图" —— 该出的图不出。
 *
 * 🔴 也不再只看 `message.slice(0, 8)`。原来那个写法只要否定词落在第 9 个字符之后
 *    就完全失效：`"先看文案，这款暂时不要出图"` 照样会调图片 API 烧钱。
 */
export function isNegative(message) {
  const t = String(message || "").toLowerCase();
  for (const w of GENERATE_WORDS) {
    const i = t.indexOf(w.toLowerCase());
    if (i < 0) continue;
    // 🔴 只取**同一个分句**里的前文：否定作用域不过逗号/句号。
    //    "不要加文字，直接出图" —— 前 12 字符里确实有"不要"，但它修饰的是"文字"，
    //    不是"出图"。按分句切开后前文只剩"直接"，误判消失。
    const before = t
      .slice(Math.max(0, i - 12), i)
      .split(/[，,。.；;！!？?\n]/)
      .pop() || "";
    if (NEGATION.test(before)) return true;
  }
  return false;
}

/** 亚马逊合规模式：用户明确要"能上架的首图 / 白底合规主图" */
const AMAZON_MAIN_WORDS = ["合规首图", "合规主图", "亚马逊首图", "亚马逊主图", "能上架", "上架用", "amazon main image", "compliant main image", "listing main image", "white background main"];

/** 已知画幅白名单。由 RATIO_PIXELS 派生，永远不会和像素表脱节。 */
const KNOWN_RATIOS = new Set(Object.keys(RATIO_PIXELS));

/** 时间上下文：冒号前紧挨这些词时不当画幅（给"下午 4:3"这类边缘写法兜底）。 */
const TIME_BEFORE = /(?:上午|下午|早上|晚上|中午|凌晨|半夜|点|时|分|秒|am|pm)\s*$/i;

/** 从自然语言里抠出画幅比例（用户可能说"竖版 9:16""方形"）
 *  `explicit` = 用户到底有没有**明说**画幅；没有明说时不要拿默认值去覆盖整套包的画幅。
 *  `scope`    = 这个比例该作用在谁身上：all（整套）/ hero（只有主图）/ pdp（只有详情页）。
 *  ⚠️ 实测踩到的坑：原来无脑返回默认 1:1，orchestrator 又把它当"用户指定"传给整套包，
 *     结果用户说"9:16"也无效、说"主图"却把详情页也压成方图。
 *
 *  🔴 2026-11-05 修：冒号正则原来是 `/(\d{1,2}):(\d{1,2})/` 取第一个命中，
 *     "上午10:30 开会" 会被判成画幅 10:30 → 到 API 那层再兜底成 1:1，
 *     用户以为设置生效了，其实一路都在用默认值且**没有任何提示**。
 *     现在只认白名单里的比例（1:1 / 4:3 / 3:2 / 16:9 / 9:16 / 4:5 / 3:4 / 2:3 / 5:4）。
 */
export function parseRatio(message) {
  const t = String(message || "");

  // 逐个候选扫，取第一个「在已知比例内 + 不在时间上下文里」的
  const re = /(\d{1,2})\s*[:：]\s*(\d{1,2})/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const ratio = `${m[1]}:${m[2]}`;
    if (!KNOWN_RATIOS.has(ratio)) continue;
    const before = t.slice(Math.max(0, m.index - 4), m.index);
    if (TIME_BEFORE.test(before)) continue;
    return { ratio, size: RATIO_PIXELS[ratio], explicit: true, scope: "all" };
  }

  if (/竖版|竖图|纵向|portrait/.test(t)) return { ratio: "3:4", size: RATIO_PIXELS["3:4"], explicit: true, scope: "all" };
  if (/横版|横图|banner|海报|landscape|wide ?screen/.test(t)) return { ratio: "16:9", size: RATIO_PIXELS["16:9"], explicit: true, scope: "all" };
  if (/社媒|小红书|抖音|ins|story/.test(t)) return { ratio: "9:16", size: RATIO_PIXELS["9:16"], explicit: true, scope: "all" };
  if (/详情页|pdp/.test(t)) return { ratio: "2:3", size: RATIO_PIXELS["2:3"], explicit: true, scope: "pdp" };
  if (/方形|正方|1:1|主图|square/.test(t)) return { ratio: "1:1", size: RATIO_PIXELS["1:1"], explicit: true, scope: "hero" };
  return { ratio: "1:1", size: RATIO_PIXELS["1:1"], explicit: false, scope: "none" };
}

/* ─────────────── 从一句话里抠出「产品主体」 ───────────────
 * 为什么值得单独写一段、而不是 `replace` 一把梭：
 * 主体会被拼进每一张图的 Prompt（"Subject and scene: ___"），抽脏了 14 张图全脏。
 * 之前用一串顺序 replace，会把 "帮我给这款宠物自动喂食器做一整套主图和详情页，走痛点驱动"
 * 抽成 "给这款宠物自动喂食器一整套和，走痛点驱动" —— 连风格指令都被当成了产品名。
 * 现在的做法是三步：先从句里挑出「不是风格指令」的那一句 → 再切掉图类型之后的部分 → 最后剥噪声前后缀。
 */

/** 图类型 / 平台词：出现在它之后的内容都不属于产品名 */
const IMG_TOKEN = /(白底主图|白底图|主图|详情页|A\+|信息图|场景图|氛围图|社媒图|小红书图|小红书|TikTok图|买家秀|爆炸图|包装图|平铺图|微距图|细节图|多角度图|海报|banner|图片|图(?![一-龥]))/i;

/**
 * 🔴 英文图类型词。
 * 跨境场景里用户**大量直接写英文**（"make a product photo for wireless earbuds"），
 * 而原来整套抽取逻辑（IMG_TOKEN / STYLE_CLAUSE / NOISE_*）**全是中文模式**：
 * 英文指令词不在噪声表里 → 整句话被当成产品名。
 * 这直接导致产品位写着 "make me a product photo for wireless bluetooth earbuds"。
 */
const IMG_TOKEN_EN = /\b(white ?background|main image|hero image|product photo|product shot|product image|lifestyle (?:photo|shot|image)|detail page|listing image|infographic|poster|banner|mockup|render|picture|image|photo|shot)\b/i;

/**
 * 🔴 英文语序陷阱："a product photo **of / for** X" —— 产品在**图类型之后**。
 * 中文习惯是「X + 图类型」，直接沿用 `slice(0, 图类型位置)` 会把产品名整段切掉。
 * 所以必须**先**识别 of/for 结构，取后半段当候选。
 */
const IMG_FOR_OF = /(?:photos?|images?|pictures?|shots?|renders?|visuals?|mockups?)\s+(?:of|for)\s+(.+)$/i;

/** 风格 / 驱动 / 规格指令从句的识别词（命中即认为这句不是产品名） */
const STYLE_CLAUSE = /(痛点|情绪|视觉|风格|调性|氛围|高级|简约|ins风|北欧|日系|复古|科技感|促销|节日|圣诞|黑五|Prime|大促|走.{0,6}驱动|驱动型|对比|偏冷|偏暖|干净|留白)/i;
/**
 * 英文风格从句。
 * ⚠️ 刻意**不收** `tech` / `clean` 这类词 —— 它们太容易出现在正常品名里
 * （"Tech Organizer" / "Clean Brush"），收进来会把产品名当风格句过滤掉。
 */
const STYLE_CLAUSE_EN = /\b(pain[- ]?point|visual|emotional|emotion|aesthetic|style|vibe|mood|premium|luxury|minimal(?:ist)?|scandinavian|nordic|japandi|vintage|retro|sale|promo|christmas|black friday|prime day|driven|moody|vibrant)\b/i;

/** 噪声：反复剥到不再变化为止（`+` 让相邻噪声一次剥干净）
 *  🔴 顺序敏感：必须先剥「给/把」再剥「我」。
 *     否则 "给我们的硅胶婴儿餐盘" 会被 `给我` 抢先吃掉，剩成 "们的硅胶婴儿餐盘"（踩过）。
 *     去掉裸 `给我`，改成 给→我 两轮剥，`我们的` 也就能整体剥掉。
 */
const NOISE_LEAD = [
  /^(?:帮我|帮忙|请|麻烦|我想|我要|我需要|可以|能不能|可不可以|你好|你|下|然后|接着)+/,
  /^(?:给|把|对|用|按照|按|基于|参考|针对|为)+/,
  /^(?:这款|这个|这一款|这|一款|一个|一种|这种|我们的|我们|我的|我家|本款|该款|这款产品|产品|此款|此|那款|那个|我|们)+/,
  /^(?:是|就是|为|叫做|叫|有)+/,
  /^(?:做|生成|设计|画|制作|搞|弄|写|输出|来|出|要|需要|重新|再|拍)+/,
];
/**
 * 英文前导指令词（顺序同理：先剥长短语，再剥冠词/介词）
 * 🔴 组后必须带 `\b`：否则 "do" 会把 "dog harness" 啃成 "g harness"、
 *    "the" 会把 "theory book" 啃成 "ory book"（踩过）。
 */
const NOISE_LEAD_EN = [
  /^(?:please|pls|hey|hi|hello|can you|could you|would you|i'?d like|i would like|i want|i need|help me|give me|show me|make me|come up with|generate|create|design|draw|render|produce|build|make|do)+\b[\s,]*/i,
  /^(?:a|an|the|some|one|of|for|about|with|on|to|in|my|our|your|its)+\b[\s,]*/i,
  /^(?:product|item|listing|ecommerce|e-?commerce|amazon|shop|store)+\b[\s,]*/i,
];
/** 尾部动词（"…餐盘出一套"剥完量词后会剩个"出"） */
const NOISE_VERB_TAIL = /(?:做|生成|设计|画|制作|搞|弄|写|输出|出|拍|来|再|重新|要|需要)+$/;
/** 尾部营销形容词（"…做一张爆款主图" 会剩个 "爆款"） */
const NOISE_ADJ_TAIL = /(?:爆款|爆品|热销|新款|大牌|高级感|高级|质感|大片感|大片|氛围感|简约|精品|同款|吸睛|亮眼|带感)+$/;
/** 尾部量词短语（"…做一整套" / "…出 3 张"） */
const NOISE_QUANT_TAIL = /(?:做|生成|设计|画|制作|搞|弄|写|输出|拍|来|再|重新)?(?:一|两|三|四|五|六|几|\d+)?(?:整|全)?(?:套|张|个|份|组|版)(?=$)/;
/** 英文尾部收尾语 —— ⚠️ 刻意不收 set/pack/bundle：它们是正常品名（"gift set" / "3-pack"） */
const NOISE_VERB_TAIL_EN = /(?:\b(?:for me|please|thanks|asap|right now|directly|now|images?|photos?|pictures?|shots?|renders?)\b[\s,]*)+$/i;
const NOISE_ADJ_TAIL_EN = /(?:\b(?:premium|high[- ]end|luxury|viral|best[- ]selling|trendy|aesthetic)\b[\s,]*)+$/i;
const NOISE_QUANT_TAIL_EN = /(?:\b(?:a|one|two|three|four|five|six|\d+)?\s?(?:full|whole|complete|entire)?\s?(?:sets?|bundles?)\b)$/i;
const NOISE_EDGE = /^[的，,。.、:：;；!！?？\s"'“”‘’「」【】()（）]+|[的，,。.、:：;；!！?？\s"'“”‘’「」【】()（）]+$/g;

/** 以「风格副词 + 风格词」开头的从句 = 纯风格指令（"走视觉驱动" / "要高级感"），不是产品名 */
const STYLE_ONLY_LEAD = /^(?:走|要|偏|偏向|用|更|保持|按|做成)/;
const STYLE_ONLY_LEAD_EN = /^(?:go|goes|use|used|make it|keep it|be|with a|in a|in an|using)\b/i;

/**
 * 🔴 用于「整句是否只有图类型词」的**严格版** token（去掉裸 `图`）。
 * 裸 `图` 只该用来**截断**（"…产品图"），不能用来判空 ——
 * 否则 "图钉"/"图书架" 这类品名会被自己的第一个字误判成无产品。
 */
const IMG_TOKEN_STRICT = /(白底主图|白底图|主图|详情页|A\+|信息图|场景图|氛围图|社媒图|小红书图|小红书|TikTok图|买家秀|爆炸图|包装图|平铺图|微距图|细节图|多角度图|海报|图片|banner)/i;

/** 图类型前置标签（"主图：X" / "main image: X"）—— 切标签而不是整体丢弃 */
const LABEL_ZH = /^[^：:]{0,8}(?:主图|详情页|场景图|氛围图|信息图|爆炸图|包装图|平铺图|微距图|海报)\s*[：:]\s*/;
const LABEL_EN = /^[a-z ]{0,24}?\b(?:main image|hero image|product photo|product image|product shot|detail page|banner|poster)\b\s*[:：-]\s*/i;

/** 噪声剥离 + 判定。`truncated` 表示这段是被「图类型」截断过的（残渣需额外检查） */
function cleanCore(input, truncated) {
  let s = String(input || "");
  // 🔴 `orig` 是噪声剥离**之前**的原文。
  //    纯风格句判定必须看原文 —— 尾部形容词会被 NOISE_ADJ_TAIL_EN 先剥掉，
  //    "go premium" 剥完只剩 "go"、"make it look premium" 只剩 "it look"，就再也认不出来了（踩过）。
  const orig = s;
  for (let i = 0; i < 8; i++) {
    const before = s;
    for (const re of NOISE_LEAD) s = s.replace(re, "");
    for (const re of NOISE_LEAD_EN) s = s.replace(re, "");
    s = s.replace(NOISE_VERB_TAIL, "").replace(NOISE_ADJ_TAIL, "").replace(NOISE_QUANT_TAIL, "");
    s = s.replace(NOISE_VERB_TAIL_EN, "").replace(NOISE_ADJ_TAIL_EN, "").replace(NOISE_QUANT_TAIL_EN, "");
    s = s.replace(NOISE_EDGE, "").trim();
    if (s === before) break;
  }
  s = s.replace(NOISE_EDGE, "").trim();

  // 🔴 少于 2 个字符 = 抽取失败（"出" / "一张" 这种不是产品名）。
  //    宁可返回空、由调用方兜底，也不要把半截垃圾拼进 14 张图的 Prompt。
  if (s.length < 2) return "";

  // 纯风格指令从句（"走视觉驱动" / "go premium"）—— 收窄判定：必须以风格副词起头 + 含风格词。
  // 收窄是为了不误杀带风格词的品名（如"氛围灯"）。
  // ⚠️ 用 `orig`（剥噪声前）判，不能用剥完的 `s`。
  if (STYLE_ONLY_LEAD.test(orig) && STYLE_CLAUSE.test(orig)) return "";
  if (STYLE_ONLY_LEAD_EN.test(orig) && STYLE_CLAUSE_EN.test(orig)) return "";

  // 🔴 被图类型截过 → 再检查剩下的残渣是不是纯风格/数量词。
  //    用来挡 "做一张促销海报 banner，走视觉驱动" 这类**根本没有产品名**的输入
  //    （截完剩 "一张促销"，看着像主体，其实是残渣）。
  //    只在「截过」时才判，避免误杀本身带风格词的品名（如"氛围灯"）。
  if (truncated) {
    const residue = s
      .replace(/[的了和与及、，,。.\s]/g, "")
      .replace(/(?:一|两|三|四|五|六|几|\d+)/g, "")
      .replace(/(?:整|全|张|个|套|份|组|版)/g, "")
      .replace(new RegExp(STYLE_CLAUSE.source.replace(/^\/|\/i$/g, ""), "gi"), "")
      .replace(new RegExp(STYLE_CLAUSE_EN.source.replace(/^\/|\/i$/g, ""), "gi"), "");
    if (residue.length < 2) return "";
  }
  return s;
}

/** 把单个从句清洗成候选主体；洗不出有意义的东西就返回 "" */
function cleanCandidate(clause) {
  let s = String(clause || "");

  // ① 英文 of/for 语序优先：「a product photo for wireless earbuds」→ 取后半段
  const fo = IMG_FOR_OF.exec(s);
  if (fo) return cleanCore(fo[1], false);

  // ② 🔴 整句除图类型词外别无他物（"hero image" / "主图" / "make me a product photo"）
  //    → 这是**没有产品名**，必须在这里判掉。
  //    否则尾部那个 "image" 会被 NOISE_VERB_TAIL_EN 当收尾语吃掉，残下 "hero" 冒充主体（踩过）。
  const g = (re) => new RegExp(re.source, re.flags.replace("i", "") + "gi");
  const noImg = s.replace(g(IMG_TOKEN_STRICT), " ").replace(g(IMG_TOKEN_EN), " ");
  if (!cleanCore(noImg, false)) return "";

  // ③ 「产品名 + 图类型」语序：切掉图类型之后的部分
  const m = s.match(IMG_TOKEN) || s.match(IMG_TOKEN_EN);
  const truncated = !!(m && m.index > 0);
  if (truncated) s = s.slice(0, m.index);

  // ④ 图类型在开头（"主图：X" / "main image: X"）→ 切前导标签，而不是整体丢弃
  s = s.replace(LABEL_ZH, "").replace(LABEL_EN, "");

  return cleanCore(s, truncated);
}

/**
 * 抽出产品主体。
 * 🔴 逐句尝试（不是只挑一句就定案）："帮我出一张白底主图，产品是无线蓝牙耳机" 里
 *    前半句洗完是空的，必须能退到后半句。全部失败返回 ""，由调用方给占位符。
 */
export function extractSubject(message) {
  const raw = String(message || "").trim();
  if (!raw) return "";

  const clauses = raw.split(/[，,。.；;！!？?\n]+/).map((s) => s.trim()).filter(Boolean);
  const plain = clauses.filter((c) => !STYLE_CLAUSE.test(c) && !STYLE_CLAUSE_EN.test(c));
  const queue = [...(plain.length ? plain : clauses)].sort((a, b) => b.length - a.length);

  for (const c of queue) {
    const got = cleanCandidate(c);
    if (got) return got.slice(0, 120);
  }
  // 纯风格指令（"做一张促销海报，走视觉驱动"）没有产品名 → 返回空，让调用方兜底
  return "";
}

/* ─────────────────────── 本地一轮（离线可用） ─────────────────────── */

/**
 * 完全本机执行的编排：不发起任何网络请求（除非配置了图片 key 且用户要求出图）。
 */
export function runLocalTurn({ message, attachment, onEvent, pack = false, explicitTemplateId = null } = {}) {
  const emit = (ev) => onEvent && onEvent(ev);
  const t0 = Date.now();
  // 🔴 抽不出主体时给占位符，而不是把整句话当主体拼进 Prompt。
  //    抽空 = 用户的输入其实是纯风格指令（"做一张促销海报，走视觉驱动"），
  //    这时正确做法是留一个显式占位符，让用户看到"这里需要补产品"。
  const rawSubject = extractSubject(message);
  const subject = rawSubject || "\{PRODUCT\} (未识别到产品名，请替换为实际产品)";
  const subjectMissing = !rawSubject;
  const wantGenerate = isGenerateIntent(message);
  const wantPack = pack || isPackIntent(message);
  const pr = parseRatio(message);
  const { ratio, size } = pr;
  // 🔴 只有用户**明说**画幅时才覆盖整套包的默认值，并且按 scope 决定作用范围
  //    （说"主图"不该把详情页也压成方图；说"9:16"才该整套都换）。
  const heroRatio = pr.explicit && pr.scope !== "pdp" ? pr.size : null;
  const pdpRatio = pr.explicit && pr.scope !== "hero" ? pr.size : null;
  const amazonMain = AMAZON_MAIN_WORDS.some((w) => message.toLowerCase().includes(w.toLowerCase()));

  // ⓪ 先把"上下文"算出来 —— 模板匹配要用它。🔴 这几行的 **emit 顺序保持不变**（品类/驱动
  //    的工具事件仍在原位发出），只是把纯计算提前，免得打乱事件流影响前端渲染与回归断言。
  //    上下文三件套：品类（这是什么产品）、转化驱动力（这句话想解决什么）、有没有参考图。
  const cat = detectCategory(message);
  const driver = diagnoseConversionDriver(message);

  // ① 模板匹配（**自动**：吃当轮文本 + 上面那份上下文；只有用户去模板库显式点了模板才走 explicit）
  const m = matchTemplate(message, {
    explicitId: explicitTemplateId || undefined,
    context: {
      category: cat.category,
      // 🔴 只在**真的识别出**转化驱动力时才把它当依据。`diagnoseConversionDriver` 无命中时会
      //    返回 confidence 0 + "默认按视觉驱动型处理" 的 visual —— 那是兜底，不是证据。
      //    直接传进来会让乱码输入也报出"按「visual」驱动常用图型选取"，属于界面说假话。
      driver: driver.confidence > 0 ? driver.driver : null,
      hasReference: Boolean(attachment),
    },
  });
  const tpl = TEMPLATES[m.id];
  const SOURCE_LABEL = {
    explicit: "用户显式指定",
    keyword: "关键词命中（自动）",
    context: "上下文推断（自动）",
    fallback: "无匹配，规则兜底",
  };
  emit({ type: "tool_call", name: "match_template", input: { query: message.slice(0, 60), auto: m.auto } });
  emit({
    type: "tool_result", name: "match_template",
    // 🔴 自动匹配必须是**可审议**的：说清"怎么选出来的"以及"还有什么备选"，
    //    否则用户不知道换一句描述就能得到另一个模板。
    content: [
      `匹配到「${tpl.order}-${tpl.id} ${tpl.name}」`,
      `依据：${m.reason}`,
      `来源：${SOURCE_LABEL[m.source] || m.source}`,
      m.candidates.length
        ? `也可考虑：${m.candidates.map((c) => `${c.id}(${c.name}，${c.score}分)`).join(" / ")}`
        : "也可考虑：（本次没有并列候选）",
    ].join("\n"),
  });

  // ② 转化驱动力诊断
  emit({ type: "tool_call", name: "diagnose_conversion_driver", input: {} });
  emit({
    type: "tool_result", name: "diagnose_conversion_driver",
    content: `${driver.label}（置信度 ${driver.confidence}）\n${driver.reason}\n推荐序列：${driver.order}`,
  });

  // ③ 品类（计算已在 ⓪ 完成，这里只负责播报）
  if (cat.category) {
    emit({ type: "tool_result", name: "diagnose_conversion_driver", content: `品类识别：${cat.category}（${cat.reason}）→ 已套用 category_tips` });
  }

  // ④ Style Lock
  const styleLock = buildStyleLock({});
  emit({ type: "tool_call", name: "build_campaign_style_lock", input: {} });
  emit({ type: "tool_result", name: "build_campaign_style_lock", content: styleLock.slice(0, 300) + " …" });

  // ⑤ 组装
  const packPlan = wantPack
    ? planImagePack({ subject, driver: driver.driver, styleLock, pack: "pdp", amazonMain, heroRatio, pdpRatio })
    : null;

  const single = wantPack ? packPlan.items[0] : composePrompt({
    subject,
    templateId: m.id,
    // 🔴 图型由**选中的模板**决定（TEMPLATE_FIGURE 里 25 个模板都有归属）。
    //    这里原来是一串硬编码的嵌套三元，全项目只认 hero-image / lifestyle-scene 两个 id，
    //    其余 23 个模板全被压成"卖点副图"口径 ——
    //    选了模板却不认模板的构图口径，等于选型白做。亚马逊合规首图仍然最高优先。
    figure: amazonMain ? "main" : figureForTemplate(tpl.id),
    slot: amazonMain ? "main" : undefined,
    styleLock,
    category: cat.category,
    sizeRatio: size,
    headline: "",
    purpose: `${tpl.name}`,
    includePlatformReserve: /国内|淘宝|天猫|京东/.test(message),
  });

  emit({ type: "tool_call", name: "compose_prompt", input: {} });
  emit({
    type: "tool_result", name: "compose_prompt",
    content: single.meta?.amazonMain
      ? `已套用亚马逊首图法规层：hex 颜色 ×${single.meta.hexApplied.length}、产品占比 ${single.meta.productPct.join("-")}%（官方要求，非 35-40% 构图口径）、纯白背景 #FFFFFF、显式禁止图内文字、画幅固定 1:1${single.meta.hexUnrecognized?.length ? `｜⚠️ 未 hex 化的颜色概念：${single.meta.hexUnrecognized.join("、")}` : ""}`
      : `已套用 6 条铁律：hex 颜色 ×${single.meta?.hexApplied?.length || 0}、产品占比 ${single.meta?.productPct?.join("-")}%、留白 ≥${single.meta?.whitespacePct}%、否定清单、画幅 ${single.meta?.ratio}${single.meta?.angle ? "、角度 " + single.meta.angle : ""}${single.meta?.hexUnrecognized?.length ? `｜⚠️ 未 hex 化的颜色概念：${single.meta.hexUnrecognized.join("、")}` : ""}`,
  });

  // ⑥ 机械自检（要在拼简报之前算出来，否则简报里报不出问题）
  const audit = packPlan ? auditPlan(packPlan) : [];

  // ⑦ 生成可读简报
  const md = buildBriefMarkdown({ subject, subjectMissing, tpl, m, driver, cat, styleLock, single, packPlan, audit, size, ratio, wantGenerate, amazonMain });
  emit({ type: "ai_response", content: md });

  emit({
    type: "usage",
    cost: 0,
    duration_ms: Date.now() - t0,
    note: "本地编排，未调用任何模型 API（成本 0）",
  });

  return {
    subject, templateId: m.id, template: tpl, match: m, driver, category: cat,
    styleLock, single, packPlan, audit, wantGenerate, size, ratio, amazonMain, heroRatio, pdpRatio,
  };
}

/* ─────────────────────── 简报 Markdown ─────────────────────── */

const GROUP_LABEL = { main: "首图", hero: "副图/主图序列", pdp: "详情页" };

function buildBriefMarkdown({ subject, subjectMissing, tpl, m, driver, cat, styleLock, single, packPlan, audit, size, ratio, wantGenerate, amazonMain }) {
  const L = [];
  // 🔴 没识别出产品名时必须先说清楚 —— 否则用户会以为下面这 14 张图是"成品"，
  //    实际每张的 Prompt 里都写着 {PRODUCT} 占位符。
  if (subjectMissing) {
    L.push(`> ⚠️ **没有识别到产品名** —— 你的描述里只有风格/版式要求。`);
    L.push(`> 下面所有 Prompt 的产品位都是 \`{PRODUCT}\` 占位符，**请先替换成实际产品再拿去出图**。`);
    L.push(`> 想省事就重发一句，把产品名写进去，例如「给这款**宠物自动喂食器**做一整套图」。`);
    L.push("");
  }
  // 🔴 合规首图的提醒必须放在很前面 —— 这是"上架会不会被拒"级别的问题，
  //    而它和整套图的默认构图口径（产品占 35-40%）是**冲突**的，不说清楚会误导。
  if (amazonMain) {
    L.push(`> ✅ **已启用亚马逊合规首图（M0）** —— 它是唯一受首图法规约束的图位。`);
    L.push(`> 首图硬要求：纯白背景 \`#FFFFFF\`（RGB 255,255,255）、产品占画幅 **85-100%**、**不得出现任何文字/水印/logo/边框/道具**、最长边 ≥1000px。`);
    L.push(`> ⚠️ 注意：M0 走的是**平台法规口径**，下面 H1-H5 走的是**设计构图口径**（产品占 35-40%、带信息图文字）。`);
    L.push(`> 这两套数值是刻意分开的 —— 把 35% 占幅的图当首图上传会被拒；反过来把 85% 占幅的图当副图会显得没有设计感。`);
    L.push(`> 亚马逊图片位共 9 个：**slot 1 = 首图**（用 M0），**slot 2-9 = 副图**（用 H1-H5 + 详情页里的场景/尺寸图）。`);
    L.push("");
  }
  L.push(`### ① 匹配场景模板`);
  L.push(`**${tpl.order}-${tpl.id} · ${tpl.name}** ｜ 匹配依据：${m.reason}`);
  if (m.source === "fallback") L.push(`> ⚠️ 没有命中任何模板关键词，按 SKILL.md 规则回落到白底主图。你可以直接在左侧模板库点选来覆盖。`);
  L.push("");
  L.push(`### ② 转化驱动力诊断`);
  L.push(`**${driver.label}**（置信度 ${driver.confidence}）`);
  L.push(`${driver.reason}`);
  L.push(`推进顺序：${driver.order}`);
  if (cat.category) L.push(`品类：\`${cat.category}\` → 已套用该模板的 category_tips`);
  L.push("");

  L.push(`### ③ Campaign Style Lock`);
  L.push("整套图共用同一段视觉合同（多图任务时逐张原样复制）：");
  L.push("```text");
  L.push(styleLock);
  L.push("```");
  L.push("");

  if (packPlan) {
    L.push(`### ④ 图片包规划（${packPlan.amazonMain ? `1 张合规首图 + ` : ""}${packPlan.counts.hero} 张主图 + ${packPlan.counts.pdp} 张详情页 = ${packPlan.counts.total} 张）`);
    L.push(`| # | 编号 | 分组 | 用途 | 模板 | 画幅 | 角度 | 景别 | 背景 |`);
    L.push(`|---|---|---|---|---|---|---|---|---|`);
    for (const it of packPlan.items) {
      L.push(`| ${it.index} | ${it.code} | ${GROUP_LABEL[it.group] || it.group} | ${it.purpose} | ${it.templateId} | ${it.size} | ${it.angle} | ${it.shot} | \`${it.background}\` |`);
    }
    L.push("");
    const ha = packPlan.angleAudit.hero, pa = packPlan.angleAudit.pdp;
    L.push(`**角度自检**：主图 ${ha.distinctAngles} 种角度（需 ≥${ha.needDistinct}）/ 特写微距 ${ha.closeShots} 张（需 ≥${ha.needClose}）｜详情页 ${pa.distinctAngles} 种（需 ≥${pa.needDistinct}）/ 特写微距 ${pa.closeShots} 张（需 ≥${pa.needClose}）`);
    L.push("");
    // 🔴 机械自检结果必须外显：这是本项目跟"让模型自己觉得没问题"的分界线。
    //    通过时要明确说"查了哪几条"，而不是只字不提。
    const problems = audit || [];
    if (problems.length) {
      L.push(`**机械自检未通过**（${problems.length} 项）：`);
      for (const p of problems) L.push(`- ${p}`);
    } else {
      // 🔴 这里核的是**Prompt 的机械约束**（画幅/占比/留白/否定清单…），不是成图。
      //    原文写「N 张逐张核过……全部通过」会让读者以为 N 张图都出好了 —— 见下面那条边界声明。
      L.push(`**机械自检**：${packPlan.counts.total} 条 Prompt 逐条核过 —— 画幅比例、数字化产品占比、${packPlan.amazonMain ? "首图法规层（85-100% 占幅 / 纯白底 / 无文字）、" : ""}显式留白、否定清单、hex 颜色、同一段 Style Lock 开头、详情页信息图结构、角度分布、全景占比，全部符合。（核的是 Prompt，不是成图。）`);
    }
    L.push("");
    // 🔴 口径对齐（A1）：编排层一次产出 N 条 Prompt，但出图链路一次只执行 1 张。
    //    不写这句，用户看到 14 行表格 + "全部通过" 会直接以为 14 张图已经生成了。
    if (packPlan.items.length > 1) {
      L.push(`> ⚠️ **本次只出第 1 张成图**（\`${packPlan.items[0].code}\`）。其余 ${packPlan.items.length - 1} 条 Prompt 在上表里，属于**待生成**，不是已生成 —— 逐张发起时原样带同一段 Style Lock。`);
      L.push("");
    }
  }

  L.push(`### ⑤ Final Image Prompt（第 1 张）`);
  L.push("```text");
  L.push(single.prompt);
  L.push("```");
  L.push("");
  L.push(`### ⑥ 硬参数核对`);
  const meta = single.meta || {};
  L.push(`| 项 | 值 | 铁律 / 口径 |`);
  L.push(`|---|---|---|`);
  if (meta.amazonMain) {
    L.push(`| 图位 | **亚马逊首图（slot 1）** | 平台法规层 |`);
    L.push(`| 产品占比 | ${(meta.productPct || []).join("-")}% | 亚马逊官方（非 SKILL.md 的 35-40% 构图口径） |`);
    L.push(`| 背景 | \`#FFFFFF\`（RGB 255,255,255） | 亚马逊官方硬要求 |`);
    L.push(`| 图内文字 | **禁止**（覆盖铁律 6） | 亚马逊官方硬要求 |`);
    L.push(`| 画幅 | 1:1（固定，不接受自定义） | 亚马逊图片位 |`);
  } else {
    L.push(`| 图型 / 产品占比 | ${meta.figureLabel || "-"} / ${(meta.productPct || []).join("-")}% | 铁律 2 数字化占比 |`);
    L.push(`| 留白下限 | ≥${meta.whitespacePct ?? "-"}% | 铁律 3 显式留白 |`);
    L.push(`| 画幅 | ${meta.ratio || size} | — |`);
  }
  if (meta.angle) L.push(`| 镜头角度 / 景别 | ${meta.angle} / ${meta.shot} | 多角度规则 |`);
  L.push(`| hex 颜色替换 | ${(meta.hexApplied || []).length} 处 | 铁律 1 颜色用 hex |`);
  L.push(`| 否定清单 | 已附 | 铁律 4 |`);
  L.push("");
  // 🔴 未 hex 化的颜色概念要说出来 —— 静默跳过等于让铁律 1 悄悄失效
  const unrec = meta.hexUnrecognized || [];
  if (unrec.length) {
    L.push(`> ⚠️ **以下颜色概念没能 hex 化**：${unrec.join("、")}`);
    L.push(`> 它们是**色系/趋势/材质**词，无法映射成单一 hex。请在 Prompt 里显式写成具体色值（如 \`#D8C3A5\`），否则铁律 1 在这几处不成立。`);
    L.push("");
  }
  if (meta.complianceNotes?.length) {
    // 行首不再放图标：blockquote（> ）本身已经表明这是提示行。
    // 🔴 这里原来是一个"图钉/清单"类 emoji —— 那是**图标位**，不是语气符号，项目规则里不许用。
    for (const n of meta.complianceNotes) L.push(`> ${n}`);
    L.push("");
  }
  // 交付前核对：文件层面的事（XMP 打标 / AI 披露 / 主图如实性），跟 Prompt 是两回事，
  // 所以不塞进上面那段（塞进去模型也不会执行），单独列给用户。
  if (meta.deliveryChecklist?.length) {
    L.push(`**交付前核对（文件层面，Prompt 管不到）**`);
    for (const n of meta.deliveryChecklist) L.push(`- ${n}`);
    L.push("");
  }
  L.push(`### ⑦ 下一步`);
  if (wantGenerate) {
    L.push(`检测到「出图」意图。→ 发送后**服务端编排会自动调用**你配置的图片 API（不需要再点别的按钮）；若还没配 key，去「设置」里填 IMG_BASE_URL / IMG_MODEL / IMG_API_KEY。`);
  } else {
    L.push(`当前是 **Brief / Prompt 模式**（只出 Prompt，不出图）。想直接出图，把话里加上「**直接出图**」四个字再发一次即可（带上「出图」两个字就会真的调图片 API）。`);
  }
  if (packPlan) {
    L.push(`整套 ${packPlan.counts.total} 张的 Prompt 全列在上面，可直接选中复制。`);
  }
  return L.join("\n");
}

/* ─────────────────────── 在线一轮（走本地服务） ─────────────────────── */

/**
 * 统一入口：先探测本地服务。
 *   在线 → 交给 server.mjs 编排（可调 LLM 润色 / 真出图）
 *   离线 → 本机编排（runLocalTurn）
 * 两条路径吐出的事件结构与文案格式一致，所以前端不需要写两套渲染。
 */
export async function runTurn({ message, attachment, onEvent, signal, pack = false, forceLocal = false, explicitTemplateId = null }) {
  const probe = await probeServer();
  if (probe.online && !forceLocal) {
    onEvent({ type: "tool_result", name: "transport", content: `本地服务在线（${probe.version}）→ 走服务端编排` });
    try {
      await postChat({ message, imageKey: attachment?.key, templateId: explicitTemplateId || undefined, onEvent, signal });
      return { mode: "server" };
    } catch (e) {
      onEvent({ type: "error_message", content: `服务端编排失败，已回退到本机编排：${e.message}` });
      return { ...runLocalTurn({ message, attachment, onEvent, pack, explicitTemplateId }), mode: "local-fallback" };
    }
  }
  runLocalTurn({ message, attachment, onEvent, pack, explicitTemplateId });
  return { mode: "local" };
}

/** 生成单张图（带进度事件）。离线或没配 key 时明确报错，而不是静默失败。 */
export async function generateOne({ prompt, size, imageKey, onEvent, signal }) {
  const emit = (ev) => onEvent && onEvent(ev);
  const probe = await probeServer();
  if (!probe.online) {
    emit({ type: "error_message", content: `无法生图：${probe.reason}` });
    return null;
  }
  if (!hasImageKey() && !probe.capabilities?.imageKeyConfigured) {
    emit({
      type: "error_message",
      content: "还没配置图片 API Key。去「设置」填 IMG_BASE_URL / IMG_MODEL / IMG_API_KEY（也支持 OpenAI 兼容接口），或把它们写进项目根目录的 .env 再重启服务。",
    });
    return null;
  }
  emit({ type: "tool_call", name: "generate_image", input: { size, mode: imageKey ? "img2img" : "txt2img" } });
  const t0 = Date.now();
  try {
    const r = await generateImage({ prompt, size, imageKey, signal });
    // 🔴 画幅一律以服务端**实际发送**的为准（r.ratio / r.size），客户端不再自己换算或展示请求值。
    //    r.sizeNote 非空表示同步接口把画幅吸附到了固定画布 —— 必须让用户看见，不能静默换比例。
    const shownRatio = r.ratio || size;
    emit({
      type: "tool_result", name: "generate_image",
      content: `${r.mode} | ${shownRatio} | 耗时 ${((r.elapsedMs || Date.now() - t0) / 1000).toFixed(1)}s${r.cost ? ` | ${r.cost}` : ""}`,
    });
    if (r.sizeNote) {
      emit({ type: "tool_result", name: "generate_image", level: "warn", content: `⚠️ ${r.sizeNote}` });
    }
    emit({
      type: "file_output",
      url: r.url,
      filename: r.filename,
      description: `${r.mode} · ${shownRatio} · ${((r.elapsedMs || Date.now() - t0) / 1000).toFixed(1)}s`,
    });
    return r;
  } catch (e) {
    emit({ type: "error_message", content: `生图失败：${e.message}` });
    return null;
  }
}

/**
 * 把 packPlan 压成可以过 SSE / 落到界面上的最小结构。
 *
 * 🔴 服务端与浏览器**共用这一个函数**：整套出图的按钮要在两种模式下都出现，
 *    如果两边各拼一份，迟早出现"在线能点、离线点不动"（或字段名不一致）。
 * angle/shot/background 这些只在简报表格里用，不需要发给前端。
 */
export function packPayload(packPlan) {
  if (!packPlan?.items?.length) return null;
  return {
    total: packPlan.items.length,
    amazonMain: Boolean(packPlan.amazonMain),
    items: packPlan.items.map((it) => ({
      code: it.code,
      purpose: it.purpose,
      // 画幅只发比例（服务端/接口按比例换算像素，客户端不参与换算）
      ratio: it.meta?.ratio || it.size,
      prompt: it.prompt,
    })),
  };
}

/** 图生图：先识图，再按"保留产品身份、改造场景"改写 Prompt */
export async function runImg2ImgTurn({ message, attachment, onEvent, signal }) {
  const emit = (ev) => onEvent && onEvent(ev);
  const t0 = Date.now();
  const probe = await probeServer();
  if (!probe.online) {
    emit({ type: "error_message", content: `图生图需要本地服务在线：${probe.reason}` });
    return null;
  }
  emit({ type: "tool_call", name: "vision_analyze", input: { imageKey: attachment.key } });
  let vision = null;
  try {
    vision = await callVision({ imageKey: attachment.key, signal });
    emit({
      type: "tool_result", name: "vision_analyze",
      content: vision.raw ? vision.raw.slice(0, 500) : JSON.stringify(vision.analysis || {}, null, 2).slice(0, 500),
    });
  } catch (e) {
    emit({ type: "tool_result", name: "vision_analyze", content: `识图失败：${e.message}（仍按文字需求走图生图）` });
  }

  const { size } = parseRatio(message);
  const styleLock = buildStyleLock({});
  const built = composeImg2ImgPrompt({
    target: message,
    scene: vision?.analysis?.summary || extractSubject(message) || "new environment",
    styleLock,
    templateId: "lifestyle-scene",
    figure: "scene",
    sizeRatio: size,
  });
  emit({
    type: "ai_response",
    content: [
      `### 参考图分析`,
      vision ? "```json\n" + JSON.stringify(vision.analysis || {}, null, 2).slice(0, 1200) + "\n```" : "识图不可用，仅按文字需求改写。",
      ``,
      `### 改造方向`,
      `**图生图**：保留产品本身（颜色 / 材质 / 印花 / 版型），改造场景、姿态、光线、风格。`,
      `> 注意：Prompt 里写的是 \`preserving the original product identity, pattern, colors and material\` —— **不是** preserving composition。构图本来就要变，要保留的是产品身份。`,
      ``,
      `### Final Image Prompt`,
      "```text",
      built.prompt,
      "```",
    ].join("\n"),
  });
  emit({ type: "usage", cost: 0, duration_ms: Date.now() - t0, note: "识图由服务端代理" });
  return { mode: "img2img", prompt: built.prompt, size, meta: built.meta, vision };
}

/** 可选：用 LLM 把中文产品描述润色成一句准确的英文主体描述 */
export async function polishSubject({ subject, onEvent }) {
  const cfg = getConfig();
  if (!cfg.enableAiPolish) return null;
  const emit = (ev) => onEvent && onEvent(ev);
  try {
    emit({ type: "tool_call", name: "polish_subject", input: {} });
    const r = await callLLM({
      system: "You convert Chinese e-commerce product descriptions into one precise English noun phrase for image generation. Output ONE line, no quotes, no explanation. Include material, form, and color (as hex when a color is mentioned).",
      user: subject,
      temperature: 0.3,
    });
    emit({ type: "tool_result", name: "polish_subject", content: r.text });
    return r.text.trim();
  } catch (e) {
    emit({ type: "tool_result", name: "polish_subject", content: `润色失败（不影响主流程）：${e.message}` });
    return null;
  }
}

export { ANGLES, SHOTS, FIGURE_SPEC, infoArchitecture, planImagePack, auditPlan, composePrompt, buildStyleLock, diagnoseConversionDriver, matchTemplate, detectCategory, TEMPLATES, figureForTemplate };
