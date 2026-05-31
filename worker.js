// Cloudflare Worker entry point (Workers + static-assets model).
// Handles the /api/* proxy routes; everything else is served from ./public
// via the ASSETS binding. Mirrors the local server.py endpoints exactly.
const UA = "flight-dashboard/1.0 (personal; public ADS-B APIs)";

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

async function handleApi(url) {
  const p = url.pathname;
  const q = url.searchParams;

  if (p === "/api/nearby") {
    const lat = parseFloat(q.get("lat"));
    const lon = parseFloat(q.get("lon"));
    let radius = parseInt(q.get("radius") || "50", 10);
    if (!isFinite(lat) || !isFinite(lon)) return jsonError("bad lat/lon", 400);
    radius = Math.max(1, Math.min(radius || 50, 250));
    return proxy(`https://api.adsb.lol/v2/point/${lat}/${lon}/${radius}`, 5);
  }
  if (p === "/api/callsign") {
    const cs = (q.get("cs") || "").trim().toUpperCase();
    if (!cs) return jsonError("missing cs", 400);
    return proxy(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cs)}`, 86400);
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
    if (url.pathname.startsWith("/api/")) return handleApi(url);
    return env.ASSETS.fetch(request); // static files from ./public
  },
};
