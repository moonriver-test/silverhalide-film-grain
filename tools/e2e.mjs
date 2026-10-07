/* 离线端到端：真实照片 → 加颗粒 → 输出 1:1 前后对比图
 *
 * 这是进 UXP 之前的最后一道自检：证明「解码 → 分段加颗粒 → 编码」整条链能跑，
 * 并且验证「行带分段」与「整图一次算」逐位一致。
 *
 * 运行：node tools/e2e.mjs
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { decodePixels, encodePixels, applyGrainBanded, depthMax } from '../core/io.mjs';
import { applyGrain } from '../core/grain.mjs';
import { resolveFilmParams } from '../core/film.mjs';
import { writeRGBPNG } from './png.mjs';

const require = createRequire(import.meta.url);
const jpeg = require('C:/Users/qijin/.workbuddy/binaries/node/workspace/node_modules/jpeg-js');

const SRC = 'C:/Users/qijin/Desktop/未命名导出/DSC_1603.jpg';
const OUT = 'out';
const UXPRatio = 34.33 / 22.08;

/* 参数不再手写 —— 走面板同一条路径：胶片 + 感光度 + 画幅 → 物理参数。
 * 这样离线端到端验证的就是用户真正会得到的东西。 */
let IMG_W = 6000, IMG_H = 4000;
const mkParams = (filmId, stops, gauge) => Object.assign(
  resolveFilmParams({ film: filmId, stops: stops || 0, gauge: gauge || '135', imageWidth: IMG_W, imageHeight: IMG_H }),
  { seed: 20261004 }
);
const PARAMS = () => Object.assign(mkParams('portra400', 0, '135'), { bandRows: 256 });

const t = (label, fn) => {
  const t0 = performance.now();
  const r = fn();
  const dt = performance.now() - t0;
  console.log('  ' + label.padEnd(34) + dt.toFixed(1).padStart(9) + ' ms'
    + ('　UXP 推算 ' + (dt * UXPRatio).toFixed(0) + ' ms').padStart(26));
  return { r, dt };
};

console.log('=== 1. 解码真实照片 ===');
if (!fs.existsSync(SRC)) { console.log('  找不到 ' + SRC); process.exit(1); }
const { r: dec, dt: tDecode } = t('JPEG 解码（jpeg-js）', () => jpeg.decode(fs.readFileSync(SRC), { useTArray: true }));
const W = dec.width, H = dec.height;
IMG_W = W; IMG_H = H;
const P0 = PARAMS();
console.log('  尺寸 ' + W + '×' + H + '（' + (W * H / 1e6).toFixed(2) + ' MP）　4 通道');

console.log('\n=== 2. 行带分段：与整图一次算是否逐位一致 ===');
{
  const CW = 512, CH = 384, ox = 1200, oy = 2000;
  const crop = new Float32Array(CW * CH * 3);
  for (let y = 0; y < CH; y++) {
    for (let x = 0; x < CW; x++) {
      const s = ((oy + y) * W + ox + x) * 4, d = (y * CW + x) * 3;
      crop[d] = dec.data[s] / 255; crop[d + 1] = dec.data[s + 1] / 255; crop[d + 2] = dec.data[s + 2] / 255;
    }
  }
  const whole = Float32Array.from(crop);
  applyGrain(whole, CW, CH, P0);

  const banded = Float32Array.from(crop);
  applyGrainBanded(banded, CW, CH, Object.assign({}, P0, { bandRows: 64, originX: ox, originY: oy }));
  const wholeAtOrigin = Float32Array.from(crop);
  applyGrain(wholeAtOrigin, CW, CH, Object.assign({}, P0, { originX: ox, originY: oy }));

  let maxDiff = 0;
  for (let i = 0; i < whole.length; i++) maxDiff = Math.max(maxDiff, Math.abs(wholeAtOrigin[i] - banded[i]));
  console.log('  带高 64 行 × 6 带 vs 一次算　最大逐点差异 = ' + maxDiff.toExponential(2));
  console.log('  ' + (maxDiff === 0 ? '✓ 逐位一致 —— 分段只是内存手段，不是精度妥协' : '✗ 不一致，分段逻辑有误'));
}

