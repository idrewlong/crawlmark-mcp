/**
 * Windows has no POSIX permission bits: stat().mode & 0o777 reads 0o666 (0o444 when read-only) whatever
 * crawlmark asked for, and chmod only toggles the read-only flag. Mode assertions run only where modes exist;
 * on Windows the files rely on the user profile's ACLs instead.
 */
export const POSIX_MODES = process.platform !== "win32";
