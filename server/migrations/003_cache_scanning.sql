ALTER TABLE artifacts ADD COLUMN cache_key text;
ALTER TABLE artifacts ADD COLUMN deleted_at timestamptz;
CREATE INDEX artifact_cache ON artifacts(release_id,cache_key) WHERE verified;
CREATE UNIQUE INDEX one_active_build ON jobs(user_id,source_release_id,(config->>'method')) WHERE kind='BUILD' AND state NOT IN ('COMPLETED','ERROR','CANCELLED');
ALTER TABLE sources ADD COLUMN next_scan_at timestamptz NOT NULL DEFAULT now();
