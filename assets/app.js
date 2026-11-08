/**
 * 应用外壳：视图路由 + 聊天消息流 + 四个工作模块。
 *
 * 消息分发逻辑刻意对齐参考项目 ecom-details-image-ui 的 dispatch()：
 *   ai_response 追加到上一条助手气泡（流式拼接）
 *   tool_call   推一条"工具运行中"气泡
 *   tool_result 找到同名运行中的工具气泡，标记完成并追加明细
 *   file_output 推一条图片卡片
 *   usage       附到上一条助手消息
 *   error_message 推一条红色错误条
 * 这样两条路径（服务端 / 本机）渲染出来完全一样。
 */

import { renderInto, escapeHtml } from "./md.js";
import * as P from "./prompt-engine.js";
import * as L from "./listing.js";
import * as A from "./amazon.js";
import * as STORE from "./store.js";
import {
  getConfig, setConfig, DEFAULT_CONFIG, probeServer, clearProbeCache,
  uploadImage, downloadText, downloadJSON, apiUrl,
} from "./api.js";
import { runTurn, runImg2ImgTurn, generateOne, isGenerateIntent, isNegative, runLocalTurn, packPayload } from "./orchestrator.js";
// 2026-11 P2：A+ 骨架 / 批量质检 / 竞品 CSV 导入。
// 三块都写成**纯函数模块**（不碰 document），理由和评分、评论分析一样：
// 只有在 Node 里能 import 直接跑，自检才可能断言到细节，而不是"点一下没报错"。
import { buildAplusPlan, aplusToText, APLUS_NOTE } from "./aplus.js";
import { batchLint, batchCsv, BATCH_MAX } from "./batch-lint.js";
import { importKeywordCsv, keywordList, withVolumes } from "./csv-import.js";
// ⑥ 准入层检查：规则引擎（冻结契约）＋ 类目键/中文名（数据层，只读用来生成下拉，
// 不在这里硬编码第二份类目表）。判定口径与 ⑤ 的「引用层」质检不同，见 renderRufus 注释。
import { lintRufus, RUFUS_GROUPS, RUFUS_NAMING } from "./rufus.js";
import { CATEGORY_ATTRIBUTES } from "./rufus-data.js";
// ⑦ 竞品关键词 → 文案提示词。
// 分工写死：**抓取**走服务端（浏览器直连亚马逊会被 CORS 拦，且主机白名单在服务端）；
// **权重计算**纯本地（competitor-keywords.js）；**提示词拼装**纯本地（copy-prompts.js）。
// 所以断网时这一卡只剩"抓取不可用"，算法与拼装照样能跑 —— 不静默降级成假数据。
import * as CK from "./competitor-keywords.js";
import * as CP from "./copy-prompts.js";
// 原生 <select> 的下拉是 OS 窗口、位置不受页面控制（本页实测会画到侧栏上方）。
// 这个模块把"点开的那一层"换成自己画的，但**保留原生 select 作为取值仓库**。
import { enhanceSelects } from "./select-ui.js";
// 健康分：把 26 条规则 + 5 组信息架构 + 覆盖度收成一个数。
// 🔴 纯函数、权重单源（assets/score.js），界面只负责画，不再自己算一套比例。
import { scoreListing, SCORE_DISCLAIMER } from "./score.js";
// 评论（VOC）分析：词表聚类 + 高频疑问 + 词频线索。不联网、不推断原因。
import { analyzeReviews, reviewsFromPayload, REVIEW_MAX } from "./reviews.js";
// 成图体检：Canvas 读像素，判背景/占比/边长/格式。图片不上传。
import { auditImageBlob } from "./image-audit.js";
// 历史快照的迷你趋势图：自己拼 path，不引图表库。
import { sparklinePath, seriesDigest, seriesOf } from "./snapshots.js";

/* ─────────────────────── 图标注册表（唯一实现）───────────────────────
 * 项目规则：UI 里**不许用 emoji 当功能图标**。图标必须是统一描边、可矢量缩放的
 * inline SVG —— 本文件零依赖，所以不引图标库 / CDN / 字体图标，图形手写内联。
 *
 * 为什么是"图形"而不是"整段 svg"：
 *   同一个图标会在两个尺寸下出现（导航/按钮 20px、行内状态位 16px）。如果表里存整段
 *   `<svg …>`，尺寸就被焊死在里面，第二个尺寸只能再抄一份路径 —— 那就是"同一事实两处实现"。
 *   所以这里只存**图形本身**（path/rect/circle），包装属性由 iconSvg() 统一生成：
 *   一处描边规格、任意尺寸复用。
 *
 * 唯一例外：index.html 侧栏导航那 7 个图标直接内联在静态 HTML 里（静态页面拿不到本文件的
 * 常量），因此不在下表内。除它们之外，全项目所有图标都必须从这里取，不许在别处再写一遍。
 */
export const ICONS = {
  // 工具气泡抬头：扳手（表示"某一步工具正在跑"）
  wrench:
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  // 上传参考图：回形针
  paperclip:
    '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  // 抓取亚马逊商品：书签（它就是"书签脚本"）
  bookmark: '<path d="M18.5 3.5h-13a1 1 0 0 0-1 1v16.5l7.5-4.8 7.5 4.8V4.5a1 1 0 0 0-1-1z"/>',
  // 质检命中硬规则：必须改
  "x-circle":
    '<circle cx="12" cy="12" r="9.5"/><path d="m9.2 9.2 5.6 5.6"/><path d="m14.8 9.2-5.6 5.6"/>',
  // 质检命中软规则：建议改（必须改与建议改严格程度不同 → 不共用一张图）
  "alert-triangle":
    '<path d="M21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z"/><path d="M12 9v4.2"/><path d="M12 17h.01"/>',
  /* ── 本地产物四类。store.js 只存图标 id（如 "download"），图形在这里写一遍 ── */
  download:
    '<path d="M20.5 15v4.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5V15"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M12 15V3.5"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="8.7" cy="8.7" r="1.8"/><path d="M21 16l-4.2-4.2a1.8 1.8 0 0 0-2.54 0L6.5 21"/>',
  "file-text":
    '<path d="M14 2.5H7A1.5 1.5 0 0 0 5.5 4v16A1.5 1.5 0 0 0 7 21.5h10a1.5 1.5 0 0 0 1.5-1.5V7z"/><path d="M14 2.5V7h4.5"/><path d="M9 12.5h6"/><path d="M9 16.5h4"/>',
  target:
    '<circle cx="12" cy="12" r="9.5"/><circle cx="12" cy="12" r="5.6"/><circle cx="12" cy="12" r="1.7"/>',
  /* 下拉替身（select-ui.js）的指示箭头。原生 select 自己会画一个，但那个只在原生控件里；
     我们把它盖住之后必须自己画，否则看起来就是个输入框。 */
  "chevron-down": '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
  // 本周词库：清单（三条横线 + 三个点）。
  // 🔴 导航栏里那份是内联的（index.html 拿不到这里的常量），两边必须逐位一致 —— selftest C 守着。
  list: '<path d="M9.5 7h11"/><path d="M9.5 12h11"/><path d="M9.5 17h11"/><circle cx="4.6" cy="7" r="1"/><circle cx="4.6" cy="12" r="1"/><circle cx="4.6" cy="17" r="1"/>',
};

/**
 * 唯一构造函数：把上表的图形包成规格统一的 inline SVG。
 * 规格：viewBox 24 / fill none / stroke currentColor / 描边 1.75 / 圆头圆角 / aria-hidden。
 * 尺寸只有三档：导航与按钮内 20、行内状态位 16、独立图标 24（默认 20）。
 * 颜色一律 currentColor → 跟随所在容器，不写死色值。
 * `name` 不认识时返回空串而**不抛错**：图标缺失不该让整块渲染挂掉。
 */
export function iconSvg(name, size = 20) {
  const body = ICONS[name];
  if (!body) return "";
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:middle">${body}</svg>`;
}

/* ─────────────────────── 全局状态 ─────────────────────── */

const S = {
  view: "chat",
  messages: [],
  input: "",
  thinking: false,
  attachment: null,
  uploading: false,
  abort: null,
  probe: { online: false, capabilities: {} },
  /** 模板库里"正在浏览"的那个模板（只影响详情展示，**不影响生成**） */
  selectedTemplate: "hero-image",
  /**
   * 用户显式固定要用的模板 id。**默认 null ＝ 自动匹配**。
   * 🔴 刻意做成"只作用于下一条消息"（send 里读完即清）：
   *    如果做成粘性状态，用户点过一次模板库之后，后面所有对话都会静默违背自动匹配，
   *    而他早就忘了自己点过 —— 那正好和"简化操作"相反。
   */
  explicitTemplateId: null,
  lastTurn: null,
  /** 最近一次覆盖度分析结果（体检报告要用；不持久化） */
  coverage: null,
  /** 最近一次健康分结果（不持久化：它必须跟当前文案同步，存下来就是过期结论） */
  lastScore: null,
  /** 最近一次评论分析结果（采样 ≤20 条） */
  lastVoc: null,
  /** 最近一次导入的第三方词表（含搜索量与来源名；刷新即失效，不落盘） */
  csvImport: null,
  /** 最近一次生成的 A+ 骨架 */
  aplusPlan: null,
  /** 最近一次批量质检结果 */
  batch: null,
  /** 当前 ASIN 的历史快照行（服务端 JSONL 读回来的） */
  snapRows: [],
  /** 整套逐张出图是否正在进行（防重复点击开两轮） */
  packRunning: false,
  /**
   * 历史面板里勾选做快照对比的记录 id，**最多两条**（多的挤掉最早的）。
   * 刻意不做持久化：它只服务于「刚抓完想立刻比一下」这一下，存下来反而会在
   * 下次打开时对着两条早就忘掉的记录显示一张差异表。
   */
  diffSel: [],
  // 🔴 highlights 是 2026-07-27 标题新规带出来的字段（后台显示名 Item Highlights，
  //    API 属性名 title_differentiation）。它和 title 是一对：标题 ≤75 才有资格提交它。
  listing: { title: "", highlights: "", bullets: [], searchTerms: "" },
  product: null,
  /** 采集到的搜索结果页（整页商品）—— 送给多竞品对比用 */
  search: null,
  lastMined: null,
  /** 本周词库上一次读到的响应（「送进文案页」要复用这批词，不重复请求） */
  words: null,
  wordsSort: "roots",
  /** 上一次生成草稿前的字段快照（撤销用）。只在本次会话内有效。 */
  draftUndo: null,
  /** 最近一次生成的草稿对象（撤销后重渲染面板要用） */
  lastDraft: null,
  /** 等待用户三选一的草稿：{draft, after} */
  draftPending: null,
  /** 图片库总字节数的展示文本（服务端给的，不在前端重算） */
  libBytesText: "0 B",
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

/* ───────────────── 两个交互原语：轻提示 / 确认框 ─────────────────
 * 为什么全项目不再用原生 alert / confirm：
 *   ① 阻塞主线程 —— 弹窗期间页面停止渲染，正在跑的串行出图也一起停在那儿；
 *   ② 样式不可控：不能换行排版、不能区分危险操作、塞不下第三个选项；
 *   ③ 不可测：无头浏览器里必须额外挂 dialog 事件处理器，否则脚本直接卡死。
 * 所以**只有这一份实现**，调用方一律 await / 直接调用，不再出现原生弹窗。
 */

let toastTimer = null;
/**
 * 轻提示：右下角浮一条，自动消失。用于「本来就没有数据」「已清空」这类
 * **不需要用户决策**的回执 —— 需要决策的一律走 uiConfirm。
 * @param {string} msg 正文（纯文本，不解析 HTML）
 * @param {"ok"|"bad"|"warn"} tone 颜色语义
 */
function uiToast(msg, tone = "ok", ms = 2800) {
  let el = document.getElementById("uiToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "uiToast";
    el.className = "ui-toast";
    // status + polite：读屏软件会念出来，但不打断用户当前的操作
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  el.className = `ui-toast ${tone}`;
  el.textContent = String(msg);
  void el.offsetWidth;      // 强制重排，让同一条消息连续出现时动画能重播
  el.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("on"), ms);
}

/**
 * 确认框：返回 Promise<boolean>。Esc / 点背景 / 取消 → false。
 * @param {{title?:string, body?:string, okText?:string, cancelText?:string, danger?:boolean}} o
 */
function uiConfirm(o = {}) {
  const { title = "确认", body = "", okText = "确定", cancelText = "取消", danger = false } = o;
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "ui-dlg-back";
    back.innerHTML = `
      <div class="ui-dlg" role="dialog" aria-modal="true" aria-labelledby="uiDlgTitle">
        <h3 id="uiDlgTitle"></h3>
        <p class="ui-dlg-body"></p>
        <div class="rowline ui-dlg-act">
          <button class="btn ghost sm" data-x="cancel"></button>
          <button class="btn sm ${danger ? "danger" : "primary"}" data-x="ok"></button>
        </div>
      </div>`;
    // 一律 textContent：body 里会出现文件名、词面等**第三方可控文本**，
    // 拼进 innerHTML 就是给自己开一个 XSS 口子。
    back.querySelector("h3").textContent = title;
    back.querySelector(".ui-dlg-body").textContent = body;
    const btnCancel = back.querySelector('[data-x="cancel"]');
    const btnOk = back.querySelector('[data-x="ok"]');
    btnCancel.textContent = cancelText;
    btnOk.textContent = okText;

    const prevFocus = document.activeElement;
    const close = (val) => {
      document.removeEventListener("keydown", onKey, true);
      back.remove();
      if (prevFocus && typeof prevFocus.focus === "function") prevFocus.focus();
      resolve(val);
    };
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); close(false); }
      // Tab 在取消/确定之间循环：不然焦点会跑到底下被遮住的页面上
      if (e.key === "Tab") {
        e.preventDefault();
        (document.activeElement === btnOk ? btnCancel : btnOk).focus();
      }
    }
    back.addEventListener("mousedown", (e) => { if (e.target === back) close(false); });
    btnCancel.addEventListener("click", () => close(false));
    btnOk.addEventListener("click", () => close(true));
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(back);
    btnOk.focus();
  });
}

/* ─────────────────────── 初始化 ─────────────────────── */

async function boot() {
  bindNav();
  bindFieldTabs();
  bindMore();
  bindComposer();
  bindTemplates();
  bindListing();
  bindCompetitor();
  bindCapture();
  bindLibrary();
  bindVault();
  bindWords();
  bindSettings();
  bindExternal();
  renderTemplateGrid();
  renderListingLimits();
  pushWelcome();
  renderMessages();
  S.probe = await probeServer({ force: true });
  renderStatus();
  renderRembgStatus();
  extRenderStatus();   // 只读与否要等 probe 回来才知道，所以这里再刷一次那张卡
  // 按 URL 落到对应视图（分享链接 / F5 / 后退键都靠这一步）。
  // 没有 hash 或 hash 不认识时，带 fromHash 走一次 = 不写 URL，停在 HTML 里默认的那一页。
  const wantedView = location.hash.replace(/^#/, "");
  if (VIEW_NAMES.has(wantedView)) goView(wantedView, { fromHash: true });
  syncSettingsForm();
  reflectConfigIntoUI();
  // 🔴 必须放在最后：先把所有下拉的选项与初始值填完，再接管它们的"点开"行为，
  //    这样按钮上第一次显示的就是真实选中项（不是空框）。
  //    之后选项再被程序改写（如 loadCompetitorCategories）由模块内的 MutationObserver 跟上。
  enhanceSelects({ icon: iconSvg("chevron-down", 15) });
}

/**
 * 能不能真出图：本地填了 key，**或**服务端已配（重启服务后 .env 里的那份）。
 * 🔴 唯一判据，别在多处各写一份 —— 曾经只有"右上角标签"那一处漏写、
 *    变成只看"服务端在线"，于是没配 key 的用户看到「可出图」却点了没反应。
 */
function canGenerateImage() {
  // 🔴 只读演示模式（线上分享）永远不出图：服务端已经 403 了，界面也必须先说"不可用"，
  //    否则用户点下去只等到一条失败提示 —— 前端和后端对"能不能做"要有同一个答案。
  if (S.probe?.capabilities?.readonly) return false;
  return Boolean(getConfig().imageApiKey?.trim()) || S.probe?.capabilities?.imageKeyConfigured === true;
}

function renderStatus() {
  const el = $("#status");
  if (!el) return;
  const on = S.probe.online;
  const imgKey = canGenerateImage();
  el.innerHTML = `
    <div><span class="dot ${on ? "on" : "off"}"></span>${on ? "本地服务在线" : "本地服务未连接"}</div>
    <div style="margin-top:5px;color:var(--slate-400)">${on ? escapeHtml(S.probe.version || "") : "模板库 / Prompt 引擎 / Listing 质检在本机跑，不需要服务"}</div>
    <div style="margin-top:5px;color:var(--slate-400)">图片 API：${S.probe.capabilities?.readonly ? "线上演示只读" : imgKey ? "已配置" : "未配置"}</div>`;
}

function reflectConfigIntoUI() {
  const t = $("#chatModeTag");
  if (!t) return;
  // 判据必须与 renderStatus / 出图前检查一致：服务端在线 ≠ 能出图
  t.textContent = !S.probe.online
    ? "本机编排 · 仅出 Prompt"
    : S.probe.capabilities?.readonly
      ? "线上演示 · 只读（仅出 Prompt）"
      : canGenerateImage()
        ? "服务端编排 · 可出图"
        : "服务端编排 · 未配图片 Key（仅出 Prompt）";
}

/* ─────────────────────── 导航 ─────────────────────── */

/**
 * 视图名集合：以 DOM 里的 `.view[data-view]` 为准，不在这里抄第二份清单。
 * 多抄一份就会出现「hash 里写了 views 但页面没有」这种只会在 URL 里暴露的错。
 */
const VIEW_NAMES = new Set($$(".view").map((v) => v.dataset.view));

/** 写 hash 会触发 hashchange；用它区分"是我自己写的"和"用户按了后退"。 */
let hashSelfWrite = false;

function bindNav() {
  $$("#nav button").forEach((b) => {
    b.addEventListener("click", () => goView(b.dataset.view));
  });
  // 🔴 没有这一步，链接只能到首页、F5 必回创作台、后退键直接退出应用。
  //    视图是纯内存状态时这三件事同时坏，而它们在截图里一点都看不出来。
  window.addEventListener("hashchange", () => {
    if (hashSelfWrite) { hashSelfWrite = false; return; }
    const name = location.hash.replace(/^#/, "");
    if (!VIEW_NAMES.has(name) || name === S.view) return;
    goView(name, { fromHash: true });
  });
}

/**
 * 切视图。**唯一**入口 —— 站内跳转（如词库页「送进文案页」）也走这里，
 * 否则会出现"视角切了但侧栏高亮没动"这种只看截图看不出来的错位。
 * 懒加载放这里：每个视图只在第一次被打开时取数，别在 boot 里把所有接口都打一遍。
 *
 * @param {string} name 视图名
 * @param {{fromHash?: boolean}} [opts] fromHash=true 表示"这次是 hash 变过来的"，不要再写回 hash
 */
function goView(name, opts = {}) {
  if (!name || !VIEW_NAMES.has(name)) return;
  S.view = name;
  $$("#nav button").forEach((x) => x.classList.toggle("on", x.dataset.view === name));
  $$(".view").forEach((v) => v.classList.toggle("on", v.dataset.view === name));
  if (!opts.fromHash && location.hash.replace(/^#/, "") !== name) {
    hashSelfWrite = true;
    location.hash = name;     // 推一条历史，后退键才能在视图之间走
  }
  if (name === "templates") renderTemplateGrid();
  if (name === "capture") renderBookmarklet();
  if (name === "library") renderLibrary();
  if (name === "vault") renderVault();
  if (name === "words") loadWords();
}

/**
 * 字段 tab：五个文案字段一次只展开一个。
 *
 * 为什么不是折叠面板：折叠会让"有 5 个框"这件事一直挂在页面上，一次只呈现一个才是"当前在改什么"。
 * 代价是看不到全部 —— 所以句长 chip 留在卡片头部，超限时还在对应 tab 上点一个红点（renderFieldCounters 里同步）。
 */
function bindFieldTabs() {
  const bar = $("#fieldTabs");
  if (!bar) return;
  const tabs = $$("button[data-tab]", bar);
  const panels = $$("[data-panel]");
  tabs.forEach((b) =>
    b.addEventListener("click", () => {
      tabs.forEach((x) => x.classList.toggle("on", x === b));
      panels.forEach((p) => {
        p.hidden = p.dataset.panel !== b.dataset.tab;
      });
    })
  );
}

/** 「更多 ▾」：把 6 个次级导出/检查收起来。主操作只留「跑质检」和「导出后台字段」。 */
function bindMore() {
  const btn = $("#btnMore");
  const panel = $("#morePanel");
  if (!btn || !panel) return;
  btn.addEventListener("click", () => {
    const open = panel.hidden;
    panel.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    btn.textContent = open ? "收起 ▴" : "更多 ▾";
  });
}

/* ─────────────────────── 消息模型 ─────────────────────── */
function pushWelcome() {
  S.messages.push({
    id: "welcome", role: "assistant", ts: Date.now(),
    content: [
      "你好，我是 **跨境 Listing 质检工作台**。",
      "",
      "我复刻了 `ecom-details-image` 的整套视觉创作体系（25 个场景模板 + GPT-Image-2 六条铁律 + Campaign Style Lock + 转化驱动力诊断 + 多角度镜头规则 + 详情页信息图结构），并补上了跨境 Listing 侧的文案生成与合规质检。",
      "",
      "试试这些说法：",
      "- 「帮我生成一款蓝色蓝牙耳机的白底主图」",
      "- 「设计一款陶瓷咖啡杯的小红书氛围图，直接出图」",
      "- 「做一整套宠物自动喂食器的 Amazon 详情页」",
      "",
      "> 带「**出图**」两个字才会真的调用图片 API；不带就只输出可执行 Prompt（Brief 模式）。",
      "> 上传参考图会自动切到**图生图**，保留产品本身、只改造场景与风格。",
    ].join("\n"),
  });
}

function msg(partial) {
  const m = { id: uid(), ts: Date.now(), ...partial };
  S.messages.push(m);
  return m;
}

function dispatch(ev) {
  switch (ev.type) {
    case "ai_response": {
      const last = S.messages[S.messages.length - 1];
      if (last && last.role === "assistant" && !last.toolName && !(last.images || []).length) {
        last.content = (last.content || "") + (ev.content || "");
        last.streaming = true;
      } else {
        msg({ role: "assistant", content: ev.content || "", streaming: true });
      }
      break;
    }
    case "tool_call":
      msg({ role: "tool", toolName: ev.name || "tool", toolStatus: "run", toolDetail: "" });
      break;
    case "tool_result": {
      for (let i = S.messages.length - 1; i >= 0; i--) {
        const m = S.messages[i];
        if (m.role === "tool" && m.toolName === ev.name && m.toolStatus === "run") {
          // 服务端标了 level:"warn" 的，是"跑完了但结果不可信"（典型：识图失败 → 退回纯文本生图）。
          // 单独一档，别混进绿色的"成功"里 —— 那会让用户以为图是按他产品生成的。
          m.toolStatus = ev.level === "warn" ? "warn" : "ok";
          m.toolDetail = (m.toolDetail || "") + (ev.content || "");
          break;
        }
      }
      break;
    }
    case "file_output":
      msg({
        role: "assistant", content: "",
        images: [{ url: ev.url, filename: ev.filename, description: ev.description }],
      });
      break;
    case "pack_ready": {
      // 整套计划就绪。**不自动开跑** —— 一次 N 张是真金白银，必须由用户点确认。
      const p = { ...ev.pack, status: "idle", done: 0, failed: [] };
      msg({ role: "pack", pack: p });
      break;
    }
    case "usage": {
      const last = [...S.messages].reverse().find((m) => m.role === "assistant" && !m.toolName);
      if (last) last.usage = { cost: ev.cost, duration_ms: ev.duration_ms, note: ev.note };
      break;
    }
    case "error_message":
      msg({ role: "error", content: ev.content || "未知错误" });
      break;
    default:
      break;
  }
  renderMessages();
}

/* ─────────────────────── 聊天渲染 ─────────────────────── */

function renderMessages() {
  const box = $("#chatInner");
  if (!box) return;
  box.innerHTML = "";
  for (const m of S.messages) box.appendChild(renderOne(m));
  if (S.thinking) {
    const d = document.createElement("div");
    d.className = "row a";
    d.innerHTML = `<div class="thinking"><span class="d"></span><span>正在编排 / 等待图片生成…</span></div>`;
    box.appendChild(d);
  }
  const sc = $("#chatScroll");
  if (sc) sc.scrollTop = sc.scrollHeight;
}

function renderOne(m) {
  if (m.role === "user") {
    const d = document.createElement("div");
    d.className = "row u";
    const inner = document.createElement("div");
    inner.style.display = "flex";
    inner.style.flexDirection = "column";
    inner.style.gap = "7px";
    inner.style.alignItems = "flex-end";
    if (m.attachment) {
      const img = document.createElement("img");
      img.src = m.attachment.url;
      img.alt = m.attachment.filename || "参考图";
      inner.appendChild(img);
    }
    if (m.content) {
      const b = document.createElement("div");
      b.className = "bubble-user";
      b.textContent = m.content;
      inner.appendChild(b);
    }
    d.appendChild(inner);
    return d;
  }

  if (m.role === "tool") {
    const d = document.createElement("div");
    d.className = "row s";
    const b = document.createElement("div");
    const st = m.toolStatus === "run" ? "run" : m.toolStatus === "warn" ? "warn" : m.toolStatus === "fail" ? "fail" : "ok";
    b.className = `bubble-tool${st === "warn" ? " warn" : ""}`;
    // 工具名旁边是工具图标（来自注册表），不是 emoji —— 工具名本身原样保留
    b.innerHTML = `<div class="h"><span class="tdot ${st}"></span>${iconSvg("wrench", 16)}<span>${escapeHtml(m.toolName)}</span></div>`;
    if (m.toolDetail) {
      const p = document.createElement("div");
      p.style.marginTop = "4px";
      p.textContent = m.toolDetail;
      b.appendChild(p);
    }
    d.appendChild(b);
    return d;
  }

  if (m.role === "error") {
    const d = document.createElement("div");
    d.className = "row s";
    const b = document.createElement("div");
    b.className = "bubble-err";
    b.textContent = m.content;
    d.appendChild(b);
    return d;
  }

  if (m.role === "pack") return renderPackCard(m);

  // assistant：可能同时有文字 + 图片 + usage
  const d = document.createElement("div");
  d.className = "row a";
  const wrap = document.createElement("div");
  wrap.style.display = "flex";
  wrap.style.flexDirection = "column";
  wrap.style.gap = "10px";
  wrap.style.maxWidth = "92%";

  if (m.content) {
    const b = document.createElement("div");
    b.className = "bubble-ai";
    renderInto(b, m.content);
    wrap.appendChild(b);
  }
  for (const img of m.images || []) {
    const c = document.createElement("div");
    c.className = "imgcard";
    c.innerHTML = `
      <img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.filename || "")}" loading="lazy">
      <div class="cap">
        <span>${escapeHtml(img.description || "")}</span>
        <a href="${escapeHtml(img.url)}" download="${escapeHtml(img.filename || "image")}">下载</a>
      </div>`;
    wrap.appendChild(c);
  }
  if (m.usage) {
    const u = document.createElement("div");
    u.style.fontSize = "11px";
    u.style.color = "var(--slate-400)";
    u.style.fontFamily = "var(--mono)";
    u.textContent = `cost=$${(m.usage.cost ?? 0).toFixed(4)} · ${((m.usage.duration_ms ?? 0) / 1000).toFixed(1)}s${m.usage.note ? " · " + m.usage.note : ""}`;
    wrap.appendChild(u);
  }
  d.appendChild(wrap);
  return d;
}

/* ─────────────────────── 整套逐张出图 ───────────────────────
 * 规划层一次产出 N 条 Prompt，但出图必须**逐张**发（一次一张，串行）：
 *   · 串行：并发打同一个上游是被封 / 429 的最快方式；
 *   · 单张失败不中断：14 张里坏 2 张，剩下 12 张仍然有用；
 *   · 可随时停止：已生成的图保留，不因为"点了停止"就白花钱；
 *   · 不自动开跑：N 张就是 N 次计费，开跑前必须用户确认。
 */
function renderPackCard(m) {
  const p = m.pack;
  const running = p.status === "running";
  const finished = p.status === "done" || p.status === "stopped";
  const label = running
    ? `生成中 ${p.done}/${p.total}`
    : p.status === "done"
      ? `完成 ${p.done}/${p.total}`
      : p.status === "stopped"
        ? `已停止 · 完成 ${p.done}/${p.total}`
        : "未开始";
  const failText = p.failed?.length
    ? `<div style="margin-top:6px;color:#b42318">失败 ${p.failed.length} 张：${p.failed.map((f) => `${escapeHtml(f.code)}（${escapeHtml(f.reason)}）`).join("、")}</div>`
    : "";
  const d = document.createElement("div");
  d.className = "row a";
  const b = document.createElement("div");
  b.className = "bubble-ai";
  b.innerHTML = `
    <div><b>整套出图 · ${p.total} 张</b> <span class="chip">${escapeHtml(label)}</span></div>
    <div class="hint" style="margin-top:6px">逐张串行调用（并发会被上游限流）。每张算一次计费，本工具不代你估算金额；单张失败不会中断整套，点「停止」后已生成的图保留。</div>
    ${failText}
    <div class="rowline" style="margin-top:8px">
      <button class="btn primary sm" data-pack-run ${running || finished ? "disabled" : ""}>${running ? "生成中…" : `生成整套（${p.total} 张）`}</button>
      <button class="btn sm ghost" data-pack-stop ${running ? "" : "disabled"}>停止</button>
    </div>`;
  b.querySelector("[data-pack-run]")?.addEventListener("click", () => runPack(m));
  b.querySelector("[data-pack-stop]")?.addEventListener("click", () => S.abort?.abort());
  d.appendChild(b);
  return d;
}

async function runPack(m) {
  const p = m.pack;
  if (S.packRunning) return;
  if (!canGenerateImage()) {
    dispatch({ type: "error_message", content: "当前不可出图（未配图片 API Key，或这是只读演示版），整套出图无法开始。Prompt 仍可逐条复制使用。" });
    return;
  }
  const go = await uiConfirm({
    title: `生成整套 ${p.total} 张？`,
    body: `按顺序逐张调用生图接口 —— 每张都是一次独立调用，按你自己的接口计费，本工具不代你估算金额。\n\n中途可以点「停止」，已生成的图会保留；单张失败不会中断整套。`,
    okText: `开始生成（${p.total} 张）`,
  });
  if (!go) return;

  S.packRunning = true;
  const ctl = new AbortController();
  S.abort = ctl;
  p.status = "running"; p.done = 0; p.failed = [];
  renderMessages();
  for (const it of p.items) {
    if (ctl.signal.aborted) break;
    dispatch({ type: "tool_call", name: `generate_image · ${it.code}` });
    try {
      const r = await generateImage({ prompt: it.prompt, size: it.ratio || "1:1", signal: ctl.signal });
      dispatch({
        type: "file_output", url: r.url, filename: r.filename,
        description: `${it.code} · ${it.purpose || ""} · ${r.mode}${r.sizeNote ? " · 画幅已吸附" : ""}`.replace(/ · $/, ""),
      });
      p.done++;
    } catch (e) {
      if (ctl.signal.aborted) break;      // 用户主动停：不算失败
      p.failed.push({ code: it.code, reason: e.message });
    }
    renderMessages();
  }
  p.status = ctl.signal.aborted ? "stopped" : "done";
  S.packRunning = false;
  S.abort = null;
  renderMessages();
}

/* ─────────────────────── 输入区 ─────────────────────── */

function bindComposer() {
  const ta = $("#input");
  ta.addEventListener("input", () => { S.input = ta.value; $("#sendBtn").disabled = !ta.value.trim() && !S.attachment; });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(false); }
  });
  $("#sendBtn").addEventListener("click", () => send(false));
  $("#packBtn").addEventListener("click", () => send(true));
  $("#stopBtn").addEventListener("click", stop);
  $("#plusBtn").addEventListener("click", addExample);
  $("#clearBtn").addEventListener("click", clearChat);

  const file = $("#file");
  renderAttachIcon();
  $("#attachBtn").addEventListener("click", () => file.click());
  file.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (!S.probe.online) {
      dispatch({ type: "error_message", content: "上传参考图需要本地服务在线（浏览器直开 file:// 时无法存储文件）。请先运行 node server.mjs。" });
      return;
    }
    S.uploading = true;
    $("#attachBtn").textContent = "…";
    try {
      const r = await uploadImage(f);
      S.attachment = { ...r, filename: f.name };
    } catch (err) {
      dispatch({ type: "error_message", content: `上传失败：${err.message}` });
    } finally {
      S.uploading = false;
      // 上传结束要把图标**重新渲染**回来（图形在注册表里，不能写一个 emoji 字符回去）
      renderAttachIcon();
      renderAttach();
      $("#sendBtn").disabled = !$("#input").value.trim() && !S.attachment;
    }
  });
}

