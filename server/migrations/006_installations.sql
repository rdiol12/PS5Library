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
