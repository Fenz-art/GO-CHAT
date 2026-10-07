package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSecurityAddsProductionContentSecurityPolicy(t *testing.T) {
	app := &server{}
	handler := app.security(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))

	if got := recorder.Header().Get("Content-Security-Policy"); got != contentSecurityPolicy {
		t.Fatalf("unexpected Content-Security-Policy: %q", got)
	}
	if got := recorder.Header().Get("X-Frame-Options"); got != "DENY" {
		t.Fatalf("expected frame denial, got %q", got)
	}
}

func TestSecurityAllowsOnlyManusPreviewAncestorsWhenExplicitlyConfigured(t *testing.T) {
	app := &server{cfg: config{allowPreviewEmbedding: true}}
	handler := app.security(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))

	if got := recorder.Header().Get("Content-Security-Policy"); got != previewContentSecurityPolicy {
		t.Fatalf("unexpected preview Content-Security-Policy: %q", got)
	}
	if got := recorder.Header().Get("X-Frame-Options"); got != "" {
		t.Fatalf("expected preview framing to rely on CSP ancestors, got X-Frame-Options %q", got)
	}
}

func TestDecodeJSONRejectsUnknownMultipleAndOversizedBodies(t *testing.T) {
	type payload struct {
		Value string `json:"value"`
	}

	for name, body := range map[string]string{
		"unknown field":      `{"value":"ok","extra":true}`,
		"multiple documents": `{"value":"ok"}{"value":"second"}`,
		"oversized body":     `{"value":"` + strings.Repeat("a", maxJSONBodyBytes) + `"}`,
	} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
			var value payload
			if decodeJSON(request, &value) {
				t.Fatal("expected malformed request body to be rejected")
			}
		})
	}
}

func TestDecodeJSONAcceptsOneKnownDocument(t *testing.T) {
	type payload struct {
		Value string `json:"value"`
	}
	request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"value":"ok"}`))
	var value payload
	if !decodeJSON(request, &value) || value.Value != "ok" {
		t.Fatalf("expected known single document to decode, got %#v", value)
	}
}

func TestNormalizeUsernameLookupAcceptsAnOptionalLeadingAtSign(t *testing.T) {
	for input, expected := range map[string]string{
		"quiet-handle":     "quiet-handle",
		"@quiet-handle":    "quiet-handle",
		"  @Quiet-Handle ": "quiet-handle",
	} {
		if got := normalizeUsernameLookup(input); got != expected {
			t.Fatalf("normalizeUsernameLookup(%q) = %q, want %q", input, got, expected)
		}
	}
}
