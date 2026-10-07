package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/mail"
	"net/smtp"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/manus/go-chat/backend/internal/sqlc"
	"github.com/oklog/ulid/v2"
	"golang.org/x/crypto/argon2"
)

const accountCookie = "gochat_account"

const (
	argonTime    uint32 = 3
	argonMemory  uint32 = 64 * 1024
	argonThreads uint8  = 2
	argonKeyLen  uint32 = 32
)

type accountResponse struct {
	ID             string `json:"id"`
	Username       string `json:"username"`
	Email          string `json:"email"`
	EmailVerified  bool   `json:"emailVerified"`
	LinkedIdentity string `json:"linkedIdentity"`
}

type authRateLimitFallback struct {
	count   int64
	resetAt time.Time
}

func (s *server) accountRoute(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		s.accountRegister(w, r)
	case http.MethodGet:
		s.accountMe(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Unsupported account operation")
	}
}

func (s *server) accountLogin(w http.ResponseWriter, r *http.Request) {
	if !s.allowAuthAttempt(r, "signin", 8, 15*time.Minute) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "Try again later")
		return
	}
	var input struct {
		Identifier string `json:"identifier"`
		Password   string `json:"password"`
	}
	if !decodeJSON(r, &input) || strings.TrimSpace(input.Identifier) == "" || input.Password == "" {
		writeError(w, http.StatusBadRequest, "invalid_credentials", "Enter your username or email and password")
		return
	}
	account, err := s.queries.GetAccountByIdentifier(r.Context(), normalize(input.Identifier))
	if errors.Is(err, pgx.ErrNoRows) || !verifyPassword(account.PasswordHash, input.Password) || account.Status != "active" {
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "Username, email, or password is incorrect")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "login_failed", "Could not sign in")
		return
	}
	if !account.LinkedUserID.Valid {
		writeError(w, http.StatusConflict, "identity_unavailable", "This account has no linked Go Chat identity")
		return
	}
	if currentUser, ok := s.authenticatedUser(r); ok && currentUser != account.LinkedUserID.String {
		writeError(w, http.StatusConflict, "identity_link_conflict", "Finish or sign out of the current anonymous identity before signing in")
		return
	}
	if err := s.issueAccountAndBrowserSessions(w, r, account.ID, account.LinkedUserID.String, true); err != nil {
		writeError(w, http.StatusInternalServerError, "login_failed", "Could not create a secure session")
		return
	}
	if err := s.queries.UpdateAccountSignedIn(r.Context(), account.ID); err != nil {
		s.log.Warn("account sign-in timestamp update failed", "error", err)
	}
	writeJSON(w, http.StatusOK, accountResponse{ID: account.ID, Username: account.Username, Email: account.Email, EmailVerified: account.EmailVerifiedAt.Valid, LinkedIdentity: account.LinkedUserID.String})
}

func (s *server) accountRegister(w http.ResponseWriter, r *http.Request) {
	if !s.allowAuthAttempt(r, "signup", 4, 15*time.Minute) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "Try again later")
		return
	}
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "anonymous_identity_required", "Create or resume an anonymous identity before creating an account")
		return
	}
	if _, err := s.queries.GetAccountForUser(r.Context(), pgtype.Text{String: userID, Valid: true}); err == nil {
		writeError(w, http.StatusConflict, "account_exists", "This identity already has an account")
		return
	} else if !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusInternalServerError, "account_failed", "Could not check account status")
		return
	}
	var input struct {
		Username string `json:"username"`
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decodeJSON(r, &input) || !validAccountUsername(input.Username) || !validEmail(input.Email) || len(input.Password) < 12 || len(input.Password) > 128 {
		writeError(w, http.StatusBadRequest, "invalid_account", "Use a 3–32 character username, valid email, and 12–128 character password")
		return
	}
	username := strings.TrimSpace(input.Username)
	email := strings.ToLower(strings.TrimSpace(input.Email))
	usernameTaken, err := s.queries.IsAccountUsernameTaken(r.Context(), normalize(username))
	if err != nil || usernameTaken {
		code, message := "account_failed", "Could not create account"
		if usernameTaken {
			code, message = "username_taken", "That account username is unavailable"
		}
		writeError(w, http.StatusConflict, code, message)
		return
	}
	emailTaken, err := s.queries.IsAccountEmailTaken(r.Context(), email)
	if err != nil || emailTaken {
		code, message := "account_failed", "Could not create account"
		if emailTaken {
			code, message = "email_taken", "That email already has an account"
		}
		writeError(w, http.StatusConflict, code, message)
		return
	}
	passwordHash, err := hashPassword(input.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "account_failed", "Could not secure the password")
		return
	}
	accountID := ulid.Make().String()
	account, err := s.queries.CreateAccount(r.Context(), sqlc.CreateAccountParams{ID: accountID, Username: username, UsernameNormalized: normalize(username), Email: email, PasswordHash: passwordHash, LinkedUserID: pgtype.Text{String: userID, Valid: true}})
	if err != nil {
		writeError(w, http.StatusConflict, "account_unavailable", "Account username or email is unavailable")
		return
	}
	if err := s.issueAccountAndBrowserSessions(w, r, account.ID, userID, true); err != nil {
		writeError(w, http.StatusInternalServerError, "account_failed", "Could not create a secure session")
		return
	}
	if err := s.sendAccountVerification(r.Context(), account); err != nil && s.log != nil {
		s.log.Warn("account verification email delivery failed", "account_id", account.ID, "error", err)
	}
	writeJSON(w, http.StatusCreated, accountResponse{ID: account.ID, Username: account.Username, Email: account.Email, EmailVerified: account.EmailVerifiedAt.Valid, LinkedIdentity: userID})
}

