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
  "../../skills/artifacts/scripts/artifact.mjs",
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
        env: { ...process.env, OPEN_ARTIFACTS_URL: apiUrl },
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
      { cwd, env: { ...process.env, ...env } },
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

function manifest(): {
  artifacts: Array<{
    id: string;
    version: number;
    watch: string[];
    snapshot: Record<string, string>;
    scope: string | null;
    channel: string | null;
    encrypted: boolean;
  }>;
} {
  return JSON.parse(
    readFileSync(join(projectDir, ".artifacts/manifest.json"), "utf8"),
  );
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

    await run(["update", "testid123456"]);

    const put = requests[1];
    expect(put.method).toBe("PUT");
    expect(put.path).toBe("/api/artifacts/testid123456");
    expect(put.auth).toBe(`Bearer wt_${"x".repeat(43)}`);
    expect(put.body.baseVersion).toBe(1);
    expect(put.body.content).toContain("Report v2");

    const entry = manifest().artifacts[0];
    expect(entry.version).toBe(2);
  });

  it("reports a version conflict with guidance", async () => {
    await run(["create", "report.html", "--favicon", "📊"]);
    nextResponse = {
      status: 409,
      body: { error: "conflict", currentVersion: 5 },
    };
    const result = await run(["update", "testid123456"], {
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
