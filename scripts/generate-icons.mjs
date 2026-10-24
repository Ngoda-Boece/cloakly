// Génère les icônes PNG de l'extension (Chrome n'accepte pas le SVG dans le manifest).
// Usage : node scripts/generate-icons.mjs
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BACKGROUND = [0x2b, 0x2d, 0x6e];
const SHIELD = [0xff, 0xff, 0xff];
const CHECK = [0x18, 0x79, 0x4e];
const SAMPLES = 4;

function insideRoundedSquare(x, y) {
  const radius = 0.22;
  const cx = Math.min(Math.max(x, radius), 1 - radius);
  const cy = Math.min(Math.max(y, radius), 1 - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function insideShield(x, y) {
  if (y < 0.18 || y > 0.84) return false;
  const half = y <= 0.5 ? 0.28 : 0.28 * Math.sqrt(1 - ((y - 0.5) / 0.34) ** 2);
  return Math.abs(x - 0.5) <= half;
}

function distanceToSegment(px, py, [ax, ay], [bx, by]) {
  const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
}

function onCheck(x, y) {
  const a = [0.36, 0.49];
  const b = [0.46, 0.6];
  const c = [0.65, 0.38];
  return Math.min(distanceToSegment(x, y, a, b), distanceToSegment(x, y, b, c)) <= 0.05;
}

function pixel(x, y) {
  if (!insideRoundedSquare(x, y)) return null;
  if (insideShield(x, y)) return onCheck(x, y) ? CHECK : SHIELD;
  return BACKGROUND;
}

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const color = pixel((x + (sx + 0.5) / SAMPLES) / size, (y + (sy + 0.5) / SAMPLES) / size);
          if (!color) continue;
          r += color[0]; g += color[1]; b += color[2]; a += 1;
        }
      }
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      raw[offset] = a ? Math.round(r / a) : 0;
      raw[offset + 1] = a ? Math.round(g / a) : 0;
      raw[offset + 2] = a ? Math.round(b / a) : 0;
      raw[offset + 3] = Math.round((a / SAMPLES ** 2) * 255);
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(new URL(`../public/icons/icon-${size}.png`, import.meta.url), png(size));
}
console.log("Icônes générées dans public/icons/");
