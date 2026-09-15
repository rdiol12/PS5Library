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
