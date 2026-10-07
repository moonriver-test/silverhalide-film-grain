/**
 * 设计 token —— 面板与预览稿的唯一来源
 * ==================================================================
 * 【为什么要有这个文件】
 * v0.5 之前，设计稿（ui-preview/template-dark.html）与实现（plugin/index.html）
 * 各写一份数值。结果实现端凭印象把圆角统一改小 2px、字号整体收了一档，
 * 与设计稿逐条漂移，而且没人发现 —— 直到逐维度对比才暴露。
 *
 * 现在：色板 / 圆角 / 关键字号 都在这里定义。
 *   · plugin/index.html 内联同一份数值，tools/verify-bundle.mjs 断言逐条相等
 *   · ui-preview/build-dark.mjs 从这里生成预览稿的 :root
 * 不一致时预检直接报错，不会再静默漂移。
 *
 * 【为什么不直接在构建时生成 index.html】
 * UXP 从 plugin/ 目录直接加载 index.html，若把它变成构建产物，
 * 就会出现「改了源模板但忘了构建」这一类问题。所以选择「内联 + 断言」：
 * 值仍是手写的，但写错立刻会被挡住。
 *
 * 【命名】
 * 面板用 --ac（accent）/ --mut（muted）这类短名，因为要出现在很多规则里；
 * 这里保持与 CSS 变量同名，便于逐条对照。
 */

/** 深色主题（面板 + 预览稿共用） */
export const COLOR_DARK = {
  '--bg': '#232323',      // 面板底
  '--card': '#2c2c2c',    // 卡片（凸起）
  '--cardh': '#333333',   // 卡片悬停（设计稿没有，实现新增）
  '--well': '#191919',    // 承台（内凹）
  '--line': '#383838',    // 分割线
  '--line2': '#4a4a4a',   // 更亮的分割线（幽灵按钮描边）
  '--rail': '#3d3d3d',    // 滑块轨道
  '--ink': '#eeeeee',     // 正文
  '--mut': '#9e9e9e',     // 次要
  '--faint': '#6e6e6e',   // 极淡
  '--ac': '#c1382a',      // 强调（深红，全稿唯一）
  '--acd': '#96291f',     // 强调按下
  '--acl': '#e0705f',     // 强调的亮色变体（用于暗底小字）
  '--view': '#141414',    // 预览框底
};

/** 浅色主题（面板专有；设计稿只做了深色） */
export const COLOR_LIGHT = {
  '--bg': '#f0efec',
  '--card': '#e2e0db',
  '--cardh': '#d8d5ce',
  '--well': '#d7d5cf',
  '--line': '#c9c6bf',
  '--line2': '#b3afa6',
  '--rail': '#cfccc4',
  '--ink': '#1b1a17',
  '--mut': '#6d6a63',
  '--faint': '#94918a',
  '--ac': '#b03425',
  '--acd': '#8d2419',
  '--acl': '#8d2419',
  '--view': '#1c1c1e',
};

/** 仅预览页用（面板里由 PS 提供背景，不需要） */
export const COLOR_PAGE = { '--page': '#0f141b' };

/**
 * 圆角阶梯。设计稿的 token 表写的是「面板 26 / 卡片 18 / 承台 14 / 胶囊 999」。
 *   面板 26 在真机上由 Photoshop 提供，插件里不需要；
 *   胶囊 999 在 UXP 上会把按钮渲染成正圆，所以一律改成「高度的一半」，见组件样式。
 */
export const RADIUS = {
  '--r-card': '18px',
  '--r-stage': '14px',
  '--r-mini': '10px',
};

/**
 * 关键字号阶梯。这几档是设计稿里最显眼的层级，
 * 之前实现端凭「面板窄要紧凑」的直觉各收了 1~4px，导致整体小一号。
 */
export const TYPE = {
  '--fs-brand': '25px',   // 银盐
  '--fs-name': '20px',    // 胶片名
  '--fs-hero': '46px',    // 感光度大字
  '--fs-amt': '19px',     // 颗粒量数值
};

/** 面板的完整 token 集（深色 / 浅色） */
export const panelTokens = (mode) => Object.assign(
  {},
  mode === 'light' ? COLOR_LIGHT : COLOR_DARK,
  RADIUS,
  TYPE
);

/** 渲染成 CSS 的 :root 块 */
export function renderRoot(mode, indent = '    ') {
  const t = panelTokens(mode);
  const keys = Object.keys(t);
  const lines = [];
  for (let i = 0; i < keys.length; i += 4) {
    lines.push(indent + keys.slice(i, i + 4).map((k) => `${k}:${t[k]};`).join(' '));
  }
  return lines.join('\n');
}

/**
 * 从一段 CSS 文本里抽出**每一个** :root 块的变量表，按出现顺序返回。
 * 用于预检断言「实现里写的值 == 这里的值」。
 * 注意必须分开返回：浅色的 :root 在 @media 里，会覆盖同名的深色变量，
 * 合并成一张表就分不清哪条该对谁了。
 */
export function parseRootBlocks(css) {
  const blocks = [];
  // 先剥掉块注释再切分 —— 否则「注释 + 变量」落在同一个分号段里，
  // 变量名会带上注释前缀而不以 -- 开头，被当成非法声明静默跳过
  // （实测 --bg / --r-card / --fs-brand 因此「缺失」，其实是解析器的问题）。
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /:root\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    const vars = {};
    for (const decl of m[1].split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const k = decl.slice(0, i).trim();
      const v = decl.slice(i + 1).trim();
      if (k.startsWith('--')) vars[k] = v;
    }
    blocks.push(vars);
  }
  return blocks;
}

/** 逐条比对，返回不一致项 */
export function diffTokens(actual, expected) {
  const bad = [];
  for (const k of Object.keys(expected)) {
    const a = actual[k];
    const e = expected[k];
    if (a === undefined) bad.push(`${k} 缺失（应为 ${e}）`);
    else if (String(a).toLowerCase() !== String(e).toLowerCase()) bad.push(`${k} 写了 ${a}，应为 ${e}`);
  }
  return bad;
}
