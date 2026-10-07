/**
 * 胶片预设与「型号 × 感光度 × 画幅」→ 物理参数的映射。
 *
 * ============================================================
 * 一、为什么必须耦合，不能给两个独立滑块
 * ============================================================
 * Nutting 定律（2.3·D = a·N）+ 泊松波动（ΔN = √N）给出 σ_D ∝ d，即
 * **颗粒度正比于颗粒直径**。所以「颗粒变粗」这件事在物理上是尺度与幅度
 * 同时上升，不可能只动其中一个。ISO 与颗粒尺度的耦合也不是设计懒惰：
 * 大晶体捕光截面大 → 高 ISO 必然倾向大颗粒（研究报告表 2）。
 *
 * 所以对外暴露的是「胶片型号 + 感光度」，内部同时驱动 radiusPx 与 strength。
 *
 * ============================================================
 * 二、grain 这个数字是怎么来的（两套源，一条桥）
 * ============================================================
 * 内部统一尺度：**相对颗粒度 g，Kodak Portra 400 / 135 / 箱速 = 1.00**。
 *
 * ① 彩色负片 —— 直接用柯达 PGI（135 画幅、4×6 英寸输出、14 英寸观看）。
 *    PGI 本身是等距感知尺度（4 单位 = 1 JND，25 = 粗略视觉阈值），
 *    所以它比 RMS 更适合直接当「感知颗粒度」用。
 *    数据点：Ektar 100 <25、Portra 160 = 28、Portra 400 = 37、
 *            Gold 200 = 44、Ultramax 400 = 45、Portra 800 = 48。
 *
 * ② 黑白 —— 柯达不给黑白片 PGI（PGI 依赖彩色相纸）。改用 diffuse RMS
 *    （48 μm 孔径、D≈1.0）经**两个主观锚点对**线性映射到同一尺度：
 *        T-Max 100（RMS 8.2）↔ Ektar 100（g 0.65）  ——「极细颗粒」
 *        Tri-X 400（RMS 17）  ↔ Portra 800（g 1.30） ——「明显颗粒」
 *    ⇒ g = 0.0739·RMS + 0.044
 *    **这是一条经验桥，不是物理换算。** 两套测量的孔径、密度、语义都不同，
 *    唯一可靠的连接是「它们在视觉上大致相当」这一判断。已标注为待标定项。
 *
 * ③ 反转片 —— 用同一座桥的原始 RMS，**不套用报告里「负片 × 2.5 ≈ 反转片」
 *    那条换算**。那条换算讲的是印相时反转片反差更高、颗粒更显眼；
 *    我们的输出是屏幕上的正像，反差由我们自己控，所以按物理颗粒度取即可。
 *
 * ⚠️ 绝对量级未经真实扫描件标定（研究报告附录 A.5 的数据缺口）。
 *    相对关系（谁比谁粗、粗多少）是同一条标尺上量出来的，可信；
 *    绝对值要靠实测回归。改动前请先看 §四 的合成基线。
 *
 * ============================================================
 * 三、感光度与画幅怎么进模型
 * ============================================================
 * · ISO（同一乳剂内）：σ ∝ ISO^(1/3)。
 *   由 Portra 家族 PGI 阶梯拟合：160→400 得 0.305、400→800 得 0.376、
 *   160→800 得 0.335。取 1/3。
 *   （跨乳剂的表观指数更高，约 0.49 —— 那部分差异已经被「选哪款胶片」承担了，
 *    不该再算进 ISO 项。）
 *
 * · 推冲（push）：比原生高速片更差。欠曝 + 强制显影会加剧感染显影与颗粒团簇，
 *   所以除 ISO 项外再加一个惩罚项 1 + 0.12·n²。
 *   拉冲（pull −1）：过曝一档 + 减显影约 15%，实测 RMS 降 19%，取 0.85。
 *
 * · 画幅：颗粒必须按**画幅对角线**定义，不能固定像素数。
 *   柯达表 6 的铁证：同一 Portra 160，135 在 16×20 时 PGI 79，
 *   120 是 50，4×5 是 26 —— **画幅比胶片型号影响更大**。
 *   拟合 (43.27/diag)^0.8：120 预测 0.55（实测 0.63）、4×5 预测 0.35（实测 0.33）。
 *   指数 0.8 而非 1.0，是因为 PGI 是感知尺度、有压缩。
 */

