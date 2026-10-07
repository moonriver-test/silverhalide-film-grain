/* 把本仓库推送到 GitHub（幂等、可重复运行、不在磁盘上留下 token）。
 *
 * 为什么需要它：本机没有存储的 git 凭据、也没有 gh CLI，
 * 而 GitHub 连接器（MCP）没有建仓权限、且只能推文本文件（二进制会被编码破坏）。
 * 所以走一次性的 PAT + git push。
 *
 * 用法（三种给 token 的方式，按推荐顺序）：
 *   1) 存到文件（推荐，命令里不会出现 token）
 *        node tools/push-to-github.mjs --token-file D:/gh_token.txt
 *   2) 环境变量
 *        GITHUB_TOKEN=xxx node tools/push-to-github.mjs
 *   3) 参数（会出现在命令历史里，不推荐）
 *        node tools/push-to-github.mjs --token xxx
 *
 * 可选参数：
 *   --owner    默认 moonriver-test
 *   --repo     默认 silverhalide-film-grain
 *   --branch   默认 main
 *   --visibility public | private   默认 public（仅建仓时生效）
 *
 * 重要：本机网络有 TLS 中间人代理，证书链无法验证，直接跑会报
 *   UNABLE_TO_VERIFY_LEAF_SIGNATURE（node fetch）/ SSL certificate problem（git）。
 *   必须先放宽校验再执行（只对本条命令生效，不改全局配置）：
 *
 *     NODE_TLS_REJECT_UNAUTHORIZED=0 GIT_SSL_NO_VERIFY=1 \
 *       node tools/push-to-github.mjs --token-file D:/gh_token.txt
 *
 *   若目标机器证书正常（能直连 github.com 且无代理拦截），不要加这两个变量。
 *
 * 它的行为：
 *   1. 用 token 查仓库是否存在，不存在则创建，并轮询等它真正可达
 *   2. git remote 设为带 token 的 URL → push（失败自动重试 3 次）→ **立刻改回不带 token**
 *   3. 全程不打印 token；结束时提示去撤销 token
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function flag(name) { return process.argv.includes('--' + name); }

const owner = arg('owner', 'moonriver-test');
const repo = arg('repo', 'silverhalide-film-grain');
const branch = arg('branch', 'main');
const visibility = arg('visibility', 'public');

let token = arg('token', process.env.GITHUB_TOKEN || '');
const tokenFile = arg('token-file', '');
if (!token && tokenFile) {
  if (!fs.existsSync(tokenFile)) { console.error('token 文件不存在：' + tokenFile); process.exit(1); }
  token = fs.readFileSync(tokenFile, 'utf8').trim();
}
if (!token) {
  console.error('没有拿到 token。用 --token-file / GITHUB_TOKEN / --token 任一方式提供。');
  process.exit(1);
}

const gh = (method, url, body) => fetch('https://api.github.com' + url, {
  method,
  headers: {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'silverhalide-handover',
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

function git(args, opts = {}) {
  // 用 execFileSync 而非 shell，避免 token 出现在进程命令行里被 ps 看到
  return execFileSync('git', args, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', ...opts });
}

const authedUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
const cleanUrl = `https://github.com/${owner}/${repo}.git`;

function scrubRemote() {
  try {
    git(['remote', 'set-url', 'origin', cleanUrl]);
    console.log('  ✓ remote 已改回不带凭据的 URL');
  } catch (e) {
    console.log('  ! 清除 remote 里的凭据失败，请手动检查 .git/config');
  }
}

/* 无论怎么退出，都要把带 token 的 remote 清掉。
 * 实测：若只挂 exit/SIGINT，某些异常终止路径不会触发，token 会留在 .git/config 里。
 * 所以把未捕获异常/未处理 rejection 也显式接住。 */
process.on('exit', scrubRemote);
process.on('SIGINT', () => { scrubRemote(); process.exit(130); });
process.on('uncaughtException', (e) => {
  console.error('未捕获异常：' + ((e && e.message) || e));
  scrubRemote();
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error('未处理的异步错误：' + ((e && e.message) || e));
  scrubRemote();
  process.exit(1);
});

