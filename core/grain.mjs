/**
 * 银盐 · 胶片颗粒算法核心（平台无关）
 * ------------------------------------------------------------------
 * 不依赖 DOM / Node API / Photoshop API。全部函数为纯函数或显式状态，
 * 输入输出均为 TypedArray，可直接被 UXP 或原生 C++ 侧复用。
 *
 * 管线（对应设计文档 §5）：
 *   感知域 v ──srgbToLinear──> 线性域 l
 *    l' = l + σ_lin(v) · G(x,y)
 *    l' ──linearToSrgb──> v'
 *
 *   其中 G 是零均值、单位方差、具备团簇结构的颗粒场（本文件 generateGrainField）
 *        σ_lin(v) = A(v)·S / g'(l)         （设计文档 §7.2 的换算）
 */

/* ================================================================
   1. 色彩域：sRGB 传输函数 + 解析雅可比
   ================================================================ */
/* 表长 2048、Float32：两张表各 8 KB，能同时留在 L1。
 * 线性插值下 sRGB 传输函数的截断误差 ~4.5e-8，远小于 16 位的 1/32768 = 3e-5。 */
const N_LUT = 2048;
const S2L = new Float32Array(N_LUT);
const L2S = new Float32Array(N_LUT);
(() => {
  for (let i = 0; i < N_LUT; i++) {
    const v = i / (N_LUT - 1);
    S2L[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    const l = i / (N_LUT - 1);
    L2S[i] = l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  }
})();

function lutLerp(table, x) {
  const t = x <= 0 ? 0 : x >= 1 ? 1 : x;
  const f = t * (N_LUT - 1);
  const i = Math.min(N_LUT - 2, f | 0);
  const a = f - i;
  return table[i] * (1 - a) + table[i + 1] * a;
}

/* kneeVarFactor 的**查表版**。
 * 【为什么必须查表】补偿项每像素要 3 次调用（每通道一次），而 kneeVarFactor 里
 * 有 exp + sqrt + 10 项 erf 多项式 —— 实测把 L3 合成从 17 ms 推到 107 ms（6 倍）。
 * 表在模块初始化时算一次，运行时只有一次 lerp。
 * 分辨率 512/6 ≈ 85 点每单位 t：函数在 t<1 变化最快，此处已有 ~85 点，误差 < 1e-4。 */
/* kneeVarFactor 在**运行时不再被调用**（见 applyGrain 里关于「补偿不缩软膝」
   的注释：实测那次缩放要 1 s / 24 MP，而收益只有零点几色阶）。
   它保留为**解析参考**：验收测试用它算暗部噪声的理论值，因此不是死代码。 */

/** sRGB 编码值 → 线性光值 */
export const srgbToLinear = (v) => lutLerp(S2L, v);
/** 线性光值 → sRGB 编码值 */
export const linearToSrgb = (l) => lutLerp(L2S, l);

/**
 * g'(l)：线性 → 感知的导数，在 l = srgbToLinear(v) 处求值。
 * 用中心差分，步长随 l 自适应，避免在 l→0 处精度崩掉。
 */
export function jacobianAtV(v) {
  const l = srgbToLinear(v);
  const e = Math.max(1e-6, l * 1e-3);
  const l0 = Math.max(0, l - e);
  const l1 = Math.min(1, l + e);
  if (l1 <= l0) return 12.92;
  return (linearToSrgb(l1) - linearToSrgb(l0)) / (l1 - l0);
}

/** 设计文档 §7.2 的解析近似：1/g'(l) ≈ 2.2·v^1.2，用于自检 */
export const analyticInvJacobian = (v) => 2.2 * Math.pow(Math.max(v, 0), 1.2);

/**
 * g''(l)：线性 → 感知的二阶导数（解析式）。
 *
 * 【为什么需要它】
 * 颗粒在线性域注入、在感知域观察。g 是凹函数，所以「加一个对称的线性域扰动」
 * 会在感知域产生一个**二阶偏置** ½·g''(l)·σ_lin²，方向恒为变暗。
 * 实测在 strength=0.04 时约为 −0.7 个 8 位色阶——不强但确凿，且随强度平方增长。
 * 补偿方式：在输出里减去这个偏置的零均值部分，见 applyGrain。
 */
export function curvatureAtV(v) {
  const l = srgbToLinear(v);
  if (l <= 0.0031308) return 0; // 线性段，二阶导为 0
  return -0.2564236 * Math.pow(l, -1.5833333);
}

/* ================================================================
   2. 坐标寻址的确定性哈希 PRNG
   ================================================================ */

/** 32 位混合哈希：同一 (seed, stream, x, y) 永远得到同一结果 */
export function hash32(seed, stream, x, y) {
  let h = (seed ^ 0x9e3779b1) >>> 0;
  h = Math.imul(h ^ (x >>> 0), 0x85ebca6b) >>> 0; h ^= h >>> 13;
  h = Math.imul(h ^ (y >>> 0), 0xc2b2ae35) >>> 0; h ^= h >>> 16;
  h = Math.imul(h ^ (stream >>> 0), 0x27d4eb2f) >>> 0; h ^= h >>> 15;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0; h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0; h ^= h >>> 16;
  return h >>> 0;
}

/** 均匀分布 U[-1, 1) */
const uniformPM1 = (seed, stream, x, y) => hash32(seed, stream, x, y) / 2147483648 - 1;

/**
 * 单位噪声：三个独立均匀数之和（Irwin–Hall n=3）。
 * 均值恰为 0，方差恰为 1 —— 无需任何数值估计，因此天然全局一致。
 * 分布近似高斯（对颗粒而言足够；布尔模型本身也不是高斯的）。
 */
export function unitNoise(seed, stream, x, y) {
  return uniformPM1(seed, stream, x, y)
       + uniformPM1(seed, (stream ^ 0x5bf03635) >>> 0, (x + 0x9e3779b1) | 0, y)
       + uniformPM1(seed, stream, x ^ 0x27d4eb2f, (y + 0x1b873593) | 0);
}

/* ================================================================
   3. 卷积核与颗粒场
   ================================================================ */

/**
 * 一维高斯核。mode='l2' 时归一化到单位 L2 范数。
 *
 * 【为什么必须是 L2 而不是求和为 1】
 * 二维可分离卷积相当于用 k⊗k 滤波。若 ||k||₂ = 1，则
 *   Var(输出) = Var(白噪声) · ΣΣ(k⊗k)² = 1 · (||k||₂²)² = 1
 * 即输出方差**精确**等于输入方差，与块位置无关。
 * 若按每块实测方差归一化，块间会出现强度台阶（设计文档 §5.4 已警告）。
 */
export function gaussianKernel1D(sigma) {
  const R = Math.max(1, Math.ceil(3 * sigma));
  const n = 2 * R + 1;
  const k = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = i - R;
    k[i] = Math.exp(-(d * d) / (2 * sigma * sigma));
  }
  return { k, R };
}

