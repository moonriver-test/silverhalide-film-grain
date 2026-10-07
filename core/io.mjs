/**
 * 银盐 · I/O 适配层（平台无关）
 * ------------------------------------------------------------------
 * 职责边界：把「Photoshop 给的像素缓冲」翻译成核心要的 Float32 sRGB [0,1]，
 * 以及把核心的输出翻译回可写回的缓冲。**不含任何 PS API 调用**，
 * 因此可以在 Node 里完整测试。
 *
 * 三条来自实测的硬约束（见 .workbuddy/memory/2026-10-04.md）：
 *
 * 1. **I/O 位深 = 文档原生位深。**
 *    实测同一张 8 位 24 MP 图：按 16 位读 273~596 ms，按 8 位读 102 ms —— 慢 4~6 倍，
 *    因为 PS 要多做一次位深转换。所以不要把「一律按 16 位读」当默认。
 *    16 位标度是 0..32768（不是 65535）。
 *
 * 2. **I/O 只做一次读 + 一次写，绝不按 tile 逐块读写。**
 *    实测分块读每块有 66~121 ms 的固定开销（getData 只要 3~6 ms），
 *    24 块合计 1.7~2.1 s，而整图一次读只要 102~273 ms。
 *    需要控制内存就切**计算**的行带，不要切 I/O。
 *
 * 3. **写回必须是 4 通道（RGBA）**，这是 putPixels 的可用写法（在售插件同此）。
 *    读进来可能是 3 通道（applyAlpha:false 且文档无 alpha），要补 alpha。
 */

import { applyGrain } from './grain.mjs';
import { hash32 } from './grain.mjs';

/** 每种位深的满量程。注意 16 位是 32768 而不是 65535 —— PS 的标度如此。 */
export const depthMax = (bits) => (bits === 8 ? 255 : bits === 16 ? 32768 : 1);

/** 按位深分配像素缓冲 */
export function allocBuffer(bits, count) {
  if (bits === 8) return new Uint8Array(count);
  if (bits === 16) return new Uint16Array(count);
  return new Float32Array(count);
}

/** 文档位深字符串 → 数字。'bitDepth8' / 'bitDepth16' / 'bitDepth32' */
export function parseBitDepth(v) {
  const s = String(v == null ? '' : v).toLowerCase();
  if (s.indexOf('32') >= 0 || s.indexOf('thirtytwo') >= 0) return 32;
  if (s.indexOf('16') >= 0 || s.indexOf('sixteen') >= 0) return 16;
  if (s.indexOf('8') >= 0 || s.indexOf('eight') >= 0) return 8;
  return null;
}

/* ================================================================
   解码：交错像素缓冲 → Float32 RGB[0,1]（sRGB 编码）+ alpha[0,1]
   ================================================================ */

/**
 * @param src         Uint8Array / Uint16Array / Float32Array，交错排列
 * @param components  3 或 4
 * @param bits        8 / 16 / 32
 */
export function decodePixels(src, width, height, components, bits) {
  const n = width * height;
  const rgb = new Float32Array(n * 3);
  // 3 通道时不分配 alpha：返回 null，由 encodePixels 按「全不透明」处理。
  // 省下 n×4 字节 —— 24 MP 时是 97 MB。实测 JPEG 背景层读回来正好是 3 通道。
  const alpha = components === 4 ? new Float32Array(n) : null;
  const inv = 1 / depthMax(bits);

  if (components === 4) {
    for (let i = 0, p = 0, q = 0; i < n; i++, p += 4, q += 3) {
      rgb[q] = src[p] * inv;
      rgb[q + 1] = src[p + 1] * inv;
      rgb[q + 2] = src[p + 2] * inv;
      alpha[i] = src[p + 3] * inv;
    }
  } else {
    // 3 通道：不写 alpha（上层按全不透明处理）
    for (let i = 0, p = 0, q = 0; i < n; i++, p += 3, q += 3) {
      rgb[q] = src[p] * inv;
      rgb[q + 1] = src[p + 1] * inv;
      rgb[q + 2] = src[p + 2] * inv;
    }
  }
  return { rgb, alpha };
}

/* ================================================================
   编码：Float32 RGB[0,1] → 交错 4 通道缓冲
   ================================================================ */

/**
 * 量化到目标位深。8/16 位要抖动。
 *
 * 【为什么必须抖动】颗粒的密度涨落只有 0.4%~2.5%，8 位量化台阶是 1/255 = 0.39% —— 同量级。
 * 不抖动的话，细颗粒会被量化台阶直接切成色块（研究报告 §7.1 约束 13）。
 *
 * 用 TPDF 抖动（两个独立均匀数之和减 1，峰峰 2 LSB）：
 * 它是标准做法，能把量化误差变成与信号无关的白噪声，而不是有结构的台阶。
 * 代价是给输出加约 0.41 LSB 的噪声：
 *   8 位 → 0.16% 标准差（相对 grain 的 3% 是可忽略的 1/19）
 *   16 位 → 0.001% ，完全可忽略
 */
