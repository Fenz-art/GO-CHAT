package main

import (
	"context"
	"crypto/subtle"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/manus/go-chat/backend/internal/sqlc"
	"github.com/minio/minio-go/v7"
	"github.com/oklog/ulid/v2"
)

type retentionResponse struct {
	Policy    string     `json:"policy"`
	UpdatedAt *time.Time `json:"updatedAt,omitempty"`
}

type retentionSweepResult struct {
	ExpiredMessages int `json:"expiredMessages"`
	DeletedMedia    int `json:"deletedMedia"`
	MediaFailures   int `json:"mediaFailures"`
}

func (s *server) retentionRoute(w http.ResponseWriter, r *http.Request, sessionID string) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Create or resume an identity first")
		return
	}
	participant, err := s.queries.IsParticipant(r.Context(), sqlc.IsParticipantParams{SessionID: sessionID, UserID: userID})
	if err != nil || !participant {
		writeError(w, http.StatusForbidden, "retention_forbidden", "You are not in this conversation")
		return
	}
	if r.Method == http.MethodGet {
		current, err := s.queries.GetSessionRetention(r.Context(), sessionID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "retention_failed", "Could not load retention policy")
			return
		}
		writeJSON(w, http.StatusOK, retentionResponse{Policy: current.RetentionPolicy, UpdatedAt: optionalTimestamp(current.RetentionUpdatedAt)})
		return
	}
	if r.Method != http.MethodPatch {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Unsupported retention operation")
		return
	}
	var input struct {
		Policy string `json:"policy"`
	}
	if !decodeJSON(r, &input) || !validRetentionPolicy(input.Policy) {
		writeError(w, http.StatusBadRequest, "invalid_retention", "Retention must be keep, 24h, 7d, or 30d")
		return
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "retention_failed", "Could not update retention policy")
		return
	}
	defer tx.Rollback(r.Context())
	queries := sqlc.New(tx)
	previous, err := queries.GetSessionRetention(r.Context(), sessionID)
	if err == nil {
		err = queries.SetSessionRetention(r.Context(), sqlc.SetSessionRetentionParams{RetentionPolicy: input.Policy, ID: sessionID})
	}
	if err == nil && previous.RetentionPolicy != input.Policy {
		err = queries.CreateRetentionEvent(r.Context(), sqlc.CreateRetentionEventParams{ID: ulid.Make().String(), SessionID: sessionID, ActorUserID: userID, PreviousPolicy: previous.RetentionPolicy, NextPolicy: input.Policy})
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "retention_failed", "Could not update retention policy")
		return
	}
	updated, err := s.queries.GetSessionRetention(r.Context(), sessionID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "retention_failed", "Could not load retention policy")
		return
	}
	writeJSON(w, http.StatusOK, retentionResponse{Policy: updated.RetentionPolicy, UpdatedAt: optionalTimestamp(updated.RetentionUpdatedAt)})
}

func (s *server) sessionLockRoute(w http.ResponseWriter, r *http.Request, sessionID, action string) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Create or resume an identity first")
		return
	}
	participant, err := s.queries.IsParticipant(r.Context(), sqlc.IsParticipantParams{SessionID: sessionID, UserID: userID})
	if err != nil || !participant {
		writeError(w, http.StatusForbidden, "lock_forbidden", "You are not in this conversation")
		return
	}
	account, ok := s.authenticatedAccount(r)
	if !ok || !account.LinkedUserID.Valid || account.LinkedUserID.String != userID {
		writeError(w, http.StatusForbidden, "account_required", "Sign in to your linked account before managing a local chat lock")
		return
	}
	var input struct {
		Password string `json:"password"`
	}
	if !decodeJSON(r, &input) || !verifyPassword(account.PasswordHash, input.Password) {
		writeError(w, http.StatusUnauthorized, "reauthentication_required", "Confirm your account password to continue")
		return
	}
	if action == "lock" {
		err = s.queries.SetSessionLocalLock(r.Context(), sqlc.SetSessionLocalLockParams{SessionID: sessionID, UserID: userID})
	} else {
		err = s.queries.RemoveSessionLocalLock(r.Context(), sqlc.RemoveSessionLocalLockParams{SessionID: sessionID, UserID: userID})
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "lock_failed", "Could not update the local chat lock")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessionId": sessionID, "localLocked": action == "lock"})
}

func (s *server) scheduledRetentionSweep(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Token string `json:"token"`
	}
	if !decodeJSON(r, &input) || subtle.ConstantTimeCompare([]byte(input.Token), []byte(s.cfg.retentionSweepToken)) != 1 {
		writeError(w, http.StatusForbidden, "scheduled_forbidden", "Scheduled retention access denied")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	result, err := s.runRetentionSweep(ctx)
	if err != nil {
		s.log.Error("scheduled retention sweep failed", "error", err)
		writeError(w, http.StatusInternalServerError, "retention_sweep_failed", "Retention sweep could not complete")
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *server) runRetentionSweep(ctx context.Context) (retentionSweepResult, error) {
	result := retentionSweepResult{}
	media, err := s.queries.ListExpiredMediaForDeletion(ctx)
	if err != nil {
		return result, err
	}
	for _, asset := range media {
		if err := s.s3.RemoveObject(ctx, s.s3Bucket, asset.StorageKey, minio.RemoveObjectOptions{}); err != nil {
			result.MediaFailures++
			s.log.Warn("expired media deletion failed", "assetID", asset.ID, "error", err)
			continue
		}
		if err := s.queries.DeleteMediaAsset(ctx, asset.ID); err != nil {
			return result, err
		}
		result.DeletedMedia++
	}
	expired, err := s.queries.ExpireDueMessages(ctx)
	if err != nil {
		return result, err
	}
	result.ExpiredMessages = len(expired)
	return result, nil
}

func validRetentionPolicy(value string) bool { return value == "keep" || value == "24h" || value == "7d" || value == "30d" }

func isNoRows(err error) bool { return err == pgx.ErrNoRows }
