-- +goose Up
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE users (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','deleted')), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE anonymous_profiles (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, username TEXT NOT NULL, username_normalized TEXT NOT NULL UNIQUE, identity_seed TEXT NOT NULL, username_locked_at TIMESTAMPTZ, onboarding_completed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), CHECK (char_length(username) BETWEEN 3 AND 32));
CREATE TABLE browser_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, csrf_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ, last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX browser_sessions_active_idx ON browser_sessions(user_id, revoked_at, expires_at);
CREATE TABLE onboarding_checkpoints (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, step TEXT NOT NULL CHECK (step IN ('username','complete')), candidate_username TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE user_settings (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, theme TEXT NOT NULL DEFAULT 'system', reduced_motion BOOLEAN NOT NULL DEFAULT FALSE, send_on_enter BOOLEAN NOT NULL DEFAULT TRUE, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, direct_pair_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'active', last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE session_participants (session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, joined_at TIMESTAMPTZ NOT NULL DEFAULT now(), archived_at TIMESTAMPTZ, muted_until TIMESTAMPTZ, last_read_cursor BIGINT NOT NULL DEFAULT 0, PRIMARY KEY(session_id,user_id));
CREATE INDEX session_participants_user_idx ON session_participants(user_id, archived_at);
CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE, sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, client_operation_id TEXT NOT NULL, cursor BIGINT NOT NULL, kind TEXT NOT NULL DEFAULT 'text', body TEXT, state TEXT NOT NULL DEFAULT 'sent', edited_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(sender_id,client_operation_id), UNIQUE(session_id,cursor));
CREATE INDEX messages_session_cursor_idx ON messages(session_id,cursor DESC);
CREATE TABLE memory_vaults (id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE REFERENCES chat_sessions(id) ON DELETE CASCADE, state TEXT NOT NULL DEFAULT 'reserved', created_at TIMESTAMPTZ NOT NULL DEFAULT now());

-- +goose Down
DROP TABLE IF EXISTS memory_vaults;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS session_participants;
DROP TABLE IF EXISTS chat_sessions;
DROP TABLE IF EXISTS user_settings;
DROP TABLE IF EXISTS onboarding_checkpoints;
DROP TABLE IF EXISTS browser_sessions;
DROP TABLE IF EXISTS anonymous_profiles;
DROP TABLE IF EXISTS users;
