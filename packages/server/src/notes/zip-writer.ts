import { crc32, deflateRawSync } from "node:zlib";

/**
 * A small zip writer for exports, with no dependency: each entry is deflated when the stream reaches it, so only one
 * entry's compressed bytes are held at a time, plus the central directory (about 50 bytes and the name per entry).
 * No zip64, so the caller keeps entries under 65,535 and the whole archive under 4 GiB (MAX_ZIP_* below).
 */

export interface ZipEntry {
  /** The path inside the archive, with `/` between folders. Written as UTF-8. */
  name: string;
  data: Uint8Array;
}

export const MAX_ZIP_ENTRIES = 65_535;
/** Uncompressed bytes across all entries; deflate never grows Markdown much, so the archive stays far below 4 GiB. */
export const MAX_ZIP_BYTES = 1024 * 1024 * 1024;

const UTF8_NAMES = 0x0800;
const DEFLATE = 8;
const VERSION = 20;

/** Date and time in MS-DOS format, as zip headers store them (local time, two-second steps, from 1980). */
function dosDateTime(date: Date): { time: number; day: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Streams a zip of the entries. Throws at once when they're past the limits, before anything is written. */
export function zipStream(entries: ZipEntry[], modified: Date = new Date()): ReadableStream<Uint8Array> {
  if (entries.length > MAX_ZIP_ENTRIES) throw new RangeError(`A zip can hold at most ${MAX_ZIP_ENTRIES} entries`);
  if (entries.reduce((sum, e) => sum + e.data.byteLength, 0) > MAX_ZIP_BYTES) throw new RangeError("Too much to zip");
  const { time, day } = dosDateTime(modified);
  const central: Buffer[] = [];
  let offset = 0;
  let next = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next < entries.length) {
        const entry = entries[next++]!;
        const name = Buffer.from(entry.name, "utf8");
        const data = deflateRawSync(entry.data);
        const crc = crc32(entry.data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(VERSION, 4);
        local.writeUInt16LE(UTF8_NAMES, 6);
        local.writeUInt16LE(DEFLATE, 8);
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(day, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.byteLength, 18);
        local.writeUInt32LE(entry.data.byteLength, 22);
        local.writeUInt16LE(name.byteLength, 26);
        local.writeUInt16LE(0, 28);
        const header = Buffer.alloc(46);
        header.writeUInt32LE(0x02014b50, 0);
        header.writeUInt16LE(VERSION, 4);
        header.writeUInt16LE(VERSION, 6);
        header.writeUInt16LE(UTF8_NAMES, 8);
        header.writeUInt16LE(DEFLATE, 10);
        header.writeUInt16LE(time, 12);
        header.writeUInt16LE(day, 14);
        header.writeUInt32LE(crc, 16);
        header.writeUInt32LE(data.byteLength, 20);
        header.writeUInt32LE(entry.data.byteLength, 24);
        header.writeUInt16LE(name.byteLength, 28);
        // Extra field, comment, disk number and internal attributes stay 0.
        header.writeUInt32LE(0o100644 << 16, 38);
        header.writeUInt32LE(offset, 42);
        central.push(header, name);
        offset += local.byteLength + name.byteLength + data.byteLength;
        controller.enqueue(new Uint8Array(Buffer.concat([local, name, data])));
        return;
      }
      const directory = Buffer.concat(central);
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(entries.length, 8);
      end.writeUInt16LE(entries.length, 10);
      end.writeUInt32LE(directory.byteLength, 12);
      end.writeUInt32LE(offset, 16);
      controller.enqueue(new Uint8Array(Buffer.concat([directory, end])));
      controller.close();
    },
  });
}
