/* 生成/核对固定 key —— 让扩展 ID 与目录路径无关
 *
 *   node scripts/gen-key.js         已有 key 时只核对并打印 ID
 * 用法：
 *   node scripts/gen-key.js --force 重新生成（会让 ID 变化，站点记忆会丢）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const p = path.join(__dirname, '..', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(p, 'utf8'));
const force = process.argv.includes('--force');

// 扩展 ID = SHA256(公钥 DER) 前 16 字节，每个 nibble 映射到 a-p
function idOf(keyB64) {
  const der = Buffer.from(keyB64, 'base64');
  const hash = crypto.createHash('sha256').update(der).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (hash[i] >> 4));
    id += String.fromCharCode(97 + (hash[i] & 0xf));
  }
  return id;
}

if (manifest.key && !force) {
  console.log('manifest.json 已有固定 key');
  console.log('扩展 ID =', idOf(manifest.key));
  console.log('（在 chrome://extensions 里核对，一致就说明 key 生效，移动目录也不会变）');
  process.exit(0);
}

const { publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'der' },
});

manifest.key = publicKey.toString('base64').replace(/\s+/g, '');
fs.writeFileSync(p, JSON.stringify(manifest, null, 2) + '\n');

console.log('已写入 manifest.key');
console.log('扩展 ID =', idOf(manifest.key));
if (force) console.log('注意：ID 变了，之前记录的站点开关会丢，需要重新设置一次');
