-- +goose Up
ALTER TABLE chat_sessions ADD COLUMN message_cursor BIGINT NOT NULL DEFAULT 0;
UPDATE chat_sessions AS cs
SET message_cursor = COALESCE((SELECT MAX(m.cursor) FROM messages AS m WHERE m.session_id = cs.id), 0);

-- +goose Down
ALTER TABLE chat_sessions DROP COLUMN IF EXISTS message_cursor;
