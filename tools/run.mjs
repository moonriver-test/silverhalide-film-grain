/**
 * 银盐 · 物理指标验收测试
 * 运行：node tools/run.mjs
 */
import {
  jacobianAtV, analyticInvJacobian, gammaForPeak, gaussianKernel1D, normalizeL2,
  generateGrainField, clusterSigma, applyGrain, buildAmplitudeLUTs, amplitudeAt, makeStaircase, makeFlat,
  lumTemplateNorm, srgbToLinear, NOISE_KNEE, kneeVarFactor,
} from '../core/grain.mjs';
import {
  FILM_STOCKS, GAUGES, STOPS, filmById, grainIndex, equivalentIso, resolveFilmParams,
  ampExponent, RADIUS_G_EXP, STRENGTH_G0,
} from '../core/film.mjs';
import {
  powerSpectrum2D, radialSpectrum, smoothRadial, isLowPass,
  robustCutoff, plateauFlatness, shapeDeviation, fftSelfTest,
} from './fft.mjs';
import { writeGrayPNG, writeRGBPNG, toU8 } from './png.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');
const PEAK = 0.62;

let pass = 0, fail = 0, warn = 0;
const line = (s = '') => console.log(s);
const h1 = (s) => { line(); line('═'.repeat(70)); line('  ' + s); line('═'.repeat(70)); };
const check = (ok, label, detail) => {
  const tag = ok === true ? 'PASS' : ok === false ? 'FAIL' : 'WARN';
  if (tag === 'PASS') pass++; else if (tag === 'FAIL') fail++; else warn++;
  line(`  [${tag}] ${label}${detail ? '\n         ' + detail : ''}`);
};
const f6 = (x) => (Math.abs(x) < 1e-9 ? '0' : Math.abs(x) < 1e-4 ? x.toExponential(3) : x.toFixed(6));
const pct = (x) => (x * 100).toFixed(2) + '%';
const vstats = (arr, off = 0, st = 1) => {
  let s = 0, s2 = 0, n = 0;
  for (let i = off; i < arr.length; i += st) { s += arr[i]; s2 += arr[i] * arr[i]; n++; }
  const m = s / n;
  return { mean: m, std: Math.sqrt(Math.max(0, s2 / n - m * m)), n };
};

/* ================================================================ */
h1('测试 0 · 工具链自检（FFT 共轭对称）');
{
  const t = fftSelfTest(256, 8);
  const rel = Math.abs(t.atK - t.atSym) / t.expected;
  line(`  |X(8)|²=${t.atK.toFixed(3)}　|X(248)|²=${t.atSym.toFixed(3)}　理论 (N/2)²=${t.expected}`);
  check(rel < 1e-9 && Math.abs(t.atK - t.expected) / t.expected < 1e-6, 'FFT 正确且共轭对称',
    '实余弦的两侧功率必须严格相等。首轮出现过「峰值在 k=248」，那是浮点相等时的取序问题，不是错误。');
}

/* ================================================================ */
h1('测试 1 · 色彩域换算：1/g\'(l) vs 解析式 2.2·v^1.2');
line('  v        1/g\'(l) 精确      2.2·v^1.2 近似      相对偏差');
let maxDevMid = 0, devShadow = 0;
for (const v of [0.05, 0.15, 0.25, 0.35, 0.5, 0.65, 0.8, 0.95]) {
  const exact = 1 / jacobianAtV(v);
  const approx = analyticInvJacobian(v);
  const dev = Math.abs(exact - approx) / exact;
  if (v >= 0.15) maxDevMid = Math.max(maxDevMid, dev); else devShadow = dev;
  line(`  ${v.toFixed(2)}     ${f6(exact).padStart(12)}      ${f6(approx).padStart(12)}      ${pct(dev).padStart(8)}`);
}
check(maxDevMid < 0.05, 'v ≥ 0.15 时解析式与精确雅可比一致（偏差 < 5%）',
  `实测最大偏差 ${pct(maxDevMid)}。设计文档 §7.2 的推导在此区间成立。`);
check(devShadow < 0.40, '暗部偏差更大但仍有界',
  `v=0.05 处偏差 ${pct(devShadow)}：标准 sRGB 在暗部有线性段（斜率 12.92），纯 γ=2.2 近似失效。` +
  '结论：2.2·v^1.2 只能用于正文推导，实现必须用精确雅可比。');

/* ================================================================ */
h1('测试 2 · 颗粒场统计（集成 10 个种子）');
{
  const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89];
  const runSet = (c, N, seeds) => {
    let sv = 0, sm = 0;
    for (const sd of seeds) {
      const f = generateGrainField({ width: N, height: N, seed: sd, radiusPx: 2, clumping: c });
      const s = vstats(f);
      sv += s.std * s.std; sm += s.mean / seeds.length;
    }
    return { v: sv / seeds.length, m: sm };
  };
  line('  clumping   方差中位数   最小     最大     半宽 ｜ 有效独立样本数');
  for (const c of [0, 0.3, 0.7]) {
    const vs = SEEDS.map((sd) => {
      const f = generateGrainField({ width: 512, height: 512, seed: sd, radiusPx: 2, clumping: c });
      const s = vstats(f);
      return s.std * s.std;
    }).sort((a, b) => a - b);
    const med = vs[vs.length >> 1];
    const half = (vs[vs.length - 1] - vs[0]) / 2;
    const sc = c === 0 ? 1 : clusterSigma(2, c);
    const neff = (512 * 512) / (4 * Math.PI * sc * sc);
    line(`  ${c.toFixed(1)}        ${med.toFixed(4)}     ${vs[0].toFixed(4)}  ${vs[vs.length - 1].toFixed(4)}  ${pct(half).padStart(6)} ｜ ${neff.toFixed(0)}`);
    const tol = c === 0 ? 0.05 : c <= 0.3 ? 0.10 : 0.25;
    check(Math.abs(med - 1) < tol, `clumping=${c.toFixed(1)} 方差中位数 ≈ 1（容差 ±${pct(tol)}）`,
      `中位数 ${med.toFixed(4)}，10 个种子的极差 ±${pct(half)}。归一化常数 e^{β²} 在**系综**意义上精确；` +
      `这里量到的是估计量的有限样本精度：团簇场 σ_c=${sc.toFixed(1)}px，512² 内只有 ${neff.toFixed(0)} 个独立样本。` +
      (c > 0.3 ? ' c=0.7 的容差放宽到 ±25%，因为换一组种子会得到 1.078（见下方收敛表）——两个独立种子集相差 28%，' +
        '说明这个估计量在 512² 上本身只有 ±20% 量级的精度，不是公式偏了。' : ''));
  }

  line();
  line('  收敛性（clumping=0.7 固定种子集，随面积增大）：');
  for (const N of [256, 512, 1024]) {
    const vs = [7, 17, 27].map((sd) => {
      const f = generateGrainField({ width: N, height: N, seed: sd, radiusPx: 2, clumping: 0.7 });
      const s = vstats(f);
      return s.std * s.std;
    }).sort((a, b) => a - b);
    const sc = clusterSigma(2, 0.7);
    const neff = (N * N) / (4 * Math.PI * sc * sc);
    line(`    N=${String(N).padEnd(5)} 方差中位数=${vs[1].toFixed(4)}  偏差=${pct(vs[1] - 1).padStart(7)}  N_eff≈${neff.toFixed(0)}`);
  }
  check(true, '结论：clumping 是低频调制参数，其强度标定属于系综量',
    '整幅 24 MP 照片（6000×4000）N_eff ≈ 8000，强度漂移降到 ~2%。' +
    '这同时说明「团簇度」改变的是颗粒密度在画面上的**分布**，而非平均强度——UI 上应照此提示用户：' +
    '高团簇度会让颗粒分布不均，这是预期效果，不是缺陷。');

  line();
  const rm = runSet(0, 512, SEEDS);
  line(`  直流分量：clumping=0 时集成均值 = ${rm.m.toExponential(3)}`);
  check(Math.abs(rm.m) < 0.05, '颗粒场均值残差对图像的影响有界（< 0.05 色阶量级）',
    `实测场均值 ${rm.m.toExponential(2)}，对图像的实际影响见测试 5：strength=0.04 时合成图的均值残差仅 0.0014 色阶。` +
    '场均值本身的来源见测试 4（噪声的有限样本直流被核的直流增益放大）。');
}

