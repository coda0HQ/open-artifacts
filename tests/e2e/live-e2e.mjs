#!/usr/bin/env node
// Live-mode END-TO-END test. Boots the real worker (wrangler dev with
// wrangler.dev.jsonc: LIVE_DO bound + DEV_AUTHORIZER), publishes an artifact
// through the real CLI, runs `live <id> --watch`, then drives a REAL browser
// (agent-browser CLI) and the live WebSocket protocol:
//
//   1. comment posted through the real comments UI   -> watcher prints comment
//   2. Live opened, element picked with real mouse   -> compose bar
//   3. Edit text flow: chip -> inline edit -> Save    -> "Apply copy edits (1)" pill
//   4. Apply clicked + done --data reply             -> watcher prints edit, pill clears
//   5. prompt typed + Submit + done reply            -> watcher prints generate
//   6. Exit clicked after the watcher resumes        -> watcher prints exit, exits 0
//   7. /live/status reports agentActive while online
//   8. the header renders Connected while the watcher is online
//   9. the watcher stream never prints timeout noise (polls time out at 1s)
//
// Requires: agent-browser on PATH, node >= 22 (global WebSocket), pnpm.
// Run:      node tests/e2e/live-e2e.mjs
// Leaves wrangler dev + the watcher running on failure (diagnosable); kills
// them on success.

import { execFileSync, execSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const CLI = join(ROOT, "skills/using-open-artifacts/scripts/artifact.mjs");
const PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;

const fail = (msg) => {
  console.error(`\nE2E FAIL: ${msg}`);
  process.exitCode = 1;
  process.exit(1);
};
const run = (cmd, opts = {}) =>
  execSync(cmd, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    ...opts,
  });