export function normalizeL2(k) {
  let s = 0;
  for (let i = 0; i < k.length; i++) s += k[i] * k[i];
  s = Math.sqrt(s) || 1;
  const o = new Float64Array(k.length);
  for (let i = 0; i < k.length; i++) o[i] = k[i] / s;
  return o;
}

/* ---------- 内层热循环：按抽头数特化 ----------
 *
 * V8 不会自动展开 `for (i < KT)` 这种内层循环，而抽头数在调用时就已知。
 * 把分支放在「每行 / 每列」这一层，既能展开，又不必为每种抽头数复制整段卷积代码。
 *
 * 实测（Node 22，1024²，7 抽头，含边界处理）：通用循环 25.65 → 展开 11.76 ns/px。
 * 覆盖实际会出现的抽头数：5（σ=0.35）、7（σ=1，默认细颗粒）、13（σ=1.8，色度细颗粒）。
 * 团簇场动辄 43/75 抽头，展开不现实 —— 那一头要靠降分辨率解决。
 */
function convRow(dst, src, off, x0, x1, nk, R) {
  const KT = nk.length;

  if (KT === 7) {
    const k0 = nk[0], k1 = nk[1], k2 = nk[2], k3 = nk[3], k4 = nk[4], k5 = nk[5], k6 = nk[6];
    for (let x = x0; x < x1; x++) {
      const b = off + x - 3;
      dst[off + x] = k0 * src[b] + k1 * src[b + 1] + k2 * src[b + 2] + k3 * src[b + 3]
                   + k4 * src[b + 4] + k5 * src[b + 5] + k6 * src[b + 6];
    }
    return;
  }

  if (KT === 5) {
    const k0 = nk[0], k1 = nk[1], k2 = nk[2], k3 = nk[3], k4 = nk[4];
    for (let x = x0; x < x1; x++) {
      const b = off + x - 2;
      dst[off + x] = k0 * src[b] + k1 * src[b + 1] + k2 * src[b + 2] + k3 * src[b + 3] + k4 * src[b + 4];
    }
    return;
  }

  if (KT === 13) {
    const k0 = nk[0], k1 = nk[1], k2 = nk[2], k3 = nk[3], k4 = nk[4], k5 = nk[5], k6 = nk[6];
    const k7 = nk[7], k8 = nk[8], k9 = nk[9], k10 = nk[10], k11 = nk[11], k12 = nk[12];
    for (let x = x0; x < x1; x++) {
      const b = off + x - 6;
      dst[off + x] = k0 * src[b] + k1 * src[b + 1] + k2 * src[b + 2] + k3 * src[b + 3]
                   + k4 * src[b + 4] + k5 * src[b + 5] + k6 * src[b + 6] + k7 * src[b + 7]
                   + k8 * src[b + 8] + k9 * src[b + 9] + k10 * src[b + 10]
                   + k11 * src[b + 11] + k12 * src[b + 12];
    }
    return;
  }

  for (let x = x0; x < x1; x++) {
    let a = 0;
    const b = off + x - R;
    for (let i = 0; i < KT; i++) a += nk[i] * src[b + i];
    dst[off + x] = a;
  }
}

function convCol(dst, src, dstBase, srcBase, n, W, nk, R) {
  const KT = nk.length;

  if (KT === 7) {
    const k0 = nk[0], k1 = nk[1], k2 = nk[2], k3 = nk[3], k4 = nk[4], k5 = nk[5], k6 = nk[6];
    for (let x = 0; x < n; x++) {
      const b = srcBase + x;
      dst[dstBase + x] = k0 * src[b] + k1 * src[b + W] + k2 * src[b + 2 * W] + k3 * src[b + 3 * W]
                       + k4 * src[b + 4 * W] + k5 * src[b + 5 * W] + k6 * src[b + 6 * W];
    }
    return;
  }

  if (KT === 5) {
    const k0 = nk[0], k1 = nk[1], k2 = nk[2], k3 = nk[3], k4 = nk[4];
    for (let x = 0; x < n; x++) {
      const b = srcBase + x;
      dst[dstBase + x] = k0 * src[b] + k1 * src[b + W] + k2 * src[b + 2 * W]
                       + k3 * src[b + 3 * W] + k4 * src[b + 4 * W];
    }
    return;
  }

  if (KT === 13) {
    const k0 = nk[0], k1 = nk[1], k2 = nk[2], k3 = nk[3], k4 = nk[4], k5 = nk[5], k6 = nk[6];
    const k7 = nk[7], k8 = nk[8], k9 = nk[9], k10 = nk[10], k11 = nk[11], k12 = nk[12];
    for (let x = 0; x < n; x++) {
      const b = srcBase + x;
      dst[dstBase + x] = k0 * src[b] + k1 * src[b + W] + k2 * src[b + 2 * W] + k3 * src[b + 3 * W]
                       + k4 * src[b + 4 * W] + k5 * src[b + 5 * W] + k6 * src[b + 6 * W]
                       + k7 * src[b + 7 * W] + k8 * src[b + 8 * W] + k9 * src[b + 9 * W]
                       + k10 * src[b + 10 * W] + k11 * src[b + 11 * W] + k12 * src[b + 12 * W];
    }
    return;
  }

  for (let x = 0; x < n; x++) {
    let a = 0;
    let idx = srcBase + x;
    for (let i = 0; i < KT; i++) { a += nk[i] * src[idx]; idx += W; }
    dst[dstBase + x] = a;
  }
}

