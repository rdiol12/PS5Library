ALTER TABLE users ADD COLUMN role text NOT NULL DEFAULT 'MEMBER' CHECK(role IN ('ADMIN','MEMBER'));
CREATE TABLE invites (
  id uuid PRIMARY KEY, created_by uuid NOT NULL REFERENCES users,
  token_hash text UNIQUE NOT NULL, expires_at timestamptz NOT NULL,
  claimed_by uuid REFERENCES users, created_at timestamptz NOT NULL DEFAULT now()
);
