import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

export class RoomConfigurationError extends Error {}

export function readPrivateSecret(path: string | undefined, staticRoot: string, setting: string, maximum: number): Buffer {
  if (!path || !isAbsolute(path)) throw new RoomConfigurationError(`${setting} must reference an absolute private file.`);
  let bytes: Buffer | undefined, fd: number | undefined;
  try {
    const canonical = realpathSync(path), root = realpathSync(staticRoot), local = relative(root, canonical);
    if (!local || (!local.startsWith(`..${sep}`) && local !== '..' && !isAbsolute(local))) {
      throw new RoomConfigurationError(`${setting} must be outside the static asset root.`);
    }
    const stat = statSync(canonical);
    if (!stat.isFile() || stat.size < 32 || stat.size > maximum + 2) {
      throw new RoomConfigurationError(`${setting} must contain 32-${maximum} printable ASCII characters.`);
    }
    fd = openSync(canonical, 'r');
    bytes = Buffer.alloc(maximum + 3);
    let length = 0, read: number;
    while (length < bytes.length && (read = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += read;
    if (length > maximum + 2) throw new RoomConfigurationError(`${setting} exceeds its size limit.`);
    if (bytes[length - 1] === 10) { length--; if (bytes[length - 1] === 13) length--; }
    if (length < 32 || length > maximum || bytes.subarray(0, length).some(byte => byte < 33 || byte > 126)) {
      throw new RoomConfigurationError(`${setting} must contain 32-${maximum} printable ASCII characters.`);
    }
    return Buffer.from(bytes.subarray(0, length));
  } catch (error) {
    if (error instanceof RoomConfigurationError) throw error;
    throw new RoomConfigurationError(`${setting} is missing or unreadable.`);
  } finally { bytes?.fill(0); if (fd !== undefined) closeSync(fd); }
}