console.log('目标：' + owner + '/' + repo + '　分支 ' + branch + '　可见性 ' + visibility);

/* 1) 仓库是否存在 */
let exists = false;
try {
  const r = await gh('GET', `/repos/${owner}/${repo}`);
  exists = r.ok;
  if (!r.ok && r.status !== 404) {
    console.error('查询仓库失败：HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    process.exit(1);
  }
} catch (e) {
  console.error('网络错误：' + e.message);
  process.exit(1);
}

if (exists) {
  console.log('仓库已存在，跳过创建。');
} else {
  console.log('仓库不存在，创建中……');
  const r = await gh('POST', '/user/repos', {
    name: repo,
    description: '银盐 · Silver Halide —— 基于胶片物理模型的 Photoshop UXP 胶片颗粒插件',
    private: visibility !== 'public',
    auto_init: false,
  });
  if (!r.ok) {
    const t = await r.text();
    console.error('创建仓库失败：HTTP ' + r.status);
    console.error(t.slice(0, 500));
    console.error('\n提示：classic token 需要 `repo` scope；');
    console.error('      fine-grained token 需要 Administration: Read and write + Contents: Read and write。');
    process.exit(1);
  }
  console.log('  ✓ 已创建 https://github.com/' + owner + '/' + repo);

  /* 刚建好的仓库存在数秒的"尚不可见"窗口，此时 git push 会报 Repository not found。
   * 必须轮询到它真的可达再推 —— 这是首次推送失败的唯一原因（实测）。 */
  for (let i = 0; i < 8; i++) {
    const probe = await gh('GET', `/repos/${owner}/${repo}`);
    if (probe.ok) { console.log('  ✓ 仓库已可访问，可以推送'); break; }
    if (i === 7) { console.log('  ! 等待超时，仍继续尝试推送'); break; }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/* 2) 提交检查 */
try {
  const dirty = git(['status', '--porcelain']).trim();
  if (dirty) console.log('注意：工作区有未提交改动，本次只推送已提交的内容。');
  console.log('本地最新提交：' + git(['log', '-1', '--oneline']).trim());
} catch (e) {
  console.error('这不是一个 git 仓库，或 git 不可用：' + e.message);
  process.exit(1);
}

/* 3) 推送 */
try {
  git(['remote', 'remove', 'origin']);
} catch { /* 没有 remote 也正常 */ }
git(['remote', 'add', 'origin', authedUrl]);

console.log('推送中（' + git(['count-objects', '-vH']).split('\n').find((l) => l.startsWith('size-pack')) + '）……');
let pushed = false;
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    const out = git(['push', '-u', 'origin', branch, '--force']);
    console.log(out.trim() || '  ✓ 推送完成');
    pushed = true;
    break;
  } catch (e) {
    // execFileSync 失败时 e.stderr / e.stdout 是 Buffer，e.status 是退出码
    const raw = [e.stderr, e.stdout, e.message]
      .filter(Boolean).map((x) => x.toString()).join('\n').trim();
    const detail = (raw || '(git 未返回输出，退出码 ' + (e.status ?? '?') + ')')
      .replaceAll(token, '***');
    console.log('  第 ' + attempt + ' 次推送失败：' + detail);
    // 疑似"仓库刚建好还没就绪"，等一下再试
    if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
  }
}
if (!pushed) {
  scrubRemote();
  console.error('推送失败（已重试 3 次，见上方输出）。');
  console.error('常见原因：token 缺少 Contents 写权限、分支保护规则拒绝 force push、或网络代理阻断 git。');
  process.exit(1);
}
scrubRemote();

console.log('\n完成。仓库地址：https://github.com/' + owner + '/' + repo);
console.log('提醒：这个 PAT 已经用完了 —— 建议现在去 Settings → Developer settings 里撤销或让它过期。');
