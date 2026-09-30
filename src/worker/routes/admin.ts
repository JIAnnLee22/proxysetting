import {
  address,
  assert,
  body,
  calendar,
  encrypt,
  hostname,
  HttpError,
  integer,
  json,
  text,
  token,
  hash,
} from "../core";
import { exportVerge } from "../export-verge";
import type { Env, Grant, Identity, VPS } from "../types";
function release(env: Env, version = env.RELEASE_VERSION) {
  assert(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.RELEASE_REPO) &&
      !env.RELEASE_REPO.startsWith("REPLACE"),
    "Release repository not configured",
    503,
  );
  assert(/^v\d+\.\d+\.\d+$/.test(version), "Invalid release version");
  return `https://github.com/${env.RELEASE_REPO}/releases/download/${version}`;
}
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
export async function adminRoutes(
  request: Request,
  env: Env,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const m =
    /^\/api\/admin\/vps\/([a-f0-9-]{36})\/(enroll|revoke|upgrade|grants)$/.exec(
      path,
    );
  if (path === "/api/admin/state" && request.method === "GET") {
    const [vps, identities, grants, snapshots] = await Promise.all([
      env.DB.prepare(
        "SELECT id,name,address,port,server_name,revision,public_key,short_id,status,version,last_sync,error,revoked FROM vps ORDER BY created_at",
      ).all(),
      env.DB.prepare("SELECT * FROM identities ORDER BY name").all(),
      env.DB.prepare("SELECT vps_id,identity_id,quota_bytes FROM grants").all(),
      env.DB.prepare("SELECT vps_id,payload,updated_at FROM snapshots").all(),
    ]);
    return json({
      vps: vps.results,
      identities: identities.results,
      grants: grants.results,
      snapshots: snapshots.results.map((s) => ({
        ...s,
        payload: JSON.parse(s.payload as string),
      })),
      calendar: calendar(),
    });
  }
  if (path === "/api/admin/vps" && request.method === "POST") {
    const b = await body(request);
    const id = crypto.randomUUID();
    assert(
      b.port !== 10085,
      "Reality port must differ from local API port 10085",
    );
    const r = await env.DB.prepare(
      "INSERT INTO vps(id,name,address,port,server_name) SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM vps)<10",
    )
      .bind(
        id,
        text(b.name, "name"),
        address(b.address),
        integer(b.port, "port", 1, 65535),
        hostname(b.serverName),
      )
      .run();
    assert(r.meta.changes === 1, "VPS limit reached", 409);
    return json({ id }, 201);
  }
  const vm = /^\/api\/admin\/vps\/([a-f0-9-]{36})$/.exec(path);
  if (vm && request.method === "PATCH") {
    const b = await body(request);
    assert(
      b.port !== 10085,
      "Reality port must differ from local API port 10085",
    );
    const result = await env.DB.prepare(
      "UPDATE vps SET name=?,address=?,port=?,server_name=?,revision=revision+1,enrollment_hash=NULL,enrollment_expires=NULL,error=NULL WHERE id=? AND status='pending' AND credential_hash IS NULL AND public_key IS NULL",
    )
      .bind(
        text(b.name, "name"),
        address(b.address),
        integer(b.port, "port", 1, 65535),
        hostname(b.serverName),
        vm[1],
      )
      .run();
    assert(
      result.meta.changes === 1,
      "Only unregistered VPS parameters can be edited; registered devices require explicit reinstall",
      409,
    );
    return json({ ok: true });
  }
  if (path === "/api/admin/identities" && request.method === "POST") {
    const b = await body(request);
    const id = crypto.randomUUID();
    const r = await env.DB.prepare(
      "INSERT INTO identities(id,name) SELECT ?,? WHERE (SELECT COUNT(*) FROM identities)<50",
    )
      .bind(id, text(b.name, "name"))
      .run();
    assert(r.meta.changes === 1, "Identity limit reached", 409);
    return json({ id }, 201);
  }
  const im = /^\/api\/admin\/identities\/([a-f0-9-]{36})$/.exec(path);
  if (im && request.method === "PATCH") {
    const b = await body(request);
    assert(typeof b.enabled === "boolean", "enabled required");
    const exists = await env.DB.prepare("SELECT id FROM identities WHERE id=?")
      .bind(im[1])
      .first();
    assert(exists, "Identity not found", 404);
    await env.DB.batch([
      env.DB.prepare("UPDATE identities SET name=?,enabled=? WHERE id=?").bind(
        text(b.name, "name"),
        b.enabled ? 1 : 0,
        im[1],
      ),
      env.DB.prepare(
        "UPDATE vps SET revision=revision+1,status=CASE WHEN status='ready' THEN 'syncing' ELSE status END WHERE id IN (SELECT vps_id FROM grants WHERE identity_id=?)",
      ).bind(im[1]),
    ]);
    return json({ ok: true });
  }
  if (path === "/api/admin/usage" && request.method === "GET") {
    const period =
      new URL(request.url).searchParams.get("period") || calendar().month;
    assert(/^\d{4}-\d{2}(-\d{2})?$/.test(period), "Invalid period");
    const r = await env.DB.prepare(
      "SELECT vps_id,period,payload,updated_at FROM usage_periods WHERE period=?",
    )
      .bind(period)
      .all<{
        vps_id: string;
        period: string;
        payload: string;
        updated_at: string;
      }>();
    return json(
      r.results.map((x) => ({ ...x, payload: JSON.parse(x.payload) })),
    );
  }
  if (path === "/api/admin/export" && request.method === "GET") {
    const id = new URL(request.url).searchParams.get("identity");
    assert(id, "identity required");
    const script = await exportVerge(env, id);
    return new Response(script, {
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Disposition": 'attachment; filename="proxysetting-verge.js"',
      },
    });
  }
  if (m) {
    const v = await env.DB.prepare("SELECT * FROM vps WHERE id=?")
      .bind(m[1])
      .first<VPS>();
    assert(v, "VPS not found", 404);
    if (m[2] === "enroll" && request.method === "POST") {
      const base = release(env);
      assert(
        /^[a-f0-9]{64}$/.test(env.INSTALL_SHA256 || ""),
        "Set pinned INSTALL_SHA256 secret/var before enrollment",
        503,
      );
      const t = token();
      await env.DB.prepare(
        "UPDATE vps SET enrollment_hash=?,enrollment_expires=?,credential_hash=NULL,revoked=0,status='pending',revision=revision+1 WHERE id=?",
      )
        .bind(await hash(t), Date.now() + 15 * 60000, v.id)
        .run();
      const url = new URL(request.url).origin;
      const command = `(set -eu; f=$(mktemp); trap 'rm -f "$f"' EXIT; curl --fail --silent --show-error --location --proto '=https' ${quote(`${base}/install.sh`)} -o "$f"; printf '%s  %s\\n' ${quote(env.INSTALL_SHA256)} "$f" | sha256sum -c -; PROXYSETTING_ENROLL_TOKEN=${quote(t)} bash "$f" --repo ${quote(env.RELEASE_REPO)} --version ${quote(env.RELEASE_VERSION)} --control-url ${quote(url)} --address ${quote(v.address)} --port ${v.port} --server-name ${quote(v.server_name)})`;
      return json({
        command,
        expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
      });
    }
    if (m[2] === "revoke" && request.method === "POST") {
      await env.DB.prepare(
        "UPDATE vps SET revoked=1,credential_hash=NULL,enrollment_hash=NULL,enrollment_expires=NULL,status='revoked',revision=revision+1 WHERE id=?",
      )
        .bind(v.id)
        .run();
      return json({ ok: true });
    }
    if (m[2] === "grants" && ["PUT", "DELETE"].includes(request.method)) {
      const b = await body(request);
      const identityId = text(b.identityId, "identityId", 36);
      assert(
        await env.DB.prepare("SELECT id FROM identities WHERE id=?")
          .bind(identityId)
          .first(),
        "Identity not found",
        404,
      );
      const existing = await env.DB.prepare(
        "SELECT * FROM grants WHERE vps_id=? AND identity_id=?",
      )
        .bind(v.id, identityId)
        .first<Grant>();
      let operation: D1PreparedStatement;
      if (request.method === "DELETE") {
        assert(existing, "Grant not found", 404);
        operation = env.DB.prepare(
          "DELETE FROM grants WHERE vps_id=? AND identity_id=?",
        ).bind(v.id, identityId);
      } else {
        assert(
          typeof b.quotaGiB === "number" && b.quotaGiB > 0,
          "Monthly GiB quota required",
        );
        const bytes = integer(
          Math.ceil(b.quotaGiB * 1073741824),
          "quotaBytes",
          1,
          109951162777600,
        );
        if (existing && existing.quota_bytes === bytes)
          return json({ ok: true, unchanged: true });
        const cipher =
          existing?.uuid_cipher ||
          (await encrypt(env, crypto.randomUUID(), `${v.id}:${identityId}`));
        operation = env.DB.prepare(
          "INSERT INTO grants(vps_id,identity_id,uuid_cipher,quota_bytes) VALUES(?,?,?,?) ON CONFLICT(vps_id,identity_id) DO UPDATE SET quota_bytes=excluded.quota_bytes",
        ).bind(v.id, identityId, cipher, bytes);
      }
      await env.DB.batch([
        operation,
        env.DB.prepare(
          "UPDATE vps SET revision=revision+1,status=CASE WHEN status='ready' THEN 'syncing' ELSE status END WHERE id=?",
        ).bind(v.id),
      ]);
      return json({ ok: true });
    }
    if (m[2] === "upgrade" && request.method === "POST") {
      assert(!v.revoked && v.credential_hash, "Device not enrolled", 409);
      const b = await body(request),
        version = text(b.version, "version", 32),
        base = release(env, version);
      const r = await fetch(`${base}/SHA256SUMS`, { redirect: "follow" });
      assert(r.ok, "Release checksum manifest unavailable", 502);
      const sums = await r.text();
      assert(sums.length <= 16384, "Invalid checksum manifest", 502);
      const match = /^([a-f0-9]{64})\s+\*?install\.sh$/m.exec(sums);
      assert(match, "Release missing installer SHA256", 502);
      const upgrade = { version, url: `${base}/install.sh`, sha256: match[1] };
      await env.DB.prepare(
        "UPDATE vps SET upgrade_json=?,revision=revision+1,status='syncing' WHERE id=?",
      )
        .bind(JSON.stringify(upgrade), v.id)
        .run();
      return json({ ok: true, upgrade });
    }
  }
  throw new HttpError(404, "Not found");
}
