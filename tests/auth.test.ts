import { it, expect, beforeAll } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { adminAuth, verifyAccess, mutationGuard } from "../src/worker/auth";
import worker from "../src/worker/index";
import type { Env } from "../src/worker/types";
let keys: Awaited<ReturnType<typeof generateKeyPair>>,
  resolver: ReturnType<typeof createLocalJWKSet>;
const env = {
  ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
  ACCESS_AUD: "admin-aud",
  ADMIN_EMAILS: "admin@example.com",
} as Env;
beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  resolver = createLocalJWKSet({
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "test" }],
  });
});
async function jwt(
  email = "admin@example.com",
  aud = "admin-aud",
  exp = "1h",
  issuer = "https://team.cloudflareaccess.com",
) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(issuer)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(keys.privateKey);
}
it("validates cryptographic Access identity and explicit administrator", async () => {
  expect(await verifyAccess(await jwt(), env, resolver)).toBe(
    "admin@example.com",
  );
  for (const args of [
    ["other@example.com"],
    ["admin@example.com", "other"],
    ["admin@example.com", "admin-aud", "-1h"],
    ["admin@example.com", "admin-aud", "1h", "https://evil.example"],
  ])
    await expect(
      verifyAccess(await jwt(...args), env, resolver),
    ).rejects.toThrow();
  await expect(
    verifyAccess((await jwt()).slice(0, -4) + "xxxx", env, resolver),
  ).rejects.toThrow();
});
it("denies unprotected asset and admin API access", async () => {
  for (const path of ["/", "/app.js", "/api/admin/state"]) {
    const r = await worker.fetch(
      new Request("https://app.example" + path),
      env,
    );
    expect(r.status).toBe(401);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
  }
});
it("rejects cross-origin and non-JSON authenticated mutations", () => {
  for (const headers of [
    { Origin: "https://evil.example", "Content-Type": "application/json" },
    { Origin: "https://app.example", "Content-Type": "text/plain" },
    { "Content-Type": "application/json" },
  ])
    expect(() =>
      mutationGuard(
        new Request("https://app.example/api/admin/vps", {
          method: "POST",
          headers: headers as Record<string, string>,
          body: "{}",
        }),
      ),
    ).toThrow();
  expect(() =>
    mutationGuard(
      new Request("https://app.example/api/admin/vps", {
        method: "POST",
        headers: {
          Origin: "https://app.example",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    ),
  ).not.toThrow();
});
it("requires Access header even for cross-origin writes", async () => {
  await expect(
    adminAuth(
      new Request("https://app.example/api/admin/vps", {
        method: "POST",
        headers: {
          Origin: "https://evil.example",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      env,
    ),
  ).rejects.toThrow("Access login required");
});
