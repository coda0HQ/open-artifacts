import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const SCRIPT = resolve(
  __dirname,
  "../../skills/using-open-artifacts/scripts/artifact.mjs",
);

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "oa-react-"));
  mkdirSync(join(projectDir, ".git"));
});

const DEFAULT_BODY = `import { useState } from "react";
export default function App() {
  const [n, setN] = useState(0);
  return <button type="button" onClick={() => setN(n + 1)}>count {n}</button>;
}
`;

function writeReactRecipe(
  options: { body?: string; mutate?: (recipe: TestRecipe) => void } = {},
): string {
  const recipeDir = join(projectDir, "recipes");
  const fragmentDir = join(recipeDir, "fragments");
  mkdirSync(fragmentDir, { recursive: true });
  writeFileSync(join(fragmentDir, "App.jsx"), options.body ?? DEFAULT_BODY);
  const recipe: TestRecipe = {
    version: 1,
    artifact: {
      title: "React counter",
      description: "React format test",
      favicon: "⚛️",
      format: "react",
      level: 1,
      canvas: false,
      channel: null,
      scope: "react format test",
      watch: [],
      local: false,
      autoUpdate: false,
    },
    document: {
      language: "en",
      theme: null,
      fragments: {
        theme: [],
        styles: [],
        body: ["fragments/App.jsx"],
        scripts: [],
      },
    },
    security: { encrypted: false, passwordCredential: null },
    build: { strategy: "auto" },
  };
  options.mutate?.(recipe);
  const recipePath = join(recipeDir, "counter.recipe.json");
  writeFileSync(recipePath, `${JSON.stringify(recipe, null, 2)}\n`);
  return recipePath;
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
  security: { encrypted: boolean; passwordCredential: string | null };
  build: { strategy: string };
}

async function run(
  args: string[],
  expectFailure = false,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [SCRIPT, ...args],
      { cwd: projectDir, env: { ...process.env } },
    );
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failed = error as { stdout: string; stderr: string; code: number };
    if (!expectFailure) {
      throw new Error(`CLI failed: ${failed.stderr || failed.stdout}`);
    }
    return {
      stdout: failed.stdout,
      stderr: failed.stderr,
      code: failed.code ?? 1,
    };
  }
}

describe("React/JSX artifact format", () => {
  it("precompiles JSX into one self-contained IIFE with React inlined", async () => {
    const recipePath = writeReactRecipe();
    const validated = await run(["validate", recipePath]);
    expect(JSON.parse(validated.stdout)).toMatchObject({ format: "react" });

    const output = ".artifacts/previews/counter.js";
    await run(["build", recipePath, "--output", output]);
    const bundle = readFileSync(join(projectDir, output), "utf8");

    // React is inlined (createRoot present) and self-mounts into #oa-root.
    expect(bundle).toContain("createRoot");
    expect(bundle).toContain("oa-root");
    // The bundle evaluates no code at runtime and loads no external script.
    expect(bundle).not.toMatch(/\beval\s*\(/);
    expect(bundle).not.toMatch(/\bnew\s+Function\s*\(/);
    expect(bundle).not.toMatch(/<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//i);
    expect(bundle).not.toMatch(/\bimport\s*\(/);
  });

  it("rejects a react recipe that relies on an in-browser JSX transform", async () => {
    const recipePath = writeReactRecipe({
      body: '<script type="text/babel">\nfunction App(){return <div>hi</div>}\n</script>\n',
    });
    const result = await run(["validate", recipePath], true);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/precompile JSX/i);
  });

  it("rejects a react recipe with no title (a bundle has none to extract)", async () => {
    const recipePath = writeReactRecipe({
      mutate: (recipe) => {
        recipe.artifact.title = null;
      },
    });
    const result = await run(["validate", recipePath], true);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(
      /artifact\.title or an extractable document title is required/i,
    );
  });

  it("requires a body-only recipe with a single entry component", async () => {
    const recipePath = writeReactRecipe({
      mutate: (recipe) => {
        writeFileSync(
          join(projectDir, "recipes/fragments/extra.css"),
          ".x{color:red}\n",
        );
        recipe.document.fragments.styles = ["fragments/extra.css"];
      },
    });
    const result = await run(["validate", recipePath], true);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/only support body fragments/i);
  });

  // esbuild dedupes by absolute path. Without alias-pinning the runtime, an
  // entry that resolves its own react (standalone skill install / nested
  // node_modules) would inline a second copy → "Invalid hook call" at mount.
  it("pins a single React runtime even when the entry has a local react", async () => {
    const { bundleReactComponent } = await import(
      "../../skills/using-open-artifacts/scripts/lib/react-build.mjs"
    );
    const entryDir = mkdtempSync(join(tmpdir(), "oa-react-dup-"));
    const localReact = join(entryDir, "node_modules", "react");
    mkdirSync(localReact, { recursive: true });
    const LOCAL_MARKER = "__OA_LOCAL_REACT_COPY__";
    writeFileSync(
      join(localReact, "package.json"),
      JSON.stringify({
        name: "react",
        version: "0.0.0-local",
        main: "index.js",
      }),
    );
    // Side-effecting marker so minify/DCE cannot drop the local copy's proof.
    writeFileSync(
      join(localReact, "index.js"),
      "export function useState(v){\n" +
        `  globalThis[${JSON.stringify(LOCAL_MARKER)}] = 1;\n` +
        "  return [v, () => {}];\n" +
        "}\n" +
        "export default { useState };\n",
    );
    // jsx-runtime stubs so an unaliased resolve can still complete a build.
    writeFileSync(
      join(localReact, "jsx-runtime.js"),
      "export function jsx(t, p) {\n" +
        `  globalThis[${JSON.stringify(LOCAL_MARKER)}] = 1;\n` +
        "  return { t, p };\n" +
        "}\n" +
        "export function jsxs(t, p) { return jsx(t, p); }\n" +
        'export const Fragment = "frag";\n',
    );
    writeFileSync(
      join(localReact, "jsx-dev-runtime.js"),
      "export function jsx(t, p) {\n" +
        `  globalThis[${JSON.stringify(LOCAL_MARKER)}] = 1;\n` +
        "  return { t, p };\n" +
        "}\n" +
        "export function jsxs(t, p) { return jsx(t, p); }\n" +
        'export const Fragment = "frag";\n',
    );
    const entryPath = join(entryDir, "App.jsx");
    const source = `import { useState } from "react";
export default function App() {
  const [n] = useState(0);
  return <span>{n}</span>;
}
`;
    writeFileSync(entryPath, source);

    const bundle = bundleReactComponent(entryPath, source);
    expect(bundle).toContain("createRoot");
    expect(bundle).not.toContain(LOCAL_MARKER);
  });
});