console.log('\n=== 3. 全图跑一遍（' + (W * H / 1e6).toFixed(2) + ' MP，行带 ' + P0.bandRows + '）===');
let rgb, alpha, out;
{
  const a = t('decodePixels（u8 交错 → f32 RGB）', () => decodePixels(dec.data, W, H, 4, 8));
  rgb = a.r.rgb; alpha = a.r.alpha;
  let bands = 0;
  const b = t('applyGrainBanded（L1+L2+L3）', () => applyGrainBanded(rgb, W, H, Object.assign({}, P0, { onProgress: () => bands++ })));
  console.log('     共 ' + bands + ' 个行带');
  const c = t('encodePixels（量化 + TPDF 抖动）', () => encodePixels(rgb, alpha, W, H, 8, { seed: P0.seed }));
  out = c.r;
}
const total = tDecode + 0;
console.log('  输出缓冲 ' + (out.byteLength / 1048576).toFixed(1) + ' MB，' + out.constructor.name);

console.log('\n=== 4. 找一块中间调 1:1 区域做目视对比 ===');
const CW = 900, CH = 620;
let best = null;
for (let oy = 200; oy + CH < H; oy += 400) {
  for (let ox = 200; ox + CW < W; ox += 400) {
    let s = 0, n = 0;
    for (let y = 0; y < CH; y += 8) {
      for (let x = 0; x < CW; x += 8) {
        const p = ((oy + y) * W + ox + x) * 4;
        s += (dec.data[p] * 0.2126 + dec.data[p + 1] * 0.7152 + dec.data[p + 2] * 0.0722);
        n++;
      }
    }
    const m = s / n / 255;
    const score = Math.abs(m - 0.45);
    if (!best || score < best.score) best = { ox, oy, m, score };
  }
}
console.log('  选定区域 (' + best.ox + ',' + best.oy + ') 平均亮度 ' + best.m.toFixed(3));

const before = new Uint8Array(CW * CH * 3);
const after = new Uint8Array(CW * CH * 3);
for (let y = 0; y < CH; y++) {
  for (let x = 0; x < CW; x++) {
    const s = ((best.oy + y) * W + best.ox + x) * 4;
    const d = (y * CW + x) * 3;
    before[d] = dec.data[s]; before[d + 1] = dec.data[s + 1]; before[d + 2] = dec.data[s + 2];
    after[d] = out[s]; after[d + 1] = out[s + 1]; after[d + 2] = out[s + 2];
  }
}
writeRGBPNG(OUT + '/e2e-before.png', CW, CH, before);
writeRGBPNG(OUT + '/e2e-after.png', CW, CH, after);

// 并排对比图：左=原始，右=加颗粒。中间留 4 px 深色分隔。
const GAP = 4;
const SW = CW * 2 + GAP;
const side = new Uint8Array(SW * CH * 3);
for (let y = 0; y < CH; y++) {
  for (let x = 0; x < CW; x++) {
    const d = (y * SW + x) * 3, s = (y * CW + x) * 3;
    side[d] = before[s]; side[d + 1] = before[s + 1]; side[d + 2] = before[s + 2];
    const d2 = (y * SW + CW + GAP + x) * 3;
    side[d2] = after[s]; side[d2 + 1] = after[s + 1]; side[d2 + 2] = after[s + 2];
  }
  for (let g = 0; g < GAP; g++) {
    const d = (y * SW + CW + g) * 3;
    side[d] = 24; side[d + 1] = 24; side[d + 2] = 24;
  }
}
writeRGBPNG(OUT + '/e2e-compare.png', SW, CH, side);
console.log('  已写出 out/e2e-compare.png（左 原始 ｜ 右 加颗粒，1:1 原始像素）');

