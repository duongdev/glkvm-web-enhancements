// GLKVM Web Enhancements — runs in the page's MAIN world at document_start.
// Hooks media APIs before the SPA uses them, then adds device-picker chevrons
// next to the speaker/mic icons, a PiP button, data totals, and toolbar tweaks.
// Feature toggles are read from a DOM attribute mirrored by bridge.js.
(function () {
  "use strict";
  if (window.__kvmMediaExt) return;
  window.__kvmMediaExt = true;

  const LS_MIC = "kvmExt.micId";
  const LS_SPK = "kvmExt.spkId";
  const get = (k) => { try { return localStorage.getItem(k) || ""; } catch (_) { return ""; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };

  // Feature toggles come from the options page via chrome.storage, mirrored by the
  // isolated-world bridge into this attribute (MAIN world can't read chrome.storage).
  const CFG_DEFAULTS = { collapseToolbar: true, showStats: true, enableSpeaker: true, enableMic: false, lockKeyboard: true, showBarFullscreen: true };
  function cfg() {
    try { return Object.assign({}, CFG_DEFAULTS, JSON.parse(document.documentElement.getAttribute("data-glkvm-cfg") || "{}")); }
    catch (_) { return CFG_DEFAULTS; }
  }
  // True once the bridge has mirrored saved settings — load-time actions wait for this
  // so a saved "off" preference isn't overridden by the defaults firing first.
  function cfgReady() { return document.documentElement.hasAttribute("data-glkvm-cfg"); }

  // --- 1. Force the chosen microphone into every getUserMedia({audio}) the SPA makes ---
  const md = navigator.mediaDevices;
  if (md && typeof md.getUserMedia === "function") {
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = function (constraints) {
      try {
        const micId = get(LS_MIC);
        if (micId && constraints && constraints.audio) {
          const a = constraints.audio === true ? {} : Object.assign({}, constraints.audio);
          a.deviceId = { exact: micId };
          constraints = Object.assign({}, constraints, { audio: a });
        }
      } catch (_) {}
      return orig(constraints);
    };
  }

  // --- 2. Capture every peer connection at construction (the KVM stream is receive-only,
  //        so addTrack is never called — we must wrap the constructor itself) ---
  const pcs = new Set();
  if (window.RTCPeerConnection) {
    const Orig = window.RTCPeerConnection;
    function Patched(...args) {
      const pc = new Orig(...args);
      pcs.add(pc);
      pc.addEventListener("connectionstatechange", () => { if (pc.connectionState === "closed") pcs.delete(pc); });
      return pc;
    }
    Patched.prototype = Orig.prototype;
    Object.setPrototypeOf(Patched, Orig);
    window.RTCPeerConnection = Patched;
    try { window.webkitRTCPeerConnection = Patched; } catch (_) {}
  }

  async function applyMic(deviceId) {
    set(LS_MIC, deviceId);
    const senders = [];
    pcs.forEach((pc) => {
      try { pc.getSenders().forEach((s) => { if (s.track && s.track.kind === "audio") senders.push(s); }); } catch (_) {}
    });
    if (!senders.length) return { live: false };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
    const track = stream.getAudioTracks()[0];
    await Promise.all(senders.map((s) => s.replaceTrack(track).catch(() => {})));
    return { live: true };
  }

  // --- 3. Speaker: route playback to the chosen output device ---
  async function applySpeaker(deviceId) {
    set(LS_SPK, deviceId);
    for (const el of document.querySelectorAll("video, audio")) {
      if (typeof el.setSinkId === "function") { try { await el.setSinkId(deviceId); } catch (_) {} }
    }
  }
  document.addEventListener("play", (e) => {
    const spk = get(LS_SPK);
    if (spk && e.target && typeof e.target.setSinkId === "function") e.target.setSinkId(spk).catch(() => {});
  }, true);

  // --- 4. Picture-in-Picture + a "bring video back" overlay while it's active ---
  async function togglePiP() {
    const v = document.getElementById("stream-video") || document.querySelector("video");
    if (!v) return;
    try {
      if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return; }
      v.disablePictureInPicture = false;
      await v.requestPictureInPicture();
    } catch (e) { console.warn("[kvm-ext] PiP failed:", e.message); }
  }
  function pipOverlay(show) {
    const box = document.getElementById("stream-box");
    let ov = document.getElementById("kvm-ext-pip-overlay");
    if (!show) { if (ov) ov.style.display = "none"; return; }
    if (!box) return;
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "kvm-ext-pip-overlay";
      ov.style.cssText =
        "position:absolute;inset:0;z-index:60;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;color:#fff;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:rgba(10,12,16,.72)";
      ov.innerHTML =
        '<svg viewBox="0 0 24 24" width="46" height="46" style="opacity:.9"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="12" y="11" width="8" height="6" rx="1" fill="currentColor"/></svg>' +
        '<div style="font-size:15px;opacity:.85">Playing in Picture-in-Picture</div>' +
        '<button id="kvm-ext-pip-back" style="padding:9px 18px;font-size:14px;font-weight:600;color:#fff;background:#1f6feb;border:none;border-radius:8px;cursor:pointer">Bring video back</button>';
      box.appendChild(ov);
      ov.querySelector("#kvm-ext-pip-back").addEventListener("click", async (e) => {
        e.stopPropagation();
        try { await document.exitPictureInPicture(); } catch (_) {}
      });
    } else if (ov.parentElement !== box) {
      box.appendChild(ov);
    }
    ov.style.display = "flex";
  }
  function bindPiP() {
    const v = document.getElementById("stream-video");
    if (!v || v.dataset.kvmPip) return;
    v.dataset.kvmPip = "1";
    v.addEventListener("enterpictureinpicture", () => pipOverlay(true));
    v.addEventListener("leavepictureinpicture", () => pipOverlay(false));
  }

  // --- 5. Device discovery (labels need a one-time permission grant) ---
  async function listDevices() {
    let granted = false;
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
      granted = true;
    } catch (_) {}
    const devs = await navigator.mediaDevices.enumerateDevices();
    return {
      granted,
      mics: devs.filter((d) => d.kind === "audioinput"),
      spks: devs.filter((d) => d.kind === "audiooutput"),
    };
  }

  // --- 6. Popup menu (shadow root, fixed, opens upward over a chevron) ---
  let popHost, popRoot, menuKind = null;
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function ensurePop() {
    if (popHost) return;
    popHost = document.createElement("div");
    popHost.id = "kvm-ext-pop";
    popHost.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;";
    document.documentElement.appendChild(popHost);
    popRoot = popHost.attachShadow({ mode: "open" });
    popRoot.innerHTML = `
      <style>
        *{box-sizing:border-box;font-family:-apple-system,Segoe UI,Roboto,sans-serif}
        .menu{position:fixed;min-width:200px;max-width:320px;max-height:280px;overflow:auto;
          background:#1c1c22;color:#eee;border:1px solid #3a3a44;border-radius:8px;padding:4px;
          box-shadow:0 8px 28px rgba(0,0,0,.55)}
        .menu[hidden]{display:none}
        .hd{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#778;padding:6px 8px 4px}
        .it{padding:7px 8px;font-size:13px;border-radius:5px;cursor:pointer;white-space:nowrap;
          overflow:hidden;text-overflow:ellipsis}
        .it:hover{background:#2c2c36}
        .it.sel{color:#58a6ff}
        .muted{color:#778;padding:6px 8px;font-size:12px}
      </style>
      <div class="menu" hidden></div>`;
    document.addEventListener("click", (e) => {
      const path = e.composedPath();
      if (path.includes(popHost)) return;
      if (path.some((n) => n.id === "kvm-ext-spk-chev" || n.id === "kvm-ext-mic-chev")) return;
      hideMenu();
    }, true);
    window.addEventListener("resize", hideMenu);
    window.addEventListener("blur", hideMenu);
  }
  function hideMenu() { menuKind = null; if (popRoot) popRoot.querySelector(".menu").hidden = true; }
  function menuOpen() { return popRoot && !popRoot.querySelector(".menu").hidden; }

  function position(menu, anchor) {
    const a = anchor.getBoundingClientRect();
    menu.style.bottom = (window.innerHeight - a.top + 8) + "px";
    const mw = menu.offsetWidth || 220;
    let left = a.right - mw;
    if (left < 8) left = 8;
    menu.style.left = left + "px";
  }

  async function openMenu(kind, anchor) {
    ensurePop();
    menuKind = kind;
    const menu = popRoot.querySelector(".menu");
    const title = kind === "audiooutput" ? "Speaker" : "Microphone";
    menu.hidden = false;
    menu.innerHTML = `<div class="hd">${title}</div><div class="muted">Loading…</div>`;
    position(menu, anchor);
    const r = await listDevices();
    const items = kind === "audiooutput" ? r.spks : r.mics;
    const cur = kind === "audiooutput" ? get(LS_SPK) : get(LS_MIC);
    let html = `<div class="hd">${title}</div>`;
    if (!items.length) html += `<div class="muted">No devices</div>`;
    else if (!r.granted && items.every((d) => !d.label))
      html += `<div class="muted">Allow microphone once<br>to see device names.</div>`;
    items.forEach((d, i) => {
      const seld = d.deviceId === cur ? " sel" : "";
      html += `<div class="it${seld}" data-id="${esc(d.deviceId)}">${d.deviceId === cur ? "✓ " : ""}${esc(d.label || title + " " + (i + 1))}</div>`;
    });
    menu.innerHTML = html;
    menu.querySelectorAll(".it[data-id]").forEach((el) => {
      el.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = el.getAttribute("data-id");
        if (kind === "audiooutput") await applySpeaker(id);
        else await applyMic(id);
        hideMenu();
      });
    });
    position(menu, anchor);
  }

  // --- 7. Total transferred (download/upload) shown next to the kbps text ---
  function fmtBytes(b) {
    if (!b) return "0 B";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return (i === 0 ? b : b.toFixed(b < 10 ? 2 : 1)) + " " + u[i];
  }
  async function netTotals() {
    let rx = 0, tx = 0;
    for (const pc of pcs) {
      if (pc.connectionState === "closed") continue;
      let stats;
      try { stats = await pc.getStats(); } catch (_) { continue; }
      let r = 0, t = 0, via = null;
      stats.forEach((s) => {
        if (s.type === "transport" && typeof s.bytesReceived === "number") { r = s.bytesReceived; t = s.bytesSent || 0; via = "t"; }
      });
      if (!via) stats.forEach((s) => {
        if (s.type === "candidate-pair" && (s.nominated || s.selected) && typeof s.bytesReceived === "number") {
          r = Math.max(r, s.bytesReceived); t = Math.max(t, s.bytesSent || 0);
        }
      });
      rx += r; tx += t;
    }
    return { rx, tx };
  }
  function ensureNet() {
    const bar = document.querySelector(".kvm-video-info");
    if (!bar) return null;
    let n = bar.querySelector("#kvm-ext-net");
    if (!cfg().showStats) { if (n) n.remove(); return null; }
    if (!n) {
      const kbps = bar.querySelector(".frame-text");
      if (!kbps) return null;
      n = document.createElement("span");
      n.id = "kvm-ext-net";
      n.className = kbps.className;
      n.style.cssText = "margin-left:4px;opacity:.85;white-space:nowrap";
      kbps.insertAdjacentElement("afterend", n);
    }
    return n;
  }
  let netTimer = null;
  function startNet() {
    if (netTimer) return;
    netTimer = setInterval(async () => {
      const el = ensureNet();
      if (!el) return;
      const { rx, tx } = await netTotals();
      if (rx || tx) el.textContent = " / ↓ " + fmtBytes(rx) + "  ↑ " + fmtBytes(tx);
    }, 1000);
  }

  // --- 8. Inject chevrons + PiP icon into the bottom status bar ---
  const CHEV = '<svg viewBox="0 0 24 24" width="12" height="12" style="display:block"><path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const PIP = '<svg viewBox="0 0 24 24" width="20" height="20" style="display:block"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="12" y="11" width="8" height="6" rx="1" fill="currentColor"/></svg>';

  function chevron(id, kind) {
    const b = document.createElement("span");
    b.id = id;
    b.title = (kind === "audiooutput" ? "Speaker" : "Microphone") + " device";
    b.style.cssText = "display:inline-flex;align-items:center;cursor:pointer;margin-left:1px;color:var(--gl-color-text-level2,#9aa);opacity:.85";
    b.innerHTML = CHEV;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (menuOpen() && menuKind === kind) hideMenu();
      else openMenu(kind, b);
    });
    return b;
  }

  // The speaker icon sits in a flex row with column-gap; cancel it so its chevron
  // hugs the icon as tightly as the mic's (whose row has no gap).
  function normGap(chev) {
    if (!chev) return;
    const cs = getComputedStyle(chev.parentElement);
    const gap = parseFloat(cs.columnGap) || parseFloat(cs.gap) || 0;
    chev.style.marginLeft = (gap ? -(gap - 1) : 1) + "px";
  }
  function pipIcon() {
    const b = document.createElement("span");
    b.id = "kvm-ext-pip";
    b.title = "Picture-in-Picture";
    b.style.cssText = "display:inline-flex;align-items:center;cursor:pointer;margin-left:12px;color:var(--gl-color-text-level2,#9aa)";
    b.innerHTML = PIP;
    b.addEventListener("click", (e) => { e.stopPropagation(); togglePiP(); });
    return b;
  }

  // Match the speaker icon by symbol prefix so it's found whether it's on
  // (#gl-kvm-sound-full) or off (#gl-kvm-sound-off).
  function findSpeakerIcon(scope) {
    const u = [...scope.querySelectorAll("use")].find(
      (x) => /#gl-kvm-sound/.test(x.getAttribute("xlink:href") || x.getAttribute("href") || "")
    );
    return u ? (u.closest(".volume-icon") || u.closest("span")) : null;
  }

  function tryInject() {
    const bar = document.querySelector(".kvm-video-info");
    if (!bar) return;
    const spk = findSpeakerIcon(bar);
    const mic = bar.querySelector(".mic-status-icon");
    if (spk && !bar.querySelector("#kvm-ext-spk-chev")) {
      spk.insertAdjacentElement("afterend", chevron("kvm-ext-spk-chev", "audiooutput"));
      normGap(bar.querySelector("#kvm-ext-spk-chev"));
    }
    if (mic && !bar.querySelector("#kvm-ext-mic-chev")) {
      mic.insertAdjacentElement("afterend", chevron("kvm-ext-mic-chev", "audioinput"));
      normGap(bar.querySelector("#kvm-ext-mic-chev"));
    }
    if (mic && !bar.querySelector("#kvm-ext-pip")) {
      const ref = bar.querySelector("#kvm-ext-mic-chev") || mic;
      ref.insertAdjacentElement("afterend", pipIcon());
    }
    ensureNet();
    bindPiP();
    // Re-apply stored speaker once devices/elements exist.
    const s = get(LS_SPK);
    if (s) applySpeaker(s);
  }

  // --- 9. Center the collapsed-toolbar expand button (the app leaves it a few px right) ---
  function injectCSS() {
    if (document.getElementById("kvm-ext-style")) return;
    const s = document.createElement("style");
    s.id = "kvm-ext-style";
    s.textContent =
      ".un-collapse-triangle.un-collapse-triangle-collapsed{left:50%!important;transform:translateX(-50%)!important;}";
    (document.head || document.documentElement).appendChild(s);
  }

  // --- 10. Collapse the toolbar by default (once), unless the app already restored it ---
  let collapseDone = false;
  function autoCollapse() {
    if (collapseDone || !cfgReady() || !cfg().collapseToolbar || !document.querySelector(".header-box")) return;
    collapseDone = true;
    setTimeout(() => {
      if (document.querySelector(".header-box.header-collapsed")) return;
      const u = [...document.querySelectorAll("use")].find(
        (x) => (x.getAttribute("xlink:href") || x.getAttribute("href")) === "#gl-kvm-collapse"
      );
      if (!u) return;
      let el = u;
      while (el && el !== document.body && !/action-item|pointer/.test((el.className || "").toString())) el = el.parentElement;
      (el || u.parentElement).click();
    }, 600);
  }

  // --- 11. Turn the speaker / mic on by default (once each), unless already on ---
  let speakerDone = false;
  function autoSpeaker() {
    if (speakerDone || !cfgReady() || !cfg().enableSpeaker) return;
    const icon = findSpeakerIcon(document);
    if (!icon) return;
    speakerDone = true;
    setTimeout(() => {
      const u = icon.querySelector("use");
      const sym = u && (u.getAttribute("xlink:href") || u.getAttribute("href"));
      if (sym && /sound-off|mute/i.test(sym)) icon.click();
    }, 800);
  }
  let micDone = false;
  function autoMic() {
    if (micDone || !cfgReady() || !cfg().enableMic) return;
    const icon = document.querySelector(".mic-status-icon");
    if (!icon) return;
    micDone = true;
    setTimeout(() => {
      const u = icon.querySelector("use");
      const sym = u && (u.getAttribute("xlink:href") || u.getAttribute("href"));
      if (sym && /mic-off|mute/i.test(sym)) icon.click();
    }, 800);
  }

  // --- 12. Keyboard lock: while GLKVM is fullscreen, route browser/OS shortcuts
  //         (Cmd+R/W/T, F-keys, …) to the page so its keydown handler forwards them
  //         to the remote instead of the local app acting on them. The Keyboard Lock
  //         API only takes effect in fullscreen over a secure context — both hold here.
  //         Cmd+Q and Cmd+Tab stay OS-reserved and can't be captured. ---
  function applyKeyboardLock() {
    const kb = navigator.keyboard;
    if (!kb || typeof kb.lock !== "function") return;
    if (document.fullscreenElement && cfg().lockKeyboard) {
      const keys = cfg().lockKeys; // future: allowlist of KeyboardEvent.code; empty/absent = all keys
      const locked = Array.isArray(keys) && keys.length ? kb.lock(keys) : kb.lock();
      Promise.resolve(locked).catch(() => {});
    } else {
      try { kb.unlock(); } catch (_) {}
    }
  }
  // --- 13. Keep the toolbar + status bar visible in fullscreen. GLKVM's fullscreen button
  //         handler removes the chrome from the DOM the moment it runs (the bar is unmounted,
  //         not just hidden) — separate from the fullscreenchange event. Calling
  //         requestFullscreen ourselves never triggers that, so when the option is on we
  //         intercept the button click in the capture phase, block GLKVM's handler, and do
  //         the fullscreen toggle here. Exit works the same way since the bar (and its
  //         button) stay on screen. ---
  // GLKVM unmounts the chrome through two paths: the button's own click handler (the
  // header) and a fullscreenchange handler (the bottom bar). We block both — hijack the
  // button click to toggle fullscreen ourselves, and swallow fullscreenchange in the
  // capture phase. Both fire before GLKVM's bubble-phase handlers, so the chrome survives.
  const fsHref = (u) => u.getAttribute("xlink:href") || u.getAttribute("href") || "";
  // Walk up the contiguous pointer-cursor chain from the click target to the button
  // element (the .action-item), then confirm it holds the fullscreen icon.
  function isFullscreenButtonClick(e) {
    let el = e.target, btn = null;
    while (el && el.nodeType === 1 && el !== document.body && getComputedStyle(el).cursor === "pointer") {
      btn = el;
      el = el.parentElement;
    }
    return !!btn && [...btn.querySelectorAll("use")].some((u) => /fullscreen/i.test(fsHref(u)));
  }
  let fsBound = false;
  function setupFullscreen() {
    if (fsBound) return;
    fsBound = true;
    document.addEventListener("fullscreenchange", (e) => {
      applyKeyboardLock();
      if (cfg().showBarFullscreen) e.stopImmediatePropagation();
    }, true);
    document.addEventListener("click", (e) => {
      if (!cfg().showBarFullscreen || !isFullscreenButtonClick(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else document.documentElement.requestFullscreen().catch(() => {});
    }, true);
  }

  // The status bar is Vue-rendered; re-inject if it re-mounts and our nodes vanish.
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; tryInject(); });
  }
  function start() {
    injectCSS();
    autoCollapse();
    autoSpeaker();
    autoMic();
    startNet();
    setupFullscreen();
    tryInject();
    const obs = new MutationObserver(() => {
      if (!document.querySelector("#kvm-ext-spk-chev, #kvm-ext-mic-chev, #kvm-ext-pip")) schedule();
      autoCollapse();
      autoSpeaker();
      autoMic();
    });
    obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