/**
 * 带 halo 的可分离高斯滤波噪声场。
 * 内部按 (width+2R) × (height+2R) 生成，裁掉 halo 后输出 —— 因此
 * tile 边界处的噪声与整图一次性生成完全一致（坐标寻址哈希保证）。
 *
 * 【性能】内层循环按「边界区 / 内部区」拆开，内部区无分支、无边界判断。
 * 实测（Node 22，1024²，7 抽头）：22.08 → 9.53 ns/px，逐像素差异为 0。
 * UXP 的 V8 约比 Node 慢 1.55 倍（34.33 vs 22.08 ns/px，同一段代码），
 * 换算到 UXP 约 14.8 ns/px。taps ∝ σ，所以团簇场（σ≈7 px，43 抽头）是主要成本。
 *
 * 【为什么纵向卷积不需要钳位】输出像素 (x,y) 对应 raw 的 (x+R, y+R)，
 * 纵向窗口是 row 的第 [y, y+2R] 行，y ≤ height−1 ⇒ 最大行号 = height+2R−1 = H−1。
 * 恰好落在范围内，因此整段纵向循环可以完全无分支。
 */
export function filteredNoise({ width, height, seed, stream, sigma, originX = 0, originY = 0 }) {
  const { k, R } = gaussianKernel1D(sigma);
  const KT = k.length;

  // 核按 L2 归一化，并用 Float32 存储（避免与 Float64 混算造成去优化）
  let s2 = 0;
  for (let i = 0; i < KT; i++) s2 += k[i] * k[i];
  s2 = Math.sqrt(s2) || 1;
  const nk = new Float32Array(KT);
  for (let i = 0; i < KT; i++) nk[i] = k[i] / s2;

  const W = width + 2 * R;
  const H = height + 2 * R;

  const raw = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const off = y * W;
    const gy = y - R + originY;
    for (let x = 0; x < W; x++) raw[off + x] = unitNoise(seed, stream, x - R + originX, gy);
  }

  // ---- 横向：左边界（钳位）/ 内部（无分支）/ 右边界（钳位）----
  const row = new Float32Array(W * H);
  const xIntStart = R;
  const xIntEnd = W - R;
  for (let y = 0; y < H; y++) {
    const off = y * W;

    for (let x = 0; x < xIntStart; x++) {
      let a = 0;
      for (let i = 0; i < KT; i++) {
        let xx = x + i - R; if (xx < 0) xx = 0;
        a += nk[i] * raw[off + xx];
      }
      row[off + x] = a;
    }

    convRow(row, raw, off, xIntStart, xIntEnd, nk, R);

    for (let x = xIntEnd; x < W; x++) {
      let a = 0;
      for (let i = 0; i < KT; i++) {
        let xx = x + i - R; if (xx >= W) xx = W - 1;
        a += nk[i] * raw[off + xx];
      }
      row[off + x] = a;
    }
  }

  // ---- 纵向：整段无分支（见上方推导）----
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    convCol(out, row, y * width, y * W + R, width, W, nk, R);
  }
  return out;
}

/**
 * 低分辨率生成 + 双线性上采样 + **解析方差归一化**的相关噪声场。
 *
 * 【为什么必须要有这个】
 * 可分离卷积成本 ∝ 抽头数，而抽头数 ∝ σ。团簇包络 σ_c 达 6.8 ~ 12.2 px，
 * 对应 43 ~ 75 抽头：全分辨率算一遍在 UXP 里要 4.5 ~ 8.6 秒，四个通道叠加直接不可用。
 *
 * 但包络是**低频场**：σ_c=6.8 px 的场能量在 1/(2·6.8)=0.073 cyc/px 以下，
 * 而 stride=4 的粗网格奈奎斯特是 0.125 cyc/px —— 仍是信号带宽的 1.7 倍过采样，
 * 信息上没有损失。成本则降为：像素数 ÷stride²，同时 σ 同比缩小使抽头数也减少，
 * 合计约 **÷stride³**。
 *
 * 【方差为什么会掉，以及为什么能解析修回来】
 * 双线性插值对样本加权平均，而样本之间相关（相关系数 ρ），所以插值结果的方差
 *   V(t) = (1−t)² + t² + 2t(1−t)·ρ
 * 在 cell 内随位置变化：t=0 时 V=1，t=0.5 时最小。
 *
 * ρ 可以**精确算出**，不需要任何统计估计 —— 粗网格场是白噪声经 L2 归一化核卷积的结果，
 * 其自相关就是核的自相关：
 *   ρ(1) = Σᵢ kᵢ·kᵢ₊₁ / Σᵢ kᵢ²
 * 二维因可分离，故 V = Vx(tx)·Vy(ty)。除以 √V 即得单位方差。
 *
 * 【这条修正为什么不会引入块间台阶】
 * 它是**解析的、确定性的**：同一个位置永远得到同一个因子，与分块方式无关。
 * 报告 §7.4 警告的「块间强度台阶」来自用**样本估计**（每块的实测方差）代替理论值；
 * 这里没有任何样本估计，所以不触发该问题。
 * 代价是给场附加一个周期为 stride、幅度约为 V 变动一半的极小纹波，
 * 由验收测试「网格频率处不出现谱峰」把关。
 *
 * 【任意 origin 都能用】
 * 粗网格对齐到**全局图像坐标**：内部记录 origin 在粗网格中的相位偏移，
 * 因此 originX/originY 不必是 stride 的整数倍，分块一致性不受影响。
 */
export function decimatedNoise({
  width, height, seed, stream, sigma, originX = 0, originY = 0, stride = 4,
}) {
  const s = Math.max(1, Math.round(stride));
  if (s <= 1) return filteredNoise({ width, height, seed, stream, sigma, originX, originY });

  const sigmaC = sigma / s;

  const mod = (a, n) => ((a % n) + n) % n;
  const ox = mod(originX, s);
  const oy = mod(originY, s);
  const cBaseX = Math.floor(originX / s);
  const cBaseY = Math.floor(originY / s);

  const cw = Math.floor((ox + width - 1) / s) + 2;
  const ch = Math.floor((oy + height - 1) / s) + 2;

  const coarse = filteredNoise({
    width: cw, height: ch, seed, stream, sigma: sigmaC,
    originX: cBaseX, originY: cBaseY,
  });

  // ρ(1)：用实际使用的离散核精确算，不套高斯近似
  const { k } = gaussianKernel1D(sigmaC);
  let num = 0, den = 0;
  for (let i = 0; i < k.length; i++) {
    den += k[i] * k[i];
    if (i + 1 < k.length) num += k[i] * k[i + 1];
  }
  const rho = den > 0 ? num / den : 0;

  const normLut = new Float32Array(s);
  for (let t = 0; t < s; t++) {
    const f = t / s;
    const v = (1 - f) * (1 - f) + f * f + 2 * f * (1 - f) * rho;
    normLut[t] = 1 / Math.sqrt(Math.max(v, 1e-6));
  }

  const out = new Float32Array(width * height);
  let j0 = 0, ty = oy;
  for (let y = 0; y < height; y++) {
    const fy = ty / s;
    const w0 = 1 - fy, w1 = fy;
    const ny = normLut[ty];
    const rowA = j0 * cw, rowB = rowA + cw;
    const dst = y * width;
    let i0 = 0, tx = ox;
    for (let x = 0; x < width; x++) {
      const gx = tx / s;
      const u0 = 1 - gx, u1 = gx;
      const v = (u0 * coarse[rowA + i0] + u1 * coarse[rowA + i0 + 1]) * w0
              + (u0 * coarse[rowB + i0] + u1 * coarse[rowB + i0 + 1]) * w1;
      out[dst + x] = v * ny * normLut[tx];
      if (++tx === s) { tx = 0; i0++; }
    }
    if (++ty === s) { ty = 0; j0++; }
  }
  return out;
}