// agent-browser invocations occasionally hang on back-to-back CDP connects;
// guard every call with a timeout so a hang fails the step instead of
// stalling the whole E2E.
const ab = (cmd) => {
  try {
    return execSync(`agent-browser ${cmd}`, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
  } catch (e) {
    const brief = cmd.length > 70 ? `${cmd.slice(0, 70)}...` : cmd;
    fail(
      `agent-browser "${brief}" failed: ${String(e.stderr || e.message).slice(0, 200)}`,
    );
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(250);
  }
  // Throws (not fail/exit) so retry loops can catch and retry.
  throw new Error(`timed out waiting for ${what}`);
}

// --- harness processes ---
const stateDir = mkdtempSync(join(tmpdir(), "oa-e2e-state-"));
const projDir = mkdtempSync(join(tmpdir(), "oa-e2e-proj-"));
const logs = { wrangler: "", watcher: "" };
const watcherLines = [];
let wrangler = null;
let watcher = null;

function cleanup() {
  if (watcher && !watcher.killed) watcher.kill("SIGKILL");
  if (wrangler && !wrangler.killed) wrangler.kill("SIGKILL");
  try {
    run("agent-browser close --all");
  } catch {}
}

process.on("exit", cleanup);

try {
  // Fail fast with a clear message instead of booting a second server into a
  // port a stray wrangler dev already holds (orphans survive the test runner
  // being killed — clear them with: lsof -ti :8788 | xargs kill -9). A prior
  // run's wrangler takes a moment to die through the pnpm→wrangler chain, so
  // give a dying server a few seconds to clear before blaming a stray.
  let serving = false;
  for (let i = 0; i < 10; i++) {
    try {
      const probe = await fetch(`${BASE}/`);
      if (probe.ok) {
        serving = true;
        await sleep(500);
      }
    } catch {
      serving = false;
      break;
    }
  }
  if (serving)
    fail(
      `port ${PORT} is already serving — a stray wrangler dev is running; kill it first (lsof -ti :${PORT} | xargs kill -9)`,
    );
  console.log(
    "== booting wrangler dev (wrangler.dev.jsonc: LIVE_DO + DEV_AUTHORIZER) ==",
  );
  wrangler = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "-c",
      "wrangler.dev.jsonc",
      "--port",
      String(PORT),
      "--persist-to",
      stateDir,
    ],
    {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  wrangler.stdout.on("data", (d) => (logs.wrangler += d));
  wrangler.stderr.on("data", (d) => (logs.wrangler += d));
  await waitFor(
    async () => {
      try {
        const res = await fetch(`${BASE}/`);
        return res.ok;
      } catch {
        return false;
      }
    },
    "wrangler dev to serve /",
    90_000,
  );
  console.log("wrangler dev up on", BASE);

  // --- publish an artifact through the real CLI (temp project, like the tests) ---
  const recipeDir = join(projDir, ".artifacts/recipes");
  const fragDir = join(projDir, ".artifacts/recipes/e2e-fragments");
  mkdirSync(fragDir, { recursive: true });
  writeFileSync(
    join(fragDir, "body.html"),
    '<main class="oa-prose"><h1 id="e2e-title">E2E Live Artifact</h1><p id="e2e-body">The quick brown fox jumps over the lazy dog.</p></main>\n',
  );
  writeFileSync(
    join(fragDir, "theme.css"),
    ':root{--accent:oklch(55% .15 250)}\n:root[data-theme="dark"]{--accent:oklch(72% .14 250)}\n',
  );
  writeFileSync(
    join(recipeDir, "e2e.recipe.json"),
    JSON.stringify(
      {
        version: 1,
        artifact: {
          title: "E2E Live Artifact",
          description: "E2E live-mode test artifact",
          favicon: "🧪",
          format: "html",
          level: 1,
          canvas: false,
          channel: null,
          scope: "E2E live tests",
          watch: [],
          local: false,
          autoUpdate: false,
        },
        document: {
          language: "en",
          theme: "e2e",
          fragments: {
            theme: ["e2e-fragments/theme.css"],
            styles: [],
            body: ["e2e-fragments/body.html"],
            scripts: [],
          },
        },
        security: { encrypted: false, passwordCredential: null },
        build: { strategy: "auto" },
      },
      null,
      2,
    ),
  );
  const createOut = execFileSync(
    process.execPath,
    [CLI, "create", join(recipeDir, "e2e.recipe.json")],
    {
      cwd: projDir,
      encoding: "utf8",
      env: {
        ...process.env,
        OPEN_ARTIFACTS_URL: BASE,
        OPEN_ARTIFACTS_API_KEY: "sk_e2e",
      },
    },
  );
  const url = createOut.trim().split("\n").pop();
  const id = url.split("/").pop();
  if (!/^[A-Za-z0-9_-]{6,}$/.test(id))
    fail(`bad artifact id from create: ${url}`);
  console.log(`published ${url}`);

  // --- start the watcher: 1s poll timeout proves timeouts stay silent ---
  console.log("== starting watcher (OPEN_ARTIFACTS_LIVE_TIMEOUT_MS=1000) ==");
  watcher = spawn(process.execPath, [CLI, "live", id, "--watch"], {
    cwd: projDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      OPEN_ARTIFACTS_URL: BASE,
      OPEN_ARTIFACTS_API_KEY: "sk_e2e",
      OPEN_ARTIFACTS_LIVE_TIMEOUT_MS: "1000",
      // The first heartbeat is immediate. Keep subsequent heartbeats below
      // the shared live-route rate limit while 1s polls exercise silent
      // timeout handling; a 300ms heartbeat self-DOSes the test with 429s.
      OPEN_ARTIFACTS_LIVE_HEARTBEAT_MS: "5000",
    },
  });
  watcher.stdout.on("data", (d) => {
    logs.watcher += d;
    for (const line of String(d).split("\n")) {
      const t = line.trim();
      if (t) watcherLines.push(t);
    }
  });
  watcher.stderr.on("data", (d) => (logs.watcher += d));
  await sleep(1500); // let the watcher connect + poll a couple of times

  // --- presence: the DO reports the watcher active ---
  {
    const res = await fetch(`${BASE}/api/artifacts/${id}/live/status`, {
      headers: { authorization: "Bearer sk_e2e" },
    });
    if (!res.ok) fail(`live/status returned ${res.status}`);
    const status = await res.json();
    if (status.agentActive !== true)
      fail(`expected agentActive true, got ${JSON.stringify(status)}`);
    console.log("presence: agentActive =", status.agentActive);
  }

  // --- browser: open the artifact ---
  console.log("== driving the browser (agent-browser) ==");
  ab(`open ${BASE}/a/${id}`);
  await sleep(2500);
  ab("set viewport 1280 900");

  // 1) comment through the REAL comments UI (compose popover + send)
  ab(
    `eval "window.__oaOnAnchorNew({anchor:{mode:'point',x:140,y:90},point:{x:140,y:90}})"`,
  );
  await sleep(400);
  ab(`type .oa-cm-body "make the title bolder"`);
  await sleep(200);
  ab("click .oa-cm-send");
  await waitFor(
    () =>
      watcherLines.some(
        (l) =>
          l.includes('"type":"comment"') && l.includes("make the title bolder"),
      ),
    "watcher to print the comment event",
    15_000,
  );
  console.log("comment streamed to watcher ✓");

  // 2) open Live, pick an element with REAL mouse events. The compose bar is
  // host chrome (visible to eval); the artifact content is centered under the
  // frame's middle, so aim there (the h1 or p both satisfy pickable()).
  // agent-browser prints string eval results as one quoted+escaped JSON line
  // (e.g. "[0,41,1280,536]"), so the output parses to a string that parses
  // again to the value.
  // agent-browser prints string results quoted+escaped, so the output parses
  // to the JSON TEXT of the value; parse again to get the value itself.
  const evalStr = (expr) =>
    JSON.parse(JSON.parse(ab(`eval "JSON.stringify(${expr})"`)));
  // Throwing variant for retry loops: ab() calls fail() which process-exits,
  // so a daemon reply loss there cannot be caught — this one throws instead.
  const evalRaw = (expr) =>
    JSON.parse(
      JSON.parse(
        execSync(`agent-browser eval "JSON.stringify(${expr})"`, {
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
          timeout: 30_000,
        }).trim(),
      ),
    );
  await waitFor(
    () =>
      evalStr(
        `(function(){var b=document.querySelector('.oa-live-toggle');var c=document.querySelector('[data-live-connection]');return !!b&&!!c&&!c.hidden&&c.textContent.trim()==='Connected';})()`,
      ) === true,
    "header Connected indicator",
    15_000,
  );
  console.log("header presence: Connected");
  const dockExpanded = () =>
    evalStr(
      `document.querySelector('.oa-live-toggle')?.getAttribute('aria-expanded')`,
    ) === "true";
  let dockOpen = false;
  for (let i = 0; i < 5 && !dockOpen; i++) {
    if (dockExpanded()) {
      dockOpen = true;
      break;
    }
    ab("click .oa-live-toggle");
    try {
      await waitFor(dockExpanded, "Live dock to open", 4000);
      dockOpen = true;
    } catch {
      // flaky click (the page is settling after the comment post) — retry
    }
  }
  if (!dockOpen) {
    const dump = ab(
      `eval "JSON.stringify({toggle:!!document.querySelector('.oa-live-toggle'),rootHidden:document.getElementById('oa-live-root')?document.getElementById('oa-live-root').hidden:'absent',dock:typeof window.__oaDock,livePush:typeof window.__oaLivePush,expanded:document.querySelector('.oa-live-toggle')?.getAttribute('aria-expanded')})"`,
    );
    ab("screenshot /tmp/oa-e2e-dock-failed.png");
    fail(`Live dock never opened after retries — page state: ${dump}`);
  }
  await sleep(500);

  const frameRect = async () => {
    for (let i = 0; i < 10; i++) {
      const arr = await evalStr(
        `document.getElementById('oa-frame') ? (function(){var r=document.getElementById('oa-frame').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})() : null`,
      );
      if (arr && arr.length === 4 && arr.every((n) => Number.isFinite(n)))
        return { x: arr[0], y: arr[1], width: arr[2], height: arr[3] };
      await sleep(400);
    }
    return null;
  };

  const composeShown = () =>
    evalStr(`!!document.querySelector('.oa-live-freeform')`) === true;

  let pickedPoint = null;
  const pickElement = async () => {
    for (let i = 0; i < 5; i++) {
      const rect = await frameRect();
      if (!rect) return false;
      const px = Math.round(rect.x + rect.width / 2);
      const py = Math.round(rect.y + 80);
      ab(`mouse move ${px} ${py}`);
      await sleep(600);
      ab(`mouse down`);
      await sleep(400);
      ab(`mouse up`);
      try {
        await waitFor(composeShown, "compose bar after pick", 4000);
        pickedPoint = { x: px, y: py };
        return true;
      } catch {
        // pick can miss on the first mouse pass — retry at the same point
      }
    }
    return false;
  };

  if (!(await pickElement())) {
    ab("screenshot /tmp/oa-e2e-pick-failed.png");
    fail("element never picked after retries");
  }
  console.log("element picked, compose bar shown ✓");

  // 3) Edit text flow: chip -> inline edit (contenteditable row) -> Save ->
  //    "Apply copy edits (1)" pill -> Apply -> watcher prints edit -> reply
  //    done --data -> the pill clears. The frame is opaque-origin, so every
  //    assertion is host-side (pill/bar) or watcher-side (event JSON).
  ab("click .oa-live-edit-chip");
  await waitFor(
    async () => {
      const btns = await evalStr(
        `[].slice.call(document.querySelectorAll('#oa-live-action-bar .oa-live-row button')).map(function(x){return x.textContent})`,
      );
      return Array.isArray(btns) && btns[0] === "Save" && btns[1] === "Cancel";
    },
    "edit bar with Save/Cancel after the Edit text chip",
    10_000,
  );
  await sleep(500); // let the frame arm contenteditable rows
  // Focus the editable row through the same real page coordinates used to
  // pick it. The sandbox has an opaque origin, so agent-browser cannot switch
  // into it by selector. Then use the platform's real select-all accelerator
  // and key events, which fire the input event that records the draft.
  if (!pickedPoint) fail("picked element coordinates were not retained");
  ab(`mouse move ${pickedPoint.x} ${pickedPoint.y}`);
  ab("mouse down");
  ab("mouse up");
  let typed = false;
  let typingError = "";
  const selectAll = process.platform === "darwin" ? "Meta+a" : "Control+a";
  for (let i = 0; i < 3 && !typed; i++) {
    try {
      execFileSync("agent-browser", ["batch", "--bail"], {
        input: JSON.stringify([
          ["press", selectAll],
          ["keyboard", "type", "E2E EDITED TITLE"],
        ]),
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf8",
        timeout: 30_000,
      });
      typed = true;
    } catch (error) {
      typingError = String(error.stderr || error.message).slice(0, 300);
      await sleep(1000);
    }
  }
  if (!typed)
    fail(
      `typing into the edited text row failed after retries: ${typingError}`,
    );
  await sleep(300);
  // Click Save from the host page (a DOM click — the same event a user's click
  // fires). agent-browser's click selector resolution is flaky against the
  // re-rendered floating action bar, so the click goes through eval. The
  // daemon can also LOSE the eval reply after a keyboard insert (the click
  // still executes — the "Saved" toast proves it), so drive by the functional
  // outcome below (the Apply pill), retrying on a lost reply. A second Save
  // after the first landed is a no-op (no drafts left, the bar is gone).
  let saveTried = false;
  for (let i = 0; i < 3 && !saveTried; i++) {
    try {
      evalRaw(
        `(function(){var bar=document.getElementById('oa-live-action-bar');var b=bar&&bar.querySelector('.oa-live-row .oa-dock-btn--primary');if(b)b.click();return 'done';})()`,
      );
      saveTried = true;
    } catch {
      await sleep(1000);
    }
  }
  if (!saveTried) fail("Save click never confirmed after retries");
  await waitFor(
    async () => {
      const label = await evalStr(
        `document.getElementById('oa-live-apply') ? document.getElementById('oa-live-apply').querySelector('.oa-dock-label').textContent : ''`,
      );
      return label === "Apply copy edits (1)";
    },
    "Apply pill with count 1 after Save",
    10_000,
  );
  console.log("edit stashed, Apply pill shown ✓");
  // In-register inline confirm: the first click arms the pill ("Confirm
  // apply?"), the second click within the window commits. Same lost-reply
  // retry pattern as Save — two landed clicks always commit.
  const clickApply = async () => {
    for (let i = 0; i < 3; i++) {
      try {
        evalRaw(
          `(function(){var a=document.getElementById('oa-live-apply');if(a)a.click();return 'done';})()`,
        );
        return;
      } catch {
        await sleep(1000);
      }
    }
  };
  await clickApply();
  await sleep(400);
  await clickApply();
  await waitFor(
    () =>
      watcherLines.some((l) => {
        try {
          return JSON.parse(l).type === "edit";
        } catch {
          return false;
        }
      }),
    "watcher to print the edit event",
    15_000,
  );
  const editLine = watcherLines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.type === "edit");
  console.log("edit streamed to watcher ✓");
  // Agent applies the ops, republishes, and replies with the canonical JSON.
  execFileSync(
    process.execPath,
    [
      CLI,
      "live",
      id,
      "--reply",
      editLine.id,
      "done",
      "--data",
      JSON.stringify({
        status: "done",
        appliedEntryIds: (editLine.items || []).map((i) => i.id),
        failed: [],
        files: ["e2e-fragments/body.html"],
        notes: ["e2e copy edits applied"],
      }),
    ],
    {
      cwd: projDir,
      encoding: "utf8",
      env: {
        ...process.env,
        OPEN_ARTIFACTS_URL: BASE,
        OPEN_ARTIFACTS_API_KEY: "sk_e2e",
      },
    },
  );
  await waitFor(
    async () =>
      evalStr(
        `document.getElementById('oa-live-apply') ? document.getElementById('oa-live-apply').hidden : true`,
      ) === true,
    "Apply pill to clear after the done reply",
    15_000,
  );
  console.log("Apply pill cleared after done ✓");
  // The frame reloaded after done; pick again for the generate flow.
  if (!(await pickElement())) {
    ab("screenshot /tmp/oa-e2e-repick-failed.png");
    fail("element never re-picked after the edit reload");
  }
  console.log("element re-picked, compose bar shown ✓");

  // 4) prompt + submit -> generate
  ab(`type .oa-live-freeform "make the heading 20% bigger"`);
  ab("press Enter"); // commit the draft
  await sleep(300);
  ab("click .oa-dock-btn--primary"); // Submit
  await waitFor(
    () =>
      watcherLines.some(
        (l) =>
          l.includes('"type":"generate"') &&
          l.includes("make the heading 20% bigger"),
      ),
    "watcher to print the generate event",
    15_000,
  );
  console.log("generate streamed to watcher ✓");
  const generateLine = watcherLines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .find((event) => event && event.type === "generate");
  execFileSync(
    process.execPath,
    [CLI, "live", id, "--reply", generateLine.id, "done", "--version", "1"],
    {
      cwd: projDir,
      encoding: "utf8",
      env: {
        ...process.env,
        OPEN_ARTIFACTS_URL: BASE,
        OPEN_ARTIFACTS_API_KEY: "sk_e2e",
      },
    },
  );
  await waitFor(
    async () => {
      const response = await fetch(`${BASE}/api/artifacts/${id}/live/status`, {
        headers: { authorization: "Bearer sk_e2e" },
      });
      if (!response.ok) return false;
      const status = await response.json();
      return !status.pendingEvents.some(
        (event) => event.id === generateLine.id,
      );
    },
    "generate event to clear after done",
    15_000,
  );
  console.log("generate cleared after done ✓");
  await waitFor(
    () =>
      evalStr(
        `document.getElementById('oa-live-status')?.textContent.trim().startsWith('Pick an element')`,
      ) === true,
    "browser to process generate done and return to picking",
    10_000,
  );

  // 6) exit live -> watcher terminates cleanly (class selector: a bare `#`
  // must be quoted so the shell does not treat it as a comment).
  ab('click "#oa-live-exit"');
  await waitFor(
    () => watcher.exitCode !== null || watcher.killed,
    "watcher to exit after the session ended",
    15_000,
  );
  if (watcher.exitCode !== 0) {
    fail(`watcher exited with ${watcher.exitCode}\n${logs.watcher}`);
  }
  console.log("watcher exited cleanly on session end ✓");

  // 9) no timeout noise on the event stream (1s poll timeouts throughout)
  const noise = watcherLines.filter((l) => l.includes('"type":"timeout"'));
  if (noise.length > 0) {
    fail(
      `watcher printed ${noise.length} timeout line(s) on stdout: ${noise.slice(0, 3).join(" | ")}`,
    );
  }
  console.log("no timeout noise on stdout ✓");

  console.log(
    "\nE2E PASS — comment/generate/exit delivery, presence, and silent timeouts all verified",
  );
  // The wrangler child's stdout pipe keeps the event loop alive — exit
  // explicitly so the harness returns (cleanup kills the child on exit).
  process.exit(0);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  console.error(`\n--- watcher log ---\n${logs.watcher || "(none)"}`);
  console.error(
    `--- wrangler log (tail) ---\n${(logs.wrangler || "(none)").slice(-2000)}`,
  );
  console.error(
    "\n(state preserved for diagnosis; kill any stray wrangler/watcher/agent-browser processes)",
  );
  process.exitCode = 1;
}
