/**
 * A store-only zip (no compression), as the desktop's crash report builds it (desktop/src-tauri/src/report.rs
 * zip_stored): local headers, the central directory and its end record, a fixed date. Enough for the suggestion zip,
 * whose pictures are already compressed. No zip64: every file and the whole zip stay well under 4 GB.
 */

let table: Uint32Array | null = null;

/** CRC-32 (IEEE), as zip wants it. */
export function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry { name: string; data: Uint8Array }

const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01

/** The zip of `files`, in order. Names are written as UTF-8 (the suggestion's names are plain ASCII). */
export function zipStored(files: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const names = files.map((f) => enc.encode(f.name));
  const localSize = files.reduce((n, f, i) => n + 30 + names[i].length + f.data.length, 0);
  const centralSize = names.reduce((n, b) => n + 46 + b.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const v = new DataView(out.buffer);
  let at = 0;
  const u16 = (x: number) => { v.setUint16(at, x, true); at += 2; };
  const u32 = (x: number) => { v.setUint32(at, x >>> 0, true); at += 4; };
  const bytes = (b: Uint8Array) => { out.set(b, at); at += b.length; };

  const offsets: number[] = [];
  const crcs = files.map((f) => crc32(f.data));
  files.forEach((f, i) => {
    offsets.push(at);
    u32(0x04034b50); u16(20); u16(0); u16(0); // signature, version needed, flags, method: stored
    u16(DOS_TIME); u16(DOS_DATE);
    u32(crcs[i]); u32(f.data.length); u32(f.data.length);
    u16(names[i].length); u16(0); // extra
    bytes(names[i]);
    bytes(f.data);
  });
  const cdOffset = at;
  files.forEach((f, i) => {
    u32(0x02014b50); u16(20); u16(20); u16(0); u16(0); // signature, made by, needed, flags, method
    u16(DOS_TIME); u16(DOS_DATE);
    u32(crcs[i]); u32(f.data.length); u32(f.data.length);
    u16(names[i].length); u16(0); u16(0); u16(0); u16(0); u32(0); // extra, comment, disk, internal, external attrs
    u32(offsets[i]);
    bytes(names[i]);
  });
  const cdSize = at - cdOffset;
  u32(0x06054b50); u16(0); u16(0); u16(files.length); u16(files.length);
  u32(cdSize);
  u32(cdOffset);
  u16(0); // comment
  return out;
}
