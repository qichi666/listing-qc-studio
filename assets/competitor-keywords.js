/**
 * 竞品关键词内核 —— 纯函数、零依赖、**零网络**。
 *
 * 来源：`tool/server.js`（原「竞品销量榜 · Listing 提示词生成器」），2026-10-02 整合进本工作台。
 *   · 词表 CAT_HINTS / SPECIES / SUB_HINTS / STOP ......... 原 server.js:140-265
 *   · tokenize / buildNgrams / hasWord ..................... 原 server.js:585-619
 *   · analyzeKeywords（权重模型）........................... 原 server.js:626-712
 *   · scoreCats（类目打分）................................. 原 server.js:715-728
 *
 * 🔴 与本模块**唯一**的刻意偏离（不是 bug，别"顺手修回去"）：
 *   原 `probeWordsSync(q)` 会读 `enCache`（由联网翻译填充），失败时本地兜底。
 *   本模块**删掉联网这一支**，改成 `probeWords(productName, extraWords)`：
 *   `extraWords` 由调用方决定要不要给（工作台不给 → 与"原版翻译失败兜底"行为一致）。
 *   原因：本地优先工具不该因为在 Node 里跑就去调免费翻译接口。
 *
 * 🔴 行为基准：`tools/_keywords-snapshot.json`（移植**前**对原实现拍的字段级快照，随整合一起搬进来了）。
 *    `tools/selftest.mjs` 第 25 节逐字段比对 —— 改本文件必须让那一节继续绿。
 */

// ---------- 词表 ----------

