/**
 * 词根种子表 —— 纯数据，无逻辑、无网络。
 *
 * ── 它解决的是什么 ────────────────────────────────────────────────
 * 搜索建议接口需要一个「词根」才能吐长尾。词根从哪来？三种办法：
 *   ① 让用户自己输 —— 被否掉的方向（"要自己输进去我还需要你这工具干嘛"）；
 *   ② 从榜单商品标题里自动抠 —— 会抠出品牌名和型号（`Anker`、`B0XXXX`），噪声大；
 *   ③ **一份人工挑过的品类词根表** —— 就是这里。它稳定、可解释、可审计。
 *
 * 所以：**词根是人的判断，长尾是机器的活**。这张表负责前者。
 *
 * ── 口径 ──────────────────────────────────────────────────────────
 * · 全部英文（美国站为主；换站点时词根仍按目标市场语言，需另配一套）；
 * · 每条形如「形容词/材质 + 品类名」或「品类名 + 用途」，2–3 个词 ——
 *   太短（`mug`）会返回一堆不相关，太长会返回 0 条；
 * · **不写品牌名**：品牌词的长尾是品牌自己的，不是选品要的；
 * · 一张表只在 `ROOTS` 里维护，别在采集器里再写一份。
 */

/** 分组只用于「这周该抓哪些」的配额分配，不参与任何判定。 */
export const ROOT_GROUPS = [
  {
    key: "kitchen",
    label: "厨房餐具",
    cat: "kitchen",
    roots: [
      "ceramic mug", "coffee cup", "travel tumbler", "insulated bottle", "water bottle",
      "cutting board", "knife set", "cast iron skillet", "nonstick pan", "mixing bowl",
      "food storage container", "lunch box", "spice grinder", "kitchen scale", "dish rack",
    ],
  },
  {
    key: "home",
    label: "家居收纳",
    cat: "home-garden",
    roots: [
      "storage bin", "closet organizer", "shoe rack", "laundry hamper", "throw pillow",
      "area rug", "curtain rod", "wall shelf", "picture frame", "trash can",
      "drying rack", "velvet hangers", "drawer divider", "under bed storage", "garment bag",
    ],
  },
  {
    key: "decor",
    label: "家居装饰",
    cat: "home-garden",
    roots: [
      "scented candle", "reed diffuser", "wall art", "table lamp", "string lights",
      "plant pot", "ceramic vase", "wall mirror", "door mat", "curtain panel",
    ],
  },
  {
    key: "electronics",
    label: "电子产品",
    cat: "electronics",
    roots: [
      "wireless earbuds", "bluetooth speaker", "phone case", "phone charger", "power bank",
      "usb c cable", "laptop stand", "hd webcam", "mechanical keyboard", "wireless mouse",
      "hdmi cable", "screen protector", "car phone mount", "smart watch band", "tablet stand",
    ],
  },
  {
    key: "beauty",
    label: "美妆个护",
    cat: "beauty",
    roots: [
      "face serum", "face moisturizer", "cleansing balm", "lip balm", "hair oil",
      "scalp massager", "makeup brush set", "nail file", "eyelash curler", "body lotion",
      "mineral sunscreen", "face mask", "hair clip", "shower cap", "cotton pads",
    ],
  },
  {
    key: "pet",
    label: "宠物用品",
    cat: "pet-supplies",
    roots: [
      "dog leash", "dog harness", "cat tree", "pet bed", "slow feeder",
      "dog toy", "cat litter mat", "pet water fountain", "dog crate", "grooming brush",
      "cat scratcher", "poop bag", "pet carrier", "dog raincoat", "chew toy",
    ],
  },
  {
    key: "toys",
    label: "玩具游戏",
    cat: "toys-and-games",
    roots: [
      "building blocks", "wooden puzzle", "stuffed animal", "board game", "play dough",
      "magnetic tiles", "toy car", "doll house", "water gun", "kite for kids",
      "card game", "kids craft kit", "remote control car", "baby rattle", "stacking toy",
    ],
  },
  {
    key: "sports",
    label: "运动户外",
    cat: "sporting-goods",
    roots: [
      "yoga mat", "resistance band", "dumbbell set", "jump rope", "foam roller",
      "water bottle", "camping chair", "sleeping bag", "hiking backpack", "bike light",
      "fishing rod", "camping tent", "rechargeable headlamp", "compression socks", "knee brace",
    ],
  },
  {
    key: "office",
    label: "办公文具",
    cat: "office-products",
    roots: [
      "desk organizer", "gel pen", "sticky notes", "spiral notebook", "file folder",
      "label maker", "dry erase board", "desk mat", "monitor stand", "paper shredder",
      "stapler with staples", "weekly planner", "binder clips", "desk lamp", "cable organizer",
    ],
  },
  {
    key: "baby",
    label: "母婴用品",
    cat: "baby-products",
    roots: [
      "baby monitor", "diaper bag", "baby bottle", "baby stroller", "baby carrier",
      "breast pump", "baby blanket", "teething toy", "changing pad", "baby wipes",
      "high chair", "sippy cup", "baby shampoo", "swaddle blanket", "play mat",
    ],
  },
  {
    key: "appliance",
    label: "家用电器",
    cat: "appliances",
    roots: [
      "air purifier", "cool mist humidifier", "personal blender", "air fryer", "electric kettle",
      "vacuum cleaner", "hand mixer", "toaster 2 slice", "rice cooker", "space heater",
      "tower fan", "small dehumidifier", "steam iron", "food processor", "coffee maker",
    ],
  },
  {
    key: "auto",
    label: "汽车用品",
    cat: "automotive",
    roots: [
      "car vacuum", "seat cover", "phone holder", "dash cam", "car charger",
      "tire inflator", "microfiber towel", "sun shade", "floor mat", "jump starter",
      "car wax", "trash bag", "steering wheel cover", "cup holder", "windshield wiper",
    ],
  },
  {
    key: "craft",
    label: "艺术手工",
    cat: "arts-crafts",
    roots: [
      "acrylic paint", "paint brush set", "colored pencil", "sketch book", "crochet hook",
      "crochet yarn", "sewing kit", "resin mold", "diamond painting", "calligraphy pen",
    ],
  },
  {
    key: "health",
    label: "健康日用",
    cat: "hpc",
    roots: [
      "vitamin c", "collagen powder", "massage gun", "heating pad", "first aid kit",
      "posture corrector", "sleep mask", "pill organizer", "digital thermometer", "resistance loop",
    ],
  },
];

/** 扁平词根表（去重、保持顺序）—— 采集器只需要这个。 */
export const ROOTS = [...new Set(ROOT_GROUPS.flatMap((g) => g.roots))];

/** 词根 → 所属分组（写快照时带上，方便前端按品类筛）。 */
export const ROOT_TO_GROUP = new Map(ROOT_GROUPS.flatMap((g) => g.roots.map((r) => [r, g.key])));

/** 榜单类目 → 词根分组。采集 ASIN 时用它决定抓哪些类目，保证两头对得上。 */
export const CAT_TO_GROUP = new Map(ROOT_GROUPS.map((g) => [g.cat, g.key]));
