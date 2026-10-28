/* ============================================================
 * color.js —— 颜色解析 + 色系映射引擎（核心二：转换）
 *
 * 设计思路：
 *   1. 把页面里出现的颜色按“明度 L”排成两列：
 *        白色系（L 高）  ——> 深色阶梯
 *        黑色系（L 低）  ——> 浅色阶梯
 *   2. 映射函数是单调的：原色越浅，转换后越深；
 *      原色越深，转换后越浅。这样页面的层次关系不会被打乱。
 *   3. 按“用途”分三套色阶：
 *        surface（背景/大面积）  白 -> 深灰
 *        text   （文字/图标）    黑 -> 浅灰
 *        line   （边框/分割线）  浅灰 -> 中灰（保持可见）
 * ============================================================ */
(function () {
  const NS = (window.__DM__ = window.__DM__ || {});
  if (NS.colorReady) return;
  NS.colorReady = true;

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  /* ---------------- 解析 ---------------- */

  const _cv = document.createElement('canvas');
  _cv.width = _cv.height = 1;
  const _ctx = _cv.getContext('2d', { willReadFrequently: true });

  // 用 canvas 归一化任意合法 CSS 颜色（oklch / color() / lab 等）
  function viaCanvas(str) {
    try {
      _ctx.fillStyle = '#010203'; // 哨兵色
      _ctx.fillStyle = str;
      const out = _ctx.fillStyle;
      if (out === '#010203') return null; // 非法
      return String(out);
    } catch (e) {
      return null;
    }
  }

  function parseHex(h) {
    if (h.length === 3 || h.length === 4) {
      const r = parseInt(h[0] + h[0], 16);
      const g = parseInt(h[1] + h[1], 16);
      const b = parseInt(h[2] + h[2], 16);
      const a = h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1;
      if ([r, g, b].some(Number.isNaN)) return null;
      return { r, g, b, a };
    }
    if (h.length === 6 || h.length === 8) {
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      if ([r, g, b].some(Number.isNaN)) return null;
      return { r, g, b, a };
    }
    return null;
  }

  function parse(str) {
    if (str == null) return null;
    str = String(str).trim();
    if (!str) return null;
    const low = str.toLowerCase();
    if (
      low === 'transparent' || low === 'none' || low === 'currentcolor' ||
      low === 'inherit' || low === 'initial' || low === 'revert' || low === 'unset'
    ) return null;

    let m = /^rgba?\(([^)]*)\)$/i.exec(str);
    if (m) {
      const ps = m[1].split(/[\s,\/]+/).filter(Boolean);
      if (ps.length < 3) return null;
      const r = parseFloat(ps[0]);
      const g = parseFloat(ps[1]);
      const b = parseFloat(ps[2]);
      let a = ps.length > 3 ? parseFloat(ps[3]) : 1;
      if (ps.length > 3 && ps[3].indexOf('%') > -1) a /= 100;
      if ([r, g, b].some(Number.isNaN)) return null;
      return { r, g, b, a: Number.isNaN(a) ? 1 : clamp(a, 0, 1) };
    }

    if (str[0] === '#') {
      const c = parseHex(str.slice(1));
      if (c) return c;
      return null;
    }

    const norm = viaCanvas(str);
    if (!norm || norm === str) return null;
    if (norm[0] === '#') return parseHex(norm.slice(1));
    if (/^rgba?\(/i.test(norm)) {
      const m2 = /^rgba?\(([^)]*)\)$/i.exec(norm);
      if (!m2) return null;
      const ps = m2[1].split(/[\s,\/]+/).filter(Boolean);
      const r = parseFloat(ps[0]), g = parseFloat(ps[1]), b = parseFloat(ps[2]);
      let a = ps.length > 3 ? parseFloat(ps[3]) : 1;
      if ([r, g, b].some(Number.isNaN)) return null;
      return { r, g, b, a: Number.isNaN(a) ? 1 : clamp(a, 0, 1) };
    }
    return null;
  }

  /* ---------------- 色彩空间 ---------------- */

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h, s, l };
  }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = clamp(s, 0, 1);
    l = clamp(l, 0, 1);
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return {
      r: Math.round((r + m) * 255),
      g: Math.round((g + m) * 255),
      b: Math.round((b + m) * 255),
    };
  }

  const toHex = (c) =>
    '#' + [c.r, c.g, c.b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');

  function toCss(c, a) {
    if (a == null || a >= 1) return `rgb(${c.r}, ${c.g}, ${c.b})`;
    return `rgba(${c.r}, ${c.g}, ${c.b}, ${+a.toFixed(3)})`;
  }

  /* ---------------- 主题配置 ----------------
   *
   * base      深色主题的“最暗底线”
   * surf      白色系的浮动空间（最高的那个白 → base+surf）
   * textLo/Hi 黑色系文字 → 浅色文字的区间
   * lineLo/Hi 边框线 → 深色线条的区间
   */
  const THEMES = {
    // 只保留一档：纯黑（OLED 友好，白 => 深黑，黑 => 近白）
    black: { base: 0.0, surf: 0.110, textLo: 0.62, textHi: 0.94, lineLo: 0.155, lineHi: 0.300 },
  };
  function themeOf(name) {
    return THEMES[name] || THEMES.black;
  }

  /* ---------------- 核心：保序色阶 ----------------
   *
   * 根据页面上真实的色系排列（range = 该类别颜色的 明度最小/最大值），
   * 把一个颜色的明度线性拉伸到目标区间。保序 + 均匀分布：
   *   · 白色系：原色越白 → 目标越亮（保持“越高越突出”的层次）
   *   · 黑色系：原色越黑 → 目标越亮（主文字最亮）
   *   · 线条：  原色越深（越强调）→ 目标越亮
   * range 无效时退化为连续曲线，保证任何时候都有合理输出。
   */

  function rangeT(l, r, invert) {
    if (!r) return null;
    const span = r.max - r.min;
    if (!(span > 0.015)) return null;
    const t = invert ? (r.max - l) / span : (l - r.min) / span;
    return clamp(t, 0, 1);
  }

  // 背景 / 大面积色块
  function mapSurface(hsl, th, r) {
    const { s, l } = hsl;

    if (s > 0.30) {
      // 有饱和度的背景：区分「淡色底」和「品牌色」
      if (l >= 0.72) {
        const nl = clamp(th.base + (1 - l) * 0.55, th.base, 0.26);
        return { s: Math.min(s, 0.6) * 0.55, l: nl };
      }
      // 品牌色（按钮、强调块）：保留鲜艳，只略微压暗
      return { s: s * 0.95, l: clamp(l * 0.82, th.base, 0.56) };
    }

    if (l >= 0.32) {
      const t = rangeT(l, r, false);
      // 用 0.25 的下限阻尼：最淡的浅色面也不会被拉到纯黑，保留可感知的层次
      const nl = t == null
        ? th.base + ((l - 0.32) / 0.68) * th.surf
        : th.base + (0.25 + 0.75 * t) * th.surf;
      return { s: s <= 0.02 ? 0 : Math.min(s, 0.55) * 0.78, l: clamp(nl, 0, th.base + th.surf) };
    }

    // 本来就是深色的区域（深色导航 / hero）：保留
    return { s: s <= 0.02 ? 0 : s * 0.9, l: Math.max(th.base * 0.6, l * 0.85) };
  }

  // 文字 / 图标：黑色系 -> 浅色系
  //   ctxL = 该元素所处背景的明度：
  //     深色底（< 0.40）上的字属于「深底浅字」，保持原样，不要压暗
  //     浅色底上的字属于「黑/灰字」，按色系排列拉到浅色阶梯
  function mapText(hsl, th, r, ctxL) {
    const { s, l } = hsl;
    let nl, ns;

    if (s > 0.30) {
      // 彩色文字（链接、强调字）：整体提亮，保留色相
      nl = clamp(l * 0.75 + 0.35, 0.52, 0.92);
      ns = s * 0.95;
    } else if (ctxL != null && ctxL < 0.40) {
      // 深色块上的文字：原样保留（白字仍是白字，灰字仍是灰字）
      nl = clamp(l, 0.42, 0.98);
      ns = s <= 0.02 ? 0 : Math.min(1, s * 0.92);
    } else if (l <= 0.85) {
      const t = rangeT(l, r, true);
      nl = t == null
        ? th.textHi - (l / 0.85) * (th.textHi - th.textLo)
        : th.textLo + t * (th.textHi - th.textLo);
      ns = s <= 0.02 ? 0 : Math.min(1, s * 0.9);
    } else {
      // 浅底上的纯白字（罕见）：保持很亮
      nl = clamp(0.96 - (1 - l) * 0.5, 0.9, 0.97);
      ns = s <= 0.02 ? 0 : Math.min(1, s * 0.9);
    }
    return { s: ns, l: clamp(nl, 0, 1) };
  }

  // 边框 / 分割线：浅灰线 -> 中灰线（在深色底上仍然可见）
  function mapLine(hsl, th, r) {
    const { s, l } = hsl;
    let nl, ns;
    if (s > 0.30) {
      nl = clamp(l * 0.5 + 0.18, th.lineLo, 0.5);
      ns = s * 0.85;
    } else if (l >= 0.35) {
      const t = rangeT(l, r, true);
      nl = t == null
        ? th.lineLo + (1 - (l - 0.35) / 0.65) * (th.lineHi - th.lineLo)
        : th.lineLo + t * (th.lineHi - th.lineLo);
      ns = s <= 0.02 ? 0 : Math.min(1, s * 0.8);
    } else {
      nl = th.lineLo + (l / 0.35) * 0.12;
      ns = s <= 0.02 ? 0 : Math.min(1, s * 0.8);
    }
    return { s: ns, l: clamp(nl, 0.08, 0.55) };
  }

  // 阴影：深色阴影 -> 更深；浅色高光 -> 微微发亮
  function mapShadow(hsl) {
    const { s, l } = hsl;
    let nl;
    if (l >= 0.5) nl = 0.16 + (1 - l) * 0.2;
    else nl = Math.max(0, l * 0.5);
    nl = clamp(nl, 0, 0.3);
    const ns = s <= 0.02 ? 0 : Math.min(s, 0.4) * 0.6;
    return { s: ns, l: nl };
  }

  const MAPPERS = { surface: mapSurface, text: mapText, line: mapLine, shadow: mapShadow };

  /**
   * 核心转换
   * @param {{r,g,b,a}} c
   * @param {'surface'|'text'|'line'|'shadow'} kind
   * @param {string} themeName
   * @param {{min:number,max:number}|null} range  同类色系的明度排列区间
   */
  function convert(c, kind, themeName, range, ctxL) {
    const th = themeOf(themeName);
    const hsl = rgbToHsl(c.r, c.g, c.b);
    const fn = MAPPERS[kind] || mapSurface;
    const out = fn(hsl, th, range || null, ctxL);
    const rgb = out.s <= 0.001
      ? hslToRgb(0, 0, out.l)
      : hslToRgb(hsl.h, out.s, out.l);
    return {
      ...rgb, a: c.a, hex: toHex(rgb), css: toCss(rgb, c.a),
      l: out.l, fromL: hsl.l, fromS: hsl.s,
    };
  }

  function convertString(str, kind, themeName, range) {
    const c = parse(str);
    if (!c) return null;
    if (c.a === 0) return null;
    return convert(c, kind, themeName, range);
  }

  /* ---------------- 多颜色字符串（渐变 / 阴影） ---------------- */

  const URL_RE = /(url\((?:[^()]|\([^()]*\))*\))/gi;

  function mapTokenString(str, kind, themeName, range, ctxL) {
    if (!str || str === 'none') return null;
    const parts = String(str).split(URL_RE);
    let changed = false;
    const out = parts.map((part) => {
      if (/^url\(/i.test(part)) return part; // 图片 / data-uri 原样保留
      const replaced = part.replace(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}\b/g, (tok) => {
        const c = parse(tok);
        if (!c) return tok;
        const m = convert(c, kind, themeName, range, ctxL);
        if (!m) return tok;
        changed = true;
        return m.css;
      });
      return replaced;
    });
    return changed ? out.join('') : null;
  }

  NS.color = {
    parse,
    convert,
    convertString,
    mapTokenString,
    rgbToHsl,
    hslToRgb,
    toHex,
    toCss,
    themeOf,
    THEMES,
    clamp,
  };
})();
