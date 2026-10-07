/* 银盐 · UXP 吞吐探针 v0.4
 *
 * v0.3 之前的错误已全部定位。根因与证据：
 *
 * 【错误 1】把 imageData 当惰性访问器去调用。
 *   实测报错：Class constructor PhotoshopImageData cannot be invoked without 'new'
 *   官方文档：getPixels() 解析为 { imageData: PhotoshopImageData 实例, sourceBounds, level }
 *   PhotoshopImageData 是**实例**，不是 getter/函数，调用它就等于调用类构造函数。
 *
 * 【错误 2】去找 .data 属性。根本没有这个属性。
 *   正确路径：await imageData.getData()，返回 Uint8Array / Uint16Array / Float32Array。
 *   用完必须 imageData.dispose()，否则 PS 的内存要等 GC 才释放。
 *
 * 【错误 3】putPixels 漏了必需的 layerID。
 *   文档：layerID 是必需参数，且目标必须是**像素图层**；targetBounds 只使用 left/top。
 *
 * 以上三条均对照本机已装的 com.cheukwing.filmemulation（可正常运行）的实证代码核实。
 * 另外从它的实现里确认的事实：
 *   - 16 位的归一化除数是 32768（不是 65535）
 *   - 读取用 applyAlpha:false，RGBA 分离读取
 *   - level !== 0 表示 PS 返回了降采样的金字塔层级，视为失败
 *   - 单次 getPixels 的块上限取 4 MP
 *   - 写回前需要 unlockPixelLayer() + doc.activeLayers = [layer]
 *   - 它用 WASM（film_core.wasm）跑像素核，且没有 Worker —— 与本机探测一致
 */

var ps = require('photoshop');
var uxp = require('uxp');
var app = ps.app;
var core = ps.core;
var imaging = ps.imaging;

var L = [];
var elOut = document.getElementById('out');
var elStatus = document.getElementById('status');
var btnRun = document.getElementById('run');
var btnCopy = document.getElementById('copy');
var btnSave = document.getElementById('save');

function now() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}
function f(x) { return (x < 0.01 ? x.toExponential(2) : x.toFixed(1)); }
function say(s) { L.push(s); elOut.textContent = L.join('\n'); }
var SEC = 0;
function head(s) {
  SEC++;
  // 丢掉调用处硬编码的编号，改为按**执行顺序**自动编号 ——
  // 章节顺序会随测试编排变化，硬编码的编号必然对不上。
  s = String(s).replace(/^\s*\d+\.\s*/, '');
  var label = SEC + '. ' + s;
  var bar = '';
  for (var i = 0; i < Math.max(0, 42 - label.length); i++) bar += '-';
  say('');
  say('== ' + label + ' ' + bar);
}
function err(e) { return (e && e.message) ? e.message : String(e); }

/* 只做诊断用：打印对象的自有属性与类型（不再调用任何东西） */
function keysOf(o, label) {
  if (o === null || o === undefined) return '\n  ' + (label || '') + ' : ' + String(o);
  var ks = [];
  try { ks = Object.keys(o); } catch (e) {}
  var out = [];
  for (var i = 0; i < ks.length; i++) {
    var line = null;
    try {
      var k = ks[i], v = o[k], t = typeof v;
      if (v && typeof v === 'object' && typeof v.byteLength === 'number') {
        var cn = '?';
        try { cn = (v.constructor && v.constructor.name) ? v.constructor.name : 'TypedArray'; } catch (e2) {}
        t = cn + '[' + v.length + ']';
      }
      line = '    ' + k + ' : ' + t;
    } catch (e3) {
      line = '    ' + ks[i] + ' : (取值抛错)';
    }
    out.push(line);
  }
  return (label ? '\n  ' + label + ' :' : '') + (out.length ? '\n' + out.join('\n') : ' (无自有属性)');
}

/* ---------------- 像素读取：官方文档确证的正确路径 ---------------- */