/**
 * 附件按钮的图形。抽成函数是因为它有两个调用点（启动 + 上传结束）——
 * 两处各写一遍图形/字符，就会出现"上传一次图标就变了"这类静默不一致。
 */
function renderAttachIcon() {
  const b = $("#attachBtn");
  if (b) b.innerHTML = iconSvg("paperclip", 20);
}

function renderAttach() {
  const box = $("#attachBox");
  box.innerHTML = "";
  if (!S.attachment) return;
  box.className = "attach";
  box.innerHTML = `
    <img src="${escapeHtml(S.attachment.url)}" alt="">
    <div class="meta"><b>${escapeHtml(S.attachment.filename || "")}</b><span>已附加 · 出图时会走图生图</span></div>
    <button class="btn sm ghost" id="rmAttach">移除</button>`;
  $("#rmAttach").addEventListener("click", () => { S.attachment = null; renderAttach(); });
}

function addExample() {
  const ta = $("#input");
  const pool = [
    "帮我生成一款蓝色蓝牙耳机的白底主图",
    "设计一款陶瓷咖啡杯的小红书氛围图，直接出图",
    "做一整套宠物自动喂食器的 Amazon 详情页",
    "给我一款磨砂玻璃护肤品瓶的电商主图 prompt",
    "生成一张编织收纳篮的平铺俯拍图，直接出图",
  ];
  ta.value = pool[Math.floor(Math.random() * pool.length)];
  S.input = ta.value;
  ta.focus();
  $("#sendBtn").disabled = false;
}

function stop() {
  S.abort?.abort();
  S.thinking = false;
  renderMessages();
  toggleThinkingUI();
}

function clearChat() {
  S.messages = [];
  S.lastTurn = null;
  pushWelcome();
  renderMessages();
}

function toggleThinkingUI() {
  $("#sendBtn").style.display = S.thinking ? "none" : "";
  $("#stopBtn").style.display = S.thinking ? "" : "none";
  $("#input").disabled = S.thinking;
  $("#attachBtn").disabled = S.thinking;
  $("#packBtn").disabled = S.thinking;
}

/* ─────────────────────── 发送 ─────────────────────── */

async function send(pack) {
  const text = $("#input").value.trim();
  if (!text || S.thinking) return;
  const attachment = S.attachment;
  $("#input").value = "";
  S.input = "";
  S.attachment = null;
  renderAttach();
  $("#sendBtn").disabled = true;

  msg({ role: "user", content: text, attachment: attachment || undefined });
  S.thinking = true;
  renderMessages();
  toggleThinkingUI();

  const ctl = new AbortController();
  S.abort = ctl;

  if (attachment && !isGenerateIntent(text)) {
    // 上传了参考图 → 图生图，且强制要求出图（参考项目的"上传=必用"铁律）。
    // ⚠️ 图生图这条路径有自己的模板逻辑（保留产品身份、只换场景），**不消费**显式模板，
    //    所以这里刻意不清 S.explicitTemplateId —— 状态条继续挂着，留给下一条文本消息，
    //    而不是"提示说会固定、实际没固定"。
    const r = await runImg2ImgTurn({ message: text, attachment, onEvent: dispatch, signal: ctl.signal });
    S.lastTurn = r;
    if (r && !canGenerateImage()) {
      dispatch({ type: "error_message", content: "参考图分析完成，但还没配置图片 API Key，暂时无法出图。可在「设置」里填写，或复制上面那段 Prompt 到任意生图工具使用。" });
    } else if (r) {
      await generateOne({ prompt: r.prompt, size: r.size, imageKey: attachment.key, onEvent: dispatch, signal: ctl.signal });
    }
  } else {
    // 🔴 显式模板**只作用于这一条消息**：先取走、立刻清掉，下一条自动回到自动匹配。
    //    做成粘性状态的话，用户点过一次模板库之后，后面所有对话都会静默违背自动匹配。
    const explicitTemplateId = S.explicitTemplateId;
    S.explicitTemplateId = null;
    renderTplLock();
    const r = await runTurn({ message: text, attachment, onEvent: dispatch, signal: ctl.signal, pack, explicitTemplateId });
    S.lastTurn = r;
    // 离线/本机编排时，整套计划在这里补发一次（在线模式由服务端的 pack_ready 事件送过来）。
    // 两种模式必须走同一个 packPayload，否则会出现"在线能点、离线点不动"。
    if (r?.packPlan) {
      const pp = packPayload(r.packPlan);
      if (pp && pp.total > 1) dispatch({ type: "pack_ready", pack: pp });
    }
    // 🔴 出图前必须两道门：有意图 **且** 没有被否定。
    //    只判 isGenerateIntent 的话，"先看文案，这款暂时不要出图" 在离线编排下
    //    仍会走 generateOne —— 虽然离线时会因为连不上服务而失败，
    //    但那条路径本身是错的：语义判断不该依赖"恰好连不上"。
    if (r && r.single && isGenerateIntent(text) && !isNegative(text)) {
      await generateOne({
        prompt: r.single.prompt,
        // 🔴 画幅只发**比例文本**（1:1 / 16:9），不发像素。
        //    原来这里有一份 sizeToPixel 映射表，和服务端 RATIO_PIXELS 各写一份，
        //    结果 16:9 被发成 1024x768（4:3）、9:16 被发成 720x1280（不是 864x1536）、
        //    5:4 直接缺失。客户端一旦自己换算，就必然和服务端分叉 ——
        //    比例 → 像素的换算只在 assets/prompt-engine.js 的 RATIO_PIXELS 一处发生。
        size: r.single.meta?.ratio || "1:1",
        imageKey: attachment?.key,
        onEvent: dispatch,
        signal: ctl.signal,
      });
    }
  }

  S.thinking = false;
  S.abort = null;
  for (const m of S.messages) delete m.streaming;
  renderMessages();
  toggleThinkingUI();
}

/* ─────────────────────── 模板库 ─────────────────────── */

function bindTemplates() {
  $("#tplSearch").addEventListener("input", renderTemplateGrid);

  // 🔴 创作台**默认自动选模板**，这里的按钮只提供"临时覆盖"，而且只作用于下一条消息。
  //    旧实现是把"用 XX 模板"拼成一句话塞进输入框、再指望关键词匹配猜中 ——
  //    绕了一圈还是靠猜，而且把模板名写进了本该由用户描述产品的输入框。
  $("#tplUse").addEventListener("click", () => {
    S.explicitTemplateId = S.selectedTemplate;
    renderTplLock();
    const subject = S.lastTurn?.subject;
    const ta = $("#input");
    if (!ta.value.trim() && subject && !subject.includes("{PRODUCT}")) ta.value = `给「${subject}」做一张图`;
    S.input = ta.value;
    $$("#nav button").find?.((b) => b.dataset.view === "chat")?.click();
    ta.focus();
  });
  $("#tplAuto").addEventListener("click", () => {
    S.explicitTemplateId = null;
    renderTplLock();
    renderAutoMatch();
  });
  $("#tplLockBtn").addEventListener("click", () => {
    S.explicitTemplateId = null;
    renderTplLock();
  });
  $("#autoMatchInput").addEventListener("input", renderAutoMatch);
  renderAutoMatch();

  $("#tplPromptOnly").addEventListener("click", () => {
    const t = P.TEMPLATES[S.selectedTemplate];
    const subject = S.lastTurn?.subject || "your product";
    const c = P.composePrompt({ subject, templateId: t.id, styleLock: P.buildStyleLock({}), sizeRatio: "1:1" });
    $("#tplPromptOut").textContent = c.prompt;
  });
  $("#tplCopy").addEventListener("click", async () => {
    const txt = $("#tplPromptOut").textContent;
    if (!txt.trim()) return;
    try { await navigator.clipboard.writeText(txt); $("#tplCopy").textContent = "已复制"; }
    catch { $("#tplCopy").textContent = "复制失败，请手动选中"; }
    setTimeout(() => ($("#tplCopy").textContent = "复制 Prompt"), 1500);
  });
}

const MATCH_SOURCE_LABEL = {
  keyword: "关键词命中",
  context: "上下文推断",
  fallback: "规则兜底",
  explicit: "显式指定",
};

/**
 * 顶栏那条"下一条固定用 XX"的提示。**没固定时不显示** ——
 * 让"当前是自动匹配"成为无需解释的默认状态，而不是一个要用户去关的开关。
 */
function renderTplLock() {
  const b = $("#tplLockBtn");
  if (!b) return;
  if (!S.explicitTemplateId) {
    b.style.display = "none";
    b.textContent = "";
    return;
  }
  const t = P.TEMPLATES[S.explicitTemplateId];
  b.style.display = "";
  b.textContent = `下一条文本消息固定用「${t ? t.name : S.explicitTemplateId}」· 点此恢复自动`;
}

/**
 * 模板库里的"自动匹配预览"：把匹配过程摊开给用户看。
 * 自动匹配要**可审议** —— 否则用户被分到一个不合适的模板时，只能反复改措辞瞎试。
 */
function renderAutoMatch() {
  const box = $("#autoMatchInput");
  const out = $("#autoMatchOut");
  if (!box || !out) return;
  const q = box.value.trim();
  if (!q) {
    out.textContent = "（在上面输入一句话，即时看匹配过程）";
    return;
  }
  const cat = P.detectCategory(q);
  const m = P.matchTemplate(q, { context: { category: cat.category } });
  const chips = [
    `<span class="chip p">${MATCH_SOURCE_LABEL[m.source] || m.source}</span>`,
    `<span class="chip">品类 ${cat.category || "未识别"}</span>`,
  ].join(" ");
  out.innerHTML = `
    <div><b>→ ${escapeHtml(m.templateName || m.id)}</b> <code>${escapeHtml(m.id)}</code> ${chips}</div>
    <div style="margin-top:6px"><b>依据：</b>${escapeHtml(m.reason)}</div>
    ${m.candidates.length
      ? `<div style="margin-top:6px"><b>也可考虑：</b>${m.candidates.map((c) => `<code>${escapeHtml(c.id)}</code>（${c.score} 分）`).join("、")}</div>`
      : `<div style="margin-top:6px"><b>也可考虑：</b>本次没有并列候选</div>`}
    <div style="margin-top:6px;color:var(--slate-400)">正式生成时还会额外带上「转化驱动力」与「有没有上传参考图」两项上下文。</div>`;
}

function renderTemplateGrid() {
  const q = ($("#tplSearch")?.value || "").trim().toLowerCase();
  const grid = $("#tplGrid");
  if (!grid) return;
  const list = P.TEMPLATE_LIST.filter((t) => {
    if (!q) return true;
    return (t.id + " " + t.name + " " + (t.keywords || []).join(" ") + " " + (t.trigger_phrases || []).join(" ")).toLowerCase().includes(q);
  });
  grid.innerHTML = "";
  for (const t of list) {
    const b = document.createElement("button");
    b.className = "tpl" + (t.id === S.selectedTemplate ? " on" : "");
    b.innerHTML = `
      <div class="no">${t.order} · ${escapeHtml(t.id)}</div>
      <div class="nm">${escapeHtml(t.name)}</div>
      <div class="kw">${escapeHtml((t.keywords || []).slice(0, 5).join(" / "))}</div>
      <div class="vs">
        ${Object.keys(t.variants || {}).slice(0, 4).map((v) => `<span class="chip">${escapeHtml(v)}</span>`).join("")}
        ${t.anti_ai_tips ? `<span class="chip a">anti-AI</span>` : ""}
      </div>`;
    b.addEventListener("click", () => { S.selectedTemplate = t.id; renderTemplateGrid(); renderTemplateDetail(); });
    grid.appendChild(b);
  }
  $("#tplCount").textContent = `${list.length} / ${P.TEMPLATE_LIST.length}`;
  renderTemplateDetail();
}

function renderTemplateDetail() {
  const t = P.TEMPLATES[S.selectedTemplate];
  if (!t) return;
  const fields = Object.entries(t.prompt_template || {});
  $("#tplDetail").innerHTML = `
    <h3>${t.order} · ${escapeHtml(t.name)} <span class="chip p">${escapeHtml(t.id)}</span></h3>
    <p class="hint">${escapeHtml((t.keywords || []).join("、"))}</p>
    <table class="tbl">
      <tr><th style="width:120px">prompt_template</th><td>${fields.map(([k, v]) => `<div><code>${escapeHtml(k)}</code> = ${escapeHtml(String(v))}</div>`).join("")}</td></tr>
      <tr><th>defaults</th><td>${Object.entries(t.defaults || {}).map(([k, v]) => `<code>${escapeHtml(k)}</code>=${escapeHtml(String(v))}`).join(" · ")}</td></tr>
      <tr><th>风格变体</th><td>${Object.entries(t.variants || {}).map(([k, v]) => `<div><span class="chip">${escapeHtml(k)}</span> ${escapeHtml(v.description || "")} → <code>${escapeHtml(Object.keys(v.overrides || {}).join(", "))}</code></div>`).join("")}</td></tr>
      <tr><th>category_tips</th><td>${Object.entries(t.category_tips || {}).map(([k, v]) => `<div><code>${escapeHtml(k)}</code>: ${escapeHtml(String(v))}</div>`).join("") || "—"}</td></tr>
      <tr><th>示例</th><td>${(t.examples || []).map((e) => `<div style="font-family:var(--mono);font-size:11.5px;margin-bottom:4px">${escapeHtml(e)}</div>`).join("") || "—"}</td></tr>
      <tr><th>anti_ai_tips</th><td>${t.anti_ai_tips ? escapeHtml(t.anti_ai_tips) : "—"}</td></tr>
      <tr><th>支持参考图</th><td>${t.supports_image_reference ? "是" : "否"}</td></tr>
    </table>`;
}

/* ─────────────────────── Listing 工作台 ─────────────────────── */

function renderListingLimits() {
  const el = $("#limTable");
  if (!el) return;
  el.innerHTML = `
    <table class="tbl">
      <tr><th>字段</th><th>平台硬上限</th><th>建议上限</th><th>来源</th></tr>
      <tr><td>标题 <span class="chip">2026-07-27 新规</span></td><td class="num">${L.LIMITS.title} 字符</td><td class="num">${L.LIMITS.titleStrict}</td><td>平台公开规则 / 建议值＝项目自定义保守口径</td></tr>
      <tr><td>标题（仅 media 例外）</td><td class="num">${L.LIMITS.titleMedia} 字符</td><td class="num">—</td><td>平台公开规则：图书 / 音乐 / 影像是唯一例外</td></tr>
      <tr><td>Item Highlights</td><td class="num">${L.LIMITS.itemHighlights} 字符</td><td class="num">—</td><td>平台公开规则，且<b>参与搜索</b>、显示在标题下方</td></tr>
      <tr><td>标题 + Highlights 合计</td><td class="num">${L.LIMITS.titleTotal} 字符</td><td class="num">—</td><td>平台公开规则：两段式标题共享 ${L.LIMITS.titleTotal} 字符额度</td></tr>
      <tr><td>五点（单条）</td><td class="num">${L.LIMITS.bullet} 字符</td><td class="num">—</td><td>平台公开规则</td></tr>
      <tr><td>Search Terms</td><td class="num">${L.LIMITS.searchTerms} 字节</td><td class="num">—</td><td>平台公开规则（注意是字节）</td></tr>
      <tr><td>规则总数</td><td colspan="3">${L.RULES.length} 条（硬规则 ${L.RULES.filter((r) => r.level === "P").length} + 软规则 ${L.RULES.filter((r) => r.level === "C").length}）</td></tr>
    </table>
    <div class="note warn" style="margin-top:10px">
      <b>新规最关键的一条因果</b>：标题超过 ${L.LIMITS.title} 字符时，Item Highlights 这个字段<b>提交不上去</b>
      （官方原文：You can only submit title_differentiation when item_name is 75 characters or fewer）。
      而且超限不等于报错 —— Amazon 会按 AI 建议<b>自动改写你的标题</b>，你拿到的是它给的版本（品牌方另有 14 天复核期）。
      所以标题和 Highlights 要<b>一起改</b>，先压标题再填亮点。
    </div>`;
}

/**
 * 额度计数器的配色档位（只影响颜色，不影响判定 —— 判定永远在 listing.js 里做）。
 * 90% 这条线是**显示用**的直觉阈值，不是平台规则，所以刻意没写进规则层：
 * 免得哪天有人把它当成"超过 90% 就违规"。
 */
function countFlag(used, limit) {
  if (used > limit) return "r";
  if (used > limit * 0.9) return "a";
  return "g";
}

/**
 * 三个和「新规额度」直接相关的实时计数：标题 / Item Highlights / 两段合计。
 * 🔴 为什么值得做成实时而不是等跑质检：新规下"标题 76 字符"不是"稍微有点长"，
 *    而是**同时丢掉标题控制权和 Highlights 提交资格**。这种量级的后果，
 *    不该让人点了按钮才知道。
 */
function renderFieldCounters() {
  const t = ($("#lTitle")?.value || "").trim();
  const h = ($("#lHighlights")?.value || "").trim();
  const media = ($("#lMedia")?.value || "") === "media";
  // 标题上限随类目口径变化 —— 复用 listing.js 的 titleLimit，不在这里重写一遍三元。
  const cap = L.titleLimit({ isMedia: media });
  const set = (sel, text, cls) => {
    const el = $(sel);
    if (!el) return;
    el.textContent = text;
    el.className = "chip" + (cls ? " " + cls : "");
  };
  const titleOver = t.length > cap;
  set("#lTitleCount", `${t.length} / ${cap}${media ? "（media）" : ""}`, countFlag(t.length, cap));
  // 🔴 标题超限时，Highlights 这一格必须**说清它会连带失效**，而不是只把自己标红 ——
  //    "标题超了 → 亮点提交不上去"是这一整条新规里最容易被忽略、后果最重的一环。
  set(
    "#lHighlightsCount",
    `${h.length} / ${L.LIMITS.itemHighlights}${titleOver ? "　⚠️ 标题超限，本字段提交不上去" : ""}`,
    titleOver ? "r" : countFlag(h.length, L.LIMITS.itemHighlights),
  );
  const total = t.length + h.length;
  set("#lBudgetCount", `两段合计 ${total} / ${L.LIMITS.titleTotal}`, countFlag(total, L.LIMITS.titleTotal));

  // tab 上点红点：字段被 tab 藏起来时，"超限"不能只体现在卡片头部的 chip 上。
  const dot = (id, over) => $(`#fieldTabs button[data-tab="${id}"]`)?.classList.toggle("r", over);
  dot("lTitle", titleOver);
  dot("lHighlights", titleOver || h.length > L.LIMITS.itemHighlights);
}

function currentListing() {
  return {
    title: $("#lTitle").value.trim(),
    // Item Highlights：**不 trim 内部**，只去首尾 —— 用户可能故意用逗号+空格分段，
    // 内部空白由用户自己控（我们只在他跑质检时告诉他长度）。
    highlights: ($("#lHighlights")?.value || "").trim(),
    bullets: $("#lBullets").value.split("\n").map((s) => s.trim()).filter(Boolean),
    searchTerms: $("#lSearch").value.trim(),
    description: ($("#lDesc")?.value || "").trim(),
  };
}
function lintCtx() {
  // 🔴 品类一定要传下去：P6 的品类分支靠它。不传就只能靠正文自动识别，
  //    而正文里往往没有品类词（"Hypoallergenic Cotton Socks" 识别不出 fashion）。
  return {
    brand: $("#lBrand").value.trim(),
    primaryKeyword: $("#lKey").value.trim(),
    category: $("#lCategory").value.trim().toLowerCase() || undefined,
    // 类目口径：media（图书/音乐/影像）是标题 75 字符新规的**唯一例外**。
    // 用一个显式开关而不是让程序猜品类 —— 猜错会给用户一个"通过"的假结论，
    // 而这条判错在后台是会被直接改标题的。
    isMedia: ($("#lMedia")?.value || "") === "media",
    // 语种：C3 的利益词判据要用它。**必须显式传** —— 德语是拉丁字母，
    // 只看字形会被判成英文，然后拿英文词表去套合格的德语文案（错判）。
    lang: ($("#lLang")?.value || "").trim(),
  };
}

/* ─────────────────────── 草稿自动保存（本机）───────────────────────
 * 为什么是 localStorage 而不是 IndexedDB：这里存的是 8 个输入框的短文本（KB 级），
 * 同步读写最省事。真正的产物（抓取结果 / 覆盖度 / 图片）仍走 IndexedDB（store.js）。
 *
 * 🔴 只存"用户敲进去的东西"，不存推导结果。打开页面时重算一次 —— 恢复一份可能过期的
 *    计算结果比不恢复更危险（口径改过之后，旧结果就是错的）。
 * 🔴 这条是**修一个 P0**：在此之前，写了一半文案按 F5，输入全部消失、视图回落到创作台。
 */
const FORM_KEY = "clx_listing_form_v1";
const FORM_IDS = [
  "lBrand", "lName", "lKey", "lFeatures", "lSize", "lQty", "lAudience",
  "lCategory", "lMedia", "lLang", "lCorpus", "lKeywords",
  "lTitle", "lHighlights", "lBullets", "lSearch", "lDesc",
];
let formTimer = null;
let formClearing = false;

const formEls = () => FORM_IDS.map((id) => document.getElementById(id)).filter(Boolean);

/**
 * 当前所有表单字段的快照。
 * 🔴 saveFormNow 与 applyDraft（覆盖前留底）共用这一份 —— 两处各写一份字段清单，
 *    迟早会漏掉某个字段，而漏掉的那个正好是撤销时恢复不了的那个。
 */
function snapshotForm() {
  const o = {};
  for (const el of formEls()) o[el.id] = el.value;
  return o;
}

