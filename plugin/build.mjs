/* 把平台无关的算法核心打包成 UXP 面板能用的单文件 IIFE
 *
 * 运行：node plugin/build.mjs
 * 产出：plugin/dist/core.js（挂到全局 SHC）
 *
 * 为什么必须打包：UXP 面板用 `<script src>` 加载脚本，不支持 ESM 的 import/export。
 * 在售的 Film Emulation 同样是打包产物（dist/main.js 是 bundle）。
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const esbuild = require('C:/Users/qijin/.workbuddy/binaries/node/workspace/node_modules/esbuild/lib/main.js');

// 注意：new URL(...).pathname 会把中文目录名百分号编码（本机路径含「数据」），
// 必须用 fileURLToPath 还原，否则 esbuild 报 Could not resolve。
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const entry = path.join(root, 'core', 'plugin-entry.mjs');
const outfile = path.join(root, 'plugin', 'dist', 'core.js');

fs.mkdirSync(path.dirname(outfile), { recursive: true });

const result = await esbuild.build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'iife',
  globalName: 'SHC',
  target: ['es2019'],
  platform: 'neutral',
  legalComments: 'none',
  minify: false,
  metafile: true,
  logLevel: 'warning',
});

const size = fs.statSync(outfile).size;
const inputs = Object.keys(result.metafile.inputs);
console.log('打包完成 → ' + outfile);
console.log('  大小   : ' + (size / 1024).toFixed(1) + ' KB');
console.log('  输入   : ' + inputs.join(', '));

// 自检：确认产物确实是「挂到 globalName」的 IIFE，而不是 ESM
const head = fs.readFileSync(outfile, 'utf8').slice(0, 200);
if (!/^var SHC = /.test(head)) {
  console.error('产物头部不是预期的 `var SHC = `：\n' + head);
  process.exit(1);
}
if (/\bexport\s*\{/.test(fs.readFileSync(outfile, 'utf8'))) {
  console.error('产物里仍含 export 语句，UXP 会解析失败');
  process.exit(1);
}
console.log('  自检   : ✓ IIFE 头正确，无残留 export');
