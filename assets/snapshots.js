/**
 * 历史快照与迷你趋势图（零依赖，不使用图表库）。
 *
 * 为什么不用图表库：
 *   一个 sparkline 只需要 20 行 path 拼接，引 Chart.js（≈60KB）或 ECharts（≈300KB）
 *   来画一条 120×28 的折线，是把"零依赖"这个卖点换成一句"我们也有图"。
 *
 * 🔴 三条口径（图上必须能看出来，所以写在返回值里）：
 *   1. **不插值**：中间断了就断（换 `M` 重新起笔），绝不把两个相隔一个月的点连成一条假曲线。
 *   2. **不预测**：只画已经发生的点。没有趋势线、没有虚线延伸。
 *   3. **两点才画**：一个点画不出趋势，返回空 path 并在 note 里说明 —— 而不是画一个点假装有历史。
 */

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** 把一行快照归一：`{ts, price, rating, reviewCount, bsr}`。缺的字段给 null，不补 0。 */
export function normalizeSnapshot(row = {}) {
  return {
    ts: row.ts || row.at || row.capturedAt || null,
    price: num(row.price),
    rating: num(row.rating),
    reviewCount: num(row.reviewCount ?? row.reviews),
    bsr: num(row.bsr ?? row.rank),
    asin: String(row.asin || "").trim().toUpperCase() || "",
  };
}

/** 从一组快照里抽某个指标的时间序列，跳过缺失值（但保留"这里缺了"的语义）。 */
export function seriesOf(rows, field) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const n = normalizeSnapshot(r);
    const v = n[field];
    out.push({ t: n.ts, v: v == null ? null : v });
  }
  return out;
}

/**
 * 生成 SVG path。x 轴默认按**记录顺序等距**（因为采集时间本来就不均匀，
 * 按真实时间会让 3 天前和 30 天前挤在一起）；只有所有点都有合法时间时才用时间轴。
 *
 * @param {Array<{t?:string|number, v:number|null}>|number[]} points
 * @param {{w?:number,h?:number,pad?:number}} [opts]
 */
export function sparklinePath(points, opts = {}) {
  const w = Number(opts.w) > 0 ? Number(opts.w) : 120;
  const h = Number(opts.h) > 0 ? Number(opts.h) : 28;
  const pad = Number(opts.pad) >= 0 ? Number(opts.pad) : 2;

  const pts = (Array.isArray(points) ? points : []).map((p) => (
    p && typeof p === "object" ? { t: p.t ?? null, v: num(p.v) } : { t: null, v: num(p) }
  ));
  const finite = pts.filter((p) => p.v != null);
  const values = finite.map((p) => p.v);
  const min = values.length ? Math.min(...values) : null;
  const max = values.length ? Math.max(...values) : null;

  const base = {
    d: "", w, h, pad, min, max, count: finite.length, total: pts.length,
    first: finite.length ? finite[0].v : null,
    last: finite.length ? finite[finite.length - 1].v : null,
    gaps: 0, xMode: "index",
  };
  if (finite.length < 2 || min == null || max == null) {
    return {
      ...base,
      change: null, pct: null,
      note: finite.length === 0
        ? "还没有数据点"
        : `只有 ${finite.length} 个数据点：一个点画不出趋势，至少需要 2 次采集`,
    };
  }

  // 时间轴：所有点都有可解析时间、且跨度 > 0 才用；否则退回序号轴（并在 note 里说明）。
  const times = pts.map((p) => (p.t ? Date.parse(String(p.t)) : NaN));
  const allTimed = times.every((t) => Number.isFinite(t));
  const span = allTimed ? Math.max(...times) - Math.min(...times) : 0;
  const xMode = allTimed && span > 0 ? "time" : "index";
  const t0 = allTimed ? Math.min(...times) : 0;

  const innerW = Math.max(1, w - pad * 2);
  const innerH = Math.max(1, h - pad * 2);
  const range = max - min || 1;
  const xAt = (i) => {
    if (xMode === "time") return pad + ((times[i] - t0) / span) * innerW;
    return pad + (pts.length === 1 ? innerW / 2 : (i / (pts.length - 1)) * innerW);
  };
  const yAt = (v) => pad + innerH - ((v - min) / range) * innerH;

  let d = "";
  let gaps = 0;
  let prevFinite = false;
  pts.forEach((p, i) => {
    if (p.v == null) {
      prevFinite = false;
      return;
    }
    const cmd = prevFinite ? "L" : "M";
    if (!prevFinite && i > 0) gaps += 1;   // 中间断过
    d += `${cmd}${xAt(i).toFixed(2)} ${yAt(p.v).toFixed(2)}`;
    prevFinite = true;
  });

  const first = finite[0].v;
  const last = finite[finite.length - 1].v;
  const change = Math.round((last - first) * 100) / 100;
  const pct = first === 0 ? null : Math.round((change / first) * 1000) / 10;

  return {
    ...base, d, gaps, xMode, change, pct,
    note: gaps > 0
      ? `中间有 ${gaps} 处数据缺失：断点处**没有连线**，因为那段时间没有样本`
      : xMode === "index"
        ? "横轴按采集顺序等距（时间字段缺失或间隔无法解析），不代表真实时间间隔"
        : "",
  };
}

/**
 * 一段序列的文字摘要（给"价格变了多少"这类问题用）。
 * 只有 2 个以上有效点才给 change/pct，否则给 null。
 */
export function seriesDigest(points) {
  const sp = sparklinePath(points, { w: 1, h: 1, pad: 0 });
  if (sp.count < 2) return { count: sp.count, min: sp.min, max: sp.max, first: sp.first, last: sp.last, change: null, pct: null };
  return {
    count: sp.count, min: sp.min, max: sp.max,
    first: sp.first, last: sp.last, change: sp.change, pct: sp.pct,
    direction: sp.change > 0 ? "up" : sp.change < 0 ? "down" : "flat",
  };
}

/**
 * 返回形状：
 * sparklinePath → {d, w, h, pad, min, max, count, total, first, last, change, pct, gaps, xMode, note}
 *   · d 为空字符串＝画不出来（点不够），调用方应显示 note 而不是硬画
 *   · gaps＝中间断了几段（断点不连线）
 * seriesDigest → {count, min, max, first, last, change, pct, direction?}
 */
