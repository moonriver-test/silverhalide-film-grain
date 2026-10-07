/* 把 Seedream 生成的素材处理成预览稿能直接用的小图。
 *
 * 运行：node tools/build-ui-preview.mjs
 *
 * 与第一版（像素画）的区别：
 *   · 素材换成**写实 3D 渲染**的 135 暗盒，白底而非棋盘格底
 *   · 量化从 5 位放宽到 6 位 —— 写实图有渐变，5 位会出现可见色阶断层
 *   · 尺寸提到 128 / 256（写实图需要更多像素才能读出细节）
 *
 * 产物：ui-preview/asset-*.png、ui-preview/ui-preview.html（自包含，可直接双击打开）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG, clearRegion, alphaBounds, fitSquare, encodePNG_RGBA, removeFlatBackground, despeckle, quantize } from './img.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const SRC = path.join(ROOT, 'ui-preview', 'assets2');
const OUT = path.join(ROOT, 'ui-preview');

/* 母本是柯达那款；另外三款是用它做图生图只换配色的，
 * 所以四张的机位/光照/片头完全一致（这是视觉统一的关键）。 */
const MAP = {
  kodak: 'Photorealistic_3D_product_rend_2026-10-06T04-42-43.png',
  fuji: 'Keep_this_exact_same_35mm_film_2026-10-06T04-43-13.png',
  bw: 'Keep_this_exact_same_35mm_film_2026-10-06T04-43-30.png',
  slide: 'Keep_this_exact_same_35mm_film_2026-10-06T04-43-46.png',
};

const SIZES = { thumb: 128, big: 224 };
const QUANT_BITS = 6;   // 写实图：5 位会断层，6 位看不出差别
const dataUri = {};

console.log('处理素材：');
for (const [key, file] of Object.entries(MAP)) {
  const p = path.join(SRC, file);
  if (!fs.existsSync(p)) { console.error('  缺失 ' + file); process.exit(1); }
  const img = decodePNG(fs.readFileSync(p));

  // 1) 抠掉白底（写实图是纯白底 + 无投影，洪填「亮 + 低饱和」即可干净分离）
  const flood = removeFlatBackground(img);
  // 水印兜底
  clearRegion(img, Math.round(img.width * 0.84), Math.round(img.height * 0.90), img.width, img.height);
  const speck = despeckle(img, 0.01);
  quantize(img, QUANT_BITS);

  const b = alphaBounds(img, 24);
  if (!b) { console.error('  ' + key + ' 整张全透明？'); process.exit(1); }
  const note = [];
  for (const [tag, size] of Object.entries(SIZES)) {
    const px = fitSquare(img, b, size, 0.04);
    const png = encodePNG_RGBA(px, size, size);
    fs.writeFileSync(path.join(OUT, `asset-${key}-${tag}.png`), png);
    note.push(`${tag} ${(png.length / 1024).toFixed(1)}KB`);
    if (tag === 'big') dataUri[key] = 'data:image/png;base64,' + png.toString('base64');
  }
  console.log(`  ${key.padEnd(6)} 抠底 ${(flood.ratio * 100).toFixed(0)}%　去斑 ${speck.dropped}px　裁出 ${b.right - b.left}×${b.bottom - b.top}　${note.join('　')}`);
}

const tplPath = path.join(OUT, 'template.html');
if (!fs.existsSync(tplPath)) { console.error('\n找不到 ui-preview/template.html'); process.exit(1); }
let html = fs.readFileSync(tplPath, 'utf8');

/* 只嵌一次。模板里每张素材被引用 2~7 次，如果按引用点内嵌，
   同一份 base64 会被复制 16 遍（实测 1.9MB）。
   改成在脚本里放一张表、用 data-a 属性赋值。 */
const nRef = (html.match(/data-a="/g) || []).length;
if (!html.includes('{{assets-json}}')) { console.error('  模板缺少 {{assets-json}} 占位符'); process.exit(1); }
html = html.replace('{{assets-json}}', JSON.stringify(dataUri));
if (html.includes('{{')) { console.error('  模板仍有未替换的占位符'); process.exit(1); }

fs.writeFileSync(path.join(OUT, 'ui-preview.html'), html);
console.log(`\n${Object.keys(dataUri).length} 张素材各嵌一次（模板中共引用 ${nRef} 处）`);
console.log(`→ ui-preview/ui-preview.html（${(html.length / 1024).toFixed(0)} KB，自包含）`);
