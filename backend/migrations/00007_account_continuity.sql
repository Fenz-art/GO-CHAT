-- +goose Up
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_normalized TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  linked_user_id TEXT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','deleted')),
  email_verified_at TIMESTAMPTZ,
  last_signed_in_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (char_length(username) BETWEEN 3 AND 32),
  CHECK (char_length(email) BETWEEN 3 AND 320)
);

CREATE TABLE account_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX account_sessions_active_idx ON account_sessions(account_id, revoked_at, expires_at);

CREATE TABLE message_requests (
  id TEXT PRIMARY KEY,
  sender_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','blocked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  CHECK (sender_user_id <> recipient_user_id),
  UNIQUE (sender_user_id, recipient_user_id)
);
CREATE INDEX message_requests_recipient_idx ON message_requests(recipient_user_id, status, created_at DESC);

ALTER TABLE reports ADD COLUMN status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','reviewing','resolved','closed'));
ALTER TABLE reports ADD COLUMN reference_code TEXT;
UPDATE reports SET reference_code = id WHERE reference_code IS NULL;
ALTER TABLE reports ALTER COLUMN reference_code SET NOT NULL;
CREATE UNIQUE INDEX reports_reference_code_idx ON reports(reference_code);

-- +goose Down
DROP INDEX IF EXISTS reports_reference_code_idx;
ALTER TABLE reports DROP COLUMN IF EXISTS reference_code;
ALTER TABLE reports DROP COLUMN IF EXISTS status;
DROP TABLE IF EXISTS message_requests;
DROP TABLE IF EXISTS account_sessions;
DROP TABLE IF EXISTS accounts;
