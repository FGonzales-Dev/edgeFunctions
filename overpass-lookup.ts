// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type OutFormat = "json" | "xml" | "csv";
type OutMode = "body" | "tags" | "geom" | "center" | "skel";
type MatchMode = "any" | "all";
type OsmType = "node" | "way" | "relation";

type TagFilter = { key: string; value?: string };

const OVERPASS_URL = Deno.env.get("OVERPASS_URL") ?? ""; // ex: https://overpass-api.de
const ALLOWED_ORIGINS = Deno.env.get("ALLOWED_ORIGINS") ?? "*";

serve(async (req) => {
  // CORS
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!OVERPASS_URL) return json({ error: "OVERPASS_URL not set" }, 500);

  try {
    const contentType = (req.headers.get("content-type") ?? "").toLowerCase();

    // 1) text/plain => treat body as raw Overpass QL directly
    if (contentType.includes("text/plain")) {
      const rawQuery = (await req.text()).trim();
      if (!rawQuery) return json({ error: "Empty plain-text body (expected Overpass QL)" }, 400);
      return await forwardToOverpass(rawQuery);
    }

    // 2) otherwise => expect JSON
    let payload: any;
    try {
      payload = await req.json();
    } catch {
      return json(
        {
          error:
            "Invalid JSON body. If you're sending a raw query, either use mode='raw' with a properly escaped JSON string, or set Content-Type to text/plain and send the Overpass QL directly.",
        },
        400,
      );
    }

    const query = buildOverpassQuery(payload);
    return await forwardToOverpass(query);
  } catch (err) {
    return json({ error: (err as Error).message }, 400);
  }
});

/* ------------------------- Core: forward to Overpass ------------------------- */

async function forwardToOverpass(query: string): Promise<Response> {
  const url = new URL("/api/interpreter", OVERPASS_URL);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: new URLSearchParams({ data: query }),
  });

  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: {
      ...corsHeaders(),
      "Content-Type": res.headers.get("content-type") ?? "text/plain",
      // Debug: lätt att se exakt vad som skickades
      "X-Overpass-Query": encodeURIComponent(query).slice(0, 8000),
    },
  });
}

/* ------------------------- Query builder ------------------------- */

function buildOverpassQuery(p: any): string {
  if (!p?.mode) throw new Error("Missing 'mode'");

  // RAW mode: user provides full Overpass QL
  if (p.mode === "raw") {
    if (typeof p.query !== "string" || !p.query.trim()) {
      throw new Error("mode=raw requires non-empty 'query' string");
    }
    return p.query.trim();
  }

  const outFormat = normalizeOutFormat(p.out);
  const outMode = normalizeOutMode(p.outMode ?? "body");
  const timeout = clampInt(p.timeoutSeconds ?? 25, 1, 180);

  const limit = typeof p.limit === "number" ? clampInt(p.limit, 1, 50000) : undefined;
  const outTail = buildOutTail(p, limit);

  type OutBase = "body" | "tags" | "skel"; // keep it simple

function normalizeOutBase(mode: any): OutBase {
  const v = String(mode ?? "body").toLowerCase().trim();
  if (v === "body" || v === "tags" || v === "skel") return v;
  return "body";
}

function buildOutTail(p: any, limit?: number): string {
  // Backward compatible:
  // - if p.outMode is "center" or "geom", treat it as a geometry modifier
  const raw = String(p.outMode ?? "body").toLowerCase().trim();

  const base: OutBase =
    raw === "center" || raw === "geom" ? "body" : normalizeOutBase(raw);

  const wantCenter = Boolean(p.center) || raw === "center";
  const wantGeom = Boolean(p.geom) || raw === "geom";

  const mods: string[] = [];
  if (wantCenter) mods.push("center");
  if (wantGeom) mods.push("geom");

  const tail = `out ${base}${mods.length ? " " + mods.join(" ") : ""}`;
  return limit ? `${tail} ${limit};` : `${tail};`;
}


  // ID lookup: if osmType omitted -> try node/way/relation
  if (p.mode === "id") {
    if (p.osmId === undefined || p.osmId === null) throw new Error("mode=id requires 'osmId'");
    const osmId = asInt(p.osmId, "osmId");

    const selector = p.osmType
      ? `${normalizeOsmType(p.osmType)}(${osmId});`
      : `(node(${osmId});way(${osmId});relation(${osmId}););`;

    return `[out:${outFormat}][timeout:${timeout}];${selector}${outTail}`;
  }

  if (p.mode === "bbox") {
    const bbox = normalizeBBox(p.bbox); // "(s,w,n,e)"
    const types = normalizeTypes(p.types);
    const tags = normalizeTags(p.tags);
    const match = normalizeMatch(p.match);

    const union = buildUnion(types, tags, match, bbox);
    return `[out:${outFormat}][timeout:${timeout}];(${union};);${outTail}`;
  }

  if (p.mode === "around") {
    const lat = asNumber(p.lat, "lat");
    const lon = asNumber(p.lon, "lon");
    const radius = clampInt(p.radiusMeters ?? 500, 1, 50000);

    const around = `(around:${radius},${lat},${lon})`;
    const types = normalizeTypes(p.types);
    const tags = normalizeTags(p.tags);
    const match = normalizeMatch(p.match);

    const union = buildUnion(types, tags, match, around);
    return `[out:${outFormat}][timeout:${timeout}];(${union};);${outTail}`;
  }

  throw new Error(`Unknown mode: ${p.mode}`);
}

