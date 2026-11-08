/**
 * 原生 <select> 的自绘替身（渐进增强，不替换元素）。
 *
 * 🔴 为什么要自己画（2026-10-30 排查结论，可直接复核）：
 *   原生 <select> 的下拉是**操作系统窗口**，位置由 Chromium 算，页面 CSS/JS 改不了。
 *   本页 10 个 select 全都长这样：
 *     .app{height:100vh;overflow:hidden} → .main{overflow:hidden} → .view{overflow:hidden}
 *       → .pane-scroll{overflow-y:auto} → <label class="f"><select class="in">
 *   在 Windows 150% 显示缩放（本机实测 devicePixelRatio=1.5）下，点开「类目」时下拉会画到
 *   侧栏上方、离触发它的框几百像素（两张截图量出来的偏移分别是 (−938,−194) 与 (−518,−272)）。
 *   同一元素、同一渲染比例、两次偏移不同 → 不可能是 CSS 造成的（CSS 偏移是确定性的），
 *   只能是浏览器 popup 定位算错。所以**只能不用原生 popup**，改不了它。
 *
 * 做法（关键设计）：
 *   · 原生 <select> **保留**，只设 `pointer-events:none; opacity:0`，仍然待在文档流里
 *     —— 所以现有全部代码 `$("#cpCat").value` / `selectedOptions[0].textContent` /
 *     `innerHTML = "<option>…"` 重建、以及 655 条回归断言**一行都不用改**。
 *   · 在它上面盖一个按钮显示当前选项；点按钮 → 自己画 div.selpop，位置用
 *     getBoundingClientRect() + 视口 clamp，必要时向上翻转。
 *   · 选完之后写回 select.value 并派发**真实的 change 事件** → 原有 change 处理器全部照跑。
 *   · 弹层挂在 document.body（position:fixed）→ 不受任何祖先 overflow 裁切。
 *
 * 没被增强的 select（浏览器太老 / JS 出错）仍然是原生控件，功能不会丢。
 */

/** 已经增强过的标记，重复调用不会套两层 */
const MARK = "data-selui";

let seq = 0;
let openPop = null;      // 当前打开的那个 { pop, btn, sel, items, active }

/** 关闭当前弹层（不写值） */
function closePop() {
  if (!openPop) return;
  const { pop, btn } = openPop;
  try { pop.remove(); } catch { /* 已被移除 */ }
  btn.setAttribute("aria-expanded", "false");
  openPop = null;
}

/**
 * 把弹层摆在按钮旁边：优先向下，放不下且上方更宽裕则向上翻；左右贴边收回来。
 * 用 position:fixed，坐标是视口坐标，不受任何滚动容器影响。
 */
function placePop() {
  if (!openPop) return;
  const { pop, btn } = openPop;
  const r = btn.getBoundingClientRect();
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const GAP = 4, EDGE = 8;
  const maxH = Math.max(120, Math.min(320, vh - EDGE * 2));
  pop.style.maxHeight = maxH + "px";

  // 宽度：至少与按钮同宽；选项文字比按钮长时往右长出去（上限 520 或视口内），
  // 否则「美国站（www.amazon.com）」这种会被截成省略号，等于看不全。
  let w = Math.max(Math.round(r.width), 180);
  pop.style.width = w + "px";
  const need = Math.min(pop.scrollWidth || w, Math.min(520, vw - EDGE * 2));
  if (need > w) { w = need; pop.style.width = w + "px"; }

  const h = Math.min(pop.scrollHeight || maxH, maxH);
  const below = vh - r.bottom - GAP - EDGE;   // 下方可用
  const above = r.top - GAP - EDGE;           // 上方可用
  const openUp = below < Math.min(h, 160) && above > below;

  let top = openUp ? r.top - h - GAP : r.bottom + GAP;
  top = Math.max(EDGE, Math.min(top, vh - h - EDGE));

  const left = Math.max(EDGE, Math.min(Math.round(r.left), vw - w - EDGE));

  pop.style.top = Math.round(top) + "px";
  pop.style.left = left + "px";
  pop.style.width = w + "px";
}

