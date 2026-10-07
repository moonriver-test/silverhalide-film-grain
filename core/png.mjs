/**
 * 银盐 · 极简 PNG 编码器（平台无关，零依赖）
 * ------------------------------------------------------------------
 * 为什么需要：UXP 面板里**没有可用的 canvas**（在售的 Film Emulation 整个 bundle 里
 * 既没有 getContext 也没有 putImageData），预览只能走「JS 编码 PNG → Blob →
 * URL.createObjectURL → <img>.src」这条路 —— 那也是它用的路。
 *
 * 为什么不用压缩：UXP 没有 Node 的 zlib，也没有 CompressionStream 的保证。
 * 所以用 deflate 的 **stored 块**（BTYPE=00），只做分块搬运 + adler32/crc32。
 * 代价是体积等于原始像素（320×190 约 190 KB），对内存里的 Blob 完全够用，
 * 而且编码是纯拷贝，比压缩还快。这也是「宁可牺牲体积换零依赖」的取舍。
 */

/* ---------------- CRC32 / Adler32 ---------------- */

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  CRC_TABLE = t;
  return t;
}

function crc32(buf, start, end) {
  const t = crcTable();
  let c = -1;
  for (let i = start; i < end; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function adler32(buf) {
  let a = 1, b = 0;
  // 5552 是标准分块长度：保证 32 位累加不溢出
  for (let i = 0; i < buf.length;) {
    const n = Math.min(5552, buf.length - i);
    for (let j = 0; j < n; j++, i++) { a += buf[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/* ---------------- deflate：仅 stored 块 ---------------- */

const STORED_MAX = 65535;

function deflateStore(data) {
  const nBlocks = Math.max(1, Math.ceil(data.length / STORED_MAX));
  const out = new Uint8Array(2 + data.length + nBlocks * 5 + 4);
  let p = 0;
  out[p++] = 0x78;  // CMF: deflate, 32K window
  out[p++] = 0x01;  // FLG: 无字典，最低压缩等级（stored 时无校验位要求）

  let off = 0;
  for (let i = 0; i < nBlocks; i++) {
    const len = Math.min(STORED_MAX, data.length - off);
    out[p++] = (i === nBlocks - 1) ? 1 : 0;        // BFINAL | BTYPE=00
    out[p++] = len & 0xff;
    out[p++] = (len >>> 8) & 0xff;
    out[p++] = (~len) & 0xff;
    out[p++] = ((~len) >>> 8) & 0xff;
    out.set(data.subarray(off, off + len), p);
    p += len;
    off += len;
  }
  const ad = adler32(data);
  out[p++] = (ad >>> 24) & 0xff;
  out[p++] = (ad >>> 16) & 0xff;
  out[p++] = (ad >>> 8) & 0xff;
  out[p++] = ad & 0xff;
  return out.subarray(0, p);
}

/* ---------------- PNG 组装 ---------------- */

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  out[0] = (data.length >>> 24) & 0xff;
  out[1] = (data.length >>> 16) & 0xff;
  out[2] = (data.length >>> 8) & 0xff;
  out[3] = data.length & 0xff;
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const c = crc32(out, 4, 8 + data.length);   // CRC 覆盖 type + data
  out[8 + data.length] = (c >>> 24) & 0xff;
  out[9 + data.length] = (c >>> 16) & 0xff;
  out[10 + data.length] = (c >>> 8) & 0xff;
  out[11 + data.length] = c & 0xff;
  return out;
}

/**
 * Float32 RGB[0,1]（sRGB 编码）→ Uint8 RGB，钳位 + 四舍五入。
 * 预览用，不做抖动 —— 预览在屏上是连续区域，不需要为 8 位量化做色阶打散。
 */
export function packRGB8(rgb, width, height) {
  const n = width * height;
  const out = new Uint8Array(n * 3);
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    let r = rgb[p] * 255, g = rgb[p + 1] * 255, b = rgb[p + 2] * 255;
    out[p] = r <= 0 ? 0 : r >= 255 ? 255 : (r + 0.5) | 0;
    out[p + 1] = g <= 0 ? 0 : g >= 255 ? 255 : (g + 0.5) | 0;
    out[p + 2] = b <= 0 ? 0 : b >= 255 ? 255 : (b + 0.5) | 0;
  }
  return out;
}

/** Uint8 RGB（w*h*3）→ PNG bytes（8 位真彩、无 alpha、filter 0、stored deflate） */
export function encodePNG(rgb, width, height) {
  const rowBytes = width * 3;
  const raw = new Uint8Array(height * (1 + rowBytes));
  for (let y = 0; y < height; y++) {
    const d = y * (1 + rowBytes);
    raw[d] = 0;                                        // filter type 0 (None)
    raw.set(rgb.subarray(y * rowBytes, (y + 1) * rowBytes), d + 1);
  }

  const ihdr = new Uint8Array(13);
  ihdr[0] = (width >>> 24) & 0xff;
  ihdr[1] = (width >>> 16) & 0xff;
  ihdr[2] = (width >>> 8) & 0xff;
  ihdr[3] = width & 0xff;
  ihdr[4] = (height >>> 24) & 0xff;
  ihdr[5] = (height >>> 16) & 0xff;
  ihdr[6] = (height >>> 8) & 0xff;
  ihdr[7] = height & 0xff;
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type 2 = truecolor RGB
  ihdr[10] = 0;  // compression = deflate
  ihdr[11] = 0;  // filter method
  ihdr[12] = 0;  // interlace = none

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateStore(raw)),
    chunk('IEND', new Uint8Array(0))
  ];
  let total = 0;
  for (const p of parts) total += p.length;
  const png = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { png.set(p, off); off += p.length; }
  return png;
}

/* ---------------- data: URL 兜底 ---------------- */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** PNGuint8 → data:image/png;base64,…（Blob URL 不可用时的兜底；自己实现，不依赖 btoa） */
export function pngToDataUrl(png) {
  let s = '';
  const n = png.length;
  for (let i = 0; i < n; i += 3) {
    const b0 = png[i], b1 = i + 1 < n ? png[i + 1] : 0, b2 = i + 2 < n ? png[i + 2] : 0;
    s += B64[b0 >> 2] + B64[((b0 & 3) << 4) | (b1 >> 4)] +
         (i + 1 < n ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=') +
         (i + 2 < n ? B64[b2 & 63] : '=');
  }
  return 'data:image/png;base64,' + s;
}