/**
 * match=all => AND (chain filters)
 * match=any => OR (union branches)
 */
function buildUnion(types: OsmType[], tags: TagFilter[], match: MatchMode, areaSelector: string): string {
  if (!tags.length) return types.map((t) => `${t}${areaSelector}`).join(";");

  if (match === "all") {
    const andFilter = tags.map(tagToFilter).join("");
    return types.map((t) => `${t}${andFilter}${areaSelector}`).join(";");
  }

  // match === "any"
  const branches: string[] = [];
  for (const t of types) {
    for (const tag of tags) branches.push(`${t}${tagToFilter(tag)}${areaSelector}`);
  }
  return branches.join(";");
}

function tagToFilter(t: TagFilter): string {
  if (!t?.key) throw new Error("Tag filter requires 'key'");
  const key = escapeOverpassString(t.key);
  if (t.value === undefined || t.value === null || t.value === "") return `["${key}"]`;
  const val = escapeOverpassString(String(t.value));
  return `["${key}"="${val}"]`;
}

/* ------------------------- Normalizers ------------------------- */

function normalizeOutFormat(out: any): OutFormat {
  const v = String(out ?? "json").toLowerCase().trim();
  if (v === "json" || v === "xml" || v === "csv") return v;
  return "json";
}

function normalizeOutMode(mode: any): OutMode {
  const v = String(mode ?? "body").toLowerCase().trim();
  if (v === "body" || v === "tags" || v === "geom" || v === "center" || v === "skel") return v;
  return "body";
}

function normalizeMatch(match: any): MatchMode {
  const v = String(match ?? "any").toLowerCase().trim();
  return v === "all" ? "all" : "any";
}

function normalizeOsmType(t: any): OsmType {
  const v = String(t ?? "").toLowerCase().trim();
  if (v === "node" || v === "way" || v === "relation") return v;
  throw new Error(`Invalid osmType: ${t}`);
}

function normalizeTypes(types: any): OsmType[] {
  if (!Array.isArray(types) || types.length === 0) return ["node", "way", "relation"];
  return types.map(normalizeOsmType);
}

function normalizeTags(tags: any): TagFilter[] {
  if (!Array.isArray(tags) || tags.length === 0) return [];
  return tags.map((t) => {
    if (!t?.key) throw new Error("Tag filter requires 'key'");
    return { key: String(t.key), value: t.value === undefined ? undefined : String(t.value) };
  });
}

function normalizeBBox(bbox: any): string {
  if (!Array.isArray(bbox) || bbox.length !== 4) throw new Error("mode=bbox requires bbox [s,w,n,e]");
  const s = asNumber(bbox[0], "bbox[0]");
  const w = asNumber(bbox[1], "bbox[1]");
  const n = asNumber(bbox[2], "bbox[2]");
  const e = asNumber(bbox[3], "bbox[3]");
  return `(${s},${w},${n},${e})`;
}

function escapeOverpassString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/* ------------------------- Helpers / CORS ------------------------- */

function clampInt(x: number, min: number, max: number): number {
  const n = Math.floor(Number(x));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function asInt(x: any, name: string): number {
  const n = Number(x);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`Invalid ${name} (must be integer)`);
  return n;
}

function asNumber(x: any, name: string): number {
  const n = Number(x);
  if (!Number.isFinite(n)) throw new Error(`Invalid ${name} (must be number)`);
  return n;
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS,
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}