/** 产品词 → 类目 映射。结构：slug -> [[词, 权重], ...]；权重越大越"专有"。 */
export const CAT_HINTS = {
  'pet-supplies': [['宠物玩具', 12], ['宠物', 10], ['pet', 10], ['狗粮', 10], ['猫粮', 10], ['猫砂', 10],
    ['牵引绳', 10], ['项圈', 9], ['狗', 9], ['猫', 9], ['狗狗', 9], ['猫咪', 9], ['鱼缸', 9],
    ['dog', 9], ['cat', 9], ['puppy', 9], ['kitten', 9], ['leash', 9], ['litter', 9], ['aquarium', 9],
    ['collar', 8], ['harness', 8], ['chew', 8], ['hamster', 8], ['bird cage', 8]],
  'toys-and-games': [['忙碌板', 12], ['蒙氏', 11], ['busy board', 12], ['montessori', 11], ['木制玩具', 10],
    ['积木', 9], ['毛绒', 9], ['拼图', 9], ['娃娃', 8], ['益智', 8], ['弹力球', 8], ['感官', 8],
    ['活动板', 9], ['早教', 9], ['玩具', 6], ['模型', 7],
    ['toy', 6], ['toys', 6], ['puzzle', 9], ['plush', 9], ['lego', 9], ['sensory', 9],
    ['building block', 9], ['board game', 9], ['doll', 8], ['action figure', 8]],
  'electronics': [['耳机', 10], ['蓝牙', 9], ['充电', 9], ['数据线', 9], ['音箱', 9], ['摄像头', 9],
    ['headphone', 10], ['earbud', 10], ['bluetooth', 9], ['charger', 9], ['cable', 8], ['speaker', 9],
    ['webcam', 9], ['monitor', 8], ['keyboard', 9], ['mouse', 8], ['power bank', 10]],
  'home-garden': [['收纳', 9], ['抱枕', 8], ['地毯', 9], ['窗帘', 9], ['置物架', 9], ['香薰', 9],
    ['storage', 8], ['pillow', 8], ['rug', 9], ['curtain', 9], ['shelf', 8], ['vase', 9],
    ['candle', 8], ['wall decor', 9], ['bedding', 9]],
  'kitchen': [['保温杯', 10], ['保温瓶', 10], ['保温壶', 10], ['水壶', 9], ['水杯', 9], ['杯子', 8],
    ['锅', 8], ['刀具', 9], ['餐具', 9], ['咖啡', 8], ['厨房', 9], ['瓶', 4],
    ['knife', 9], ['cookware', 9], ['utensil', 9], ['tumbler', 9], ['mug', 8], ['cutting board', 9],
    ['coffee maker', 9], ['bottle', 6], ['dinnerware', 9], ['thermos', 10], ['water bottle', 9]],
  'sporting-goods': [['瑜伽', 10], ['健身', 9], ['露营', 9], ['帐篷', 10], ['哑铃', 10], ['骑行', 9],
    ['yoga', 10], ['fitness', 9], ['camping', 9], ['tent', 10], ['dumbbell', 10], ['resistance band', 10],
    ['cycling', 9], ['hiking', 9], ['water bottle', 8]],
  'beauty': [['护肤', 10], ['面霜', 9], ['口红', 9], ['洗发', 9], ['面膜', 9], ['精华', 9],
    ['skincare', 10], ['serum', 9], ['lipstick', 9], ['shampoo', 9], ['face mask', 9], ['moisturizer', 9],
    ['hair', 7], ['nail', 8], ['makeup', 9]],
  'hpc': [['牙膏', 9], ['洗衣液', 10], ['纸巾', 9], ['洗手液', 9], ['维生素', 9], ['保健品', 9],
    ['toothpaste', 9], ['detergent', 10], ['vitamin', 9], ['supplement', 9], ['soap', 8],
    ['diaper', 8], ['tissue', 8], ['sanitizer', 9],
    // 医疗护具（2026-10-30 补）：原先只覆盖日用品，输入 back brace / 护腰 一律返回 null，
    // 而这正是最常用的一类选品。分值按"越具体越高"排，`brace` 单独给 7 ——
    // 它会顺带命中 bracelet，是刻意的取舍（宁可多认，不可漏认）。
    ['back brace', 12], ['护腰', 12], ['腰托', 12], ['posture corrector', 11], ['lumbar support', 11],
    ['knee brace', 10], ['ankle brace', 10], ['wrist brace', 10], ['护膝', 10], ['护腕', 10],
    ['矫姿', 10], ['护具', 9], ['医疗', 8], ['brace', 7]],
  'baby-products': [['婴儿', 10], ['宝宝', 10], ['奶瓶', 10], ['推车', 10], ['尿不湿', 10], ['口水巾', 9],
    ['baby', 10], ['infant', 10], ['toddler', 8], ['stroller', 10], ['baby bottle', 10],
    ['pacifier', 10], ['onesie', 9], ['crib', 9]],
  'office-products': [['文具', 10], ['笔', 6], ['打印纸', 9], ['文件夹', 9], ['订书机', 10], ['标签纸', 9],
    ['stationery', 10], ['pen', 7], ['notebook', 8], ['printer paper', 9], ['stapler', 10],
    ['label', 8], ['desk organizer', 9], ['planner', 9]],
  'appliances': [['吸尘器', 10], ['冰箱', 10], ['洗衣机', 10], ['微波炉', 10], ['空气炸锅', 10], ['风扇', 8],
    ['vacuum', 10], ['refrigerator', 10], ['microwave', 10], ['air fryer', 10], ['blender', 9],
    ['toaster', 9], ['humidifier', 9]],
  'automotive': [['车载', 10], ['汽车', 8], ['轮胎', 9], ['雨刷', 10], ['脚垫', 10], ['车充', 10],
    ['car', 8], ['tire', 9], ['wiper', 10], ['floor mat', 10], ['dash cam', 10], ['motorcycle', 9],
    ['engine oil', 10]],
  'arts-crafts': [['绘画', 9], ['手工', 8], ['颜料', 9], ['毛线', 9], ['编织', 9], ['画笔', 9],
    ['paint', 8], ['craft', 8], ['yarn', 9], ['knitting', 9], ['brush', 7], ['canvas', 8],
    ['diamond painting', 9]],
  'musical-instruments': [['吉他', 10], ['尤克里里', 10], ['电子琴', 10], ['乐器', 10], ['麦克风', 9],
    ['guitar', 10], ['ukulele', 10], ['keyboard piano', 9], ['microphone', 9], ['drum', 9],
    ['violin', 10]],
  'fashion': [['衣服', 8], ['T恤', 9], ['鞋', 7], ['袜子', 8], ['帽子', 8], ['项链', 9], ['手链', 9],
    ['shirt', 8], ['t-shirt', 9], ['shoes', 7], ['socks', 8], ['hat', 7], ['necklace', 9],
    ['bracelet', 9], ['jewelry', 9], ['dress', 8]],
  'videogames': [['游戏手柄', 10], ['游戏机', 10], ['手柄', 9], ['游戏卡', 10],
    ['game controller', 10], ['console', 9], ['gamepad', 10], ['nintendo', 9], ['playstation', 9]],
  'books': [['图书', 10], ['绘本', 10], ['小说', 9], ['教材', 9], ['笔记本本', 8],
    ['book', 9], ['notebook journal', 8], ['paperback', 9], ['coloring book', 10]],
  'grocery': [['零食', 9], ['咖啡豆', 10], ['茶叶', 10], ['坚果', 9], ['调味料', 9], ['饮料', 8],
    ['snack', 9], ['coffee bean', 10], ['tea', 9], ['nuts', 9], ['seasoning', 9], ['candy', 8]],
  'industrial': [['工业', 10], ['仪器', 9], ['轴承', 10], ['耗材', 9], ['手套', 7],
    ['industrial', 10], ['bearing', 10], ['sensor', 8], ['3d printer', 10], ['safety glove', 9]],
  'tools': [['手工具', 10], ['电动工具', 10], ['螺丝刀', 10], ['电钻', 10], ['扳手', 10], ['工具箱', 10],
    ['screwdriver', 10], ['drill', 10], ['wrench', 10], ['tool box', 10], ['hammer', 9]]
};

