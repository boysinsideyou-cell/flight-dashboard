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
- **Cloud (Cloudflare Workers):** the identical proxy lives in `worker.js`, which handles
  `/api/*` and serves the UI from `./public` via the `ASSETS` binding (Cloudflare's edge
  cache uses the same TTLs).
- `public/index.html` — the dashboard UI (vanilla JS, Leaflet via CDN for the map).
- Client-side, enrichment is cached per aircraft (by hex), so each plane is looked up
  once per session no matter how often the dashboard refreshes.

## Published (Cloudflare Workers — free, always-on, HTTPS)
**Live:** https://flight-dashboard.jeremy-fancher.workers.dev

Deployed via Cloudflare's Workers + static-assets model, connected to the GitHub repo
`boysinsideyou-cell/flight-dashboard`. There is **no build step** — Cloudflare runs
`npx wrangler deploy`, which reads `wrangler.toml`:

```toml
name = "flight-dashboard"
main = "worker.js"            # handles /api/*
compatibility_date = "2026-05-31"
[assets]
directory = "public"          # the dashboard UI
binding = "ASSETS"            # worker.js falls back to this for non-/api paths
```

**Every `git push` to `main` auto-redeploys** — no dashboard steps needed. Because it's
served over HTTPS, the **"Use my location"** button works on phones too.

> Public + unlisted: the site has **no login** — anyone with the URL can view it and use
> the proxy. The default map centers on the `HOME` coords baked into `public/index.html`;
> edit that constant and push if you'd rather not expose a specific location.

## Accurate route + scheduled times (optional, keyed — AeroDataBox)
ADS-B has no schedule data, and the free adsbdb route is the *typical* route for a
callsign (so return legs / reused callsigns can be wrong). For **today's actual
origin/destination + scheduled/estimated times**, the dashboard can use
[AeroDataBox](https://aerodatabox.com) (looked up by the aircraft's Mode-S hex). It's
**optional**: with no key, the "Live schedule" toggle simply falls back to the adsbdb
route — nothing breaks.

**Setup (free tier):**
1. Create a [RapidAPI](https://rapidapi.com) account → subscribe to **AeroDataBox**
   (the **Basic** plan is free; note the monthly request cap). Copy your `X-RapidAPI-Key`.
2. **Cloud (Cloudflare):** dashboard → your Worker **flight-dashboard** → **Settings** →
   **Variables and Secrets** → add a **Secret** named **`AERODATABOX_KEY`** = your key
   → **Deploy**. (Optional `AERODATABOX_HOST`, defaults to `aerodatabox.p.rapidapi.com`.)
   The key lives only in Cloudflare — never in the repo.
3. **Local / Pi:** set an env var before running:
   ```powershell
   $env:AERODATABOX_KEY = "your-key"; python server.py
   ```

**Quota care:** schedule is fetched only for the **closest** aircraft, cached per hex
(client + 10-min edge cache), and gated by the **Live schedule** checkbox — turn it off
to stop using quota. Endpoint: `GET /api/schedule?hex=<mode-s>` → normalized
`{ found, from, to, dep, arr, status, airline }`.

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
