/**
 * Rufus / Alexa for Shopping 信息架构检查 —— 纯数据层。
 *
 * 本模块只放「数据」，不放任何判断逻辑，也不 import 任何模块：
 * 浏览器（<script type="module">）与 Node（import）都能直接使用，零依赖。
 *
 * 五个具名导出（注意：没有单一的合并表名，请按下面 5 个真实导出名引用）：
 *   · CATEGORY_ATTRIBUTES —— 按产品类型的属性清单（required / recommended）
 *   · CATEGORY_QUESTIONS  —— 按产品类型的买家高频问题覆盖矩阵
 *   · UNIT_GROUPS         —— 同族不同单位词表（单位制一致性检查用）
 *   · MATERIAL_CONFLICTS  —— 互斥材质／成分词对（含 guards 混纺保护词）
 *   · NUMBER_UNIT_RE      —— 数值 + 单位提取的描述对象（非裸 RegExp）
 *
 * 出处纪律（本项目的铁律，务必遵守）：
 *   source 只有三个合法取值，写成这三个字面值，不许出现别的写法：
 *     "amazon-guide"   —— 亚马逊**帮助文档正文**明确举例或定义：《Attributes guide》、
 *                         《目录属性规范化》、Baby 等类目帮助页。
 *     "amazon-schema"  —— 亚马逊**一方的结构性产物**：Flat File 模板列名、
 *                         SP-API Product Type Definition schema 字段名、
 *                         Seller Central 后台表单字段名。
 *     "practitioner"   —— 无官方明文，行业通行／项目自定义。
 *   宁可标低，不许标高：拿不准一律 practitioner。对外材料里一条查不到出处的「官方」
 *   会毁掉整段可信度，远不如老实标注。
 *
 * required 数组语义（纪律，务必遵守，防止后来人再按常识往里塞）：
 *   required = 官方帮助文档正文／官方必填组明文要求的字段。不是「常识上应该必填」。
 *   放进 required 必须能附上引用句；拿不出引用句的一律放 recommended。宁可标低。
 *   理由：界面上写「必填」等于替亚马逊下断言，只有官方明文可证才允许这样说。
 *
 * required 字段的引用句登记（可复查，谁问都能指着这一节看）：
 *   · item_type_keyword（home_kitchen）—— 官方 Category Style Guide 脚注原文：
 *     "ItemType is required and is the most important attribute for getting customers to your
 *      product and in the most granular browse node."；SP-API Product Type Definition 亦带 minItems: 1。
 *   · item_name（全部 8 个类目）—— Amazon Seller Central 官方帮助页《商品名称要求和指南》
 *      （页面 ID GYTR6SYGFA5E3EQC）正文：「对于首次发布的商品，商品名称必须符合以下要求」
 *      （其后列 75 字符上限、禁促销语、特殊字符、重复词等硬约束）。
 *   · color / size / material / unit_count / unit_count_type / item_weight —— 官方《Attributes guide》
 *     正文举例，或官方《目录属性规范化》正文逐字列明。
 *
 * 已按「证据到哪、结论到哪」移出 required 的字段登记（均无官方必填组原文，移至 recommended）：
 *   brand（8 个类目）、apparel:department、electronics:model_number、electronics:batteries_required、
 *   baby:age_range_description。
 *   注：brand 与 item_name 都像「必填」，但证据强度不同 —— item_name 有官方帮助页正文故留在 required，
 *   brand 只有 Learn 页流程叙述与第三方口径，故不跟着提回。不为了对称而降低证据标准。
 *
 * alias 读法层（条目上的可选字段；只影响「读」，不影响归属判据）：
 *   语义：读「该字段填了没有」时，listing[e.key] 非空 或 e.alias 中任一键非空 => 视为已填。
 *   纪律：alias 只参与读，绝不改变 required / recommended 的归属；alias 缺失时行为与无别名完全一致。
 *   已加 alias 的 key 与依据（与既有草稿模型字段语义等价；草稿字段名实测见 assets/app.js:894-898）：
 *     · item_name —— alias: ["title"]（8 个类目均加）。依据：item_name 就是商品标题，与草稿模型
 *       的 title 语义等价，不加则用户在标题框填了标题、仍会被判 item_name 缺失（必然误报）。
 *   未加 alias 的原因（一句话）：本清单其余 63 个 key 都是**结构化属性**（brand / color / material /
 *     size / 各品类专有属性等），草稿模型只有 title / highlights / bullets / description / searchTerms
 *     这 5 个内容字段，没有与它们语义等价的属性字段，故一律不加。
 *     另注：bullet_point / product_description / title_differentiation / generic_keywords 这几个「内容类」
 *     字段**本就不在** CATEGORY_ATTRIBUTES 清单里（它们属 listing 内容模型，不是类目属性），
 *     因此没有为它们加 alias 的位置 —— 需要时由规则层直接读草稿字段，不要在本清单里造 key。
 *
 * 说明：本模块不实现任何检查，只提供词表与问题清单，供规则引擎消费。
 *   属性值本身有闭集约束（官方错误码 90057：值必须来自下拉清单），
 *   因此本项目只做「哪个字段空着」的检查与引导，不做生成式填值。
 */

/* ─────────────────────────── ① 属性清单（按产品类型）─────────────────────────── */

/**
 * 每个字段对象：
 *   key    —— 亚马逊官方模板／SP-API 的英文列名（snake_case），不要自造中文 key
 *   label  —— 中文说明，给人看
 *   source —— "amazon-guide" | "amazon-schema" | "practitioner"
 *
 * required 与 recommended 两档对应官方《Attributes guide》的三视图
 * （Required / Recommended / All）里的前两档口径。
 */