/**
 * 物种词：只用来决定"第一层往哪个动物分支走"（猫 / 狗 / 鸟 / 鱼）。
 * 进了分支之后就不再参与打分 —— 否则 "Cat Doors, Steps, Nets & Pens" 这种
 * 名字里蹭到一个 cat 的长类目，会靠泛词压过真正对口的类目（原项目实测踩过）。
 */
export const SPECIES = [
  ['猫抓板', 'cat'], ['猫爬架', 'cat'], ['猫玩具', 'cat'], ['猫砂', 'cat'], ['猫粮', 'cat'],
  ['猫咪', 'cat'], ['小猫', 'cat'], ['猫', 'cat'],
  ['狗咬胶', 'dog'], ['狗玩具', 'dog'], ['狗粮', 'dog'], ['狗狗', 'dog'], ['小狗', 'dog'], ['狗', 'dog'],
  ['抓板', 'cat'],   // 行业语境里"抓板"默认就是猫抓板
  ['兔子', 'rabbit'], ['仓鼠', 'hamster'], ['鸟笼', 'bird'], ['鱼缸', 'fish']
];

/**
 * 中文查询词 → 英文品类联想词（用于匹配亚马逊的英文子类目名）。
 * 格式：[中文词, [英文词...], 权重?]  权重默认 2；3 = 强品类词（"这个东西到底是什么"）。
 * 物种词不放这里，见 SPECIES。
 */