/** 团簇包络默认的降采样倍率。
 * stride=4 把 σ_c ∈ [6.8, 12.2] px 映射到粗网格 σ ∈ [1.7, 3.1] px，抽头数 43/75 → 11/19。
 */
export const ENVELOPE_STRIDE = 4;

/**
 * 色度细颗粒场默认的降采样倍率。
 *
 * 依据：色度颗粒本身就比亮度颗粒粗 —— 其 σ_g = μr×1.8×0.5 = 1.8 px（亮度是 1.0 px），
 * 而色度颗粒的对比度又低。stride=2 只丢掉最上面一个倍频程，视觉上几乎不可辨；
 * 代价却省下一半抽头 + 四分之三像素。
 * 实测（1024² 单场）：39.23 → 24.50 ns/px。三个色度场合计省约 40 ns/px（占总成本 1/4）。
 */
export const CHROMA_FINE_STRIDE = 2;

/* exp 查表：组合循环里每像素一次 Math.exp(beta·C) 是实打实的开销。
 * β ≤ 0.9，β·C 的标准差就是 β，取 [-4,4] 覆盖 4σ 以上；
 * 1024 点线性插值的相对误差 ≈ h²/8 = 7.6e-6，远小于颗粒自身的统计涨落。 */
const EXP_N = 1024, EXP_LO = -4, EXP_HI = 4;
const EXP_LUT = new Float32Array(EXP_N + 1);
for (let i = 0; i <= EXP_N; i++) EXP_LUT[i] = Math.exp(EXP_LO + (EXP_HI - EXP_LO) * i / EXP_N);
const EXP_STEP = (EXP_HI - EXP_LO) / EXP_N;

/** 细颗粒核宽与颗粒半径的比例。由频谱测试标定：cut = 0.1325/σ_g = 0.265/r ≈ 1/(2d) */
export const SIGMA_GRAIN_RATIO = 0.5;

/**
 * 团簇场的核宽。这是「团簇度」滑块的物理语义所在。
 *
 * 【为什么是 (2 + 4c) 而不是 (2 + 8c)】
 * 视觉核对发现 c=0.6 时团簇尺度达到颗粒半径的 7.6 倍，画面呈现的是大块「云斑」
 * 而不是胶片颗粒。真实胶片的团簇尺度约为颗粒的 2–4 倍。收敛到 (2+4c) 后，
 * c∈[0,1] 对应倍数 2–6，默认取 0.35（3.4 倍）落在合理区间。
 *
 * 注意这个尺度同时决定颗粒场方差的可复现精度：σ_c 越大，单块内独立样本越少。
 */
export function clusterSigma(radiusPx, clumping) {
  // 用**有效**颗粒半径：细颗粒的 σ_g 有 0.35 的下限（等价于半径下限 0.7），
  // 团簇尺度必须跟着同一个下限走，否则两者脱钩。
  // 【实测的代价】Ektar 100 在 4×5 上标称 μr=0.45：不设下限时 σ_c=1.40，
  //   包络只能全分辨率算（KT=11，通用路径），实测 68 ns/px —— 比默认参数还慢一倍，
  //   而它的效果几乎不可见（幅度 0.0034）。设下限后 σ_c=2.18、stride=2，
  //   成本降到与默认同级。对 μr ≥ 0.7 的所有情形**结果完全不变**。
  const mr = Math.max(radiusPx, 2 * SIGMA_GRAIN_RATIO); // 2×0.5 = 0.7
  const sg = mr * SIGMA_GRAIN_RATIO;
  return Math.max(sg * 1.5, mr * (2 + 4 * clumping));
}

/**
 * 团簇包络的降采样倍率：让粗网格上的 σ 落在 ~2 px。
 *
 * 引入胶片预设后颗粒半径跨度很大（Ektar 100 在 4×5 上 μr≈0.7，
 * Delta 3200 在 16mm 上 μr≈14）。固定 stride=4 时后者的 σ_c 会到 60+ px、
 * 核长 360 抽头，性能直接崩；而前者又会被过度降采样、丢掉团簇结构。
 *
 * 默认参数（μr=2、c=0.35 → σ_c=6.8）给出 4，与历史常量 ENVELOPE_STRIDE 一致，
 * 所以既有验收基线不动。
 */
export function autoEnvelopeStride(radiusPx, clumping) {
  const sc = clusterSigma(radiusPx, clumping);
  return Math.max(1, Math.min(64, Math.ceil(sc / 2.0)));
}

/**
 * 细颗粒场的降采样倍率：只在 **σ 很大时**才降采样。
 *
 * 依据：颗粒场的 −3dB 截止是 f_c = 0.1325/σ（已实测 2.2% 精度内）。
 * 粗网格的 Nyquist 是 0.5/s，要无混叠地表示 f_c 需要 s < 3.8σ。
 * 取 s = round(σ/2) 留了近 8 倍余量。
 *
 * 【为什么不能一视同仁地降采样】σ=1（标准 135 颗粒）时 s 会是 2，
 * 那会直接把可见的颗粒纹理抹掉一半。这里的规则在 σ<3 时恒等于 1，
 * 因此既有行为完全不变；只有「推三档的 Portra」或「16mm 上的 Delta 3200」
 * 这类 σ 到 4~7 的极端情况才会降到 2~4 档，避免核长从 27 涨到 50+ 抽头。
 */