function formStamp(t) {
  const d = new Date(t || 0);
  if (!Number.isFinite(d.getTime())) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 有没有存过东西 —— 「清空草稿」按钮的可用态、以及标签要不要显示，都看这一个判据。 */
function formHasDraft() {
  try {
    const raw = localStorage.getItem(FORM_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return d && d.v === 1 && d.fields ? d : null;
  } catch {
    return null;
  }
}

function saveFormNow() {
  if (formClearing) return;
  const fields = snapshotForm();
  // 全空就别占着一份"草稿"：否则清空之后下次打开还会显示"已自动保存 14:32"。
  const any = Object.values(fields).some((v) => String(v || "").trim());
  try {
    if (!any) localStorage.removeItem(FORM_KEY);
    else localStorage.setItem(FORM_KEY, JSON.stringify({ v: 1, at: Date.now(), fields }));
  } catch { /* 隐私模式下 localStorage 可能直接抛，功能降级但不该拦着人用 */ }
  renderFormSavedLabel();
}

function scheduleSaveForm() {
  clearTimeout(formTimer);
  formTimer = setTimeout(saveFormNow, 350);   // 打字时不要每个字符写一次盘
}

function renderFormSavedLabel() {
  const el = $("#formSaved");
  if (!el) return;
  const d = formHasDraft();
  const btn = $("#btnClearForm");
  if (d) {
    el.textContent = `草稿已自动存在本机 · ${formStamp(d.at)}`;
    el.className = "hint ok";
  } else {
    el.textContent = "还没开始写 · 输入会自动存在这台机器上，刷新不丢";
    el.className = "hint";
  }
  if (btn) btn.disabled = !d;
}

function restoreForm() {
  const d = formHasDraft();
  if (!d) { renderFormSavedLabel(); return; }
  for (const el of formEls()) {
    if (typeof d.fields[el.id] === "string") el.value = d.fields[el.id];
  }
  renderFieldCounters();
  renderFormSavedLabel();
}

/**
 * 清空草稿：两步确认，不用 window.confirm()。
 * 理由和导出 CSV 拦缺口处写的一样 —— 原生对话框会阻塞主线程，自动化脚本直接卡死，
 * 而且它只能放一行字，说不清"清掉的是什么、能不能恢复"。
 */
function clearForm(btn) {
  if (!btn || btn.dataset.armed !== "1") {
    if (btn) {
      btn.dataset.armed = "1";
      btn.textContent = "再点一次确认清空";
      setTimeout(() => {
        btn.dataset.armed = "";
        btn.textContent = "清空草稿";
      }, 4000);
    }
    return;
  }
  formClearing = true;
  for (const el of formEls()) el.value = "";
  try { localStorage.removeItem(FORM_KEY); } catch { /* 忽略 */ }
  formClearing = false;
  btn.dataset.armed = "";
  btn.textContent = "清空草稿";
  // 清空后把已经渲染出来的结果也撤掉，否则左边空了、右边还挂着一份旧结论。
  for (const id of ["#lintOut", "#draftOut", "#csvOut", "#coverOut", "#mineOut", "#vaultOut"]) {
    const el = $(id);
    if (el) el.innerHTML = "";
  }
  renderFieldCounters();
  renderFormSavedLabel();
}

function bindFormPersistence() {
  for (const el of formEls()) {
    el.addEventListener("input", scheduleSaveForm);
    el.addEventListener("change", scheduleSaveForm);   // select 改值不一定触发 input
  }
  const btn = $("#btnClearForm");
  if (btn) btn.addEventListener("click", () => clearForm(btn));
  restoreForm();
}

function bindListing() {
  // 🔴 必须最先调：先把上次没写完的草稿还原回来，后面所有渲染与计数才有数据可算。
  bindFormPersistence();
  $("#btnDraft").addEventListener("click", () => generateDraft());
  $("#btnLint").addEventListener("click", runLint);
  $("#btnCoverage").addEventListener("click", runCoverage);

  // ── P2：竞品 CSV 导入 / A+ 骨架 / 批量质检 ──
  // 全部走 `?.`：这三块都在抽屉里，抽屉将来若被拆走也不会让整页初始化崩掉。
  $("#csvFile")?.addEventListener("change", onCsvFile);
  $("#btnAplus")?.addEventListener("click", runAplus);
  $("#btnAplusCopy")?.addEventListener("click", async () => {
    if (!S.aplusPlan) return;
    const text = aplusToText(S.aplusPlan, { product: $("#lName").value.trim(), brand: $("#lBrand").value.trim() });
    try {
      await navigator.clipboard.writeText(text);
      $("#aplusStatus").textContent = "已复制到剪贴板";
    } catch {
      // 剪贴板需要安全上下文（http://127.0.0.1 算），不行就退回下载 —— 但不能假装复制成功
      downloadText("A+模块骨架.txt", text);
      $("#aplusStatus").textContent = "剪贴板不可用，已改为下载 txt";
    }
  });
  $("#btnBatch")?.addEventListener("click", runBatch);
  $("#btnBatchDemo")?.addEventListener("click", fillBatchDemo);
  $("#btnBatchCsv")?.addEventListener("click", () => {
    if (!S.batch || !S.batch.rows.length) return;
    downloadText("批量质检-汇总.csv", batchCsv(S.batch.rows), "text/csv;charset=utf-8");
  });
  if ($("#batchMax")) $("#batchMax").textContent = String(BATCH_MAX);
  // 「生成并质检」：草稿真的写进输入框之后才跑质检 —— 否则检的是生成前的内容。
  // 有冲突时先弹三选一，选了哪个再跑；点「取消」则不跑（用户可以自己按「跑质检」）。
  $("#btnLintDraft").addEventListener("click", () => generateDraft({ after: runLint }));
  $("#btnExportListing").addEventListener("click", () => {
    S.listing = currentListing();
    const f = L.exportListingFields(S.listing, lintCtx());
    const out = {
      listing: S.listing,
      lint: L.lintListing(S.listing, lintCtx()),
      // 把两段式标题的额度账也写进报告：单看任一字段都看不出额度还剩多少。
      headlineBudget: f.budget,
      budgetNotes: f.notes,
      exportedAt: new Date().toISOString(),
    };
    downloadJSON("listing-质检报告.json", out);
  });
  const buildFields = () => {
    S.listing = currentListing();
    return L.exportListingFields(S.listing, lintCtx());
  };
  $("#btnExportFields").addEventListener("click", () => downloadJSON("listing-后台字段.json", buildFields()));
  // 🆕 Flat File 风格 CSV：列名用官方属性名，给批量表搬数据用。
  // ⚠️ 界面上必须说清它不是"可直接提交的官方模板" —— 各品类模板列名不同，
  //    把对照文件说成模板，用户传上去才报错，比不做这个功能更糟。
  $("#btnExportCsv")?.addEventListener("click", () => {
    S.listing = currentListing();
    const ctx = lintCtx();
    // 🔴 导出前先跑预校验：有硬缺口就**拦住并说清**，而不是给一份"看着挺完整"的 CSV。
    // 拦住的方式是「先把缺口摆出来 + 给一个明确的仍然导出按钮」，**不用 confirm()**：
    //   ① 原生对话框会阻塞页面主线程（控制台 / 自动化脚本直接卡死）；
    //   ② 它塞不进三层预校验的内容，只能放一行标题，用户看完还是不知道该改哪里。
    const pre = L.precheckForUpload(S.listing, ctx);
    if (!pre.ok) {
      const el = $("#csvOut");
      if (el) {
        el.innerHTML = `<div class="note bad" style="margin-top:8px"><b>先不导出：有 ${pre.blockers.length} 项硬缺口。</b>
          CSV 里会如实写你填的内容，但带着这些缺口传不到亚马逊。</div>${precheckHtml(pre)}
          <div class="rowline" style="margin-top:8px"><button class="btn sm ghost" id="btnCsvForce">仍然导出（内容就是我填的这些）</button></div>`;
        const fb = $("#btnCsvForce");
        if (fb) fb.onclick = () => doExportCsv(pre);
      }
      return;
    }
    doExportCsv(pre);
  });
  $("#btnPrecheck")?.addEventListener("click", () => {
    S.listing = currentListing();
    renderPrecheck(L.precheckForUpload(S.listing, lintCtx()));
  });
  // 🆕 体检报告：单文件 HTML（可直接转发 / 打印成 PDF），内容 = 字段 + 质检 + 信息架构 + 覆盖度 + 边界声明
  $("#btnHealth")?.addEventListener("click", () => {
    S.listing = currentListing();
    downloadText("listing-体检报告.html", healthReportHtml(), "text/html;charset=utf-8");
  });
  $("#btnCopyFields").addEventListener("click", async () => {
    const out = buildFields();
    const bits = [];
    if (out.overflows.length) bits.push(`超限：${out.overflows.map((f) => f.label + " 超 " + (-f.remaining) + f.unit).join("、")}`);
    if (out.missingRequired.length) bits.push(`缺必填：${out.missingRequired.map((f) => f.label).join("、")}`);
    // 🔴 budget.notes 是"标题超 75 → Highlights 提交不上去"这类因果提示，
    //    复制出去的内容里也要带，否则用户在后台会遇到一个说不清原因的失败。
    bits.push(...out.notes);
    const warn = bits.length ? `\n\n⚠️ 注意：${bits.join("；")}` : "";
    const text = out.text + warn;
    try {
      await navigator.clipboard.writeText(text);
      $("#btnCopyFields").textContent = "已复制到剪贴板";
    } catch {
      downloadText("listing-后台字段.txt", text);
      $("#btnCopyFields").textContent = "已改为下载 txt";
    }
    setTimeout(() => ($("#btnCopyFields").textContent = "复制为文本"), 1800);
  });
  $("#btnMine").addEventListener("click", () => {
    const text = $("#lCorpus").value;
    if (!text.trim()) return;
    const lang = $("#lLang").value;
    // 多段（--- 分隔）时只在第一段上做词频会丢信息 —— 但那正是"多竞品对比"要解决的问题，
    // 所以这里对整段跑词频，并在界面上提示"要按竞品分别看请点旁边那个按钮"。
    const r = L.mineKeywords(text, { top: 40, lang });
    S.lastMined = r;
    $("#mineOut").innerHTML = `
      <div class="rowline" style="margin-bottom:8px">
        <span class="chip">词条 ${r.stats.tokens}</span>
        <span class="chip">去重 ${r.stats.uniqueTokens}</span>
        <span class="chip p">Top1：${escapeHtml(r.stats.topTerm || "—")}</span>
        <button class="btn sm ghost" id="btnMineToKey">把这些词填入关键词框</button>
      </div>
      <div class="note warn" style="margin-bottom:8px">${escapeHtml(r.note)}</div>
      ${r.scriptNote ? `<div class="note bad" style="margin-bottom:8px">${escapeHtml(r.scriptNote)}</div>` : ""}
      <div style="display:flex;flex-wrap:wrap;gap:5px">
        ${r.terms.map((t) => `<span class="chip" title="权重 ${t.weight}">${escapeHtml(t.term)} <span style="color:var(--slate-400)">${t.weight}</span></span>`).join("")}
      </div>`;
    $("#btnMineToKey").addEventListener("click", () => {
      $("#lKeywords").value = r.terms.slice(0, 20).map((t) => t.term).join(", ");
    });
    saveArtifact("listing", `词频挖掘 · ${$("#lName").value.trim() || "未命名"}`, r, {
      subject: $("#lName").value.trim() || undefined,
      terms: r.terms.length,
      lang: lang || undefined,
    });
  });
  // ── 本周词库：体检卡（G-3）+ 排序切换（G-7）─────────────────────────────
  // 数据由定时任务每周写进 data/keywords/latest.json（采集器：tools/collect-keywords.mjs）。
  // 🔴 四种状态必须分开说，因为下一步动作完全不同：
  //    没有词库（没跑过）/ 过期（跑了但失败）/ 快死了（>21 天没更新）/ 正常。
  //    一律显示"加载失败"等于把四种情况都变成"不知道该怎么办"。
  // 🔴 体检卡的判据：只要"数据可能不新 / 不全 / 没验证"，界面上就必须有一行对应的话。
  //    只放进 JSON 等于没说 —— 运营不会 F12 去看返回体。
  const VAULT_SORTS = [["roots", "词根命中"], ["new", "新词优先"], ["az", "字母序"]];
  let vaultSort = "roots";
  // 时间一律走文件末尾那个 fmtStamp()：它按**本地时区**格式化。
  // 别用 `iso.slice(0,16)` —— 采集器写的是 UTC（22:03Z），切片会把北京时间显示成早 8 小时。

  // 体检卡只输出"事实行"，不改写数据：新不新、全不全由服务端 trust 判定，
  // 界面**不再自己算一遍覆盖率** —— 两处各算一份，迟早会打架。
  function vaultTrustHtml(d) {
    const t = d.trust || {};
    const st = t.staleness || {};
    const state = ["fresh", "stale", "dead", "missing"].includes(st.state) ? st.state : "missing";
    const FRESH = { fresh: "chip g", stale: "chip a", dead: "chip r", missing: "chip" };
    const age = Number.isFinite(st.ageDays) ? `${st.ageDays} 天` : "—";
    const cov = t.coverage || {};
    const pct = (v) => (Number.isFinite(v) ? `${Math.round(Number(v) * 100)}%` : "—");
    const src = t.sourceStatus || {};
    const bud = t.budget || null;
    const s = t.status || {};
    const html = [];

    html.push(`<div class="rowline" style="margin-bottom:6px">
      <span class="${FRESH[state]}">新鲜度 ${state}（${age}）</span>
      ${t.verifiedMarket === false
        ? `<span class="chip a">站点 ${escapeHtml(String(d.site || "?"))} 未验证</span>`
        : `<span class="chip g">站点 ${escapeHtml(String(d.site || "US"))} 已验证</span>`}
      <span class="chip ${Number(cov.price) >= 0.9 ? "" : "a"}">价格字段 ${pct(cov.price)}</span>
      <span class="chip ${Number(cov.rating) >= 0.9 ? "" : "a"}">评分 ${pct(cov.rating)}</span>
      <span class="chip">评论数 ${pct(cov.reviewCount)}</span>
    </div>`);

    // 不新鲜 / 未验证 / 字段缺损：每种都要有一句"那该怎么办"，不是只染个颜色。
    if (state !== "fresh") {
      const bad = state === "dead" || state === "missing";
      html.push(`<div class="note ${bad ? "bad" : "warn"}">${escapeHtml(st.note || "词库不是最新的")}</div>`);
    }
    if (t.verifiedMarket === false) {
      html.push(`<div class="note warn">站点 ${escapeHtml(String(d.site || "?"))} 没有实测过 —— 目前只有 US 的类目/榜单结构验证过，其他站点可能整块取不到数据。拿它做判断前先抽查几条。</div>`);
    }
    if (Number.isFinite(cov.price) && Number(cov.price) < 0.9) {
      html.push(`<div class="note">价格字段只有 ${pct(cov.price)} —— 比价和价格带判断会漏掉一部分竞品，别把"没抓到价"当成"便宜"。</div>`);
    }
    if (Number(t.emptyGroups) > 0) {
      html.push(`<div class="note warn">有 ${t.emptyGroups} 个词没归到任何词根 —— 这些词进不了类目反查，只能当纯搜索词用。</div>`);
    }

    // 数据源自证：状态 + 预算。预算不够导致词根没跑完，是最容易被忽略的"数据不全"。
    const srcBits = Object.entries(src).map(([k, v]) =>
      `<span class="chip ${v === "ok" ? "g" : "a"}">${escapeHtml(k)} ${escapeHtml(String(v))}</span>`).join("");
    const budBits = bud && Number.isFinite(bud.requests)
      ? `<span class="chip">请求 ${bud.requests}${Number.isFinite(bud.planned) ? `/${bud.planned}` : ""} 次</span>`
      : "";
    const skipBits = bud && Number(bud.skipped) > 0
      ? `<span class="chip a">预算跳过 ${bud.skipped} 个词根</span>`
      : "";
    if (srcBits || budBits || skipBits) {
      html.push(`<div class="rowline" style="margin-bottom:6px">${srcBits}${budBits}${skipBits}</div>`);
    }

    // 上次采集到底成没成：这条解释了"词库为什么是现在这个样子"。
    const dur = Number.isFinite(s.durationMs) ? `（耗时 ${Math.round(Number(s.durationMs) / 1000)}s）` : "";
    const lastOk = s.lastSuccessAt ? fmtStamp(s.lastSuccessAt) : "";
    if (!s.lastAttemptAt && !s.lastSuccessAt) {
      html.push(`<div class="note warn">没有采集记录 —— 定时任务还没跑过，这份数据是手生成的或来自旧文件。上面按钮只能读到已有的东西。</div>`);
    } else if (s.ok === false) {
      html.push(`<div class="note bad">上次采集失败：${escapeHtml(String(s.reason || "未知原因"))}${Number.isFinite(s.exitCode) ? `（退出码 ${s.exitCode}）` : ""}${lastOk ? `｜上次成功 ${escapeHtml(lastOk)}` : "｜从未成功过"}</div>`);
    } else {
      html.push(`<div class="note">上次采集 ${escapeHtml(s.lastAttemptAt ? fmtStamp(s.lastAttemptAt) : "—")} 成功${dur}${s.host ? `｜机器 ${escapeHtml(String(s.host))}` : ""}</div>`);
    }
    return html.join("");
  }

  async function loadVault(sort = vaultSort) {
    vaultSort = sort;
    const el = $("#vaultOut");
    el.innerHTML = `<div class="note">正在读取本周词库…</div>`;
    try {
      const resp = await fetch(apiUrl(`/api/keywords?limit=300&sort=${encodeURIComponent(sort)}`));
      const d = await resp.json();
      const t = d.trust || {};
      if (!d.ok) {
        // 没有词库时更要把"上次采集怎么了"说出来 —— 这才是可以照着修的信息。
        const s = t.status || {};
        const why = s.lastAttemptAt
          ? `上次采集 ${escapeHtml(fmtStamp(s.lastAttemptAt))} 失败：${escapeHtml(String(s.reason || "未知原因"))}`
          : "还没有任何采集记录。";
        el.innerHTML = `<div class="note bad"><b>暂时没有词库。</b>${escapeHtml(d.error || "未知原因")}
          ${d.hint ? `<br><small>${escapeHtml(d.hint)}</small>` : ""}<br><small>${why}</small></div>`;
        return;
      }
      const top = (d.keywords || []).slice(0, 40);
      const day = String(d.generatedAt || "").slice(0, 10);
      const sum = d.summary || {};
      // 首次 / 回归分开报：「本周新增 N」把回归词算成新词，会让人误判"冒出一批新需求"。
      const newChip = t.returnedUnknown
        ? `<span class="chip p">本周新增 ${d.counts.newKeywords}</span><span class="chip a" title="没有历史投影，分不出首次与回归">首次/回归分不出</span>`
        : `<span class="chip p">首次 ${Number.isFinite(sum.firstTimeCount) ? sum.firstTimeCount : "—"}</span>`
          + `<span class="chip">回归 ${Number.isFinite(sum.returnedCount) ? sum.returnedCount : "—"}</span>`;
      const tabs = VAULT_SORTS.map(([k, label]) =>
        `<button class="btn sm ${k === sort ? "primary" : "ghost"}" data-vsort="${k}">${label}</button>`).join("");
      const sortLabel = (VAULT_SORTS.find(([k]) => k === sort) || VAULT_SORTS[0])[1];
      el.innerHTML = `
        <div class="rowline" style="margin-bottom:8px">
          <span class="chip">${escapeHtml(day)}</span>
          <span class="chip">词 ${d.counts.keywords}</span>
          <span class="chip">ASIN ${d.counts.asins}</span>
          ${newChip}
          <button class="btn sm ghost" id="btnVaultToKey">把前 ${Math.min(30, top.length)} 个词填入关键词框</button>
        </div>
        ${vaultTrustHtml(d)}
        ${d.keywordsTruncated ? `<div class="note" style="margin-bottom:8px">词库共 ${d.keywordsTotal} 条，这里按「${escapeHtml(sortLabel)}」取了前 ${d.keywords.length} 条 —— 不是词库只有这么多。</div>` : ""}
        <div class="rowline" style="margin-bottom:8px">${tabs}</div>
        <div class="note" style="margin-bottom:8px">${escapeHtml(d.note || "")}</div>
        <div style="display:flex;flex-wrap:wrap;gap:5px">
          ${top.map((k) => `<span class="chip" title="词根：${escapeHtml((k.roots || []).join(", ") || "—")}｜命中 ${k.rootCount ?? k.hits ?? "—"} 个词根">${escapeHtml(k.term)}</span>`).join("")}
        </div>`;
      el.querySelectorAll("[data-vsort]").forEach((b) => {
        b.addEventListener("click", () => loadVault(b.getAttribute("data-vsort")));
      });
      const tb = $("#btnVaultToKey");
      if (tb) {
        tb.addEventListener("click", () => {
          $("#lKeywords").value = top.slice(0, 30).map((k) => k.term).join(", ");
        });
      }
    } catch (e) {
      el.innerHTML = `<div class="note bad">读取词库出错：${escapeHtml(e.message)}</div>`;
    }
  }
  $("#btnLoadVault").addEventListener("click", () => loadVault(vaultSort));
  $("#btnCompare").addEventListener("click", () => {
    const raw = $("#lCorpus").value;
    if (!raw.trim()) return;
    const lang = $("#lLang").value;
    const r = L.compareCompetitors(raw, { top: 40, lang });
    renderCompare(r);
    saveArtifact("coverage", `多竞品对比 · ${r.size} 个竞品`, r, { count: r.size, consensus: r.consensus.length });
  });
  $("#lUseProduct").addEventListener("click", () => {
    if (!S.product) { uiToast("还没有采集到商品数据。先去「数据采集」抓一次。", "warn"); return; }
    const inp = A.productToWorkbenchInput(S.product);
    $("#lBrand").value = inp.brand || "";
    $("#lName").value = inp.productName || "";
    $("#lFeatures").value = (inp.features || []).join("\n");
    $("#lCorpus").value = inp.competitorText || "";
    $("#lSize").value = inp.sizeSpec || "";
    $("#lCategory").value = inp.category || "";
    // 采集来的商品是 media（图书/音乐/影像）时同步切口径 —— 否则会拿 75 去卡一本图书的标题，
    // 报一堆"超限"，而用户其实没错。同步之后他也能一眼看到口径被切到了 media。
    if ($("#lMedia")) $("#lMedia").value = inp.isMedia ? "media" : "";
    renderFieldCounters();
  });

  // ── 额度实时计数 ──
  // 🔴 只挂在"改了就有后果"的两个字段上：标题与 Item Highlights。
  //    其余字段（五点/描述）超限的后果是"被截断"，而标题超限的后果是
  //    "连 Highlights 一起提交不上去、标题还会被 AI 改写" —— 两者不是一个量级。
  for (const sel of ["#lTitle", "#lHighlights"]) {
    $(sel)?.addEventListener("input", renderFieldCounters);
  }
  $("#lMedia")?.addEventListener("change", renderFieldCounters);
  renderFieldCounters();

  // ── ⑥ Rufus 信息架构检查 ──
  // 🔴 空表也要**先跑一次**：跳过项与「无可检查项」的结论必须在首屏就可见 ——
  //    藏起来等于界面说假话（AC-03 / AC-04）。改任一被查字段都实时重算，
  //    免得用户改了文案还看着上一轮的旧结论。
  $("#btnRufus")?.addEventListener("click", renderRufus);
  $("#rProductType")?.addEventListener("change", renderRufus);
  $("#rImageText")?.addEventListener("input", renderRufus);
  for (const sel of ["#lTitle", "#lHighlights", "#lBullets", "#lSearch", "#lDesc"]) {
    $(sel)?.addEventListener("input", renderRufus);
  }
  renderRufus();
}

/* ─────────── ⑦ 竞品关键词 → 文案提示词（实时抓取 + 本地算权重）───────────
 * 三条分工写死，不许混：
 *   抓取  → 服务端 /api/competitor/*（浏览器直连亚马逊会被 CORS 拦；主机白名单在服务端）
 *   权重  → CK.analyzeKeywords（纯本地，断网也能算）
 *   拼装  → CP.buildCopyPrompt（纯本地）
 * 🔴 失败一律如实报原文，不塞假数据、不假装成功。
 */

const CMP = { cfg: null, items: [], rows: null, prompt: "", busy: false };

/* 🔴 请求世代号。换站点 / 类目 / 子类目时 +1，在途的旧响应回来一律丢弃。
 *   没有它会出这种自相矛盾：下拉已经换成「电子产品」，表格还是「玩具与游戏」的 30 条，
 *   点「生成提示词」出来的文本里写着「类目：电子产品」，正文却是玩具榜单的词。
 *   用序号而不是 abort：Node/浏览器都可能已经把响应收完了，序号判断更省事、也不会漏 catch。 */
let cmpEpoch = 0;

function setCpStatus(msg) {
  const el = $("#cpStatus");
  if (el) el.textContent = msg || "";
}

/**
 * 让上一轮的抓取结果与所有派生产物失效。
 * 「我要看哪个榜单」的控件一动就必须调它 —— 否则屏幕上会同时挂着两代数据。
 */
function clearCompetitorResult(reason) {
  cmpEpoch++;                 // 🔴 先作废在途请求，再清屏 —— 否则几秒后回来的旧响应又会把屏幕填满
  CMP.items = [];
  CMP.rows = null;
  CMP.prompt = "";
  const p = $("#cpPromptOut"); if (p) p.innerHTML = "";
  const kwWrap = $("#cpKwWrap"); if (kwWrap) kwWrap.style.display = "none";
  const kwOut = $("#cpKwOut"); if (kwOut) kwOut.innerHTML = "";
  renderCompetitorItems();
  if (reason) setCpStatus(reason);
}

function cpCtx() {
  const siteSel = $("#cpSite"), catSel = $("#cpCat");
  const siteLabel = siteSel && siteSel.selectedOptions[0] ? siteSel.selectedOptions[0].textContent : "";
  const catLabel = catSel && catSel.selectedOptions[0] ? catSel.selectedOptions[0].textContent : "";
  const sub = $("#cpSub");
  const subLabel = sub && sub.value && sub.selectedOptions[0] ? sub.selectedOptions[0].textContent : "";
  return {
    product: ($("#cpProduct")?.value || "").trim(),
    siteLabel,
    categoryPath: [catLabel, subLabel].filter(Boolean).join(" > "),
    items: CMP.items,
    rows: CMP.rows || [],
    isMedia: $("#cpIsMedia")?.value === "1",
  };
}

async function loadCompetitorCategories() {
  const siteSel = $("#cpSite"), catSel = $("#cpCat");
  if (!siteSel || !catSel) return;
  try {
    const resp = await fetch(apiUrl("/api/competitor/categories"));
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const d = await resp.json();
    CMP.cfg = d;
    siteSel.innerHTML = (d.sites || [])
      .map((s) => `<option value="${escapeHtml(s.code)}">${escapeHtml(s.label)}（${escapeHtml(s.host)}）</option>`).join("");
    catSel.innerHTML = (d.cats || [])
      .map((c) => `<option value="${escapeHtml(c.slug)}">${escapeHtml(c.cn)}</option>`).join("");
    setCpStatus(d.enabled ? "" : "竞品抓取已在服务端关闭（COMPETITOR_SCRAPE=0）—— 算法与提示词仍可用");
  } catch (e) {
    // 服务端不可达 ≠ 页面坏了：如实说清哪一半不可用
    setCpStatus("服务端不可达，竞品抓取不可用（" + e.message + "）。关键词算法与提示词拼装仍可本地使用。");
  }
}

async function loadCompetitorSubs(epoch) {
  const sub = $("#cpSub");
  if (!sub) return;
  const mine = epoch == null ? ++cmpEpoch : epoch;
  const site = $("#cpSite").value, slug = $("#cpCat").value;
  const s = (CMP.cfg?.sites || []).find((x) => x.code === site);
  sub.innerHTML = '<option value="">全部（不限定）</option>';
  // 站点表还没到手（比如 /api/competitor/categories 失败）就别硬拼 —— 否则拼出 https://undefined/…
  if (!s) return;
  try {
    const resp = await fetch(apiUrl("/api/competitor/subs?site=" + encodeURIComponent(site) + "&slug=" + encodeURIComponent(slug)));
    const d = await resp.json();
    if (mine !== cmpEpoch) return;          // 期间换过站点/类目：这份结果已经过期，丢掉
    if (!d.ok) return;
    for (const x of d.subs || []) {
      // href 既可能是相对路径，也可能是绝对 URL（跨域链接）—— 交给 URL 解析，别字符串硬拼，
      // 否则绝对地址会被拼成 https://www.amazon.comhttps://…
      let href;
      try { href = new URL(x.href, "https://" + s.host).toString(); } catch { continue; }
      const o = document.createElement("option");
      o.value = href;
      o.textContent = x.name;
      sub.appendChild(o);
    }
  } catch { /* 子类目抓不到不影响主流程，静默即可 —— 主列表已给出真实数据 */ }
}

async function fetchCompetitor() {
  if (CMP.busy) return;
  CMP.busy = true;
  const mine = ++cmpEpoch;                  // 这次抓取属于哪一代
  setCpStatus("正在抓取…（首次约 1–3 秒）");
  try {
    const qs = new URLSearchParams({ site: $("#cpSite").value, slug: $("#cpCat").value });
    const href = $("#cpSub").value;
    if (href) qs.set("href", href);
    // 🆕 页数：服务端会再夹一次（1–3），这里传上去只是表达意图
    const pages = Number($("#cpPages")?.value || 1);
    if (pages > 1) qs.set("pages", String(pages));
    const resp = await fetch(apiUrl("/api/competitor/bestsellers?" + qs.toString()));
    const d = await resp.json();
    if (mine !== cmpEpoch) return;          // 抓的过程中换了控件：这份结果已经不属于当前榜单
    if (!d.ok) throw new Error(d.error || "HTTP " + resp.status);
    CMP.items = d.items || [];
    CMP.rows = null;
    // 抓取成功后必须清掉上一轮的提示词产物与错误 —— 否则"抓到 30 条"和
    // "请先抓取竞品"会同时挂在屏幕上，自相矛盾，用户会以为工具坏了。
    CMP.prompt = "";
    const _pOut = $("#cpPromptOut");
    if (_pOut) _pOut.innerHTML = "";
    $("#cpKwWrap").style.display = "none";
    renderCompetitorItems();
    // 类目与产品名对不上时先提示一句（提示词里还有"产品对口校验"兜底，
    // 但 30 条全不对口等于白跑一轮，越早提醒越省事）。
    const _prod = ($("#cpProduct")?.value || "").trim();
    const _guess = _prod ? CK.detectCatSlug(_prod) : null;
    const _curCat = $("#cpCat").value;
    const _cn = (s) => ((CMP.cfg?.cats || []).find((x) => x.slug === s) || {}).cn || s;
    if (_guess && _guess !== _curCat) {
      const _box = $("#cpItems");
      if (_box) _box.insertAdjacentHTML("afterbegin",
        '<div class="note warn" style="margin:10px 0 0">⚠️ 产品名「' + escapeHtml(_prod) +
        "」更像「" + escapeHtml(_cn(_guess)) + "」类目的东西，当前抓的是「" + escapeHtml(_cn(_curCat)) +
        "」的榜单 —— 两边对不上时，抓来的词基本用不上，建议换类目重抓。</div>");
    }
    // 🔴 多页抓取的结果必须把「几页成功 / 去重几条 / 哪页失败」一起说出来。
    //    只说"抓到 87 条"会让用户以为 3 页都成功了。
    const pageBits = [];
    if (d.requestedPages > 1) {
      pageBits.push(`请求 ${d.requestedPages} 页 · 成功 ${d.pages} 页`);
      if (d.duplicates) pageBits.push(`跨页重复去重 ${d.duplicates} 条`);
      if (d.failedPages?.length) pageBits.push(`失败页 ${d.failedPages.map((f) => `第${f.page}页(${f.reason})`).join("、")}`);
    }
    setCpStatus("抓到 " + CMP.items.length + " 条 · " + (d.cached ? "来自 10 分钟缓存" : "实时") +
      (pageBits.length ? " · " + pageBits.join(" · ") : "") +
      " · " + new Date(d.fetchedAt).toLocaleTimeString());
    loadCompetitorSubs(mine);
  } catch (e) {
    if (mine !== cmpEpoch) return;          // 过期请求的失败不该盖掉当前状态
    CMP.items = [];
    CMP.rows = null;
    renderCompetitorItems();
    setCpStatus("抓取失败：" + e.message + "（如实报错，不会给你假数据 —— 换个类目或稍后再试）");
  } finally { CMP.busy = false; }
}

function renderCompetitorItems() {
  const box = $("#cpItems");
  if (!box) return;
  if (!CMP.items.length) {
    box.innerHTML = '<div class="note info" style="margin-top:10px">还没抓取。选好站点与类目后点「抓取竞品榜单」。</div>';
    return;
  }
  box.innerHTML = '<div style="margin-top:10px;overflow-x:auto"><table class="tbl">' +
    "<thead><tr><th>#</th><th>标题</th><th>星级</th><th>评论数</th><th>价格</th></tr></thead><tbody>" +
    CMP.items.map((x) =>
      "<tr><td class=\"num\">" + x.rank + "</td><td>" + escapeHtml(x.title) + "</td>" +
      "<td class=\"num\">" + (x.rating || "—") + "</td>" +
      "<td class=\"num\">" + (x.reviews ? x.reviews.toLocaleString() : "—") + "</td>" +
      "<td class=\"num\">" + escapeHtml(x.price || "—") + "</td></tr>").join("") +
    "</tbody></table></div>" +
    '<p class="hint" style="margin-top:6px">共 ' + CMP.items.length + " 条。评论数是亚马逊公开的销量代理指标（<b>从业者口径，非官方口径</b>）。价格里的「—」表示榜单页该商品未展示价格，<b>不是抓取失败</b>。</p>";
}

function analyzeCompetitor() {
  if (!CMP.items.length) { setCpStatus("先抓取竞品榜单（或先手动补标题）"); return; }
  const titles = CMP.items.map((x) => x.title);
  const product = ($("#cpProduct")?.value || "").trim();
  const r = CK.analyzeKeywords(titles, { productName: product, allTitles: titles });
  if (!r.ok) { setCpStatus(r.msg); return; }
  CMP.rows = r.rows;
  renderCompetitorKeywords(r);
  setCpStatus("关键词 " + r.rows.length + " 条 · 空白机会 " + r.blank.length + " 条（全文本地计算，未联网）");
}

function renderCompetitorKeywords(r) {
  const box = $("#cpKwOut"), wrap = $("#cpKwWrap");
  if (!box || !wrap) return;
  wrap.style.display = "";
  const row = (x) =>
    '<tr><td>' + escapeHtml(x.term) + '</td><td class="num">' + x.n + "</td>" +
    '<td class="num">' + x.useRate + "%</td><td class=\"num\">" + x.cov + "/" + x.total + "</td>" +
    '<td class="num">' + x.avgPos + "</td><td class=\"num\"><b>" + x.weight + "</b></td>" +
    "<td>" + escapeHtml(x.advice) + "</td></tr>";
  let html = '<div style="overflow-x:auto"><table class="tbl"><thead><tr>' +
    "<th>关键词</th><th>词长</th><th>使用率</th><th>条数</th><th>平均位置</th><th>权重</th><th>用法建议</th>" +
    "</tr></thead><tbody>" + r.rows.slice(0, 40).map(row).join("") + "</tbody></table></div>";
  if (r.blank.length) {
    html += '<div class="note info" style="margin-top:10px"><b>差异化机会（覆盖 ≤25% 但词够具体）</b>：' +
      r.blank.map((x) => escapeHtml(x.term)).join("、") + "</div>";
  }
  if (r.consistency) {
    const lv = r.consistency.level === "good" ? "g" : r.consistency.level === "warn" ? "a" : "r";
    html += '<div class="note ' + (r.consistency.level === "good" ? "info" : "warn") + '" style="margin-top:10px">' +
      '<b>一致性校验</b> <span class="chip ' + lv + '">' + r.consistency.score + "%</span> " +
      "在 " + r.consistency.sample + " 条竞品标题里，我的产品联想词的命中率。漏掉的：" +
      escapeHtml(r.consistency.miss.join("、") || "（无）") + "</div>";
  } else {
    html += '<div class="note warn" style="margin-top:10px">一致性校验<b>跳过</b>：产品名为空，或没匹配到本地联想词表。' +
      "（这一项依赖本地词表，不联网翻译 —— 所以英文产品名可能匹配不到，如实标跳过而不是算个假分。）</div>";
  }
  box.innerHTML = html;
}

function generateCompetitorPrompt() {
  const kind = $("#cpKind")?.value || "analysis";
  const ctx = cpCtx();
  const r = CP.buildCopyPrompt(kind, ctx);
  const out = $("#cpPromptOut");
  if (!r.ok) {
    CMP.prompt = "";
    if (out) out.innerHTML = '<div class="note warn">' + escapeHtml(r.error) + "</div>";
    setCpStatus("");
    return;
  }
  CMP.prompt = r.prompt;
  if (out) {
    out.innerHTML = '<div class="note info">' + escapeHtml(r.name) + " · <b>" + r.chars + "</b> 字符 · 竞品 " +
      r.meta.itemCount + " 条 · 权重词 " + r.meta.keywordCount + " 个 · 标题上限 " + r.meta.titleCap +
      "（媒体类目：" + (ctx.isMedia ? "是" : "否") + "）</div>" +
      '<pre class="code">' + escapeHtml(r.prompt) + "</pre>";
  }
  setCpStatus("");
}

async function copyCompetitorPrompt() {
  if (!CMP.prompt) { setCpStatus("先生成提示词"); return; }
  try {
    await navigator.clipboard.writeText(CMP.prompt);
    setCpStatus("已复制 " + CMP.prompt.length + " 字符到剪贴板");
  } catch {
    setCpStatus("浏览器不允许自动复制 —— 请手动选中上面的提示词复制");
  }
}

function sendCompetitorToCorpus() {
  if (!CMP.items.length) { setCpStatus("先抓取竞品榜单"); return; }
  const corpus = $("#lCorpus");
  if (!corpus) return;
  corpus.value = CMP.items.map((x) => x.title).join("\n---\n");
  // 产品名顺手从「Listing 生成器」带过来，省一次输入（只在当前为空时才带，不覆盖用户填的）
  const cpProd = $("#cpProduct");
  if (cpProd && !cpProd.value.trim() && $("#lName")?.value.trim()) cpProd.value = $("#lName").value.trim();
  setCpStatus("已把 " + CMP.items.length + " 条标题写进上方「竞品语料」—— 可以点那边的「挖掘关键词」做多竞品对比");
  corpus.scrollIntoView({ behavior: "smooth", block: "center" });
}

function bindCompetitor() {
  if (!$("#btnCpFetch")) return;
  const kindSel = $("#cpKind");
  if (kindSel) kindSel.innerHTML = CP.PROMPT_KINDS
    .map((k) => `<option value="${escapeHtml(k.id)}">${escapeHtml(k.name)}</option>`).join("");
  // 🔴 每个 button id 都必须真绑 —— selftest 有通用断言扫全页面，漏绑直接红
  $("#btnCpFetch")?.addEventListener("click", fetchCompetitor);
  $("#btnCpAnalyze")?.addEventListener("click", analyzeCompetitor);
  $("#btnCpToCorpus")?.addEventListener("click", sendCompetitorToCorpus);
  $("#btnCpGen")?.addEventListener("click", generateCompetitorPrompt);
  $("#btnCpCopy")?.addEventListener("click", copyCompetitorPrompt);
  // 🔴 三个「我要看哪个榜单」的控件都必须让旧结果失效。
  //    原来只有 #cpCat 绑了 change，而且只重置了 #cpSub —— 于是换完类目点「生成提示词」，
  //    提示词里写的是新类目、正文是旧类目的商品，用户根本看不出哪一半是错的。
  const _invalid = () => clearCompetitorResult("已切换榜单范围 —— 上一轮的榜单、关键词和提示词已清空，请重新抓取");
  $("#cpCat")?.addEventListener("change", () => { _invalid(); loadCompetitorSubs(); });
  $("#cpSite")?.addEventListener("change", () => { _invalid(); loadCompetitorSubs(); });
  $("#cpSub")?.addEventListener("change", () => { _invalid(); });
  renderCompetitorItems();
  loadCompetitorCategories();
}

/** 草稿会写到哪 5 个字段。写之前要比对、写之后要能撤，所以集中成一张表。 */
function draftFields(d) {
  return [
    ["lTitle", d.title || "", "标题"],
    ["lHighlights", d.highlights || "", "Item Highlights"],
    ["lBullets", (d.bullets || []).join("\n"), "五点"],
    ["lSearch", d.searchTerms || "", "Search Terms"],
    ["lDesc", d.description || "", "描述"],
  ];
}

/**
 * 会覆盖哪些字段：**已有内容且与将要写入的不同**才算冲突。
 * 相等不算冲突 —— 连点两次「生成草稿」不该第二次弹确认。
 */
function draftConflicts(d) {
  return draftFields(d)
    .filter(([id, next]) => {
      const cur = ($("#" + id)?.value || "").trim();
      return Boolean(cur) && cur !== String(next).trim();
    })
    .map(([, , label]) => label);
}

/**
 * 落盘到输入框。
 * @param {"fill"|"overwrite"} mode fill = 只补空白字段（默认，保留手改内容）
 */
function applyDraft(d, mode = "fill") {
  const before = snapshotForm();     // 写之前留一份旧值 —— "可撤销"的唯一依据
  let changed = false;
  for (const [id, next] of draftFields(d)) {
    const el = $("#" + id);
    if (!el) continue;
    if (mode === "fill" && String(el.value || "").trim()) continue;
    if (el.value !== next) { el.value = next; changed = true; }
  }
  if (changed) S.draftUndo = { fields: before, at: Date.now() };
  S.lastDraft = d;
  renderFieldCounters();
  saveFormNow();
  renderDraftPanel(d);
}

/** 撤销：把 5 个字段整体还原到生成之前的那一份快照。 */
function undoDraft() {
  const u = S.draftUndo;
  if (!u) return;
  for (const el of formEls()) {
    if (typeof u.fields[el.id] === "string") el.value = u.fields[el.id];
  }
  S.draftUndo = null;
  renderFieldCounters();
  saveFormNow();
  $("#draftOut").innerHTML = `<div class="note info">已撤销上一次生成，字段已还原到你原来的内容。</div>`;
}

/** 草稿摘要面板。标题上限**必须走 titleLimit(ctx)** —— 硬写 75 会让 media 类目同屏两个答案。 */
function renderDraftPanel(draft) {
  const ctx = lintCtx();
  const cap = L.titleLimit(ctx);
  const budgetCls = countFlag(draft.headlineChars, L.LIMITS.titleTotal);
  const titleLine = ctx.isMedia
    ? `${draft.title.length} / ${cap} 字符（media 类目，无「建议 ≤${L.LIMITS.titleStrict}」这一说）`
    : `${draft.title.length} / ${cap} 字符（建议 ≤${L.LIMITS.titleStrict}）`;
  const ok = Boolean((draft.title || "").trim());
  const head = ok
    ? "规则式草稿已生成。结构合规，但措辞仍需人工改写 —— 这是骨架，不是成稿。"
    : "还没填「产品名 / 核心词」—— 这是空骨架，不是合规草稿。";
  $("#draftOut").innerHTML = `
    <div class="note ${ok ? "info" : "warn"}">${escapeHtml(head)}</div>
    <table class="tbl">
      <tr><th style="width:150px">标题长度</th><td class="num">${escapeHtml(titleLine)}</td></tr>
      <tr><th>Item Highlights</th><td class="num">${draft.highlightsChars} / ${L.LIMITS.itemHighlights} 字符${draft.highlights ? "" : "（空 —— 需要你补材质/用途）"}${draft.highlightsDropped?.length ? `　<span class="chip r">挤出 ${draft.highlightsDropped.length} 段</span>` : ""}</td></tr>
      <tr><th>两段合计</th><td class="num"><span class="chip ${budgetCls}">${draft.headlineChars} / ${L.LIMITS.titleTotal} 字符</span>（标题 + Highlights 共享这一份额度）</td></tr>
      <tr><th>Search Terms</th><td class="num">${draft.searchTermsBytes} / ${L.LIMITS.searchTerms} 字节${draft.searchTermsDropped.length ? ` · 丢弃 ${draft.searchTermsDropped.length} 个（${draft.searchTermsDropped.map((d) => escapeHtml(d.term) + "：" + escapeHtml(d.why)).join("；")}）` : ""}</td></tr>
      <tr><th>商品描述</th><td class="num">${(draft.description || "").length} / ${L.LIMITS.description} 字符</td></tr>
      <tr><th>挖掘到的词</th><td>${draft.minedTerms.slice(0, 24).map((t) => `<span class="chip">${escapeHtml(t.term)}</span>`).join(" ") || "—"}</td></tr>
    </table>
    ${draft.highlightsDropped?.length ? `<div class="note warn" id="lHighlightsDropped"><b>Item Highlights 有 ${draft.highlightsDropped.length} 段被挤出（共 ${draft.highlightsDroppedChars} 字符）</b><br>${draft.highlightsDropped.map((d) => `${escapeHtml(d.text)} —— ${escapeHtml(d.why)}`).join("<br>")}</div>` : ""}
    <h3 style="margin-top:14px">A+ 内容骨架（7 屏）</h3>
    <table class="tbl">
      ${draft.aplus.map((a) => `<tr><th style="width:34px">${a.screen}</th><td><b>${escapeHtml(a.headline)}</b><div style="color:var(--slate-600);white-space:pre-wrap">${escapeHtml(a.body)}</div></td></tr>`).join("")}
    </table>
    <div class="note warn" style="margin-top:12px">${draft.notes.map(escapeHtml).join("<br>")}</div>
    ${S.draftUndo ? `<div class="rowline" style="margin-top:8px"><button class="btn ghost sm" id="btnDraftUndo">撤销这次生成（还原我原来的内容）</button></div>` : ""}`;
  const undo = $("#btnDraftUndo");
  if (undo) undo.onclick = undoDraft;
}

/**
 * 冲突时的三选一。**不用 window.confirm()**：它阻塞主线程、塞不下三个选项，
 * 也没法说明"哪些字段会被动"。
 */
function renderDraftConfirm(draft, labels) {
  $("#draftOut").innerHTML = `
    <div class="note warn">
      <b>这 ${labels.length} 个字段里已经有你写的内容，生成草稿会动它们：</b>${labels.map(escapeHtml).join("、")}
      <div style="margin-top:6px">选一种，再继续：</div>
    </div>
    <div class="rowline">
      <button class="btn primary sm" id="btnDraftFill">只补空白字段（保留我写的）</button>
      <button class="btn sm" id="btnDraftOver">全部覆盖</button>
      <button class="btn ghost sm" id="btnDraftCancel">取消</button>
    </div>`;
  const after = S.draftPending?.after || null;
  $("#btnDraftFill").onclick = () => { applyDraft(draft, "fill"); if (after) after(); };
  $("#btnDraftOver").onclick = () => { applyDraft(draft, "overwrite"); if (after) after(); };
  $("#btnDraftCancel").onclick = () => {
    $("#draftOut").innerHTML = `<div class="note info">已取消，你的内容一个字都没动。</div>`;
  };
}

/**
 * 生成草稿。
 * @param {{mode?: "fill"|"overwrite", after?: Function}} [opts]
 *   mode 显式给了就跳过确认（按钮回调里用）；after 在真正写入后执行（「生成并质检」用）。
 */
function generateDraft(opts = {}) {
  const features = $("#lFeatures").value.split("\n").map((s) => s.trim()).filter(Boolean);
  const keywords = $("#lKeywords").value.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
  const draft = L.generateListingDraft({
    brand: $("#lBrand").value.trim(),
    productName: $("#lName").value.trim(),
    primaryKeyword: $("#lKey").value.trim(),
    category: $("#lCategory").value.trim(),
    audience: $("#lAudience").value.trim(),
    sizeSpec: $("#lSize").value.trim(),
    quantity: $("#lQty").value.trim(),
    features,
    keywords,
    competitorText: $("#lCorpus").value,
  });
  const conflicts = draftConflicts(draft);
  if (conflicts.length && !opts.mode) {
    S.draftPending = { draft, after: typeof opts.after === "function" ? opts.after : null };
    renderDraftConfirm(draft, conflicts);
    return false;
  }
  applyDraft(draft, opts.mode || "fill");
  if (typeof opts.after === "function") opts.after();
  return true;
}

/**
 * 质检结果右侧的状态位。命中硬规则 → 必须改（圆圈叉），命中软规则 → 建议改（三角警示）。
 * 两者严格程度不同，**刻意不共用一张图**；文字原样保留（"必须改"/"建议改"/原 status）。
 */
function statusBadge(x) {
  if (x.status !== "命中") return `<div class="st">${escapeHtml(x.status)}</div>`;
  const hard = x.level === "P";
  return `<div class="st" style="display:inline-flex;align-items:center;gap:5px">${
    iconSvg(hard ? "x-circle" : "alert-triangle", 16)
  }<span>${hard ? "必须改" : "建议改"}</span></div>`;
}

/**
 * 上传前预校验面板。
 * 🔴 三层分开显示，因为它们的证据强度不同：硬缺口（一定传不上去）/ 建议改 / **本工具不检查**。
 *    第三层必须存在 —— 只给前两层会让人以为"绿了就能提交"。
 */
function precheckHtml(pre) {
  const lis = (arr) => arr
    .map((x) => `<li>${escapeHtml(x.label || x.field || "")}${x.why ? `：${escapeHtml(x.why)}` : `：${escapeHtml(String(x))}`}</li>`)
    .join("");
  return `
    <div class="note ${pre.ok ? "info" : "bad"}" style="margin-top:10px">
      <b>${pre.ok ? "文本字段已齐（仅指文本字段）" : `有 ${pre.blockers.length} 项硬缺口，现在传不上去`}</b>
      ${pre.blockers.length ? `<ul style="margin:6px 0 0 18px">${lis(pre.blockers)}</ul>` : ""}
      ${pre.warnings.length ? `<div style="margin-top:8px"><b>建议改（不阻塞上传）</b><ul style="margin:4px 0 0 18px">${lis(pre.warnings)}</ul></div>` : ""}
    </div>
    <div class="note warn" style="margin-top:8px">
      <b>本工具不检查这几项（上传前自己核）</b>
      <ul style="margin:6px 0 0 18px">${pre.externals.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>
      <div style="margin-top:6px">${escapeHtml(pre.note)}</div>
    </div>`;
}

function renderPrecheck(pre) {
  const el = $("#csvOut");
  if (el) el.innerHTML = precheckHtml(pre);
}

/** 真正落盘的那一步。**导出前必须先过 precheck**，这里是唯一的出口，
 *  这样"拦住"与"仍然导出"两条路都走同一份导出代码，不会出现两份实现。 */
function doExportCsv(pre) {
  const out = L.exportFlatFileCsv(S.listing, lintCtx());
  downloadText(out.filename, out.csv);
  S.lastCsvNote = out.note;
  const el = $("#csvOut");
  if (el) el.innerHTML = `<div class="note warn" style="margin-top:8px">已导出 <code>${escapeHtml(out.filename)}</code>（列：${out.columns.map(escapeHtml).join(" · ")}）<br>${escapeHtml(out.note)}</div>${precheckHtml(pre)}`;
}

/* ─────────────────────── 体检报告（单文件 HTML）───────────────────────
 * 为什么是 HTML 而不是 JSON/PDF：
 *   JSON 给不了非技术同事看；PDF 要引第三方库（本项目零依赖）。
 *   单文件 HTML 可以直接微信转发、双击打开、也能打印成 PDF。
 * 🔴 报告里必须带**边界声明**：这份东西查的是文本，不查 UPC / 价格 / 库存 / 主图，
 *    也不是平台官方评分。不写这句，"全绿"会被当成"可以上架 + 会有流量"。
 */
function healthReportHtml() {
  const listing = currentListing();
  const ctx = lintCtx();
  const lint = L.lintListing(listing, ctx);
  const rufus = lintRufus(listing, rufusCtx());
  const cov = S.coverage || null;
  const fieldsOut = L.exportListingFields(listing, ctx);
  const sc = scoreListing({ lint, rufus, coverage: cov, listing, fields: fieldsOut.fields });
  const name = ($("#lName")?.value || "").trim() || listing.title || "未命名";
  const when = new Date().toLocaleString("zh-CN");
  const esc = escapeHtml;
  const cls = (x) => (x.status === "命中" ? (x.level === "P" ? "bad" : "warn") : x.status === "通过" ? "ok" : "skip");
  const lintRows = lint.results
    .map((x) => `<tr class="${cls(x)}"><td class="id">${esc(x.id)}</td><td>${esc(x.scope)}</td><td class="st">${esc(x.status)}</td><td>${esc(x.detail)}</td></tr>`)
    .join("");
  const rufusRows = rufus.results
    .map((x) => `<tr class="${cls(x)}"><td class="id">${esc(x.id)}</td><td>${esc(x.group || "")}</td><td class="st">${esc(x.status)}</td><td>${esc(x.detail)}</td></tr>`)
    .join("");
  const covSection = cov
    ? `<h2>四、关键词覆盖度</h2>
       <p class="muted">共 ${cov.total} 个词，覆盖 ${cov.covered ?? "—"} 个（${cov.coveragePct ?? "—"}%）。这只测<b>文本覆盖</b>，不是搜索排名，也不是搜索量。</p>
       <table><thead><tr><th>关键词</th><th>标题</th><th>五点</th><th>描述</th><th>后台词</th><th>建议</th></tr></thead><tbody>
       ${cov.rows.slice(0, 60).map((r) => `<tr><td>${esc(r.term)}</td><td>${r.title ? "有" : "—"}</td><td>${r.bullets ? "有" : "—"}</td><td>${r.description ? "有" : "—"}</td><td>${r.searchTerms ? "有" : "—"}</td><td>${esc(r.advice || "")}</td></tr>`).join("")}
       </tbody></table>`
    : `<h2>四、关键词覆盖度</h2><p class="muted">本次未运行覆盖度分析（在「文案与质检」视图点「关键词覆盖度分析」后重新导出即可包含）。</p>`;
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Listing 体检报告 · ${esc(name)}</title>
<style>
  :root{--ink:#1f2937;--muted:#6b7280;--line:#e5e7eb;--bad:#b42318;--warn:#b54708;--ok:#067647}
  *{box-sizing:border-box}
  body{margin:0;padding:32px 20px;font:14px/1.65 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink);background:#f8fafc}
  main{max-width:920px;margin:0 auto;background:#fff;border:1px solid var(--line);border-radius:12px;padding:28px 30px}
  h1{font-size:20px;margin:0 0 6px} h2{font-size:16px;margin:26px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
  .meta{color:var(--muted);font-size:12px;margin-bottom:18px}
  .kpi{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0}
  .kpi div{flex:1 1 120px;border:1px solid var(--line);border-radius:8px;padding:8px 10px}
  .kpi b{display:block;font-size:18px} .kpi span{color:var(--muted);font-size:12px}
  .verdict{border-left:3px solid var(--ink);padding:8px 12px;background:#f9fafb;margin:10px 0}
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
  th{background:#f3f4f6;font-weight:600}
  td.id{font-family:ui-monospace,Consolas,monospace;white-space:nowrap}
  tr.bad td.st{color:var(--bad);font-weight:600}
  tr.warn td.st{color:var(--warn);font-weight:600}
  tr.ok td.st{color:var(--ok)}
  tr.skip td.st{color:var(--muted)}
  .muted{color:var(--muted);font-size:12.5px}
  .box{border:1px solid var(--line);border-radius:8px;padding:10px 12px;background:#fffbeb;margin-top:10px;font-size:12.5px}
  ul{margin:6px 0 0 18px;padding:0} li{margin:3px 0}
  @media print{body{background:#fff;padding:0}main{border:0;border-radius:0}}
</style></head><body><main>
  <h1>Listing 体检报告 · ${esc(name)}</h1>
  <div class="meta">生成时间 ${esc(when)} · 品牌 ${esc(ctx.brand || "未填")} · 核心词 ${esc(ctx.primaryKeyword || "未填")} · 口径 ${ctx.isMedia ? "media（标题 200 = 75 + 125）" : "普通类目（标题 75 / Highlights 125 / 合计 200）"}</div>

  <div class="kpi">
    <div><b>${sc.score == null ? "—" : sc.score}</b><span>健康分（项目自定义，非官方）</span></div>
    <div><b>${lint.summary.hitP}</b><span>硬规则命中</span></div>
    <div><b>${lint.summary.hitC}</b><span>软规则命中</span></div>
    <div><b>${lint.summary.checked - lint.summary.hit}</b><span>通过</span></div>
    <div><b>${lint.summary.skipped + lint.summary.errored}</b><span>未判定（跳过/异常）</span></div>
  </div>
  <div class="verdict"><b>健康分：</b>${sc.score == null ? "算不出（缺质检结果）" : `${esc(sc.grade)} 档 · ${sc.score}/100 —— ${esc(sc.gradeLabel)}`}
    <div class="muted" style="margin-top:4px">${esc(sc.disclaimer)} ${esc(sc.note)}${sc.cap ? ` ${esc(sc.cap.reason)}` : ""}</div></div>
  <table><thead><tr><th>维度</th><th>得分</th><th>依据</th></tr></thead><tbody>
  ${sc.dims.map((d) => `<tr><td>${esc(d.label)}</td><td>${d.status === "scored" ? `${d.earned} / ${d.max}` : `— / ${d.max}`}</td><td>${esc(d.basis || "")}</td></tr>`).join("")}
  </tbody></table>
  ${sc.top3.length ? `<div class="box"><b>先改这三条</b><ul>${sc.top3.map((d) => `<li><b>${esc(d.ruleId)}</b>（${d.delta}）${esc(d.detail || d.why || "")}${d.fix ? `<br>怎么改：${esc(d.fix)}` : ""}</li>`).join("")}</ul></div>` : ""}
  <div class="verdict"><b>文案质检结论：</b>${esc(lint.summary.conclusion)}</div>
  <div class="verdict"><b>信息架构（${esc(RUFUS_NAMING.current)}）结论：</b>${esc(rufus.summary.conclusion)}</div>

  <h2>一、字段填写情况</h2>
  <table><thead><tr><th>字段</th><th>已用 / 上限</th><th>状态</th></tr></thead><tbody>
  ${L.exportListingFields(listing, ctx).fields.map((f) => `<tr><td>${esc(f.label)}</td><td>${f.used} / ${f.limit} ${esc(f.unit)}</td><td>${f.empty ? "空" : f.over ? "超限" : "正常"}</td></tr>`).join("")}
  </tbody></table>

  <h2>二、文案质检明细（${lint.summary.total} 条）</h2>
  <table><thead><tr><th>规则</th><th>作用域</th><th>状态</th><th>说明</th></tr></thead><tbody>${lintRows}</tbody></table>

  <h2>三、信息架构检查明细（${rufus.summary.total} 条）</h2>
  <table><thead><tr><th>规则</th><th>分组</th><th>状态</th><th>说明</th></tr></thead><tbody>${rufusRows}</tbody></table>

  ${covSection}

  <h2>五、这份报告不覆盖什么</h2>
  <div class="box">
    <b>只覆盖文本字段。</b>以下项目必须在上架前自己核对，本工具不生成也不校验：
    <ul>
      <li>external_product_id（UPC / EAN / GTIN）或品牌备案豁免</li>
      <li>类目节点 / product_type（决定模板列名与必填属性）</li>
      <li>价格、币种、库存（quantity）</li>
      <li>主图 slot 1 与其它图片（本工具只出 Prompt，不产出成图）</li>
      <li>类目相关合规文件（儿童品 CPC / 化妆品 FDA / 电池 UN38.3 等）</li>
    </ul>
    <div style="margin-top:8px">另外：本报告是<b>基于公开规则的启发式检查</b>，<b>不是平台官方评分，也不预测排名或流量</b>。全绿只意味着"没查出明显问题"，不等于"上架就会有曝光"。</div>
  </div>
  <p class="muted" style="margin-top:22px">由「跨境 Listing 质检工作台」生成 · 规则在本地代码里跑，文案不上传任何服务器。</p>
</main></body></html>`;
}


/* ─────────────────────── 健康分（聚合层）───────────────────────
 * 它**不新增任何判据**：分数完全由既有规则的结果推出来（lint + rufus + coverage + 字段用量）。
 * 这一点是刻意的 —— 如果健康分自己再判一遍，就会出现"分很低但找不到哪条规则命中"的死胡同。
 *
 * 🔴 三件事界面必须做到：
 *   1. 分旁边写明「项目自定义权重，不是亚马逊官方评分」；
 *   2. **扣分项必须可点开看到规则 id / 为什么 / 怎么改**，只给分数等于不给信息；
 *   3. 缺数据的维度显示"—"并说明原因，不按 0 分算，也不偷偷按满分算。
 */

/** 现算一份快照：文案 + 上下文 + 质检 + 信息架构 + 字段用量。 */
function scoreInputs() {
  const listing = currentListing();
  const ctx = lintCtx();
  return {
    listing,
    ctx,
    lint: L.lintListing(listing, ctx),
    rufus: lintRufus(listing, rufusCtx()),
    fields: L.exportListingFields(listing, ctx).fields,
  };
}

function renderHealthScore(inputs) {
  const card = $("#scoreCard");
  if (!card) return null;
  const pack = inputs || scoreInputs();
  const r = scoreListing({
    lint: pack.lint, rufus: pack.rufus, coverage: S.coverage,
    listing: pack.listing, fields: pack.fields,
  });
  S.lastScore = r;
  card.hidden = false;

  const grade = $("#scoreGrade");
  if (grade) grade.textContent = r.score == null ? "算不出" : `${r.grade} · ${r.score} 分`;
  const tone = r.score == null ? "skip" : r.score >= 90 ? "good" : r.score >= 75 ? "ok" : r.score >= 60 ? "warn" : "bad";

  const dimRows = r.dims.map((d) => {
    const pct = d.status === "scored" ? Math.max(0, Math.min(100, (d.earned / d.max) * 100)) : 0;
    return `<div class="srow ${d.status === "skipped" ? "skip" : ""}" title="${escapeHtml(d.hint || "")}｜${escapeHtml(d.basis || "")}">
      <span class="sname">${escapeHtml(d.label)}</span>
      <span class="sbar"><i class="${pct >= 90 ? "g" : pct >= 60 ? "o" : "b"}" style="width:${pct.toFixed(1)}%"></i></span>
      <span class="sval">${d.status === "scored" ? `${d.earned} / ${d.max}` : `— / ${d.max}`}</span>
    </div>${d.status === "skipped" ? `<div class="snote">${escapeHtml(d.basis || "未参与计分")}</div>` : ""}`;
  }).join("");

  const top3 = r.top3.length
    ? `<div class="stop3">
        <div class="sth">先改这三条（按扣分从大到小）</div>
        <ol>${r.top3.map((d) => `<li>
          <b>${escapeHtml(d.ruleId)}</b>
          <span class="sdelta">${d.delta}</span>
          <div class="swhy">${escapeHtml(d.detail || d.why || "")}</div>
          ${d.fix ? `<div class="sfix">怎么改：${escapeHtml(d.fix)}</div>` : ""}
          <div class="ssrc">来源：${escapeHtml(d.source || "—")}</div>
        </li>`).join("")}</ol>
      </div>`
    : `<div class="note info" style="margin-top:8px">没有扣分项 —— 已计分的维度都是满分。这不等于"能上架"：图片、类目、资质不在文本检查范围内。</div>`;

  $("#scoreOut").innerHTML = `
    <div class="score-top">
      <div class="score-num ${tone}"><b>${r.score == null ? "—" : r.score}</b><span>/100</span></div>
      <div class="score-meta">
        <b>${r.score == null ? "算不出分" : `${escapeHtml(r.grade)} · ${escapeHtml(r.gradeLabel)}`}</b>
        <div class="hint" style="margin:4px 0 0">${escapeHtml(SCORE_DISCLAIMER)}</div>
      </div>
    </div>
    ${r.cap ? `<div class="note ${r.cap.applied === false ? "info" : "bad"}" style="margin-top:8px">${escapeHtml(r.cap.reason)}${r.cap.applied === false ? `（未触发封顶：原始分 ${r.cap.before}）` : `（原始分 ${r.cap.before} → 封顶 ${r.cap.score}）`}</div>` : ""}
    <div class="sdims">${dimRows}</div>
    ${top3}
    <div class="hint" style="margin-top:8px">${escapeHtml(r.note)}</div>`;
  return r;
}

function runLint() {
  S.listing = currentListing();
  const r = L.lintListing(S.listing, lintCtx());
  const s = r.summary;
  const cls = s.hitP > 0 ? "bad" : s.hitC > 0 ? "warn" : "good";
  const SCOPE_LABEL = {
    title: "标题", bullets: "五点", searchTerms: "搜索词",
    highlights: "Item Highlights",
    titleHighlights: "标题 + Item Highlights",
    copy: "标题+五点+亮点",
  };
  $("#lintOut").innerHTML = `
    <div class="kpi">
      <div class="k ${cls}"><b>${s.hitP}</b><span>硬规则命中</span></div>
      <div class="k ${s.hitC > 0 ? "warn" : "good"}"><b>${s.hitC}</b><span>软规则命中</span></div>
      <div class="k good"><b>${s.checked - s.hit}</b><span>通过</span></div>
      <div class="k" title="前提不足（字段为空 / 缺品牌或核心关键词），没有判定"><b>${s.skipped}</b><span>跳过 · 未判定</span></div>
      ${s.errored ? `<div class="k bad" title="规则自身执行异常，结论未知"><b>${s.errored}</b><span>异常 · 未判定</span></div>` : ""}
    </div>
    <div class="note ${s.hitP ? "bad" : s.hitC ? "warn" : "info"}"><b>${escapeHtml(s.conclusion)}</b></div>
    ${r.results.map((x) => `
      <div class="rule ${x.status === "通过" ? "pass" : x.status === "命中" ? "hit" : "skip"}">
        <div class="id">${x.id}</div>
        <div class="body">
          <b>${escapeHtml(SCOPE_LABEL[x.scope] || x.scope)} · ${escapeHtml(x.detail)}</b>
          <div class="why">${escapeHtml(x.why)}</div>
          ${x.fix ? `<div class="fix">怎么改：${escapeHtml(x.fix)}</div>` : ""}
          <div class="src">来源：${escapeHtml(x.source)}</div>
        </div>
        ${statusBadge(x)}
      </div>`).join("")}`;
  // 每次质检后重算健康分：分数必须跟当前文案同步，否则它就是在展示一个过期结论。
  renderHealthScore({ listing: S.listing, ctx: lintCtx(), lint: r, rufus: lintRufus(S.listing, rufusCtx()), fields: L.exportListingFields(S.listing, lintCtx()).fields });
}

/* ─────────────── ⑥ Rufus 信息架构检查（准入层）───────────────
 * 与 ⑤ 的「引用层」质检并列，但判定口径完全不同：⑤ 问「文案合不合规」，
 * ⑥ 问「能不能被 Rufus 纳入结构化比对」（字段空没空 / 事实自不自洽 / 单位混不混 /
 * 高频问题有没有答案 / 图里的字文本化了没）。
 * 🔴 三条「界面不许说假话」的硬要求（SPEC §8 / AC-04）：
 *   1. 跳过项必须可见且带 detail 原因 —— 藏起来 = 让用户以为全通过。
 *   2. 结论文案**只有** summary.conclusion 一个来源，界面不另写"通过 / 不通过"。
 *   3. level === "P" 才可以说"必须改"；R2/R3/R4/R5 全 C 级，用引擎自己的话呈现，
 *      不许把"证据强度不足以报必须改"渲染成"错误"。
 */

/** 产品类型下拉的选项来自数据层（CATEGORY_ATTRIBUTES 的 key + label），不在这里硬编码第二份。 */
function fillRufusProductTypes() {
  const sel = $("#rProductType");
  if (!sel || sel.dataset.filled) return;
  sel.insertAdjacentHTML(
    "beforeend",
    Object.entries(CATEGORY_ATTRIBUTES)
      .map(([key, def]) => `<option value="${escapeHtml(key)}">${escapeHtml(def.label)}</option>`)
      .join(""),
  );
  sel.dataset.filled = "1";
}

/** ctx：productType 取类目键；imageText 是用户手打的「图上有什么字」（按行拆、去空，不做 OCR）。 */
function rufusCtx() {
  return {
    productType: ($("#rProductType")?.value || "").trim() || undefined,
    imageText: ($("#rImageText")?.value || "").split("\n").map((s) => s.trim()).filter(Boolean),
  };
}

/**
 * ⑥ 的状态位。与 ⑤ 的 statusBadge **刻意不同**：⑤ 把软命中叫「建议改」，而
 * R2/R3/R4/R5 是"证据强度不足以报必须改"的线索（R4 更是「只作线索、不作待办」），
 * 叫「建议改」会把线索说成待办。所以这里 C 级命中只说引擎自己的词「命中」。
 */
function rufusBadge(x) {
  if (x.status === "命中") {
    const hard = x.level === "P";
    return `<div class="st" style="display:inline-flex;align-items:center;gap:5px">${
      iconSvg(hard ? "x-circle" : "alert-triangle", 16)
    }<span>${hard ? "必须改" : "命中"}</span></div>`;
  }
  return `<div class="st">${escapeHtml(x.status)}</div>`;
}

/** 行样式：只有 P 级命中用红色（= 错误量级）；C 级命中与「通过（部分）」用琥珀，绝不渲染成"错误"。 */
function rufusRowClass(x) {
  if (x.status === "通过") return "pass";
  if (x.status === "跳过") return "skip";
  if (x.status === "命中") return x.level === "P" ? "hit" : "soft";
  return "soft"; // 通过（部分）
}

function renderRufus() {
  const out = $("#rufusOut");
  if (!out) return;
  fillRufusProductTypes();
  const r = lintRufus(currentListing(), rufusCtx());
  const s = r.summary;
  const cnt = (p) => r.results.filter(p).length;
  const pass = cnt((x) => x.status === "通过");
  const partial = cnt((x) => x.status === "通过（部分）");
  const skipped = cnt((x) => x.status === "跳过");
  const hitP = cnt((x) => x.status === "命中" && x.level === "P");
  const hitC = cnt((x) => x.status === "命中" && x.level === "C");
  // 口径分档按两档（official / practitioner）—— 用户不需要理解 guide 与 schema 的区别。
  const offHit = cnt((x) => x.status === "命中" && x.sourceTier === "official");
  const pracHit = cnt((x) => x.status === "命中" && x.sourceTier === "practitioner");

  const tierChip = (t) =>
    `<span class="chip" title="口径强度：官方明文 vs 从业者口径">${
      t === "official" ? "官方口径" : "从业者口径"
    }</span>`;

  const row = (x) => `
    <div class="rule ${rufusRowClass(x)}">
      <div class="id">${escapeHtml(x.id)}</div>
      <div class="body">
        <b>${escapeHtml(x.detail)}</b>
        <div class="why">${escapeHtml(x.why)}</div>
        <div class="src">来源：${escapeHtml(x.source)} ${tierChip(x.sourceTier)}</div>
      </div>
      ${rufusBadge(x)}
    </div>`;

  // 分组：规则名只能来自 RUFUS_GROUPS（results[i] 里没有 title），不许自编。
  const groups = RUFUS_GROUPS.map((g) => {
    const list = r.results.filter((x) => x.group === g.id);
    if (!list.length) return "";
    const b = s.byGroup[g.id] || { total: 0, hit: 0, pass: 0, partial: 0, skipped: 0, covered: 0, miss: 0 };
    // R4 是「覆盖型」组：用引擎自己的 covered / miss 说「已覆盖 / 未覆盖」，
    // 绝不把「通过（部分）」并进"通过"（部分覆盖必须自己露面，不许显示成通过）。
    const head =
      g.id === "R4"
        ? `<span class="chip">共 ${b.total}</span><span class="chip g">已覆盖 ${b.covered}</span><span class="chip${b.miss ? " r" : ""}">未覆盖 ${b.miss}</span><span class="chip">跳过 ${b.skipped}</span>`
        : `<span class="chip">共 ${b.total}</span><span class="chip${b.hit ? " r" : ""}">命中 ${b.hit}</span><span class="chip g">通过 ${b.pass}</span>${b.partial ? `<span class="chip a">部分 ${b.partial}</span>` : ""}<span class="chip">跳过 ${b.skipped}</span>`;
    return `<div class="rgroup">
      <div class="rgroup-h"><b>${g.id} · ${escapeHtml(g.name)}</b>${head}</div>
      ${list.map(row).join("")}
    </div>`;
  }).join("");

  out.innerHTML = `
    <div class="kpi">
      <div class="k ${hitP ? "bad" : "good"}"><b>${hitP}</b><span>硬规则命中 · 必须改</span></div>
      <div class="k ${hitC ? "warn" : "good"}"><b>${hitC}</b><span>软规则命中 · C 级</span></div>
      <div class="k good"><b>${pass}</b><span>通过</span></div>
      <div class="k${partial ? " warn" : ""}"><b>${partial}</b><span>通过（部分覆盖）</span></div>
      <div class="k"><b>${skipped}</b><span>跳过 · 附原因</span></div>
    </div>
    <div class="note ${hitP ? "bad" : hitC ? "warn" : "info"}"><b>${escapeHtml(s.conclusion)}</b>
      <div style="margin-top:4px;color:var(--slate-600)">共 ${s.total} 条判定 · 命中 ${s.hit} · 跳过 ${s.skipped}；口径分档：官方 ${offHit} / 从业者 ${pracHit}。结论文案由引擎给出，界面不另写一套"通过 / 不通过"。</div>
    </div>
    ${groups}`;
}

/**
 * 关键词覆盖度分析 —— 逐词检查它落在标题／五点／描述／后台词哪几处。
 * 🔴 这一块只做**文本覆盖**判定：不查搜索排名、不估搜索量。
 *    它的价值是抓「竞品在打的核心词，我一个字都没提」这类低级漏失。
 */
function runCoverage() {
  S.listing = currentListing();
  const corpus = ($("#lCorpus")?.value || "").trim();
  // 多个竞品（--- 分隔）时用 competitors 传进去，coveredBy 才能指出"是哪个竞品在打这个词"；
  // 单个竞品仍走旧的 competitorText 字段（两条路都保留，向后兼容）。
  const multi = /\n\s*[-=]{3,}\s*\n/.test(corpus);
  const r = L.analyzeCoverage(S.listing, {
    keywords: ($("#lKeywords")?.value || "").trim(),
    competitorText: multi ? "" : ($("#lCorpus")?.value || "").trim(),
    competitors: multi ? corpus : undefined,
    lang: $("#lLang")?.value || "",
    top: 30,
  });

  if (!r.total) {
    // 🔴 没词可分析时必须**清掉上一次的覆盖度**：留着它，健康分就会拿一份
    //    跟当前文案无关的旧结果去算分（而且看起来毫无异常）。
    S.coverage = null;
    $("#coverOut").innerHTML = `<div class="note info" style="margin-top:12px">没有可分析的词 —— 先在 ③ 卡填「自定义关键词」，或把竞品文案粘进「竞品 / 类目语料」。</div>`;
    if (S.lastScore) renderHealthScore();
    return;
  }
  saveArtifact("coverage", `覆盖度 · ${($("#lName")?.value || "").trim() || "未命名"}`, r, {
    coveragePct: r.coveragePct, rules: r.total,
  });
  // 体检报告要用：存一份最近一次结果（不持久化，只是同一次会话内复用）
  S.coverage = r;
  // 🔴 搜索量是**附加列**，不参与判定：覆盖度仍然只回答「这个词有没有出现在文案里」。
  //    导入过的 CSV 能把量并进来，是为了排序与取舍（先补哪几个缺口），不是为了让覆盖率变好看。
  const vol = S.csvImport && S.csvImport.rows.length
    ? withVolumes(r.rows, S.csvImport, { sourceName: S.csvImport.sourceName, source: S.csvImport.source })
    : null;
  const withVol = Boolean(vol && S.csvImport.volumeColumn);
  const mark = (v) => (v ? "✓" : "—");
  const head = `<tr><th>关键词</th>${withVol ? "<th>搜索量</th>" : ""}<th>标题</th><th>五点</th><th>描述</th><th>后台词</th><th>竞品</th><th>建议动作</th></tr>`;
  const rows = (vol ? vol.rows : r.rows).map((x) => `<tr>
      <td><b>${escapeHtml(x.term)}</b></td>
      ${withVol ? `<td class="num">${x.volume == null
        ? "—"
        : `${x.volume.toLocaleString("en-US")}${x.volumeSuspect ? " <span title=\"列数比表头多，可能是千分位逗号没加引号\">?</span>" : ""}`}</td>` : ""}
      <td class="num">${mark(x.hit.title)}</td>
      <td class="num">${mark(x.hit.bullets)}</td>
      <td class="num">${mark(x.hit.description)}</td>
      <td class="num">${mark(x.hit.searchTerms)}</td>
      <td class="num">${x.competitor === null ? "—" : mark(x.competitor)}</td>
      <td>${escapeHtml(x.action)}</td>
    </tr>`).join("");

  $("#coverOut").innerHTML = `
    <div class="kpi" style="margin-top:12px">
      <div class="k ${r.gaps.length ? "bad" : "good"}"><b>${r.gaps.length}</b><span>竞品有、我没有</span></div>
      <div class="k ${r.weak.length ? "warn" : "good"}"><b>${r.weak.length}</b><span>只在后台词</span></div>
      <div class="k"><b>${r.coveragePct}%</b><span>覆盖率 ${r.covered}/${r.total}</span></div>
      <div class="k"><b>${r.minedCount}</b><span>竞品语料挖出词数</span></div>
    </div>
    <div class="note ${r.gaps.length ? "bad" : "info"}"><b>${r.gaps.length
      ? "优先补这几个词（竞品已覆盖、我完全没有）：" + escapeHtml(r.gaps.slice(0, 8).join(" / "))
      : "你选的候选词里，没有「竞品在打、我完全没提」的。"}</b></div>
    ${r.minedGaps.length ? `<div class="note info">竞品语料里还有这些我没覆盖的词，<b>只当线索看</b>
      （其中混有 n-gram 片段，不是待办清单）：<br>${r.minedGaps.slice(0, 24).map((w) => `<span class="chip">${escapeHtml(w)}</span>`).join(" ")}
      ${r.minedGaps.length > 24 ? `<br>…共 ${r.minedGaps.length} 个` : ""}</div>` : ""}
    ${withVol
      ? `<div class="tbl-scroll"><table>${head}${rows}</table></div>`
      : `<table>${head}${rows}</table>`}
    ${vol && S.csvImport.volumeColumn ? `<div class="note info" style="margin-top:8px">搜索量来自 <b>${escapeHtml(vol.sourceLabel)}</b>（你导入的文件，不是本工具估算的）。
      这一列的 ${r.total} 个候选词里匹配上 ${vol.matched} 个，其余留空而不是按 0 处理。表里带 <b>?</b> 的那几行是「列数比表头多」——
      多半是千分位逗号没加引号，数值存疑。</div>` : ""}
    <div class="note info" style="margin-top:10px">${escapeHtml(r.note)}<br>${escapeHtml(r.source)}</div>`;
  // 覆盖度是健康分的一个维度：跑完就重算，别让分数停在上一次的状态。
  if (S.lastScore) renderHealthScore();
}

/* ─────────────── 竞品关键词 CSV 导入（P2-4）───────────────
 * 只做「读用户自己导出的表 + 把搜索量并成一列」。
 * 🔴 不做：不去抓、不估算、不把搜索量当成本工具的结论 —— 界面与导出都标来源。
 */

async function onCsvFile(ev) {
  const f = ev.target.files && ev.target.files[0];
  if (!f) return;
  let text = "";
  try {
    text = await f.text();
  } catch (e) {
    $("#csvStatus").textContent = `读不了这个文件：${e.message}`;
    return;
  }
  const r = importKeywordCsv(text, { sourceName: f.name });
  S.csvImport = r;
  $("#csvStatus").textContent = r.rows.length ? `${f.name} · ${r.rows.length} 词` : `${f.name} · 0 词`;
  renderCsvImport(r);
  // 重置选择框：同一个文件改过之后再选，不清空就不会触发 change
  ev.target.value = "";
}

function renderCsvImport(r) {
  const box = $("#csvImportOut");
  if (!box) return;
  if (!r.rows.length) {
    box.innerHTML = `<div class="note bad">${r.problems.map(escapeHtml).join("<br>")}</div>`;
    return;
  }
  const roleName = { keyword: "关键词", volume: "搜索量", asin: "ASIN" };
  const map = (r.matched || [])
    .map((m) => `<span class="chip">${roleName[m.role] || m.role} ← ${escapeHtml(m.header)}</span>`)
    .join(" ");
  const sample = r.rows.slice(0, 5).map((x) => `<tr>
      <td>${escapeHtml(x.keyword)}</td>
      <td class="num">${x.volume == null ? "—" : x.volume.toLocaleString("en-US")}${x.volumeSuspect ? " ?" : ""}</td>
    </tr>`).join("");
  box.innerHTML = `
    <div class="note ${r.problems.length ? "warn" : "info"}">
      <b>${escapeHtml(r.sourceName || "CSV")}</b> · 识别为 ${escapeHtml(r.source)} · 分隔符 ${r.delimiter === "\t" ? "制表符" : `「${escapeHtml(r.delimiter)}」`} · 读入 <b>${r.rows.length}</b> 词
      ${r.truncated ? `<br>已按上限截断（原始 ${r.total} 行）` : ""}
      ${map ? `<br>${map}` : ""}
      ${r.unknownColumns.length ? `<br>未使用的列：${escapeHtml(r.unknownColumns.slice(0, 8).join(" / "))}` : ""}
      ${r.problems.map((p) => `<br>⚠️ ${escapeHtml(p)}`).join("")}
      ${r.note ? `<br>${escapeHtml(r.note).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")}` : ""}
    </div>
    <table style="max-width:420px"><tr><th>关键词</th><th>搜索量</th></tr>${sample}</table>
    <div class="rowline" style="margin-top:8px">
      <button class="btn sm" id="btnCsvUse">把这批词填进「自定义关键词」</button>
      <span class="hint" style="margin:0">填进去后跑覆盖度分析，表里会多一列搜索量（只作排序依据，不参与判定）</span>
    </div>`;
  $("#btnCsvUse")?.addEventListener("click", useCsvKeywords);
}

function useCsvKeywords() {
  const imported = (S.csvImport && S.csvImport.rows) || [];
  if (!imported.length) return;
  // 词表可能有几千行，而覆盖矩阵本来只分析 top 30。按搜索量取前 200 个填进去，
  // 剩下的留在导入结果里（不丢数据，只是不铺满输入框）。
  const all = keywordList(imported);
  const ordered = imported.slice().sort((a, b) => (b.volume || 0) - (a.volume || 0)).map((r) => r.keyword).filter(Boolean);
  const picked = (ordered.length ? ordered : all).slice(0, 200);
  const el = $("#lKeywords");
  const existing = el.value.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
  const seen = new Set(existing.map((s) => s.toLowerCase()));
  const add = picked.filter((k) => !seen.has(k.toLowerCase()));
  el.value = [...existing, ...add].join(", ");
  el.dispatchEvent(new Event("input", { bubbles: true }));
  $("#csvStatus").textContent = `已填入 ${add.length} 个新词（原有 ${existing.length} 个，文件共 ${all.length} 个）`;
  runCoverage();
}

/* ─────────────── A+ 模块骨架（P2-1）─────────────── */

function runAplus() {
  const plan = buildAplusPlan({
    brand: $("#lBrand").value,
    name: $("#lName").value,
    features: $("#lFeatures").value.split("\n"),
    bullets: ($("#lBullets")?.value || "").split("\n"),
    material: $("#lSize")?.value || "",
    scene: $("#lAudience")?.value || "",
  });
  S.aplusPlan = plan;

  const mods = plan.modules.map((m) => {
    const slotRows = (m.slots || []).map((s) => `<tr>
        <td style="white-space:nowrap">${escapeHtml(s.label)}</td>
        <td>${escapeHtml(s.text || "【待填】")}</td>
        <td class="num">${s.len}/${s.budget}${s.over ? " ⚠️" : ""}</td>
      </tr>`).join("");
    const cardRows = (m.cards || []).map((c) => `<tr>
        <td style="white-space:nowrap">第 ${c.index} 格</td>
        <td><b>${escapeHtml(c.title)}</b><br><span class="hint">${escapeHtml(c.body)}</span></td>
        <td class="num">—</td>
      </tr>`).join("");
    const dims = m.rows && m.rows.length
      ? `<p class="hint" style="margin:6px 0 0">对比维度：${m.rows.map(escapeHtml).join(" / ")}<br>
          列：本品 + 最多 ${Math.max(0, (m.cols || 6) - 1)} 个竞品（后台最多 ${m.cols || 6} 列）—— 口径必须一致，不做贬低性描述。</p>`
      : "";
    return `<div class="aplus-mod">
      <div class="am-h"><b>${escapeHtml(m.name)}</b><span class="chip">${escapeHtml(m.where)}</span></div>
      <p class="hint">${escapeHtml(m.why)}</p>
      <table>${slotRows}${cardRows}</table>
      ${dims}
      <p class="hint" style="margin:8px 0 4px">${escapeHtml(m.imageSpec || "")}</p>
      <div class="note info"><b>配图提示词</b>（英文，直接粘给模型）
        <br><code>${escapeHtml(m.imagePrompt)}</code></div>
    </div>`;
  }).join("");

  const missing = plan.missing.length
    ? `<div class="note bad"><b>还缺：</b>${plan.missing.map(escapeHtml).join("；")}</div>`
    : "";
  const checks = plan.checks.length
    ? `<div class="note warn"><b>骨架文字自检 · ${plan.checks.length} 项命中：</b><br>${plan.checks
        .map((c) => `${escapeHtml(c.label)}：${escapeHtml(c.detail)} → ${escapeHtml(c.fix)}`).join("<br>")}</div>`
    : `<div class="note info">骨架文字自检：没有命中促销语 / 疗效表述 / 特殊符号 / A+ 高风险表述。</div>`;

  $("#aplusOut").innerHTML = `<div class="note info">${escapeHtml(plan.budgetNote)}<br>${escapeHtml(plan.note)}</div>${missing}${mods}${checks}`;
  $("#btnAplusCopy").disabled = false;
  $("#aplusStatus").textContent = `已生成 ${plan.modules.length} 块模块`;
}

/* ─────────────── 批量质检（P2-2）─────────────── */

function runBatch() {
  const txt = $("#batchIn").value;
  if (!txt.trim()) {
    $("#batchStatus").textContent = "先贴几条 listing";
    return;
  }
  const r = batchLint(txt, lintCtx());
  S.batch = r;
  $("#btnBatchCsv").disabled = !r.rows.length;

  const errs = r.summary.errors.length
    ? `<div class="note bad"><b>有 ${r.summary.errors.length} 块没检：</b><br>${r.summary.errors
        .map((e) => `第 ${e.block} 块：${escapeHtml(e.reason)}`).join("<br>")}</div>`
    : "";

  if (!r.rows.length) {
    $("#batchOut").innerHTML = `${errs}<div class="note info">没有可检的条目。格式：第一行标题、其余行五点，块之间用 <code>---</code> 分隔。</div>`;
    $("#batchStatus").textContent = "0 条";
    return;
  }

  const first = r.rows[0];
  const banner = first.pHits
    ? `<div class="note bad"><b>先改这一条：${escapeHtml(first.label)}</b>（命中 ${first.pHits} 条硬规则：${escapeHtml(first.pRuleIds.join(" / "))}）</div>`
    : `<div class="note info"><b>没有硬规则命中。</b>分数最低的是 ${escapeHtml(first.label)}（${first.score == null ? "—" : first.score} 分）。</div>`;

  const tableRows = r.rows.map((x, i) => `<tr>
      <td class="num">${i + 1}</td>
      <td><b>${escapeHtml(x.label)}</b></td>
      <!-- 备注并进标题格：单独开一列时，90% 的行是空的，反而把标题挤成两行 -->
      <td>${escapeHtml(x.title.length > 52 ? x.title.slice(0, 52) + "…" : x.title)}
        ${x.notes.length ? `<br><span class="hint">${escapeHtml(x.notes.join("；"))}</span>` : ""}</td>
      <td class="num"><b>${x.score == null ? "—" : x.score}</b></td>
      <td class="num">${escapeHtml(x.grade || "—")}</td>
      <td class="num" title="硬规则命中数">${x.pHits || "—"}</td>
      <td class="num" title="软规则命中数">${x.cHits}</td>
    </tr>`).join("");

  $("#batchOut").innerHTML = `
    <div class="kpi" style="margin-top:12px">
      <div class="k"><b>${r.summary.count}</b><span>条数</span></div>
      <div class="k ${r.summary.withP ? "bad" : "good"}"><b>${r.summary.withP}</b><span>有硬规则命中</span></div>
      <div class="k"><b>${r.summary.avg == null ? "—" : r.summary.avg}</b><span>平均分（同口径）</span></div>
      <div class="k"><b>${r.summary.best ? r.summary.best.score : "—"}</b><span>最高分</span></div>
    </div>
    ${banner}${errs}
    <table>
      <tr><th>#</th><th>ASIN/序号</th><th>标题</th><th>分数</th><th>档位</th><th title="硬规则命中数">P</th><th title="软规则命中数">C</th></tr>
      ${tableRows}
    </table>
    <p class="hint" style="margin:6px 0 0">P = 硬规则命中数（发布前必须改）；C = 软规则命中数。要逐条看结论，把那一块单独贴回上面的文案编辑区跑一次质检。</p>
    <div class="note info" style="margin-top:10px">${escapeHtml(r.note).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")}</div>`;
  $("#batchStatus").textContent = `${r.summary.count} 条已检`;
}

function fillBatchDemo() {
  $("#batchIn").value = [
    "B0EXAMPLE1",
    "Premium Ceramic Coffee Mug 350ml Double Wall Insulated Stainless Steel Travel Cup with Lid and Handle for Office Home Camping and Gift",
    "- Double wall insulation keeps drinks hot for 6 hours",
    "- Food-grade 304 stainless steel, BPA free",
    "- Fits most car cup holders",
    "---",
    "标题：Montessori Busy Board for Toddlers 1-3, 8 in 1 Sensory Toy",
    "五点：",
    "- Safe felt with no sharp edges",
    "- Portable 30x30cm, fits an airplane tray",
    "- Quiet enough for restaurant and airplane",
  ].join("\n");
  $("#batchStatus").textContent = "示例已填入 · 点「批量质检」";
}

/* ─────────────────────── 数据采集 ─────────────────────── */

function bindCapture() {
  $("#btnParse").addEventListener("click", () => {
    try {
      const r = A.extractAny($("#pasteBox").value);
      // 🔴 必须在这里分流：搜索页载荷没有 title/bullets，交给 renderProduct 会渲染出空表，
      //    而用户会以为是"解析失败"。按 kind 分流，不按"有没有报错"分流。
      if (r && r.kind === "search") {
        S.search = r;
        S.product = null;
        // 搜索页没有单条商品，评论与历史都无从谈起 —— 直接收起，不留上一份的残影。
        if ($("#vocCard")) $("#vocCard").hidden = true;
        if ($("#snapCard")) $("#snapCard").hidden = true;
        renderSearch(r);
      } else {
        S.product = r;
        S.search = null;
        renderProduct(r);
      }
    } catch (e) {
      $("#captureOut").innerHTML = `<div class="note bad">解析失败：${escapeHtml(e.message)}</div>`;
    }
  });
  $("#btnClearPaste").addEventListener("click", () => {
    $("#pasteBox").value = "";
    $("#captureOut").innerHTML = "";
    S.product = null;
    S.search = null;
    S.snapRows = [];
    S.lastVoc = null;
    if ($("#vocCard")) $("#vocCard").hidden = true;
    if ($("#snapCard")) $("#snapCard").hidden = true;
    setCaptureSaved("");
  });
  $("#btnSnapSave").addEventListener("click", saveSnapshot);
  $("#btnSnapRefresh").addEventListener("click", loadSnapshots);
  $("#btnExportProduct").addEventListener("click", () => {
    const payload = S.search || S.product;
    if (!payload) return;
    downloadJSON(`amazon-${S.search ? "search" : "product"}-${payload.asin || payload.keyword || "captured"}.json`, payload);
  });
  $("#btnSaveCapture").addEventListener("click", async () => {
    const payload = S.search || S.product;
    if (!payload) { setCaptureSaved("还没有可保存的采集结果"); return; }
    const isSearch = Boolean(S.search);
    const title = isSearch
      ? `搜索页「${payload.keyword || "(无关键词)"}」${(payload.items || []).length} 个商品`
      : `${payload.asin || "商品"} ${String(payload.title || "").slice(0, 40)}`;
    const r = await saveArtifact("capture", title, payload, {
      asin: payload.asin || undefined,
      count: isSearch ? (payload.items || []).length : undefined,
      site: payload.site || undefined,
    });
    setCaptureSaved(r.ok ? `已存入本地产物（${new Date().toLocaleTimeString()}）` : "当前环境存不了（见「本地产物」页说明）");
  });
}

function setCaptureSaved(text) {
  const el = $("#captureSaved");
  if (el) el.textContent = text || "";
}

function renderBookmarklet() {
  const href = A.bookmarkletHref();
  const a = $("#bmLink");
  a.href = href;
  // 图标从注册表取；文案原样保留（静态 HTML 里只放了文字，图形在这里补齐）
  a.innerHTML = `${iconSvg("bookmark", 20)} 抓取亚马逊商品`;
  $("#bmSrc").textContent = A.bookmarkletSource();
  $("#bmCopy").onclick = async () => {
    try { await navigator.clipboard.writeText(href); $("#bmCopy").textContent = "已复制"; }
    catch { $("#bmCopy").textContent = "复制失败，请手动右键复制链接"; }
    setTimeout(() => ($("#bmCopy").textContent = "复制书签脚本"), 1500);
  };
}

/**
 * 搜索结果页载荷的展示：整页商品表 + 概览统计 + 一键送去多竞品对比。
 * 🔴 这一屏是"批量采集"的价值落点 —— 抓完就完事等于没抓，必须能直接变成下一步的输入。
 */
function renderSearch(r) {
  const items = r.items || [];
  const s = A.searchItemsSummary(items);
  if (!items.length) {
    $("#captureOut").innerHTML = `<div class="note warn">没解析到商品。<br>${escapeHtml(r.note || "")}<br>
      可能原因：页面还没加载完就点了书签，或粘的不是搜索结果页。<b>把搜索结果页往下滚一屏再点书签</b>通常就好。</div>`;
    return;
  }
  const rows = items.map((it) => `
    <tr>
      <td class="num">${escapeHtml(it.asin || "—")}</td>
      <td>${escapeHtml(String(it.title || "").slice(0, 120))}${it.sponsored ? ' <span class="chip a">广告位</span>' : ""}</td>
      <td class="num">${escapeHtml(it.price || "—")}</td>
      <td class="num">${it.rating == null ? "—" : it.rating}</td>
      <td class="num">${it.reviewCount == null ? "—" : it.reviewCount.toLocaleString()}</td>
    </tr>`).join("");

  $("#captureOut").innerHTML = `
    <div class="note info">${escapeHtml(r.note)}</div>
    <div class="kpi" style="margin-bottom:12px">
      <div class="k"><b>${s.total}</b><span>商品</span></div>
      <div class="k"><b>${s.sponsored}</b><span>广告位</span></div>
      <div class="k"><b>${s.price ? s.price.median : "—"}</b><span>价格中位数</span></div>
      <div class="k"><b>${s.rating ? s.rating.median : "—"}</b><span>评分中位数</span></div>
      <div class="k"><b>${s.reviewCount ? s.reviewCount.median : "—"}</b><span>评论数中位数</span></div>
    </div>
    <div class="rowline" style="margin-bottom:10px">
      <button class="btn sm primary" id="btnSearchToCompare">整页送去多竞品对比 →</button>
      <button class="btn sm ghost" id="btnSearchToCorpus">整页作为竞品语料 →</button>
      <span class="chip">站点 ${escapeHtml(r.site || "—")}</span>
      <span class="chip">搜索词 ${escapeHtml(r.keyword || "—")}</span>
    </div>
    <div class="hint" style="margin-bottom:8px">⚠️ 搜索页只有<b>标题 / 价格 / 评分 / 评论数</b>，没有五点与描述。做词频与覆盖度够用（标题是关键词密度最高的字段），要完整文案请用详情页采集。</div>
    <table class="tbl">
      <tr><th style="width:105px">ASIN</th><th>标题</th><th style="width:80px">价格</th><th style="width:56px">评分</th><th style="width:80px">评论数</th></tr>
      ${rows}
    </table>
    ${items.length > 24 ? `<div class="hint" style="margin-top:8px">共 ${items.length} 个商品。导出 JSON 可以看到完整字段（含主图 URL）。</div>` : ""}`;

  // 整页 → 多竞品输入：每个商品一段，用 --- 分隔（normalizeCompetitors 认这个形态）
  const asCompetitors = () => A.searchItemsToCompetitors(items).map((c) => `${c.text}\n---`).join("\n");
  const gotoListing = () => {
    $$("#nav button").find((b) => b.dataset.view === "listing").click();
    // 站点语种自动带过去：德国站的竞品标题里 mit/für/und 不该被当关键词
    const lang = A.siteLang(r.site);
    if (lang) $("#lLang").value = lang;
  };
  $("#btnSearchToCompare").onclick = () => {
    gotoListing();
    $("#lCorpus").value = asCompetitors();
    $("#btnCompare").click();
    $("#compareOut").scrollIntoView({ behavior: "smooth", block: "center" });
  };
  $("#btnSearchToCorpus").onclick = () => {
    gotoListing();
    $("#lCorpus").value = asCompetitors();
    if (!$("#lName").value.trim()) $("#lName").value = r.keyword || "";
    $("#btnMine").click();
    $("#mineOut").scrollIntoView({ behavior: "smooth", block: "center" });
  };
}

/* ─────────────────────── 评论（VOC）分析 ───────────────────────
 * 输入只有一种：书签脚本抓回来的 `reviews[]`。没有评论就整卡隐藏 ——
 * 藏起来的空卡比"这里能分析评论"的假承诺更诚实。
 */
function renderVoc(p) {
  const card = $("#vocCard");
  if (!card) return;
  const list = reviewsFromPayload(p);
  if (!list.length) {
    card.hidden = true;
    S.lastVoc = null;
    return;
  }
  const r = analyzeReviews(list, { asin: p.asin, max: REVIEW_MAX });
  S.lastVoc = r;
  card.hidden = false;
  const sample = $("#vocSample");
  if (sample) sample.textContent = `${r.sampleSize} 条样本`;

  const clusterRow = (c, kind) => `<tr>
      <td><b>${escapeHtml(c.label)}</b></td>
      <td class="num">${kind === "pain" ? c.painCount : c.praiseCount}</td>
      <td class="num">${kind === "pain" ? (c.painAvg ?? "—") : (c.avgRating ?? "—")}</td>
      <td>${c.quotes.map((q) => `<div class="qc">“${escapeHtml(q)}”</div>`).join("") || "—"}</td>
    </tr>`;

  const pain = r.painClusters.length
    ? `<table class="tbl" style="margin-top:6px">
        <tr><th style="width:110px">抱怨的方面</th><th style="width:70px">低星数</th><th style="width:64px">均分</th><th>原话（节选）</th></tr>
        ${r.painClusters.map((c) => clusterRow(c, "pain")).join("")}
      </table>`
    : `<div class="note info">没有识别出明确的抱怨簇（词表判定，不等于"没有差评"）。</div>`;

  const praise = r.praiseClusters.length
    ? `<div style="display:flex;flex-wrap:wrap;gap:5px;margin:6px 0 2px">
        ${r.praiseClusters.map((c) => `<span class="chip g">${escapeHtml(c.label)} ×${c.praiseCount}</span>`).join("")}
      </div>`
    : `<div class="hint">没有识别出好评簇。</div>`;

  const questions = r.questions.length
    ? `<ul class="qlist">${r.questions.map((q) => `<li>${escapeHtml(q.text)}${q.count > 1 ? ` <span class="chip">×${q.count}</span>` : ""}</li>`).join("")}</ul>`
    : `<div class="hint">评论里没看到疑问句。这不代表详情页答全了 —— 很多人懒得在评论里问。</div>`;

  const kws = r.keywordCandidates.length
    ? `<div style="display:flex;flex-wrap:wrap;gap:5px">${r.keywordCandidates.slice(0, 16).map((x) => `<span class="chip">${escapeHtml(x.term)}</span>`).join("")}</div>`
    : "";

  $("#vocOut").innerHTML = `
    <div class="kpi" style="margin-top:2px">
      <div class="k"><b>${r.avgRating ?? "—"}</b><span>样本均分（${r.ratedCount} 条有星级）</span></div>
      <div class="k ${r.lowStarShare >= 40 ? "bad" : r.lowStarShare >= 20 ? "warn" : "good"}"><b>${r.lowStarShare ?? "—"}%</b><span>3 星及以下占比</span></div>
      <div class="k"><b>${r.painClusters.length}</b><span>抱怨簇</span></div>
      <div class="k"><b>${r.questions.length}</b><span>高频疑问</span></div>
    </div>
    <div class="note ${r.reliability.level === "insufficient" ? "warn" : "info"}">${escapeHtml(r.reliability.why)}。${escapeHtml(r.conclusion)}</div>
    <div class="seg-h" style="margin-top:10px">痛点 · 按低星提及数排</div>
    ${pain}
    <div class="seg-h" style="margin-top:12px">买家夸的方面 · 这些词可以直接搬进五点</div>
    ${praise}
    <div class="seg-h" style="margin-top:12px">评论里真有人问的问题 · 详情页该答</div>
    ${questions}
    ${kws ? `<div class="seg-h" style="margin-top:12px">高频词 · 只当线索（含抱怨词本身，不是关键词建议）</div>${kws}` : ""}
    <details class="why" style="margin-top:12px"><summary>这份分析的边界（必须看）</summary>
      <div><ul style="margin:6px 0 0 18px">${r.limits.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>
    </details>`;
}

/* ─────────────────────── 历史快照（同 ASIN） ───────────────────────
 * 只画**已经发生**的点：断点不连线、不预测、2 点以下直接说"画不出趋势"。
 */
function sparkSvg(series, { w = 150, h = 30 } = {}) {
  const sp = sparklinePath(series, { w, h, pad: 3 });
  if (!sp.d) return `<span class="hint" style="margin:0">${escapeHtml(sp.note)}</span>`;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img"
    aria-label="共 ${sp.count} 个数据点的趋势"><path d="${sp.d}" fill="none" stroke="currentColor"
    stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function snapshotDigest(rows, field, label, unit = "") {
  const series = seriesOf(rows, field);
  const d = seriesDigest(series);
  if (d.count < 2) return `<div class="snap-row"><span>${escapeHtml(label)}</span>${sparkSvg(series)}</div>`;
  // 🔴 别用 ↑ ↓ 当"升降"：11px 字号下这两个字形会被看成 1 和 4（截图时真实踩到，
  //    "↑64" 看起来像 "164"）。中文界面就用「升 / 降 / 持平」，没有歧义。
  const dir = d.change > 0 ? "升" : d.change < 0 ? "降" : "";
  const delta = d.change === 0 ? "持平" : `${dir} ${Math.abs(d.change).toLocaleString("en-US")}`;
  return `<div class="snap-row">
    <span>${escapeHtml(label)}</span>
    ${sparkSvg(series)}
    <span class="snap-val">${escapeHtml(d.last.toLocaleString("en-US"))}${escapeHtml(unit)} <b>${escapeHtml(delta)}</b>${d.pct == null ? "" : `（${d.pct > 0 ? "+" : ""}${d.pct}%）`}</span>
  </div>`;
}

function renderSnapshotPanel() {
  const card = $("#snapCard");
  if (!card) return;
  const asin = String(S.product?.asin || "").trim();
  if (!asin) { card.hidden = true; return; }
  card.hidden = false;
  const count = $("#snapCount");
  if (count) count.textContent = `${S.snapRows.length} 条记录 · ${asin}`;
  const rows = S.snapRows;
  if (!rows.length) {
    $("#snapOut").innerHTML = `<div class="note info">这个 ASIN 还没有历史记录。点「记一条快照」，下次再采集时就有了对比。</div>`;
    return;
  }
  if (rows.length < 2) {
    $("#snapOut").innerHTML = `<div class="note warn">只有 1 条记录：一个点画不出趋势。下次采集后再记一条，才能看出价格/评分/评论数怎么变。<br>
      <span class="hint">记录时间：${escapeHtml(fmtStamp(rows[0].ts))}</span></div>`;
    return;
  }
  $("#snapOut").innerHTML = `
    <div class="snap-box">
      ${snapshotDigest(rows, "price", "价格")}
      ${snapshotDigest(rows, "rating", "星级")}
      ${snapshotDigest(rows, "reviewCount", "评论数")}
      ${snapshotDigest(rows, "bsr", "类目排名")}
    </div>
    <div class="hint" style="margin-top:6px">横轴按采集顺序等距；断点处没有连线（那段时间没有样本）；只画已发生的点，不预测。</div>`;
}

async function loadSnapshots() {
  const asin = String(S.product?.asin || "").trim();
  if (!asin) { S.snapRows = []; renderSnapshotPanel(); return; }
  if (!S.probe.online) {
    $("#snapOut").innerHTML = `<div class="note warn">本地服务没在跑，读不到历史快照。<b>记录本身没有丢</b> —— 启动 <code>node server.mjs</code> 后点「刷新」。</div>`;
    return;
  }
  try {
    const resp = await fetch(apiUrl(`/api/snapshots?asin=${encodeURIComponent(asin)}`));
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(j.error || `HTTP ${resp.status}`);
    S.snapRows = Array.isArray(j.rows) ? j.rows : [];
    renderSnapshotPanel();
  } catch (e) {
    $("#snapOut").innerHTML = `<div class="note bad">读取历史失败：${escapeHtml(e.message)}</div>`;
  }
}

async function saveSnapshot() {
  const p = S.product;
  if (!p) return;
  const asin = String(p.asin || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) {
    uiToast("这个商品没有合法 ASIN，记不了快照（搜索页数据请先打开某个商品页采集）。", "warn");
    return;
  }
  if (!S.probe.online) { uiToast("本地服务没在跑，写不了快照。", "bad"); return; }
  const btn = $("#btnSnapSave");
  if (btn) btn.disabled = true;
  try {
    const resp = await fetch(apiUrl("/api/snapshots"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        asin, price: p.price, rating: p.rating,
        reviewCount: p.reviewCount, bsr: p.bestSellersRank, source: "capture",
      }),
    });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(j.error || `HTTP ${resp.status}`);
    S.snapRows = Array.isArray(j.rows) ? j.rows : [];
    renderSnapshotPanel();
    if ($("#snapMsg")) $("#snapMsg").textContent = j.appended ? `已记一条（共 ${j.count} 条）` : (j.reason || "未写入");
  } catch (e) {
    uiToast(`记录失败：${e.message}`, "bad");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderProduct(p) {
  const missing = [];
  if (!p.title) missing.push("title");
  if (!(p.bullets || []).length) missing.push("bullets");
  $("#captureOut").innerHTML = `
    <div class="note ${missing.length ? "warn" : "info"}">
      解析来源：<code>${escapeHtml(p._source || "?")}</code> ·
      ${p.title ? "标题 ✓" : "标题 ✗"} · ${(p.bullets || []).length} 条五点 ·
      ${Object.keys(p.specs || {}).length} 项规格
      ${missing.length ? `<br>⚠️ 没解析到：${missing.join("、")}（可能是页面结构变了，或粘贴内容被截断）` : ""}
    </div>
    <div class="rowline" style="margin-bottom:10px">
      <button class="btn sm primary" id="btnGoListing">拿这份数据去 Listing 工作台 →</button>
      <button class="btn sm ghost" id="btnGoImage">拿它做图 →</button>
    </div>
    <table class="tbl">
      <tr><th style="width:110px">ASIN</th><td class="num">${escapeHtml(p.asin || "—")}</td></tr>
      <tr><th>站点</th><td>${escapeHtml(p.site || "—")} ${p.site ? `（${escapeHtml(A.detectSite("https://" + p.site).label)}）` : ""}</td></tr>
      <tr><th>标题</th><td>${escapeHtml(p.title || "—")} <span class="chip">${(p.title || "").length} 字符</span></td></tr>
      <tr><th>品牌</th><td>${escapeHtml(p.brand || "—")}</td></tr>
      <tr><th>价格 / 评分</th><td>${escapeHtml(p.price || "—")} · ${escapeHtml(p.rating || "—")} 星 · ${escapeHtml(p.reviewCount || "—")} 评价</td></tr>
      <tr><th>五点</th><td>${(p.bullets || []).map((b) => `<div>• ${escapeHtml(b)}</div>`).join("") || "—"}</td></tr>
      <tr><th>规格表</th><td>${Object.entries(p.specs || {}).map(([k, v]) => `<div><code>${escapeHtml(k)}</code>: ${escapeHtml(v)}</div>`).join("") || "—"}</td></tr>
      <tr><th>类目</th><td>${escapeHtml((p.breadcrumbs || []).join(" › ") || "—")}</td></tr>
      <tr><th>主图</th><td>${p.image ? `<a href="${escapeHtml(p.image)}" target="_blank" rel="noopener">${escapeHtml(p.image.slice(0, 90))}…</a>` : "—"}</td></tr>
    </table>`;
  $("#btnGoListing").onclick = () => { $$("#nav button").find((b) => b.dataset.view === "listing").click(); $("#lUseProduct").click(); };
  $("#btnGoImage").onclick = () => {
    $$("#nav button").find((b) => b.dataset.view === "chat").click();
    const ta = $("#input");
    ta.value = `帮我为「${p.title.slice(0, 60)}」设计一张白底主图`;
    ta.focus();
  };
  // 评论与历史都是这个载荷的**下游**：有就显示，没有就整卡隐藏（不摆空壳）。
  renderVoc(p);
  loadSnapshots();
}

/* ─────────────────────── 多竞品对比 ─────────────────────── */

/**
 * 多竞品对比视图。
 * 判断分两层：**全类目共识词**（几乎所有竞品都用 → 优先保证覆盖）与
 * **只在一家出现的词**（差异化/品牌词 → 需要人工判断该不该跟）。
 */
function renderCompare(r) {
  if (!r.size) {
    $("#compareOut").innerHTML = `<div class="note info">没有可对比的内容 —— 把至少 2 个竞品的文案粘进上面的框，用一行 <code>---</code> 分隔。<br>（或者先在「数据采集」抓一次搜索结果页，那里有「整页送去多竞品对比」一键按钮。）</div>`;
    return;
  }
  const solo = r.rows.filter((x) => x.count === 1).length;
  const rows = r.rows.slice(0, 40).map((x) => `<tr>
      <td><b>${escapeHtml(x.term)}</b></td>
      <td class="num">${x.count} / ${r.size}</td>
      <td class="num">${Math.round(x.consistency * 100)}%</td>
      <td>${x.consensus ? '<span class="chip g">全类目共识</span>' : x.count === 1 ? '<span class="chip a">差异化 / 品牌词</span>' : '<span class="chip">部分覆盖</span>'}</td>
      <td style="font-size:11.5px;color:var(--slate-500)">${escapeHtml(x.hits.map((h) => h.name).join("、"))}</td>
    </tr>`).join("");
  $("#compareOut").innerHTML = `
    <div class="kpi" style="margin-top:4px">
      <div class="k"><b>${r.size}</b><span>竞品</span></div>
      <div class="k good"><b>${r.consensus.length}</b><span>全类目共识词</span></div>
      <div class="k warn"><b>${solo}</b><span>只在一家出现</span></div>
      <div class="k"><b>${r.rows.length}</b><span>候选词</span></div>
    </div>
    <div class="rowline" style="margin:10px 0">
      <button class="btn sm ghost" id="btnConsensusToKey">把共识词填入关键词框</button>
    </div>
    ${r.consensus.length
      ? `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px">${r.consensus.slice(0, 40).map((t) => `<span class="chip g">${escapeHtml(t)}</span>`).join("")}</div>`
      : `<div class="hint" style="margin-bottom:10px">没有共识词 —— 说明这几个竞品的用词各不相同（或竞品数太少）。</div>`}
    <table class="tbl">
      <tr><th>词</th><th style="width:76px">几个竞品用</th><th style="width:66px">一致性</th><th style="width:150px">判定</th><th style="width:180px">谁在用</th></tr>
      ${rows}
    </table>
    <div class="note info" style="margin-top:10px">${escapeHtml(r.note)}<br>${escapeHtml(r.source)}</div>`;
  $("#btnConsensusToKey").onclick = () => {
    if (!r.consensus.length) { uiToast("没有共识词可填 —— 至少要 2 个竞品，且它们有共同用词。", "warn"); return; }
    $("#lKeywords").value = r.consensus.slice(0, 30).join(", ");
  };
}

/* ─────────────────────── 本地产物（写入）─────────────────────── */

/**
 * 存一份产物到浏览器 IndexedDB。
 * 🔴 刻意**静默**：存不了（无 IndexedDB / 配额爆了）不该打断用户手上的活，
 *    但也不能假装成功 —— 所以返回值原样交回去，由调用方决定要不要提示。
 */
async function saveArtifact(kind, title, payload, meta = {}) {
  try {
    const r = await STORE.save(kind, title, payload, meta);
    if (!r.ok && r.reason !== "unavailable") console.warn("保存本地产物失败：", r);
    return r;
  } catch (e) {
    console.warn("保存本地产物异常：", e);
    return { ok: false, reason: "error" };
  }
}

/* ─────────────────────── 图片库 ─────────────────────── */

let lastLibrary = [];

/* ─────────────────────── 成图体检 ───────────────────────
 * 两个入口共用一份渲染：① 图片库里点某张「体检」；② 上传任意一张本地图。
 * 🔴 全部在浏览器里读像素，图片不出本机。结论一律是"疑似"，不当平台审核结论用。
 */

const AUDIT_MARK = { pass: "✓", warn: "⚠", fail: "✗", hint: "·", skip: "–" };
const AUDIT_CLASS = { pass: "ok", warn: "warn", fail: "bad", hint: "info", skip: "" };

function auditHtml(r, title) {
  if (!r || r.error) {
    return `<div class="note bad" style="margin-top:10px">体检失败：${escapeHtml((r && r.error) || "未知原因")}</div>`;
  }
  const rows = r.checks.map((c) => `<div class="arow ${AUDIT_CLASS[c.status] || ""}">
      <span class="amark">${AUDIT_MARK[c.status] || "·"}</span>
      <span class="alabel">${escapeHtml(c.label)}</span>
      <span class="aval">${escapeHtml(String(c.value ?? ""))}</span>
      <span class="anote">${escapeHtml(c.measured || "")}</span>
    </div>`).join("");
  const bad = r.summary.fail || 0;
  const warn = r.summary.warn || 0;
  const verdict = bad
    ? `有 ${bad} 项必须处理（按官方主图规则会被拒或明显吃亏）`
    : warn
      ? `没有硬性问题，但有 ${warn} 项建议看一眼`
      : "按本项目这套采样判据没查出问题（不等于平台审核一定过）";
  return `<div class="audit">
    <div class="rowline" style="margin-bottom:6px">
      <b style="font-size:13px">${escapeHtml(title)}</b>
      ${r.width ? `<span class="chip">${r.width} × ${r.height}</span>` : ""}
      <span class="chip ${bad ? "" : "g"}">${bad ? "需修改" : warn ? "建议检查" : "未发现问题"}</span>
    </div>
    <div class="note ${bad ? "bad" : warn ? "warn" : "info"}" style="margin:0 0 8px">${escapeHtml(verdict)}</div>
    ${rows}
    <div class="hint" style="margin-top:8px">${escapeHtml(r.note || "")}</div>
  </div>`;
}

async function runAudit(blobOrFile, label) {
  const out = $("#auditOut");
  if (!out) return;
  out.innerHTML = `<div class="hint" style="margin-top:10px">正在读像素体检 ${escapeHtml(label || "图片")}…</div>`;
  try {
    const r = await auditImageBlob(blobOrFile);
    out.innerHTML = auditHtml(r, label || "图片体检");
  } catch (e) {
    out.innerHTML = `<div class="note bad" style="margin-top:10px">体检失败：${escapeHtml(e.message)}</div>`;
  }
}

function bindAudit() {
  const input = $("#auditFile");
  if (input) {
    input.addEventListener("change", async () => {
      const f = input.files && input.files[0];
      input.value = "";   // 允许连续选同一张文件（否则 change 不再触发）
      if (f) await runAudit(f, f.name);
    });
  }
}

async function auditLibraryFile(name, btn) {
  const item = lastLibrary.find((f) => f.name === name);
  if (!item) { uiToast("找不到这张图，刷新列表再试。", "warn"); return; }
  const label = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "读取中…"; }
  try {
    const resp = await fetch(apiUrl(item.url));
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const file = new File([blob], name, { type: blob.type || "image/png" });
    await runAudit(file, name);
    $("#auditOut")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (e) {
    uiToast(`体检失败：${e.message}`, "bad");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label || "体检"; }
  }
}

async function rembgLibraryFile(name, btn) {
  if (btn) { btn.disabled = true; btn.textContent = "抠图中…"; }
  try {
    const resp = await fetch(apiUrl("/api/plugins/rembg"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(j.error || `HTTP ${resp.status}`);
    uiToast(`抠好了：${j.file}（${Math.round((j.bytes || 0) / 1024)} KB，${j.ms}ms）`, "ok", 4200);
    await renderLibrary();
  } catch (e) {
    uiToast(`抠图失败：${e.message}`, "bad", 5000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "抠图"; }
  }
}

function bindLibrary() {
  $("#btnLibRefresh").addEventListener("click", () => renderLibrary());
  // 搜索是**纯前端过滤**：lastLibrary 已经在内存里，不需要为一个输入框再打一次接口。
  // 用 input 而不是 change —— 边打边筛才有「找东西」的手感。
  $("#libQ").addEventListener("input", () => renderLibGrid());
  bindAudit();
  $("#btnLibZip").addEventListener("click", () => {
    if (!S.probe.online) { uiToast("本地服务没在跑，打包下载用不了。先 node server.mjs 启动服务。", "warn"); return; }
    if (!lastLibrary.length) { uiToast("图片库是空的。", "warn"); return; }
    // zip 由服务端打包**整个**目录，不受搜索框影响 —— 这一点要说出来，
    // 否则用户筛了 3 张却下到 40 张，会以为筛错了。
    if (($("#libQ")?.value || "").trim()) uiToast("搜索框只影响页面显示；zip 始终打包 data/gen/ 全部图片。", "warn", 4200);
    window.open(apiUrl("/api/library?zip=1"), "_blank");
  });
  $("#btnLibCopyPaths").addEventListener("click", async () => {
    // 复制跟随当前筛选：用户筛出 5 张，想要的就是这 5 条的路径
    const list = libVisible();
    if (!list.length) { uiToast(lastLibrary.length ? "当前筛选没有匹配项。" : "图片库是空的。", "warn"); return; }
    const text = list.map((f) => `data/gen/${f.name}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      $("#btnLibCopyPaths").textContent = "已复制";
    } catch {
      downloadText("listing-images-路径清单.txt", text);
      $("#btnLibCopyPaths").textContent = "已改为下载 txt";
    }
    setTimeout(() => ($("#btnLibCopyPaths").textContent = "复制全部路径"), 1600);
  });
}

async function renderLibrary() {
  const grid = $("#libGrid");
  const meta = $("#libMeta");
  const off = $("#libOffline");
  if (!grid) return;
  if (!S.probe.online) {
    // 「看不到」和「丢了」是两回事 —— 必须说清楚，否则用户会以为图没了
    off.style.display = "";
    grid.innerHTML = "";
    meta.textContent = "";
    lastLibrary = [];
    return;
  }
  off.style.display = "none";
  grid.innerHTML = `<div class="lib-empty">正在读取…</div>`;
  let data = null;
  try {
    const resp = await fetch(apiUrl("/api/library"));
    data = await resp.json();
    if (!resp.ok) throw new Error((data && data.error) || `HTTP ${resp.status}`);
  } catch (e) {
    grid.innerHTML = `<div class="lib-empty">读取失败：${escapeHtml(e.message)}</div>`;
    return;
  }
  lastLibrary = data.files || [];
  S.libBytesText = data.bytesText || "0 B";
  renderLibGrid();
}

/**
 * 当前搜索框筛出来的图片列表（空搜索 = 全部）。
 * 🔴 抽出这一份：栅格和「复制全部路径」必须看到同一个结果集，
 *    各写一遍迟早出现「页面显示 3 张、复制出来 40 条」。
 */
function libVisible() {
  const q = ($("#libQ")?.value || "").trim().toLowerCase();
  if (!q) return lastLibrary;
  return lastLibrary.filter((f) => String(f.name || "").toLowerCase().includes(q));
}

/**
 * 只重画「筛选 + 栅格」这一段。
 * 🔴 和 renderLibrary 分开：搜索框每敲一个字都会调用它。
 *    如果合成一个函数写成重新 fetch，打字就会变成打一次网络请求一次。
 */
function renderLibGrid() {
  const grid = $("#libGrid");
  const meta = $("#libMeta");
  const hint = $("#libQHint");
  if (!grid) return;

  const raw = ($("#libQ")?.value || "").trim();
  const list = libVisible();
  const q = Boolean(raw);

  // 🔴 空库也要写「共 0 张」：留白会让人分不清"读到了、就是没有"和"没读到"。
  meta.innerHTML = `共 <b>${lastLibrary.length}</b> 张${q ? ` · 筛出 <b>${list.length}</b> 张` : ""} · ${escapeHtml(S.libBytesText || "0 B")} · 存在本机 <code>data/gen/</code>`;
  if (hint) hint.textContent = q ? `匹配「${raw}」：${list.length} / ${lastLibrary.length}` : "";

  if (!lastLibrary.length) {
    grid.innerHTML = `<div class="lib-empty">还没有图片。去「创作台」生成一张试试（需要先配好图片 API）。</div>`;
    return;
  }
  if (!list.length) {
    // 空态同样跨列（.lib-empty 的 grid-column），并给一条出路 —— 别让用户以为图没了
    grid.innerHTML = `<div class="lib-empty">没有文件名包含「${escapeHtml(raw)}」的图片。<br>
      <button class="btn sm ghost" id="libQClear" style="margin-top:8px">清空筛选</button></div>`;
    $("#libQClear")?.addEventListener("click", () => { $("#libQ").value = ""; renderLibGrid(); $("#libQ").focus(); });
    return;
  }

  grid.innerHTML = list.map((f) => `
    <div class="lib-card">
      <a href="${escapeHtml(f.url)}" target="_blank" rel="noopener"><img src="${escapeHtml(f.url)}" alt="${escapeHtml(f.name)}" loading="lazy"></a>
      <div class="m">
        <code>${escapeHtml(f.name)}</code>
        <span>${escapeHtml(f.sizeText)} · ${escapeHtml(fmtStamp(f.mtime))}</span>
      </div>
      <div class="b">
        <a class="btn sm ghost" href="${escapeHtml(f.url)}" download="${escapeHtml(f.name)}">下载</a>
        <button class="btn sm ghost" data-audit="${escapeHtml(f.name)}">体检</button>
        ${S.probe.capabilities?.rembg ? `<button class="btn sm ghost" data-rembg="${escapeHtml(f.name)}">抠图</button>` : ""}
        <button class="btn sm ghost" data-del="${escapeHtml(f.name)}" style="color:var(--red-700)">删除</button>
      </div>
    </div>`).join("");
  grid.querySelectorAll("[data-audit]").forEach((btn) => {
    btn.onclick = () => auditLibraryFile(btn.dataset.audit, btn);
  });
  grid.querySelectorAll("[data-rembg]").forEach((btn) => {
    btn.onclick = () => rembgLibraryFile(btn.dataset.rembg, btn);
  });
  grid.querySelectorAll("[data-del]").forEach((btn) => {
    btn.onclick = async () => {
      const name = btn.dataset.del;
      // 删的是用户自己生成的本机文件，且不可撤销 → 必须点名确认
      const go = await uiConfirm({
        title: "删除这张图？",
        body: `文件名：${name}\n\n这是本机 data/gen/ 里的真实文件，删掉不进回收站，无法恢复。`,
        okText: "删除",
        danger: true,
      });
      if (!go) return;
      btn.disabled = true;
      btn.textContent = "删除中…";
      try {
        const resp = await fetch(`${apiUrl("/api/library")}?name=${encodeURIComponent(name)}`, { method: "DELETE" });
        const j = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(j.error || `HTTP ${resp.status}`);
        await renderLibrary();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = "删除";
        uiToast(`删除失败：${e.message}`, "bad");
      }
    };
  });
}

/* ─────────────────────── 本地产物（查看）─────────────────────── */

function bindVault() {
  $("#btnVaultRefresh").addEventListener("click", () => renderVault());
  $("#btnVaultExport").addEventListener("click", async () => {
    const rows = await STORE.list();
    if (!rows.length) { uiToast("还没有产物可以导出。", "warn"); return; }
    downloadText(`listing-本地产物-${new Date().toISOString().slice(0, 10)}.json`, STORE.toExport(rows));
  });
  $("#btnVaultImport").addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const f = input.files && input.files[0];
      if (!f) return;
      const r = await STORE.importFrom(await f.text());
      // 旧格式（无版本号）要当场说一句，别让用户以为文件本来就长这样
      uiToast(r.ok
        ? `导入完成：新增 ${r.added} 条，跳过 ${r.skipped} 条。${r.warning ? `\n\n注意：${r.warning}` : ""}`
        : `导入失败：${r.error}`, r.ok ? "ok" : "bad", r.warning ? 5200 : 2800);
      renderVault();
    };
    input.click();
  });
  $("#btnVaultClear").addEventListener("click", async () => {
    const st = await STORE.stats();
    if (!st.total) { uiToast("本来就是空的。", "warn"); return; }
    const go = await uiConfirm({
      title: `清空全部 ${st.total} 条本地产物？`,
      body: "这些记录存在这台机器的浏览器 IndexedDB 里，清空后无法恢复。\n\n建议先点「导出全部」留一份 JSON 再清空。",
      okText: "清空",
      danger: true,
    });
    if (!go) return;
    const r = await STORE.clear();
    uiToast(r.ok ? "已清空。" : "清空失败。", r.ok ? "ok" : "bad");
    renderVault();
  });
}

async function renderVault() {
  const statEl = $("#vaultStat");
  const listEl = $("#vaultList");
  if (!statEl || !listEl) return;
  const st = await STORE.stats();
  if (!st.available) {
    // 「当前环境不支持」不等于「功能坏了」—— 别把浏览器限制说成 bug
    statEl.innerHTML = `<div class="note warn" style="margin:0">当前环境用不了 IndexedDB（浏览器隐私模式 / 老浏览器），所以本地产物不可用。<b>采集、质检、Prompt 生成本身都不受影响</b>，只是关掉页面后不会留档。要留档就导出 JSON。</div>`;
  } else {
    // 每类的图标与标签从 STORE.KINDS 取；KINDS 里存的是**图标 id**，图形在本文件的注册表里
    const byKind = Object.entries(st.byKind)
      .map(([k, v]) => `${iconSvg(STORE.KINDS[k].icon, 16)} ${escapeHtml(STORE.KINDS[k].label)} <b>${v}</b>`)
      .join(" · ");
    const quota = st.quota && st.quota.quota
      ? ` · 浏览器配额已用 ${escapeHtml(st.quota.usageText)} / ${escapeHtml(STORE.formatSize(st.quota.quota))}`
      : "";
    statEl.innerHTML = `本地共 <b>${st.total}</b> 条：${byKind}${quota}<br><span class="hint">每类最多 ${STORE.MAX_RECORDS_PER_KIND} 条，超了自动淘汰最旧的；单条超过 ${STORE.formatSize(STORE.MAX_PAYLOAD_CHARS)} 会被裁剪并标注。</span>`;
  }
  const rows = await STORE.list();
  if (!rows.length) {
    listEl.innerHTML = `<div class="hint">还没有记录。抓一次竞品、跑一次质检或覆盖度，就会自动留档。</div>`;
    S.diffSel = [];
    renderDiffCtl();
    const dv = $("#vaultDiff");
    if (dv) dv.innerHTML = "";
    return;
  }
  // 删记录 / 被新记录挤掉之后，勾选里可能留着已经不存在的 id —— 在这里清掉，
  // 否则按钮是"已勾 2 条"的可用状态，点下去才发现其中一条没了。
  const alive = new Set(rows.map((r) => r.id));
  S.diffSel = (S.diffSel || []).filter((id) => alive.has(id));
  listEl.innerHTML = rows.map((rec) => {
    const s = STORE.summarize(rec);
    const picked = (S.diffSel || []).includes(rec.id);
    return `<div class="vault-row">
      ${rec.kind === "capture"
        ? `<input type="checkbox" data-pick="${rec.id}" ${picked ? "checked" : ""} title="勾选两条做快照对比" style="margin-right:8px">`
        : `<span style="display:inline-block;width:21px"></span>`}
      <div class="ico">${iconSvg(s.icon, 20)}</div>
      <div class="body">
        <div class="title">${escapeHtml(s.title)}</div>
        <div class="meta">${escapeHtml(s.label)} · ${escapeHtml(s.time)} · ${escapeHtml(s.sizeText)}${s.detail ? " · " + escapeHtml(s.detail) : ""}</div>
      </div>
      <div class="rowline" style="flex:0 0 auto">
        ${rec.kind === "capture" ? `<button class="btn sm ghost" data-load="${rec.id}">载入</button>` : ""}
        <button class="btn sm ghost" data-dl="${rec.id}">导出</button>
        <button class="btn sm ghost" data-rm="${rec.id}" style="color:var(--red-700)">删除</button>
      </div>
    </div>`;
  }).join("");
  // 快照对比：只允许选两条（选第三条时把最早选的那条挤掉，避免"选了 5 条不知道比哪两条"）
  listEl.querySelectorAll("[data-pick]").forEach((b) => {
    b.onchange = () => {
      const id = b.dataset.pick;
      const cur = S.diffSel || [];
      if (b.checked) S.diffSel = [...cur.filter((x) => x !== id), id].slice(-2);
      else S.diffSel = cur.filter((x) => x !== id);
      renderDiffCtl();
      listEl.querySelectorAll("[data-pick]").forEach((x) => { x.checked = (S.diffSel || []).includes(x.dataset.pick); });
    };
  });
  renderDiffCtl();
  listEl.querySelectorAll("[data-dl]").forEach((b) => {
    b.onclick = async () => {
      const rec = await STORE.get(b.dataset.dl);
      if (rec) downloadJSON(`${rec.kind}-${rec.id}.json`, rec);
    };
  });
  listEl.querySelectorAll("[data-rm]").forEach((b) => {
    b.onclick = async () => {
      const go = await uiConfirm({
        title: "删除这条本地产物？",
        body: "删掉后无法恢复（可以先去「导出全部」留一份）。",
        okText: "删除",
        danger: true,
      });
      if (!go) return;
      await STORE.remove(b.dataset.rm);
      renderVault();
    };
  });
  listEl.querySelectorAll("[data-load]").forEach((b) => {
    b.onclick = async () => {
      const rec = await STORE.get(b.dataset.load);
      if (!rec) return;
      const p = rec.payload;
      if (p && p.kind === "search") { S.search = p; S.product = null; renderSearch(p); }
      else { S.product = p; S.search = null; renderProduct(p); }
      // 载入后自动跳回采集页，否则用户按了按钮却看不到任何变化
      $$("#nav button").find((x) => x.dataset.view === "capture").click();
      $("#captureOut").scrollIntoView({ behavior: "smooth", block: "start" });
    };
  });
}

/* ─────────────────────── 快照对比（同一件商品前后两次采集）───────────────────────
 * 三条纪律（与 amazon.js 的 diffSnapshots 对齐）：
 *   ① 只比「你两次抓到的内容」——不猜对方为什么改，也不评价改得好不好；
 *   ② 两份不是同一件商品时必须写在最上面。把"商品 A 与商品 B 的差异"读成"它改了标题"
 *      是最容易发生的误读，而界面上一个字的暗示就够造成它；
 *   ③ 搜索页对搜索页**按 ASIN 集合比**（谁进榜/谁掉榜）。一次 20+ 个商品逐字段摊开
 *      没人看得下去，摊开等于没做。
 */

/** 这条 capture 是「搜索结果页」还是「单个商品」——存的时候两种都进 capture 类。 */
function isSearchPayload(p) {
  return Boolean(p) && (p.kind === "search" || Array.isArray(p.items));
}

/**
 * 时间戳 → `YYYY-MM-DD HH:mm`（本地时区）。
 *
 * 🔴 非法时间必须显示 `—`，不能显示 1970。
 *    原来的写法是 `new Date(t || 0)`：`t` 缺失 / 是空串 / 是坏字符串时，
 *    `0` 会被当成 epoch，于是页面上出现 `1970-01-01 08:00` ——
 *    这是最坏的一种"假数据"，因为它看起来像一个真实的时间戳，
 *    用户会以为「这条记录是 1970 年的」而不是「这条记录没时间」。
 *    缺数据就显示缺数据，这条在全项目是一致的。
 */
function fmtStamp(t) {
  if (t === null || t === undefined || t === "") return "—";
  const d = t instanceof Date ? t : new Date(typeof t === "number" ? t : String(t));
  if (Number.isNaN(d.getTime())) return "—";
  // 1970 年只可能来自 `0` 或别处误传的假值；正常采集不可能落到这一年。
  if (d.getFullYear() < 1971) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 勾选区：只放一个按钮 + 一句当前状态，够用就行（不做"对比模式"这种要解释的交互）。 */
function renderDiffCtl() {
  const el = $("#vaultDiffCtl");
  if (!el) return;
  const n = (S.diffSel || []).length;
  const tip = n === 0
    ? "勾两条同类记录：商品对商品比字段，搜索页对搜索页比谁进榜"
    : n === 1
      ? "已勾 1 条，再勾 1 条"
      : "已勾 2 条 —— 采集时间早的当「改前」，晚的当「改后」，与勾选顺序无关";
  el.innerHTML = `<div class="rowline" style="gap:10px;align-items:center;flex-wrap:wrap">
      <button class="btn sm" id="btnVaultDiff"${n === 2 ? "" : " disabled"}>对比快照</button>
      <span class="hint" style="margin:0">${escapeHtml(tip)}</span>
    </div>`;
  const b = $("#btnVaultDiff");
  if (b) b.onclick = () => { renderDiff(); };
}

async function renderDiff() {
  const out = $("#vaultDiff");
  if (!out) return;
  const ids = (S.diffSel || []).slice(0, 2);
  if (ids.length !== 2) { out.innerHTML = ""; return; }

  const got = [];
  for (const id of ids) {
    const r = await STORE.get(id);
    if (r) got.push(r);
  }
  if (got.length !== 2) {
    S.diffSel = [];
    out.innerHTML = `<div class="note warn">其中一条记录已经不在了（被删掉或被新记录淘汰），请重新勾两条。</div>`;
    renderDiffCtl();
    return;
  }

  // 🔴 按采集时间排，不按勾选顺序：先勾新的再勾旧的很常见，反过来读会把"改后"当"改前"
  got.sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
  const [oldRec, newRec] = got;
  const a = oldRec.payload || {};
  const b = newRec.payload || {};
  const head = `<div class="hint" style="margin:0 0 8px">改前 <b>${escapeHtml(fmtStamp(oldRec.createdAt))}</b> → 改后 <b>${escapeHtml(fmtStamp(newRec.createdAt))}</b></div>`;

  const sa = isSearchPayload(a);
  const sb = isSearchPayload(b);
  if (sa !== sb) {
    out.innerHTML = `<div class="note warn">两份记录类型不同：一份是搜索结果页、一份是单个商品，没法逐字段对比。请勾两条同类记录。</div>`;
    return;
  }

  if (sa) { renderSearchDiff(out, a, b, head); return; }

  const d = A.diffSnapshots(a, b);
  const bits = [head];
  if (d.note) bits.push(`<div class="note warn">${escapeHtml(d.note)}</div>`);
  if (!d.rows.length) {
    bits.push(`<div class="note info">两次采集的 ${d.unchanged.length} 个字段完全一致（${escapeHtml(d.unchanged.join("、"))}）—— 至少在你抓的那一刻，这些内容没变。</div>`);
  } else {
    const cell = (v) => {
      if (Array.isArray(v)) {
        return v.length
          ? v.map((x) => `<div>· ${escapeHtml(x)}</div>`).join("")
          : `<span style="color:var(--slate-400)">（空）</span>`;
      }
      return String(v || "").trim()
        ? escapeHtml(String(v))
        : `<span style="color:var(--slate-400)">（空）</span>`;
    };
    bits.push(`<table class="tbl"><thead><tr><th style="width:74px">字段</th><th>改前</th><th>改后</th></tr></thead><tbody>${
      d.rows.map((r) => {
        const bits2 = [];
        if (r.added && r.added.length) bits2.push(`新增 ${r.added.length} 条`);
        if (r.removed && r.removed.length) bits2.push(`删掉 ${r.removed.length} 条`);
        const extra = bits2.length ? `<div class="hint" style="margin:4px 0 0">${bits2.join(" · ")}</div>` : "";
        return `<tr><td><b>${escapeHtml(r.label)}</b></td><td>${cell(r.before)}</td><td>${cell(r.after)}${extra}</td></tr>`;
      }).join("")
    }</tbody></table>`);
    bits.push(`<div class="hint" style="margin:8px 0 0">共 <b>${d.changedCount}</b> 个字段有变化${d.unchanged.length ? `；没变：${escapeHtml(d.unchanged.join("、"))}` : ""}。<br>
      差异只反映两次抓取之间页面上显示的内容。本工具<b>只比这 9 个文本字段</b>：标题 / 品牌 / 价格 / 星级 / 评论数 / 类目排名 / 五点 / 规格 / 描述 —— 主图、A+ 内容、变体结构不在比较范围内；价格与排名本身也会随地区、登录态、时间变化。</div>`);
  }
  out.innerHTML = bits.join("");
}

function renderSearchDiff(out, a, b, head) {
  const idsOf = (p) => (p.items || []).map((x) => String(x.asin || x.title || "").trim()).filter(Boolean);
  const listA = idsOf(a);
  const listB = idsOf(b);
  const setA = new Set(listA);
  const setB = new Set(listB);
  const added = listB.filter((x) => !setA.has(x));
  const removed = listA.filter((x) => !setB.has(x));
  const nameOf = (p, key) => {
    const hit = (p.items || []).find((x) => String(x.asin || x.title || "").trim() === key);
    return hit && hit.title ? String(hit.title) : "";
  };
  const line = (key, p) => {
    const t = nameOf(p, key);
    return `<div>· <b>${escapeHtml(key)}</b>${t ? ` ${escapeHtml(t.slice(0, 70))}` : ""}</div>`;
  };
  const col = (title, keys, p, tone) => {
    if (!keys.length) return `<td><span style="color:var(--slate-400)">（无）</span></td>`;
    return `<td style="color:${tone}">${keys.map((k) => line(k, p)).join("")}</td>`;
  };
  out.innerHTML = `${head}
    <div class="note info">这是<b>搜索结果页</b>的对比：按 ASIN 集合比「谁进榜 / 谁掉榜」，不逐条比字段 —— 一次 20+ 个商品逐字段摊开没有可读性。</div>
    <div class="hint" style="margin:0 0 8px">改前 <b>${listA.length}</b> 个商品 · 改后 <b>${listB.length}</b> 个 · 新进 <b>${added.length}</b> · 掉出 <b>${removed.length}</b></div>
    <table class="tbl"><thead><tr><th style="width:74px">变化</th><th>商品</th></tr></thead><tbody>
      <tr><td><b>新进</b></td>${col("", added, b, "var(--green-700)")}</tr>
      <tr><td><b>掉出</b></td>${col("", removed, a, "var(--red-700)")}</tr>
    </tbody></table>
    <div class="hint" style="margin:8px 0 0">集合差异不等于商品本身有变化：搜索结果的排序与展示会随地区、登录态、时间、个性化推荐变化；没配搜索量数据时，本工具也不判断「进榜」是不是变好。</div>`;
}

/* ─────────────────────── 本周词库（独立页）───────────────────────
 *
 * 这一页只做一件事：把 `/api/keywords` 说清楚。
 *
 * 为什么单独开一页，而不是继续塞在 Listing 页的抽屉里：
 *   那边一次只铺 40 个 chip、不能搜、没有总数 —— 用户看不到"这周到底采到多少词"，
 *   也就没法判断"我要的词是没抓到，还是抓到了但我没看见"。两件事的处理方式完全不同。
 *   词库是**全品类**的（跟具体商品无关），它属于"选词"这一步，不该寄生在"写文案"里。
 *
 * 🔴 三个必须说出口的事实，少一个这页就沦为装饰：
 *   ① 数据是哪天抓的、距今几天（`ageDays` + `stale` + `staleNote`）；
 *   ② 你看到的是不是全部（`keywordsTruncated` / `keywordsTotal`）；
 *   ③ 上次采集成没成（`trust.status`：失败要带原因，没跑过要直说没跑过）。
 */

const W_LIMIT = 500; // 与 keyword-vault.js 的 MAX_KEYWORD_LIMIT 同值；接口会自己夹，夹完在界面上报账

function bindWords() {
  const q = $("#wordsQ");
  if (!q) return;
  let timer = null;
  // 防抖 260ms：词库 2000+ 条且筛在服务端，敲一个字母发一次请求没有意义。
  q.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(loadWords, 260); });
  q.addEventListener("keydown", (e) => { if (e.key === "Enter") { clearTimeout(timer); loadWords(); } });

  $$("[data-wsort]").forEach((b) =>
    b.addEventListener("click", () => {
      S.wordsSort = b.getAttribute("data-wsort");
      $$("[data-wsort]").forEach((x) => {
        const on = x === b;
        x.classList.toggle("primary", on);
        x.classList.toggle("ghost", !on);
      });
      loadWords();
    })
  );

  const reload = $("#btnWordsReload");
  if (reload) reload.addEventListener("click", () => loadWords());

  const toCopy = $("#btnWordsToCopy");
  if (toCopy)
    toCopy.addEventListener("click", () => {
      const rows = (S.words?.keywords || []).slice(0, 30);
      const box = $("#lKeywords");
      if (!rows.length || !box) return;
      // 只填「关键词」框，**不碰**标题与五点 —— 这一步的语义是"把词带过去"，不是"改文案"。
      box.value = rows.map((k) => k.term).join(", ");
      // 程序里写 .value 不会触发 input，字数 chip 与超限红点会停在旧值上。
      box.dispatchEvent(new Event("input", { bubbles: true }));
      goView("listing");
    });

  /* 折叠扩展区（6 组）：按钮逐个显式绑定；两个要独立取数的区只在展开时请求。
     传字面量 id —— selftest 会静态检查「每个 button id 都在 app.js 里被引用」。 */
  const on = (id, fn) => { const b = $(id); if (b) b.addEventListener("click", fn); };
  on("#btnWCoverRun", runWordsCoverage);
  on("#btnWRootAdd", addRootPending);
  on("#btnWRootDel", delRootPending);
  on("#btnWRootSave", saveRoots);
  on("#btnWExpKeywords", () => exportWordsCsv("keywords"));
  on("#btnWExpAsins", () => exportWordsCsv("asins"));
  const toggleLoad = (id, fn) => {
    const el = $(id);
    if (el) el.addEventListener("toggle", () => { if (el.open) fn(); });
  };
  toggleLoad("#dWCompare", loadWordsCompare);
  toggleLoad("#dWRoots", loadRootsPanel);
  const siteSel = $("#wSiteSel");
  if (siteSel) siteSel.addEventListener("change", updateSiteNote);
  // 服务没起 / 没给 verifiedMarkets 时，下拉也要有「○ 未实测」的选项（G-9 的兜底口径）
  renderSitePanel(null);
}

/**
 * 「送进文案页」的可用性。
 * 没词的时候按钮必须是**灰的**，而不是"点下去什么都不发生" ——
 * 后者会让人怀疑是自己点错了，然后反复点。可用性本身就是一种说明。
 */
function wordsCopyEnabled(on) {
  const b = $("#btnWordsToCopy");
  if (b) b.disabled = !on;
}

function wordsCells(cells) {
  return cells
    .map(([v, k]) => `<div class="wcell"><b>${escapeHtml(String(v))}</b><span>${escapeHtml(k)}</span></div>`)
    .join("");
}

async function loadWords() {
  const table = $("#wordsTable");
  const stat = $("#wordsStat");
  if (!table) return;
  table.innerHTML = `<div class="note">正在读取词库…</div>`;
  wordsCopyEnabled(false);
  loadWordsExt();   // 外部词表那一块独立取数：没有导入时它自己会消失，不影响上面的表
  try {
    const q = ($("#wordsQ")?.value || "").trim();
    const sort = encodeURIComponent(S.wordsSort || "roots");
    const resp = await fetch(
      apiUrl(`/api/keywords?limit=${W_LIMIT}&sort=${sort}` + (q ? `&q=${encodeURIComponent(q)}` : ""))
    );
    const d = await resp.json();
    S.words = d;
    if (!d.ok) { renderWordsCold(d); renderWordsPanels(null); return; }
    renderWords(d, q);
    renderWordsPanels(d);
  } catch (e) {
    if (stat) stat.innerHTML = wordsCells([["—", "条词"], ["—", "个 ASIN"], ["—", "本周新增"], ["—", "采集日期"]]);
    table.innerHTML = `<div class="note bad">读取词库出错：${escapeHtml(e.message)}
      <br><small>词库由本地服务提供，先确认 <code>node server.mjs</code> 在跑（本页不是从浏览器缓存读的）。</small></div>`;
    renderWordsPanels(null);
  }
}

/** 冷分支：没有词库文件。**这里要能照着修**，所以必须带上"上次采集怎么了"。 */
function renderWordsCold(d) {
  const st = d.trust?.status || {};
  const day = (t) => (t ? fmtStamp(t) : "—");
  const why = st.lastAttemptAt
    ? `上次采集 ${day(st.lastAttemptAt)} 失败：${st.reason || "未知原因"}${Number.isFinite(st.exitCode) ? `（退出码 ${st.exitCode}）` : ""}｜${st.lastSuccessAt ? `上次成功 ${day(st.lastSuccessAt)}` : "从未成功过"}`
    : "还没有任何采集记录 —— 定时任务一次都没跑过。";
  const stat = $("#wordsStat");
  if (stat) stat.innerHTML = wordsCells([["—", "条词"], ["—", "个 ASIN"], ["—", "本周新增"], ["—", "采集日期"]]);
  $("#wordsTable").innerHTML = `<div class="note bad"><b>暂时没有词库。</b>${escapeHtml(d.error || "未知原因")}
    ${d.hint ? `<br><small>${escapeHtml(d.hint)}</small>` : ""}
    <br><small>${escapeHtml(why)}</small></div>`;
}

function renderWords(d, q) {
  const day = String(d.generatedAt || "").slice(0, 10);
  const age = Number.isFinite(d.ageDays) ? d.ageDays : null;
  const n = (v) => Number(v || 0).toLocaleString("en-US");
  // 🔴 「分不出」不能显示成 0：首次采集 / 没有历史投影时 `newKeywordCount` 一定是 0，
  //    而那个 0 的含义是"没算过"，不是"这周没有新词"。两句话对应两种动作（等下周 / 去查采集）。
  const unknownNew = d.trust?.returnedUnknown === true;
  $("#wordsStat").innerHTML = wordsCells([
    [n(d.counts?.keywords), "条词"],
    [n(d.counts?.asins), "个 ASIN"],
    [unknownNew ? "分不出" : n(d.counts?.newKeywords), "本周新增"],
    [day || "—", age === 0 ? "今天采集" : age == null ? "采集日期" : `${age} 天前采集`],
  ]);

  // 只放"会改变你怎么用这份数据"的提示，不做科普。
  const warn = [];
  if (d.stale)
    warn.push(`<div class="note warn"><b>不是本周的数据。</b>${escapeHtml(d.staleNote || "")} 最近一次成功采集：${escapeHtml(day || "—")}。</div>`);
  if (unknownNew)
    warn.push(`<div class="note">还没有历史可比 —— <b>分不出「本周新词」和「回归词」</b>，所以那一格写的是「分不出」而不是 0。下一周再采一次就有了。</div>`);
  if (d.trust?.verifiedMarket === false)
    warn.push(`<div class="note warn">站点 <b>${escapeHtml(String(d.site || "—"))}</b> 的抓取规则没实测过，字段可能缺；换回 US 可对照。</div>`);

  const rows = d.keywords || [];
  wordsCopyEnabled(rows.length > 0);
  if (!rows.length) {
    $("#wordsTable").innerHTML =
      warn.join("") +
      (q
        ? `<div class="note">没有匹配「${escapeHtml(q)}」的词。<button class="btn ghost sm" id="wordsClearQ">清空搜索</button></div>`
        : `<div class="note warn">这次采集到 <b>0 条词</b> —— 大概率是抓取被拦了，不是"这个词没需求"。</div>`);
    const clr = $("#wordsClearQ");
    if (clr)
      clr.addEventListener("click", () => {
        $("#wordsQ").value = "";
        loadWords();
      });
    return;
  }

  if (d.keywordsTruncated)
    warn.push(`<div class="note">词库共 <b>${n(d.keywordsTotal)}</b> 条，这里按当前排序只列前 ${n(rows.length)} 条 —— 不是词库只有这么多。</div>`);

  // 状态列只在**真的有新词/回归词**时才出现。
  // 一列 500 行的「—」既占宽度又像在暗示"这里本该有数据"；没有就不显示这一列。
  const showState = rows.some((k) => k.newly === "new" || k.newly === "returned");

  const tag = (k) =>
    k.newly === "new" ? `<span class="chip p">新词</span>` : `<span class="chip a">回归</span>`;

  const body = rows
    .map(
      (k) => `<tr>
        <td class="t">${escapeHtml(k.term)}</td>
        <td class="n">${escapeHtml(String(k.rootCount ?? k.hits ?? "—"))}</td>
        ${showState ? `<td>${tag(k)}</td>` : ""}
        <td class="r hide-sm">${escapeHtml((k.roots || []).join(" · ") || "—")}</td>
      </tr>`
    )
    .join("");

  $("#wordsTable").innerHTML =
    warn.join("") +
    `<div class="wmeta">${q ? `搜索「${escapeHtml(q)}」命中 ` : ""}${n(rows.length)} 条</div>
     <table class="wt">
       <thead><tr><th>词面</th><th class="n" title="这个词由几个词根带出来（不是命中次数）">词根数</th>${showState ? "<th>状态</th>" : ""}<th class="hide-sm">来源词根</th></tr></thead>
       <tbody>${body}</tbody>
     </table>`;
}

/* ─────────────── 本周词库 · 折叠扩展区（6 组）───────────────
 * 全部收在 data-view="words" 里、默认收起的 <details>：一屏只多出几行小标题，
 * 不新增第 9 个视图，也不把页面堆满。
 * 🔴 每个渲染分支都必须处理「服务端没给这个字段」：如实说没有，不写 0、不写 undefined。
 *    旧服务端 / 只读演示版没有 asinDiff、roots、verifiedMarkets、compare，页面不能崩。
 */

// verifiedMarkets 缺失时的展示兜底：US 已验证、其余未验证。
// 这只是「页面上有哪些选项」，不是服务端认可的站点清单 —— 所以非 US 一律标「未实测」。
const W_MARKETS_FALLBACK = ["US", "UK", "DE", "FR", "JP", "CA", "IT", "ES"]
  .map((code) => ({ code, verified: code === "US" }));

// 词根管理：待提交的改动只在本次会话里攒着，点「保存」才 POST
const WROOTS = { added: [], removed: [], renamed: [], rows: [] };

/** 主响应（/api/keywords）到了之后，把「同一份响应里就带着」的几块填好，零额外请求。
 *  🔴 loadWords() 的默认请求必须原样保留（浏览器断言盯着它），所以这里绝不发请求。
 *     S-3 / G-4 的独立取数只由 <details> 的 toggle 事件驱动，见 bindWords()。
 */
function renderWordsPanels(d) {
  renderAsinDiff(d);      // S-4
  renderSitePanel(d);     // G-9
}

/* ── S-2 覆盖度体检 ───────────────────────────────────────────
 * 「用本周词库做覆盖度体检」：词从 /api/keywords 来，判定交给本地 listing.js。
 * 🔴 没写 Listing 时不给 0 —— 那不是「全部未覆盖」，是根本还没开始写。
 */
async function runWordsCoverage() {
  const out = $("#wCoverOut");
  if (!out) return;
  out.innerHTML = `<div class="note">正在对照…</div>`;

  S.listing = currentListing();
  const filled = [S.listing.title, S.listing.highlights, S.listing.description, S.listing.searchTerms]
    .some((v) => String(v || "").trim()) || (S.listing.bullets || []).some(Boolean);
  if (!filled) {
    out.innerHTML = `<div class="note warn"><b>先去写 Listing。</b>标题、五点、描述、后台词一个都没填，
      现在算出来的「未覆盖」不是缺口，是还没开始写。去「文案与质检」页填完再回来。</div>`;
    return;
  }

  let d;
  try {
    const resp = await fetch(apiUrl("/api/keywords?q=&limit=500"));
    d = await resp.json();
  } catch (e) {
    out.innerHTML = `<div class="note bad">读取本周词库失败：${escapeHtml(e.message)}</div>`;
    return;
  }
  // 词库没取到**不中断**：user 词照样能体检，vault 那一组由引擎标 ok:false，界面如实说「没取到」
  const words = d && d.ok && Array.isArray(d.keywords) ? d.keywords : [];
  const vaultFetchNote = d && d.ok ? "" : String(d?.error || "词库接口没返回 ok");

  // 词面 → 词根数 / 分组（给结构化 targets 用；没给就留 null，不编一个「1 个词根」出来）
  const meta = new Map();
  for (const k of words) {
    const t = typeof k === "string" ? k : k?.term;
    if (!t) continue;
    const rc = typeof k === "string" ? null : Number(k.rootCount ?? k.hits);
    meta.set(String(t).toLowerCase(), {
      rootCount: Number.isFinite(rc) && rc > 0 ? rc : null,
      groups: Array.isArray(k?.groups) ? k.groups : [],
    });
  }

  // 🔴 显式 targets：user 词来自后台词、vault 词来自本周词库，user 优先去重。
  //    只传 targetsFrom:"vault" 而不传 targets，扩展会把所有词都标成 vault、
  //    coverageUser 分母恒为 0 —— 那个参数就白传了。keywords 传合并后的词面数组。
  const userTerms = String(S.listing.searchTerms || "")
    .split(/[,，\n;]/).map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  const targets = [];
  for (const term of userTerms) {
    const key = term.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    targets.push({ term, from: "user", rootCount: 1, groups: [] });
  }
  for (const k of words) {
    const term = typeof k === "string" ? k : k?.term;
    if (!term) continue;
    const key = String(term).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const m = meta.get(key) || { rootCount: null, groups: [] };
    // 引擎要求 rootCount > 0，缺元数据时给中性占位 1；显示时仍按 meta 里的 null 判「不编数字」
    targets.push({ term: String(term), from: "vault", rootCount: m.rootCount ?? 1, groups: m.groups });
  }
  // 来源兜底：旧服务端 / 旧引擎不给 gapsDetail 时，仍按自己构造的 targets 判 user / vault，
  // 不把「我自己填的后台词」误标成「词库词」。词根数照样只认 meta，不用引擎的占位 1。
  const fromMap = new Map(targets.map((t) => [t.term.toLowerCase(), t.from]));
  const keywords = targets.map((t) => t.term);
  if (!keywords.length) {
    out.innerHTML = `<div class="note warn">没有可对照的词 —— 后台词和本周词库都没给到词。</div>`;
    return;
  }
  const userCount = targets.filter((t) => t.from === "user").length;
  const vaultCount = targets.filter((t) => t.from === "vault").length;

  let r;
  try {
    r = L.analyzeCoverage(S.listing, {
      keywords, targets, targetsFrom: "vault", top: Math.max(keywords.length, 500),
    });
  } catch (e) {
    out.innerHTML = `<div class="note bad">覆盖度引擎出错：${escapeHtml(e.message)}</div>`;
    return;
  }

  const finite = (v) => v != null && v !== "" && Number.isFinite(Number(v));
  // 未覆盖 = 逐词 score===0。优先 rows（改动前后都在）；没有 rows 才退回 gaps / unused。
  const rowList = Array.isArray(r?.rows) ? r.rows : [];
  let missing = rowList.filter((x) => Number(x.score) === 0);
  if (!rowList.length) {
    const alt = Array.isArray(r?.gaps) ? r.gaps : Array.isArray(r?.unused) ? r.unused : [];
    missing = alt
      .map((x) => (typeof x === "string" ? { term: x } : { term: x?.term, from: x?.from, rootCount: x?.rootCount }))
      .filter((x) => x.term);
  }
  // gapsDetail：引擎已按 rootCount × 未覆盖字段数 排好序、覆盖全部 targets。
  // 用它重排缺口，并给每条补「漏在哪些字段」的中文名；旧服务端没给 gapsDetail 时保持原顺序、不硬凑。
  const FIELD_CN = { title: "标题", bullets: "五点", description: "描述", searchTerms: "后台词" };
  const details = Array.isArray(r?.gapsDetail) ? r.gapsDetail : [];
  const detailMap = new Map();
  for (const g of details) if (g?.term) detailMap.set(String(g.term).toLowerCase(), g);
  const weight = (g) => (Number(g?.rootCount) || 0) * (Array.isArray(g?.missingIn) ? g.missingIn.length : 0);
  if (details.length) {
    missing.sort((a, b) => {
      const ga = detailMap.get(String(a.term).toLowerCase()) || {};
      const gb = detailMap.get(String(b.term).toLowerCase()) || {};
      return weight(gb) - weight(ga)
        || (Number(gb.rootCount) || 0) - (Number(ga.rootCount) || 0)
        || String(a.term).localeCompare(String(b.term));
    });
  }

  const n = (v) => Number(v || 0).toLocaleString("en-US");
  if (!rowList.length && !missing.length && !r?.total) {
    out.innerHTML = `<div class="note warn">引擎没返回可判定的词，这次给不出「未覆盖」结论。</div>`;
    return;
  }

  const shown = missing.slice(0, 60);
  const items = shown.map((x) => {
    const term = String(x.term || "");
    const g = detailMap.get(term.toLowerCase()) || {};
    const from = g.from || x.from || fromMap.get(term.toLowerCase());
    const own = meta.get(term.toLowerCase());
    let tag;
    if (from === "user") tag = `<span class="chip a">user</span>`;
    else if (own && Number.isFinite(own.rootCount) && own.rootCount > 0)
      tag = `<span class="chip">由 ${own.rootCount} 个词根带出</span>`;
    else tag = `<span class="chip">词库词</span>`;
    const miss = Array.isArray(g.missingIn) && g.missingIn.length
      ? `<span class="chip a">漏在：${g.missingIn.map((k) => escapeHtml(FIELD_CN[k] || k)).join(" / ")}</span>`
      : "";
    return `<span class="chip">${escapeHtml(term)}</span> ${tag} ${miss}`;
  }).join(" ");

  // 两个覆盖率分开算：各按自己的分母。分母为 0 → 「—」+「这一组没有词」，不显示 0%（0% 会被读成全没覆盖）。
  // vault.ok===false 时词库那一格留空并如实说明，不给假数字。
  const vaultOk = r?.vault?.ok === true;
  const pctHtml = (val, label, noGroup) => {
    if (noGroup) return `<div class="wcell"><b>—</b><span>${label} · 这一组没有词</span></div>`;
    if (!finite(val)) return `<div class="wcell"><b>—</b><span>${label} · 算不出</span></div>`;
    return `<div class="wcell"><b>${Number(val)}%</b><span>${label}</span></div>`;
  };
  const covHtml = `<div class="wstat" style="grid-template-columns:repeat(2,minmax(0,1fr))">
      ${pctHtml(r?.coverageUser, "我的后台词覆盖", userCount === 0)}
      ${vaultOk
        ? pctHtml(r?.coverageVault, "本周词库词覆盖", vaultCount === 0)
        : `<div class="wcell"><b>—</b><span>本周词库词覆盖 · 没取到</span></div>`}
    </div>
    <div class="note">这两个数各按<b>自己的分母</b>算（我的后台词 / 本周词库词），不是把两类词混成一个覆盖率。
      ${userCount === 0 ? "后台词这一组没有词，所以显示「—」而不是 0%。" : ""}
      ${vaultOk
        ? "引擎判定本周词库可用。"
        : `引擎标记 <b>本周词库没取到</b>（vault.ok=false，${escapeHtml(String(r?.vault?.reason || "missing"))}），所以词库那一格留空${vaultFetchNote ? `：${escapeHtml(vaultFetchNote)}` : ""}。`}</div>`;

  out.innerHTML = `<div class="note ${missing.length ? "warn" : "ok"}"><b>未覆盖 ${n(missing.length)} 个</b>
      —— 对照了 ${n(keywords.length)} 条候选词（后台词 ${n(userCount)} / 本周词库 ${n(vaultCount)}），
      下面是没出现在标题 / 五点 / 描述 / 后台词里的词。每条后面的标记说明它从哪来、带出多少词根、漏在哪些字段。</div>
    ${covHtml}
    <div class="hint" style="margin:8px 0">${items || "这批词都覆盖到了，没有缺口。"}</div>
    ${missing.length > shown.length ? `<div class="hint">只列前 ${shown.length} 条，共 ${n(missing.length)} 条；按「词根数 × 漏掉的字段数」排序。</div>` : ""}
    <div class="note">这是<b>文本覆盖</b>判定，不等于搜索排名或搜索量；补上去只是避免「核心词一个字都没提」。</div>`;
}

/* ── S-3 本周 vs 上周 ─────────────────────────────────────────
 * 独立取 /api/keywords?compare=prev（展开才发）。没有 prev 时如实说「还没法对比」，
 * 不显示 0 —— 「没比过」和「没变化」是两件事。
 */
async function loadWordsCompare() {
  const out = $("#wCompareOut");
  if (!out) return;
  out.innerHTML = `<div class="note">正在读取上一份快照…</div>`;
  let d;
  try {
    const r = await fetch(apiUrl("/api/keywords?compare=prev"));
    d = await r.json();
  } catch (e) {
    out.innerHTML = `<div class="note bad">读取对比失败：${escapeHtml(e.message)}</div>`;
    return;
  }
  const c = d && d.compare;
  if (!c || c.ok === false) {
    const why = c && c.reason ? `：${escapeHtml(String(c.reason))}` : "";
    out.innerHTML = `<div class="note warn">还没有上一份快照，暂时没法对比${why}。
      等下周再采一次，或手动留一份历史快照就有了 —— 这里不显示 0，因为「没比过」不等于「没变化」。</div>`;
    return;
  }
  const delta = c.delta || {};
  const label = (x) => {
    const s = typeof x === "string" ? x : String(x?.term ?? x?.asin ?? x?.root ?? x ?? "").slice(0, 60);
    return escapeHtml(s || "（未标名）");
  };
  const chips = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return `<span class="hint">（没有）</span>`;
    return arr.slice(0, 40).map((x) => `<span class="chip">${label(x)}</span>`).join(" ");
  };
  const snap = (x, title) => {
    if (x == null) return `<div class="card" style="margin:0"><b>${title}</b><div class="hint" style="margin:6px 0 0">这份快照服务端没给明细。</div></div>`;
    if (typeof x !== "object") return `<div class="card" style="margin:0"><b>${title}</b><div class="wmeta" style="margin:6px 0 0">${escapeHtml(String(x))}</div></div>`;
    const pick = (keys) => { for (const k of keys) if (x[k] != null) return x[k]; return null; };
    const bits = [];
    const kw = pick(["keywords", "keywordCount", "count", "terms"]);
    const as = pick(["asins", "asinCount"]);
    const day = pick(["generatedAt", "date", "at"]);
    if (kw != null) bits.push(`词 ${escapeHtml(String(kw))}`);
    if (as != null) bits.push(`ASIN ${escapeHtml(String(as))}`);
    if (day != null) bits.push(escapeHtml(String(day).slice(0, 10)));
    return `<div class="card" style="margin:0"><b>${title}</b>
      <div class="hint" style="margin:6px 0 0">${bits.length
        ? bits.map((b) => `<span class="chip" style="margin-right:4px">${b}</span>`).join("")
        : "服务端没给可识别的汇总字段。"}</div></div>`;
  };
  const count = (v) => (Array.isArray(v) ? v.length : null);
  const line = (title, arr) => `<div class="note"><b>${title} ${count(arr) == null ? "—" : count(arr)} 个</b>
      <div class="hint" style="margin-top:6px">${chips(arr)}</div></div>`;
  out.innerHTML = `
    <div class="grid c2" style="margin-bottom:12px">${snap(c.current, "本周")}${snap(c.prev, "上周")}</div>
    <div class="sec-mini">变化明细</div>
    <div class="grid c2">
      ${line("新词", delta.newTerms)}
      ${line("回归词", delta.returnedTerms)}
      ${line("掉出词", delta.droppedTerms)}
    </div>`;
}

/* ── S-4 ASIN 榜单变动 ─────────────────────────────────────── */
function renderAsinDiff(d) {
  const out = $("#wAsinOut");
  if (!out) return;
  const ad = d && d.asinDiff;
  const cnt = (v) => (Array.isArray(v) ? v.length : (v != null && Number.isFinite(Number(v)) ? Number(v) : null));
  if (!ad || typeof ad !== "object") {
    out.innerHTML = `<div class="note">暂无 ASIN 历史投影 —— 榜单变动要拿两份快照的 ASIN 排名算，服务端这次没返回 asinDiff。</div>`;
    return;
  }
  const e = cnt(ad.entered), l = cnt(ad.left), m = cnt(ad.moved);
  if (e === null && l === null && m === null) {
    out.innerHTML = `<div class="note">暂无 ASIN 历史投影 —— asinDiff 里没有可识别的 entered / left / moved。</div>`;
    return;
  }
  const list = (arr, title) => Array.isArray(arr) && arr.length
    ? `<div class="hint" style="margin-top:6px">${title}：${arr.slice(0, 20).map((x) => {
        const s = typeof x === "string" ? x : String(x?.asin ?? x?.term ?? x?.root ?? x ?? "").slice(0, 40);
        return `<span class="chip">${escapeHtml(s || "（未标名）")}</span>`;
      }).join(" ")}</div>`
    : "";
  out.innerHTML = `<div class="note info">本周新进榜单 ${e ?? "—"} 个，掉出 ${l ?? "—"} 个${m != null ? `，名次变动 ${m} 个` : ""}。
      这是名次集合的进出，不代表销量变化。</div>
    ${list(ad.entered, "新进")}${list(ad.left, "掉出")}`;
}

/* ── G-9 站点「可见但不承诺」───────────────────────────────────
 * 未验证项在 <option> 上带 data-verified="false"，选中时 select 自己也带上，
 * 并提示「类目映射可能不准，仅 US 经过实测」。
 */
function renderSitePanel(d) {
  const sel = $("#wSiteSel");
  if (!sel) return;
  const keep = sel.value;
  const raw = d && Array.isArray(d.verifiedMarkets) ? d.verifiedMarkets : null;
  const list = raw && raw.length
    ? raw.map((x) => ({ code: String(x?.code ?? "").toUpperCase(), verified: x?.verified === true })).filter((x) => x.code)
    : W_MARKETS_FALLBACK;
  sel.innerHTML = list.map((m) =>
    `<option value="${escapeHtml(m.code)}" data-verified="${m.verified ? "true" : "false"}">${m.verified ? "● 已实测" : "○ 未实测"} ${escapeHtml(m.code)}</option>`
  ).join("");
  const cur = String((d && d.site) || "US").toUpperCase();
  // 先保留用户已经选的那个站点：主表重新读取时别把人家的选择悄悄改回去
  if (keep && list.some((m) => m.code === keep)) sel.value = keep;
  else if (list.some((m) => m.code === cur)) sel.value = cur;
  updateSiteNote();
}

function updateSiteNote() {
  const sel = $("#wSiteSel");
  const box = $("#wSiteNote");
  if (!sel || !box) return;
  const opt = sel.selectedOptions && sel.selectedOptions[0];
  if (!opt) {
    sel.dataset.verified = "unknown";
    box.innerHTML = `<div class="note">站点清单还没读到，暂时没法判断哪个站点实测过。</div>`;
    return;
  }
  const verified = opt.dataset.verified !== "false";
  sel.dataset.verified = verified ? "true" : "false";
  const code = opt.value;
  box.innerHTML = verified
    ? `<div class="note ok">站点 <b>${escapeHtml(code)}</b> 已实测，类目 / 榜单结构按实测口径取。</div>`
    : `<div class="note warn"><b>类目映射可能不准，仅 US 经过实测。</b>站点 <b>${escapeHtml(code)}</b> 未实测（○ 未实测），
        抓取字段可能整块缺失；拿它做判断前先抽查几条，别把「没抓到」当成「没人搜」。</div>`;
}

/* ── G-4 词根管理面板 ─────────────────────────────────────────
 * 两份数据：/api/keyword-roots 给 groups/roots/notes/rejected，/api/keywords 的 roots
 * 给 planned/hit/zeroHit/top。形状服务端没逐字段钉死，所以解析一律走「兼容 + 如实」。
 */
function collectRootRows(kr, kwRoots) {
  const hits = new Map();
  if (Array.isArray(kwRoots?.top)) {
    for (const t of kwRoots.top) {
      const r = String(t?.root ?? t?.term ?? "").trim();
      const h = Number(t?.terms ?? t?.hits ?? t?.count);
      if (r && Number.isFinite(h)) hits.set(r.toLowerCase(), h);
    }
  }
  const zero = new Set(
    (Array.isArray(kwRoots?.zeroHit) ? kwRoots.zeroHit : [])
      .map((x) => String(typeof x === "string" ? x : (x?.root ?? x?.term ?? "")).trim().toLowerCase())
      .filter(Boolean)
  );
  const rows = [];
  const seen = new Set();
  const add = (root, group) => {
    const r = String(root ?? "").trim();
    if (!r) return;
    const k = r.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    rows.push({
      root: r,
      group: String(group ?? "").trim() || "—",
      hits: zero.has(k) ? 0 : (hits.has(k) ? hits.get(k) : null),
    });
  };
  const flat = (src, group) => {
    if (Array.isArray(src)) {
      for (const x of src) {
        if (typeof x === "string") add(x, group);
        else if (x && typeof x === "object") add(x.root ?? x.term ?? x.name, x.group ?? x.groups?.[0] ?? group);
      }
    } else if (src && typeof src === "object") {
      for (const [g, arr] of Object.entries(src)) {
        if (Array.isArray(arr)) flat(arr, g);
        else if (arr && typeof arr === "object") add(arr.root ?? arr.term, g);
      }
    }
  };
  flat(kr?.roots, "");
  if (!rows.length) flat(kr?.groups, "");
  // groups 只是「分组 → 词根」映射时，用它给还没分组的行补上
  const gs = kr?.groups;
  if (gs && typeof gs === "object" && !Array.isArray(gs)) {
    for (const row of rows) {
      if (row.group !== "—") continue;
      for (const [g, arr] of Object.entries(gs)) {
        if (Array.isArray(arr) && arr.some((x) =>
          String(typeof x === "string" ? x : (x?.root ?? x?.term ?? "")).toLowerCase() === row.root.toLowerCase())) {
          row.group = g;
          break;
        }
      }
    }
  }
  return rows;
}

/** 底部一行建议：条数 / 平均命中 / 零命中建议替换。缺数据就说算不出，不写 0。 */
function rootsAdvice(rows, kwRoots) {
  const withHits = rows.filter((r) => Number.isFinite(r.hits));
  const avg = withHits.length
    ? (withHits.reduce((s, r) => s + r.hits, 0) / withHits.length).toFixed(1)
    : null;
  const zeroList = (Array.isArray(kwRoots?.zeroHit) ? kwRoots.zeroHit : [])
    .map((x) => String(typeof x === "string" ? x : (x?.root ?? x?.term ?? "")).trim())
    .filter(Boolean);
  const parts = [`本组共 ${rows.length} 条`];
  parts.push(avg !== null ? `平均命中 ${avg}` : "平均命中算不出（服务端没给命中明细）");
  parts.push(zeroList.length
    ? `<code>${escapeHtml(zeroList[0])}</code> 本周 0 命中，建议替换${zeroList.length > 1 ? `（还有 ${zeroList.length - 1} 个）` : ""}`
    : "本周没有 0 命中的词根");
  return `<div class="note">${parts.join("，")}。</div>`;
}

/** rejected / notes 一律显式显示 —— 保存后「我删了但它还在」不能静默。 */
function rootsNotesHtml(kr) {
  const bits = [];
  const rejected = Array.isArray(kr?.rejected) ? kr.rejected : [];
  if (rejected.length) {
    bits.push(`<div class="note bad"><b>有 ${rejected.length} 条改动被驳回（没有静默吞掉）：</b>
      <div class="hint" style="margin-top:6px">${rejected.map((x) => {
        const s = typeof x === "string" ? x : `${x?.root ?? "?"}：${x?.reason ?? "没给原因"}`;
        return `<span class="chip r">${escapeHtml(s)}</span>`;
      }).join(" ")}</div></div>`);
  }
  const notes = kr?.notes;
  if (Array.isArray(notes) && notes.length) {
    bits.push(`<div class="note"><b>服务端说明：</b><div class="hint" style="margin-top:6px">${notes.map((x) => escapeHtml(String(x))).join("<br>")}</div></div>`);
  } else if (typeof notes === "string" && notes.trim()) {
    bits.push(`<div class="note"><b>服务端说明：</b>${escapeHtml(notes)}</div>`);
  }
  return bits.join("");
}

function renderRootsPanel(kr, kwRoots) {
  const out = $("#wRootsOut");
  const msg = $("#wRootsMsg");
  if (!out) return;
  WROOTS.rows = collectRootRows(kr, kwRoots);
  const rows = WROOTS.rows;
  if (!rows.length) {
    out.innerHTML = `<div class="note warn">词根管理数据没读到可识别的词根明细 —— 服务端 /api/keyword-roots
      返回的 groups / roots 形状不认识，或暂时没有词根。这里不编一份空表格，也不显示 0 条命中。</div>
      ${rootsNotesHtml(kr)}`;
    return;
  }
  const body = rows.slice(0, 200).map((r) => `<tr>
      <td><b>${escapeHtml(r.root)}</b></td>
      <td>${escapeHtml(r.group)}</td>
      <td class="num">${Number.isFinite(r.hits) ? r.hits : "—"}</td>
      <td><button class="btn ghost sm" data-wroot-del="${escapeHtml(r.root)}">删除</button></td>
    </tr>`).join("");
  out.innerHTML = `${rootsNotesHtml(kr)}
    <table class="tbl">
      <thead><tr><th>词根</th><th>分组</th><th>本周命中词数</th><th>操作</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    ${rows.length > 200 ? `<div class="hint">只列前 200 条，共 ${rows.length} 条。</div>` : ""}
    ${rootsAdvice(rows, kwRoots)}`;
  // 删除按钮是 innerHTML 动态生成的，用 data-* + 事件委托，不给它们 id
  out.querySelectorAll("[data-wroot-del]").forEach((b) =>
    b.addEventListener("click", () => {
      const root = b.getAttribute("data-wroot-del");
      if (!WROOTS.removed.includes(root)) WROOTS.removed.push(root);
      b.disabled = true;
      b.textContent = "待删除";
      if (msg) msg.textContent = `未保存的改动：待删除 ${WROOTS.removed.length}${WROOTS.added.length ? ` / 待添加 ${WROOTS.added.length}` : ""}（点「保存词根改动」提交）`;
    })
  );
}

async function loadRootsPanel() {
  const out = $("#wRootsOut");
  if (!out) return;
  out.innerHTML = `<div class="note">正在读取词根…</div>`;
  let kr, kw;
  try {
    kr = await fetch(apiUrl("/api/keyword-roots")).then((r) => r.json());
  } catch (e) {
    out.innerHTML = `<div class="note bad">读取词根失败：${escapeHtml(e.message)}。词根管理需要本地服务支持 /api/keyword-roots。</div>`;
    return;
  }
  // 命中明细只从主响应里取（loadWords 已经取过），**不再额外发 /api/keywords**：
  // loadWords() 的默认请求要原样保留，展开折叠区不该再打一次词库接口。
  // 主响应还没到 / 没给 roots 时，表格照出但「本周命中词数」显示「—」，建议里如实说算不出。
  kw = S.words && S.words.ok ? S.words.roots : null;
  if (!kr || kr.ok === false) {
    out.innerHTML = `<div class="note warn">词根管理数据没读到：${escapeHtml(kr?.error || "服务端没返回 /api/keyword-roots")}。
      这里不显示空表格，也不给 0 命中。</div>${rootsNotesHtml(kr)}`;
    return;
  }
  // kw 缺失时表格照出，但「本周命中词数」只能是「—」，建议里也如实说算不出
  renderRootsPanel(kr, kw);
}

function addRootPending() {
  const msg = $("#wRootsMsg");
  const root = ($("#wRootAdd")?.value || "").trim();
  const group = ($("#wRootAddGroup")?.value || "").trim();
  if (!root) {
    if (msg) msg.innerHTML = `<div class="note warn">先填词根再点添加。</div>`;
    return;
  }
  WROOTS.added.push({ root, group });
  $("#wRootAdd").value = "";
  if (msg) msg.innerHTML = `<div class="note">已把「${escapeHtml(root)}」加入待添加（分组 ${escapeHtml(group || "未填")}），
    还没提交 —— 点「保存词根改动」才会写进服务端。</div>`;
}

function delRootPending() {
  const msg = $("#wRootsMsg");
  const root = ($("#wRootDel")?.value || "").trim();
  if (!root) {
    if (msg) msg.innerHTML = `<div class="note warn">先填要删除的词根。</div>`;
    return;
  }
  if (!WROOTS.removed.includes(root)) WROOTS.removed.push(root);
  $("#wRootDel").value = "";
  if (msg) msg.innerHTML = `<div class="note">已把「${escapeHtml(root)}」加入待删除，
    还没提交 —— 点「保存词根改动」才会写进服务端。</div>`;
}

async function saveRoots() {
  const msg = $("#wRootsMsg");
  if (!WROOTS.added.length && !WROOTS.removed.length && !WROOTS.renamed.length) {
    if (msg) msg.innerHTML = `<div class="note warn">还没有改动：先添加或删除一个词根，再点保存。</div>`;
    return;
  }
  if (msg) msg.innerHTML = `<div class="note">正在保存…</div>`;
  try {
    const resp = await fetch(apiUrl("/api/keyword-roots"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ added: WROOTS.added, removed: WROOTS.removed, renamed: WROOTS.renamed }),
    });
    const d = await resp.json();
    const rejected = Array.isArray(d?.rejected) ? d.rejected : [];
    const notes = d?.notes;
    const hasNotes = Array.isArray(notes) ? notes.length > 0 : Boolean(String(notes || "").trim());
    WROOTS.added = [];
    WROOTS.removed = [];
    WROOTS.renamed = [];
    if (msg) msg.innerHTML = `<div class="note ${rejected.length ? "warn" : "ok"}">
        ${resp.ok && d?.ok !== false ? "已保存，词根表已按服务端返回刷新。" : "保存请求已发出，但服务端没确认成功。"}
        <b>被驳回 ${rejected.length} 条</b>（${rejected.length ? "明细见下方，没有静默吞掉" : "没有改动被驳回"}）；
        ${hasNotes ? "服务端说明见下方" : "服务端没给额外说明"}。</div>`;
    // POST 与 GET 同形状，直接拿它刷新表格（这就是「保存后刷新」）
    renderRootsPanel(d, S.words?.roots);
  } catch (e) {
    if (msg) msg.innerHTML = `<div class="note bad">保存失败：${escapeHtml(e.message)}（改动还留着，可重试）。</div>`;
  }
}

/* ── P2 #10 CSV 导出 ──────────────────────────────────────────
 * GET /api/export?kind=keywords|asins → text/csv（UTF-8 BOM）。
 * 🔴 fetch().text() 会剥掉 BOM，所以落盘前补回去，保证首字节 EF BB BF。
 *    拿不到接口就如实报「导出失败：…」，不假装成功。
 */
async function exportWordsCsv(kind) {
  const out = $("#wExpOut");
  if (!out) return;
  out.innerHTML = `<div class="note">正在导出…</div>`;
  try {
    const resp = await fetch(apiUrl(`/api/export?kind=${encodeURIComponent(kind)}`));
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText || ""}`.trim());
    const text = await resp.text();
    if (!text) throw new Error("接口返回了空内容");
    const csv = text.charCodeAt(0) === 0xFEFF ? text : "\uFEFF" + text;
    const day = new Date().toISOString().slice(0, 10);
    downloadText(`词库-${kind}-${day}.csv`, csv, "text/csv;charset=utf-8");
    out.innerHTML = `<div class="note ok">已导出${kind === "keywords" ? "词表" : "ASIN"} CSV（${csv.length} 字符，含 BOM）。
      若浏览器没弹下载，检查是否被拦截。</div>`;
  } catch (e) {
    out.innerHTML = `<div class="note bad">导出失败：${escapeHtml(e.message)}。
      需要本地服务提供 /api/export，且服务端是完整版（不是只读演示版）。</div>`;
  }
}


/* ─────────────── 外部数据源（第三方 MCP）───────────────
 * 分工：**出网与密钥都在服务端**（assets/mcp-http.js + server.mjs 的 /api/external/*）。
 * 这一层只负责让人看得见、点得到：配密钥 → 列工具 → 填参数 → 调用/导入 → 回词库看对比。
 *
 * 🔴 三条不做：
 *   ① 密钥不进 localStorage、不回填输入框 —— 保存成功后立刻清空，页面上只留末四位掩码；
 *   ② 不替使用者猜参数 —— 参数框的骨架只来自对方 `inputSchema` 里的 required；
 *   ③ 不把回包塞进对话 —— 原始返回动辄上百 KB，这里是"看"的地方，不是"发"的地方。
 */
const EXT = { providers: [], tools: [], run: null, tested: false, server: null, demo: false };

async function extLoadProviders() {
  const sel = $("#extProvider");
  if (!sel) return;
  try {
    const r = await fetch(apiUrl("/api/external/providers"));
    const d = await r.json();
    EXT.providers = d.providers || [];
    sel.innerHTML = EXT.providers
      .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`)
      .join("");
    extRenderStatus();
  } catch (e) {
    const box = $("#extStatus");
    if (box) box.innerHTML = `<span>读取失败：${escapeHtml(e.message)}</span>
      <br><small>这一块需要本地服务（<code>node server.mjs</code>）；直接双击打开页面时不可用。</small>`;
  }
}

