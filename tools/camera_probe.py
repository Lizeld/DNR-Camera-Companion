#!/usr/bin/env python3
"""
Camera reachability + CORS tool. Stdlib only.

This talks to the camera directly, NOT through a browser, so it is not subject
to CORS. That is the point: in the browser, "camera unreachable" and "camera
reachable but has not been told to allow this origin" produce the same opaque
failure. This tool tells them apart.

    python tools/camera_probe.py scan 192.168.0
    python tools/camera_probe.py info 192.168.0.158
    python tools/camera_probe.py allow 192.168.0.158 http://192.168.0.153:8000

For day-to-day use you usually want `python serve.py --camera <ip>` instead,
which registers the origin and keeps re-applying it — `corssetting` reverts to
"disable" every time the camera powers off. This tool is for diagnosis and
one-off changes.
"""

from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ccapi_lite import (  # noqa: E402
    DEFAULT_PORTS, ensure_cors, find_ccapi, http_json, read_cors, tcp_open,
)


def cmd_scan(args) -> int:
    prefix = args.prefix.rstrip(".")
    print(f"Scanning {prefix}.1-254 on ports 8080, 80, 443 …")

    def probe(n):
        host = f"{prefix}.{n}"
        for port, scheme in DEFAULT_PORTS:
            if tcp_open(host, port, timeout=0.6):
                status, body, _ = http_json(f"{scheme}://{host}:{port}/ccapi", timeout=2.0)
                if status == 200 and isinstance(body, dict) and body:
                    return (host, port, scheme, body)
        return None

    with ThreadPoolExecutor(max_workers=64) as pool:
        hits = [found for found in pool.map(probe, range(1, 255)) if found]

    if not hits:
        print("\nNo CCAPI camera found on this subnet.")
        print("  • Is the camera's Wi-Fi on and connected to the SAME network?")
        print("  • Is CCAPI enabled in the camera menu (not just Wi-Fi)?")
        print("  • Has it auto-powered-off? Wake it and try again.")
        print("  • If the camera is in its own access-point mode, this machine must join")
        print("    the camera's network, then scan that subnet instead.")
        return 1

    for host, port, scheme, body in hits:
        print(f"\n  FOUND  {scheme}://{host}:{port}   versions: {', '.join(sorted(body))}")
        print(f"         python serve.py --camera {host}")
    return 0


def cmd_info(args) -> int:
    report = find_ccapi(args.host, timeout=args.timeout)

    print(f"Host {args.host}")
    for label, listening in report["tcp"].items():
        print(f"  port {label:<10} {'OPEN' if listening else 'closed / filtered'}")

    if not report["base"]:
        print("\nNo CCAPI root answered.")
        for err in report["errors"]:
            print(f"  {err}")
        if not any(report["tcp"].values()):
            print("\n  Nothing is listening on any CCAPI port. Either the IP is wrong, the")
            print("  camera is asleep or off its network, or CCAPI is not enabled in the")
            print("  camera menu. Try:  python tools/camera_probe.py scan <first-three-octets>")
        else:
            print("\n  A port is open but did not serve /ccapi. Wrong device, or CCAPI is off.")
        return 1

    base = report["base"]
    endpoints = report["endpoints"]
    print(f"\nCCAPI root: {base}/ccapi")
    print("\nResolved endpoints (matched by suffix, never constructed):")
    for name, found in endpoints.items():
        print(f"  {name:<22} {f'{found[0]}  {found[1]}' if found else '— not advertised'}")

    info = endpoints.get("deviceinformation")
    if info:
        status, body, err = http_json(f"{base}{info[1]}", timeout=args.timeout)
        if status == 200 and isinstance(body, dict):
            for key in ("manufacturer", "productname", "firmwareversion", "serialnumber"):
                if key in body:
                    print(f"  {key:<22} {body[key]}")
        else:
            print(f"  deviceinformation -> {status} {err or ''}")

    state = read_cors(base, endpoints, timeout=args.timeout)
    print("\nCORS (§3.6) — what a browser client depends on:")
    print(f"  enabled                {state['enabled']}")
    print(f"  origin                 {state['origin']!r}")
    if not state["enabled"]:
        print("\n  CORS is OFF, so every browser request will be refused. Note this flag")
        print("  resets to 'disable' on each camera power cycle. Rather than setting it")
        print("  by hand, let the server maintain it:")
        print(f"    python serve.py --camera {args.host}")
    return 0


def cmd_allow(args) -> int:
    report = find_ccapi(args.host, timeout=args.timeout)
    if not report["base"]:
        print(f"Cannot reach CCAPI on {args.host}. Run `info` first.")
        return 1

    origin = args.origin.rstrip("/")
    print(f"Camera {report['base']}")
    print(f"Origin {origin}\n")

    result = ensure_cors(report["base"], report["endpoints"], origin, timeout=args.timeout)
    print(f"  before  {json.dumps(result['before'])}")
    print(f"  changed {result['changed'] or '(nothing needed)'}")
    print(f"  after   {json.dumps(result['after'])}")
    for err in result["errors"]:
        print(f"  error   {err}")

    if result["ok"]:
        print("\nCamera now accepts that origin. Reload the app and press Test connection.")
        print("Remember this reverts when the camera powers off — for a real shoot use:")
        print(f"    python serve.py --camera {args.host}")
        return 0

    print("\nCould not configure CORS. Set the allowed origin from the camera menu")
    print("(connection setup), or check the CORS function exists on this firmware.")
    return 1


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--timeout", type=float, default=6.0)
    sub = parser.add_subparsers(dest="command", required=True)

    s = sub.add_parser("scan", help="sweep a /24 for a CCAPI camera")
    s.add_argument("prefix", help="first three octets, e.g. 192.168.0")
    s.set_defaults(func=cmd_scan)

    i = sub.add_parser("info", help="probe one host: endpoints, device info, CORS state")
    i.add_argument("host")
    i.set_defaults(func=cmd_info)

    a = sub.add_parser("allow", help="tell the camera to accept a web origin")
    a.add_argument("host")
    a.add_argument("origin", help="exact app origin, e.g. http://192.168.0.153:8000")
    a.set_defaults(func=cmd_allow)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