function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* v0.4 实测：连续 4 次分块 getPixels 全部失败，报
 *   Photoshop Error. Code: -1. Message: 无法打开 "xxx.jpg"
 * 且失败全部发生在一次 putPixels 之后 —— 怀疑是写回弄脏了文档状态，
 * 或 getPixels 本身会间歇性失败（在售的 Film Emulation 插件正是为此加了
 * 「失败后 60 ms 重试一次」，说明这是已知现象）。
 * 本版两手都上：读取全部前置到写回之前；读取失败按退避重试并记录重试次数。 */

async function getPixelsWithRetry(args, maxTries) {
  maxTries = maxTries || 4;
  var last = null;
  for (var i = 0; i < maxTries; i++) {
    try { return { res: await imaging.getPixels(args), tries: i + 1 }; }
    catch (e) {
      last = e;
      if (i < maxTries - 1) await delay(60 * (i + 1));
    }
  }
  throw last;
}

/* 每次都用 app.activeDocument 重新取，避免 putPixels 之后旧代理失效 */
function freshDoc() {
  try { return app.activeDocument; } catch (e) { return null; }
}

/* 返回 { img, data, level, tHandle, tData, w, h, components, componentSize, colorProfile, tries } */
async function readPixels(doc, bounds, compSize, layerID) {
  var r = { tHandle: 0, tData: 0, tries: 0 };
  await core.executeAsModal(async function () {
    var args = {
      documentID: doc.id,
      sourceBounds: bounds,
      colorSpace: 'RGB',
      componentSize: compSize,
      applyAlpha: false
    };
    if (typeof layerID === 'number') args.layerID = layerID;

    var t0 = now();
    var got = await getPixelsWithRetry(args);   // → { res: {imageData, sourceBounds, level}, tries }
    r.tHandle = now() - t0;
    r.tries = got.tries;
    var res = got.res;

    r.level = res.level;
    var img = res.imageData;                    // ← PhotoshopImageData 实例，绝对不要调用它
    r.img = img;
    r.w = img.width;
    r.h = img.height;
    r.components = img.components;
    r.componentSize = img.componentSize;
    try { r.colorProfile = img.colorProfile; } catch (e) {}

    var t1 = now();
    r.data = await img.getData();               // ← 真正的取像素方法
    r.tData = now() - t1;
  }, { commandName: '银盐探针：读取像素' });
  return r;
}

/* ---------------- 目标图层 ---------------- */

function isPixelLayer(layer) {
  if (!layer) return false;
  try { return String(layer.kind) === 'pixel'; } catch (e) { return false; }
}

function unlockPixelLayer(layer) {
  if (!layer) return false;
  var props = ['allLocked', 'pixelsLocked', 'transparentPixelsLocked', 'positionLocked'];
  for (var i = 0; i < props.length; i++) {
    try { layer[props[i]] = false; } catch (e) {}
  }
  try { return layer.locked !== true; } catch (e) { return true; }
}

/* ---------------- 各阶段 ---------------- */

async function stageEnvironment() {
  head('1. 环境');
  say('宿主应用      : ' + (uxp.host && uxp.host.name ? uxp.host.name : '?') + ' ' + (uxp.host && uxp.host.version ? uxp.host.version : '?'));
  say('imaging 模块  : ' + (imaging ? '存在' : '不存在'));
  say('Web Worker    : ' + (typeof Worker === 'undefined' ? '没有构造器（不可用）' : '有构造器'));
  say('WebAssembly   : ' + (typeof WebAssembly === 'undefined' ? '没有' : '有'));
  say('performance   : ' + ((typeof performance !== 'undefined' && performance.now) ? 'performance.now 可用' : '回退到 Date.now'));
  var clip = '不存在';
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      clip = navigator.clipboard.writeText ? '存在且可写' : '存在但无 writeText';
    }
  } catch (e) { clip = '读取抛错：' + err(e); }
  say('navigator.clipboard : ' + clip);
}