func (s *server) accountMe(w http.ResponseWriter, r *http.Request) {
	account, ok := s.authenticatedAccount(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Sign in to view account settings")
		return
	}
	linked := ""
	if account.LinkedUserID.Valid {
		linked = account.LinkedUserID.String
	}
	writeJSON(w, http.StatusOK, accountResponse{ID: account.ID, Username: account.Username, Email: account.Email, EmailVerified: account.EmailVerifiedAt.Valid, LinkedIdentity: linked})
}

func (s *server) accountSessionRoute(w http.ResponseWriter, r *http.Request) {
	account, ok := s.authenticatedAccount(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Sign in to manage account sessions")
		return
	}
	switch r.Method {
	case http.MethodGet:
		rows, err := s.db.Query(r.Context(), `SELECT id, created_at, last_seen_at, expires_at, (token_hash=$2) AS is_current FROM account_sessions WHERE account_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY last_seen_at DESC`, account.ID, accountSessionHash(r))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "sessions_failed", "Could not load account sessions")
			return
		}
		defer rows.Close()
		items := make([]map[string]any, 0)
		for rows.Next() {
			var id string
			var createdAt, lastSeenAt, expiresAt time.Time
			var isCurrent bool
			if err := rows.Scan(&id, &createdAt, &lastSeenAt, &expiresAt, &isCurrent); err != nil {
				writeError(w, http.StatusInternalServerError, "sessions_failed", "Could not load account sessions")
				return
			}
			items = append(items, map[string]any{"id": id, "createdAt": createdAt, "lastSeenAt": lastSeenAt, "expiresAt": expiresAt, "isCurrent": isCurrent})
		}
		if err := rows.Err(); err != nil {
			writeError(w, http.StatusInternalServerError, "sessions_failed", "Could not load account sessions")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": items})
	case http.MethodDelete:
		if err := s.revokeAccountSessions(r.Context(), account.ID); err != nil {
			writeError(w, http.StatusInternalServerError, "signout_failed", "Could not sign out sessions")
			return
		}
		s.clearAccountCookie(w, r)
		s.clearSessionCookie(w, r)
		s.disconnectUserSessions(account.LinkedUserID.String)
		writeJSON(w, http.StatusOK, map[string]any{"signedOut": "all"})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Unsupported account session operation")
	}
}

func (s *server) accountLogout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(accountCookie); err == nil {
		if err := s.queries.RevokeAccountSession(r.Context(), hash(cookie.Value)); err != nil {
			s.log.Warn("account session revoke failed", "error", err)
		}
	}
	s.clearAccountCookie(w, r)
	writeJSON(w, http.StatusOK, map[string]any{"signedOut": true, "anonymousIdentityPreserved": true})
}

func (s *server) sendAccountVerification(ctx context.Context, account sqlc.Account) error {
	if account.EmailVerifiedAt.Valid {
		return nil
	}
	return s.sendRecoveryToken(ctx, account, "email_verification", 24*time.Hour)
}

