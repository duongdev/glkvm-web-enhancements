const DEFAULTS = { collapseToolbar: true, showStats: true, enableSpeaker: true, enableMic: false };
const KEYS = Object.keys(DEFAULTS);
const saved = document.getElementById("saved");
let savedTimer = null;

function flashSaved() {
  saved.classList.add("show");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => saved.classList.remove("show"), 1200);
}

chrome.storage.sync.get(DEFAULTS, (cfg) => {
  KEYS.forEach((k) => {
    const el = document.getElementById(k);
    el.checked = !!cfg[k];
    el.addEventListener("change", () => {
      chrome.storage.sync.set({ [k]: el.checked }, flashSaved);
    });
  });
});
