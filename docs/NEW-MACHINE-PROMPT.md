# 新电脑 · 开工提示词（直接复制粘贴）

> 用途：在新电脑上打开 WorkBuddy，把下面**方框里的整段**粘进对话，
> 让接手的 agent 自己完成「拉代码 → 装环境 → 验证 → 给出下一步」。
>
> 仓库地址已填好：`https://github.com/moonriver-test/silverhalide-film-grain`（public）。
> 若仓库改过名或换了 owner，把下文里的 URL 一起替换。

---

## 提示词（复制这一段）

```text
我要接手一个已经在别的电脑上开发了一段时间的项目，请帮我把它在本机恢复成可继续开发的状态。

项目：银盐（Silver Halide）—— 基于胶片物理模型的 Photoshop UXP 胶片颗粒插件。
仓库：https://github.com/moonriver-test/silverhalide-film-grain

请按下面的顺序做，每步都告诉我实际输出，不要跳过验证：

1. 在 D 盘（不要写 C 盘）挑一个工作目录克隆仓库。
   如果这台机器没有 D 盘，先问我。

2. 读完仓库根目录的 README.md 与 HANDOVER.md（后者是交接文档，
   包含进度、环境、待办、已知问题、新机上手清单），然后用 5 句话向我复述：
   - 这个项目在做什么
   - 当前完成到哪一步
   - 最重要的一个未完成项是什么
   - 有哪些「千万不能改回去」的地方
   - 你会建议我第一步做什么

3. 按 HANDOVER.md 的「§4 环境搭建」装依赖并跑验证，逐条报告实际结果：
   - npm install --no-audit --no-fund
   - npm test          → 期望「通过 41　警告 0　失败 0」
   - npm run build     → 生成 plugin/dist/core.js
   - npm run verify    → 期望预检 10 节全过
   如果任何一步失败，先诊断根因再动手改，改之前告诉我你打算改什么。

4. 环境就绪后，检查并修复 HANDOVER.md「§4.4 换机器要改的地方」里列出的硬编码路径
   （jpeg-js 的绝对路径、测试照片路径、esbuild 的绝对路径），
   改成可移植的写法（require('包名') 或环境变量），然后重跑第 3 步的所有验证确认没回归。

5. 告诉我这台机器上有没有安装 Photoshop（找一下 Adobe Photoshop 的 Plug-ins 目录）。
   如果装了，用 npm run install-plugin 把插件装上，并告诉我需要我做什么来验收。

6. 最后，从 HANDOVER.md 的「§3 待办事项」里挑 2–3 件适合现在做的事，
   按「收益 / 成本」排序给我选，并说明为什么。

注意：
- 这个项目的验收测试（tools/run.mjs 的 41 项）是唯一的质量门，任何核心改动后必须重跑。
- 面板改动要跑 tools/verify-bundle.mjs（进 PS 前的预检）和
  tools/build-panel-preview.mjs（浏览器预演，因为 PS 里没有控制台）。
- 核心算法（core/）零依赖，如果你发现它引入了 npm 包，那一定是改错了。
- 不要跳过验证就说「完成了」—— 把真实输出贴给我。
```

---

## 最短版本（如果你只想先看到东西跑起来）

```text
克隆 https://github.com/moonriver-test/silverhalide-film-grain 到 D 盘，读 HANDOVER.md，然后按它的「§5 新机上手清单」一步步执行，
每步把真实输出发我。有失败先诊断根因，别急着改代码。
```

---

## 首次验收时可以问 agent 的三个问题

1. **「跑一遍 tools/run.mjs，把测试 14（彩色平块逐通道幅度）、测试 15（高 ISO 暗部钳位）
   的原始输出贴给我。」**
   —— 这两项是历史缺陷的回归测试，它们过了说明「彩色脏污 / 暖调红点 / 高 ISO 溅泥」
   这三类问题没有复发。

2. **「把 HANDOVER.md 里的『千万别做的事』列出来。」**
   —— 接手的人必须知道哪些改动会让已修好的问题复发。

3. **「当前离『像真胶片』还差什么？」**
   —— 正确答案是：缺真实胶片扫描件的实测标定（`HANDOVER.md` §3 的 P0-1）。
   如果 agent 答不出这一点，说明它没读交接文档。
