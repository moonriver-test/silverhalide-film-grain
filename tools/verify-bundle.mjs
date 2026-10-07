/* 打包产物预检：在 Node 里加载 plugin/dist/core.js，确认它真的可用
 *
 * 为什么值得单独做：UXP 里没有控制台、没有热重载，出错只能靠肉眼。
 * 万一打包产物的全局名或 API 面有问题，我们希望在进 PS 之前就发现，
 * 而不是让用户在 PS 里对着一个不工作的面板猜。
 *
 * 运行：node tools/verify-bundle.mjs
 */

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {
  COLOR_DARK, COLOR_LIGHT, RADIUS, TYPE, parseRootBlocks, diffTokens, panelTokens,
} from './design-tokens.mjs';

const FILE = 'plugin/dist/core.js';
if (!fs.existsSync(FILE)) {
  console.error('找不到 ' + FILE + '，请先运行 node plugin/build.mjs');
  process.exit(1);
}

const code = fs.readFileSync(FILE, 'utf8');

// 1) 不能残留 ESM 语法（UXP 的 <script src> 不认）
const esm = code.match(/^\s*(import|export)\s/m);
console.log('=== 1. 产物形态 ===');
console.log('  大小          : ' + (code.length / 1024).toFixed(1) + ' KB');
console.log('  ESM 残留      : ' + (esm ? '有 → ' + esm[0].trim() : '无 ✓'));
if (esm) process.exit(1);

// 2) 执行产物，检查全局名
// 【必须用 runInThisContext（同 realm），不能用 vm.createContext（独立 realm）】
// vm.createContext 会造一个全新的 realm，里面的 TypedArray/Math 都是另一套内建对象，
// V8 对跨 realm 的代码走慢路径 —— 实测同一段 applyGrain：
//   独立 realm 266 ms  vs  同 realm 15.5 ms，差 17 倍。
// UXP 里面板脚本与 bundle 都是同一个文档里的 <script src>，共享一个 realm，
// 所以只有同 realm 的数字才有意义。这个坑会把性能结论带偏一个数量级。
vm.runInThisContext(code);
const C = globalThis.SHC;
console.log('  全局名 SHC    : ' + (C ? '存在 ✓' : '不存在 ✗'));
if (!C) process.exit(1);

// 3) API 面
const NEED = [
  'applyGrain', 'generateGrainField', 'buildAmplitudeLUTs', 'amplitudeAt',
  'clusterSigma', 'autoEnvelopeStride', 'autoFineStride',
  'SIGMA_GRAIN_RATIO', 'ENVELOPE_STRIDE', 'CHROMA_FINE_STRIDE',
  'decodePixels', 'encodePixels', 'applyGrainBanded', 'processImage',
  'depthMax', 'allocBuffer', 'parseBitDepth',
  // v0.3 面板完全依赖这一组：胶片预设，以及「型号 × ISO × 画幅」→ 物理参数的解析
  'FILM_STOCKS', 'GAUGES', 'STOPS', 'filmsByGroup', 'filmById', 'gaugeById',
  'equivalentIso', 'grainIndex', 'resolveFilmParams',
  // v0.5 面板用纯 CSS 拼装胶片徽章，色路与文案从这里取（UXP 的 SVG 支持不可靠，见 pinart.mjs）
  'colorwayFor', 'colorwayOf', 'badgeText', 'colorwayCensus'
];
console.log('\n=== 2. API 面 ===');
const missing = NEED.filter((k) => !(k in C));
console.log('  需要 ' + NEED.length + ' 项，缺失 ' + (missing.length ? missing.join(', ') : '0 ✓'));
if (missing.length) process.exit(1);

