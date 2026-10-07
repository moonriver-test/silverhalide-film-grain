/* 彩色脏污诊断：量化「团簇包络是否共用」对色度噪声的影响
 *
 * 用户报的现象：调大尺寸 / 团簇度时，画面出现彩色脏污（杂色噪点）。
 *
 * 指标设计：
 *   把图像分成 8×8 块，分别算 R−G、G−B 的**块均值**，再对块均值求标准差
 *   —— 这叫「低频色度噪声」，正是人眼读作「有颜色的云斑 / 脏污」的那个量。
 *   对照组是同一区域内的**高频**色度噪声（扣除块均值后的残差），
 *   那是细颗粒尺度的颜色抖动，正常胶片也有，量级小、不读作脏污。
 *
 * A/B：envelopeMode='shared'（新，全通道共用包络）vs 'perChannel'（旧，各带一个）。
 *
 * 运行：node tools/diag-chroma.mjs
 */

import { applyGrain, makeFlat } from '../core/grain.mjs';
import { packRGB8 } from '../core/png.mjs';
import { writeRGBPNG } from './png.mjs';

const BLOCK = 8;

/* 多尺度色度噪声：把 R−G 在 BLOCK×BLOCK 块上平均，再看块均值的标准差。
 * 块越小 → 包含的尺度越宽；块越大 → 越只剩低频。
 * 用一组块尺寸才能看出色度噪声**住在哪个尺度**：
 *   细颗粒在 2~8 px，团簇包络在 20~40 px。只报单一块尺寸会得出错误结论。 */
function chromaByScale(rgb, W, H, blocks) {
  const n = W * H;
  const rg = new Float64Array(n), gb = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    rg[i] = rgb[i * 3] - rgb[i * 3 + 1];
    gb[i] = rgb[i * 3 + 1] - rgb[i * 3 + 2];
  }
  const total = Math.max(sd(rg), sd(gb)) * 255;
  const out = { total };
  for (const B of blocks) {
    const bx = Math.floor(W / B), by = Math.floor(H / B);
    const a = new Float64Array(bx * by), b = new Float64Array(bx * by);
    for (let j = 0; j < by; j++) {
      for (let i = 0; i < bx; i++) {
        let sr = 0, sb = 0;
        for (let y = 0; y < B; y++) {
          for (let x = 0; x < B; x++) {
            const p = (j * B + y) * W + (i * B + x);
            sr += rg[p]; sb += gb[p];
          }
        }
        a[j * bx + i] = sr / (B * B);
        b[j * bx + i] = sb / (B * B);
      }
    }
    out['b' + B] = Math.max(sd(a), sd(b)) * 255;
  }
  return out;
}

function sd(arr) {
  let m = 0;
  for (let i = 0; i < arr.length; i++) m += arr[i];
  m /= arr.length;
  let v = 0;
  for (let i = 0; i < arr.length; i++) v += (arr[i] - m) * (arr[i] - m);
  return Math.sqrt(v / arr.length);
}

/** 分块统计：返回 { lum, lfChroma, hfChroma } */
function analyze(rgb, W, H) {
  const n = W * H;
  const lum = new Float64Array(n);
  const rg = new Float64Array(n);
  const gb = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    rg[i] = r - g;
    gb[i] = g - b;
  }
  const sd = (arr) => {
    let m = 0;
    for (let i = 0; i < arr.length; i++) m += arr[i];
    m /= arr.length;
    let v = 0;
    for (let i = 0; i < arr.length; i++) v += (arr[i] - m) * (arr[i] - m);
    return Math.sqrt(v / arr.length);
  };

  // 块均值（低频）与块内去均值（高频）
  const bx = Math.floor(W / BLOCK), by = Math.floor(H / BLOCK);
  const lfRG = new Float64Array(bx * by), lfGB = new Float64Array(bx * by);
  const hfRG = [], hfGB = [];
  for (let j = 0; j < by; j++) {
    for (let i = 0; i < bx; i++) {
      let sr = 0, sb = 0;
      for (let y = 0; y < BLOCK; y++) {
        for (let x = 0; x < BLOCK; x++) {
          const p = (j * BLOCK + y) * W + (i * BLOCK + x);
          sr += rg[p]; sb += gb[p];
        }
      }
      const mR = sr / (BLOCK * BLOCK), mB = sb / (BLOCK * BLOCK);
      lfRG[j * bx + i] = mR;
      lfGB[j * bx + i] = mB;
      for (let y = 0; y < BLOCK; y++) {
        for (let x = 0; x < BLOCK; x++) {
          const p = (j * BLOCK + y) * W + (i * BLOCK + x);
          hfRG.push(rg[p] - mR);
          hfGB.push(gb[p] - mB);
        }
      }
    }
  }
  return {
    lum: sd(lum) * 255,
    lf: Math.max(sd(lfRG), sd(lfGB)) * 255,
    hf: Math.max(sd(hfRG), sd(hfGB)) * 255
  };
}

