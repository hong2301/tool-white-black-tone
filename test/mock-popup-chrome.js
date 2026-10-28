/* popup 预览用的 chrome API 模拟，仅 test 目录使用 */
(function () {
  const KEY = 'dm_state';
  const DEFAULTS = {
    enabled: true, sites: { 'example.com': true }, force: {}, theme: 'black',
    version: 1, autoSkip: true,
  };
  const read = () => {
    try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) || 'null') || {}) }; }
    catch (e) { return { ...DEFAULTS }; }
  };
  const write = (v) => localStorage.setItem(KEY, JSON.stringify(v));

  const Q = new URLSearchParams(location.search);
  const DARK = Q.get('mode') === 'dark';
  const NA = ['na', 'builtin', 'store', 'file'].includes(Q.get('mode'));

  const REPLY = {
    ok: true,
    origin: 'news.example.com',
    enabled: true,
    theme: 'black',
    autoSkip: true,
    forced: false,
    stats: {
      elements: 2437, truncated: false, ms: 38, theme: 'black',
      totalColors: 23, applied: 1841, skipped: false, forced: false, autoSkip: true,
      pageTone: { darkArea: 182340, lightArea: 1861020, ratio: 0.0892, isDark: false },
      white: [
        { hex: '#ffffff', mapped: '#1c1c1c', count: 486, role: '背景', kind: 'surface', fromL: 1 },
        { hex: '#f7f8fa', mapped: '#1a1a1c', count: 213, role: '背景', kind: 'surface', fromL: 0.97 },
        { hex: '#eef1f6', mapped: '#111214', count: 98, role: '背景', kind: 'surface', fromL: 0.945 },
        { hex: '#e4e7ec', mapped: '#23272e', count: 312, role: '线条', kind: 'line', fromL: 0.906 },
        { hex: '#f4f4f5', mapped: '#18181a', count: 74, role: '背景', kind: 'surface', fromL: 0.956 },
        { hex: '#d7dbe3', mapped: '#424957', count: 58, role: '线条', kind: 'line', fromL: 0.867 },
      ],
      black: [
        { hex: '#111111', mapped: '#f0f0f0', count: 640, role: '文字', kind: 'text', fromL: 0.067 },
        { hex: '#6b7280', mapped: '#9e9e9e', count: 205, role: '文字', kind: 'text', fromL: 0.46 },
        { hex: '#374151', mapped: '#c8c8c8', count: 121, role: '文字', kind: 'text', fromL: 0.267 },
        { hex: '#9ca3af', mapped: '#767676', count: 88, role: '文字', kind: 'text', fromL: 0.649 },
        { hex: '#2e3038', mapped: '#3c3e46', count: 44, role: '线条', kind: 'line', fromL: 0.2 },
        { hex: '#0f172a', mapped: '#e2e4e8', count: 31, role: '文字', kind: 'text', fromL: 0.11 },
      ],
    },
  };

  if (DARK) {
    REPLY.stats.skipped = true;
    REPLY.stats.forced = false;
    REPLY.stats.pageTone = { darkArea: 1720330, lightArea: 24000, ratio: 0.986, isDark: true };
    REPLY.stats.applied = 0;
  }

  const ABI = {
    runtime: { lastError: null },
    scripting: {
      executeScript(opts, cb) { cb && cb([{ result: null }]); },
    },
  };

  window.chrome = {
    runtime: { lastError: null, sendMessage() {} },
    storage: {
      local: {
        get(key, cb) { cb && cb({ [key]: read() }); },
        set(obj, cb) { write({ ...read(), ...obj[KEY] }); cb && cb(); },
      },
    },
    scripting: {
      executeScript(_opts, cb) { if (cb) setTimeout(() => cb([{ result: null }]), 50); },
    },
    tabs: {
      query(_q, cb) {
        const M = Q.get('mode');
        const url =
          M === 'na' ? 'https://news.example.com/a/b' :
          M === 'builtin' ? 'chrome://extensions/' :
          M === 'store' ? 'https://chromewebstore.google.com/detail/xyz' :
          M === 'file' ? 'file:///D:/Desktop/x.html' :
          'https://news.example.com/a/b';
        cb([{ id: 1, url }]);
      },
      sendMessage(_id, _msg, cb) {
        if (NA) {
          window.chrome.runtime.lastError = { message: 'no receiver' };
          cb && cb(undefined);
          window.chrome.runtime.lastError = null;
          return;
        }
        const s = read();
        const origin = REPLY.origin;
        const on = s.sites && origin in s.sites ? !!s.sites[origin] : !!s.enabled;
        const forced = !!(s.force && s.force[origin]);
        cb && setTimeout(() => cb({
          ...REPLY,
          enabled: on,
          forced,
          autoSkip: s.autoSkip !== false,
          useVars: s.useVars !== false,
          stats: { ...REPLY.stats, skipped: DARK && !forced },
        }), 40);
      },
    },
  };
})();
