import { it, expect, vi } from "vitest";
import { adminAuth, mutationGuard } from "../src/worker/auth";
import worker from "../src/worker/index";
import type { Env } from "../src/worker/types";
const password = "test-administrator-password";
const env = { ADMIN_PASSWORD: password } as Env;
function basic(credentials = `admin:${password}`) {
  return `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
}
it("accepts the administrator password without any Access configuration", async () => {
  await expect(
    adminAuth(
      new Request("https://app.example/", {
        headers: { Authorization: basic() },
      }),
      env,
    ),
  ).resolves.toBeUndefined();
  const unicodePassword = "密码:abcdefghijklmnop";
  await expect(
    adminAuth(
      new Request("https://app.example/", {
        headers: { Authorization: basic(`admin:${unicodePassword}`) },
      }),
      { ADMIN_PASSWORD: unicodePassword } as Env,
    ),
  ).resolves.toBeUndefined();
});
it("rejects HTTP management requests without inviting plaintext login", async () => {
  const response = await worker.fetch(new Request("http://app.example/"), env);
  expect(response.status).toBe(403);
  expect(response.headers.has("WWW-Authenticate")).toBe(false);
  expect(await response.json()).toEqual({ error: "HTTPS required" });
});
it("rejects wrong usernames, passwords, malformed and non-Basic credentials", async () => {
  for (const authorization of [
    basic("admin:wrong-password"),
    basic(`other:${password}`),
    basic(password),
    "Basic !!!!",
    "Basic A",
    "Basic /w==",
    "Basic " + "A".repeat(2048),
    "Bearer " + password,
  ]) {
    await expect(
      adminAuth(
        new Request("https://app.example/", {
          headers: { Authorization: authorization },
        }),
        env,
      ),
    ).rejects.toMatchObject({ status: 401 });
  }
});
it("fails closed when the administrator password is missing or invalid", async () => {
  for (const ADMIN_PASSWORD of [
    undefined,
    "",
    "short",
    "x".repeat(257),
    password + "\n",
  ]) {
    const response = await worker.fetch(
      new Request("https://app.example/", {
        headers: { Authorization: basic() },
      }),
      { ADMIN_PASSWORD } as Env,
    );
    expect(response.status).toBe(503);
    expect(response.headers.has("WWW-Authenticate")).toBe(false);
  }
});
it("allows public access to assets without authentication challenge", async () => {
  const fetch = vi.fn(async () => new Response("asset"));
  for (const path of ["/", "/index.html", "/style.css"]) {
    const response = await worker.fetch(
      new Request("https://app.example" + path, {
        headers: { "Cf-Access-Jwt-Assertion": "old-access-token" },
      }),
      { ...env, ASSETS: { fetch } } as unknown as Env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.has("WWW-Authenticate")).toBe(false);
  }
});
it("protects sensitive admin operations with a browser Basic login challenge", async () => {
  for (const [path, method, body] of [
    ["/api/admin/vps", "POST", '{"name":"test","address":"1.2.3.4","port":443,"serverName":"example.com"}'],
    ["/api/admin/identities", "POST", '{"name":"alice"}'],
    ["/api/admin/usage", "GET", undefined],
    ["/api/admin/login", "POST", "{}"],
  ] as const) {
    const response = await worker.fetch(
      new Request("https://app.example" + path, {
        method,
        headers: {
          Origin: "https://app.example",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body,
      }),
      env,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(
      'Basic realm="Proxysetting", charset="UTF-8"',
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
  }
});
it("serves authenticated assets for GET and HEAD", async () => {
  const fetch = vi.fn(async () => new Response("asset"));
  for (const method of ["GET", "HEAD"]) {
    const response = await worker.fetch(
      new Request("https://app.example/app.js", {
        method,
        headers: { Authorization: basic() },
      }),
      { ...env, ASSETS: { fetch } } as unknown as Env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.has("WWW-Authenticate")).toBe(false);
  }
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("keeps device authentication independent from the administrator password", async () => {
  for (const authorization of [undefined, basic()]) {
    const response = await worker.fetch(
      new Request("https://app.example/api/agent/config", {
        headers: authorization ? { Authorization: authorization } : {},
      }),
      {} as Env,
    );
    expect(response.status).toBe(401);
    expect(response.headers.has("WWW-Authenticate")).toBe(false);
    expect(await response.json()).toEqual({
      error: "Device credential required",
    });
  }
});
it("rejects cross-origin and non-JSON mutations", () => {
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
it("checks same-origin JSON even after valid password authentication", async () => {
  const response = await worker.fetch(
    new Request("https://app.example/api/admin/vps", {
      method: "POST",
      headers: {
        Authorization: basic(),
        Origin: "https://evil.example",
        "Content-Type": "application/json",
      },
      body: "{}",
    }),
    env,
  );
  expect(response.status).toBe(403);
  expect(response.headers.has("WWW-Authenticate")).toBe(false);
  await expect(
    adminAuth(
      new Request("https://app.example/api/admin/vps", {
        method: "POST",
        headers: {
          Authorization: basic(),
          Origin: "https://app.example",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      env,
    ),
  ).resolves.toBeUndefined();
});
it("allows public state inspection while differentiating administrator status", async () => {
  const DB = {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({ all: vi.fn(async () => ({ results: [] })) })),
      all: vi.fn(async () => ({ results: [] })),
    })),
  };
  const mockEnv = { ...env, DB } as unknown as Env;

  // Guest request without Authorization
  const guestRes = await worker.fetch(
    new Request("https://app.example/api/admin/state"),
    mockEnv,
  );
  expect(guestRes.status).toBe(200);
  const guestData = (await guestRes.json()) as any;
  expect(guestData.isAdmin).toBe(false);

  // Admin request with Authorization
  const adminRes = await worker.fetch(
    new Request("https://app.example/api/admin/state", {
      headers: { Authorization: basic() },
    }),
    mockEnv,
  );
  expect(adminRes.status).toBe(200);
  const adminData = (await adminRes.json()) as any;
  expect(adminData.isAdmin).toBe(true);
});
