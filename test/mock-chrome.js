/* mock-chrome.js —— 让 content script 能在普通网页里跑（不装扩展也能验证） */
(function () {
  if (window.chrome && window.chrome.runtime && window.chrome.runtime.id) return; // 真扩展环境

  const KEY = 'dm_demo_state';
  const DEFAULTS = { enabled: false, sites: {}, force: {}, theme: 'black', version: 1, autoSkip: true };
  const listeners = [];
  const msgListeners = [];

  const read = () => {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return { ...DEFAULTS };
      return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch (e) {
      return { ...DEFAULTS };
    }
  };

  const write = (obj) => {
    const old = read();
    localStorage.setItem(KEY, JSON.stringify(obj));
    const changes = { dm_state: { oldValue: old, newValue: obj } };
    listeners.forEach((fn) => {
      try { fn(changes, 'local'); } catch (e) { console.error(e); }
    });
  };

  window.__dmDemo = {
    read,
    update(patch) {
      const s = { ...read(), ...patch };
      write(s);
      return s;
    },
    ask(msg) {
      let out = null;
      msgListeners.forEach((fn) => {
        try { fn(msg, {}, (r) => { out = r; }); } catch (e) { console.error(e); }
      });
      return out;
    },
    onMessage(fn) { msgListeners.push(fn); },
  };

  window.chrome = {
    runtime: {
      id: 'demo',
      lastError: null,
      sendMessage(msg, cb) { if (cb) cb({ ok: true }); },
      onMessage: { addListener(fn) { msgListeners.push(fn); } },
    },
    storage: {
      local: {
        get(key, cb) {
          if (typeof key === 'function') { key({ dm_state: read() }); return; }
          const s = read();
          cb && cb({ dm_state: s });
        },
        set(obj, cb) {
          write({ ...read(), ...obj.dm_state });
          cb && cb();
        },
      },
      onChanged: { addListener(fn) { listeners.push(fn); } },
    },
  };
})();
