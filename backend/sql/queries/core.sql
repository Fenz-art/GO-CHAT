-- name: CreateUser :one
INSERT INTO users (id) VALUES ($1) RETURNING id, status, created_at, updated_at;

-- name: CreateBrowserSession :exec
INSERT INTO browser_sessions (id,user_id,token_hash,csrf_hash,expires_at) VALUES ($1,$2,$3,$4,now()+interval '30 days');

-- name: CreateUserSettings :exec
INSERT INTO user_settings (user_id) VALUES ($1);

-- name: CreateAccount :one
INSERT INTO accounts (id,username,username_normalized,email,password_hash,linked_user_id,last_signed_in_at) VALUES ($1,$2,$3,$4,$5,$6,now()) RETURNING id,username,username_normalized,email,password_hash,linked_user_id,status,email_verified_at,last_signed_in_at,created_at,updated_at;

-- name: GetAccountByIdentifier :one
SELECT id,username,username_normalized,email,password_hash,linked_user_id,status,email_verified_at,last_signed_in_at,created_at,updated_at FROM accounts WHERE username_normalized=$1 OR lower(email)=lower($1);

-- name: GetAccountByID :one
SELECT id,username,username_normalized,email,password_hash,linked_user_id,status,email_verified_at,last_signed_in_at,created_at,updated_at FROM accounts WHERE id=$1;

-- name: GetAccountForUser :one
SELECT id,username,username_normalized,email,password_hash,linked_user_id,status,email_verified_at,last_signed_in_at,created_at,updated_at FROM accounts WHERE linked_user_id=$1;

-- name: IsAccountUsernameTaken :one
SELECT EXISTS(SELECT 1 FROM accounts WHERE username_normalized=$1);

-- name: IsAccountEmailTaken :one
SELECT EXISTS(SELECT 1 FROM accounts WHERE lower(email)=lower($1));

-- name: CreateAccountSession :exec
INSERT INTO account_sessions (id,account_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '30 days');

-- name: GetAccountSession :one
SELECT account_id FROM account_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now();

-- name: TouchAccountSession :exec
UPDATE account_sessions SET last_seen_at=now() WHERE token_hash=$1 AND revoked_at IS NULL;

-- name: RevokeAccountSession :exec
UPDATE account_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL;

-- name: RevokeAllAccountSessions :exec
UPDATE account_sessions SET revoked_at=now() WHERE account_id=$1 AND revoked_at IS NULL;

-- name: ListAccountSessions :many
SELECT id,created_at,last_seen_at,expires_at FROM account_sessions WHERE account_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY last_seen_at DESC;

-- name: LinkAccountUser :exec
UPDATE accounts SET linked_user_id=$1,updated_at=now() WHERE id=$2 AND linked_user_id IS NULL;

-- name: UpdateAccountSignedIn :exec
UPDATE accounts SET last_signed_in_at=now(),updated_at=now() WHERE id=$1;

-- name: GetBrowserSessionUser :one
SELECT user_id FROM browser_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now();

-- name: RevokeBrowserSession :exec
UPDATE browser_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL;

-- name: CreateProfile :one
INSERT INTO anonymous_profiles (user_id, username, username_normalized, identity_seed) VALUES ($1,$2,$3,$4) RETURNING user_id, username, username_normalized;

-- name: GetProfileByUsername :one
SELECT user_id, username, username_normalized FROM anonymous_profiles WHERE username_normalized=$1;

-- name: GetOwnProfile :one
SELECT user_id,username,username_normalized,avatar_storage_key,status_message FROM anonymous_profiles WHERE user_id=$1;

-- name: UpdateOwnProfile :one
UPDATE anonymous_profiles SET avatar_storage_key=COALESCE(sqlc.narg('avatar_storage_key'),avatar_storage_key), status_message=COALESCE(sqlc.narg('status_message'),status_message), updated_at=now() WHERE user_id=$1 RETURNING user_id,username,username_normalized,avatar_storage_key,status_message;

-- name: IsUsernameTaken :one
SELECT EXISTS(SELECT 1 FROM anonymous_profiles WHERE username_normalized=$1 AND ($2='' OR user_id<>$2));

-- name: IsProfileCompleted :one
SELECT EXISTS(SELECT 1 FROM anonymous_profiles WHERE user_id=$1 AND onboarding_completed_at IS NOT NULL);

-- name: GetOnboardingResume :one
SELECT oc.step,COALESCE(oc.candidate_username,''),ap.username,ap.username_locked_at,ap.onboarding_completed_at FROM onboarding_checkpoints oc JOIN anonymous_profiles ap ON ap.user_id=oc.user_id WHERE oc.user_id=$1;