func (s *server) sendRecoveryToken(ctx context.Context, account sqlc.Account, kind string, lifetime time.Duration) error {
	if err := s.validateMailConfig(); err != nil {
		return err
	}
	token := randomToken(32)
	tokenHash := hash(token)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE account_recovery_tokens SET used_at=now() WHERE account_id=$1 AND kind=$2 AND used_at IS NULL`, account.ID, kind); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO account_recovery_tokens (id,account_id,token_hash,kind,expires_at) VALUES ($1,$2,$3,$4,now()+$5 * interval '1 second')`, ulid.Make().String(), account.ID, tokenHash, kind, lifetime.Seconds()); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if err := s.sendRecoveryEmail(account.Email, kind, token); err != nil {
		if _, consumeErr := s.db.Exec(ctx, `UPDATE account_recovery_tokens SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL`, tokenHash); consumeErr != nil && s.log != nil {
			s.log.Error("could not invalidate undelivered recovery token", "account_id", account.ID, "error", consumeErr)
		}
		return err
	}
	return nil
}

func (s *server) validateMailConfig() error {
	if s.cfg.smtpHost == "" || s.cfg.smtpPort == "" || s.cfg.smtpUsername == "" || s.cfg.smtpPassword == "" || s.cfg.emailFrom == "" || s.cfg.publicURL == "" {
		return errors.New("SMTP and public URL settings are incomplete")
	}
	port, err := strconv.Atoi(s.cfg.smtpPort)
	if err != nil || port < 1 || port > 65535 {
		return errors.New("SMTP port is invalid")
	}
	if strings.TrimSpace(s.cfg.smtpHost) != s.cfg.smtpHost || strings.ContainsAny(s.cfg.smtpHost, "\r\n /") {
		return errors.New("SMTP host is invalid")
	}
	if _, err := mail.ParseAddress(s.cfg.emailFrom); err != nil {
		return errors.New("sender email address is invalid")
	}
	baseURL, err := url.Parse(s.cfg.publicURL)
	if err != nil || baseURL.Host == "" || baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" {
		return errors.New("public URL is invalid")
	}
	ip := net.ParseIP(baseURL.Hostname())
	if baseURL.Scheme != "https" && !(baseURL.Scheme == "http" && (baseURL.Hostname() == "localhost" || ip != nil && ip.IsLoopback())) {
		return errors.New("public URL must use HTTPS")
	}
	return nil
}

func (s *server) sendRecoveryEmail(recipient, kind, token string) error {
	sender, err := mail.ParseAddress(s.cfg.emailFrom)
	if err != nil {
		return errors.New("sender email address is invalid")
	}
	baseURL, err := url.Parse(strings.TrimRight(s.cfg.publicURL, "/"))
	if err != nil {
		return errors.New("public URL is invalid")
	}
	path := "/verify-email"
	subject := "Verify your Go Chat recovery email"
	instructions := "Confirm this email address to use it for account recovery."
	if kind == "password_reset" {
		path = "/reset-password"
		subject = "Reset your Go Chat password"
		instructions = "Use this one-time link to choose a new password."
	}
	link := *baseURL
	link.Path = strings.TrimRight(link.Path, "/") + path
	query := link.Query()
	query.Set("token", token)
	link.RawQuery = query.Encode()
	message := strings.Join([]string{
		"From: " + sender.String(),
		"To: " + recipient,
		"Subject: " + subject,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"",
		instructions,
		"",
		link.String(),
		"",
		"If you did not request this, you can ignore this email.",
	}, "\r\n")
	port, _ := strconv.Atoi(s.cfg.smtpPort)
	address := net.JoinHostPort(s.cfg.smtpHost, s.cfg.smtpPort)
	var connection net.Conn
	if port == 465 {
		connection, err = tls.DialWithDialer(&net.Dialer{Timeout: 8 * time.Second}, "tcp", address, &tls.Config{ServerName: s.cfg.smtpHost, MinVersion: tls.VersionTLS12})
	} else {
		connection, err = net.DialTimeout("tcp", address, 8*time.Second)
	}
	if err != nil {
		return fmt.Errorf("connect to mail server: %w", err)
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(12 * time.Second))
	client, err := smtp.NewClient(connection, s.cfg.smtpHost)
	if err != nil {
		return fmt.Errorf("start mail session: %w", err)
	}
	defer client.Close()
	if port != 465 {
		if supported, _ := client.Extension("STARTTLS"); !supported {
			return errors.New("mail server does not offer STARTTLS")
		}
		if err := client.StartTLS(&tls.Config{ServerName: s.cfg.smtpHost, MinVersion: tls.VersionTLS12}); err != nil {
			return fmt.Errorf("start TLS for mail: %w", err)
		}
	}
	if err := client.Auth(smtp.PlainAuth("", s.cfg.smtpUsername, s.cfg.smtpPassword, s.cfg.smtpHost)); err != nil {
		return fmt.Errorf("authenticate with mail server: %w", err)
	}
	if err := client.Mail(sender.Address); err != nil {
		return fmt.Errorf("set mail sender: %w", err)
	}
	if err := client.Rcpt(recipient); err != nil {
		return fmt.Errorf("set mail recipient: %w", err)
	}
	writer, err := client.Data()
	if err != nil {
		return fmt.Errorf("open mail body: %w", err)
	}
	if _, err := writer.Write([]byte(message)); err != nil {
		_ = writer.Close()
		return fmt.Errorf("write mail body: %w", err)
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("send mail body: %w", err)
	}
	return client.Quit()
}