export function autoFineStride(sigma) {
  return Math.max(1, Math.min(4, Math.round(sigma / 2)));
}

/**
 * 生成颗粒场：零均值、单位方差、具备团簇结构。
 *
 * 团簇用**乘性对数正态调制**实现，而不是设计文档初稿里的高斯差分（DoG）。
 * 原因见文档勘误：DoG 的功率谱峰值落在远低于颗粒尺度的频率上，与颗粒的实测
 * 频谱不符；且 σ₂=σ₁(1+4c) 在 c=0 时退化为零核。乘性调制才对应「某些区域
 * 颗粒密、某些区域稀」这一真实的团簇观感。
 *
 * 归一化是解析的：
 *   E[G]   = E[F]·E[e^{βC}] = 0
 *   Var(G) = E[F²]·E[e^{2βC}] / e^{2β²} = e^{2β²}/e^{2β²} = 1
 */
/**
 * 细颗粒场（不含包络）。
 * 抽出来单独导出的理由见 applyGrain 的注释 —— 包络要全通道共用。
 */
export function generateFineField({
  width, height, seed = 1, stream = 0, sigma, originX = 0, originY = 0, stride = 1,
}) {
  return stride > 1
    ? decimatedNoise({ width, height, seed, stream, sigma, originX, originY, stride })
    : filteredNoise({ width, height, seed, stream, sigma, originX, originY });
}

/**
 * 团簇包络（低频强度调制场）。
 * 返回 null 表示「团簇度为 0」，调用方应直接用细颗粒场。
 */
export function generateEnvelope({
  width, height, seed = 1, stream = 0, radiusPx, clumping = 0.35,
  originX = 0, originY = 0, envelopeStride = ENVELOPE_STRIDE,
}) {
  if (clumping <= 0.001) return null;
  const sc = clusterSigma(radiusPx, clumping);
  return decimatedNoise({
    width, height, seed, stream: (stream ^ 0x1f123bb5) >>> 0, sigma: sc,
    originX, originY, stride: envelopeStride,
  });
}

/**
 * 组合：out = fine · exp(β·envelope) / exp(β²)。
 * envelope 为 null 时退化为原样返回细颗粒场。exp 走查表。
 */
export function combineGrain(fine, envelope, beta, out) {
  out = out || new Float32Array(fine.length);
  if (!envelope) { out.set(fine); return out; }
  const inv = 1 / Math.exp(beta * beta);
  for (let i = 0; i < out.length; i++) {
    let t = (beta * envelope[i] - EXP_LO) / EXP_STEP;
    if (t < 0) t = 0; else if (t > EXP_N - 1) t = EXP_N - 1;
    const j = t | 0;
    out[i] = fine[i] * (EXP_LUT[j] + (EXP_LUT[j + 1] - EXP_LUT[j]) * (t - j)) * inv;
  }
  return out;
}

/**
 * 单通道颗粒场 = 细颗粒 × 包络。
 * 允许传入预计算的 envelope，供 applyGrain 让四个通道**共用同一份包络**。
 */
export function generateGrainField({
  width, height, seed = 1, stream = 0, radiusPx, clumping = 0.35,
  originX = 0, originY = 0,
  fineStride = 1, envelopeStride = null, envelope = undefined,
}) {
  const sg = Math.max(0.35, radiusPx * SIGMA_GRAIN_RATIO);
  // 取调用方给定的倍率与自动倍率的较大者：σ 大时自动降采样，
  // 调用方仍可显式要求更粗（色度场就是这么做的）。
  const fs = Math.max(fineStride, autoFineStride(sg));
  const fine = generateFineField({
    width, height, seed, stream, sigma: sg, originX, originY, stride: fs,
  });
  if (clumping <= 0.001) return fine;
  const es = (envelopeStride === null || envelopeStride === undefined || envelopeStride === 'auto')
    ? autoEnvelopeStride(radiusPx, clumping)
    : Math.max(1, Math.round(envelopeStride));
  const wide = envelope !== undefined ? envelope : generateEnvelope({
    width, height, seed, stream, radiusPx, clumping, originX, originY, envelopeStride: es,
  });
  /* 包络对比度上限（「高 ISO 不均匀」修复）：β = 0.9c 在 c > 0.5 时进入
     对数正态的重尾区 —— 部分热斑幅度达邻域的 2~3 倍，低强度下读作自然的
     胶片团块，高强度下就是显眼的脏斑。β=0.45 对应 e^β ≈ 1.57 的中位偏移，
     团簇感保留、重尾收敛。归一化 e^{β²} 对任意 β 解析精确，方差不受影响。 */
  return combineGrain(fine, wide, Math.min(0.45, 0.9 * clumping), null);
}

/* ================================================================
   4. 幅度曲线（L1 预计算）
   ================================================================ */

/**
 * 归一化幅度曲线 A(u)，峰值 1，两端严格为 0。
 *
 *   p = u^γ,  γ = ln(0.5)/ln(uPeak)
 *   A(u) = 2·√(p(1−p))
 *
 * 形式来自布尔模型的覆盖波动 Var = p(1−p)（研究报告 §4.7 事实 C）。
 *
 * 【为什么用幂次而不是 u 的线性缩放】
 * 设计文档原稿写的是 p = min(1, k·u)，这会让 p(1) = k < 1，
 * 于是 A(1) = 2√(k(1−k)) ≠ 0 —— 纯白区域会长出颗粒，与
 * 「死黑与死白干净」的结论直接冲突（实测纯白 std = 0.0071）。
 * 改用幂次映射后 p(0)=0、p(1)=1、峰值精确落在 uPeak，三处都满足。
 *
 * @param uPeak 颗粒最强的灰度位置（研究报告给出 0.55–0.65，默认 0.62）
 */
export function gammaForPeak(uPeak) {
  const p = Math.min(0.95, Math.max(0.05, uPeak));
  return Math.log(0.5) / Math.log(p);
}

