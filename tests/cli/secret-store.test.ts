import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EnvironmentSecretStore,
  FileSecretStore,
  MacOSKeychainSecretStore,
} from "../../skills/using-open-artifacts/scripts/lib/secret-store.mjs";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("replaceable SecretStore backends", () => {
  it("uses a 0600 atomic file only as the compatibility fallback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oa-secret-store-"));
    directories.push(directory);
    const path = join(directory, "credentials.json");
    const store = new FileSecretStore(path);
    await store.set("artifact-token", "wt_file-secret");
    expect(await store.get("artifact-token")).toBe("wt_file-secret");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await store.delete("artifact-token")).toBe(true);
    expect(await store.get("artifact-token")).toBeNull();
  });

  it("supports a read-only organization environment adapter", async () => {
    const store = new EnvironmentSecretStore({
      OPEN_ARTIFACTS_SECRET_RELEASE: "managed-secret",
    });
    expect(await store.get("release")).toBe("managed-secret");
    await expect(store.set("release", "replacement")).rejects.toThrow(
      "read-only",
    );
  });

  it("passes a Keychain secret over stdin rather than argv", async () => {
    const runner = vi.fn(async () => ({ stdout: "" }));
    const store = new MacOSKeychainSecretStore("open-artifacts", runner);
    await store.set("artifact-1", "wt_keychain-secret");
    expect(runner).toHaveBeenCalledWith(
      "/usr/bin/security",
      expect.not.arrayContaining(["wt_keychain-secret"]),
      { input: "wt_keychain-secret" },
    );
  });
});
