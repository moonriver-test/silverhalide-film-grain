/* L2/L3 成本分解：找出真正的大头
 *
 * bench-l2 的结果反常：
 *   细颗粒场（7 抽头）31.27 ns/px，而同样是 7 抽头的合成基准只有 9.53 ns/px
 *   applyGrain 898 ns/px，是探针实测「简单主循环 2 ns/px」的 450 倍
 * 说明大头不在卷积。逐项拆开量。
 *
 * 运行：node tools/bench-decomp.mjs
 */

import {
  unitNoise, gaussianKernel1D, filteredNoise, generateGrainField,
  applyGrain, makeFlat, clusterSigma, SIGMA_GRAIN_RATIO
} from '../core/grain.mjs';

const N = 1024, H = 1024, PX = N * H;
const UXP = 34.33 / 22.08;

function bench(label, fn, px = PX, reps = 5, note = '') {
  fn();
  let best = Infinity;
  for (let i = 0; i < reps; i++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  const nsPx = (best * 1e6) / px;
  console.log(
    '  ' + label.padEnd(40) +
    best.toFixed(2).padStart(8) + ' ms' +
    nsPx.toFixed(2).padStart(10) + ' ns/px' +
    ('　UXP 24MP ' + (best * 24 / (px / 1e6) * UXP).toFixed(0) + ' ms').padStart(22) +
    (note ? '  ' + note : '')
  );
  return nsPx;
}

console.log('=== 1. 哈希噪声生成（坐标寻址 PRNG）===');
const a0 = bench('unitNoise 逐点生成 1 MP', () => {
  const out = new Float32Array(PX);
  for (let y = 0; y < H; y++) {
    const o = y * H;
    for (let x = 0; x < N; x++) out[o + x] = unitNoise(1, 0, x, y);
  }
  return out;
});

console.log('\n=== 2. 分配与填充 ===');
bench('new Float32Array(1 MP)', () => new Float32Array(PX));
const srcPre = new Float32Array(PX);
for (let i = 0; i < PX; i++) srcPre[i] = ((i * 2654435761) % 1000) / 1000 - 0.5;

console.log('\n=== 3. 纯卷积（噪声预先算好，不计入计时）===');
function conv(src, N, H, sigma) {
  const { k, R } = gaussianKernel1D(sigma);
  const KT = k.length;
  let s2 = 0; for (let i = 0; i < KT; i++) s2 += k[i] * k[i];
  s2 = Math.sqrt(s2) || 1;
  const nk = new Float32Array(KT);
  for (let i = 0; i < KT; i++) nk[i] = k[i] / s2;
  const W = N + 2 * R, Hp = H + 2 * R;
  const raw = new Float32Array(W * Hp);
  for (let y = 0; y < Hp; y++) {
    const off = y * W, sy = Math.min(H - 1, Math.max(0, y - R));
    for (let x = 0; x < W; x++) raw[off + x] = src[sy * N + Math.min(N - 1, Math.max(0, x - R))];
  }
  const row = new Float32Array(W * Hp);
  for (let y = 0; y < Hp; y++) {
    const off = y * W;
    for (let x = 0; x < R; x++) {
      let a = 0;
      for (let i = 0; i < KT; i++) { let xx = x + i - R; if (xx < 0) xx = 0; a += nk[i] * raw[off + xx]; }
      row[off + x] = a;
    }
    for (let x = R; x < W - R; x++) {
      let a = 0; const b = off + x - R;
      for (let i = 0; i < KT; i++) a += nk[i] * raw[b + i];
      row[off + x] = a;
    }
    for (let x = W - R; x < W; x++) {
      let a = 0;
      for (let i = 0; i < KT; i++) { let xx = x + i - R; if (xx >= W) xx = W - 1; a += nk[i] * raw[off + xx]; }
      row[off + x] = a;
    }
  }
  const out = new Float32Array(N * H);
  for (let y = 0; y < H; y++) {
    const dst = y * N;
    for (let x = 0; x < N; x++) {
      let a = 0, idx = y * W + x + R;
      for (let i = 0; i < KT; i++) { a += nk[i] * row[idx]; idx += W; }
      out[dst + x] = a;
    }
  }
  return out;
}
const c7 = bench('卷积 7 抽头（σ=1）', () => conv(srcPre, N, H, 1));
const c43 = bench('卷积 43 抽头（σ=6.8，团簇场）', () => conv(srcPre, N, H, 6.8));
const c75 = bench('卷积 75 抽头（σ=12.2，色度团簇场）', () => conv(srcPre, N, H, 12.24));

console.log('\n=== 4. filteredNoise 总计 vs 分项之和 ===');
console.log('  分项推算：哈希 ' + a0.toFixed(1) + ' + 卷积 ' + c7.toFixed(1) + ' = ' + (a0 + c7).toFixed(1) + ' ns/px');
bench('filteredNoise σ=1（7 抽头）', () => filteredNoise({ width: N, height: H, seed: 1, stream: 0, sigma: 1 }));

console.log('\n=== 5. 通道数量对 applyGrain 的影响 ===');
const flat = makeFlat(N, H, 0.45);
const rgb0 = new Float32Array(PX * 3);
for (let i = 0; i < PX; i++) { rgb0[i * 3] = flat[i]; rgb0[i * 3 + 1] = flat[i]; rgb0[i * 3 + 2] = flat[i]; }
bench('applyGrain mono（只 1 路亮度场）', () =>
  applyGrain(rgb0.slice(), N, H, { seed: 1, radiusPx: 2, clumping: 0.35, strength: 0.03, mono: true }));
bench('applyGrain 默认（亮度 + 3 路色度 = 4 个场）', () =>
  applyGrain(rgb0.slice(), N, H, { seed: 1, radiusPx: 2, clumping: 0.35, strength: 0.03 }));

console.log('\n=== 6. 单个场的成本构成（默认 μr=2、c=0.35）===');
const sg = Math.max(0.35, 2 * SIGMA_GRAIN_RATIO);
const sc = clusterSigma(2, 0.35);
const scChroma = clusterSigma(2 * 1.8, 0.35);
const taps = (s) => 2 * Math.max(1, Math.ceil(3 * s)) + 1;
console.log('  亮度场：σ_g=' + sg.toFixed(2) + '(' + taps(sg) + ' 抽头) + σ_c=' + sc.toFixed(2) + '(' + taps(sc) + ' 抽头)');
console.log('  色度场：σ_g=' + (sg * 1.8).toFixed(2) + '(' + taps(sg * 1.8) + ' 抽头) + σ_c=' + scChroma.toFixed(2) + '(' + taps(scChroma) + ' 抽头)  × 3 个通道');
bench('generateGrainField 亮度口径', () => generateGrainField({ width: N, height: H, seed: 1, radiusPx: 2, clumping: 0.35 }));
bench('generateGrainField 色度口径', () => generateGrainField({ width: N, height: H, seed: 2, radiusPx: 3.6, clumping: 0.35 }));

console.log('\n=== 结论 ===');
console.log('  哈希生成 ' + a0.toFixed(1) + ' ns/px 是固定成本，每个场都要付一次。');
console.log('  卷积成本随抽头数近似线性：7→' + c7.toFixed(1) + '　43→' + c43.toFixed(1) + '　75→' + c75.toFixed(1));
console.log('  4 个场叠加 ⇒ 团簇场的大核被付了 4 次，这是最大的一笔。');
