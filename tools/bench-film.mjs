/* 胶片预设标定验证 + 视觉阶梯
 *
 * 三件事：
 *  1. 数值：grainIndex 跨 ISO 单调、ISO 指数 ≈ 1/3、画幅效应对齐报告表 6
 *  2. 护栏：**所有预设 × 所有档位**的色度噪声 / 亮度噪声 < 0.35
 *     （这是「彩色脏污」那一类 bug 的回归护栏，必须是全组合而不是抽样）
 *  3. 目视：把若干胶片渲染在平灰上，1:1 拼成阶梯
 */
import { writeFileSync } from 'node:fs';
import {
  FILM_STOCKS, filmsByGroup, filmById, gaugeById, GAUGES, STOPS,
  grainIndex, equivalentIso, resolveFilmParams, autoEnvelopeStride, autoFineStride,
} from '../core/film.mjs';
import { applyGrain, generateGrainField, makeFlat } from '../core/grain.mjs';
import { packRGB8 } from '../core/png.mjs';
import { writeRGBPNG } from './png.mjs';

const OUT = 'out';
const UXP = 34.33 / 22.08; // Node → UXP 换算系数（实测）

const f = (v, n = 2) => v.toFixed(n);
const sd = (a) => {
  let m = 0; for (let i = 0; i < a.length; i++) m += a[i];
  m /= a.length;
  let v = 0; for (let i = 0; i < a.length; i++) v += (a[i] - m) * (a[i] - m);
  return Math.sqrt(v / a.length);
};

/* ================================================================
   1. ISO 与画幅的标定
   ================================================================ */
console.log('=== 1. 感光度阶梯（Portra 400，135，24 MP）===');
console.log('  档位   等效 ISO   grain   半径px   幅度     包络倍率');
for (const s of STOPS) {
  const p = resolveFilmParams({ film: 'portra400', stops: s.v, gauge: '135', imageWidth: 6000, imageHeight: 4000 });
  console.log(`  ${s.label.padEnd(8)}${String(p.iso).padStart(7)}   ${f(p.grainIndex, 3).padStart(6)}  ${f(p.radiusPx, 2).padStart(7)}  ${f(p.strength, 4).padStart(7)}  ${String(autoEnvelopeStride(p.radiusPx, p.clumping)).padStart(5)}`);
}
{
  const g0 = grainIndex(filmById('portra400'), 0);
  const g1 = grainIndex(filmById('portra400'), 2);
  const exp = Math.log(g1 / g0) / Math.log(4);
  console.log(`\n  1600/400 两档的实测指数 = ${f(exp, 3)}（设定 ${f(1 / 3, 3)}，推冲惩罚使其上偏）`);
  const pure = Math.pow(2, 2 / 3);
  console.log(`  纯 ISO 项（无推冲惩罚）应为 2^(2/3) = ${f(pure, 3)}，实测含惩罚 = ${f(g1, 3)}`);
}

console.log('\n=== 2. 画幅梯度 vs 报告表 6 的 PGI（Portra 160）===');
console.log('  画幅       颗粒相对尺度   预测 PGI 比   报告实测比');
{
  // 报告表 6：同一 Portra 160，16×20 输出下 135=79、120=50、4×5=26
  const measured = { '135': 79, '120': 50, '4x5': 26 };
  const ref = measured['135'];
  for (const g of GAUGES) {
    if (!measured[g.id]) continue;
    const p = resolveFilmParams({ film: 'portra160', stops: 0, gauge: g.id, imageWidth: 6000, imageHeight: 4000 });
    const pred = p.radiusPx / resolveFilmParams({ film: 'portra160', gauge: '135', imageWidth: 6000, imageHeight: 4000 }).radiusPx;
    console.log(`  ${g.name.padEnd(10)}${f(p.gaugeScale, 3).padStart(10)}${f(pred, 3).padStart(14)}${f(measured[g.id] / ref, 3).padStart(13)}`);
  }
  console.log('  注：模型指数 0.8 由这两组数据拟合，误差见上表。PGI 的绝对值不可与 grain 直接比，只比比值。');
}

/* ================================================================
   2. 色度护栏：全组合
   ================================================================ */