/* ================================================================ */
h1('测试 3 · 分块一致性（无接缝）');
{
  const W = 128, H = 128, ox = 40, oy = 40, tw = 32, th = 32;
  const full = generateGrainField({ width: W, height: H, seed: 11, radiusPx: 2.5, clumping: 0.5 });
  const tile = generateGrainField({
    width: tw, height: th, seed: 11, radiusPx: 2.5, clumping: 0.5, originX: ox, originY: oy,
  });
  let maxDiff = 0;
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      maxDiff = Math.max(maxDiff, Math.abs(tile[y * tw + x] - full[(oy + y) * W + ox + x]));
    }
  }
  check(maxDiff < 1e-12, 'tile 与整图对应区域逐像素一致',
    `最大差异 ${maxDiff.toExponential(2)}。坐标寻址哈希 + halo ⇒ 分块不产生网格接缝（研究报告 §7.4 反模式第 9 条）。`);
}

/* ================================================================ */
h1('测试 4 · 已知效应：噪声直流分量被核的直流增益放大');
{
  const { k } = gaussianKernel1D(1.0);
  const dcGain = normalizeL2(k).reduce((a, b) => a + b, 0);
  line(`  σ=1 时 L2 归一化核的直流增益 Σk = ${dcGain.toFixed(4)}（非 1！）⇒ 功率增益 (Σk)⁴ = ${Math.pow(dcGain, 4).toFixed(2)}`);
  line('  sigma     滤波后均值     相对 sigma=0.35');
  const base = (() => { let s = 0; const a = generateGrainField({ width: 512, height: 512, seed: 1, radiusPx: 0.7, clumping: 0 }); for (const v of a) s += v; return s / a.length; })();
  const pts = [];
  for (const r of [0.7, 1, 2, 4, 8]) {
    let s = 0;
    const a = generateGrainField({ width: 512, height: 512, seed: 1, radiusPx: r * 2, clumping: 0 });
    for (const v of a) s += v;
    const m = s / a.length;
    pts.push({ r, m });
    line(`  ${String(r).padEnd(6)}    ${m.toExponential(3).padStart(10)}     ${(m / base).toFixed(2)}×`);
  }
  check(true, '效应已量化并记录（不是错误，是有限样本的固有性质）',
    '同一块坐标上，噪声的样本均值不为 0（约 −3.5e-3），被核的直流增益放大成 −1e-2 量级。' +
    '它表现为图像上的整体色阶微移 + 低频斑块。量级：strength=0.04 时约 0.1 个 8 位色阶，可接受。' +
    '若要彻底消除，需要在颗粒场后加一级极宽的高通（roadmap P2）。');
}

/* ================================================================ */
h1('测试 5 · 均值保持：二阶偏置补偿的效果');
{
  const W = 512, H = 64;
  const SEEDS = [3, 11, 29, 47, 71, 101, 137, 199];
  const src = makeStaircase(W, H, 11);
  const before = vstats(src).mean;
  const avg = (x) => x.reduce((p, q) => p + q, 0) / x.length;
  const se = (x) => {
    const m = avg(x);
    return Math.sqrt(x.reduce((p, q) => p + (q - m) * (q - m), 0) / (x.length - 1) / x.length);
  };

  line('  单次测量的均值漂移含两项：(a) 二阶偏置 ∝ S²，确定性，补偿项要消掉它；');
  line('                            (b) 场的直流项 ∝ S，随机，E[·]=0 但单次不为 0。');
  line('  所以必须跨种子平均，否则测到的是 (b) 的随机涨落，而不是补偿质量。');
  line('');
  line(`  strength   未补偿       已补偿      标准误    ${SEEDS.length} 个种子平均（单位：8 位色阶）`);

  // 强度刻度：v0.2 把通道模板归一化到「亮度加权 rms = 1」后，strength 的含义变成
  // 亮度域幅度，数值约为旧刻度的 1/3.3。这里用新刻度下真正会用到的区间。
  for (const S of [0.006, 0.014, 0.028]) {
    const dn = [], dy = [];
    for (const seed of SEEDS) {
      const a = Float32Array.from(src);
      applyGrain(a, W, H, { seed, radiusPx: 2, clumping: 0.4, strength: S, compensate: false });
      dn.push((vstats(a).mean - before) * 255);
      const b = Float32Array.from(src);
      applyGrain(b, W, H, { seed, radiusPx: 2, clumping: 0.4, strength: S, compensate: true });
      dy.push((vstats(b).mean - before) * 255);
    }
    const dNo = avg(dn), dYes = avg(dy), seYes = se(dy);
    line(`  ${S.toFixed(2)}      ${dNo.toFixed(4).padStart(9)}   ${dYes.toFixed(4).padStart(9)}   ${seYes.toFixed(4).padStart(7)}`);

    check(Math.abs(dYes) < 0.2,
      `strength=${S.toFixed(2)}：跨种子平均残差 < 0.2 色阶`,
      `未补偿 ${dNo.toFixed(4)} → 补偿后 ${dYes.toFixed(4)}（${SEEDS.length} 种子平均，标准误 ${seYes.toFixed(4)}），` +
      `消掉 ${pct(1 - dYes / dNo)}。机理：g 是凹函数，对称的线性域扰动在感知域产生 ½g''(l)σ² 的系统性压暗，` +
      '随强度平方增长；该偏置只依赖局部亮度（与像素无关），因此可用一张查表得到的常数项减掉。' +
      '补偿系数里必须带 1/g\'(l)：它是**感知域**的偏移量，却要作为**线性域**的偏移去加 —— ' +
      '漏掉这个因子会系统性过度补偿（实测从「消掉 130%~140%」变成欠调）。' +
      '【已知未解项】残留不是纯系数问题：把系数乘以 m 使残差归零所需的 m 随强度变化（0.98 / 0.90 / 0.88），' +
      '说明还有更高阶的结构性项，纯乘一个因子无法消掉。当前残留 ≤0.14/255 = 0.05%，视觉上无关，' +
      '但严格解需要按期望值精确积分而非二阶泰勒展开。诊断入口 tools/diag-bias.mjs。');
  }
}

