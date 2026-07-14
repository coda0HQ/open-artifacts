/* Pixel Grid Editor — in-memory state, no localStorage, no fetch.
 * Tools: paint / eraser / fill / eyedropper. Sizes: 8 / 16 / 32.
 * Undo/redo bounded history. Live preview at native res. PNG export
 * degrades gracefully (clipboard may be blocked under sandbox CSP). */
(function () {
  "use strict";

  var PALETTE = [
    "#000000", "#ffffff", "#7f7f7f", "#c3c3c3",
    "#880015", "#ed1c24", "#ff7f27", "#fff200",
    "#22b14c", "#00a2e8", "#3f48cc", "#a349a4",
    "#b97a56", "#aecf00", "#ffaec9", "#ffc90e"
  ];

  var SIZES = [8, 16, 32];
  var INITIAL_SIZE = 16;
  var INITIAL_COLOR = PALETTE[1]; /* white-on-canvas-dark default reads well */
  var MAX_HISTORY = 200;

  var state = {
    size: INITIAL_SIZE,
    pixels: makePixels(INITIAL_SIZE),
    color: INITIAL_COLOR,
    tool: "paint",
    gridlines: true,
    history: [],
    future: [],
    painting: false,
    lastCell: null,
  };

  /* ── DOM ─────────────────────────────────────────────────────────── */
  var canvas = document.getElementById("canvas");
  var ctx = canvas.getContext("2d");
  var previewCanvas = document.getElementById("preview-canvas");
  var previewCtx = previewCanvas.getContext("2d");
  var paletteEl = document.getElementById("palette");
  var currentSwatch = document.getElementById("current-swatch");
  var currentHex = document.getElementById("current-hex");
  var coordEl = document.getElementById("coord");
  var dimEl = document.getElementById("dim");
  var previewNote = document.getElementById("preview-note");
  var btnUndo = document.getElementById("btn-undo");
  var btnRedo = document.getElementById("btn-redo");
  var btnClear = document.getElementById("btn-clear");
  var btnGridlines = document.getElementById("btn-gridlines");
  var btnCopy = document.getElementById("btn-copy");
  var btnDownload = document.getElementById("btn-download");

  /* ── Init ────────────────────────────────────────────────────────── */
  function makePixels(size) {
    var n = size * size;
    var arr = new Array(n);
    for (var i = 0; i < n; i++) arr[i] = null; /* null = transparent */
    return arr;
  }

  function buildPalette() {
    paletteEl.innerHTML = "";
    PALETTE.forEach(function (hex, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "swatch";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(hex === state.color));
      b.setAttribute("aria-label", "Color " + hex);
      b.title = hex;
      b.style.setProperty("--swatch-color", hex);
      b.dataset.color = hex;
      b.addEventListener("click", function () {
        setColor(hex);
      });
      paletteEl.appendChild(b);
    });
  }

  function setColor(hex) {
    state.color = hex;
    currentSwatch.style.setProperty("--current-color", hex);
    currentHex.textContent = hex.toUpperCase();
    var swatches = paletteEl.querySelectorAll(".swatch");
    for (var i = 0; i < swatches.length; i++) {
      swatches[i].setAttribute("aria-checked", String(swatches[i].dataset.color === hex));
    }
  }

  function setTool(tool) {
    state.tool = tool;
    var tools = document.querySelectorAll(".tool");
    for (var i = 0; i < tools.length; i++) {
      var active = tools[i].dataset.tool === tool;
      tools[i].classList.toggle("tool--active", active);
      tools[i].setAttribute("aria-pressed", String(active));
    }
    canvas.setAttribute("data-tool", tool);
  }

  function setSize(size) {
    if (size === state.size) return;
    /* Resample: preserve top-left overlap, lose the rest (classic pixel-tool behavior). */
    var oldPixels = state.pixels;
    var oldSize = state.size;
    var newPixels = makePixels(size);
    var min = Math.min(oldSize, size);
    for (var y = 0; y < min; y++) {
      for (var x = 0; x < min; x++) {
        newPixels[y * size + x] = oldPixels[y * oldSize + x];
      }
    }
    pushHistory();
    state.size = size;
    state.pixels = newPixels;
    previewCanvas.width = size;
    previewCanvas.height = size;
    dimEl.textContent = size + "×" + size;
    var sizeBtns = document.querySelectorAll(".size");
    for (var i = 0; i < sizeBtns.length; i++) {
      var active = Number(sizeBtns[i].dataset.size) === size;
      sizeBtns[i].classList.toggle("size--active", active);
      sizeBtns[i].setAttribute("aria-pressed", String(active));
    }
    render();
  }

  /* ── History ─────────────────────────────────────────────────────── */
  function pushHistory() {
    state.history.push({ size: state.size, pixels: state.pixels.slice() });
    if (state.history.length > MAX_HISTORY) state.history.shift();
    state.future = [];
    updateHistoryButtons();
  }

  function undo() {
    if (state.history.length === 0) return;
    state.future.push({ size: state.size, pixels: state.pixels.slice() });
    var prev = state.history.pop();
    state.size = prev.size;
    state.pixels = prev.pixels;
    previewCanvas.width = state.size;
    previewCanvas.height = state.size;
    dimEl.textContent = state.size + "×" + state.size;
    syncSizeButtons();
    render();
    updateHistoryButtons();
  }

  function redo() {
    if (state.future.length === 0) return;
    state.history.push({ size: state.size, pixels: state.pixels.slice() });
    var next = state.future.pop();
    state.size = next.size;
    state.pixels = next.pixels;
    previewCanvas.width = state.size;
    previewCanvas.height = state.size;
    dimEl.textContent = state.size + "×" + state.size;
    syncSizeButtons();
    render();
    updateHistoryButtons();
  }

  function syncSizeButtons() {
    var sizeBtns = document.querySelectorAll(".size");
    for (var i = 0; i < sizeBtns.length; i++) {
      var active = Number(sizeBtns[i].dataset.size) === state.size;
      sizeBtns[i].classList.toggle("size--active", active);
      sizeBtns[i].setAttribute("aria-pressed", String(active));
    }
  }

  function updateHistoryButtons() {
    btnUndo.disabled = state.history.length === 0;
    btnRedo.disabled = state.future.length === 0;
  }

  /* ── Painting ────────────────────────────────────────────────────── */
  function cellFromEvent(e) {
    var rect = canvas.getBoundingClientRect();
    var cx, cy;
    if (e.touches && e.touches.length) {
      cx = e.touches[0].clientX;
      cy = e.touches[0].clientY;
    } else {
      cx = e.clientX;
      cy = e.clientY;
    }
    var x = (cx - rect.left) / rect.width;
    var y = (cy - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    var px = Math.min(state.size - 1, Math.max(0, Math.floor(x * state.size)));
    var py = Math.min(state.size - 1, Math.max(0, Math.floor(y * state.size)));
    return { x: px, y: py };
  }

  function paintCell(x, y) {
    var idx = y * state.size + x;
    if (state.tool === "paint") state.pixels[idx] = state.color;
    else if (state.tool === "eraser") state.pixels[idx] = null;
  }

  function fillBucket(x, y) {
    var idx = y * state.size + x;
    var target = state.pixels[idx];
    if (target === state.color) return;
    var size = state.size;
    var stack = [[x, y]];
    while (stack.length) {
      var p = stack.pop();
      var px = p[0], py = p[1];
      if (px < 0 || px >= size || py < 0 || py >= size) continue;
      var i = py * size + px;
      if (state.pixels[i] !== target) continue;
      state.pixels[i] = state.color;
      stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
    }
  }

  function eyedrop(x, y) {
    var c = state.pixels[y * state.size + x];
    if (c) setColor(c);
  }

  function applyTool(x, y, isStart) {
    if (state.tool === "fill") {
      if (isStart) { fillBucket(x, y); }
    } else if (state.tool === "eyedropper") {
      if (isStart) { eyedrop(x, y); setTool("paint"); }
    } else {
      paintCell(x, y);
      /* Interpolate between last cell and current to avoid gaps on fast drag. */
      if (state.lastCell) {
        var dx = x - state.lastCell.x;
        var dy = y - state.lastCell.y;
        var steps = Math.max(Math.abs(dx), Math.abs(dy));
        for (var s = 1; s < steps; s++) {
          var ix = Math.round(state.lastCell.x + (dx * s) / steps);
          var iy = Math.round(state.lastCell.y + (dy * s) / steps);
          paintCell(ix, iy);
        }
      }
    }
  }

  function onPointerDown(e) {
    e.preventDefault();
    var cell = cellFromEvent(e);
    if (!cell) return;
    pushHistory();
    state.painting = true;
    state.lastCell = null;
    applyTool(cell.x, cell.y, true);
    state.lastCell = cell;
    render();
  }

  function onPointerMove(e) {
    var cell = cellFromEvent(e);
    if (cell) {
      coordEl.textContent = pad(cell.x, state.size) + "," + pad(cell.y, state.size);
    } else {
      coordEl.textContent = "—";
    }
    if (!state.painting) return;
    if (!cell) return;
    if (state.lastCell && state.lastCell.x === cell.x && state.lastCell.y === cell.y) return;
    applyTool(cell.x, cell.y, false);
    state.lastCell = cell;
    render();
  }

  function onPointerUp() {
    if (state.painting) {
      state.painting = false;
      state.lastCell = null;
    }
  }

  function pad(n, size) {
    var s = String(n);
    var w = size >= 32 ? 2 : (size >= 16 ? 2 : 1);
    while (s.length < w) s = "0" + s;
    return s;
  }

  /* ── Render ───────────────────────────────────────────────────────── */
  function render() {
    var size = state.size;
    var cell = Math.floor(canvas.width / size);
    var dim = cell * size;
    var bg = getComputedStyle(document.body).backgroundColor;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    /* Checker background for transparency. */
    var checker = 8;
    for (var y = 0; y < dim; y += checker) {
      for (var x = 0; x < dim; x += checker) {
        if ((((x / checker) + (y / checker)) % 2) === 0) {
          ctx.fillStyle = "rgba(127,127,127,0.18)";
        } else {
          ctx.fillStyle = "rgba(127,127,127,0.32)";
        }
        ctx.fillRect(x, y, checker, checker);
      }
    }

    /* Pixels. */
    for (var py = 0; py < size; py++) {
      for (var px = 0; px < size; px++) {
        var c = state.pixels[py * size + px];
        if (c) {
          ctx.fillStyle = c;
          ctx.fillRect(px * cell, py * cell, cell, cell);
        }
      }
    }

    /* Gridlines. */
    if (state.gridlines && cell >= 4) {
      ctx.strokeStyle = "rgba(127,127,127,0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (var gx = 0; gx <= size; gx++) {
        var X = Math.floor(gx * cell) + 0.5;
        ctx.moveTo(X, 0);
        ctx.lineTo(X, dim);
      }
      for (var gy = 0; gy <= size; gy++) {
        var Y = Math.floor(gy * cell) + 0.5;
        ctx.moveTo(0, Y);
        ctx.lineTo(dim, Y);
      }
      ctx.stroke();
    }

    renderPreview();
  }

  function renderPreview() {
    var size = state.size;
    previewCanvas.width = size;
    previewCanvas.height = size;
    previewCtx.clearRect(0, 0, size, size);
    for (var py = 0; py < size; py++) {
      for (var px = 0; px < size; px++) {
        var c = state.pixels[py * size + px];
        if (c) {
          previewCtx.fillStyle = c;
          previewCtx.fillRect(px, py, 1, 1);
        }
      }
    }
    previewNote.textContent = size + "×" + size + " — 1px = 1px, scaled up.";
  }

  /* ── Export ───────────────────────────────────────────────────────── */
  function exportPNG() {
    /* Render at native pixel resolution (1px per cell), no gridlines. */
    var size = state.size;
    var c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    var cx = c.getContext("2d");
    cx.imageSmoothingEnabled = false;
    for (var py = 0; py < size; py++) {
      for (var px = 0; px < size; px++) {
        var col = state.pixels[py * size + px];
        if (col) {
          cx.fillStyle = col;
          cx.fillRect(px, py, 1, 1);
        }
      }
    }
    return c;
  }

  function copyPNG() {
    var c = exportPNG();
    c.toBlob(function (blob) {
      if (!blob) { downloadPNG(c); return; }
      if (navigator.clipboard && navigator.clipboard.write && window.ClipboardItem) {
        var item = new ClipboardItem({ "image/png": blob });
        navigator.clipboard.write([item]).then(function () {
          flash(btnCopy, "Copied");
        }).catch(function () {
          downloadPNG(c);
          flash(btnCopy, "Downloaded (clipboard blocked)");
        });
      } else {
        downloadPNG(c);
        flash(btnCopy, "Downloaded (no clipboard)");
      }
    }, "image/png");
  }

  function downloadPNG(c) {
    var dataUrl = c.toDataURL("image/png");
    btnDownload.href = dataUrl;
    var a = document.createElement("a");
    a.href = dataUrl;
    a.download = "pixel-art-" + state.size + "x" + state.size + ".png";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function flash(btn, msg) {
    var label = btn.querySelector(".action__label");
    if (!label) return;
    var original = label.textContent;
    label.textContent = msg;
    setTimeout(function () { label.textContent = original; }, 1600);
  }

  /* ── Clear ───────────────────────────────────────────────────────── */
  function clearCanvas() {
    pushHistory();
    state.pixels = makePixels(state.size);
    render();
  }

  /* ── Gridlines toggle ────────────────────────────────────────────── */
  function toggleGridlines() {
    state.gridlines = !state.gridlines;
    btnGridlines.setAttribute("aria-pressed", String(state.gridlines));
    btnGridlines.classList.toggle("action--active", state.gridlines);
    render();
  }

  /* ── Keyboard ─────────────────────────────────────────────────────── */
  function isMac() {
    return /Mac|iPhone|iPad/.test(navigator.platform) || /Mac/.test(navigator.userAgent);
  }

  function onKey(e) {
    /* Ignore typing in inputs. */
    var tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return;

    var meta = isMac() ? e.metaKey : e.ctrlKey;
    var key = e.key.toLowerCase();

    if (meta && key === "z") {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (meta && key === "y") { e.preventDefault(); redo(); return; }

    if (e.key === "Escape") { setTool("paint"); return; }

    switch (key) {
      case "p": case "b": setTool("paint"); break;
      case "e": setTool("eraser"); break;
      case "g": setTool("fill"); break;
      case "i": setTool("eyedropper"); break;
    }
  }

  /* ── Wire up ──────────────────────────────────────────────────────── */
  function wire() {
    /* Pointer events on the canvas. */
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointerleave", function () { coordEl.textContent = "—"; });

    /* Tools. */
    var tools = document.querySelectorAll(".tool");
    for (var i = 0; i < tools.length; i++) {
      (function (btn) {
        btn.addEventListener("click", function () { setTool(btn.dataset.tool); });
      })(tools[i]);
    }

    /* Sizes. */
    var sizes = document.querySelectorAll(".size");
    for (var j = 0; j < sizes.length; j++) {
      (function (btn) {
        btn.addEventListener("click", function () { setSize(Number(btn.dataset.size)); });
      })(sizes[j]);
    }

    /* History + actions. */
    btnUndo.addEventListener("click", undo);
    btnRedo.addEventListener("click", redo);
    btnClear.addEventListener("click", clearCanvas);
    btnGridlines.addEventListener("click", toggleGridlines);
    btnCopy.addEventListener("click", copyPNG);
    btnDownload.addEventListener("click", function (e) {
      var c = exportPNG();
      downloadPNG(c);
      e.preventDefault();
    });

    /* Keyboard. */
    document.addEventListener("keydown", onKey);

    /* Theme change re-renders (gridline color follows body bg via rgba, fine). */
    var observer = new MutationObserver(function () { render(); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }

  /* ── Boot ─────────────────────────────────────────────────────────── */
  function boot() {
    buildPalette();
    setColor(state.color);
    setTool(state.tool);
    dimEl.textContent = state.size + "×" + state.size;
    previewCanvas.width = state.size;
    previewCanvas.height = state.size;
    wire();
    updateHistoryButtons();
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
