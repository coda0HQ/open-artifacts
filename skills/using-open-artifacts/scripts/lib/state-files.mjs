import { createHash, randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import { basename, dirname, join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.mjs";
import { withFileLockSync } from "./file-lock.mjs";

const STATE_SCHEMA_VERSION = 1;

export class StateFileError extends Error {
  code = "STATE_FILE_CORRUPT";

  /** @param {string} message @param {string} path @param {string | null} quarantinePath */
  constructor(message, path, quarantinePath) {
    super(
      `${message}; preserved the damaged file${quarantinePath ? ` at ${quarantinePath}` : ""}. Restore a known-good copy or inspect it manually before retrying`,
    );
    this.name = "StateFileError";
    this.path = path;
    this.quarantinePath = quarantinePath;
  }
}

/** @param {unknown} value */
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

/** @param {Record<string, unknown>} value */
function checksum(value) {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

/** @param {unknown} value */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {Record<string, unknown>} value @param {"manifest" | "config" | "credentials"} kind */
function validate(value, kind) {
  if (!isRecord(value)) throw new Error(`${kind} state must be a JSON object`);
  if (kind === "manifest") {
    if (!Array.isArray(value.artifacts)) {
      throw new Error("manifest.artifacts must be an array");
    }
    if (
      value.manifestVersion !== undefined &&
      (typeof value.manifestVersion !== "number" ||
        !Number.isInteger(value.manifestVersion) ||
        value.manifestVersion < 1)
    ) {
      throw new Error("manifestVersion must be a positive integer");
    }
  }
  if (kind === "credentials") {
    for (const field of ["tokens", "channels", "passwords", "namedPasswords"]) {
      const candidate = value[field];
      if (candidate !== undefined && !isRecord(candidate)) {
        throw new Error(`credentials.${field} must be an object`);
      }
    }
  }
}

/**
 * @param {string} path
 * @param {typeof nodeFs} fileSystem
 * @returns {string | null}
 */
function quarantine(path, fileSystem) {
  const destination = join(
    dirname(path),
    `${basename(path)}.corrupt-${new Date().toISOString().replace(/[^0-9]/g, "")}-${randomUUID().slice(0, 8)}`,
  );
  try {
    fileSystem.renameSync(path, destination);
    return destination;
  } catch {
    return null;
  }
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} fallback
 * @param {{kind: "manifest" | "config" | "credentials", fileSystem?: typeof nodeFs}} options
 */
export function readStateJsonSync(path, fallback, options) {
  const fileSystem = options.fileSystem ?? nodeFs;
  if (!fileSystem.existsSync(path)) return { ...fallback };
  /** @type {Record<string, unknown>} */
  let parsed;
  try {
    parsed = JSON.parse(fileSystem.readFileSync(path, "utf8"));
    validate(parsed, options.kind);
    if (parsed._state !== undefined) {
      if (!isRecord(parsed._state)) throw new Error("_state must be an object");
      const state = /** @type {Record<string, unknown>} */ (parsed._state);
      if (state.schemaVersion !== STATE_SCHEMA_VERSION) {
        throw new Error(`unsupported state schema ${state.schemaVersion}`);
      }
      const payload = { ...parsed };
      delete payload._state;
      if (state.checksum !== checksum(payload)) {
        throw new Error("state checksum mismatch");
      }
      return payload;
    }
    return parsed;
  } catch (error) {
    const preserved = quarantine(path, fileSystem);
    const message =
      error instanceof Error ? error.message : "invalid state file";
    throw new StateFileError(message, path, preserved);
  }
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} value
 * @param {{kind: "manifest" | "config" | "credentials", secret?: boolean, fileSystem?: typeof nodeFs, lock?: object}} options
 */
export function writeStateJsonSync(path, value, options) {
  const fileSystem = options.fileSystem ?? nodeFs;
  validate(value, options.kind);
  const payload = { ...value };
  delete payload._state;
  const serialized = `${JSON.stringify(
    {
      ...payload,
      _state: {
        schemaVersion: STATE_SCHEMA_VERSION,
        checksum: checksum(payload),
      },
    },
    null,
    2,
  )}\n`;
  return withFileLockSync(
    path,
    () =>
      atomicWriteFileSync(path, serialized, {
        mode: options.secret ? 0o600 : 0o644,
        fileSystem,
      }),
    options.lock,
  );
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} fallback
 * @param {{kind: "manifest" | "config" | "credentials", secret?: boolean, fileSystem?: typeof nodeFs, lock?: object}} options
 * @param {(current: Record<string, unknown>) => Record<string, unknown> | void} mutate
 */
export function mutateStateJsonSync(path, fallback, options, mutate) {
  const fileSystem = options.fileSystem ?? nodeFs;
  return withFileLockSync(
    path,
    () => {
      const current = readStateJsonSync(path, fallback, {
        kind: options.kind,
        fileSystem,
      });
      const mutated = mutate(current);
      const replacement = /** @type {Record<string, unknown>} */ (
        mutated === undefined ? current : mutated
      );
      validate(replacement, options.kind);
      /** @type {Record<string, unknown>} */
      const payload = { ...replacement };
      delete payload._state;
      atomicWriteFileSync(
        path,
        `${JSON.stringify(
          {
            ...payload,
            _state: {
              schemaVersion: STATE_SCHEMA_VERSION,
              checksum: checksum(payload),
            },
          },
          null,
          2,
        )}\n`,
        {
          mode: options.secret ? 0o600 : 0o644,
          fileSystem,
        },
      );
      return replacement;
    },
    options.lock,
  );
}
