import { execFile } from "node:child_process";
import { webcrypto } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const SCRIPT = resolve(
  __dirname,
  "../../skills/using-open-artifacts/scripts/artifact.mjs",
);

interface RecordedRequest {
  method: string;
  path: string;
  auth: string | undefined;
  body: Record<string, unknown>;
}

let server: Server;
let apiUrl: string;
const requests: RecordedRequest[] = [];
let nextResponse: { status: number; body: Record<string, unknown> } | null =
  null;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        auth: req.headers.authorization,
        body: raw ? JSON.parse(raw) : {},
      });
      const preset = nextResponse;
      nextResponse = null;
      const status = preset?.status ?? (req.method === "POST" ? 201 : 200);
      const body =
        preset?.body ??
        (req.method === "POST"
          ? {
              id: "testid123456",
              url: `${apiUrl}/a/testid123456`,
              writeToken: `wt_${"x".repeat(43)}`,
              version: 1,
            }
          : {
              id: "testid123456",
              url: `${apiUrl}/a/testid123456`,
              version: 2,
            });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  apiUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server.close();
});

let projectDir: string;

beforeEach(() => {
  requests.length = 0;
  projectDir = mkdtempSync(join(tmpdir(), "oa-cli-"));
  mkdirSync(join(projectDir, ".git"));
  mkdirSync(join(projectDir, "src"));
  writeFileSync(join(projectDir, "src/main.ts"), "export const x = 1;\n");
  writeFileSync(
    join(projectDir, "report.html"),
    "<title>Report</title><h1>Report</h1>",
  );
});

// Strip CLAUDE_PROJECT_DIR from the inherited env so tests are hermetic: only
// the cases that explicitly opt into a Claude Code session (auto-arm on create)
// see it, regardless of whether the suite itself runs inside one.
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  return env;
}

async function run(
  args: string[],
  options: { expectFailure?: boolean } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [SCRIPT, ...args],
      {
        cwd: projectDir,
        env: { ...cleanEnv(), OPEN_ARTIFACTS_URL: apiUrl },
      },
    );
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failed = error as { stdout: string; stderr: string; code: number };
    if (!options.expectFailure) {
      throw new Error(`CLI failed: ${failed.stderr || failed.stdout}`);
    }
    return {
      stdout: failed.stdout,
      stderr: failed.stderr,
      code: failed.code ?? 1,
    };
  }
}

async function runEnv(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [SCRIPT, ...args],
      { cwd, env: { ...cleanEnv(), ...env } },
    );
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failed = error as { stdout: string; stderr: string; code: number };
    return {
      stdout: failed.stdout,
      stderr: failed.stderr,
      code: failed.code ?? 1,
    };
  }
}

// Run the CLI with a string piped to stdin and closed — needed to exercise the
// Stop hook input contract (status --hook reads the hook JSON from stdin).
function runWithStdin(
  args: string[],
  input: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolveRun) => {
    const child = execFile(
      process.execPath,
      [SCRIPT, ...args],
      { cwd: projectDir, env: { ...cleanEnv(), OPEN_ARTIFACTS_URL: apiUrl } },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: number }).code === "number"
            ? (error as { code: number }).code
            : 0;
        resolveRun({ stdout, stderr, code });
      },
    );
    child.stdin?.end(input);
  });
}

function manifest(): {
  artifacts: Array<{
    id: string;
    version: number;
    watch: string[];
    snapshot: Record<string, string>;
    scope: string | null;
    channel: string | null;
    level: number | null;
    encrypted: boolean;
    autoUpdate?: boolean;
  }>;
} {
  const path = join(projectDir, ".artifacts/manifest.json");
  if (!existsSync(path)) return { artifacts: [] };
  return JSON.parse(readFileSync(path, "utf8"));
}

function manifestAt(rel: string): {
  artifacts: Array<Record<string, unknown>>;
} {
  const path = join(projectDir, rel);
  if (!existsSync(path)) return { artifacts: [] };
  return JSON.parse(readFileSync(path, "utf8"));
}

