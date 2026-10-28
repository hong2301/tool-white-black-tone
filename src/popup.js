/* popup.js —— 一个开关，没有别的 */
const STATE_KEY = 'dm_state';
const DEFAULTS = {
  enabled: false, sites: {}, force: {}, theme: 'black', version: 1,
  autoSkip: true, useVars: true,
};

const $ = (id) => document.getElementById(id);

let tabId = null;
let host = null;
let enabled = false;
let supported = true;

const loadState = () =>
  new Promise((resolve) => {
    chrome.storage.local.get(STATE_KEY, (res) => {
      const s = (res && res[STATE_KEY]) || {};
      resolve({
        ...DEFAULTS, ...s,
        sites: { ...(s.sites || {}) },
        force: { ...(s.force || {}) },
      });
    });
  });

const saveState = (s) =>
  new Promise((resolve) => chrome.storage.local.set({ [STATE_KEY]: s }, () => resolve()));

const activeTab = () =>
  new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs && tabs[0] ? tabs[0] : null));
  });

const say = (id, msg) =>
  new Promise((resolve) => {
    if (id == null) return resolve(null);
    chrome.tabs.sendMessage(id, msg, (reply) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(reply || null);
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 不可用原因 ---------------- */

function classify(url) {
  if (!url) return 'unknown';
  if (/^(chrome|edge|brave|opera|vivaldi|about|devtools|view-source|chrome-extension|moz-extension|data):/i.test(url)) return 'builtin';
  if (/chrome\.google\.com\/webstore|chromewebstore\.google\.com/i.test(url)) return 'store';
  if (/^file:/i.test(url)) return 'file';
  if (/^https?:/i.test(url)) return 'web';
  return 'unknown';
}

const NA_TEXT = {
  builtin: '浏览器内置页面，扩展无法介入',
  store: '应用商店禁止扩展运行',
  file: '本地文件需先开启「允许访问文件网址」',
  web: '标签页早于插件打开，刷新即可',
  unknown: '当前页面无法注入，刷新试试',
};

/* ---------------- 渲染 ---------------- */

function setNote(text, kind, btnText, btnAction) {
  const note = $('note');
  if (!text) { note.classList.add('hidden'); return; }
  note.classList.remove('hidden');
  note.classList.toggle('err', kind === 'err');
  $('noteText').textContent = text;

  const btn = $('noteBtn');
  if (btnText) {
    btn.textContent = btnText;
    btn.classList.remove('hidden');
    btn.onclick = btnAction;
  } else {
    btn.classList.add('hidden');
    btn.onclick = null;
  }
}

function render(skipped, forced) {
  const sw = $('toggle');

  if (!supported) {
    sw.disabled = true;
    sw.setAttribute('aria-checked', 'false');
    sw.title = '当前页面不可用';
    return;
  }

  sw.disabled = false;
  sw.setAttribute('aria-checked', enabled ? 'true' : 'false');
  sw.title = enabled ? '已转深色（点击还原）' : '浅色（点击转深色）';

  if (skipped) {
    setNote('页面本身是深色，已跳过', 'warn', '仍然应用', onForce);
  } else if (forced) {
    setNote('已强制应用', 'warn', '取消强制', onUnforce);
  } else {
    setNote('');
  }
}

/* ---------------- 数据 ---------------- */

async function refresh() {
  const reply = await say(tabId, { type: 'dm:hello' });

  if (!reply || !reply.ok) {
    supported = false;
    host = null;
    const tab = await activeTab();
    const kind = classify(tab && tab.url);
    setNote(NA_TEXT[kind], 'err',
      kind === 'web' || kind === 'unknown' ? '注入' : null,
      onInject);
    render();
    return;
  }

  supported = true;
  host = reply.origin;
  enabled = !!reply.enabled;
  render(!!(reply.stats && reply.stats.skipped), !!reply.forced);
}

async function refreshQuick() {
  await sleep(130);
  const reply = await say(tabId, { type: 'dm:hello' });
  if (!reply || !reply.ok) return;
  enabled = !!reply.enabled;
  render(!!(reply.stats && reply.stats.skipped), !!reply.forced);
}

/* ---------------- 操作 ---------------- */

async function onToggle() {
  if (!supported || !host) return;
  const next = !enabled;
  const s = await loadState();
  s.sites[host] = next;
  s.enabled = next;            // 新站点沿用最后一次选择
  await saveState(s);
  enabled = next;
  $('toggle').setAttribute('aria-checked', next ? 'true' : 'false');
  await refreshQuick();
}

async function onForce() {
  if (!host) return;
  const s = await loadState();
  s.force[host] = true;
  if (s.sites[host] === undefined) s.sites[host] = true;
  await saveState(s);
  await refreshQuick();
}

async function onUnforce() {
  if (!host) return;
  const s = await loadState();
  delete s.force[host];
  await saveState(s);
  await refreshQuick();
}

async function onInject() {
  const btn = $('noteBtn');
  btn.textContent = '注入中…';
  btn.disabled = true;
  try {
    await new Promise((resolve, reject) => {
      chrome.scripting.executeScript(
        { target: { tabId }, files: ['src/color.js', 'src/engine.js'] },
        (res) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(res);
        }
      );
    });
    await sleep(260);
    await refresh();
  } catch (e) {
    btn.textContent = '失败';
    $('noteText').textContent = '浏览器拒绝注入：' + (e && e.message ? e.message : '未知原因');
  }
}

/* ---------------- 启动 ---------------- */

(async function init() {
  const tab = await activeTab();
  tabId = tab ? tab.id : null;

  $('toggle').addEventListener('click', onToggle);

  if (tabId == null) {
    supported = false;
    setNote('无活动标签页', 'err');
    render();
    return;
  }
  await refresh();
})();
