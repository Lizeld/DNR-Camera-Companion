#!/usr/bin/env python3
"""
LAN static server — spec §5.1, deployment option A (recommended).

    python serve.py                              # serve only
    python serve.py --camera 192.168.0.158       # ...and keep camera CORS alive
    python serve.py                              # camera is remembered afterwards
    python serve.py --port 80
    python serve.py --allow-origin http://dnr-pc:8000
    python serve.py --backend https://inventory.example.com   # ...and proxy uploads

Why this exists, in one paragraph: the camera is a device on the local network
serving plain HTTP. A page loaded over https:// cannot fetch() it (mixed
content), and Chrome's Private Network Access rules require a preflight header
CCAPI does not send. So the app cannot be hosted at a public https:// origin
and still talk to the camera. Serving it over plain HTTP from the same LAN
makes every camera request same-scheme HTTP->HTTP, which sidesteps both.

The cost is that a plain-HTTP LAN origin is not a *secure context*, so OPFS,
Wake Lock and service workers are unavailable there. The app detects this and
falls back (see src/core/blobstore.js); Settings > Diagnostics shows which
backend is live.

--- The CORS keeper ---

The camera must be told to accept this app's exact origin (§3.6), and two facts
make that awkward to do by hand:

  1. The CORS endpoints are themselves subject to CORS, so the browser can
     never perform the initial enable — it is blocked before the request is
     sent. It has to come from outside a browser, like this process.
  2. `corssetting` reverts to "disable" when the camera powers off. Observed on
     real hardware: the origin string survived a power cycle, the enable flag
     did not. So it is not a one-time setup.

With --camera, this server registers its own origin and then re-checks
periodically, re-enabling within seconds of the camera waking up. Point it at a
different machine and it registers that machine's address instead, so moving
the app costs nothing.

The app can also ask for it on demand: when it finds the camera reachable but
refusing its origin, it POSTs /camera/cors (same-origin, so CORS does not apply)
and this server re-applies the config immediately for that page's origin.

--- The backend proxy ---

The same LAN origin that makes the camera reachable makes the *upload* backend
unreachable, for the mirror-image reason. `inventory.*` answers a preflight from
this origin with an `Access-Control-Allow-Origin` naming some other origin, so
the browser discards the response and `fetch` rejects with a bare
"NetworkError" — no status, no hint. The S3 bucket needs its own CORS grant for
the `PUT` on top of that. Android never hit either wall: OkHttp does not enforce
CORS. Browsers do.

With --backend, this server forwards those calls itself:

    POST /backend/api/presign  ->  {upstream}/api/presign
    POST /backend/api/drafts   ->  {upstream}/api/drafts
    PUT  /backend/s3?...       ->  the presigned S3 URL

The browser only ever talks to its own origin, so CORS never enters into it and
nothing has to change on the backend or the bucket. Set Settings > Backend URL
to `/backend` to use it. The cost is that image bytes now transit this process
instead of going straight to S3 — on a LAN that is not worth noticing.

Stdlib only — there is no build step and no package manager in this project.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import http.server
import json
import re
import secrets
import shutil
import socketserver
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "tools"))

# Windows hands a cp1252 stream to a redirected stdout, which mangles the
# section signs and dashes below. Ask for UTF-8 and degrade rather than crash.
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

import ccapi_lite  # noqa: E402  (path is set immediately above)

CONFIG_PATH = ROOT / ".dnr-serve.json"
KEEPER_INTERVAL_SECONDS = 10

PROXY_PREFIX = "/backend"
JSON_TIMEOUT_SECONDS = 30
PUT_TIMEOUT_SECONDS = 300
MAX_BODY_BYTES = 512 * 1024 * 1024

# OCR fallback for labels whose barcode won't decode: the app crops the label
# and posts it here; Tesseract reads the printed digits. Optional — without the
# binary the endpoint says so and the app simply doesn't use it.
TESSERACT = shutil.which("tesseract")
OCR_MAX_BYTES = 12 * 1024 * 1024
OCR_TIMEOUT_SECONDS = 20
SKU_TOKEN = re.compile(r"(?<!\d)\d{7}(?!\d)")

# Set in main() when --backend is given; read by every Handler instance.
PROXY: BackendProxy | None = None
CAMERA: str | None = None  # the camera this server keeps CORS alive for, if any
KEEPER: "CorsKeeper | None" = None  # set in main() alongside CAMERA


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """§4 trap 2, server side: a followed redirect silently downgrades POST to
    GET and the API answers 405. Returning None turns the 3xx into an HTTPError
    we can report verbatim instead."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def normalise_upstream(value: str) -> str:
    """Port of `backendApiBase()` in src/core/settings.js — same two §4 traps,
    same fixes, so the proxy and the app agree on what the base URL means."""
    value = value.strip().rstrip("/")
    if not value:
        return ""
    if not re.match(r"^https?://", value, re.IGNORECASE):
        value = f"https://{value}"
    value = re.sub(r"^http://", "https://", value, flags=re.IGNORECASE)
    if not re.search(r"/api$", value, re.IGNORECASE):
        value = f"{value}/api"
    return value


