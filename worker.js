// Cloudflare Worker entry point (Workers + static-assets model).
// Handles the /api/* proxy routes; everything else is served from ./public
// via the ASSETS binding. Mirrors the local server.py endpoints exactly.
// Descriptive UA with a contact URL — required by planespotters.net, polite elsewhere.
const UA = "flight-dashboard/1.0 (+https://flight-dashboard.jeremy-fancher.workers.dev)";

function jsonError(msg, status) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function proxy(url, ttl) {
  try {
    const r = await fetch(url, {
      headers: { "user-agent": UA, accept: "application/json" },
      cf: { cacheTtl: ttl, cacheEverything: true },
    });
    return new Response(r.body, {
      status: r.status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${ttl}`,
      },
    });
  } catch (e) {
    return jsonError("upstream unreachable", 502);
  }
}

const jsonOk = (obj, ttl = 300) =>
  new Response(JSON.stringify(obj), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": `public, max-age=${ttl}` },
  });

// --- AeroDataBox flight normalisation (accurate current route + times) ---
function adbAirport(side) {
  const a = side && side.airport;
  if (!a) return null;
  const loc = a.location || {};
  return { iata: a.iata || null, icao: a.icao || null, name: a.shortName || a.name || null,
    city: a.municipalityName || null, lat: loc.lat != null ? loc.lat : null, lon: loc.lon != null ? loc.lon : null };
}
function adbTimes(side) {
  if (!side) return null;
  const pick = (x) => (x ? x.local || x.utc || null : null);
  return { sched: pick(side.scheduledTime), revised: pick(side.revisedTime), runway: pick(side.runwayTime) };
}
function adbPick(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const active = list.find((f) => /en.?route|airborne|expected|boarding|departed|approach/i.test(f.status || ""));
  return active || list[list.length - 1];
}
function adbNormalize(f) {
  return {
    found: true, number: f.number || null, callsign: f.callSign || null, status: f.status || null,
    airline: f.airline ? f.airline.name || null : null,
    from: adbAirport(f.departure), to: adbAirport(f.arrival),
    dep: adbTimes(f.departure), arr: adbTimes(f.arrival),
  };
}

async function handleApi(url, env) {
  const p = url.pathname;
  const q = url.searchParams;

  // Accurate, current route + scheduled times via AeroDataBox (keyed; optional).
  // Falls back gracefully (found:false) when no key / no match / rate-limited, so
  // the UI keeps showing the adsbdb "typical route" instead of breaking.
  if (p === "/api/schedule") {
    const hex = (q.get("hex") || "").trim();
    if (!hex) return jsonError("missing hex", 400);
    if (!env || !env.AERODATABOX_KEY) return jsonOk({ found: false, reason: "no_key" }, 60);
    const host = env.AERODATABOX_HOST || "aerodatabox.p.rapidapi.com";
    const u = `https://${host}/flights/Icao24/${encodeURIComponent(hex)}?withAircraftImage=false&withLocation=true`;
    try {
      const r = await fetch(u, {
        headers: { "X-RapidAPI-Key": env.AERODATABOX_KEY, "X-RapidAPI-Host": host, accept: "application/json" },
        cf: { cacheTtl: 600, cacheEverything: true }, // conserve the small free quota
      });
      if (!r.ok) return jsonOk({ found: false, reason: "http_" + r.status }, 120);
      const data = await r.json();
      const flights = Array.isArray(data) ? data : data.flights || [];
      const f = adbPick(flights);
      return jsonOk(f ? adbNormalize(f) : { found: false }, 600);
    } catch (e) {
      return jsonOk({ found: false, reason: "error" }, 60);
    }
  }

  if (p === "/api/nearby") {
    const lat = parseFloat(q.get("lat"));
    const lon = parseFloat(q.get("lon"));
    let radius = parseInt(q.get("radius") || "50", 10);
    if (!isFinite(lat) || !isFinite(lon)) return jsonError("bad lat/lon", 400);
    radius = Math.max(1, Math.min(radius || 50, 250));
    return proxy(`https://api.adsb.lol/v2/point/${lat}/${lon}/${radius}`, 5);
  }
  // Aircraft photo (planespotters.net, keyless; attribution required & shown).
  if (p === "/api/photo") {
    const hex = (q.get("hex") || "").trim();
    if (!hex) return jsonError("missing hex", 400);
    return proxy(`https://api.planespotters.net/pub/photos/hex/${encodeURIComponent(hex)}`, 86400);
  }
  if (p === "/api/callsign") {
    const cs = (q.get("cs") || "").trim().toUpperCase();
    if (!cs) return jsonError("missing cs", 400);
    return proxy(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cs)}`, 3600);
  }
  if (p === "/api/aircraft") {
    const hex = (q.get("hex") || "").trim().toUpperCase();
    if (!hex) return jsonError("missing hex", 400);
    return proxy(`https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(hex)}`, 86400);
  }
  if (p === "/api/metar") {
    const ids = (q.get("ids") || "KSAN").trim().toUpperCase();
    return proxy(`https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(ids)}&format=json`, 300);
  }
  return jsonError("not found", 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(url, env);
    // Static files from ./public. Serve HTML with no-cache so dashboard updates
    // reach every client immediately (otherwise a stale index.html lingers and
    // old bugs—e.g. the location handling—appear "unfixed").
    const res = await env.ASSETS.fetch(request);
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("text/html")) {
      const h = new Headers(res.headers);
      h.set("cache-control", "no-cache, no-store, must-revalidate");
      return new Response(res.body, { status: res.status, headers: h });
    }
    return res;
  },
};