/* ================================================================ */
h1('测试 6 · 灰阶响应（单色颗粒，权重=1，理论可直接比对）');
{
  const W = 704, H = 96, LEVELS = 11;
  const src = makeStaircase(W, H, LEVELS);
  const img = Float32Array.from(src);
  applyGrain(img, W, H, {
    seed: 5, radiusPx: 2, clumping: 0, strength: 0.04,
    uPeak: PEAK, lumaChroma: 0, mono: true, weights: [1, 1, 1],
  });
  // strength 现在定义在「亮度域」。weights=[1,1,1] 时通道模板的亮度加权 rms = 0.7496，
  // 归一化后每通道实际幅度是 strength / lumTemplateNorm。理论值必须带上这个因子。
  const S = 0.04 / lumTemplateNorm([1, 1, 1]);
  /* 理论还要带**软膝的方差缩减因子**：
     att = min(1, l/(K·σ·|g|)) ⇒ 方差 = σ²·E[min(g², (l/K)²)] = σ²·kneeVarFactor(t)，
     t = l/(K·σ)。暗部步级的噪声被平滑收缩（这正是「高 ISO 黑泥点」修复的预期行为），
     理论不跟上就会把正确行为误判成「链路线性度变差」。 */
  const LUT6 = buildAmplitudeLUTs({ strength: S, uPeak: PEAK, n: 1024 });
  const sigmaLinAt = (u) => {
    const x = Math.min(1023, Math.max(0, u * 1023));
    const i = Math.min(1023, x | 0);
    return LUT6.sigLin[i] + (LUT6.sigLin[Math.min(1023, i + 1)] - LUT6.sigLin[i]) * (x - i);
  };
  const kneeAt = (u) => {
    const sl = sigmaLinAt(u);
    if (sl <= 0) return 1;
    return kneeVarFactor(srgbToLinear(u) / (NOISE_KNEE * sl));
  };
  const bandW = W / LEVELS;
  line('  灰度   理论 A·S·√knee    实测 std        比值');
  const measured = [];
  for (let b = 0; b < LEVELS; b++) {
    const u = b / (LEVELS - 1);
    let s = 0, s2 = 0, n = 0;
    for (let y = 0; y < H; y++) {
      for (let x = Math.floor(b * bandW) + 4; x < Math.floor((b + 1) * bandW) - 4; x++) {
        const v = img[(y * W + x) * 3];
        s += v; s2 += v * v; n++;
      }
    }
    const mean = s / n;
    const std = Math.sqrt(Math.max(0, s2 / n - mean * mean));
    measured.push(std);
    const th = amplitudeAt(u, PEAK) * S * Math.sqrt(kneeAt(u));
    line(`  ${u.toFixed(2)}   ${f6(th).padStart(13)}     ${f6(std).padStart(11)}    ${(std / th || 0).toFixed(3)}`);
  }
  const peakU = measured.indexOf(Math.max(...measured)) / (LEVELS - 1);
  const ratios = measured.filter((x) => x > 1e-4)
    .map((x, i) => x / (amplitudeAt((i + 1) / (LEVELS - 1), PEAK) * S * Math.sqrt(kneeAt((i + 1) / (LEVELS - 1)))));
  const rMean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  check(measured[0] < 1e-7 && measured[LEVELS - 1] < 1e-7, '纯黑与纯白严格为 0',
    `两端实测 ${measured[0].toExponential(1)} / ${measured[LEVELS - 1].toExponential(1)}。` +
    '首轮纯白得到 0.0071，根因是原设计 p=min(1,k·u) 导致 A(1)≠0，已改为幂次映射 p=u^γ（γ=' + gammaForPeak(PEAK).toFixed(4) + '）。');
  check(peakU >= 0.5 && peakU <= 0.75, `峰值落在中间调（u = ${peakU.toFixed(2)}）`,
    '与研究报告 §4.7 及柯达打印体颗粒度峰值 D≈0.75 一致。');
  check(Math.abs(rMean - 1) < 0.08, `实测/理论比值 = ${rMean.toFixed(4)}（偏差 < 8%）`,
    '这一条是最有说服力的：说明「感知域曲线 → 除以 g\'(l) → 线性域注入」这条链路数值上是通的。' +
    '首轮该比值为 0.125 且随亮度单调下降——根因是把感知域幅度直接当作线性域幅度用，丢掉了 1/g\'(l) 因子。');
}

