-- +goose Up
ALTER TABLE anonymous_profiles
  ADD COLUMN avatar_storage_key TEXT,
  ADD COLUMN status_message TEXT NOT NULL DEFAULT '' CHECK (char_length(status_message) <= 140);

CREATE INDEX anonymous_profiles_status_idx ON anonymous_profiles (updated_at DESC);

-- +goose Down
DROP INDEX IF EXISTS anonymous_profiles_status_idx;
ALTER TABLE anonymous_profiles
  DROP COLUMN IF EXISTS status_message,
  DROP COLUMN IF EXISTS avatar_storage_key;
