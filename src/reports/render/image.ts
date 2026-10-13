/** Logo checks (pure): PNG or JPEG by magic bytes, at most 512 KB, and pixel size for layout. */

export const MAX_LOGO_BYTES = 512 * 1024;

export function sniffImage(data: Buffer): "image/png" | "image/jpeg" | undefined {
  if (data.length > 24 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  return undefined;
}

/** Width and height in pixels, or undefined when the header can't be read. */
export function imageSize(data: Buffer): { width: number; height: number } | undefined {
  const mime = sniffImage(data);
  if (mime === "image/png") return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (mime === "image/jpeg") {
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) return undefined;
      const marker = data[i + 1]!;
      const len = data.readUInt16BE(i + 2);
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return undefined;
}

/** Fit within a box, keeping the aspect ratio. */
export function fit(size: { width: number; height: number }, maxW: number, maxH: number): { width: number; height: number } {
  const k = Math.min(1, maxW / size.width, maxH / size.height);
  return { width: Math.max(1, Math.round(size.width * k)), height: Math.max(1, Math.round(size.height * k)) };
}