export const CATEGORY_ATTRIBUTES = {
  home_kitchen: {
    label: "家居厨房（Home & Kitchen）",
    required: [
      { key: "item_name", label: "商品标题", source: "amazon-guide", alias: ["title"] },
      // item_type_keyword 属必填：Amazon 官方 Category Style Guide 脚注原文 —
      // "ItemType is required and is the most important attribute for getting customers to your
      //  product and in the most granular browse node."；SP-API Product Type Definition 亦带 minItems: 1。
      // 依据为帮助文档 / 类目 Style Guide 正文，故 source = amazon-guide（不是 amazon-schema）。
      { key: "item_type_keyword", label: "商品类型关键词（必填；决定商品归入哪个浏览分类）", source: "amazon-guide" },
      { key: "color", label: "颜色", source: "amazon-guide" },
      { key: "size", label: "尺寸", source: "amazon-guide" },
      { key: "material", label: "主要材质", source: "amazon-guide" },
    ],
    recommended: [
      { key: "unit_count", label: "单位计数（数量值）", source: "amazon-guide" },
      { key: "unit_count_type", label: "单位计数类型（如 count / pack）", source: "amazon-guide" },
      { key: "number_of_items", label: "商品数量", source: "amazon-guide" },
      { key: "item_dimensions", label: "商品尺寸（长宽高）", source: "amazon-guide" },
      { key: "item_weight", label: "商品重量", source: "amazon-guide" },
      { key: "capacity", label: "容量", source: "amazon-guide" },
      { key: "special_features", label: "特殊功能", source: "amazon-guide" },
      { key: "care_instructions", label: "清洁保养说明", source: "amazon-guide" },
      { key: "style", label: "款式", source: "amazon-schema" },
      { key: "pattern", label: "图案", source: "amazon-schema" },
      { key: "included_components", label: "随附配件", source: "practitioner" },
      { key: "room_type", label: "适用房间", source: "practitioner" },
      { key: "is_assembly_required", label: "是否需要组装", source: "practitioner" },
      { key: "warranty_description", label: "保修说明", source: "amazon-schema" },
      { key: "indoor_outdoor_usage", label: "室内 / 户外使用", source: "practitioner" },
      { key: "brand", label: "品牌名称", source: "amazon-schema" },
    ],
  },

  apparel: {
    label: "服装（Apparel）",
    required: [
      { key: "item_name", label: "商品标题", source: "amazon-guide", alias: ["title"] },
      { key: "size", label: "尺码", source: "amazon-guide" },
      { key: "color", label: "颜色", source: "amazon-guide" },
      { key: "material", label: "主要材质", source: "amazon-guide" },
    ],
    recommended: [
      { key: "fabric_type", label: "面料成分（含百分比）", source: "amazon-schema" },
      { key: "care_instructions", label: "洗涤保养说明", source: "amazon-guide" },
      { key: "style", label: "款式", source: "amazon-schema" },
      { key: "pattern", label: "图案", source: "amazon-schema" },
      { key: "closure", label: "闭合方式（拉链 / 纽扣）", source: "amazon-schema" },
      { key: "weave_type", label: "织法", source: "amazon-schema" },
      { key: "age_range_description", label: "适用年龄段", source: "amazon-schema" },
      { key: "item_weight", label: "商品重量", source: "amazon-guide" },
      { key: "country_of_origin", label: "原产国", source: "amazon-guide" },
      { key: "size_map", label: "尺码对照表", source: "practitioner" },
      { key: "fit_type", label: "版型（修身 / 宽松）", source: "practitioner" },
      { key: "sleeve_type", label: "袖型", source: "practitioner" },
      { key: "neckline", label: "领型", source: "practitioner" },
      { key: "brand", label: "品牌名称", source: "amazon-schema" },
      { key: "department", label: "部门（男装 / 女装 / 童装）", source: "amazon-schema" },
    ],
  },

  electronics: {
    label: "电子产品（Electronics）",
    required: [
      { key: "item_name", label: "商品标题", source: "amazon-guide", alias: ["title"] },
      { key: "color", label: "颜色", source: "amazon-guide" },
      { key: "item_weight", label: "商品重量", source: "amazon-guide" },
    ],
    recommended: [
      { key: "batteries_included", label: "是否含电池", source: "amazon-schema" },
      { key: "battery", label: "电池电芯成分", source: "amazon-schema" },
      { key: "num_batteries", label: "电池数量", source: "amazon-schema" },
      { key: "wattage", label: "功率（瓦特）", source: "amazon-guide" },
      { key: "item_dimensions", label: "商品尺寸（长宽高）", source: "amazon-guide" },
      { key: "item_package_weight", label: "包装重量", source: "amazon-schema" },
      { key: "item_package_dimensions", label: "包装尺寸", source: "amazon-schema" },
      { key: "special_features", label: "特殊功能", source: "amazon-guide" },
      { key: "warranty_description", label: "保修说明", source: "amazon-schema" },
      { key: "supplier_declared_dg_hz_regulation", label: "危险品申报", source: "amazon-schema" },
      { key: "country_of_origin", label: "原产国", source: "amazon-guide" },
      { key: "voltage", label: "电压", source: "practitioner" },
      { key: "power_source", label: "供电方式（电池 / 有线 / USB）", source: "practitioner" },
      { key: "connectivity_type", label: "连接方式（蓝牙 / Wi-Fi / USB）", source: "practitioner" },
      { key: "compatible_devices", label: "兼容设备", source: "practitioner" },
      { key: "included_components", label: "随附配件（充电线 / 适配器）", source: "practitioner" },
      { key: "brand", label: "品牌名称", source: "amazon-schema" },
      { key: "model_number", label: "型号", source: "amazon-schema" },
      { key: "batteries_required", label: "是否需要电池", source: "amazon-schema" },
    ],
  },

  pet_supplies: {
    label: "宠物用品（Pet Supplies）",
    required: [
      { key: "item_name", label: "商品标题", source: "amazon-guide", alias: ["title"] },
      { key: "size", label: "尺寸", source: "amazon-guide" },
      { key: "color", label: "颜色", source: "amazon-guide" },
      { key: "material", label: "主要材质", source: "amazon-guide" },
      { key: "item_weight", label: "商品重量", source: "amazon-guide" },
    ],
    recommended: [
      { key: "unit_count", label: "单位计数（数量值）", source: "amazon-guide" },
      { key: "unit_count_type", label: "单位计数类型", source: "amazon-guide" },
      { key: "number_of_items", label: "商品数量", source: "amazon-guide" },
      { key: "capacity", label: "容量（食盆 / 水盆 / 猫砂盆）", source: "amazon-guide" },
      { key: "item_dimensions", label: "商品尺寸（长宽高）", source: "amazon-guide" },
      { key: "care_instructions", label: "清洁保养说明", source: "amazon-guide" },
      { key: "special_features", label: "特殊功能", source: "amazon-guide" },
      { key: "country_of_origin", label: "原产国", source: "amazon-guide" },
      { key: "target_species", label: "适用物种（犬 / 猫 / 小宠）", source: "practitioner" },
      { key: "pet_life_stage", label: "适用生命阶段（幼年 / 成年 / 老年）", source: "practitioner" },
      { key: "breed_recommendation", label: "推荐犬猫体型", source: "practitioner" },
      { key: "flavor", label: "口味", source: "practitioner" },
      { key: "item_form", label: "形态（干粮 / 湿粮 / 冻干）", source: "practitioner" },
      { key: "included_components", label: "随附配件", source: "practitioner" },
      { key: "is_assembly_required", label: "是否需要组装", source: "practitioner" },
      { key: "weight_capacity", label: "承重上限（适用体型上限）", source: "practitioner" },
      { key: "safety_warning", label: "安全警示（如需在旁看护）", source: "practitioner" },
      { key: "warranty_description", label: "保修说明", source: "amazon-schema" },
      { key: "brand", label: "品牌名称", source: "amazon-schema" },
    ],
  },

  beauty: {
    label: "美妆个护（Beauty & Personal Care）",
    required: [
      { key: "item_name", label: "商品标题", source: "amazon-guide", alias: ["title"] },
      { key: "unit_count", label: "单位计数（数量值）", source: "amazon-guide" },
      { key: "unit_count_type", label: "单位计数类型（如 fl oz / count）", source: "amazon-guide" },
      { key: "size", label: "规格", source: "amazon-guide" },
      { key: "color", label: "色号", source: "amazon-guide" },
    ],
    recommended: [
      { key: "net_content_volume", label: "净含量（体积）", source: "amazon-guide" },
      { key: "net_content_weight", label: "净含量（重量）", source: "amazon-guide" },
      { key: "capacity", label: "容量", source: "amazon-guide" },
      { key: "item_weight", label: "商品重量", source: "amazon-guide" },
      { key: "special_features", label: "特殊功能（如无香精 / 防水）", source: "amazon-guide" },
      { key: "country_of_origin", label: "原产国", source: "amazon-guide" },
      { key: "item_form", label: "形态（膏 / 液 / 粉 / 喷雾）", source: "practitioner" },
      { key: "ingredients", label: "成分表", source: "practitioner" },
      { key: "active_ingredients", label: "有效成分", source: "practitioner" },
      { key: "skin_type", label: "适用肤质", source: "practitioner" },
      { key: "hair_type", label: "适用发质", source: "practitioner" },
      { key: "scent", label: "香型", source: "practitioner" },
      { key: "target_audience", label: "目标人群", source: "practitioner" },
      { key: "safety_warning", label: "安全警示（如儿童禁用 / 需皮试）", source: "practitioner" },
      { key: "brand", label: "品牌名称", source: "amazon-schema" },
    ],
  },

  sports_outdoors: {
    label: "运动户外（Sports & Outdoors）",
    required: [
      { key: "item_name", label: "商品标题", source: "amazon-guide", alias: ["title"] },
      { key: "color", label: "颜色", source: "amazon-guide" },
      { key: "size", label: "尺寸", source: "amazon-guide" },
      { key: "material", label: "主要材质", source: "amazon-guide" },
      { key: "item_weight", label: "商品重量", source: "amazon-guide" },
    ],
    recommended: [
      { key: "item_dimensions", label: "商品尺寸（长宽高）", source: "amazon-guide" },
      { key: "number_of_items", label: "商品数量", source: "amazon-guide" },
      { key: "unit_count", label: "单位计数", source: "amazon-guide" },
      { key: "unit_count_type", label: "单位计数类型", source: "amazon-guide" },
      { key: "special_features", label: "特殊功能（如防水 IPX 等级）", source: "amazon-guide" },
      { key: "age_range_description", label: "适用年龄段", source: "amazon-schema" },
      { key: "care_instructions", label: "清洁保养说明", source: "amazon-guide" },
      { key: "warranty_description", label: "保修说明", source: "amazon-schema" },
      { key: "country_of_origin", label: "原产国", source: "amazon-guide" },
      { key: "style", label: "款式", source: "amazon-schema" },
      { key: "sport_type", label: "适用运动类型", source: "practitioner" },
      { key: "indoor_outdoor_usage", label: "室内 / 户外使用", source: "practitioner" },
      { key: "weight_capacity", label: "承重上限", source: "practitioner" },
      { key: "skill_level", label: "适用熟练度", source: "practitioner" },
      { key: "included_components", label: "随附配件", source: "practitioner" },
      { key: "is_assembly_required", label: "是否需要组装", source: "practitioner" },
      { key: "brand", label: "品牌名称", source: "amazon-schema" },
    ],
  },

  baby: {
    label: "母婴（Baby）",
    required: [
      { key: "item_name", label: "商品标题", source: "amazon-guide", alias: ["title"] },
      { key: "color", label: "颜色", source: "amazon-guide" },
      { key: "size", label: "尺寸", source: "amazon-guide" },
      { key: "material", label: "主要材质", source: "amazon-guide" },
    ],
    recommended: [
      { key: "care_instructions", label: "清洁保养说明", source: "amazon-guide" },
      { key: "country_of_origin", label: "原产国", source: "amazon-guide" },
      { key: "special_features", label: "特殊功能", source: "amazon-guide" },
      { key: "batteries_required", label: "是否需要电池", source: "amazon-schema" },
      { key: "batteries_included", label: "是否含电池", source: "amazon-schema" },
      { key: "num_batteries", label: "电池数量", source: "amazon-schema" },
      { key: "item_weight", label: "商品重量", source: "amazon-guide" },
      { key: "item_dimensions", label: "商品尺寸（长宽高）", source: "amazon-guide" },
      { key: "unit_count", label: "单位计数", source: "amazon-guide" },
      { key: "unit_count_type", label: "单位计数类型", source: "amazon-guide" },
      { key: "target_gender", label: "适用性别", source: "amazon-schema" },
      { key: "department", label: "部门", source: "amazon-schema" },
      { key: "warranty_description", label: "保修说明", source: "amazon-schema" },
      { key: "safety_warning", label: "安全警示", source: "practitioner" },
      { key: "is_assembly_required", label: "是否需要组装", source: "practitioner" },
      { key: "included_components", label: "随附配件", source: "practitioner" },
      { key: "weight_capacity", label: "承重上限（如推车 / 座椅限重）", source: "practitioner" },
      { key: "fabric_type", label: "面料成分", source: "amazon-schema" },
      { key: "brand", label: "品牌名称", source: "amazon-schema" },
      { key: "age_range_description", label: "适用年龄段", source: "amazon-schema" },
    ],
  },

  office: {
    label: "办公用品（Office Products）",
    required: [
      { key: "item_name", label: "商品标题", source: "amazon-guide", alias: ["title"] },
      { key: "color", label: "颜色", source: "amazon-guide" },
      { key: "size", label: "尺寸", source: "amazon-guide" },
      { key: "material", label: "主要材质", source: "amazon-guide" },
      { key: "item_weight", label: "商品重量", source: "amazon-guide" },
    ],
    recommended: [
      { key: "item_dimensions", label: "商品尺寸（长宽高）", source: "amazon-guide" },
      { key: "unit_count", label: "单位计数", source: "amazon-guide" },
      { key: "unit_count_type", label: "单位计数类型", source: "amazon-guide" },
      { key: "number_of_items", label: "商品数量", source: "amazon-guide" },
      { key: "capacity", label: "容量", source: "amazon-guide" },
      { key: "special_features", label: "特殊功能", source: "amazon-guide" },
      { key: "style", label: "款式", source: "amazon-schema" },
      { key: "warranty_description", label: "保修说明", source: "amazon-schema" },
      { key: "country_of_origin", label: "原产国", source: "amazon-guide" },
      { key: "model_number", label: "型号", source: "amazon-schema" },
      { key: "power_source", label: "供电方式", source: "practitioner" },
      { key: "connectivity_type", label: "连接方式（USB / 无线）", source: "practitioner" },
      { key: "compatible_devices", label: "兼容设备", source: "practitioner" },
      { key: "os_support", label: "支持的操作系统", source: "practitioner" },
      { key: "mounting_type", label: "安装方式（桌面 / 壁挂）", source: "practitioner" },
      { key: "included_components", label: "随附配件", source: "practitioner" },
      { key: "batteries_required", label: "是否需要电池", source: "amazon-schema" },
      { key: "brand", label: "品牌名称", source: "amazon-schema" },
    ],
  },
};

