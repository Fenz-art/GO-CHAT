-- +goose Up
ALTER TABLE chat_sessions
  ADD COLUMN retention_policy TEXT NOT NULL DEFAULT 'keep' CHECK (retention_policy IN ('keep','24h','7d','30d')),
  ADD COLUMN retention_updated_at TIMESTAMPTZ;

ALTER TABLE messages
  ADD COLUMN expires_at TIMESTAMPTZ,
  ADD COLUMN expired_at TIMESTAMPTZ;

CREATE INDEX messages_expiry_due_idx ON messages(expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE retention_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  previous_policy TEXT NOT NULL,
  next_policy TEXT NOT NULL CHECK (next_policy IN ('keep','24h','7d','30d')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX retention_events_session_idx ON retention_events(session_id, created_at DESC);

CREATE TABLE session_local_locks (
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  locked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id,user_id)
);

-- +goose Down
DROP TABLE IF EXISTS session_local_locks;
DROP INDEX IF EXISTS retention_events_session_idx;
DROP TABLE IF EXISTS retention_events;
DROP INDEX IF EXISTS messages_expiry_due_idx;
ALTER TABLE messages DROP COLUMN IF EXISTS expired_at, DROP COLUMN IF EXISTS expires_at;
ALTER TABLE chat_sessions DROP COLUMN IF EXISTS retention_updated_at, DROP COLUMN IF EXISTS retention_policy;