async function stageDocument() {
  head('2. 文档');
  var doc = app.activeDocument;
  if (!doc) throw new Error('当前没有打开的文档。');
  say('名称     : ' + (doc.name || '?'));
  say('尺寸     : ' + doc.width + ' x ' + doc.height + '  (' + (doc.width * doc.height / 1e6).toFixed(2) + ' MP)');
  say('位深     : ' + doc.bitsPerChannel);
  say('色彩模式 : ' + doc.mode);

  var layer = null;
  try { layer = doc.activeLayers && doc.activeLayers[0]; } catch (e) {}
  if (layer) {
    var kind = '?';
    try { kind = String(layer.kind); } catch (e) {}
    say('目标图层 : ' + (layer.name || '?') + '　kind=' + kind + (isPixelLayer(layer) ? '　✓ 像素图层' : '　✗ 不是像素图层，写回会跳过'));
  } else {
    say('目标图层 : 取不到 activeLayers[0]');
  }
  return { doc: doc, layer: layer };
}

async function stageFullRead(doc, compSize) {
  var bounds = { left: 0, top: 0, right: doc.width, bottom: doc.height };
  var r;
  try {
    r = await readPixels(doc, bounds, compSize);
  } catch (e) {
    say(compSize + ' 位读取失败 : ' + err(e));
    return null;
  }
  var bytes = r.data ? r.data.byteLength : 0;
  var mp = (r.w * r.h) / 1e6;

  say('返回尺寸     : ' + r.w + ' x ' + r.h + '  ' + mp.toFixed(2) + ' MP   level=' + r.level);
  say('通道 / 位深  : ' + r.components + ' 通道  ' + r.componentSize + ' 位');
  say('像素数组     : ' + (r.data ? r.data.constructor.name : '(null)') + '  ' + (bytes / 1048576).toFixed(1) + ' MB');
  say('色彩配置     : ' + (r.colorProfile || '(空)'));
  say('');
  say('getPixels    : ' + f(r.tHandle) + ' ms　（拿到句柄）');
  say('getData      : ' + f(r.tData) + ' ms　（真正取像素）');
  say('读取合计     : ' + f(r.tHandle + r.tData) + ' ms');
  if (bytes && (r.tHandle + r.tData) > 0) {
    say('读取吞吐     : ' + f(bytes / 1048576 / ((r.tHandle + r.tData) / 1000)) + ' MB/s');
  }

  // 采样若干点的数值范围，确认 16 位的标度
  if (r.data && r.data.length > 1000) {
    var mx = 0, mn = 1e18, step = Math.max(1, Math.floor(r.data.length / 200000));
    for (var i = 0; i < r.data.length; i += step) {
      var v = r.data[i];
      if (v > mx) mx = v;
      if (v < mn) mn = v;
    }
    say('数值范围     : ' + mn + ' ~ ' + mx + '　（16 位按文档应为 0~32768；若为 0~255 说明 PS 回退成 8 位了）');
  }
  return r;
}

async function stageTiles(doc, compSize) {
  head('4. 分块读取（1024x1024 × 4）');
  var TS = 1024;
  if (doc.width < TS || doc.height < TS) { say('图像太小，跳过。'); return; }
  var spots = [[0, 0], [doc.width - TS, 0], [0, doc.height - TS],
               [Math.floor((doc.width - TS) / 2), Math.floor((doc.height - TS) / 2)]];
  var total = 0, ok = 0, retries = 0;
  for (var i = 0; i < spots.length; i++) {
    var b = { left: spots[i][0], top: spots[i][1], right: spots[i][0] + TS, bottom: spots[i][1] + TS };
    try {
      var r = await readPixels(doc, b, compSize);
      var dt = r.tHandle + r.tData;
      total += dt; ok++; retries += (r.tries - 1);
      say('  块 ' + (i + 1) + ' @(' + b.left + ',' + b.top + ') : ' + f(dt) + ' ms'
          + '　(' + f(r.tHandle) + ' 句柄 + ' + f(r.tData) + ' 取数据)'
          + '  ' + (r.data.byteLength / 1048576).toFixed(1) + ' MB'
          + (r.tries > 1 ? '　重试 ' + (r.tries - 1) + ' 次' : ''));
    } catch (e) {
      say('  块 ' + (i + 1) + ' 失败 : ' + err(e));
      say('     当时的文档状态 : ' + docState());
    }
  }
  if (!ok) return;
  var avg = total / ok;
  var nTiles = Math.ceil(doc.width / TS) * Math.ceil(doc.height / TS);
  say('');
  say('平均块耗时 : ' + f(avg) + ' ms（含 executeAsModal 固定开销）');
  say('全图共需   : ' + nTiles + ' 块　推算 : ' + f(avg * nTiles) + ' ms');
  say('块尺寸若提到 2048²（4 MP）: ' + Math.ceil(doc.width / 2048) * Math.ceil(doc.height / 2048) + ' 块');
  if (retries) say('合计触发重试 ' + retries + ' 次（说明 getPixels 确实会间歇性失败）');
}