/* ─────────────────────────── ② 买家问题覆盖矩阵 ─────────────────────────── */

/**
 * 每条问题对象：
 *   id           —— 稳定标识，形如 "{productType}-q{n}"
 *   question     —— 英文，模拟买家在 Rufus / Alexa for Shopping 里的真实问法
 *   answerHints  —— 数组，回答里应出现的关键信息类型，供机械匹配
 *   why          —— 一句说明这类问题为什么高频（可选）
 *   source       —— 一律 "practitioner"：我们没有任何官方问题清单，
 *                   这份清单是从业者口径（由评论 / Q&A / 客服收件箱归纳的经验值），
 *                   不是亚马逊官方明文，绝不许写成官方。
 */
export const CATEGORY_QUESTIONS = {
  home_kitchen: [
    { id: "home_kitchen-q1", question: "Will this fit a standard 30-inch cabinet?", answerHints: ["dimensions", "unit", "compatibility", "item_dimensions"], why: "尺寸与橱柜是否匹配是安装前第一道门槛，答不上就放弃购买。", source: "practitioner" },
    { id: "home_kitchen-q2", question: "What is it made of?", answerHints: ["material"], why: "材质直接决定耐用度与安全性，是最高频的单项提问。", source: "practitioner" },
    { id: "home_kitchen-q3", question: "Is it dishwasher safe?", answerHints: ["care_instructions", "material"], why: "清洁方式决定日常使用成本，厨房品类必问。", source: "practitioner" },
    { id: "home_kitchen-q4", question: "Can I put this in the microwave?", answerHints: ["material", "care_instructions", "temperature_range"], why: "误用会损坏产品甚至引发安全风险，买家必须确认。", source: "practitioner" },
    { id: "home_kitchen-q5", question: "How many pieces come in the set?", answerHints: ["unit_count", "included_components"], why: "数量与套装内容关系到性价比判断。", source: "practitioner" },
    { id: "home_kitchen-q6", question: "What are the exact dimensions of this item?", answerHints: ["dimensions", "unit", "item_dimensions"], why: "缺少精确尺寸会导致退货，是最常见的差评来源。", source: "practitioner" },
    { id: "home_kitchen-q7", question: "Does it come with the mounting hardware?", answerHints: ["included_components"], why: "配件缺失会迫使用户二次采购，是典型的信息缺口。", source: "practitioner" },
    { id: "home_kitchen-q8", question: "Is it safe for hot food and liquids?", answerHints: ["material", "temperature_range", "care_instructions"], why: "耐温性能关系到食品安全，买家对材质边界很敏感。", source: "practitioner" },
    { id: "home_kitchen-q9", question: "Can it be used outdoors on a patio?", answerHints: ["indoor_outdoor_usage", "material"], why: "室内外使用场景差异大，误用会导致生锈或褪色。", source: "practitioner" },
    { id: "home_kitchen-q10", question: "Is there a warranty if it breaks?", answerHints: ["warranty_description"], why: "耐用品的售后承诺直接影响下单信心。", source: "practitioner" },
  ],

  apparel: [
    { id: "apparel-q1", question: "What size should I order if I normally wear a medium?", answerHints: ["size", "size_map", "fit_type"], why: "尺码偏差是服装类目退货的首要原因。", source: "practitioner" },
    { id: "apparel-q2", question: "Is the fabric stretchy or rigid?", answerHints: ["material", "fabric_type"], why: "弹性影响合身度与舒适度，照片看不出。", source: "practitioner" },
    { id: "apparel-q3", question: "Can I machine wash this?", answerHints: ["care_instructions"], why: "洗涤方式是日常维护成本的关键。", source: "practitioner" },
    { id: "apparel-q4", question: "What is the exact material composition?", answerHints: ["material", "fabric_type"], why: "成分百分比影响透气、缩水与过敏，必须精确。", source: "practitioner" },
    { id: "apparel-q5", question: "Does this run small or true to size?", answerHints: ["fit_type", "size", "size_map"], why: "版型偏差直接决定是否退货。", source: "practitioner" },
    { id: "apparel-q6", question: "Is this suitable for hot summer weather?", answerHints: ["material", "seasons", "fabric_type"], why: "季节适用性影响使用场景匹配。", source: "practitioner" },
    { id: "apparel-q7", question: "Is it see-through when worn?", answerHints: ["material", "fabric_type", "color"], why: "透明感是服装差评的高频词。", source: "practitioner" },
    { id: "apparel-q8", question: "Is it machine washable or dry clean only?", answerHints: ["care_instructions"], why: "只能干洗会显著抬升持有成本，买家提前确认。", source: "practitioner" },
    { id: "apparel-q9", question: "Will it shrink after the first wash?", answerHints: ["care_instructions", "material", "fabric_type"], why: "缩水是服装类目最常见的售后争议之一。", source: "practitioner" },
    { id: "apparel-q10", question: "What colors does this come in?", answerHints: ["color"], why: "颜色选项决定是否有买家想要的那一款。", source: "practitioner" },
  ],

  electronics: [
    { id: "electronics-q1", question: "Does it come with a charger and cable in the box?", answerHints: ["included_components", "power_source"], why: "配件是否含在包装内直接影响总成本。", source: "practitioner" },
    { id: "electronics-q2", question: "Are batteries included or do I need to buy them?", answerHints: ["batteries_included", "batteries_required", "num_batteries"], why: "电池是否随附是电子产品高频提问。", source: "practitioner" },
    { id: "electronics-q3", question: "How long does the battery last on a full charge?", answerHints: ["battery", "battery_life"], why: "续航是便携电子产品的核心购买指标。", source: "practitioner" },
    { id: "electronics-q4", question: "Is this compatible with an iPhone 15?", answerHints: ["compatibility", "connectivity_type", "compatible_devices"], why: "兼容性判断错误会导致直接退货。", source: "practitioner" },
    { id: "electronics-q5", question: "What is the input voltage and can it be used abroad?", answerHints: ["voltage", "power_source"], why: "跨境使用与地区电压适配是常被忽略的坑。", source: "practitioner" },
    { id: "electronics-q6", question: "Is there a warranty on this product?", answerHints: ["warranty_description"], why: "电子产品的售后承诺是下单的重要保障。", source: "practitioner" },
    { id: "electronics-q7", question: "Does it support Bluetooth 5.0 or newer?", answerHints: ["connectivity_type", "compatibility"], why: "连接协议版本决定能否与手头设备配对。", source: "practitioner" },
    { id: "electronics-q8", question: "What is the exact weight of the device?", answerHints: ["item_weight", "unit"], why: "便携设备的重量是随身携带的关键。", source: "practitioner" },
    { id: "electronics-q9", question: "Can I use it while it is charging?", answerHints: ["power_source", "special_features"], why: "边充边用是否支持影响使用体验。", source: "practitioner" },
    { id: "electronics-q10", question: "How long is the included cable?", answerHints: ["dimensions", "unit", "included_components"], why: "线材长度不足会迫使买家另购。", source: "practitioner" },
  ],

  pet_supplies: [
    { id: "pet_supplies-q1", question: "What size dog is this suitable for?", answerHints: ["size", "breed_recommendation", "weight_capacity"], why: "体型不匹配是宠物用品退货主因。", source: "practitioner" },
    { id: "pet_supplies-q2", question: "Is this chew-proof for aggressive chewers?", answerHints: ["material", "durability", "special_features"], why: "耐咬程度决定玩具能否存活，是差评高频点。", source: "practitioner" },
    { id: "pet_supplies-q3", question: "Can I wash this in the washing machine?", answerHints: ["care_instructions", "material"], why: "宠物用品清洁需求高，洗涤方式必确认。", source: "practitioner" },
    { id: "pet_supplies-q4", question: "What are the exact dimensions of this item?", answerHints: ["dimensions", "unit", "item_dimensions"], why: "尺寸偏差会导致宠物用不上。", source: "practitioner" },
    { id: "pet_supplies-q5", question: "Is this safe for puppies and kittens?", answerHints: ["age_range", "pet_life_stage", "safety_warning"], why: "幼宠安全是买家最在意的顾虑。", source: "practitioner" },
    { id: "pet_supplies-q6", question: "Does it contain any harmful chemicals or BPA?", answerHints: ["material", "safety_warning"], why: "宠物啃咬接触材料，安全性必须说明。", source: "practitioner" },
    { id: "pet_supplies-q7", question: "How much food or water does it hold?", answerHints: ["capacity", "unit"], why: "容量决定是否需要频繁加食加水。", source: "practitioner" },
    { id: "pet_supplies-q8", question: "Is it suitable for cats as well as dogs?", answerHints: ["target_species", "size"], why: "跨物种适用性影响购买范围。", source: "practitioner" },
    { id: "pet_supplies-q9", question: "What is it made of and is it pet safe?", answerHints: ["material", "safety_warning"], why: "材质与宠物安全常被合并提问。", source: "practitioner" },
    { id: "pet_supplies-q10", question: "Does it come with a warranty?", answerHints: ["warranty_description"], why: "耐用品类的售后承诺影响信任。", source: "practitioner" },
  ],

  beauty: [
    { id: "beauty-q1", question: "What are the full ingredients in this product?", answerHints: ["ingredients", "active_ingredients"], why: "成分表是美妆类目合规与过敏判断的核心。", source: "practitioner" },
    { id: "beauty-q2", question: "Is it suitable for sensitive or acne-prone skin?", answerHints: ["skin_type", "ingredients", "special_features"], why: "肤质适配是美妆购买第一道筛子。", source: "practitioner" },
    { id: "beauty-q3", question: "Is this cruelty-free and vegan?", answerHints: ["ingredients", "certifications"], why: "动物友好与素颜诉求在美妆买家占比高。", source: "practitioner" },
    { id: "beauty-q4", question: "How long will one bottle last with daily use?", answerHints: ["capacity", "unit_count", "usage"], why: "使用周期关系到真实单价。", source: "practitioner" },
    { id: "beauty-q5", question: "What does it smell like?", answerHints: ["scent"], why: "香型是美妆个护无法从图片判断的关键信息。", source: "practitioner" },
    { id: "beauty-q6", question: "Is it safe for color-treated or damaged hair?", answerHints: ["hair_type", "ingredients"], why: "发质适配决定是否会加重损伤。", source: "practitioner" },
    { id: "beauty-q7", question: "Does this leave a white cast on the skin?", answerHints: ["color", "finish", "ingredients"], why: "泛白是防晒与底妆类目的高频差评。", source: "practitioner" },
    { id: "beauty-q8", question: "How many ounces is the bottle?", answerHints: ["capacity", "net_content_volume", "unit"], why: "净含量直接关系到性价比换算。", source: "practitioner" },
    { id: "beauty-q9", question: "Is it fragrance-free?", answerHints: ["scent", "ingredients", "special_features"], why: "无香精是敏感肌买家的硬性筛选条件。", source: "practitioner" },
    { id: "beauty-q10", question: "Can this be used on children?", answerHints: ["age_range", "target_audience", "safety_warning"], why: "儿童使用限制涉及安全与合规。", source: "practitioner" },
  ],

  sports_outdoors: [
    { id: "sports_outdoors-q1", question: "How much weight can this hold?", answerHints: ["weight_capacity", "material"], why: "承重是户外装备的安全底线。", source: "practitioner" },
    { id: "sports_outdoors-q2", question: "Is it waterproof for use in the rain?", answerHints: ["material", "special_features", "water_resistance"], why: "防水等级常被模糊表述，买家需明确。", source: "practitioner" },
    { id: "sports_outdoors-q3", question: "What are the packed dimensions and weight?", answerHints: ["dimensions", "item_weight", "unit"], why: "收纳体积与重量决定便携性。", source: "practitioner" },
    { id: "sports_outdoors-q4", question: "Does it come with a carry bag or case?", answerHints: ["included_components"], why: "收纳配件缺失会额外增加成本。", source: "practitioner" },
    { id: "sports_outdoors-q5", question: "Is this suitable for beginners or advanced users?", answerHints: ["skill_level"], why: "熟练度适配影响使用是否顺手。", source: "practitioner" },
    { id: "sports_outdoors-q6", question: "How much does it weigh when fully assembled?", answerHints: ["item_weight", "unit"], why: "组装后重量影响携带与存放。", source: "practitioner" },
    { id: "sports_outdoors-q7", question: "Can it be used in salt water or at the beach?", answerHints: ["material", "care_instructions"], why: "海水腐蚀环境对材质要求更高。", source: "practitioner" },
    { id: "sports_outdoors-q8", question: "What is the maximum height or length range?", answerHints: ["dimensions", "size", "unit"], why: "可调范围决定是否适配使用者身材。", source: "practitioner" },
    { id: "sports_outdoors-q9", question: "Is assembly required when it arrives?", answerHints: ["is_assembly_required", "included_components"], why: "是否需要组装影响开箱即可用性。", source: "practitioner" },
    { id: "sports_outdoors-q10", question: "Is it suitable for indoor use as well?", answerHints: ["indoor_outdoor_usage", "dimensions"], why: "室内外通用性扩大使用场景。", source: "practitioner" },
  ],

  baby: [
    { id: "baby-q1", question: "Is this safe for a 6-month-old baby?", answerHints: ["age_range", "safety_warning"], why: "年龄段与安全性是母婴用品的硬门槛。", source: "practitioner" },
    { id: "baby-q2", question: "What is the maximum weight limit?", answerHints: ["weight_capacity", "age_range"], why: "承重上限决定产品能用多久。", source: "practitioner" },
    { id: "baby-q3", question: "Is it machine washable?", answerHints: ["care_instructions", "material"], why: "母婴用品洗涤频次极高，清洁方式必确认。", source: "practitioner" },
    { id: "baby-q4", question: "Is it BPA-free and non-toxic?", answerHints: ["material", "safety_warning", "certifications"], why: "材质安全是母婴买家第一顾虑。", source: "practitioner" },
    { id: "baby-q5", question: "What are the exact dimensions?", answerHints: ["dimensions", "unit", "item_dimensions"], why: "尺寸决定能否放进婴儿床或推车。", source: "practitioner" },
    { id: "baby-q6", question: "Does it need batteries and are they included?", answerHints: ["batteries_required", "batteries_included", "num_batteries"], why: "电池信息缺失会导致买回家不能用。", source: "practitioner" },
    { id: "baby-q7", question: "How do I install or assemble it?", answerHints: ["assembly", "included_components", "safety_warning"], why: "安装不当会带来安全风险，说明必须清晰。", source: "practitioner" },
    { id: "baby-q8", question: "What safety certifications does it have?", answerHints: ["safety_warning", "certifications"], why: "合规认证是母婴品类的信任凭据。", source: "practitioner" },
    { id: "baby-q9", question: "Can it be used from birth?", answerHints: ["age_range", "safety_warning"], why: "从出生即可用是新生儿家长的强需求。", source: "practitioner" },
    { id: "baby-q10", question: "Is the fabric breathable and gentle on skin?", answerHints: ["material", "fabric_type", "care_instructions"], why: "面料透气性关系到婴儿皮肤健康。", source: "practitioner" },
  ],

  office: [
    { id: "office-q1", question: "Does it fit standard 8.5 x 11 inch paper?", answerHints: ["dimensions", "compatibility", "unit", "item_dimensions", "compatible_devices"], why: "纸张规格适配是办公用品的基本要求。", source: "practitioner" },
    { id: "office-q2", question: "Is it compatible with both Windows and Mac?", answerHints: ["compatibility", "os_support", "connectivity_type"], why: "跨系统兼容决定能否直接用。", source: "practitioner" },
    { id: "office-q3", question: "How long is the cable or cord?", answerHints: ["dimensions", "unit", "included_components"], why: "线长不足会限制摆放位置。", source: "practitioner" },
    { id: "office-q4", question: "Does it need batteries or a power outlet?", answerHints: ["power_source", "batteries_required"], why: "供电方式决定使用与摆放自由度。", source: "practitioner" },
    { id: "office-q5", question: "How many sheets or items can it hold?", answerHints: ["capacity", "number_of_items", "unit"], why: "容量决定是否满足日常办公量。", source: "practitioner" },
    { id: "office-q6", question: "Is it refillable with standard supplies?", answerHints: ["compatibility", "included_components"], why: "耗材是否通用关系到长期成本。", source: "practitioner" },
    { id: "office-q7", question: "What is the warranty period?", answerHints: ["warranty_description"], why: "办公设备售后承诺影响企业采购决策。", source: "practitioner" },
    { id: "office-q8", question: "Can it be mounted on a wall or does it need a desk?", answerHints: ["mounting_type", "included_components", "dimensions"], why: "安装方式决定适配的办公空间。", source: "practitioner" },
    { id: "office-q9", question: "Is it waterproof or spill resistant?", answerHints: ["material", "special_features"], why: "防泼溅能力关系到耐用度。", source: "practitioner" },
    { id: "office-q10", question: "What colors or sizes does it come in?", answerHints: ["color", "size"], why: "颜色与规格选项影响团队统一采购。", source: "practitioner" },
  ],
};

