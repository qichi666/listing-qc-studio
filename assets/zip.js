/**
 * 极简 ZIP 打包器（method=0 存储，不压缩）。
 *
 * ── 为什么要自己写 zip ────────────────────────────────────────
 * 一套图 14 张，逐个点"下载"是典型的玩具感。而 archiver / jszip 会带进几十个包，
 * 违背本项目"零 npm 依赖、能直接跑起来"的硬约束。
 * ZIP 的存储模式其实只是一串定长头 + 原始数据，CRC32 用 node:zlib 就够了
 * （Node ≥ 20.15 内置 zlib.crc32，不必自己写 CRC 表）。
 *
 * ── 为什么不压缩 ─────────────────────────────────────────────
 * 库里的图都是 PNG / JPEG，本身就是压缩格式。再套一层 deflate 收益接近 0，
 * 却要多付一次全量 CPU。method=0 让打包变成纯粹的拼接。
 *
 * ── 为什么不支持分卷 / 加密 / zip64 ──────────────────────────
 * 用不上。单卷 + 4GB 上限对"一次下载几十张商品图"绰绰有余；
 * 真到了要 zip64 的量级，也不该用浏览器一键下载了。
 * ⚠️ 但"不支持"必须**响亮地不支持**：越界时抛 RangeError，而不是让 4 字节字段静默回绕
 *    （回绕后 CRC / 偏移全错，解压器只会说"文件损坏"，定位成本极高）。见 assertZipWithinLimits。
 *
 * 本模块**不碰文件系统**（调用方传 Buffer 进来），所以能在自检里直接断言。
 */

// 🔴 必须是默认导入，**不能**写 `import { crc32 } from "node:zlib"`。
//    ESM 的命名导入在**模块链接期**就要解析：Node < 20.15 的 zlib 没有 crc32 这个导出，
//    整条 import 链会在服务启动前直接抛 SyntaxError —— 表现是"服务根本起不来"，
//    而不是"打包下载不能用"。一个可选的下载功能不该有这种杀伤力。
//    改成默认导入 + 运行时探测后：低版本照常启动、Prompt/质检/关键词全可用，
//    只有真的点"打包下载"时才报一句人话。
import zlib from "node:zlib";

/** crc32 的运行时探测包装。低版本 Node 到这里才失败，且失败信息可操作。 */
function crc32(buf) {
  const fn = zlib.crc32;
  if (typeof fn !== "function") {
    throw new Error(
      `当前 Node（${process.versions?.node || "未知"}）没有 zlib.crc32，无法打包下载。` +
      "该 API 需要 Node ≥ 20.15；请升级 Node，或改用逐张下载。"
    );
  }
  return fn(buf);
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
/**
 * 通用位标记 bit 11 = 文件名是 UTF-8。
 * 🔴 不设这一位，中文 / emoji 文件名在 Windows 资源管理器里会解成乱码。
 */
const FLAG_UTF8 = 0x0800;
/** 2.0 —— 存储模式所需的最低版本号。写大了老解压器会报"需要更新版本"。 */
const VERSION = 20;

/**
 * 🔴 ZIP64 边界。
 * ZIP 的 EOCD 里"条目数"是 **2 字节**，本地头里"大小/偏移"是 **4 字节**。
 * 越界时 writeUInt16LE / writeUInt32LE 在 Node 里会抛 ERR_OUT_OF_RANGE，
 * 但**偏移累加**那处不会 —— offset 会先变成一个超范围的数，写进 central 时才发现。
 * 与其在打包末尾抛一个语焉不详的 RangeError，不如在越界的第一刻响亮报错。
 */
export const MAX_ENTRIES = 0xffff;      // 65535
export const MAX_BYTES = 0xffffffff;    // 4GB - 1

/**
 * 越界即抛。抽成纯函数是为了**能被自检直接断言** —— 真要造一个 4GB 的 Buffer
 * 来触发它，自检本身就会先 OOM。
 * @param {number} count 条目数
 * @param {number} bytes 已累计字节数（本地头 + 文件名 + 数据）
 */
export function assertZipWithinLimits(count, bytes) {
  if (count > MAX_ENTRIES) {
    throw new RangeError(`ZIP 条目数 ${count} 超过 ${MAX_ENTRIES}：本实现不支持 ZIP64，请分批打包`);
  }
  if (bytes > MAX_BYTES) {
    throw new RangeError(`ZIP 体积 ${bytes} 字节超过 4GB：本实现不支持 ZIP64，请分批下载`);
  }
}

function dosDateTime(d) {
  // ZIP 的日期从 1980 年起算；小于 1980 的会被写坏，所以先夹住
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * @param {{name?:string, data?:Buffer|string}[]} entries
 * @param {Date} [now] 可注入 → 自检里不必依赖真实时间
 * @returns {Buffer}
 */
export function buildZip(entries = [], now = new Date()) {
  const { time, date } = dosDateTime(now instanceof Date ? now : new Date(now));
  const locals = [];
  const centrals = [];
  let offset = 0;
  let count = 0;

  for (const e of entries) {
    if (!e) continue;
    const name = Buffer.from(String(e.name || `file-${count + 1}`), "utf8");
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ""), "utf8");
    const crc = crc32(data) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(0, 8);            // 压缩方法 = 0（存储）
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // 压缩后大小 == 原始大小
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);           // 额外字段长度
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(VERSION, 4);    // version made by
    central.writeUInt16LE(VERSION, 6);    // version needed
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);         // 额外字段
    central.writeUInt16LE(0, 32);         // 备注
    central.writeUInt16LE(0, 34);         // 起始磁盘号
    central.writeUInt16LE(0, 36);         // 内部属性
    central.writeUInt32LE(0, 38);         // 外部属性
    central.writeUInt32LE(offset, 42);    // 本地头偏移 —— 写错这个，解压时直接报"文件损坏"
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
    count++;
    // 越界的第一刻就报 —— 不要等到写 EOCD 时才发现偏移回绕了
    assertZipWithinLimits(count, offset);
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);        // 本磁盘号
  eocd.writeUInt16LE(0, 6);        // 中央目录起始磁盘号
  eocd.writeUInt16LE(count, 8);    // 本磁盘条目数
  eocd.writeUInt16LE(count, 10);   // 总条目数
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);  // 中央目录偏移
  eocd.writeUInt16LE(0, 20);       // 备注长度

  return Buffer.concat([...locals, cd, eocd]);
}

