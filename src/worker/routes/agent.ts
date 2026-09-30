import { deviceAuth } from "../auth";
import {
  address,
  assert,
  body,
  calendar,
  desired,
  hash,
  HttpError,
  integer,
  json,
  rateLimit,
  text,
  token,
} from "../core";
import type { Env, Snapshot, VPS } from "../types";
export function validateSnapshot(b: Record<string, unknown>): Snapshot {
  assert(b.schema === 1, "Unsupported schema");
  const sequence = integer(b.sequence, "sequence", 1);
  const revision = integer(b.revision, "revision", 1);
  const version = text(b.version, "version", 32);
  assert(/^v\d+\.\d+\.\d+$/.test(version), "Invalid version");
  const month = text(b.month, "month", 7),
    day = text(b.day, "day", 10);
  assert(
    /^\d{4}-(0[1-9]|1[0-2])$/.test(month) &&
      /^\d{4}-\d{2}-\d{2}$/.test(day) &&
      day.startsWith(month) &&
      Number.isFinite(Date.parse(`${day}T00:00:00Z`)) &&
      new Date(`${day}T00:00:00Z`).toISOString().startsWith(day),
    "Invalid calendar",
  );
  const current = calendar().month;
  const previous = calendar(
    new Date(
      Date.UTC(
        Number(current.slice(0, 4)),
        Number(current.slice(5, 7)) - 2,
        15,
      ),
    ),
  ).month;
  assert(
    (month >= previous && month <= current) ||
      month === calendar(new Date(Date.now() + 60000)).month,
    "Snapshot month outside tolerance",
  );
  assert(b.status === "ready" || b.status === "error", "Invalid status");
  assert(
    typeof b.error === "string" &&
      b.error.length <= 240 &&
      !/[\x00-\x1f]/.test(b.error),
    "Invalid error",
  );
  assert(Array.isArray(b.users) && b.users.length <= 50, "Invalid users");
  const seen = new Set();
  const users = b.users.map((u: unknown) => {
    assert(u && typeof u === "object", "Invalid user");
    const a = u as Record<string, unknown>;
    const id = text(a.id, "id", 36);
    assert(
      /^[a-f0-9-]{36}$/.test(id) && !seen.has(id),
      "Invalid/duplicate identity",
    );
    seen.add(id);
    const uplink = integer(a.uplink, "uplink"),
      downlink = integer(a.downlink, "downlink");
    assert(Number.isSafeInteger(uplink + downlink), "Counter overflow");
    assert(typeof a.disabled === "boolean", "Invalid disabled");
    return { id, uplink, downlink, disabled: a.disabled };
  });
  return {
    schema: 1,
    sequence,
    revision,
    version,
    month,
    day,
    status: b.status,
    error: b.error,
    users,
  };
}
export async function agentRoutes(
  request: Request,
  env: Env,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/api/agent/register" && request.method === "POST") {
    const b = await body(request);
    const t = text(b.token, "token", 43);
    assert(/^[A-Za-z0-9_-]{43}$/.test(t), "Invalid enrollment token");
    await rateLimit(
      env,
      `enroll:${request.headers.get("CF-Connecting-IP") || "local"}`,
      10,
      900,
    );
    const h = await hash(t);
    const v = await env.DB.prepare(
      "SELECT * FROM vps WHERE enrollment_hash=? AND enrollment_expires>? AND revoked=0",
    )
      .bind(h, Date.now())
      .first<VPS>();
    assert(v, "Enrollment expired or already used", 401);
    assert(
      address(b.address) === v.address &&
        integer(b.port, "port", 1, 65535) === v.port &&
        b.serverName === v.server_name,
      "Enrollment parameters mismatch",
      409,
    );
    const publicKey = text(b.publicKey, "publicKey", 43),
      shortId = text(b.shortId, "shortId", 16),
      version = text(b.version, "version", 32);
    assert(
      /^[A-Za-z0-9_-]{43}$/.test(publicKey) &&
        /^[a-f0-9]{16}$/.test(shortId) &&
        /^v\d+\.\d+\.\d+$/.test(version),
      "Invalid Reality/release data",
    );
    const credential = token();
    const credentialHash = await hash(credential);
    const result = await env.DB.batch([
      env.DB.prepare(
        "UPDATE vps SET credential_hash=?,enrollment_hash=NULL,enrollment_expires=NULL,public_key=?,short_id=?,version=?,status='registered',last_sync=NULL,error=NULL WHERE id=? AND enrollment_hash=? AND enrollment_expires>?",
      ).bind(credentialHash, publicKey, shortId, version, v.id, h, Date.now()),
      env.DB.prepare(
        "DELETE FROM snapshots WHERE vps_id=? AND EXISTS (SELECT 1 FROM vps WHERE id=? AND credential_hash=?)",
      ).bind(v.id, v.id, credentialHash),
    ]);
    assert(result[0].meta.changes === 1, "Enrollment already used", 401);
    const fresh = await env.DB.prepare("SELECT * FROM vps WHERE id=?")
      .bind(v.id)
      .first<VPS>();
    return json({
      vpsId: v.id,
      credential,
      config: await desired(env, fresh!),
    });
  }
  const v = await deviceAuth(request, env);
  if (path === "/api/agent/config" && request.method === "GET")
    return json(await desired(env, v));
  if (path === "/api/agent/rotate" && request.method === "POST") {
    const c = token();
    const r = await env.DB.prepare(
      "UPDATE vps SET credential_hash=? WHERE id=? AND credential_hash=? AND revoked=0",
    )
      .bind(await hash(c), v.id, v.credential_hash)
      .run();
    assert(r.meta.changes === 1, "Credential changed", 401);
    return json({ credential: c });
  }
  if (path === "/api/agent/snapshot" && request.method === "POST") {
    const s = validateSnapshot(await body(request));
    assert(s.revision <= v.revision, "Unknown revision", 409);
    const old = await env.DB.prepare(
      "SELECT sequence,month,payload FROM snapshots WHERE vps_id=?",
    )
      .bind(v.id)
      .first<{ sequence: number; month: string; payload: string }>();
    if (old && s.sequence <= old.sequence)
      return json({ accepted: true, duplicate: true });
    if (old) {
      assert(s.month >= old.month, "Month moved backwards", 409);
      if (s.month === old.month) {
        const before = JSON.parse(old.payload) as Snapshot;
        for (const u of s.users) {
          const last = before.users.find((x) => x.id === u.id);
          assert(
            !last || (u.uplink >= last.uplink && u.downlink >= last.downlink),
            "Usage moved backwards",
            409,
          );
        }
      }
    }
    const now = new Date().toISOString();
    const payload = JSON.stringify(s);
    const params = [v.id, s.sequence, s.month, s.day, payload, now];
    const status =
      s.status === "ready" &&
      s.revision === v.revision &&
      v.public_key &&
      v.short_id
        ? "ready"
        : s.status === "error"
          ? "error"
          : "syncing";
    // Every following write is conditioned on the winning sequence, so concurrent old requests cannot replace a newer snapshot.
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO snapshots(vps_id,sequence,month,day,payload,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(vps_id) DO UPDATE SET sequence=excluded.sequence,month=excluded.month,day=excluded.day,payload=excluded.payload,updated_at=excluded.updated_at WHERE excluded.sequence>sequence",
      ).bind(...params),
      ...[s.month, s.day].map((p) =>
        env.DB.prepare(
          "INSERT INTO usage_periods(vps_id,period,payload,updated_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM snapshots WHERE vps_id=? AND sequence=?) ON CONFLICT(vps_id,period) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at",
        ).bind(v.id, p, payload, now, v.id, s.sequence),
      ),
      env.DB.prepare(
        "UPDATE vps SET last_sync=?,status=CASE WHEN ?='ready' AND revision<>? THEN 'syncing' ELSE ? END,version=?,error=? WHERE id=? AND revoked=0 AND credential_hash=? AND EXISTS(SELECT 1 FROM snapshots WHERE vps_id=? AND sequence=?)",
      ).bind(
        now,
        status,
        s.revision,
        status,
        s.version,
        s.error || null,
        v.id,
        v.credential_hash,
        v.id,
        s.sequence,
      ),
    ]);
    return json({ accepted: true, duplicate: false });
  }
  throw new HttpError(404, "Not found");
}