export function amplitudeAt(u, uPeak = 0.62) {
  const t = u <= 0 ? 0 : u >= 1 ? 1 : u;
  const p = Math.pow(t, gammaForPeak(uPeak));
  const base = 2 * Math.sqrt(Math.max(0, p * (1 - p)));
  /* ★ 高光侧非对称衰减（「高 ISO 全画面发脏」修复之三）。
     【为什么】p(1−p) 是对称的，高光侧衰减太慢 —— A(0.9) = 70% 峰值，
     意味着白墙、白桌布上也长着接近峰值的颗粒，整张图像糊了一层。
     【物理依据】正像的高光来自负片的肩部低密度区，可显影的颗粒很少，
     颗粒性应当很快消失；阴影侧（负片高密度）颗粒团簇保留 —— 真实扫描件
     的阴影发闷、高光干净，正是不对称的。
     【形状】p ≤ 0.5 不动；p > 0.5 乘 ((1−p)/0.5)^B。
     峰值仍在 uPeak（p=0.5 处连续）；A(1)=0 严格保持。 */
  if (p > 0.5) {
    return base * Math.pow((1 - p) / 0.5, HIGHLIGHT_TAPER_B);
  }
  return base;
}

/** 高光侧衰减指数。0.8 → A(0.8)=0.56、A(0.9)=0.26、A(0.95)=0.11（峰值=1）。 */
export const HIGHLIGHT_TAPER_B = 0.8;

/* ================================================================
   深度软膝（「高 ISO 黑泥点」修复之一）
   ----------------------------------------------------------------
   线性域注入的高斯噪声在暗处会跌破 0，硬钳位把噪声整流成单边「只变暗」
   的尖峰 —— 高强度下暗区出现一颗颗黑泥点，且永不配对亮斑。
   对策：按像素衰减噪声幅度 att = min(1, l/(KNEE·σ·|g|))。
   【数学性质】注入量 = att·σ·g = min(σg, (l/K)·sign(g)) ⇒ 绝对值 ≤ l/K，
   因此**数学上不可能再触发钳位**（KNEE=3.5 时最深只到 −l/3.5）。
   【统计性质】att 只依赖 |g|（偶函数），E[att·g] ≈ 0（g 近对称），
   均值保持不被破坏；方差变为 σ²·E[min(g², (l/K)²)]，解析式见 kneeVarFactor。
   ================================================================ */
export const NOISE_KNEE = 3.5;
/** 1/NOISE_KNEE 预烘成常数 —— 软膝用「幅度上限 min 选择」实现，免掉每像素除法。 */
export const INV_NOISE_KNEE = 1 / NOISE_KNEE;

/** E[min(g², t²)]，g ~ N(0,1)。噪声经软膝后的方差缩减因子（t = l/(KNEE·σ)）。 */
export function kneeVarFactor(t) {
  if (t >= 6) return 1;
  if (t <= 0) return 0;
  const phi = Math.exp(-0.5 * t * t) / Math.sqrt(2 * Math.PI);
  // Φ(t)：erf 的有理近似（A&S 7.1.26，|误差| < 1.5e-7）
  const z = t / Math.SQRT2;
  const s = 1 / (1 + 0.3275911 * z);
  const erf = 1 - ((((1.061405429 * s - 1.453152027) * s + 1.421413741) * s - 0.284496736) * s + 0.254829592) * s * Math.exp(-z * z);
  const Phi = 0.5 * (1 + erf);
  // 2∫₀ᵗ x²φdx = 2Φ(t) − 1 − 2tφ(t)；再加尾部 t²·2(1−Φ(t))
  return 2 * Phi - 1 - 2 * t * phi + 2 * t * t * (1 - Phi);
}

/**
 * 构建逐像素查找表（L1 预计算的产物）。三张表，全部以感知域灰度 v 为索引。
 *
 *   amp[i]    = A(v)·S                感知域的颗粒标准差（用户看到的量）
 *   sigLin[i] = A(v)·S / g'(l)        线性域的标准差（真正注入的量）
 *   corr[i]   = ½·g''(l)·sigLin²      线性→感知的二阶偏置（需从输出里减掉）
 *
 * 【为什么必须区分 amp 与 sigLin】
 * 曲线定义在感知域，注入发生在线性域，两者差一个雅可比 g'(l)。
 * 把感知域幅度直接当线性域幅度用，会让实测的感知颗粒强度带上一个 g'(l) 因子，
 * 于是「越暗颗粒越强」，与中间调峰值的结论完全相反——这是实现中最容易犯的错。
 */
export function buildAmplitudeLUTs({ strength = 0.03, uPeak = 0.62, n = 1024 } = {}) {
  const amp = new Float32Array(n);
  const sigLin = new Float32Array(n);
  const corr = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const a = amplitudeAt(u, uPeak) * strength;
    amp[i] = a;
    const g1 = Math.max(jacobianAtV(u), 1e-6);
    const s = a / g1;
    sigLin[i] = s;
    // 二阶偏置补偿系数。
    // 【为什么最后还要除以 g'(l)】补偿项是**感知域**的偏移量 ½g''(l)σ²，
    // 但要把它当作**线性域**的偏移 b 去加。加 b 之后的感知域均值变化是
    //   E[v'] − v ≈ g'(l)·b + ½g''(l)σ²
    // 令其为零 ⇒ b = −½g''(l)σ² / g'(l)。漏掉这个 1/g'(l) 会系统性过度补偿
    //   （实测：跨种子平均后残差为正且随强度增长，消掉 130%~140% 而非 100%）。
    corr[i] = 0.5 * curvatureAtV(u) * s * s / g1;
  }
  return { amp, sigLin, corr };
}

/* ================================================================
   5. 合成（L3）
   ================================================================ */

const CHANNEL_STREAMS = [1, 2, 3]; // R / G / B 的色度流编号

/**
 * 通道模板的**亮度加权 rms**（模板先归一化到最大通道 = 1）。
 *
 * 用途：把 `strength` 归一化到「亮度域的颗粒幅度」，这样调整通道的蓝偏置时
 * 不会顺带改变整幅图的颗粒总强度。
 * 导出它是为了让调用方（测试、面板）能算出实际注入幅度，而不是把常数藏在函数里。
 */
export function lumTemplateNorm(weights) {
  const w = weights || [1, 1, 1];
  const wMax = Math.max(...w) || 1;
  const w0 = w.map((x) => x / wMax);
  return Math.sqrt(
    0.2126 * 0.2126 * w0[0] * w0[0] +
    0.7152 * 0.7152 * w0[1] * w0[1] +
    0.0722 * 0.0722 * w0[2] * w0[2]
  ) || 1;
}

/**
 * 把颗粒加到感知域 RGB 图像上（就地修改）。
 * rgb: Float32Array(width*height*3)，值域 [0,1]，sRGB 编码值
 */
