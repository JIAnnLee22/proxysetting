import { assert } from "../core";
import { exportClash } from "../export-verge";
import type { Env, Grant, Snapshot } from "../types";

export async function subRoutes(request: Request, env: Env): Promise<Response> {
  assert(request.method === "GET" || request.method === "HEAD", "Method not allowed", 405);
  const url = new URL(request.url);
  let id = url.searchParams.get("token") || url.searchParams.get("identity");
  if (!id) {
    const m = /^\/api\/sub\/([a-f0-9-]{36})$/.exec(url.pathname);
    if (m) id = m[1];
  }
  assert(id && /^[a-f0-9-]{36}$/.test(id), "Valid subscription token or identity required", 400);

  const yaml = await exportClash(env, id);

  const headers = new Headers({
    "Content-Type": "text/yaml; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Disposition": 'attachment; filename="clash-verge.yaml"',
    "Profile-Update-Interval": "24",
  });

  // Calculate user quota info for Subscription-Userinfo header if available
  try {
    const grants = await env.DB.prepare(
      "SELECT quota_bytes FROM grants WHERE identity_id=?"
    ).bind(id).all<Grant>();
    
    if (grants.results.length > 0) {
      const totalBytes = grants.results.reduce((acc, g) => acc + (g.quota_bytes || 0), 0);
      
      const snapshots = await env.DB.prepare(
        "SELECT payload FROM snapshots"
      ).all<{ payload: string }>();

      let usedUp = 0;
      let usedDown = 0;
      for (const s of snapshots.results) {
        try {
          const p = JSON.parse(s.payload) as Snapshot;
          const u = p.users?.find((x) => x.id === id);
          if (u) {
            usedUp += u.uplink || 0;
            usedDown += u.downlink || 0;
          }
        } catch {
          // ignore parsing error
        }
      }

      headers.set(
        "Subscription-Userinfo",
        `upload=${usedUp}; download=${usedDown}; total=${totalBytes}`
      );
    }
  } catch {
    // Non-fatal if header calculation fails
  }

  return new Response(request.method === "HEAD" ? null : yaml, {
    status: 200,
    headers,
  });
}