/* ---- 同一张真实照片 × 四款胶片：v0.3 参数模型的目视验收 ---- */
console.log('\n=== 4b. 胶片对比条（同一区域，1:1）===');
{
  const PICKS = [
    ['ektar100', 0, 'Ektar 100'],
    ['portra400', 0, 'Portra 400'],
    ['portra800', 3, 'Portra 800 推三档'],
    ['d3200', 0, 'Delta 3200'],
    ['trix400', 0, 'Tri-X 400'],
  ];
  const crop2 = new Float32Array(CW * CH * 3);
  for (let y = 0; y < CH; y++) {
    for (let x = 0; x < CW; x++) {
      const s = ((best.oy + y) * W + best.ox + x) * 4, d = (y * CW + x) * 3;
      crop2[d] = dec.data[s] / 255; crop2[d + 1] = dec.data[s + 1] / 255; crop2[d + 2] = dec.data[s + 2] / 255;
    }
  }
  const GAP2 = 3;
  const OH = PICKS.length * CH + (PICKS.length - 1) * GAP2;
  const strip = new Uint8Array(CW * OH * 3);
  let oy2 = 0;
  for (const [id, st, label] of PICKS) {
    const pr = mkParams(id, st, '135');
    const work = Float32Array.from(crop2);
    applyGrain(work, CW, CH, Object.assign({}, pr, { originX: best.ox, originY: best.oy }));
    const u8 = encodePixels(work, null, CW, CH, 8, { seed: pr.seed, dither: false });
    for (let y = 0; y < CH; y++) {
      for (let x = 0; x < CW; x++) {
        const s = (y * CW + x) * 4, d = ((oy2 + y) * CW + x) * 3;
        strip[d] = u8[s]; strip[d + 1] = u8[s + 1]; strip[d + 2] = u8[s + 2];
      }
    }
    console.log('  ' + label.padEnd(18) + 'μr ' + pr.radiusPx.toFixed(2).padStart(5) +
      ' px　幅度 ' + pr.strength.toFixed(4) + '　团簇 ' + pr.clumping.toFixed(2) +
      '　色度占比 ' + pr.lumaChroma.toFixed(3) + (pr.mono ? '　黑白' : ''));
    oy2 += CH + GAP2;
  }
  writeRGBPNG(OUT + '/e2e-films.png', CW, OH, strip);
  console.log('  已写出 out/e2e-films.png（自上而下：' + PICKS.map((p) => p[2]).join(' / ') + '）');
}

console.log('\n=== 5. 量化质量核对 ===');
{
  const stat = (buf, off) => {
    let s = 0, s2 = 0, n = 0;
    for (let i = 0; i < buf.length; i++) { const v = buf[i]; s += v; s2 += v * v; n++; }
    const m = s / n;
    return { m, sd: Math.sqrt(s2 / n - m * m) };
  };
  const bs = stat(before), as = stat(after);
  console.log('  区域均值      : 前 ' + bs.m.toFixed(3) + ' → 后 ' + as.m.toFixed(3)
    + '　漂移 ' + ((as.m - bs.m) * 255 / 255).toFixed(4) + '（0~1 标度）');
  console.log('  区域标准差    : 前 ' + bs.sd.toFixed(3) + ' → 后 ' + as.sd.toFixed(3));
  console.log('  8 位量化台阶  : ' + (1 / 255).toFixed(4) + '　TPDF 抖动噪声 0.41 LSB = ' + (0.41 / 255).toFixed(4));
}

console.log('\n=== 6. 时间汇总（Node 实测 / UXP 推算 = ×' + UXPRatio.toFixed(3) + '）===');
console.log('  JPEG 解码不计入插件耗时（PS 已解码）。插件侧真正要做的三件事见第 3 节。');
