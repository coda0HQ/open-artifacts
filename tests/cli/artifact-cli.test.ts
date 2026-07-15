import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const itUnix = platform() === "win32" ? it.skip : it;

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
    theme: string | null;
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
          body: '<title>Published</title><style>:root{--accent:blue}:root[data-theme="dark"]{--accent:cyan}main{max-width:72ch;margin-inline:auto;padding:2rem}</style><main><h1>Published</h1></main>',
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
<section class="oa-frame" id="first" data-tour="1" style="--x:0;--y:0;--w:390;--h:844"><button class="oa-frame-label" type="button">First</button><div class="oa-frame-body" inert>First</div></section>
<section class="oa-frame" id="second" data-tour="2" style="--x:510;--y:0;--w:390;--h:844"><button class="oa-frame-label" type="button">Second</button><div class="oa-frame-body" inert>Second</div></section>
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
        : '<main class="oa-prose"><h1>Recipe report</h1></main>');
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
    expect(html).toContain("const TAP_SLOP");
    expect(html).toContain("TAP_SLOP + 1");
    expect(html).toContain("const SPOT_DIM");
    expect(html).toContain("--spot-dim-frame");
    expect(html).toContain("focus(frame, true)");
    expect(html).toContain("function tap(");
    expect(html).toContain("function closestCrossing(");
    expect(html).toContain("function eventDeepTarget(");
    expect(html).toContain("pressTarget = deep");
    expect(html).toContain("function isPointerControl(");
    expect(html).toContain("oa-frame-label");
    expect(html).toContain("clickConsumed");
    expect(html).toContain('canvas.addEventListener("click"');
    expect(html).toContain("rubber(rawK - MIN, 1)");
    expect(html).toContain("rubber(rawK - MAX, 1)");
    expect(html).toContain('contenteditable]:not([contenteditable="false"])');
    expect(html).toContain("translateY(1px)");
    expect(html).toContain("fitTo(box(focused), 0)");
    expect(html).not.toContain('closest(".oa-frame") === focused');
    expect(html).toMatch(/(?<!-webkit-)user-select:\s*none/);
    expect(html).toContain(
      '.oa-frame[data-focused] .oa-frame-body :is(input, textarea, select, [contenteditable]:not([contenteditable="false"]))',
    );
    expect(html).not.toMatch(
      /\.oa-frame\[data-focused\]\s+\.oa-frame-body\s*\{[^}]*user-select/,
    );
    expect(html).toMatch(/touch-action:\s*auto/);
    expect(html).toMatch(
      /@media\s*\(max-width:\s*640px\)[\s\S]*?\.oa-canvas\s*\{[^}]*user-select:\s*auto/,
    );
    expect(html).toContain("@media (prefers-reduced-motion: reduce)");
    expect(html).toContain("--focus-ring:");
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

  it("requires unlayered light and dark theme blocks", async () => {
    const missingDark = writeRecipe("missing-dark-theme");
    writeFileSync(missingDark.themePath, ":root{--accent:blue}\n");
    const missingDarkResult = await run(["validate", missingDark.recipePath], {
      expectFailure: true,
    });
    expect(missingDarkResult.stderr).toContain(
      ':root[data-theme="dark"] block',
    );

    const layered = writeRecipe("layered-theme");
    writeFileSync(
      layered.themePath,
      '@layer direction{:root{--accent:blue}:root[data-theme="dark"]{--accent:cyan}}\n',
    );
    const layeredResult = await run(["validate", layered.recipePath], {
      expectFailure: true,
    });
    expect(layeredResult.stderr).toContain("theme fragments must be unlayered");
  });

  it("fails when a container class is defined but never applied", async () => {
    const orphan = writeRecipe("orphan-shell", {
      body: "<main><h1>Orphan</h1><p>No shell wrapper here.</p></main>\n",
    });
    writeFileSync(
      orphan.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n.shell{max-width:880px;margin:0 auto}\n',
    );
    const result = await run(["validate", orphan.recipePath], {
      expectFailure: true,
    });
    expect(result.stderr).toContain('container class ".shell" with max-width');
    expect(requests).toHaveLength(0);
  });

  it("passes when an applied container class carries max-width", async () => {
    const applied = writeRecipe("applied-container", {
      body: '<main class="report"><h1>Report</h1></main>\n',
    });
    writeFileSync(
      applied.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n.report{max-width:72ch;margin:0 auto}\n',
    );
    const result = await run(["validate", applied.recipePath]);
    expect(result.code).toBe(0);
  });

  it("passes a max-width class applied only via JS (L2 rendered body)", async () => {
    const scriptsDir = join(projectDir, "js-container-fragments");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(
      join(scriptsDir, "behavior.js"),
      'const cell = document.createElement("div"); cell.className = "dur-bar";\ndocument.querySelector("main").append(cell);\n',
    );
    const recipe = writeRecipe("js-container", {
      mutate: (r) => {
        r.artifact.level = 2;
        r.document.fragments.scripts = [
          "../js-container-fragments/behavior.js",
        ];
      },
      body: "<main><h1>JS render</h1></main>\n",
    });
    writeFileSync(
      recipe.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n.dur-bar{max-width:96px}\n',
    );
    const result = await run(["validate", recipe.recipePath]);
    expect(result.code).toBe(0);
  });

  it("fails a max-width class defined but never applied even in scripts", async () => {
    const orphan = writeRecipe("orphan-js-shell", {
      mutate: (r) => {
        r.artifact.level = 2;
      },
      body: "<main><h1>No shell</h1></main>\n",
    });
    writeFileSync(
      orphan.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n.shell{max-width:880px}\n',
    );
    const result = await run(["validate", orphan.recipePath], {
      expectFailure: true,
    });
    expect(result.stderr).toContain('container class ".shell"');
    expect(requests).toHaveLength(0);
  });

  it("passes when max-width is set on body, not a class", async () => {
    const bodyContainer = writeRecipe("body-container", {
      body: "<main><h1>Body measure</h1></main>\n",
    });
    writeFileSync(
      bodyContainer.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\nbody{max-width:880px;margin:0 auto}\n',
    );
    const result = await run(["validate", bodyContainer.recipePath]);
    expect(result.code).toBe(0);
  });

  it("rejects a level 1 page with no measure cap and points to .oa-prose", async () => {
    const bare = writeRecipe("bare-l1", {
      body: "<main><h1>Bare</h1><p>No measure cap anywhere.</p></main>\n",
    });
    writeFileSync(
      bare.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n',
    );
    const result = await run(["validate", bare.recipePath], {
      expectFailure: true,
    });
    expect(result.stderr).toContain("level 1 HTML documents must constrain");
    expect(result.stderr).toContain("oa-prose");
    expect(requests).toHaveLength(0);
  });

  it("passes a level 1 page using the .oa-prose baseline", async () => {
    const prose = writeRecipe("prose-l1", {
      body: '<main class="oa-prose"><h1>Prose</h1><p>Baseline.</p></main>\n',
    });
    writeFileSync(
      prose.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n',
    );
    const result = await run(["validate", prose.recipePath]);
    expect(result.code).toBe(0);
  });

  it("passes a level 2 page with no measure cap (guard is L1-only)", async () => {
    const bareL2 = writeRecipe("bare-l2", {
      mutate: (recipe) => {
        recipe.artifact.level = 2;
      },
      body: "<main><h1>Bare L2</h1></main>\n",
    });
    writeFileSync(
      bareL2.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n',
    );
    const result = await run(["validate", bareL2.recipePath]);
    expect(result.code).toBe(0);
  });

  it("rejects a start tag carrying style= twice and tells the author to merge", async () => {
    const dupStyle = writeRecipe("dup-style", {
      mutate: (recipe) => {
        recipe.artifact.level = 2;
      },
      body: '<main><h1 style="--i:1" style="margin-top:2rem">Cascade</h1></main>\n',
    });
    writeFileSync(
      dupStyle.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n',
    );
    const result = await run(["validate", dupStyle.recipePath], {
      expectFailure: true,
    });
    expect(result.stderr).toContain("style=");
    expect(result.stderr).toContain("only once");
    expect(result.stderr).toContain('style="--i:1"');
    expect(requests).toHaveLength(0);
  });

  it("passes a start tag with a single style attribute", async () => {
    const singleStyle = writeRecipe("single-style", {
      mutate: (recipe) => {
        recipe.artifact.level = 2;
      },
      body: '<main><h1 style="--i:1">Cascade</h1></main>\n',
    });
    writeFileSync(
      singleStyle.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n',
    );
    const result = await run(["validate", singleStyle.recipePath]);
    expect(result.code).toBe(0);
  });

  it("passes a CSP-forbidden token mentioned only in a comment", async () => {
    const scriptsDir = join(projectDir, "comment-csp-fragments");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(
      join(scriptsDir, "behavior.js"),
      "// no fetch (CSP blocks it anyway) and no WebSocket in this file\nconsole.log('safe');\n",
    );
    const recipe = writeRecipe("comment-csp", {
      mutate: (r) => {
        r.artifact.level = 2;
        r.document.fragments.scripts = ["../comment-csp-fragments/behavior.js"];
      },
      body: "<main><h1>Comment CSP</h1></main>\n",
    });
    writeFileSync(
      recipe.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n',
    );
    const result = await run(["validate", recipe.recipePath]);
    expect(result.code).toBe(0);
  });

  it("rejects a real fetch() call in executable code", async () => {
    const scriptsDir = join(projectDir, "real-csp-fragments");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(join(scriptsDir, "behavior.js"), "fetch('/secret');\n");
    const recipe = writeRecipe("real-csp", {
      mutate: (r) => {
        r.artifact.level = 2;
        r.document.fragments.scripts = ["../real-csp-fragments/behavior.js"];
      },
      body: "<main><h1>Real CSP</h1></main>\n",
    });
    writeFileSync(
      recipe.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n',
    );
    const result = await run(["validate", recipe.recipePath], {
      expectFailure: true,
    });
    expect(result.stderr).toContain("fetch()");
    expect(result.stderr).toContain("CSP");
    expect(requests).toHaveLength(0);
  });

  it("rejects a @font-face src that points at a remote host", async () => {
    const stylesDir = join(projectDir, "remote-font-fragments");
    mkdirSync(stylesDir, { recursive: true });
    writeFileSync(
      join(stylesDir, "styles.css"),
      '@font-face{font-family:"Evil";src:url("https://evil.example/font.woff2") format("woff2")}\n',
    );
    const recipe = writeRecipe("remote-font", {
      mutate: (r) => {
        r.artifact.level = 1;
        r.document.fragments.styles = ["../remote-font-fragments/styles.css"];
      },
      body: '<main class="oa-prose"><h1>Remote font</h1></main>\n',
    });
    const result = await run(["validate", recipe.recipePath], {
      expectFailure: true,
    });
    expect(result.stderr).toContain("@font-face");
    expect(result.stderr).toContain("/fonts/");
    expect(requests).toHaveLength(0);
  });

  it("accepts a @font-face src that points at the same-origin /fonts/ proxy", async () => {
    const stylesDir = join(projectDir, "proxy-font-fragments");
    mkdirSync(stylesDir, { recursive: true });
    writeFileSync(
      join(stylesDir, "styles.css"),
      '@font-face{font-family:"General Sans";src:url("/fonts/general-sans--400.woff2") format("woff2");font-display:swap}\n:root{--font-display:"General Sans",system-ui,sans-serif}\n',
    );
    const recipe = writeRecipe("proxy-font", {
      mutate: (r) => {
        r.artifact.level = 1;
        r.document.fragments.styles = ["../proxy-font-fragments/styles.css"];
      },
      body: '<main class="oa-prose"><h1>Proxy font</h1></main>\n',
    });
    const result = await run(["validate", recipe.recipePath]);
    expect(result.code).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it("accepts a @font-face src pointing at an allowlisted font CDN", async () => {
    const stylesDir = join(projectDir, "cdn-font-fragments");
    mkdirSync(stylesDir, { recursive: true });
    writeFileSync(
      join(stylesDir, "styles.css"),
      '@font-face{font-family:"Fraunces";src:url("https://fonts.gstatic.com/s/fraunces/v9/x.woff2") format("woff2");font-display:swap}\n:root{--font-display:"Fraunces",Georgia,serif}\n',
    );
    const recipe = writeRecipe("cdn-font", {
      mutate: (r) => {
        r.artifact.level = 1;
        r.document.fragments.styles = ["../cdn-font-fragments/styles.css"];
      },
      body: '<main class="oa-prose"><h1>CDN font</h1></main>\n',
    });
    const result = await run(["validate", recipe.recipePath]);
    expect(result.code).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it("accepts a Google Fonts @import (fonts.googleapis.com CSS)", async () => {
    const stylesDir = join(projectDir, "gfont-import-fragments");
    mkdirSync(stylesDir, { recursive: true });
    writeFileSync(
      join(stylesDir, "styles.css"),
      '@import url("https://fonts.googleapis.com/css2?family=Fraunces:wght@600&display=swap");\n:root{--font-display:"Fraunces",Georgia,serif}\n',
    );
    const recipe = writeRecipe("gfont-import", {
      mutate: (r) => {
        r.artifact.level = 1;
        r.document.fragments.styles = ["../gfont-import-fragments/styles.css"];
      },
      body: '<main class="oa-prose"><h1>Google Fonts</h1></main>\n',
    });
    const result = await run(["validate", recipe.recipePath]);
    expect(result.code).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it("accepts a same-origin @import of the /fonts proxy CSS shim", async () => {
    const stylesDir = join(projectDir, "fonts-proxy-import-fragments");
    mkdirSync(stylesDir, { recursive: true });
    writeFileSync(
      join(stylesDir, "styles.css"),
      '@import url("/fonts/general-sans--400.css");\n:root{--font-display:"General Sans",system-ui,sans-serif}\n',
    );
    const recipe = writeRecipe("fonts-proxy-import", {
      mutate: (r) => {
        r.artifact.level = 1;
        r.document.fragments.styles = [
          "../fonts-proxy-import-fragments/styles.css",
        ];
      },
      body: '<main class="oa-prose"><h1>Proxy import</h1></main>\n',
    });
    const result = await run(["validate", recipe.recipePath]);
    expect(result.code).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it("rejects a @font-face src pointing at a non-allowlisted host", async () => {
    const stylesDir = join(projectDir, "bad-cdn-font-fragments");
    mkdirSync(stylesDir, { recursive: true });
    writeFileSync(
      join(stylesDir, "styles.css"),
      '@font-face{font-family:"Evil";src:url("https://evil.example/font.woff2") format("woff2")}\n',
    );
    const recipe = writeRecipe("bad-cdn-font", {
      mutate: (r) => {
        r.artifact.level = 1;
        r.document.fragments.styles = ["../bad-cdn-font-fragments/styles.css"];
      },
      body: '<main class="oa-prose"><h1>Bad CDN font</h1></main>\n',
    });
    const result = await run(["validate", recipe.recipePath], {
      expectFailure: true,
    });
    expect(result.stderr).toContain("@font-face");
    expect(result.stderr).toContain("fonts.gstatic.com");
    expect(requests).toHaveLength(0);
  });

  it("rejects a remote <script src> in the body", async () => {
    const recipe = writeRecipe("remote-script", {
      mutate: (r) => {
        r.artifact.level = 1;
      },
      body: '<main><script src="https://evil.example/x.js"></script></main>\n',
    });
    const result = await run(["validate", recipe.recipePath], {
      expectFailure: true,
    });
    expect(result.stderr).toContain("script");
    expect(requests).toHaveLength(0);
  });

  it("rejects a non-allowlisted jsdelivr package in a <script src>", async () => {
    const recipe = writeRecipe("bad-pkg", {
      mutate: (r) => {
        r.artifact.level = 1;
      },
      body: '<main><pre class="d3"></pre><script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script></main>\n',
    });
    const result = await run(["validate", recipe.recipePath], {
      expectFailure: true,
    });
    expect(result.stderr).toContain("d3");
    expect(requests).toHaveLength(0);
  });

  it("accepts an allowlisted jsdelivr <script src> in the body", async () => {
    const recipe = writeRecipe("mermaid", {
      mutate: (r) => {
        r.artifact.level = 1;
      },
      body: '<main class="oa-prose"><pre class="mermaid">flowchart LR\nA-->B</pre><script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script></main>\n',
    });
    const result = await run(["validate", recipe.recipePath]);
    expect(result.code).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it("accepts valid mermaid syntax in <pre class=mermaid>", async () => {
    const recipe = writeRecipe("mermaid-ok", {
      mutate: (r) => {
        r.artifact.level = 1;
      },
      body:
        '<main class="oa-prose">\n' +
        '<pre class="mermaid">flowchart LR\nA-->B</pre>\n' +
        '<pre class="mermaid">sequenceDiagram\nparticipant A\nA->>B: hi</pre>\n' +
        '<pre class="mermaid">classDiagram\nclass A{+int x}</pre>\n' +
        "</main>\n",
    });
    const result = await run(["validate", recipe.recipePath]);
    expect(result.code).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it("rejects broken mermaid syntax at build time", async () => {
    const recipe = writeRecipe("mermaid-bad", {
      mutate: (r) => {
        r.artifact.level = 1;
      },
      body: '<main class="oa-prose"><pre class="mermaid">flowchart LR\nA->>B [[[</pre></main>\n',
    });
    const result = await run(["validate", recipe.recipePath], {
      expectFailure: true,
    });
    expect(result.stderr).toContain("mermaid syntax error");
    expect(result.stderr).toContain("Parse error");
    expect(requests).toHaveLength(0);
  });

  it("passes a CSP-forbidden API name mentioned only in a script string", async () => {
    const scriptsDir = join(projectDir, "string-csp-fragments");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(
      join(scriptsDir, "behavior.js"),
      'const note = "fetch(/refresh) is documented here but never called";\nconsole.log(note);\n',
    );
    const recipe = writeRecipe("string-csp", {
      mutate: (r) => {
        r.artifact.level = 2;
        r.document.fragments.scripts = ["../string-csp-fragments/behavior.js"];
      },
      body: "<main><h1>Docs</h1></main>\n",
    });
    writeFileSync(
      recipe.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n',
    );
    const result = await run(["validate", recipe.recipePath]);
    expect(result.code).toBe(0);
  });

  it("rejects a decorative side-stripe border-left > 1px", async () => {
    const stripe = writeRecipe("side-stripe", {
      mutate: (r) => {
        r.artifact.level = 2;
      },
    });
    writeFileSync(
      stripe.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n.card{border-left:3px solid var(--accent)}\n',
    );
    const result = await run(["validate", stripe.recipePath], {
      expectFailure: true,
    });
    expect(result.stderr).toContain("side-stripe");
    expect(result.stderr).toContain("border-left");
    expect(requests).toHaveLength(0);
  });

  it("passes a blockquote quote-bar border-left", async () => {
    const quoteBar = writeRecipe("quote-bar", {
      mutate: (r) => {
        r.artifact.level = 2;
      },
    });
    writeFileSync(
      quoteBar.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\nblockquote{border-left:3px solid var(--border)}\n',
    );
    const result = await run(["validate", quoteBar.recipePath]);
    expect(result.code).toBe(0);
  });

  it("rejects a gradient-text combo", async () => {
    const gradText = writeRecipe("gradient-text", {
      mutate: (r) => {
        r.artifact.level = 2;
      },
    });
    writeFileSync(
      gradText.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n.h1-grad{background:linear-gradient(90deg,#fff,#000);-webkit-background-clip:text;background-clip:text;color:transparent}\n',
    );
    const result = await run(["validate", gradText.recipePath], {
      expectFailure: true,
    });
    expect(result.stderr).toContain("gradient text");
    expect(requests).toHaveLength(0);
  });

  it("rejects a decorative backdrop-filter on a card", async () => {
    const glass = writeRecipe("glass-card", {
      mutate: (r) => {
        r.artifact.level = 2;
      },
    });
    writeFileSync(
      glass.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n.card{backdrop-filter:blur(10px);background:rgba(255,255,255,0.5)}\n',
    );
    const result = await run(["validate", glass.recipePath], {
      expectFailure: true,
    });
    expect(result.stderr).toContain("glassmorphism");
    expect(requests).toHaveLength(0);
  });

  it("passes a sanctioned floating-bar backdrop-filter", async () => {
    const floatingBar = writeRecipe("floating-bar", {
      mutate: (r) => {
        r.artifact.level = 2;
      },
    });
    writeFileSync(
      floatingBar.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n.toolbar{position:sticky;top:0;backdrop-filter:blur(10px)}\n',
    );
    const result = await run(["validate", floatingBar.recipePath]);
    expect(result.code).toBe(0);
  });

  it("rejects an enlarged callout box at --text-lg", async () => {
    const callout = writeRecipe("positioning", {
      mutate: (r) => {
        r.artifact.level = 2;
      },
    });
    writeFileSync(
      callout.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n.positioning{margin:1.5rem 0;padding:1rem 1.5rem;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-md);font-size:var(--text-lg);line-height:1.5}\n',
    );
    const result = await run(["validate", callout.recipePath], {
      expectFailure: true,
    });
    expect(result.stderr).toContain("enlarged callout");
    expect(result.stderr).toContain(".positioning");
    expect(requests).toHaveLength(0);
  });

  it("passes a callout box kept at --text-base", async () => {
    const callout = writeRecipe("positioning-base", {
      mutate: (r) => {
        r.artifact.level = 2;
      },
    });
    writeFileSync(
      callout.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n.positioning{margin:1.5rem 0;padding:1rem 1.5rem;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-md);font-size:var(--text-base);line-height:var(--leading-body)}\n',
    );
    const result = await run(["validate", callout.recipePath]);
    expect(result.code).toBe(0);
  });

  it("passes a --text-lg lead on a standfirst selector", async () => {
    const lead = writeRecipe("standfirst", {
      mutate: (r) => {
        r.artifact.level = 2;
      },
    });
    writeFileSync(
      lead.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n.standfirst{font-size:var(--text-lg);line-height:1.4}\n',
    );
    const result = await run(["validate", lead.recipePath]);
    expect(result.code).toBe(0);
  });

  it("passes a callout at 16px (body-size pixels, not oversized)", async () => {
    const pxCallout = writeRecipe("positioning-px", {
      mutate: (r) => {
        r.artifact.level = 2;
      },
    });
    writeFileSync(
      pxCallout.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n.positioning{padding:1rem;background:var(--surface);border:1px solid var(--border);font-size:16px;line-height:1.5}\n',
    );
    const result = await run(["validate", pxCallout.recipePath]);
    expect(result.code).toBe(0);
  });

  it("rejects a callout at var(--text-4xl) (display-tier token)", async () => {
    const big = writeRecipe("positioning-4xl", {
      mutate: (r) => {
        r.artifact.level = 2;
      },
    });
    writeFileSync(
      big.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n.positioning{padding:1rem;background:var(--surface);border:1px solid var(--border);font-size:var(--text-4xl)}\n',
    );
    const result = await run(["validate", big.recipePath], {
      expectFailure: true,
    });
    expect(result.stderr).toContain("enlarged callout");
    expect(requests).toHaveLength(0);
  });

  it("rejects a .card-title callout at --text-xl (generic title selector)", async () => {
    const cardTitle = writeRecipe("card-title", {
      mutate: (r) => {
        r.artifact.level = 2;
      },
    });
    writeFileSync(
      cardTitle.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n.card-title{font-size:var(--text-xl);font-weight:600}\n',
    );
    const result = await run(["validate", cardTitle.recipePath], {
      expectFailure: true,
    });
    expect(result.stderr).toContain("enlarged callout");
    expect(requests).toHaveLength(0);
  });

  it("passes a .page-title at var(--text-3xl) (sanctioned page title)", async () => {
    const pageTitle = writeRecipe("page-title", {
      mutate: (r) => {
        r.artifact.level = 2;
      },
    });
    writeFileSync(
      pageTitle.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n.page-title{font-size:var(--text-3xl)}\n',
    );
    const result = await run(["validate", pageTitle.recipePath]);
    expect(result.code).toBe(0);
  });

  it("passes a heading font-size inside @media (real selector, not the at-rule prelude)", async () => {
    const responsive = writeRecipe("responsive-heading", {
      mutate: (r) => {
        r.artifact.level = 2;
      },
    });
    writeFileSync(
      responsive.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n@media (min-width:768px){ h2 { font-size: var(--text-xl) } }\n',
    );
    const result = await run(["validate", responsive.recipePath]);
    expect(result.code).toBe(0);
  });

  it("rejects a heading with an inline icon but no centered-row layout", async () => {
    const crooked = writeRecipe("crooked-icon", {
      body: '<main class="oa-prose"><h2><svg viewBox="0 0 24 24" fill="currentColor"><path d="M11 7H13V9H11V7Z"/></svg> What it is</h2></main>\n',
    });
    const result = await run(["validate", crooked.recipePath], {
      expectFailure: true,
    });
    expect(result.stderr).toContain("not laid out as a centered row");
    expect(result.stderr).toContain("oa-ico-text");
    expect(requests).toHaveLength(0);
  });

  it("passes a heading whose icon uses the .oa-ico-text helper", async () => {
    const helper = writeRecipe("icon-helper", {
      body: '<main class="oa-prose"><h2 class="oa-ico-text"><svg class="oa-ico" viewBox="0 0 24 24" fill="currentColor"><path d="M11 7H13V9H11V7Z"/></svg> What it is</h2></main>\n',
    });
    const result = await run(["validate", helper.recipePath]);
    expect(result.code).toBe(0);
  });

  it("passes a heading centered by an authored flex rule", async () => {
    const authoredFlex = writeRecipe("icon-authored-flex", {
      body: '<main class="oa-prose"><section class="section"><h2><svg class="ico" viewBox="0 0 24 24" fill="currentColor"><path d="M11 7H13V9H11V7Z"/></svg> The request flow</h2></section></main>\n',
    });
    writeFileSync(
      authoredFlex.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n.section > h2{display:flex;align-items:center;gap:8px}\n',
    );
    const result = await run(["validate", authoredFlex.recipePath]);
    expect(result.code).toBe(0);
  });

  it("leaves headings with no inline icon untouched by the icon gate", async () => {
    const textOnly = writeRecipe("icon-none", {
      body: '<main class="oa-prose"><h2>Just text</h2><figure><svg viewBox="0 0 24 24" fill="currentColor"><path d="M11 7H13V9H11V7Z"/></svg></figure></main>\n',
    });
    const result = await run(["validate", textOnly.recipePath]);
    expect(result.code).toBe(0);
  });

  it("rejects a heading whose flex rule omits align-items:center", async () => {
    // display:flex alone defaults to align-items:stretch, dropping the fixed-
    // height icon at the top of the line — still crooked.
    const noAlign = writeRecipe("icon-flex-no-align", {
      body: '<main class="oa-prose"><h2><svg class="ico" viewBox="0 0 24 24" fill="currentColor"><path d="M11 7H13V9H11V7Z"/></svg> Title</h2></main>\n',
    });
    writeFileSync(
      noAlign.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\nh2{display:flex;gap:8px}\n',
    );
    const result = await run(["validate", noAlign.recipePath], {
      expectFailure: true,
    });
    expect(result.stderr).toContain("not laid out as a centered row");
    expect(requests).toHaveLength(0);
  });

  it("passes a heading centered by a flex rule nested in @media", async () => {
    const mediaFlex = writeRecipe("icon-media-flex", {
      body: '<main class="oa-prose"><h2 class="head"><svg class="ico" viewBox="0 0 24 24" fill="currentColor"><path d="M11 7H13V9H11V7Z"/></svg> Title</h2></main>\n',
    });
    writeFileSync(
      mediaFlex.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n@media (min-width:1px){.head{display:flex;align-items:center;gap:8px}}\n',
    );
    const result = await run(["validate", mediaFlex.recipePath]);
    expect(result.code).toBe(0);
  });

  it("passes a heading whose icon+label sit in an inner custom-flex span", async () => {
    const innerFlex = writeRecipe("icon-inner-flex", {
      body: '<main class="oa-prose"><h2><span class="row"><svg class="ico" viewBox="0 0 24 24" fill="currentColor"><path d="M11 7H13V9H11V7Z"/></svg> Title</span></h2></main>\n',
    });
    writeFileSync(
      innerFlex.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n.row{display:inline-flex;align-items:center;gap:8px}\n',
    );
    const result = await run(["validate", innerFlex.recipePath]);
    expect(result.code).toBe(0);
  });

  it("passes an icon-only heading with no adjacent text", async () => {
    const iconOnly = writeRecipe("icon-only-heading", {
      body: '<main class="oa-prose"><h2><svg class="oa-ico" viewBox="0 0 24 24" fill="currentColor"><path d="M11 7H13V9H11V7Z"/></svg></h2><p>Body.</p></main>\n',
    });
    const result = await run(["validate", iconOnly.recipePath]);
    expect(result.code).toBe(0);
  });

  it("passes when icon-in-heading markup appears only inside an HTML comment", async () => {
    const commented = writeRecipe("icon-commented", {
      body: '<main class="oa-prose"><!-- example: <h2><svg viewBox="0 0 24 24"><path d="M1 1"/></svg> Title</h2> --><h2>Real text heading</h2></main>\n',
    });
    const result = await run(["validate", commented.recipePath]);
    expect(result.code).toBe(0);
  });

  it("rejects a heading whose only flex rule targets a pseudo-element", async () => {
    const pseudo = writeRecipe("icon-pseudo-flex", {
      body: '<main class="oa-prose"><h2><svg class="ico" viewBox="0 0 24 24" fill="currentColor"><path d="M11 7H13V9H11V7Z"/></svg> Title</h2></main>\n',
    });
    writeFileSync(
      pseudo.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\nh2::before{display:flex;align-items:center;content:""}\n',
    );
    const result = await run(["validate", pseudo.recipePath], {
      expectFailure: true,
    });
    expect(result.stderr).toContain("not laid out as a centered row");
    expect(requests).toHaveLength(0);
  });

  it("validates a Markdown recipe that omits document.theme", async () => {
    const recipe = writeRecipe("no-theme-markdown", {
      format: "markdown",
      mutate: (r) => {
        r.document.theme = null;
      },
    });
    const result = await run(["validate", recipe.recipePath]);
    expect(result.code).toBe(0);
  });

  it("fails a scrollspy with a tight IO band, no boundary fallback, and scrollIntoView in setActive", async () => {
    const scriptsDir = join(projectDir, "scrollspy-bad-fragments");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(
      join(scriptsDir, "behavior.js"),
      [
        "var links = [].slice.call(document.querySelectorAll('.nav-chips a'));",
        "var sections = links.map(function(a){ return document.getElementById(a.getAttribute('href').slice(1)); }).filter(Boolean);",
        "function setActive(id){ links.forEach(function(a){ if(a.getAttribute('href')==='#'+id){ a.setAttribute('aria-current','true'); a.scrollIntoView(); } else a.removeAttribute('aria-current'); }); }",
        "var io = new IntersectionObserver(function(entries){ entries.forEach(function(e){ if(e.isIntersecting && e.target.id) setActive(e.target.id); }); }, { rootMargin: '-40% 0px -55% 0px', threshold: 0 });",
        "sections.forEach(function(s){ io.observe(s); });",
      ].join("\n"),
    );
    const recipe = writeRecipe("scrollspy-bad", {
      mutate: (r) => {
        r.artifact.level = 2;
        r.document.fragments.scripts = [
          "../scrollspy-bad-fragments/behavior.js",
        ];
      },
      body: '<main><nav class="nav-chips"><a href="#a">A</a><a href="#b">B</a></nav><section id="a">a</section><section id="b">b</section></main>\n',
    });
    writeFileSync(
      recipe.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n',
    );
    const result = await run(["validate", recipe.recipePath], {
      expectFailure: true,
    });
    expect(result.stderr).toContain("scrollspy:");
    expect(result.stderr).toContain("bottom margin is too tight");
    expect(result.stderr).toContain("scrollIntoView");
    expect(requests).toHaveLength(0);
  });

  it("passes a scrollspy with a bottom-boundary fallback and chip-only scrollIntoView", async () => {
    const scriptsDir = join(projectDir, "scrollspy-good-fragments");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(
      join(scriptsDir, "behavior.js"),
      [
        "var links = [].slice.call(document.querySelectorAll('.nav-chips a'));",
        "var sections = links.map(function(a){ return document.getElementById(a.getAttribute('href').slice(1)); });",
        "var lastIdx = sections.length - 1;",
        "function setActive(id){ links.forEach(function(a){ if(a.getAttribute('href')==='#'+id) a.setAttribute('aria-current','true'); else a.removeAttribute('aria-current'); }); }",
        "function syncChipScroll(id){ var active = links.filter(function(a){ return a.getAttribute('href')==='#'+id; })[0]; if(active) active.scrollIntoView({ block:'nearest' }); }",
        "function recompute(){ var docTop = window.scrollY; var maxScroll = document.documentElement.scrollHeight - window.innerHeight; if(maxScroll>0 && docTop >= maxScroll - 4){ var id = sections[lastIdx].id; setActive(id); syncChipScroll(id); return; } }",
        "var io = new IntersectionObserver(function(entries){ entries.forEach(function(e){ if(e.isIntersecting && e.target.id){ setActive(e.target.id); syncChipScroll(e.target.id); } }); }, { rootMargin: '-45% 0px -45% 0px', threshold: 0 });",
        "sections.forEach(function(s){ if(s) io.observe(s); });",
        "window.addEventListener('scroll', recompute, { passive: true });",
      ].join("\n"),
    );
    const recipe = writeRecipe("scrollspy-good", {
      mutate: (r) => {
        r.artifact.level = 2;
        r.document.fragments.scripts = [
          "../scrollspy-good-fragments/behavior.js",
        ];
      },
      body: '<main><nav class="nav-chips"><a href="#a">A</a><a href="#b">B</a></nav><section id="a">a</section><section id="b">b</section></main>\n',
    });
    writeFileSync(
      recipe.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n',
    );
    const result = await run(["validate", recipe.recipePath]);
    expect(result.code).toBe(0);
  });

  it("passes a scrollspy whose bottom-boundary uses the additive innerHeight+scrollY form", async () => {
    // The project-intro artifact used `window.scrollY + window.innerHeight >=
    // document.documentElement.scrollHeight - 2` — functionally correct, but the
    // gate must accept this additive spelling, not just the maxScroll local form.
    const scriptsDir = join(projectDir, "scrollspy-additive-fragments");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(
      join(scriptsDir, "behavior.js"),
      [
        "var links = [].slice.call(document.querySelectorAll('.nav-chips a'));",
        "var sections = links.map(function(a){ return document.getElementById(a.getAttribute('href').slice(1)); });",
        "var lastIdx = sections.length - 1;",
        "function setActive(id){ links.forEach(function(a){ if(a.getAttribute('href')==='#'+id) a.setAttribute('aria-current','true'); else a.removeAttribute('aria-current'); }); }",
        "function atEnd(){ return window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2; }",
        "function recompute(){ if(atEnd() && lastIdx >= 0){ setActive(sections[lastIdx].id); return; } }",
        "var io = new IntersectionObserver(function(entries){ entries.forEach(function(e){ if(e.isIntersecting && e.target.id) setActive(e.target.id); }); }, { rootMargin: '-40% 0px -55% 0px', threshold: 0 });",
        "sections.forEach(function(s){ if(s) io.observe(s); });",
        "window.addEventListener('scroll', recompute, { passive: true });",
      ].join("\n"),
    );
    const recipe = writeRecipe("scrollspy-additive", {
      mutate: (r) => {
        r.artifact.level = 2;
        r.document.fragments.scripts = [
          "../scrollspy-additive-fragments/behavior.js",
        ];
      },
      body: '<main><nav class="nav-chips"><a href="#a">A</a><a href="#b">B</a></nav><section id="a">a</section><section id="b">b</section></main>\n',
    });
    writeFileSync(
      recipe.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n',
    );
    const result = await run(["validate", recipe.recipePath]);
    expect(result.code).toBe(0);
  });

  it("passes a lazy-image-reveal artifact (not a scrollspy) untouched", async () => {
    const scriptsDir = join(projectDir, "lazy-reveal-fragments");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(
      join(scriptsDir, "behavior.js"),
      [
        "var imgs = [].slice.call(document.querySelectorAll('img[data-reveal]'));",
        "function reveal(el){ el.classList.add('is-active'); el.scrollIntoView(); }",
        "var io = new IntersectionObserver(function(entries){ entries.forEach(function(e){ if(e.isIntersecting) reveal(e.target); }); }, { rootMargin: '0px' });",
        "imgs.forEach(function(i){ io.observe(i); });",
      ].join("\n"),
    );
    const recipe = writeRecipe("lazy-reveal", {
      mutate: (r) => {
        r.artifact.level = 2;
        r.document.fragments.scripts = ["../lazy-reveal-fragments/behavior.js"];
      },
      body: '<main><img data-reveal src="data:image/svg+xml,<svg></svg>"></main>\n',
    });
    writeFileSync(
      recipe.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n',
    );
    const result = await run(["validate", recipe.recipePath]);
    expect(result.code).toBe(0);
  });

  it("rejects a dark --muted below 4.5:1 contrast against --bg", async () => {
    const lowContrast = writeRecipe("low-contrast-dark", {
      mutate: (recipe) => {
        recipe.artifact.level = 2;
      },
    });
    writeFileSync(
      lowContrast.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan;--muted:#3a3a40}\n',
    );
    const result = await run(["validate", lowContrast.recipePath], {
      expectFailure: true,
    });
    expect(result.stderr).toContain("contrast P0");
    expect(result.stderr).toContain("--muted");
    expect(result.stderr).toContain("4.5:1");
    // dark theme: background is dark, so the hint tells the author to RAISE foreground.
    expect(result.stderr).toContain("raise the foreground lightness");
    expect(requests).toHaveLength(0);
  });

  it("hints to lower foreground lightness for a light-theme contrast failure", async () => {
    // A too-light accent on a near-white light background: raising L would
    // lower contrast further, so the hint must say "lower", not "raise".
    const lightLow = writeRecipe("low-contrast-light", {
      mutate: (recipe) => {
        recipe.artifact.level = 2;
      },
    });
    writeFileSync(
      lightLow.themePath,
      ':root{--bg:#fff;--accent:oklch(78% 0.16 255)}\n:root[data-theme="dark"]{--accent:cyan}\n',
    );
    const result = await run(["validate", lightLow.recipePath], {
      expectFailure: true,
    });
    expect(result.stderr).toContain("contrast P0");
    expect(result.stderr).toContain("light");
    expect(result.stderr).toContain("lower the foreground lightness");
    expect(requests).toHaveLength(0);
  });

  it("passes a dark --muted at or above 4.5:1 contrast", async () => {
    const okContrast = writeRecipe("ok-contrast-dark", {
      mutate: (recipe) => {
        recipe.artifact.level = 2;
      },
    });
    writeFileSync(
      okContrast.themePath,
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan;--muted:#9a9aa2}\n',
    );
    const result = await run(["validate", okContrast.recipePath]);
    expect(result.code).toBe(0);
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
    writeFileSync(
      built.themePath,
      ':root{--accent:oklch(55% .15 250)}\n:root[data-theme="dark"]{--accent:oklch(72% .14 250)}\nbody{max-width:72ch;margin-inline:auto}\n',
    );

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

    const overlap = writeRecipe("overlap-frames", {
      canvas: true,
      body: `<div class="oa-canvas" id="canvas"><div class="oa-plane" id="plane">
<section class="oa-frame" id="first" data-tour="1" style="--x:0;--y:0;--w:390;--h:844"><button class="oa-frame-label" type="button">First</button><div class="oa-frame-body" inert>First</div></section>
<section class="oa-frame" id="second" data-tour="2" style="--x:300;--y:0;--w:390;--h:844"><button class="oa-frame-label" type="button">Second</button><div class="oa-frame-body" inert>Second</div></section>
</div></div>`,
    });
    const overlapResult = await run(["validate", overlap.recipePath], {
      expectFailure: true,
    });
    expect(overlapResult.stderr).toContain("overlap");

    const zeroGap = writeRecipe("zero-gap-frames", {
      canvas: true,
      body: `<div class="oa-canvas" id="canvas"><div class="oa-plane" id="plane">
<section class="oa-frame" id="first" data-tour="1" style="--x:0;--y:0;--w:390;--h:844"><button class="oa-frame-label" type="button">First</button><div class="oa-frame-body" inert>First</div></section>
<section class="oa-frame" id="second" data-tour="2" style="--x:0;--y:844;--w:390;--h:844"><button class="oa-frame-label" type="button">Second</button><div class="oa-frame-body" inert>Second</div></section>
</div></div>`,
    });
    const zeroGapResult = await run(["validate", zeroGap.recipePath], {
      expectFailure: true,
    });
    expect(zeroGapResult.stderr).toContain("0px apart");
    expect(zeroGapResult.stderr).toContain(">=");
    expect(zeroGapResult.stderr).toContain("24");

    const tightGap = writeRecipe("tight-gap-frames", {
      canvas: true,
      body: `<div class="oa-canvas" id="canvas"><div class="oa-plane" id="plane">
<section class="oa-frame" id="first" data-tour="1" style="--x:0;--y:0;--w:390;--h:844"><button class="oa-frame-label" type="button">First</button><div class="oa-frame-body" inert>First</div></section>
<section class="oa-frame" id="second" data-tour="2" style="--x:0;--y:868;--w:390;--h:844"><button class="oa-frame-label" type="button">Second</button><div class="oa-frame-body" inert>Second</div></section>
</div></div>`,
    });
    const tightGapResult = await run(["validate", tightGap.recipePath]);
    expect(tightGapResult.code).toBe(0);
  });

  it("rejects a canvas whose bounding rect width exceeds 2880 world px", async () => {
    // five 1440-wide frames in a row = 5*1440 = 7200 wide (with 0 gap, but
    // 0 gap fails the min-gap gate first; space them 8px apart to isolate the
    // bounding-width gate). boundingW = 5*1440 + 4*8 = 7232 > 2880.
    const wide = writeRecipe("bounding-too-wide", {
      canvas: true,
      body: `<div class="oa-canvas" id="canvas"><div class="oa-plane" id="plane">${[
        0, 1, 2, 3, 4,
      ]
        .map(
          (i) =>
            `<section class="oa-frame" id="f${i}" data-tour="${
              i + 1
            }" style="--x:${i * (1440 + 24)};--y:0;--w:1440;--h:900"><button class="oa-frame-label" type="button">F${i}</button><div class="oa-frame-body" inert>F${i}</div></section>`,
        )
        .join("")}</div></div>`,
    });
    const wideResult = await run(["validate", wide.recipePath], {
      expectFailure: true,
    });
    expect(wideResult.stderr).toContain("bounding rect");
    expect(wideResult.stderr).toContain("2880");
    expect(requests).toHaveLength(0);
  });

  it("rejects a canvas whose bounding rect height exceeds 2560 world px", async () => {
    // four 844-tall frames stacked 8px apart = 4*844 + 3*8 = 3400 tall > 2560.
    const tall = writeRecipe("bounding-too-tall", {
      canvas: true,
      body: `<div class="oa-canvas" id="canvas"><div class="oa-plane" id="plane">${[
        0, 1, 2, 3,
      ]
        .map(
          (i) =>
            `<section class="oa-frame" id="f${i}" data-tour="${
              i + 1
            }" style="--x:0;--y:${i * (844 + 24)};--w:390;--h:844"><button class="oa-frame-label" type="button">F${i}</button><div class="oa-frame-body" inert>F${i}</div></section>`,
        )
        .join("")}</div></div>`,
    });
    const tallResult = await run(["validate", tall.recipePath], {
      expectFailure: true,
    });
    expect(tallResult.stderr).toContain("tall");
    expect(tallResult.stderr).toContain("2560");
  });

  it("rejects a .oa-note whose chip center lands inside a frame", async () => {
    const noteOnFrame = writeRecipe("note-on-frame", {
      canvas: true,
      body: `<div class="oa-canvas" id="canvas"><div class="oa-plane" id="plane">
<section class="oa-frame" id="first" data-tour="1" style="--x:0;--y:0;--w:390;--h:844"><button class="oa-frame-label" type="button">First</button><div class="oa-frame-body" inert>First</div></section>
<div class="oa-note" style="--x:200;--y:400">a note planted on the frame</div>
</div></div>`,
    });
    const noteResult = await run(["validate", noteOnFrame.recipePath], {
      expectFailure: true,
    });
    expect(noteResult.stderr).toContain(".oa-note");
    expect(noteResult.stderr).toContain("inside frame");
    expect(requests).toHaveLength(0);
  });

  it("passes a .oa-note placed in a gutter between frames", async () => {
    const noteInGutter = writeRecipe("note-in-gutter", {
      canvas: true,
      body: `<div class="oa-canvas" id="canvas"><div class="oa-plane" id="plane">
<section class="oa-frame" id="first" data-tour="1" style="--x:0;--y:0;--w:390;--h:844"><button class="oa-frame-label" type="button">First</button><div class="oa-frame-body" inert>First</div></section>
<section class="oa-frame" id="second" data-tour="2" style="--x:0;--y:900;--w:390;--h:844"><button class="oa-frame-label" type="button">Second</button><div class="oa-frame-body" inert>Second</div></section>
<div class="oa-note" style="--x:195;--y:856">a note in the row-gap gutter (center 195,872 is between frames)</div>
</div></div>`,
    });
    const noteResult = await run(["validate", noteInGutter.recipePath]);
    expect(noteResult.code).toBe(0);
  });

  it("rejects incomplete Canvas frame and connector contracts", async () => {
    const divFrame = writeRecipe("div-frame", {
      canvas: true,
      body: validCanvasBody()
        .replaceAll("<section", "<div")
        .replaceAll("</section>", "</div>"),
    });
    const divFrameResult = await run(["validate", divFrame.recipePath], {
      expectFailure: true,
    });
    expect(divFrameResult.stderr).toContain("must use a section element");

    const missingLabel = writeRecipe("missing-label", {
      canvas: true,
      body: validCanvasBody().replace(
        '<button class="oa-frame-label" type="button">First</button>',
        "",
      ),
    });
    const missingLabelResult = await run(
      ["validate", missingLabel.recipePath],
      {
        expectFailure: true,
      },
    );
    expect(missingLabelResult.stderr).toContain(
      "requires one button.oa-frame-label",
    );

    const missingInert = writeRecipe("missing-inert", {
      canvas: true,
      body: validCanvasBody().replace(
        '<div class="oa-frame-body" inert>First</div>',
        '<div class="oa-frame-body">First</div>',
      ),
    });
    const missingInertResult = await run(
      ["validate", missingInert.recipePath],
      {
        expectFailure: true,
      },
    );
    expect(missingInertResult.stderr).toContain(
      "requires one inert div.oa-frame-body",
    );

    const missingEndpoint = writeRecipe("missing-endpoint", {
      canvas: true,
      body: validCanvasBody().replace(' data-to="second"', ""),
    });
    const missingEndpointResult = await run(
      ["validate", missingEndpoint.recipePath],
      { expectFailure: true },
    );
    expect(missingEndpointResult.stderr).toContain(
      "connector path requires data-from and data-to",
    );
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
      '<main class="oa-prose"><h1>Recipe report v2</h1></main>\n',
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
    writeFileSync(
      built.bodyPath,
      '<main class="oa-prose"><h1>Conflicting update</h1></main>\n',
    );
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

  it("rejects update with a recipe path where an id is expected", async () => {
    const built = writeRecipe();
    await run(["create", built.recipePath]);
    // The common mistake: passing the Recipe path as `update`'s first
    // positional. The error must name the artifact id as the lookup key and
    // list the known id so the author reaches for `update <id>`, not the path.
    const result = await run(["update", "recipes/report.recipe.json"], {
      expectFailure: true,
    });
    expect(result.stderr).toContain("no manifest entry with id");
    expect(result.stderr).toContain("not its Recipe path");
    expect(result.stderr).toContain("testid123456");
    expect(requests).toHaveLength(1);
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

  it("reports the fragments.local rule and ../traversal for a local Recipe with misplaced fragments", async () => {
    // Local Recipe correctly placed, but fragments referenced outside fragments.local/.
    const shared = writeRecipe("misplaced-fragments", { local: true });
    const recipe = readJson<TestRecipe>(shared.recipePath);
    // Point fragments at a committed (shared) fragments dir, not fragments.local/.
    // The Recipe sits in .artifacts/recipes.local/, so ../fragments reaches
    // .artifacts/fragments/ — create those real files so fragment resolution
    // passes and the private-source placement check is what fails.
    recipe.document.fragments.theme = ["../fragments/theme.css"];
    recipe.document.fragments.body = ["../fragments/body.html"];
    mkdirSync(join(projectDir, ".artifacts", "fragments"), {
      recursive: true,
    });
    writeFileSync(
      join(projectDir, ".artifacts", "fragments", "theme.css"),
      ':root{--accent:blue}\n:root[data-theme="dark"]{--accent:cyan}\n',
    );
    writeFileSync(
      join(projectDir, ".artifacts", "fragments", "body.html"),
      '<main class="oa-prose"><h1>Misplaced</h1></main>\n',
    );
    writeJson(shared.recipePath, recipe);

    const result = await run(["validate", shared.recipePath], {
      expectFailure: true,
    });
    expect(result.stderr).toContain("fragments.local");
    expect(result.stderr).toContain("../fragments.local/");
    expect(requests).toHaveLength(0);
  });

  it("reports both the recipes.local and fragments.local rules in one message when both are misplaced", async () => {
    // A local Recipe whose file AND fragments both live in shared locations.
    const shared = writeRecipe("misplaced-both");
    const recipe = readJson<TestRecipe>(shared.recipePath);
    recipe.artifact.local = true;
    writeJson(shared.recipePath, recipe);

    const result = await run(["validate", shared.recipePath], {
      expectFailure: true,
    });
    expect(result.stderr).toContain("recipes.local");
    expect(result.stderr).toContain("fragments.local");
    expect(result.stderr).toContain("../fragments.local/");
    expect(requests).toHaveLength(0);
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

  it("migrates a legacy bare-L1 page by wrapping it in the prose baseline", async () => {
    seedLegacyManifest({ level: 1, canvas: false });
    nextRaw = {
      contentType: "text/plain; charset=utf-8",
      body: '<title>Bare</title><style>:root{--accent:blue}:root[data-theme="dark"]{--accent:cyan}</style><main><h1>Bare</h1><p>No measure cap.</p></main>',
    };

    await run(["update", "testid123456"]);

    const state = manifest();
    expect(state.manifestVersion).toBe(2);
    const recipePath = join(projectDir, state.artifacts[0].recipe ?? "");
    const recipe = readJson<TestRecipe>(recipePath);
    const bodyPath = join(
      dirname(recipePath),
      recipe.document.fragments.body[0],
    );
    expect(readFileSync(bodyPath, "utf8")).toContain('class="oa-prose"');
    expect(requests[1].body.content).toContain("oa-prose");
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

  itUnix(
    "writes credentials.json with mode 0600 after create --password",
    async () => {
      const { recipePath } = writeRecipe("secret-locked", {
        local: true,
        encrypted: true,
      });

      await run(["create", recipePath], {
        env: { OPEN_ARTIFACTS_PASSWORD_REPORT_PASSWORD: "correct horse" },
      });

      const credentialsPath = join(projectDir, ".artifacts/credentials.json");
      expect(existsSync(credentialsPath)).toBe(true);
      expect(statSync(credentialsPath).mode & 0o777).toBe(0o600);
    },
  );

  itUnix(
    "migrates a pre-existing 0644 credentials.json to 0600 on load",
    async () => {
      const credentialsPath = join(projectDir, ".artifacts/credentials.json");
      mkdirSync(dirname(credentialsPath), { recursive: true });
      writeFileSync(
        credentialsPath,
        `${JSON.stringify({ tokens: {} }, null, 2)}\n`,
      );
      chmodSync(credentialsPath, 0o644);
      expect(statSync(credentialsPath).mode & 0o777).toBe(0o644);

      // `show` calls loadCredentials at the top, before the network round-trip,
      // so the one-time migration runs even though the lookup otherwise no-ops.
      await run(["show", "testid123456"]);

      expect(statSync(credentialsPath).mode & 0o777).toBe(0o600);
    },
  );
});