const extCurrent = () => {
  const id = $("#extProvider")?.value;
  return EXT.providers.find((p) => p.id === id) || EXT.providers[0] || null;
};

function extRenderStatus() {
  const box = $("#extStatus");
  if (!box) return;
  // 线上只读演示版：先说清楚"这里不能配"，而不是让人填完密钥才吃一个 403。
  // 判据来自 /api/health 的 capabilities.readonly（服务端自己说的，不是猜的）。
  if (S.probe?.capabilities?.readonly) {
    box.innerHTML = `线上演示版是<b>只读</b>的：这里不能保存密钥（否则访客就能用站长账号的额度）。<br>
      <small>把项目拉到本地跑 <code>node server.mjs</code>，就能填自己的密钥。「看示例对比」不受影响。</small>`;
    const b = $("#btnExtSaveTest");
    if (b) { b.disabled = true; b.textContent = "演示版只读"; }
    return;
  }
  const p = extCurrent();
  if (!p) { box.textContent = EXT.providers.length ? "没有可用的数据源。" : "正在读取…"; return; }
  if (EXT.tested && EXT.server) {
    const v = EXT.server.version ? ` v${escapeHtml(EXT.server.version)}` : "";
    box.innerHTML = `<span class="okdot">●</span> 已连通 <b>${escapeHtml(EXT.server.name || "服务端")}</b>${v}
      · ${EXT.tools.length} 个工具 · <code>${escapeHtml(p.url)}</code>`;
    return;
  }
  box.innerHTML = p.configured
    ? `已保存密钥 <code>${escapeHtml(p.keyHint)}</code>（还没验证）—— 点「保存并测试」走一次握手，能看到工具列表才算通。`
    : `还没配密钥。${escapeHtml(p.note || "")}`;
}