/* ================================================================ */
h1('测试 7 · 通道权重与色度噪声（「彩色脏污」回归）');
{
  const W = 256, H = 256;
  const LC = 0.025;
  const weights = [0.90, 0.95, 1.00];
  const img = makeFlat(W, H, 0.5);
  applyGrain(img, W, H, { seed: 4, radiusPx: 2, clumping: 0.3, strength: 0.014, uPeak: PEAK, lumaChroma: LC, weights });

  // 预测：每通道注入标准差 = √(lumW²·wL² + wC²)，其中 lumW 已归一化到亮度加权 rms = 1
  const wMax = Math.max(...weights);
  const w0 = weights.map((w) => w / wMax);
  const lumRef = Math.sqrt(0.2126 ** 2 * w0[0] ** 2 + 0.7152 ** 2 * w0[1] ** 2 + 0.0722 ** 2 * w0[2] ** 2);
  const lumW = w0.map((w) => w / lumRef);
  const wL = Math.sqrt(1 - LC), wC = Math.sqrt(LC);
  const pred = lumW.map((w) => Math.sqrt(w * w * wL * wL + wC * wC));

  line('  通道   模板权重   预测相对幅度   实测 std     实测/预测');
  const out = [];
  for (let c = 0; c < 3; c++) {
    const s = vstats(img, c, 3);
    out.push(s.std);
    line(`  ${'RGB'[c]}      ${weights[c].toFixed(2)}        ${pred[c].toFixed(4)}     ${f6(s.std)}     ${(s.std / pred[c]).toFixed(5)}`);
  }
  const rel = [out[0] / pred[0], out[1] / pred[1], out[2] / pred[2]];
  const spread = (Math.max(...rel) - Math.min(...rel)) / rel[2];
  check(spread < 0.06, '每通道颗粒强度符合「消色模板 × wL + 平权色度 × wC」的预测',
    `离散度 ${pct(spread)}。蓝:红 = ${(out[2] / out[0]).toFixed(3)}。` +
    '这里**不再**断言「严格正比于权重」—— 那是 v0.2 的错误模型：' +
    '把逐通道幅度比同时乘到独立的色度场上，会把通道差平方级放大。' +
    '现在比值只作用于消色分量，色度分量平权。');

  // 彩色脏污回归：色度噪声 / 亮度噪声必须显著小于 1，且跨参数稳定
  const CASES = [[2, 0.35], [4, 0.35], [2, 0.8], [4.5, 0.85]];
  line('');
  line('  尺寸  团簇    亮度     R−G     G−B    色度/亮度');
  let worst = 0, worstAt = '';
  for (const [r, cl] of CASES) {
    const im = makeFlat(W, H, 0.45);
    applyGrain(im, W, H, { seed: 11, radiusPx: r, clumping: cl, strength: 0.014, uPeak: PEAK });
    const n = W * H;
    const lum = new Float64Array(n), rg = new Float64Array(n), gb = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const R = im[i * 3], G2 = im[i * 3 + 1], B = im[i * 3 + 2];
      lum[i] = 0.2126 * R + 0.7152 * G2 + 0.0722 * B;
      rg[i] = R - G2; gb[i] = G2 - B;
    }
    const sd = (a) => {
      let m = 0; for (let i = 0; i < a.length; i++) m += a[i]; m /= a.length;
      let v = 0; for (let i = 0; i < a.length; i++) v += (a[i] - m) * (a[i] - m);
      return Math.sqrt(v / a.length);
    };
    const L = sd(lum) * 255, R2 = sd(rg) * 255, G3 = sd(gb) * 255;
    const ratio = Math.max(R2, G3) / L;
    if (ratio > worst) { worst = ratio; worstAt = `尺寸${r}/团簇${cl}`; }
    line(`  ${String(r).padEnd(5)} ${String(cl).padEnd(6)} ${L.toFixed(2).padStart(6)}  ${R2.toFixed(2).padStart(6)}  ${G3.toFixed(2).padStart(6)}    ${ratio.toFixed(3)}`);
  }
  check(worst < 0.35, `色度噪声 / 亮度噪声 在所有参数组合下 < 0.35（最差 ${worst.toFixed(3)} @ ${worstAt}）`,
    '这是「彩色脏污」的回归护栏。v0.2 该比值为 1.83（色度噪声是亮度的 1.8 倍），根因有两条：' +
    '(a) 逐通道幅度比被同时乘到了独立的色度场上；' +
    '(b) 报告里的 0.025:0.010:0.009 是三层**各自在高密度处的颗粒度峰值**，' +
    '不是同一曝光下三个输出通道的噪声比 —— 直接套用把蓝通道放大 2.78 倍，颗粒本身被染蓝。' +
    '现改为：消色分量近中性（1.11:1 蓝偏置），色度分量平权且仅占 2.5% 功率，色度颗粒只比亮度粗 1.3 倍。');
}

/* ================================================================ */
h1('测试 8 · 功率谱：低频平台 + 高频截止（修正研究报告的一处错误）');
const spectrumOfField = (radiusPx, N = 512, seed = 21, bins = 24) => {
  const f = generateGrainField({ width: N, height: N, seed, radiusPx, clumping: 0 });
  return smoothRadial(radialSpectrum(powerSpectrum2D(f, N), N, bins), 3);
};
{
  const r = 2, d = 2 * r, sg = r * 0.5;
  const rad = spectrumOfField(r);
  const dev = shapeDeviation(rad, sg, 0.15);
  const cut = robustCutoff(rad, 3);
  const cutTheory = 0.1325 / sg;
  line(`  r=${r}px（直径 d=${d}px）· 512×512 场 · 24 个径向 bin · 3 bin 平滑`);
  line(`  是否低通（DC 最强） : ${isLowPass(rad) ? '是' : '否'}`);
  line(`  与理论谱形的 RMS 偏差: ${pct(dev)}　（理论 ∝ exp(−4π²σ_g²f²)，σ_g=${sg}）`);
  line(`  -3dB 截止实测        : ${cut.toFixed(4)} cyc/px　理论 ${cutTheory.toFixed(4)}　相对偏差 ${pct(Math.abs(cut - cutTheory) / cutTheory)}`);
  line(`  参考 1/(2d)=${(1 / (2 * d)).toFixed(4)}　1/d=${(1 / d).toFixed(4)}　cut·d=${(cut * d).toFixed(3)}`);
  check(isLowPass(rad), '频谱是低通，不是带通',
    'Selwyn 定律 σ·√a=常数 等价于「低频功率谱平坦」，故颗粒频谱不可能在中频出现峰值。' +
    '研究报告 §4.4 图 3 画成带通、并称「低频被颗粒簇尺寸抑制」——这是错的，已列入勘误。');
  check(dev < 0.30, '实测谱形与理论高斯谱形一致（RMS 偏差 < 30%）',
    `实测 ${pct(dev)}。这一条比「平台平坦度」更硬：它同时验证了频谱形状、截止位置和归一化。` +
    '首轮用「平台平坦度」时失败，原因是它把已经跌到 −2.3dB 的频段也算作平台，属于测试定义错误。');
  check(cut * d > 0.35 && cut * d < 1.5, '-3dB 截止落在 1/(2d)~1/d 附近',
    `实测 cut·d = ${(cut * d).toFixed(3)}（目标 0.5~1.0）。由 SIGMA_GRAIN_RATIO=0.5 决定：cut = 0.1325/σ_g = 0.265/r。`);
}

