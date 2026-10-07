/**
 * 胶片徽章的「色路」与文案表
 * ==================================================================
 * 这是**唯一的色路来源**：ui-preview 的 SVG 徽章与 plugin 的 CSS 徽章
 * 都从这里取色，避免两处各写一份而漂移。
 *
 * 【为什么徽章不用 SVG 渲染】
 * Adobe 官方「Known UXP Issues」明确写着：UXP 的 SVG 渲染器只针对简单图标，
 * 复杂 SVG 可能完全不渲染或渲染异常；本机在售的 Film Emulation 插件也
 * 一处 SVG 都没用（图标全走 PNG + <img>）。
 * 而徽章要用的 <symbol>+<use>+clipPath+linearGradient+text 远超「简单图标」，
 * 所以插件里改成纯 CSS + div 拼装（见 plugin/index.html 的 .pin 一节），
 * 只把颜色与文案放在这里共享。
 */

/** 盒身 / 片条 / 字色 / 齿孔 */
export const COLORWAYS = {
  // 柯达彩色负片 —— 琥珀黄
  kodakC: { box: '#e8a72a', strip: '#7d5a2e', ink: '#211604', holes: '#fbf3e2' },
  // 富士彩色负片 —— 绿
  fujiC: { box: '#0f9c4c', strip: '#8a9c2a', ink: '#04210f', holes: '#eefbe8' },
  // 柯达黑白 —— 炭黑配白字
  kodakB: { box: '#1c1c20', strip: '#5a5a60', ink: '#f0f0ec', holes: '#e8e8e4' },
  // 富士黑白 —— 冷灰蓝。要读作单色（黑白片），又要与柯达炭黑分得开
  fujiB: { box: '#46505c', strip: '#8d99a6', ink: '#f2f4f6', holes: '#eef1f4' },
  // 依尔福黑白 —— 象牙白配黑字
  ilfordB: { box: '#f0efe9', strip: '#9a9a94', ink: '#131313', holes: '#ffffff' },
  // 柯达反转片 —— 红
  kodakR: { box: '#d4442c', strip: '#3a2a52', ink: '#fff4f0', holes: '#ffe8e2' },
  // 富士反转片 —— 紫蓝
  fujiR: { box: '#3d3aa0', strip: '#c8403a', ink: '#f0f0ff', holes: '#e8e8ff' },
};

/** 分组 → 色路。key 是归一化后的字母。
 *  ⚠️ core/film.mjs 里 stock.group 存的是**中文字符串**（'彩色负片' 等），
 *  不是字母，所以必须按前缀归一化，不能直接当键用。 */
const GROUP_COLORWAY = {
  C: { Kodak: 'kodakC', Fujifilm: 'fujiC' },
  B: { Kodak: 'kodakB', Ilford: 'ilfordB', Fujifilm: 'fujiB' },
  R: { Kodak: 'kodakR', Fujifilm: 'fujiR' },
};

export function groupKind(group) {
  const g = String(group || '');
  if (g.startsWith('彩色')) return 'C';
  if (g.startsWith('黑白')) return 'B';
  if (g.startsWith('反转')) return 'R';
  return null;
}

/**
 * 取色路。**取不到就抛错，不静默回退** ——
 * 这里曾因键不匹配而全部回退成同一个颜色，23 款徽章全白却毫无提示。
 */
export function colorwayFor(stock) {
  const kind = groupKind(stock && stock.group);
  const byBrand = kind && GROUP_COLORWAY[kind];
  const cw = byBrand && byBrand[stock.brand];
  if (!cw) {
    throw new Error(
      '没有为「' + (stock && stock.brand) + ' / ' + (stock && stock.group) +
      '」（id=' + (stock && stock.id) + '）定义色路。请在 COLORWAYS/GROUP_COLORWAY 里补上。'
    );
  }
  return cw;
}

export const colorwayOf = (stock) => COLORWAYS[colorwayFor(stock)];

/* 牌名短写：徽章盒身内宽只有 ~24px，8 字符的 FUJIFILM 一定溢出，
   所以统一收成 4–6 字符。SVG 版能自动缩字号，CSS 版不能，只能靠短写。 */
const BRAND_SHORT = { Kodak: 'KODAK', Fujifilm: 'FUJI', Ilford: 'ILFORD' };

/** 型号短写：徽章面积有限，长名收进 4–8 个字符 */
const MODEL_SHORT = {
  ektar100: 'EKTAR', portra160: 'PORTRA', portra400: 'PORTRA', portra800: 'PORTRA',
  gold200: 'GOLD', ultramax400: 'ULTRA', proimage100: 'PRO',
  superia400: 'SUPERIA', c200: 'C200',
  panf50: 'PAN F', d100: 'DELTA', d400: 'DELTA', d3200: 'DELTA',
  tmax100: 'T-MAX', tmax400: 'T-MAX',
  fp4: 'FP4', acros100: 'ACROS', xp2: 'XP2', trix400: 'TRI-X', hp5: 'HP5',
  velvia50: 'VELVIA', provia100f: 'PROVIA', e100: 'E100',
};