async function extSaveAndTest() {
  const p = extCurrent();
  const btn = $("#btnExtSaveTest");
  if (!p || !btn) return;
  const key = ($("#extKey")?.value || "").trim();
  if (!key) {
    $("#extStatus").innerHTML = "先把密钥填进去 —— 这是<b>你自己</b>在服务商后台生成的，本项目不内置、也不代付。";
    return;
  }
  btn.disabled = true;
  const step = (t) => { $("#extStatus").textContent = t; };
  try {
    step("写入本机 .env.local…");
    const w = await fetch(apiUrl("/api/config"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [`${p.id}Key`]: key }),
    });
    const wj = await w.json();
    if (!wj.ok) throw new Error(wj.error || `写入失败（HTTP ${w.status}）`);
    $("#extKey").value = "";   // 不在页面上留值

    step("握手 + 列工具…");
    const t = await fetch(apiUrl("/api/external/test"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: p.id }),
    });
    const tj = await t.json();
    if (!tj.ok) throw new Error(`${tj.error || "测试失败"}${tj.hint ? `\n${tj.hint}` : ""}`);
    EXT.tested = true;
    EXT.server = tj.server || {};
    EXT.tools = tj.tools || [];
    const me = EXT.providers.find((x) => x.id === p.id);
    if (me) me.configured = true;
    extRenderStatus();
    extRenderTools();
  } catch (e) {
    EXT.tested = false;
    EXT.tools = [];
    extRenderTools();
    $("#extStatus").innerHTML = `<span class="bad">失败：</span>${escapeHtml(String(e.message)).replace(/\n/g, "<br>")}
      <br><small>密钥已尽力写入（写入失败会明说）；「测试」失败说明握手没过，不是界面坏了。</small>`;
  } finally {
    btn.disabled = false;
  }
}