/** 把 select 的当前值同步到按钮文字上（值可能来自程序、也可能来自原生键盘操作） */
function syncBtn(rec) {
  const { sel, btn } = rec;
  const opt = sel.selectedOptions && sel.selectedOptions[0];
  const label = opt ? opt.textContent : "";
  const span = btn.querySelector(".selui-txt");
  if (span) span.textContent = label || "（未选择）";
  btn.classList.toggle("empty", !sel.value);
  btn.disabled = !!sel.disabled;
  btn.title = label || "";
}

/** 选中某一项：写值 → 派发真实 change → 同步按钮 → 关闭 */
function choose(rec, value) {
  const { sel } = rec;
  if (sel.value !== value) {
    sel.value = value;
    // 🔴 必须冒泡。全项目的 select 变更监听都挂在 select 自己身上，
    //    但派发一次真的 change 事件是"替身"能被当成原生控件对待的前提。
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }
  syncBtn(rec);
  closePop();
}

/** 打开某一项的弹层 */
function openPopFor(rec) {
  closePop();
  const { sel, btn } = rec;
  const pop = document.createElement("div");
  pop.className = "selpop";
  pop.setAttribute("role", "listbox");
  pop.id = "selpop-" + (++seq);

  const opts = Array.from(sel.options || []);
  if (!opts.length) return;                       // 还没填选项：不弹空盒子

  const frag = document.createDocumentFragment();
  opts.forEach((o, i) => {
    const it = document.createElement("div");
    it.className = "opt" + (o.value === sel.value ? " on" : "") + (o.disabled ? " dis" : "");
    it.setAttribute("role", "option");
    it.setAttribute("aria-selected", o.value === sel.value ? "true" : "false");
    it.dataset.v = o.value;
    it.dataset.i = String(i);
    it.textContent = o.textContent;
    if (o.disabled) return;                       // 禁用项不响应点击
    frag.appendChild(it);
  });
  pop.appendChild(frag);
  document.body.appendChild(pop);

  rec.pop = pop;
  openPop = rec;
  btn.setAttribute("aria-expanded", "true");
  btn.setAttribute("aria-controls", pop.id);

  placePop();

  // 当前项滚进可视区
  const on = pop.querySelector(".opt.on");
  if (on) {
    const pr = pop.getBoundingClientRect(), or = on.getBoundingClientRect();
    if (or.top < pr.top || or.bottom > pr.bottom) on.scrollIntoView({ block: "nearest" });
  }

  pop.addEventListener("mousedown", (e) => e.preventDefault());   // 别让按钮失焦闪一下
  pop.addEventListener("click", (e) => {
    const it = e.target.closest(".opt");
    if (!it || it.classList.contains("dis")) return;
    choose(rec, it.dataset.v);
  });
}

/** 键盘：上下移动高亮 */
function moveActive(rec, delta) {
  if (!openPop || openPop !== rec) return;
  const items = Array.from(rec.pop.querySelectorAll(".opt:not(.dis)"));
  if (!items.length) return;
  let i = items.findIndex((x) => x.classList.contains("hover"));
  i = i < 0 ? (delta > 0 ? 0 : items.length - 1) : (i + delta + items.length) % items.length;
  items.forEach((x) => x.classList.remove("hover"));
  items[i].classList.add("hover");
  items[i].scrollIntoView({ block: "nearest" });
}

