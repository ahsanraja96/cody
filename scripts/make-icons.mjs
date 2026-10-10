// Draws the Tabfold mark (tabs folding into a card) as PNG icons. No image dependencies:
// shapes are rasterised with 4x4 supersampling and written with Node's zlib.
// Usage: node scripts/make-icons.mjs [outDir] [sizes...]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const outDir = process.argv[2] ?? 'public/icon';
const sizes = process.argv.length > 3 ? process.argv.slice(3).map(Number) : [16, 32, 48, 128];

const ACCENT = [0x4f, 0x5b, 0xd5];
const WHITE = [0xff, 0xff, 0xff];

function roundedRectContains(x, y, rx, ry, w, h, r) {
  if (x < rx || y < ry || x > rx + w || y > ry + h) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + w - r);
  const cy = Math.min(Math.max(y, ry + r), ry + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Coverage of the white glyph in a 24x24 design grid: card outline plus two "tab" strokes. */
function glyph(x, y) {
  const stroke = 2.2;
  const half = stroke / 2;
  // Card: rect x=4 y=9 w=16 h=11 rx=2.5, stroked.
  const outer = roundedRectContains(x, y, 4 - half, 9 - half, 16 + stroke, 11 + stroke, 2.5 + half);
  const inner = roundedRectContains(x, y, 4 + half, 9 + half, 16 - stroke, 11 - stroke, Math.max(0, 2.5 - half));
  if (outer && !inner) return true;
  // Lines with round caps: M7 5.5 h10, M9.5 2.5 h5
  const line = (x1, x2, ly) => {
    const cx = Math.min(Math.max(x, x1), x2);
    return (x - cx) ** 2 + (y - ly) ** 2 <= half * half;
  };
  return line(7, 17, 5.5) || line(9.5, 14.5, 2.5);
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const ss = 4;
  const radius = size * 0.22;
  const glyphScale = 0.62; // glyph box relative to icon
  const offset = (size - size * glyphScale) / 2;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const x = px + (sx + 0.5) / ss;
          const y = py + (sy + 0.5) / ss;
          if (!roundedRectContains(x, y, 0, 0, size, size, radius)) continue;
          bg += 1;
          const gx = ((x - offset) / (size * glyphScale)) * 24;
          const gy = ((y - offset) / (size * glyphScale)) * 24 + 0.6;
          if (glyph(gx, gy)) fg += 1;
        }
      }
      const total = ss * ss;
      const alpha = bg / total;
      const mix = bg ? fg / bg : 0;
      const i = (py * size + px) * 4;
      for (let c = 0; c < 3; c += 1) pixels[i + c] = Math.round(ACCENT[c] * (1 - mix) + WHITE[c] * mix);
      pixels[i + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
}

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
for (const size of sizes) {
  writeFileSync(join(outDir, `${size}.png`), png(size, render(size)));
  console.log(`wrote ${join(outDir, `${size}.png`)}`);
}
