/* ============================================================
 * engine.js —— 核心一：识别　核心二：转换
 *
 *   Pass 1（识别）：遍历 DOM（含 open shadow root），读取每个元素的
 *                   计算样式，把颜色按用途归类：surface(背景) / text(文字)
 *                   / line(边框)，并统计每一类的明度排列（range）。
 *   Pass 2（转换）：不写 inline style，而是
 *                     · 给元素打一个 data-dm-* 属性（值 = 颜色编号）
 *                     · 颜色本身只写在一张 CSS 规则表里（每种颜色一条规则）
 *                     · 页面自己的 CSS 变量（--xxx: #fff）也一并覆盖
 *                   好处：几千个元素只写入「属性」，不触发样式重算风暴，
 *                         也不会自己触发 MutationObserver 形成死循环。
 * ============================================================ */
(function () {
  const DM = window.__DM__;
  if (!DM || !DM.color) return;
  if (window.__dmEngineReady) return;
  window.__dmEngineReady = true;

  const { parse, convert, mapTokenString, toHex, hslToRgb, themeOf, clamp } = DM.color;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const STATE_KEY = 'dm_state';
  const DEFAULT_STATE = {
    enabled: false, sites: {}, theme: 'black', version: 1,
    autoSkip: true,   // 页面本身已是深色时自动跳过
    force: {},        // 强制应用的站点白名单
    useVars: true,    // 顺便覆盖页面的 CSS 颜色变量
  };

  const SKIP_TAG = new Set([
    'SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'BASE',
    'IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'PICTURE',
    'SOURCE', 'TRACK', 'BR', 'WBR', 'HEAD', 'PARAM', 'MAP', 'AREA',
  ]);
  const SKIP_DESCEND = new Set([
    'BR', 'WBR', 'IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME', 'SOURCE', 'TRACK',
    'TEMPLATE', 'INPUT', 'TEXTAREA', 'SELECT', 'PROGRESS', 'METER',
  ]);

  const MAX_ELEMENTS = 20000;
  const MAX_RULES = 1500;   // 规则过多时降级为逐元素内联样式

  /* 属性标记 <-> CSS 属性 */
  const PROP_MAP = {
    bg: { attr: 'data-dm-bg', css: 'background-color' },
    fg: { attr: 'data-dm-fg', css: 'color' },
    b1: { attr: 'data-dm-b1', css: 'border-top-color' },
    b2: { attr: 'data-dm-b2', css: 'border-right-color' },
    b3: { attr: 'data-dm-b3', css: 'border-bottom-color' },
    b4: { attr: 'data-dm-b4', css: 'border-left-color' },
    ol: { attr: 'data-dm-ol', css: 'outline-color' },
    dl: { attr: 'data-dm-dl', css: 'text-decoration-color' },
    sh: { attr: 'data-dm-sh', css: 'box-shadow' },
    img: { attr: 'data-dm-im', css: 'background-image' },
    fi: { attr: 'data-dm-fi', css: 'fill' },
    st: { attr: 'data-dm-st', css: 'stroke' },
    tfc: { attr: 'data-dm-tf', css: '-webkit-text-fill-color' },
  };

  const BORDER_PROPS = [
    ['b1', 'border-top-color', 'border-top-width', 'border-top-style'],
    ['b2', 'border-right-color', 'border-right-width', 'border-right-style'],
    ['b3', 'border-bottom-color', 'border-bottom-width', 'border-bottom-style'],
    ['b4', 'border-left-color', 'border-left-width', 'border-left-style'],
  ];

  /* ---------------- 运行时状态 ---------------- */

  let state = { ...DEFAULT_STATE };
  let origin = location.hostname || location.protocol;
  let enabled = false;
  let theme = 'black';

  const recs = new Map();      // Element -> Map(pkey -> {ap, mode, orig, styleVal, stylePri})
  const ctxOf = new WeakMap(); // Element -> 背景上下文明度
  let seen = new WeakSet();    // 已处理过的元素（避免重复计算）

  const ruleMap = new Map();   // "pkey|css" -> 编号
  const rules = [];            // 规则文本
  let sheetDirty = true;
  let useSheet = true;
  let varCss = '';

  let baseSheet = null;
  let observer = null;
  let flushTimer = 0;
  let throttle = 160;          // 自适应节流（页面越吵，间隔越长）
  let statsDirty = false;
  let lastSchedule = 0;
  const pendingRoots = new Set();

  let ranges = { surface: null, text: null, line: null };
  let canvasHex = '#0e0e0e';
  const palette = { surface: new Map(), text: new Map(), line: new Map() };
  const counts = { surface: new Map(), text: new Map(), line: new Map() };

  let tone = { darkArea: 0, lightArea: 0, ratio: 0, isDark: false };

  let stats = {
    elements: 0, truncated: false, ms: 0, theme: 'black',
    white: [], black: [], totalColors: 0, applied: 0, mode: 'rules',
    skipped: false, forced: false, pageTone: null, autoSkip: true,
  };

  /* ---------------- 状态 ---------------- */

  function loadState() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(STATE_KEY, (res) => {
          resolve({ ...DEFAULT_STATE, ...((res && res[STATE_KEY]) || {}) });
        });
      } catch (e) {
        resolve({ ...DEFAULT_STATE });
      }
    });
  }

  function effectiveEnabled() {
    const sites = state.sites || {};
    if (Object.prototype.hasOwnProperty.call(sites, origin)) return !!sites[origin];
    return !!state.enabled;
  }

  function isForced() {
    return !!(state.force && state.force[origin]);
  }

  /* ---------------- 收集元素 ---------------- */

  function gather(root) {
    const out = [];
    if (!root) return out;
    const stack = [root];
    while (stack.length) {
      const el = stack.pop();
      const tag = el.tagName;
      const skip = SKIP_TAG.has(tag);
      if (!skip) out.push(el);
      if (out.length >= MAX_ELEMENTS) { stats.truncated = true; break; }
      if (el.shadowRoot) {
        const sk = el.shadowRoot.children;
        for (let i = sk.length - 1; i >= 0; i--) stack.push(sk[i]);
      }
      if (!SKIP_DESCEND.has(tag)) {
        const k = el.children;
        for (let i = k.length - 1; i >= 0; i--) stack.push(k[i]);
      }
    }
    return out;
  }

  /* ---------------- 读取 ---------------- */

  function readEl(el) {
    let cs;
    try { cs = getComputedStyle(el); } catch (e) { return null; }
    if (!cs) return null;

    const isSvg = el.namespaceURI === SVG_NS;
    const r = {
      el,
      parent: el.parentElement,
      isSvg,
      bg: cs.backgroundColor || '',
      bgImg: cs.backgroundImage || 'none',
      color: cs.color || '',
      tfc: cs.webkitTextFillColor || '',
      borders: [],
      outline: null,
      deco: null,
      shadow: cs.boxShadow || 'none',
      fill: '', stroke: '',
      area: 0,
      bgL: null,
      bgParsed: null,
      ctxL: 0.95,
    };

    for (const [pkey, cProp, wProp, sProp] of BORDER_PROPS) {
      const w = cs.getPropertyValue(wProp);
      const st = cs.getPropertyValue(sProp);
      if (!w || w === '0px' || st === 'none' || st === 'hidden') { r.borders.push(null); continue; }
      r.borders.push({ pkey, css: cs.getPropertyValue(cProp) });
    }

    if (cs.outlineWidth && cs.outlineWidth !== '0px' && cs.outlineStyle && cs.outlineStyle !== 'none') {
      r.outline = { pkey: 'ol', css: cs.outlineColor };
    }
    if (cs.textDecorationLine && cs.textDecorationLine !== 'none' && cs.textDecorationColor !== 'currentcolor') {
      r.deco = { pkey: 'dl', css: cs.textDecorationColor };
    }
    if (isSvg) {
      r.fill = cs.getPropertyValue('fill');
      r.stroke = cs.getPropertyValue('stroke');
    }

    if (cs.display !== 'none') {
      r.area = (el.offsetWidth || 0) * (el.offsetHeight || 0);
    }

    const bgc = parse(r.bg);
    if (bgc && bgc.a >= 0.5) {
      r.bgParsed = bgc;
      r.bgL = DM.color.rgbToHsl(bgc.r, bgc.g, bgc.b).l;
    }
    return r;
  }

  /* ---------------- 色系统计 ---------------- */

  function collect(acc, kind, strOrColor) {
    const c = typeof strOrColor === 'string' ? parse(strOrColor) : strOrColor;
    if (!c || c.a < 0.05) return;
    const { s, l } = DM.color.rgbToHsl(c.r, c.g, c.b);
    if (s > 0.25) return;
    if (kind === 'surface') {
      if (l < 0.60) return;
    } else if (kind === 'text') {
      if (l > 0.85) return;
    } else if (kind === 'line') {
      if (l < 0.45) return;
    }
    acc[kind].push(l);
  }

  function countOf(kind, c) {
    const m = counts[kind];
    const hex = toHex(c);
    m.set(hex, (m.get(hex) || 0) + 1);
  }

  // 5%~95% 分位裁剪，避免个别离群色把整页色阶拉偏
  function makeRanges(acc) {
    const out = {};
    for (const k of ['surface', 'text', 'line']) {
      const arr = acc[k];
      if (!arr.length) { out[k] = null; continue; }
      arr.sort((a, b) => a - b);
      const lo = arr[Math.floor(arr.length * 0.05)];
      const hi = arr[Math.min(arr.length - 1, Math.ceil(arr.length * 0.95) - 1)];
      out[k] = hi - lo > 0.015 ? { min: lo, max: hi } : null;
    }
    return out;
  }

  // 这个颜色在页面上主要当背景、文字还是线条用？
  function dominantKind(hex, c) {
    let best = null;
    let bestN = -1;
    for (const k of ['surface', 'text', 'line']) {
      const n = counts[k].get(hex) || 0;
      if (n > bestN) { bestN = n; best = k; }
    }
    if (bestN > 0) return best;
    const l = c ? DM.color.rgbToHsl(c.r, c.g, c.b).l : 0.5;
    return l >= 0.5 ? 'surface' : 'text';
  }

  /* ---------------- 写入层 ---------------- */

  let applied = 0;
  let dry = false;

  function ruleFor(pkey, css) {
    const key = pkey + '|' + css;
    let idx = ruleMap.get(key);
    if (idx !== undefined) return idx;
    if (rules.length >= MAX_RULES) return -1;
    idx = rules.length;
    const meta = PROP_MAP[pkey];
    rules.push(`[data-dm][${meta.attr}="${idx}"]{${meta.css}:${css} !important}`);
    ruleMap.set(key, idx);
    sheetDirty = true;
    return idx;
  }

  function markProp(el, rec, pkey, css, origComputed) {
    if (!css || dry) return;
    const prev = rec.get(pkey);
    if (prev && prev.ap === css) return;

    const meta = PROP_MAP[pkey];

    if (useSheet) {
      const idx = ruleFor(pkey, css);
      if (idx >= 0) {
        if (!prev) {
          rec.set(pkey, { ap: css, mode: 'a', orig: el.getAttribute(meta.attr) });
        } else {
          prev.ap = css;
        }
        el.setAttribute('data-dm', '1');
        el.setAttribute(meta.attr, String(idx));
        applied++;
        return;
      }
      // 规则数超限：本条降级为内联
    }

    if (!prev) {
      rec.set(pkey, {
        ap: css, mode: 's',
        styleVal: el.style.getPropertyValue(meta.css),
        stylePri: el.style.getPropertyPriority(meta.css),
      });
    } else {
      prev.ap = css;
      prev.mode = 's';
      prev.styleVal = el.style.getPropertyValue(meta.css);
      prev.stylePri = el.style.getPropertyPriority(meta.css);
    }
    el.style.setProperty(meta.css, css, 'important');
    applied++;
  }

  function unmark(el, rec, pkey) {
    const e = rec.get(pkey);
    if (!e) return;
    const meta = PROP_MAP[pkey];
    if (e.mode === 'a') {
      if (e.orig != null) el.setAttribute(meta.attr, e.orig);
      else el.removeAttribute(meta.attr);
      if (!el.hasAttribute('data-dm-bg') && !el.hasAttribute('data-dm-fg') &&
          !el.hasAttribute('data-dm-b1') && !el.hasAttribute('data-dm-b2') &&
          !el.hasAttribute('data-dm-b3') && !el.hasAttribute('data-dm-b4') &&
          !el.hasAttribute('data-dm-ol') && !el.hasAttribute('data-dm-dl') &&
          !el.hasAttribute('data-dm-sh') && !el.hasAttribute('data-dm-im') &&
          !el.hasAttribute('data-dm-fi') && !el.hasAttribute('data-dm-st') &&
          !el.hasAttribute('data-dm-tf')) {
        el.removeAttribute('data-dm');
      }
    } else {
      if (e.styleVal) el.style.setProperty(meta.css, e.styleVal, e.stylePri);
      else el.style.removeProperty(meta.css);
      if (!el.style.cssText) el.removeAttribute('style');
    }
    rec.delete(pkey);
  }

  function origOf(rec, pkey, current) {
    const e = rec.get(pkey);
    if (e && e.ap === current) return e.orig != null ? e.orig : (e.styleVal != null ? e.styleVal : current);
    return current;
  }

  function bump(kind, c, m) {
    const bucket = palette[kind];
    const hex = toHex(c);
    const e = bucket.get(hex);
    if (e) { e.count++; return; }
    bucket.set(hex, { hex, mapped: m.hex, count: 1, fromL: m.fromL, l: m.l, kind });
  }

  function mapProp(r, rec, pkey, current, kind, ctxL) {
    if (!current) return null;
    const orig = origOf(rec, pkey, current);
    const c = parse(orig);
    if (!c || c.a < 0.02) return null;
    const m = convert(c, kind, theme, ranges[kind], ctxL);
    bump(kind, c, m);

    if (m.css === orig) {
      if (rec.has(pkey)) unmark(r.el, rec, pkey);
      return null;
    }
    markProp(r.el, rec, pkey, m.css, orig);
    return m;
  }

  /* ---------------- 单元素 ---------------- */

  function processRecord(r, parentColor) {
    const el = r.el;
    const rec = recs.get(el) || (recs.set(el, new Map()), recs.get(el));
    const ctxL = r.ctxL;

    /* 1. 背景色 */
    const bg = mapProp(r, rec, 'bg', r.bg, 'surface');
    const bgApplied = bg ? bg.css : null;

    /* 2. 背景图（渐变里的色标） */
    if (r.bgImg && r.bgImg !== 'none' && r.bgImg.indexOf('gradient') !== -1) {
      const orig = origOf(rec, 'img', r.bgImg);
      const mapped = mapTokenString(orig, 'surface', theme, ranges.surface);
      if (mapped && mapped !== orig) markProp(el, rec, 'img', mapped, orig);
    }

    /* 3. 文字色（与父元素相同则交给继承） */
    const skipColor = parentColor != null && parentColor === r.color;
    if (!skipColor && r.color) {
      mapProp(r, rec, 'fg', r.color, 'text', ctxL);
      if (r.tfc && r.tfc !== 'currentcolor') {
        const orig = origOf(rec, 'tfc', r.tfc);
        const c = parse(orig);
        if (c && c.a > 0.02) {
          const m = convert(c, 'text', theme, ranges.text, ctxL);
          if (m.css !== orig) markProp(el, rec, 'tfc', m.css, orig);
        }
      }
    }

    /* 4. 四条边框 */
    for (const b of r.borders) {
      if (!b) continue;
      mapProp(r, rec, b.pkey, b.css, 'line');
    }

    /* 5. 外轮廓 */
    if (r.outline) mapProp(r, rec, r.outline.pkey, r.outline.css, 'line');

    /* 6. 文字装饰线 */
    if (r.deco) mapProp(r, rec, r.deco.pkey, r.deco.css, 'text', ctxL);

    /* 7. 阴影 */
    if (r.shadow && r.shadow !== 'none') {
      const orig = origOf(rec, 'sh', r.shadow);
      const mapped = mapTokenString(orig, 'shadow', theme, null);
      if (mapped && mapped !== orig) markProp(el, rec, 'sh', mapped, orig);
    }

    /* 8. SVG fill / stroke */
    if (r.isSvg) {
      for (const [pkey, cur] of [['fi', r.fill], ['st', r.stroke]]) {
        if (!cur || cur === 'none' || cur === 'currentcolor') continue;
        mapProp(r, rec, pkey, cur, 'text', ctxL);
      }
    }

    return bgApplied;
  }

  /* ---------------- 页面 CSS 变量覆盖 ----------------
   *
   * 现代站点大量使用 --bg / --text-primary 这类变量。直接改变量比逐个元素更划算：
   * 一个变量改完，所有引用它的元素（包括以后动态插入的）自动跟随。
   * 变量该走哪套色阶，看这个颜色在页面上主要被当背景 / 文字 / 边框用。
   */

  function walkRules(ruleList, names, depth) {
    if (!ruleList || depth > 4) return;
    for (let i = 0; i < ruleList.length; i++) {
      const r = ruleList[i];
      if (r.cssRules || r.styleSheet) {
        walkRules(r.cssRules || (r.styleSheet && r.styleSheet.cssRules), names, depth + 1);
        continue;
      }
      const t = r.cssText;
      if (!t || t.indexOf('--') === -1) continue;
      const m = t.match(/--[A-Za-z0-9_-]+/g);
      if (m) for (const n of m) names.add(n);
      if (names.size > 800) return;
    }
  }

  function collectVarNames(cs) {
    const names = new Set();
    // 1) computed style 索引枚举
    for (let i = 0; i < cs.length; i++) {
      const n = cs[i];
      if (n && n.charCodeAt(0) === 45 && n.charCodeAt(1) === 45) names.add(n);
    }
    // 2) 样式表文本（跨域表读不到 cssRules，逐张跳过）
    const sheets = document.styleSheets || [];
    for (let i = 0; i < sheets.length; i++) {
      let rs;
      try { rs = sheets[i].cssRules; } catch (e) { continue; }
      if (rs) walkRules(rs, names, 0);
      if (names.size > 800) break;
    }
    return names;
  }

  function buildVarCss() {
    if (!state.useVars) return '';
    let cs;
    try { cs = getComputedStyle(document.documentElement); } catch (e) { return ''; }
    if (!cs) return '';

    const names = collectVarNames(cs);
    const out = [];
    for (const name of names) {
      if (out.length >= 400) break;
      if (name.indexOf('dm-') !== -1) continue; // 自己的属性不碰
      const val = (cs.getPropertyValue(name) || '').trim();
      if (!val || val.length > 40) continue;
      const c = parse(val);
      if (!c || c.a < 0.05) continue;
      const kind = dominantKind(toHex(c), c);
      const m = convert(c, kind, theme, ranges[kind]);
      if (!m || m.css === val) continue;
      out.push(`${name}:${m.css} !important`);
    }
    return out.length ? `:root{${out.join(';')}}` : '';
  }

  /* ---------------- 样式表 ---------------- */

  function baseCss(bgHex, thumb, track) {
    return `:root, html { color-scheme: dark !important; }
html { background-color: ${bgHex} !important; }
::selection { background: rgba(94, 140, 255, 0.35) !important; }
::-webkit-scrollbar { width: 12px !important; height: 12px !important; background: ${track} !important; }
::-webkit-scrollbar-track { background: ${track} !important; }
::-webkit-scrollbar-thumb { background: ${thumb} !important; border-radius: 8px !important; border: 3px solid transparent !important; background-clip: padding-box !important; }
::-webkit-scrollbar-thumb:hover { background: #575757 !important; background-clip: padding-box !important; }
::-webkit-scrollbar-corner { background: ${track} !important; }
input, textarea, select, button, progress, meter { color-scheme: dark !important; }`;
  }

  function ensureBaseSheet(css) {
    try {
      if (!baseSheet) baseSheet = new CSSStyleSheet();
      const list = document.adoptedStyleSheets || [];
      if (!list.includes(baseSheet)) document.adoptedStyleSheets = [...list, baseSheet];
      baseSheet.replaceSync(css);
    } catch (e) {
      let tag = document.getElementById('__dm_base_style');
      if (!tag) {
        tag = document.createElement('style');
        tag.id = '__dm_base_style';
        (document.head || document.documentElement).appendChild(tag);
      }
      tag.textContent = css;
    }
  }

  function removeBaseSheet() {
    if (baseSheet) {
      try {
        document.adoptedStyleSheets = (document.adoptedStyleSheets || []).filter((s) => s !== baseSheet);
      } catch (e) { /* ignore */ }
      baseSheet = null;
    }
    const tag = document.getElementById('__dm_base_style');
    if (tag) tag.remove();
  }

  let thumbHex = '#2f2f2f';
  let trackHex = '#101010';

  function flushSheet(force) {
    if (!sheetDirty && !force) return;
    sheetDirty = false;
    const th = themeOf(theme);
    thumbHex = toHex(hslToRgb(0, 0, clamp(th.base + 0.19, 0, 1)));
    trackHex = theme === 'black' ? '#101010' : toHex(hslToRgb(0, 0, Math.max(th.base + 0.04, 0.10)));
    ensureBaseSheet(baseCss(canvasHex, thumbHex, trackHex) + varCss + rules.join(''));
  }

  /* ---------------- 主流程 ---------------- */

  function resetPalette() {
    palette.surface.clear();
    palette.text.clear();
    palette.line.clear();
    counts.surface.clear();
    counts.text.clear();
    counts.line.clear();
  }

  function toneOf(darkArea, lightArea) {
    const total = darkArea + lightArea;
    const ratio = total > 0 ? darkArea / total : 0;
    return { darkArea, lightArea, ratio, isDark: total > 0 && ratio >= 0.6 };
  }

  function restoreAll() {
    for (const [el, rec] of recs) {
      for (const pkey of [...rec.keys()]) unmark(el, rec, pkey);
      if (!el.style.cssText) el.removeAttribute('style');
    }
    recs.clear();
    ruleMap.clear();
    rules.length = 0;
    varCss = '';
    sheetDirty = true;
  }

  function runFull(apply = true) {
    if (apply && !enabled) return;
    const t0 = performance.now();
    if (apply) {
      restoreAll();
      removeBaseSheet();
    }
    resetPalette();
    seen = new WeakSet();
    applied = 0;
    stats.elements = 0;
    stats.truncated = false;

    const root = document.documentElement;
    if (!root) return;

    const els = gather(root);
    stats.elements = els.length;

    /* --- Pass 1：识别 --- */
    const records = [];
    const byEl = new Map();
    const acc = { surface: [], text: [], line: [] };
    const toneAcc = { dark: 0, light: 0 };

    for (const el of els) {
      const r = readEl(el);
      if (!r) continue;
      records.push(r);
      byEl.set(el, r);

      if (r.bgL != null) r.ctxL = r.bgL;
      else if (r.parent && byEl.has(r.parent)) r.ctxL = byEl.get(r.parent).ctxL;
      else r.ctxL = 0.95;
      ctxOf.set(el, r.ctxL);
      seen.add(el);

      const bgc = r.bgParsed;
      if (bgc) { collect(acc, 'surface', bgc); countOf('surface', bgc); }
      const fg = parse(r.color);
      if (fg && fg.a >= 0.05) { collect(acc, 'text', fg); countOf('text', fg); }
      for (const b of r.borders) {
        if (!b) continue;
        const bc = parse(b.css);
        if (bc && bc.a >= 0.05) { collect(acc, 'line', bc); countOf('line', bc); }
      }

      /* 页面基调：面积加权 */
      if (r.area > 0 && r.bgL != null) {
        if (r.bgL >= 0.60) toneAcc.light += r.area;
        else if (r.bgL <= 0.35) toneAcc.dark += r.area;
      }
    }

    ranges = makeRanges(acc);
    tone = toneOf(toneAcc.dark, toneAcc.light);

    // 颜色种类太多时，逐元素内联反而更省规则
    useSheet = (counts.surface.size + counts.text.size + counts.line.size) <= MAX_RULES;
    stats.mode = useSheet ? 'rules' : 'inline';

    /* 页面本身已是深色 -> 自动跳过（除非本站被强制） */
    const forced = isForced();
    const skip = !!state.autoSkip && tone.isDark && !forced;
    const allowApply = apply && !skip;

    if (allowApply) varCss = buildVarCss();
    else varCss = '';

    /* --- Pass 2：转换 --- */
    dry = !allowApply;
    let bodyBg = null;
    for (const r of records) {
      let pcolor = null;
      if (r.parent) {
        const pr = byEl.get(r.parent);
        if (pr) pcolor = pr.color;
      }
      let b = null;
      try { b = processRecord(r, pcolor); } catch (e) { /* 单元素失败不影响整体 */ }
      if (b && !bodyBg && r.el === document.body) bodyBg = b;
    }
    dry = false;

    if (allowApply) {
      const bgc = bodyBg ? parse(bodyBg) : null;
      const canvas = bgc
        ? convert(bgc, 'surface', theme, ranges.surface)
        : convert({ r: 255, g: 255, b: 255, a: 1 }, 'surface', theme, ranges.surface);
      canvasHex = canvas.hex;
      flushSheet(true);
    }

    stats.ms = Math.round(performance.now() - t0);
    stats.theme = theme;
    stats.applied = applied;
    stats.skipped = apply && skip;
    stats.forced = forced;
    stats.autoSkip = !!state.autoSkip;
    stats.pageTone = tone;
    buildStats();
  }

  function runSubtree(root) {
    if (!enabled || !root || !root.isConnected) return;
    const els = gather(root);
    for (const el of els) {
      if (seen.has(el)) continue;
      try {
        const r = readEl(el);
        if (!r) continue;
        seen.add(el);

        let pcolor = null;
        let ctxL = 0.95;
        if (r.parent) {
          const pr = r.parent;
          if (ctxOf.has(pr)) ctxL = ctxOf.get(pr);
          if (recs.has(pr)) pcolor = getComputedStyle(pr).color;
        }
        r.ctxL = r.bgL != null ? r.bgL : ctxL;
        ctxOf.set(el, r.ctxL);

        // 新内容里出现的颜色也补进色系统计
        const bgc = r.bgParsed;
        if (bgc) countOf('surface', bgc);
        const fg = parse(r.color);
        if (fg && fg.a >= 0.05) countOf('text', fg);

        processRecord(r, pcolor);
      } catch (e) { /* ignore */ }
    }
    flushSheet(false);
    statsDirty = true;
  }

  function buildStats() {
    const take = (bucket, pred, role) => {
      const arr = [];
      for (const v of bucket.values()) if (pred(v)) arr.push({ ...v, role });
      return arr;
    };
    const white = [
      ...take(palette.surface, (v) => v.fromL >= 0.32, '背景'),
      ...take(palette.line, (v) => v.fromL >= 0.5, '线条'),
    ].sort((a, b) => b.count - a.count).slice(0, 14);

    const black = [
      ...take(palette.text, (v) => v.fromL < 0.85, '文字'),
      ...take(palette.line, (v) => v.fromL < 0.5, '线条'),
    ].sort((a, b) => b.count - a.count).slice(0, 14);

    let total = 0;
    for (const k of Object.keys(palette)) total += palette[k].size;

    stats.white = white;
    stats.black = black;
    stats.totalColors = total;
    statsDirty = false;
  }

  function disableAll() {
    restoreAll();
    removeBaseSheet();
    if (observer) { observer.disconnect(); observer = null; }
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = 0; }
    pendingRoots.clear();
    resetPalette();
    seen = new WeakSet();
    applied = 0;
    stats.elements = 0;
    stats.skipped = false;
    stats.forced = false;
    stats.pageTone = null;
    stats.white = [];
    stats.black = [];
    stats.totalColors = 0;
    stats.applied = 0;
  }

  /* ---------------- 动态内容 ---------------- */

  function schedule(root) {
    if (root) pendingRoots.add(root);
    if (flushTimer) return;

    const now = performance.now();
    // 页面变化越频繁，节流间隔越长（最多 1.2s），空闲 3s 后复位
    if (now - lastSchedule > 3000) throttle = 160;
    else throttle = Math.min(1200, throttle * 1.25);
    lastSchedule = now;

    flushTimer = setTimeout(() => {
      flushTimer = 0;
      if (!enabled) return;
      if (pendingRoots.size === 0) return;
      const roots = [...pendingRoots];
      pendingRoots.clear();

      let big = false;
      for (const r of roots) {
        if (!r.isConnected) continue;
        if (r === document.documentElement || r === document.body) { big = true; break; }
      }
      if (big) { runFull(true); return; }
      for (const r of roots) if (r.isConnected) runSubtree(r);
    }, throttle);
  }

  function startObserver() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver((muts) => {
      if (!enabled) return;
      for (const m of muts) {
        // 只关心节点增删：属性变化不再监听，避免自己写属性 / 页面动画互相触发
        if (m.type !== 'childList') continue;
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && !seen.has(n)) schedule(n);
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  /* ---------------- 对外接口 ---------------- */

  function payload() {
    if (statsDirty) buildStats();
    return {
      ok: true,
      origin,
      enabled,
      theme,
      stats,
      themes: Object.keys(DM.color.THEMES),
      ranges,
      autoSkip: !!state.autoSkip,
      useVars: state.useVars !== false,
      forced: isForced(),
      pageTone: tone,
    };
  }

  function sync() {
    enabled = effectiveEnabled();
    theme = DM.color.THEMES[state.theme] ? state.theme : 'black';
    if (enabled) {
      runFull(true);
      if (stats.skipped) {
        if (observer) { observer.disconnect(); observer = null; }
      } else {
        startObserver();
      }
    } else {
      disableAll();
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'dm:hello') {
      if (!enabled && !stats.elements) {
        try { runFull(false); } catch (e) { /* ignore */ }
      }
      sendResponse(payload());
      return true;
    }
    if (msg.type === 'dm:rescan') {
      try { runFull(!!enabled); } catch (e) { /* ignore */ }
      sendResponse(payload());
      return true;
    }
    return true;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STATE_KEY]) return;
    state = { ...DEFAULT_STATE, ...(changes[STATE_KEY].newValue || {}) };
    sync();
  });

  function boot() {
    loadState().then((s) => {
      state = s;
      origin = location.hostname || location.protocol;
      sync();
    });
  }

  boot();
})();
