import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/** Why a capped read was refused: the path isn't a regular file, or it is larger than the cap. */
export class RegularFileError extends Error {
  constructor(
    readonly reason: "not-regular" | "too-large",
    message: string,
  ) {
    super(message);
    this.name = "RegularFileError";
  }
}

/**
 * Read a whole regular file of at most `maxBytes`, from one open handle. The final path component is opened with
 * O_NOFOLLOW (a symlink swapped in after an earlier lstat is refused, ELOOP) and O_NONBLOCK (a FIFO can't hang the
 * open); then fstat must say regular file and a size within the cap, and the bytes actually read are counted too,
 * so a file that grew after the fstat still can't exceed the cap. The flags are 0 where the platform lacks them
 * (Windows). Open errors (ENOENT, ELOOP, EACCES) propagate unchanged.
 */
export function readRegularFileCapped(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new RegularFileError("not-regular", `${path} isn't a regular file.`);
    if (st.size > maxBytes) throw new RegularFileError("too-large", `${path} is larger than ${maxBytes} bytes.`);
    // Reads stop one byte past the cap at most: enough to see that the file is over it.
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buf = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      total += n;
      chunks.push(buf.subarray(0, n));
      if (total > maxBytes) throw new RegularFileError("too-large", `${path} is larger than ${maxBytes} bytes.`);
    }
    return Buffer.concat(chunks, total);
  } finally {
    closeSync(fd);
  }
}