/** 只读的结构自检（自检脚本用；也是给"ZIP 到底拼没拼对"一个不依赖解压器的判据）。 */
export function inspectZip(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const out = { ok: false, entries: [], eocdAt: -1, centralAt: -1, size: b.length, reason: "" };
  if (b.length < 22) { out.reason = "太短，连 EOCD 都放不下"; return out; }
  // 本实现不写备注，所以 EOCD 必须正好在末尾 22 字节
  const eocdAt = b.length - 22;
  if (b.readUInt32LE(eocdAt) !== SIG_EOCD) { out.reason = "末尾不是 EOCD 签名"; return out; }
  out.eocdAt = eocdAt;
  const total = b.readUInt16LE(eocdAt + 10);
  const cdSize = b.readUInt32LE(eocdAt + 12);
  const cdOffset = b.readUInt32LE(eocdAt + 16);
  if (cdOffset + cdSize !== eocdAt) { out.reason = "中央目录偏移与 EOCD 不吻合"; return out; }
  // 空包没有中央目录（cdSize=0），此时不该去读签名 —— 那里其实就是 EOCD 自己
  if (total === 0) { out.centralAt = cdOffset; out.ok = cdSize === 0; if (!out.ok) out.reason = "没有条目却写了中央目录长度"; return out; }
  if (b.readUInt32LE(cdOffset) !== SIG_CENTRAL) { out.reason = "中央目录签名不对"; return out; }
  out.centralAt = cdOffset;
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (b.readUInt32LE(p) !== SIG_CENTRAL) { out.reason = `第 ${i} 条中央目录签名不对`; return out; }
    const nameLen = b.readUInt16LE(p + 28);
    const rel = b.readUInt32LE(p + 42);
    if (b.readUInt32LE(rel) !== SIG_LOCAL) { out.reason = `第 ${i} 条的本地头偏移指错了（解压器会报文件损坏）`; return out; }
    out.entries.push({
      name: b.slice(p + 46, p + 46 + nameLen).toString("utf8"),
      crc: b.readUInt32LE(p + 16),
      size: b.readUInt32LE(p + 24),
      offset: rel,
    });
    p += 46 + nameLen;
  }
  out.ok = out.entries.length === total;
  if (!out.ok) out.reason = "条目数对不上";
  return out;
}
