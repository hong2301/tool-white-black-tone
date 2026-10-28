/* 生成图标：无依赖 PNG 编码器（RGBA，zlib deflate） */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------- CRC32 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- 画图 ---------- */
const SS = 4; // 超采样

function mix(a, b, t) {
  return a + (b - a) * t;
}

function render(size) {
  const W = size * SS;
  const buf = Buffer.alloc(W * W * 4);
  const r = 0.22 * W;              // 圆角半径
  const cx = W / 2, cy = W / 2;
  const moonR = 0.30 * W;
  const cutR = 0.255 * W;
  const cutX = cx + 0.135 * W, cutY = cy - 0.115 * W;

  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;

      // 圆角矩形遮罩
      const dx = Math.max(r - x, 0, x - (W - r));
      const dy = Math.max(r - y, 0, y - (W - r));
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > r) { buf[idx + 3] = 0; continue; }

      // 背景渐变
      const t = (x / W) * 0.4 + (y / W) * 0.6;
      let R = mix(0x2a, 0x10, t);
      let G = mix(0x2d, 0x10, t);
      let B = mix(0x3d, 0x16, t);

      // 月亮（白色圆 - 偏移背景圆）
      const d1 = Math.hypot(x - cx, y - cy);
      const d2 = Math.hypot(x - cutX, y - cutY);
      if (d1 <= moonR && d2 > cutR) {
        // 月牙内部：白->浅蓝渐变
        const mt = (y - (cy - moonR)) / (2 * moonR);
        R = mix(0xf7, 0xc8, mt);
        G = mix(0xf9, 0xd4, mt);
        B = mix(0xff, 0xef, mt);
      } else if (d1 <= moonR && d2 <= cutR) {
        // 被挖掉的部分：背景
        const bob = mix(0x2a, 0x10, t);
        R = bob; G = mix(0x2d, 0x10, t); B = mix(0x3d, 0x16, t);
      }

      // 一颗小星
      const sx = 0.735 * W, sy = 0.295 * W, sr = 0.038 * W;
      if (Math.hypot(x - sx, y - sy) <= sr) { R = 0xdf; G = 0xe6; B = 0xff; }

      // 左侧一道浅色竖条，暗示「白 -> 黑」
      if (x < 0.13 * W && y > 0.30 * W && y < 0.70 * W) {
        R = mix(R, 0xf2, 0.9); G = mix(G, 0xf4, 0.9); B = mix(B, 0xfa, 0.9);
      }

      buf[idx] = Math.round(R);
      buf[idx + 1] = Math.round(G);
      buf[idx + 2] = Math.round(B);
      buf[idx + 3] = 255;
    }
  }

  // 下采样（box filter，处理透明边缘）
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r0 = 0, g0 = 0, b0 = 0, a0 = 0;
      for (let sy2 = 0; sy2 < SS; sy2++) {
        for (let sx2 = 0; sx2 < SS; sx2++) {
          const i = ((y * SS + sy2) * W + (x * SS + sx2)) * 4;
          const a = buf[i + 3] / 255;
          r0 += buf[i] * a;
          g0 += buf[i + 1] * a;
          b0 += buf[i + 2] * a;
          a0 += a;
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      const alpha = a0 / n;
      out[o] = a0 > 0 ? Math.round(r0 / a0) : 0;
      out[o + 1] = a0 > 0 ? Math.round(g0 / a0) : 0;
      out[o + 2] = a0 > 0 ? Math.round(b0 / a0) : 0;
      out[o + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}

const dir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = encodePNG(size, size, render(size));
  fs.writeFileSync(path.join(dir, `icon${size}.png`), png);
  console.log(`icons/icon${size}.png  ${png.length} bytes`);
}
