DROP INDEX IF EXISTS vps_name;
CREATE UNIQUE INDEX IF NOT EXISTS vps_name ON vps(name) WHERE status != 'deleted';
