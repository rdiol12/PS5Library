CREATE TABLE saved_games (user_id uuid REFERENCES users,game_id uuid REFERENCES games,saved_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,game_id));