function docState() {
  var n = '?', id = '?', name = '?';
  try { n = app.documents.length; } catch (e) {}
  try { var d = app.activeDocument; id = d ? d.id : 'null'; name = d ? d.name : 'null'; } catch (e) { name = '取值抛错'; }
  return '打开文档数=' + n + ' 活动文档=' + name + '(id=' + id + ')';
}

/* 只验证「从 buffer 造 imageData」这个能力，不写回 —— 因此可以放在破坏性测试之前 */
async function stageBufferCreate(doc, compSize) {
  head('5. 生成像素能力（createImageDataFromBuffer，不写回）');
  var TS = Math.min(1024, doc.width, doc.height);
  var b = { left: 0, top: 0, right: TS, bottom: TS };
  try {
    var r = await readPixels(doc, b, compSize);
    var n = TS * TS;
    var buf = compSize === 16 ? new Uint16Array(n * 4) : (compSize === 8 ? new Uint8Array(n * 4) : new Float32Array(n * 4));
    var comp = r.components || 3;
    var maxv = compSize === 16 ? 32768 : (compSize === 8 ? 255 : 1);
    var t0 = now();
    for (var i = 0; i < n; i++) {
      buf[i * 4] = r.data[i * comp];
      buf[i * 4 + 1] = r.data[i * comp + 1];
      buf[i * 4 + 2] = r.data[i * comp + 2];
      buf[i * 4 + 3] = comp === 4 ? r.data[i * comp + 3] : maxv;
    }
    var tPack = now() - t0;
    r.img.dispose();

    var t1 = now();
    // 传 TypedArray 本身（与 Film Emulation 的可用实现一致），不是 .buffer
    var out = await imaging.createImageDataFromBuffer(buf, {
      width: TS, height: TS, components: 4, colorSpace: 'RGB'
    });
    var tCreate = now() - t1;
    say('块尺寸       : ' + TS + ' x ' + TS + '　' + compSize + ' 位 RGBA（4 通道）');
    say('打包 RGB→RGBA : ' + f(tPack) + ' ms');
    say('createImageDataFromBuffer : ' + f(tCreate) + ' ms');
    say('返回对象     : ' + out.width + ' x ' + out.height + '  ' + out.components + ' 通道');
    out.dispose();
    say('');
    say('结论：造 imageData 的能力可用。写回放在最后一步单独测。');
  } catch (e) {
    say('失败 : ' + err(e));
    say('当时的文档状态 : ' + docState());
  }
}

/* ---------------- 写回实验 ----------------
 *
 * v0.5 实测：一次 putPixels 之后，后续 getPixels 全部失败，
 *   报 Photoshop Error. Code: -1. Message: 无法打开 "xxx.jpg"
 * 而只读测试（写回之前）完全正常。所以「写回会破坏文档状态」已被确认。
 *
 * 但**哪一步**破坏的还不知道。本实验按「最不可能破坏 → 最可能破坏」排序，
 * 每步之后立刻重读一小块验证，遇到第一个失败就停。
 * 主要怀疑：把 16 位 imageData 写进了 8 位文档（位深不符）。
 */

