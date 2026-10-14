/**
 * A minimal, bounded zip reader for imported exports (Search Console's Pages report: a zip of CSV files, and
 * .xlsx workbooks, which are zips of XML). Reads the central directory of an in-memory buffer; supports stored
 * (0) and deflate (8) entries only. Refuses encrypted entries, Zip64, more than `maxEntries` entries, and any
 * entry or total that would inflate past its cap (inflateRawSync's maxOutputLength stops a zip bomb before it
 * is allocated). Nothing is written to disk; entry names are only matched, never used as paths.
 */
import { inflateRawSync } from "node:zlib";

export class ZipReadError extends Error {
  override name = "ZipReadError";
}

export interface ZipCaps {
  maxEntries: number;
  /** Uncompressed bytes per entry. */
  maxEntryBytes: number;
  /** Uncompressed bytes across the entries read. */
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_CAPS: ZipCaps = { maxEntries: 200, maxEntryBytes: 20 * 1024 * 1024, maxTotalBytes: 60 * 1024 * 1024 };

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

/** Whether a buffer starts like a zip file (local file header, or an empty archive's end record). */
export const looksLikeZip = (buf: Buffer) => buf.length >= 4 && (buf.readUInt32LE(0) === LOC || buf.readUInt32LE(0) === EOCD);

/**
 * The entries whose name `want` accepts (directories skipped), decompressed, in central-directory order.
 * `want` sees the entry's name with backslashes turned into slashes.
 */
export function readZip(buf: Buffer, want: (name: string) => boolean, caps: ZipCaps = DEFAULT_ZIP_CAPS): { name: string; data: Buffer }[] {
  // The end-of-central-directory record is in the last 22 + 65,535 (comment) bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipReadError("Not a zip file (no end of central directory).");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new ZipReadError("Zip64 archives aren't supported.");
  if (count > caps.maxEntries) throw new ZipReadError(`The zip has ${count} entries; at most ${caps.maxEntries} are read.`);
  if (cdOffset + cdSize > buf.length) throw new ZipReadError("The zip's central directory is outside the file (truncated or corrupt).");

  const out: { name: string; data: Buffer }[] = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN) throw new ZipReadError("The zip's central directory is corrupt.");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buf.length) throw new ZipReadError("The zip's central directory is corrupt.");
    // Bit 11 marks a UTF-8 name; anything else is read as latin1 (CP437 differs only outside ASCII).
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? "utf8" : "latin1").replace(/\\/g, "/");
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/") || !want(name)) continue;
    if (flags & 0x1) throw new ZipReadError(`${name.slice(0, 200)} is encrypted.`);
    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ZipReadError("Zip64 archives aren't supported.");
    if (size > caps.maxEntryBytes) throw new ZipReadError(`${name.slice(0, 200)} is larger than ${caps.maxEntryBytes} bytes uncompressed.`);
    if (total + size > caps.maxTotalBytes) throw new ZipReadError(`The zip's files are larger than ${caps.maxTotalBytes} bytes uncompressed.`);
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOC) throw new ZipReadError("The zip's local header is corrupt.");
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (start + compSize > buf.length) throw new ZipReadError(`${name.slice(0, 200)} is truncated.`);
    const raw = buf.subarray(start, start + compSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        // The declared size is the cap: a stream that inflates past it is refused, not allocated.
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, size) });
      } catch {
        throw new ZipReadError(`${name.slice(0, 200)} couldn't be decompressed (corrupt, or larger than it declares).`);
      }
    } else throw new ZipReadError(`${name.slice(0, 200)} uses an unsupported compression method (${method}).`);
    if (data.length !== size) throw new ZipReadError(`${name.slice(0, 200)} isn't the size it declares.`);
    total += data.length;
    out.push({ name, data });
  }
  return out;
}
