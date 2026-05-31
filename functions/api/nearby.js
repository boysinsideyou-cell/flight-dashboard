// Cloudflare Pages Function — GET /api/nearby?lat=&lon=&radius=
// Proxies adsb.lol live positions (browser can't call it directly: no CORS).
const UA = "flight-dashboard/1.0 (personal; public ADS-B APIs)";

function err(msg, status) {
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
    return err("upstream unreachable", 502);
  }
}

export async function onRequestGet({ request }) {
  const q = new URL(request.url).searchParams;
  const lat = parseFloat(q.get("lat"));
  const lon = parseFloat(q.get("lon"));
  let radius = parseInt(q.get("radius") || "50", 10);
  if (!isFinite(lat) || !isFinite(lon)) return err("bad lat/lon", 400);
  radius = Math.max(1, Math.min(radius || 50, 250));
  return proxy(`https://api.adsb.lol/v2/point/${lat}/${lon}/${radius}`, 5);
}
