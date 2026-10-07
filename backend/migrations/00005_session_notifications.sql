-- +goose Up
ALTER TABLE session_participants
  ADD COLUMN notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- +goose Down
ALTER TABLE session_participants
  DROP COLUMN IF EXISTS notifications_enabled;
