/* 卷积实现基准：判断 L2 层到底需不需要 WASM
 *
 * 背景：UXP 探针测出朴素 7 抽头可分离卷积 34.33 ns/像素（1.05 MP 用 36 ms），
 * 折算 24 MP 单趟 824 ms、L2 四趟 3.3 s —— 超出预算。本脚本测出 JS 的优化上限。
 *
 * 运行：node tools/bench-conv.mjs
 */

const N = 1024, H = 1024;
const R = 3;
const K = (() => {
  const k = [];
  for (let i = -R; i <= R; i++) k.push(Math.exp(-(i * i) / 2));
  const s = Math.sqrt(k.reduce((a, v) => a + v * v, 0));
  return k.map((v) => v / s);
})();
const NK = K.length;

const src = new Float32Array(N * H);
for (let z = 0; z < N * H; z++) src[z] = (z % 997) * 0.001;
const px = N * H;

function time(label, fn, reps = 5) {
  fn(); // 预热
  let best = Infinity;
  for (let i = 0; i < reps; i++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  const nsPerPx = (best * 1e6) / px;
  const per24 = best * 24 / (px / 1e6);
  console.log(
    '  ' + label.padEnd(34) +
    best.toFixed(1).padStart(8) + ' ms' +
    nsPerPx.toFixed(2).padStart(10) + ' ns/px' +
    ('24MP 单趟 ' + per24.toFixed(0) + ' ms').padStart(22)
  );
  return { ms: best, nsPerPx, per24, out: fn() };
}

/* ---------- A. 朴素实现：逐抽头边界钳位（探针里的基准） ---------- */
function naive(src, N, H, k) {
  const R = (k.length - 1) / 2;
  const tmp = new Float32Array(N * H), dst = new Float32Array(N * H);
  for (let y = 0; y < H; y++) {
    const off = y * N;
    for (let x = 0; x < N; x++) {
      let acc = 0;
      for (let i = 0; i < k.length; i++) {
        let xx = x + i - R; if (xx < 0) xx = 0; if (xx >= N) xx = N - 1;
        acc += k[i] * src[off + xx];
      }
      tmp[off + x] = acc;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < N; x++) {
      let acc = 0;
      for (let i = 0; i < k.length; i++) {
        let yy = y + i - R; if (yy < 0) yy = 0; if (yy >= H) yy = H - 1;
        acc += k[i] * tmp[yy * N + x];
      }
      dst[y * N + x] = acc;
    }
  }
  return dst;
}

/* ---------- B. 优化实现：边界与内部拆开，内部无分支且展开 ---------- */
function optimized(src, N, H, k) {
  const R = (k.length - 1) / 2;
  const tmp = new Float32Array(N * H), dst = new Float32Array(N * H);

  // 横向：左边界 / 无分支内部 / 右边界
  for (let y = 0; y < H; y++) {
    const off = y * N;
    for (let x = 0; x < R; x++) {
      let acc = 0;
      for (let i = -R; i <= R; i++) {
        let xx = x + i; if (xx < 0) xx = 0; else if (xx >= N) xx = N - 1;
        acc += k[i + R] * src[off + xx];
      }
      tmp[off + x] = acc;
    }
    for (let x = R; x < N - R; x++) {
      const b = off + x;
      tmp[b] = k[0] * src[b - 3] + k[1] * src[b - 2] + k[2] * src[b - 1] + k[3] * src[b]
             + k[4] * src[b + 1] + k[5] * src[b + 2] + k[6] * src[b + 3];
    }
    for (let x = N - R; x < N; x++) {
      let acc = 0;
      for (let i = -R; i <= R; i++) {
        let xx = x + i; if (xx < 0) xx = 0; else if (xx >= N) xx = N - 1;
        acc += k[i + R] * src[off + xx];
      }
      tmp[off + x] = acc;
    }
  }

  // 纵向：先处理上下边界行，再对内部行做 7 行指针展开
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < N; x++) {
      let acc = 0;
      for (let i = -R; i <= R; i++) {
        let yy = y + i; if (yy < 0) yy = 0; else if (yy >= H) yy = H - 1;
        acc += k[i + R] * tmp[yy * N + x];
      }
      dst[y * N + x] = acc;
    }
  }
  for (let y = R; y < H - R; y++) {
    const b = y * N;
    const t0 = b - 3 * N, t1 = t0 + N, t2 = t1 + N, t3 = t2 + N, t4 = t3 + N, t5 = t4 + N, t6 = t5 + N;
    for (let x = 0; x < N; x++) {
      dst[b + x] = k[0] * tmp[t0 + x] + k[1] * tmp[t1 + x] + k[2] * tmp[t2 + x] + k[3] * tmp[t3 + x]
                 + k[4] * tmp[t4 + x] + k[5] * tmp[t5 + x] + k[6] * tmp[t6 + x];
    }
  }
  for (let y = H - R; y < H; y++) {
    for (let x = 0; x < N; x++) {
      let acc = 0;
      for (let i = -R; i <= R; i++) {
        let yy = y + i; if (yy < 0) yy = 0; else if (yy >= H) yy = H - 1;
        acc += k[i + R] * tmp[yy * N + x];
      }
      dst[y * N + x] = acc;
    }
  }
  return dst;
}

