import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Durably replaces one file using a same-directory temporary file. The target
 * remains untouched until the atomic rename commit point.
 *
 * @param {string} target
 * @param {string | Uint8Array} data
 * @param {{mode?: number, fileSystem?: typeof nodeFs}} [options]
 */
export function atomicWriteFileSync(target, data, options = {}) {
  const fileSystem = options.fileSystem ?? nodeFs;
  const mode = options.mode ?? 0o644;
  const directory = dirname(target);
  const temporary = join(
    directory,
    `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  fileSystem.mkdirSync(directory, { recursive: true });
  /** @type {number | undefined} */
  let descriptor;
  let renamed = false;
  try {
    descriptor = fileSystem.openSync(
      temporary,
      fileSystem.constants.O_CREAT |
        fileSystem.constants.O_EXCL |
        fileSystem.constants.O_WRONLY,
      mode,
    );
    fileSystem.writeFileSync(descriptor, data);
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    fileSystem.chmodSync(temporary, mode);
    fileSystem.renameSync(temporary, target);
    renamed = true;

    let directoryDescriptor;
    try {
      directoryDescriptor = fileSystem.openSync(
        directory,
        fileSystem.constants.O_RDONLY,
      );
      fileSystem.fsyncSync(directoryDescriptor);
    } catch (error) {
      // Some platforms/filesystems reject fsync on a directory. The file data
      // itself was fsynced before rename; only suppress that documented
      // portability case, never an arbitrary I/O error.
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        (error.code !== "EINVAL" && error.code !== "EPERM")
      ) {
        throw error;
      }
    } finally {
      if (directoryDescriptor !== undefined) {
        fileSystem.closeSync(directoryDescriptor);
      }
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fileSystem.closeSync(descriptor);
      } catch {}
    }
    if (!renamed) {
      try {
        fileSystem.unlinkSync(temporary);
      } catch {}
    }
    throw error;
  }
}
