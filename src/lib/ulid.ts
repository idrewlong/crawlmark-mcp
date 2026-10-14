import { randomBytes } from "node:crypto";

/** Crockford base32 ULID: 48-bit time + 80 random bits, sortable. */
export function ulid(now = Date.now()): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = alphabet[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += alphabet[bytes[i]! % 32];
  return time + rand;
}