/* ---------- C. 三次箱式模糊近似高斯：游程求和，代价与半径无关 ---------- */
function boxBlur1D(src, dst, n, r) {
  const inv = 1 / (2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += src[i < 0 ? 0 : (i >= n ? n - 1 : i)];
  for (let x = 0; x < n; x++) {
    dst[x] = sum * inv;
    const addIdx = x + r + 1; const subIdx = x - r;
    sum += src[addIdx >= n ? n - 1 : addIdx] - src[subIdx < 0 ? 0 : subIdx];
  }
}

function boxApprox(src, N, H, sigma) {
  // 三次箱式模糊的方差 = r(r+1) ⇒ 由此反解半径
  const r = Math.max(1, Math.round(Math.sqrt(sigma * sigma + 0.25) - 0.5));
  let a = src, b = new Float32Array(N * H), c = new Float32Array(N * H);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < H; y++) {
      const off = y * N;
      boxBlur1D(a.subarray(off, off + N), b.subarray(off, off + N), N, r);
    }
    for (let x = 0; x < N; x++) {
      // 纵向：先抽成列，再模糊，再写回（避免跨步访问）
      for (let y = 0; y < H; y++) c[y] = b[y * N + x];
      const col = new Float32Array(H);
      boxBlur1D(c, col, H, r);
      for (let y = 0; y < H; y++) b[y * N + x] = col[y];
    }
    const t = a; a = b; b = t;
  }
  return a;
}

/* ---------- 正确性交叉校验 ---------- */
function maxDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > m) m = d; }
  return m;
}

console.log('=== 卷积实现基准（' + N + 'x' + H + ' = ' + (px / 1e6).toFixed(2) + ' MP）===');
console.log('  注：探针在 UXP 里测到的朴素实现是 34.33 ns/px\n');

const ref = naive(src, N, H, K);
const A = time('A 朴素·逐抽头钳位（探针基准）', () => naive(src, N, H, K));

// 用同一个 sigma 对照：K 的等效 sigma 由二阶矩推出
let m2 = 0, m0 = 0;
for (let i = 0; i < NK; i++) { m0 += K[i]; m2 += K[i] * (i - R) * (i - R); }
const sigmaEq = Math.sqrt(m2 / m0);

const B = time('B 优化·边界拆分+展开', () => optimized(src, N, H, K));
console.log('     与朴素实现的逐像素最大差异 : ' + maxDiff(A.out, B.out).toExponential(2));

const C = time('C 三次箱式模糊(r=' + Math.max(1, Math.round(Math.sqrt(sigmaEq * sigmaEq + 0.25) - 0.5)) + ')', () => boxApprox(src, N, H, sigmaEq), 3);
console.log('     与高斯参考的最大差异       : ' + maxDiff(A.out, C.out).toExponential(2) + '（尺度不同属正常，仅看量级）');

console.log('\n=== L2 层总成本推算（24 MP）===');
console.log('  当前设计：细颗粒场 2 趟 + 团簇场 2 趟 = 4 趟');
const rows = [
  ['A 朴素', A.per24 * 4],
  ['B 优化', B.per24 * 4],
  ['C 箱式', C.per24 * 4]
];
for (const [name, t] of rows) {
  const opt = B.per24 * 2 + (B.per24 / 16) * 2; // 团簇场降到 1/4 分辨率
  console.log('  ' + name.padEnd(8) + '4 趟全分辨率 ' + t.toFixed(0).padStart(6) + ' ms'
    + '　｜　团簇场降 1/4 分辨率后 ' + (name[0] === 'B' ? opt.toFixed(0) : (t / 4 + t / 64).toFixed(0)).padStart(5) + ' ms');
}
