// Cloudflare Pages Function — GET /api/metar?ids=
// Decoded METAR for one or more stations (aviationweather.gov / NOAA-AWC, keyless).
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
  const ids = (new URL(request.url).searchParams.get("ids") || "KSAN").trim().toUpperCase();
  return proxy(`https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(ids)}&format=json`, 300);
}
