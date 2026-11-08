/**
 * 成图体检（纯前端 Canvas，零依赖、零上传）。
 *
 * 为什么这块必须做：
 *   整个工作台把「文本」查得很细，但主图是转化率的第一变量，而工具此前只出 Prompt、不看成图。
 *   卖家最常踩的三个坑，全都是**看一眼就能发现、但没人会去数**的：
 *     ① 背景不是纯白（官方主图要求 RGB 255,255,255）
 *     ② 商品没占满 85%（留白太多，缩略图上就是个小白点）
 *     ③ 最长边不到 1000px（放不出缩放，点击率直接吃亏）
 *   这三个都能量出来，且量出来的数比"我觉得挺白"可信。
 *
 * 🔴 诚实边界（必须显示在界面上，写在这里防止文案走样）：
 *   1. 这是**按像素采样**的近似判断，不是平台审核。采样点、阈值都写在代码里，可以自己改。
 *   2. 商品占满画面 / 有大量阴影或倒影时，85% 与"纯白"两个指标会**低估**（阴影被算成非白）。
 *      所以结论一律是"疑似"，最终以平台后台预览为准。
 *   3. **不判 Logo、不判侵权、不判类目禁图**（例如某些类目禁真人、禁尺寸标注）。
 *      这些需要人看图，工具不装这个懂。
 *   4. 不做 OCR。图内文字只给"边缘密度偏高"的线索 —— 真要看字得自己看，
 *      或者接一个视觉模型（设置页配了 Key 就能用「图片识别」）。
 */

/** 官方主图硬指标（公开规则；改这里就是改判据）。 */
export const IMAGE_RULES = {
  /** 背景：RGB 三通道都 ≥ 250 且通道差 ≤ 5，视为"接近纯白" */
  whiteMin: 250,
  whiteSpread: 5,
  /** 商品占画面比例下限 */
  fillMin: 0.85,
  /** 最长边：<500 传不上去；500–999 可传但无缩放；≥1000 才能放大 */
  edgeFail: 500,
  edgeZoom: 1000,
  /** 单文件上限 10MB */
  maxBytes: 10 * 1024 * 1024,
  /** 允许的格式（主图） */
  mimeOk: ["image/jpeg", "image/png", "image/tiff", "image/gif"],
};

/** MIME → 人话。只用于展示。 */
const MIME_LABEL = {
  "image/jpeg": "JPEG", "image/jpg": "JPEG", "image/png": "PNG",
  "image/tiff": "TIFF", "image/gif": "GIF", "image/webp": "WebP", "image/bmp": "BMP",
};

