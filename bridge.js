// Isolated-world bridge: mirrors chrome.storage settings into a DOM attribute
// that the MAIN-world content script can read (MAIN world has no chrome.* access).
(function () {
  "use strict";
  const DEFAULTS = { collapseToolbar: true, showStats: true, enableSpeaker: true, enableMic: false };

  function write(cfg) {
    try {
      document.documentElement.setAttribute("data-glkvm-cfg", JSON.stringify(Object.assign({}, DEFAULTS, cfg)));
    } catch (_) {}
  }

  function sync() {
    try { chrome.storage.sync.get(DEFAULTS, write); }
    catch (_) { write(DEFAULTS); }
  }

  sync();
  // documentElement may not exist yet at document_start in rare cases.
  if (!document.documentElement) document.addEventListener("DOMContentLoaded", sync, { once: true });

  try {
    chrome.storage.onChanged.addListener((_changes, area) => { if (area === "sync") sync(); });
  } catch (_) {}
})();
