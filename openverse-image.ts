// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
function okCors(json, status = 200) {
  return new Response(JSON.stringify(json), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization"
    }
  });
}
serve(async (req)=>{
  if (req.method === "OPTIONS") return okCors({}, 204);
  if (req.method !== "POST") return okCors({
    error: "Use POST"
  }, 405);
  const { query, limit = 50, page = 1, license_type = "commercial", licenses = "cc0,by,by-sa,by-nd,pdm" } = await req.json().catch(()=>({}));
  if (!query || typeof query !== "string") {
    return okCors({
      error: "Missing 'query' string"
    }, 400);
  }
  const OPENVERSE_API_KEY = Deno.env.get("OPENVERSE_API_KEY");
  const params = new URLSearchParams({
    q: query,
    page: String(page),
    page_size: String(Math.min(limit, 50)),
    license: licenses,
    license_type
  });
  const url = `https://api.openverse.engineering/v1/images/?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      ...OPENVERSE_API_KEY ? {
        authorization: `Bearer ${OPENVERSE_API_KEY}`
      } : {}
    }
  });
  if (!res.ok) {
    return okCors({
      error: "Openverse request failed",
      status: res.status
    }, 502);
  }
  const data = await res.json();
  const images = (data.results || []).map((r)=>({
      url: r.url || r.thumbnail,
      thumbnail: r.thumbnail,
      title: r.title,
      creator: r.creator,
      license: r.license,
      license_url: r.license_url,
      source: "openverse",
      source_url: r.foreign_landing_url,
      provider: r.provider,
      width: r.width,
      height: r.height
    })).filter((x)=>!!x.url);
  return okCors({
    query,
    count: images.length,
    images
  });
});