const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/** 采样 8 个点：四角 + 四边中点（inset 用来躲开圆角/黑边）。 */
function samplePoints(w, h) {
  const ix = Math.max(1, Math.round(Math.min(w, h) * 0.01));
  const cx = Math.round(w / 2);
  const cy = Math.round(h / 2);
  return [
    ["左上", ix, ix], ["右上", w - 1 - ix, ix],
    ["左下", ix, h - 1 - ix], ["右下", w - 1 - ix, h - 1 - ix],
    ["上中", cx, ix], ["下中", cx, h - 1 - ix],
    ["左中", ix, cy], ["右中", w - 1 - ix, cy],
  ].map(([label, x, y]) => {
    const px = (Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4;
    return { label, r: 0, g: 0, b: 0, a: 0, offset: px };
  });
}

const isNearWhite = (r, g, b) => {
  const min = Math.min(r, g, b);
  const max = Math.max(r, g, b);
  return min >= IMAGE_RULES.whiteMin && max - min <= IMAGE_RULES.whiteSpread;
};

/**
 * 纯函数：吃像素（RGBA），吐指标。Node 里可以用合成像素直接测，不需要浏览器。
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray|number[]}} img
 * @param {object} [opts] {sourceWidth, sourceHeight}
 */
export function auditPixels(img, opts = {}) {
  const width = Number(img && img.width) || 0;
  const height = Number(img && img.height) || 0;
  const data = img && img.data;
  if (!width || !height || !data || data.length < width * height * 4) {
    return {
      ok: false, width, height, checks: [],
      error: "像素数据不完整，无法体检",
      summary: { pass: 0, warn: 0, fail: 0, hint: 0, skip: 1 },
    };
  }

  const srcW = Number(opts.sourceWidth) || width;
  const srcH = Number(opts.sourceHeight) || height;
  const checks = [];

  /* ① 背景是否接近纯白（8 点采样） */
  const pts = samplePoints(width, height);
  const samples = pts.map((p) => {
    const o = p.offset;
    return { label: p.label, r: data[o], g: data[o + 1], b: data[o + 2], a: data[o + 3] };
  });
  const whitePts = samples.filter((s) => isNearWhite(s.r, s.g, s.b));
  const worst = samples.reduce((a, s) => {
    const d = 255 - Math.min(s.r, s.g, s.b);
    return d > a.d ? { d, label: s.label, rgb: `${s.r}/${s.g}/${s.b}` } : a;
  }, { d: -1, label: "", rgb: "" });
  const bgCheck = {
    id: "background",
    label: "背景接近纯白",
    value: `${whitePts.length}/${samples.length} 个采样点达纯白`,
    measured: `最偏的一点：${worst.label} ${worst.rgb}（要求三通道 ≥${IMAGE_RULES.whiteMin}，通道差 ≤${IMAGE_RULES.whiteSpread}）`,
    status: whitePts.length === samples.length ? "pass" : whitePts.length >= Math.ceil(samples.length / 2) ? "warn" : "fail",
  };
  checks.push(bgCheck);

  /* ② 商品占画面比例（非白像素占比） */
  const total = width * height;
  let nonWhite = 0;
  let transparent = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (a < 250) transparent++;
    if (!isNearWhite(r, g, b)) nonWhite++;
  }
  const fill = nonWhite / total;
  const bgIsWhite = bgCheck.status !== "fail";
  const fillCheck = bgIsWhite
    ? {
      id: "fill",
      label: "商品占画面 ≥85%",
      value: `${round(fill * 100)}%`,
      measured: `非白像素 ${nonWhite.toLocaleString("en-US")} / ${total.toLocaleString("en-US")}；有阴影、倒影或浅色背景时这个数会偏低`,
      status: fill >= IMAGE_RULES.fillMin ? "pass" : fill >= 0.7 ? "warn" : "fail",
    }
    : {
      id: "fill",
      label: "商品占画面 ≥85%",
      value: "未测（背景不是纯白，占比算不准）",
      measured: "占比是按「非白像素」算的；背景本身有颜色时这个口径没有意义",
      status: "skip",
    };
  checks.push(fillCheck);

  /* ③ 最长边 */
  const longest = Math.max(srcW, srcH);
  checks.push({
    id: "size",
    label: "最长边 ≥1000px",
    value: `${srcW} × ${srcH}`,
    measured: longest >= IMAGE_RULES.edgeZoom
      ? "可开启缩放（放大查看）"
      : longest >= IMAGE_RULES.edgeFail
        ? `${IMAGE_RULES.edgeFail}–${IMAGE_RULES.edgeZoom - 1}px：能传，但前台没有缩放`
        : `低于 ${IMAGE_RULES.edgeFail}px：多数类目传不上去`,
    status: longest >= IMAGE_RULES.edgeZoom ? "pass" : longest >= IMAGE_RULES.edgeFail ? "warn" : "fail",
  });

  /* ④ 透明通道 */
  if (transparent > 0) {
    checks.push({
      id: "alpha",
      label: "透明通道",
      value: `${round((transparent / total) * 100)}% 像素带透明`,
      measured: "转成 JPG 时透明区会变黑：别只改扩展名，要在导出时铺白底",
      status: "warn",
    });
  }

  /* ⑤ 图内文字线索（边缘密度，只给线索，不下结论） */
  let edges = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const o = (y * width + x) * 4;
      const gray = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
      const oR = o + 4;
      const grayR = 0.299 * data[oR] + 0.587 * data[oR + 1] + 0.114 * data[oR + 2];
      const oD = o + width * 4;
      const grayD = 0.299 * data[oD] + 0.587 * data[oD + 1] + 0.114 * data[oD + 2];
      if (Math.abs(gray - grayR) + Math.abs(gray - grayD) > 90) edges++;
    }
  }
  const density = edges / total;
  checks.push({
    id: "text",
    label: "图内可能有文字",
    value: `边缘密度 ${round(density * 100, 2)}%`,
    measured: density > 0.08
      ? "密度偏高，常见于带文字的图；**这是线索不是结论**，请自己看一眼（主图通常不允许叠字）"
      : "密度正常，未发现明显的文字特征",
    status: density > 0.08 ? "hint" : "pass",
  });

  const summary = checks.reduce((acc, c) => {
    acc[c.status] = (acc[c.status] || 0) + 1;
    return acc;
  }, { pass: 0, warn: 0, fail: 0, hint: 0, skip: 0 });

  return {
    ok: !summary.fail,
    width,
    height,
    sourceWidth: srcW,
    sourceHeight: srcH,
    fill: round(fill * 100),
    checks,
    summary,
    note: "按像素采样得出的近似判断，不是平台审核结论。有阴影 / 倒影 / 浅色背景时「纯白」与「85%」会低估，最终以后台预览为准。",
  };
}

