(function () {
  "use strict";

  var navLinks = Array.prototype.slice.call(
    document.querySelectorAll(".oa-nav-link"),
  );
  var sections = navLinks
    .map(function (link) {
      return document.getElementById(link.getAttribute("data-target"));
    })
    .filter(Boolean);

  function setActive(id) {
    navLinks.forEach(function (link) {
      var target = link.getAttribute("data-target");
      if (target === id) {
        link.classList.add("is-active");
        link.setAttribute("aria-current", "true");
      } else {
        link.classList.remove("is-active");
        link.removeAttribute("aria-current");
      }
    });
  }

  if ("IntersectionObserver" in window && sections.length) {
    var spy = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            setActive(entry.target.id);
          }
        });
      },
      {
        rootMargin: "-30% 0px -60% 0px",
        threshold: 0,
      },
    );
    sections.forEach(function (sec) {
      spy.observe(sec);
    });
  }

  navLinks.forEach(function (link) {
    link.addEventListener("click", function (e) {
      var target = link.getAttribute("data-target");
      if (target) {
        setActive(target);
      }
    });
  });

  var copyButtons = Array.prototype.slice.call(
    document.querySelectorAll("[data-copy]"),
  );
  copyButtons.forEach(function (btn) {
    var block = btn.closest("[data-copyable]");
    if (!block) return;
    var codeEl = block.querySelector("pre code");
    if (!codeEl) return;

    btn.addEventListener("click", function () {
      var text = codeEl.textContent;
      var label = btn.querySelector(".oa-copy-text");
      var original = label ? label.textContent : "";
      var done = false;

      function onSuccess() {
        if (done) return;
        done = true;
        btn.classList.add("is-copied");
        if (label) label.textContent = "已复制";
        setTimeout(function () {
          btn.classList.remove("is-copied");
          if (label) label.textContent = original;
        }, 2000);
      }

      function fallbackCopy() {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
          onSuccess();
        } catch (err) {}
        document.body.removeChild(ta);
      }

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
          .writeText(text)
          .then(onSuccess)
          .catch(function () {
            fallbackCopy();
          });
      } else {
        fallbackCopy();
      }
    });
  });
})();