console.log('\n=== 3. 色度噪声护栏（全部 ' + FILM_STOCKS.length + ' 款 × ' + STOPS.length + ' 档 × 2 画幅）===');
{
  const W = 320, H = 200, px = W * H;
  const gray = makeFlat(W, H, 0.45);
  let worst = 0, worstWhat = '', bad = 0;
  const rows = [];
  for (const film of FILM_STOCKS) {
    for (const s of STOPS) {
      if (s.v > 0 && film.iso >= 3200) continue;           // 3200 再推三档没意义
      for (const gauge of ['135', '16mm']) {
        const p = resolveFilmParams({
          film, stops: s.v, gauge, imageWidth: W, imageHeight: H,
        });
        const img = Float32Array.from(gray);
        applyGrain(img, W, H, {
          seed: 7, radiusPx: p.radiusPx, clumping: p.clumping,
          strength: p.strength, uPeak: p.uPeak, lumaChroma: p.lumaChroma,
          mono: p.mono, weights: p.weights, chromaRadiusScale: p.chromaRadiusScale,
        });
        const lum = new Float64Array(px), rg = new Float64Array(px), gb = new Float64Array(px);
        for (let i = 0; i < px; i++) {
          const r = img[i * 3], g = img[i * 3 + 1], b = img[i * 3 + 2];
          lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          rg[i] = r - g; gb[i] = b - g;
        }
        const L = sd(lum) * 255;
        const Chr = Math.max(sd(rg), sd(gb)) * 255;
        const ratio = L > 0.01 ? Chr / L : 0;
        if (ratio > worst) { worst = ratio; worstWhat = `${film.name} ${s.label} ${gauge}`; }
        if (ratio > 0.35) bad++;
        rows.push({ film: film.name, stops: s.label, gauge, L, Chr, ratio });
      }
    }
  }
  console.log(`  最差组合 : ${worstWhat}　色度/亮度 = ${f(worst, 3)}（阈值 0.35）`);
  console.log(`  超阈值数量 : ${bad} / ${rows.length}`);
  console.log('  说明：该比值随参数**必须稳定** —— 旧版随参数从 0.5 涨到 1.8，');
  console.log('        用户调大尺寸/团簇度时就会出现彩色斑块。');
  const chr = rows.filter((r) => r.Chr > 0.02).map((r) => r.ratio);
  console.log(`  比值分布 : min ${f(Math.min(...chr), 3)}　max ${f(Math.max(...chr), 3)}　中位 ${f(chr.sort((a, b) => a - b)[chr.length >> 1], 3)}`);
}

/* ================================================================
   3. 视觉阶梯
   ================================================================ */
console.log('\n=== 4. 视觉阶梯（平灰 0.45，1:1）===');
{
  const W = 300, H = 150;
  const PICKS = ['ektar100', 'portra400', 'gold200', 'portra800', 'trix400', 'hp5', 'd3200', 'velvia50'];
  const GAP = 2;
  const OH = PICKS.length * H + (PICKS.length - 1) * GAP;
  const out = new Uint8Array(W * OH * 3);
  const gray = makeFlat(W, H, 0.45);
  let oy = 0;
  for (const id of PICKS) {
    const film = filmById(id);
    const p = resolveFilmParams({ film, stops: 0, gauge: '135', imageWidth: 6000, imageHeight: 4000 });
    // 用 24MP 的半径，但在小画布上渲染 —— 反映「同一张照片裁一小块看」
    const img = Float32Array.from(gray);
    applyGrain(img, W, H, {
      seed: 4242, radiusPx: p.radiusPx * 1.0, clumping: p.clumping,
      strength: p.strength, uPeak: p.uPeak, lumaChroma: p.lumaChroma,
      mono: p.mono, weights: p.weights, chromaRadiusScale: p.chromaRadiusScale,
      originX: 2000, originY: 3000,
    });
    const u8 = packRGB8(img, W, H);
    for (let y = 0; y < H; y++) {
      const s = y * W * 3, d = ((oy + y) * W) * 3;
      out.set(u8.subarray(s, s + W * 3), d);
    }
    console.log(`  ${film.name.padEnd(18)} g=${f(p.grainIndex, 2)}  半径 ${f(p.radiusPx, 2)} px  幅度 ${f(p.strength, 4)}`);
    oy += H + GAP;
  }
  writeRGBPNG(`${OUT}/film-ladder.png`, W, OH, out);
  console.log(`  已写出 ${OUT}/film-ladder.png（自上而下：${PICKS.join(' / ')}）`);
}

/* ================================================================
   4. 极端参数的性能上界
   ================================================================ */
console.log('\n=== 5. 性能上界（最粗的组合）===');
{
  const N = 512;
  // 半径必须按**整图**算（6000×4000），再在 512² 的小画布上渲染 ——
  // 相当于「在 24 MP 照片里取一块 512² 的裁切」。直接传 512 会让
  // 分辨率无关的缩放把半径压到 0.05 px，测的就不是真实成本了。
  const mk = (o) => resolveFilmParams({ ...o, imageWidth: 6000, imageHeight: 4000 });
  const cases = [
    ['Ektar 100 / 4×5', mk({ film: 'ektar100', gauge: '4x5' })],
    ['Portra 400 / 135', mk({ film: 'portra400', gauge: '135' })],
    ['Portra 800 / 135 +2', mk({ film: 'portra800', stops: 2, gauge: '135' })],
    ['Portra 400 / 135 +3', mk({ film: 'portra400', stops: 3, gauge: '135' })],
    ['Delta 3200 / 16mm', mk({ film: 'd3200', gauge: '16mm' })],
  ];
  for (const [label, p] of cases) {
    const sg = Math.max(0.35, p.radiusPx * 0.5);
    const run = () => generateGrainField({
      width: N, height: N, seed: 1, radiusPx: p.radiusPx, clumping: p.clumping,
    });
    run();
    let best = Infinity;
    for (let i = 0; i < 3; i++) { const t = performance.now(); run(); best = Math.min(best, performance.now() - t); }
    const nsPx = best * 1e6 / (N * N);
    console.log(`  ${label.padEnd(20)} μr=${f(p.radiusPx, 2).padStart(5)}  σ_g=${f(sg, 2).padStart(4)}  fine=${autoFineStride(sg)}  env=${autoEnvelopeStride(p.radiusPx, p.clumping)}  ${f(nsPx, 1).padStart(6)} ns/px  → 24MP×4场 ${f(nsPx * 24.34e6 * 4 * UXP / 1e9, 1)} s`);
  }
}