const W = 512, H = 256;
const gray = makeFlat(W, H, 0.45);

const CASES = [
  { label: '默认（尺寸 2.0 / 团簇 0.35）', radiusPx: 2.0, clumping: 0.35 },
  { label: '大尺寸（尺寸 4.0 / 团簇 0.35）', radiusPx: 4.0, clumping: 0.35 },
  { label: '高团簇（尺寸 2.0 / 团簇 0.80）', radiusPx: 2.0, clumping: 0.80 },
  { label: '用户报的组合（尺寸 4.5 / 团簇 0.85）', radiusPx: 4.5, clumping: 0.85 }
];

console.log('=== 彩色脏污诊断（平灰 0.45，' + W + '×' + H + '，strength 0.014）===');
console.log('  多尺度色度噪声 = |R−G| 与 |G−B| 在 BLOCK 块上平均后的标准差');
console.log('  块越小含的尺度越宽；块 32/64 基本只剩团簇包络尺度。单位：8 位色阶\n');
const BLOCKS = [8, 16, 32, 64];
console.log('  参数组合'.padEnd(30) + '模式'.padEnd(12) + '总量'.padStart(8) + BLOCKS.map(b => ('块' + b).padStart(8)).join('') + '  亮度');
console.log('  ' + '-'.repeat(92));

const results = [];
for (const c of CASES) {
  const out = {};
  for (const mode of ['shared', 'perChannel']) {
    const img = Float32Array.from(gray);
    applyGrain(img, W, H, {
      seed: 11, strength: 0.014, radiusPx: c.radiusPx, clumping: c.clumping,
      envelopeMode: mode
    });
    const cs = chromaByScale(img, W, H, BLOCKS);
    const a = analyze(img, W, H);
    out[mode] = { cs, a };
    if (mode === 'shared') out.sharedImg = img; else out.oldImg = img;
  }
  results.push({ c, ...out });
  for (const mode of ['shared', 'perChannel']) {
    const { cs, a } = out[mode];
    console.log('  ' + (mode === 'shared' ? c.label : '').padEnd(30)
      + (mode === 'shared' ? '共用包络' : '各带包络').padEnd(12)
      + cs.total.toFixed(2).padStart(8)
      + BLOCKS.map(b => cs['b' + b].toFixed(2).padStart(8)).join('')
      + a.lum.toFixed(2).padStart(7));
  }
  console.log('');
}

console.log('=== 判定（看块 32/64，那才是包络尺度）===');
let allOk = true;
for (const r of results) {
  const s = r.shared.cs, o = r.perChannel.cs;
  const drop = 1 - s.b64 / Math.max(1e-9, o.b64);
  const ok = s.b64 < o.b64 * 0.6;
  if (!ok) allOk = false;
  console.log('  ' + r.c.label.padEnd(32) + '块64 ' + o.b64.toFixed(2) + ' → ' + s.b64.toFixed(2)
    + '　降 ' + (drop * 100).toFixed(1) + '%　' + (ok ? '✓' : '✗'));
}
console.log('');
console.log(allOk ? '  ✓ 共用包络显著压低了包络尺度的色度噪声'
  : '  ✗ 包络不是主因 —— 色度噪声来自细颗粒尺度，需要改色度模型本身');

// 输出目视对照图（1:1 原始像素）
const g8s = packRGB8(results[3].sharedImg, W, H);
const g8o = packRGB8(results[3].oldImg, W, H);
writeRGBPNG('out/chroma-shared.png', W, H, g8s);
writeRGBPNG('out/chroma-perchannel.png', W, H, g8o);
console.log('  已写出 out/chroma-shared.png（新）　out/chroma-perchannel.png（旧）');

// 彩色块检查：纯色区域不应该被染出别的颜色
console.log('');
console.log('=== 纯色块检查（尺寸 4.5 / 团簇 0.85）===');
const PATCH = [[0.8, 0.2, 0.2, '红'], [0.2, 0.6, 0.3, '绿'], [0.2, 0.3, 0.8, '蓝']];
for (const [r, g, b, name] of PATCH) {
  const src = new Float32Array(W * H * 3);
  for (let i = 0; i < W * H; i++) { src[i * 3] = r; src[i * 3 + 1] = g; src[i * 3 + 2] = b; }
  const img = Float32Array.from(src);
  applyGrain(img, W, H, { seed: 11, strength: 0.014, radiusPx: 4.5, clumping: 0.85 });
  const a = analyze(img, W, H);
  console.log('  ' + name.padEnd(4) + '亮度 ' + a.lum.toFixed(2) + '　低频色度 ' + a.lf.toFixed(2)
    + '　高频色度 ' + a.hf.toFixed(2));
}
