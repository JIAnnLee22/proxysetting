import { beforeAll, afterAll, it, expect } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFileSync } from "node:fs";
import { adminRoutes } from "../src/worker/routes/admin";
import { agentRoutes } from "../src/worker/routes/agent";
import { calendar, hash, token } from "../src/worker/core";
import type { Env } from "../src/worker/types";
let mf: Miniflare, env: Env;
const id = "00000000-0000-4000-8000-000000000001",
  vps = "00000000-0000-4000-8000-000000000002";
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
    UUID_KEY: btoa("z".repeat(32)),
    RELEASE_REPO: "example/proxysetting",
    RELEASE_VERSION: "v0.1.0",
    INSTALL_SHA256: "f".repeat(64),
  } as Env;
});
afterAll(async () => {
  await mf?.dispose();
});
it("re-enrollment retains reported monthly budget and reset sequences but never exposes private key", async () => {
  const t = token(),
    old = token();
  await env.DB.prepare(
    "INSERT INTO vps(id,name,address,port,server_name,enrollment_hash,enrollment_expires,credential_hash) VALUES(?,?,?,?,?,?,?,?)",
  )
    .bind(
      vps,
      "vps",
      "203.0.113.1",
      443,
      "www.microsoft.com",
      await hash(t),
      Date.now() + 60000,
      await hash(old),
    )
    .run();
  const usage = {
    schema: 1,
    sequence: 20,
    revision: 1,
    ...calendar(),
    version: "v0.1.0",
    status: "ready",
    error: "",
    users: [{ id, uplink: 10, downlink: 20, disabled: true }],
  };
  await env.DB.prepare("INSERT INTO usage_periods VALUES(?,?,?,?)")
    .bind(vps, usage.month, JSON.stringify(usage), new Date().toISOString())
    .run();
  await env.DB.prepare("INSERT INTO snapshots VALUES(?,?,?,?,?,?)")
    .bind(
      vps,
      20,
      usage.month,
      usage.day,
      JSON.stringify(usage),
      new Date().toISOString(),
    )
    .run();
  const request = new Request("https://app.example/api/agent/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: t,
      address: "203.0.113.1",
      port: 443,
      serverName: "www.microsoft.com",
      publicKey: "A".repeat(43),
      shortId: "a".repeat(16),
      version: "v0.1.0",
    }),
  });
  const response = await agentRoutes(request, env);
  const data = (await response.json()) as any;
  expect(data.config.usage.users[0]).toMatchObject({
    uplink: 10,
    downlink: 20,
  });
  expect(
    (await env.DB.prepare("SELECT COUNT(*) c FROM snapshots").first<any>()).c,
  ).toBe(0);
  expect(
    (await env.DB.prepare("SELECT COUNT(*) c FROM usage_periods").first<any>())
      .c,
  ).toBe(1);
  expect(JSON.stringify(data)).not.toContain("private");
  await expect(
    agentRoutes(
      new Request("https://app.example/api/agent/config", {
        headers: { Authorization: `Bearer ${old}` },
      }),
      env,
    ),
  ).rejects.toThrow("rejected");
});
it("export refuses empty node sets and missing quotas/metadata", async () => {
  await env.DB.prepare("INSERT INTO identities VALUES(?,?,1)")
    .bind(id, "user")
    .run();
  await expect(
    adminRoutes(
      new Request("https://app.example/api/admin/export?identity=" + id),
      env,
    ),
  ).rejects.toThrow("not ready");
  await env.DB.prepare("UPDATE vps SET status='ready'").run();
  await expect(
    adminRoutes(
      new Request("https://app.example/api/admin/export?identity=" + id),
      env,
    ),
  ).rejects.toThrow("quota missing");
});