/* ─────────────────────── ③ 跨字段事实一致性与单位制一致性 ─────────────────────── */

/**
 * UNIT_GROUPS —— 同族不同单位，用于检查「同一事实不许出现两种单位制」。
 *   例：标题写 32 fl oz，A+ 里写 1 liter，即同一事实用了两套单位，应报。
 *   （注：写作 32 fl oz 而非 32 oz —— oz 属重量族、liter 属体积族，同一事实必须是同一族才成立。）
 * 字段：
 *   id       —— 族标识
 *   label    —— 中文说明
 *   imperial —— 英制单位（同一族内的英制写法）
 *   metric   —— 公制单位（同一族内的公制写法）
 *   units    —— 全部写法（imperial + metric 的合集，便于直接做词表匹配）
 *   source   —— 一律 practitioner：单位制一致性是可机械判定的从业者规则，
 *               不是亚马逊官方明文（官方只要求填写单位，未要求跨字段统一）。
 */
export const UNIT_GROUPS = [
  {
    id: "weight",
    label: "重量",
    imperial: ["oz", "ounce", "ounces", "lb", "lbs", "pound", "pounds"],
    metric: ["g", "gram", "grams", "kg", "kilogram", "kilograms", "mg", "milligram", "milligrams"],
    units: ["oz", "ounce", "ounces", "lb", "lbs", "pound", "pounds", "g", "gram", "grams", "kg", "kilogram", "kilograms", "mg", "milligram", "milligrams"],
    source: "practitioner",
  },
  {
    id: "length",
    label: "长度 / 尺寸",
    imperial: ["in", "inch", "inches", "ft", "foot", "feet", "yd", "yard", "yards"],
    metric: ["mm", "millimeter", "millimeters", "cm", "centimeter", "centimeters", "m", "meter", "meters"],
    units: ["in", "inch", "inches", "ft", "foot", "feet", "yd", "yard", "yards", "mm", "millimeter", "millimeters", "cm", "centimeter", "centimeters", "m", "meter", "meters"],
    source: "practitioner",
  },
  {
    id: "volume",
    label: "体积 / 容积",
    imperial: ["fl oz", "fluid ounce", "fluid ounces", "gal", "gallon", "gallons", "qt", "quart", "quarts", "cup", "cups", "pt", "pint", "pints"],
    metric: ["ml", "milliliter", "milliliters", "l", "liter", "liters", "cl", "centiliter", "centiliters"],
    units: ["fl oz", "fluid ounce", "fluid ounces", "gal", "gallon", "gallons", "qt", "quart", "quarts", "cup", "cups", "pt", "pint", "pints", "ml", "milliliter", "milliliters", "l", "liter", "liters", "cl", "centiliter", "centiliters"],
    source: "practitioner",
  },
  {
    id: "temperature",
    label: "温度",
    imperial: ["f", "fahrenheit", "deg f", "degree fahrenheit", "degrees fahrenheit"],
    metric: ["c", "celsius", "deg c", "degree celsius", "degrees celsius", "centigrade"],
    units: ["f", "fahrenheit", "deg f", "degree fahrenheit", "degrees fahrenheit", "c", "celsius", "deg c", "degree celsius", "degrees celsius", "centigrade"],
    source: "practitioner",
  },
  {
    id: "power",
    label: "功率",
    imperial: ["w", "watt", "watts"],
    metric: ["kw", "kilowatt", "kilowatts"],
    units: ["w", "watt", "watts", "kw", "kilowatt", "kilowatts"],
    source: "practitioner",
  },
  {
    id: "battery_capacity",
    label: "电池容量",
    imperial: ["mah", "ah"],
    metric: ["wh", "kwh"],
    units: ["mah", "ah", "wh", "kwh"],
    source: "practitioner",
  },
];