async function readCheck() {
  var d = freshDoc();
  if (!d) return '拿不到活动文档';
  try {
    var r = await readPixels(d, { left: 0, top: 0, right: 256, bottom: 256 }, 8);
    var t = r.tries - 1;
    try { r.img.dispose(); } catch (e) {}
    return '成功（' + f(r.tHandle + r.tData) + ' ms' + (t ? '，重试 ' + t + ' 次' : '') + '）';
  } catch (e) { return err(e); }
}

async function tryUndo() {
  var forms = [
    [{ _obj: 'undo' }],
    [{ _obj: 'undo', _target: [{ _ref: 'historyState', _property: 'currentHistoryState' }] }]
  ];
  for (var i = 0; i < forms.length; i++) {
    try {
      var f2 = forms[i];
      await core.executeAsModal(async function () {
        await ps.action.batchPlay(f2, {});
      }, { commandName: '银盐探针：撤销' });
      return true;
    } catch (e) {}
  }
  return false;
}

/* 把某个区域的原像素原样写回。viaBuffer=true 时走 createImageDataFromBuffer（真实插件的路径） */
async function writeBackRegion(compSize, TS, viaBuffer) {
  var d = freshDoc();
  var layer = d.activeLayers && d.activeLayers[0];
  if (!layer || !isPixelLayer(layer)) throw new Error('目标不是像素图层');
  var r = await readPixels(d, { left: 0, top: 0, right: TS, bottom: TS }, compSize);
  var img = r.img, note = '（句柄，' + (r.components || '?') + ' 通道）';

  if (viaBuffer) {
    var n = TS * TS, comp = r.components || 3;
    var maxv = compSize === 16 ? 32768 : (compSize === 8 ? 255 : 1);
    var buf = compSize === 16 ? new Uint16Array(n * 4) : (compSize === 8 ? new Uint8Array(n * 4) : new Float32Array(n * 4));
    for (var i = 0; i < n; i++) {
      buf[i * 4] = r.data[i * comp];
      buf[i * 4 + 1] = r.data[i * comp + 1];
      buf[i * 4 + 2] = r.data[i * comp + 2];
      buf[i * 4 + 3] = comp === 4 ? r.data[i * comp + 3] : maxv;
    }
    try { img.dispose(); } catch (e) {}
    img = await imaging.createImageDataFromBuffer(buf, { width: TS, height: TS, components: 4, colorSpace: 'RGB' });
    note = '（造数据，4 通道）';
  }

  var t0 = now();
  await core.executeAsModal(async function () {
    unlockPixelLayer(layer);
    try { d.activeLayers = [layer]; } catch (e) {}
    await imaging.putPixels({
      documentID: d.id, layerID: layer.id, imageData: img,
      replace: true, targetBounds: { left: 0, top: 0 }
    });
  }, { commandName: '银盐探针：局部写回' });
  var dt = now() - t0;
  try { img.dispose(); } catch (e) {}
  return 'putPixels ' + f(dt) + ' ms ' + note;
}

async function writeBackFull(compSize) {
  var d = freshDoc();
  var layer = d.activeLayers && d.activeLayers[0];
  if (!layer || !isPixelLayer(layer)) throw new Error('目标不是像素图层');
  var t0 = now();
  var r = await readPixels(d, { left: 0, top: 0, right: d.width, bottom: d.height }, compSize);
  var tRead = now() - t0;
  var t1 = now();
  await core.executeAsModal(async function () {
    unlockPixelLayer(layer);
    try { d.activeLayers = [layer]; } catch (e) {}
    await imaging.putPixels({
      documentID: d.id, layerID: layer.id, imageData: r.img,
      replace: true, targetBounds: { left: 0, top: 0 }
    });
  }, { commandName: '银盐探针：全图写回' });
  var tWrite = now() - t1;
  var bytes = r.data ? r.data.byteLength : 0;
  try { r.img.dispose(); } catch (e) {}
  return { tRead: tRead, tWrite: tWrite, bytes: bytes, compSize: compSize };
}

