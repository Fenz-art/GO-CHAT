-- +goose Up
ALTER TABLE user_settings
  DROP CONSTRAINT IF EXISTS user_settings_presence_visibility_check,
  ADD CONSTRAINT user_settings_presence_visibility_check CHECK (presence_visibility IN ('everyone','direct_contacts','nobody')),
  ADD COLUMN avatar_visibility TEXT NOT NULL DEFAULT 'direct_contacts' CHECK (avatar_visibility IN ('everyone','direct_contacts','nobody')),
  ADD COLUMN status_visibility TEXT NOT NULL DEFAULT 'direct_contacts' CHECK (status_visibility IN ('everyone','direct_contacts','nobody')),
  ADD COLUMN notification_preview TEXT NOT NULL DEFAULT 'sender' CHECK (notification_preview IN ('full','sender','none')),
  ADD COLUMN notification_sound BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN quiet_hours_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN quiet_hours_start TIME,
  ADD COLUMN quiet_hours_end TIME,
  ADD COLUMN media_auto_download TEXT NOT NULL DEFAULT 'manual' CHECK (media_auto_download IN ('always','manual','never')),
  ADD COLUMN link_previews_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN privacy_checkup_completed_at TIMESTAMPTZ;

CREATE TABLE data_rights_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_kind TEXT NOT NULL CHECK (request_kind IN ('deletion')),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','processing','completed','rejected')),
  reference_code TEXT NOT NULL UNIQUE,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fulfilled_at TIMESTAMPTZ,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX data_rights_requests_active_deletion_unique ON data_rights_requests(user_id, request_kind) WHERE status IN ('submitted','processing');
CREATE INDEX data_rights_requests_user_created_idx ON data_rights_requests(user_id, created_at DESC);

-- +goose Down
DROP INDEX IF EXISTS data_rights_requests_user_created_idx;
DROP INDEX IF EXISTS data_rights_requests_active_deletion_unique;
DROP TABLE IF EXISTS data_rights_requests;
ALTER TABLE user_settings
  DROP COLUMN IF EXISTS privacy_checkup_completed_at,
  DROP COLUMN IF EXISTS link_previews_enabled,
  DROP COLUMN IF EXISTS media_auto_download,
  DROP COLUMN IF EXISTS quiet_hours_end,
  DROP COLUMN IF EXISTS quiet_hours_start,
  DROP COLUMN IF EXISTS quiet_hours_enabled,
  DROP COLUMN IF EXISTS notification_sound,
  DROP COLUMN IF EXISTS notification_preview,
  DROP COLUMN IF EXISTS status_visibility,
  DROP COLUMN IF EXISTS avatar_visibility,
  DROP CONSTRAINT IF EXISTS user_settings_presence_visibility_check,
  ADD CONSTRAINT user_settings_presence_visibility_check CHECK (presence_visibility IN ('everyone','nobody'));