function extRenderTools() {
  const box = $("#extTools");
  if (!box) return;
  if (!EXT.tools.length) { box.innerHTML = ""; return; }
  box.innerHTML =
    `<div class="wmeta">可用工具 ${EXT.tools.length} 个 —— 先看清哪个是「反查流量词 / 关键词研究」，再决定导哪个。</div>` +
    EXT.tools
      .map(
        (t) => `<div class="extool">
          <div class="extool-h"><code>${escapeHtml(t.name)}</code><span>${escapeHtml(t.description || "")}</span></div>
          <div class="rowline">
            <button class="btn ghost sm" data-ext-run="${escapeHtml(t.name)}">调用（看原始返回）</button>
            <button class="btn ghost sm" data-ext-import="${escapeHtml(t.name)}">导入成词表</button>
          </div>
        </div>`
      )
      .join("");
  $$("[data-ext-run]", box).forEach((b) => b.addEventListener("click", () => extOpenRun(b.dataset.extRun, "call")));
  $$("[data-ext-import]", box).forEach((b) => b.addEventListener("click", () => extOpenRun(b.dataset.extImport, "import")));
}

function extOpenRun(name, mode) {
  const t = EXT.tools.find((x) => x.name === name);
  if (!t) return;
  EXT.run = { name, mode };
  const params = t.params || [];
  const skeleton = {};
  for (const p of params.filter((x) => x.required)) {
    skeleton[p.name] = p.type === "number" ? 0 : p.type === "boolean" ? false : "";
  }
  const hint = params.length
    ? params.map((p) => `<code>${escapeHtml(p.name)}</code>${p.required ? "<b>*</b>" : ""}${p.type ? `:${escapeHtml(p.type)}` : ""}`).join(" · ")
    : "这个工具没声明参数（直接执行即可）。";
  let box = $("#extRun");
  if (!box) {
    box = document.createElement("div");
    box.id = "extRun";
    $("#extTools").appendChild(box);
  }
  box.hidden = false;
  box.className = "extrun";
  box.innerHTML = `
    <div class="wmeta"><code>${escapeHtml(name)}</code> · ${mode === "import" ? "调用后归一成词表并存盘" : "原样调用，不改写返回"}</div>
    <p class="hint">参数：${hint}<br>必填项是对方声明的；本项目不替你猜参数 —— 缺了对方会自己报错，那句话比这里编一个更有用。</p>
    <textarea class="field" id="extArgs" rows="4" spellcheck="false">${escapeHtml(JSON.stringify(skeleton, null, 2))}</textarea>
    <div class="rowline">
      <button class="btn primary sm" id="btnExtExec">${mode === "import" ? "调用并导入" : "执行"}</button>
      <button class="btn ghost sm" id="btnExtClose">收起</button>
      <span class="hint" id="extExecNote"></span>
    </div>
    <div id="extOut"></div>`;
  $("#btnExtClose").addEventListener("click", () => { box.hidden = true; });
  $("#btnExtExec").addEventListener("click", extExec);
  box.scrollIntoView({ block: "nearest" });
}

