import { spawn } from "node:child_process";
import { mutateStateJsonSync, readStateJsonSync } from "./state-files.mjs";

export class SecretStoreUnavailableError extends Error {
  code = "SECRET_STORE_UNAVAILABLE";

  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "SecretStoreUnavailableError";
  }
}

export class FileSecretStore {
  /** @param {string} path */
  constructor(path) {
    this.path = path;
  }

  /** @param {string} name */
  async get(name) {
    const state = readStateJsonSync(this.path, {}, { kind: "credentials" });
    const secrets =
      state.secrets && typeof state.secrets === "object" ? state.secrets : {};
    return typeof secrets[name] === "string" ? secrets[name] : null;
  }

  /** @param {string} name @param {string} value */
  async set(name, value) {
    mutateStateJsonSync(
      this.path,
      {},
      { kind: "credentials", secret: true },
      (state) => ({
        ...state,
        secrets: {
          ...(state.secrets && typeof state.secrets === "object"
            ? state.secrets
            : {}),
          [name]: value,
        },
      }),
    );
  }

  /** @param {string} name */
  async delete(name) {
    let removed = false;
    mutateStateJsonSync(
      this.path,
      {},
      { kind: "credentials", secret: true },
      (state) => {
        const secrets = {
          ...(state.secrets && typeof state.secrets === "object"
            ? state.secrets
            : {}),
        };
        removed = typeof secrets[name] === "string";
        delete secrets[name];
        return { ...state, secrets };
      },
    );
    return removed;
  }
}

export class EnvironmentSecretStore {
  /** @param {Record<string, string | undefined>} environment @param {string} [prefix] */
  constructor(environment, prefix = "OPEN_ARTIFACTS_SECRET_") {
    this.environment = environment;
    this.prefix = prefix;
  }

  /** @param {string} name */
  async get(name) {
    return this.environment[`${this.prefix}${name.toUpperCase()}`] ?? null;
  }

  /** @param {string} _name @param {string} _value */
  async set(_name, _value) {
    throw new SecretStoreUnavailableError(
      "environment secret stores are read-only; rotate through the organization secret manager",
    );
  }

  /** @param {string} _name */
  async delete(_name) {
    throw new SecretStoreUnavailableError(
      "environment secret stores are read-only; revoke through the organization secret manager",
    );
  }
}

/**
 * @param {string} command
 * @param {string[]} arguments_
 * @param {{input?: string}} [options]
 */
function runCommand(command, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new SecretStoreUnavailableError(
            `secret-store command exited ${code}`,
          ),
        );
    });
    child.stdin.end(options.input ?? "");
  });
}

export class MacOSKeychainSecretStore {
  /**
   * @param {string} service
   * @param {(command: string, arguments_: string[], options?: {input?: string}) => Promise<{stdout: string, stderr?: string}>} [runner]
   */
  constructor(service, runner = runCommand) {
    this.service = service;
    this.runner = runner;
  }

  /** @param {string} name */
  async get(name) {
    try {
      const result = await this.runner("/usr/bin/security", [
        "find-generic-password",
        "-w",
        "-a",
        name,
        "-s",
        this.service,
      ]);
      return result.stdout.replace(/\r?\n$/, "");
    } catch {
      return null;
    }
  }

  /** @param {string} name @param {string} value */
  async set(name, value) {
    await this.runner(
      "/usr/bin/security",
      ["add-generic-password", "-U", "-a", name, "-s", this.service, "-w"],
      { input: value },
    );
  }

  /** @param {string} name */
  async delete(name) {
    try {
      await this.runner("/usr/bin/security", [
        "delete-generic-password",
        "-a",
        name,
        "-s",
        this.service,
      ]);
      return true;
    } catch {
      return false;
    }
  }
}