function enhance(sel, icon) {
  if (!sel || sel.tagName !== "SELECT") return null;
  if (sel.hasAttribute(MARK)) return null;

  const wrap = document.createElement("span");
  wrap.className = "selui";
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);
  sel.setAttribute(MARK, "1");
  // 键盘焦点交给按钮：否则 Tab 会停在原生控件上，按空格又弹出那个位置算错的系统下拉。
  // aria-hidden 与之配套 —— 值由按钮（role=combobox）负责播报，避免读屏念两遍。
  sel.tabIndex = -1;
  sel.setAttribute("aria-hidden", "true");

  const btn = document.createElement("button");
  btn.type = "button";                       // 在 <label> 里也必须是 button，否则会当提交按钮
  btn.className = "selui-btn";
  btn.setAttribute("role", "combobox");
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  btn.innerHTML = '<span class="selui-txt"></span>' + (icon || "");
  wrap.appendChild(btn);

  const rec = { sel, btn, pop: null };

  syncBtn(rec);
  sel.addEventListener("change", () => syncBtn(rec));
  // 程序里写 `$("#sImgMode").value = "sync"` **不会**触发 change（设置页「恢复默认」就是这么干的），
  // 光靠 change 监听按钮文字会停在旧值。所以在这一个元素实例上截一层 value 存取器 ——
  // 只影响这个 select，不动 HTMLSelectElement.prototype，别处的原生控件照旧。
  try {
    const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
    if (d && d.get && d.set) {
      Object.defineProperty(sel, "value", {
        configurable: true,
        get() { return d.get.call(sel); },
        set(v) { d.set.call(sel, v); syncBtn(rec); },
      });
    }
  } catch { /* 不支持就算了：还有 change + MutationObserver 两道 */ }
  // 选项可能是程序 later 填进来的（如 loadCompetitorCategories 的一次性注入）——
  // 按钮文字必须跟着变，否则界面显示的是空框。
  try {
    new MutationObserver(() => syncBtn(rec)).observe(sel, { childList: true, subtree: true });
  } catch { /* 老浏览器没有 MutationObserver 就只靠 change */ }

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (openPop && openPop === rec) closePop();
    else openPopFor(rec);
  });

  btn.addEventListener("keydown", (e) => {
    const k = e.key;
    if (k === "Escape") { closePop(); return; }
    if (k === "ArrowDown" || k === "ArrowUp") {
      e.preventDefault();
      if (!openPop || openPop !== rec) openPopFor(rec);
      else moveActive(rec, k === "ArrowDown" ? 1 : -1);
      return;
    }
    if (k === "Enter" || k === " ") {
      e.preventDefault();
      if (!openPop || openPop !== rec) return openPopFor(rec);
      const item = rec.pop.querySelector(".opt.hover") || rec.pop.querySelector(".opt.on");
      if (item) choose(rec, item.dataset.v);
      return;
    }
    if (k === "Home" || k === "End") {
      if (!openPop || openPop !== rec) return;
      e.preventDefault();
      const items = Array.from(rec.pop.querySelectorAll(".opt:not(.dis)"));
      const target = k === "Home" ? items[0] : items[items.length - 1];
      items.forEach((x) => x.classList.remove("hover"));
      if (target) { target.classList.add("hover"); target.scrollIntoView({ block: "nearest" }); }
    }
  });

  return rec;
}

/** 打开状态下：点别处 / Esc / 滚动 / 缩放，统一收口 */
function bindGlobal() {
  document.addEventListener("mousedown", (e) => {
    if (!openPop) return;
    if (openPop.pop.contains(e.target) || openPop.btn.contains(e.target)) return;
    closePop();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (!openPop || e.key !== "Escape") return;
    // 先把按钮拿在手上：closePop() 会把 openPop 置空，之后 openPop.btn 直接抛 TypeError
    const b = openPop.btn;
    closePop();
    try { b.focus(); } catch { /* 元素已不在文档里 */ }
  }, true);
  // 滚动（捕获阶段能收到内层容器滚动）与窗口尺寸变化都重新定位，别让它跟丢
  window.addEventListener("scroll", () => placePop(), true);
  window.addEventListener("resize", () => placePop());
}

/**
 * 增强页面上所有 `select.in`。
 * @param {{icon?:string, root?:Document|Element}} opts icon 是已经渲染好的 SVG 字符串
 * @returns {number} 本次新增强的个数
 */
export function enhanceSelects(opts = {}) {
  const root = opts.root || document;
  const list = root.querySelectorAll ? root.querySelectorAll("select.in") : [];
  let n = 0;
  for (const sel of list) if (enhance(sel, opts.icon)) n++;
  if (n && !bindGlobal.__done) { bindGlobal(); bindGlobal.__done = true; }
  return n;
}

/** 测试/诊断用：当前是否有弹层打开 */
export function isOpen() { return !!openPop; }