// 3b) 胶片表自身的完整性 —— 面板直接拿它渲染，坏一条就白屏
{
  console.log('  胶片表        : ' + C.FILM_STOCKS.length + ' 款　画幅 ' + C.GAUGES.length +
    ' 种　感光度档 ' + C.STOPS.length + ' 个');
  const bad = [];
  for (const f of C.FILM_STOCKS) {
    for (const k of ['id', 'brand', 'name', 'group', 'iso', 'grain', 'clumping', 'uPeak']) {
      if (f[k] === undefined || f[k] === null || f[k] === '') bad.push(f.id + '.' + k);
    }
    if (typeof f.chroma !== 'number') bad.push(f.id + '.chroma');
  }
  const nCombo = C.FILM_STOCKS.length * C.STOPS.length * C.GAUGES.length;
  for (const f of C.FILM_STOCKS) {
    for (const s of C.STOPS) {
      for (const g of C.GAUGES) {
        const p = C.resolveFilmParams({ film: f.id, stops: s.v, gauge: g.id, imageWidth: 6000, imageHeight: 4000 });
        const tag = f.id + '/' + s.v + '/' + g.id;
        if (!(p.radiusPx > 0 && isFinite(p.radiusPx))) bad.push(tag + '.radiusPx');
        if (!(p.strength > 0 && isFinite(p.strength))) bad.push(tag + '.strength');
        if (!(p.lumaChroma < 0.05)) bad.push(tag + '.lumaChroma 偏高');
        if (!(Math.max.apply(null, p.weights) <= 1.0001 && Math.min.apply(null, p.weights) >= 0.6)) {
          bad.push(f.id + '.weights 偏离中性');
        }
      }
    }
  }
  console.log('  全组合解析     : ' + nCombo + ' 组，异常 ' +
    (bad.length ? bad.slice(0, 8).join(', ') : '0 ✓'));
  if (bad.length) process.exit(1);
}

// 4) 真实跑一遍小尺度端到端，确认打包后行为与源一致
console.log('\n=== 3. 打包后功能自检（64×48）===');
const W = 64, H = 48;
const bits = C.parseBitDepth('bitDepth8');
console.log('  parseBitDepth("bitDepth8") = ' + bits);
console.log('  depthMax(8/16/32) = ' + C.depthMax(8) + ' / ' + C.depthMax(16) + ' / ' + C.depthMax(32));

const src = new Uint8Array(W * H * 4);
for (let i = 0; i < W * H; i++) {
  const g = 110 + ((i % 7) - 3);
  src[i * 4] = g; src[i * 4 + 1] = g; src[i * 4 + 2] = g; src[i * 4 + 3] = 255;
}
const before = Float32Array.from(src).reduce((a, b) => a + b, 0);

const dec = C.decodePixels(src, W, H, 4, 8);
let mean0 = 0;
for (let i = 0; i < dec.rgb.length; i++) mean0 += dec.rgb[i];
mean0 /= dec.rgb.length;

const F = C.resolveFilmParams({ film: 'portra400', stops: 0, gauge: '135', imageWidth: W, imageHeight: H });
 F.seed = 3;
 C.applyGrain(dec.rgb, W, H, F);

let mean1 = 0, sd = 0;
for (let i = 0; i < dec.rgb.length; i++) mean1 += dec.rgb[i];
mean1 /= dec.rgb.length;
for (let i = 0; i < dec.rgb.length; i++) sd += (dec.rgb[i] - mean1) * (dec.rgb[i] - mean1);
sd = Math.sqrt(sd / dec.rgb.length);

const out = C.encodePixels(dec.rgb, dec.alpha, W, H, 8, { seed: 3 });
console.log('  解码均值      : ' + mean0.toFixed(5));
console.log('  加颗粒后均值  : ' + mean1.toFixed(5) + '　漂移 ' + ((mean1 - mean0) * 255).toFixed(3) + ' 色阶');
console.log('  加颗粒后标准差: ' + sd.toFixed(5) + '　（应远大于量化台阶 0.0039）');
console.log('  编码输出      : ' + out.constructor.name + ' × ' + out.length + '（应为 w*h*4）');

const okLen = out.length === W * H * 4;
const okGrain = sd > 0.01;
const okDrift = Math.abs((mean1 - mean0) * 255) < 1.5;
console.log('');
console.log('  ' + (okLen ? '✓' : '✗') + ' 输出长度 w*h*4');
console.log('  ' + (okGrain ? '✓' : '✗') + ' 颗粒确实被加进去了（标准差 ' + sd.toFixed(4) + '）');
console.log('  ' + (okDrift ? '✓' : '✗') + ' 均值漂移在 1.5 色阶以内');

if (!(okLen && okGrain && okDrift)) { console.error('预检未通过'); process.exit(1); }