async function experimentStep(label, fn, out) {
  say(label);
  var info = '';
  try { info = await fn(); if (info) say('  写回 : ' + info); }
  catch (e) { say('  写回失败 : ' + err(e)); }
  await delay(60);
  var chk = await readCheck();
  if (chk.indexOf('成功') === 0) { say('  写后读取 : ' + chk + '　✓'); return true; }
  say('  写后读取失败 : ' + chk + '　✗');
  if (!out.brokenAt) out.brokenAt = label;
  return false;
}

async function stageWriteExperiment(compSize16, read16) {
  head('写回实验：哪一步会破坏文档状态？');
  var d0 = freshDoc();
  var native = 8;
  try {
    var bpc = String(d0.bitsPerChannel);
    native = bpc.indexOf('32') >= 0 ? 32 : (bpc.indexOf('16') >= 0 ? 16 : 8);
  } catch (e) {}
  say('文档原生位深 : ' + native + ' 位');
  say('本实验会改动文档：每一步都把原像素写回，视觉上不变；随时可 Ctrl+Z。');
  say('步骤按「最不可能破坏 → 最可能破坏」排序，遇到第一个失败就停。');
  say('');

  var base = await readCheck();
  say('基线（写回前读取）: ' + base);
  if (base.indexOf('成功') !== 0) { say('基线不通，实验终止。'); return { roundTrip: null }; }

  var out = { roundTrip: null, brokenAt: null };

  if (!out.brokenAt) {
    await experimentStep('步骤 1 · 局部 1024² 句柄写回（' + native + ' 位，与文档一致）',
      function () { return writeBackRegion(native, 1024, false); }, out);
  }
  if (!out.brokenAt) {
    await experimentStep('步骤 2 · 局部 1024² 造数据写回（' + native + ' 位，与文档一致）',
      function () { return writeBackRegion(native, 1024, true); }, out);
  }
  if (!out.brokenAt) {
    var rt = null;
    await experimentStep('步骤 3 · 全图句柄写回（' + native + ' 位，与文档一致）', async function () {
      rt = await writeBackFull(native);
      return '读 ' + f(rt.tRead) + ' ms + 写 ' + f(rt.tWrite) + ' ms　共 ' + (rt.bytes / 1048576).toFixed(1) + ' MB';
    }, out);
    if (rt) {
      out.roundTrip = rt.tRead + rt.tWrite;
      say('  ⇒ 位深匹配的全图往返 : ' + f(out.roundTrip) + ' ms');
    }
  }
  if (!out.brokenAt && read16 && native !== 16) {
    await experimentStep('步骤 4 · 全图写回（16 位数据 → ' + native + ' 位文档，位深不符）　← 怀疑就是它',
      async function () {
        var d = freshDoc();
        var layer = d.activeLayers && d.activeLayers[0];
        var t = now();
        await core.executeAsModal(async function () {
          unlockPixelLayer(layer);
          try { d.activeLayers = [layer]; } catch (e) {}
          await imaging.putPixels({
            documentID: d.id, layerID: layer.id, imageData: read16.img,
            replace: true, targetBounds: { left: 0, top: 0 }
          });
        }, { commandName: '银盐探针：位深不符写回' });
        return 'putPixels ' + f(now() - t) + ' ms（16 位句柄，' + (read16.components || '?') + ' 通道）';
      }, out);
  }

  say('');
  if (!out.brokenAt) {
    say('⇒ 四个步骤全部通过，未复现破坏。');
  } else {
    say('破坏点 : ' + out.brokenAt);
    say('');
    say('尝试恢复……');
    var undone = await tryUndo();
    say('  撤销 : ' + (undone ? '已执行' : '执行失败（两种写法都试过）'));
    await delay(100);
    var after = await readCheck();
    say('  撤销后读取 : ' + after);
    if (after.indexOf('成功') === 0) {
      say('  ⇒ 撤销可恢复。插件出错后应提示用户撤销。');
    } else {
      say('  ⇒ 撤销无效。文档需关闭（不保存）后重新打开。');
    }
  }
  return out;
}

