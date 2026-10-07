-- +goose Up
ALTER TABLE account_sessions
  ADD COLUMN browser_session_id TEXT REFERENCES browser_sessions(id) ON DELETE CASCADE;

CREATE TABLE account_recovery_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('email_verification', 'password_reset')),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX account_recovery_tokens_active_idx
  ON account_recovery_tokens(account_id, kind, expires_at)
  WHERE used_at IS NULL;

-- +goose Down
DROP TABLE IF EXISTS account_recovery_tokens;
ALTER TABLE account_sessions DROP COLUMN IF EXISTS browser_session_id;