// 5) 3 通道路径 —— 这是 JPEG 背景层在 applyAlpha:false 下的实际返回值，
//    插件一定会走这条路，所以必须单独验一遍（alpha 走 null 分支）。
console.log('\n=== 4. 3 通道输入（alpha = null 分支）===');
{
  const src3 = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const g = 108 + ((i % 5) - 2);
    src3[i * 3] = g; src3[i * 3 + 1] = g; src3[i * 3 + 2] = g;
  }
  const d3 = C.decodePixels(src3, W, H, 3, 8);
  console.log('  decodePixels(components=3).alpha = ' + (d3.alpha === null ? 'null ✓（省下 n×4 字节）' : '不是 null ✗'));
  C.applyGrain(d3.rgb, W, H, Object.assign(C.resolveFilmParams({ film: 'trix400', gauge: '135', imageWidth: W, imageHeight: H }), { seed: 3 }));
  const o3 = C.encodePixels(d3.rgb, d3.alpha, W, H, 8, { seed: 3 });
  let alphaOk = true;
  for (let i = 0; i < W * H; i++) if (o3[i * 4 + 3] !== 255) { alphaOk = false; break; }
  console.log('  输出 alpha 通道全为 255 : ' + (alphaOk ? '✓' : '✗'));
  console.log('  输出长度 : ' + o3.length + '（应为 ' + (W * H * 4) + '）' + (o3.length === W * H * 4 ? ' ✓' : ' ✗'));
  if (!alphaOk || o3.length !== W * H * 4) { console.error('3 通道路径预检未通过'); process.exit(1); }
}

// 5) 预览用的 PNG 编码器：用 Node 的 zlib 反向解码，验证产出的 PNG 真的合法。
//    这一步很关键 —— UXP 里没有 canvas，预览全靠这个编码器；
//    如果它产出的 PNG 不合法，面板上只会看到一个破图，没有任何报错线索。
console.log('\n=== 5. 预览 PNG 编码器（用 Node zlib 反向解码验证）===');
{
  const PW = 37, PH = 23;                       // 用非 2 的幂、非整块尺寸，能暴露行对齐 bug
  const rgb8 = new Uint8Array(PW * PH * 3);
  for (let y = 0; y < PH; y++) {
    for (let x = 0; x < PW; x++) {
      const p = (y * PW + x) * 3;
      rgb8[p] = (x * 7 + y * 3) & 0xff;
      rgb8[p + 1] = (x * 2 + y * 11) & 0xff;
      rgb8[p + 2] = (x ^ y) & 0xff;
    }
  }
  const png = C.encodePNG(rgb8, PW, PH);
  console.log('  PNG 体积      : ' + png.length + ' B（原始像素 ' + (PW * PH * 3) + ' B，stored 不压缩）');

  // 签名
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  let sigOk = true;
  for (let i = 0; i < 8; i++) if (png[i] !== sig[i]) sigOk = false;
  console.log('  签名          : ' + (sigOk ? '✓' : '✗'));

  // 解析 chunk
  const zlib = await import('node:zlib');
  let off = 8, ihdr = null, idat = [], iend = false, chunks = 0;
  while (off < png.length) {
    const len = (png[off] << 24 | png[off + 1] << 16 | png[off + 2] << 8 | png[off + 3]) >>> 0;
    const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7]);
    const data = png.subarray(off + 8, off + 8 + len);
    chunks++;
    if (type === 'IHDR') ihdr = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') iend = true;
    off += 12 + len;
  }
  console.log('  chunk 结构    : ' + chunks + ' 个，IEND ' + (iend ? '存在 ✓' : '缺失 ✗'));
  const w = ihdr[0] << 24 | ihdr[1] << 16 | ihdr[2] << 8 | ihdr[3];
  const h = ihdr[4] << 24 | ihdr[5] << 16 | ihdr[6] << 8 | ihdr[7];
  console.log('  IHDR          : ' + w + '×' + h + '　位深 ' + ihdr[8] + '　色型 ' + ihdr[9] +
    '（2=真彩）　' + (w === PW && h === PH && ihdr[8] === 8 && ihdr[9] === 2 ? '✓' : '✗'));

  // 解压并还原扫描线
  const raw = zlib.inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d))));
  const rowBytes = PW * 3;
  let filterOk = true, pixelsOk = true;
  for (let y = 0; y < PH; y++) {
    const base = y * (1 + rowBytes);
    if (raw[base] !== 0) filterOk = false;
    for (let i = 0; i < rowBytes; i++) {
      if (raw[base + 1 + i] !== rgb8[y * rowBytes + i]) { pixelsOk = false; break; }
    }
    if (!pixelsOk) break;
  }
  console.log('  zlib 可解压   : ✓（解出 ' + raw.length + ' B，应为 ' + (PH * (1 + rowBytes)) + '）');
  console.log('  filter 全为 0 : ' + (filterOk ? '✓' : '✗'));
  console.log('  像素逐字节一致: ' + (pixelsOk ? '✓' : '✗'));

  const dataUrl = C.pngToDataUrl(png);
  const urlOk = dataUrl.indexOf('data:image/png;base64,') === 0 && /^[A-Za-z0-9+/=]+$/.test(dataUrl.slice(22));
  console.log('  data URL 兜底 : ' + (urlOk ? '✓ 前缀与 base64 字符集正确' : '✗'));

  if (!(sigOk && iend && filterOk && pixelsOk && urlOk && w === PW && h === PH)) {
    console.error('PNG 编码器预检未通过');
    process.exit(1);
  }
}