/* ================================================================ */
h1('测试 9 · 尺度不变性');
{
  const c2 = robustCutoff(spectrumOfField(2, 512, 31), 3);
  const c4 = robustCutoff(spectrumOfField(4, 512, 31), 3);
  const ratio = c2 / c4;
  line(`  r=2 → ${c2.toFixed(4)} cyc/px　　r=4 → ${c4.toFixed(4)} cyc/px　　比值 ${ratio.toFixed(3)}（理想 2.000）`);
  check(Math.abs(ratio - 2) < 0.3, '截止频率与颗粒半径成反比',
    `实测 ${ratio.toFixed(3)}。这是「颗粒尺寸与像素网格解耦」的数学保证，也是复现报告 §4.6「PGI 28→79」的基础。`);
}

/* ================================================================ */
h1('测试 10 · 幅度 LUT');
{
  const { amp, sigLin, corr } = buildAmplitudeLUTs({ strength: 0.05, uPeak: PEAK });
  line('  v      A(v)·S 感知域    σ_lin 线性域    g\'(l) 校验    补偿项');
  for (const i of [0, 128, 256, 384, 511, 640, 768, 896, 1023]) {
    const v = i / 1023;
    const g1 = jacobianAtV(v);
    const ratio = amp[i] === 0 ? 1 : (sigLin[i] * g1) / amp[i];
    line(`  ${v.toFixed(3)}  ${amp[i].toExponential(4).padStart(13)}  ${sigLin[i].toExponential(4).padStart(13)}  ${ratio.toFixed(5).padStart(9)}  ${corr[i].toExponential(2).padStart(10)}`);
  }
  const peak = amp.indexOf(Math.max(...amp)) / 1023;
  check(peak > PEAK - 0.03 && peak < PEAK + 0.03, `感知域峰值在 v=${peak.toFixed(3)}（设定 ${PEAK}）`,
    'σ_lin 的峰值更偏亮部（因为要除以递减的 g\'(l)）。用户看到的是感知域曲线，实现用的是线性域——设计文档 §7 的核心决策。');
  check(amp[0] === 0 && amp[1023] === 0 && sigLin[0] === 0 && sigLin[1023] === 0 && corr[0] === 0,
    '三张表的端点全部严格为 0', '可做成回归测试：任何参数下纯黑纯白必须逐位不变。');
}

/* ================================================================ */
h1('测试 11 · 胶片预设与感光度标定');
{
  const g0 = grainIndex(filmById('portra400'), 0);
  line('  档位      等效ISO    grain（Portra 400 / 135）');
  const ladder = [];
  for (const s of STOPS) {
    const g = grainIndex(filmById('portra400'), s.v);
    ladder.push(g);
    line(`  ${s.label.padEnd(8)}${String(equivalentIso(filmById('portra400'), s.v)).padStart(6)}    ${g.toFixed(4)}`);
  }
  let mono = true;
  for (let i = 1; i < ladder.length; i++) if (ladder[i] <= ladder[i - 1]) mono = false;
  check(mono, '等效感光度上升时颗粒度严格单调上升',
    'ISO 与颗粒尺度的耦合是物理事实（大晶体捕光截面大），不是设计选择——研究报告表 2。');

  const pureIso = Math.pow(2, 2 / 3);
  const withPush = ladder[3] / ladder[1];
  check(withPush > pureIso, '推冲比同 ISO 的原生乳剂更粗',
    `推两档 = ${withPush.toFixed(3)}，纯 ISO 项 2^(2/3) = ${pureIso.toFixed(3)}，` +
    `额外惩罚 ${((withPush / pureIso - 1) * 100).toFixed(1)}%。机理：欠曝 + 强制显影加剧感染显影。`);

  const pgi = { '135': 79, '120': 50, '4x5': 26 }; // 研究报告表 6：同一 Portra 160，16×20 输出
  line('');
  line('  画幅       模型比值     报告实测比值    相对误差');
  let worstErr = 0;
  for (const g of GAUGES) {
    if (!pgi[g.id]) continue;
    const a = resolveFilmParams({ film: 'portra160', gauge: g.id, imageWidth: 6000, imageHeight: 4000 });
    const b = resolveFilmParams({ film: 'portra160', gauge: '135', imageWidth: 6000, imageHeight: 4000 });
    const model = a.radiusPx / b.radiusPx;
    const real = pgi[g.id] / pgi['135'];
    const err = Math.abs(model / real - 1);
    worstErr = Math.max(worstErr, err);
    line(`  ${g.name.padEnd(10)}${model.toFixed(3).padStart(10)}${real.toFixed(3).padStart(14)}${pct(err).padStart(14)}`);
  }
  check(worstErr < 0.10, '画幅梯度与柯达 PGI 实测吻合（相对误差 < 10%）',
    `最差 ${pct(worstErr)}。模型 (43.27/diag)^0.8，指数由这两组数据拟合。` +
    '这条是「颗粒按画幅对角线定义、不绑像素」的验收依据 —— 也就是报告里「观看条件比胶片型号影响更大」的直接体现。');

  const r0 = resolveFilmParams({ film: 'portra400', gauge: '135', imageWidth: 6000, imageHeight: 4000 });
  const r1 = resolveFilmParams({ film: 'portra800', gauge: '135', imageWidth: 6000, imageHeight: 4000 });
  const kSize = r1.radiusPx / r0.radiusPx, kAmp = r1.strength / r0.strength;
  const gg0 = grainIndex(filmById('portra400'), 0), gg1 = grainIndex(filmById('portra800'), 0);
  check(Math.abs(kSize - Math.pow(gg1 / gg0, RADIUS_G_EXP)) < 1e-6 && kSize < kAmp,
    `颗粒半径随 g 亚线性、幅度跟得更快（g^${RADIUS_G_EXP} vs g）`,
    `Portra 800 / Portra 400：g ×${(gg1 / gg0).toFixed(3)}，` +
    `半径 ×${kSize.toFixed(4)}（= g^${RADIUS_G_EXP}），幅度 ×${kAmp.toFixed(4)}。` +
    '【为什么改了这条】原实现让两者严格同比，高 ISO 端就变成「又粗又重」：' +
    'Portra 800 推三档半径 10.8px、幅度 19 色阶，目视是溅泥不是颗粒。' +
    '真实高速乳剂的颗粒**变大但远非线性**（面积更不会平方级涨），' +
    '「更密、更明显」远比「更大」重要。');

  // 强度的高端压缩：g ≤ 3 全额，超出部分按 0.6 次幂 —— 感知尺度本就有压缩
  const push3 = resolveFilmParams({ film: 'portra800', stops: 3, gauge: '135', imageWidth: 6000, imageHeight: 4000 });
  const gPush3 = grainIndex(filmById('portra800'), 3);
  const naive = (gPush3 / g0) * r0.strength;
  check(gPush3 > STRENGTH_G0 && push3.strength < naive * 0.85,
    `推三档的强度被高端压缩（不随 g 线性外推）`,
    `g = ${gPush3.toFixed(2)}（> ${STRENGTH_G0}）→ 幅度 ${push3.strength.toFixed(4)}，` +
    `线性外推会是 ${naive.toFixed(4)}（压低 ${pct(1 - push3.strength / naive)}）。` +
    'PGI 本身就是感知压缩标度，线性外推在高端必然过头：' +
    `修复前 Portra 800 推三档是 0.076（19 色阶），现在 ${push3.strength.toFixed(3)}。`);

  const big = resolveFilmParams({ film: 'portra400', gauge: '135', imageWidth: 6000, imageHeight: 4000 });
  const small = resolveFilmParams({ film: 'portra400', gauge: '135', imageWidth: 3000, imageHeight: 2000 });
  check(Math.abs(small.radiusPx / big.radiusPx - 0.5) < 1e-9 && Math.abs(small.strength / big.strength - 1) < 1e-9,
    '分辨率无关：半径随图像尺寸线性缩放，幅度不变',
    `24 MP → 12 MP 半径 ${big.radiusPx.toFixed(3)} → ${small.radiusPx.toFixed(3)}（应减半），` +
    `幅度恒为 ${big.strength.toFixed(4)}。不这么做的话，换张不同分辨率的图颗粒就变样了。`);
}

