/* 把 plugin/ 安装（或更新）到 Photoshop 的 Plug-ins 目录。
 *
 * 为什么单独写成脚本：安装路径因机器而异（本机是 `D:\新建文件夹\Adobe Photoshop 2026`，
 * 含中文与空格），把它硬编码进文档会出错。这里按优先级取：
 *   1) 命令行参数：node tools/install-plugin.mjs "D:\path\to\Photoshop\Plug-ins"
 *   2) 环境变量：PS_PLUGINS_DIR
 *   3) 常见位置自动探测（含中文路径）
 *
 * 运行：node tools/install-plugin.mjs [Plug-ins 目录]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ID = 'com.silverhalide.grain';

/** 已知的候选路径（按机器不同而不同；找不到就报错并让用户显式传参） */
function guessCandidates() {
  const out = [];
  const drives = ['C:', 'D:', 'E:'];
  const adobeDirs = [
    'Program Files/Adobe', 'Program Files (x86)/Adobe',
    '新建文件夹/Adobe Photoshop 2026', '新建文件夹/Adobe Photoshop 2025',
    'Adobe/Adobe Photoshop 2026', 'Adobe',
  ];
  for (const d of drives) {
    for (const a of adobeDirs) {
      for (const v of ['Adobe Photoshop 2026', 'Adobe Photoshop 2025', 'Adobe Photoshop 2024']) {
        out.push(`${d}/${a}/${v}/Plug-ins`);
      }
      out.push(`${d}/${a}/Plug-ins`);
    }
  }
  return out;
}

function resolveTarget() {
  const arg = process.argv[2] || process.env.PS_PLUGINS_DIR;
  if (arg) return arg;
  for (const c of guessCandidates()) {
    try { if (fs.existsSync(c)) return c; } catch { /* 忽略无权限的盘 */ }
  }
  return null;
}

const target = resolveTarget();
if (!target) {
  console.error('找不到 Photoshop 的 Plug-ins 目录。请显式指定：');
  console.error('  node tools/install-plugin.mjs "D:\\path\\to\\Photoshop\\Plug-ins"');
  process.exit(1);
}
if (!fs.existsSync(target)) {
  console.error('目录不存在：' + target);
  process.exit(1);
}

const dest = path.join(target, PLUGIN_ID);
// 【为什么不用 fs.rmSync(recursive)】某些环境（沙箱 / 受管终端）会把递归删除
// 重定向成「移到回收站」并失败；而且 Plug-ins 目录可能没有删除权限。
// 这里改为「按已知文件逐个覆盖 + 清理已废弃文件」，幂等且不需要删除目录。
fs.mkdirSync(path.join(dest, 'dist'), { recursive: true });

const files = [
  ['plugin/manifest.json', 'manifest.json'],
  ['plugin/index.html', 'index.html'],
  ['plugin/main.js', 'main.js'],
  ['plugin/dist/core.js', 'dist/core.js'],
];
for (const [src, rel] of files) {
  const from = path.join(ROOT, src);
  if (!fs.existsSync(from)) {
    console.error('缺少 ' + src + ' —— 先跑 node plugin/build.mjs 生成 dist/core.js');
    process.exit(1);
  }
  fs.copyFileSync(from, path.join(dest, rel));
}

/* 清理历史版本残留的入口文件（避免 UXP 加载到旧脚本）：
   只删我们自己曾经放过的名字，不动用户加的其它文件。 */
for (const stale of ['core.js', 'probe-worker.js']) {
  const p = path.join(dest, stale);
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* 只读就跳过 */ }
}

const version = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8')).version;
console.log('✓ 已安装 v' + version + ' → ' + dest);
console.log('  （卸载 = 删掉这个文件夹；与其它插件互不影响）');
console.log('  重启 Photoshop 才会加载。');