console.log('\n=== 6. 预览整条链路（模拟面板尺寸 336×180）===');
{
  const PW = 336, PH = 180;
  const src = new Uint8Array(PW * PH * 3);
  for (let i = 0; i < PW * PH; i++) {
    const g = 96 + ((i * 7) % 60);
    src[i * 3] = g; src[i * 3 + 1] = g; src[i * 3 + 2] = g;
  }
  const parts = [];
  // 预热必须充分：产物跑在 vm 的独立上下文里，V8 的优化层是**按上下文**独立晋升的。
  // 只调一两次测到的是解释执行的值 —— 实测差 27 倍（273 ms vs 10 ms），会把结论带偏。
  const warm = C.decodePixels(src, PW, PH, 3, 8);
  for (let i = 0; i < 25; i++) {
    const v = Float32Array.from(warm.rgb);
    C.applyGrain(v, PW, PH, Object.assign(C.resolveFilmParams({ film: 'portra400', gauge: '135', imageWidth: 6000, imageHeight: 4000 }), { seed: 100 + i }));
    C.encodePNG(C.packRGB8(v, PW, PH), PW, PH);
  }

  let t = performance.now();
  const dec = C.decodePixels(src, PW, PH, 3, 8);
  parts.push(['decodePixels', performance.now() - t]);

  const gT = [];
  for (let i = 0; i < 5; i++) {
    const v = Float32Array.from(dec.rgb);
    const tt = performance.now();
    C.applyGrain(v, PW, PH, Object.assign(C.resolveFilmParams({ film: 'portra400', gauge: '135', imageWidth: 6000, imageHeight: 4000 }), { seed: 7 + i, originX: 1712, originY: 2824 }));
    gT.push(performance.now() - tt);
  }
  parts.push(['applyGrain（含 4 个颗粒场）', Math.min.apply(null, gT)]);

  t = performance.now();
  const rgb8 = C.packRGB8(dec.rgb, PW, PH);
  parts.push(['packRGB8', performance.now() - t]);

  const pT = [];
  for (let i = 0; i < 5; i++) {
    const tt = performance.now();
    C.encodePNG(rgb8, PW, PH);
    pT.push(performance.now() - tt);
  }
  parts.push(['encodePNG', Math.min.apply(null, pT)]);
  const png = C.encodePNG(rgb8, PW, PH);

  let sum = 0;
  for (const [k, v] of parts) {
    sum += v;
    console.log('  ' + k.padEnd(28) + v.toFixed(1).padStart(7) + ' ms'
      + ('　UXP 推算 ' + (v * 1.555).toFixed(0) + ' ms').padStart(20));
  }
  console.log('  ' + '─'.repeat(28));
  console.log('  ' + '计算侧合计（不含读像素）'.padEnd(24) + sum.toFixed(1).padStart(7) + ' ms'
    + ('　UXP 推算 ' + (sum * 1.555).toFixed(0) + ' ms').padStart(20));
  console.log('  PNG 体积 : ' + (png.length / 1024).toFixed(0) + ' KB');
  console.log('  ⇒ 加上一次裁切读取（约 70~130 ms 固定开销），单次预览约 '
    + (sum * 1.555 + 130).toFixed(0) + ' ms（UXP）');
  if (sum > 400) { console.error('预览计算侧过慢'); process.exit(1); }
}