/**
 * MATERIAL_CONFLICTS —— 互斥的材质 / 成分词对，用于跨字段事实一致性检查。
 *   例：同一 listing 里 title 说 100% Cotton、description 说 Polyester blend，即冲突。
 *
 * 防误伤（务必遵守，否则会大面积误报）：
 *   混纺（blend）不是冲突。cotton blend / cotton-poly / 65% cotton 35% polyester
 *   都是合法表述。判断前必须先看上下文里是否出现 guards 里的「混纺标记」，
 *   命中标记则整对跳过，不报冲突。
 *
 * guards 词表纪律（务必遵守）：guards 只放「材质／成分语境词」。通用连接词与纯符号一律不作 guard
 *   （stoplist = and / or / with / & / + / % / / / ,）—— 它们在任何文案里都出现，
 *   当 guard 会把真冲突一起静默压掉（例："faux leather and genuine leather" 会因 and 被放过，
 *   而它必须报）。每对的 guards 清完后不得为空，否则该对永远不抑制、可能过报。
 *
 * guards 对齐纪律（务必遵守，防止「同一事实两份口径」）：
 *   同一类语境事实在所有词对上必须写成同一份，禁止「这对有 lining、那对没有」。
 *   因此 15 对的 guards 统一 = 通用部件词 ∪ 通用混纺词 ∪ 该对材质特定词，三段顺序一致：
 *     · 通用部件词（15 对全量）：lining lid base frame legs handle trim coating coated insert
 *       sole strap buckle panel cover grip rim shell filling padding cushion sleeve hood collar
 *     · 通用混纺词（15 对全量）：blend mixed mix combination compound weave woven knit knitted
 *     · 该对特定词（各对保留，如 poly-cotton / synthetic down / alloy 等）
 *   目的：让「主体 + 部件」复合商品（例：Ceramic Flower Vase 主体陶瓷 + Plastic Base 塑料底座）
 *   和混纺表述一样被正确放行，不再因词表在 pair 之间不齐而误报。
 *   故意不收：top / bottom —— 会命中「top quality cotton」这类质量形容，属误伤，故排除。
 *
 * 字段：
 *   a       —— 词对一侧（小写）
 *   b       —— 词对另一侧（小写）
 *   note    —— 中文说明
 *   guards  —— 命中任一项即判为「非冲突」（如混纺、复合材质），此时跳过该词对
 *   source  —— 一律 practitioner
 */
