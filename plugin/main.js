/* 银盐 · UXP 面板逻辑 v0.5
 *
 * ============================================================
 * v0.5：换成深色主题 + 胶片徽章视觉，**算法与流程一行未改**
 * ============================================================
 * 这一版只动「渲染层」：DOM 结构、CSS、以及把胶片徽章画出来。
 * 读写像素、非破坏颗粒图层、绑定解析、行带分块、进度与取消 —— 全部沿用 v0.4。
 *
 * 【徽章为什么用 CSS 而不是 SVG】
 * Adobe 官方「Known UXP Issues」：UXP 的 SVG 渲染器只针对简单图标，
 * 复杂 SVG 可能完全不渲染或渲染异常；本机在售的 Film Emulation 插件也
 * 一处 SVG 都没用（图标全走位图）。
 * 预览稿里的徽章用了 <symbol>+<use>+clipPath+linearGradient+text，
 * 所以这里用 div + 百分比几何重画（见 index.html 的 .pin 一节）：
 *   .tg 片头条 / .hs 两排齿孔 / .bx 盒身（含高光与三段文字）
 * 色路与文案统一取自 core/pinart.mjs，与预览稿同源。
 *
 * ============================================================
 * v0.4 的核心：颗粒不叠加、非破坏
 * ============================================================
 * 颗粒写到**独立的「银盐颗粒」图层**上，源图层一个像素都不动。
 *   · 每次应用都从**源图层**重读像素 ⇒ 天然不会叠加
 *   · 改参数再应用 ⇒ 只重写颗粒层 ⇒ 就是「先还原再重算」
 *   · 想回原图 ⇒ 删掉那一层（或用面板里的「移除颗粒图层」）
 *   · 绑定关系写在图层名里，面板关掉、PS 重启也依然成立
 *
 * 【源图层怎么认】① 面板内存里的 id（同会话最准）
 *   ② 颗粒层名里的 id：`银盐颗粒 · 源 123`
 *   ③ 颗粒层正下方那一个像素图层（自描述规则，图层被移动也仍成立）
 *   ④ 都没有 ⇒ 当前选中的像素图层
 *
 * 【写法出处】不是在猜 API —— createLayer / move(PLACEBEFORE) /
 * boundsNoEffects / activeHistoryState 四条，全部来自本机 Plug-ins 下
 * 在售的 Film Emulation 插件（未混淆 bundle），是「在这个 PS 版本上确实能跑」的写法。
 *
 * 【参数模型】面板只持有**状态**（选了哪款胶片、哪个档位、画幅、强度），
 * 物理参数一律由 core/film.mjs 的 resolveFilmParams 推。
 * v0.2 曾因面板硬编码旧的 lumaChroma/weights 而把「彩色脏污」的修复整个覆盖掉，
 * 端到端测试却全绿 —— 所以这条红线必须守住。
 */

var ps = require('photoshop');
var app = ps.app;
var core = ps.core;
var imaging = ps.imaging;
var constants = ps.constants;
var C = SHC;

var GRAIN_PREFIX = '银盐颗粒';

var el = {
  run: document.getElementById('run'),
  cancel: document.getElementById('cancel'),
  remove: document.getElementById('remove'),
  status: document.getElementById('status'),
  bar: document.getElementById('bar'),
  readout: document.getElementById('readout'),
  bindOut: document.getElementById('bindOut'),
  pvBox: document.querySelector('.pv'),
  preview: document.getElementById('preview'),
  pvEmpty: document.getElementById('pvEmpty'),
  pvInfo: document.getElementById('pvInfo'),
  compare: document.getElementById('compare'),
  filmBtn: document.getElementById('filmBtn'),
  filmList: document.getElementById('filmList'),
  filmPin: document.getElementById('filmPin'),
  filmName: document.getElementById('filmName'),
  filmBrand: document.getElementById('filmBrand'),
  filmSub: document.getElementById('filmSub'),
  filmMeta: document.getElementById('filmMeta'),
  caret: document.getElementById('filmCaret'),
  isoSeg: document.getElementById('isoSeg'),
  isoNum: document.getElementById('isoNum'),
  isoStop: document.getElementById('isoStop'),
  isoSub: document.getElementById('isoSub'),
  gaugeSeg: document.getElementById('gaugeSeg'),
  gaugeOut: document.getElementById('gaugeOut'),
  amount: document.getElementById('amount'),
  amtOut: document.getElementById('amtOut'),
  amtFill: document.getElementById('amtFill'),
  amtKnob: document.getElementById('amtKnob'),
  clump: document.getElementById('clump'),
  clumpOut: document.getElementById('clumpOut'),
  clumpFill: document.getElementById('clumpFill'),
  clumpKnob: document.getElementById('clumpKnob'),
  advH: document.getElementById('advH'),
  advB: document.getElementById('advB'),
  reseed: document.getElementById('reseed')
};

