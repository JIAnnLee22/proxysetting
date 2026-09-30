# Worker ↔ agent v1 contract
All JSON, HTTPS only, Authorization: Bearer <device credential>. Errors: `{error: string}`. Bytes are integer uint64 on Go, safe integers ≤ 2^53−1 in API; reject overflow. Month and day are Asia/Shanghai calendar strings. UUIDs never used as logging IDs. Body max 64 KiB. 1–10 VPS, 1–50 identities.

## Enrollment
POST `/api/agent/register`, no device auth: `{token, address, port, publicKey, shortId, serverName, version}`. One-use token (256 random bits), 15-minute TTL, bound to pending VPS ID. Address/port must match administrator's VPS. Reality publicKey base64url 32 bytes, shortId 16 hex chars, serverName valid candidate DNS name. Private key NEVER leaves VPS. Returns `{vpsId, credential, config}`. Credential independent 256 bits, stored hash only by Worker, persist agent config mode 0600. If response lost, admin issues new enrollment token and reinstalls; never retry consumed token.

## Desired config
GET `/api/agent/config?revision=N`: returns full config (even unchanged; no 304 to keep protocol simple):
```
{schema:1,vpsId,revision,port,serverName,users:[{id,email,uuid,quotaBytes}],upgrade:null|{version,url,sha256},usage?:{month,users:[{id,uplink,downlink,disabled}]}}
```
`email = identity ID + '@proxysetting'`, stable. Only explicitly granted VPS×identity pairs in users; missing quota means no user. Disabled identity/revoked grant disappears. Per VPS revisions strictly increase for grants, identity enabled/name changes, target/port changes (target/port changes require reinstall, not live mutable first release), upgrade command. Runtime must reject vpsId/port/serverName mismatch with installed config rather than mark ready. `quotaBytes` positive integer GiB × 1073741824 (max 102400 GiB). Public Reality parameters installed fixed. Upgrade URL is constructed from configured GitHub Release repo and validated release version, never user URL. Version match prevents repeated upgrade.

## Snapshot and Analytics
POST `/api/agent/snapshot`: 
```json
{
  "schema": 1,
  "sequence": 123,
  "month": "2026-09",
  "day": "2026-09-30",
  "revision": 5,
  "version": "v0.1.1",
  "status": "ready",
  "error": "",
  "users": [{"id": 1, "uplink": 100, "downlink": 200}],
  "daily": {
    "date": "2026-09-30",
    "users": [{"id": 1, "uplink": 10, "downlink": 20}],
    "quality": "complete",
    "archived": false
  },
  "archive": {
    "period": "2026-09-29",
    "type": "daily",
    "users": [{"id": 1, "uplink": 50, "downlink": 100}],
    "quality": "complete"
  }
}
```
- `sequence` monotonic persisted across restart; same/lower sequence accepted without writes (idempotent).
- **Month legacy `users`**: Nonnegative cumulative counters for the current month. Up to 50 users. Required for old agent compatibility and month quota enforcement.
- **`daily` (optional)**: Daily cumulative counters (additive traffic within the day, not month cumulative). Does NOT include remote month seed or manual quota compensations. `quality` can be `complete`, `partial` (e.g. startup gap, crash), or `missing`. `archived`: boolean indicating if this is the final value for the day.
- **`archive` (optional)**: At most one historical period (daily or monthly) to backfill. Sent over normal snapshot 5-min intervals to avoid limits.
- **ACK & Compatibility**: The Worker acknowledges the `sequence`. The agent only deletes the confirmed `archive` from its local outbox upon HTTP 2xx response. Old agents do not send `daily`/`archive` and are gracefully handled (UI shows `missing`/legacy estimation). Old agents strict JSON decoder ignores unknown fields.
- **Time boundaries**: Daily records retained 400 days; monthly records retained 60 months. Cloudflare calendar authoritative validation (Asia/Shanghai). Old archives beyond retention are dropped by the Worker but still ACKed to unblock the agent's queue.
- **Usage seeds**: The remote month seed is merged for quotas (`max(local, recorded)`), but must NOT be treated as newly observed traffic in the `daily` counters. Daily counters purely represent local proxy observations since 00:00.

## Credential controls
POST `/api/agent/rotate`: old credential authenticates; returns `{credential}`; old hash immediately invalid. Operator revoke endpoint stops subsequent authentication; already offline agent cannot learn revocation, explicitly documented. Re-enrollment resets snapshot sequence; retains quota and billing records. Desired config usage seeds current-month counters on fresh reinstall; agent merges per-direction max(local,recorded), never sum, so reinstallation cannot erase already reported monthly usage. No D1 UUID plaintext: AES-256-GCM keyed by Worker secret, AAD = VPS ID + ':' + identity ID. Device credential hash: SHA-256.

## Local files and CLI
`proxysetting-agent install --control-url URL --token TOKEN --address IP --port PORT --server-name HOST --root /opt/proxysetting` generates private Reality key, tests TLS1.3 target, produces config, registers, persists mode 0600 config + state and prints only public status. Installer passes token via protected environment `PROXYSETTING_ENROLL_TOKEN` (not persistent unit). Installed root paths: `current/bin/xray`, `current/bin/proxysetting-agent`, `config/agent.json`, `config/xray.json`, `state/usage.json`. `run --root ...` reads config, starts Xray through systemd dependency, verifies local API, initializes counters and grants; sample 10s, config poll 60s, upload 300s; SIGTERM final sample+fsync. `check --root ...` local state/health; `upgrade --root ... --version ...` and `rollback --root ...` installer invoked, pre-upgrade sample enforced by stopping agent first. Agent includes Go Xray protobuf dependency pinned official v26.3.27; API loopback `127.0.0.1:10085` (collision must error). Xray JSON on restart contains zero static VLESS clients; agent reconstructs allowed users from durable monthly state BEFORE signaling readiness. Public inbound tag `vless-reality`, stats query `user>>>`, reset=false, flow `xtls-rprx-vision`, level 0 with both user stats enabled. Fail closed systemd dependency/watchdog: Xray BindsTo agent, agent READY only after restored users + sample persistence. No direct browser→VPS API.
