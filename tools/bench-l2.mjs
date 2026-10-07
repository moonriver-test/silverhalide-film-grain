/* L2/L3 真实成本基准：直接调用生产函数，不是合成负载
 *
 * 目标：把 UXP 探针测出的「朴素卷积 34.33 ns/px」换成真实配置下的数字，
 * 判断 L2 层到底需不需要 WASM，以及团簇场要不要降到低分辨率算。
 *
 * 换算依据：同一段朴素卷积，UXP 34.33 ns/px vs Node 22.08 ns/px
 *          ⇒ UXP ≈ 1.55 × Node。本脚本输出 Node 数字，并给出 UXP 推算。
 *
 * 运行：node tools/bench-l2.mjs
 */

import { filteredNoise, generateGrainField, clusterSigma, applyGrain, makeFlat, SIGMA_GRAIN_RATIO } from '../core/grain.mjs';

const UXPRatio = 34.33 / 22.08; // 由探针与本地基准的同一段代码标定
const MP24 = 24;

function bench(label, fn, px, reps = 5) {
  fn();
  let best = Infinity;
  for (let i = 0; i < reps; i++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  const nsPx = (best * 1e6) / px;
  const uxp = best * MP24 / (px / 1e6) * UXPRatio;
  console.log(
    '  ' + label.padEnd(46) +
    best.toFixed(1).padStart(7) + ' ms' +
    nsPx.toFixed(2).padStart(9) + ' ns/px' +
    ('→ 24MP『UXP』 ' + uxp.toFixed(0) + ' ms').padStart(24)
  );
  return { ms: best, nsPx, per24Uxp: uxp };
}

const N = 1024, H = 1024, PX = N * H;
const radiusPx = 2.0, clumping = 0.35;
const sg = Math.max(0.35, radiusPx * SIGMA_GRAIN_RATIO);
const sc = clusterSigma(radiusPx, clumping);
const taps = (s) => 2 * Math.max(1, Math.ceil(3 * s)) + 1;

console.log('=== L2 层：真实参数下的成本 ===');
console.log('  默认 μr=' + radiusPx + ' px　团簇度 c=' + clumping);
console.log('  细颗粒核 σ_g=' + sg.toFixed(2) + ' px → ' + taps(sg) + ' 抽头');
console.log('  团簇核   σ_c=' + sc.toFixed(2) + ' px → ' + taps(sc) + ' 抽头  ← 抽头数 ∝ σ，这是成本主因');
console.log('  UXP/Node 换算系数 ' + UXPRatio.toFixed(3) + '（由同一段代码的实测对推出）\n');

const fine = bench('细颗粒场（可分离高斯，' + taps(sg) + ' 抽头）', () =>
  filteredNoise({ width: N, height: H, seed: 1, stream: 0, sigma: sg }), PX);

const envFull = bench('团簇场·全分辨率（' + taps(sc) + ' 抽头）', () =>
  filteredNoise({ width: N, height: H, seed: 1, stream: 7, sigma: sc }), PX);

const envHalf = bench('团簇场·1/2 分辨率（σ 减半 → 抽头减半）', () =>
  filteredNoise({ width: N >> 1, height: H >> 1, seed: 1, stream: 7, sigma: sc / 2 }), PX / 4);

const envQuarter = bench('团簇场·1/4 分辨率', () =>
  filteredNoise({ width: N >> 2, height: H >> 2, seed: 1, stream: 7, sigma: sc / 4 }), PX / 16);

const field = bench('generateGrainField 完整（细颗粒 × 团簇调制）', () =>
  generateGrainField({ width: N, height: H, seed: 1, radiusPx, clumping }), PX);

console.log('\n=== L3 层：合成（线性化 + LUT + 写回）===');
const rgb = new Float32Array(PX * 3);
{
  const flat = makeFlat(N, H, 0.45);
  for (let i = 0; i < PX; i++) { rgb[i * 3] = flat[i]; rgb[i * 3 + 1] = flat[i]; rgb[i * 3 + 2] = flat[i]; }
}
const synth = bench('applyGrain 全通道合成', () =>
  applyGrain(rgb.slice(), N, H, { seed: 1, radiusPx, clumping, strength: 0.03 }), PX);

console.log('\n=== 24 MP 全分辨率单帧预算（UXP 推算）===');
const rows = [
  ['L1 物理预计算（一张 LUT + 核）', 1],
  ['L2 细颗粒场', fine.per24Uxp],
  ['L2 团簇场（全分辨率）', envFull.per24Uxp],
  ['L2 团簇场（1/2 分辨率）', envHalf.per24Uxp],
  ['L2 团簇场（1/4 分辨率）', envQuarter.per24Uxp],
  ['L3 合成', synth.per24Uxp]
];
for (const [k, v] of rows) console.log('  ' + k.padEnd(30) + v.toFixed(0).padStart(7) + ' ms');

const sumFull = fine.per24Uxp + envFull.per24Uxp + synth.per24Uxp + 1;
const sumHalf = fine.per24Uxp + envHalf.per24Uxp + synth.per24Uxp + 1;
const sumQuarter = fine.per24Uxp + envQuarter.per24Uxp + synth.per24Uxp + 1;
console.log('  ' + '─'.repeat(37));
console.log('  计算侧合计（团簇场全分辨率）    ' + sumFull.toFixed(0).padStart(7) + ' ms');
console.log('  计算侧合计（团簇场 1/2 分辨率） ' + sumHalf.toFixed(0).padStart(7) + ' ms');
console.log('  计算侧合计（团簇场 1/4 分辨率） ' + sumQuarter.toFixed(0).padStart(7) + ' ms');
console.log('\n  注意：以上不含 I/O。全图 I/O 往返由 UXP 探针单独给出，两者相加才是提交耗时。');
console.log('  预览若走 1/2 分辨率，上述计算侧成本 ÷4。');
