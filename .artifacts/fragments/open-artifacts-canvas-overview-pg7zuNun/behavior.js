/* Canvas runtime JS (vendored verbatim from references/canvas.md). */


/* Frame-internal interactions: tab switching and copy-to-clipboard.
   These run inside frame bodies, which are live only when the frame is
   focused (inert is toggled by the canvas runtime). State is in-memory. */
(function () {
  const tablist = document.querySelector("#levels-canvas .fr-tabs");
  if (tablist) {
    const tabs = [...tablist.querySelectorAll("button")];
    tablist.addEventListener("click", (e) => {
      const tab = e.target.closest("button[role='tab']");
      if (!tab) return;
      const selected = tab.getAttribute("aria-selected") === "true";
      if (selected) return;
      for (const t of tabs) {
        const isOn = t === tab;
        t.setAttribute("aria-selected", String(isOn));
        const panel = document.getElementById(t.getAttribute("aria-controls"));
        if (panel) panel.setAttribute("aria-hidden", String(!isOn));
      }
    });
  }

  const copyBtn = document.getElementById("copy-cmd");
  if (copyBtn) {
    copyBtn.addEventListener("click", () => {
      const cmd = copyBtn.dataset.cmd;
      if (!cmd) return;
      navigator.clipboard?.writeText(cmd).then(() => {
        copyBtn.textContent = "Copied";
        copyBtn.setAttribute("data-state", "copied");
        setTimeout(() => {
          copyBtn.textContent = "Copy command";
          copyBtn.removeAttribute("data-state");
        }, 1500);
      }).catch(() => {});
    });
  }
})();
