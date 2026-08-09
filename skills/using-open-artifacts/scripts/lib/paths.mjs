import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = process.cwd();
export const SKILL_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const ARTIFACTS_DIR = ".artifacts";

export const filePair = (base) => ({
  shared: join(ARTIFACTS_DIR, `${base}.json`),
  local: join(ARTIFACTS_DIR, `${base}.local.json`),
});

export const MANIFEST = filePair("manifest");
export const CONFIG = filePair("config");
export const CREDENTIALS_PATH = join(ARTIFACTS_DIR, "credentials.json");
export const GLOBAL_CONFIG_PATH = join(
  homedir(),
  ".config/open-artifacts/config.json",
);