-- name: LockUsername :exec
UPDATE anonymous_profiles SET username=$1,username_normalized=$2,username_locked_at=now(),onboarding_completed_at=now(),updated_at=now() WHERE user_id=$3;

-- name: CompleteOnboardingCheckpoint :exec
UPDATE onboarding_checkpoints SET step='complete',candidate_username=$1,updated_at=now() WHERE user_id=$2;

-- name: UpsertCheckpoint :one
INSERT INTO onboarding_checkpoints (user_id, step, candidate_username) VALUES ($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET step=EXCLUDED.step,candidate_username=EXCLUDED.candidate_username,updated_at=now() RETURNING user_id, step, candidate_username;

-- name: CreateDirectSession :one
INSERT INTO chat_sessions (id,direct_pair_key) VALUES ($1,$2) ON CONFLICT(direct_pair_key) DO UPDATE SET last_activity_at=chat_sessions.last_activity_at RETURNING id,direct_pair_key,status,last_activity_at,created_at;

-- name: GetDirectSessionByPair :one
SELECT id,direct_pair_key,status,last_activity_at,created_at FROM chat_sessions WHERE direct_pair_key=$1;

-- name: ListSessions :many
SELECT cs.id,ap.username,cs.last_activity_at,cs.retention_policy,COALESCE(sll.session_id IS NOT NULL,FALSE) AS local_locked FROM chat_sessions cs JOIN session_participants sp ON sp.session_id=cs.id AND sp.user_id=$1 JOIN session_participants other ON other.session_id=cs.id AND other.user_id<>$1 JOIN anonymous_profiles ap ON ap.user_id=other.user_id LEFT JOIN session_local_locks sll ON sll.session_id=cs.id AND sll.user_id=$1 WHERE sp.archived_at IS NULL ORDER BY cs.last_activity_at DESC;

-- name: AddParticipant :exec
INSERT INTO session_participants (session_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING;

-- name: CreateMessage :one
INSERT INTO messages (id,session_id,sender_id,client_operation_id,cursor,kind,body,expires_at) SELECT $1,$2,$3,$4,$5,$6,$7,CASE cs.retention_policy WHEN '24h' THEN now()+interval '24 hours' WHEN '7d' THEN now()+interval '7 days' WHEN '30d' THEN now()+interval '30 days' ELSE NULL END FROM chat_sessions cs WHERE cs.id=$2 ON CONFLICT(sender_id,client_operation_id) DO UPDATE SET body=messages.body RETURNING id,session_id,sender_id,client_operation_id,cursor,kind,body,state,created_at,expires_at;

-- name: ListMessages :many
SELECT id,session_id,sender_id,client_operation_id,cursor,kind,body,state,created_at FROM messages WHERE session_id=$1 ORDER BY cursor DESC LIMIT $2;

-- name: ListMessagesWithMedia :many
SELECT m.id,m.session_id,m.sender_id,m.client_operation_id,m.cursor,m.kind,COALESCE(m.body,''),m.state,m.created_at,m.edited_at,m.deleted_at,m.expires_at,COALESCE((SELECT MAX(other.last_read_cursor) FROM session_participants other WHERE other.session_id=m.session_id AND other.user_id<>$3),0)>=m.cursor AS read,ma.storage_key,ma.file_name,ma.content_type,ma.byte_size FROM messages m LEFT JOIN media_assets ma ON ma.message_id=m.id WHERE m.session_id=$1 AND ($2::bigint=0 OR m.cursor<$2) ORDER BY m.cursor DESC LIMIT 51;

-- name: SearchProfiles :many
SELECT ap.user_id,ap.username FROM anonymous_profiles ap WHERE ap.onboarding_completed_at IS NOT NULL AND ap.user_id<>$1 AND ap.username_normalized ILIKE $2 AND NOT EXISTS (SELECT 1 FROM blocked_users b WHERE (b.blocker_id=$1 AND b.blocked_user_id=ap.user_id) OR (b.blocker_id=ap.user_id AND b.blocked_user_id=$1)) ORDER BY ap.username_normalized LIMIT $3;

-- name: SearchMessages :many
SELECT m.id,m.session_id,m.body,m.cursor,ap.username FROM messages m JOIN session_participants sp ON sp.session_id=m.session_id AND sp.user_id=$1 JOIN session_participants other ON other.session_id=m.session_id AND other.user_id<>$1 JOIN anonymous_profiles ap ON ap.user_id=other.user_id WHERE m.deleted_at IS NULL AND COALESCE(m.body,'') ILIKE $2 ORDER BY m.created_at DESC LIMIT $3;

-- name: SearchSessionMessages :many
SELECT id,session_id,sender_id,body,cursor,state,created_at FROM messages WHERE session_id=$1 AND deleted_at IS NULL AND COALESCE(body,'') ILIKE $2 AND ($3='' OR created_at >= $3::timestamptz) AND ($4='' OR created_at < ($4::date + INTERVAL '1 day')) ORDER BY created_at DESC LIMIT $5 OFFSET $6;

-- name: ListSessionSharedAssets :many
SELECT m.id,m.session_id,m.sender_id,m.body,m.created_at,ma.storage_key,ma.file_name,ma.content_type,ma.byte_size FROM messages m JOIN session_participants sp ON sp.session_id=m.session_id AND sp.user_id=$1 JOIN media_assets ma ON ma.message_id=m.id WHERE m.session_id=$2 AND m.deleted_at IS NULL AND (($3='media' AND (ma.content_type LIKE 'image/%' OR ma.content_type LIKE 'video/%' OR ma.content_type LIKE 'audio/%')) OR ($3='documents' AND ma.content_type NOT LIKE 'image/%' AND ma.content_type NOT LIKE 'video/%' AND ma.content_type NOT LIKE 'audio/%')) ORDER BY m.created_at DESC LIMIT $4 OFFSET $5;

-- name: ListSessionSharedLinks :many
SELECT m.id,m.session_id,m.sender_id,m.body,m.created_at FROM messages m JOIN session_participants sp ON sp.session_id=m.session_id AND sp.user_id=$1 WHERE m.session_id=$2 AND m.deleted_at IS NULL AND COALESCE(m.body,'') ~* 'https?://[^[:space:]]+' ORDER BY m.created_at DESC LIMIT $3 OFFSET $4;

-- name: GetSettings :one
SELECT theme,reduced_motion,send_on_enter,presence_visibility,read_receipts,notifications,avatar_visibility,status_visibility,notification_preview,notification_sound,quiet_hours_enabled,quiet_hours_start,quiet_hours_end,media_auto_download,link_previews_enabled,privacy_checkup_completed_at FROM user_settings WHERE user_id=$1;

-- name: UpdateSettings :exec
UPDATE user_settings SET theme=COALESCE(NULLIF(sqlc.narg('theme'),''),theme), reduced_motion=COALESCE(sqlc.narg('reduced_motion'),reduced_motion), send_on_enter=COALESCE(sqlc.narg('send_on_enter'),send_on_enter), presence_visibility=COALESCE(NULLIF(sqlc.narg('presence_visibility'),''),presence_visibility), read_receipts=COALESCE(sqlc.narg('read_receipts'),read_receipts), notifications=COALESCE(sqlc.narg('notifications'),notifications), avatar_visibility=COALESCE(NULLIF(sqlc.narg('avatar_visibility'),''),avatar_visibility), status_visibility=COALESCE(NULLIF(sqlc.narg('status_visibility'),''),status_visibility), notification_preview=COALESCE(NULLIF(sqlc.narg('notification_preview'),''),notification_preview), notification_sound=COALESCE(sqlc.narg('notification_sound'),notification_sound), quiet_hours_enabled=COALESCE(sqlc.narg('quiet_hours_enabled'),quiet_hours_enabled), quiet_hours_start=COALESCE(sqlc.narg('quiet_hours_start'),quiet_hours_start), quiet_hours_end=COALESCE(sqlc.narg('quiet_hours_end'),quiet_hours_end), media_auto_download=COALESCE(NULLIF(sqlc.narg('media_auto_download'),''),media_auto_download), link_previews_enabled=COALESCE(sqlc.narg('link_previews_enabled'),link_previews_enabled), privacy_checkup_completed_at=CASE WHEN sqlc.narg('privacy_checkup_complete')::boolean THEN now() ELSE privacy_checkup_completed_at END, updated_at=now() WHERE user_id=$1;

-- name: ListOwnExportMessages :many
SELECT m.id,m.session_id,m.kind,COALESCE(m.body,''),m.state,m.created_at,m.edited_at,m.deleted_at FROM messages m WHERE m.sender_id=$1 ORDER BY m.created_at ASC;

-- name: ListOwnExportMedia :many
SELECT ma.id,ma.message_id,ma.storage_key,ma.file_name,ma.content_type,ma.byte_size,ma.created_at FROM media_assets ma JOIN messages m ON m.id=ma.message_id WHERE m.sender_id=$1 ORDER BY ma.created_at ASC;

-- name: CreateDataDeletionRequest :one
INSERT INTO data_rights_requests (id,user_id,request_kind,reference_code) VALUES ($1,$2,'deletion',$3) ON CONFLICT DO NOTHING RETURNING id,request_kind,status,reference_code,confirmed_at,created_at,updated_at;

-- name: ListDataRightsRequests :many
SELECT id,request_kind,status,reference_code,confirmed_at,fulfilled_at,note,created_at,updated_at FROM data_rights_requests WHERE user_id=$1 ORDER BY created_at DESC;

-- name: GetStorageUsage :one
SELECT COALESCE(SUM(ma.byte_size),0)::bigint,COUNT(*)::bigint FROM media_assets ma JOIN messages m ON m.id=ma.message_id WHERE m.sender_id=$1;

-- name: LockMediaUsageOwner :one
SELECT id FROM users WHERE id=$1 FOR UPDATE;

-- name: IsParticipant :one
SELECT EXISTS(SELECT 1 FROM session_participants WHERE session_id=$1 AND user_id=$2);

-- name: GetPeerUserID :one
SELECT other.user_id FROM session_participants self JOIN session_participants other ON other.session_id=self.session_id AND other.user_id<>self.user_id WHERE self.session_id=$1 AND self.user_id=$2;

-- name: IsBlocked :one
SELECT EXISTS(SELECT 1 FROM blocked_users WHERE (blocker_id=$1 AND blocked_user_id=$2) OR (blocker_id=$2 AND blocked_user_id=$1));

-- name: CreateBlock :exec
INSERT INTO blocked_users (blocker_id,blocked_user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING;

-- name: ArchiveSession :exec
UPDATE session_participants SET archived_at=now() WHERE session_id=$1 AND user_id=$2 AND archived_at IS NULL;

-- name: MuteSession :exec
UPDATE session_participants SET muted_until=now()+($1 * interval '1 minute') WHERE session_id=$2 AND user_id=$3;

-- name: CreateReport :exec
INSERT INTO reports (id,reporter_id,reported_user_id,session_id,reason) VALUES ($1,$2,$3,$4,$5);

-- name: CreateReportReceipt :one
INSERT INTO reports (id,reporter_id,reported_user_id,session_id,reason,reference_code) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,reference_code,status,created_at;

-- name: ListOwnReports :many
SELECT id,reference_code,status,reason,created_at FROM reports WHERE reporter_id=$1 ORDER BY created_at DESC LIMIT $2;

-- name: CreateMessageRequest :one
INSERT INTO message_requests (id,sender_user_id,recipient_user_id) VALUES ($1,$2,$3) ON CONFLICT(sender_user_id,recipient_user_id) DO UPDATE SET status='pending',resolved_at=NULL,created_at=now() WHERE message_requests.status IN ('declined','blocked') RETURNING id,sender_user_id,recipient_user_id,status,created_at,resolved_at;

-- name: GetMessageRequestBetween :one
SELECT id,sender_user_id,recipient_user_id,status,created_at,resolved_at
FROM message_requests
WHERE (sender_user_id=$1 AND recipient_user_id=$2)
   OR (sender_user_id=$2 AND recipient_user_id=$1)
ORDER BY created_at DESC
LIMIT 1;

-- name: ListIncomingMessageRequests :many
SELECT mr.id,mr.sender_user_id,ap.username,mr.status,mr.created_at FROM message_requests mr JOIN anonymous_profiles ap ON ap.user_id=mr.sender_user_id WHERE mr.recipient_user_id=$1 AND mr.status='pending' ORDER BY mr.created_at DESC LIMIT $2;

-- name: ResolveMessageRequest :one
UPDATE message_requests SET status=$1,resolved_at=now() WHERE id=$2 AND recipient_user_id=$3 AND status='pending' RETURNING id,sender_user_id,recipient_user_id,status,created_at,resolved_at;

-- name: GetNotificationPreference :one
SELECT notifications_enabled FROM session_participants WHERE session_id=$1 AND user_id=$2;

-- name: SetNotificationPreference :exec
UPDATE session_participants SET notifications_enabled=$1 WHERE session_id=$2 AND user_id=$3;

-- name: NextMessageCursor :one
UPDATE chat_sessions
SET message_cursor=message_cursor+1,last_activity_at=now()
WHERE id=$1
RETURNING message_cursor;

-- name: UpdateMessageBody :one
UPDATE messages SET body=$1, edited_at=now() WHERE id=$2 AND session_id=$3 AND sender_id=$4 AND deleted_at IS NULL RETURNING id,session_id,sender_id,client_operation_id,cursor,kind,body,state,created_at,edited_at,deleted_at,false;

-- name: DeleteMessage :one
UPDATE messages SET body=NULL, state='deleted', deleted_at=now() WHERE id=$1 AND session_id=$2 AND sender_id=$3 AND deleted_at IS NULL RETURNING id;

-- name: GetMessageCursor :one
SELECT cursor FROM messages WHERE id=$1 AND session_id=$2;

-- name: MarkParticipantRead :one
UPDATE session_participants p SET last_read_cursor=GREATEST(p.last_read_cursor,m.cursor) FROM messages m WHERE p.session_id=$1 AND p.user_id=$2 AND m.id=$3 AND m.session_id=$1 RETURNING m.cursor;

-- name: MarkReadMessages :exec
UPDATE messages SET state='read' WHERE session_id=$1 AND sender_id<>$2 AND cursor<=$3 AND state IN ('sent','delivered') AND deleted_at IS NULL;

-- name: MarkDeliveredMessages :exec
UPDATE messages SET state='delivered' WHERE session_id=$1 AND sender_id<>$2 AND state='sent' AND deleted_at IS NULL;

-- name: AddMediaMessage :one
INSERT INTO messages (id,session_id,sender_id,client_operation_id,cursor,kind,body,expires_at) SELECT $1,$2,$3,$4,$5,'media','',CASE cs.retention_policy WHEN '24h' THEN now()+interval '24 hours' WHEN '7d' THEN now()+interval '7 days' WHEN '30d' THEN now()+interval '30 days' ELSE NULL END FROM chat_sessions cs WHERE cs.id=$2 ON CONFLICT(sender_id,client_operation_id) DO UPDATE SET body=messages.body RETURNING id,session_id,sender_id,client_operation_id,cursor,kind,body,state,created_at,edited_at,deleted_at,expires_at,false;

-- name: UpsertMediaAsset :one
INSERT INTO media_assets (id,message_id,storage_key,file_name,content_type,byte_size) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(message_id) DO UPDATE SET message_id=EXCLUDED.message_id RETURNING storage_key,file_name,content_type,byte_size;

-- name: GetMediaMessageByOperation :one
SELECT m.id,m.session_id,m.sender_id,m.client_operation_id,m.cursor,m.kind,COALESCE(m.body,''),m.state,m.created_at,m.edited_at,m.deleted_at,m.expires_at,ma.storage_key,ma.file_name,ma.content_type,ma.byte_size
FROM messages m
JOIN media_assets ma ON ma.message_id=m.id
WHERE m.sender_id=$1 AND m.client_operation_id=$2 AND m.kind='media';

-- name: ListSessionParticipants :many
SELECT user_id FROM session_participants WHERE session_id=$1;

-- name: ClearOwnProfileAvatar :one
UPDATE anonymous_profiles SET avatar_storage_key=NULL, updated_at=now() WHERE user_id=$1 RETURNING user_id,username,username_normalized,avatar_storage_key,status_message;

-- name: GetSessionRetention :one
SELECT retention_policy,retention_updated_at FROM chat_sessions WHERE id=$1;

-- name: SetSessionRetention :exec
UPDATE chat_sessions SET retention_policy=$1,retention_updated_at=now() WHERE id=$2;

-- name: CreateRetentionEvent :exec
INSERT INTO retention_events (id,session_id,actor_user_id,previous_policy,next_policy) VALUES ($1,$2,$3,$4,$5);

-- name: SetSessionLocalLock :exec
INSERT INTO session_local_locks (session_id,user_id) VALUES ($1,$2) ON CONFLICT(session_id,user_id) DO UPDATE SET locked_at=now(),last_verified_at=now();

-- name: RemoveSessionLocalLock :exec
DELETE FROM session_local_locks WHERE session_id=$1 AND user_id=$2;

-- name: ListExpiredMediaForDeletion :many
SELECT ma.id,ma.storage_key FROM media_assets ma JOIN messages m ON m.id=ma.message_id WHERE m.expires_at<=now() AND m.deleted_at IS NULL;

-- name: DeleteMediaAsset :exec
DELETE FROM media_assets WHERE id=$1;

-- name: ExpireDueMessages :many
UPDATE messages SET body=NULL,state='expired',deleted_at=now(),expired_at=now() WHERE expires_at<=now() AND deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.message_id=messages.id) RETURNING id,session_id;
