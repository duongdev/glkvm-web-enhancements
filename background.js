// Service worker: keeps the toolbar icon in color only on tabs where the
// extension actually runs, and monotone everywhere else.
//
// The icon is set per-tab, so Chrome already shows the right one for the
// focused tab. A tab is "active" only once bridge.js — which is injected
// solely on the matched GLKVM hosts — pings in; any navigation drops the
// tab back to monotone until (and unless) bridge.js pings again.
"use strict";

const COLOR_ICON = {
  16: "icons/icon-16.png",
  32: "icons/icon-32.png",
  48: "icons/icon-48.png",
  128: "icons/icon-128.png",
};
const MONO_ICON = {
  16: "icons/icon-mono-16.png",
  32: "icons/icon-mono-32.png",
  48: "icons/icon-mono-48.png",
  128: "icons/icon-mono-128.png",
};

function setIcon(tabId, path) {
  // Rejects if the tab is already gone — harmless, so swallow it.
  chrome.action.setIcon({ tabId, path }).catch(() => {});
}

// A navigating tab is monotone until its content script reports back. If it
// loads a GLKVM page, bridge.js re-colors it; otherwise it stays monotone.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") setIcon(tabId, MONO_ICON);
});

// bridge.js runs only on the matched GLKVM hosts, so its ping means the
// extension has effect on this tab — light the icon up.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === "glkvm-active" && sender.tab && sender.tab.id != null) {
    setIcon(sender.tab.id, COLOR_ICON);
  }
});