class BackendProxy:
    """Forwards backend calls so the browser only ever sees same-origin requests."""

    def __init__(self, upstream: str):
        self.upstream = upstream
        self.opener = urllib.request.build_opener(_NoRedirect)
        # Per-process signing key. The S3 URLs handed to the browser carry their
        # real target in the query string, so they are signed: without this the
        # PUT route would relay bytes to any address a LAN client named. A
        # restart invalidates outstanding URLs, which costs one re-presign.
        self._key = secrets.token_bytes(32)

    def _signature(self, target: bytes) -> str:
        digest = hmac.new(self._key, target, hashlib.sha256).digest()
        return base64.urlsafe_b64encode(digest[:18]).decode()

    def seal(self, target: str) -> str:
        raw = target.encode()
        blob = base64.urlsafe_b64encode(raw).decode()
        return f"{PROXY_PREFIX}/s3?t={blob}&sig={urllib.parse.quote(self._signature(raw))}"

    def unseal(self, query: str) -> str | None:
        params = urllib.parse.parse_qs(query)
        blob = (params.get("t") or [""])[0]
        signature = (params.get("sig") or [""])[0]
        if not blob or not signature:
            return None
        try:
            raw = base64.urlsafe_b64decode(blob)
        except (ValueError, TypeError):
            return None
        if not hmac.compare_digest(self._signature(raw), signature):
            return None
        target = raw.decode("utf-8", "replace")
        return target if target.startswith("https://") else None

    def rewrite_upload_url(self, payload: bytes) -> bytes:
        """Point `uploadUrl` at this server so the PUT is same-origin too.

        `publicUrl` is deliberately left alone: it is stored per photo and sent
        to /drafts, and it must stay the real, stable bucket link (§4).
        """
        try:
            doc = json.loads(payload)
        except (ValueError, UnicodeDecodeError):
            return payload
        if not isinstance(doc, dict):
            return payload
        target = doc.get("uploadUrl")
        if not isinstance(target, str) or not target.startswith("https://"):
            return payload
        doc["uploadUrl"] = self.seal(target)
        return json.dumps(doc).encode()

    def forward(self, method: str, url: str, body: bytes, headers: dict, timeout: float):
        """@returns (status, payload, content_type). Never raises."""
        request = urllib.request.Request(url, data=body, method=method)
        for name, value in headers.items():
            request.add_header(name, value)
        try:
            with self.opener.open(request, timeout=timeout) as response:
                content_type = response.headers.get("Content-Type") or "application/octet-stream"
                return response.status, response.read(), content_type
        except urllib.error.HTTPError as err:
            payload = err.read()
            if err.code in (301, 302, 303, 307, 308):
                return err.code, json.dumps({
                    "error": "upstream_redirect",
                    "message": f"{method} {url} -> {err.code} redirect to "
                               f"{err.headers.get('Location', '?')}. Not followed on purpose: "
                               f"following it downgrades POST to GET and the API answers 405 (§4).",
                }).encode(), "application/json"
            return err.code, payload, err.headers.get("Content-Type") or "text/plain"
        except Exception as err:  # timeout, DNS, TLS, connection reset
            return 502, json.dumps({
                "error": "upstream_unreachable",
                "message": f"{method} {url} failed at the proxy: {err}",
            }).encode(), "application/json"


