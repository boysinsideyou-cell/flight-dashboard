# Flight Dashboard

A real-time dashboard that finds the **nearest aircraft to your location** using
live ADS-B data, and displays detailed info on the closest one plus a ranked list
of others nearby.

![overview](https://globe.adsb.lol) <!-- live map for any aircraft is linked from the UI -->

## What it does
- Auto-detects your location (browser geolocation) or lets you enter coordinates.
- Polls the [adsb.lol](https://adsb.lol) public API for all aircraft within a radius.
- Highlights the **closest plane**: callsign, type, registration, distance (nm + mi),
  bearing (with a compass arrow pointing where to look), altitude + climb/descent,
  ground speed, heading, squawk, and signal strength.
- **Human-readable enrichment** for the closest plane (via [adsbdb](https://www.adsbdb.com), keyless):
  - **Airline / operator** name (e.g. "United Airlines") from the callsign.
  - **To / From** airports with city names + IATA/ICAO codes.
  - **Owner, registration, manufacturer, readable type**, and an **aircraft photo**.
  - Gracefully shows "No route on file" / "No registry record" for GA or unlisted aircraft.
- **Weather (METAR)** for a configurable station (default `KSAN`), decoded into plain
  English — flight category (VFR/MVFR/IFR/LIFR), wind, visibility, sky/clouds,
  temp/dewpoint + humidity, altimeter — with the raw METAR shown below.
- Lists the next nearest aircraft, sorted by distance, refreshing automatically.
- **Airborne-only filter** (on by default): drops parked/taxiing ground traffic so
  "closest" tracks planes that are actually flying. Near a busy airport (e.g. SAN),
  ramp aircraft keep broadcasting ADS-B and would otherwise always win "nearest."
  A secondary **min ground-speed** filter ignores stationary movers. Both persist.
- A canvas **radar scope** (range rings, bearing/distance blips, heading ticks) —
  the low-resolution view intended to port to an LED matrix board later.

## Requirements
- **Python 3.9+** — standard library only, no `pip install` needed.

## Run
```powershell
python server.py
```
Then open **http://localhost:8000** in your browser.

> Important: open the URL above — not the `index.html` file directly. The page talks
> to the local Python server, which proxies the ADS-B API (the API sends no CORS
> headers, so the browser can't call it directly).

### Sharing on your network (opt-in)
By default the server binds `127.0.0.1` — **this machine only**; other devices on your
wifi cannot reach it. To expose it on your LAN:
```powershell
python server.py --lan          # binds 0.0.0.0, prints your LAN URL + firewall command
python server.py --host 0.0.0.0 --port 9000   # custom interface/port
$env:FLIGHT_HOST="0.0.0.0"; python server.py  # via env var (handy for a service unit)
```
**Caveats when exposed:** there is **no authentication** — anyone on the network can use
the dashboard and its API proxy. Windows Firewall may block the port (the startup banner
prints the `New-NetFirewallRule` command to allow it). The browser "Use my location"
button only works on `localhost`/HTTPS, so other devices enter coordinates manually
(these persist in their browser).

## How it works
Two interchangeable backends serve the **same** `public/index.html` and the **same**
`/api/*` routes, so the UI is identical whether you run locally or in the cloud:

- **Local / Pi:** `server.py` — a tiny stdlib HTTP server. Serves the UI and proxies four
  keyless upstream APIs, each cached by how fast the data changes:
  - `GET /api/nearby?lat=&lon=&radius=` → adsb.lol `/v2/point/...` — live positions (4s).
  - `GET /api/callsign?cs=` → adsbdb — airline + origin/destination (1-day).
  - `GET /api/aircraft?hex=` → adsbdb — registration / owner / type / photo (1-day).
  - `GET /api/metar?ids=` → aviationweather.gov (NOAA/AWC) — decoded METAR (5-min).
- **Cloud (Cloudflare Pages):** the identical proxy lives in `functions/api/*.js` as
  serverless Pages Functions, using Cloudflare's edge cache (same TTLs).
- `public/index.html` — the dashboard UI (vanilla JS, Leaflet via CDN for the map).
- Client-side, enrichment is cached per aircraft (by hex), so each plane is looked up
  once per session no matter how often the dashboard refreshes.

## Publish to the internet (Cloudflare Pages — free, always-on, HTTPS)
No build step, no server to keep running. You need a (free) GitHub account and a (free)
Cloudflare account.

1. **Push this folder to a new GitHub repo:**
   ```powershell
   git init
   git add -A
   git commit -m "Flight dashboard"
   git branch -M main
   git remote add origin https://github.com/<you>/flight-dashboard.git
   git push -u origin main
   ```
2. **Connect it in Cloudflare:** dashboard → **Workers & Pages** → **Create** →
   **Pages** → **Connect to Git** → pick the repo. Build settings:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: **`public`**

   Click **Save and Deploy**. Cloudflare auto-detects `functions/` and wires up `/api/*`.
3. You get a URL like `https://flight-dashboard-xxx.pages.dev`. Because it's HTTPS, the
   **"Use my location"** button works on phones too. Every `git push` redeploys.

> Public + unlisted: the site has **no login** — anyone with the URL can view it and use
> the proxy. The default map centers on the `HOME` coords baked into `public/index.html`;
> edit that constant if you'd rather not expose a specific location.

## Departure / arrival times — not included (and why)
Scheduled (or estimated) **departure/arrival times are not available** from ADS-B or any
of the free, keyless APIs above — ADS-B broadcasts position/velocity, not schedules.
Getting live times requires a flight-schedule API with an account/key, e.g.
[AeroDataBox](https://aerodatabox.com) (free tier via RapidAPI) or
[FlightAware AeroAPI](https://www.flightaware.com/commercial/aeroapi/) (paid). The UI
leaves a labelled slot for this; wiring one in is a small `server.py` proxy + a key.

## Notes
- Data is community-sourced ADS-B; coverage is best near populated areas and worsens
  over oceans / remote regions and below ~1,000 ft (line-of-sight to a receiver).
- Aircraft broadcasting on Mode S without position, or with privacy/blocking
  (e.g. some military/VIP), may not appear.
- adsb.lol is free for personal use. Be a good citizen: keep the refresh interval
  reasonable (default 10s). For higher volume, run your own feeder or get an API key.

## Alternative data sources
The proxy URL in `server.py` (`ADSB_BASE`) can be swapped for other free, key-less,
compatible APIs that use the same `/v2/point/{lat}/{lon}/{radius}` shape:
- `https://opendata.adsb.fi/api/v2`  (adsb.fi)
- `https://api.airplanes.live/v2`     (airplanes.live — uses `/point/...`)

For an officially documented/SLA option, [OpenSky Network](https://openskynetwork.github.io/opensky-api/)
offers a bounding-box REST API (now OAuth2-based for useful rate limits).