/** 徽章上的三段文字 */
export function badgeText(stock) {
  return {
    brand: BRAND_SHORT[stock.brand] || String(stock.brand),
    iso: String(stock.iso),
    model: MODEL_SHORT[stock.id] || String(stock.name).split(' ')[0],
  };
}

/** 供构建脚本自检：统计色路分布，并在种类过少时报警 */
export function colorwayCensus(stocks) {
  const count = {};
  for (const f of stocks) {
    const k = colorwayFor(f);
    count[k] = (count[k] || 0) + 1;
  }
  return count;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ------------------------------------------------------------------
   盒身文字的自适应字号
   ------------------------------------------------------------------
   SVG 版可以按框宽逐字量算；CSS 版没有这个能力，所以在这里算好、内联输出
   font-size —— 等价于 SVG 版 fitSize() 的效果。

   之前是硬编码 6px / 14px，后果是：KODAK 显得偏小、ILFORD 快贴到边框、
   四位 ISO（Delta 3200）还要靠一个 .n4 类单独降字号。
   现在改成由字符数推：短牌名自动放大，长牌名自动收，视觉重量拉齐。

   盒身可用文字宽度（56px 徽章）：
     56 × 61.7%(盒身宽) − 2×2px(描边) − (3+3)px(内边距) ≈ 24.5px
   每字符占字号的倍数（粗体无衬线，含字距）：
     牌名大写 ≈ 0.62em，另加 .04em 字距 → 0.66
     型号     ≈ 0.62em，另加 .03em 字距 → 0.65
     数字     ≈ 0.58em，另加 −.045em 字距 → 0.535
   ------------------------------------------------------------------ */
const CAP_W = 24.5;

function fitSize(text, perChar, cap, min) {
  const n = Math.max(1, String(text).length);
  let s = CAP_W / (n * perChar);
  if (s > cap) s = cap;
  if (s < min) s = min;
  return Math.round(s * 10) / 10;
}

/**
 * 生成一枚徽章的 HTML（纯 CSS 拼装，无 SVG）。
 *
 * 【为什么放在核心而不是面板里】
 * 这是个纯字符串函数，平台无关。放在这里就能被 Node 侧复用 ——
 * `tools/build-panel-preview.mjs` 用它把**真实徽章标记**渲染到浏览器里核对，
 * 这样「字会不会溢出盒身」这类问题能在进 PS 之前就看见。
 * PS 里没有控制台，送进去再发现问题代价太大。
 *
 * 结构与 index.html 的 .pin 一节对应：
 *   .tg 片头条（先画，被盒身压住） / .hs 两排齿孔 / .bx 盒身（含高光与文字）
 *
 * @param {object} stock      胶片记录
 * @param {'card'|'mini'} size  card = 56px 全细节；mini = 34px 只留形状与配色
 * @param {object} [fallbackCw] 色路取不到时的兜底配色（面板传，构建脚本不传则抛错）
 */
export function pinMarkup(stock, size, fallbackCw) {
  let cw;
  try { cw = colorwayOf(stock); }
  catch (e) { if (!fallbackCw) throw e; cw = fallbackCw; }

  let holes = '';
  let cap = '';

  /* 齿孔两种尺寸都画 —— 它是让徽章读作「胶片」而不是「一块色」的关键特征。
     大尺寸 5 个/排（与参考图一致）；34px 缩略图上放 5 个会糊成一条虚线，减到 3 个。 */
  const nHoles = size === 'card' ? 5 : 3;
  let row = '';
  for (let i = 0; i < nHoles; i++) row += `<i style="background:${cw.holes}"></i>`;
  holes = `<span class="hs r1">${row}</span><span class="hs r2">${row}</span>`;

  if (size === 'card') {
    const t = badgeText(stock);
    const brandFs = fitSize(t.brand, 0.66, 7.5, 5.5);
    const isoFs = fitSize(t.iso, 0.535, 16, 10);
    const modelFs = fitSize(t.model, 0.65, 8, 5);
    cap = `<span class="cap" style="color:${cw.ink}">`
      + `<b style="font-size:${brandFs}px">${esc(t.brand)}</b>`
      + `<u style="font-size:${isoFs}px">${esc(t.iso)}</u>`
      + (t.model ? `<em style="font-size:${modelFs}px">${esc(t.model)}</em>` : '')
      + '</span>';
  }

  return `<span class="pin ${size}">`
    + `<span class="tg" style="background:${cw.strip}"></span>`
    + holes
    + `<span class="bx" style="background:${cw.box}"><span class="gl"></span>${cap}</span>`
    + '</span>';
}
