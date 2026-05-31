#!/usr/bin/env python3
"""
Flight Dashboard — local server.

Serves the dashboard UI and proxies the adsb.lol public ADS-B API.
The proxy exists because adsb.lol returns no CORS headers, so a browser
page cannot call it directly. It also adds a short cache so we stay well
within the API's ~1 request/second courtesy limit.

No third-party packages required — Python 3.9+ standard library only.

Run (private — this machine only, the default):
    python server.py
Then open http://localhost:8000 in your browser.

Run (expose to other devices on your LAN — opt-in):
    python server.py --lan            # bind 0.0.0.0, print your LAN URL
    python server.py --host 0.0.0.0   # equivalent
    FLIGHT_HOST=0.0.0.0 python server.py   # via env var
Binding to anything other than 127.0.0.1 means anyone on your network can reach
the dashboard AND its API proxy — there is no authentication. See the firewall
note printed on startup.
"""

import os
import json
import time
import socket
import argparse
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from pathlib import Path

# Defaults are loopback-only (private). Override via --host/--port/--lan or env.
HOST = os.environ.get("FLIGHT_HOST", "127.0.0.1")
PORT = int(os.environ.get("FLIGHT_PORT", "8000"))

ADSB_BASE = "https://api.adsb.lol"          # live positions
ADSBDB_BASE = "https://api.adsbdb.com/v0"   # airline / route / owner enrichment (keyless)
METAR_BASE = "https://aviationweather.gov/api/data"  # NOAA/AWC METAR (keyless)
# A descriptive User-Agent is good manners and avoids default-UA blocking.
USER_AGENT = "flight-dashboard/1.0 (personal use; public ADS-B + AWC APIs)"
HERE = Path(__file__).resolve().parent

# --- tiny in-memory cache so rapid polling doesn't hammer upstream APIs ---
_cache = {}            # key -> (timestamp, payload bytes)
CACHE_TTL = 4.0        # seconds (live positions)
TTL_STATIC = 86400.0   # aircraft/route facts barely change — cache a day
TTL_METAR = 300.0      # METAR updates ~hourly — 5 min is plenty


def _cached(key, url, ttl):
    """Return (status, body) using a cached copy when fresh enough."""
    now = time.time()
    hit = _cache.get(key)
    if hit and now - hit[0] < ttl:
        return 200, hit[1]
    status, body = _fetch(url)
    if status == 200:
        _cache[key] = (now, body)
    return status, body


def _fetch(url, data=None, method="GET"):
    """Fetch a URL with our User-Agent. Returns (status, body_bytes)."""
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except urllib.error.URLError as e:
        return 502, json.dumps({"error": f"upstream unreachable: {e.reason}"}).encode()


class Handler(BaseHTTPRequestHandler):
    # quieter logging
    def log_message(self, fmt, *args):
        pass

    def _send(self, status, body, content_type="application/json"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/" or path == "/index.html":
            html = (HERE / "public" / "index.html").read_bytes()
            return self._send(200, html, "text/html; charset=utf-8")

        if path == "/api/nearby":
            q = parse_qs(parsed.query)
            try:
                lat = float(q.get("lat", ["0"])[0])
                lon = float(q.get("lon", ["0"])[0])
                radius = int(float(q.get("radius", ["50"])[0]))
            except ValueError:
                return self._send(400, json.dumps({"error": "bad lat/lon/radius"}))
            radius = max(1, min(radius, 250))  # API caps radius

            key = f"{lat:.3f},{lon:.3f},{radius}"
            now = time.time()
            cached = _cache.get(key)
            if cached and now - cached[0] < CACHE_TTL:
                return self._send(200, cached[1])

            url = f"{ADSB_BASE}/v2/point/{lat}/{lon}/{radius}"
            status, body = _fetch(url)
            if status == 200:
                _cache[key] = (now, body)
            return self._send(status, body)

        # Airline + route (origin/destination) for a callsign.
        if path == "/api/callsign":
            cs = parse_qs(parsed.query).get("cs", [""])[0].strip().upper()
            if not cs:
                return self._send(400, json.dumps({"error": "missing cs"}))
            status, body = _cached(f"cs:{cs}", f"{ADSBDB_BASE}/callsign/{cs}", TTL_STATIC)
            return self._send(status, body)

        # Registration / owner / manufacturer / photo for a Mode-S hex.
        if path == "/api/aircraft":
            hexid = parse_qs(parsed.query).get("hex", [""])[0].strip().upper()
            if not hexid:
                return self._send(400, json.dumps({"error": "missing hex"}))
            status, body = _cached(f"ac:{hexid}", f"{ADSBDB_BASE}/aircraft/{hexid}", TTL_STATIC)
            return self._send(status, body)

        # Decoded METAR for one or more station ids (e.g. KSAN).
        if path == "/api/metar":
            ids = parse_qs(parsed.query).get("ids", ["KSAN"])[0].strip().upper()
            url = f"{METAR_BASE}/metar?ids={ids}&format=json"
            status, body = _cached(f"metar:{ids}", url, TTL_METAR)
            return self._send(status, body)

        return self._send(404, json.dumps({"error": "not found"}))


def _lan_ip():
    """Best-effort local LAN IP (no traffic actually sent)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def main():
    parser = argparse.ArgumentParser(description="Flight dashboard server")
    parser.add_argument("--host", default=HOST,
                        help="interface to bind (default 127.0.0.1 = this machine only)")
    parser.add_argument("--port", type=int, default=PORT, help="port (default 8000)")
    parser.add_argument("--lan", action="store_true",
                        help="shortcut for --host 0.0.0.0 (expose to your local network)")
    args = parser.parse_args()

    host = "0.0.0.0" if args.lan else args.host
    port = args.port
    exposed = host not in ("127.0.0.1", "localhost", "::1")

    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Flight dashboard listening on {host}:{port}")
    if exposed:
        print(f"  - This machine:   http://localhost:{port}")
        print(f"  - Other devices:  http://{_lan_ip()}:{port}")
        print("  [!] EXPOSED to your local network - no authentication. Anyone on the")
        print("      wifi can use this dashboard and its API proxy.")
        print("  [!] Windows Firewall may block it. To allow inbound on this port, run")
        print("      once in an *elevated* PowerShell:")
        print(f"        New-NetFirewallRule -DisplayName 'Flight Dashboard' -Direction Inbound -Action Allow -Protocol TCP -LocalPort {port}")
        print("  Note: the browser 'Use my location' button only works on localhost/https,")
        print("        so other devices enter coordinates manually.")
    else:
        print(f"  Open http://localhost:{port}  (private - pass --lan to share on your network)")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.shutdown()


if __name__ == "__main__":
    main()
