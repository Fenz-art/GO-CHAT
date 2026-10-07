package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/manus/go-chat/backend/internal/sqlc"
	"github.com/oklog/ulid/v2"
)

type dataExportResponse struct {
	GeneratedAt time.Time             `json:"generatedAt"`
	Messages    []dataExportMessage   `json:"messages"`
	Media       []dataExportMedia     `json:"media"`
	Notice      string                `json:"notice"`
}

type dataExportMessage struct {
	ID        string     `json:"id"`
	SessionID string     `json:"sessionId"`
	Kind      string     `json:"kind"`
	Body      string     `json:"body"`
	State     string     `json:"state"`
	CreatedAt time.Time  `json:"createdAt"`
	EditedAt  *time.Time `json:"editedAt,omitempty"`
	DeletedAt *time.Time `json:"deletedAt,omitempty"`
}

type dataExportMedia struct {
	ID         string    `json:"id"`
	MessageID  string    `json:"messageId"`
	StorageKey string    `json:"storageKey"`
	FileName   string    `json:"fileName"`
	ContentType string   `json:"contentType"`
	ByteSize   int64     `json:"byteSize"`
	CreatedAt  time.Time `json:"createdAt"`
}

type dataRightsRequestResponse struct {
	ID            string     `json:"id"`
	Kind          string     `json:"kind"`
	Status        string     `json:"status"`
	ReferenceCode string     `json:"referenceCode"`
	ConfirmedAt   time.Time  `json:"confirmedAt"`
	FulfilledAt   *time.Time `json:"fulfilledAt,omitempty"`
	Note          string     `json:"note,omitempty"`
	CreatedAt     time.Time  `json:"createdAt"`
	UpdatedAt     time.Time  `json:"updatedAt"`
}

func (s *server) dataExport(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Create or resume an identity before exporting data")
		return
	}
	messages, err := s.queries.ListOwnExportMessages(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "export_failed", "Could not prepare your data export")
		return
	}
	media, err := s.queries.ListOwnExportMedia(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "export_failed", "Could not prepare your data export")
		return
	}
	export := dataExportResponse{GeneratedAt: time.Now().UTC(), Messages: make([]dataExportMessage, 0, len(messages)), Media: make([]dataExportMedia, 0, len(media)), Notice: "This export contains messages you authored and opaque storage references for media you uploaded. It never includes signed file URLs, account secrets, or another person’s private profile data."}
	for _, message := range messages {
		export.Messages = append(export.Messages, dataExportMessage{ID: message.ID, SessionID: message.SessionID, Kind: message.Kind, Body: message.Body, State: message.State, CreatedAt: message.CreatedAt.Time, EditedAt: optionalTimestamp(message.EditedAt), DeletedAt: optionalTimestamp(message.DeletedAt)})
	}
	for _, item := range media {
		export.Media = append(export.Media, dataExportMedia{ID: item.ID, MessageID: item.MessageID, StorageKey: item.StorageKey, FileName: item.FileName, ContentType: item.ContentType, ByteSize: item.ByteSize, CreatedAt: item.CreatedAt.Time})
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", "attachment; filename=go-chat-data-export.json")
	if err := json.NewEncoder(w).Encode(export); err != nil {
		s.log.Warn("data export response write failed", "error", err)
	}
}

func (s *server) dataRightsRoute(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Create or resume an identity before managing data rights")
		return
	}
	if r.Method == http.MethodPost {
		var input struct {
			Confirm string `json:"confirm"`
		}
		if !decodeJSON(r, &input) || input.Confirm != "DELETE MY DATA" {
			writeError(w, http.StatusBadRequest, "confirmation_required", "Type DELETE MY DATA to submit a deletion request")
			return
		}
		request, err := s.queries.CreateDataDeletionRequest(r.Context(), sqlc.CreateDataDeletionRequestParams{ID: ulid.Make().String(), UserID: userID, ReferenceCode: "DATA-" + ulid.Make().String()[16:]})
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusConflict, "request_pending", "A deletion request is already pending")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "request_failed", "Could not submit your deletion request")
			return
		}
		writeJSON(w, http.StatusCreated, dataRightsRequestResponse{ID: request.ID, Kind: request.RequestKind, Status: request.Status, ReferenceCode: request.ReferenceCode, ConfirmedAt: request.ConfirmedAt.Time, CreatedAt: request.CreatedAt.Time, UpdatedAt: request.UpdatedAt.Time})
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Unsupported data-rights operation")
		return
	}
	requests, err := s.queries.ListDataRightsRequests(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "requests_failed", "Could not load your data-rights requests")
		return
	}
	items := make([]dataRightsRequestResponse, 0, len(requests))
	for _, request := range requests {
		items = append(items, dataRightsRequestResponse{ID: request.ID, Kind: request.RequestKind, Status: request.Status, ReferenceCode: request.ReferenceCode, ConfirmedAt: request.ConfirmedAt.Time, FulfilledAt: optionalTimestamp(request.FulfilledAt), Note: request.Note.String, CreatedAt: request.CreatedAt.Time, UpdatedAt: request.UpdatedAt.Time})
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func optionalTimestamp(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	result := value.Time
	return &result
}
