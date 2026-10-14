/** Build a zip in memory (deflate unless `store`), shaped like Search Console's exports, for tests. */
import { crc32, deflateRawSync } from "node:zlib";

const LOC = 0x04034b50;
const CEN = 0x02014b50;
const EOCD = 0x06054b50;

export function buildZip(files: { name: string; data: Buffer | string; store?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, "utf8");
    const comp = f.store ? data : deflateRawSync(data);
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(data);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(LOC, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(0x800, 6);
    loc.writeUInt16LE(f.store ? 0 : 8, 8);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(comp.length, 18);
    loc.writeUInt32LE(data.length, 22);
    loc.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(CEN, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x800, 8);
    cen.writeUInt16LE(f.store ? 0 : 8, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    locals.push(loc, name, comp);
    centrals.push(cen, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
