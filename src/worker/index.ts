import { adminAuth } from "./auth";
import { HttpError, json } from "./core";
import { adminRoutes } from "./routes/admin";
import { agentRoutes } from "./routes/agent";
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
        if (path.startsWith("/api/admin/"))
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
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    return new Response(response.body, { status: response.status, headers });
  },
};
