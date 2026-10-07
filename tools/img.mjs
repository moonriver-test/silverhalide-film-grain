/* 极简 PNG 解码 + 缩放 + 编码（仅供构建期使用，依赖 node:zlib）
 *
 * 为什么需要它：Seedream 生成的是 1024² 的大图、还带右下角水印，
 * 而预览稿里只需要 100~200 px 的小图，且要能放在深色/浅色底上。
 * 所以要做四件事：解码 → 去掉水印角 → 裁掉透明边 → 缩放 → 重新编码。
 *
 * 缩放用**面积平均（box）**并且按 alpha 预乘，理由：
 *   像素画缩小时用最近邻会严重走样；用不预乘的普通双线性又会在透明边缘
 *   混出黑边（因为透明像素的 RGB 通常是 0）。按 alpha 加权平均才是对的。
 */
import zlib from 'node:zlib';

const PNG_SIG = 0x89504e47;

export function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== PNG_SIG) throw new Error('不是 PNG');
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let palette = null, trns = null;

  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IEND') break;
    off += 12 + len;
  }

  if (bitDepth !== 8) throw new Error('只支持 8 位深度，实为 ' + bitDepth);
  if (interlace !== 0) throw new Error('不支持隔行扫描');

  const CH = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!CH) throw new Error('不支持的颜色类型 ' + colorType);

  const stride = width * CH;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(height * stride);

  let pos = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= CH ? cur[x - CH] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= CH) ? prev[x - CH] : 0;
      let v = line[x];
      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + b) & 255;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[x] = v;
    }
  }

  // 统一转成 RGBA
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    let r = 0, g = 0, b = 0, a = 255;
    const s = i * CH;
    if (colorType === 0) { r = g = b = px[s]; }
    else if (colorType === 4) { r = g = b = px[s]; a = px[s + 1]; }
    else if (colorType === 2) { r = px[s]; g = px[s + 1]; b = px[s + 2]; }
    else if (colorType === 6) { r = px[s]; g = px[s + 1]; b = px[s + 2]; a = px[s + 3]; }
    else if (colorType === 3) {
      const idx = px[s];
      r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
      if (trns && idx < trns.length) a = trns[idx];
    }
    const d = i * 4;
    rgba[d] = r; rgba[d + 1] = g; rgba[d + 2] = b; rgba[d + 3] = a;
  }
  return { width, height, rgba };
}

/**
 * 去斑点：只保留面积 ≥ minRatio 的连通域（4 邻接）。
 *
 * 洪水填充之后，边缘偶尔会剩几个孤立的不透明像素（生成图的抗锯齿碎屑、
 * 或水印残余）。它们会把 alphaBounds 撑到整幅，让裁边和居中全部失效
 * （实测 bw/slide 两款的包围盒因此从 613 宽错到 1024 宽）。
 */
export function despeckle(img, minRatio = 0.01) {
  const W = img.width, H = img.height, rgba = img.rgba;
  const seen = new Uint8Array(W * H);
  const min = Math.max(1, Math.round(W * H * minRatio));
  const keep = new Uint8Array(W * H);
  const stack = [];
  let dropped = 0;

  for (let s = 0; s < W * H; s++) {
    if (seen[s] || rgba[s * 4 + 3] <= 24) continue;
    const comp = [];
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const i = stack.pop(); comp.push(i);
      const x = i % W, y = (i / W) | 0;
      const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
      for (const j of nb) {
        if (j >= 0 && !seen[j] && rgba[j * 4 + 3] > 24) { seen[j] = 1; stack.push(j); }
      }
    }
    if (comp.length >= min) for (const i of comp) keep[i] = 1;
    else dropped += comp.length;
  }
  for (let i = 0; i < W * H; i++) {
    if (!keep[i] && rgba[i * 4 + 3] > 0) {
      rgba[i * 4 + 3] = 0; rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 0;
    }
  }
  return { dropped };
}

/** 把右下角一块区域涂成完全透明（用于清掉生成模型带的水印）。 */
export function clearRegion(img, x0, y0, x1, y1) {
  const { width, rgba } = img;
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) {
      rgba[(y * width + x) * 4 + 3] = 0;
    }
  }
  return img;
}

/**
 * 抠掉**烤进图里的棋盘格背景**。
 *
 * 【为什么需要这个】向生成模型请求 `background: transparent` 时，它并没有给出 alpha 通道，
 * 而是把「透明」画成了灰白相间的棋盘格（实测 alpha 全是 255、角落像素 ≈ (253,251,252)）。
 * 所以必须自己抠：从四边做**洪水填充**，只吃「亮 + 低饱和」的连通区域。
 *
 * 【为什么必须从边框洪填，而不是全图按颜色判定】
 * 黑白片那款的盒身就是米白 (240,238,230)，按颜色判会被一起抠掉。
 * 但盒身被黑色描边围住，从边框进来的洪水到不了 —— 描边成了天然的封闭轮廓。
 */
