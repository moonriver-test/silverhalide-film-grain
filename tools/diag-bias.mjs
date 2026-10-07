/* 诊断：二阶偏置补偿的残差是「系统性误差」还是「随机场的统计涨落」
 *
 * 现象：验收测试 5 在 strength=0.08 时残差 0.2774，超过 0.25 的阈值；
 *       而 strength=0.04 的残差 0.0621 与改动前完全一致。
 *
 * 关键判别：单个种子的「均值漂移」包含两项
 *   (a) 二阶偏置   ∝ S²，确定性，补偿项要消掉它
 *   (b) 场的直流项 ∝ S ，随机（E[mean(g)]=0 但单次不为 0）
 * 若把种子平均掉，(b) 应趋近 0，剩下的就是 (a) 的补偿误差。
 *
 * 运行：node tools/diag-bias.mjs
 */

import { applyGrain, makeFlat, buildAmplitudeLUTs, jacobianAtV, amplitudeAt } from '../core/grain.mjs';

const W = 1024, H = 1024;
const GRAY = 0.45;
const SEEDS = 32;
const CLUMP = 0.4;

function meanOf(a) {
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i];
  return s / a.length;
}

console.log('=== 二阶偏置补偿：跨种子平均 ===');
console.log('  图像 ' + W + '×' + H + '　灰度 ' + GRAY + '　clumping ' + CLUMP + '　种子数 ' + SEEDS);
console.log('');

const src = makeFlat(W, H, GRAY);

for (const S of [0.02, 0.04, 0.08, 0.12]) {
  const no = [], yes = [];
  for (let s = 0; s < SEEDS; s++) {
    const seed = 1000 + s * 7;
    const a = Float32Array.from(src);
    applyGrain(a, W, H, { seed, radiusPx: 2, clumping: CLUMP, strength: S, compensate: false });
    no.push((meanOf(a) - GRAY) * 255);

    const b = Float32Array.from(src);
    applyGrain(b, W, H, { seed, radiusPx: 2, clumping: CLUMP, strength: S, compensate: true });
    yes.push((meanOf(b) - GRAY) * 255);
  }
  const mNo = no.reduce((x, y) => x + y, 0) / SEEDS;
  const mYes = yes.reduce((x, y) => x + y, 0) / SEEDS;
  const se = (arr) => {
    const m = arr.reduce((x, y) => x + y, 0) / arr.length;
    const v = arr.reduce((x, y) => x + (y - m) * (y - m), 0) / (arr.length - 1);
    return Math.sqrt(v / arr.length);
  };
  const seYes = se(yes);
  const z = mYes / seYes;
  console.log('  S=' + String(S).padEnd(5)
    + ' 未补偿均值 ' + mNo.toFixed(4).padStart(9)
    + '　补偿后均值 ' + mYes.toFixed(4).padStart(9)
    + '　标准误 ' + seYes.toFixed(4).padStart(7)
    + '　z=' + z.toFixed(2).padStart(7)
    + '　' + (Math.abs(z) < 3 ? '✓ 残差在涨落内' : '✗ 系统性残差'));
}

console.log('');
console.log('=== 补偿系数的解析核验（与场无关，纯确定性）===');
const { sigLin, corr } = buildAmplitudeLUTs({ strength: 0.04, uPeak: 0.62 });
const idx = Math.min(1023, Math.round(GRAY * 1023));
const g1 = jacobianAtV(GRAY);
const sLin = sigLin[idx];
const halfG2s2 = corr[idx];
console.log('  灰度 v=' + GRAY + ' 处：g\'(l)=' + g1.toFixed(4) + '　σ_lin=' + sLin.toExponential(3));
console.log('  补偿系数 corr = ½g\'\'σ² = ' + halfG2s2.toExponential(3));
console.log('  换到「色阶」单位（×255·g\'）: ' + (halfG2s2 * g1 * 255).toFixed(4) + ' 色阶（S=0.04）');
console.log('  按 S² 缩放后的预期真值（S=0.08）: ' + (halfG2s2 * g1 * 255 * 4).toFixed(4) + ' 色阶');
console.log('');
console.log('判读：若跨种子平均后 z 很小，说明补偿没错，单次测试的残差来自随机场的直流项；');
console.log('      若 z 随 S 增大而增大，说明补偿系数本身有系统性问题。');
