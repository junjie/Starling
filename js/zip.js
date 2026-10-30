/* Just enough zip to download several clips at once. Files are stored, not
   compressed: audio barely compresses, and this stays short. */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* Bit 11 marks names as UTF-8. Without it Chinese and Vietnamese names unpack
   as garbage. */
const UTF8_NAMES = 0x0800;

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/* The fields a file's local header and its central directory entry share,
   starting at "version needed". */
function commonFields(file, stamp) {
  const out = new Uint8Array(26);
  const view = new DataView(out.buffer);
  view.setUint16(0, 20, true);
  view.setUint16(2, UTF8_NAMES, true);
  view.setUint16(4, 0, true);                    // stored
  view.setUint16(6, stamp.time, true);
  view.setUint16(8, stamp.date, true);
  view.setUint32(10, file.crc, true);
  view.setUint32(14, file.bytes.length, true);
  view.setUint32(18, file.bytes.length, true);
  view.setUint16(22, file.name.length, true);
  return out;
}

/* `files` is [{ name, bytes }]. Returns a Blob. */
export function makeZip(files, now = new Date()) {
  const stamp = dosTime(now);
  const parts = [];
  const directory = [];
  let offset = 0;

  for (const f of files) {
    const file = { name: new TextEncoder().encode(f.name), bytes: f.bytes, crc: crc32(f.bytes) };
    const fields = commonFields(file, stamp);

    const local = new Uint8Array(4 + 26);
    new DataView(local.buffer).setUint32(0, 0x04034b50, true);
    local.set(fields, 4);
    parts.push(local, file.name, file.bytes);

    const central = new Uint8Array(46);
    const view = new DataView(central.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);                 // version made by
    central.set(fields, 6);
    view.setUint32(42, offset, true);
    directory.push(central, file.name);

    offset += local.length + file.name.length + file.bytes.length;
  }

  const size = directory.reduce((sum, d) => sum + d.length, 0);
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, files.length, true);
  view.setUint16(10, files.length, true);
  view.setUint32(12, size, true);
  view.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], { type: 'application/zip' });
}