export function encodePixels(rgb, alpha, width, height, bits, opts = {}) {
  const o = opts || {};
  const dither = o.dither === undefined ? (bits !== 32) : !!o.dither;
  const seed = o.seed === undefined ? 0x5eed1234 : (o.seed >>> 0);
  const n = width * height;
  const out = allocBuffer(bits, n * 4);

  if (bits === 32) {
    for (let i = 0, p = 0, q = 0; i < n; i++, p += 4, q += 3) {
      out[p] = rgb[q]; out[p + 1] = rgb[q + 1]; out[p + 2] = rgb[q + 2];
      out[p + 3] = alpha ? alpha[i] : 1;
    }
    return out;
  }

  // 【为什么用嵌套行列循环】上一版在单层循环里做 `i % width` 和 `(i/width)|0`，
  // 每像素一次除法 + 一次取模，是 851 ms / 24 MP 的主要来源之一。
  // 【为什么两个哈希够】每次 hash32 产出 32 位，切 4 个字节就是 4 个独立均匀数；
  // 两次共 8 个，正好够 4 个通道各做一次 TPDF（两个均匀数之差）。
  const scale = bits === 8 ? 255 : 32768;
  const q = bits === 8 ? q8 : q16;

  for (let y = 0; y < height; y++) {
    let p = y * width * 4;
    let i = y * width;
    for (let x = 0; x < width; x++, p += 4, i++) {
      let d0 = 0, d1 = 0, d2 = 0, d3 = 0;
      if (dither) {
        const h0 = hash32(seed, 0, x, y);
        const h1 = hash32(seed, 1, x, y);
        d0 = ((h0 & 255) + ((h0 >>> 8) & 255)) / 255 - 1;
        d1 = (((h0 >>> 16) & 255) + (h0 >>> 24)) / 255 - 1;
        d2 = ((h1 & 255) + ((h1 >>> 8) & 255)) / 255 - 1;
        d3 = (((h1 >>> 16) & 255) + (h1 >>> 24)) / 255 - 1;
      }
      const b = i * 3;
      const aMax = bits === 8 ? 255 : 32768;
      out[p] = q(rgb[b], scale, d0);
      out[p + 1] = q(rgb[b + 1], scale, d1);
      out[p + 2] = q(rgb[b + 2], scale, d2);
      // alpha **不抖动**：它是覆盖遮罩而不是连续调，抖动会让图层边缘出现假的透明噪点。
      // （这一点是 tools/verify-bundle.mjs 的 3 通道路径检查抓出来的：
      //   抖动会让本应恒为 255 的 alpha 掉到 254，即凭空产生半透明像素。）
      out[p + 3] = alpha ? qa(alpha[i], aMax) : aMax;
    }
  }
  return out;
}

function q8(v, max, d) {
  const x = v * max + d;
  return x <= 0 ? 0 : x >= max ? max : (x + 0.5) | 0;
}
function q16(v, max, d) {
  const x = v * 32768 + d;
  return x <= 0 ? 0 : x >= 32768 ? 32768 : (x + 0.5) | 0;
}
/** alpha 的量化：不抖动，只四舍五入并钳位 */
function qa(v, max) {
  const x = v * max;
  return x <= 0 ? 0 : x >= max ? max : (x + 0.5) | 0;
}

/* ================================================================
   行带分段计算
   ================================================================ */

/**
 * 把颗粒施加到整幅 rgb 上，但**按行带分段调用核心**，以压低内存峰值。
 *
 * 关键：行带的起始行通过 originY 传给颗粒场生成器，而颗粒场用坐标寻址哈希 + halo，
 * 所以「分段算」的结果与「整图一次算」**逐像素完全一致** —— 这是可以断言的性质，
 * 已由测试 3 覆盖（tile 与整图零差异）。因此分段只是内存手段，不是精度妥协。
 *
 * 由于 rgb 的行是连续的，band 正好是 rgb 的一个 subarray 视图，无需拷贝。
 *
 * @param bandRows  每个带的行数。默认 256：24 MP 时约 24 个带，单带工作集约 3 MB（RGB）
 */
export function applyGrainBanded(rgb, width, height, opts = {}) {
  const o = opts || {};
  const bandRows = Math.max(1, Math.min(height, o.bandRows || 256));
  const onProgress = o.onProgress;
  const stride = width * 3;
  // originY 基准：调用方可能传入「本图在整幅图中的起点」，带的偏移要**加在它上面**。
  // 若直接覆盖成 y0，从裁剪区域调用时颗粒场的相位就会整体错位（实测差异 2.85e-1）。
  const baseY = o.originY || 0;
  const baseX = o.originX || 0;

  for (let y0 = 0; y0 < height; y0 += bandRows) {
    const h = Math.min(bandRows, height - y0);
    const view = rgb.subarray(y0 * stride, (y0 + h) * stride);
    applyGrain(view, width, h, Object.assign({}, o, { originX: baseX, originY: baseY + y0 }));
    if (onProgress) onProgress((y0 + h) / height);
  }
  return rgb;
}

/* ================================================================
   顶层：一次调用完成「解码 → 加颗粒 → 编码」
   ================================================================ */

/**
 * @param src        交错像素缓冲（来自 getPixels().imageData.getData()）
 * @param components 3 或 4
 * @param bits       文档原生位深（8/16/32）
 * @param params     传给 applyGrain 的参数，外加 bandRows / onProgress / dither / seed
 * @returns          交错 4 通道缓冲，可直接交给 putPixels
 */
export function processImage(src, width, height, components, bits, params = {}) {
  const { rgb, alpha } = decodePixels(src, width, height, components, bits);
  applyGrainBanded(rgb, width, height, params);
  return encodePixels(rgb, alpha, width, height, bits, {
    dither: params.dither,
    seed: params.seed,
  });
}
