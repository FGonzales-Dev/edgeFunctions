// Deno / Supabase Edge Function: Valhalla smart proxy med polyline6 -> polyline5
// Deploy: supabase functions deploy valhalla
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
/* ===== Env & defaults ===== */ const VALHALLA_BASE = (Deno.env.get("VALHALLA_BASE") ?? "").replace(/\/+$/, ""); // t.ex. http://13.61.135.250:8002
const CLIENT_API_KEY = Deno.env.get("CLIENT_API_KEY") ?? ""; // optional
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "*").split(",").map((s)=>s.trim()).filter(Boolean);
const REQUIRE_JWT = (Deno.env.get("REQUIRE_JWT") ?? "false").toLowerCase() === "true";
const TIMEOUT_MS = Number(Deno.env.get("TIMEOUT_MS") ?? "120000");
const MAX_BYTES = Number(Deno.env.get("MAX_BYTES") ?? "2097152"); // 2 MiB
const GOOGLE_POLYLINE_PRECISION = Number(Deno.env.get("GOOGLE_POLYLINE_PRECISION") ?? "5"); // Google = 5
// Valhalla endpoints vi tillåter
const ALLOW = new Set([
  "status",
  "route",
  "locate",
  "costs",
  "height",
  "isochrone",
  "trace_route",
  "trace_attributes",
  "optimized_route",
  "sources_to_targets"
]);
/* ===== Helpers ===== */ function cors(origin) {
  const allowOrigin = ALLOWED_ORIGINS.includes("*") ? "*" : origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0] ?? "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, content-type, x-api-key, x-client-version",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400"
  };
}
async function readBodyLimited(req, maxBytes) {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let received = 0;
  while(true){
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      received += value.byteLength;
      if (received > maxBytes) throw new Error("Payload too large");
      chunks.push(value);
    }
  }
  const total = new Uint8Array(received);
  let off = 0;
  for (const c of chunks){
    total.set(c, off);
    off += c.byteLength;
  }
  return total;
}
// Stöd både ?endpoint=route och /valhalla/route
function resolveEndpoint(url) {
  const qp = (url.searchParams.get("endpoint") ?? "").replace(/^\/+/, "");
  if (qp) return qp;
  const parts = url.pathname.split("/").filter(Boolean); // .../valhalla[/endpoint]
  const maybe = parts[parts.length - 1];
  const prev = parts[parts.length - 2];
  if (prev && prev.toLowerCase() === "valhalla" && maybe) return maybe;
  return "route";
}
function buildUpstreamUrl(endpoint, url) {
  const skip = new Set([
    "endpoint",
    "diag"
  ]);
  const sp = new URLSearchParams();
  for (const [k, v] of url.searchParams.entries()){
    if (!skip.has(k)) sp.append(k, v);
  }
  const qs = sp.toString();
  return `${VALHALLA_BASE}/${endpoint}${qs ? `?${qs}` : ""}`;
}
/* ===== Polyline helpers (decode/encode) ===== */ function decodePolyline(str, precision = 6) {
  const factor = Math.pow(10, precision);
  const coords = [];
  let index = 0, lat = 0, lng = 0;
  while(index < str.length){
    let result = 0, shift = 0, b;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    }while (b >= 0x20)
    const dlat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dlat;
    result = 0;
    shift = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    }while (b >= 0x20)
    const dlng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dlng;
    coords.push([
      lat / factor,
      lng / factor
    ]);
  }
  return coords;
}
function encodePolyline(coords, precision = 5) {
  const factor = Math.pow(10, precision);
  let prevLat = 0, prevLng = 0, out = "";
  for (const [lat, lng] of coords){
    let ilat = Math.round(lat * factor);
    let ilng = Math.round(lng * factor);
    let dlat = ilat - prevLat;
    prevLat = ilat;
    let dlng = ilng - prevLng;
    prevLng = ilng;
    const enc = (v)=>{
      v = v < 0 ? ~(v << 1) : v << 1;
      while(v >= 0x20){
        out += String.fromCharCode((0x20 | v & 0x1f) + 63);
        v >>= 5;
      }
      out += String.fromCharCode(v + 63);
    };
    enc(dlat);
    enc(dlng);
  }
  return out;
}
// Konvertera shapes i Valhalla-svar (trip.shape + legs[*].shape); bevarar övriga fält oförändrade
function convertValhallaShapes(obj, targetPrecision = 5) {
  const convertOne = (s)=>{
    if (typeof s !== "string" || !s) return s;
    try {
      const coords = decodePolyline(s, 6); // Valhalla default = polyline6
      return encodePolyline(coords, targetPrecision);
    } catch  {
      return s; // Om något är off, lämna orörd
    }
  };
  if (obj?.trip) {
    if (typeof obj.trip.shape === "string") obj.trip.shape = convertOne(obj.trip.shape);
    if (Array.isArray(obj.trip.legs)) {
      for (const leg of obj.trip.legs){
        if (typeof leg.shape === "string") leg.shape = convertOne(leg.shape);
      }
    }
  }
  if (typeof obj?.shape === "string") obj.shape = convertOne(obj.shape); // fallback för andra endpoints
  return obj;
}
/* ===== Server ===== */ serve(async (req)=>{
  const url = new URL(req.url);
  const origin = req.headers.get("origin");
  const baseHeaders = cors(origin);
  // CORS preflight
  if (req.method === "OPTIONS") return new Response(null, {
    headers: baseHeaders
  });
  // Env check
  if (!VALHALLA_BASE) {
    return new Response(JSON.stringify({
      error: "Missing VALHALLA_BASE env"
    }), {
      status: 500,
      headers: {
        ...baseHeaders,
        "Content-Type": "application/json"
      }
    });
  }
  // API key (optional)
  if (CLIENT_API_KEY) {
    const key = req.headers.get("x-api-key");
    if (key !== CLIENT_API_KEY) {
      return new Response(JSON.stringify({
        error: "Invalid API key"
      }), {
        status: 401,
        headers: {
          ...baseHeaders,
          "Content-Type": "application/json"
        }
      });
    }
  }
  // JWT (optional)
  if (REQUIRE_JWT) {
    const auth = req.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ") || auth.slice(7).trim().length < 20) {
      return new Response(JSON.stringify({
        error: "Unauthorized"
      }), {
        status: 401,
        headers: {
          ...baseHeaders,
          "Content-Type": "application/json"
        }
      });
    }
  }
  // Diagnostics
  const diag = url.searchParams.get("diag");
  if (req.method === "GET" && diag === "status") {
    try {
      const r = await fetch(`${VALHALLA_BASE}/status`);
      const t = await r.text();
      return new Response(JSON.stringify({
        ok: true,
        VALHALLA_BASE,
        upstreamStatus: r.status,
        contentType: r.headers.get("content-type"),
        bodySample: t.slice(0, 500)
      }), {
        status: 200,
        headers: {
          ...baseHeaders,
          "Content-Type": "application/json"
        }
      });
    } catch (e) {
      return new Response(JSON.stringify({
        ok: false,
        error: "fetch failed",
        detail: String(e)
      }), {
        status: 504,
        headers: {
          ...baseHeaders,
          "Content-Type": "application/json"
        }
      });
    }
  }
  // Resolve endpoint & method
  const endpoint = resolveEndpoint(url).replace(/^\/+/, "");
  if (!ALLOW.has(endpoint)) {
    return new Response(JSON.stringify({
      error: `Unsupported endpoint "${endpoint}"`
    }), {
      status: 400,
      headers: {
        ...baseHeaders,
        "Content-Type": "application/json"
      }
    });
  }
  const upstreamUrl = buildUpstreamUrl(endpoint, url);
  const method = endpoint === "status" && req.method === "GET" ? "GET" : req.method;
  if (method !== "GET" && method !== "POST") {
    return new Response(JSON.stringify({
      error: "Use GET (for status) or POST"
    }), {
      status: 405,
      headers: {
        ...baseHeaders,
        "Content-Type": "application/json"
      }
    });
  }
  // Body (för POST). Var förlåtande med JSON; proxya rå data.
  let rawBody = new Uint8Array();
  try {
    if (method === "POST") rawBody = await readBodyLimited(req, MAX_BYTES);
  } catch  {
    return new Response(JSON.stringify({
      error: "Payload too large"
    }), {
      status: 413,
      headers: {
        ...baseHeaders,
        "Content-Type": "application/json"
      }
    });
  }
  const reqCT = (req.headers.get("content-type") ?? "").toLowerCase();
  if (method === "POST" && reqCT.includes("application/json")) {
    const asText = new TextDecoder().decode(rawBody || new Uint8Array());
    try {
      JSON.parse(asText || "{}");
    } catch (e) {
      console.warn("Invalid JSON (passing through):", String(e));
    }
  }
  // Proxy med timeout
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(upstreamUrl, {
      method: method === "GET" ? "GET" : "POST",
      headers: {
        ...method === "POST" ? {
          "Content-Type": reqCT || "application/json"
        } : {},
        "Accept": "application/json, text/plain, */*"
      },
      body: method === "POST" ? rawBody : undefined,
      signal: controller.signal
    });
    clearTimeout(timer);
    const upstreamCT = upstream.headers.get("content-type") ?? "application/octet-stream";
    const outHeaders = new Headers(baseHeaders);
    outHeaders.set("Content-Type", upstreamCT);
    // JSON: konvertera polyline6 -> polyline5, bevara övriga fält (distance, time, etc.)
    if (upstreamCT.includes("application/json")) {
      const text = await upstream.text();
      try {
        const data = JSON.parse(text || "{}");
        const converted = convertValhallaShapes(data, GOOGLE_POLYLINE_PRECISION);
        return new Response(JSON.stringify(converted), {
          status: upstream.status,
          headers: outHeaders
        });
      } catch  {
        // Om JSON inte gick att parsa, returnera råtexten
        return new Response(text, {
          status: upstream.status,
          headers: outHeaders
        });
      }
    }
    // Icke-JSON: pass-through bytes
    const buf = new Uint8Array(await upstream.arrayBuffer());
    return new Response(buf, {
      status: upstream.status,
      headers: outHeaders
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = e && String(e).toLowerCase().includes("abort") ? "Upstream timeout" : "Upstream fetch failed";
    return new Response(JSON.stringify({
      error: msg,
      detail: String(e),
      tried: upstreamUrl
    }), {
      status: 504,
      headers: {
        ...baseHeaders,
        "Content-Type": "application/json"
      }
    });
  }
});
