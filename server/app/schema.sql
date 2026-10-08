-- PS5Library ordered database schema. Keep existing section bodies unchanged; append new numbered sections.
-- PS5LIBRARY MIGRATION 001_initial.sql
CREATE TABLE users (
  id uuid PRIMARY KEY, username text NOT NULL UNIQUE, password_hash text NOT NULL,
  default_console_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE, expires_at timestamptz NOT NULL);
CREATE TABLE consoles (
  id uuid PRIMARY KEY, device_id uuid NOT NULL UNIQUE, user_id uuid REFERENCES users,
  name text NOT NULL, client_kind text NOT NULL CHECK(client_kind IN ('PS5','SIMULATOR')),
  last_seen timestamptz, firmware text, runtime text NOT NULL DEFAULT 'unknown',
  client_version text, agent_version text, shadowmount_version text,
  shadowmount_fakelib boolean NOT NULL DEFAULT false, standalone_backpork boolean NOT NULL DEFAULT false,
  library_revision bigint NOT NULL DEFAULT -1, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD CONSTRAINT default_console_fk FOREIGN KEY(default_console_id) REFERENCES consoles;
CREATE TABLE console_credentials (id uuid PRIMARY KEY, console_id uuid NOT NULL REFERENCES consoles ON DELETE CASCADE, token_hash text UNIQUE NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE pairings (id uuid PRIMARY KEY, console_id uuid NOT NULL REFERENCES consoles, code_hash text NOT NULL UNIQUE, poll_hash text NOT NULL, credential_cipher text, expires_at timestamptz NOT NULL, claimed_at timestamptz);
CREATE TABLE console_heartbeats (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, console_id uuid NOT NULL REFERENCES consoles ON DELETE CASCADE, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX console_heartbeats_console ON console_heartbeats(console_id, created_at DESC);
CREATE TABLE console_capabilities (console_id uuid PRIMARY KEY REFERENCES consoles ON DELETE CASCADE, capabilities jsonb NOT NULL DEFAULT '{}');
CREATE TABLE console_storage (console_id uuid REFERENCES consoles ON DELETE CASCADE, storage_id text, display_name text NOT NULL, path text NOT NULL, total_bytes bigint NOT NULL CHECK(total_bytes>=0), free_bytes bigint NOT NULL CHECK(free_bytes>=0 AND free_bytes<=total_bytes), writable boolean NOT NULL, methods jsonb NOT NULL, last_seen timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(console_id, storage_id));
CREATE TABLE games (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users, title_id text NOT NULL, title text NOT NULL, metadata jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,title_id));
CREATE TABLE game_releases (id uuid PRIMARY KEY, game_id uuid NOT NULL REFERENCES games, content_id text NOT NULL, version text NOT NULL, kind text NOT NULL CHECK(kind IN ('BASE','UPDATE','DLC')), metadata jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(game_id,content_id,version,kind));
CREATE TABLE sources (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users, name text NOT NULL, type text NOT NULL, config jsonb NOT NULL, last_synced timestamptz, error text);
CREATE TABLE source_releases (id uuid PRIMARY KEY, source_id uuid NOT NULL REFERENCES sources, release_id uuid NOT NULL REFERENCES game_releases, source_key text NOT NULL, metadata jsonb NOT NULL, UNIQUE(source_id,source_key));
CREATE TABLE metadata_records (id uuid PRIMARY KEY, game_id uuid NOT NULL REFERENCES games, provider text NOT NULL, rank integer NOT NULL CHECK(rank BETWEEN 1 AND 5), data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(game_id,provider));
CREATE TABLE artwork (id uuid PRIMARY KEY, game_id uuid NOT NULL REFERENCES games, kind text NOT NULL, sha256 text NOT NULL, relative_path text NOT NULL, width integer NOT NULL, height integer NOT NULL, size bigint NOT NULL CHECK(size>=0), UNIQUE(game_id,kind));
CREATE TABLE compatibility_profiles (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users, title_id text NOT NULL, content_id text NOT NULL, game_version text NOT NULL, target_firmware text NOT NULL, runtime text NOT NULL, profile jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE artifacts (id uuid PRIMARY KEY, release_id uuid NOT NULL REFERENCES game_releases, format text NOT NULL, relative_path text NOT NULL UNIQUE, sha256 text NOT NULL CHECK(length(sha256)=64), size bigint NOT NULL CHECK(size BETWEEN 0 AND 9007199254740991), verified boolean NOT NULL DEFAULT false, inspection jsonb NOT NULL, builder_version text, input_hash text, profile_id uuid REFERENCES compatibility_profiles, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE backport_artifacts (id uuid PRIMARY KEY, game_id uuid NOT NULL REFERENCES games, release_id uuid NOT NULL REFERENCES game_releases, title_id text NOT NULL, game_version text NOT NULL, target_firmware text NOT NULL, type text NOT NULL, source text NOT NULL, sha256 text NOT NULL, size bigint NOT NULL CHECK(size>=0), profile_id uuid NOT NULL REFERENCES compatibility_profiles, tested boolean NOT NULL DEFAULT false, artifact_id uuid NOT NULL REFERENCES artifacts, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE jobs (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users, kind text NOT NULL CHECK(kind IN ('DOWNLOAD','BUILD','TRANSFER')),
  release_id uuid NOT NULL REFERENCES game_releases, source_release_id uuid REFERENCES source_releases,
  artifact_id uuid REFERENCES artifacts, console_id uuid REFERENCES consoles, storage_id text,
  state text NOT NULL, desired_state text NOT NULL DEFAULT 'RUNNING' CHECK(desired_state IN ('RUNNING','PAUSED','CANCELLED')),
  downloaded_bytes bigint NOT NULL DEFAULT 0 CHECK(downloaded_bytes>=0), total_bytes bigint CHECK(total_bytes>=0),
  speed_bytes_per_second bigint NOT NULL DEFAULT 0 CHECK(speed_bytes_per_second>=0), eta_seconds integer,
  attempts integer NOT NULL DEFAULT 0, error text, config jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(console_id,storage_id) REFERENCES console_storage(console_id,storage_id)
);
CREATE INDEX jobs_user_updated ON jobs(user_id,updated_at DESC);
CREATE UNIQUE INDEX one_active_download ON jobs(user_id,source_release_id) WHERE kind='DOWNLOAD' AND state NOT IN ('COMPLETED','ERROR','CANCELLED');
CREATE UNIQUE INDEX one_active_transfer ON jobs(console_id,release_id,storage_id) WHERE kind='TRANSFER' AND state NOT IN ('READY_ON_PS5','ERROR','CANCELLED');
CREATE TABLE job_events (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, job_id uuid NOT NULL REFERENCES jobs, user_id uuid NOT NULL REFERENCES users, state text NOT NULL, progress jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX events_user_cursor ON job_events(user_id,id);
CREATE TABLE library_entries (user_id uuid REFERENCES users, release_id uuid REFERENCES game_releases, artifact_id uuid NOT NULL REFERENCES artifacts, state text NOT NULL, PRIMARY KEY(user_id,release_id));
CREATE TABLE console_library_entries (
  console_id uuid REFERENCES consoles, release_id uuid REFERENCES game_releases, storage_id text NOT NULL,
  state text NOT NULL CHECK(state IN ('SERVER_ONLY','PREPARING','READY_ON_SERVER','QUEUED_FOR_PS5','TRANSFERRING','VERIFYING','REGISTERING','READY_ON_PS5','MISSING','ERROR')),
  relative_path text, sha256 text, size bigint, registered boolean NOT NULL DEFAULT false,
  backport_profile_id uuid REFERENCES compatibility_profiles, revision bigint NOT NULL DEFAULT -1,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(console_id,release_id,storage_id)
);
CREATE VIEW downloads AS SELECT * FROM jobs WHERE kind='DOWNLOAD';
CREATE VIEW build_jobs AS SELECT * FROM jobs WHERE kind='BUILD';
CREATE VIEW transfer_jobs AS SELECT * FROM jobs WHERE kind='TRANSFER';
-- PS5LIBRARY MIGRATION 002_invites.sql
ALTER TABLE users ADD COLUMN role text NOT NULL DEFAULT 'MEMBER' CHECK(role IN ('ADMIN','MEMBER'));
CREATE TABLE invites (
  id uuid PRIMARY KEY, created_by uuid NOT NULL REFERENCES users,
  token_hash text UNIQUE NOT NULL, expires_at timestamptz NOT NULL,
  claimed_by uuid REFERENCES users, created_at timestamptz NOT NULL DEFAULT now()
);
-- PS5LIBRARY MIGRATION 003_cache_scanning.sql
ALTER TABLE artifacts ADD COLUMN cache_key text;
ALTER TABLE artifacts ADD COLUMN deleted_at timestamptz;
CREATE INDEX artifact_cache ON artifacts(release_id,cache_key) WHERE verified;
CREATE UNIQUE INDEX one_active_build ON jobs(user_id,source_release_id,(config->>'method')) WHERE kind='BUILD' AND state NOT IN ('COMPLETED','ERROR','CANCELLED');
ALTER TABLE sources ADD COLUMN next_scan_at timestamptz NOT NULL DEFAULT now();
-- PS5LIBRARY MIGRATION 004_saved_games.sql
CREATE TABLE saved_games (user_id uuid REFERENCES users,game_id uuid REFERENCES games,saved_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,game_id));
-- PS5LIBRARY MIGRATION 005_weekly_hero.sql
CREATE TABLE featured_history (
  id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users,game_id uuid NOT NULL REFERENCES games,
  week_of date NOT NULL,sha256 text NOT NULL,relative_path text NOT NULL,
  selected_at timestamptz NOT NULL,UNIQUE(user_id,week_of)
);
CREATE INDEX featured_repeat_window ON featured_history(user_id,sha256,selected_at DESC);
-- PS5LIBRARY MIGRATION 006_installations.sql
CREATE TABLE installations (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users,
  source_release_id uuid NOT NULL REFERENCES source_releases,
  console_id uuid NOT NULL REFERENCES consoles, storage_id text NOT NULL,
  method text NOT NULL CHECK(method IN ('HOMEBREW','FPKG','SHADOWMOUNT')),
  source_sha256 text NOT NULL CHECK(length(source_sha256)=64),
  source_job_id uuid REFERENCES jobs, artifact_id uuid REFERENCES artifacts,
  transfer_job_id uuid REFERENCES jobs,
  state text NOT NULL DEFAULT 'CREATED', error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(console_id,storage_id) REFERENCES console_storage(console_id,storage_id)
);
CREATE UNIQUE INDEX installation_active ON installations(user_id,source_release_id,console_id,storage_id,method)
  WHERE state NOT IN ('READY_ON_PS5','ERROR','CANCELLED');
CREATE UNIQUE INDEX installation_transfer ON jobs((config->>'installationId'))
  WHERE kind='TRANSFER' AND config->>'installationId' IS NOT NULL;
-- PS5LIBRARY MIGRATION 007_console_discovery.sql
ALTER TABLE consoles ADD COLUMN runtime_status jsonb NOT NULL DEFAULT '{}';
ALTER TABLE console_library_entries ADD COLUMN source text NOT NULL DEFAULT 'MANAGED' CHECK(source IN ('MANAGED','EXISTING_DUMP'));
ALTER TABLE console_library_entries ADD COLUMN backport_files boolean NOT NULL DEFAULT false;
-- PS5LIBRARY MIGRATION 008_trophy_summary.sql
ALTER TABLE consoles ADD COLUMN trophy_summary jsonb;
ALTER TABLE consoles ADD COLUMN trophy_synced_at timestamptz;
-- PS5LIBRARY MIGRATION 009_installed_ps4.sql
ALTER TABLE console_library_entries DROP CONSTRAINT console_library_entries_source_check;
ALTER TABLE console_library_entries ADD CONSTRAINT console_library_entries_source_check CHECK(source IN ('MANAGED','EXISTING_DUMP','INSTALLED_TITLE'));
-- PS5LIBRARY MIGRATION 010_profile_avatar.sql
ALTER TABLE users ADD COLUMN avatar bytea;
ALTER TABLE users ADD COLUMN avatar_sha256 text;
ALTER TABLE users ADD CONSTRAINT avatar_size_limit CHECK(octet_length(avatar)<=262144);
-- PS5LIBRARY MIGRATION 011_trailers.sql
CREATE TABLE game_trailers (
  id uuid PRIMARY KEY,
  game_id uuid NOT NULL UNIQUE REFERENCES games(id) ON DELETE CASCADE,
  state text NOT NULL CHECK(state IN ('UPLOADING','QUEUED','PREPARING','READY','ERROR')),
  reserved_bytes bigint NOT NULL CHECK(reserved_bytes>=0),
  size bigint CHECK(size>0),
  sha256 text CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  duration double precision CHECK(duration>0 AND duration<=180.1),
  error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(state<>'READY' OR (size IS NOT NULL AND sha256 IS NOT NULL AND duration IS NOT NULL))
);
-- PS5LIBRARY MIGRATION 012_shared_watch.sql
ALTER TABLE games ADD COLUMN shared boolean NOT NULL DEFAULT false;
ALTER TABLE artwork ADD COLUMN input_sha256 text;
CREATE VIEW game_read_access AS
  SELECT id AS game_id,user_id FROM games
  UNION SELECT g.id,u.id FROM games g CROSS JOIN users u WHERE g.shared
  UNION SELECT r.game_id,c.user_id FROM console_library_entries l JOIN consoles c ON c.id=l.console_id JOIN game_releases r ON r.id=l.release_id WHERE c.user_id IS NOT NULL;
CREATE TABLE source_observations (
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  path text NOT NULL,
  signature text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'STABILIZING',
  release jsonb,
  error text,
  PRIMARY KEY(source_id,path)
);
CREATE TABLE automatic_preparations (
  source_release_id uuid NOT NULL REFERENCES source_releases(id),
  input_hash text NOT NULL,
  method text NOT NULL CHECK(method IN ('FPKG','SHADOWMOUNT','DOWNLOAD','TRAILER')),
  PRIMARY KEY(source_release_id,input_hash,method)
);
-- PS5LIBRARY MIGRATION 013_separate_backports.sql
-- Unclassified dump libraries are preserved without inventing a target firmware or tested profile.
ALTER TABLE backport_artifacts ALTER COLUMN target_firmware DROP NOT NULL;
ALTER TABLE backport_artifacts ALTER COLUMN profile_id DROP NOT NULL;
ALTER TABLE backport_artifacts ALTER COLUMN artifact_id DROP NOT NULL;
ALTER TABLE backport_artifacts ADD COLUMN input_hash text CHECK(input_hash IS NULL OR input_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE backport_artifacts ADD COLUMN relative_path text UNIQUE;
ALTER TABLE backport_artifacts ADD COLUMN deleted_at timestamptz;
ALTER TABLE backport_artifacts ADD CONSTRAINT backport_storage CHECK(artifact_id IS NOT NULL OR (type='SHADOWMOUNT_FOLDER' AND relative_path IS NOT NULL AND input_hash IS NOT NULL));
-- PS5LIBRARY MIGRATION 014_portable_cache_paths.sql
-- Relative paths use '/' on every host. Windows accepts it, Linux requires it.
UPDATE artifacts SET relative_path=replace(relative_path,chr(92),'/');
UPDATE artwork SET relative_path=replace(relative_path,chr(92),'/');
UPDATE featured_history SET relative_path=replace(relative_path,chr(92),'/');
UPDATE backport_artifacts SET relative_path=replace(relative_path,chr(92),'/') WHERE relative_path IS NOT NULL;
-- PS5LIBRARY MIGRATION 015_archive_observations.sql
ALTER TABLE source_observations ADD COLUMN details jsonb NOT NULL DEFAULT '{}';
-- Prepared images now exclude the separate DLC directory; allow the new pipeline to prepare once.
DELETE FROM automatic_preparations WHERE method IN ('FPKG','SHADOWMOUNT');
-- PS5LIBRARY MIGRATION 016_console_removals.sql
ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK(kind IN ('DOWNLOAD','BUILD','TRANSFER','DELETE'));
-- PS5LIBRARY MIGRATION 017_game_music.sql
ALTER TABLE game_trailers RENAME TO game_media;
ALTER TABLE game_media DROP CONSTRAINT game_trailers_game_id_key;
ALTER TABLE game_media ADD COLUMN kind text NOT NULL DEFAULT 'trailer' CHECK(kind IN ('trailer','music'));
ALTER TABLE game_media ADD COLUMN input_format text NOT NULL DEFAULT 'mov' CHECK(input_format IN ('mov','wav','ogg','mp3','flac'));
ALTER TABLE game_media ADD UNIQUE(game_id,kind);
ALTER TABLE automatic_preparations DROP CONSTRAINT automatic_preparations_method_check;
ALTER TABLE automatic_preparations ADD CHECK(method IN ('FPKG','SHADOWMOUNT','DOWNLOAD','TRAILER','MUSIC'));
-- PS5LIBRARY MIGRATION 018_storage_volumes.sql
-- The agent's /user record is an inventory root on the internal SSD, not
-- a second destination. Keep it for inventory/removal path validation.
-- Old agents also benefit; do not merge unrelated drives by display name.
CREATE VIEW console_storage_volumes AS
SELECT s.* FROM console_storage s
WHERE NOT (s.storage_id='internal-installed' AND s.path='/user' AND
  EXISTS(SELECT 1 FROM console_storage d WHERE d.console_id=s.console_id
    AND d.storage_id='internal' AND d.path='/data'));
-- PS5LIBRARY MIGRATION 019_console_firmware.sql
ALTER TABLE consoles ADD COLUMN firmware_checked_at timestamptz;
ALTER TABLE consoles ADD COLUMN firmware_request_id uuid;
UPDATE consoles SET firmware_checked_at=COALESCE(last_seen,created_at) WHERE firmware IS NOT NULL;
-- One-time upgrade from the old SDK-baseline detector to the system software API.
UPDATE consoles SET firmware_request_id=gen_random_uuid() WHERE client_kind='PS5' AND user_id IS NOT NULL;
-- PS5LIBRARY MIGRATION 020_backport_delivery.sql
ALTER TABLE artifacts ADD COLUMN profile_hash text CHECK(profile_hash IS NULL OR profile_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE installations ADD COLUMN profile_id uuid REFERENCES compatibility_profiles;
ALTER TABLE installations ADD COLUMN profile_hash text;
CREATE TABLE console_notices (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users, console_id uuid NOT NULL REFERENCES consoles,
  release_id uuid NOT NULL REFERENCES game_releases, code text NOT NULL, context text NOT NULL, message text NOT NULL,
  delivered_at timestamptz, resolved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(console_id,release_id,code,context)
);
-- PS5LIBRARY MIGRATION 021_native_downloads.sql
CREATE TABLE native_download_grants (
  job_id uuid PRIMARY KEY REFERENCES jobs, token_hash text NOT NULL UNIQUE, token_cipher text NOT NULL,
  expires_at timestamptz NOT NULL, coverage int8multirange NOT NULL DEFAULT '{}'
);
-- PS5LIBRARY MIGRATION 022_patched_libraries.sql
ALTER TABLE backport_artifacts ADD COLUMN profile_hash text CHECK(profile_hash IS NULL OR profile_hash ~ '^[a-f0-9]{64}$');
-- Different console firmware profiles produce different cache variants of the same source/method.
DROP INDEX one_active_build;
CREATE UNIQUE INDEX one_active_build ON jobs(user_id,source_release_id,(COALESCE(config->>'cacheKey',config->>'method')))
  WHERE kind='BUILD' AND state NOT IN ('COMPLETED','ERROR','CANCELLED');
-- PS5LIBRARY MIGRATION 023_frontend_credentials.sql
ALTER TABLE console_credentials
  ADD COLUMN kind text NOT NULL DEFAULT 'AGENT' CHECK(kind IN ('AGENT','FRONTEND')),
  ADD COLUMN frontend_device_id uuid,
  ADD CHECK ((kind='FRONTEND') = (frontend_device_id IS NOT NULL));
CREATE UNIQUE INDEX active_frontend_identity ON console_credentials(frontend_device_id)
  WHERE revoked_at IS NULL AND kind='FRONTEND';
ALTER TABLE pairings
  ALTER COLUMN console_id DROP NOT NULL,
  ADD COLUMN kind text NOT NULL DEFAULT 'AGENT' CHECK(kind IN ('AGENT','FRONTEND')),
  ADD COLUMN frontend_device_id uuid,
  ADD COLUMN credential_id uuid REFERENCES console_credentials(id) ON DELETE SET NULL,
  ADD CHECK ((kind='FRONTEND') = (frontend_device_id IS NOT NULL)),
  ADD CHECK (kind='FRONTEND' OR console_id IS NOT NULL);
-- PS5LIBRARY MIGRATION 024_native_notification_test.sql
ALTER TABLE console_notices ALTER COLUMN release_id DROP NOT NULL;
ALTER TABLE console_notices ADD COLUMN resolve_on_delivery boolean NOT NULL DEFAULT false;
-- PS5LIBRARY MIGRATION 025_download_history.sql
ALTER TABLE jobs ADD COLUMN dismissed_at timestamptz;
CREATE INDEX jobs_visible_user_updated ON jobs(user_id,updated_at DESC) WHERE dismissed_at IS NULL;
-- PS5LIBRARY MIGRATION 026_console_save_data.sql
CREATE TABLE console_save_data (
  console_id uuid NOT NULL REFERENCES consoles(id) ON DELETE CASCADE,
  local_user_id char(8) NOT NULL CHECK (local_user_id ~ '^[a-f0-9]{8}$'),
  platform text NOT NULL CHECK (platform IN ('PS4','PS5')),
  game_title_id varchar(9) NOT NULL,
  save_title_id varchar(9) NOT NULL,
  directory varchar(128) NOT NULL,
  title varchar(200) NOT NULL,
  subtitle varchar(200) NOT NULL,
  detail varchar(1000) NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  modified_at bigint NOT NULL CHECK (modified_at >= 0),
  scan_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(console_id,local_user_id,platform,save_title_id,directory)
);
CREATE INDEX console_save_data_game ON console_save_data(console_id,game_title_id,modified_at DESC);
-- PS5LIBRARY MIGRATION 027_game_shares.sql
CREATE TABLE game_shares (
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(game_id,user_id)
);

CREATE OR REPLACE VIEW game_read_access AS
  SELECT id AS game_id,user_id FROM games
  UNION SELECT g.id,u.id FROM games g CROSS JOIN users u WHERE g.shared
  UNION SELECT game_id,user_id FROM game_shares
  UNION SELECT r.game_id,c.user_id FROM console_library_entries l JOIN consoles c ON c.id=l.console_id JOIN game_releases r ON r.id=l.release_id WHERE c.user_id IS NOT NULL;
-- PS5LIBRARY MIGRATION 028_remote_play_pairing.sql
ALTER TABLE consoles
  ADD COLUMN remote_play_pairing_id uuid,
  ADD COLUMN remote_play_pairing_state text CHECK(remote_play_pairing_state IN ('REQUESTED','READY','PAIRED','ERROR','CANCELLED')),
  ADD COLUMN remote_play_pairing_cipher text,
  ADD COLUMN remote_play_pairing_error varchar(80),
  ADD COLUMN remote_play_pairing_expires_at timestamptz,
  ADD COLUMN remote_play_pairing_updated_at timestamptz,
  ADD CHECK (remote_play_pairing_cipher IS NULL OR remote_play_pairing_state='READY'),
  ADD CHECK (remote_play_pairing_error IS NULL OR remote_play_pairing_state='ERROR');
-- PS5LIBRARY MIGRATION 029_save_backups.sql
CREATE TABLE save_backups (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  console_id uuid NOT NULL REFERENCES consoles(id) ON DELETE CASCADE,
  local_user_id char(8) NOT NULL CHECK (local_user_id ~ '^[a-f0-9]{8}$'),
  platform text NOT NULL CHECK (platform IN ('PS4','PS5')),
  game_title_id varchar(9) NOT NULL,
  save_title_id varchar(9) NOT NULL,
  directory varchar(128) NOT NULL,
  source_modified_at bigint NOT NULL CHECK (source_modified_at >= 0),
  format text NOT NULL DEFAULT 'RAW_CONSOLE_V1' CHECK (format='RAW_CONSOLE_V1'),
  state text NOT NULL DEFAULT 'REQUESTED' CHECK (state IN ('REQUESTED','UPLOADING','VERIFYING','READY','ERROR','CANCELLED')),
  total_bytes bigint CHECK (total_bytes BETWEEN 1 AND 9007199254740991),
  uploaded_bytes bigint NOT NULL DEFAULT 0 CHECK (uploaded_bytes >= 0 AND (total_bytes IS NULL OR uploaded_bytes <= total_bytes)),
  sha256 char(64) CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  relative_path text UNIQUE,
  manifest jsonb NOT NULL DEFAULT '{}',
  error varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX save_backups_owner ON save_backups(user_id,created_at DESC);
CREATE UNIQUE INDEX one_active_save_backup ON save_backups(console_id,local_user_id,platform,save_title_id,directory)
  WHERE state IN ('REQUESTED','UPLOADING','VERIFYING');
-- PS5LIBRARY MIGRATION 030_community_master.sql
CREATE TABLE community_master_connection (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  installation_id uuid NOT NULL UNIQUE,
  master_url text NOT NULL,
  display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 80),
  credential_cipher text,
  user_code char(8),
  verification_uri text,
  verification_uri_complete text,
  server_identifier text,
  state text NOT NULL CHECK(state IN ('AWAITING_OWNER','PENDING','APPROVED','BANNED','DISCONNECT_PENDING','DISCONNECTED','ERROR')),
  ban_reason text,
  expires_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- PS5LIBRARY MIGRATION 031_portable_saves.sql
CREATE TABLE community_user_terms (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  terms_version text NOT NULL CHECK(length(terms_version) BETWEEN 1 AND 40),
  terms_sha256 char(64) NOT NULL CHECK(terms_sha256 ~ '^[a-f0-9]{64}$'),
  accepted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE portable_save_archives (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  origin text NOT NULL CHECK(origin IN ('EXPORT','COMMUNITY')),
  console_id uuid REFERENCES consoles(id) ON DELETE CASCADE,
  local_user_id char(8) CHECK(local_user_id IS NULL OR local_user_id ~ '^[a-f0-9]{8}$'),
  platform text NOT NULL CHECK(platform IN ('PS4','PS5')),
  game_title_id varchar(9) NOT NULL,
  save_title_id varchar(9) NOT NULL,
  directory varchar(128) NOT NULL,
  game_version varchar(32) NOT NULL,
  region varchar(32),
  source_modified_at bigint CHECK(source_modified_at IS NULL OR source_modified_at>=0),
  state text NOT NULL CHECK(state IN ('REQUESTED','UPLOADING','VERIFYING','DOWNLOADING','READY','ERROR','CANCELLED')),
  total_bytes bigint CHECK(total_bytes BETWEEN 1 AND 8589934592),
  uploaded_bytes bigint NOT NULL DEFAULT 0 CHECK(uploaded_bytes>=0 AND (total_bytes IS NULL OR uploaded_bytes<=total_bytes)),
  sha256 char(64) CHECK(sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  file_count integer CHECK(file_count BETWEEN 1 AND 10000),
  relative_path text UNIQUE,
  manifest jsonb NOT NULL DEFAULT '{}',
  display_name varchar(120),
  description varchar(2000) NOT NULL DEFAULT '',
  master_publication_id uuid,
  master_state text,
  error varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((origin='EXPORT' AND console_id IS NOT NULL AND local_user_id IS NOT NULL) OR origin='COMMUNITY')
);
CREATE INDEX portable_save_owner ON portable_save_archives(user_id,created_at DESC);
CREATE UNIQUE INDEX one_active_portable_export ON portable_save_archives(console_id,local_user_id,platform,save_title_id,directory)
  WHERE origin='EXPORT' AND state IN ('REQUESTED','UPLOADING','VERIFYING');

CREATE TABLE save_imports (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  archive_id uuid NOT NULL REFERENCES portable_save_archives(id) ON DELETE RESTRICT,
  console_id uuid NOT NULL REFERENCES consoles(id) ON DELETE CASCADE,
  local_user_id char(8) NOT NULL CHECK(local_user_id ~ '^[a-f0-9]{8}$'),
  rollback_backup_id uuid NOT NULL REFERENCES save_backups(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK(state IN ('WAITING_ROLLBACK','REQUESTED','IMPORTING','VERIFYING','COMPLETED','ERROR','CANCELLED')),
  downloaded_bytes bigint NOT NULL DEFAULT 0 CHECK(downloaded_bytes>=0),
  speed_bytes_per_second bigint NOT NULL DEFAULT 0 CHECK(speed_bytes_per_second>=0),
  error varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX save_imports_owner ON save_imports(user_id,created_at DESC);
CREATE UNIQUE INDEX one_active_save_import ON save_imports(console_id,local_user_id,archive_id)
  WHERE state IN ('WAITING_ROLLBACK','REQUESTED','IMPORTING','VERIFYING');
-- PS5LIBRARY MIGRATION 032_admin_activity.sql
ALTER TABLE sessions
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_ip inet,
  ADD COLUMN user_agent varchar(200);

ALTER TABLE console_credentials
  ADD COLUMN last_seen_at timestamptz,
  ADD COLUMN last_ip inet;
-- PS5LIBRARY MIGRATION 033_community_user_connections.sql
CREATE TABLE community_user_connections (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  master_url text NOT NULL,
  state text NOT NULL CHECK(state IN ('AWAITING_OWNER','CONNECTED','DISCONNECT_PENDING','DISCONNECTED','ERROR')),
  device_code_cipher text,
  session_cipher text,
  user_code char(8),
  verification_uri text,
  verification_uri_complete text,
  expires_at timestamptz,
  master_account_id uuid,
  master_handle text CHECK(master_handle IS NULL OR master_handle ~ '^[a-z0-9_]{3,32}$'),
  master_display_name text CHECK(master_display_name IS NULL OR length(master_display_name) BETWEEN 1 AND 80),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- PS5LIBRARY MIGRATION 034_per_user_job_queue.sql
CREATE INDEX jobs_user_queue ON jobs(user_id,(CASE WHEN state='QUEUED' THEN 1 ELSE 0 END),created_at,id)
WHERE kind IN ('DOWNLOAD','BUILD') AND desired_state='RUNNING' AND state IN ('QUEUED','DOWNLOADING','VERIFYING','RETRYING','EXTRACTING','BUILDING');
-- PS5LIBRARY MIGRATION 035_native_install_storage.sql
CREATE OR REPLACE VIEW console_storage_volumes AS
SELECT s.console_id,s.storage_id,
  CASE WHEN s.storage_id='internal-installed' AND s.path='/user'
    THEN 'PS5-managed install storage' ELSE s.display_name END AS display_name,
  s.path,s.total_bytes,s.free_bytes,
  CASE WHEN s.storage_id='internal-installed' AND s.path='/user' THEN true ELSE s.writable END AS writable,
  CASE WHEN s.storage_id='internal-installed' AND s.path='/user'
    THEN '["FPKG"]'::jsonb ELSE s.methods-'FPKG' END AS methods,
  s.last_seen
FROM console_storage s
LEFT JOIN console_capabilities c ON c.console_id=s.console_id
WHERE NOT (s.storage_id='internal-installed' AND s.path='/user')
   OR COALESCE(c.capabilities @> '{"nativeDownloads":true}'::jsonb,false);
-- PS5LIBRARY MIGRATION 036_native_move_storage.sql
CREATE OR REPLACE VIEW console_storage_volumes AS
SELECT s.console_id,s.storage_id,
  CASE WHEN s.storage_id='internal-installed' AND s.path='/user'
    THEN 'PS5-managed install storage' ELSE s.display_name END AS display_name,
  s.path,s.total_bytes,s.free_bytes,
  CASE WHEN s.storage_id='internal-installed' AND s.path='/user' THEN true ELSE s.writable END AS writable,
  CASE
    WHEN s.storage_id='internal-installed' AND s.path='/user'
      THEN '["FPKG"]'::jsonb
    WHEN s.storage_id='ext1' AND s.path='/mnt/ext1' AND s.methods ? 'FPKG'
      AND COALESCE(k.capabilities @> '{"nativeDownloads":true}'::jsonb,false) THEN s.methods
    WHEN s.storage_id='ext0' AND s.path='/mnt/ext0' AND s.methods ? 'FPKG'
      AND COALESCE(k.capabilities @> '{"nativeDownloads":true}'::jsonb,false)
      AND COALESCE(c.runtime_status @> '{"externalFpkgPatch":true}'::jsonb,false) THEN s.methods
    ELSE s.methods-'FPKG'
  END AS methods,
  s.last_seen
FROM console_storage s
JOIN consoles c ON c.id=s.console_id
LEFT JOIN console_capabilities k ON k.console_id=s.console_id
WHERE NOT (s.storage_id='internal-installed' AND s.path='/user')
   OR COALESCE(k.capabilities @> '{"nativeDownloads":true}'::jsonb,false);
-- PS5LIBRARY MIGRATION 037_storage_path_identity.sql
CREATE OR REPLACE VIEW console_storage_volumes AS
SELECT s.console_id,s.storage_id,
  CASE WHEN s.path='/user'
    THEN 'PS5-managed install storage' ELSE s.display_name END AS display_name,
  s.path,s.total_bytes,s.free_bytes,
  CASE WHEN s.path='/user' THEN true ELSE s.writable END AS writable,
  CASE
    WHEN s.path='/user'
      THEN '["FPKG"]'::jsonb
    WHEN s.path='/mnt/ext1' AND s.methods ? 'FPKG'
      AND COALESCE(k.capabilities @> '{"nativeDownloads":true}'::jsonb,false) THEN s.methods
    WHEN s.path='/mnt/ext0' AND s.methods ? 'FPKG'
      AND COALESCE(k.capabilities @> '{"nativeDownloads":true}'::jsonb,false)
      AND COALESCE(c.runtime_status @> '{"externalFpkgPatch":true}'::jsonb,false) THEN s.methods
    ELSE s.methods-'FPKG'
  END AS methods,
  s.last_seen
FROM console_storage s
JOIN consoles c ON c.id=s.console_id
LEFT JOIN console_capabilities k ON k.console_id=s.console_id
WHERE s.path<>'/user'
   OR COALESCE(k.capabilities @> '{"nativeDownloads":true}'::jsonb,false);
-- PS5LIBRARY MIGRATION 038_cheat_profiles.sql
CREATE TABLE cheat_profiles (
  id uuid PRIMARY KEY,
  created_by uuid NOT NULL REFERENCES users(id),
  title_id text NOT NULL CHECK(title_id ~ '^[A-Z]{4}[0-9]{5}$'),
  game_version text NOT NULL CHECK(length(game_version) BETWEEN 1 AND 40 AND game_version ~ '^[0-9A-Za-z][0-9A-Za-z._-]*$'),
  process_name text NOT NULL CHECK(length(process_name) BETWEEN 1 AND 128 AND process_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'),
  content_id text CHECK(content_id IS NULL OR (content_id ~ '^[A-Z]{2}[0-9]{4}-[A-Z]{4}[0-9]{5}_[0-9]{2}-[A-Z0-9]{16}$' AND substring(content_id from 8 for 9)=title_id)),
  target_executable_sha256 text CHECK(target_executable_sha256 IS NULL OR target_executable_sha256 ~ '^[a-f0-9]{64}$'),
  format text NOT NULL CHECK(format IN ('JSON','MC4','SHN')),
  profile_body bytea NOT NULL CHECK(octet_length(profile_body) BETWEEN 1 AND 1048576),
  profile_sha256 text NOT NULL CHECK(profile_sha256 ~ '^[a-f0-9]{64}$'),
  provenance jsonb NOT NULL CHECK(jsonb_typeof(provenance)='object'),
  approval_state text NOT NULL DEFAULT 'PENDING' CHECK(approval_state IN ('PENDING','APPROVED','REJECTED')),
  test_state text NOT NULL DEFAULT 'UNTESTED' CHECK(test_state IN ('UNTESTED','TESTED','FAILED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX cheat_profiles_identity_hash ON cheat_profiles(title_id,game_version,process_name,COALESCE(content_id,''),COALESCE(target_executable_sha256,''),profile_sha256);
CREATE INDEX cheat_profiles_exact_catalog ON cheat_profiles(title_id,game_version,process_name,approval_state);
-- PS5LIBRARY MIGRATION 039_cheat_deliveries.sql
CREATE TABLE cheat_deliveries (
  id uuid PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES cheat_profiles(id) ON DELETE CASCADE,
  console_id uuid NOT NULL REFERENCES consoles(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RECEIVED','REJECTED','DELETE_REQUESTED','DELETED')),
  error text CHECK(error IS NULL OR length(error) BETWEEN 1 AND 120),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 1000000),
  last_attempt_at timestamptz,
  received_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(console_id,profile_id)
);

CREATE INDEX cheat_deliveries_console_pending ON cheat_deliveries(console_id,created_at)
  WHERE state IN ('QUEUED','DELETE_REQUESTED');
-- PS5LIBRARY MIGRATION 040_cheat_delivery_targets.sql
ALTER TABLE cheat_deliveries ADD COLUMN target_key text;

UPDATE cheat_deliveries d
SET target_key=p.title_id || '_' || p.game_version || '_' || p.process_name || '.json'
FROM cheat_profiles p
WHERE p.id=d.profile_id;

ALTER TABLE cheat_deliveries
  ALTER COLUMN target_key SET NOT NULL,
  ADD CONSTRAINT cheat_delivery_target_key CHECK(
    target_key ~ '^(PPSA|CUSA)[0-9]{5}_[0-9]{1,3}(\.[0-9]{1,3}){1,2}_[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$'
  );

ALTER TABLE cheat_deliveries DROP CONSTRAINT cheat_deliveries_console_id_profile_id_key;

CREATE UNIQUE INDEX cheat_deliveries_console_target_active ON cheat_deliveries(console_id,target_key)
  WHERE state<>'DELETED';
-- PS5LIBRARY MIGRATION 041_media_paths.sql
ALTER TABLE game_media ADD COLUMN relative_path text;
-- PS5LIBRARY MIGRATION 042_remove_weekly_featured.sql
DROP TABLE IF EXISTS featured_history;
-- PS5LIBRARY MIGRATION 043_console_hardware_identity.sql
ALTER TABLE pairings
  ADD COLUMN hardware_lookup_hash text CHECK(hardware_lookup_hash IS NULL OR hardware_lookup_hash ~ '^[a-f0-9]{64}$');

CREATE TABLE console_hardware_identities (
  console_id uuid PRIMARY KEY REFERENCES consoles(id) ON DELETE CASCADE,
  lookup_hash text NOT NULL UNIQUE CHECK(lookup_hash ~ '^[a-f0-9]{64}$'),
  nonce text NOT NULL CHECK(nonce ~ '^[a-f0-9]{64}$'),
  recovery_token_hash text NOT NULL CHECK(recovery_token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_recovered_at timestamptz,
  recovery_disabled_at timestamptz
);
-- PS5LIBRARY MIGRATION 044_catalog_reverse_lookup_indexes.sql
CREATE INDEX source_releases_release ON source_releases(release_id);
CREATE INDEX backport_artifacts_release_active
  ON backport_artifacts(release_id,input_hash,type,profile_hash,created_at DESC)
  WHERE deleted_at IS NULL;
-- PS5LIBRARY MIGRATION 045_job_queue_order.sql
ALTER TABLE jobs ADD COLUMN queue_order bigint;

WITH ranked AS (
  SELECT id,row_number() OVER(PARTITION BY user_id ORDER BY CASE WHEN state='QUEUED' THEN 1 ELSE 0 END,created_at,id) AS position
  FROM jobs
  WHERE kind IN ('DOWNLOAD','BUILD') AND desired_state='RUNNING'
    AND state IN ('QUEUED','DOWNLOADING','VERIFYING','RETRYING','EXTRACTING','BUILDING')
)
UPDATE jobs SET queue_order=ranked.position FROM ranked WHERE jobs.id=ranked.id;

DROP INDEX jobs_user_queue;
CREATE INDEX jobs_user_queue ON jobs(user_id,(CASE WHEN state='QUEUED' THEN 1 ELSE 0 END),queue_order NULLS LAST,created_at,id)
WHERE kind IN ('DOWNLOAD','BUILD') AND desired_state='RUNNING'
  AND state IN ('QUEUED','DOWNLOADING','VERIFYING','RETRYING','EXTRACTING','BUILDING');
-- PS5LIBRARY MIGRATION 046_release_hot_paths.sql
DELETE FROM console_heartbeats
WHERE NOT (payload ? 'launchTrace')
  AND id NOT IN (
    SELECT max(id) FROM console_heartbeats
    WHERE NOT (payload ? 'launchTrace')
    GROUP BY console_id
  );

DELETE FROM job_events e
USING jobs j
WHERE e.job_id=j.id AND j.dismissed_at IS NOT NULL;

CREATE UNIQUE INDEX console_heartbeats_latest_normal
  ON console_heartbeats(console_id)
  WHERE NOT (payload ? 'launchTrace');

CREATE INDEX sources_due_scan
  ON sources(next_scan_at)
  WHERE config ? 'scanIntervalMinutes';

CREATE INDEX installations_active_scan
  ON installations(created_at)
  WHERE state NOT IN ('READY_ON_PS5','ERROR','CANCELLED');

CREATE INDEX game_media_work_scan
  ON game_media(state,updated_at,id)
  WHERE state IN ('UPLOADING','QUEUED','PREPARING');

CREATE INDEX console_notices_user_pending
  ON console_notices(user_id,created_at DESC)
  WHERE resolved_at IS NULL;

CREATE INDEX console_notices_device_pending
  ON console_notices(console_id,created_at)
  WHERE delivered_at IS NULL AND resolved_at IS NULL;

CREATE INDEX console_library_ready_release
  ON console_library_entries(release_id,console_id)
  WHERE state='READY_ON_PS5';

CREATE INDEX compatibility_profiles_match
  ON compatibility_profiles(user_id,title_id,content_id,game_version,target_firmware,runtime,created_at DESC);
-- PS5LIBRARY MIGRATION 047_job_event_lookup.sql
CREATE INDEX IF NOT EXISTS job_events_job ON job_events(job_id,id);
-- PS5LIBRARY MIGRATION 048_game_content_access.sql
CREATE OR REPLACE VIEW game_content_access AS
  SELECT id AS game_id,user_id FROM games
  UNION SELECT g.id,u.id FROM games g CROSS JOIN users u WHERE g.shared
  UNION SELECT game_id,user_id FROM game_shares;
-- PS5LIBRARY MIGRATION 049_console_inventory_indexes.sql
CREATE INDEX IF NOT EXISTS jobs_failed_transfer_history
  ON jobs(console_id,release_id,storage_id)
  WHERE kind='TRANSFER' AND state='READY_ON_PS5' AND config ? 'launchFailure';

CREATE INDEX IF NOT EXISTS pairings_console_credentials
  ON pairings(console_id,kind)
  WHERE credential_cipher IS NOT NULL;
