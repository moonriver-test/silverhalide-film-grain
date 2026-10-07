/**
 * 诊断工具：基-2 FFT 与径向功率谱
 * 仅用于 Node 侧测试，不进入插件运行时。
 */

/** 原地复数 FFT（基-2，长度须为 2 的幂） */
export function fft1d(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const p = i + k, q = p + half;
        const vr = re[q] * cr - im[q] * ci;
        const vi = re[q] * ci + im[q] * cr;
        re[q] = re[p] - vr; im[q] = im[p] - vi;
        re[p] += vr; im[p] += vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * 二维功率谱。先做 Hann 窗 + 去均值（抑制泄漏），再行/列 FFT。
 * 返回未移位的功率谱，索引 (uy*N + ux)。
 */
export function powerSpectrum2D(src, N) {
  const re = new Float64Array(N * N);
  const im = new Float64Array(N * N);

  let mean = 0;
  for (let i = 0; i < N * N; i++) mean += src[i];
  mean /= N * N;

  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      re[y * N + x] = (src[y * N + x] - mean) * win[x] * win[y];
    }
  }

  const rr = new Float64Array(N), ii = new Float64Array(N);
  for (let y = 0; y < N; y++) {
    rr.set(re.subarray(y * N, y * N + N));
    ii.fill(0);
    fft1d(rr, ii);
    re.set(rr, y * N);
    im.set(ii, y * N);
  }
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) { rr[y] = re[y * N + x]; ii[y] = im[y * N + x]; }
    fft1d(rr, ii);
    for (let y = 0; y < N; y++) { re[y * N + x] = rr[y]; im[y * N + x] = ii[y]; }
  }

  const P = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) P[i] = re[i] * re[i] + im[i] * im[i];
  return P;
}

/** 把二维功率谱按半径平均，返回 [{ f, p }]，f 单位 cycles/pixel */
export function radialSpectrum(P, N, bins = 40) {
  const FMAX = 0.5;
  const sum = new Float64Array(bins);
  const cnt = new Float64Array(bins);

  for (let uy = 0; uy < N; uy++) {
    const fy = (uy <= N / 2 ? uy : uy - N) / N;
    for (let ux = 0; ux < N; ux++) {
      const fx = (ux <= N / 2 ? ux : ux - N) / N;
      const f = Math.hypot(fx, fy);
      if (f >= FMAX) continue;
      let b = Math.floor((f / FMAX) * bins);
      if (b >= bins) b = bins - 1;
      sum[b] += P[uy * N + ux];
      cnt[b]++;
    }
  }

  const out = [];
  for (let b = 0; b < bins; b++) {
    if (cnt[b] > 0) out.push({ f: ((b + 0.5) / bins) * FMAX, p: sum[b] / cnt[b] });
  }
  return out;
}

/**
 * 径向谱平滑。必要性见实测：40 个径向 bin、256×256 的场，
 * 低频 bin 的独立自由度只有 ~10，单个 bin 的相对波动可达 ±45%。
 * 不平滑就会出现「阈值取在噪声尖峰上 → 截止频率偏低一个数量级」这种假结果。
 */
export function smoothRadial(radial, win = 3) {
  const half = win >> 1;
  return radial.map((r, i) => {
    let s = 0, n = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j >= 0 && j < radial.length) { s += radial[j].p; n++; }
    }
    return { f: r.f, p: s / n };
  });
}

/** 是否低通（DC 处最强）。低通 = 颗粒频谱的正确形态；带通是研究报告里的一个错误说法。 */
export function isLowPass(smoothed) {
  const first = smoothed[0].p;
  return smoothed.every((r) => r.p <= first * 1.02);
}

/**
 * 功率降到峰值以下 dropDb 处的截止频率。
 * 注意：这里的「峰值」是低频平台的平台值，不是全局最大值所在的那个 bin。
 */
export function robustCutoff(smoothed, dropDb = 3) {
  const plateau = Math.max(...smoothed.map((r) => r.p));
  const thr = plateau * Math.pow(10, -dropDb / 10);
  for (const r of smoothed) if (r.p < thr) return r.f;
  return smoothed[smoothed.length - 1].f;
}

/** 低频平台的平坦度：取 f < frac·Nyquist 的频段，返回相对平均绝对偏差 */
export function plateauFlatness(smoothed, frac = 0.25) {
  const seg = smoothed.filter((r) => r.f < frac * 0.5);
  if (seg.length < 2) return 1;
  const mean = seg.reduce((a, r) => a + r.p, 0) / seg.length;
  const dev = seg.reduce((a, r) => a + Math.abs(r.p - mean), 0) / seg.length;
  return dev / mean;
}

/**
 * 与理论形状的偏差（RMS 相对偏差）。
 * 理论：高斯滤波白噪声的径向功率谱 ∝ exp(−4π²σ_g²f²)。
 * 注意指数里是 4π² 而不是 8π² —— 2D 可分离核的功率是两个一维谱的乘积，
 * 但两者共用同一个径向 f，所以指数不翻倍。写成 8π² 会把理论截止频率
 * 算小 √2 倍，从而得出「实测偏高」的假结论（首轮踩过这个坑）。
 */
export function shapeDeviation(smoothed, sigmaGrain, theoryFloor = 0.15) {
  const k = 4 * Math.PI * Math.PI * sigmaGrain * sigmaGrain;
  const bins = smoothed.filter((r) => Math.exp(-k * r.f * r.f) > theoryFloor);
  if (bins.length < 3) return 1;
  const f0 = bins[0].f;
  const norm = smoothed[0].p / Math.exp(-k * f0 * f0);
  let acc = 0;
  for (const r of bins) {
    const m = r.p / norm;
    const t = Math.exp(-k * r.f * r.f);
    acc += ((m - t) / t) ** 2;
  }
  return Math.sqrt(acc / bins.length);
}

/** FFT 自检：实余弦的频谱必须关于 N/2 共轭对称 */
export function fftSelfTest(N = 256, k = 8) {
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = Math.cos((2 * Math.PI * k * i) / N);
  fft1d(re, im);
  const p = (i) => re[i] * re[i] + im[i] * im[i];
  return { atK: p(k), atSym: p(N - k), expected: (N / 2) * (N / 2) };
}
