// Genera le icone PNG della PWA (rasterizzatore minimale, senza dipendenze).
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const OUTER = [[6.5, 25.5], [14, 6.5], [18, 6.5], [25.5, 25.5], [21.2, 25.5], [16, 11.9], [10.8, 25.5]];
const HOLE = [[-1, -1], [-1, -2], [-2, -1]];
function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inRoundRect(x, y, s, r) {
  if (x < 0 || y < 0 || x > s || y > s) return false;
  const cx = Math.min(Math.max(x, r), s - r);
  const cy = Math.min(Math.max(y, r), s - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function render(size, { radius = 3, glyphScale = 1 } = {}) {
  const ss = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0, fg = 0, oc = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const x = ((px + (sx + 0.5) / ss) / size) * 32;
        const y = ((py + (sy + 0.5) / ss) / size) * 32;
        if (!inRoundRect(x, y, 32, radius)) continue;
        bg++;
        const gx = (x - 16) / glyphScale + 16;
        const gy = (y - 16) / glyphScale + 16;
        if (gx >= 12.6 && gx <= 19.4 && gy >= 17.6 && gy <= 21.2) oc++;
        else if (inPoly(gx, gy, OUTER) && !inPoly(gx, gy, HOLE)) fg++;
      }
      const n = ss * ss;
      const br = 11, bgc = 63, bb = 191;
      const a = bg / n, f = bg ? fg / bg : 0;
      const i = (py * size + px) * 4;
      const o = bg ? oc / bg : 0;
      buf[i] = Math.round(br + (255 - br) * f + (232 - br) * o);
      buf[i + 1] = Math.round(bgc + (255 - bgc) * f + (169 - bgc) * o);
      buf[i + 2] = Math.round(bb + (255 - bb) * f + (23 - bb) * o);
      buf[i + 3] = Math.round(a * 255);
    }
  }
  return png(size, size, buf);
}

const out = new URL('../public/icons/', import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL('icon-192.png', out), render(192));
writeFileSync(new URL('icon-512.png', out), render(512));
writeFileSync(new URL('maskable-512.png', out), render(512, { radius: 0, glyphScale: 0.78 }));
writeFileSync(new URL('apple-touch-icon.png', out), render(180, { radius: 0, glyphScale: 0.85 }));
writeFileSync(new URL('badge-96.png', out), render(96, { radius: 3, glyphScale: 1.15 }));
console.log('icone generate in public/icons/');

/** favicon.ico (16, 32, 48 px, PNG incorporati) per i browser che non usano l'icona SVG */
function ico(sizes) {
  const imgs = sizes.map((s) => render(s));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + i * 16;
    head.writeUInt8(s >= 256 ? 0 : s, e); head.writeUInt8(s >= 256 ? 0 : s, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(imgs[i].length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += imgs[i].length;
  });
  return Buffer.concat([head, ...imgs]);
}
writeFileSync(new URL('../app/favicon.ico', import.meta.url), ico([16, 32, 48]));
writeFileSync(new URL('favicon-32.png', out), render(32));
console.log('favicon.ico generata in app/');
