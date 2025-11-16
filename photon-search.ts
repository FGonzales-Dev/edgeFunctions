/// deno-lint-ignore-file no-explicit-any
/**
 * Supabase Edge Function: photon-search (forward-only /api, explicit modes)
 * Runtime: Deno (TypeScript)
 *
 * ENV:
 *  - PHOTON_BASE_URL  (ex: "http://51.21.66.103:2322"  // NOTE: no trailing /api)
 *  - ALLOWED_ORIGINS  (comma-separated or "*")
 *
 * Modes (REQUIRED):
 *  - "autocomplete"  : plain forward (/api) with q only (no geometryList)
 *  - "point"         : geometryList length 1 + radius (m) -> bbox around point
 *  - "rectangle"     : geometryList length 2 -> bbox rectangle
 *  - "polyline"      : geometryList length >= 2 + radius (m) -> corridor (auto densify)
 */ import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
/* ───────────────────────── CORS ───────────────────────── */ function corsHeaders(origin) {
  const allowed = Deno.env.get("ALLOWED_ORIGINS") ?? "*";
  const ok = allowed === "*" || !!origin && allowed.split(",").map((s)=>s.trim()).includes(origin);
  const h = new Headers();
  h.set("Access-Control-Allow-Origin", ok ? origin ?? "*" : "*");
  h.set("Vary", "Origin");
  h.set("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  h.set("Content-Type", "application/json; charset=utf-8");
  return h;
}
const badRequest = (h, msg, extra)=>new Response(JSON.stringify({
    error: msg,
    ...extra
  }), {
    status: 400,
    headers: h
  });
const serverError = (h, msg, extra)=>new Response(JSON.stringify({
    error: msg,
    ...extra
  }), {
    status: 500,
    headers: h
  });
/* ───────────────────────── Utils ───────────────────────── */ function photonApi(base) {
  return base.replace(/\/api\/?$/i, "").replace(/\/$/, "") + "/api";
}
function validateGeometryList(gl) {
  return Array.isArray(gl) && gl.length > 0 && gl.every((p)=>Array.isArray(p) && p.length === 2 && typeof p[0] === "number" && typeof p[1] === "number");
}
function rectangleFromTwoPoints(geometryList) {
  if (geometryList.length !== 2) {
    return {
      ok: false,
      error: "`geometryList` must contain exactly 2 points for rectangle."
    };
  }
  const [a, b] = geometryList;
  const minLat = Math.min(a[0], b[0]);
  const maxLat = Math.max(a[0], b[0]);
  const minLon = Math.min(a[1], b[1]);
  const maxLon = Math.max(a[1], b[1]);
  if (!(minLat < maxLat) || !(minLon < maxLon)) {
    return {
      ok: false,
      error: "Invalid rectangle: min < max must hold for lat & lon."
    };
  }
  return {
    ok: true,
    bbox: {
      minLat,
      minLon,
      maxLat,
      maxLon
    }
  };
}
function bboxAroundPoint(lat, lon, radiusMeters) {
  const dLat = radiusMeters / 111320; // m/deg latitude
  const dLon = radiusMeters / (111320 * Math.cos(lat * Math.PI / 180));
  return {
    minLat: lat - dLat,
    minLon: lon - dLon,
    maxLat: lat + dLat,
    maxLon: lon + dLon
  };
}
function bboxToParam(b) {
  return `${b.minLon},${b.minLat},${b.maxLon},${b.maxLat}`;
}
function uniqPhotonFeatures(features) {
  const seen = new Set();
  const out = [];
  for (const f of features ?? []){
    const t = f?.properties?.osm_type;
    const id = f?.properties?.osm_id;
    const key = t && id ? `${t}/${id}` : f?.id ?? JSON.stringify(f?.geometry);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(f);
    }
  }
  return out;
}
/* ───────────── Categories → osm_tag ───────────── */ const CATEGORY_MAP = {
  cafe: "amenity:cafe",
  restaurant: "amenity:restaurant",
  bar: "amenity:bar",
  pub: "amenity:pub",
  fast_food: "amenity:fast_food",
  supermarket: "shop:supermarket",
  convenience: "shop:convenience",
  museum: "tourism:museum",
  park: "leisure:park",
  hotel: "tourism:hotel",
  hostel: "tourism:hostel",
  pharmacy: "amenity:pharmacy",
  bank: "amenity:bank",
  atm: "amenity:atm",
  fuel: "amenity:fuel"
};
function categoriesToOsmTags(categories) {
  if (!categories || !Array.isArray(categories) || categories.length === 0) {
    return undefined;
  }
  const out = {};
  for (const raw of categories){
    const c = String(raw ?? "").trim().toLowerCase();
    const tag = CATEGORY_MAP[c];
    if (!tag) continue;
    const [k, v] = tag.split(":");
    if (!out[k]) out[k] = [];
    out[k].push(v);
  }
  return Object.keys(out).length ? out : undefined;
}
function buildOsmTagParams(osmTags) {
  const params = [];
  if (!osmTags) return params;
  for (const [k, arr] of Object.entries(osmTags)){
    for (const v of arr){
      params.push([
        "osm_tag",
        `${k}:${v}`
      ]);
    }
  }
  return params;
}
/* ───────────── Fallback q ───────────── */ function pickFallbackQuery(input) {
  if (input?.q && String(input.q).trim().length) return String(input.q).trim();
  if (input?.name && String(input.name).trim().length) {
    return String(input.name).trim();
  }
  const cats = Array.isArray(input?.categories) ? input.categories : [];
  if (cats.length) {
    const first = String(cats[0] ?? "").toLowerCase().trim();
    if (first) return first;
  }
  const ot = input?.osmTags && typeof input.osmTags === "object" ? input.osmTags : undefined;
  if (ot) {
    const [k, arr] = Object.entries(ot)[0] ?? [];
    if (Array.isArray(arr) && arr[0]) return String(arr[0]);
    if (k) return String(k);
  }
  return "poi";
}
/* ───────────── Forward fetch ───────────── */ async function photonForwardFetch(apiBase, searchParams, dbg = false) {
  const url = `${apiBase}?${searchParams.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(()=>"");
    const err = new Error(`Photon /api error: ${res.status}`);
    if (dbg) {
      err._debug = {
        url,
        body: text.slice(0, 500)
      };
    }
    throw err;
  }
  const json = await res.json();
  return {
    url,
    json
  };
}
/* ───────────── Input merge (query + body) ───────────── */ async function readInput(req) {
  const url = new URL(req.url);
  const queryObj = {};
  url.searchParams.forEach((v, k)=>{
    if (k in queryObj) {
      queryObj[k] = Array.isArray(queryObj[k]) ? [
        ...queryObj[k],
        v
      ] : [
        queryObj[k],
        v
      ];
    } else {
      queryObj[k] = v;
    }
  });
  let bodyObj = {};
  if (req.method !== "GET" && req.headers.get("content-type")?.includes("application/json")) {
    try {
      bodyObj = await req.json();
    } catch  {
      bodyObj = {};
    }
  }
  const merged = {
    ...queryObj,
    ...bodyObj
  };
  // Back-compat: map name -> q if q saknas
  if ((merged.q == null || String(merged.q).trim() === "") && merged.name) {
    merged.q = merged.name;
  }
  // normalize mode (required)
  if (merged.mode) merged.mode = String(merged.mode).toLowerCase();
  return merged;
}
/* ───────────── Build /api params ───────────── */ function buildForwardParams(input) {
  const params = new URLSearchParams();
  // Always provide q (fallback if missing)
  params.set("q", pickFallbackQuery(input));
  // Standard Photon params
  if (input.limit != null) params.set("limit", String(input.limit));
  if (input.lang != null) params.set("lang", String(input.lang));
  if (input.lat != null) params.set("lat", String(input.lat));
  if (input.lon != null) params.set("lon", String(input.lon));
  if (input.bbox && typeof input.bbox === "string") {
    params.set("bbox", input.bbox); // raw bbox string support
  }
  // layer/osm_key/osm_value/osm_tag passthrough (string or array)
  for (const key of [
    "layer",
    "osm_key",
    "osm_value",
    "osm_tag"
  ]){
    const v = input[key];
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((e)=>params.append(key, String(e)));
    else params.append(key, String(v));
  }
  // categories/osmTags → osm_tag
  const osmTags = input.osmTags ?? categoriesToOsmTags(input.categories);
  for (const [k, v] of buildOsmTagParams(osmTags)){
    params.append(k, v);
  }
  return {
    params,
    osmTags
  };
}
/* ───────────── Geo helpers (distance & densifiering) ───────────── */ function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d)=>d * Math.PI / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function interpolate(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t
  ];
}
function densifyPolylineByRadius(gl, radiusMeters, maxPoints = 200) {
  if (!(radiusMeters > 0)) return gl;
  const step = Math.max(1, radiusMeters * 0.9); // center-to-center spacing for bbox overlap
  const out = [];
  for(let i = 0; i < gl.length - 1; i++){
    const A = gl[i];
    const B = gl[i + 1];
    out.push(A);
    const dist = haversineMeters(A, B);
    const nInsert = Math.max(0, Math.ceil(dist / step) - 1);
    for(let k = 1; k <= nInsert; k++){
      out.push(interpolate(A, B, k / (nInsert + 1)));
      if (out.length >= maxPoints - 1) break;
    }
    if (out.length >= maxPoints - 1) break;
  }
  out.push(gl[gl.length - 1]);
  if (out.length > maxPoints) {
    const stride = Math.ceil(out.length / maxPoints);
    const thinned = [];
    for(let i = 0; i < out.length; i += stride){
      thinned.push(out[i]);
    }
    if (thinned[thinned.length - 1] !== out[out.length - 1]) {
      thinned.push(out[out.length - 1]);
    }
    return thinned;
  }
  return out;
}
/* ───────────── Mode handlers ───────────── */ async function handleAutocomplete(apiBase, input) {
  if (input.geometryList) {
    throw new Error("`geometryList` not allowed in 'autocomplete' mode.");
  }
  const { params } = buildForwardParams(input);
  const { url, json } = await photonForwardFetch(apiBase, params, Boolean(input.debug));
  return {
    source: "photon-forward",
    mode: "autocomplete",
    debug: input.debug ? {
      url
    } : undefined,
    data: json
  };
}
async function handlePoint(apiBase, input) {
  if (!validateGeometryList(input.geometryList) || input.geometryList.length !== 1) {
    throw new Error("'point' mode requires geometryList with exactly 1 [lat,lon].");
  }
  const radius = Number(input.radius ?? 0);
  if (!(radius > 0)) {
    throw new Error("'point' mode requires a positive `radius` (meters).");
  }
  const [lat, lon] = input.geometryList[0];
  const { params } = buildForwardParams(input);
  if (!params.has("lat")) params.set("lat", String(lat));
  if (!params.has("lon")) params.set("lon", String(lon));
  params.set("bbox", bboxToParam(bboxAroundPoint(lat, lon, radius)));
  const { url, json } = await photonForwardFetch(apiBase, params, Boolean(input.debug));
  return {
    source: "photon-forward-bbox",
    mode: "point",
    debug: input.debug ? {
      url
    } : undefined,
    data: json
  };
}
async function handleRectangle(apiBase, input) {
  if (!validateGeometryList(input.geometryList) || input.geometryList.length !== 2) {
    throw new Error("'rectangle' mode requires geometryList with exactly 2 [lat,lon] points.");
  }
  const rect = rectangleFromTwoPoints(input.geometryList);
  if (!rect.ok) throw new Error(rect.error);
  const { params } = buildForwardParams(input);
  params.set("bbox", bboxToParam(rect.bbox));
  const { url, json } = await photonForwardFetch(apiBase, params, Boolean(input.debug));
  return {
    source: "photon-forward-bbox",
    mode: "rectangle",
    debug: input.debug ? {
      url
    } : undefined,
    data: json
  };
}
async function handlePolyline(apiBase, input) {
  if (!validateGeometryList(input.geometryList) || input.geometryList.length < 2) {
    throw new Error("'polyline' mode requires geometryList with 2 or more [lat,lon] points.");
  }
  const radius = Number(input.radius ?? 0);
  if (!(radius > 0)) {
    throw new Error("'polyline' mode requires a positive `radius` (meters).");
  }
  const gl = densifyPolylineByRadius(input.geometryList, radius, Number(input.maxPolylinePoints ?? 200));
  const limit = Number(input.limit ?? 20);
  const perCallLimit = Math.max(5, Math.ceil(limit / 2));
  const collected = [];
  for (const [lat, lon] of gl){
    const { params } = buildForwardParams({
      ...input,
      limit: perCallLimit
    });
    if (!params.has("lat")) params.set("lat", String(lat));
    if (!params.has("lon")) params.set("lon", String(lon));
    params.set("bbox", bboxToParam(bboxAroundPoint(lat, lon, radius)));
    const { json } = await photonForwardFetch(apiBase, params, false);
    collected.push(...json?.features ?? []);
  }
  const dedup = uniqPhotonFeatures(collected).slice(0, limit);
  const note = input.debug ? `per-point /api with auto densify (radius=${radius}m, points=${gl.length})` : undefined;
  return {
    source: "photon-forward-bbox-multi",
    mode: "polyline",
    debug: input.debug ? {
      note
    } : undefined,
    data: {
      type: "FeatureCollection",
      features: dedup
    }
  };
}
/* ───────────── HTTP entry ───────────── */ serve(async (req)=>{
  const headers = corsHeaders(req.headers.get("Origin"));
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers
    });
  }
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      return badRequest(headers, "Use GET or POST.");
    }
    const photonBase = Deno.env.get("PHOTON_BASE_URL");
    if (!photonBase) {
      return serverError(headers, "Missing PHOTON_BASE_URL secret.");
    }
    const input = await readInput(req);
    const apiBase = photonApi(photonBase);
    const mode = String(input.mode ?? "").toLowerCase();
    if (!mode) {
      return badRequest(headers, "Missing required `mode`. Use one of: autocomplete, point, rectangle, polyline.");
    }
    if (mode === "autocomplete") {
      const out = await handleAutocomplete(apiBase, input);
      return new Response(JSON.stringify(out), {
        headers
      });
    }
    if (mode === "point") {
      const out = await handlePoint(apiBase, input);
      return new Response(JSON.stringify(out), {
        headers
      });
    }
    if (mode === "rectangle") {
      const out = await handleRectangle(apiBase, input);
      return new Response(JSON.stringify(out), {
        headers
      });
    }
    if (mode === "polyline") {
      const out = await handlePolyline(apiBase, input);
      return new Response(JSON.stringify(out), {
        headers
      });
    }
    return badRequest(headers, "Unsupported `mode`. Use one of: autocomplete, point, rectangle, polyline.");
  } catch (err) {
    const payload = {
      error: "Upstream error",
      details: String(err?.message ?? err)
    };
    if (err?._debug) payload.debug = err._debug;
    return new Response(JSON.stringify(payload), {
      status: 500,
      headers
    });
  }
});
