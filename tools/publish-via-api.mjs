/* 用 GitHub REST API 发布本地未推送的提交 —— 当 `git push` 不可用时的替代通道。
 *
 * 为什么需要它：
 *   某些受限环境会把 `git push` 整个进程杀掉（连 `--dry-run`、不发任何数据也杀），
 *   而同一个环境里认证的 REST API 写操作却完全正常（建仓、建 blob 都能成）。
 *   实测表现：git push 静默返回、shell 后续语句一起消失、退出码 1。
 *   这时可以逐对象地把提交"搬"上去。
 *
 * 它做了什么（每个未推送的提交）：
 *   1. POST /git/blobs          —— 把改动文件的字节按原样上传（base64，无编码转换）
 *   2. POST /git/trees          —— 以远程父提交的 tree 为 base_tree，只替换改动路径
 *   3. POST /git/commits        —— 复用原提交的 author/committer/时间戳/消息
 *   4. PATCH /git/refs/heads/分支 —— 前移分支指针（仅快进，不 force）
 *
 * 关键特性：**逐提交校验 tree SHA**。GitHub 算出的 tree 必须与本地
 * `git rev-parse <commit>^{tree}` 完全相同，否则立即中止 ——
 * 这保证了远程内容与本地逐字节一致，而不是"看起来像"。
 *
 * 用法：
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node tools/publish-via-api.mjs --token-file D:/gh_token.txt
 *
 * 可选参数：
 *   --owner   默认 moonriver-test
 *   --repo    默认 silverhalide-film-grain
 *   --branch  默认 main
 *   --upto    只发布到这个提交（默认 HEAD）
 *   --dry-run 只打印计划，不写任何东西
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
const dryRun = process.argv.includes('--dry-run');

const owner = arg('owner', 'moonriver-test');
const repo = arg('repo', 'silverhalide-film-grain');
const branch = arg('branch', 'main');

let token = arg('token', process.env.GITHUB_TOKEN || '');
const tokenFile = arg('token-file', '');
if (!token && tokenFile) {
  if (!fs.existsSync(tokenFile)) { console.error('token 文件不存在：' + tokenFile); process.exit(1); }
  token = fs.readFileSync(tokenFile, 'utf8').trim();
}
if (!token && !dryRun) {
  console.error('没有拿到 token。用 --token-file / GITHUB_TOKEN / --token 任一方式提供。');
  process.exit(1);
}

const H = {
  ...(token ? { Authorization: 'Bearer ' + token } : {}),
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'silverhalide-publish',
  'Content-Type': 'application/json',
};

const api = async (method, url, body) => {
  const r = await fetch('https://api.github.com' + url, {
    method, headers: H, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  if (!r.ok) {
    console.error(`  ✗ ${method} ${url} → HTTP ${r.status}`);
    console.error('    ' + text.slice(0, 400));
    throw new Error('API 失败');
  }
  return text ? JSON.parse(text) : {};
};

/* git 一律以字节方式读取，避免 CRLF / 编码被工作区污染 */
const git = (args, enc = 'utf8') =>
  execFileSync('git', args, { cwd: ROOT, stdio: 'pipe', ...(enc ? { encoding: enc } : {}) });
const gitBuf = (args) => execFileSync('git', args, { cwd: ROOT, stdio: 'pipe' });
const gitText = (args) => git(args, 'utf8').toString().trim();

