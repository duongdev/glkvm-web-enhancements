#!/usr/bin/env python3
"""Render popup.html in headless Chrome and write assets/popup.png.

Self-contained: launches its own throwaway Chrome (no shared instance needed),
drives it over the DevTools protocol, forces every toggle on (file:// has no
chrome.storage, so toggles render off otherwise), and captures the popup body
at 2x. Re-run whenever popup.html changes.

    python3 scripts/capture-popup.py
"""
import base64, json, os, shutil, socket, struct, subprocess, sys, tempfile, time, urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POPUP = os.path.join(REPO, "popup.html")
OUT = os.path.join(REPO, "assets", "popup.png")
WIDTH, SCALE = 340, 2

CHROME_CANDIDATES = [
    os.environ.get("CHROME"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    shutil.which("google-chrome-stable"),
    shutil.which("google-chrome"),
    shutil.which("chromium"),
]


def find_chrome():
    for c in CHROME_CANDIDATES:
        if c and os.path.exists(c):
            return c
    sys.exit("Chrome not found. Set CHROME=/path/to/chrome.")


def wait_for_port(profile, deadline):
    portfile = os.path.join(profile, "DevToolsActivePort")
    while time.time() < deadline:
        if os.path.exists(portfile):
            return int(open(portfile).read().splitlines()[0])
        time.sleep(0.1)
    sys.exit("Chrome did not expose a debugging port in time.")


class CDP:
    """Minimal DevTools websocket client (no third-party deps)."""

    def __init__(self, ws_url):
        host, port, path = self._parse(ws_url)
        self.sock = socket.create_connection((host, port)); self.sock.settimeout(15)
        key = base64.b64encode(b"0123456789abcdef").decode()
        self.sock.sendall(
            f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n".encode()
        )
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.sock.recv(1)
        self._id = 0

    @staticmethod
    def _parse(url):
        rest = url.split("://", 1)[1]
        hp, path = rest.split("/", 1)
        host, port = hp.split(":")
        return host, int(port), "/" + path

    def call(self, method, params=None):
        self._id += 1
        payload = json.dumps({"id": self._id, "method": method, "params": params or {}}).encode()
        header = bytearray([0x81])
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126); header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127); header += struct.pack(">Q", n)
        self.sock.sendall(bytes(header) + b"\x00\x00\x00\x00" + payload)
        while True:
            msg = self._recv()
            if msg.get("id") == self._id:
                return msg

    def _recv(self):
        b = self.sock.recv(2)
        ln = b[1] & 0x7F
        if ln == 126:
            ln = struct.unpack(">H", self.sock.recv(2))[0]
        elif ln == 127:
            ln = struct.unpack(">Q", self.sock.recv(8))[0]
        data = b""
        while len(data) < ln:
            data += self.sock.recv(ln - len(data))
        return json.loads(data)


def main():
    if not os.path.exists(POPUP):
        sys.exit(f"popup.html not found at {POPUP}")
    chrome = find_chrome()
    profile = tempfile.mkdtemp(prefix="glkvm-popup-")
    proc = subprocess.Popen(
        [chrome, "--headless=new", "--remote-debugging-port=0", f"--user-data-dir={profile}",
         "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        port = wait_for_port(profile, time.time() + 20)
        page = json.loads(urllib.request.urlopen(urllib.request.Request(
            f"http://127.0.0.1:{port}/json/new?file://{POPUP}", method="PUT")).read())
        cdp = CDP(page["webSocketDebuggerUrl"])
        cdp.call("Page.enable"); cdp.call("Runtime.enable")
        cdp.call("Emulation.setDeviceMetricsOverride",
                 {"width": WIDTH, "height": 1000, "deviceScaleFactor": SCALE, "mobile": False})
        time.sleep(0.8)
        height = int(cdp.call("Runtime.evaluate", {
            "expression": "document.querySelectorAll('input[type=checkbox]').forEach(c=>c.checked=true);"
                          "Math.ceil(document.body.getBoundingClientRect().height)",
            "returnByValue": True})["result"]["result"]["value"])
        time.sleep(0.3)
        shot = cdp.call("Page.captureScreenshot", {
            "format": "png", "captureBeyondViewport": True,
            "clip": {"x": 0, "y": 0, "width": WIDTH, "height": height, "scale": SCALE}})
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        open(OUT, "wb").write(base64.b64decode(shot["result"]["data"]))
        print(f"wrote {os.path.relpath(OUT, REPO)} ({WIDTH}x{height} @ {SCALE}x)")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    main()