/* ================================================================
   基准点：Portra 400 / 135 / 箱速 / 24 MP 上的一套可用参数
   ================================================================ */
export const REF_FRAME_DIAG_MM = Math.sqrt(36 * 36 + 24 * 24); // 135：43.267 mm
export const REF_IMAGE_DIAG_PX = Math.sqrt(6000 * 6000 + 4000 * 4000); // 24 MP 3:2
export const REF_RADIUS_PX = 2.0;    // g=1 时，24 MP 上的颗粒半径
export const REF_STRENGTH = 0.014;   // g=1 时的峰值幅度（sRGB 单位）

/** 同乳剂内 ISO 的颗粒度指数。见 §三。 */
export const ISO_EXP = 1 / 3;
/** 画幅（放大率）的指数。见 §三。 */
export const GAUGE_EXP = 0.8;
/** 推冲额外惩罚系数。 */
export const PUSH_COEF = 0.12;
/** 拉冲一档的颗粒度倍率。 */
export const PULL_FACTOR = 0.85;

/* —— 高 g 段的两条压缩（「高 ISO 像溅了泥」修复）——
 * 修复前 radius 和 strength 都随 g 线性走：Portra 800 推三档 g=5.41，
 * 半径 10.8px、峰值幅度 19 色阶 —— 「又粗又重」，目视是溅泥不是颗粒。
 * 【半径亚线性】真实高速乳剂颗粒变大但远非线性（面积更不会平方级涨）。
 *   取 0.65：Delta 3200 μr 3.8px（vs 修复前 5.3），仍是 Tri-X 的 1.6 倍粗。
 * 【强度压缩】PGI 本身就是感知压缩标度，线性外推在高端必然过头。
 *   g ≤ 3 全额；超过部分按 0.6 次幂压缩。Portra 800+3：0.076 → 0.060。 */
export const RADIUS_G_EXP = 0.65;
export const STRENGTH_G0 = 3;
export const STRENGTH_COMP_EXP = 0.6;

/** 强度用的有效 g：g ≤ G0 全额，超出部分压缩。 */
export function ampExponent(g) {
  return g <= STRENGTH_G0 ? g : STRENGTH_G0 * Math.pow(g / STRENGTH_G0, STRENGTH_COMP_EXP);
}

/* ================================================================
   画幅
   ================================================================ */
export const GAUGES = [
  { id: '135', name: '135', note: '36 × 24 mm · 全画幅', diag: 43.267 },
  { id: '120', name: '120', note: '6 × 6 cm', diag: 79.196 },
  { id: '4x5', name: '4 × 5', note: '大画幅页片', diag: 162.640 },
  { id: '16mm', name: '16mm', note: 'Super 16 · 电影', diag: 12.700 },
];

export function gaugeById(id) {
  return GAUGES.find((g) => g.id === id) || GAUGES[0];
}

/* ================================================================
   胶片预设
   ----------------------------------------------------------------
   grain    相对颗粒度（Portra 400 = 1.00）
   clumping 团簇度。「经典厚乳剂」（Tri-X / HP5）明显成团；
             T 颗粒 / 现代乳剂（T-Max / Delta / Ektar）平滑紧凑。
   uPeak    颗粒最强的灰度位置。消费级负片反差略高、峰值略低；反转片略高。
   chroma   色度颗粒功率占比。黑白为 0。
   weights  消色分量的逐通道幅度模板（最大通道 = 1）。
             一律近中性 —— 见 grain.mjs 里关于「彩色脏污」的长注释。
   ================================================================ */
const C = '彩色负片', B = '黑白负片', R = '反转片';

