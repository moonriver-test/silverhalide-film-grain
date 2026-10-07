/**
 * 深色主题预览稿构建
 * ------------------------------------------------------------------
 * 1) 从 core/film.mjs 读真实胶片表（不另抄一份，避免与预设漂移）
 * 2) 参数化生成徽章 sprite（内联 SVG）
 * 3) 生成胶片列表 HTML
 * 4) 替换模板占位符，写出 ui-preview-dark.html
 *
 * 只读核心、只写 ui-preview/ 下的文件 —— 不触碰 plugin/。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILM_STOCKS } from '../core/film.mjs';
import { buildSprite, pinUse, colorwayFor, COLORWAYS } from './pins.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));   // 注意：路径含中文，
const OUT = here;                                            // 必须用 fileURLToPath

/* ---- 1. 徽章 sprite ---- */
// 先做一次色路自检：曾因为分组键写成字母、而数据里是中文字符串，
// 导致 23 款静默退回同一个色路（全白）却毫无提示。这里显式打印分布。
const cwCount = {};
for (const f of FILM_STOCKS) {
  const cw = colorwayFor(f);
  cwCount[cw] = (cwCount[cw] || 0) + 1;
}
console.log('色路分布：' + Object.entries(cwCount).map(([k, v]) => `${k}×${v}`).join('  '));
if (Object.keys(cwCount).length < 2) {
  console.error('✗ 所有胶片落到同一个色路，颜色必然不对 —— 中止');
  process.exit(1);
}
const boxColors = new Set(Object.keys(cwCount).map((k) => COLORWAYS[k].box));
if (boxColors.size !== Object.keys(cwCount).length) {
  console.error('✗ 有色路共用了同一个盒身颜色 —— 中止');
  process.exit(1);
}
console.log(`盒身色 ${boxColors.size} 种，互不重复 ✓`);

const { html: sprite, specs } = buildSprite(FILM_STOCKS);
console.log(`徽章 sprite：${specs.length} 个 symbol，${(sprite.length / 1024).toFixed(1)}KB`);

/* ---- 2. 胶片列表 ---- */
const GROUP_ORDER = ['彩色负片', '黑白负片', '反转片'];
const ROW_CAP = 16;          // 面板内不铺满 23 行，留出「可滚动」的观感
const SELECTED = 'portra400';

let rows = 0;
const listParts = [];
for (const g of GROUP_ORDER) {
  const inGroup = FILM_STOCKS.filter((f) => f.group === g);
  if (!inGroup.length) continue;
  const room = ROW_CAP - rows;
  if (room <= 0) break;
  const show = inGroup.slice(0, room);
  listParts.push(`<div class="grp">${g}</div>`);
  for (const f of show) {
    const on = f.id === SELECTED ? ' on' : '';
    listParts.push(
      `<div class="opt${on}"><span class="mini">${pinUse(f.id, 'pin mini')}</span>` +
      `<span class="n">${f.name}</span><span class="iso">${f.iso}</span></div>`
    );
    rows++;
  }
}
if (rows < FILM_STOCKS.length) {
  listParts.push(`<div class="scrollhint">· 共 ${FILM_STOCKS.length} 款 ·</div>`);
}
const listHtml = listParts.join('\n        ');

/* ---- 3. 组装 ---- */
const tpl = fs.readFileSync(path.join(OUT, 'template-dark.html'), 'utf8');

const unknown = new Set();
const counts = {
  cw: Object.keys(cwCount).length,
  groups: new Set(FILM_STOCKS.map((f) => f.group)).size,
  films: FILM_STOCKS.length,
};
/* ---- 3. 注入设计 token ---- */
/* token 的唯一来源是 tools/design-tokens.mjs（面板内联同一份，预检会断言相等）。
   这里额外补两个东西：
     · --page       仅预览页需要的牛仔布底
     · --accent*    预览稿组件的历史命名 → 别名到 canonical 的 --ac/--acd/--acl，
                    这样不用去改组件规则里的几十处 var(--accent) */
const tokenBlock = `  :root {
${renderRoot('dark', '    ')}
    --page:#0f141b;
    --accent:var(--ac); --accentd:var(--acd); --accentl:var(--acl);
  }`;

const html = tpl
  .replace('{{tokens}}', tokenBlock)
  .replace('{{sprite}}', sprite)
  .replace('{{list}}', listHtml)
  .replace(/\{\{(cw|groups|films)\}\}/g, (m, k) => String(counts[k]))
  .replace(/\{\{pin:([a-zA-Z0-9]+)(?:\|([a-z]+))?\}\}/g, (m, id, extra) => {
    if (!specs.some((s) => s.key === id)) { unknown.add(id); return ''; }
    return pinUse(id, extra ? `pin ${extra}` : 'pin');
  });

if (unknown.size) {
  console.error('模板引用了不存在的胶片 id：' + [...unknown].join(', '));
  process.exit(1);
}
const leftover = html.match(/\{\{[^}]*\}\}/g);
if (leftover) {
  console.error('未替换的占位符：' + leftover.slice(0, 5).join(' '));
  process.exit(1);
}

const outPath = path.join(OUT, 'ui-preview-dark.html');
fs.writeFileSync(outPath, html);
console.log(`写出 ${outPath}（${(html.length / 1024).toFixed(0)}KB，内联 SVG，零外部依赖）`);
console.log(`胶片列表 ${rows} 行 / 共 ${FILM_STOCKS.length} 款`);
