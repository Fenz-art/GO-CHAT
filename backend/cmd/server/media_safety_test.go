package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestInspectMediaUploadAcceptsMatchingSignaturesAndRejectsMismatches(t *testing.T) {
	tests := []struct {
		name        string
		prefix      []byte
		declared    string
		wantType    string
		wantExt     string
		shouldError bool
	}{
		{name: "png", prefix: []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}, declared: "image/png", wantType: "image/png", wantExt: ".png"},
		{name: "jpeg mismatch", prefix: []byte{0xff, 0xd8, 0xff, 0x00}, declared: "image/png", shouldError: true},
		{name: "webm voice", prefix: []byte{0x1a, 0x45, 0xdf, 0xa3, 0x9f}, declared: "audio/webm", wantType: "audio/webm", wantExt: ".webm"},
		{name: "unrecognized executable", prefix: []byte("MZ\x90\x00"), declared: "application/octet-stream", shouldError: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			gotType, gotExt, err := inspectMediaUpload(test.prefix, test.declared)
			if test.shouldError {
				if err == nil {
					t.Fatal("expected content inspection to reject the upload")
				}
				return
			}
			if err != nil {
				t.Fatalf("inspectMediaUpload returned %v", err)
			}
			if gotType != test.wantType || gotExt != test.wantExt {
				t.Fatalf("got (%q, %q), want (%q, %q)", gotType, gotExt, test.wantType, test.wantExt)
			}
		})
	}
}

func TestNormalizedMediaFileNameUsesDetectedExtension(t *testing.T) {
	if got := normalizedMediaFileName("../invoice.exe", ".pdf"); got != "invoice.pdf" {
		t.Fatalf("unexpected normalized name %q", got)
	}
	if got := normalizedMediaFileName("\x00", ".txt"); got != "upload.txt" {
		t.Fatalf("unexpected fallback normalized name %q", got)
	}
}

func TestMediaUploadLimiterFallsBackLocallyWhenRedisIsUnavailable(t *testing.T) {
	app := &server{}
	request := httptest.NewRequest(http.MethodPost, "/", nil)
	request.RemoteAddr = "198.51.100.24:43210"
	for attempt := 0; attempt < 12; attempt++ {
		if !app.allowMediaUpload(request, "user-one") {
			t.Fatalf("attempt %d was unexpectedly rate limited", attempt+1)
		}
	}
	if app.allowMediaUpload(request, "user-one") {
		t.Fatal("local media limiter ignored the configured limit")
	}
}

func TestCanStoreOwnedMediaHonorsOwnerQuotaBoundary(t *testing.T) {
	if !canStoreOwnedMedia(maxOwnedMediaBytes-(2<<20), 2<<20) {
		t.Fatal("expected an upload that exactly reaches the owner quota to be accepted")
	}
	if canStoreOwnedMedia(maxOwnedMediaBytes-(2<<20)+1, 2<<20) {
		t.Fatal("expected an upload above the owner quota to be rejected")
	}
	if canStoreOwnedMedia(0, 0) {
		t.Fatal("expected empty uploads to be rejected")
	}
}

func TestUploadedMediaCleanupCoversPersistenceFailureAndIdempotentRace(t *testing.T) {
	if !shouldCleanupUploadedMedia(errors.New("persistence failed"), "", "new-object") {
		t.Fatal("expected a persistence failure to remove the uploaded object")
	}
	if !shouldCleanupUploadedMedia(nil, "existing-object", "new-object") {
		t.Fatal("expected a race-resolved idempotent retry to remove its newly uploaded object")
	}
	if shouldCleanupUploadedMedia(nil, "new-object", "new-object") {
		t.Fatal("expected the newly persisted object to remain in storage")
	}
	removed := ""
	if err := cleanupUploadedMedia("new-object", func(_ context.Context, key string) error { removed = key; return nil }); err != nil {
		t.Fatalf("cleanup helper returned %v", err)
	}
	if removed != "new-object" {
		t.Fatalf("cleanup removed %q, want new-object", removed)
	}
}
