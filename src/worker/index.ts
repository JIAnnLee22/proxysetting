import { adminAuth } from "./auth";
import { HttpError, json } from "./core";
import { adminRoutes } from "./routes/admin";
import { agentRoutes } from "./routes/agent";
import { analyticsRoutes } from "./routes/analytics";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response;
    try {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/api/agent/"))
        response = await agentRoutes(request, env);
      else {
        await adminAuth(request, env);
        if (path === "/api/admin/analytics")
          response = await analyticsRoutes(request, env);
        else if (path.startsWith("/api/admin/"))
          response = await adminRoutes(request, env);
        else if (request.method === "GET" || request.method === "HEAD")
          response = await env.ASSETS.fetch(request);
        else response = json({ error: "Not found" }, 404);
      }
    } catch (e) {
      response = json(
        {
          error:
            e instanceof HttpError
              ? e.message
              : "Internal error; check deployment and secrets",
        },
        e instanceof HttpError ? e.status : 500,
      );
      if (
        response.status === 401 &&
        !new URL(request.url).pathname.startsWith("/api/agent/")
      )
        response.headers.set(
          "WWW-Authenticate",
          'Basic realm="Proxysetting", charset="UTF-8"',
        );
    }
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    return new Response(response.body, { status: response.status, headers });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const today = new Date(Date.now() + 8 * 3600 * 1000);
    const dayThreshold = new Date(today.getTime() - 400 * 86400000).toISOString().slice(0, 10);
    
    // For 60 months, approximate by subtracting 5 years
    const monthThresholdDate = new Date(today.getTime());
    monthThresholdDate.setFullYear(monthThresholdDate.getFullYear() - 5);
    const monthThreshold = monthThresholdDate.toISOString().slice(0, 7);
    
    // Rate limit keys cleanup
    const oldKeys = Date.now() - 24 * 3600 * 1000;
    
    // We only clean up a bounded number of rows to respect limits (e.g. 20 of each type).
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM usage_periods WHERE period < ? AND length(period) = 10 LIMIT 20"
      ).bind(dayThreshold),
      env.DB.prepare(
        "DELETE FROM usage_periods WHERE period < ? AND length(period) = 7 LIMIT 20"
      ).bind(monthThreshold),
      env.DB.prepare(
        "DELETE FROM rate_limit WHERE updated_at < ? LIMIT 20"
      ).bind(oldKeys)
    ]);
  }
};
