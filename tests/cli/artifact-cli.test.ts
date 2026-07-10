import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

interface RecipeOptions {
  title?: string;
  format?: "html" | "markdown";
  canvas?: boolean;
  body?: string;
  channel?: string | null;
  watch?: string[];
  local?: boolean;
  encrypted?: boolean;
  autoUpdate?: boolean;
  mutate?: (recipe: TestRecipe) => void;
}

interface TestRecipe {
  version: number;
  artifact: Record<string, unknown>;
  document: {
    language: string;
    theme: string;
    fragments: {
      theme: string[];
      styles: string[];
      body: string[];
      scripts: string[];
    };
  };
  security: {
    encrypted: boolean;
    passwordCredential: string | null;
  };
  build: { strategy: string };
}

interface ManifestEntry {
  id: string;
  version: number;
  recipe?: string;
  strategy?: string;
  recipeHash?: string;
  inputHash?: string;
  outputHash?: string;
  autoUpdate?: boolean;
  title?: string;
  migrationPending?: boolean;
}

interface ManifestState {
  manifestVersion?: number;
  artifacts: ManifestEntry[];
}

interface CredentialsState {
  tokens?: Record<string, string>;
  channels?: Record<string, string>;
  namedPasswords?: Record<string, string>;
}

let server: Server;
let apiUrl: string;
const requests: RecordedRequest[] = [];
let nextResponse: { status: number; body: Record<string, unknown> } | null =
  null;
let nextRaw: { contentType: string; body: string } | null = null;
let projectDir: string;

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
      if (req.method === "GET" && (req.url ?? "").includes("/raw")) {
        const preset = nextRaw ?? {
          contentType: "text/plain; charset=utf-8",
          body: '<title>Published</title><style>:root{--accent:blue}:root[data-theme="dark"]{--accent:cyan}</style><h1>Published</h1>',
        };
        nextRaw = null;
        res.writeHead(200, { "content-type": preset.contentType });
        res.end(preset.body);
        return;
      }
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
  if (address === null || typeof address === "string") {
    throw new Error("no port");
  }
  apiUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  requests.length = 0;
  nextResponse = null;
  nextRaw = null;
  projectDir = mkdtempSync(join(tmpdir(), "oa-cli-"));
  mkdirSync(join(projectDir, ".git"));
  mkdirSync(join(projectDir, "src"));
  writeFileSync(join(projectDir, "src/main.ts"), "export const x = 1;\n");
  writeFileSync(
    join(projectDir, "report.html"),
    "<title>Legacy</title><h1>Legacy</h1>",
  );
});

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  return env;
}