export const MATERIAL_CONFLICTS = [
  {
    a: "cotton",
    b: "polyester",
    note: "纯棉与涤纶互斥",
    guards: [
      // 通用部件词
      "lining", "lid", "base", "frame", "legs", "handle", "trim", "coating",
      "coated", "insert", "sole", "strap", "buckle", "panel", "cover", "grip",
      "rim", "shell", "filling", "padding", "cushion", "sleeve", "hood", "collar",
      // 通用混纺词
      "blend", "mixed", "mix", "combination", "compound", "weave", "woven", "knit", "knitted",
      // 本对特定词
      "poly-cotton", "cotton-poly", "cotton blend", "polyester blend",
    ],
    source: "practitioner",
  },
  {
    a: "leather",
    b: "faux leather",
    note: "真皮与人造革互斥",
    guards: [
      // 通用部件词
      "lining", "lid", "base", "frame", "legs", "handle", "trim", "coating",
      "coated", "insert", "sole", "strap", "buckle", "panel", "cover", "grip",
      "rim", "shell", "filling", "padding", "cushion", "sleeve", "hood", "collar",
      // 通用混纺词
      "blend", "mixed", "mix", "combination", "compound", "weave", "woven", "knit", "knitted",
    ],
    source: "practitioner",
  },
  {
    a: "leather",
    b: "vegan leather",
    note: "真皮与素皮互斥",
    guards: [
      // 通用部件词
      "lining", "lid", "base", "frame", "legs", "handle", "trim", "coating",
      "coated", "insert", "sole", "strap", "buckle", "panel", "cover", "grip",
      "rim", "shell", "filling", "padding", "cushion", "sleeve", "hood", "collar",
      // 通用混纺词
      "blend", "mixed", "mix", "combination", "compound", "weave", "woven", "knit", "knitted",
    ],
    source: "practitioner",
  },
  {
    a: "stainless steel",
    b: "plastic",
    note: "不锈钢与塑料互斥（主体材质不能两说）",
    guards: [
      // 通用部件词
      "lining", "lid", "base", "frame", "legs", "handle", "trim", "coating",
      "coated", "insert", "sole", "strap", "buckle", "panel", "cover", "grip",
      "rim", "shell", "filling", "padding", "cushion", "sleeve", "hood", "collar",
      // 通用混纺词
      "blend", "mixed", "mix", "combination", "compound", "weave", "woven", "knit", "knitted",
    ],
    source: "practitioner",
  },
  {
    a: "down",
    b: "polyester",
    note: "羽绒与聚酯纤维填充互斥",
    guards: [
      // 通用部件词
      "lining", "lid", "base", "frame", "legs", "handle", "trim", "coating",
      "coated", "insert", "sole", "strap", "buckle", "panel", "cover", "grip",
      "rim", "shell", "filling", "padding", "cushion", "sleeve", "hood", "collar",
      // 通用混纺词
      "blend", "mixed", "mix", "combination", "compound", "weave", "woven", "knit", "knitted",
      // 本对特定词（只放"离开本对就无意义"的复合词；裸 alternatives 属通用营销词，已按 SPEC v1.0.5 §8 第 13 条删除）
      "synthetic down", "down alternative",
    ],
    source: "practitioner",
  },
  {
    a: "wool",
    b: "acrylic",
    note: "羊毛与腈纶互斥",
    guards: [
      // 通用部件词
      "lining", "lid", "base", "frame", "legs", "handle", "trim", "coating",
      "coated", "insert", "sole", "strap", "buckle", "panel", "cover", "grip",
      "rim", "shell", "filling", "padding", "cushion", "sleeve", "hood", "collar",
      // 通用混纺词
      "blend", "mixed", "mix", "combination", "compound", "weave", "woven", "knit", "knitted",
    ],
    source: "practitioner",
  },
  {
    a: "silicone",
    b: "latex",
    note: "硅胶与乳胶互斥",
    guards: [
      // 通用部件词
      "lining", "lid", "base", "frame", "legs", "handle", "trim", "coating",
      "coated", "insert", "sole", "strap", "buckle", "panel", "cover", "grip",
      "rim", "shell", "filling", "padding", "cushion", "sleeve", "hood", "collar",
      // 通用混纺词
      "blend", "mixed", "mix", "combination", "compound", "weave", "woven", "knit", "knitted",
    ],
    source: "practitioner",
  },
  {
    a: "genuine leather",
    b: "synthetic",
    note: "真皮与合成材质互斥",
    guards: [
      // 通用部件词
      "lining", "lid", "base", "frame", "legs", "handle", "trim", "coating",
      "coated", "insert", "sole", "strap", "buckle", "panel", "cover", "grip",
      "rim", "shell", "filling", "padding", "cushion", "sleeve", "hood", "collar",
      // 通用混纺词
      "blend", "mixed", "mix", "combination", "compound", "weave", "woven", "knit", "knitted",
    ],
    source: "practitioner",
  },
  {
    a: "glass",
    b: "acrylic",
    note: "玻璃与亚克力互斥",
    guards: [
      // 通用部件词
      "lining", "lid", "base", "frame", "legs", "handle", "trim", "coating",
      "coated", "insert", "sole", "strap", "buckle", "panel", "cover", "grip",
      "rim", "shell", "filling", "padding", "cushion", "sleeve", "hood", "collar",
      // 通用混纺词
      "blend", "mixed", "mix", "combination", "compound", "weave", "woven", "knit", "knitted",
    ],
    source: "practitioner",
  },
  {
    a: "wood",
    b: "metal",
    note: "木质与金属互斥（主体材质不能两说）",
    guards: [
      // 通用部件词
      "lining", "lid", "base", "frame", "legs", "handle", "trim", "coating",
      "coated", "insert", "sole", "strap", "buckle", "panel", "cover", "grip",
      "rim", "shell", "filling", "padding", "cushion", "sleeve", "hood", "collar",
      // 通用混纺词
      "blend", "mixed", "mix", "combination", "compound", "weave", "woven", "knit", "knitted",
    ],
    source: "practitioner",
  },
  {
    a: "ceramic",
    b: "plastic",
    note: "陶瓷与塑料互斥",
    guards: [
      // 通用部件词
      "lining", "lid", "base", "frame", "legs", "handle", "trim", "coating",
      "coated", "insert", "sole", "strap", "buckle", "panel", "cover", "grip",
      "rim", "shell", "filling", "padding", "cushion", "sleeve", "hood", "collar",
      // 通用混纺词
      "blend", "mixed", "mix", "combination", "compound", "weave", "woven", "knit", "knitted",
    ],
    source: "practitioner",
  },
  {
    a: "aluminum",
    b: "carbon steel",
    note: "铝与碳钢互斥",
    guards: [
      // 通用部件词
      "lining", "lid", "base", "frame", "legs", "handle", "trim", "coating",
      "coated", "insert", "sole", "strap", "buckle", "panel", "cover", "grip",
      "rim", "shell", "filling", "padding", "cushion", "sleeve", "hood", "collar",
      // 通用混纺词
      "blend", "mixed", "mix", "combination", "compound", "weave", "woven", "knit", "knitted",
      // 本对特定词
      "alloy",
    ],
    source: "practitioner",
  },
  {
    a: "suede",
    b: "faux suede",
    note: "麂皮与人造麂皮互斥",
    guards: [
      // 通用部件词
      "lining", "lid", "base", "frame", "legs", "handle", "trim", "coating",
      "coated", "insert", "sole", "strap", "buckle", "panel", "cover", "grip",
      "rim", "shell", "filling", "padding", "cushion", "sleeve", "hood", "collar",
      // 通用混纺词
      "blend", "mixed", "mix", "combination", "compound", "weave", "woven", "knit", "knitted",
    ],
    source: "practitioner",
  },
  {
    a: "sheepskin",
    b: "faux fur",
    note: "羊皮与仿毛互斥",
    guards: [
      // 通用部件词
      "lining", "lid", "base", "frame", "legs", "handle", "trim", "coating",
      "coated", "insert", "sole", "strap", "buckle", "panel", "cover", "grip",
      "rim", "shell", "filling", "padding", "cushion", "sleeve", "hood", "collar",
      // 通用混纺词
      "blend", "mixed", "mix", "combination", "compound", "weave", "woven", "knit", "knitted",
    ],
    source: "practitioner",
  },
  {
    a: "organic cotton",
    b: "regular cotton",
    note: "有机棉与普通棉互斥（同一字段不能两说）",
    guards: [
      // 通用部件词
      "lining", "lid", "base", "frame", "legs", "handle", "trim", "coating",
      "coated", "insert", "sole", "strap", "buckle", "panel", "cover", "grip",
      "rim", "shell", "filling", "padding", "cushion", "sleeve", "hood", "collar",
      // 通用混纺词
      "blend", "mixed", "mix", "combination", "compound", "weave", "woven", "knit", "knitted",
    ],
    source: "practitioner",
  },
];

