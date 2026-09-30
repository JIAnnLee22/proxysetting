import { assert, hash, HttpError, rateLimit } from "./core";
import type { Env, VPS } from "./types";
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
  assert(new URL(request.url).protocol === "https:", "HTTPS required", 403);
  assert(
    typeof env.ADMIN_PASSWORD === "string" &&
      env.ADMIN_PASSWORD.length >= 16 &&
      env.ADMIN_PASSWORD.length <= 256 &&
      !/[\x00-\x1f\x7f]/.test(env.ADMIN_PASSWORD),
    "ADMIN_PASSWORD secret must contain 16–256 characters without control characters",
    503,
  );
  const authorization = request.headers.get("Authorization") || "";
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
  assert(
    match && authorization.length <= 2048,
    "Administrator login required",
    401,
  );
  let credentials: string;
  try {
    credentials = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(match[1]), (c) => c.charCodeAt(0)),
    );
  } catch {
    throw new HttpError(401, "Invalid administrator credentials");
  }
  // Compare fixed-length hashes without early exits, including the username.
  const [actual, expected] = await Promise.all([
    hash(credentials),
    hash(`admin:${env.ADMIN_PASSWORD}`),
  ]);
  let difference = 0;
  for (let i = 0; i < expected.length; i++)
    difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  assert(difference === 0, "Invalid administrator credentials", 401);
  mutationGuard(request);
}
export async function checkAdminStatus(request: Request, env: Env): Promise<boolean> {
  const authorization = request.headers.get("Authorization");
  if (!authorization) return false;
  await adminAuth(request, env);
  return true;
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