func accountSessionHash(r *http.Request) string {
	cookie, err := r.Cookie(accountCookie)
	if err != nil {
		return ""
	}
	return hash(cookie.Value)
}

func (s *server) revokeAccountSessionRoute(w http.ResponseWriter, r *http.Request) {
	account, ok := s.authenticatedAccount(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Sign in to manage account sessions")
		return
	}
	sessionID := strings.TrimSpace(r.PathValue("sessionID"))
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "session_revoke_failed", "Could not revoke that account session")
		return
	}
	defer tx.Rollback(r.Context())
	var browserSessionID string
	var isCurrent bool
	err = tx.QueryRow(r.Context(), `UPDATE account_sessions SET revoked_at=now() WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL RETURNING COALESCE(browser_session_id,''), token_hash=$3`, sessionID, account.ID, accountSessionHash(r)).Scan(&browserSessionID, &isCurrent)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "session_not_found", "That active account session was not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "session_revoke_failed", "Could not revoke that account session")
		return
	}
	if browserSessionID != "" {
		if _, err := tx.Exec(r.Context(), `UPDATE browser_sessions SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL`, browserSessionID); err != nil {
			writeError(w, http.StatusInternalServerError, "session_revoke_failed", "Could not revoke that account session")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "session_revoke_failed", "Could not revoke that account session")
		return
	}
	if browserSessionID != "" {
		s.disconnectBrowserSession(browserSessionID)
	}
	if isCurrent {
		s.clearAccountCookie(w, r)
		s.clearSessionCookie(w, r)
	}
	writeJSON(w, http.StatusOK, map[string]any{"revoked": true, "currentSession": isCurrent})
}

func (s *server) revokeAccountSessions(ctx context.Context, accountID string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE browser_sessions SET revoked_at=now() WHERE id IN (SELECT browser_session_id FROM account_sessions WHERE account_id=$1 AND revoked_at IS NULL AND browser_session_id IS NOT NULL) AND revoked_at IS NULL`, accountID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE account_sessions SET revoked_at=now() WHERE account_id=$1 AND revoked_at IS NULL`, accountID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *server) sendEmailVerification(w http.ResponseWriter, r *http.Request) {
	account, ok := s.authenticatedAccount(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Sign in to verify your recovery email")
		return
	}
	if account.EmailVerifiedAt.Valid {
		writeJSON(w, http.StatusOK, map[string]any{"verified": true})
		return
	}
	if !s.allowAuthAttempt(r, "email-verification", 4, 15*time.Minute) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "Try again later")
		return
	}
	if err := s.sendAccountVerification(r.Context(), account); err != nil {
		if s.log != nil {
			s.log.Warn("account verification email delivery failed", "account_id", account.ID, "error", err)
		}
		writeError(w, http.StatusServiceUnavailable, "email_delivery_unavailable", "Could not send a verification email. Try again later.")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"sent": true})
}