class Handler(http.server.SimpleHTTPRequestHandler):
    """Static handler with the MIME types and caching this app needs."""

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".css": "text/css",
        ".wasm": "application/wasm",
        ".png": "image/png",
        ".webmanifest": "application/manifest+json",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # No caching: an operator reloading after a fix must get the new code,
        # and everything is served off a LAN at gigabit anyway.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Sealed S3 URLs carry a base64 target in the query and are ~1KB wide;
        # untruncated they bury every other line in the log.
        line = fmt % args
        if len(line) > 120:
            line = f"{line[:117]}..."
        sys.stderr.write(f"  {self.address_string()}  {line}\n")

    # -- backend proxy ----------------------------------------------------

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == f"{PROXY_PREFIX}/config":
            return self._proxy_config()
        # Read-only companion lookups (token check, SKU, draft state). Only this
        # namespace: the proxy is for the watermark API, not the whole site.
        if path.startswith(f"{PROXY_PREFIX}/api/watermark/"):
            return self._proxy_get(path[len(f"{PROXY_PREFIX}/api/"):])
        super().do_GET()

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/ocr/sku":
            return self._ocr_sku()
        if path == "/camera/cors":
            return self._camera_cors()
        if path.startswith(f"{PROXY_PREFIX}/api/"):
            return self._proxy_json(path[len(f"{PROXY_PREFIX}/api/"):])
        self._send_json(405, {"error": "method_not_allowed",
                              "message": f"POST {path} is not a route on this server"})

    def do_PUT(self):
        if self.path.split("?", 1)[0] == f"{PROXY_PREFIX}/s3":
            return self._proxy_s3()
        self._send_json(405, {"error": "method_not_allowed",
                              "message": f"PUT {self.path.split('?', 1)[0]} is not a route on this server"})

    def _send_json(self, status: int, doc: dict):
        self._send_bytes(status, json.dumps(doc).encode(), "application/json")

    def _send_bytes(self, status: int, payload: bytes, content_type: str):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def _read_body(self) -> bytes | None:
        """@returns the body, or None if it is implausibly large."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length > MAX_BODY_BYTES:
            return None
        return self.rfile.read(length) if length > 0 else b""

    def _rejects_chunked(self) -> bool:
        """Sizing the body by Content-Length would read nothing from a chunked
        request and PUT an empty object. Browsers send Content-Length for a Blob
        body, so this should never fire — but silence here would corrupt an
        upload rather than fail it."""
        if "chunked" not in (self.headers.get("Transfer-Encoding") or "").lower():
            return False
        self._send_json(411, {
            "error": "length_required",
            "message": "This proxy needs a Content-Length; it does not decode chunked bodies.",
        })
        return True

    def _proxy_disabled(self):
        self._send_json(503, {
            "error": "proxy_disabled",
            "message": "This server was started without --backend, so it is not proxying "
                       "the upload API. Restart it as: python serve.py --backend "
                       "https://inventory.example.com",
        })

    def _proxy_config(self):
        """What the app should be pointed at, and where it goes. A fresh browser
        uses `camera` and `api` to pre-fill its blank settings."""
        if PROXY is None:
            return self._send_json(200, {"proxy": False, "api": None, "upstream": None,
                                         "camera": CAMERA, "ocr": bool(TESSERACT)})
        self._send_json(200, {
            "camera": CAMERA,
            "ocr": bool(TESSERACT),
            "proxy": True,
            "api": f"{PROXY_PREFIX}/api",
            "upstream": PROXY.upstream,
        })

    # -- camera CORS on demand ---------------------------------------------

    def _camera_cors(self):
        """Re-apply the camera's CORS config now, for the origin asking.

        The browser cannot do the first enable itself (the CORS endpoints are
        subject to CORS), but it can ask this same-origin server to. The app
        calls this when it finds the camera reachable but refusing its origin —
        typically just after a camera wake-up, before the keeper's next tick.

        Only the page's own origin is accepted: `Origin` must equal
        http://<Host>, i.e. a page this server actually served under that
        name. The keeper then adopts it, so a tablet that reaches this machine
        by hostname keeps working without --allow-origin."""
        keeper = KEEPER
        if keeper is None:
            return self._send_json(409, {
                "ok": False, "error": "no_camera",
                "message": "This server is not keeping a camera's CORS alive. Restart it "
                           "as: python serve.py --camera <camera-ip>",
            })

        host = self.headers.get("Host") or ""
        origin = (self.headers.get("Origin") or "").rstrip("/")
        if not host or origin != f"http://{host}":
            return self._send_json(403, {
                "ok": False, "error": "origin_mismatch",
                "message": f"Origin {origin or '(none)'} is not this server's page origin "
                           f"http://{host}",
            })

        body = self._read_body() or b""
        try:
            wanted = json.loads(body or b"{}").get("camera")
        except (json.JSONDecodeError, AttributeError):
            wanted = None
        if wanted and wanted != keeper.host:
            return self._send_json(409, {
                "ok": False, "error": "camera_mismatch",
                "message": f"The app is set to camera {wanted}, but this server manages "
                           f"{keeper.host}. Fix Settings > Camera, or restart as: "
                           f"python serve.py --camera {wanted}",
            })

        keeper.origin = origin
        result = keeper.apply_once()
        self._send_json(200 if result["ok"] else 502, {
            "ok": result["ok"], "camera": keeper.host, "origin": origin,
            "changed": result.get("changed", []),
            "message": result.get("message", ""),
        })

    def _proxy_json(self, endpoint: str):
        proxy = PROXY
        if proxy is None:
            return self._proxy_disabled()
        endpoint = endpoint.strip("/")
        if not endpoint or ".." in endpoint:
            return self._send_json(400, {"error": "bad_endpoint", "message": f"refusing to proxy {self.path!r}"})
        if self._rejects_chunked():
            return

        body = self._read_body()
        if body is None:
            return self._send_json(413, {"error": "too_large", "message": "request body exceeds the proxy limit"})

        headers = {"Content-Type": self.headers.get("Content-Type") or "application/json"}
        # The bearer token is the app's, forwarded untouched; the proxy has none
        # of its own and stores nothing.
        if self.headers.get("Authorization"):
            headers["Authorization"] = self.headers["Authorization"]

        url = f"{proxy.upstream}/{endpoint}"
        status, payload, content_type = proxy.forward("POST", url, body, headers, JSON_TIMEOUT_SECONDS)
        if status == 200 and "json" in content_type.lower():
            payload = proxy.rewrite_upload_url(payload)
        self.log_message("proxy POST %s -> %s %s", endpoint, status, url)
        self._send_bytes(status, payload, content_type)

    def _ocr_sku(self):
        """Read 7-digit SKUs off a cropped, upright label image (PNG/JPEG body).

        Digits-only Tesseract, block mode first and sparse-text mode if that
        finds nothing. Returns every standalone 7-digit run — the app checks
        them against Inventory before trusting one, since OCR has no checksum.
        """
        if not TESSERACT:
            return self._send_json(503, {
                "error": "ocr_unavailable",
                "message": "Tesseract is not installed on this server: sudo apt install tesseract-ocr",
            })
        if self._rejects_chunked():
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > OCR_MAX_BYTES:
            return self._send_json(413, {"error": "bad_size", "message": f"expected an image up to {OCR_MAX_BYTES} bytes"})
        image = self.rfile.read(length)

        started = time.monotonic()
        candidates: list[str] = []
        used = None
        for psm in ("6", "11"):
            try:
                proc = subprocess.run(
                    [TESSERACT, "stdin", "stdout", "--psm", psm, "-c", "tessedit_char_whitelist=0123456789"],
                    input=image, capture_output=True, timeout=OCR_TIMEOUT_SECONDS,
                )
            except subprocess.TimeoutExpired:
                return self._send_json(504, {"error": "ocr_timeout", "message": "Tesseract took too long"})
            text = proc.stdout.decode("utf-8", "replace")
            for token in SKU_TOKEN.findall(text):
                if token not in candidates:
                    candidates.append(token)
            if candidates:
                used = psm
                break
        ms = round((time.monotonic() - started) * 1000)
        self.log_message("ocr %s bytes -> %s (psm %s, %sms)", len(image), candidates or "nothing", used, ms)
        self._send_json(200, {"candidates": candidates, "psm": used, "ms": ms})

    def _proxy_get(self, endpoint: str):
        proxy = PROXY
        if proxy is None:
            return self._proxy_disabled()
        if ".." in endpoint or not re.fullmatch(r"[A-Za-z0-9_\-/]+", endpoint):
            return self._send_json(400, {"error": "bad_endpoint", "message": f"refusing to proxy {self.path!r}"})
        headers = {}
        if self.headers.get("Authorization"):
            headers["Authorization"] = self.headers["Authorization"]
        url = f"{proxy.upstream}/{endpoint}"
        status, payload, content_type = proxy.forward("GET", url, None, headers, JSON_TIMEOUT_SECONDS)
        self.log_message("proxy GET %s -> %s %s", endpoint, status, url)
        self._send_bytes(status, payload, content_type)

    def _proxy_s3(self):
        proxy = PROXY
        if proxy is None:
            return self._proxy_disabled()
        query = self.path.split("?", 1)[1] if "?" in self.path else ""
        target = proxy.unseal(query)
        if not target:
            return self._send_json(403, {
                "error": "bad_upload_url",
                "message": "This upload URL was not issued by this process. The signing key is "
                           "per-process, so restarting the server invalidates outstanding URLs — "
                           "retry the SKU and it will re-presign.",
            })
        if self._rejects_chunked():
            return

        body = self._read_body()
        if body is None:
            return self._send_json(413, {"error": "too_large", "message": "image exceeds the proxy limit"})

        # Content-Type only: it is bound into the presigned signature and must
        # match what was sent to /presign. No Authorization — the presigned URL
        # carries its own credentials in the query, and a bearer header on top
        # of that makes S3 reject the request.
        headers = {"Content-Type": self.headers.get("Content-Type") or "application/octet-stream"}
        status, payload, content_type = proxy.forward("PUT", target, body, headers, PUT_TIMEOUT_SECONDS)
        self.log_message("proxy PUT %s bytes -> %s %s", len(body), status, target.split("?", 1)[0])
        self._send_bytes(status, payload, content_type)


class Server(socketserver.ThreadingTCPServer):
    """Threaded so a slow image request cannot block the page load."""

    allow_reuse_address = True
    daemon_threads = True


# ---------------------------------------------------------------------------
# CORS keeper
# ---------------------------------------------------------------------------

class CorsKeeper(threading.Thread):
    """Keeps the camera accepting `origin`, across camera power cycles."""

    def __init__(self, host: str, origin: str, interval: int = KEEPER_INTERVAL_SECONDS):
        super().__init__(daemon=True, name="cors-keeper")
        self.host = host
        self.origin = origin
        self.interval = interval
        self.stop_event = threading.Event()
        # The periodic tick and an on-demand POST /camera/cors can overlap.
        self.lock = threading.Lock()
        # Only report transitions; a line every 20s would bury the access log.
        self.last_state: str | None = None

    def announce(self, state: str, message: str):
        if state != self.last_state:
            print(f"  [cors] {message}")
            self.last_state = state

    def apply_once(self) -> dict:
        """@returns {'ok': bool, 'changed': [str], 'message': str}"""
        with self.lock:
            return self._apply_locked()

    def _apply_locked(self) -> dict:
        report = ccapi_lite.find_ccapi(self.host, timeout=2.0)
        if not report["base"]:
            message = f"camera {self.host} not responding (asleep or off network) — will retry"
            self.announce("unreachable", message)
            return {"ok": False, "changed": [], "message": message}

        result = ccapi_lite.ensure_cors(report["base"], report["endpoints"], self.origin)
        if result["ok"]:
            if result["changed"]:
                # Fresh enable: either first run, or the camera just woke up and
                # dropped corssetting back to "disable".
                print(f"  [cors] camera now accepts {self.origin} "
                      f"(set: {', '.join(result['changed'])})")
                self.last_state = "ok"
            else:
                self.announce("ok", f"camera already accepts {self.origin}")
            return {"ok": True, "changed": result["changed"],
                    "message": f"camera accepts {self.origin}"}

        message = (f"could not configure CORS on {self.host}: "
                   f"{'; '.join(result['errors']) or 'unknown'}")
        self.announce("failed", message)
        return {"ok": False, "changed": result["changed"], "message": message}

    def run(self):
        while not self.stop_event.is_set():
            try:
                self.apply_once()
            except Exception as err:  # a keeper crash must never kill the server
                self.announce("error", f"keeper error: {err}")
            self.stop_event.wait(self.interval)


def load_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def save_config(config: dict):
    try:
        CONFIG_PATH.write_text(json.dumps(config, indent=2), encoding="utf-8")
    except OSError as err:
        print(f"  warning: could not save {CONFIG_PATH.name}: {err}", file=sys.stderr)


# ---------------------------------------------------------------------------

def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="0.0.0.0",
                        help="bind address (default 0.0.0.0, so the tablet can reach it)")
    parser.add_argument("--camera", metavar="IP",
                        help="camera IP; keeps its CORS config pointed at this server. "
                             "Remembered in .dnr-serve.json for later runs.")
    parser.add_argument("--no-camera", action="store_true",
                        help="ignore a remembered camera and serve only")
    parser.add_argument("--allow-origin", metavar="ORIGIN",
                        help="register this origin instead of the auto-detected one "
                             "(use when the tablet reaches this machine by hostname)")
    parser.add_argument("--backend", metavar="URL",
                        help="proxy the upload API through this server, sidestepping backend "
                             "and bucket CORS. Remembered in .dnr-serve.json for later runs.")
    parser.add_argument("--no-backend", action="store_true",
                        help="ignore a remembered backend and serve only")
    args = parser.parse_args(argv)

    if not (ROOT / "index.html").exists():
        print(f"error: index.html not found in {ROOT}", file=sys.stderr)
        return 1
    if not (ROOT / "assets" / "watermark.png").exists():
        print("warning: assets/watermark.png is missing — run: python tools/make_fixtures.py",
              file=sys.stderr)

    config = load_config()
    camera = None if args.no_camera else (args.camera or config.get("camera"))
    global CAMERA
    CAMERA = camera
    if args.camera and args.camera != config.get("camera"):
        config["camera"] = args.camera
        save_config(config)

    backend = None if args.no_backend else (args.backend or config.get("backend"))
    if args.backend and args.backend != config.get("backend"):
        config["backend"] = args.backend
        save_config(config)
    if backend:
        upstream = normalise_upstream(backend)
        if not upstream:
            print(f"error: --backend {backend!r} is not a usable URL", file=sys.stderr)
            return 1
        global PROXY
        PROXY = BackendProxy(upstream)

    try:
        server = Server((args.host, args.port), Handler)
    except OSError as err:
        print(f"error: cannot bind {args.host}:{args.port} — {err}", file=sys.stderr)
        return 1

    addresses = ccapi_lite.lan_addresses()
    primary = addresses[0] if addresses else "localhost"
    origin = (args.allow_origin or f"http://{primary}:{args.port}").rstrip("/")

    print(f"DNR Watermark  ·  serving {ROOT}")
    print(f"  local     http://localhost:{args.port}/")
    for addr in addresses:
        print(f"  tablet    http://{addr}:{args.port}/")
    print(f"  tests     http://{primary}:{args.port}/tests.html")
    print(f"  label OCR {'Tesseract at ' + TESSERACT if TESSERACT else 'off (sudo apt install tesseract-ocr to enable)'}")
    print()

    keeper = None
    if camera:
        print(f"  CORS keeper: camera {camera}, origin {origin}")
        keeper = CorsKeeper(camera, origin)
        global KEEPER
        KEEPER = keeper
        keeper.apply_once()          # register before the first page load
        keeper.start()               # then re-apply after every camera wake-up
        print(f"  Open the app at {origin} — that exact URL, on every device.")
    else:
        print("  No camera configured. To have this server keep the camera's CORS")
        print("  setting alive automatically (it resets on every camera power cycle):")
        print(f"    python serve.py --camera <camera-ip>")
    print()

    if PROXY:
        print(f"  Backend proxy: {PROXY.upstream}")
        print("  Set Settings > Backend URL to  /backend  — that exact string, on every")
        print("  device. Uploads then run same-origin, so neither the backend's CORS")
        print("  allowlist nor the bucket's needs to know this origin.")
    else:
        print("  No backend proxy. If uploads fail with a bare \"NetworkError\", the backend")
        print("  is refusing this origin at CORS; route around it with:")
        print("    python serve.py --backend https://inventory.example.com")
    print()
    print("  Use HTTP, not HTTPS, so the app can reach the camera (§5.1). A plain-HTTP")
    print("  LAN origin is not a secure context, so the app falls back from OPFS to an")
    print("  IndexedDB blob store and cannot take a Wake Lock — set the device screen")
    print("  timeout to Never for a shoot. Ctrl+C to stop.")
    print()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        if keeper:
            keeper.stop_event.set()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