/* 卷积是 L2 层主力开销，与 PS API 无关，因此可以独立测 */
async function stageConvolution() {
  head('6. 卷积吞吐（L2 层主力负载）');
  try {
    var N = 1024, H = 1024, R = 3, nk = [];
    for (var i = -R; i <= R; i++) nk.push(Math.exp(-(i * i) / 2));
    var s = 0; for (var q = 0; q < nk.length; q++) s += nk[q] * nk[q];
    s = Math.sqrt(s); for (var q2 = 0; q2 < nk.length; q2++) nk[q2] /= s;

    var src = new Float32Array(N * H), tmp = new Float32Array(N * H), dst = new Float32Array(N * H);
    for (var z = 0; z < N * H; z++) src[z] = (z % 997) * 0.001;

    var t = now();
    for (var y = 0; y < H; y++) {
      var off = y * N;
      for (var x = 0; x < N; x++) {
        var acc = 0;
        for (var k = 0; k < nk.length; k++) {
          var xx = x + k - R; if (xx < 0) xx = 0; if (xx >= N) xx = N - 1;
          acc += nk[k] * src[off + xx];
        }
        tmp[off + x] = acc;
      }
    }
    for (var y2 = 0; y2 < H; y2++) {
      for (var x2 = 0; x2 < N; x2++) {
        var acc2 = 0;
        for (var k2 = 0; k2 < nk.length; k2++) {
          var yy = y2 + k2 - R; if (yy < 0) yy = 0; if (yy >= H) yy = H - 1;
          acc2 += nk[k2] * tmp[yy * N + x2];
        }
        dst[y2 * N + x2] = acc2;
      }
    }
    var dt = now() - t;
    var px = N * H;
    var perPass24 = dt * 24 / (px / 1e6);
    say('测试规模   : ' + (px / 1e6).toFixed(2) + ' MP，7 抽头可分离高斯（含逐点边界钳位）');
    say('耗时       : ' + f(dt) + ' ms');
    say('单像素成本 : ' + (dt * 1e6 / px).toFixed(2) + ' ns');
    say('推算 24 MP 单趟 : ' + f(perPass24) + ' ms');
    say('L2 需 4 趟（细颗粒场 + 团簇场，各两次一维）: ' + f(perPass24 * 4) + ' ms');
    say('');
    say('说明：这是纯 JS 的朴素实现。真实实现可用 WASM 加速，');
    say('      团簇场是低频场、可在 1/4 分辨率上算再上采样，成本降约 16 倍。');
    return perPass24 * 4;
  } catch (e) {
    say('失败 : ' + err(e));
    return null;
  }
}

async function stageYield() {
  head('7. 主线程让出控制权（Worker 不可用时的替代方案）');
  try {
    var t = now();
    for (var i = 0; i < 50; i++) {
      await new Promise(function (r) { setTimeout(r, 0); });
    }
    var dt = (now() - t) / 50;
    say('单次 setTimeout(0) 让出 : ' + dt.toFixed(2) + ' ms');
    say('若分 100 块、每块让出一次 : 额外约 ' + (dt * 100).toFixed(0) + ' ms');
  } catch (e) {
    say('失败 : ' + err(e));
  }
}

function stageVerdict(io, conv24) {
  head('11. 结论');
  if (!io || io.roundTrip === undefined) {
    say('拿不到全图往返耗时，无法给出 I/O 判定。');
    return;
  }
  var rt = io.roundTrip;
  var ioVerdict = rt < 800 ? 'Go' : (rt < 1500 ? '条件 Go' : 'No-Go');
  say('全图 I/O 往返 : ' + f(rt) + ' ms　→ I/O 判定：' + ioVerdict + '　（门槛 800 / 1500）');
  say('');
  say('这一项决定「要不要转 C++ Plug-in SDK」。判定为 Go 即表示 UXP 路线的 I/O 不构成瓶颈。');
  say('');
  if (conv24) {
    say('计算侧（这一项与 UXP 无关，可在 Node 里优化）：');
    say('  本节第 6 项测的是**朴素**实现的卷积，是成本上界：');
    say('    朴素 4 趟（24 MP）               : ' + f(conv24) + ' ms');
    say('    小核展开 + 边界拆分（实测 ÷2.18）: ' + f(conv24 * 0.4585) + ' ms');
    say('    再叠加团簇场降分辨率（约 ÷4）     : ' + f(conv24 * 0.4585 / 4) + ' ms');
    say('');
    say('  ⇒ L2 的目标成本约 ' + f(conv24 * 0.4585 / 4) + ' ms，与 I/O 相加才是提交耗时。');
    say('  ⇒ 真正的实现必须先做这三件事，不能拿朴素数字下结论。');
  }
  say('');
  say('提醒：本探针不测颜色管理开销。非 sRGB 文档的色彩转换可能显著更慢。');
}

