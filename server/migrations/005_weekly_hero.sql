CREATE TABLE featured_history (
  id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users,game_id uuid NOT NULL REFERENCES games,
  week_of date NOT NULL,sha256 text NOT NULL,relative_path text NOT NULL,
  selected_at timestamptz NOT NULL,UNIQUE(user_id,week_of)
);
CREATE INDEX featured_repeat_window ON featured_history(user_id,sha256,selected_at DESC);
