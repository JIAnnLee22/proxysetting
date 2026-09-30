import type { DesiredConfig, Env, Grant, VPS } from "./types";
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function assert(
  value: unknown,
  message: string,
  status = 400,
): asserts value {
  if (!value) throw new HttpError(status, message);
}
export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
export async function body(request: Request): Promise<Record<string, unknown>> {
  assert(
    Number(request.headers.get("Content-Length") || 0) <= 65536,
    "Body too large",
    413,
  );
  const reader = request.body?.getReader();
  assert(reader, "JSON body required");
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65536) {
      await reader.cancel();
      throw new HttpError(413, "Body too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  let b;
  try {
    b = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
  assert(
    b && typeof b === "object" && !Array.isArray(b),
    "JSON object required",
  );
  return b;
}
export function text(v: unknown, field: string, max = 100) {
  assert(
    typeof v === "string" &&
      v.length > 0 &&
      v.length <= max &&
      !/[\x00-\x1f]/.test(v),
    `Invalid ${field}`,
  );
  return v;
}
export function integer(
  v: unknown,
  field: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
) {
  assert(
    typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max,
    `Invalid ${field}`,
  );
  return v;
}
export function hostname(v: unknown) {
  const s = text(v, "serverName", 253);
  assert(
    /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/.test(
      s,
    ),
    "Invalid DNS name",
  );
  return s.toLowerCase();
}
export function address(v: unknown) {
  const s = text(v, "address", 45);
  const parts = s.split(".");
  let valid = false;
  if (
    parts.length === 4 &&
    parts.every((p) => /^(0|[1-9][0-9]{0,2})$/.test(p) && Number(p) <= 255)
  ) {
    const n = parts.map(Number);
    valid =
      n[0] > 0 &&
      n[0] < 224 &&
      n[0] !== 10 &&
      n[0] !== 127 &&
      !(n[0] === 169 && n[1] === 254) &&
      !(n[0] === 172 && n[1] >= 16 && n[1] <= 31) &&
      !(n[0] === 192 && n[1] === 168);
  } else if (s.includes(":")) {
    try {
      const n = new URL(`http://[${s}]`).hostname.slice(1, -1).toLowerCase();
      valid = !/^(:|0:|f[cd]|fe[89ab]|ff)/.test(n) && !n.startsWith("::ffff:");
    } catch {
      valid = false;
    }
  }
  assert(valid, "Public literal IPv4/IPv6 required (no private/loopback IP)");
  return s;
}
export function calendar(now = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => p.find((x) => x.type === t)!.value;
  const month = `${get("year")}-${get("month")}`;
  return { month, day: `${month}-${get("day")}` };
}
export function token() {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}
function b64(a: Uint8Array) {
  return btoa(String.fromCharCode(...a))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function bytes(s: string) {
  try {
    return Uint8Array.from(
      atob(s.replaceAll("-", "+").replaceAll("_", "/")),
      (c) => c.charCodeAt(0),
    );
  } catch {
    throw new HttpError(500, "Invalid encryption key");
  }
}
export async function hash(s: string) {
  return b64(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
  );
}
async function key(env: Env) {
  assert(env.UUID_KEY, "UUID_KEY secret not configured", 503);
  const raw = bytes(env.UUID_KEY);
  assert(raw.length === 32, "UUID_KEY must be 32 bytes", 503);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function encrypt(env: Env, value: string, aad: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
    await key(env),
    new TextEncoder().encode(value),
  );
  return `${b64(iv)}.${b64(new Uint8Array(data))}`;
}
export async function decrypt(env: Env, value: string, aad: string) {
  const [iv, data] = value.split(".");
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes(iv),
        additionalData: new TextEncoder().encode(aad),
      },
      await key(env),
      bytes(data),
    ),
  );
}
export async function desired(env: Env, vps: VPS): Promise<DesiredConfig> {
  const recorded = await env.DB.prepare(
    "SELECT payload FROM usage_periods WHERE vps_id=? AND period=?",
  )
    .bind(vps.id, calendar().month)
    .first<{ payload: string }>();
  const usage = recorded ? JSON.parse(recorded.payload) : null;
  const grants = await env.DB.prepare(
    "SELECT g.* FROM grants g JOIN identities i ON i.id=g.identity_id WHERE g.vps_id=? AND i.enabled=1 ORDER BY g.identity_id",
  )
    .bind(vps.id)
    .all<Grant>();
  return {
    schema: 1,
    vpsId: vps.id,
    revision: vps.revision,
    port: vps.port,
    serverName: vps.server_name,
    users: await Promise.all(
      grants.results.map(async (g) => ({
        id: g.identity_id,
        email: `${g.identity_id}@proxysetting`,
        uuid: await decrypt(env, g.uuid_cipher, `${vps.id}:${g.identity_id}`),
        quotaBytes: g.quota_bytes,
      })),
    ),
    upgrade: vps.upgrade_json ? JSON.parse(vps.upgrade_json) : null,
    ...(usage ? { usage: { month: usage.month, users: usage.users } } : {}),
  };
}
export async function rateLimit(
  env: Env,
  key: string,
  limit: number,
  seconds = 60,
) {
  const window = Math.floor(Date.now() / 1000 / seconds);
  const row = await env.DB.prepare(
    "INSERT INTO rate_limits(key,window,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET window=excluded.window,count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END RETURNING count",
  )
    .bind(key, window)
    .first<{ count: number }>();
  assert(row && row.count <= limit, "Rate limit exceeded", 429);
}
