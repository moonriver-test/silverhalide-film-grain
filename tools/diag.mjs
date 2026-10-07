/** 定位用：验证 FFT 与频谱计算本身是否正确 */
import { unitNoise, filteredNoise, gaussianKernel1D, normalizeL2 } from '../core/grain.mjs';
import { fft1d, powerSpectrum2D, radialSpectrum } from './fft.mjs';

const N = 256;

// --- A. FFT 自检：单个余弦波应只在对应频率出现 ---
{
  const k = 8; // cycles over N samples -> f = 8/256 = 0.03125
  const re = new Float64Array(N).fill(0);
  for (let i = 0; i < N; i++) re[i] = Math.cos(2 * Math.PI * k * i / N);
  const im = new Float64Array(N);
  fft1d(re, im);
  let best = 0, bestV = 0;
  for (let i = 0; i < N; i++) {
    const p = re[i] * re[i] + im[i] * im[i];
    if (p > bestV) { bestV = p; best = i; }
  }
  console.log(`A. FFT 自检: 注入 k=${k} (f=${(k / N).toFixed(5)}) → 峰值出现在 k=${best} (f=${(best / N).toFixed(5)})  ${best === k ? 'OK' : '❌ 错误'}`);
}

// --- B. 原始白噪声的径向谱（应平坦）---
{
  const raw = new Float64Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) raw[y * N + x] = unitNoise(1, 0, x, y);
  let m = 0; for (const v of raw) m += v; m /= raw.length;
  let s2 = 0; for (const v of raw) s2 += (v - m) * (v - m);
  console.log(`B. 原始噪声 均值=${m.toExponential(2)}  方差=${(s2 / raw.length).toFixed(4)}`);
  const rad = radialSpectrum(powerSpectrum2D(raw, N), N, 20);
  showBins('   白噪声径向谱', rad);
}

// --- C. 高斯滤波后的径向谱（应与理论 exp(-8π²σ²f²) 吻合）---
for (const sigma of [1.0, 2.0, 4.0]) {
  const f = filteredNoise({ width: N, height: N, seed: 1, stream: 0, sigma });
  let m = 0; for (const v of f) m += v; m /= f.length;
  let s2 = 0; for (const v of f) s2 += (v - m) * (v - m);
  const rad = radialSpectrum(powerSpectrum2D(f, N), N, 20);
  const f3 = Math.sqrt(Math.log(2) / (8 * Math.PI * Math.PI * sigma * sigma));
  console.log(`C. sigma=${sigma}  实测方差=${(s2 / f.length).toFixed(4)}  理论 -3dB 频率=${f3.toFixed(4)}`);
  showBins('   径向谱', rad, f => Math.exp(-8 * Math.PI * Math.PI * sigma * sigma * f * f));
}

// --- D. 核的频响（一维解析）---
{
  const { k } = gaussianKernel1D(1.0);
  const nk = normalizeL2(k);
  let dcGain = 0; for (const v of nk) dcGain += v;
  console.log(`D. sigma=1 的 7 抽头核：L2范数=${Math.hypot(...nk).toFixed(6)}  DC增益=${dcGain.toFixed(4)}`);
  console.log('   1D |FT|² 在 f=0.0937（2D PSD 的 -3dB 点）处的值应为 0.707：');
  const re = new Float64Array(64), im = new Float64Array(64);
  for (let i = 0; i < 64; i++) re[i] = i < nk.length ? nk[i] : 0;
  fft1d(re, im);
  for (const kk of [0, 1, 6, 12]) {
    const p = re[kk] * re[kk] + im[kk] * im[kk];
    const p0 = re[0] * re[0] + im[0] * im[0];
    console.log(`     f=${(kk / 64).toFixed(4)}  |FT|²/|FT(0)|² = ${(p / p0).toFixed(4)}`);
  }
}

function showBins(label, rad, theory) {
  const max = Math.max(...rad.map(r => r.p));
  console.log(label + '（p 已按最大值归一化，括号内为理论值）');
  for (let i = 0; i < Math.min(12, rad.length); i++) {
    const r = rad[i];
    const t = theory ? `  [理论 ${(theory(r.f) / theory(rad[0].f) * (rad[0].p / max)).toFixed(3)}]` : '';
    console.log(`     f=${r.f.toFixed(4)}  p=${(r.p / max).toFixed(4)}${t}`);
  }
}