/* ---------------- 状态 ---------------- */
var filmId = 'portra400';
var stops = 0;
var gauge = '135';
var amount = 1;
var clumpOverride = null;
var seed = 20261005;

/* 绑定：哪个图层是源、哪个是颗粒层。跨会话靠图层名恢复。 */
var boundDocId = null;
var boundSourceId = null;
var bindingNote = '尚未建立';

var busy = false;
var cancelled = false;
var pvBusy = false, pvPending = false;
var pvTimer = null;
var pvKey = null;
var cropSrcRGB = null, cropSrc8 = null, cropOut8 = null, cropW = 0, cropH = 0;
var previewUrl = null;
var pvShowOriginal = false;
var docW = 6000, docH = 4000;

/* ---------------- 小工具 ---------------- */
function setStatus(s) { el.status.textContent = s; }
function setProgress(p) { el.bar.style.width = (Math.max(0, Math.min(1, p)) * 100).toFixed(1) + '%'; }
function yieldHost() { return new Promise(function (r) { setTimeout(r, 0); }); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function errOf(e) { return (e && e.message) ? e.message : String(e); }
function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
function safeName(l) { try { return String(l.name || ''); } catch (e) { return ''; } }
function safeId(l) { try { return typeof l.id === 'number' ? l.id : null; } catch (e) { return null; } }
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isPixelLayer(l) {
  if (!l) return false;
  try { return String(l.kind) === 'pixel'; } catch (e) { return false; }
}
function isGrainName(n) { return String(n || '').indexOf(GRAIN_PREFIX) === 0; }
function isGrainLayer(l) { return isGrainName(safeName(l)); }
function grainLayerName(srcId) { return GRAIN_PREFIX + ' · 源 ' + srcId; }

function unlockLayer(l) {
  var props = ['allLocked', 'pixelsLocked', 'transparentPixelsLocked', 'positionLocked'];
  for (var i = 0; i < props.length; i++) { try { l[props[i]] = false; } catch (e) {} }
}

/** 递归收集所有图层（含组内）。UXP 的 doc.layers 只给顶层。 */
function walkLayers(doc) {
  var out = [];
  function visit(list) {
    if (!list) return;
    var n = 0;
    try { n = list.length; } catch (e) { return; }
    for (var i = 0; i < n; i++) {
      var l = null;
      try { l = list[i]; } catch (e) { continue; }
      if (!l) continue;
      out.push(l);
      try { if (l.layers && l.layers.length) visit(l.layers); } catch (e) {}
    }
  }
  try { visit(doc.layers); } catch (e) {}
  return out;
}

/** 图层像素边界。boundsNoEffects 取不到时返回 null（调用方回退整幅画布）。 */
function layerBounds(l) {
  try {
    var b = l.boundsNoEffects;
    if (b && b.right > b.left && b.bottom > b.top) {
      return {
        left: Math.round(b.left), top: Math.round(b.top),
        right: Math.round(b.right), bottom: Math.round(b.bottom)
      };
    }
  } catch (e) {}
  return null;
}

function clampBounds(b, W, H) {
  var left = Math.max(0, Math.min(W, b.left));
  var top = Math.max(0, Math.min(H, b.top));
  var right = Math.max(left + 1, Math.min(W, b.right));
  var bottom = Math.max(top + 1, Math.min(H, b.bottom));
  return { left: left, top: top, right: right, bottom: bottom };
}

/** doc.layers 是「自上而下」，所以正下方那层是同级里 index+1。 */
function layerBelow(doc, targetId) {
  var hit = null;
  function visit(list) {
    var n = 0;
    try { n = list.length; } catch (e) { return false; }
    for (var i = 0; i < n; i++) {
      var l = null;
      try { l = list[i]; } catch (e) { continue; }
      if (!l) continue;
      if (safeId(l) === targetId) { hit = (i + 1 < n) ? list[i + 1] : null; return true; }
      try { if (l.layers && l.layers.length && visit(l.layers)) return true; } catch (e) {}
    }
    return false;
  }
  try { visit(doc.layers); } catch (e) {}
  return hit;
}

/** 颗粒层名里的源 id：`银盐颗粒 · 源 123` */
function sourceIdFromName(n) {
  var m = /源\s*(\d+)/.exec(String(n || ''));
  return m ? Number(m[1]) : null;
}

/**
 * 解析「源图层 / 颗粒层」。四级回退，见文件头。
 * @returns {{source:object|null, grain:object|null, doc:object}}
 */
function resolveTargets(doc) {
  var all = walkLayers(doc);
  var grain = null, i;
  for (i = 0; i < all.length; i++) if (isGrainLayer(all[i])) { grain = all[i]; break; }

  var src = null;

  // ① 面板内存
  if (grain && boundDocId === doc.id && boundSourceId !== null) {
    for (i = 0; i < all.length; i++) {
      if (safeId(all[i]) === boundSourceId && isPixelLayer(all[i]) && !isGrainLayer(all[i])) { src = all[i]; break; }
    }
  }
  // ② 图层名里的 id
  if (!src && grain) {
    var wantId = sourceIdFromName(safeName(grain));
    if (wantId !== null) {
      for (i = 0; i < all.length; i++) if (safeId(all[i]) === wantId && isPixelLayer(all[i])) { src = all[i]; break; }
    }
  }
  // ③ 正下方那个像素图层
  if (!src && grain) {
    var below = layerBelow(doc, safeId(grain));
    if (below && isPixelLayer(below)) src = below;
  }
  // ④ 没有颗粒层：用当前选中的像素图层
  if (!src) {
    var act = null;
    try { act = doc.activeLayers && doc.activeLayers[0]; } catch (e) {}
    if (act && isPixelLayer(act) && !isGrainLayer(act)) src = act;
  }

  return { source: src, grain: grain, doc: doc };
}

function formatBinding(t) {
  if (!t.source) {
    if (t.grain) return '颗粒层：' + safeName(t.grain) + '　·　源图层未找到，请选中原始像素图层';
    return '尚未建立 · 打开一张照片并选中一个像素图层';
  }
  return '源：' + safeName(t.source) + (t.grain ? '　→　' + safeName(t.grain) : '　·　应用时自动新建颗粒层');
}

async function getPixelsWithRetry(args, tries) {
  tries = tries || 4;
  var last = null;
  for (var i = 0; i < tries; i++) {
    try { return await imaging.getPixels(args); }
    catch (e) { last = e; if (i < tries - 1) await sleep(60 * (i + 1)); }
  }
  throw last;
}

function historyKey(doc) {
  try {
    var st = doc.activeHistoryState;
    return st ? String(st.id !== undefined && st.id !== null ? st.id : st.name) : '';
  } catch (e) { return ''; }
}

/** 读一块区域（可指定图层）。返回 {rgb, alpha, w, h}。 */
async function readRegion(doc, bounds, bits, layerId) {
  var raw = await core.executeAsModal(async function () {
    var args = {
      documentID: doc.id,
      sourceBounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
      colorSpace: 'RGB',
      componentSize: bits,
      applyAlpha: false
    };
    if (typeof layerId === 'number') args.layerID = layerId;
    var res = await getPixelsWithRetry(args);
    var img = res.imageData;
    var o = {
      width: Math.round(num(img.width)),
      height: Math.round(num(img.height)),
      components: num(img.components)
    };
    o.data = await img.getData();
    try { img.dispose(); } catch (e) {}
    return o;
  }, { commandName: '银盐：读取像素' });

  var dec = C.decodePixels(raw.data, raw.width, raw.height, raw.components, bits);
  raw.data = null;
  return { rgb: dec.rgb, alpha: dec.alpha, w: raw.width, h: raw.height };
}

/* ---------------- 徽章渲染 ----------------
 * 生成逻辑在 core/pinart.mjs 的 pinMarkup()（纯字符串、平台无关），
 * 这样 Node 侧的 build-panel-preview.mjs 能拿**同一份标记**在浏览器里核对 ——
 * 「字会不会溢出盒身」这类问题必须在进 PS 之前发现，PS 里没有控制台。
 * 这里只负责传一个兜底配色：色路表万一缺条目，面板要降级而不是崩。 */
var CW_FALLBACK = { box: '#7a7a7a', strip: '#4a4a4a', ink: '#ffffff', holes: '#dddddd' };

function pinHTML(stock, size) {
  return C.pinMarkup(stock, size, CW_FALLBACK);
}

/* ---------------- 参数解析 ---------------- */
function resolvedFor(w, h) {
  var p = C.resolveFilmParams({
    film: filmId, stops: stops, gauge: gauge, amount: amount,
    clumping: clumpOverride === null ? undefined : clumpOverride,
    imageWidth: w, imageHeight: h
  });
  p.seed = seed;
  return p;
}

function grainOpts(p, ox, oy) {
  return {
    seed: p.seed, radiusPx: p.radiusPx, clumping: p.clumping, strength: p.strength,
    uPeak: p.uPeak, lumaChroma: p.lumaChroma, mono: p.mono,
    weights: p.weights, chromaRadiusScale: p.chromaRadiusScale,
    originX: ox, originY: oy
  };
}

function coarseness(g) {
  if (g < 0.60) return '极细';
  if (g < 0.80) return '很细';
  if (g < 1.05) return '细';
  if (g < 1.35) return '中等';
  if (g < 1.80) return '偏粗';
  return '粗';
}

function setSlider(fill, knob, v01) {
  var pct = Math.max(0, Math.min(1, v01)) * 100;
  fill.style.width = pct.toFixed(2) + '%';
  knob.style.left = 'calc(' + pct.toFixed(2) + '% - 8px)';
}

function stopLabel(v) {
  for (var i = 0; i < C.STOPS.length; i++) if (C.STOPS[i].v === v) return C.STOPS[i].label;
  return '';
}

function syncUI() {
  var f = C.filmById(filmId);
  var p = resolvedFor(docW, docH);

  el.filmPin.innerHTML = pinHTML(f, 'card');
  el.filmBrand.textContent = String(f.brand).toUpperCase();
  el.filmName.textContent = f.name;
  el.filmSub.textContent = f.group + ' · ' + coarseness(p.grainIndex) + '颗粒';
  el.filmMeta.textContent = el.filmList.className.indexOf('on') >= 0 ? '点击收起' : '点击选择';
  el.caret.textContent = el.filmList.className.indexOf('on') >= 0 ? '▲' : '▼';

  el.isoNum.textContent = String(p.iso);
  el.isoStop.textContent = stopLabel(stops);
  el.isoSub.textContent = f.name + ' · ' + (stops === 0 ? '未推冲' : stopLabel(stops));

  el.amtOut.innerHTML = Math.round(amount * 100) + '<small style="font-size:11px">%</small>';
  el.clumpOut.textContent = p.clumping.toFixed(2);
  el.gaugeOut.textContent = C.gaugeById(gauge).note;
  el.bindOut.textContent = bindingNote;

  setSlider(el.amtFill, el.amtKnob, amount / 2);
  setSlider(el.clumpFill, el.clumpKnob, p.clumping);

  var i, btns;
  btns = el.isoSeg.children;
  for (i = 0; i < btns.length; i++) btns[i].className = (Number(btns[i].dataset.v) === stops) ? 'on' : '';
  btns = el.gaugeSeg.children;
  for (i = 0; i < btns.length; i++) btns[i].className = (btns[i].dataset.v === gauge) ? 'on' : '';

  var opts = el.filmList.querySelectorAll('.so');
  for (i = 0; i < opts.length; i++) opts[i].className = 'so' + (opts[i].dataset.v === filmId ? ' on' : '');

  el.readout.innerHTML =
    '<span><b>μr</b> ' + p.radiusPx.toFixed(2) + 'px</span>' +
    '<span><b>σc</b> ' + (p.radiusPx * (2 + 4 * p.clumping)).toFixed(1) + 'px</span>' +
    '<span><b>S</b> ' + p.strength.toFixed(4) + '</span>';
}

/* ---------------- 构建控件 ---------------- */
function buildControls() {
  var groups = C.filmsByGroup();
  var html = '';
  for (var gi = 0; gi < groups.length; gi++) {
    html += '<div class="sgh">' + esc(groups[gi].group) + '</div>';
    for (var fi = 0; fi < groups[gi].films.length; fi++) {
      var f = groups[gi].films[fi];
      html += '<div class="so" data-v="' + f.id + '">' +
                '<span class="mh">' + pinHTML(f, 'mini') + '</span>' +
                '<span class="nm">' + esc(f.name) + '</span>' +
                '<span class="is">' + f.iso + '</span>' +
              '</div>';
    }
  }
  html += '<div class="scrollhint">· 共 ' + C.FILM_STOCKS.length + ' 款 ·</div>';
  el.filmList.innerHTML = html;

  var iso = '', i;
  for (i = 0; i < C.STOPS.length; i++) {
    iso += '<button data-v="' + C.STOPS[i].v + '">' + C.STOPS[i].short + '</button>';
  }
  el.isoSeg.innerHTML = iso;

  var gg = '';
  for (i = 0; i < C.GAUGES.length; i++) {
    gg += '<button data-v="' + C.GAUGES[i].id + '">' + C.GAUGES[i].name + '</button>';
  }
  el.gaugeSeg.innerHTML = gg;
}

/* ---------------- 预览 ---------------- */
function showEmpty(msg) {
  el.pvEmpty.textContent = msg;
  el.pvEmpty.style.display = 'flex';
  el.preview.removeAttribute('src');
  el.pvInfo.textContent = '—';
}

function publishImage(rgb8) {
  var png = C.encodePNG(rgb8, cropW, cropH);
  var url = null;
  try {
    if (typeof Blob === 'function' && typeof URL !== 'undefined' && URL.createObjectURL) {
      url = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
    }
  } catch (e) { url = null; }
  if (!url) url = C.pngToDataUrl(png);
  var prev = previewUrl;
  el.preview.src = url;
  previewUrl = url;
  if (prev && prev.indexOf('blob:') === 0) { try { URL.revokeObjectURL(prev); } catch (e) {} }
}

async function doPreview() {
  var doc = null;
  try { doc = app.activeDocument; } catch (e) {}
  if (!doc) { bindingNote = '没有打开的文档'; syncUI(); showEmpty('没有打开的文档。'); return; }

  var mode = String(doc.mode || '');
  if (mode.indexOf('RGB') < 0) {
    bindingNote = '非 RGB 文档';
    syncUI();
    showEmpty('只支持 RGB 文档，当前是 ' + (mode || '未知') + '。');
    return;
  }

  docW = Math.round(num(doc.width)) || 6000;
  docH = Math.round(num(doc.height)) || 4000;

  var t = resolveTargets(doc);
  bindingNote = formatBinding(t);

  if (!t.source) {
    syncUI();
    showEmpty('请选中一个像素图层作为源头。智能对象 / 文字层 / 形状层不行。');
    return;
  }
  // 记住绑定，下次优先用它
  boundDocId = doc.id;
  boundSourceId = safeId(t.source);

  var bits = C.parseBitDepth(doc.bitsPerChannel) || 8;
  var sB = clampBounds(layerBounds(t.source) || { left: 0, top: 0, right: docW, bottom: docH }, docW, docH);

  var pw = Math.round(el.pvBox.clientWidth);
  var ph = Math.round(el.pvBox.clientHeight);
  if (pw < 64 || ph < 48) { pw = 320; ph = 152; }

  // 预览框落在**源图层**的范围内
  var w = Math.max(8, Math.min(pw, sB.right - sB.left));
  var h = Math.max(8, Math.min(ph, sB.bottom - sB.top));
  var left = Math.max(sB.left, Math.round(sB.left + (sB.right - sB.left - w) / 2));
  var top = Math.max(sB.top, Math.round(sB.top + (sB.bottom - sB.top - h) / 2));
  var r = { left: left, top: top, right: left + w, bottom: top + h };

  /* 关键：预览读的是**源图层**，不是文档合成结果。
     否则颗粒层一建出来，预览就会显示「已带颗粒的画面再叠一层颗粒」，
     看起来像在叠加 —— 而实际应用是完全替换的，预览会撒谎。 */
  var key = doc.id + '|L' + safeId(t.source) + '|' + r.left + ',' + r.top + ',' + r.right + 'x' + r.bottom +
            '|' + bits + '|' + historyKey(doc);
  if (key !== pvKey || !cropSrcRGB) {
    var rd = await readRegion(doc, r, bits, safeId(t.source));
    if (rd.w <= 0 || rd.h <= 0) { showEmpty('读不到源图层的像素。'); return; }
    cropSrcRGB = rd.rgb;
    cropW = rd.w; cropH = rd.h;
    cropSrc8 = C.packRGB8(cropSrcRGB, cropW, cropH);
    pvKey = key;
    rd = null;
  }

  // 颗粒场原点用裁切区在整图中的真实位置 ⇒ 预览与「应用」在同一处结果一致。
  // 半径按**整幅文档**尺寸解析（不是裁切尺寸），否则预览的颗粒会比实际的小。
  var p = resolvedFor(docW, docH);
  var work = Float32Array.from(cropSrcRGB);
  C.applyGrain(work, cropW, cropH, grainOpts(p, r.left, r.top));
  cropOut8 = C.packRGB8(work, cropW, cropH);
  work = null;

  syncUI();
  publishImage(pvShowOriginal ? cropSrc8 : cropOut8);
  el.pvEmpty.style.display = 'none';
  el.pvInfo.textContent = '1:1 · ' + cropW + '×' + cropH + ' @ ' + r.left + ',' + r.top;
}

async function updatePreview() {
  if (busy || !C || !C.encodePNG) return;
  if (pvBusy) { pvPending = true; return; }
  pvBusy = true;
  try { await doPreview(); }
  catch (e) { showEmpty('预览失败：' + errOf(e)); }
  finally {
    pvBusy = false;
    if (pvPending) { pvPending = false; setTimeout(updatePreview, 30); }
  }
}

function schedulePreview(delay) {
  if (pvTimer) clearTimeout(pvTimer);
  pvTimer = setTimeout(function () { pvTimer = null; updatePreview(); }, delay === undefined ? 170 : delay);
}

/* ---------------- 应用 ---------------- */

/* 行带高度。UXP 没有 Worker，计算全在主线程，靠分带 + 带间让出保面板不假死。 */
var BAND_ROWS = 128;

/** 拿到（必要时新建）颗粒图层。返回 null 表示无法建立，调用方必须放弃、不改文档。 */
async function ensureGrainLayer(doc, source) {
  var t = resolveTargets(doc);
  if (t.grain) return t.grain;

  var name = grainLayerName(safeId(source));
  var layer = null;
  await core.executeAsModal(async function () {
    layer = await doc.createLayer(constants.LayerKind.NORMAL, { name: name });
    if (!layer) throw new Error('createLayer 返回空');
    try { layer.name = name; } catch (e) {}
    try { await layer.move(source, constants.ElementPlacement.PLACEBEFORE); } catch (e) {}
  }, { commandName: '银盐：新建颗粒图层' });

  if (!layer) return null;
  return layer;
}

async function run() {
  var doc = null;
  try { doc = app.activeDocument; } catch (e) {}
  if (!doc) { setStatus('没有打开的文档。'); return; }

  var mode = String(doc.mode || '');
  if (mode.indexOf('RGB') < 0) {
    setStatus('只支持 RGB 文档，当前是 ' + (mode || '未知') + '。请先「图像 → 模式 → RGB 颜色」。');
    return;
  }

  var W = Math.round(num(doc.width));
  var H = Math.round(num(doc.height));
  var bits = C.parseBitDepth(doc.bitsPerChannel);
  if (!bits) { setStatus('无法识别文档位深：' + doc.bitsPerChannel); return; }
  if (W <= 0 || H <= 0) { setStatus('拿不到文档尺寸。'); return; }

  var t = resolveTargets(doc);
  if (!t.source) {
    setStatus('找不到源图层。请先选中一个像素图层（智能对象 / 文字层 / 形状层不行，请先栅格化）。');
    return;
  }

  var sB = clampBounds(layerBounds(t.source) || { left: 0, top: 0, right: W, bottom: H }, W, H);
  var bw = sB.right - sB.left, bh = sB.bottom - sB.top;
  var mp = bw * bh / 1e6;
  var perByte = bits / 8;
  var peakMB = Math.round(bw * bh * (perByte * 4 + 12 + perByte * 4) / 1048576);
  if (bw * bh > 60e6) {
    setStatus('源图层区域 ' + mp.toFixed(0) + ' MP 偏大，预计峰值内存约 ' + peakMB + ' MB，可能失败。建议先缩图或裁剪。');
    return;
  }

  var p = resolvedFor(W, H);
  var opts = grainOpts(p, 0, 0);
  var tStart = performance.now();

  busy = true; cancelled = false;
  el.run.disabled = true; el.cancel.disabled = false;
  el.remove.disabled = true;
  setProgress(0);

  try {
    setStatus('读取源图层…（' + safeName(t.source) + '　' + bw + '×' + bh + '，' + bits + ' 位）');
    await yieldHost();
    var rd = await readRegion(doc, sB, bits, safeId(t.source));

    if (cancelled) { setStatus('已取消。'); return; }
    var rw = rd.w, rh = rd.h;
    var rgb = rd.rgb, alpha = rd.alpha;

    setProgress(0.1);
    var nBands = Math.ceil(rh / BAND_ROWS);
    for (var b = 0; b < nBands; b++) {
      if (cancelled) break;
      var y0 = b * BAND_ROWS;
      var vh = Math.min(BAND_ROWS, rh - y0);
      var view = rgb.subarray(y0 * rw * 3, (y0 + vh) * rw * 3);
      // 原点必须加上源图层在画布中的位置，否则颗粒相位与实际不符
      C.applyGrain(view, rw, vh, Object.assign({}, opts, {
        originX: sB.left, originY: sB.top + y0
      }));
      setProgress(0.1 + 0.62 * ((b + 1) / nBands));
      setStatus('生成颗粒… 第 ' + (b + 1) + ' / ' + nBands + ' 带');
      await yieldHost();
    }
    if (cancelled) { setStatus('已取消（文档未改动）。'); return; }

    setProgress(0.76);
    setStatus('量化与抖动…');
    await yieldHost();
    var out = C.encodePixels(rgb, alpha, rw, rh, bits, { seed: seed });
    rd.rgb = null; rd.alpha = null; rgb = null; alpha = null; rd = null;

    setProgress(0.84);
    setStatus('准备颗粒图层…');
    await yieldHost();
    var grainLayer = await ensureGrainLayer(doc, t.source);
    if (!grainLayer) {
      setStatus('无法新建颗粒图层。文档未改动 —— 请手动新建一个空白像素图层、命名以「' +
        GRAIN_PREFIX + '」开头、放在源图层上方，再重试。');
      return;
    }

    setProgress(0.9);
    setStatus('写入「' + safeName(grainLayer) + '」…');
    await core.executeAsModal(async function () {
      unlockLayer(grainLayer);
      try { doc.activeLayers = [grainLayer]; } catch (e) {}
      var imageData = await imaging.createImageDataFromBuffer(out, {
        width: rw, height: rh, components: 4, colorSpace: 'RGB'
      });
      try {
        await imaging.putPixels({
          documentID: doc.id, layerID: safeId(grainLayer), imageData: imageData,
          replace: true, targetBounds: { left: sB.left, top: sB.top }
        });
      } finally {
        try { imageData.dispose(); } catch (e) {}
      }
    }, { commandName: '银盐：应用颗粒' });

    boundDocId = doc.id;
    boundSourceId = safeId(t.source);
    bindingNote = '源：' + safeName(t.source) + '　→　' + safeName(grainLayer);

    setProgress(1);
    var ms = performance.now() - tStart;
    setStatus('完成。' + C.filmById(filmId).name + ' · ISO ' + p.iso + '　' + rw + '×' + rh + '　' +
      (ms / 1000).toFixed(1) + ' s\n' +
      '颗粒写在独立图层上，源图层未改动 —— 再点应用是替换，不会叠加。');

    // 颗粒层在源层上方，但预览读的是源层，所以裁切缓存仍然有效；
    // 这里仍强制刷新一次，保证绑定信息与图层状态同步。
    schedulePreview(200);
  } catch (e) {
    setStatus('出错：' + errOf(e) + '\n若后续读取异常，请撤销或重开文档。');
  } finally {
    busy = false;
    el.run.disabled = false;
    el.cancel.disabled = true;
    el.remove.disabled = false;
    syncUI();
  }
}

/** 移除颗粒层，恢复原图。 */
async function removeGrain() {
  var doc = null;
  try { doc = app.activeDocument; } catch (e) {}
  if (!doc) { setStatus('没有打开的文档。'); return; }
  var t = resolveTargets(doc);
  if (!t.grain) { setStatus('当前文档里没有「' + GRAIN_PREFIX + '」图层。'); return; }

  busy = true; el.run.disabled = true; el.remove.disabled = true;
  var nm = safeName(t.grain);
  try {
    var ok = false;
    await core.executeAsModal(async function () {
      try { await t.grain.delete(); ok = true; }
      catch (e) {
        try { t.grain.visible = false; ok = 'hidden'; } catch (e2) {}
      }
    }, { commandName: '银盐：移除颗粒图层' });
    if (ok === true) setStatus('已删除「' + nm + '」，文档恢复为原始状态。');
    else if (ok === 'hidden') setStatus('无法删除，已改为隐藏「' + nm + '」。需要彻底删除请在图层面板里手动删。');
    else setStatus('没能删除「' + nm + '」。请在图层面板里手动删除它。');
  } catch (e) {
    setStatus('移除失败：' + errOf(e) + '　请在图层面板里手动删除「' + nm + '」。');
  } finally {
    busy = false; el.run.disabled = false; el.remove.disabled = false;
    pvKey = null;
    schedulePreview(200);
  }
}

/* ---------------- 事件 ---------------- */

function toggleFilmList(force) {
  var on = el.filmList.className.indexOf('on') >= 0;
  var next = (force === undefined) ? !on : !!force;
  el.filmList.className = next ? 'list on' : 'list';
  el.filmBtn.className = next ? 'film open' : 'film';
  syncUI();
}

el.filmBtn.addEventListener('click', function () { toggleFilmList(); });

el.filmList.addEventListener('click', function (ev) {
  // 用 data-v 定位行，而不是靠类名 —— 类名一旦有前缀相同的子元素就会误判
  var n = ev.target;
  while (n && n !== el.filmList) {
    if (n.dataset && n.dataset.v !== undefined) break;
    n = n.parentNode;
  }
  if (!n || n === el.filmList || !n.dataset || !n.dataset.v) return;
  filmId = n.dataset.v;
  clumpOverride = null;
  el.clump.value = String(Math.round(C.filmById(filmId).clumping * 100));
  toggleFilmList(false);
  schedulePreview(40);
});

el.isoSeg.addEventListener('click', function (ev) {
  if (!ev.target.dataset || ev.target.dataset.v === undefined) return;
  stops = Number(ev.target.dataset.v);
  syncUI();
  schedulePreview(40);
});

el.gaugeSeg.addEventListener('click', function (ev) {
  if (!ev.target.dataset || ev.target.dataset.v === undefined) return;
  gauge = ev.target.dataset.v;
  syncUI();
  schedulePreview(40);
});

el.amount.addEventListener('input', function () {
  amount = parseInt(el.amount.value, 10) / 100;
  syncUI();
  schedulePreview();
});

el.clump.addEventListener('input', function () {
  clumpOverride = parseInt(el.clump.value, 10) / 100;
  syncUI();
  schedulePreview();
});

el.reseed.addEventListener('click', function () {
  seed = (Math.floor(Math.random() * 2147483646) + 1);
  schedulePreview(40);
});

el.advH.addEventListener('click', function () {
  var on = el.advB.className.indexOf('on') >= 0;
  el.advB.className = on ? 'advb' : 'advb on';
  var c = el.advH.querySelector('.c');
  if (c) c.textContent = on ? '▶' : '▼';
});

el.compare.addEventListener('click', function () {
  pvShowOriginal = !pvShowOriginal;
  el.compare.textContent = pvShowOriginal ? '看效果' : '看原图';
  if (cropSrc8 && cropOut8) publishImage(pvShowOriginal ? cropSrc8 : cropOut8);
});

el.run.addEventListener('click', run);
el.remove.addEventListener('click', removeGrain);
el.cancel.addEventListener('click', function () {
  if (!busy) return;
  cancelled = true;
  setStatus('正在取消…（会在当前行带结束后停止）');
});

/* ---------------- 启动 ---------------- */

if (!C || !C.applyGrain || !C.resolveFilmParams) {
  setStatus('核心未加载或版本不匹配（dist/core.js 缺失/过旧）。请先运行 node plugin/build.mjs。');
  el.run.disabled = true; el.remove.disabled = true;
  showEmpty('核心未加载');
} else {
  buildControls();
  el.clump.value = String(Math.round(C.filmById(filmId).clumping * 100));
  syncUI();
  setTimeout(function () { updatePreview(); }, 400);
}
