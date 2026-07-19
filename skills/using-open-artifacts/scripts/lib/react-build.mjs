import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// React/JSX artifacts are precompiled at build time into ONE self-contained
// IIFE (React + ReactDOM + the component, bundled by esbuild) that the viewer
// inlines as a nonce'd <script>. There is no runtime JSX transform and no
// external script host, so the artifact renders under the same strict CSP as
// every other format (nonce-only script-src, no 'unsafe-eval'). The security
// model is unchanged; this file is only the build-time compile.

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const nodeRequire = createRequire(import.meta.url);

// The id of the mount node the viewer frame emits (src/wrap.ts frameDocument).
export const REACT_MOUNT_ID = "oa-root";

// In-browser JSX/transform tells. A react recipe must ship compiled-JSX source,
// never a Babel-standalone / <script type="text/babel"> runtime transform: that
// needs 'unsafe-eval' (blocked) and an external script host (blocked). Reject it
// at build time with a "precompile JSX" message.
const RUNTIME_TRANSFORM_RE =
  /text\/babel|@babel\/standalone|\bbabel(?:\.min)?\.js\b|\bBabel\.transform\b|data-presets\s*=|unpkg\.com\/@babel|cdn\.jsdelivr\.net\/npm\/@babel/i;

// Walk up from `start` for the first node_modules holding BOTH react and
// react-dom — the tree esbuild must resolve the runtime from. In this repo that
// is the top-level node_modules (pnpm symlinks both there); when the skill is
// installed standalone it is wherever the two packages are installed as peers.
function findRuntimeModules(start) {
  let dir = start;
  for (;;) {
    const nm = join(dir, "node_modules");
    if (existsSync(join(nm, "react")) && existsSync(join(nm, "react-dom"))) {
      return nm;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function assertPrecompilable(source) {
  if (RUNTIME_TRANSFORM_RE.test(source)) {
    throw new Error(
      "react artifacts must precompile JSX — in-browser transforms " +
        '(Babel standalone, <script type="text/babel">, or a runtime JSX ' +
        "transform) are blocked by the viewer CSP (no 'unsafe-eval', no " +
        "external script host). Author a plain .jsx/.tsx component; the skill " +
        "precompiles it with esbuild into a self-contained bundle.",
    );
  }
}

// Bundle the entry component into a browser IIFE that mounts itself into
// #oa-root. Returns the bundle source (a string). Deterministic for a given
// esbuild + react version: no timestamps, no hashes, minified production build.
export function bundleReactComponent(entryRealPath, source) {
  assertPrecompilable(source);

  const runtimeModules = findRuntimeModules(LIB_DIR);
  if (runtimeModules === null) {
    throw new Error(
      "react format requires react + react-dom to be installed " +
        "(pnpm add -D esbuild react react-dom).",
    );
  }

  let esbuild;
  try {
    esbuild = nodeRequire("esbuild");
  } catch {
    throw new Error(
      "react format requires esbuild to precompile JSX " +
        "(pnpm add -D esbuild react react-dom).",
    );
  }

  // The entry stub imports the component by absolute path (so it resolves from
  // anywhere) and mounts it. React/ReactDOM resolve via nodePaths; the JSX
  // automatic runtime injects react/jsx-runtime, which resolves the same way.
  const stub = `import { createRoot } from "react-dom/client";
import { createElement } from "react";
import Component from ${JSON.stringify(entryRealPath)};
const el = document.getElementById(${JSON.stringify(REACT_MOUNT_ID)});
if (el) createRoot(el).render(createElement(Component));
`;

  let result;
  try {
    result = esbuild.buildSync({
      stdin: { contents: stub, resolveDir: LIB_DIR, loader: "js" },
      bundle: true,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      minify: true,
      define: { "process.env.NODE_ENV": '"production"' },
      nodePaths: [runtimeModules],
      write: false,
      legalComments: "none",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`react JSX compile failed: ${message}`);
  }

  const bundle = result.outputFiles?.[0]?.text ?? "";
  if (bundle.trim() === "") {
    throw new Error("react JSX compile produced an empty bundle");
  }
  // Defense in depth: a self-contained bundle must not evaluate code at runtime
  // (eval / new Function need 'unsafe-eval', which the viewer CSP never grants).
  if (/\beval\s*\(/.test(bundle) || /\bnew\s+Function\s*\(/.test(bundle)) {
    throw new Error(
      "react bundle unexpectedly contains eval/new Function — refusing to " +
        "publish a bundle that would need 'unsafe-eval'.",
    );
  }
  return bundle;
}