func (s *server) requestPasswordReset(w http.ResponseWriter, r *http.Request) {
	if !s.allowAuthAttempt(r, "password-reset", 8, 15*time.Minute) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "Try again later")
		return
	}
	if err := s.validateMailConfig(); err != nil {
		writeError(w, http.StatusServiceUnavailable, "recovery_unavailable", "Password recovery is not configured yet. Try again later.")
		return
	}
	var input struct {
		Email string `json:"email"`
	}
	if !decodeJSON(r, &input) || !validEmail(input.Email) {
		writeError(w, http.StatusBadRequest, "invalid_email", "Enter the email address for your account")
		return
	}
	email := strings.ToLower(strings.TrimSpace(input.Email))
	if !s.allowRateAttempt(r, "gochat:auth:password-reset-email:"+hash(email), "password reset email", 3, 15*time.Minute) {
		writeJSON(w, http.StatusAccepted, map[string]any{"message": passwordResetGenericMessage})
		return
	}
	account, err := s.queries.GetAccountByIdentifier(r.Context(), email)
	if err == nil && account.Status == "active" && account.EmailVerifiedAt.Valid {
		if tokenErr := s.sendRecoveryToken(r.Context(), account, "password_reset", 30*time.Minute); tokenErr != nil && s.log != nil {
			s.log.Warn("password reset email delivery failed", "account_id", account.ID, "error", tokenErr)
		}
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"message": passwordResetGenericMessage})
}

const passwordResetGenericMessage = "If a verified account uses that email, password reset instructions will be sent."