function gitignore(): string {
  const path = join(projectDir, ".gitignore");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

describe("create", () => {
  it("publishes, records the manifest entry, and stores the token separately", async () => {
    const result = await run([
      "create",
      "report.html",
      "--favicon",
      "📊",
      "--scope",
      "app interaction flows",
      "--watch",
      "src/**/*.ts",
    ]);
    expect(result.stdout.trim()).toBe(`${apiUrl}/a/testid123456`);

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].path).toBe("/api/artifacts");
    expect(requests[0].body.content).toContain("<h1>Report</h1>");
    expect(requests[0].body.format).toBe("html");

    const entry = manifest().artifacts[0];
    expect(entry.id).toBe("testid123456");
    expect(entry.scope).toBe("app interaction flows");
    expect(entry.watch).toEqual(["src/**/*.ts"]);
    expect(Object.keys(entry.snapshot)).toContain("src/main.ts");

    const credentials = JSON.parse(
      readFileSync(join(projectDir, ".artifacts/credentials.json"), "utf8"),
    );
    expect(credentials.tokens.testid123456).toMatch(/^wt_/);
    expect(JSON.stringify(manifest())).not.toContain("wt_");

    const gitignore = readFileSync(join(projectDir, ".gitignore"), "utf8");
    expect(gitignore).toContain(".artifacts/credentials.json");
  });

  it("requires a favicon", async () => {
    const result = await run(["create", "report.html"], {
      expectFailure: true,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("favicon");
  });

  it("encrypts client-side with --password and never sends plaintext", async () => {
    await run([
      "create",
      "report.html",
      "--favicon",
      "🔒",
      "--title",
      "Secret Report",
      "--password",
      "hunter2",
    ]);
    const body = requests[0].body as {
      content: string;
      encrypted: { salt: string; iv: string; iterations: number };
      title: string;
    };
    expect(body.encrypted.iterations).toBe(600000);
    expect(body.content).not.toContain("Report");
    expect(JSON.stringify(body)).not.toContain("hunter2");

    const fromB64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));
    const baseKey = await webcrypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("hunter2"),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    const key = await webcrypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: fromB64(body.encrypted.salt),
        iterations: body.encrypted.iterations,
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const plain = await webcrypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(body.encrypted.iv) },
      key,
      fromB64(body.content),
    );
    expect(new TextDecoder().decode(plain)).toContain("<h1>Report</h1>");
  });

  it("stores the password in credentials.json (gitignored) for later updates", async () => {
    await run([
      "create",
      "report.html",
      "--favicon",
      "🔒",
      "--password",
      "hunter2",
    ]);
    const creds = JSON.parse(
      readFileSync(join(projectDir, ".artifacts/credentials.json"), "utf8"),
    );
    expect(creds.passwords.testid123456).toBe("hunter2");
    // password is in the gitignored credentials file, never in the manifest
    expect(JSON.stringify(manifest())).not.toContain("hunter2");
    expect(gitignore()).toContain(".artifacts/credentials.json");
  });

  it("update reuses the stored password without re-prompting", async () => {
    await run([
      "create",
      "report.html",
      "--favicon",
      "🔒",
      "--password",
      "hunter2",
    ]);
    writeFileSync(join(projectDir, "report.html"), "<h1>Report v2</h1>");
    // No --password passed: CLI reads it from credentials and re-encrypts.
    await run(["update", "testid123456", "report.html"]);
    const put = requests[1];
    const putBody = put.body as {
      content: string;
      encrypted: { iterations: number };
    };
    expect(put.method).toBe("PUT");
    expect(putBody.encrypted.iterations).toBe(600000);
    expect(putBody.content).not.toContain("Report v2");
    expect(JSON.stringify(put.body)).not.toContain("hunter2");
    expect(put.body.content).not.toContain("Report v2");
    expect(JSON.stringify(put.body)).not.toContain("hunter2");
  });

  it("update on an encrypted artifact without stored password fails clearly", async () => {
    await run([
      "create",
      "report.html",
      "--favicon",
      "🔒",
      "--password",
      "hunter2",
    ]);
    // Wipe the stored password to simulate a teammate without it.
    const credsPath = join(projectDir, ".artifacts/credentials.json");
    const creds = JSON.parse(readFileSync(credsPath, "utf8"));
    delete creds.passwords;
    writeFileSync(credsPath, JSON.stringify(creds));
    const result = await run(["update", "testid123456", "report.html"], {
      expectFailure: true,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/password protected/i);
  });
});

