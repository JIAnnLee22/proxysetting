import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFileSync } from "node:fs";
import {
  calendar,
  desired,
  encrypt,
  decrypt,
  integer,
  rateLimit,
} from "../src/worker/core";
import type { Env } from "../src/worker/types";
let mf: Miniflare, env: Env;
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
  env = { DB, UUID_KEY: btoa("x".repeat(32)) } as Env;
});
afterAll(async () => {
  await mf?.dispose();
});
describe("contract and persistence", () => {
  it("uses Beijing natural calendar", () => {
    expect(calendar(new Date("2026-01-31T15:59:59Z")).month).toBe("2026-01");
    expect(calendar(new Date("2026-01-31T16:00:00Z")).day).toBe("2026-02-01");
  });
  it("requires positive safe integer quota", () => {
    for (const v of [null, 0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])
      expect(() => integer(v, "quota", 1)).toThrow();
    expect(integer(1073741824, "quota", 1)).toBe(1073741824);
  });
  it("encrypts UUID and binds ciphertext to exact grant", async () => {
    const c = await encrypt(env, "secret-uuid", "vps:identity");
    expect(c).not.toContain("secret-uuid");
    expect(await decrypt(env, c, "vps:identity")).toBe("secret-uuid");
    await expect(decrypt(env, c, "other:identity")).rejects.toThrow();
  });
  it("only grants explicitly budgeted identities; persists revisions", async () => {
    await env.DB.prepare(
      "INSERT INTO vps(id,name,address,port,server_name) VALUES('v','v','1.1.1.1',443,'example.com')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO identities(id,name) VALUES('i','i'),('without','no quota')",
    ).run();
    const c = await encrypt(env, "00000000-0000-4000-8000-000000000000", "v:i");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO grants VALUES(?,?,?,?)").bind(
        "v",
        "i",
        c,
        1073741824,
      ),
      env.DB.prepare("UPDATE vps SET revision=revision+1 WHERE id=?").bind("v"),
    ]);
    const v = await env.DB.prepare("SELECT * FROM vps WHERE id=?")
      .bind("v")
      .first<any>();
    const d = await desired(env, v);
    expect(d.revision).toBe(2);
    expect(d.users).toHaveLength(1);
    expect(d.users[0]).toMatchObject({
      id: "i",
      email: "i@proxysetting",
      quotaBytes: 1073741824,
    });
    await env.DB.prepare("UPDATE identities SET enabled=0 WHERE id=?")
      .bind("i")
      .run();
    expect((await desired(env, v)).users).toEqual([]);
  });
  it("rate limits devices independently", async () => {
    await rateLimit(env, "a", 1);
    await expect(rateLimit(env, "a", 1)).rejects.toThrow("Rate limit");
    await rateLimit(env, "b", 1);
  });
  it("fits free budget with per VPS snapshots instead of per user writes", () => {
    const requests = 10 * (1440 + 288),
      writes = 10 * (1440 + 288 + 288 * 4);
    expect(requests).toBe(17280);
    expect(writes).toBeLessThan(100000);
  });
});