func (s *server) confirmPasswordReset(w http.ResponseWriter, r *http.Request) {
	if !s.allowAuthAttempt(r, "password-reset-confirm", 8, 15*time.Minute) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "Try again later")
		return
	}
	var input struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if !decodeJSON(r, &input) || len(input.Password) < 12 || len(input.Password) > 128 || len(input.Token) < 32 || len(input.Token) > 128 {
		writeError(w, http.StatusBadRequest, "invalid_reset", "Use a valid reset link and a 12–128 character password")
		return
	}
	passwordHash, err := hashPassword(input.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "password_reset_failed", "Could not secure the new password")
		return
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "password_reset_failed", "Could not reset the password")
		return
	}
	defer tx.Rollback(r.Context())
	var accountID string
	err = tx.QueryRow(r.Context(), `UPDATE account_recovery_tokens SET used_at=now() WHERE token_hash=$1 AND kind='password_reset' AND used_at IS NULL AND expires_at>now() RETURNING account_id`, hash(input.Token)).Scan(&accountID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusBadRequest, "invalid_reset", "This password reset link is invalid or expired")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "password_reset_failed", "Could not reset the password")
		return
	}
	var linkedUserID string
	if err := tx.QueryRow(r.Context(), `UPDATE accounts SET password_hash=$1, updated_at=now() WHERE id=$2 AND status='active' RETURNING linked_user_id`, passwordHash, accountID).Scan(&linkedUserID); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_reset", "This password reset link is invalid or expired")
		return
	}
	if _, err := tx.Exec(r.Context(), `UPDATE account_recovery_tokens SET used_at=now() WHERE account_id=$1 AND used_at IS NULL`, accountID); err != nil {
		writeError(w, http.StatusInternalServerError, "password_reset_failed", "Could not reset the password")
		return
	}
	if _, err := tx.Exec(r.Context(), `UPDATE account_sessions SET revoked_at=now() WHERE account_id=$1 AND revoked_at IS NULL`, accountID); err != nil {
		writeError(w, http.StatusInternalServerError, "password_reset_failed", "Could not reset the password")
		return
	}
	if _, err := tx.Exec(r.Context(), `UPDATE browser_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, linkedUserID); err != nil {
		writeError(w, http.StatusInternalServerError, "password_reset_failed", "Could not reset the password")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "password_reset_failed", "Could not reset the password")
		return
	}
	s.clearAccountCookie(w, r)
	s.clearSessionCookie(w, r)
	s.disconnectUserSessions(linkedUserID)
	writeJSON(w, http.StatusOK, map[string]any{"reset": true, "sessionsRevoked": true})
}

func (s *server) confirmEmailVerification(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Token string `json:"token"`
	}
	if !decodeJSON(r, &input) || len(input.Token) < 32 || len(input.Token) > 128 {
		writeError(w, http.StatusBadRequest, "invalid_verification", "This verification link is invalid or expired")
		return
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "verification_failed", "Could not verify the recovery email")
		return
	}
	defer tx.Rollback(r.Context())
	var accountID string
	err = tx.QueryRow(r.Context(), `UPDATE account_recovery_tokens SET used_at=now() WHERE token_hash=$1 AND kind='email_verification' AND used_at IS NULL AND expires_at>now() RETURNING account_id`, hash(input.Token)).Scan(&accountID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusBadRequest, "invalid_verification", "This verification link is invalid or expired")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "verification_failed", "Could not verify the recovery email")
		return
	}
	if _, err := tx.Exec(r.Context(), `UPDATE accounts SET email_verified_at=COALESCE(email_verified_at,now()), updated_at=now() WHERE id=$1 AND status='active'`, accountID); err != nil {
		writeError(w, http.StatusInternalServerError, "verification_failed", "Could not verify the recovery email")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "verification_failed", "Could not verify the recovery email")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"verified": true})
}

func (s *server) messageRequestRoute(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Create or resume an identity first")
		return
	}
	switch r.Method {
	case http.MethodGet:
		rows, err := s.queries.ListIncomingMessageRequests(r.Context(), sqlc.ListIncomingMessageRequestsParams{RecipientUserID: userID, Limit: 50})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "requests_failed", "Could not load message requests")
			return
		}
		items := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			items = append(items, map[string]any{"id": row.ID, "fromUserId": row.SenderUserID, "username": row.Username, "status": row.Status, "createdAt": row.CreatedAt.Time})
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": items})
	case http.MethodPost:
		if !s.allowAuthAttempt(r, "message_request", 12, 15*time.Minute) {
			writeError(w, http.StatusTooManyRequests, "rate_limited", "Try again later")
			return
		}
		var input struct {
			Username string `json:"username"`
		}
		if !decodeJSON(r, &input) || normalizeUsernameLookup(input.Username) == "" {
			writeError(w, http.StatusBadRequest, "invalid_request", "Choose a username to contact")
			return
		}
		profile, err := s.queries.GetProfileByUsername(r.Context(), normalizeUsernameLookup(input.Username))
		if errors.Is(err, pgx.ErrNoRows) || profile.UserID == userID {
			writeError(w, http.StatusNotFound, "peer_unavailable", "That peer is unavailable")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "request_failed", "Could not create message request")
			return
		}
		completed, err := s.queries.IsProfileCompleted(r.Context(), profile.UserID)
		if err != nil || !completed {
			writeError(w, http.StatusNotFound, "peer_unavailable", "That peer is unavailable")
			return
		}
		blocked, err := s.queries.IsBlocked(r.Context(), sqlc.IsBlockedParams{BlockerID: userID, BlockedUserID: profile.UserID})
		if err != nil || blocked {
			writeError(w, http.StatusForbidden, "peer_unavailable", "That peer is unavailable")
			return
		}
		request, err := s.queries.CreateMessageRequest(r.Context(), sqlc.CreateMessageRequestParams{ID: ulid.Make().String(), SenderUserID: userID, RecipientUserID: profile.UserID})
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusConflict, "request_pending", "A request is already awaiting that person")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "request_failed", "Could not create message request")
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"id": request.ID, "username": profile.Username, "status": request.Status, "createdAt": request.CreatedAt.Time})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Unsupported request operation")
	}
}

func (s *server) resolveMessageRequestRoute(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Create or resume an identity first")
		return
	}
	requestID := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/requests/"), "/")
	if requestID == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "Choose a request")
		return
	}
	var input struct {
		Action string `json:"action"`
	}
	if !decodeJSON(r, &input) || (input.Action != "accept" && input.Action != "decline" && input.Action != "block") {
		writeError(w, http.StatusBadRequest, "invalid_action", "Choose accept, decline, or block")
		return
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "request_failed", "Could not update the request")
		return
	}
	defer tx.Rollback(r.Context())
	queries := sqlc.New(tx)
	status := input.Action + "ed"
	if input.Action == "accept" {
		status = "accepted"
	}
	if input.Action == "block" {
		status = "blocked"
	}
	request, err := queries.ResolveMessageRequest(r.Context(), sqlc.ResolveMessageRequestParams{Status: status, ID: requestID, RecipientUserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "request_unavailable", "That message request is no longer pending")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "request_failed", "Could not update the request")
		return
	}
	response := map[string]any{"id": request.ID, "status": request.Status}
	if input.Action == "block" {
		if err := queries.CreateBlock(r.Context(), sqlc.CreateBlockParams{BlockerID: userID, BlockedUserID: request.SenderUserID}); err != nil {
			writeError(w, http.StatusInternalServerError, "block_failed", "Could not block this peer")
			return
		}
	}
	if input.Action == "accept" {
		ids := []string{userID, request.SenderUserID}
		sort.Strings(ids)
		session, err := queries.CreateDirectSession(r.Context(), sqlc.CreateDirectSessionParams{ID: ulid.Make().String(), DirectPairKey: ids[0] + ":" + ids[1]})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "session_failed", "Could not create the direct line")
			return
		}
		if err := queries.AddParticipant(r.Context(), sqlc.AddParticipantParams{SessionID: session.ID, UserID: userID}); err != nil {
			writeError(w, http.StatusInternalServerError, "session_failed", "Could not add participants")
			return
		}
		if err := queries.AddParticipant(r.Context(), sqlc.AddParticipantParams{SessionID: session.ID, UserID: request.SenderUserID}); err != nil {
			writeError(w, http.StatusInternalServerError, "session_failed", "Could not add participants")
			return
		}
		response["sessionId"] = session.ID
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "request_failed", "Could not save the request decision")
		return
	}
	s.broadcastUserEvent(userID, map[string]any{"type": "request.resolved", "requestId": request.ID, "status": request.Status})
	s.broadcastUserEvent(request.SenderUserID, map[string]any{"type": "request.resolved", "requestId": request.ID, "status": request.Status, "sessionId": response["sessionId"]})
	writeJSON(w, http.StatusOK, response)
}

func (s *server) authenticatedAccount(r *http.Request) (sqlc.Account, bool) {
	cookie, err := r.Cookie(accountCookie)
	if err != nil {
		return sqlc.Account{}, false
	}
	accountID, err := s.queries.GetAccountSession(r.Context(), hash(cookie.Value))
	if err != nil {
		return sqlc.Account{}, false
	}
	_ = s.queries.TouchAccountSession(r.Context(), hash(cookie.Value))
	account, err := s.queries.GetAccountByID(r.Context(), accountID)
	return account, err == nil && account.Status == "active"
}

func (s *server) authenticatedBrowserSessionID(r *http.Request) (string, bool) {
	cookie, err := r.Cookie(sessionCookie)
	if err != nil {
		return "", false
	}
	var id string
	err = s.db.QueryRow(r.Context(), `SELECT id FROM browser_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()`, hash(cookie.Value)).Scan(&id)
	return id, err == nil
}

func (s *server) issueAccountAndBrowserSessions(w http.ResponseWriter, r *http.Request, accountID, userID string, rotateBrowser bool) error {
	accountRaw := randomToken(32)
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	var browserRaw string
	var browserID pgtype.Text
	var previousBrowserID string
	if rotateBrowser {
		if cookie, err := r.Cookie(sessionCookie); err == nil {
			err := tx.QueryRow(r.Context(), `UPDATE browser_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL RETURNING id`, hash(cookie.Value)).Scan(&previousBrowserID)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			if previousBrowserID != "" {
				if _, err := tx.Exec(r.Context(), `UPDATE account_sessions SET revoked_at=now() WHERE browser_session_id=$1 AND revoked_at IS NULL`, previousBrowserID); err != nil {
					return err
				}
			}
		}
		browserRaw = randomToken(32)
		browserSessionID := ulid.Make().String()
		if _, err := tx.Exec(r.Context(), `INSERT INTO browser_sessions (id,user_id,token_hash,csrf_hash,expires_at) VALUES ($1,$2,$3,$4,now()+interval '30 days')`, browserSessionID, userID, hash(browserRaw), hash(randomToken(24))); err != nil {
			return err
		}
		browserID = pgtype.Text{String: browserSessionID, Valid: true}
	}
	if _, err := tx.Exec(r.Context(), `INSERT INTO account_sessions (id,account_id,token_hash,browser_session_id,expires_at) VALUES ($1,$2,$3,$4,now()+interval '30 days')`, ulid.Make().String(), accountID, hash(accountRaw), browserID); err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	if previousBrowserID != "" {
		s.disconnectBrowserSession(previousBrowserID)
	}
	if rotateBrowser {
		s.setSessionCookie(w, r, browserRaw)
	}
	s.setAccountCookie(w, r, accountRaw)
	return nil
}

func (s *server) allowAuthAttempt(r *http.Request, action string, limit int64, window time.Duration) bool {
	host := authRateLimitHost(r)
	key := "gochat:auth:" + action + ":" + hash(host)
	return s.allowRateAttempt(r, key, "auth "+action, limit, window)
}

func (s *server) allowMediaUpload(r *http.Request, userID string) bool {
	key := "gochat:media:upload:" + hash(userID) + ":" + hash(authRateLimitHost(r))
	return s.allowRateAttempt(r, key, "media upload", 12, 15*time.Minute)
}

func (s *server) allowRateAttempt(r *http.Request, key, action string, limit int64, window time.Duration) bool {
	ctx, cancel := context.WithTimeout(r.Context(), 300*time.Millisecond)
	defer cancel()
	if s.redis == nil {
		return s.allowFallbackAuthAttempt(key, limit, window)
	}
	count, err := s.redis.Incr(ctx, key).Result()
	if err != nil {
		if s.log != nil {
			s.log.Warn("Redis limiter unavailable; using bounded local fallback", "action", action, "error", err)
		}
		return s.allowFallbackAuthAttempt(key, limit, window)
	}
	if count == 1 {
		_ = s.redis.Expire(ctx, key, window).Err()
	}
	return count <= limit
}

func authRateLimitHost(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return host
	}
	client := strings.TrimSpace(r.Header.Get("X-GoChat-Integration-Client"))
	if client == "" || len(client) > 64 {
		return host
	}
	for _, character := range client {
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') || character == '-' || character == '_' {
			continue
		}
		return host
	}
	return "integration:" + client
}

func (s *server) allowFallbackAuthAttempt(key string, limit int64, window time.Duration) bool {
	now := time.Now()
	s.authLimitMu.Lock()
	defer s.authLimitMu.Unlock()
	if s.authLimits == nil {
		s.authLimits = make(map[string]authRateLimitFallback)
	}
	for candidate, attempt := range s.authLimits {
		if now.After(attempt.resetAt) {
			delete(s.authLimits, candidate)
		}
	}
	attempt := s.authLimits[key]
	if attempt.resetAt.IsZero() || now.After(attempt.resetAt) {
		attempt = authRateLimitFallback{resetAt: now.Add(window)}
	}
	attempt.count++
	s.authLimits[key] = attempt
	return attempt.count <= limit
}

func (s *server) setAccountCookie(w http.ResponseWriter, r *http.Request, value string) {
	http.SetCookie(w, &http.Cookie{Name: accountCookie, Value: value, Path: "/", HttpOnly: true, Secure: requestUsesHTTPS(r), SameSite: s.cookieSameSite(r), MaxAge: 30 * 24 * 60 * 60})
}

func (s *server) clearAccountCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: accountCookie, Value: "", Path: "/", HttpOnly: true, Secure: requestUsesHTTPS(r), SameSite: s.cookieSameSite(r), MaxAge: -1})
}

func validAccountUsername(value string) bool {
	value = normalize(value)
	if len(value) < 3 || len(value) > 32 {
		return false
	}
	for index, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '_' || char == '-' {
			if index == 0 && (char == '_' || char == '-') {
				return false
			}
			continue
		}
		return false
	}
	return true
}

func validEmail(value string) bool {
	parsed, err := mail.ParseAddress(strings.TrimSpace(value))
	return err == nil && strings.EqualFold(parsed.Address, strings.TrimSpace(value)) && len(value) <= 320
}

func hashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s", argonMemory, argonTime, argonThreads, base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

func verifyPassword(encoded, password string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" || parts[2] != "v=19" {
		return false
	}
	params := strings.Split(parts[3], ",")
	if len(params) != 3 {
		return false
	}
	values := map[string]uint64{}
	for _, param := range params {
		pair := strings.SplitN(param, "=", 2)
		if len(pair) != 2 {
			return false
		}
		value, err := strconv.ParseUint(pair[1], 10, 32)
		if err != nil {
			return false
		}
		values[pair[0]] = value
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false
	}
	expected, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false
	}
	key := argon2.IDKey([]byte(password), salt, uint32(values["t"]), uint32(values["m"]), uint8(values["p"]), uint32(len(expected)))
	return subtle.ConstantTimeCompare(expected, key) == 1
}
