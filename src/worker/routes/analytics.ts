import { assert, HttpError, json } from "../core";
import { adminAuth } from "../auth";
import type { Env } from "../types";

export async function analyticsRoutes(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  
  if (url.pathname === "/api/admin/analytics" && request.method === "GET") {
    const type = url.searchParams.get("type");
    const start = url.searchParams.get("start");
    const end = url.searchParams.get("end");
    assert(type === "daily" || type === "month", "Invalid type", 400);
    assert(typeof start === "string" && typeof end === "string", "Missing start/end", 400);

    if (type === "daily") {
      assert(/^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end), "Invalid daily format", 400);
      assert(start <= end, "start > end", 400);
      const startMs = Date.parse(start + "T00:00:00Z");
      const endMs = Date.parse(end + "T00:00:00Z");
      assert((endMs - startMs) / 86400000 <= 7, "Range exceeds 7 days", 400);
      
      const rows = await env.DB.prepare(
        "SELECT vps_id, period, payload FROM usage_periods WHERE period >= ? AND period <= ? AND length(period) = 10"
      ).bind(start, end).all<{ vps_id: string; period: string; payload: string }>();
      
      const results = rows.results.map(r => {
        let p;
        try { p = JSON.parse(r.payload); } catch { return null; }
        return {
          vps_id: r.vps_id,
          period: r.period,
          daily: p.daily || null,
          users: p.users || [] // Fallback for old history diffs
        };
      }).filter(Boolean);
      return json(results);
    } else {
      assert(/^\d{4}-\d{2}$/.test(start) && /^\d{4}-\d{2}$/.test(end), "Invalid month format", 400);
      assert(start <= end, "start > end", 400);
      // Rough month difference check <= 6
      const startYear = parseInt(start.slice(0, 4), 10), startMo = parseInt(start.slice(5, 7), 10);
      const endYear = parseInt(end.slice(0, 4), 10), endMo = parseInt(end.slice(5, 7), 10);
      const diff = (endYear - startYear) * 12 + (endMo - startMo);
      assert(diff >= 0 && diff <= 6, "Range exceeds 6 months", 400);
      
      const rows = await env.DB.prepare(
        "SELECT vps_id, period, payload FROM usage_periods WHERE period >= ? AND period <= ? AND length(period) = 7"
      ).bind(start, end).all<{ vps_id: string; period: string; payload: string }>();
      
      const results = rows.results.map(r => {
        let p;
        try { p = JSON.parse(r.payload); } catch { return null; }
        return {
          vps_id: r.vps_id,
          period: r.period,
          users: p.month === r.period ? p.users : (p.users || [])
        };
      });
      return json(results);
    }
  }

  throw new HttpError(404, "Not found");
}
