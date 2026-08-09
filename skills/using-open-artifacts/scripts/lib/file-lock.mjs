import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import { hostname as systemHostname } from "node:os";
import { dirname } from "node:path";

const waitArray = new Int32Array(new SharedArrayBuffer(4));

export class FileLockTimeoutError extends Error {
  code = "STATE_LOCK_TIMEOUT";

  /** @param {string} lockPath @param {number} timeoutMs */
  constructor(lockPath, timeoutMs) {
    super(
      `state lock ${lockPath} remained active for ${timeoutMs}ms; wait for the owning process or follow the stale-lock recovery guide`,
    );
    this.name = "FileLockTimeoutError";
  }
}

/** @param {number} pid */
function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/**
 * @param {string} target
 * @param {{
 *   timeoutMs?: number,
 *   staleMs?: number,
 *   retryMs?: number,
 *   fileSystem?: typeof nodeFs,
 *   now?: () => number,
 *   pid?: number,
 *   hostname?: string,
 *   isProcessAlive?: (pid: number) => boolean
 * }} [options]
 */
export function acquireFileLockSync(target, options = {}) {
  const fileSystem = options.fileSystem ?? nodeFs;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const staleMs = options.staleMs ?? 30_000;
  const retryMs = options.retryMs ?? 10;
  const pid = options.pid ?? process.pid;
  const hostname = options.hostname ?? systemHostname();
  const isAlive = options.isProcessAlive ?? processIsAlive;
  const lockPath = `${target}.lock`;
  const started = now();
  let recoveredStaleLock = false;
  fileSystem.mkdirSync(dirname(target), { recursive: true });

  for (;;) {
    const nonce = randomUUID();
    try {
      const descriptor = fileSystem.openSync(lockPath, "wx", 0o600);
      try {
        fileSystem.writeFileSync(
          descriptor,
          `${JSON.stringify({
            pid,
            hostname,
            createdAt: new Date(now()).toISOString(),
            nonce,
          })}\n`,
        );
        fileSystem.fsyncSync(descriptor);
      } finally {
        fileSystem.closeSync(descriptor);
      }
      let released = false;
      return {
        path: lockPath,
        recoveredStaleLock,
        release() {
          if (released) return;
          released = true;
          try {
            const owner = JSON.parse(fileSystem.readFileSync(lockPath, "utf8"));
            if (owner.nonce === nonce) fileSystem.unlinkSync(lockPath);
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !("code" in error) ||
              error.code !== "ENOENT"
            ) {
              throw error;
            }
          }
        },
      };
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
    }

    try {
      const owner = JSON.parse(fileSystem.readFileSync(lockPath, "utf8"));
      const age = now() - Date.parse(owner.createdAt);
      if (
        age >= staleMs &&
        owner.hostname === hostname &&
        Number.isInteger(owner.pid) &&
        !isAlive(owner.pid)
      ) {
        fileSystem.unlinkSync(lockPath);
        recoveredStaleLock = true;
        continue;
      }
    } catch {
      // An unreadable lock is not stolen automatically. The bounded timeout
      // produces a recovery message instead of risking two simultaneous writers.
    }

    if (now() - started >= timeoutMs) {
      throw new FileLockTimeoutError(lockPath, timeoutMs);
    }
    Atomics.wait(waitArray, 0, 0, Math.min(retryMs, timeoutMs));
  }
}

/**
 * @template T
 * @param {string} target
 * @param {() => T} operation
 * @param {Parameters<typeof acquireFileLockSync>[1]} [options]
 * @returns {T}
 */
export function withFileLockSync(target, operation, options) {
  const lock = acquireFileLockSync(target, options);
  try {
    return operation();
  } finally {
    lock.release();
  }
}
