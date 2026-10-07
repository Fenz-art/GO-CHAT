package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestPasswordHashRoundTripAndRejection(t *testing.T) {
	hash, err := hashPassword("a-long-private-password")
	if err != nil {
		t.Fatalf("hashPassword() error = %v", err)
	}
	if !verifyPassword(hash, "a-long-private-password") {
		t.Fatal("verifyPassword() rejected the original password")
	}
	if verifyPassword(hash, "different-private-password") {
		t.Fatal("verifyPassword() accepted the wrong password")
	}
}

func TestAccountInputValidation(t *testing.T) {
	for _, username := range []string{"signal-line", "quiet_42", "private9"} {
		if !validAccountUsername(username) {
			t.Fatalf("validAccountUsername(%q) = false", username)
		}
	}
	for _, username := range []string{"ab", "-private", "signal line", "private!"} {
		if validAccountUsername(username) {
			t.Fatalf("validAccountUsername(%q) = true", username)
		}
	}
	if !validEmail("person@example.com") {
		t.Fatal("validEmail() rejected a valid email")
	}
	for _, email := range []string{"not-an-email", "name <person@example.com>", ""} {
		if validEmail(email) {
			t.Fatalf("validEmail(%q) = true", email)
		}
	}
}

func TestPasswordVerifierRejectsMalformedHash(t *testing.T) {
	if verifyPassword("not-a-password-hash", "password") {
		t.Fatal("verifyPassword() accepted a malformed hash")
	}
}

func TestMailConfigRequiresSecurePublicURLAndAuthenticatedSMTP(t *testing.T) {
	cfg := config{
		smtpHost: "smtp.example.com", smtpPort: "587", smtpUsername: "mailer",
		smtpPassword: "secret", emailFrom: "Go Chat <noreply@example.com>",
		publicURL: "https://chat.example.com",
	}
	if err := (&server{cfg: cfg}).validateMailConfig(); err != nil {
		t.Fatalf("validateMailConfig() rejected a valid configuration: %v", err)
	}
	cfg.publicURL = "http://chat.example.com"
	if err := (&server{cfg: cfg}).validateMailConfig(); err == nil {
		t.Fatal("validateMailConfig() accepted a non-TLS public URL")
	}
	cfg.publicURL = "http://localhost:3000"
	if err := (&server{cfg: cfg}).validateMailConfig(); err != nil {
		t.Fatalf("validateMailConfig() rejected a local development URL: %v", err)
	}
	cfg.smtpPort = "70000"
	if err := (&server{cfg: cfg}).validateMailConfig(); err == nil {
		t.Fatal("validateMailConfig() accepted an invalid SMTP port")
	}
}

func TestLocalAuthRateLimitFallbackRemainsBounded(t *testing.T) {
	s := &server{}
	if !s.allowFallbackAuthAttempt("signin:client", 2, time.Minute) {
		t.Fatal("first local fallback attempt was blocked")
	}
	if !s.allowFallbackAuthAttempt("signin:client", 2, time.Minute) {
		t.Fatal("second local fallback attempt was blocked")
	}
	if s.allowFallbackAuthAttempt("signin:client", 2, time.Minute) {
		t.Fatal("local fallback ignored the configured limit")
	}
}

func TestAuthRateLimitHostUsesIntegrationClientOnlyForLoopback(t *testing.T) {
	loopback := httptest.NewRequest(http.MethodPost, "/", nil)
	loopback.RemoteAddr = "127.0.0.1:43210"
	loopback.Header.Set("X-GoChat-Integration-Client", "account-continuity")
	if got := authRateLimitHost(loopback); got != "integration:account-continuity" {
		t.Fatalf("unexpected loopback key: %q", got)
	}

	remote := httptest.NewRequest(http.MethodPost, "/", nil)
	remote.RemoteAddr = "203.0.113.10:43210"
	remote.Header.Set("X-GoChat-Integration-Client", "account-continuity")
	if got := authRateLimitHost(remote); got != "203.0.113.10" {
		t.Fatalf("unexpected remote key: %q", got)
	}
}

func TestRequestUsesHTTPSBehindManagedProxy(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/", nil)
	request.Header.Set("X-Forwarded-Proto", "https")
	if !requestUsesHTTPS(request) {
		t.Fatal("proxy HTTPS request did not receive a secure cookie")
	}
	request.Header.Set("X-Forwarded-Proto", "http")
	if requestUsesHTTPS(request) {
		t.Fatal("plain proxy request received a secure cookie")
	}
}

func TestIdentityLogoutCookieClearsUseProxySafeAttributes(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/api/v1/identity/logout", nil)
	request.Header.Set("X-Forwarded-Proto", "https")
	recorder := httptest.NewRecorder()
	app := &server{}
	app.clearSessionCookie(recorder, request)
	app.clearAccountCookie(recorder, request)
	cookies := recorder.Result().Cookies()
	if len(cookies) != 2 {
		t.Fatalf("expected two cleared cookies, got %d", len(cookies))
	}
	for _, cookie := range cookies {
		if cookie.MaxAge >= 0 || !cookie.Secure || !cookie.HttpOnly || cookie.Path != "/" || cookie.SameSite != http.SameSiteLaxMode {
			t.Fatalf("unexpected clear-cookie attributes for %s: %#v", cookie.Name, cookie)
		}
	}
}

func TestEmbeddedPreviewCookiesUseSecureSameSiteNoneOnlyWhenExplicitlyConfigured(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/api/v1/identity/bootstrap", nil)
	request.Header.Set("X-Forwarded-Proto", "https")
	recorder := httptest.NewRecorder()
	app := &server{cfg: config{allowPreviewEmbedding: true}}
	app.setSessionCookie(recorder, request, "browser-token")
	app.setAccountCookie(recorder, request, "account-token")

	cookies := recorder.Result().Cookies()
	if len(cookies) != 2 {
		t.Fatalf("expected two preview cookies, got %d", len(cookies))
	}
	for _, cookie := range cookies {
		if !cookie.Secure || !cookie.HttpOnly || cookie.Path != "/" || cookie.SameSite != http.SameSiteNoneMode {
			t.Fatalf("unexpected preview cookie attributes for %s: %#v", cookie.Name, cookie)
		}
	}
}