export function removeFlatBackground(img, { lightMin = 195, satMax = 30 } = {}) {
  const W = img.width, H = img.height, rgba = img.rgba;
  const bg = new Uint8Array(W * H);
  const like = (i) => {
    const d = i * 4;
    const r = rgba[d], g = rgba[d + 1], b = rgba[d + 2];
    return Math.min(r, g, b) >= lightMin && (Math.max(r, g, b) - Math.min(r, g, b)) <= satMax;
  };
  const stack = [];
  const seed = (x, y) => {
    const i = y * W + x;
    if (!bg[i] && like(i)) { bg[i] = 1; stack.push(i); }
  };
  for (let x = 0; x < W; x++) { seed(x, 0); seed(x, H - 1); }
  for (let y = 0; y < H; y++) { seed(0, y); seed(W - 1, y); }
  let n = 0;
  while (stack.length) {
    const i = stack.pop(); n++;
    const x = i % W, y = (i / W) | 0;
    if (x > 0) seed(x - 1, y);
    if (x < W - 1) seed(x + 1, y);
    if (y > 0) seed(x, y - 1);
    if (y < H - 1) seed(x, y + 1);
  }
  for (let i = 0; i < W * H; i++) {
    if (bg[i]) { rgba[i * 4 + 3] = 0; rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 0; }
  }
  return { removed: n, ratio: n / (W * H) };
}

/**
 * 颜色量化（每通道保留 bits 位）。像素画本来就只有几个色，
 * 但**面积平均缩小会把边缘插值出上千种过渡色** —— 那是 PNG 体积的全部来源。
 * 量化后既缩小体积，又让边缘回到像素画该有的硬边观感。
 */
export function quantize(img, bits = 5) {
  const step = 256 >> bits;
  const rgba = img.rgba;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) { rgba[i] = rgba[i + 1] = rgba[i + 2] = 0; continue; }
    rgba[i] = Math.min(255, Math.round(rgba[i] / step) * step);
    rgba[i + 1] = Math.min(255, Math.round(rgba[i + 1] / step) * step);
    rgba[i + 2] = Math.min(255, Math.round(rgba[i + 2] / step) * step);
  }
  return img;
}


/** 透明边裁剪：返回 alpha > 阈值 的包围盒。 */
export function alphaBounds(img, thr = 8) {
  const { width, height, rgba } = img;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] > thr) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { left: minX, top: minY, right: maxX + 1, bottom: maxY + 1 };
}

/** 面积平均缩放（alpha 预乘，避免透明边缘发黑），再居中放进 size×size 画布。 */
export function fitSquare(img, b, size, margin = 0.06) {
  const sw = b.right - b.left, sh = b.bottom - b.top;
  const inner = size * (1 - margin * 2);
  const scale = Math.min(inner / sw, inner / sh);
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  const out = new Uint8Array(size * size * 4);
  const ox = Math.round((size - dw) / 2), oy = Math.round((size - dh) / 2);
  const sx = sw / dw, sy = sh / dh;

  for (let y = 0; y < dh; y++) {
    const y0 = b.top + Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, b.top + Math.floor((y + 1) * sy));
    for (let x = 0; x < dw; x++) {
      const x0 = b.left + Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, b.left + Math.floor((x + 1) * sx));
      let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const s = (yy * img.width + xx) * 4;
          const a = img.rgba[s + 3];
          sr += img.rgba[s] * a; sg += img.rgba[s + 1] * a; sb += img.rgba[s + 2] * a;
          sa += a; n++;
        }
      }
      const d = ((oy + y) * size + (ox + x)) * 4;
      if (sa > 0) {
        out[d] = Math.round(sr / sa);
        out[d + 1] = Math.round(sg / sa);
        out[d + 2] = Math.round(sb / sa);
        out[d + 3] = Math.round(sa / n);
      }
    }
  }
  return out;
}

/* ---------------- RGBA PNG 编码（真压缩，构建期用 node:zlib） ---------------- */
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    CRC_TABLE[n] = c;
  }
  return CRC_TABLE;
}
function crc32(buf) {
  const t = crcTable();
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

export function encodePNG_RGBA(rgba, width, height, level = 9) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // 位深
  ihdr[9] = 6;   // 颜色类型 6 = RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