export function applyGrain(rgb, width, height, {
  seed = 1,
  radiusPx = 2.0,
  clumping = 0.5,
  strength = 0.014,
  uPeak = 0.62,
  // 色度功率占比。**默认值 0.025 是感知定标**：真实胶片确实有色度颗粒，
  // 但它必须弱到「凑近看得出、正常看只觉得是颗粒质感」。
  lumaChroma = 0.025,
  // 消色（密度）分量的逐通道幅度模板，归一化到最大通道 = 1。
  //
  // 【为什么是近中性的 [0.90, 0.95, 1.00]，而不是报告里的 0.025:0.010:0.009】
  // 那组数是柯达 VISION3 500T **三层各自在高密度处的 RMS 颗粒度峰值** ——
  // 三层的密度-曝光曲线不同、峰值出现在不同曝光点，所以它**不是**「同一曝光下三个
  // 输出通道的噪声比」。把它当逐通道幅度用，等于让每一个颗粒事件都偏向蓝色，
  // 也就是把颗粒本身染色。
  // 【实测证据】把它按 [0.36,0.40,1.00] 用时，即便把色度分量完全关掉（lumaChroma=0），
  // G−B 仍有 1.68 色阶的波动 vs 亮度 3.56 —— 色度噪声的 97% 来自这个模板偏置，
  // 而不是来自色度场。调整尺寸/团簇度时那些蓝色斑块就是这么来的（用户报的「彩色脏污」）。
  // 这里只保留 1.11:1 的轻微蓝偏置（真实观察里蓝通道确实更噪，但不该是 2.78 倍）。
  // **精确比值必须等真实扫描件标定**（研究报告附录 A.5 的数据缺口）。
  weights = [0.90, 0.95, 1.00],
  mono = false,
  // 色度颗粒略粗于亮度颗粒（染料云尺度大于银颗粒），但**不能太粗**：
  // 人眼对低频色度反而更敏感，大块颜色会读成「脏」，细密的色噪才会融进颗粒质感。
  // 早期取 2.6 是判断反了，实测在极端参数下会形成可见的彩色斑块。
  chromaRadiusScale = 1.3,
  compensate = true,
  // 深度软膝开关。关掉仅用于基准对照（定位性能开销），产品路径必须为 true。
  noiseKnee = true,
  originX = 0, originY = 0,
  fineStride = 1, envelopeStride = null,
  chromaFineStride = CHROMA_FINE_STRIDE,
  envelopeMode = 'shared',
} = {}) {
  // ★ sigLin/corr 必须与 S2L/L2S **同分辨率**（N_LUT）：
  //   逐通道修复后三者共用同一个插值索引 iv。默认 1024 的表配 2048 的索引会
  //   越界读到 undefined → NaN（第一版逐通道实现就栽在这里，整个补偿列变 NaN）。
  const { sigLin, corr } = buildAmplitudeLUTs({ strength, uPeak, n: N_LUT });
  const nPix = width * height;

  // 包络倍率默认按颗粒尺度自动定（见 autoEnvelopeStride）。传具体数字可覆盖。
  const envStride = (envelopeStride === null || envelopeStride === undefined || envelopeStride === 'auto')
    ? autoEnvelopeStride(radiusPx, clumping)
    : Math.max(1, Math.round(envelopeStride));

  // originX/originY 让本函数能在**行带分段**里逐带调用，且结果与整图一次算完全一致
  // （颗粒场的坐标寻址哈希 + halo 保证）。这是「一次读 + 内存分段 + 一次写」的基础。
  //
  // ★ 团簇包络默认**全通道共用一份**（envelopeMode='shared'）。
  // 【原先为什么错】四个场各带一个独立包络 ⇒ 每个颜色通道的颗粒强度被**不同的**
  //   大尺度场调制 ⇒ 放大尺寸或提高团簇度时出现有颜色的云斑（「彩色脏污」）。
  // 【物理依据】胶片里那团银颗粒是同一份，三层染料云跟随它；肉眼看到的团簇是**消色**的。
  //   所以包络取亮度场的尺度（σ_c = μr·(2+4c)）一份，四个通道共享；
  //   颜色差异只由**各通道独立的细颗粒场**承担 —— 那是染料云层面的差异，尺度小、对比度低。
  // 【envelopeMode='perChannel'】只用于诊断脚本复现历史行为做 A/B，不要在产品里用。
  const sharedEnv = envelopeMode === 'shared'
    ? generateEnvelope({ width, height, seed, stream: 0, radiusPx, clumping, originX, originY, envelopeStride: envStride })
    : undefined;

  const luma = generateGrainField({
    width, height, seed, stream: 0, radiusPx, clumping,
    originX, originY, fineStride, envelopeStride: envStride, envelope: sharedEnv,
  });

  const chroma = [[], [], []];
  if (!mono && lumaChroma > 0.001) {
    // 色度细场允许更粗的降采样：色度颗粒本身 σ_g 就是亮度的 1.8 倍、对比度又低
    const cs = Math.max(fineStride, chromaFineStride);
    for (let c = 0; c < 3; c++) {
      chroma[c] = generateGrainField({
        width, height, seed, stream: CHANNEL_STREAMS[c],
        radiusPx: radiusPx * chromaRadiusScale, clumping,
        originX, originY, fineStride: cs, envelopeStride, envelope: sharedEnv,
      });
    }
  }

  const wL = Math.sqrt(Math.max(0, 1 - lumaChroma));
  const wC = Math.sqrt(Math.max(0, lumaChroma));
  const wMax = Math.max(...weights) || 1;
  // lumW 只作用于**消色（密度）分量**；色度分量**不**乘这个比值。
  // 【为什么】逐通道幅度比乘在独立色度场上，会把通道差平方级放大：
  //   色度对 R−G 的贡献 ∝ 2·wC²（两通道独立），而消色分量的通道差只贡献 ∝ (Δw)²。
  //   早期版本两处都乘，实测 R−G 色度噪声 8.06 色阶 vs 亮度 4.41 —— 颜色噪声是亮度的 1.8 倍，
  //   那就是「彩色脏污」。（v0.2 的 bug，已修）
  //
  // 归一化：把通道模板的**亮度加权 rms 归到 1**，于是 `strength` 有干净的含义 ——
  // 「亮度域的颗粒幅度」。否则通道模板的绝对值会顺带改变颗粒总强度，
  // 调整蓝偏置时会连带把整幅图的颗粒一起调粗（改这段时踩过一次：亮度从 4.41 跳到 7.76）。
  const lumW0 = weights.map((w) => w / wMax);
  const lumRef = lumTemplateNorm(weights);
  const lumW = lumW0.map((w) => w / lumRef);
  // 每通道的总相对方差 = lumW²·wL² + wC²，二阶偏置补偿要按它缩放
  const vc = lumW.map((w) => w * w * wL * wL + wC * wC);

  // 【这里的查表为什么是内联的】这是全管线最热的循环（每像素 3 通道 × 2 次查表）。
  // 早期版本调用 srgbToLinear/linearToSrgb，配合 Float64 表（每张 32 KB，装不进 L1），
  // 实测 37 ns/px。改成内联 lerp + Float32 小表后见 tools/bench-l3.mjs 的对比。
  const NL1 = N_LUT - 1;
  const hasChroma = chroma[0].length > 0;

  for (let i = 0; i < nPix; i++) {
    const base = i * 3;
    // 纯黑早退：A(u) 只在 u=0 处为 0，三通道全黑才确定无噪声
    if (rgb[base] <= 0 && rgb[base + 1] <= 0 && rgb[base + 2] <= 0) continue;

    for (let c = 0; c < 3; c++) {
      const v = rgb[base + c];
      // 消色分量按通道幅度比加权；色度分量平权（理由见上方 lumW 的注释）
      let g = luma[i] * (lumW[c] * wL);
      if (hasChroma) g += chroma[c][i] * wC;

      /* ★★★ 逐通道索引（「暖色调红点」修复的核心）★★★
         【原先为什么错】idx 只取红通道，算出的一个 sigLin 被三通道共用。
         sigLin(u) = A(u)·S / g'(l) 只在**索引点 u** 上自洽；把这个 σ 灌进
         亮度为 v_c 的另一个通道，感知噪声变成
             g'(l_c) / g'(l_red) · A(v_red) · S
         暖色像素（红亮蓝暗，如 R=.55 G=.35 B=.25）里：
           蓝通道实际得到 2.39·S，而它应有的只有 0.68·S —— 过噪 3.5 倍（绿 2 倍）；
           σ_lin 占蓝通道线性值的 71%，频繁钳到 l≤0；
           高斯噪声被钳位整流成单边尖峰，蓝=0 即最饱和的红
           —— 这就是截图里「团簇小红点」的来源（蓝通道噪声在暖色里的观感）。
         【物理依据】三层染料各自响应**自己的曝光**：该层密度→0 时波动也→0
         （布尔模型 Var ∝ p(1−p)）。逐通道索引后 A(v)→0 自动关掉暗通道的
         噪声，钳位问题随之消失，不需要任何软钳补丁。
         【为什么测试没抓到】34 项验收全用灰图（R=G=B），灰图下红通道索引
         恰好完全正确；此 bug 只在通道离散度大的饱和色上出现。 */
      const tv = v <= 0 ? 0 : (v >= 1 ? 1 : v);
      const fv = tv * NL1;
      const iv = fv < NL1 ? (fv | 0) : (NL1 - 1);
      const av = fv - iv;

      const sig = sigLin[iv] + (sigLin[iv + 1] - sigLin[iv]) * av;
      if (sig === 0) continue;   // 纯黑/纯白通道不生成噪声

      let l = S2L[iv] + (S2L[iv + 1] - S2L[iv]) * av;

      /* ★ 深度软膝（「高 ISO 黑泥点」修复之一）。
         att = min(1, l/(KNEE·σ·|g|)) ⇒ 注入量 |att·σ·g| ≤ l/KNEE，
         数学上不可能再跌破 0 —— 硬钳位的单边整流（只变暗的黑泥点）被消灭。
         att 只依赖 |g|（偶函数），E[att·g] ≈ 0，均值保持不破坏。 */

      /* 软膝：把注入量的**绝对值**限制在 l/KNEE 以内。
         数学上与 att = min(1, l/(K·σ·|g|)) 完全等价（cap/(σ|g|) = att），
         但用「乘法算上限 + min 选择」实现，**省掉每像素每通道一次除法**
         —— 除法在数据相关的分支里实测要 0.7 s / 24 MP。 */
      let inj = sig * g;
      if (noiseKnee) {
        const cap = l * INV_NOISE_KNEE;
        const mag = inj < 0 ? -inj : inj;
        if (mag > cap) inj = inj < 0 ? -cap : cap;
      }

      // 二阶偏置补偿。σ² 用的是**未衰减**的 sigLin²，而软膝区间实际方差更小，
      // 严格来说补偿应乘一个缩减因子 E[min(g²,t²)]。
      // 【为什么最后没乘】实测那个因子（即便内联成「乘法取下标 + lerp」）在
      //   24MP 上要 ~1 s —— 它落在每通道的依赖链上，代价远超收益：补偿本身
      //   在高 ISO 暗部也只有零点几色阶的量级，乘 0.19~1 的因子最多差 0.2 色阶，
      //   而测试 5/15 的均值残差在**不乘**的情况下仍满足阈值（见验收输出）。
      //   这里选择「简单且在验收范围内正确」，并把结论写在测试里。
      if (compensate) {
        const cv = corr[iv] + (corr[iv + 1] - corr[iv]) * av;
        l -= cv * vc[c];
      }
      l += inj;

      const tl = l <= 0 ? 0 : (l >= 1 ? 1 : l);
      const fl = tl * NL1;
      const il = fl < NL1 ? (fl | 0) : (NL1 - 1);
      const al = fl - il;
      rgb[base + c] = L2S[il] + (L2S[il + 1] - L2S[il]) * al;
    }
  }
  return rgb;
}

/* ================================================================
   6. 工具
   ================================================================ */

export function makeStaircase(width, height, levels) {
  const img = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const band = Math.min(levels - 1, Math.floor((x / width) * levels));
      const v = band / (levels - 1);
      const b = (y * width + x) * 3;
      img[b] = img[b + 1] = img[b + 2] = v;
    }
  }
  return img;
}

export function makeFlat(width, height, v) {
  const img = new Float32Array(width * height * 3);
  img.fill(v);
  return img;
}

export function stats(arr, stride = 1, offset = 0) {
  let n = 0, s = 0, s2 = 0;
  for (let i = offset; i < arr.length; i += stride) { s += arr[i]; s2 += arr[i] * arr[i]; n++; }
  const mean = s / n;
  return { mean, std: Math.sqrt(Math.max(0, s2 / n - mean * mean)), n };
}
