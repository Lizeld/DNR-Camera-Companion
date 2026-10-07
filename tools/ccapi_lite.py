"""
Minimal CCAPI client for the non-browser tooling. Stdlib only.

Shared by `tools/camera_probe.py` and `serve.py`. Everything here runs outside
a browser, which is the entire point: the camera's CORS endpoints are
themselves subject to CORS, so a browser can never perform the initial enable.
"""

from __future__ import annotations

import json
import socket
import ssl
import urllib.error
import urllib.request

# HTTP 8080 first: the camera's SoC is the bottleneck when encrypting, so HTTP
# measures ~1.95 MB/s against ~1.5 MB/s over HTTPS (spec §3.1).
DEFAULT_PORTS = [(8080, "http"), (80, "http"), (443, "https")]

# The camera presents a self-signed certificate; we are not verifying it (§3.1).
_TLS = ssl.create_default_context()
_TLS.check_hostname = False
_TLS.verify_mode = ssl.CERT_NONE

# Every CCAPI function this tooling needs, keyed by the path suffix to match.
WANTED = {
    "deviceinformation": "deviceinformation",
    "event/polling": "event/polling",
    "contents": "contents",
    "cors/corssetting": "functions/cors/corssetting",
    "cors/origin": "functions/cors/origin",
}


def tcp_open(host: str, port: int, timeout: float = 1.0) -> bool:
    """Is anything listening? Distinguishes 'no service' from 'not CCAPI'."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def http_json(url: str, method: str = "GET", payload: dict | None = None, timeout: float = 6.0):
    """Returns (status, parsed_body_or_text, error_string). status 0 = no response."""
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=_TLS) as response:
            body = response.read().decode("utf-8", "replace")
            try:
                return response.status, json.loads(body) if body else {}, None
            except json.JSONDecodeError:
                return response.status, body, None
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", "replace")
        try:
            body = json.loads(body)
        except json.JSONDecodeError:
            pass
        return err.code, body, None
    except (urllib.error.URLError, socket.timeout, OSError) as err:
        return 0, None, str(getattr(err, "reason", err))


def resolve_endpoints(api_map: dict) -> dict:
    """Match each function by path suffix across ALL versions (spec §3.2).

    Never assume a version prefix: on the R50, deviceinformation is ver100,
    event/polling is ver110 and contents is ver130. Constructing
    /ccapi/ver130/event/polling returns 404.
    """
    out: dict[str, tuple[str, str] | None] = {}
    for name, suffix in WANTED.items():
        best = None
        for version, entries in (api_map or {}).items():
            if not isinstance(entries, list):
                continue
            for entry in entries:
                path = entry.get("path") if isinstance(entry, dict) else None
                if isinstance(path, str) and path.endswith("/" + suffix):
                    if best is None or version > best[0]:
                        best = (version, path)
        out[name] = best
    return out


def find_ccapi(host: str, ports=None, timeout: float = 2.0) -> dict:
    """Try each port for a CCAPI root. Returns a report dict."""
    report = {"host": host, "tcp": {}, "base": None, "api_map": None,
              "endpoints": {}, "errors": []}
    for port, scheme in (ports or DEFAULT_PORTS):
        listening = tcp_open(host, port, timeout=min(timeout, 1.5))
        report["tcp"][f"{port}/{scheme}"] = listening
        if not listening:
            continue
        base = f"{scheme}://{host}:{port}"
        status, body, err = http_json(f"{base}/ccapi", timeout=timeout)
        if status == 200 and isinstance(body, dict) and body:
            report["base"] = base
            report["api_map"] = body
            report["endpoints"] = resolve_endpoints(body)
            return report
        report["errors"].append(f"{base}/ccapi -> status {status} {err or ''}".strip())
    return report


def read_cors(base: str, endpoints: dict, timeout: float = 6.0) -> dict:
    """Current CORS state. @returns {'enabled': bool|None, 'origin': str|None}."""
    state = {"enabled": None, "origin": None}
    setting = endpoints.get("cors/corssetting")
    origin = endpoints.get("cors/origin")
    if setting:
        status, body, _ = http_json(f"{base}{setting[1]}", timeout=timeout)
        if status == 200 and isinstance(body, dict):
            state["enabled"] = body.get("value") == "enable"
    if origin:
        status, body, _ = http_json(f"{base}{origin[1]}", timeout=timeout)
        if status == 200 and isinstance(body, dict):
            state["origin"] = body.get("origin")
    return state


def ensure_cors(base: str, endpoints: dict, want_origin: str, timeout: float = 6.0) -> dict:
    """Make the camera accept `want_origin`, writing only what is wrong.

    Payload shapes confirmed against an EOS R50 on firmware 1.5.0:
        PUT functions/cors/origin      {"origin": "http://host:port"}
        PUT functions/cors/corssetting {"value": "enable"}
    The extra variants are kept as fallbacks for other bodies/firmware.

    ⚠ `corssetting` reverts to "disable" when the camera powers off — observed
    on real hardware. The origin string survived, the enable flag did not. This
    is why it has to be re-applied rather than set once.

    @returns {'ok': bool, 'changed': [str], 'before': dict, 'after': dict, 'errors': [str]}
    """
    result = {"ok": False, "changed": [], "before": {}, "after": {}, "errors": []}
    before = read_cors(base, endpoints, timeout)
    result["before"] = before

    def put(name, payloads):
        found = endpoints.get(name)
        if not found:
            result["errors"].append(f"{name}: endpoint not advertised")
            return False
        for payload in payloads:
            status, body, err = http_json(f"{base}{found[1]}", "PUT", payload, timeout)
            if 200 <= status < 300:
                return True
            result["errors"].append(
                f"{name} {json.dumps(payload)} -> {status} {err or json.dumps(body)}")
        return False

    if before["origin"] != want_origin:
        if put("cors/origin", [{"origin": want_origin}, {"value": want_origin}]):
            result["changed"].append("origin")

    if not before["enabled"]:
        if put("cors/corssetting", [{"value": "enable"}, {"corssetting": "enable"}]):
            result["changed"].append("corssetting")

    after = read_cors(base, endpoints, timeout)
    result["after"] = after
    result["ok"] = bool(after["enabled"]) and after["origin"] == want_origin
    return result


def lan_addresses() -> list[str]:
    """Best-effort list of this machine's LAN IPv4 addresses, most likely first."""
    found: list[str] = []
    # The UDP-connect trick reports the address used for outbound traffic —
    # the one another device on the same network can reach.
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            found.append(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            addr = info[4][0]
            if addr not in found and not addr.startswith("127."):
                found.append(addr)
    except OSError:
        pass
    return found