async function extExec() {
  const p = extCurrent();
  const run = EXT.run;
  if (!p || !run) return;
  let args;
  try {
    args = JSON.parse($("#extArgs").value || "{}");
  } catch (e) {
    $("#extOut").innerHTML = `<div class="note bad">参数不是合法 JSON：${escapeHtml(e.message)}</div>`;
    return;
  }
  const btn = $("#btnExtExec");
  btn.disabled = true;
  $("#extExecNote").textContent = "请求中（对方可能要几秒）…";
  const path = run.mode === "import" ? "/api/external/import" : "/api/external/call";
  const t0 = performance.now();
  try {
    const r = await fetch(apiUrl(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: p.id, tool: run.name, args }),
    });
    const d = await r.json();
    $("#extExecNote").textContent = `${Math.round(performance.now() - t0)} ms`;
    if (!d.ok) {
      $("#extOut").innerHTML =
        `<div class="note bad"><b>${escapeHtml(d.error || "调用失败")}</b>
          ${d.hint ? `<br><small>${escapeHtml(d.hint)}</small>` : ""}</div>` +
        (d.text ? `<pre class="code">${escapeHtml(String(d.text).slice(0, 2000))}</pre>` : "");
      return;
    }
    if (run.mode === "import") renderExtImport(d);
    else renderExtCall(d);
  } catch (e) {
    $("#extOut").innerHTML = `<div class="note bad">请求没发成功：${escapeHtml(e.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

function renderExtCall(d) {
  const kb = (Number(d.bytes || 0) / 1024).toFixed(1);
  $("#extOut").innerHTML = `<div class="note">
      回包 <b>${kb} KB</b>${d.truncated ? "（超出 200 KB，已截断显示）" : ""} · ${d.ms} ms
      <br><small>这个体积放进对话大约是 ${Math.round(Number(d.bytes || 0) / 3.5).toLocaleString("en-US")} token 量级的上下文 —— 只想知道有哪些词，用「导入成词表」更省。</small>
    </div>
    <pre class="code">${escapeHtml(String(d.text || "").slice(0, 4000))}</pre>`;
}

function renderExtImport(d) {
  const n = (v) => Number(v || 0).toLocaleString("en-US");
  const map = Object.entries(d.mapping || {}).map(([k, v]) => `${v}→${k}`).join(" · ") || "—";
  const rows = (d.preview || [])
    .map(
      (t) => `<tr><td class="t">${escapeHtml(t.term)}</td>
        <td class="n">${t.volume == null ? "—" : n(t.volume)}</td>
        <td class="n">${t.rank == null ? "—" : escapeHtml(String(t.rank))}</td></tr>`
    )
    .join("");
  $("#extOut").innerHTML =
    `<div class="note ${d.count ? "ok" : "warn"}">
      <b>认出 ${n(d.count)} 条词</b> · 字段映射 ${escapeHtml(map)} · 回包 ${(Number(d.bytes || 0) / 1024).toFixed(1)} KB
      ${d.why ? `<br><small>${escapeHtml(d.why)}</small>` : ""}
      ${d.count ? `<br><small>已存到 <code>${escapeHtml(d.file)}</code>。到「本周词库」页能看它和本地词库的交集与盲区。</small>` : ""}
    </div>` +
    (rows
      ? `<table class="wt"><thead><tr><th>词面</th><th class="n">搜索量</th><th class="n">排名</th></tr></thead><tbody>${rows}</tbody></table>`
      : "") +
    (d.count ? `<div class="rowline" style="margin-top:8px"><button class="btn sm primary" id="btnExtToWords">去词库页看对比</button></div>` : "");
  const go = $("#btnExtToWords");
  if (go) go.addEventListener("click", () => goView("words"));
}

/* 词库页顶部的「外部词表」块：**没导入就整块不出现**，
 * 因为这一页的原则是"只放当前能用的东西"，不摆一个永远空着的占位。 */
async function loadWordsExt() {
  const box = $("#wordsExt");
  if (!box) return;
  try {
    // EXT.demo = 「我现在看的是示例，不是我自己导的」——只影响这一次请求，不落盘、不进存储
    const r = await fetch(apiUrl(`/api/external/terms?compare=1${EXT.demo ? "&demo=1" : ""}`));
    const d = await r.json();
    if (!d.ok) { box.innerHTML = ""; return; }
    renderWordsExt(d);
  } catch {
    box.innerHTML = "";   // 服务没起时词库表本身已经报错，这里不叠第二条
  }
}

function renderWordsExt(d) {
  const box = $("#wordsExt");
  if (!box) return;
  const n = (v) => Number(v || 0).toLocaleString("en-US");
  const c = d.compare || {};
  const when = (() => {
    const t = new Date(d.at);
    if (Number.isNaN(t.getTime())) return "—";
    const p = (x) => String(x).padStart(2, "0");
    return `${t.getMonth() + 1}/${t.getDate()} ${p(t.getHours())}:${p(t.getMinutes())}`;
  })();
  const blind = (c.externalOnly || []).slice(0, 12);
  box.innerHTML = `<div class="card">
    <div class="wmeta">外部词表 · <b>${escapeHtml(d.label || d.provider)}</b> · <code>${escapeHtml(d.tool)}</code>
      · ${n(d.count)} 词 · ${d.demo ? "<b>示例数据</b>" : `导入于 ${escapeHtml(when)}`}</div>
    ${d.demo ? `<div class="note warn" style="margin:8px 0">这是<b>示例数据</b>，不是你账户里的数据 —— 只为让你先看清"导入之后长什么样"。
      下面的对比是<b>真的</b>：拿这 12 个示例词和你本地 <b>${n(d.compare?.localCount)}</b> 词实际求的交集。
      <button class="btn ghost sm" id="btnExtReal" style="margin-left:6px">看我自己的数据</button></div>` : ""}
    ${
      c.ok
        ? `<div class="wstat" style="margin-top:8px;grid-template-columns:repeat(3,minmax(0,1fr))">
             ${wordsCells([
               [n(c.externalOnlyCount), "外部有 · 本地没抓到"],
               [n(c.bothCount), "两边都有"],
               [n(c.localOnlyCount), "本地有 · 外部没有"],
             ])}
           </div>
           <p class="hint" style="margin:0">第一格是<b>本地采集的盲区</b>：这些词在外部数据里是真的，只是本地周词库没抓到 ——
             值得单独看要不要打，别读成"没需求"。对比用的是本地全量 ${n(c.localCount)} 词，不是上面那一页截断后的 500 条。</p>
           ${blind.length ? `<div class="hint" style="margin-top:8px">盲区前 ${blind.length} 个：${blind
             .map((t) => `<span class="chip">${escapeHtml(t.term)}</span>`)
             .join(" ")}</div>` : ""}`
        : `<div class="note warn" style="margin-top:8px">词表在，但暂时没法对比：${escapeHtml(c.hint || c.reason || "本地还没有周词库")}</div>`
    }
  </div>`;
  const real = $("#btnExtReal");
  if (real) real.addEventListener("click", () => { EXT.demo = false; loadWords(); });
}

function bindExternal() {
  extLoadProviders();
  const btn = $("#btnExtSaveTest");
  if (btn) btn.addEventListener("click", extSaveAndTest);
  const demo = $("#btnExtDemo");
  if (demo) demo.addEventListener("click", () => { EXT.demo = true; goView("words"); });
  const sel = $("#extProvider");
  if (sel) sel.addEventListener("change", () => { EXT.tested = false; EXT.tools = []; EXT.server = null; extRenderTools(); extRenderStatus(); });
}

/* ─────────────────────── 设置 ─────────────────────── */

/**
 * 抠图插件状态。**只读**：REMBG_URL 是环境变量，不在页面里改 ——
 * 页面能改的东西越少，越不会出现"设置页显示已启用、服务端其实没读"这种错位。
 */
function renderRembgStatus() {
  const el = $("#rembgStatus");
  if (!el) return;
  if (!S.probe.online) {
    el.textContent = "本地服务没在跑，判断不了。启动 node server.mjs 后再看。";
    return;
  }
  el.textContent = S.probe.capabilities?.rembg
    ? "已启用：图片库每张图会多一个「抠图」按钮，结果存进 data/gen。"
    : "未启用（REMBG_URL 未配置）。这不影响其它任何功能 —— 少的就是「一键去背景」这一步。";
}

function bindSettings() {
  $("#btnSaveCfg").addEventListener("click", async () => {
    setConfig({
      serverUrl: $("#sServer").value.trim(),
      imageBaseUrl: $("#sImgBase").value.trim(),
      imageModel: $("#sImgModel").value.trim(),
      imageApiKey: $("#sImgKey").value.trim(),
      imageMode: $("#sImgMode").value,
      imageResolution: $("#sRes").value,
      chatBaseUrl: $("#sChatBase").value.trim(),
      chatModel: $("#sChatModel").value.trim(),
      chatApiKey: $("#sChatKey").value.trim(),
      visionModel: $("#sVisionModel").value.trim(),
      enableAiPolish: $("#sPolish").checked,
    });
    clearProbeCache();
    S.probe = await probeServer({ force: true });
    renderStatus();
    reflectConfigIntoUI();
    $("#cfgSaved").textContent = "已保存 " + new Date().toLocaleTimeString();
    setTimeout(() => ($("#cfgSaved").textContent = ""), 2500);
  });
  $("#btnSaveKeyToServer").addEventListener("click", async () => {
    const key = $("#sImgKey").value.trim();
    if (!key) { $("#cfgSaved").textContent = "请先填写 API Key"; return; }
    try {
      const resp = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBaseUrl: $("#sImgBase").value.trim(),
          imageModel: $("#sImgModel").value.trim(),
          imageApiKey: key,
          imageMode: $("#sImgMode").value,
          imageResolution: $("#sRes").value,
        }),
      });
      const j = await resp.json();
      $("#cfgSaved").textContent = j.ok ? "已写入服务端配置（仅内存 + 本机 .env.local）" : "写入失败：" + (j.error || "");
    } catch (e) {
      $("#cfgSaved").textContent = "写入失败：" + e.message + "（需要先启动本地服务）";
    }
    clearProbeCache();
    S.probe = await probeServer({ force: true });
    renderStatus();
  });
  $("#btnReset").addEventListener("click", () => {
    localStorage.removeItem("clx_listing_workbench_config");
    syncSettingsForm();
    $("#cfgSaved").textContent = "已恢复默认";
  });
  $("#btnRecheck").addEventListener("click", async () => {
    clearProbeCache();
    S.probe = await probeServer({ force: true });
    renderStatus();
    reflectConfigIntoUI();
    $("#healthOut").textContent = JSON.stringify(S.probe, null, 2);
  });
  // 两张卡各一个「测试连接」：探的是**表单里当前填的值**，不用先保存
  $("#btnTestImg").addEventListener("click", () => testConfigConn("image"));
  $("#btnTestChat").addEventListener("click", () => testConfigConn("chat"));
}

/**
 * 配置自检：POST /api/config/test，服务端只 GET `{baseUrl}/models`。
 * 不生成图片、不发对话 —— 也就是说**不产生额度**。
 *
 * 🔴 结果必须分三档显示，不能压成"成功/失败"：
 *    绿 = 通了且密钥被验证；黄 = 端点可达但没能验证密钥；红 = 真的没通。
 *    把黄的说成绿，就是"数据不足算通过"，这条在全项目都是禁止的。
 */
async function testConfigConn(target) {
  const isImg = target === "image";
  const btn = $(isImg ? "#btnTestImg" : "#btnTestChat");
  const out = $(isImg ? "#testImgOut" : "#testChatOut");
  const fields = isImg
    ? { baseUrl: $("#sImgBase").value.trim(), model: $("#sImgModel").value.trim(), apiKey: $("#sImgKey").value.trim() }
    : { baseUrl: $("#sChatBase").value.trim(), model: $("#sChatModel").value.trim(), apiKey: $("#sChatKey").value.trim() };

  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "测试中…";
  out.className = "hint";
  out.textContent = "正在请求 /models …";

  try {
    const resp = await fetch(apiUrl("/api/config/test"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target, ...fields }),
    });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok && !j.error) throw new Error(`HTTP ${resp.status}`);

    if (j.ok && j.verified) {
      const bits = [`通 · ${j.host} · ${j.ms}ms`];
      if (j.modelFound === true) bits.push(`模型 ${j.model} 在清单里`);
      else if (j.modelFound === false) bits.push(j.warning || `清单里没有 ${j.model}`);
      else if (j.note) bits.push(j.note);
      out.className = j.modelFound === false ? "hint warn" : "hint ok";
      out.textContent = (j.modelFound === false ? "⚠ " : "✓ ") + bits.join(" · ");
    } else if (j.ok && j.verified === false) {
      // 端点活着，但密钥没被验证过 —— 黄字，不冒充成功
      out.className = "hint warn";
      out.textContent = `⚠ ${j.error || j.note || "端点可达，但没能验证密钥"}${j.hint ? ` ${j.hint}` : ""}`;
    } else if (j.readonly) {
      out.className = "hint warn";
      out.textContent = "线上演示版为只读，不能拿站长的密钥探活。";
    } else {
      out.className = "hint bad";
      out.textContent = `✗ ${j.error || `HTTP ${resp.status}`}${j.hint ? ` ${j.hint}` : ""}`;
    }
  } catch (e) {
    out.className = "hint bad";
    out.textContent = `✗ ${e.message}（需要先 node server.mjs 启动本地服务）`;
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

function syncSettingsForm() {
  const c = getConfig();
  $("#sServer").value = c.serverUrl || "";
  $("#sImgBase").value = c.imageBaseUrl || "";
  $("#sImgModel").value = c.imageModel || "";
  $("#sImgKey").value = c.imageApiKey || "";
  $("#sImgMode").value = c.imageMode || "auto";
  $("#sRes").value = c.imageResolution || "2k";
  $("#sChatBase").value = c.chatBaseUrl || "";
  $("#sChatModel").value = c.chatModel || "";
  $("#sChatKey").value = c.chatApiKey || "";
  $("#sVisionModel").value = c.visionModel || "";
  $("#sPolish").checked = Boolean(c.enableAiPolish);
  $("#healthOut").textContent = "点「重新探测」查看本地服务能力。";
  renderRembgStatus();
}

document.addEventListener("DOMContentLoaded", boot);
