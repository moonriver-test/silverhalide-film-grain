/**
 * 极简 PNG 编码器（仅用于 Node 侧目视检查，不进入插件）
 * 支持 8 位灰度与 8 位 RGB，无滤波器。
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
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
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encode(w, h, channels, pixels) {
  const black = channels === 1 ? 0 : 0;
  const stride = w * channels;
  const raw = Buffer.alloc((stride + 1) * h);
  const src = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    src.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  void black;

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;                       // bit depth
  ihdr[9] = channels === 1 ? 0 : 2;  // color type: 0=gray, 2=RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function writeGrayPNG(path, w, h, gray /* Uint8ClampedArray | Uint8Array */) {
  writeFileSync(path, encode(w, h, 1, gray));
}

export function writeRGBPNG(path, w, h, rgb) {
  writeFileSync(path, encode(w, h, 3, rgb));
}

/** Float32 [0,1] 灰度 → Uint8 */
export function toU8(floatArr) {
  const out = new Uint8ClampedArray(floatArr.length);
  for (let i = 0; i < floatArr.length; i++) {
    const v = floatArr[i] * 255;
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}