console.log('\n=== 7. 面板「不叠加」机制自检（静态） ===');
{
  /* 图层 API 没法在 Node 里跑，但可以断言「不叠加」依赖的几段代码还在。
     v0.3 之前是直接往当前图层写像素，连点两次颗粒翻倍（实测 ×1.99）。 */
  const panel = fs.readFileSync('plugin/main.js', 'utf8');
  const MUST = [
    ['createLayer', '新建独立的颗粒图层（而不是往源图层写）'],
    ['PLACEBEFORE', '把颗粒层放在源图层正上方'],
    ['GRAIN_PREFIX', '用图层名前缀识别自己的颗粒层'],
    ['sourceIdFromName', '从图层名恢复「哪层是源」的绑定（跨会话）'],
    ['layerBelow', '回退规则：颗粒层正下方即源层'],
    ['layerID', '读像素时显式指定源图层'],
    ['removeGrain', '提供「移除颗粒」恢复原图'],
  ];
  const missing = MUST.filter(([k]) => panel.indexOf(k) < 0).map(([k, why]) => k + '（' + why + '）');
  for (const [k, why] of MUST) {
    console.log('  ' + (panel.indexOf(k) >= 0 ? '✓' : '✗') + ' ' + k.padEnd(18) + why);
  }
  if (missing.length) { console.error('  缺失：' + missing.join('；')); process.exit(1); }

  /* 反向断言：不能存在「读当前图层 → 处理后原地写回同一图层」的破坏式路径。
     判据：putPixels 的目标不能是用于读取的那个 layer 变量。 */
  const destructive = /readRegion\([^)]*layerId:\s*safeId\(t\.source\)[\s\S]{0,4000}?layerID:\s*safeId\(t\.source\)/.test(panel);
  console.log('  ' + (destructive ? '✗' : '✓') + ' 未出现「读源层 → 原地写回源层」的破坏式路径');
  if (destructive) { console.error('  面板仍会破坏性写回源图层，颗粒会叠加'); process.exit(1); }
}

console.log('\n=== 8. 徽章色路全胶片自检 ===');
{
  /* 这条是「静默回退」那个 bug 的回归测试：
     曾经因为分组键写成字母、而数据里存的是中文字符串，查表全部落空，
     靠 || 兜底让 23 款徽章全渲染成同一个颜色，控制台一句提示都没有。 */
  const bad = [];
  for (const f of C.FILM_STOCKS) {
    try {
      const c = C.colorwayOf(f);
      const t = C.badgeText(f);
      if (!c || !c.box || !c.strip || !c.ink || !c.holes) throw new Error('色路字段不全');
      if (!t || !t.brand || !t.iso) throw new Error('徽章文案不全');
    } catch (e) {
      bad.push(f.id + '（' + e.message + '）');
    }
  }
  const census = C.colorwayCensus(C.FILM_STOCKS);
  const kinds = Object.keys(census);
  console.log('  色路分布 : ' + Object.entries(census).map(([k, v]) => k + '×' + v).join('  '));
  console.log('  解析失败 : ' + (bad.length ? bad.join('，') : '0 ✓'));
  if (bad.length) process.exit(1);
  if (kinds.length < 2) { console.error('  ✗ 所有胶片落到同一色路，徽章必然全一个颜色'); process.exit(1); }
  const boxes = new Set(kinds.map((k) => C.COLORWAYS[k].box));
  console.log('  盒身色   : ' + boxes.size + ' 种，' + (boxes.size === kinds.length ? '互不重复 ✓' : '有重复 ✗'));
  if (boxes.size !== kinds.length) process.exit(1);

  // 徽章文案不能溢出盒身：四位数 ISO 要单独收字号（面板用 .n4 处理）
  const longest = C.FILM_STOCKS.map((f) => C.badgeText(f)).sort((a, b) => b.brand.length - a.brand.length)[0];
  const longestIso = C.FILM_STOCKS.map((f) => C.badgeText(f)).sort((a, b) => b.iso.length - a.iso.length)[0];
  console.log('  最长牌名 : ' + longest.brand + '（' + longest.brand.length + ' 字符）');
  console.log('  最长 ISO : ' + longestIso.iso + '（' + longestIso.iso.length + ' 位，需 .n4 降字号：'
    + (longestIso.iso.length > 3 ? '是' : '否') + '）');
}

