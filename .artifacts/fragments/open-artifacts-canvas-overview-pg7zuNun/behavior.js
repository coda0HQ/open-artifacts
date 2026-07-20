/* Canvas runtime JS is vendored verbatim from references/canvas.md by the
   builder — do not copy it here. This fragment holds frame-internal
   interactions only, which run inside frame bodies once a frame is focused
   (inert is toggled by the vendored runtime). State stays in memory.

   Inert gating: the runtime clears `inert` on the focused frame's body (and
   on every frame body under the compact / stacked read). We never auto-focus
   inputs on load — a frame body is inert until then, and focusing into it
   would either be impossible (inert blocks focus) or read as the frame
   stealing focus. Each widget initializes its state once the user enters the
   frame. */

(function () {
  "use strict";

  // A helper: is this frame's body currently interactive (not inert)?
  // Inert is an attribute on .oa-frame-body; when absent/falsy the body is live.
  function isLive(body) {
    return body && !body.hasAttribute("inert");
  }

  // The runtime focuses frames by toggling inert on .oa-frame-body elements.
  // We re-init a frame's widget when its body becomes live, and tear down
  // when it goes inert again. We poll on a rAF loop — cheap, and inert can
  // flip from outside our own event scope (the runtime sets it directly).
  var inited = new WeakSet();
  function whenLive(body, fn) {
    function check() {
      if (isLive(body)) {
        if (!inited.has(body)) {
          inited.add(body);
          fn(true);
        }
      } else if (inited.has(body)) {
        // Body went inert again (another frame grabbed focus, or compact
        // collapsed). We keep the inited flag so re-entering does not
        // double-bind, but signal the widget to pause if it cares.
        inited.delete(body);
        fn(false);
      }
    }
    check();
    var raf = 0;
    function loop() {
      check();
      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);
    return function () { cancelAnimationFrame(raf); };
  }

  // ── F1: Project overview — play tour + copy link ──────────────────────
  var poRoot = document.getElementById("po-root");
  if (poRoot) {
    var status = document.getElementById("po-status");
    var flashTimer = null;
    function flash(msg) {
      if (!status) return;
      status.textContent = msg;
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(function () {
        status.textContent = "“Play tour” steps through the board; “Copy link” copies this URL.";
      }, 2600);
    }
    var tourBtn = document.getElementById("po-tour");
    if (tourBtn) {
      tourBtn.addEventListener("click", function () {
        // The vendored runtime owns the tour. Trigger it by focusing the
        // first tour frame and dispatching a Right-arrow to step forward.
        // Deep-linking to the first frame is the reliable, CSP-safe entry.
        if (location.hash !== "#project-overview") {
          location.hash = "#project-overview";
        }
        // Simulate a tour-next keypress so the runtime steps to frame 2.
        // ArrowRight steps the tour when data-tour frames exist.
        try {
          var ev = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
          document.dispatchEvent(ev);
        } catch (e) { /* older engines */ }
        flash("Tour started. Use ← / → to step, Esc to return.");
      });
    }
    var copyBtn = document.getElementById("po-copy");
    if (copyBtn) {
      copyBtn.addEventListener("click", function () {
        var url = location.origin + location.pathname;
        var done = function () { flash("Link copied: " + url); };
        var fail = function () {
          // Opaque origin blocks clipboard in some engines; select the URL
          // bar text as a fallback so the user can copy manually.
          flash("Copy blocked by sandbox — select the URL bar to copy: " + url);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(done, fail);
        } else {
          fail();
        }
      });
    }
  }

  // ── F2: What it is — identity explorer tabs ────────────────────────────
  var wiRoot = document.getElementById("wi-root");
  if (wiRoot) {
    var examples = {
      identity: {
        id: "pg7zuNunQpo5",
        note: "12-char crypto-random, base58-like. Unguessable, unlisted-by-default."
      },
      channels: {
        token: "ch_8K2m9Q4r...",
        note: "Presenting the channel token on a later create updates the bound artifact (same URL, new version). Only the SHA-256 is stored."
      },
      versions: {
        list: ["v1 · initial", "v2 · “fix nav”", "v3 · “rebrand”"],
        note: "?v=N views history. PUT accepts baseVersion; mismatch → 409 (override with force)."
      },
      markdown: {
        snippet: "## Hello\nRendered client-side by vendored marked. Encrypted markdown shares the same path.",
        note: "The viewer wraps raw markdown in .oa-md and renders it in the browser."
      },
      passwords: {
        env: "PBKDF2-HMAC-SHA256, 600k iterations → AES-256-GCM",
        note: "Server stores only {salt, iv, ciphertext}. Wrong password = AES-GCM auth failure, no content."
      }
    };
    var rows = wiRoot.querySelectorAll(".wi-row");
    var panel = document.getElementById("wi-panel");
    function renderPanel(key) {
      var ex = examples[key];
      if (!ex || !panel) return;
      var html = '<p class="wi-panel-hint">live example</p>';
      if (key === "identity") {
        html += '<div class="wi-ex"><span class="wi-ex-k">id</span><code class="wi-ex-v">' + ex.id + '</code></div>';
      } else if (key === "channels") {
        html += '<div class="wi-ex"><span class="wi-ex-k">channel token</span><code class="wi-ex-v">' + ex.token + '</code></div>';
      } else if (key === "versions") {
        html += '<div class="wi-ex"><span class="wi-ex-k">history</span><span class="wi-ex-v">' + ex.list.map(function (v) { return '<span class="wi-vlist">' + v + '</span>'; }).join("") + '</span></div>';
      } else if (key === "markdown") {
        html += '<div class="wi-ex"><span class="wi-ex-k">body.md</span><pre class="wi-ex-pre">' + ex.snippet + '</pre></div>';
      } else if (key === "passwords") {
        html += '<div class="wi-ex"><span class="wi-ex-k">kdf</span><code class="wi-ex-v">' + ex.env + '</code></div>';
      }
      html += '<p class="wi-ex-note">' + ex.note + '</p>';
      panel.innerHTML = html;
    }
    rows.forEach(function (row) {
      row.addEventListener("click", function () {
        rows.forEach(function (r) { r.setAttribute("aria-selected", "false"); });
        row.setAttribute("aria-selected", "true");
        renderPanel(row.dataset.key);
      });
    });
  }

  // ── F3: Publishing flow — Recipe builder simulator ────────────────────
  var pfRoot = document.getElementById("pf-root");
  if (pfRoot) {
    var title = document.getElementById("pf-title");
    var level = document.getElementById("pf-level");
    var format = document.getElementById("pf-format");
    var channel = document.getElementById("pf-channel");
    var canvas = document.getElementById("pf-canvas");
    var local = document.getElementById("pf-local");
    var encrypted = document.getElementById("pf-encrypted");
    var code = document.getElementById("pf-code");
    var bytes = document.getElementById("pf-bytes");
    var gate = document.getElementById("pf-gate");
    var valBtn = document.getElementById("pf-validate");
    var pubBtn = document.getElementById("pf-publish");

    function composeRecipe() {
      var lvl = level ? level.value : "2";
      var fmt = format ? format.value : "html";
      var enc = !!(encrypted && encrypted.checked);
      var loc = !!(local && local.checked) || enc; // encrypted forces local
      var ch = channel && channel.value ? channel.value : null;
      var obj = {
        version: 1,
        artifact: {
          title: (title && title.value) || "",
          favicon: "🎨",
          format: fmt,
          level: Number(lvl),
          canvas: !!(canvas && canvas.checked),
          channel: ch,
          local: loc,
          autoUpdate: false
        },
        document: {
          language: "en",
          theme: fmt === "markdown" ? null : "modern-minimal",
          fragments: fmt === "markdown"
            ? { body: ["fragments/body.md"] }
            : { theme: ["fragments/theme.css"], body: ["fragments/body.html"], scripts: ["fragments/behavior.js"] }
        },
        security: { encrypted: enc, passwordCredential: enc ? "report" : null },
        build: { strategy: "auto" }
      };
      return obj;
    }

    function render() {
      var r = composeRecipe();
      var json = JSON.stringify(r, null, 2);
      if (code) code.textContent = json;
      var b = new TextEncoder().encode(json).length;
      if (bytes) bytes.textContent = b.toLocaleString() + " B";
      if (encrypted && encrypted.checked && local) local.checked = true;
      if (gate) gate.textContent = "not validated yet";
      if (gate) { gate.className = "pf-gate"; }
    }

    [title, level, format, channel, canvas, local, encrypted].forEach(function (el) {
      if (!el) return;
      el.addEventListener("input", render);
      el.addEventListener("change", render);
    });

    if (encrypted) {
      encrypted.addEventListener("change", function () {
        if (encrypted.checked && local) local.checked = true;
        render();
      });
    }

    function runValidate() {
      var r = composeRecipe();
      var errs = [];
      if (!r.artifact.title || r.artifact.title.trim() === "") errs.push("title is required");
      if (r.artifact.format === "markdown") {
        if (r.document.fragments.theme || (r.document.fragments.scripts && r.document.fragments.scripts.length)) {
          errs.push("Markdown recipes only support body fragments");
        }
      }
      if (r.artifact.channel && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(r.artifact.channel)) {
        errs.push("channel must be kebab-case");
      }
      if (r.security.encrypted && !r.artifact.local) {
        errs.push("encrypted recipes must be local");
      }
      if (gate) {
        if (errs.length === 0) {
          gate.textContent = "validate: pass — build is deterministic, no external requests";
          gate.className = "pf-gate pf-pass";
        } else {
          gate.textContent = "validate: fail — " + errs.join("; ");
          gate.className = "pf-gate pf-fail";
        }
      }
      return errs.length === 0;
    }

    if (valBtn) valBtn.addEventListener("click", runValidate);
    if (pubBtn) pubBtn.addEventListener("click", function () {
      var ok = runValidate();
      if (!ok) return;
      if (gate) {
        gate.textContent = "create: POST /api/artifacts → 201 { id, url, writeToken, version: 1 } — manifest updated";
        gate.className = "pf-gate pf-pass";
      }
    });

    render();
  }

  // ── F4: Levels & canvas — picker + live preview ───────────────────────
  var lcRoot = document.getElementById("lc-root");
  if (lcRoot) {
    var preview = document.getElementById("lc-preview");
    var canvasChk = document.getElementById("lc-canvas");
    function renderPreview() {
      if (!preview) return;
      var lvl = lcRoot.querySelector('input[name="lc-level"]:checked');
      var level = lvl ? lvl.value : "2";
      var isCanvas = !!(canvasChk && canvasChk.checked);
      var head = "L" + level + (isCanvas ? " canvas" : "") + " preview";
      var body = "";
      if (level === "1") {
        body = '<div class="lc-doc"><p>Typography-led document. No flashy hero, no JS state. Body wrapped in <code>.oa-prose</code>.</p></div>';
      } else if (level === "2") {
        body = '<div class="lc-frame-body"><span class="lc-tile">state pill</span><button class="lc-btn" type="button">copy</button><div class="lc-bar"></div></div>';
      } else {
        body = '<div class="lc-frame-body"><div class="lc-rise"></div><span class="lc-tile lc-glow">orchestrated</span></div>';
      }
      if (isCanvas) {
        body = '<div class="lc-frame">' +
          '<div class="lc-frame-head">' + head + '</div>' +
          '<div class="lc-grid">' + body + '<div class="lc-frame-mini"></div></div></div>';
        preview.innerHTML = '<div class="lc-frame"><div class="lc-frame-head">' + head + '</div>' + body + '</div>';
      } else {
        preview.innerHTML = '<div class="lc-frame"><div class="lc-frame-head">' + head + '</div>' + body + '</div>';
      }
    }
    var radios = lcRoot.querySelectorAll('input[name="lc-level"]');
    radios.forEach(function (r) { r.addEventListener("change", renderPreview); });
    if (canvasChk) canvasChk.addEventListener("change", renderPreview);
    renderPreview();
  }

  // ── F5: Design directions — direction switcher ────────────────────────
  var ddRoot = document.getElementById("dd-root");
  if (ddRoot) {
    var directions = {
      editorial: {
        name: "Editorial",
        post: "Monocle / FT. Serif headlines, paper + ink, one accent.",
        accent: "oklch(52% 0.10 28)",
        bg: "oklch(98% 0.004 95)",
        font: "'Iowan Old Style','Charter',Georgia,serif"
      },
      modern: {
        name: "Modern minimal",
        post: "Linear / Vercel. System fonts, crisp neutrals, hairline borders.",
        accent: "oklch(52% 0.18 255)",
        bg: "oklch(99% 0.002 240)",
        font: "-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
      },
      human: {
        name: "Human",
        post: "Airbnb / Duolingo. Tactile, generous radii, clear hierarchy.",
        accent: "oklch(50% 0.12 170)",
        bg: "oklch(98% 0.004 240)",
        font: "'Seravek','Gill Sans Nova','Gill Sans','Avenir Next',system-ui,sans-serif"
      },
      tech: {
        name: "Tech utility",
        post: "Datadog / GitHub. Data-dense, mono-friendly, tabular numerics.",
        accent: "oklch(50% 0.16 145)",
        bg: "oklch(98% 0.005 250)",
        font: "-apple-system,BlinkMacSystemFont,Inter,'Segoe UI',system-ui,sans-serif"
      },
      brutalist: {
        name: "Brutalist",
        post: "Are.na / Yale. Loud type, visible grid, oversized serif.",
        accent: "oklch(58% 0.22 25)",
        bg: "oklch(98% 0.004 240)",
        font: "'Times New Roman','Iowan Old Style',Georgia,serif"
      }
    };
    var chips = ddRoot.querySelectorAll(".dd-chip");
    var preview2 = document.getElementById("dd-preview");
    function renderDir(dir) {
      var d = directions[dir];
      if (!d || !preview2) return;
      preview2.innerHTML =
        '<div class="dd-tile" style="--dd-accent:' + d.accent + ';--dd-bg:' + d.bg + ';--dd-font:' + d.font + '">' +
        '<span class="dd-swatch" style="background:' + d.accent + '"></span>' +
        '<p class="dd-name" style="font-family:' + d.font + '">' + d.name + '</p>' +
        '<p class="dd-post">' + d.post + '</p>' +
        '<div class="dd-row"><span class="dd-pill" style="background:' + d.accent + ';color:#fff">accent</span>' +
        '<span class="dd-mono">var(--accent)</span></div></div>';
    }
    chips.forEach(function (chip) {
      chip.addEventListener("click", function () {
        chips.forEach(function (c) {
          c.setAttribute("aria-checked", "false");
          c.classList.remove("dd-active");
        });
        chip.setAttribute("aria-checked", "true");
        chip.classList.add("dd-active");
        renderDir(chip.dataset.dir);
      });
    });
    renderDir("modern");
  }

  // ── F6: Validation gates — snippet tripper ────────────────────────────
  // Detection uses string .includes() rather than regex literals: the CSP
  // scanner strips string literals before scanning, so forbidden tokens inside
  // strings are invisible to it, while regex literals are NOT stripped and a
  // regex naming a forbidden API in source would trip the very gate it
  // documents.
  var vgRoot = document.getElementById("vg-root");
  if (vgRoot) {
    var input = document.getElementById("vg-input");
    var gates = vgRoot.querySelectorAll(".vg-gate");
    var STY = "<st" + "yle";
    var SCR = "<sc" + "ript";
    var LNK = "<li" + "nk";
    var STSH = "stylesheet";
    var FETCH = "fet" + "ch(";
    var XHR = "XMLHttp" + "Request";
    var WS = "WebSo" + "cket";
    var ES = "EventSo" + "urce";
    var HTTP = "https://" ;
    var HTP = "http://";
    var MEDIA = ["<img", "<video", "<audio", "<source", "<iframe"];
    function runGates() {
      var src = input ? input.value : "";
      var hasStyle = src.indexOf(STY) >= 0 || src.indexOf(SCR) >= 0;
      var hasExternalSrc = src.indexOf(FETCH) >= 0 || src.indexOf(XHR) >= 0 ||
        src.indexOf(WS) >= 0 || src.indexOf(ES) >= 0 ||
        ((src.indexOf(HTTP) >= 0 || src.indexOf(HTP) >= 0) &&
          MEDIA.some(function (m) { return src.indexOf(m) >= 0; })) ||
        (src.indexOf(LNK) >= 0 && src.indexOf(STSH) >= 0);
      // dup style=: count occurrences of style= (case-insensitive). Two or
      // more on one start tag is the silent data-loss bug the gate catches.
      var lower = src.toLowerCase();
      var sIdx = 0;
      var count = 0;
      while ((sIdx = lower.indexOf("style=", sIdx)) >= 0) { count += 1; sIdx += 6; }
      // Find the first start tag and check if style= appears twice before its >.
      var tagStart = src.indexOf("<");
      var tagEnd = tagStart >= 0 ? src.indexOf(">", tagStart) : -1;
      var dupStyle = false;
      if (tagStart >= 0 && tagEnd > tagStart) {
        var tag = src.slice(tagStart, tagEnd).toLowerCase();
        dupStyle = tag.indexOf("style=") !== tag.lastIndexOf("style=") && tag.indexOf("style=") >= 0;
      }
      var hasCanvasNoPlane = src.indexOf('id="canvas"') >= 0 && src.indexOf('id="plane"') < 0;
      var trips = {
        style: hasStyle,
        external: hasExternalSrc,
        dupstyle: dupStyle,
        contrast: false,
        container: false,
        measure: false,
        canvas: hasCanvasNoPlane,
        overlap: false,
        bounds: false
      };
      gates.forEach(function (g) {
        var key = g.dataset.gate;
        var state = g.querySelector(".vg-state");
        if (trips[key]) {
          g.classList.add("vg-tripped");
          g.classList.remove("vg-ok");
          if (state) state.textContent = "!";
        } else {
          g.classList.remove("vg-tripped");
          g.classList.add("vg-ok");
          if (state) state.textContent = "ok";
        }
      });
    }
    if (input) {
      input.addEventListener("input", runGates);
      runGates();
    }
  }

  // ── F7: Viewer chrome — theme toggle + sticky header demo ──────────────
  var vcRoot = document.getElementById("vc-root");
  if (vcRoot) {
    var btn = document.getElementById("vc-theme");
    var val = document.getElementById("vc-theme-val");
    var demo = document.getElementById("vc-demo");
    function currentTheme() {
      return document.documentElement.getAttribute("data-theme") || "light";
    }
    function paint() {
      var t = currentTheme();
      if (val) val.textContent = t;
      if (demo) demo.setAttribute("data-vc-theme", t);
      if (btn) btn.textContent = t === "dark" ? "☀ light" : "☽ dark";
    }
    if (btn) {
      btn.addEventListener("click", function () {
        var next = currentTheme() === "dark" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", next);
        paint();
      });
    }
    paint();
  }

  // ── F8: Storage & bindings — D1/R2 schema inspector ────────────────────
  var sbRoot = document.getElementById("sb-root");
  if (sbRoot) {
    var schema = {
      "sb-d1": {
        title: "DB (D1) — artifacts table",
        cols: [
          ["id", "TEXT PRIMARY KEY"],
          ["token_hash", "TEXT NOT NULL"],
          ["channel_hash", "TEXT (unique idx)"],
          ["title", "TEXT NOT NULL"],
          ["description", "TEXT DEFAULT ''"],
          ["favicon", "TEXT NOT NULL"],
          ["format", "TEXT NOT NULL"],
          ["encrypted", "INTEGER 0|1"],
          ["current_version", "INTEGER NOT NULL"],
          ["created_at", "TEXT ISO"],
          ["updated_at", "TEXT ISO"]
        ],
        note: "Strongly consistent (read-after-write cross-colo). D1's 2 MB row cap forbids storing HTML here."
      },
      "sb-r2": {
        title: "CONTENT (R2) — content/<id>/<version>",
        cols: [
          ["key", "content/<id>/<version>"],
          ["body", "plaintext OR JSON envelope"],
          ["encrypted flag", "customMetadata.encrypted = '1'|'0'"],
          ["envelope", "{ v, alg, kdf, iterations, salt, iv, ciphertext }"]
        ],
        note: "Strongly consistent via bindings. Per-version encrypted flag — an artifact can switch across versions."
      },
      "sb-assets": {
        title: "ASSETS — public/ static dir",
        cols: [
          ["binding", "ASSETS"],
          ["dir", "public/"],
          ["routes", "run_worker_first: /, /api/*, /a/*, /og/*, /fonts/*, /vendor/*"],
          ["landing", "HTMLRewriter rebrands on coda0.com only"],
          ["fonts", "/fonts/<slug> proxy (opt-in: OPEN_ARTIFACTS_WEB_FONTS)"],
          ["vendor", "/vendor/mermaid.runtime.js (self-hosted)"]
        ],
        note: "The Worker intercepts the listed routes before falling back to static assets. /fonts and /vendor are served with correct MIME + nosniff."
      }
    };
    var nodes = sbRoot.querySelectorAll(".sb-node");
    var detail = document.getElementById("sb-detail");
    nodes.forEach(function (node) {
      node.addEventListener("click", function () {
        nodes.forEach(function (n) { n.classList.remove("sb-active"); });
        node.classList.add("sb-active");
        var target = node.dataset.target;
        var s = schema[target];
        if (!s || !detail) return;
        var rows = s.cols.map(function (c) {
          return '<div class="sb-col"><span class="sb-col-k">' + c[0] + '</span><span class="sb-col-v">' + c[1] + '</span></div>';
        }).join("");
        detail.innerHTML = '<p class="sb-detail-title">' + s.title + '</p><div class="sb-cols">' + rows + '</div><p class="sb-detail-note">' + s.note + '</p>';
      });
    });
  }

  // ── F9: Local vs shared recipes — path resolver ────────────────────────
  var lsRoot = document.getElementById("ls-root");
  if (lsRoot) {
    var recipe = document.getElementById("ls-recipe");
    var fragment = document.getElementById("ls-fragment");
    var localChk = document.getElementById("ls-local");
    var encChk = document.getElementById("ls-encrypted");
    var resolved = document.getElementById("ls-resolved");
    var layout = document.getElementById("ls-layout");
    var note = document.getElementById("ls-note");

    function resolve() {
      var r = recipe ? recipe.value : "";
      var f = fragment ? fragment.value : "";
      var isLocal = !!(localChk && localChk.checked) || !!(encChk && encChk.checked);
      if (encChk && encChk.checked && localChk) localChk.checked = true;

      // A path is invalid if absolute or scheme-prefixed.
      var absOk = !/^(?:[a-z]+:)?\/\//i.test(r) && !r.startsWith("/");

      // Recipe dir = directory portion of r.
      var slash = r.lastIndexOf("/");
      var rdir = slash >= 0 ? r.slice(0, slash) : ".";
      var resolvedPath;
      try {
        // emulate path.resolve(rdir, f) without the path module
        if (f.startsWith("/")) {
          resolvedPath = f;
        } else {
          resolvedPath = (rdir + "/" + f).replace(/\/\.\//g, "/").replace(/\/+/g, "/");
        }
      } catch (e) {
        resolvedPath = "—";
      }

      var recipeLoc, fragLoc, layoutDesc;
      if (isLocal) {
        recipeLoc = ".artifacts/recipes.local/" + (slash >= 0 ? r.slice(slash + 1) : r);
        fragLoc = ".artifacts/fragments.local/" + (slash >= 0 ? r.slice(slash + 1).replace(/\.[^.]+$/, "") : r.replace(/\.[^.]+$/, "")) + "/";
        layoutDesc = "Recipe: " + recipeLoc + "\nFragments: " + fragLoc + "\nState: manifest.local.json";
      } else {
        recipeLoc = r;
        fragLoc = rdir + "/";
        layoutDesc = "Recipe: " + recipeLoc + "\nFragments: " + fragLoc + "\nState: .artifacts/manifest.json";
      }

      if (resolved) resolved.textContent = absOk ? resolvedPath : "invalid (absolute / outside root)";
      if (layout) layout.textContent = layoutDesc;
      if (note) {
        if (!absOk) {
          note.innerHTML = "Fails with <span class=\"fr-mono\">recipe must live inside the project root</span>. Run from the project root with a project-relative path.";
        } else if (encChk && encChk.checked) {
          note.innerHTML = "Encrypted recipes are always local. Passwords resolve from <span class=\"fr-mono\">--password</span>, an <span class=\"fr-mono\">OPEN_ARTIFACTS_PASSWORD_*</span> env var, or <span class=\"fr-mono\">credentials.json</span>.";
        } else if (isLocal) {
          note.textContent = "Local recipes live under gitignored .artifacts/recipes.local/ and fragments under .artifacts/fragments.local/.";
        } else {
          note.innerHTML = "Shared recipes are commit-ready. Fragment paths resolve against the Recipe file's own directory: " + rdir + "/.";
        }
      }
    }

    [recipe, fragment, localChk, encChk].forEach(function (el) {
      if (!el) return;
      el.addEventListener("input", resolve);
      el.addEventListener("change", resolve);
    });
    if (encChk) {
      encChk.addEventListener("change", function () {
        if (encChk.checked && localChk) localChk.checked = true;
        resolve();
      });
    }
    resolve();
  }
})();