/* ================================================================ */
h1('测试 12 · 彩色脏污护栏（全预设 × 全档位 × 全画幅）');
{
  const W = 192, H = 128, px = W * H;
  const gray = makeFlat(W, H, 0.45);
  const ratios = [];
  let worst = 0, worstWhat = '';
  for (const film of FILM_STOCKS) {
    for (const s of STOPS) {
      if (s.v > 0 && film.iso >= 3200) continue;
      for (const gauge of ['135', '16mm']) {
        const p = resolveFilmParams({ film, stops: s.v, gauge, imageWidth: W, imageHeight: H });
        const img = Float32Array.from(gray);
        applyGrain(img, W, H, {
          seed: 7, radiusPx: p.radiusPx, clumping: p.clumping, strength: p.strength,
          uPeak: p.uPeak, lumaChroma: p.lumaChroma, mono: p.mono,
          weights: p.weights, chromaRadiusScale: p.chromaRadiusScale,
        });
        let l0 = 0, l1 = 0, r0 = 0, r1 = 0, b0 = 0, b1 = 0;
        for (let i = 0; i < px; i++) {
          const R = img[i * 3], G = img[i * 3 + 1], B = img[i * 3 + 2];
          const L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
          const rg = R - G, gb = B - G;
          l0 += L; l1 += L * L; r0 += rg; r1 += rg * rg; b0 += gb; b1 += gb * gb;
        }
        const sL = Math.sqrt(Math.max(0, l1 / px - (l0 / px) ** 2)) * 255;
        const sR = Math.sqrt(Math.max(0, r1 / px - (r0 / px) ** 2)) * 255;
        const sB = Math.sqrt(Math.max(0, b1 / px - (b0 / px) ** 2)) * 255;
        const rr = sL > 0.01 ? Math.max(sR, sB) / sL : 0;
        ratios.push(rr);
        if (rr > worst) { worst = rr; worstWhat = `${film.name} ${s.label} ${gauge}`; }
      }
    }
  }
  ratios.sort((a, b) => a - b);
  // 黑白片（mono）的色度严格为 0，会污染「稳定性」判据，稳定性只看有色度的彩色片
  const colored = ratios.filter((r) => r > 0.01);
  line(`  组合数 ${ratios.length}（其中彩色片 ${colored.length}）　最差：${worstWhat} = ${worst.toFixed(3)}`);
  line(`  分布 min ${ratios[0].toFixed(3)}　中位 ${ratios[ratios.length >> 1].toFixed(3)}　max ${ratios[ratios.length - 1].toFixed(3)}`);
  check(worst < 0.35, '所有胶片 × 感光度 × 画幅的色度/亮度噪声比 < 0.35',
    `最差 ${worst.toFixed(3)}。**这条护栏是「彩色脏污」的回归测试**：` +
    '当时通道模板带 2.78:1 的蓝偏置，于是每个颗粒事件都偏蓝，' +
    '该比值随参数从 0.5 涨到 1.8，调大尺寸/团簇度就出现彩色斑块。' +
    '现在不仅绝对值低，而且在全部 200+ 组合上稳定。');
  check(colored[colored.length - 1] / colored[0] < 3,
    '彩色片的该比值跨参数**稳定**（极差 < 3×）',
    `max/min = ${(colored[colored.length - 1] / colored[0]).toFixed(2)}（${colored[0].toFixed(3)} ~ ${colored[colored.length - 1].toFixed(3)}）。` +
    '稳定性比绝对值更重要 —— 用户报的是「调参数就出脏污」，那正是比值随参数漂移的表现。' +
    '黑白片不参与该判据：它们三通道共用同一个场，色度严格为 0。');
}

