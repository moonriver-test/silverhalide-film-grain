/* 面板浏览器预演器
 *
 * 【为什么需要它】PS 里没有控制台、没有热重载、没有元素检查器。
 * 面板改版后「徽章里的字有没有溢出盒身」「flex 有没有塌」这类问题，
 * 送进 PS 再发现，代价是「重启 PS → 点开 → 肉眼猜 → 再改 → 再重启」。
 *
 * 【做法】把 plugin/index.html 原样拿来，只做三件事：
 *   ① 把两个 <script> 的路径改成相对本文件（仍在同一台服务下）
 *   ② 在 main.js 之前插入一个 require('photoshop') 的桩
 *   ③ 注入一段「面板宽度约束」的样式，让 body 等于真实面板宽度
 * 于是 main.js 会真的跑起来：buildControls + syncUI 都是**生产代码**，
 * 只有图层读写走桩。截出来的图就是面板在 PS 里的样子（预览图另外贴一张）。
 *
 * 运行：node tools/build-panel-preview.mjs   （需先 node plugin/build.mjs）
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { decodePixels } from '../core/io.mjs';

const require = createRequire(import.meta.url);
const jpeg = require('C:/Users/qijin/.workbuddy/binaries/node/workspace/node_modules/jpeg-js');

const SRC = 'C:/Users/qijin/Desktop/未命名导出/DSC_1603.jpg';
const OUT = 'ui-preview/panel-harness.html';
const PW = 320, PH = 152;   // 面板预览框的真实内容尺寸（348 − 左右各 14）

/* ---- 1. 准备一张 1:1 的演示裁切（面板里显示的就是 1:1 原生像素）---- */
let photo = null;
if (fs.existsSync(SRC)) {
  const jpg = jpeg.decode(fs.readFileSync(SRC), { formatAsRGBA: true });
  const X = 1700, Y = 2860;
  const rgb = new Uint8Array(PW * PH * 3);
  for (let y = 0; y < PH; y++) {
    for (let x = 0; x < PW; x++) {
      const s = ((Y + y) * jpg.width + (X + x)) * 4;
      const d = (y * PW + x) * 3;
      rgb[d] = jpg.data[s]; rgb[d + 1] = jpg.data[s + 1]; rgb[d + 2] = jpg.data[s + 2];
    }
  }
  // 用核心自带的分段 PNG（stored deflate）写出，无需额外依赖
  const { encodePNG } = await import('../core/png.mjs');
  fs.writeFileSync('ui-preview/harness-preview.png', encodePNG(rgb, PW, PH));
  photo = "harness-preview.png";
  console.log(`演示裁切 ${PW}×${PH} @ ${X},${Y} → ui-preview/harness-preview.png`);
} else {
  console.log('（没找到演示照片，预览框将显示真实空态）');
}

/* ---- 2. 改写 plugin/index.html ---- */
let html = fs.readFileSync('plugin/index.html', 'utf8');

const scripts = `<script src="../plugin/dist/core.js"></script>
<script>
/* require('photoshop') 的桩：只让 main.js 能跑起来渲染界面。
   图层相关的一切都不提供 —— updatePreview 会在 app.activeDocument 上抛错并走空态，
   这正是我们想要的：界面渲染走生产代码，文档交互不在预演范围内。 */
window.require = function (m) {
  if (m !== 'photoshop') throw new Error('harness: 未知模块 ' + m);
  return {
    app: {}, imaging: {}, constants: { LayerKind: {}, ElementPlacement: {} },
    core: { executeAsModal: function (f) { return f(); } }
  };
};
</script>
<script src="../plugin/main.js"></script>`;

html = html.replace(/<script src="dist\/core\.js"><\/script>\s*<script src="main\.js"><\/script>/, scripts);

// 面板宽度约束 + 深色底衬，让截图就是「面板在 PS 里的样子」
//
// 【为什么要把 :root 再抄一遍放在最后】
// 面板里有 @media (prefers-color-scheme: light) 覆盖浅色变量。
// 截图浏览器通常处于浅色模式，会渲染出浅色版 —— 但我们要核对的是深色。
// 把原来的深色 :root 块**原样搬到样式表末尾**，靠顺序压过媒体查询，
// 而不是在预演器里另抄一份色值（那样两边会漂移）。
//
// 【为什么要在预演里改字体】
// 本机装了 Adobe 的 Source Han Sans SC，截图用的无头浏览器把它渲染成了错误的字形
// （汉字全变成别的字）。这是截图工具的问题、不是面板的问题（PS 里正常），
// 但会让我没法核对文案。预演里换掉字体栈只为能看清。
const rootDark = html.match(/:root\s*\{[^}]*\}/);
html = html.replace('</style>', `
  /* ---- 仅预演用 ---- */
  html { background:#101010; min-height:100%; }
  body { width:348px; margin:0 auto; min-height:100vh;
         font-family:"Inter","PingFang SC","Microsoft YaHei",system-ui,sans-serif !important; }
  ${rootDark ? rootDark[0] : ''}
</style>`);
if (!rootDark) console.warn('⚠ 没找到 :root 块，预演可能仍按浅色渲染');

// 预览图与状态文字改成演示内容（main.js 在无文档时会写成空态）
const demo = (extra) => `
<script>
setTimeout(function () {
  var img = document.getElementById('preview');
  if (img && ${JSON.stringify(photo)}) { img.src = ${JSON.stringify(photo)}; }
  var e = document.getElementById('pvEmpty'); if (e) e.style.display = 'none';
  var i = document.getElementById('pvInfo'); if (i) i.textContent = '1:1 · 320×152 @ 1700,2860';
  var s = document.getElementById('status');
  if (s) s.textContent = '完成。Portra 400 · ISO 400　320×152　5.2 s\\n颗粒写在独立图层上，源图层未改动 —— 再点应用是替换，不会叠加。';
  var r = document.getElementById('readout');
  if (r) r.innerHTML = '<span><b>μr</b> 2.00px</span><span><b>σc</b> 6.8px</span><span><b>S</b> 0.0140</span>';
  var b = document.getElementById('bindOut');
  if (b) b.textContent = '源：背景　→　银盐颗粒 · 源 12';
  ${extra}
}, 900);
</script>
</body>`;

// 收起态
fs.writeFileSync(OUT, html.replace('</body>', demo('')));
// 展开态：真的去点一下胶片卡，走的是 main.js 的真实事件处理器
fs.writeFileSync(OUT.replace('.html', '-open.html'),
  html.replace('</body>', demo(`document.getElementById('filmBtn').click();
  var ad = document.getElementById('advH'); if (ad) ad.click();`)));

console.log(`写出 ${OUT}（${(html.length / 1024).toFixed(1)}KB）与 panel-harness-open.html`);
console.log('服务根目录要用 film-grain-plugin/，访问 ui-preview/panel-harness.html');
