/**
 * 胶片暗盒「珐琅徽章」素材生成器
 * ==================================================================
 * 风格来源：用户提供的参考图（深色牛仔布上散落的胶片暗盒徽章）。
 * 抽出的可复现要素：
 *   ① 扁平高饱和色块，没有渐变、没有写实光影
 *   ② 匀黑描边把所有形状箍成一个整体（这是「徽章感」的来源）
 *   ③ 右侧伸出的片头条，带两排齿孔 —— 这是「胶片」的身份标识
 *   ④ 粗体压缩字，牌名小字拉开字距，感光度数字极大
 *   ⑤ 顶层一道斜向树脂高光，模拟珐琅/滴胶的凸起
 *
 * 为什么用 SVG 而不是生成式模型：
 *   · 这个风格本来就是平面矢量设计，生成模型只会引入噪声与不一致
 *   · 需要在 30px 缩略图与 58px 卡片两种尺寸下都清晰 —— 矢量天然解决
 *   · 二十几款胶片要求形制**完全一致**，只换配色；参数化生成能保证
 *   · 每个 symbol 不到 2KB，内联进 HTML 不会让文件膨胀
 */

/* 色路与文案表已上移到 core/pinart.mjs —— 预览的 SVG 徽章与插件的 CSS 徽章
   共用同一份数据，避免两处各写一份而漂移。这里只做几何与 SVG 组装。 */
export { COLORWAYS, colorwayFor, colorwayOf, badgeText, colorwayCensus } from '../core/pinart.mjs';
import { COLORWAYS, colorwayFor, badgeText } from '../core/pinart.mjs';

/* ------------------------------------------------------------------
   几何常量（viewBox 0 0 120 120）
   比例对照参考图：盒身约 62% 宽，片头条露出约 32%，两排各 5 个齿孔。
   ------------------------------------------------------------------ */
const BOX = { x: 4, y: 10, w: 74, h: 100, r: 9 };      // 盒身（标签面）
const TONGUE = { x: 52, y: 16, w: 64, h: 62, r: 8 };   // 片头条（被盒身压在下面，右侧露出 38px）
const SW = 3.6;                                        // 描边宽度
const TEXT_L = 13;                                     // 文字左边界
const TEXT_W = 56;                                     // 文字可用宽度
const HOLE_X = [82, 88.4, 94.8, 101.2, 107.6];         // 齿孔横向位置（5 个一组）
const HOLE_Y = [22, 68];                               // 上、下两排齿孔

/** 粗体压缩字的宽度估算，用来把字号收到框内 */
function fitSize(text, maxW, base, min, track) {
  let size = base;
  while (size > min) {
    if (text.length * (0.56 * size + track) <= maxW) break;
    size -= 0.5;
  }
  return size;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * 生成一枚徽章的 <symbol>。
 * @param {string} id        symbol id（同时作为 <use> 的引用名）
 * @param {string} cwKey     色路名
 * @param {object} text      { brand, iso, model }
 */
export function pinSymbol(id, cwKey, text) {
  const c = COLORWAYS[cwKey] || COLORWAYS.ilfordB;
  const rule = c.ink;   // 分隔线用字色
  const brand = esc(text.brand);
  const model = esc(text.model);
  const iso = esc(text.iso);

  const brandSize = fitSize(brand, TEXT_W, 11.5, 6.5, 1.0).toFixed(1);
  const modelSize = fitSize(model, TEXT_W, 9.5, 6, 0.8).toFixed(1);
  // ISO 数字：三位数时收到 58px 内；两位/一位可以放大到上限
  const isoSize = Math.min(40, fitSize(iso, TEXT_W, 40, 20, -1.2)).toFixed(1);

  const holeXs = HOLE_X;
  const holes = HOLE_Y
    .map((y) => holeXs.map((x) => `<rect x="${x}" y="${y}" width="4.4" height="4.5" rx="1.2"/>`).join(''))
    .join('');

  const clipId = `cl-${id}`;

  return `<symbol id="${id}" viewBox="0 0 120 120">
<defs>
<clipPath id="${clipId}">
<rect x="${BOX.x}" y="${BOX.y}" width="${BOX.w}" height="${BOX.h}" rx="${BOX.r}"/>
<rect x="${TONGUE.x}" y="${TONGUE.y}" width="${TONGUE.w}" height="${TONGUE.h}" rx="${TONGUE.r}"/>
</clipPath>
</defs>
<g stroke="#0c0c0c" stroke-width="${SW}" stroke-linejoin="round" stroke-linecap="round">
<rect x="${TONGUE.x}" y="${TONGUE.y}" width="${TONGUE.w}" height="${TONGUE.h}" rx="${TONGUE.r}" fill="${c.strip}"/>
<rect x="${BOX.x}" y="${BOX.y}" width="${BOX.w}" height="${BOX.h}" rx="${BOX.r}" fill="${c.box}"/>
</g>
<g fill="${c.holes}">${holes}</g>
<g font-family="'Arial Narrow','Helvetica Neue',Impact,'PingFang SC',sans-serif" font-weight="700" fill="${c.ink}">
<text x="${TEXT_L}" y="37" font-size="${brandSize}" letter-spacing="1">${brand}</text>
<text x="${TEXT_L}" y="84" font-size="${isoSize}" font-weight="800" letter-spacing="-1.2">${iso}</text>
<text x="${TEXT_L}" y="99" font-size="${modelSize}" letter-spacing=".8" opacity=".82">${model}</text>
</g>
<rect x="${TEXT_L}" y="43" width="30" height="2.2" rx="1.1" fill="${rule}" opacity=".62"/>
<g clip-path="url(#${clipId})">
<rect x="0" y="0" width="120" height="120" fill="url(#pinGloss)"/>
</g>
</symbol>`;
}

/** 树脂高光：所有徽章共用一份渐变定义 */
export const GLOSS_DEFS = `<defs>
<linearGradient id="pinGloss" x1="0" y1="0" x2="0.42" y2="1">
<stop offset="0" stop-color="#ffffff" stop-opacity=".40"/>
<stop offset=".30" stop-color="#ffffff" stop-opacity=".12"/>
<stop offset=".52" stop-color="#ffffff" stop-opacity="0"/>
<stop offset=".82" stop-color="#000000" stop-opacity=".07"/>
<stop offset="1" stop-color="#000000" stop-opacity=".22"/>
</linearGradient>
</defs>`;

/**
 * 按胶片记录生成徽章规格（id + 三段文字）。
 * 同一款胶片在页面上被引用多次，但 symbol 只定义一次。
 */
export function pinSpec(stock) {
  return {
    key: stock.id,
    cw: colorwayFor(stock),
    text: badgeText(stock),
  };
}

/** 把一批胶片编成 sprite：<svg style="display:none"><defs/>…<symbol/>…</svg> */
export function buildSprite(stocks) {
  const seen = new Set();
  const specs = [];
  for (const s of stocks) {
    const sp = pinSpec(s);
    if (seen.has(sp.key)) continue;
    seen.add(sp.key);
    specs.push(sp);
  }
  const body = specs.map((sp) => pinSymbol(`pin-${sp.key}`, sp.cw, sp.text)).join('\n');
  return {
    html: `<svg width="0" height="0" style="position:absolute" aria-hidden="true">${GLOSS_DEFS}${body}</svg>`,
    specs,
  };
}

/** 页面上引用一枚徽章 */
export const pinUse = (id, cls = 'pin') => `<svg class="${cls}" viewBox="0 0 120 120"><use href="#pin-${id}"/></svg>`;
