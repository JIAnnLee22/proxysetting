PRAGMA foreign_keys = ON;
CREATE TABLE vps (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL, port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),
 server_name TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, public_key TEXT, short_id TEXT,
 status TEXT NOT NULL DEFAULT 'pending', version TEXT, last_sync TEXT, error TEXT,
 credential_hash TEXT UNIQUE, revoked INTEGER NOT NULL DEFAULT 0,
 enrollment_hash TEXT UNIQUE, enrollment_expires INTEGER, upgrade_json TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE identities (id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)));
CREATE TABLE grants (
 vps_id TEXT NOT NULL REFERENCES vps(id), identity_id TEXT NOT NULL REFERENCES identities(id),
 uuid_cipher TEXT NOT NULL, quota_bytes INTEGER NOT NULL CHECK(quota_bytes > 0 AND quota_bytes <= 109951162777600),
 PRIMARY KEY (vps_id, identity_id)
);
CREATE TABLE snapshots (
 vps_id TEXT PRIMARY KEY REFERENCES vps(id), sequence INTEGER NOT NULL, month TEXT NOT NULL, day TEXT NOT NULL,
 payload TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE usage_periods (
 vps_id TEXT NOT NULL REFERENCES vps(id), period TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY (vps_id, period)
);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE INDEX grants_identity ON grants(identity_id);
CREATE INDEX usage_period ON usage_periods(period);
CREATE INDEX enrollment_expiry ON vps(enrollment_expires);
