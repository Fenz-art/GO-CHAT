-- +goose Up
ALTER TABLE user_settings
  ADD COLUMN presence_visibility TEXT NOT NULL DEFAULT 'everyone' CHECK (presence_visibility IN ('everyone','nobody')),
  ADD COLUMN read_receipts BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN notifications BOOLEAN NOT NULL DEFAULT TRUE;

-- +goose Down
ALTER TABLE user_settings
  DROP COLUMN IF EXISTS notifications,
  DROP COLUMN IF EXISTS read_receipts,
  DROP COLUMN IF EXISTS presence_visibility;