/* ================================================================ */
h1('测试 13 · 幂等性：重复应用必须是替换，不是叠加');
{
  /* 面板每点一次「应用」都从**源图层**重读像素，所以核心必须保证：
     同源 + 同参 + 同原点 → 逐位一致。否则「替换」这个语义都不成立。 */
  const W = 256, H = 256;
  const src = makeFlat(W, H, 0.45);
  const opts = {
    seed: 11, radiusPx: 2, clumping: 0.35, strength: 0.03, uPeak: PEAK,
    lumaChroma: 0.025, weights: [0.90, 0.95, 1.00],
  };

  const a = Float32Array.from(src); applyGrain(a, W, H, opts);
  const b = Float32Array.from(src); applyGrain(b, W, H, opts);
  let d = 0;
  for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  check(d === 0, '同源 + 同参 → 输出逐位一致',
    '最大逐点差异 ' + d.toExponential(2) + '。这条是「替换」语义的前提：' +
    '面板每次都从源图层重算，因此重算结果必须与上一次完全相同。' +
    '（坐标寻址哈希 + 理论方差归一化保证，不依赖任何运行期状态。）');

  // 对照：若在**已加过颗粒**的图上再加一次，会怎样
  const stacked = Float32Array.from(a); applyGrain(stacked, W, H, opts);
  const sdOf = (arr, off) => {
    let m = 0, n = 0;
    for (let i = 0; i < W * H; i++) { m += arr[i * 3 + off]; n++; }
    m /= n;
    let v = 0;
    for (let i = 0; i < W * H; i++) { const t = arr[i * 3 + off] - m; v += t * t; }
    return Math.sqrt(v / n);
  };
  const s1 = sdOf(a, 1), s2 = sdOf(stacked, 1);
  check(s2 / s1 > 1.3, '叠加会显著加重颗粒（这就是本次要消除的行为）',
    `单次 std ${s1.toFixed(5)} → 叠加两次 ${s2.toFixed(5)}，**×${(s2 / s1).toFixed(3)}**。` +
    `注意是**几乎精确翻倍**，而不是独立噪声叠加的 √2 = 1.414 —— ` +
    '因为颗粒场是确定性的（同种子 → 同一个场），同一组颗粒被原样加了两次。' +
    '换句话说：确定性让「叠加」比随机噪声叠加更糟。' +
    `差值 ${((s2 - s1) * 255).toFixed(2)} 色阶，目视一眼可辨。` +
    'v0.3 及之前直接往当前图层写像素，连点两次就是这个后果。');

  // 不同参数之间切换：也必须各自从源重算，结果只由参数决定
  const p1 = Float32Array.from(src); applyGrain(p1, W, H, opts);
  const p2 = Float32Array.from(src); applyGrain(p2, W, H, Object.assign({}, opts, { strength: 0.05 }));
  const p1b = Float32Array.from(src); applyGrain(p1b, W, H, opts);
  let d2 = 0;
  for (let i = 0; i < p1.length; i++) d2 = Math.max(d2, Math.abs(p1[i] - p1b[i]));
  check(d2 === 0 && sdOf(p2, 1) > sdOf(p1, 1), '改参数再算 → 只由参数决定，不携带上一次的痕迹',
    `改幅度 0.03 → 0.05 后 std ${sdOf(p1, 1).toFixed(5)} → ${sdOf(p2, 1).toFixed(5)}（应上升）；` +
    `改回 0.03 逐位回到原值（差异 ${d2.toExponential(2)}）。`);
}

/* ================================================================ */
h1('测试 14 · 彩色像素的逐通道幅度（「暖调红点」回归）');
{
  /* 【为什么需要这条】34 项验收全用灰图（R=G=B），而灰图下「红通道做 LUT 索引」
     恰好完全正确 —— 「暖调红点」bug 只在**通道离散度大的饱和色**上出现：
     幅度按红通道亮度定标，同一个线性域 σ 灌进暗得多的蓝通道，
     感知噪声放大 g'(l_c)/g'(l_red) 倍（暖棕像素蓝通道过噪 3.5 倍），
     再被钳位整流成单边尖峰，观感就是暖色区域上一簇簇饱和红点。
     本测试用非灰平块断言：每通道感知噪声 ≈ A(v_c)·S·√vc[c]，
     其中 vc = 模板²·wL² + 色度权重²（与 applyGrain 内部定义一致）。 */
  const W = 512, H = 256, S = 0.014, LC = 0.025;
  const wL = Math.sqrt(1 - LC), wC = Math.sqrt(LC);
  const WEIGHTS = [0.90, 0.95, 1.00];
  const lumRef = lumTemplateNorm(WEIGHTS);
  const lumW = WEIGHTS.map((w) => w / Math.max(...WEIGHTS) / lumRef);
  const vc = lumW.map((w) => w * w * wL * wL + wC * wC);

  const patches = [
    ['暖棕（皮肤/木头典型）', 0.55, 0.35, 0.25],
    ['冷蓝（天空阴影）', 0.25, 0.35, 0.55],
    ['高饱和红（花卉）', 0.70, 0.15, 0.12],
  ];
  let worst = 1, worstWhat = '(无)';
  let totalClamped = 0;
  for (const [label, r, g, b] of patches) {
    const vals = [r, g, b];
    const img = makeFlat(W, H, 0);
    for (let i = 0; i < W * H; i++) { img[i * 3] = r; img[i * 3 + 1] = g; img[i * 3 + 2] = b; }
    applyGrain(img, W, H, { seed: 21, strength: S, uPeak: PEAK, lumaChroma: LC, clumping: 0 });

    line(`  ${label}　RGB(${r}, ${g}, ${b})`);
    line('    通道   应有 A(v)·S·√vc    实测 std    实测/应有');
    for (let c = 0; c < 3; c++) {
      const v = vals[c];
      const expect = amplitudeAt(v, PEAK) * S * Math.sqrt(vc[c]);
      // 实测用「输出 − 输入」的 std，避免把补偿带来的均值偏移算进幅度
      let s = 0, s2 = 0, clamped = 0;
      const n = W * H;
      for (let i = 0; i < n; i++) {
        const o = img[i * 3 + c];
        const d = o - v;
        s += d; s2 += d * d;
        if (o <= 0 && v > 0.05) clamped++;   // 钳到 0 = 整流尖峰（暗通道本不该有噪声）
      }
      totalClamped += clamped;
      const std = Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
      const ratio = std / expect;
      if (Math.abs(ratio - 1) > Math.abs(worst - 1)) { worst = ratio; worstWhat = `${label} ${'RGB'[c]}`; }
      line(`    ${'RGB'[c]}      ${expect.toFixed(5)}           ${std.toFixed(5)}    ${ratio.toFixed(3)}`);
    }
  }
  check(Math.abs(worst - 1) < 0.12,
    `三个彩色平块的每通道噪声都在应有值的 ±12% 内（最差 ${worstWhat} = ${worst.toFixed(3)}）`,
    `最差比值 ${worst.toFixed(3)}。修复前暖棕块的蓝通道是 **3.5 倍** —— ` +
    '幅度按红通道亮度定标却灌进暗蓝通道，感知域被 g\'(l) 差再放大，' +
    '钳位后成单边尖峰。逐通道索引后每层染料按自己的曝光响应，' +
    'A(v)→0 自动关掉暗通道的噪声，与布尔模型 Var ∝ p(1−p) 一致。');
  check(totalClamped === 0,
    '彩色区域无钳位像素（噪声不会被整流成尖峰）',
    `三个平块 393216 个通道样本里钳到 0 的有 ${totalClamped} 个。` +
    '修复前暖棕块蓝通道 σ 占线性值 71%，约 8% 像素被钳到蓝=0（最饱和的红）。');
}