export const FILM_STOCKS = [
  /* ---- 彩色负片（g 由柯达 PGI 直接换算：g = PGI / 37） ---- */
  { id: 'ektar100', brand: 'Kodak', name: 'Ektar 100', group: C, iso: 100, grain: 0.65, clumping: 0.28, uPeak: 0.64, chroma: 0.022 },
  { id: 'portra160', brand: 'Kodak', name: 'Portra 160', group: C, iso: 160, grain: 0.76, clumping: 0.32, uPeak: 0.62, chroma: 0.022 },
  { id: 'portra400', brand: 'Kodak', name: 'Portra 400', group: C, iso: 400, grain: 1.00, clumping: 0.35, uPeak: 0.62, chroma: 0.025 },
  { id: 'portra800', brand: 'Kodak', name: 'Portra 800', group: C, iso: 800, grain: 1.30, clumping: 0.42, uPeak: 0.60, chroma: 0.028 },
  { id: 'gold200', brand: 'Kodak', name: 'Gold 200', group: C, iso: 200, grain: 1.19, clumping: 0.38, uPeak: 0.60, chroma: 0.028 },
  { id: 'ultramax400', brand: 'Kodak', name: 'Ultramax 400', group: C, iso: 400, grain: 1.22, clumping: 0.40, uPeak: 0.60, chroma: 0.028 },
  { id: 'proimage100', brand: 'Kodak', name: 'Pro Image 100', group: C, iso: 100, grain: 1.16, clumping: 0.36, uPeak: 0.61, chroma: 0.026 },
  { id: 'superia400', brand: 'Fujifilm', name: 'Superia X-TRA 400', group: C, iso: 400, grain: 1.22, clumping: 0.40, uPeak: 0.60, chroma: 0.030 },
  { id: 'c200', brand: 'Fujifilm', name: 'C200', group: C, iso: 200, grain: 1.12, clumping: 0.37, uPeak: 0.61, chroma: 0.028 },

  /* ---- 黑白负片（g 由 RMS 经锚点桥换算：g = 0.0739·RMS + 0.044） ---- */
  { id: 'panf50', brand: 'Ilford', name: 'Pan F Plus 50', group: B, iso: 50, grain: 0.49, clumping: 0.28, uPeak: 0.63, chroma: 0, mono: true },
  { id: 'd100', brand: 'Ilford', name: 'Delta 100', group: B, iso: 100, grain: 0.60, clumping: 0.24, uPeak: 0.63, chroma: 0, mono: true },
  { id: 'tmax100', brand: 'Kodak', name: 'T-Max 100', group: B, iso: 100, grain: 0.65, clumping: 0.24, uPeak: 0.63, chroma: 0, mono: true },
  { id: 'fp4', brand: 'Ilford', name: 'FP4 Plus 125', group: B, iso: 125, grain: 0.71, clumping: 0.36, uPeak: 0.62, chroma: 0, mono: true },
  { id: 'acros100', brand: 'Fujifilm', name: 'Acros II 100', group: B, iso: 100, grain: 0.76, clumping: 0.28, uPeak: 0.63, chroma: 0, mono: true },
  { id: 'tmax400', brand: 'Kodak', name: 'T-Max 400', group: B, iso: 400, grain: 0.86, clumping: 0.25, uPeak: 0.62, chroma: 0, mono: true },
  { id: 'xp2', brand: 'Ilford', name: 'XP2 Super 400', group: B, iso: 400, grain: 0.86, clumping: 0.30, uPeak: 0.62, chroma: 0, mono: true },
  { id: 'd400', brand: 'Ilford', name: 'Delta 400', group: B, iso: 400, grain: 0.97, clumping: 0.27, uPeak: 0.62, chroma: 0, mono: true },
  { id: 'trix400', brand: 'Kodak', name: 'Tri-X 400', group: B, iso: 400, grain: 1.30, clumping: 0.55, uPeak: 0.60, chroma: 0, mono: true },
  { id: 'hp5', brand: 'Ilford', name: 'HP5 Plus 400', group: B, iso: 400, grain: 1.45, clumping: 0.55, uPeak: 0.60, chroma: 0, mono: true },
  { id: 'd3200', brand: 'Ilford', name: 'Delta 3200', group: B, iso: 3200, grain: 2.63, clumping: 0.45, uPeak: 0.60, chroma: 0, mono: true },

  /* ---- 反转片 ---- */
  { id: 'velvia50', brand: 'Fujifilm', name: 'Velvia 50', group: R, iso: 50, grain: 0.63, clumping: 0.28, uPeak: 0.66, chroma: 0.018 },
  { id: 'provia100f', brand: 'Fujifilm', name: 'Provia 100F', group: R, iso: 100, grain: 0.71, clumping: 0.30, uPeak: 0.65, chroma: 0.018 },
  { id: 'e100', brand: 'Kodak', name: 'Ektachrome E100', group: R, iso: 100, grain: 0.78, clumping: 0.30, uPeak: 0.65, chroma: 0.018 },
];

export function filmById(id) {
  return FILM_STOCKS.find((f) => f.id === id) || FILM_STOCKS.find((f) => f.id === 'portra400');
}