export const SUB_HINTS = [
  ['宠物玩具', ['toy']], ['狗狗玩具', ['toy']], ['猫玩具', ['toy']],
  ['抓板', ['scratching', 'scratcher', 'scratchers'], 3],
  ['猫抓板', ['scratching', 'scratcher', 'scratchers'], 3],
  ['猫爬架', ['tree', 'tower', 'condo'], 3],
  ['猫砂盆', ['litter', 'box'], 3],
  ['咬胶', ['chew'], 3], ['磨牙', ['chew'], 3], ['洁齿', ['dental', 'chew'], 3],
  ['弹力绳', ['rope'], 3], ['拔河绳', ['rope', 'tug'], 3], ['绳', ['rope']],
  ['宠物', ['pet'], 1],   // 泛词：只配权重 1，否则会命中 "Fish & Aquatic Pets" 这类噪音
  ['牵引绳', ['leash', 'collar']], ['项圈', ['collar']], ['猫砂', ['litter']], ['饮水机', ['fountain']],
  ['玩具', ['toy']], ['积木', ['block', 'building']], ['毛绒', ['plush']], ['拼图', ['puzzle']],
  ['娃娃', ['doll']], ['模型', ['model']],
  ['忙碌板', ['busy', 'activity'], 3], ['蒙氏', ['montessori', 'educational', 'toddler']],
  ['感官', ['sensory']],
  ['早教', ['educational', 'learning', 'toddler']], ['活动中心', ['activity']],
  ['木制玩具', ['wooden', 'toy']],
  ['耳机', ['headphone', 'earbud']], ['充电', ['charger']], ['数据线', ['cable']], ['音箱', ['speaker']],
  ['键盘', ['keyboard']], ['鼠标', ['mouse']], ['电源', ['power']],
  ['收纳', ['storage']], ['枕头', ['pillow']], ['地毯', ['rug']], ['窗帘', ['curtain']],
  ['架', ['stand', 'shelf']], ['装饰', ['decor']], ['毯', ['blanket']], ['灯', ['light']],
  ['刀', ['knife']], ['锅', ['pan']], ['餐具', ['utensil']], ['杯', ['cup']], ['水壶', ['bottle']],
  ['保温瓶', ['thermos', 'tumbler', 'bottle'], 3], ['保温杯', ['tumbler', 'bottle'], 3],
  ['保温壶', ['thermos', 'carafe'], 3], ['水杯', ['cup', 'tumbler']],
  ['瑜伽', ['yoga', 'exercise', 'fitness']], ['健身', ['fitness', 'exercise']],
  ['帐篷', ['tent', 'camping', 'outdoor']], ['哑铃', ['dumbbell', 'strength', 'weight']],
  ['骑行', ['cycling', 'bike']], ['球', ['ball']], ['露营', ['camping', 'outdoor']],
  ['护肤', ['skin']], ['洗发', ['hair']], ['面膜', ['mask']], ['口红', ['lip']],
  ['牙膏', ['tooth']], ['洗衣', ['laundry']], ['维生素', ['vitamin']],
  ['婴儿', ['baby']], ['宝宝', ['baby']], ['奶瓶', ['bottle']], ['推车', ['stroller']],
  ['文具', ['stationery']], ['笔', ['pen']], ['打印', ['printing']], ['标签', ['label']],
  ['吸尘器', ['vacuum']], ['风扇', ['fan']], ['冰箱', ['refrigerator']],
  ['车载', ['car']], ['汽车', ['car']], ['轮胎', ['tire']], ['脚垫', ['mat']],
  ['绘画', ['paint']], ['颜料', ['paint']], ['毛线', ['yarn']], ['手工', ['craft']],
  ['吉他', ['guitar']], ['键盘琴', ['keyboard']], ['麦克风', ['microphone']],
  ['衣', ['shirt']], ['鞋', ['shoe']], ['袜', ['sock']], ['帽', ['hat']], ['项链', ['necklace']],
  ['手柄', ['controller']], ['游戏', ['game']],
  ['绘本', ['book']], ['图书', ['book']],
  ['零食', ['snack']], ['咖啡', ['coffee']], ['茶', ['tea']], ['坚果', ['nut']],
  ['工具', ['tool']], ['螺丝刀', ['screwdriver']], ['电钻', ['drill']], ['手套', ['glove']]
];

/** 停用词（不参与关键词统计） */
export const STOP = new Set(('a an the and or for with of in to on by from at as is are be this that it its ' +
  'your you our all new set pack pcs piece pieces count ct inch inches cm mm oz lb lbs g kg ml ' +
  'x plus size color colors colour black white blue red green pink purple grey gray yellow large ' +
  'small medium mini xl xxl s m l 1 2 3 4 5 6 7 8 9 10 12 24 30 100 ' +
  'including includes include use using used great best good perfect ideal makes make made ' +
  'can will not no more most other others also than then when where which who whom how why ' +
  'out up down off over under into onto about only just even very much many some any each ' +
  'pcs. set. item items product products').split(/\s+/));

// ---------- 基础函数 ----------

