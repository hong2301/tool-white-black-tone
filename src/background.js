/* background.js —— service worker：只负责首次安装时写入默认设置 */
const STATE_KEY = 'dm_state';
const DEFAULT_STATE = {
  enabled: false, sites: {}, force: {}, theme: 'black', version: 1,
  autoSkip: true, useVars: true,
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(STATE_KEY, (res) => {
    if (!res || !res[STATE_KEY]) {
      chrome.storage.local.set({ [STATE_KEY]: DEFAULT_STATE });
    }
  });
});
