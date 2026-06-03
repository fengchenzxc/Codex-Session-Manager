import fs from "node:fs";
import zlib from "node:zlib";

const [input = "src-tauri/icons/icon.png", output = input] = process.argv.slice(2);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function paeth(left, up, upLeft) {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upLeft;
}

function unfilterScanlines(data, width, height, bytesPerPixel) {
  const stride = width * bytesPerPixel;
  const result = Buffer.alloc(height * stride);
  let readOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = data[readOffset];
    readOffset += 1;
    const rowOffset = y * stride;
    const prevRowOffset = rowOffset - stride;

    for (let x = 0; x < stride; x += 1) {
      const raw = data[readOffset + x];
      const left = x >= bytesPerPixel ? result[rowOffset + x - bytesPerPixel] : 0;
      const up = y > 0 ? result[prevRowOffset + x] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? result[prevRowOffset + x - bytesPerPixel] : 0;

      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + Math.floor((left + up) / 2);
      else if (filter === 4) value = raw + paeth(left, up, upLeft);
      else throw new Error(`Unsupported PNG filter: ${filter}`);

      result[rowOffset + x] = value & 0xff;
    }

    readOffset += stride;
  }

  return result;
}

const source = fs.readFileSync(input);
if (!source.subarray(0, 8).equals(pngSignature)) {
  throw new Error(`${input} is not a PNG file`);
}

let offset = 8;
let ihdr;
const idatChunks = [];

while (offset < source.length) {
  const length = source.readUInt32BE(offset);
  const type = source.toString("ascii", offset + 4, offset + 8);
  const data = source.subarray(offset + 8, offset + 8 + length);
  offset += length + 12;

  if (type === "IHDR") ihdr = Buffer.from(data);
  else if (type === "IDAT") idatChunks.push(Buffer.from(data));
  else if (type === "IEND") break;
}

if (!ihdr) throw new Error("PNG is missing IHDR");

const width = ihdr.readUInt32BE(0);
const height = ihdr.readUInt32BE(4);
const bitDepth = ihdr[8];
const colorType = ihdr[9];
const compression = ihdr[10];
const filterMethod = ihdr[11];
const interlace = ihdr[12];

if (bitDepth !== 8 || compression !== 0 || filterMethod !== 0 || interlace !== 0) {
  throw new Error("Only non-interlaced 8-bit PNG files are supported");
}

if (colorType === 6) {
  if (input !== output) fs.copyFileSync(input, output);
  console.log(`${output} is already RGBA`);
  process.exit(0);
}

if (colorType !== 2) {
  throw new Error(`Unsupported PNG color type: ${colorType}`);
}

const rgb = unfilterScanlines(zlib.inflateSync(Buffer.concat(idatChunks)), width, height, 3);
const rgbaRows = Buffer.alloc(height * (1 + width * 4));

for (let y = 0; y < height; y += 1) {
  const rowStart = y * (1 + width * 4);
  rgbaRows[rowStart] = 0;
  for (let x = 0; x < width; x += 1) {
    const src = (y * width + x) * 3;
    const dst = rowStart + 1 + x * 4;
    rgbaRows[dst] = rgb[src];
    rgbaRows[dst + 1] = rgb[src + 1];
    rgbaRows[dst + 2] = rgb[src + 2];
    rgbaRows[dst + 3] = 255;
  }
}

const nextIhdr = Buffer.from(ihdr);
nextIhdr[9] = 6;

const encoded = Buffer.concat([
  pngSignature,
  chunk("IHDR", nextIhdr),
  chunk("IDAT", zlib.deflateSync(rgbaRows, { level: 9 })),
  chunk("IEND")
]);

fs.writeFileSync(output, encoded);
console.log(`${output} converted to RGBA`);
