# 银盐 · Silver Halide

> 基于胶片物理模型的 Photoshop 胶片颗粒插件。
> **核心算法平台无关**（零依赖、可在 Node / 浏览器 / UXP 中直接运行）。

---

## 这是什么

给数码照片添加**胶片颗粒质感**的 Photoshop UXP 面板插件。

与常见的「叠一层噪声」不同，颗粒是**按胶片物理规律重构**出来的：

- **幅度按密度定**：中间调最强、两端收敛；高光衰减比阴影更快（负片肩部特性）
- **尺度按画幅定**：不是固定像素，而是按画幅对角线 —— 同 24 MP 下 120 比 135 细
- **团簇是消色的**：四通道共用一份包络（银颗粒是同一份，三层染料跟随它）
- **逐通道独立幅度**：每层染料按自己的曝光响应，暗通道自然无噪
- **暗部有噪声地板膝**：注入量上限 `l/3.5`，数学上不会跌破 0

对外只暴露摄影师熟悉的三个旋钮：**胶片型号 × 感光度 × 画幅**，
内部由标定链（柯达 PGI + RMS 数据）解析成物理参数。

---

## 快速开始

```bash
# 1) 依赖（核心零依赖，只有打包与离线测试需要这两个包）
npm install --no-audit --no-fund

# 2) 验收测试：41 项物理指标
npm test              # → node tools/run.mjs

# 3) 打包核心（生成 plugin/dist/core.js）
npm run build         # → node plugin/build.mjs

# 4) 进 PS 前预检（10 节，含 token 一致性 / DOM 交叉核对 / 不叠加机制）
npm run verify        # → node tools/verify-bundle.mjs

# 5) 安装到 Photoshop（路径自动探测，也可显式传参）
npm run install-plugin
# 或： node tools/install-plugin.mjs "D:\你的路径\Adobe Photoshop 2026\Plug-ins"
```

**使用**：重启 Photoshop → 打开照片 → `增效工具 / Plugins` → **银盐 · 胶片颗粒**。

> 颗粒写在**独立图层**（`银盐颗粒 · 源 <id>`）上，源图层一个像素都不动。
> 每次应用都从源图层重算 ⇒ 不叠加、可反复调参、可一键移除。

---

## 目录结构

```
film-grain-plugin/
├── core/                    算法核心（零依赖，平台无关）★ 最重要的部分
│   ├── grain.mjs            颗粒场生成 + 幅度 LUT + 合成（含全部物理推导注释）
│   ├── film.mjs             胶片预设表 + 「胶片×ISO×画幅 → 物理参数」标定链
│   ├── io.mjs               位深适配 / 抖动 / 行带分段（一次读一次写）
│   ├── png.mjs              零依赖 PNG 编码器（UXP 没有 canvas，预览靠它）
│   ├── pinart.mjs           胶片徽章色路与标记（纯字符串，面板与预览稿共用）
│   └── plugin-entry.mjs     打包入口（只做 re-export）
├── plugin/                  UXP 面板
│   ├── manifest.json        manifestVersion 5 / apiVersion 2
│   ├── index.html           面板 UI（深色主题 + 纯 CSS 徽章）
│   ├── main.js              面板逻辑（非破坏写回、预览、进度、取消）
│   ├── build.mjs            esbuild 打包脚本
│   └── dist/core.js         打包产物（IIFE，全局名 SHC，纳入版本控制）
├── probe/                   UXP 吞吐探针（一次性工具，可删）
├── tools/                   测试与工具链
│   ├── run.mjs              ★ 41 项物理指标验收测试
│   ├── verify-bundle.mjs    ★ 进 PS 前预检（10 节）
│   ├── e2e.mjs              离线端到端（真实照片 → 加颗粒 → 对比图）
│   ├── design-tokens.mjs    设计 token 唯一来源
│   ├── build-panel-preview.mjs  面板浏览器预演器（PS 里没控制台，靠它）
│   ├── install-plugin.mjs   安装到 Photoshop
│   ├── fft.mjs / png.mjs / img.mjs   自写的 FFT / PNG 编解码 / 图像处理
│   ├── bench-*.mjs          性能基准（L3 / 卷积 / 胶片标定）
│   └── diag-*.mjs           诊断脚本（频谱 / 色度脏污 / 补偿残差）
├── docs/
│   ├── research-report.html ★ 颗粒形成机理与视觉特征研究报告（含勘误卡）
│   ├── design-spec.html     插件设计文档 v0.1（含勘误）
│   └── DEPENDENCIES.md      依赖清单与版本锁定
├── ui-preview/              UI 设计稿与素材生成器
├── out/                     验收与对比图（可重新生成）
└── HANDOVER.md              ★ 交接文档（进度 / 环境 / 待办 / 上手清单）
```

---

## 当前状态

| 项 | 状态 |
|---|---|
| 版本 | **0.5.4** |
| 验收测试 | **41 / 41 通过** |
| 进 PS 前预检 | **10 节全过** |
| 端到端（真实照片 24 MP） | 通；分段与整图**逐位一致** |
| 已修的三类视觉缺陷 | 彩色脏污（通道模板误读）、暖调红点（幅度参考通道）、高 ISO 溅泥（四条成因） |
| 未完成 | 预设的**实测标定**（缺真实胶片扫描件）、预览降分辨率、WASM 加速、色彩管理边界 |

**详细进度、环境搭建、已知问题与后续指引见 [`HANDOVER.md`](HANDOVER.md)。**

---

## 两份必读的核心文档

1. **[`HANDOVER.md`](HANDOVER.md)** —— 换电脑接手看这份（含新机上手清单）
2. **[`docs/research-report.html`](docs/research-report.html)** —— 为什么这么设计（颗粒的形成机理与视觉特征）
   - 顶部有 **「勘误 · 2026-10-03」** 卡片：三处结论被实现阶段实测推翻并已就地修正，
     引用旧版资料前务必先看它

> **换到新电脑？** 直接看 [`docs/NEW-MACHINE-PROMPT.md`](docs/NEW-MACHINE-PROMPT.md) ——
> 里面有一段可直接粘贴给 agent 的提示词，会自己完成「拉代码 → 装环境 → 验证 → 报结论」。

