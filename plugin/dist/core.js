var SHC = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // core/plugin-entry.mjs
  var plugin_entry_exports = {};
  __export(plugin_entry_exports, {
    CHROMA_FINE_STRIDE: () => CHROMA_FINE_STRIDE,
    COLORWAYS: () => COLORWAYS,
    ENVELOPE_STRIDE: () => ENVELOPE_STRIDE,
    FILM_STOCKS: () => FILM_STOCKS,
    GAUGES: () => GAUGES,
    SIGMA_GRAIN_RATIO: () => SIGMA_GRAIN_RATIO,
    STOPS: () => STOPS,
    allocBuffer: () => allocBuffer,
    amplitudeAt: () => amplitudeAt,
    applyGrain: () => applyGrain,
    applyGrainBanded: () => applyGrainBanded,
    autoEnvelopeStride: () => autoEnvelopeStride,
    autoFineStride: () => autoFineStride,
    badgeText: () => badgeText,
    buildAmplitudeLUTs: () => buildAmplitudeLUTs,
    clusterSigma: () => clusterSigma,
    colorwayCensus: () => colorwayCensus,
    colorwayFor: () => colorwayFor,
    colorwayOf: () => colorwayOf,
    decodePixels: () => decodePixels,
    depthMax: () => depthMax,
    encodePNG: () => encodePNG,
    encodePixels: () => encodePixels,
    equivalentIso: () => equivalentIso,
    filmById: () => filmById,
    filmsByGroup: () => filmsByGroup,
    gammaForPeak: () => gammaForPeak,
    gaugeById: () => gaugeById,
    generateGrainField: () => generateGrainField,
    grainIndex: () => grainIndex,
    groupKind: () => groupKind,
    packRGB8: () => packRGB8,
    parseBitDepth: () => parseBitDepth,
    pinMarkup: () => pinMarkup,
    pngToDataUrl: () => pngToDataUrl,
    processImage: () => processImage,
    resolveFilmParams: () => resolveFilmParams
  });

  // core/grain.mjs
  var N_LUT = 2048;
  var S2L = new Float32Array(N_LUT);
  var L2S = new Float32Array(N_LUT);
  (() => {
    for (let i = 0; i < N_LUT; i++) {
      const v = i / (N_LUT - 1);
      S2L[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      const l = i / (N_LUT - 1);
      L2S[i] = l <= 31308e-7 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
    }
  })();
  function lutLerp(table, x) {
    const t = x <= 0 ? 0 : x >= 1 ? 1 : x;
    const f = t * (N_LUT - 1);
    const i = Math.min(N_LUT - 2, f | 0);
    const a = f - i;
    return table[i] * (1 - a) + table[i + 1] * a;
  }
  var srgbToLinear = (v) => lutLerp(S2L, v);
  var linearToSrgb = (l) => lutLerp(L2S, l);
  function jacobianAtV(v) {
    const l = srgbToLinear(v);
    const e = Math.max(1e-6, l * 1e-3);
    const l0 = Math.max(0, l - e);
    const l1 = Math.min(1, l + e);
    if (l1 <= l0) return 12.92;
    return (linearToSrgb(l1) - linearToSrgb(l0)) / (l1 - l0);
  }
  function curvatureAtV(v) {
    const l = srgbToLinear(v);
    if (l <= 31308e-7) return 0;
    return -0.2564236 * Math.pow(l, -1.5833333);
  }
  function hash32(seed, stream, x, y) {
    let h = (seed ^ 2654435761) >>> 0;
    h = Math.imul(h ^ x >>> 0, 2246822507) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h ^ y >>> 0, 3266489909) >>> 0;
    h ^= h >>> 16;
    h = Math.imul(h ^ stream >>> 0, 668265263) >>> 0;
    h ^= h >>> 15;
    h ^= h >>> 16;
    h = Math.imul(h, 2146121005) >>> 0;
    h ^= h >>> 15;
    h = Math.imul(h, 2221713035) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
  }
  var uniformPM1 = (seed, stream, x, y) => hash32(seed, stream, x, y) / 2147483648 - 1;
  function unitNoise(seed, stream, x, y) {
    return uniformPM1(seed, stream, x, y) + uniformPM1(seed, (stream ^ 1542469173) >>> 0, x + 2654435761 | 0, y) + uniformPM1(seed, stream, x ^ 668265263, y + 461845907 | 0);
  }
  function gaussianKernel1D(sigma) {
    const R2 = Math.max(1, Math.ceil(3 * sigma));
    const n = 2 * R2 + 1;
    const k = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const d = i - R2;
      k[i] = Math.exp(-(d * d) / (2 * sigma * sigma));
    }
    return { k, R: R2 };
  }
  function convRow(dst, src, off, x0, x1, nk, R2) {
    const KT = nk.length;
    if (KT === 7) {
      const k0 = nk[0], k1 = nk[1], k2 = nk[2], k3 = nk[3], k4 = nk[4], k5 = nk[5], k6 = nk[6];
      for (let x = x0; x < x1; x++) {
        const b = off + x - 3;
        dst[off + x] = k0 * src[b] + k1 * src[b + 1] + k2 * src[b + 2] + k3 * src[b + 3] + k4 * src[b + 4] + k5 * src[b + 5] + k6 * src[b + 6];
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
        dst[off + x] = k0 * src[b] + k1 * src[b + 1] + k2 * src[b + 2] + k3 * src[b + 3] + k4 * src[b + 4] + k5 * src[b + 5] + k6 * src[b + 6] + k7 * src[b + 7] + k8 * src[b + 8] + k9 * src[b + 9] + k10 * src[b + 10] + k11 * src[b + 11] + k12 * src[b + 12];
      }
      return;
    }
    for (let x = x0; x < x1; x++) {
      let a = 0;
      const b = off + x - R2;
      for (let i = 0; i < KT; i++) a += nk[i] * src[b + i];
      dst[off + x] = a;
    }
  }
  function convCol(dst, src, dstBase, srcBase, n, W, nk, R2) {
    const KT = nk.length;
    if (KT === 7) {
      const k0 = nk[0], k1 = nk[1], k2 = nk[2], k3 = nk[3], k4 = nk[4], k5 = nk[5], k6 = nk[6];
      for (let x = 0; x < n; x++) {
        const b = srcBase + x;
        dst[dstBase + x] = k0 * src[b] + k1 * src[b + W] + k2 * src[b + 2 * W] + k3 * src[b + 3 * W] + k4 * src[b + 4 * W] + k5 * src[b + 5 * W] + k6 * src[b + 6 * W];
      }
      return;
    }
    if (KT === 5) {
      const k0 = nk[0], k1 = nk[1], k2 = nk[2], k3 = nk[3], k4 = nk[4];
      for (let x = 0; x < n; x++) {
        const b = srcBase + x;
        dst[dstBase + x] = k0 * src[b] + k1 * src[b + W] + k2 * src[b + 2 * W] + k3 * src[b + 3 * W] + k4 * src[b + 4 * W];
      }
      return;
    }
    if (KT === 13) {
      const k0 = nk[0], k1 = nk[1], k2 = nk[2], k3 = nk[3], k4 = nk[4], k5 = nk[5], k6 = nk[6];
      const k7 = nk[7], k8 = nk[8], k9 = nk[9], k10 = nk[10], k11 = nk[11], k12 = nk[12];
      for (let x = 0; x < n; x++) {
        const b = srcBase + x;
        dst[dstBase + x] = k0 * src[b] + k1 * src[b + W] + k2 * src[b + 2 * W] + k3 * src[b + 3 * W] + k4 * src[b + 4 * W] + k5 * src[b + 5 * W] + k6 * src[b + 6 * W] + k7 * src[b + 7 * W] + k8 * src[b + 8 * W] + k9 * src[b + 9 * W] + k10 * src[b + 10 * W] + k11 * src[b + 11 * W] + k12 * src[b + 12 * W];
      }
      return;
    }
    for (let x = 0; x < n; x++) {
      let a = 0;
      let idx = srcBase + x;
      for (let i = 0; i < KT; i++) {
        a += nk[i] * src[idx];
        idx += W;
      }
      dst[dstBase + x] = a;
    }
  }
  function filteredNoise({ width, height, seed, stream, sigma, originX = 0, originY = 0 }) {
    const { k, R: R2 } = gaussianKernel1D(sigma);
    const KT = k.length;
    let s2 = 0;
    for (let i = 0; i < KT; i++) s2 += k[i] * k[i];
    s2 = Math.sqrt(s2) || 1;
    const nk = new Float32Array(KT);
    for (let i = 0; i < KT; i++) nk[i] = k[i] / s2;
    const W = width + 2 * R2;
    const H = height + 2 * R2;
    const raw = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const off = y * W;
      const gy = y - R2 + originY;
      for (let x = 0; x < W; x++) raw[off + x] = unitNoise(seed, stream, x - R2 + originX, gy);
    }
    const row = new Float32Array(W * H);
    const xIntStart = R2;
    const xIntEnd = W - R2;
    for (let y = 0; y < H; y++) {
      const off = y * W;
      for (let x = 0; x < xIntStart; x++) {
        let a = 0;
        for (let i = 0; i < KT; i++) {
          let xx = x + i - R2;
          if (xx < 0) xx = 0;
          a += nk[i] * raw[off + xx];
        }
        row[off + x] = a;
      }
      convRow(row, raw, off, xIntStart, xIntEnd, nk, R2);
      for (let x = xIntEnd; x < W; x++) {
        let a = 0;
        for (let i = 0; i < KT; i++) {
          let xx = x + i - R2;
          if (xx >= W) xx = W - 1;
          a += nk[i] * raw[off + xx];
        }
        row[off + x] = a;
      }
    }
    const out = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      convCol(out, row, y * width, y * W + R2, width, W, nk, R2);
    }
    return out;
  }
  function decimatedNoise({
    width,
    height,
    seed,
    stream,
    sigma,
    originX = 0,
    originY = 0,
    stride = 4
  }) {
    const s = Math.max(1, Math.round(stride));
    if (s <= 1) return filteredNoise({ width, height, seed, stream, sigma, originX, originY });
    const sigmaC = sigma / s;
    const mod = (a, n) => (a % n + n) % n;
    const ox = mod(originX, s);
    const oy = mod(originY, s);
    const cBaseX = Math.floor(originX / s);
    const cBaseY = Math.floor(originY / s);
    const cw = Math.floor((ox + width - 1) / s) + 2;
    const ch = Math.floor((oy + height - 1) / s) + 2;
    const coarse = filteredNoise({
      width: cw,
      height: ch,
      seed,
      stream,
      sigma: sigmaC,
      originX: cBaseX,
      originY: cBaseY
    });
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
        const v = (u0 * coarse[rowA + i0] + u1 * coarse[rowA + i0 + 1]) * w0 + (u0 * coarse[rowB + i0] + u1 * coarse[rowB + i0 + 1]) * w1;
        out[dst + x] = v * ny * normLut[tx];
        if (++tx === s) {
          tx = 0;
          i0++;
        }
      }
      if (++ty === s) {
        ty = 0;
        j0++;
      }
    }
    return out;
  }
  var ENVELOPE_STRIDE = 4;
  var CHROMA_FINE_STRIDE = 2;
  var EXP_N = 1024;
  var EXP_LO = -4;
  var EXP_HI = 4;
  var EXP_LUT = new Float32Array(EXP_N + 1);
  for (let i = 0; i <= EXP_N; i++) EXP_LUT[i] = Math.exp(EXP_LO + (EXP_HI - EXP_LO) * i / EXP_N);
  var EXP_STEP = (EXP_HI - EXP_LO) / EXP_N;
  var SIGMA_GRAIN_RATIO = 0.5;
  function clusterSigma(radiusPx, clumping) {
    const mr = Math.max(radiusPx, 2 * SIGMA_GRAIN_RATIO);
    const sg = mr * SIGMA_GRAIN_RATIO;
    return Math.max(sg * 1.5, mr * (2 + 4 * clumping));
  }
  function autoEnvelopeStride(radiusPx, clumping) {
    const sc = clusterSigma(radiusPx, clumping);
    return Math.max(1, Math.min(64, Math.ceil(sc / 2)));
  }
  function autoFineStride(sigma) {
    return Math.max(1, Math.min(4, Math.round(sigma / 2)));
  }
  function generateFineField({
    width,
    height,
    seed = 1,
    stream = 0,
    sigma,
    originX = 0,
    originY = 0,
    stride = 1
  }) {
    return stride > 1 ? decimatedNoise({ width, height, seed, stream, sigma, originX, originY, stride }) : filteredNoise({ width, height, seed, stream, sigma, originX, originY });
  }
  function generateEnvelope({
    width,
    height,
    seed = 1,
    stream = 0,
    radiusPx,
    clumping = 0.35,
    originX = 0,
    originY = 0,
    envelopeStride = ENVELOPE_STRIDE
  }) {
    if (clumping <= 1e-3) return null;
    const sc = clusterSigma(radiusPx, clumping);
    return decimatedNoise({
      width,
      height,
      seed,
      stream: (stream ^ 521288629) >>> 0,
      sigma: sc,
      originX,
      originY,
      stride: envelopeStride
    });
  }
  function combineGrain(fine, envelope, beta, out) {
    out = out || new Float32Array(fine.length);
    if (!envelope) {
      out.set(fine);
      return out;
    }
    const inv = 1 / Math.exp(beta * beta);
    for (let i = 0; i < out.length; i++) {
      let t = (beta * envelope[i] - EXP_LO) / EXP_STEP;
      if (t < 0) t = 0;
      else if (t > EXP_N - 1) t = EXP_N - 1;
      const j = t | 0;
      out[i] = fine[i] * (EXP_LUT[j] + (EXP_LUT[j + 1] - EXP_LUT[j]) * (t - j)) * inv;
    }
    return out;
  }
  function generateGrainField({
    width,
    height,
    seed = 1,
    stream = 0,
    radiusPx,
    clumping = 0.35,
    originX = 0,
    originY = 0,
    fineStride = 1,
    envelopeStride = null,
    envelope = void 0
  }) {
    const sg = Math.max(0.35, radiusPx * SIGMA_GRAIN_RATIO);
    const fs = Math.max(fineStride, autoFineStride(sg));
    const fine = generateFineField({
      width,
      height,
      seed,
      stream,
      sigma: sg,
      originX,
      originY,
      stride: fs
    });
    if (clumping <= 1e-3) return fine;
    const es = envelopeStride === null || envelopeStride === void 0 || envelopeStride === "auto" ? autoEnvelopeStride(radiusPx, clumping) : Math.max(1, Math.round(envelopeStride));
    const wide = envelope !== void 0 ? envelope : generateEnvelope({
      width,
      height,
      seed,
      stream,
      radiusPx,
      clumping,
      originX,
      originY,
      envelopeStride: es
    });
    return combineGrain(fine, wide, Math.min(0.45, 0.9 * clumping), null);
  }
  function gammaForPeak(uPeak) {
    const p = Math.min(0.95, Math.max(0.05, uPeak));
    return Math.log(0.5) / Math.log(p);
  }
  function amplitudeAt(u, uPeak = 0.62) {
    const t = u <= 0 ? 0 : u >= 1 ? 1 : u;
    const p = Math.pow(t, gammaForPeak(uPeak));
    const base = 2 * Math.sqrt(Math.max(0, p * (1 - p)));
    if (p > 0.5) {
      return base * Math.pow((1 - p) / 0.5, HIGHLIGHT_TAPER_B);
    }
    return base;
  }
  var HIGHLIGHT_TAPER_B = 0.8;
  var NOISE_KNEE = 3.5;
  var INV_NOISE_KNEE = 1 / NOISE_KNEE;
  function buildAmplitudeLUTs({ strength = 0.03, uPeak = 0.62, n = 1024 } = {}) {
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
      corr[i] = 0.5 * curvatureAtV(u) * s * s / g1;
    }
    return { amp, sigLin, corr };
  }
  var CHANNEL_STREAMS = [1, 2, 3];
  function lumTemplateNorm(weights) {
    const w = weights || [1, 1, 1];
    const wMax = Math.max(...w) || 1;
    const w0 = w.map((x) => x / wMax);
    return Math.sqrt(
      0.2126 * 0.2126 * w0[0] * w0[0] + 0.7152 * 0.7152 * w0[1] * w0[1] + 0.0722 * 0.0722 * w0[2] * w0[2]
    ) || 1;
  }
  function applyGrain(rgb, width, height, {
    seed = 1,
    radiusPx = 2,
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
    weights = [0.9, 0.95, 1],
    mono = false,
    // 色度颗粒略粗于亮度颗粒（染料云尺度大于银颗粒），但**不能太粗**：
    // 人眼对低频色度反而更敏感，大块颜色会读成「脏」，细密的色噪才会融进颗粒质感。
    // 早期取 2.6 是判断反了，实测在极端参数下会形成可见的彩色斑块。
    chromaRadiusScale = 1.3,
    compensate = true,
    // 深度软膝开关。关掉仅用于基准对照（定位性能开销），产品路径必须为 true。
    noiseKnee = true,
    originX = 0,
    originY = 0,
    fineStride = 1,
    envelopeStride = null,
    chromaFineStride = CHROMA_FINE_STRIDE,
    envelopeMode = "shared"
  } = {}) {
    const { sigLin, corr } = buildAmplitudeLUTs({ strength, uPeak, n: N_LUT });
    const nPix = width * height;
    const envStride = envelopeStride === null || envelopeStride === void 0 || envelopeStride === "auto" ? autoEnvelopeStride(radiusPx, clumping) : Math.max(1, Math.round(envelopeStride));
    const sharedEnv = envelopeMode === "shared" ? generateEnvelope({ width, height, seed, stream: 0, radiusPx, clumping, originX, originY, envelopeStride: envStride }) : void 0;
    const luma = generateGrainField({
      width,
      height,
      seed,
      stream: 0,
      radiusPx,
      clumping,
      originX,
      originY,
      fineStride,
      envelopeStride: envStride,
      envelope: sharedEnv
    });
    const chroma = [[], [], []];
    if (!mono && lumaChroma > 1e-3) {
      const cs = Math.max(fineStride, chromaFineStride);
      for (let c = 0; c < 3; c++) {
        chroma[c] = generateGrainField({
          width,
          height,
          seed,
          stream: CHANNEL_STREAMS[c],
          radiusPx: radiusPx * chromaRadiusScale,
          clumping,
          originX,
          originY,
          fineStride: cs,
          envelopeStride,
          envelope: sharedEnv
        });
      }
    }
    const wL = Math.sqrt(Math.max(0, 1 - lumaChroma));
    const wC = Math.sqrt(Math.max(0, lumaChroma));
    const wMax = Math.max(...weights) || 1;
    const lumW0 = weights.map((w) => w / wMax);
    const lumRef = lumTemplateNorm(weights);
    const lumW = lumW0.map((w) => w / lumRef);
    const vc = lumW.map((w) => w * w * wL * wL + wC * wC);
    const NL1 = N_LUT - 1;
    const hasChroma = chroma[0].length > 0;
    for (let i = 0; i < nPix; i++) {
      const base = i * 3;
      if (rgb[base] <= 0 && rgb[base + 1] <= 0 && rgb[base + 2] <= 0) continue;
      for (let c = 0; c < 3; c++) {
        const v = rgb[base + c];
        let g = luma[i] * (lumW[c] * wL);
        if (hasChroma) g += chroma[c][i] * wC;
        const tv = v <= 0 ? 0 : v >= 1 ? 1 : v;
        const fv = tv * NL1;
        const iv = fv < NL1 ? fv | 0 : NL1 - 1;
        const av = fv - iv;
        const sig = sigLin[iv] + (sigLin[iv + 1] - sigLin[iv]) * av;
        if (sig === 0) continue;
        let l = S2L[iv] + (S2L[iv + 1] - S2L[iv]) * av;
        let inj = sig * g;
        if (noiseKnee) {
          const cap = l * INV_NOISE_KNEE;
          const mag = inj < 0 ? -inj : inj;
          if (mag > cap) inj = inj < 0 ? -cap : cap;
        }
        if (compensate) {
          const cv = corr[iv] + (corr[iv + 1] - corr[iv]) * av;
          l -= cv * vc[c];
        }
        l += inj;
        const tl = l <= 0 ? 0 : l >= 1 ? 1 : l;
        const fl = tl * NL1;
        const il = fl < NL1 ? fl | 0 : NL1 - 1;
        const al = fl - il;
        rgb[base + c] = L2S[il] + (L2S[il + 1] - L2S[il]) * al;
      }
    }
    return rgb;
  }

  // core/film.mjs
  var REF_FRAME_DIAG_MM = Math.sqrt(36 * 36 + 24 * 24);
  var REF_IMAGE_DIAG_PX = Math.sqrt(6e3 * 6e3 + 4e3 * 4e3);
  var REF_RADIUS_PX = 2;
  var REF_STRENGTH = 0.014;
  var ISO_EXP = 1 / 3;
  var GAUGE_EXP = 0.8;
  var PUSH_COEF = 0.12;
  var PULL_FACTOR = 0.85;
  var RADIUS_G_EXP = 0.65;
  var STRENGTH_G0 = 3;
  var STRENGTH_COMP_EXP = 0.6;
  function ampExponent(g) {
    return g <= STRENGTH_G0 ? g : STRENGTH_G0 * Math.pow(g / STRENGTH_G0, STRENGTH_COMP_EXP);
  }
  var GAUGES = [
    { id: "135", name: "135", note: "36 \xD7 24 mm \xB7 \u5168\u753B\u5E45", diag: 43.267 },
    { id: "120", name: "120", note: "6 \xD7 6 cm", diag: 79.196 },
    { id: "4x5", name: "4 \xD7 5", note: "\u5927\u753B\u5E45\u9875\u7247", diag: 162.64 },
    { id: "16mm", name: "16mm", note: "Super 16 \xB7 \u7535\u5F71", diag: 12.7 }
  ];
  function gaugeById(id) {
    return GAUGES.find((g) => g.id === id) || GAUGES[0];
  }
  var C = "\u5F69\u8272\u8D1F\u7247";
  var B = "\u9ED1\u767D\u8D1F\u7247";
  var R = "\u53CD\u8F6C\u7247";
  var FILM_STOCKS = [
    /* ---- 彩色负片（g 由柯达 PGI 直接换算：g = PGI / 37） ---- */
    { id: "ektar100", brand: "Kodak", name: "Ektar 100", group: C, iso: 100, grain: 0.65, clumping: 0.28, uPeak: 0.64, chroma: 0.022 },
    { id: "portra160", brand: "Kodak", name: "Portra 160", group: C, iso: 160, grain: 0.76, clumping: 0.32, uPeak: 0.62, chroma: 0.022 },
    { id: "portra400", brand: "Kodak", name: "Portra 400", group: C, iso: 400, grain: 1, clumping: 0.35, uPeak: 0.62, chroma: 0.025 },
    { id: "portra800", brand: "Kodak", name: "Portra 800", group: C, iso: 800, grain: 1.3, clumping: 0.42, uPeak: 0.6, chroma: 0.028 },
    { id: "gold200", brand: "Kodak", name: "Gold 200", group: C, iso: 200, grain: 1.19, clumping: 0.38, uPeak: 0.6, chroma: 0.028 },
    { id: "ultramax400", brand: "Kodak", name: "Ultramax 400", group: C, iso: 400, grain: 1.22, clumping: 0.4, uPeak: 0.6, chroma: 0.028 },
    { id: "proimage100", brand: "Kodak", name: "Pro Image 100", group: C, iso: 100, grain: 1.16, clumping: 0.36, uPeak: 0.61, chroma: 0.026 },
    { id: "superia400", brand: "Fujifilm", name: "Superia X-TRA 400", group: C, iso: 400, grain: 1.22, clumping: 0.4, uPeak: 0.6, chroma: 0.03 },
    { id: "c200", brand: "Fujifilm", name: "C200", group: C, iso: 200, grain: 1.12, clumping: 0.37, uPeak: 0.61, chroma: 0.028 },
    /* ---- 黑白负片（g 由 RMS 经锚点桥换算：g = 0.0739·RMS + 0.044） ---- */
    { id: "panf50", brand: "Ilford", name: "Pan F Plus 50", group: B, iso: 50, grain: 0.49, clumping: 0.28, uPeak: 0.63, chroma: 0, mono: true },
    { id: "d100", brand: "Ilford", name: "Delta 100", group: B, iso: 100, grain: 0.6, clumping: 0.24, uPeak: 0.63, chroma: 0, mono: true },
    { id: "tmax100", brand: "Kodak", name: "T-Max 100", group: B, iso: 100, grain: 0.65, clumping: 0.24, uPeak: 0.63, chroma: 0, mono: true },
    { id: "fp4", brand: "Ilford", name: "FP4 Plus 125", group: B, iso: 125, grain: 0.71, clumping: 0.36, uPeak: 0.62, chroma: 0, mono: true },
    { id: "acros100", brand: "Fujifilm", name: "Acros II 100", group: B, iso: 100, grain: 0.76, clumping: 0.28, uPeak: 0.63, chroma: 0, mono: true },
    { id: "tmax400", brand: "Kodak", name: "T-Max 400", group: B, iso: 400, grain: 0.86, clumping: 0.25, uPeak: 0.62, chroma: 0, mono: true },
    { id: "xp2", brand: "Ilford", name: "XP2 Super 400", group: B, iso: 400, grain: 0.86, clumping: 0.3, uPeak: 0.62, chroma: 0, mono: true },
    { id: "d400", brand: "Ilford", name: "Delta 400", group: B, iso: 400, grain: 0.97, clumping: 0.27, uPeak: 0.62, chroma: 0, mono: true },
    { id: "trix400", brand: "Kodak", name: "Tri-X 400", group: B, iso: 400, grain: 1.3, clumping: 0.55, uPeak: 0.6, chroma: 0, mono: true },
    { id: "hp5", brand: "Ilford", name: "HP5 Plus 400", group: B, iso: 400, grain: 1.45, clumping: 0.55, uPeak: 0.6, chroma: 0, mono: true },
    { id: "d3200", brand: "Ilford", name: "Delta 3200", group: B, iso: 3200, grain: 2.63, clumping: 0.45, uPeak: 0.6, chroma: 0, mono: true },
    /* ---- 反转片 ---- */
    { id: "velvia50", brand: "Fujifilm", name: "Velvia 50", group: R, iso: 50, grain: 0.63, clumping: 0.28, uPeak: 0.66, chroma: 0.018 },
    { id: "provia100f", brand: "Fujifilm", name: "Provia 100F", group: R, iso: 100, grain: 0.71, clumping: 0.3, uPeak: 0.65, chroma: 0.018 },
    { id: "e100", brand: "Kodak", name: "Ektachrome E100", group: R, iso: 100, grain: 0.78, clumping: 0.3, uPeak: 0.65, chroma: 0.018 }
  ];
  function filmById(id) {
    return FILM_STOCKS.find((f) => f.id === id) || FILM_STOCKS.find((f) => f.id === "portra400");
  }
  function filmsByGroup() {
    const order = [C, B, R];
    return order.map((g) => ({ group: g, films: FILM_STOCKS.filter((f) => f.group === g) }));
  }
  var STOPS = [
    { v: -1, label: "\u62C9\u4E00\u6863", short: "\u22121" },
    { v: 0, label: "\u7BB1\u901F", short: "\u7BB1" },
    { v: 1, label: "\u63A8\u4E00\u6863", short: "+1" },
    { v: 2, label: "\u63A8\u4E8C\u6863", short: "+2" },
    { v: 3, label: "\u63A8\u4E09\u6863", short: "+3" }
  ];
  function equivalentIso(stock, stops = 0) {
    return Math.round(stock.iso * Math.pow(2, stops));
  }
  function grainIndex(stock, stops = 0) {
    const isoTerm = Math.pow(2, stops * ISO_EXP);
    const pen = stops > 0 ? 1 + PUSH_COEF * stops * stops : stops < 0 ? Math.pow(PULL_FACTOR, -stops) : 1;
    return stock.grain * isoTerm * pen;
  }
  function resolveFilmParams(o) {
    const stock = typeof o.film === "string" ? filmById(o.film) : o.film || filmById("portra400");
    const stops = Math.max(-1, Math.min(3, Math.round(o.stops || 0)));
    const gauge = gaugeById(o.gauge);
    const amount = o.amount === void 0 ? 1 : Math.max(0, o.amount);
    const g = grainIndex(stock, stops);
    const gaugeScale = Math.pow(REF_FRAME_DIAG_MM / gauge.diag, GAUGE_EXP);
    const w = Math.max(1, o.imageWidth || 6e3);
    const h = Math.max(1, o.imageHeight || 4e3);
    const diagPx = Math.sqrt(w * w + h * h);
    const sizeFactor = Math.pow(g, RADIUS_G_EXP) * gaugeScale * (diagPx / REF_IMAGE_DIAG_PX);
    const radiusPx = REF_RADIUS_PX * sizeFactor;
    return {
      radiusPx,
      strength: REF_STRENGTH * ampExponent(g) * gaugeScale * amount,
      clumping: o.clumping === void 0 ? stock.clumping : o.clumping,
      uPeak: stock.uPeak,
      lumaChroma: stock.mono ? 0 : stock.chroma === void 0 ? 0.025 : stock.chroma,
      mono: !!stock.mono,
      weights: stock.mono ? [1, 1, 1] : [0.9, 0.95, 1],
      chromaRadiusScale: 1.3,
      // 供 UI 显示
      grainIndex: g,
      iso: equivalentIso(stock, stops),
      gaugeScale
    };
  }

  // core/io.mjs
  var depthMax = (bits) => bits === 8 ? 255 : bits === 16 ? 32768 : 1;
  function allocBuffer(bits, count) {
    if (bits === 8) return new Uint8Array(count);
    if (bits === 16) return new Uint16Array(count);
    return new Float32Array(count);
  }
  function parseBitDepth(v) {
    const s = String(v == null ? "" : v).toLowerCase();
    if (s.indexOf("32") >= 0 || s.indexOf("thirtytwo") >= 0) return 32;
    if (s.indexOf("16") >= 0 || s.indexOf("sixteen") >= 0) return 16;
    if (s.indexOf("8") >= 0 || s.indexOf("eight") >= 0) return 8;
    return null;
  }
  function decodePixels(src, width, height, components, bits) {
    const n = width * height;
    const rgb = new Float32Array(n * 3);
    const alpha = components === 4 ? new Float32Array(n) : null;
    const inv = 1 / depthMax(bits);
    if (components === 4) {
      for (let i = 0, p = 0, q = 0; i < n; i++, p += 4, q += 3) {
        rgb[q] = src[p] * inv;
        rgb[q + 1] = src[p + 1] * inv;
        rgb[q + 2] = src[p + 2] * inv;
        alpha[i] = src[p + 3] * inv;
      }
    } else {
      for (let i = 0, p = 0, q = 0; i < n; i++, p += 3, q += 3) {
        rgb[q] = src[p] * inv;
        rgb[q + 1] = src[p + 1] * inv;
        rgb[q + 2] = src[p + 2] * inv;
      }
    }
    return { rgb, alpha };
  }
  function encodePixels(rgb, alpha, width, height, bits, opts = {}) {
    const o = opts || {};
    const dither = o.dither === void 0 ? bits !== 32 : !!o.dither;
    const seed = o.seed === void 0 ? 1592594996 : o.seed >>> 0;
    const n = width * height;
    const out = allocBuffer(bits, n * 4);
    if (bits === 32) {
      for (let i = 0, p = 0, q2 = 0; i < n; i++, p += 4, q2 += 3) {
        out[p] = rgb[q2];
        out[p + 1] = rgb[q2 + 1];
        out[p + 2] = rgb[q2 + 2];
        out[p + 3] = alpha ? alpha[i] : 1;
      }
      return out;
    }
    const scale = bits === 8 ? 255 : 32768;
    const q = bits === 8 ? q8 : q16;
    for (let y = 0; y < height; y++) {
      let p = y * width * 4;
      let i = y * width;
      for (let x = 0; x < width; x++, p += 4, i++) {
        let d0 = 0, d1 = 0, d2 = 0, d3 = 0;
        if (dither) {
          const h0 = hash32(seed, 0, x, y);
          const h1 = hash32(seed, 1, x, y);
          d0 = ((h0 & 255) + (h0 >>> 8 & 255)) / 255 - 1;
          d1 = ((h0 >>> 16 & 255) + (h0 >>> 24)) / 255 - 1;
          d2 = ((h1 & 255) + (h1 >>> 8 & 255)) / 255 - 1;
          d3 = ((h1 >>> 16 & 255) + (h1 >>> 24)) / 255 - 1;
        }
        const b = i * 3;
        const aMax = bits === 8 ? 255 : 32768;
        out[p] = q(rgb[b], scale, d0);
        out[p + 1] = q(rgb[b + 1], scale, d1);
        out[p + 2] = q(rgb[b + 2], scale, d2);
        out[p + 3] = alpha ? qa(alpha[i], aMax) : aMax;
      }
    }
    return out;
  }
  function q8(v, max, d) {
    const x = v * max + d;
    return x <= 0 ? 0 : x >= max ? max : x + 0.5 | 0;
  }
  function q16(v, max, d) {
    const x = v * 32768 + d;
    return x <= 0 ? 0 : x >= 32768 ? 32768 : x + 0.5 | 0;
  }
  function qa(v, max) {
    const x = v * max;
    return x <= 0 ? 0 : x >= max ? max : x + 0.5 | 0;
  }
  function applyGrainBanded(rgb, width, height, opts = {}) {
    const o = opts || {};
    const bandRows = Math.max(1, Math.min(height, o.bandRows || 256));
    const onProgress = o.onProgress;
    const stride = width * 3;
    const baseY = o.originY || 0;
    const baseX = o.originX || 0;
    for (let y0 = 0; y0 < height; y0 += bandRows) {
      const h = Math.min(bandRows, height - y0);
      const view = rgb.subarray(y0 * stride, (y0 + h) * stride);
      applyGrain(view, width, h, Object.assign({}, o, { originX: baseX, originY: baseY + y0 }));
      if (onProgress) onProgress((y0 + h) / height);
    }
    return rgb;
  }
  function processImage(src, width, height, components, bits, params = {}) {
    const { rgb, alpha } = decodePixels(src, width, height, components, bits);
    applyGrainBanded(rgb, width, height, params);
    return encodePixels(rgb, alpha, width, height, bits, {
      dither: params.dither,
      seed: params.seed
    });
  }

  // core/png.mjs
  var CRC_TABLE = null;
  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
      t[n] = c;
    }
    CRC_TABLE = t;
    return t;
  }
  function crc32(buf, start, end) {
    const t = crcTable();
    let c = -1;
    for (let i = start; i < end; i++) c = t[(c ^ buf[i]) & 255] ^ c >>> 8;
    return (c ^ -1) >>> 0;
  }
  function adler32(buf) {
    let a = 1, b = 0;
    for (let i = 0; i < buf.length; ) {
      const n = Math.min(5552, buf.length - i);
      for (let j = 0; j < n; j++, i++) {
        a += buf[i];
        b += a;
      }
      a %= 65521;
      b %= 65521;
    }
    return (b << 16 | a) >>> 0;
  }
  var STORED_MAX = 65535;
  function deflateStore(data) {
    const nBlocks = Math.max(1, Math.ceil(data.length / STORED_MAX));
    const out = new Uint8Array(2 + data.length + nBlocks * 5 + 4);
    let p = 0;
    out[p++] = 120;
    out[p++] = 1;
    let off = 0;
    for (let i = 0; i < nBlocks; i++) {
      const len = Math.min(STORED_MAX, data.length - off);
      out[p++] = i === nBlocks - 1 ? 1 : 0;
      out[p++] = len & 255;
      out[p++] = len >>> 8 & 255;
      out[p++] = ~len & 255;
      out[p++] = ~len >>> 8 & 255;
      out.set(data.subarray(off, off + len), p);
      p += len;
      off += len;
    }
    const ad = adler32(data);
    out[p++] = ad >>> 24 & 255;
    out[p++] = ad >>> 16 & 255;
    out[p++] = ad >>> 8 & 255;
    out[p++] = ad & 255;
    return out.subarray(0, p);
  }
  function chunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    out[0] = data.length >>> 24 & 255;
    out[1] = data.length >>> 16 & 255;
    out[2] = data.length >>> 8 & 255;
    out[3] = data.length & 255;
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    const c = crc32(out, 4, 8 + data.length);
    out[8 + data.length] = c >>> 24 & 255;
    out[9 + data.length] = c >>> 16 & 255;
    out[10 + data.length] = c >>> 8 & 255;
    out[11 + data.length] = c & 255;
    return out;
  }
  function packRGB8(rgb, width, height) {
    const n = width * height;
    const out = new Uint8Array(n * 3);
    for (let i = 0, p = 0; i < n; i++, p += 3) {
      let r = rgb[p] * 255, g = rgb[p + 1] * 255, b = rgb[p + 2] * 255;
      out[p] = r <= 0 ? 0 : r >= 255 ? 255 : r + 0.5 | 0;
      out[p + 1] = g <= 0 ? 0 : g >= 255 ? 255 : g + 0.5 | 0;
      out[p + 2] = b <= 0 ? 0 : b >= 255 ? 255 : b + 0.5 | 0;
    }
    return out;
  }
  function encodePNG(rgb, width, height) {
    const rowBytes = width * 3;
    const raw = new Uint8Array(height * (1 + rowBytes));
    for (let y = 0; y < height; y++) {
      const d = y * (1 + rowBytes);
      raw[d] = 0;
      raw.set(rgb.subarray(y * rowBytes, (y + 1) * rowBytes), d + 1);
    }
    const ihdr = new Uint8Array(13);
    ihdr[0] = width >>> 24 & 255;
    ihdr[1] = width >>> 16 & 255;
    ihdr[2] = width >>> 8 & 255;
    ihdr[3] = width & 255;
    ihdr[4] = height >>> 24 & 255;
    ihdr[5] = height >>> 16 & 255;
    ihdr[6] = height >>> 8 & 255;
    ihdr[7] = height & 255;
    ihdr[8] = 8;
    ihdr[9] = 2;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    const parts = [
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateStore(raw)),
      chunk("IEND", new Uint8Array(0))
    ];
    let total = 0;
    for (const p of parts) total += p.length;
    const png = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      png.set(p, off);
      off += p.length;
    }
    return png;
  }
  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function pngToDataUrl(png) {
    let s = "";
    const n = png.length;
    for (let i = 0; i < n; i += 3) {
      const b0 = png[i], b1 = i + 1 < n ? png[i + 1] : 0, b2 = i + 2 < n ? png[i + 2] : 0;
      s += B64[b0 >> 2] + B64[(b0 & 3) << 4 | b1 >> 4] + (i + 1 < n ? B64[(b1 & 15) << 2 | b2 >> 6] : "=") + (i + 2 < n ? B64[b2 & 63] : "=");
    }
    return "data:image/png;base64," + s;
  }

  // core/pinart.mjs
  var COLORWAYS = {
    // 柯达彩色负片 —— 琥珀黄
    kodakC: { box: "#e8a72a", strip: "#7d5a2e", ink: "#211604", holes: "#fbf3e2" },
    // 富士彩色负片 —— 绿
    fujiC: { box: "#0f9c4c", strip: "#8a9c2a", ink: "#04210f", holes: "#eefbe8" },
    // 柯达黑白 —— 炭黑配白字
    kodakB: { box: "#1c1c20", strip: "#5a5a60", ink: "#f0f0ec", holes: "#e8e8e4" },
    // 富士黑白 —— 冷灰蓝。要读作单色（黑白片），又要与柯达炭黑分得开
    fujiB: { box: "#46505c", strip: "#8d99a6", ink: "#f2f4f6", holes: "#eef1f4" },
    // 依尔福黑白 —— 象牙白配黑字
    ilfordB: { box: "#f0efe9", strip: "#9a9a94", ink: "#131313", holes: "#ffffff" },
    // 柯达反转片 —— 红
    kodakR: { box: "#d4442c", strip: "#3a2a52", ink: "#fff4f0", holes: "#ffe8e2" },
    // 富士反转片 —— 紫蓝
    fujiR: { box: "#3d3aa0", strip: "#c8403a", ink: "#f0f0ff", holes: "#e8e8ff" }
  };
  var GROUP_COLORWAY = {
    C: { Kodak: "kodakC", Fujifilm: "fujiC" },
    B: { Kodak: "kodakB", Ilford: "ilfordB", Fujifilm: "fujiB" },
    R: { Kodak: "kodakR", Fujifilm: "fujiR" }
  };
  function groupKind(group) {
    const g = String(group || "");
    if (g.startsWith("\u5F69\u8272")) return "C";
    if (g.startsWith("\u9ED1\u767D")) return "B";
    if (g.startsWith("\u53CD\u8F6C")) return "R";
    return null;
  }
  function colorwayFor(stock) {
    const kind = groupKind(stock && stock.group);
    const byBrand = kind && GROUP_COLORWAY[kind];
    const cw = byBrand && byBrand[stock.brand];
    if (!cw) {
      throw new Error(
        "\u6CA1\u6709\u4E3A\u300C" + (stock && stock.brand) + " / " + (stock && stock.group) + "\u300D\uFF08id=" + (stock && stock.id) + "\uFF09\u5B9A\u4E49\u8272\u8DEF\u3002\u8BF7\u5728 COLORWAYS/GROUP_COLORWAY \u91CC\u8865\u4E0A\u3002"
      );
    }
    return cw;
  }
  var colorwayOf = (stock) => COLORWAYS[colorwayFor(stock)];
  var BRAND_SHORT = { Kodak: "KODAK", Fujifilm: "FUJI", Ilford: "ILFORD" };
  var MODEL_SHORT = {
    ektar100: "EKTAR",
    portra160: "PORTRA",
    portra400: "PORTRA",
    portra800: "PORTRA",
    gold200: "GOLD",
    ultramax400: "ULTRA",
    proimage100: "PRO",
    superia400: "SUPERIA",
    c200: "C200",
    panf50: "PAN F",
    d100: "DELTA",
    d400: "DELTA",
    d3200: "DELTA",
    tmax100: "T-MAX",
    tmax400: "T-MAX",
    fp4: "FP4",
    acros100: "ACROS",
    xp2: "XP2",
    trix400: "TRI-X",
    hp5: "HP5",
    velvia50: "VELVIA",
    provia100f: "PROVIA",
    e100: "E100"
  };
  function badgeText(stock) {
    return {
      brand: BRAND_SHORT[stock.brand] || String(stock.brand),
      iso: String(stock.iso),
      model: MODEL_SHORT[stock.id] || String(stock.name).split(" ")[0]
    };
  }
  function colorwayCensus(stocks) {
    const count = {};
    for (const f of stocks) {
      const k = colorwayFor(f);
      count[k] = (count[k] || 0) + 1;
    }
    return count;
  }
  var esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  var CAP_W = 24.5;
  function fitSize(text, perChar, cap, min) {
    const n = Math.max(1, String(text).length);
    let s = CAP_W / (n * perChar);
    if (s > cap) s = cap;
    if (s < min) s = min;
    return Math.round(s * 10) / 10;
  }
  function pinMarkup(stock, size, fallbackCw) {
    let cw;
    try {
      cw = colorwayOf(stock);
    } catch (e) {
      if (!fallbackCw) throw e;
      cw = fallbackCw;
    }
    let holes = "";
    let cap = "";
    const nHoles = size === "card" ? 5 : 3;
    let row = "";
    for (let i = 0; i < nHoles; i++) row += `<i style="background:${cw.holes}"></i>`;
    holes = `<span class="hs r1">${row}</span><span class="hs r2">${row}</span>`;
    if (size === "card") {
      const t = badgeText(stock);
      const brandFs = fitSize(t.brand, 0.66, 7.5, 5.5);
      const isoFs = fitSize(t.iso, 0.535, 16, 10);
      const modelFs = fitSize(t.model, 0.65, 8, 5);
      cap = `<span class="cap" style="color:${cw.ink}"><b style="font-size:${brandFs}px">${esc(t.brand)}</b><u style="font-size:${isoFs}px">${esc(t.iso)}</u>` + (t.model ? `<em style="font-size:${modelFs}px">${esc(t.model)}</em>` : "") + "</span>";
    }
    return `<span class="pin ${size}"><span class="tg" style="background:${cw.strip}"></span>` + holes + `<span class="bx" style="background:${cw.box}"><span class="gl"></span>${cap}</span></span>`;
  }
  return __toCommonJS(plugin_entry_exports);
})();