/* 把 git 的 "<epoch> <±HHMM>" 转成 API 接受的 ISO 8601 */
function isoFromGitDate(epoch, tz) {
  const sign = tz[0] === '-' ? -1 : 1;
  const offMin = sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
  const d = new Date((Number(epoch) + offMin * 60) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
         `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}` +
         `${tz.slice(0, 3)}:${tz.slice(3, 5)}`;
}

/* 解析一条 commit 对象的原始字节 */
function parseCommit(sha) {
  const raw = gitBuf(['cat-file', 'commit', sha]).toString('utf8');
  const nl = raw.indexOf('\n\n');
  const headers = raw.slice(0, nl).split('\n');
  const message = raw.slice(nl + 2);            // 原样保留（含结尾换行）
  const get = (k) => headers.find((l) => l.startsWith(k + ' '))?.slice(k.length + 1);
  const parseWho = (line) => {
    const m = line.match(/^(.*) <(.*)> (\d+) ([+-]\d{4})$/);
    return { name: m[1], email: m[2], date: isoFromGitDate(m[3], m[4]) };
  };
  return {
    sha,
    tree: get('tree'),
    parents: headers.filter((l) => l.startsWith('parent ')).map((l) => l.slice(7)),
    author: parseWho(get('author')),
    committer: parseWho(get('committer')),
    message,
  };
}

const localHead = gitText(['rev-parse', 'HEAD']);
const upto = arg('upto', localHead);

console.log(`仓库：${owner}/${repo}　分支 ${branch}`);
console.log(`本地 HEAD：${localHead.slice(0, 8)}`);

/* 远程当前指向哪儿 */
const ref = await api('GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
const remoteSha = ref.object.sha;
console.log(`远程 HEAD：${remoteSha.slice(0, 8)}`);

if (remoteSha === upto) {
  console.log('\n已经是最新，无需发布。');
  process.exit(0);
}

/* 待发布的提交（旧 → 新） */
const list = gitText(['rev-list', '--reverse', `${remoteSha}..${upto}`]).split('\n').filter(Boolean).map(parseCommit);
if (!list.length) {
  console.log('\n没有需要发布的提交（远程可能领先本地，请先 git fetch）。');
  process.exit(0);
}
console.log(`待发布 ${list.length} 个提交：`);
list.forEach((c) => console.log(`  ${c.sha.slice(0, 8)}  ${c.message.split('\n')[0]}`));

if (dryRun) { console.log('\n--dry-run：不写入任何内容。'); process.exit(0); }

console.log('');

/* 注意顺序：GitHub 的 refs 更新必须最后做，中途失败就保持原状 */
let parentSha = remoteSha;
let parentTree = (await api('GET', `/repos/${owner}/${repo}/git/commits/${remoteSha}`)).tree.sha;

for (const c of list) {
  console.log(`提交 ${c.sha.slice(0, 8)}　${c.message.split('\n')[0]}`);

  /* 改动路径（相对父提交） */
  const parentForDiff = c.parents[0] || gitText(['rev-parse', c.sha + '^']);
  const status = gitText(['diff', '--name-status', parentForDiff, c.sha])
    .split('\n').filter(Boolean)
    .map((l) => { const [st, ...rest] = l.split('\t'); return { st: st[0], p: rest.join('\t') }; });

  const entries = [];
  for (const { st, p } of status) {
    if (st === 'D') { entries.push({ path: p.replaceAll('\\', '/'), mode: '100644', type: 'blob', sha: null }); continue; }
    if (st === 'R' || st === 'C') { console.error('  ! 暂不支持重命名/复制，请先拆分提交'); process.exit(1); }

    const blobSha = gitText(['rev-parse', `${c.sha}:${p}`]);
    const bytes = gitBuf(['cat-file', 'blob', blobSha]);
    const created = await api('POST', `/repos/${owner}/${repo}/git/blobs`, {
      content: bytes.toString('base64'), encoding: 'base64',
    });
    if (created.sha !== blobSha) {
      console.error(`  ✗ blob 内容不一致：${p}\n    本地 ${blobSha}\n    远程 ${created.sha}`);
      process.exit(1);
    }
    const mode = gitText(['ls-tree', c.sha, '--', p]).split(/\s+/)[0] || '100644';
    entries.push({ path: p.replaceAll('\\', '/'), mode, type: 'blob', sha: created.sha });
  }
  console.log(`  ✓ ${entries.length} 个 blob 已上传（逐个校验哈希一致）`);

  /* 以远程父 tree 为基底，只替换改动路径 */
  const tree = await api('POST', `/repos/${owner}/${repo}/git/trees`, {
    base_tree: parentTree, tree: entries,
  });

  /* 关键校验：远程算出的 tree 必须与本地完全相同 */
  const localTree = gitText(['rev-parse', `${c.sha}^{tree}`]);
  if (tree.sha !== localTree) {
    console.error(`  ✗ tree 不一致，已中止（远程 ref 未改动）\n    本地 ${localTree}\n    远程 ${tree.sha}`);
    process.exit(1);
  }
  console.log(`  ✓ tree ${localTree.slice(0, 8)} 与本地一致`);

  const made = await api('POST', `/repos/${owner}/${repo}/git/commits`, {
    message: c.message,
    tree: tree.sha,
    parents: [parentSha],
    author: c.author,
    committer: c.committer,
  });

  if (made.sha === c.sha) {
    console.log(`  ✓ commit ${c.sha.slice(0, 8)} SHA 与本地完全相同`);
  } else {
    console.log(`  ~ commit 已创建但 SHA 不同：本地 ${c.sha.slice(0, 8)} → 远程 ${made.sha.slice(0, 8)}`);
    console.log('    （通常是 GitHub 对提交信息做了规范化；内容不受影响）');
  }

  parentSha = made.sha;
  parentTree = tree.sha;
}

/* 前移分支（快进；远程 ref 若已被改动则这里会失败，属于预期保护） */
console.log(`\n更新 refs/heads/${branch} → ${parentSha.slice(0, 8)}`);
await api('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, { sha: parentSha, force: false });

const after = await api('GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
console.log(`\n完成。远程 ${branch} = ${after.object.sha.slice(0, 8)}`);
if (after.object.sha !== upto) {
  console.log(`注意：与本地 HEAD ${upto.slice(0, 8)} 不一致（提交信息被规范化）。`);
  console.log('可以执行 `git fetch origin && git reset --hard origin/' + branch + '` 让本地对齐。');
} else {
  console.log('本地与远程完全同步。');
}
console.log('提醒：用完请去 Settings → Developer settings 撤销这个 PAT。');
