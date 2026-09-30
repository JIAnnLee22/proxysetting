import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { assert, hash, HttpError, rateLimit } from "./core";
import type { Env, VPS } from "./types";
const resolvers = new Map<string, JWTVerifyGetKey>();
export async function verifyAccess(
  token: string,
  env: Env,
  resolver?: JWTVerifyGetKey,
) {
  assert(
    /^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN) &&
      env.ACCESS_AUD &&
      !env.ACCESS_AUD.startsWith("REPLACE"),
    "Access not configured",
    503,
  );
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  if (!resolver) {
    resolver = resolvers.get(issuer);
    if (!resolver) {
      resolver = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
      resolvers.set(issuer, resolver);
    }
  }
  try {
    const { payload } = await jwtVerify(token, resolver, {
      issuer,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "email"],
    });
    const email =
      typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    assert(
      env.ADMIN_EMAILS.split(",")
        .map((x) => x.trim().toLowerCase())
        .includes(email),
      "Administrator not permitted",
      403,
    );
    return email;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(401, "Invalid Access identity");
  }
}
export function mutationGuard(request: Request) {
  if (!["GET", "HEAD"].includes(request.method)) {
    const origin = request.headers.get("Origin");
    assert(
      origin === new URL(request.url).origin,
      "Same-origin request required",
      403,
    );
    assert(
      request.headers.get("Content-Type")?.startsWith("application/json"),
      "JSON Content-Type required",
      415,
    );
  }
}
export async function adminAuth(request: Request, env: Env) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  assert(token, "Access login required", 401);
  await verifyAccess(token, env);
  mutationGuard(request);
}
export async function deviceAuth(request: Request, env: Env) {
  const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
    request.headers.get("Authorization") || "",
  );
  assert(m, "Device credential required", 401);
  const vps = await env.DB.prepare(
    "SELECT * FROM vps WHERE credential_hash=? AND revoked=0",
  )
    .bind(await hash(m[1]))
    .first<VPS>();
  assert(vps, "Device credential rejected", 401);
  await rateLimit(env, `device:${vps.id}`, 30);
  return vps;
}