/** 切词：小写 → 去标点 → 去停用词/纯数字/单字符 */
export function tokenize(title) {
  return String(title).toLowerCase()
    .replace(/[^a-z0-9\s\-']/g, ' ')
    .split(/\s+/)
    .map(w => w.replace(/^[-']+|[-']+$/g, ''))
    .filter(w => w && w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w));
}

/** 生成 n 元组及位置 */
export function buildNgrams(words, n) {
  const out = [];
  for (let i = 0; i + n <= words.length; i++) {
    const seg = words.slice(i, i + n);
    if (seg.some(w => w.length < 2)) continue;
    out.push({ term: seg.join(' '), pos: i });
  }
  return out;
}

/** 转义正则元字符（产品名/竞品标题里的 . * + ? 等不能被当成模式） */
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 词形宽松匹配：ropes 能被 rope 命中。
 *
 * 🔴 必须是**词边界**匹配，不能是 indexOf 子串匹配。
 *    2026-10-30 实测旧实现（join 成一个长串后 indexOf）：
 *      hasWord("party favors for kids", "art") → true   （"party" 里有 "art"）
 *      hasWord("cardigan sweater", "car")     → true   （"cardigan" 里有 "car"）
 *    一致性校验正是拿它算「我的产品联想词被竞品覆盖了多少」，子串命中会把
 *    "竞品其实一个字都没提" 的维度算成擦边命中 → 分数虚高，结论偏乐观。
 *    现在的口径：左边不能紧贴字母数字，右边允许复数尾巴（s / es），再右边也不能是字母数字。
 *    `rope` 命中 `ropes`、`cat` 命中 `cats`、`box` 命中 `boxes` —— 原本的意图照样成立。
 */
export function hasWord(joined, w) {
  const hay = String(joined || "").toLowerCase();
  const raw = String(w || "").toLowerCase().trim();
  if (!hay || !raw) return false;
  const stem = raw.replace(/(es|s)$/, "");
  const t = stem.length >= 3 ? stem : raw;
  return new RegExp("(?:^|[^a-z0-9])" + escRe(t) + "(?:s|es)?(?![a-z0-9])").test(hay);
}

/**
 * 一致性校验用的探测词。
 * @param {string} q 产品名
 * @param {string[]} extraWords 调用方额外给的英文词（原实现里来自联网翻译；本模块不联网，默认空）
 */
export function probeWords(q, extraWords = []) {
  const set = new Set();
  tokenize(extraWords.join(' ')).forEach(function (w) { if (w.length >= 3) set.add(w); });
  const low = String(q).toLowerCase();
  for (const it of SUB_HINTS) {
    if (low.indexOf(it[0]) >= 0) it[1].forEach(function (e) { set.add(e); });
  }
  return Array.from(set);
}

// ---------- 核心：关键词权重 ----------

/**
 * 覆盖率(使用率) 50% + 位置 30% + 精准度 20% → 1–10 分。
 * 分母 = 竞品标题总数；使用率 = 含该词的标题数 / 总数。
 * @param {string[]} titles    参与分析的竞品标题（用户勾选的那几条）
 * @param {object}   opts
 * @param {string}   opts.productName 产品名（做一致性校验）
 * @param {string[]} opts.allTitles   全部抓到的竞品标题 —— 一致性校验用它，不用勾选的那几条
 *                                    （勾选是挑选，不代表样本）
 * @param {string[]} opts.extraWords  一致性探测词的额外英文词（替代原实现的联网翻译）
 */
export function analyzeKeywords(titles, { productName = '', allTitles = [], extraWords = [] } = {}) {
  const list = (titles || []).map(t => String(t || '')).filter(t => t.trim().length > 8);
  const total = list.length;
  if (!total) return { ok: false, msg: '没有可分析的竞品标题' };

  const docs = list.map(t => tokenize(t));
  const stat = new Map();   // term -> { cov, posSum, n }

  for (let d = 0; d < docs.length; d++) {
    const words = docs[d];
    if (!words.length) continue;
    const seen = new Set();
    for (const n of [1, 2, 3]) {
      for (const g of buildNgrams(words, n)) {
        const k = g.term;
        if (seen.has(k)) continue;          // 同一标题内只计一次覆盖
        seen.add(k);
        let s = stat.get(k);
        if (!s) { s = { cov: 0, posSum: 0, n }; stat.set(k, s); }
        s.cov++;
        s.posSum += words.length > 1 ? g.pos / (words.length - 1) : 0;
      }
    }
  }

  const rows = [];
  for (const [term, s] of stat) {
    if (s.cov < 2) continue;                 // 只出现 1 次的噪声不留
    const covRate = s.cov / total;           // 覆盖率 = 使用率
    const avgPos = s.posSum / s.cov;         // 0 = 最前，1 = 最后
    const n = s.n;
    const covScore = covRate * 10;           // 0–10
    const posScore = (1 - Math.min(1, avgPos)) * 10;
    const lenScore = n === 1 ? 4 : n === 2 ? 7.5 : 10;

    let w = covScore * 0.5 + posScore * 0.3 + lenScore * 0.2;
    // 单词且极泛（如 toy / dog）不给满分，避免"入场券词"挤掉长尾
    if (n === 1 && covRate >= 0.9) w -= 1.2;
    w = Math.max(1, Math.min(10, Math.round(w * 10) / 10));

    let advice;
    if (covRate >= 0.8 && w >= 7) advice = '必埋标题前段';
    else if (covRate >= 0.5) advice = '放标题中后段';
    else if (covRate >= 0.2 && n >= 2) advice = '标题或五点，作补充';
    else if (covRate >= 0.2) advice = '放五点/后台词';
    else if (n >= 2) advice = '差异化长尾，可放后台词';
    else advice = '低优先，可不加';

    rows.push({
      term, n,
      cov: s.cov, total,
      useRate: Math.round(covRate * 1000) / 10,          // 使用率 %
      avgPos: Math.round(avgPos * 100) / 100,
      weight: w,
      advice
    });
  }

  rows.sort((a, b) => b.weight - a.weight || b.cov - a.cov);

  // 差异化 / 空白机会：覆盖低但词够具体
  const blank = rows.filter(r => r.useRate <= 25 && r.n >= 2).slice(0, 12);

  // 一致性校验：产品名（联想词）在竞品标题里的命中率
  let consistency = null;
  const pTxt = String(productName || '').trim();
  if (pTxt) {
    const probe = probeWords(pTxt, extraWords);
    // 🔴 用"全部抓到的竞品"判断，而不是用户勾选的那几条 —— 勾选是挑选，不代表样本
    const sample = (allTitles && allTitles.length >= 5) ? allTitles : list;
    if (probe.length) {
      const joined = sample.join(' ').toLowerCase();
      const hit = probe.filter(function (w) { return hasWord(joined, w); });
      const miss = probe.filter(function (w) { return hit.indexOf(w) < 0; });
      const score = Math.round((hit.length / probe.length) * 100);
      consistency = {
        score,
        sample: sample.length,
        hit: hit.slice(0, 8),
        miss: miss.slice(0, 8),
        level: score >= 40 ? 'good' : score >= 20 ? 'warn' : 'bad'
      };
    }
  }

  return { ok: true, total, rows, blank, consistency, top: rows.slice(0, 10) };
}

// ---------- 产品名 → 类目打分（纯本地第一层） ----------

/** 命中分最高者胜出；返回按分降序的候选数组 */
export function scoreCats(q) {
  const low = String(q).toLowerCase();
  const out = [];
  for (const slug in CAT_HINTS) {
    let score = 0;
    const hits = [];
    for (const [term, w] of CAT_HINTS[slug]) {
      if (low.indexOf(term.toLowerCase()) >= 0) { score += w; hits.push(term); }
    }
    if (score > 0) out.push({ cat: slug, score, hits });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** 只问"是哪个类目"时用这个；没有命中返回 null */
export function detectCatSlug(q) {
  const top = scoreCats(q);
  return top.length ? top[0].cat : null;
}

// ---------- 下游：把关键词变成"可粘进提示词"的文本 ----------

/**
 * 按建议分档把关键词排成几组，供提示词组装使用。
 * @returns {{must:string[], mid:string[], tail:string[], backend:string[]}}
 */
export function groupByAdvice(rows) {
  const must = [], mid = [], tail = [], backend = [];
  for (const r of rows || []) {
    if (r.advice === '必埋标题前段') must.push(r.term);
    else if (r.advice === '放标题中后段') mid.push(r.term);
    else if (r.advice === '标题或五点，作补充') tail.push(r.term);
    else backend.push(r.term);
  }
  return { must, mid, tail, backend };
}
