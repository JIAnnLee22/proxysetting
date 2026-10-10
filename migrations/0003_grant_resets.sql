CREATE TABLE IF NOT EXISTS grant_resets (
  vps_id TEXT NOT NULL REFERENCES vps(id),
  identity_id TEXT NOT NULL REFERENCES identities(id),
  reset_baseline_bytes INTEGER NOT NULL DEFAULT 0,
  lifetime_used_bytes INTEGER NOT NULL DEFAULT 0,
  reset_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (vps_id, identity_id)
);