/** 按类别分组，供面板渲染（保持 FILM_STOCKS 的组内顺序）。 */
export function filmsByGroup() {
  const order = [C, B, R];
  return order.map((g) => ({ group: g, films: FILM_STOCKS.filter((f) => f.group === g) }));
}

/* ================================================================
   推拉冲
   ================================================================ */
export const STOPS = [
  { v: -1, label: '拉一档', short: '−1' },
  { v: 0, label: '箱速', short: '箱' },
  { v: 1, label: '推一档', short: '+1' },
  { v: 2, label: '推二档', short: '+2' },
  { v: 3, label: '推三档', short: '+3' },
];

/** 等效 ISO。 */
export function equivalentIso(stock, stops = 0) {
  return Math.round(stock.iso * Math.pow(2, stops));
}

/** 相对颗粒度（Portra 400/135/箱速 = 1.00）。 */
export function grainIndex(stock, stops = 0) {
  const isoTerm = Math.pow(2, stops * ISO_EXP);
  const pen = stops > 0
    ? 1 + PUSH_COEF * stops * stops
    : stops < 0 ? Math.pow(PULL_FACTOR, -stops) : 1;
  return stock.grain * isoTerm * pen;
}

/* ================================================================
   解析：胶片 + 感光度 + 画幅 + 图像尺寸 → applyGrain 参数
   ================================================================ */
/**
 * @param {object} o
 * @param {object|string} o.film       胶片预设对象或其 id
 * @param {number} o.stops             推拉冲档数（-1 / 0 / 1 / 2 / 3）
 * @param {string} o.gauge             画幅 id
 * @param {number} o.amount            颗粒量微调（1 = 标称）
 * @param {number} o.imageWidth        图像宽（像素）
 * @param {number} o.imageHeight       图像高（像素）
 * @param {number} [o.clumping]        覆盖预设的团簇度
 * @returns {{radiusPx:number, strength:number, clumping:number, uPeak:number,
 *            lumaChroma:number, mono:boolean, weights:number[], chromaRadiusScale:number,
 *            grainIndex:number, iso:number, gaugeScale:number}}
 */
export function resolveFilmParams(o) {
  const stock = typeof o.film === 'string' ? filmById(o.film) : (o.film || filmById('portra400'));
  const stops = Math.max(-1, Math.min(3, Math.round(o.stops || 0)));
  const gauge = gaugeById(o.gauge);
  const amount = o.amount === undefined ? 1 : Math.max(0, o.amount);

  const g = grainIndex(stock, stops);

  // 画幅 → 相对尺度。见 §三：颗粒按画幅对角线定义，不是固定像素数。
  const gaugeScale = Math.pow(REF_FRAME_DIAG_MM / gauge.diag, GAUGE_EXP);

  const w = Math.max(1, o.imageWidth || 6000);
  const h = Math.max(1, o.imageHeight || 4000);
  const diagPx = Math.sqrt(w * w + h * h);

  // 【半径】随 g **亚线性**（g^0.65，见 RADIUS_G_EXP 的注释）：
  //   高速乳剂颗粒变大但远非线性，「更密」远比「更大」重要。
  // 【幅度】随 g 线性但高端压缩（ampExponent）：感知尺度本就有压缩。
  //   amount 只作用于幅度：尺寸是胶片/ISO/画幅已经决定好的物理量，
  //   颗粒量是「我想让它多显」的主观旋钮。
  const sizeFactor = Math.pow(g, RADIUS_G_EXP) * gaugeScale * (diagPx / REF_IMAGE_DIAG_PX);
  const radiusPx = REF_RADIUS_PX * sizeFactor;

  return {
    radiusPx,
    strength: REF_STRENGTH * ampExponent(g) * gaugeScale * amount,
    clumping: o.clumping === undefined ? stock.clumping : o.clumping,
    uPeak: stock.uPeak,
    lumaChroma: stock.mono ? 0 : (stock.chroma === undefined ? 0.025 : stock.chroma),
    mono: !!stock.mono,
    weights: stock.mono ? [1, 1, 1] : [0.90, 0.95, 1.00],
    chromaRadiusScale: 1.3,
    // 供 UI 显示
    grainIndex: g,
    iso: equivalentIso(stock, stops),
    gaugeScale,
  };
}

/* 包络降采样倍率由 core/grain.mjs 的 autoEnvelopeStride 提供（那里有 clusterSigma，
   保持单一真源）。这里再导出一次，方便面板只 import 一个模块。 */
export { autoEnvelopeStride, autoFineStride } from './grain.mjs';
