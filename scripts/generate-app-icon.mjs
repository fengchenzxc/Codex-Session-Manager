import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const size = 1024;
const pixels = new Uint8ClampedArray(size * size * 4);

function rgba(hex, alpha = 255) {
  const clean = hex.replace("#", "");
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
    alpha
  ];
}

function blendPixel(x, y, color) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const index = (Math.floor(y) * size + Math.floor(x)) * 4;
  const alpha = color[3] / 255;
  const inv = 1 - alpha;
  pixels[index] = Math.round(color[0] * alpha + pixels[index] * inv);
  pixels[index + 1] = Math.round(color[1] * alpha + pixels[index + 1] * inv);
  pixels[index + 2] = Math.round(color[2] * alpha + pixels[index + 2] * inv);
  pixels[index + 3] = Math.min(255, Math.round(color[3] + pixels[index + 3] * inv));
}

function fillRoundedRect(x, y, w, h, r, color) {
  const x2 = x + w;
  const y2 = y + h;
  for (let py = Math.floor(y); py < Math.ceil(y2); py++) {
    for (let px = Math.floor(x); px < Math.ceil(x2); px++) {
      const cx = px < x + r ? x + r : px > x2 - r ? x2 - r : px;
      const cy = py < y + r ? y + r : py > y2 - r ? y2 - r : py;
      const dx = px - cx;
      const dy = py - cy;
      if (dx * dx + dy * dy <= r * r) {
        blendPixel(px, py, color);
      }
    }
  }
}

function drawLine(x1, y1, x2, y2, width, color) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const steps = Math.ceil(Math.hypot(dx, dy));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x1 + dx * t;
    const y = y1 + dy * t;
    fillCircle(x, y, width / 2, color);
  }
}

function fillCircle(cx, cy, radius, color) {
  const minX = Math.floor(cx - radius);
  const maxX = Math.ceil(cx + radius);
  const minY = Math.floor(cy - radius);
  const maxY = Math.ceil(cy + radius);
  const r2 = radius * radius;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) {
        blendPixel(x, y, color);
      }
    }
  }
}

function drawBackground() {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = (y * size + x) * 4;
      pixels[index] = 0;
      pixels[index + 1] = 0;
      pixels[index + 2] = 0;
      pixels[index + 3] = 0;
    }
  }

  const shadow = rgba("#000000", 46);
  fillRoundedRect(116, 132, 792, 792, 174, shadow);
  fillRoundedRect(96, 84, 832, 832, 172, rgba("#191d19", 255));
  fillRoundedRect(126, 114, 772, 772, 148, rgba("#242923", 235));
  fillRoundedRect(168, 152, 688, 250, 94, rgba("#ffffff", 13));
}

function encodePng(width, height, data) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    Buffer.from(data.buffer, y * width * 4, width * 4).copy(raw, rowStart + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])) >>> 0);
  return Buffer.concat([len, name, data, crc]);
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}

drawBackground();

// Sidebar rail.
fillRoundedRect(244, 252, 96, 512, 48, rgba("#0d100d", 180));
fillCircle(292, 316, 20, rgba("#f6f2e9", 232));
fillCircle(292, 434, 15, rgba("#f6f2e9", 126));
fillCircle(292, 552, 15, rgba("#f6f2e9", 92));
fillCircle(292, 670, 15, rgba("#f6f2e9", 76));

// Calm session marks.
fillRoundedRect(408, 294, 300, 66, 33, rgba("#f6f2e9", 234));
fillRoundedRect(408, 466, 252, 62, 31, rgba("#f6f2e9", 180));
fillRoundedRect(408, 636, 198, 58, 29, rgba("#f6f2e9", 136));

// A small sync/repair path.
drawLine(710, 330, 770, 506, 24, rgba("#7be8d3", 226));
drawLine(770, 506, 660, 666, 24, rgba("#7be8d3", 226));
fillCircle(710, 330, 34, rgba("#7be8d3", 248));
fillCircle(770, 506, 30, rgba("#7be8d3", 240));
fillCircle(660, 666, 32, rgba("#f0bf57", 244));

// Inner counters keep the motif readable at small sizes.
fillCircle(710, 330, 12, rgba("#191d19", 255));
fillCircle(770, 506, 10, rgba("#191d19", 255));
fillCircle(660, 666, 11, rgba("#191d19", 255));

// Subtle bottom depth.
fillRoundedRect(236, 788, 544, 18, 9, rgba("#000000", 54));

fs.mkdirSync("src-tauri/icons", { recursive: true });
fs.writeFileSync("src-tauri/icons/icon.png", encodePng(size, size, pixels));
console.log(path.resolve("src-tauri/icons/icon.png"));
