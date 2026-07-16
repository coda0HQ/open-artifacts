import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Vendors mermaid (pinned major) + linkedom as standalone esbuild bundles so the
// skill's build-time mermaid-syntax gate (skills/.../scripts/lib/validate.mjs)
// can run mermaid.parse() in a node child process with no node_modules, no
// network, and no runtime deps — matching the repo's vendored-static-file
// convention (vendor/marked.min.js.txt, vendor/inter/*.ttf).
//
// This is a MANUAL vendor step (like subset-cjk-font.py): run it once when
// bumping the pinned mermaid major. It uses `npx esbuild` so the repo itself
// stays esbuild-free. The generated bundles are committed.
//
//   node scripts/vendor-mermaid.mjs
//
// Outputs:
//   skills/.../vendor/mermaid/mermaid.bundle.mjs  (~3.4MB, ESM) — node build-time gate
//   skills/.../vendor/mermaid/linkedom.bundle.mjs (~480KB, ESM) — DOM shim for parse
//   skills/.../vendor/mermaid/LICENSE              (mermaid MIT, linkedom ISC)
//   public/vendor/mermaid.runtime.js              (~3.5MB, IIFE) — browser runtime
//
// TWO bundle formats for mermaid, by necessity:
//   - ESM (mermaid.bundle.mjs): the node build-time gate does `import()` and reads
//     `mod.default`. ESM is the only format node can `import()` here. Kept in the
//     skill's vendor dir (NOT public) — it is a build-time input, never served.
//   - IIFE (mermaid.runtime.js): the BROWSER runtime. The browser load-order bug
//     (issue #11): a module `<script src>` is deferred (executes after parse), but
//     the mermaid init is a plain inline `<script>` in the scripts slot that runs
//     synchronously DURING parse — before the deferred module. So `window.mermaid`
//     was undefined when the init guard ran and diagrams never rendered. The fix:
//     load mermaid as a REGULAR (non-module) `<script src="/vendor/mermaid.runtime.js">`
//     in the body. A regular same-origin script executes synchronously when the
//     parser hits it (blocking), and compose emits the body BEFORE the scripts-slot
//     inline init, so `window.mermaid` is defined before the init runs. The IIFE
//     assigns `window.mermaid` synchronously (not as a deferred module side effect).
//
// Why linkedom not jsdom: jsdom bundles to ~6MB and pulls ~60 deps; linkedom
// is a no-dep DOM that satisfies mermaid's DOMPurify path (classDiagram needs
// it; a hand-rolled shim does not), at ~480KB.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// The bundles ship WITH the skill so the build-time gate runs offline wherever
// the skill is installed (npx skills add), not just in this repo.
const outDir = join(root, "skills/using-open-artifacts/vendor/mermaid");
mkdirSync(outDir, { recursive: true });

const MERMAID_MAJOR = 11;
// Use a temp install dir so the repo's own node_modules isn't polluted.
const tmpDir = join(root, ".vendor-tmp");
mkdirSync(tmpDir, { recursive: true });

function npmInstall(spec) {
  // spec may include a version ("mermaid@11"); the installed dir is just the name.
  const name = spec.split("@")[0];
  const res = spawnSync(
    "npm",
    [
      "install",
      "--prefix",
      tmpDir,
      "--no-save",
      "--no-audit",
      "--no-fund",
      spec,
    ],
    { stdio: "inherit" },
  );
  if (res.status !== 0) throw new Error(`npm install ${spec} failed`);
  return join(tmpDir, "node_modules", name);
}

function esbuild(entry, outfile, { format = "esm", extra = [] } = {}) {
  const res = spawnSync(
    "npx",
    [
      "--yes",
      "esbuild@0.23.1",
      entry,
      "--bundle",
      "--platform=node",
      `--format=${format}`,
      "--minify",
      `--outfile=${outfile}`,
      ...extra,
    ],
    { stdio: "inherit" },
  );
  if (res.status !== 0) throw new Error(`esbuild ${outfile} failed`);
}

const mermaidEntry = join(
  npmInstall(`mermaid@${MERMAID_MAJOR}`),
  "dist/mermaid.esm.mjs",
);

// ESM bundle — the node build-time syntax gate `import()`s this and reads
// `mod.default`. Lives in the SKILL's vendor dir (not public): it is a
// build-time input, never served to a browser. The appended
// `window.mermaid=...` line is inert in node (no window) but keeps the file a
// loadable ESM module; the gate reads `mod.default` regardless.
const mermaidBundle = join(outDir, "mermaid.bundle.mjs");
esbuild(mermaidEntry, mermaidBundle, { format: "esm" });
const emitted = readFileSync(mermaidBundle, "utf8");
const exportMatch = emitted.match(
  /export\s*\{\s*([A-Za-z_$][\w$]*)\s+as\s+default\s*\}/,
);
if (!exportMatch) {
  throw new Error(
    "could not find `export{<binding> as default}` in mermaid bundle; vendor step can't append the window.mermaid side-effect",
  );
}
const binding = exportMatch[1];
writeFileSync(
  mermaidBundle,
  `${emitted}\n;window.mermaid=globalThis.mermaid=${binding};\n`,
);

// IIFE runtime bundle — the BROWSER runtime. A regular (non-module)
// `<script src="/vendor/mermaid.runtime.js">` executes synchronously when the
// parser hits it (blocking), so `window.mermaid` is defined before the
// scripts-slot inline init runs — fixing the deferred-module load-order bug.
// `--global-name=mermaid` makes esbuild assign the default export to a global
// `mermaid` var; the appended line mirrors the ESM one to set
// `window.mermaid`/`globalThis.mermaid` synchronously.
const publicVendorDir = join(root, "public", "vendor");
mkdirSync(publicVendorDir, { recursive: true });
const runtimeBundle = join(publicVendorDir, "mermaid.runtime.js");
esbuild(mermaidEntry, runtimeBundle, {
  format: "iife",
  extra: ["--global-name=mermaid"],
});
const runtimeEmitted = readFileSync(runtimeBundle, "utf8");
writeFileSync(
  runtimeBundle,
  `${runtimeEmitted}\n;window.mermaid=globalThis.mermaid=mermaid;\n`,
);

const linkedomEntry = join(npmInstall("linkedom"), "esm/index.js");
const linkedomBundle = join(outDir, "linkedom.bundle.mjs");
esbuild(linkedomEntry, linkedomBundle);

// LICENSE — both MIT/ISC, free for any use.
writeFileSync(
  join(outDir, "LICENSE"),
  `mermaid.bundle.mjs — mermaid v${MERMAID_MAJOR} (MIT, https://github.com/mermaid-js/mermaid)
  bundled with all runtime deps (MIT ISC Apache-2.0).
linkedom.bundle.mjs — linkedom (ISC, https://github.com/WebReflection/linkedom)
  bundled standalone.

These bundles are generated by scripts/vendor-mermaid.mjs and committed so
the skill's build-time mermaid-syntax gate runs offline with no node_modules.
`,
);

console.log(`vendored mermaid v${MERMAID_MAJOR} + linkedom into ${outDir}`);