/* ---------------- 主流程 ---------------- */

async function run() {
  L.length = 0;
  SEC = 0;
  elOut.textContent = '';
  btnRun.disabled = true;
  elStatus.textContent = '检测中，请稍候……';

  var io = null, conv24 = null, read = null, compSize = 16;
  async function guard(name, fn) {
    try { return await fn(); } catch (e) {
      say('');
      say('!! [' + name + '] 中断 : ' + err(e));
      say('   文档状态 : ' + docState());
      return null;
    }
  }

  await guard('环境', stageEnvironment);
  var ctx = await guard('文档', stageDocument);

  // ───── 以下全部是只读测试，不碰文档 ─────
  if (ctx) {
    head('3. 全图读取（getPixels → imageData.getData）');
    read = await guard('全图读取', function () { return stageFullRead(ctx.doc, compSize); });
    if (!read) {
      say('');
      say('16 位读取失败，改用 8 位重试一次……');
      compSize = 8;
      read = await guard('全图读取(8位)', function () { return stageFullRead(ctx.doc, compSize); });
    }
    if (read) {
      io = { roundTrip: read.tHandle + read.tData };
      var d1 = freshDoc() || ctx.doc;
      await guard('分块读取', function () { return stageTiles(d1, compSize); });
      var d2 = freshDoc() || ctx.doc;
      await guard('生成像素能力', function () { return stageBufferCreate(d2, compSize); });
    }
  } else {
    say('没有可用文档，跳过像素测试。');
  }

  conv24 = await guard('卷积吞吐', stageConvolution);
  await guard('让出控制权', stageYield);

  // ───── 以下会改动文档，因此放在最后 ─────
  var exp = await guard('写回实验', function () {
    return stageWriteExperiment(compSize, read);
  });
  if (exp && exp.roundTrip) io = { roundTrip: exp.roundTrip };
  else if (read) io = { roundTrip: read.tHandle + read.tData };
  if (read && read.img) { try { read.img.dispose(); } catch (e) {} }

  await guard('结论', function () { return stageVerdict(io, conv24); });

  btnRun.disabled = false;
  elStatus.textContent = '完成。用「复制结果」或「保存到文件」发给我。';
}

async function doCopy() {
  var text = L.join('\n');
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      elStatus.textContent = '已复制到剪贴板。'; return;
    }
  } catch (e) {}
  try {
    var c = require('clipboard');
    if (c && c.copy) { c.copy(text); elStatus.textContent = '已复制到剪贴板。'; return; }
  } catch (e) {}
  elStatus.textContent = '剪贴板不可用，请用「保存到文件」。';
}

async function doSave() {
  try {
    var fs = uxp.storage.localFileSystem;
    var file = await fs.getFileForSaving('silverhalide-probe.txt');
    if (!file) { elStatus.textContent = '已取消。'; return; }
    var fmts = uxp.storage.formats;
    if (fmts && fmts.utf8) await file.write(L.join('\n'), { format: fmts.utf8 });
    else await file.write(L.join('\n'));
    elStatus.textContent = '已保存：' + (file.nativePath || file.name);
  } catch (e) {
    elStatus.textContent = '保存失败：' + err(e);
  }
}

btnRun.addEventListener('click', run);
btnCopy.addEventListener('click', doCopy);
btnSave.addEventListener('click', doSave);
