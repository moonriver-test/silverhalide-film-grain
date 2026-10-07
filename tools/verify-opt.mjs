/* 验证展开优化：结果必须与朴素实现逐位一致，并复测速度
 *
 * 运行：node tools/verify-opt.mjs
 */

import { unitNoise, gaussianKernel1D, filteredNoise } from '../core/grain.mjs';

const UXPRatio = 34.33 / 22.08;

/* 朴素参考：逐抽头钳位，Float32，与优化前的实现同构 */
function naive({ width, height, seed, stream, sigma }) {
  const { k, R } = gaussianKernel1D(sigma);
  const KT = k.length;
  let s2 = 0; for (let i = 0; i < KT; i++) s2 += k[i] * k[i];
  s2 = Math.sqrt(s2) || 1;
  const nk = new Float32Array(KT);
  for (let i = 0; i < KT; i++) nk[i] = k[i] / s2;

  const W = width + 2 * R, H = height + 2 * R;
  const raw = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const off = y * W;
    for (let x = 0; x < W; x++) raw[off + x] = unitNoise(seed, stream, x - R, y - R);
  }

  const row = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const off = y * W;
    for (let x = 0; x < W; x++) {
      let a = 0;
      for (let i = 0; i < KT; i++) {
        let xx = x + i - R; if (xx < 0) xx = 0; else if (xx >= W) xx = W - 1;
        a += nk[i] * raw[off + xx];
      }
      row[off + x] = a;
    }
  }

  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const dst = y * width;
    for (let x = 0; x < width; x++) {
      let a = 0, idx = y * W + x + R;
      for (let i = 0; i < KT; i++) { a += nk[i] * row[idx]; idx += W; }
      out[dst + x] = a;
    }
  }
  return out;
}

function maxDiff(a, b) {
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > m) m = d; }
  return m;
}

function time(fn, reps = 7) {
  fn();
  let best = Infinity;
  for (let i = 0; i < reps; i++) { const t = performance.now(); fn(); best = Math.min(best, performance.now() - t); }
  return best;
}

const N = 512, H = 512, PX = N * H;
const taps = (s) => 2 * Math.max(1, Math.ceil(3 * s)) + 1;

console.log('=== 1. 正确性：展开实现 vs 朴素实现 ===');
for (const sigma of [0.35, 1.0, 1.8, 6.8]) {
  const a = naive({ width: N, height: H, seed: 3, stream: 0, sigma });
  const b = filteredNoise({ width: N, height: H, seed: 3, stream: 0, sigma });
  const d = maxDiff(a, b);
  const ok = d === 0;
  console.log('  σ=' + String(sigma).padEnd(5) + ' 抽头=' + String(taps(sigma)).padEnd(4)
    + ' 最大逐点差异 = ' + d.toExponential(2) + '  ' + (ok ? '✓ 逐位一致' : '✗ 不一致'));
}

console.log('\n=== 2. 速度对比（1024²，Node 22）===');
const M = 1024;
for (const sigma of [0.35, 1.0, 1.8]) {
  const tN = time(() => naive({ width: M, height: M, seed: 1, stream: 0, sigma }), 5);
  const tO = time(() => filteredNoise({ width: M, height: M, seed: 1, stream: 0, sigma }), 5);
  const px = M * M;
  console.log('  σ=' + String(sigma).padEnd(5) + '抽头=' + String(taps(sigma)).padEnd(4)
    + ' 朴素 ' + (tN * 1e6 / px).toFixed(2).padStart(6) + ' ns/px'
    + '　→ 展开 ' + (tO * 1e6 / px).toFixed(2).padStart(6) + ' ns/px'
    + '　提速 ' + (tN / tO).toFixed(2) + '×'
    + '　UXP 24MP ' + (tO * 24 / (px / 1e6) * UXPRatio).toFixed(0).padStart(4) + ' ms');
}

console.log('\n=== 3. 团簇场（大核，落回通用路径）===');
for (const sigma of [6.8, 12.24]) {
  const tO = time(() => filteredNoise({ width: M, height: M, seed: 1, stream: 7, sigma }), 3);
  const px = M * M;
  console.log('  σ=' + String(sigma).padEnd(6) + '抽头=' + String(taps(sigma)).padEnd(4)
    + (tO * 1e6 / px).toFixed(2).padStart(6) + ' ns/px'
    + '　UXP 24MP ' + (tO * 24 / (px / 1e6) * UXPRatio).toFixed(0).padStart(4) + ' ms'
    + '　← 展开无能为力，只能降分辨率');
}
