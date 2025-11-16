// supabase/functions/nominatim-place-lookup/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  };
}
// Vilka extra parametrar vi tillåter att klienten skickar vidare till Nominatim
// (lägg gärna till fler vid behov)
const ALLOWED_EXTRA_PARAMS = [
  "accept-language",
  "addressdetails",
  "extratags",
  "namedetails",
  "zoom",
  "layer",
  "polygon_geojson",
  "polygon_kml",
  "polygon_svg",
  "polygon_text",
  "featureType",
  "email"
];
serve(async (req)=>{
  const url = new URL(req.url);
  const origin = req.headers.get("Origin") ?? undefined;
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders(origin)
    });
  }
  try {
    const baseFromEnv = Deno.env.get("NOMINATIM_BASE_URL");
    const NOMINATIM_BASE_URL = baseFromEnv ?? "http://51.21.66.103:8080";
    // enkel validering
    if (!/^https?:\/\/.+/.test(NOMINATIM_BASE_URL)) {
      console.error("Bad NOMINATIM_BASE_URL:", NOMINATIM_BASE_URL);
      return new Response(JSON.stringify({
        error: "Bad NOMINATIM_BASE_URL"
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders(origin)
        }
      });
    }
    let osm_id = null;
    let osm_type = null;
    let acceptLanguage = null;
    // Övriga extra-parametrar som vi tänker vidarebefordra
    const extraParams = {};
    if (req.method === "GET") {
      osm_id = url.searchParams.get("osm_id");
      osm_type = url.searchParams.get("osm_type");
      // Läs språk både som accept-language & accept_language
      acceptLanguage = url.searchParams.get("accept-language") ?? url.searchParams.get("accept_language");
      // Plocka upp alla extra tillåtna parametrar
      for (const key of ALLOWED_EXTRA_PARAMS){
        if (key === "accept-language") continue; // hanteras separat
        const val = url.searchParams.get(key) ?? // stöd för snake_case-variant (t.ex. namedetails vs name_details osv om du vill)
        url.searchParams.get(key.replace(/-/g, "_"));
        if (val != null) {
          extraParams[key] = val;
        }
      }
    } else if (req.method === "POST") {
      const body = await req.json().catch(()=>({}));
      osm_id = body?.osm_id != null ? String(body.osm_id) : null;
      osm_type = body?.osm_type ?? null;
      // stöd både "accept-language" och "accept_language" i body
      acceptLanguage = body?.["accept-language"] ?? body?.accept_language ?? null;
      // plocka upp övriga extra param-nycklar
      for (const key of ALLOWED_EXTRA_PARAMS){
        if (key === "accept-language") continue; // separat
        const val = body?.[key] ?? body?.[key.replace(/-/g, "_")] ?? null;
        if (val != null) {
          extraParams[key] = String(val);
        }
      }
    }
    if (!osm_id) {
      return new Response(JSON.stringify({
        error: "Missing osm_id"
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders(origin)
        }
      });
    }
    const tryTypes = osm_type ? [
      osm_type
    ] : [
      "N",
      "W",
      "R"
    ];
    for (const t of tryTypes){
      const lookupUrl = new URL("/lookup", NOMINATIM_BASE_URL);
      lookupUrl.searchParams.set("format", "jsonv2");
      lookupUrl.searchParams.set("osm_ids", `${t}${osm_id}`);
      // lägg på extra parametrar
      for (const [key, val] of Object.entries(extraParams)){
        lookupUrl.searchParams.set(key, val);
      }
      // accept-language som query-param om angivet
      if (acceptLanguage) {
        lookupUrl.searchParams.set("accept-language", acceptLanguage);
      }
      let fetchInit = {};
      if (acceptLanguage) {
        fetchInit = {
          headers: {
            "Accept-Language": acceptLanguage
          }
        };
      }
      let resp;
      try {
        resp = await fetch(lookupUrl.toString(), fetchInit);
      } catch (e) {
        console.error("fetch failed:", lookupUrl.toString(), e);
        continue; // prova nästa typ
      }
      if (!resp.ok) {
        console.warn("lookup not ok:", lookupUrl.toString(), resp.status);
        continue;
      }
      const data = await resp.json().catch((e)=>{
        console.error("json parse failed:", e);
        return null;
      });
      if (Array.isArray(data) && data.length > 0) {
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders(origin)
          }
        });
      }
    }
    return new Response(JSON.stringify({
      error: "Not found"
    }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders(origin)
      }
    });
  } catch (err) {
    console.error("edge error:", err);
    return new Response(JSON.stringify({
      error: err?.message ?? String(err)
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders(origin)
      }
    });
  }
});