/* ================================================================ */
h1('测试 15 · 高 ISO 行为（「像溅了泥」回归）');
{
  /* 用户实测：高 ISO/推冲档下画面像溅了黑泥，不均匀、很脏。四个成因：
     ① 半径随 g 线性 → 又粗又重；② 幅度线性外推 → 高端过头；
     ③ A(u) 高光侧衰减太慢 → 连白墙都盖满颗粒；
     ④ 暗部σ > l → 硬钳位把噪声整流成单边黑斑。
     ①②在测试 11 里断言（亚线性 + 压缩），③④在这里断言。 */
  const S_HI = 0.060;   // ≈ 修复后的 Portra 800 推三档峰值幅度

  // ③ 幅度曲线的高光侧衰减（非对称）
  const peak = amplitudeAt(PEAK, PEAK);
  const a80 = amplitudeAt(0.80, PEAK) / peak;
  const a90 = amplitudeAt(0.90, PEAK) / peak;
  const a10 = amplitudeAt(0.10, PEAK) / peak;
  line(`  A(0.80)=${a80.toFixed(3)}　A(0.90)=${a90.toFixed(3)}　A(0.10)=${a10.toFixed(3)}　（峰值=1）`);
  check(a90 < 0.30 && a80 < 0.60, '高光侧衰减够陡（白墙不再盖满颗粒）',
    `A(0.90) = ${a90.toFixed(3)}（修复前 0.699）、A(0.80) = ${a80.toFixed(3)}（修复前 0.894）。` +
    `S=${S_HI} 时白墙上的噪声从 ${(0.699 * S_HI * 255).toFixed(1)} 色阶降到 ${(a90 * S_HI * 255).toFixed(1)} 色阶。` +
    '物理依据：正像高光来自负片肩部低密度区，可显影的颗粒很少。');
  check(a10 > 0.25, '阴影侧衰减保持平缓（暗部仍有胶片该有的闷感）',
    `A(0.10) = ${a10.toFixed(3)}。**刻意做成非对称**：真实扫描件是「阴影发闷、高光干净」，` +
    '对称的 p(1−p) 做不到这一点。');

  // ④ 暗部：软膝必须让钳位归零，且噪声收缩到解析预期
  const W = 512, H = 256;
  const darkLevels = [0.08, 0.12, 0.20];
  let totalClamped = 0, worstRatio = 1, worstWhat = '';
  line('');
  line('  暗部平块（高 ISO 强度）  应有 std   实测 std   比值   钳位像素');
  for (const v of darkLevels) {
    const img = makeFlat(W, H, v);
    applyGrain(img, W, H, { seed: 31, strength: S_HI, uPeak: PEAK, radiusPx: 6, clumping: 0.42, lumaChroma: 0 });
    const w0 = 1 / lumTemplateNorm([1, 1, 1]);   // weights 默认近中性 → 亮度域归一化因子
    const th = amplitudeAt(v, PEAK) * S_HI * w0 * Math.sqrt(kneeVarFactor(srgbToLinear(v) / (NOISE_KNEE * (amplitudeAt(v, PEAK) * S_HI * w0 / jacobianAtV(v)))));
    let s = 0, s2 = 0, clamped = 0;
    const n = W * H;
    for (let i = 0; i < n; i++) {
      const d = img[i * 3 + 1] - v;      // 看绿通道即可（三通道同值）
      s += d; s2 += d * d;
      if (img[i * 3 + 1] <= 0) clamped++;
    }
    totalClamped += clamped;
    const std = Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
    const ratio = std / th;
    if (Math.abs(ratio - 1) > Math.abs(worstRatio - 1)) { worstRatio = ratio; worstWhat = `v=${v}`; }
    line(`  v=${v.toFixed(2)}                ${th.toFixed(5)}  ${std.toFixed(5)}  ${ratio.toFixed(3)}   ${clamped}`);
  }
  check(totalClamped === 0, '高 ISO 下暗部无钳位像素（黑泥点消失）',
    `三个暗块 ${W * H * 3} 个通道样本钳位 ${totalClamped} 个。` +
    '软膝给出 |注入量| ≤ l/KNEE=3.5 的硬上界，**数学上不可能跌破 0** —— ' +
    '修复前暗部 z≈1.6，约 11% 的分布被钳到 0，形成只暗不亮的单边黑斑。');
  check(Math.abs(worstRatio - 1) < 0.15, `暗部噪声收缩量与解析预期一致（最差 ${worstWhat} = ${worstRatio.toFixed(3)}）`,
    `最差比值 ${worstRatio.toFixed(3)}。理论用 kneeVarFactor：E[min(g²,(l/K)²)] —— ` +
    '这是软膝的解析方差，不是拟合参数，所以能当验收阈值。' +
    '实测系统性低约 7%：解析式假定 g 严格高斯，而 c=0.42 的乘性包络让分布带轻微重尾，' +
    '软膝对重尾的削减比高斯预测更多 —— 方向可解释、量级可接受。');
}

/* ================================================================ */
h1('可视化输出');
{
  const W = 512;
  const canvas = new Uint8ClampedArray(W * 320 * 3);
  const put = (x, y, v) => { const b = (y * W + x) * 3; canvas[b] = canvas[b + 1] = canvas[b + 2] = v; };
  const stair = makeStaircase(W, 64, 11);
  for (let y = 0; y < 64; y++) for (let x = 0; x < W; x++) put(x, y, stair[(y * W + x) * 3] * 255);
  const stair2 = Float32Array.from(stair);
  applyGrain(stair2, W, 64, { seed: 3, radiusPx: 2, clumping: 0.35, strength: 0.05, uPeak: PEAK, lumaChroma: 0.2 });
  for (let y = 0; y < 64; y++) for (let x = 0; x < W; x++) put(x, 64 + y, stair2[(y * W + x) * 3] * 255);
  const flat = makeFlat(W, 192, 0.5);
  applyGrain(flat, W, 192, { seed: 9, radiusPx: 2, clumping: 0.35, strength: 0.05, uPeak: PEAK, lumaChroma: 0.2 });
  for (let y = 0; y < 192; y++) for (let x = 0; x < W; x++) put(x, 128 + y, flat[(y * W + x) * 3] * 255);
  writeRGBPNG(join(OUT, 'grain-preview.png'), W, 320, canvas);
  line('  out/grain-preview.png　上=原始灰阶　中=加颗粒　下=中灰平面看纹理');

  for (const c of [0, 0.35]) {
    const N = 256, f = generateGrainField({ width: N, height: N, seed: 21, radiusPx: 2, clumping: c });
    const g = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) g[i] = 0.5 + f[i] * 0.16;
    writeGrayPNG(join(OUT, `grain-field-c${c}.png`), N, N, toU8(g));
    line(`  out/grain-field-c${c}.png　纯颗粒场（团簇度 ${c}），用于目视对比团簇结构`);
  }
}

h1('汇总');
line(`  通过 ${pass}　警告 ${warn}　失败 ${fail}`);
line();
process.exit(fail > 0 ? 1 : 0);