describe("update", () => {
  it("sends the write token and baseVersion, then refreshes the manifest", async () => {
    await run([
      "create",
      "report.html",
      "--favicon",
      "📊",
      "--watch",
      "src/**/*.ts",
    ]);
    writeFileSync(join(projectDir, "report.html"), "<h1>Report v2</h1>");
    writeFileSync(join(projectDir, "src/main.ts"), "export const x = 2;\n");

    await run(["update", "testid123456", "report.html"]);

    const put = requests[1];
    expect(put.method).toBe("PUT");
    expect(put.path).toBe("/api/artifacts/testid123456");
    expect(put.auth).toBe(`Bearer wt_${"x".repeat(43)}`);
    expect(put.body.baseVersion).toBe(1);
    expect(put.body.content).toContain("Report v2");

    const entry = manifest().artifacts[0];
    expect(entry.version).toBe(2);
  });

  it("fails without a file argument", async () => {
    await run(["create", "report.html", "--favicon", "📊"]);
    const result = await run(["update", "testid123456"], {
      expectFailure: true,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("update requires a file argument");
  });

  it("reports a version conflict with guidance", async () => {
    await run(["create", "report.html", "--favicon", "📊"]);
    nextResponse = {
      status: 409,
      body: { error: "conflict", currentVersion: 5 },
    };
    const result = await run(["update", "testid123456", "report.html"], {
      expectFailure: true,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--force");
    expect(result.stderr).toContain("5");
  });
});

describe("status", () => {
  it("is silent and exits 0 with no manifest", async () => {
    const result = await run(["status"]);
    expect(result.code).toBe(0);
  });

  it("exits 0 when watched files are unchanged", async () => {
    await run([
      "create",
      "report.html",
      "--favicon",
      "📊",
      "--watch",
      "src/**/*.ts",
    ]);
    const result = await run(["status"]);
    expect(result.code).toBe(0);
  });

  it("reports stale artifacts with exit 1 after a watched file changes", async () => {
    await run([
      "create",
      "report.html",
      "--favicon",
      "📊",
      "--scope",
      "app interactions",
      "--watch",
      "src/**/*.ts",
    ]);
    writeFileSync(join(projectDir, "src/main.ts"), "export const x = 99;\n");

    const result = await run(["status"], { expectFailure: true });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("stale: testid123456");
    expect(result.stdout).toContain("src/main.ts");
  });

  it("emits Claude hook JSON with --hook", async () => {
    await run([
      "create",
      "report.html",
      "--favicon",
      "📊",
      "--scope",
      "app interactions",
      "--watch",
      "src/**/*.ts",
    ]);
    await run(["auto-update", "testid123456", "on"]);
    writeFileSync(join(projectDir, "src/main.ts"), "export const x = 99;\n");

    const result = await run(["status", "--hook"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      "src/main.ts",
    );
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      "app interactions",
    );
  });

  it("stays silent when the hook input has stop_hook_active true", async () => {
    await run([
      "create",
      "report.html",
      "--favicon",
      "📊",
      "--scope",
      "app interactions",
      "--watch",
      "src/**/*.ts",
    ]);
    await run(["auto-update", "testid123456", "on"]);
    writeFileSync(join(projectDir, "src/main.ts"), "export const x = 99;\n");

    const result = await runWithStdin(
      ["status", "--hook"],
      JSON.stringify({ stop_hook_active: true }),
    );
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("still emits the nudge when stop_hook_active is false", async () => {
    await run([
      "create",
      "report.html",
      "--favicon",
      "📊",
      "--scope",
      "app interactions",
      "--watch",
      "src/**/*.ts",
    ]);
    await run(["auto-update", "testid123456", "on"]);
    writeFileSync(join(projectDir, "src/main.ts"), "export const x = 99;\n");

    const result = await runWithStdin(
      ["status", "--hook"],
      JSON.stringify({ stop_hook_active: false }),
    );
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      "src/main.ts",
    );
  });

  it("detects newly added files matching the watch globs", async () => {
    await run([
      "create",
      "report.html",
      "--favicon",
      "📊",
      "--watch",
      "src/**/*.ts",
    ]);
    writeFileSync(
      join(projectDir, "src/new-module.ts"),
      "export const y = 1;\n",
    );
    const result = await run(["status"], { expectFailure: true });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("src/new-module.ts");
  });
});

describe("status --hook filters to auto-update artifacts", () => {
  it("hook JSON mentions only the auto-update:true artifact; plain status reports both with auto-update lines", async () => {
    nextResponse = {
      status: 201,
      body: {
        id: "auto-a",
        url: "http://example.invalid/a/auto-a",
        writeToken: `wt_${"a".repeat(43)}`,
        version: 1,
      },
    };
    await run([
      "create",
      "report.html",
      "--favicon",
      "📊",
      "--scope",
      "scope A",
      "--watch",
      "src/main.ts",
    ]);
    nextResponse = {
      status: 201,
      body: {
        id: "auto-b",
        url: "http://example.invalid/a/auto-b",
        writeToken: `wt_${"b".repeat(43)}`,
        version: 1,
      },
    };
    await run([
      "create",
      "report.html",
      "--favicon",
      "📊",
      "--scope",
      "scope B",
      "--watch",
      "src/main.ts",
    ]);

    await run(["auto-update", "auto-a", "on"]);
    // Simulate auto-b being a legacy entry created before this feature
    // shipped, i.e. the autoUpdate key is entirely absent, not just false.
    const m = manifest();
    const entryB = m.artifacts.find((a) => a.id === "auto-b") as {
      autoUpdate?: boolean;
    };
    delete entryB.autoUpdate;
    writeFileSync(
      join(projectDir, ".artifacts/manifest.json"),
      `${JSON.stringify(m, null, 2)}\n`,
    );

    writeFileSync(join(projectDir, "src/main.ts"), "export const x = 999;\n");

    const hook = await run(["status", "--hook"]);
    expect(hook.code).toBe(0);
    const parsed = JSON.parse(hook.stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.additionalContext).toContain("auto-a");
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain("auto-b");

    const plain = await run(["status"], { expectFailure: true });
    expect(plain.code).toBe(1);
    expect(plain.stdout).toContain("stale: auto-a");
    expect(plain.stdout).toContain("stale: auto-b");
    expect(plain.stdout).toContain("auto-update: on");
    expect(plain.stdout).toContain("auto-update: off");
  });

  it("hook stays completely silent when stale artifacts exist but none have auto-update on", async () => {
    await run([
      "create",
      "report.html",
      "--favicon",
      "📊",
      "--scope",
      "s",
      "--watch",
      "src/main.ts",
    ]);
    writeFileSync(join(projectDir, "src/main.ts"), "export const x = 999;\n");

    const hook = await run(["status", "--hook"]);
    expect(hook.code).toBe(0);
    expect(hook.stdout.trim()).toBe("");

    const plain = await run(["status"], { expectFailure: true });
    expect(plain.code).toBe(1); // human path is unaffected by the filter
    expect(plain.stdout).toContain("stale: testid123456");
    expect(plain.stdout).toContain("auto-update: off");
  });
});

describe("channel binding", () => {
  it("first create with --channel sends the channel and stores a ch_ token", async () => {
    const result = await run([
      "create",
      "report.html",
      "--favicon",
      "📊",
      "--channel",
      "app-interactions",
    ]);
    expect(result.code).toBe(0);
    expect(requests[0].body.channel).toMatch(/^ch_/);

    const credentials = JSON.parse(
      readFileSync(join(projectDir, ".artifacts/credentials.json"), "utf8"),
    );
    expect(credentials.channels["app-interactions"]).toMatch(/^ch_/);
    // The channel token never appears in the committed manifest.
    expect(JSON.stringify(manifest())).not.toContain("ch_");
  });

  it("reusing the same channel slug posts the same channel token", async () => {
    await run([
      "create",
      "report.html",
      "--favicon",
      "📊",
      "--channel",
      "topic",
    ]);
    const firstToken = requests[0].body.channel;
    writeFileSync(join(projectDir, "report.html"), "<h1>v2</h1>");
    await run([
      "create",
      "report.html",
      "--favicon",
      "📊",
      "--channel",
      "topic",
    ]);
    expect(requests[1].body.channel).toBe(firstToken);
  });

  it("manifest holds one entry per channel slug (replaced, not duplicated)", async () => {
    await run(["create", "report.html", "--favicon", "📊", "--channel", "one"]);
    await run(["create", "report.html", "--favicon", "📊", "--channel", "one"]);
    const entries = manifest().artifacts.filter((a) => a.channel === "one");
    expect(entries).toHaveLength(1);
  });

  it("different channel slugs get different tokens and entries", async () => {
    await run(["create", "report.html", "--favicon", "📊", "--channel", "a"]);
    await run(["create", "report.html", "--favicon", "📊", "--channel", "b"]);
    expect(requests[0].body.channel).not.toBe(requests[1].body.channel);
    expect(manifest().artifacts).toHaveLength(2);
  });
});

describe("production level", () => {
  it("--level records the level in the manifest and is not sent to the server", async () => {
    await run(["create", "report.html", "--favicon", "📊", "--level", "3"]);
    expect(manifest().artifacts[0].level).toBe(3);
    expect(requests[0].body.level).toBeUndefined();
  });

  it("aliases --simple / --interactive / --rich map to 1 / 2 / 3", async () => {
    await run(["create", "report.html", "--favicon", "📊", "--simple"]);
    expect(manifest().artifacts[0].level).toBe(1);
    await run(["create", "report.html", "--favicon", "📊", "--interactive"]);
    expect(manifest().artifacts[1].level).toBe(2);
    await run(["create", "report.html", "--favicon", "📊", "--rich"]);
    expect(manifest().artifacts[2].level).toBe(3);
  });

  it("omitting level records null (agent decides from the brief)", async () => {
    await run(["create", "report.html", "--favicon", "📊"]);
    expect(manifest().artifacts[0].level).toBeNull();
  });

  it("rejects an invalid --level", async () => {
    const result = await run(
      ["create", "report.html", "--favicon", "📊", "--level", "4"],
      { expectFailure: true },
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/level/i);
  });
});

describe("local mode (--local)", () => {
  it("writes the entry to manifest.local.json and gitignores it", async () => {
    await run([
      "create",
      "report.html",
      "--favicon",
      "📊",
      "--scope",
      "report",
      "--local",
    ]);
    // shared manifest untouched; local manifest holds the entry
    expect(manifest().artifacts).toHaveLength(0);
    const local = manifestAt(".artifacts/manifest.local.json");
    expect(local.artifacts).toHaveLength(1);
    expect(local.artifacts[0].id).toBe("testid123456");
    // credentials still single-file, holds the token
    const creds = JSON.parse(
      readFileSync(join(projectDir, ".artifacts/credentials.json"), "utf8"),
    );
    expect(creds.tokens.testid123456).toBeTruthy();
    // gitignore covers the local files, not credentials.local
    expect(gitignore()).toContain(".artifacts/manifest.local.json");
    expect(gitignore()).not.toContain("credentials.local");
  });

  it("create --local on a channel already in shared migrates it (no ghost)", async () => {
    // First create writes to the shared manifest (no --local).
    await run(["create", "report.html", "--favicon", "📊", "--channel", "x"]);
    expect(manifest().artifacts).toHaveLength(1);
    expect(manifestAt(".artifacts/manifest.local.json").artifacts).toHaveLength(
      0,
    );
    // Second create with --local on the same channel: server reuses the id,
    // CLI migrates the entry from shared to local so delete/update can reach it.
    await run([
      "create",
      "report.html",
      "--favicon",
      "📊",
      "--channel",
      "x",
      "--local",
    ]);
    expect(manifest().artifacts).toHaveLength(0);
    const local = manifestAt(".artifacts/manifest.local.json");
    expect(local.artifacts).toHaveLength(1);
    expect(local.artifacts[0].id).toBe("testid123456");
    // delete reaches the entry (lives in local) and clears it fully
    await run(["delete", "testid123456"]);
    expect(manifestAt(".artifacts/manifest.local.json").artifacts).toHaveLength(
      0,
    );
    expect(manifest().artifacts).toHaveLength(0);
  });

  it("list reads the merged view (local + shared)", async () => {
    mkdirSync(join(projectDir, ".artifacts"), { recursive: true });
    writeFileSync(
      join(projectDir, ".artifacts/manifest.json"),
      JSON.stringify({
        artifacts: [
          { id: "sharedAAA", url: "u", title: "Shared", favicon: "📊" },
        ],
      }),
    );
    writeFileSync(
      join(projectDir, ".artifacts/manifest.local.json"),
      JSON.stringify({
        artifacts: [
          { id: "localBBB", url: "u", title: "Local", favicon: "📊" },
        ],
      }),
    );
    const result = await run(["list"]);
    expect(result.stdout).toContain("sharedAAA");
    expect(result.stdout).toContain("localBBB");
  });

  it("local entry overrides shared entry with the same id", async () => {
    mkdirSync(join(projectDir, ".artifacts"), { recursive: true });
    const entry = (title: string) => ({
      id: "sameID",
      url: "u",
      title,
      favicon: "📊",
      watch: [],
      snapshot: {},
    });
    writeFileSync(
      join(projectDir, ".artifacts/manifest.json"),
      JSON.stringify({ artifacts: [entry("SharedTitle")] }),
    );
    writeFileSync(
      join(projectDir, ".artifacts/manifest.local.json"),
      JSON.stringify({ artifacts: [entry("LocalTitle")] }),
    );
    const result = await run(["list"]);
    expect(result.stdout).toContain("LocalTitle");
    expect(result.stdout).not.toContain("SharedTitle");
  });

  it("status reports staleness across both files", async () => {
    mkdirSync(join(projectDir, ".artifacts"), { recursive: true });
    const watch = ["src/**/*.ts"];
    const stale = (id: string) => ({
      id,
      url: "u",
      title: id,
      favicon: "📊",
      watch,
      snapshot: { "src/main.ts": "deadbeef" },
    });
    writeFileSync(
      join(projectDir, ".artifacts/manifest.json"),
      JSON.stringify({ artifacts: [stale("sharedStale")] }),
    );
    writeFileSync(
      join(projectDir, ".artifacts/manifest.local.json"),
      JSON.stringify({ artifacts: [stale("localStale")] }),
    );
    const result = await run(["status"], { expectFailure: true });
    expect(result.stdout).toContain("sharedStale");
    expect(result.stdout).toContain("localStale");
  });
});

describe("delete", () => {
  it("removes the artifact from the server, manifest, and credentials", async () => {
    await run(["create", "report.html", "--favicon", "📊"]);
    await run(["delete", "testid123456"]);
    expect(requests[1].method).toBe("DELETE");
    expect(requests[1].auth).toContain("wt_");
    expect(manifest().artifacts).toHaveLength(0);
  });
});

describe("install-hook", () => {
  it("writes the Stop hook into $CLAUDE_PROJECT_DIR/.claude/settings.json, not cwd", async () => {
    const sub = join(projectDir, "subdir");
    mkdirSync(sub, { recursive: true });
    const { code } = await runEnv(["install-hook"], sub, {
      CLAUDE_PROJECT_DIR: projectDir,
    });
    expect(code).toBe(0);
    const settingsPath = join(projectDir, ".claude/settings.json");
    expect(existsSync(settingsPath)).toBe(true);
    expect(existsSync(join(sub, ".claude/settings.json"))).toBe(false);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const stop = settings.hooks?.Stop?.[0]?.hooks?.[0];
    expect(stop?.type).toBe("command");
    expect(stop?.command).toContain("artifact.mjs");
    expect(stop?.command).toContain("status --hook");
  });

  it("is idempotent", async () => {
    await runEnv(["install-hook"], projectDir, {
      CLAUDE_PROJECT_DIR: projectDir,
    });
    const second = await runEnv(["install-hook"], projectDir, {
      CLAUDE_PROJECT_DIR: projectDir,
    });
    expect(second.code).toBe(0);
    expect(second.stderr).toContain("already installed");
    const settings = JSON.parse(
      readFileSync(join(projectDir, ".claude/settings.json"), "utf8"),
    );
    expect(settings.hooks.Stop).toHaveLength(1);
  });
});

describe("create leaves hook installation to the user", () => {
  it("does not write settings.json on create in a session, but hints", async () => {
    const { code, stderr } = await runEnv(
      ["create", "report.html", "--favicon", "📊", "--watch", "src/**/*.ts"],
      projectDir,
      { OPEN_ARTIFACTS_URL: apiUrl, CLAUDE_PROJECT_DIR: projectDir },
    );
    expect(code).toBe(0);
    expect(existsSync(join(projectDir, ".claude/settings.json"))).toBe(false);
    expect(stderr).toContain("install-hook");
  });

  it("does not hint once the hook is already installed", async () => {
    await runEnv(["install-hook"], projectDir, {
      CLAUDE_PROJECT_DIR: projectDir,
    });
    const { stderr } = await runEnv(
      ["create", "report.html", "--favicon", "📊", "--watch", "src/**/*.ts"],
      projectDir,
      { OPEN_ARTIFACTS_URL: apiUrl, CLAUDE_PROJECT_DIR: projectDir },
    );
    expect(stderr).not.toContain("install-hook");
  });

  it("neither installs nor hints outside a Claude Code session", async () => {
    const { stderr } = await run([
      "create",
      "report.html",
      "--favicon",
      "📊",
      "--watch",
      "src/**/*.ts",
    ]);
    expect(existsSync(join(projectDir, ".claude/settings.json"))).toBe(false);
    expect(stderr).not.toContain("install-hook");
  });
});

describe("ack", () => {
  it("advances the snapshot baseline offline without republishing", async () => {
    await run([
      "create",
      "report.html",
      "--favicon",
      "📊",
      "--scope",
      "app interactions",
      "--watch",
      "src/**/*.ts",
    ]);
    const before = manifest().artifacts[0].snapshot["src/main.ts"];
    writeFileSync(join(projectDir, "src/main.ts"), "export const x = 42;\n");

    const stale = await run(["status"], { expectFailure: true });
    expect(stale.code).toBe(1);

    const requestsBefore = requests.length;
    const ack = await run(["ack", "testid123456"]);
    expect(ack.code).toBe(0);
    // ack is purely local: it must not hit the server.
    expect(requests.length).toBe(requestsBefore);

    const after = manifest().artifacts[0].snapshot["src/main.ts"];
    expect(after).not.toBe(before);

    const clean = await run(["status"]);
    expect(clean.code).toBe(0);
  });

  it("fails on an unknown id", async () => {
    await run(["create", "report.html", "--favicon", "📊"]);
    const result = await run(["ack", "nope"], { expectFailure: true });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("not found");
  });

  it("requires an id", async () => {
    const result = await run(["ack"], { expectFailure: true });
    expect(result.code).not.toBe(0);
  });
});

describe("auto-update", () => {
  it("toggles on for one artifact without affecting another (isolation)", async () => {
    nextResponse = {
      status: 201,
      body: {
        id: "artifact-a",
        url: "http://example.invalid/a/artifact-a",
        writeToken: `wt_${"a".repeat(43)}`,
        version: 1,
      },
    };
    await run(["create", "report.html", "--favicon", "📊"]);
    nextResponse = {
      status: 201,
      body: {
        id: "artifact-b",
        url: "http://example.invalid/a/artifact-b",
        writeToken: `wt_${"b".repeat(43)}`,
        version: 1,
      },
    };
    await run(["create", "report.html", "--favicon", "📊"]);

    await run(["auto-update", "artifact-a", "on"]);

    const entries = manifest().artifacts;
    expect(entries.find((a) => a.id === "artifact-a")?.autoUpdate).toBe(true);
    expect(entries.find((a) => a.id === "artifact-b")?.autoUpdate).toBeFalsy();
  });

  it("installs the Stop hook when turned on inside a session", async () => {
    await run(["create", "report.html", "--favicon", "📊"]);
    const id = manifest().artifacts[0].id;

    const { code, stderr } = await runEnv(
      ["auto-update", id, "on"],
      projectDir,
      { CLAUDE_PROJECT_DIR: projectDir },
    );
    expect(code).toBe(0);
    expect(stderr).toContain("auto-update enabled");
    expect(stderr).toContain("installed Stop hook");

    const settings = JSON.parse(
      readFileSync(join(projectDir, ".claude/settings.json"), "utf8"),
    );
    expect(settings.hooks?.Stop?.[0]?.hooks?.[0]?.command).toContain(
      "status --hook",
    );
    expect(manifest().artifacts[0].autoUpdate).toBe(true);
  });

  it("does not reinstall the hook if already installed (idempotent)", async () => {
    await run(["create", "report.html", "--favicon", "📊"]);
    const id = manifest().artifacts[0].id;
    await runEnv(["install-hook"], projectDir, {
      CLAUDE_PROJECT_DIR: projectDir,
    });

    const { stderr } = await runEnv(["auto-update", id, "on"], projectDir, {
      CLAUDE_PROJECT_DIR: projectDir,
    });
    expect(stderr).toContain("already installed");
    const settings = JSON.parse(
      readFileSync(join(projectDir, ".claude/settings.json"), "utf8"),
    );
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it("turning off does not uninstall an already-installed hook", async () => {
    await run(["create", "report.html", "--favicon", "📊"]);
    const id = manifest().artifacts[0].id;
    await runEnv(["auto-update", id, "on"], projectDir, {
      CLAUDE_PROJECT_DIR: projectDir,
    });

    const { code, stderr } = await run(["auto-update", id, "off"]);
    expect(code).toBe(0);
    expect(stderr).toContain("auto-update disabled");
    expect(manifest().artifacts[0].autoUpdate).toBe(false);
    const settings = JSON.parse(
      readFileSync(join(projectDir, ".claude/settings.json"), "utf8"),
    );
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it("fails to turn on without a write token for that artifact", async () => {
    await run(["create", "report.html", "--favicon", "📊"]);
    const id = manifest().artifacts[0].id;
    // Simulate a teammate who cloned the repo: manifest.json is committed,
    // credentials.json (gitignored) is not.
    writeFileSync(
      join(projectDir, ".artifacts/credentials.json"),
      JSON.stringify({ tokens: {} }),
    );
    const result = await run(["auto-update", id, "on"], {
      expectFailure: true,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("no write token");
    expect(manifest().artifacts[0].autoUpdate).toBeFalsy();
  });

  it("fails on an unknown id", async () => {
    await run(["create", "report.html", "--favicon", "📊"]);
    const result = await run(["auto-update", "nope", "on"], {
      expectFailure: true,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("not found");
  });

  it("fails on an invalid mode argument", async () => {
    await run(["create", "report.html", "--favicon", "📊"]);
    const id = manifest().artifacts[0].id;
    const result = await run(["auto-update", id, "maybe"], {
      expectFailure: true,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('"on" or "off"');
  });

  it("requires an id and a mode", async () => {
    const noId = await run(["auto-update"], { expectFailure: true });
    expect(noId.code).not.toBe(0);

    await run(["create", "report.html", "--favicon", "📊"]);
    const id = manifest().artifacts[0].id;
    const noMode = await run(["auto-update", id], { expectFailure: true });
    expect(noMode.code).not.toBe(0);
  });
});