/** 文件本身的检查（MIME / 体积 / 扩展名）。不读像素也能跑。 */
export function auditFileMeta(meta = {}) {
  const name = String(meta.name || "");
  const type = String(meta.type || "").toLowerCase();
  const size = Number(meta.size) || 0;
  const checks = [];

  const mime = type === "image/jpg" ? "image/jpeg" : type;
  if (!mime) {
    checks.push({ id: "mime", label: "文件格式", value: "未知", measured: "浏览器没给 MIME，无法判断", status: "skip" });
  } else if (IMAGE_RULES.mimeOk.includes(mime)) {
    checks.push({
      id: "mime", label: "文件格式", value: MIME_LABEL[mime] || mime,
      measured: "在主图允许的格式内（JPEG / PNG / TIFF / GIF）", status: "pass",
    });
  } else {
    checks.push({
      id: "mime", label: "文件格式", value: MIME_LABEL[mime] || mime,
      measured: "主图不接受这个格式，另存为 JPEG 或 PNG 再传", status: "fail",
    });
  }
  if (mime === "image/gif") {
    checks.push({
      id: "gif", label: "GIF 是否动图", value: "需自查",
      measured: "主图不允许动图；本工具只读了 MIME，没有逐帧解析", status: "warn",
    });
  }

  if (size > 0) {
    checks.push({
      id: "bytes", label: "文件体积", value: `${round(size / 1024 / 1024, 2)} MB`,
      measured: `上限 ${IMAGE_RULES.maxBytes / 1024 / 1024} MB`,
      status: size <= IMAGE_RULES.maxBytes ? "pass" : "fail",
    });
  }

  const ext = (name.match(/\.[a-z0-9]+$/i) || [""])[0].toLowerCase();
  if (ext && type && !((ext === ".jpg" || ext === ".jpeg") && mime === "image/jpeg") && ext.replace("jpeg", "jpg") !== `.${mime.split("/")[1]}`) {
    checks.push({
      id: "ext", label: "扩展名与格式", value: `${ext} / ${MIME_LABEL[mime] || mime}`,
      measured: "两者不一致：有些后台按扩展名判格式，建议另存为一致的", status: "warn",
    });
  }
  return checks;
}

/** 把像素结论与文件结论合成一份报告。 */
export function combineAudit(pixelAudit, metaChecks = []) {
  const checks = [...(metaChecks || []), ...((pixelAudit && pixelAudit.checks) || [])];
  const summary = checks.reduce((acc, c) => {
    acc[c.status] = (acc[c.status] || 0) + 1;
    return acc;
  }, { pass: 0, warn: 0, fail: 0, hint: 0, skip: 0 });
  return {
    // 🔴 有 error（像素读不出来）时**不能**因为"没有 fail 项"就报 ok —— 那是把"没测"当成"通过"。
    ok: !summary.fail && !(pixelAudit && pixelAudit.error),
    checks,
    summary,
    width: pixelAudit && pixelAudit.sourceWidth,
    height: pixelAudit && pixelAudit.sourceHeight,
    fill: pixelAudit && pixelAudit.fill,
    note: (pixelAudit && pixelAudit.note) || "",
    error: (pixelAudit && pixelAudit.error) || null,
  };
}

/**
 * 浏览器端入口：Blob/File → 缩略采样 → 体检。
 * 缩到 ≤512px 再算，既快又够用（白底与占比都是尺度无关的）。
 * ⚠️ 只读像素，不上传、不写盘。
 */
export async function auditImageBlob(blob, opts = {}) {
  const max = Number(opts.max) > 0 ? Number(opts.max) : 512;
  const metaChecks = auditFileMeta({ name: blob.name, type: blob.type, size: blob.size });
  if (typeof createImageBitmap !== "function") {
    return combineAudit({ ok: false, checks: [], error: "当前浏览器不支持 createImageBitmap，无法读像素" }, metaChecks);
  }
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch (e) {
    return combineAudit({ ok: false, checks: [], error: `图片解码失败：${e.message}` }, metaChecks);
  }
  const srcW = bmp.width;
  const srcH = bmp.height;
  const scale = Math.min(1, max / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  let data;
  try {
    const canvas = typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement("canvas"), { width: w, height: h });
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, w, h);
    data = ctx.getImageData(0, 0, w, h).data;
  } catch (e) {
    return combineAudit({ ok: false, checks: [], error: `读像素失败：${e.message}` }, metaChecks);
  } finally {
    if (typeof bmp.close === "function") bmp.close();
  }
  return combineAudit(auditPixels({ width: w, height: h, data }, { sourceWidth: srcW, sourceHeight: srcH }), metaChecks);
}
