/* 由 src/popup.html 生成 test/popup.html（注入 mock chrome API，方便在浏览器里预览 UI） */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(root, 'src', 'popup.html'), 'utf8');

// 加 ?v=时间戳，避免浏览器缓存 file:// 下的脚本/样式
const v = Date.now();

html = html
  .replace('href="popup.css"', `href="../src/popup.css?v=${v}"`)
  .replace(
    '<script src="popup.js"></script>',
    [
      `<script src="mock-popup-chrome.js?v=${v}"></script>`,
      `  <script src="../src/popup.js?v=${v}"></script>`,
    ].join('\n')
  );

fs.writeFileSync(path.join(root, 'test', 'popup.html'), html);
console.log('test/popup.html generated');