console.log('\n=== 9. 面板 DOM 引用交叉核对 ===');
{
  /* PS 里没有控制台：id 拼错只会表现为「点了没反应」或「某处永远空白」，
     根本没法调试。所以在进 PS 之前静态核对一遍。 */
  const js = fs.readFileSync('plugin/main.js', 'utf8');
  const html = fs.readFileSync('plugin/index.html', 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const classes = new Set(
    [...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean)
  );
  const wantIds = [...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  const wantSel = [...js.matchAll(/querySelector\('([^']+)'\)/g)].map((m) => m[1]);

  const missId = wantIds.filter((i) => !ids.has(i));
  const missCls = wantSel.filter((s) => s[0] === '.' && !classes.has(s.slice(1)));
  console.log('  引用 id ' + wantIds.length + ' 个 / 选择器 ' + wantSel.length + ' 个');
  console.log('  缺失     : ' + ((missId.length || missCls.length)
    ? missId.concat(missCls).join(', ') : '0 ✓'));
  if (missId.length || missCls.length) process.exit(1);

  const orphan = [...ids].filter((i) => !wantIds.includes(i));
  console.log('  孤儿 id  : ' + (orphan.length ? orphan.join(', ') : '0 ✓'));

  // 徽章靠百分比几何：两种尺寸的类名必须都在样式里定义
  for (const cls of ['pin', 'tg', 'bx', 'hs', 'cap', 'gl']) {
    if (html.indexOf('.' + cls) < 0) { console.error('  ✗ 徽章样式缺少 .' + cls); process.exit(1); }
  }
  console.log('  徽章样式 : pin/tg/bx/hs/cap/gl 齐全 ✓');

  /* 齿孔必须两种尺寸都画 —— 它是让徽章读作「胶片」而不是「一块色」的关键特征。
     曾经只给大尺寸画齿孔，缩略图就是一排纯色块。 */
  const { FILM_STOCKS: FS, pinMarkup: PM } = C;
  const mCard = PM(FS[0], 'card'), mMini = PM(FS[0], 'mini');
  const holes = (s) => (s.match(/class="hs r/g) || []).length;
  console.log('  齿孔行数 : card ' + holes(mCard) + ' 行 / mini ' + holes(mMini) + ' 行');
  if (holes(mCard) !== 2 || holes(mMini) !== 2) {
    console.error('  ✗ 齿孔缺失（应为 2 行：上下各一排）'); process.exit(1);
  }
  if (mMini.indexOf('cap') >= 0) console.log('  （mini 仍带文字，34px 下读不出来）');

  /* ⚠️ UXP 的 <button> 会被撑高，且超大 border-radius 会把它渲染成正圆/肥椭圆。
     对策是每个**基础**按钮选择器都显式写 height + 有限的圆角。
     这条是「应用颗粒变成一颗蛋、−1/箱/+1 变成一排圆点」那个 bug 的回归测试。
     注意只查基础规则：`.seg button.on` / `.btn[disabled]` 这类状态修饰不该有 height。 */
  const styleBlock = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))
    .replace(/\/\*[\s\S]*?\*\//g, '');   // 先去掉注释，否则注释文字会被当成选择器
  const BASE_SEL = ['.btn', '.seg button', '.chip', '.mini-btn', '.advh'];
  const rules = [...styleBlock.matchAll(/([^{}]+)\{([^}]*)\}/g)];
  const found = [];
  for (const [, selRaw, body] of rules) {
    const sels = selRaw.split(',').map((s) => s.trim());
    const hit = sels.filter((s) => BASE_SEL.indexOf(s) >= 0);
    for (const s of hit) found.push([s, body]);
  }
  const noH = found.filter(([, body]) => !/(^|[\s;])height\s*:/.test(body)).map(([s]) => s);
  const badR = found.filter(([, body]) => /border-radius\s*:\s*9{3,}px/.test(body)).map(([s]) => s);
  console.log('  基础按钮 : ' + found.length + '/' + BASE_SEL.length + ' 条命中　缺 height '
    + (noH.length || 0) + ' 条　用 999px 圆角 ' + (badR.length || 0) + ' 条');
  if (found.length < BASE_SEL.length) {
    const miss = BASE_SEL.filter((s) => !found.some(([x]) => x === s));
    console.error('  ✗ 没找到这些按钮的基础样式：' + miss.join(' | '));
    process.exit(1);
  }
  if (noH.length) { console.error('  ✗ 缺 height（UXP 会撑高）：' + noH.join(' | ')); process.exit(1); }
  if (badR.length) { console.error('  ✗ 用了 999px 圆角（UXP 会渲染成圆形）：' + badR.join(' | ')); process.exit(1); }

  /* 胶片卡不能是 <button>：UXP 的 button 不保留子元素布局，
     实测徽章完全不渲染、文字被拍平成一行。 */
  const filmTag = /<button[^>]*id="filmBtn"/.test(html);
  console.log('  ' + (filmTag ? '✗' : '✓') + ' 胶片卡用 <div> 而非 <button>（徽章才能渲染）');
  if (filmTag) process.exit(1);
}

console.log('\n=== 10. 设计 token 一致性（防止实现与设计稿漂移）===');
{
  /* 这条是「凭印象写数值」那个根因的回归测试。
     v0.5 的实现端把圆角统一改小 2px、字号整体收了一档，与设计稿逐条漂移，
     而且没人发现。现在 token 表在 tools/design-tokens.mjs，实现必须逐条对上。 */
  const html = fs.readFileSync('plugin/index.html', 'utf8');
  const blocks = parseRootBlocks(html);
  console.log('  :root 块 : ' + blocks.length + ' 个（深色 + 浅色媒体查询）');
  if (blocks.length < 2) {
    console.error('  ✗ 期望 2 个 :root 块（深色 / 浅色），实际 ' + blocks.length);
    process.exit(1);
  }

  const darkBad = diffTokens(blocks[0], panelTokens('dark'));
  const lightBad = diffTokens(blocks[1], COLOR_LIGHT);
  console.log('  深色     : ' + Object.keys(panelTokens('dark')).length + ' 条，不一致 '
    + darkBad.length + ' 条');
  console.log('  浅色     : ' + Object.keys(COLOR_LIGHT).length + ' 条，不一致 '
    + lightBad.length + ' 条');
  for (const b of darkBad.concat(lightBad)) console.error('    ✗ ' + b);
  if (darkBad.length || lightBad.length) {
    console.error('  实现里的 token 与 tools/design-tokens.mjs 不一致 —— 改哪边都要两边同步');
    process.exit(1);
  }
  console.log('  ✓ 色板 / 圆角 / 字号 与设计 token 表逐条相等');

  /* 圆角必须真的用变量，而不是各处再写一遍字面量 ——
     否则 token 表对了、组件里还是旧值。 */
  const radii = [...html.matchAll(/border-radius\s*:\s*([^;}]+)/g)].map((m) => m[1].trim());
  const literal18 = radii.filter((r) => /^18px$/.test(r)).length;
  const usedVar = radii.filter((r) => r.indexOf('--r-card') >= 0 || r.indexOf('--r-stage') >= 0
    || r.indexOf('--r-mini') >= 0).length;
  console.log('  圆角用法 : 变量 ' + usedVar + ' 处　裸写 18px ' + literal18 + ' 处'
    + '　（其余为胶囊/圆形等一次性值）');
  if (literal18 > 0) {
    console.error('  ✗ 有 ' + literal18 + ' 处裸写 18px 圆角，应改用 var(--r-card)');
    process.exit(1);
  }

  // 字号 token 也必须被真正引用
  const fsVars = ['--fs-brand', '--fs-name', '--fs-hero', '--fs-amt'];
  const unused = fsVars.filter((v) => html.indexOf('var(' + v + ')') < 0);
  console.log('  字号变量 : ' + fsVars.length + ' 个，未被引用 ' + (unused.length || 0) + ' 个');
  if (unused.length) { console.error('  ✗ 定义了但没用上：' + unused.join(', ')); process.exit(1); }
}

console.log('\n预检全部通过，可以装进 Photoshop 了。');