/**
 * NUMBER_UNIT_RE —— 从文本里提取「数值 + 单位」的规则。
 *
 * 为了让本表也能携带 source 字段（RegExp 的 source 属性是只读内建属性，无法写入），
 * 这里导出为「描述对象」而不是裸 RegExp：
 *   · regex   —— 现成可用的 RegExp 实例（g + i）
 *   · pattern —— 正则主体字符串，可 new RegExp(NUMBER_UNIT_RE.pattern, NUMBER_UNIT_RE.flags) 重建
 *   · flags   —— 正则标志
 *   · unit    —— 单位子模式，与 pattern 的第 3 捕获组为同一字符串（同源，不含外层括号）
 *   · source  —— 一律 practitioner
 *
 * 捕获组：
 *   1 —— 第一个数值（整数或小数）
 *   2 —— 区间上界数值（如 "10-12 inches" 里的 12），无则为 undefined
 *   3 —— 单位文本
 */
const UNIT_ALT =
  "fl\\s?oz|fluid\\s?ounces?|degrees?\\s*fahrenheit|degrees?\\s*celsius|milliliters?|centiliters?|millimeters?|centimeters?|kilograms?|milligrams?|kilowatts?|fahrenheit|celsius|milliliter|centiliter|millimeter|centimeter|kilogram|milligram|kilowatt|gallons?|quarts?|pints?|ounces?|pounds?|liters?|meters?|yards?|inch(?:es)?|watts?|hours?|minutes?|seconds?|sheets?|pieces?|counts?|packs?|mah|kwh|wh|°\\s?[fc]|deg(?:rees?)?\\s?[fc]|oz|lb|lbs|kg|mg|ml|cl|gal|qt|pt|cm|mm|ft|yd|hrs|in|g|l|m|w|v|ct|pcs";

// 单一真源：单位子模式只写一次（上面的 UNIT_ALT），
// pattern 的第 3 捕获组与导出的 .unit 都由它拼出，二者永远同源、不会漂移。
const NUMBER_UNIT_PATTERN =
  "\\b(\\d+(?:[.,]\\d+)?)\\s*(?:-|to|~)?\\s*(\\d+(?:[.,]\\d+)?)?\\s*(" + UNIT_ALT + ")\\b";

export const NUMBER_UNIT_RE = {
  regex: new RegExp(NUMBER_UNIT_PATTERN, "gi"),
  pattern: NUMBER_UNIT_PATTERN,
  flags: "gi",
  unit: UNIT_ALT,
  note: "提取形如 32 oz / 1.5 kg / 10-12 inches 的数值与单位。.unit 即 pattern 第 3 捕获组的内部子模式（同源，不含外层括号）。",
  source: "practitioner",
};
