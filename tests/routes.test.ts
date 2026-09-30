import { beforeAll, afterAll, it, expect } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFileSync } from "node:fs";
import worker from "../src/worker/index";
import { adminRoutes } from "../src/worker/routes/admin";
import { agentRoutes, validateSnapshot } from "../src/worker/routes/agent";
import { hash, token, calendar } from "../src/worker/core";
import type { Env } from "../src/worker/types";
let mf: Miniflare,
  env: Env,
  vpsId: string,
  identityId: string,
  credential: string;
function req(path: string, method = "GET", b?: unknown, auth = credential) {
  return new Request("https://app.example/api/" + path, {
    method,
    headers: {
      ...(b ? { "Content-Type": "application/json" } : {}),
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    body: b ? JSON.stringify(b) : undefined,
  });
}
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: ["DB"],
    }),
  );
  const DB = await mf.getD1Database("DB");
  await DB.exec(
    readFileSync("migrations/0001_init.sql", "utf8").replaceAll("\n", " "),
  );
  env = {
    DB,
    ADMIN_PASSWORD: "test-administrator-password",
    UUID_KEY: btoa("y".repeat(32)),
    RELEASE_REPO: "example/proxysetting",
    RELEASE_VERSION: "v0.1.0",
    INSTALL_SHA256: "f".repeat(64),
  } as Env;
});
afterAll(async () => {
  await mf?.dispose();
});
it("creates admin VPS/identity, quota is mandatory and idempotent", async () => {
  vpsId = (
    (await (
      await adminRoutes(
        req("admin/vps", "POST", {
          name: "server",
          address: "203.0.113.1",
          port: 443,
          serverName: "www.microsoft.com",
        }),
        env,
      )
    ).json()) as any
  ).id;
  identityId = (
    (await (
      await adminRoutes(req("admin/identities", "POST", { name: "phone" }), env)
    ).json()) as any
  ).id;
  await expect(
    adminRoutes(req(`admin/vps/${vpsId}/grants`, "PUT", { identityId }), env),
  ).rejects.toThrow("quota");
  await adminRoutes(
    req(`admin/vps/${vpsId}/grants`, "PUT", { identityId, quotaGiB: 10 }),
    env,
  );
  const first = await env.DB.prepare("SELECT revision FROM vps WHERE id=?")
    .bind(vpsId)
    .first<any>();
  await adminRoutes(
    req(`admin/vps/${vpsId}/grants`, "PUT", { identityId, quotaGiB: 10 }),
    env,
  );
  const second = await env.DB.prepare("SELECT revision FROM vps WHERE id=?")
    .bind(vpsId)
    .first<any>();
  expect(first.revision).toBe(second.revision);
  await adminRoutes(req(`admin/vps/${vpsId}/enroll`, "POST", {}), env);
  await adminRoutes(
    req(`admin/vps/${vpsId}`, "PATCH", {
      name: "server",
      address: "203.0.113.1",
      port: 24443,
      serverName: "www.microsoft.com",
    }),
    env,
  );
  const edited = await env.DB.prepare(
    "SELECT port,enrollment_hash FROM vps WHERE id=?",
  )
    .bind(vpsId)
    .first<any>();
  expect(edited.port).toBe(24443);
  expect(edited.enrollment_hash).toBeNull();
  await adminRoutes(
    req(`admin/vps/${vpsId}`, "PATCH", {
      name: "server",
      address: "203.0.113.1",
      port: 443,
      serverName: "www.microsoft.com",
    }),
    env,
  );
  await adminRoutes(
    req(`admin/vps/${vpsId}/grants`, "PUT", { identityId, quotaGiB: 0.1 }),
    env,
  );
  expect(
    (
      await env.DB.prepare("SELECT quota_bytes FROM grants WHERE vps_id=?")
        .bind(vpsId)
        .first<any>()
    ).quota_bytes,
  ).toBe(Math.ceil(0.1 * 1073741824));
  await adminRoutes(
    req(`admin/vps/${vpsId}/grants`, "PUT", { identityId, quotaGiB: 10 }),
    env,
  );
});
it("single-use enrollment rejects expired, replay, mismatched VPS", async () => {
  const command = (
    (await (
      await adminRoutes(req(`admin/vps/${vpsId}/enroll`, "POST", {}), env)
    ).json()) as any
  ).command;
  expect(command).toContain("sha256sum -c");
  const t = /PROXYSETTING_ENROLL_TOKEN='([^']+)'/.exec(command)![1];
  const b = {
    token: t,
    address: "203.0.113.1",
    port: 443,
    serverName: "www.microsoft.com",
    publicKey: "A".repeat(43),
    shortId: "a".repeat(16),
    version: "v0.1.0",
  };
  await expect(
    agentRoutes(
      req("agent/register", "POST", { ...b, address: "203.0.113.2" }),
      env,
    ),
  ).rejects.toThrow("mismatch");
  credential = (
    (await (
      await agentRoutes(req("agent/register", "POST", b), env)
    ).json()) as any
  ).credential;
  await expect(
    agentRoutes(req("agent/register", "POST", b), env),
  ).rejects.toThrow("expired");
  const c = await env.DB.prepare("SELECT credential_hash FROM vps WHERE id=?")
    .bind(vpsId)
    .first<any>();
  expect(c.credential_hash).toBe(await hash(credential));
  expect(c.credential_hash).not.toBe(credential);
  await expect(
    adminRoutes(
      req(`admin/vps/${vpsId}`, "PATCH", {
        name: "server",
        address: "203.0.113.1",
        port: 24443,
        serverName: "www.microsoft.com",
      }),
      env,
    ),
  ).rejects.toThrow("Only unregistered");
  const expired = token();
  await env.DB.prepare(
    "UPDATE vps SET enrollment_hash=?,enrollment_expires=? WHERE id=?",
  )
    .bind(await hash(expired), Date.now() - 1, vpsId)
    .run();
  await expect(
    agentRoutes(req("agent/register", "POST", { ...b, token: expired }), env),
  ).rejects.toThrow("expired");
});
it("serves only the authenticated device grants, stores no plaintext UUID", async () => {
  const response = await worker.fetch(req("agent/config"), {
    ...env,
    ADMIN_PASSWORD: "",
  });
  expect(response.status).toBe(200);
  expect(response.headers.has("WWW-Authenticate")).toBe(false);
  const d = (await (await agentRoutes(req("agent/config"), env)).json()) as any;
  expect(d.vpsId).toBe(vpsId);
  expect(d.users[0].quotaBytes).toBe(10 * 1073741824);
  const g = await env.DB.prepare("SELECT uuid_cipher FROM grants").first<any>();
  expect(g.uuid_cipher).not.toContain(d.users[0].uuid);
  await expect(
    agentRoutes(req("agent/config", "GET", undefined, token()), env),
  ).rejects.toThrow("rejected");
});
it("snapshots batch/duplicate/new revision and usage cannot move backwards", async () => {
  const config = (await (
    await agentRoutes(req("agent/config"), env)
  ).json()) as any;
  const s = {
    schema: 1,
    sequence: 1,
    ...calendar(),
    revision: config.revision,
    version: "v0.1.0",
    status: "ready",
    error: "",
    users: [{ id: identityId, uplink: 100, downlink: 50, disabled: false }],
  };
  await agentRoutes(req("agent/snapshot", "POST", s), env);
  const duplicate = (await (
    await agentRoutes(req("agent/snapshot", "POST", s), env)
  ).json()) as any;
  expect(duplicate.duplicate).toBe(true);
  expect(
    (await env.DB.prepare("SELECT COUNT(*) c FROM usage_periods").first<any>())
      .c,
  ).toBe(2);
  await expect(
    agentRoutes(
      req("agent/snapshot", "POST", {
        ...s,
        sequence: 2,
        users: [{ ...s.users[0], uplink: 0 }],
      }),
      env,
    ),
  ).rejects.toThrow("backwards");
  const output = await adminRoutes(
    req(`admin/export?identity=${identityId}`),
    env,
  );
  expect(await output.text()).toContain("reality-opts");
  await adminRoutes(
    req(`admin/vps/${vpsId}/grants`, "PUT", { identityId, quotaGiB: 11 }),
    env,
  );
  await expect(
    adminRoutes(req(`admin/export?identity=${identityId}`), env),
  ).rejects.toThrow("not ready");
});
it("rotation invalidates old credential and revocation rejects current device", async () => {
  const old = credential;
  credential = (
    (await (
      await agentRoutes(req("agent/rotate", "POST", {}), env)
    ).json()) as any
  ).credential;
  await expect(
    agentRoutes(req("agent/config", "GET", undefined, old), env),
  ).rejects.toThrow("rejected");
  await agentRoutes(req("agent/config"), env);
  await adminRoutes(req(`admin/vps/${vpsId}/revoke`, "POST", {}), env);
  await expect(agentRoutes(req("agent/config"), env)).rejects.toThrow(
    "rejected",
  );
});
it("serves the admin API and same-origin writes with only the administrator password", async () => {
  const headers = {
    Authorization: `Basic ${btoa(`admin:${env.ADMIN_PASSWORD}`)}`,
    Origin: "https://app.example",
    "Content-Type": "application/json",
  };
  const response = await worker.fetch(
    new Request("https://app.example/api/admin/state", { headers }),
    env,
  );
  expect(response.status).toBe(200);
  const state = (await response.json()) as any;
  expect(state.vps[0].id).toBe(vpsId);
  expect(response.headers.has("WWW-Authenticate")).toBe(false);
  const created = await worker.fetch(
    new Request("https://app.example/api/admin/identities", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "password-admin-test" }),
    }),
    env,
  );
  expect(created.status).toBe(201);
});
