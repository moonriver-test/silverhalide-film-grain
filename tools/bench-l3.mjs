/* L3 合成与颗粒场的成本拆分（真实参数）
 *
 * 手法：`strength: 0` 会让幅度 LUT 全为 0，合成循环里 `if (s0 === 0) continue;`
 * 直接跳过每个像素 —— 于是这一次测量只剩「生成颗粒场」的成本。
 * 两次之差就是纯合成循环（L3）的成本。这是无侵入的隔离办法。
 *
 * 运行：node tools/bench-l3.mjs
 */

import { applyGrain, makeFlat, SIGMA_GRAIN_RATIO, clusterSigma, ENVELOPE_STRIDE } from '../core/grain.mjs';

const UXPRatio = 34.33 / 22.08;
const N = 1024, H = 1024, PX = N * H;
const MP24 = 24;

const flat = makeFlat(N, H, 0.45);
const rgb0 = new Float32Array(PX * 3);
for (let i = 0; i < PX; i++) { rgb0[i * 3] = flat[i]; rgb0[i * 3 + 1] = flat[i]; rgb0[i * 3 + 2] = flat[i]; }

function bench(label, fn, reps = 5) {
  fn();
  let best = Infinity;
  for (let i = 0; i < reps; i++) { const t = performance.now(); fn(); best = Math.min(best, performance.now() - t); }
  const ns = best * 1e6 / PX;
  console.log('  ' + label.padEnd(38) + best.toFixed(1).padStart(8) + ' ms'
    + ns.toFixed(2).padStart(9) + ' ns/px'
    + ('　UXP 24MP ' + (best * MP24 / (PX / 1e6) * UXPRatio / 1000).toFixed(2) + ' s').padStart(20));
  return best;
}

const base = { seed: 1, radiusPx: 2, clumping: 0.35 };
const sg = Math.max(0.35, 2 * SIGMA_GRAIN_RATIO);
const sc = clusterSigma(2, 0.35);
const taps = (s) => 2 * Math.max(1, Math.ceil(3 * s)) + 1;
console.log('=== 参数（默认 μr=2, c=0.35）===');
console.log('  细颗粒核 σ_g=' + sg.toFixed(2) + ' → ' + taps(sg) + ' 抽头');
console.log('  团簇包络 σ_c=' + sc.toFixed(2) + ' → 全分辨率 ' + taps(sc) + ' 抽头，降采样 stride=' + ENVELOPE_STRIDE + ' 后 ' + taps(sc / ENVELOPE_STRIDE) + ' 抽头');
console.log('  色度细颗粒 σ_g=' + (sg * 1.8).toFixed(2) + ' → ' + taps(sg * 1.8) + ' 抽头');
console.log('');

console.log('=== 成本拆分（strength=0 只留颗粒场）===');
const tFields = bench('颗粒场生成（4 个场，strength=0）',
  () => applyGrain(rgb0.slice(), N, H, Object.assign({}, base, { strength: 0 })));
const tTotal = bench('完整 applyGrain（strength=0.045）',
  () => applyGrain(rgb0.slice(), N, H, Object.assign({}, base, { strength: 0.045 })));
const tMono = bench('完整 applyGrain（mono，只有亮度场）',
  () => applyGrain(rgb0.slice(), N, H, Object.assign({}, base, { strength: 0.045, mono: true })));
console.log('');
console.log('  L3 合成 ≈ 完整 − 场生成 = ' + (tTotal - tFields).toFixed(0) + ' ms'
  + '（' + ((tTotal - tFields) * 1e6 / PX).toFixed(1) + ' ns/px）');
console.log('  色度三个场的总代价 ≈ 完整 − mono = ' + (tTotal - tMono).toFixed(0) + ' ms');
console.log('');

console.log('=== 关键结论 ===');
const share = (tTotal - tFields) / tTotal;
console.log('  L3 占 ' + (share * 100).toFixed(0) + '%，颗粒场占 ' + ((1 - share) * 100).toFixed(0) + '%');
console.log('  ⇒ 优化重点应放在' + (share > 0.5 ? ' L3 合成' : '颗粒场生成（尤其是 3 个色度场）'));