async function run(
  args: string[],
  options: { expectFailure?: boolean; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [SCRIPT, ...args],
      {
        cwd: projectDir,
        env: {
          ...cleanEnv(),
          OPEN_ARTIFACTS_URL: apiUrl,
          ...options.env,
        },
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

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function manifest(local = false): ManifestState {
  const path = join(
    projectDir,
    local ? ".artifacts/manifest.local.json" : ".artifacts/manifest.json",
  );
  return existsSync(path) ? readJson<ManifestState>(path) : { artifacts: [] };
}

function credentials(): CredentialsState {
  const path = join(projectDir, ".artifacts/credentials.json");
  return existsSync(path) ? readJson<CredentialsState>(path) : {};
}

function validCanvasBody(): string {
  return `<div class="oa-canvas" id="canvas"><div class="oa-plane" id="plane">
<svg class="oa-connectors"><path d="M0 0L100 0" data-from="first" data-to="second"/></svg>
<section class="oa-frame" id="first" data-tour="1" style="--x:0;--y:0;--w:390;--h:844"><button class="oa-frame-label">First</button><div class="oa-frame-body" inert>First</div></section>
<section class="oa-frame" id="second" data-tour="2" style="--x:510;--y:0;--w:390;--h:844"><button class="oa-frame-label">Second</button><div class="oa-frame-body" inert>Second</div></section>
</div></div>`;
}

function writeRecipe(
  name = "report",
  options: RecipeOptions = {},
): { recipePath: string; bodyPath: string; themePath: string } {
  const format = options.format ?? "html";
  const isPrivate = options.local === true || options.encrypted === true;
  const recipeDir = join(
    projectDir,
    isPrivate ? ".artifacts/recipes.local" : "recipes",
  );
  const fragmentDir = join(
    projectDir,
    isPrivate
      ? `.artifacts/fragments.local/${name}`
      : `recipes/${name}-fragments`,
  );
  mkdirSync(recipeDir, { recursive: true });
  mkdirSync(fragmentDir, { recursive: true });
  const bodyPath = join(
    fragmentDir,
    format === "markdown" ? "body.md" : "body.html",
  );
  const themePath = join(fragmentDir, "theme.css");
  const body =
    options.body ??
    (options.canvas
      ? validCanvasBody()
      : format === "markdown"
        ? "# Recipe report\n\nDeterministic Markdown.\n"
        : '<main class="report"><h1>Recipe report</h1></main>');
  writeFileSync(bodyPath, body.endsWith("\n") ? body : `${body}\n`);
  if (format === "html") {
    writeFileSync(
      themePath,
      ':root{--accent:oklch(55% .15 250)}\n:root[data-theme="dark"]{--accent:oklch(72% .14 250)}\n',
    );
  }
  const relativePrefix = isPrivate
    ? `../fragments.local/${name}`
    : `${name}-fragments`;
  const recipe: TestRecipe = {
    version: 1,
    artifact: {
      title: options.title ?? "Recipe report",
      description: "Deterministic test artifact",
      favicon: "📊",
      format,
      level: options.canvas ? 2 : 1,
      canvas: options.canvas ?? false,
      channel: options.channel ?? null,
      scope: "Recipe CLI tests",
      watch: options.watch ?? [],
      local: options.local ?? false,
      autoUpdate: options.autoUpdate ?? false,
    },
    document: {
      language: "en",
      theme: "test-direction",
      fragments: {
        theme: format === "html" ? [`${relativePrefix}/theme.css`] : [],
        styles: [],
        body: [
          `${relativePrefix}/${format === "markdown" ? "body.md" : "body.html"}`,
        ],
        scripts: [],
      },
    },
    security: {
      encrypted: options.encrypted ?? false,
      passwordCredential: options.encrypted ? "report-password" : null,
    },
    build: { strategy: "auto" },
  };
  options.mutate?.(recipe);
  const recipePath = join(recipeDir, `${name}.recipe.json`);
  writeJson(recipePath, recipe);
  return { recipePath, bodyPath, themePath };
}

function seedLegacyManifest(overrides: Record<string, unknown> = {}): void {
  writeJson(join(projectDir, ".artifacts/manifest.json"), {
    artifacts: [
      {
        id: "testid123456",
        url: `${apiUrl}/a/testid123456`,
        title: "Published",
        favicon: "📄",
        format: "html",
        encrypted: false,
        scope: "Legacy report",
        channel: null,
        level: 1,
        canvas: false,
        watch: ["src/**"],
        snapshot: {},
        version: 1,
        autoUpdate: false,
        ...overrides,
      },
    ],
  });
  writeJson(join(projectDir, ".artifacts/credentials.json"), {
    tokens: { testid123456: `wt_${"x".repeat(43)}` },
  });
}

describe("Recipe builder", () => {
  it("validates deterministically without writing state", async () => {
    const { recipePath } = writeRecipe();
    const first = await run(["validate", recipePath]);
    const second = await run(["validate", recipePath]);

    expect(JSON.parse(first.stdout)).toEqual(JSON.parse(second.stdout));
    expect(JSON.parse(first.stdout)).toMatchObject({
      strategy: "direct",
      format: "html",
      canvas: false,
      fragments: 2,
    });
    expect(existsSync(join(projectDir, ".artifacts"))).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it("builds an explicit standalone Canvas preview with one injected control cluster", async () => {
    const { recipePath } = writeRecipe("flow", { canvas: true });
    const output = join(projectDir, "flow-preview.html");

    await run(["build", recipePath, "--output", output, "--standalone"]);

    const html = readFileSync(output, "utf8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('id="canvas"');
    expect(html).toContain('id="zoom-pct"');
    expect(html).toContain('id="tour-status"');
    expect(html.match(/class="oa-zoom"/g)).toHaveLength(1);
    expect(html).toContain("const FRICTION");
    expect(requests).toHaveLength(0);
  });

  it("refuses to overwrite a Recipe through a preview symlink", async () => {
    const { recipePath } = writeRecipe("preview-alias");
    const alias = join(projectDir, "preview-alias.json");
    const before = readFileSync(recipePath, "utf8");
    symlinkSync(recipePath, alias);

    const result = await run(["build", recipePath, "--output", alias], {
      expectFailure: true,
    });

    expect(result.stderr).toContain("cannot overwrite the recipe");
    expect(readFileSync(recipePath, "utf8")).toBe(before);
  });

  it("rejects direct HTML publishing", async () => {
    const result = await run(["create", "report.html"], {
      expectFailure: true,
    });

    expect(result.stderr).toContain("direct HTML/Markdown publishing");
    expect(requests).toHaveLength(0);
  });

  it("rejects unknown Recipe keys and CSP-incompatible APIs", async () => {
    const unknown = writeRecipe("unknown", {
      mutate: (recipe) => {
        recipe.artifact.surprise = true;
      },
    });
    const unknownResult = await run(["validate", unknown.recipePath], {
      expectFailure: true,
    });
    expect(unknownResult.stderr).toContain("artifact.surprise");

    const unsafe = writeRecipe("unsafe", {
      body: "<main><h1>Unsafe</h1><button onclick=\"fetch('/secret')\">Load</button></main>",
    });
    const unsafeResult = await run(["validate", unsafe.recipePath], {
      expectFailure: true,
    });
    expect(unsafeResult.stderr).toContain("fetch()");
    expect(requests).toHaveLength(0);
  });

  it("rejects project traversal and symlink escapes", async () => {
    const traversal = writeRecipe("traversal", {
      mutate: (recipe) => {
        recipe.document.fragments.body = ["../../../outside.html"];
      },
    });
    const traversalResult = await run(["validate", traversal.recipePath], {
      expectFailure: true,
    });
    expect(traversalResult.stderr).toContain("escapes the project root");

    const outsideDir = mkdtempSync(join(tmpdir(), "oa-outside-"));
    const outside = join(outsideDir, "body.html");
    writeFileSync(outside, "<h1>Outside</h1>");
    const escaped = writeRecipe("symlink");
    const link = join(dirname(escaped.bodyPath), "linked.html");
    symlinkSync(outside, link);
    const recipe = readJson<TestRecipe>(escaped.recipePath);
    recipe.document.fragments.body = ["symlink-fragments/linked.html"];
    writeJson(escaped.recipePath, recipe);
    const symlinkResult = await run(["validate", escaped.recipePath], {
      expectFailure: true,
    });
    expect(symlinkResult.stderr).toContain("symlink escapes");

    const privacy = writeRecipe("privacy");
    const privateDirectory = join(
      projectDir,
      ".artifacts/fragments.local/private",
    );
    mkdirSync(privateDirectory, { recursive: true });
    const privateBody = join(privateDirectory, "body.html");
    writeFileSync(privateBody, "<h1>Private</h1>");
    const privateLink = join(dirname(privacy.bodyPath), "private.html");
    symlinkSync(privateBody, privateLink);
    const privacyRecipe = readJson<TestRecipe>(privacy.recipePath);
    privacyRecipe.document.fragments.body = ["privacy-fragments/private.html"];
    writeJson(privacy.recipePath, privacyRecipe);
    const privacyResult = await run(["validate", privacy.recipePath], {
      expectFailure: true,
    });
    expect(privacyResult.stderr).toContain(
      "shared Recipes cannot reference private fragments",
    );

    const watchSecret = join(dirname(projectDir), "watch-secret.txt");
    writeFileSync(watchSecret, "secret");
    const watchEscape = writeRecipe("watch-escape", {
      watch: ["[.][.]/watch-secret.txt"],
    });
    const watchResult = await run(["validate", watchEscape.recipePath], {
      expectFailure: true,
    });
    expect(watchResult.stderr).toContain(
      "artifact.watch resolves outside the project root",
    );
  });

  it("selects staged composition for a large fragment set", async () => {
    const built = writeRecipe("large");
    const recipe = readJson<TestRecipe>(built.recipePath);
    recipe.document.fragments.body = [];
    for (let index = 0; index < 25; index += 1) {
      const path = join(dirname(built.bodyPath), `section-${index}.html`);
      writeFileSync(path, `<section><h2>Section ${index}</h2></section>\n`);
      recipe.document.fragments.body.push(
        `large-fragments/section-${index}.html`,
      );
    }
    writeJson(built.recipePath, recipe);

    const result = await run(["validate", built.recipePath]);

    expect(JSON.parse(result.stdout).strategy).toBe("staged");
    expect(requests).toHaveLength(0);
  });

  it("rejects authored Canvas controls and invalid connector references", async () => {
    const controls = writeRecipe("controls", {
      canvas: true,
      body: `${validCanvasBody()}<div class="oa-zoom"></div>`,
    });
    const controlsResult = await run(["validate", controls.recipePath], {
      expectFailure: true,
    });
    expect(controlsResult.stderr).toContain("controls are injected");

    const connector = writeRecipe("connector", {
      canvas: true,
      body: validCanvasBody().replace('data-to="second"', 'data-to="missing"'),
    });
    const connectorResult = await run(["validate", connector.recipePath], {
      expectFailure: true,
    });
    expect(connectorResult.stderr).toContain("unknown frame");

    const outsideFrame = writeRecipe("outside-frame", {
      canvas: true,
      body: `${validCanvasBody()}
<section class="oa-frame" id="outside" style="--x:0;--y:0;--w:390;--h:844"></section>`,
    });
    const outsideResult = await run(["validate", outsideFrame.recipePath], {
      expectFailure: true,
    });
    expect(outsideResult.stderr).toContain("nested inside #plane");

    const template = writeRecipe("template-frame", {
      canvas: true,
      body: `<div class="oa-canvas" id="canvas"><div class="oa-plane" id="plane"><template>${validCanvasBody()}</template></div></div>`,
    });
    const templateResult = await run(["validate", template.recipePath], {
      expectFailure: true,
    });
    expect(templateResult.stderr).toContain("cannot contain template elements");
  });
});

describe("Recipe publishing", () => {
  it("creates from one in-memory build and writes Manifest v2 after success", async () => {
    const { recipePath } = writeRecipe();

    const result = await run(["create", recipePath]);

    expect(result.stdout.trim()).toBe(`${apiUrl}/a/testid123456`);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: "/api/artifacts",
    });
    expect(requests[0].body.content).toContain("@layer oa-tokens");
    expect(requests[0].body.content).toContain("Recipe report");
    const state = manifest();
    expect(state.manifestVersion).toBe(2);
    expect(state.artifacts[0]).toMatchObject({
      id: "testid123456",
      version: 1,
      recipe: "recipes/report.recipe.json",
      strategy: "direct",
    });
    expect(state.artifacts[0].recipeHash).toMatch(/^sha256:/);
    expect(state.artifacts[0].inputHash).toMatch(/^sha256:/);
    expect(state.artifacts[0].outputHash).toMatch(/^sha256:/);
    expect(state.artifacts[0].title).toBeUndefined();
    expect(credentials().tokens?.testid123456).toMatch(/^wt_/);
  });

  it("reuses a Recipe channel token across create calls", async () => {
    const { recipePath } = writeRecipe("channel", { channel: "release-map" });

    await run(["create", recipePath]);
    await run(["create", recipePath]);

    expect(requests).toHaveLength(2);
    expect(requests[0].body.channel).toMatch(/^ch_/);
    expect(requests[1].body.channel).toBe(requests[0].body.channel);
    expect(credentials().channels?.["release-map"]).toBe(
      requests[0].body.channel,
    );
    expect(manifest().artifacts).toHaveLength(1);
  });

  it("does not write Manifest state when publication fails", async () => {
    const { recipePath } = writeRecipe();
    nextResponse = { status: 400, body: { error: "bad request" } };

    const result = await run(["create", recipePath], { expectFailure: true });

    expect(result.stderr).toContain("create failed (400)");
    expect(manifest().artifacts).toHaveLength(0);
  });

  it("updates from the Manifest Recipe with optimistic versioning", async () => {
    const built = writeRecipe();
    await run(["create", built.recipePath]);
    writeFileSync(
      built.bodyPath,
      '<main class="report"><h1>Recipe report v2</h1></main>\n',
    );

    await run(["update", "testid123456"]);

    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      method: "PUT",
      path: "/api/artifacts/testid123456",
    });
    expect(requests[1].body.baseVersion).toBe(1);
    expect(requests[1].body.content).toContain("Recipe report v2");
    expect(manifest().artifacts[0].version).toBe(2);
  });

  it("keeps Manifest hashes unchanged on a version conflict", async () => {
    const built = writeRecipe();
    await run(["create", built.recipePath]);
    const before = manifest();
    writeFileSync(built.bodyPath, "<main><h1>Conflicting update</h1></main>\n");
    nextResponse = {
      status: 409,
      body: { error: "conflict", currentVersion: 5 },
    };

    const result = await run(["update", "testid123456"], {
      expectFailure: true,
    });

    expect(result.stderr).toContain("version conflict");
    expect(manifest()).toEqual(before);
  });

  it("keeps encrypted Recipes private and resolves a named password", async () => {
    const { recipePath } = writeRecipe("secret", {
      local: true,
      encrypted: true,
    });

    await run(["create", recipePath], {
      env: { OPEN_ARTIFACTS_PASSWORD_REPORT_PASSWORD: "correct horse" },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].body.encrypted).toMatchObject({
      iterations: 600_000,
    });
    expect(requests[0].body.content).not.toContain("Recipe report");
    expect(manifest(true).manifestVersion).toBe(2);
    expect(manifest().artifacts).toHaveLength(0);
    expect(credentials().namedPasswords?.["report-password"]).toBe(
      "correct horse",
    );
    const ignore = readFileSync(join(projectDir, ".gitignore"), "utf8");
    expect(ignore).toContain(".artifacts/recipes.local/");
    expect(ignore).toContain(".artifacts/fragments.local/");
    expect(readFileSync(recipePath, "utf8")).not.toContain("correct horse");
  });

  it("rejects encrypted Recipes outside private source directories", async () => {
    const built = writeRecipe("misplaced");
    const recipe = readJson<TestRecipe>(built.recipePath);
    recipe.security = {
      encrypted: true,
      passwordCredential: "report-password",
    };
    writeJson(built.recipePath, recipe);

    const result = await run(["create", built.recipePath, "--password", "x"], {
      expectFailure: true,
    });

    expect(result.stderr).toContain("recipes.local");
    expect(requests).toHaveLength(0);

    const privateShared = writeRecipe("private-shared", { local: true });
    const privateRecipe = readJson<TestRecipe>(privateShared.recipePath);
    privateRecipe.artifact.local = false;
    writeJson(privateShared.recipePath, privateRecipe);
    const privateResult = await run(["validate", privateShared.recipePath], {
      expectFailure: true,
    });
    expect(privateResult.stderr).toContain(
      "shared Recipes cannot live under .artifacts/recipes.local",
    );
  });

  it("reads Recipe watch metadata for status and ack", async () => {
    const built = writeRecipe("watched", { watch: ["src/**"] });
    await run(["create", built.recipePath]);
    writeFileSync(join(projectDir, "src/main.ts"), "export const x = 2;\n");

    const stale = await run(["status"], { expectFailure: true });
    expect(stale.stdout).toContain("stale: testid123456 Recipe report");
    expect(stale.stdout).toContain("src/main.ts");

    await run(["ack", "testid123456"]);
    const clean = await run(["status"]);
    expect(clean.stderr).toContain("all artifacts are up to date");
  });

  it("reads Manifest v1 without mutating it", async () => {
    seedLegacyManifest();
    const path = join(projectDir, ".artifacts/manifest.json");
    const before = readFileSync(path, "utf8");

    const result = await run(["list"]);

    expect(result.stdout).toContain("Published");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("migrates a legacy entry on first update and publishes once", async () => {
    seedLegacyManifest();

    await run(["update", "testid123456"]);

    expect(requests.map((request) => request.method)).toEqual(["GET", "PUT"]);
    const state = manifest();
    expect(state.manifestVersion).toBe(2);
    expect(state.artifacts[0].recipe).toMatch(
      /^\.artifacts\/recipes\/published-/,
    );
    expect(state.artifacts[0].migrationPending).toBeUndefined();
    expect(existsSync(join(projectDir, state.artifacts[0].recipe ?? ""))).toBe(
      true,
    );
    expect(requests[1].body.content).toContain("Published");
  });

  it("migrates nested legacy Canvas controls without duplicating the runtime", async () => {
    seedLegacyManifest({ canvas: true, level: 2 });
    nextRaw = {
      contentType: "text/plain; charset=utf-8",
      body: `<title>Legacy Canvas</title>
<style>
:root{--accent:blue}:root[data-theme="dark"]{--accent:cyan}
/* Viewport. Sized to the visible area below the service header. */
.oa-canvas{overflow:hidden}
</style>
${validCanvasBody()}
<div class="oa-zoom">
  <div class="oa-tour"><button id="tour-next">Legacy next</button></div>
  <button id="zoom-out">Legacy zoom</button>
</div>
<script>
const authored = 1;
(function () {
  const canvas = document.getElementById("canvas");
  canvas.dataset.legacy = "true";
})();
</script>`,
    };

    await run(["update", "testid123456"]);

    expect(requests.map((request) => request.method)).toEqual(["GET", "PUT"]);
    const content = String(requests[1].body.content);
    expect(content.match(/class="oa-zoom"/g)).toHaveLength(1);
    expect(content).toContain("open-artifacts:canvas-js:start");
    expect(content).toContain("const authored = 1");
    expect(content).not.toContain("Legacy zoom");
    expect(content).not.toContain("dataset.legacy");
  });

  it("updates Recipe autoUpdate metadata with the operational toggle", async () => {
    const built = writeRecipe();
    await run(["create", built.recipePath]);

    await run(["auto-update", "testid123456", "on"], {
      env: { CLAUDE_PROJECT_DIR: projectDir },
    });

    expect(readJson<TestRecipe>(built.recipePath).artifact.autoUpdate).toBe(
      true,
    );
    expect(manifest().artifacts[0].autoUpdate).toBe(true);
    expect(existsSync(join(projectDir, ".claude/settings.json"))).toBe(true);
  });
});
