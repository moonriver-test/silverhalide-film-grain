# 依赖清单与版本锁定

> 本文件是「换个环境能不能跑起来」的唯一依据。所有版本号都是**本机实测过的**，
> 不是「大概能用」的估计。

---

## 一、运行时依赖

### 1.1 算法核心（`core/`）—— **零依赖**

`core/*.mjs` 只用 JavaScript 标准库（`Math`、`Float32Array`、`Math.log` 等），
**不依赖任何 npm 包、不依赖 Node 内置模块**（除 `core/png.mjs` 也不需要 ——
它自带 crc32/adler32，为的是能在 UXP 里跑）。

因此核心可以在浏览器、Node、UXP 任意环境运行，这是「平台无关」这条设计约束的实现基础。

### 1.2 Node 侧工具（`tools/`、`plugin/build.mjs`）

| 包 | 版本 | 用途 | 是否必需 |
|---|---|---|---|
| `esbuild` | **0.28.2** | 把 `core/` 打成 UXP 可加载的 IIFE（`plugin/dist/core.js`） | 必需（只有打包时需要） |
| `jpeg-js` | **0.4.4** | 离线端到端测试解码真实 JPEG（`tools/e2e.mjs`） | 可选（只有 e2e 需要） |

**没有其他依赖。** 项目刻意不引入 FFT 库、图像库、测试框架 ——
FFT 是自己写的（`tools/fft.mjs`）、PNG 编解码是自己写的（`tools/png.mjs`、`core/png.mjs`）、
断言是自己写的最简 `check()`。

### 1.3 Node 版本

| 项 | 值 |
|---|---|
| 本机实测版本 | **Node 22.22.2**（托管运行时） |
| 绝对路径 | `C:\Users\qijin\.workbuddy\binaries\node\versions\22.22.2\node.exe` |
| 最低要求 | Node ≥ 18（用到了 `node:test` 之外的现代 ESM；`--expose-gc` 用于基准） |

**这个项目不用 TypeScript、不用打包工具链、不用 npm scripts 之外的任何构建系统**，
所以「换电脑」的成本主要是装 esbuild 和 jpeg-js 两个包。

---

## 二、Photoshop / UXP 侧

| 项 | 值 | 说明 |
|---|---|---|
| Photoshop | **27.5.0**（2026-06-23 版） | UXP 面板宿主 |
| 安装路径 | `D:\新建文件夹\Adobe Photoshop 2026` | 路径含中文与空格，构建脚本已处理 |
| 插件目录 | `<PS根目录>\Plug-ins\` | **不需要 UXP Developer Tool**，丢文件夹即可加载 |
| manifestVersion | **5** | 低于 5 时 `clipboard` 等权限不可用 |
| apiVersion | **2** | `require('photoshop')` 的 API 版本 |
| Web Worker | **不可用**（无构造器） | 实测；因此全部计算在主线程 + 分块让出 |
| WebAssembly | **可用** | 备选加速路径（尚未使用） |

### 2.1 本机已安装的插件

| 目录 | 用途 |
|---|---|
| `Plug-ins/com.silverhalide.grain` | **本项目产品**（v0.5.4） |
| `Plug-ins/com.silverhalide.probe` | 本项目的一次性探针（环境/吞吐测量，可删） |
| `Plug-ins/com.cheukwing.filmemulation` | **第三方在售插件（重要参考）** |

> ⚠️ **关于 Film Emulation**：本项目**没有抄它的任何代码**。
> 它的价值在于「在你这台机器这个版本上确实能跑」—— 我们用它来核对 UXP 的
> 像素读写写法（`imageData.getData()`、`putPixels` 必须带 `layerID`、
> `createLayer` + `move(..., PLACEBEFORE)` 做非破坏效果层）。
> 这些是 API **用法事实**，不是实现代码。分发本项目时不要打包它的任何内容。

---

## 三、没有数据集、没有模型权重

这一点值得单独说明，因为它是「AI 项目」的常见误解：

- **本插件是纯程序化算法**，不含任何机器学习模型、不含权重文件、不含训练数据。
  颗粒由坐标寻址哈希 + 可分离高斯卷积合成，参数由物理标定链（见 `core/film.mjs`）解析得出。
- 仓库里唯一的「生成式资产」是 UI 素材（`ui-preview/assets2/*.png`），
  由图像生成模型产出，**仅用于界面预览稿**，与算法无关。
- 唯一的外部数据依赖是**胶片实测颗粒度数据**（柯达 PGI / RMS 值），
  已硬编码进 `core/film.mjs` 的胶片预设表，并标注了来源与可信度。

---

## 四、离线安装（新机器上手用）

```bash
# 建议把依赖装到项目内的 node_modules（而不是全局），避免污染
cd <项目根>

# 方式 A：有网络
npm install --no-audit --no-fund

# 方式 B：完全离线（把这两个包从旧机器拷过来）
#   esbuild-0.28.2 / jpeg-js-0.4.4 的 tarball 放进 ./vendor/
npm install --no-audit --no-fund --offline ./vendor/esbuild-0.28.2.tgz ./vendor/jpeg-js-0.4.4.tgz
```

旧机器上的包位置（可直接复制整个目录）：

```
C:\Users\qijin\.workbuddy\binaries\node\workspace\node_modules\{esbuild,jpeg-js}
```

### 4.1 路径适配

`tools/e2e.mjs` 里目前**硬编码**了 `jpeg-js` 的绝对路径：

```js
const jpeg = require('C:/Users/qijin/.workbuddy/binaries/node/workspace/node_modules/jpeg-js');
```

换机器请改成 `require('jpeg-js')`，或设置 `NODE_PATH`。
**这是已知的待清理项**（见 `HANDOVER.md` 的「待办」）。

---

## 五、版本矩阵（本仓库）

| 组件 | 版本 | 位置 |
|---|---|---|
| Photoshop 插件 | **0.5.4** | `plugin/manifest.json` |
| 探针插件 | 0.6.0 | `probe/manifest.json` |
| 算法核心 | 随插件版本走（无独立版本号） | `core/` |
| 研究报告 | 含 2026-10-03 勘误卡 | `docs/research-report.html` |
| 设计文档 | v0.1 + 勘误 | `docs/design-spec.html` |
| 验收测试 | 41 项（`node tools/run.mjs`，当前 41 通过 / 0 失败） | `tools/run.mjs` |
| 预检 | 10 节（`node tools/verify-bundle.mjs`） | `tools/verify-bundle.mjs` |
