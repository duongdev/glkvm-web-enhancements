# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chromium MV3 browser extension that layers controls onto the **closed-source** GL.iNet GLKVM web UI (a minified Vue SPA served from the KVM device). The extension never has the SPA's source — it operates entirely by manipulating the live DOM and hooking browser media APIs.

## No build system

Vanilla JS/HTML/CSS, no bundler, no dependencies, no tests. Iterate by editing files directly.

- **Load/reload:** `chrome://extensions` → Developer mode → Load unpacked → select repo root. After edits, hit **Reload** on the extension card, then refresh the GLKVM tab.
- **Syntax check before reload:** `node --check content.js && node --check bridge.js && node --check popup.js` and `python3 -c "import json;json.load(open('manifest.json'))"`.
- **Regenerate icons** from the source SVG: `for s in 16 32 48 128; do rsvg-convert -w $s -h $s icons/icon.svg -o icons/icon-$s.png; done` (requires `rsvg-convert`, e.g. `brew install librsvg`).

## Architecture: the two-world split

This is the central design constraint. The media hooks must run in the page's **MAIN world** at `document_start` (before the SPA opens WebRTC), but MAIN-world scripts have **no `chrome.*` access**. So there are two content scripts plus a popup:

- **`content.js` (MAIN world, `document_start`)** — all page logic: wraps `getUserMedia` and the `RTCPeerConnection` constructor, injects the bottom-bar controls, computes data totals, PiP, toolbar tweaks. Cannot read `chrome.storage`.
- **`bridge.js` (isolated world, `document_start`)** — reads settings from `chrome.storage.sync` and mirrors them into a `data-glkvm-cfg` attribute on `<html>`. `content.js` reads that attribute via `cfg()`. This is the only channel between the two worlds.
- **`popup.html` / `popup.js`** — the `action.default_popup` settings UI; writes toggles to `chrome.storage.sync`. Clicking the toolbar icon opens it.

Settings flow: **popup → `chrome.storage.sync` → `bridge.js` → `data-glkvm-cfg` attribute → `content.js`**.

## Critical, non-obvious details

- **Wrap the `RTCPeerConnection` constructor, not `addTrack`.** The KVM video stream is *receive-only*, so the page never calls `addTrack`. Connection tracking (for live mic swap and `getStats()` totals) depends on the constructor wrap. Reverting to an `addTrack` hook silently breaks data totals and live mic switching.
- **Load-time actions wait for `cfgReady()`.** `autoCollapse` / `autoSpeaker` / `autoMic` only fire once `data-glkvm-cfg` exists, so a saved "off" preference isn't overridden by defaults firing before the bridge mirrors storage.
- **The UI is re-injected via `MutationObserver`.** The status bar is Vue-rendered and re-mounts; `tryInject()` re-adds the chevrons/PiP/stats when they vanish.
- **Two separate stores.** Device selections (speaker/mic IDs) live in the page's `localStorage` (origin-specific). Feature toggles live in `chrome.storage.sync`. Don't merge them.
- **Settings defaults are duplicated** in `content.js` (`CFG_DEFAULTS`), `bridge.js` (`DEFAULTS`), and `popup.js` (`DEFAULTS`). Keep all three in sync when adding a toggle.

## Coupling to the GLKVM SPA (fragile by nature)

`content.js` targets specific SPA internals that can change on a GLKVM firmware update. When the UI breaks, re-inspect these against the live page:

- `.kvm-video-info` (bottom status bar), `.frame-text` (bitrate text, anchor for data totals)
- `.volume-icon` + sprite `#gl-kvm-sound-full` / `#gl-kvm-sound-off` (speaker toggle/state)
- `.mic-status-icon` + `#gl-kvm-mic` / `#gl-kvm-mic-off` (mic toggle/state)
- `.header-box` / `.header-collapsed` and `#gl-kvm-collapse`, `.un-collapse-triangle-collapsed` (toolbar collapse/expand)
- `#stream-video` (the WebRTC `<video>`), `#stream-box` (PiP overlay mount)

Icons are flipped by sprite symbol (`<use xlink:href>`), so detect on/off state by the symbol name, and match controls by symbol *prefix* where the symbol changes with state.

## Host matching

`manifest.json` `matches` is deliberately generic (`glkvm.local`, `*.ts.net`) — **never commit personal hosts** (specific Tailscale IDs, LAN IPs). Users add their own host locally per the README.
