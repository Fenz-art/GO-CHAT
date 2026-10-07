package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/manus/go-chat/backend/internal/sqlc"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/oklog/ulid/v2"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
)

//go:embed all:public
var publicFS embed.FS

const (
	sessionCookie                = "gochat_session"
	dependencyHealthProbeTimeout = time.Second
	maxJSONBodyBytes             = 1 << 20
	maxMediaBytes                = 50 << 20
	maxVoiceNoteBytes            = 8 << 20
	maxOwnedMediaBytes           = 500 << 20
	mediaSignatureProbeBytes     = 512
	mediaMultipartRequestBytes   = maxMediaBytes + (1 << 20)
	messageFanoutChannel         = "gochat:message.created"
	userEventFanoutChannel       = "gochat:user.event"
	contentSecurityPolicy        = "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: https:; img-src 'self' data: blob: https:; media-src 'self' blob: https:; font-src 'self' data:; worker-src 'self' blob:"
	previewContentSecurityPolicy = "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self' https://manus.im https://*.manus.im https://manus.computer https://*.manus.computer; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: https:; img-src 'self' data: blob: https:; media-src 'self' blob: https:; font-src 'self' data:; worker-src 'self' blob:"
)

type config struct {
	port, postgresURL, redisURL, retentionSweepToken         string
	s3Endpoint, s3Bucket, s3AccessKey, s3SecretKey, s3Region string
	smtpHost, smtpPort, smtpUsername, smtpPassword           string
	emailFrom, publicURL                                     string
	allowPreviewEmbedding                                    bool
}
type server struct {
	cfg         config
	db          *pgxpool.Pool
	queries     *sqlc.Queries
	redis       *redis.Client
	log         *slog.Logger
	requests    *prometheus.CounterVec
	s3          *minio.Client
	s3Bucket    string
	wsMu        sync.RWMutex
	clients     map[string]map[*wsClient]struct{}
	authLimitMu sync.Mutex
	authLimits  map[string]authRateLimitFallback
	instanceID  string
}

type wsClient struct {
	userID           string
	browserSessionID string
	conn             *websocket.Conn
	writeMu          sync.Mutex
}

type typingEvent struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	SenderID  string `json:"senderId"`
}

type identityResponse struct {
	UserID         string `json:"userId"`
	Username       string `json:"username"`
	SessionID      string `json:"sessionId"`
	OnboardingStep string `json:"onboardingStep"`
}
type sessionResponse struct {
	ID              string    `json:"id"`
	Username        string    `json:"username"`
	LastActivity    time.Time `json:"lastActivity"`
	RetentionPolicy string    `json:"retentionPolicy"`
	LocalLocked     bool      `json:"localLocked"`
}
type messageResponse struct {
	ID                string     `json:"id"`
	SessionID         string     `json:"sessionId"`
	SenderID          string     `json:"senderId"`
	ClientOperationID string     `json:"clientOperationId"`
	Cursor            int64      `json:"cursor"`
	Kind              string     `json:"kind"`
	Body              string     `json:"body"`
	State             string     `json:"state"`
	CreatedAt         time.Time  `json:"createdAt"`
	EditedAt          *time.Time `json:"editedAt,omitempty"`
	DeletedAt         *time.Time `json:"deletedAt,omitempty"`
	ExpiresAt         *time.Time `json:"expiresAt,omitempty"`
	Read              bool       `json:"read"`
	MediaURL          string     `json:"mediaUrl,omitempty"`
	FileName          string     `json:"fileName,omitempty"`
	MimeType          string     `json:"mimeType,omitempty"`
	ByteSize          int64      `json:"byteSize,omitempty"`
}

type settingsResponse struct {
	Theme                   string `json:"theme"`
	ReducedMotion           bool   `json:"reducedMotion"`
	SendOnEnter             bool   `json:"sendOnEnter"`
	PresenceVisibility      string `json:"presenceVisibility"`
	ReadReceipts            bool   `json:"readReceipts"`
	Notifications           bool   `json:"notifications"`
	AvatarVisibility        string `json:"avatarVisibility"`
	StatusVisibility        string `json:"statusVisibility"`
	NotificationPreview     string `json:"notificationPreview"`
	NotificationSound       bool   `json:"notificationSound"`
	QuietHoursEnabled       bool   `json:"quietHoursEnabled"`
	QuietHoursStart         string `json:"quietHoursStart"`
	QuietHoursEnd           string `json:"quietHoursEnd"`
	MediaAutoDownload       string `json:"mediaAutoDownload"`
	LinkPreviewsEnabled     bool   `json:"linkPreviewsEnabled"`
	PrivacyCheckupCompleted bool   `json:"privacyCheckupCompleted"`
}

type searchResult struct {
	Kind      string `json:"kind"`
	UserID    string `json:"userId,omitempty"`
	Username  string `json:"username"`
	SessionID string `json:"sessionId,omitempty"`
	MessageID string `json:"messageId,omitempty"`
	Body      string `json:"body,omitempty"`
	Cursor    int64  `json:"cursor,omitempty"`
}

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	cfg := config{port: env("PORT", "3000"), postgresURL: os.Getenv("GOCHAT_POSTGRES_URL"), redisURL: os.Getenv("GOCHAT_REDIS_URL"), retentionSweepToken: hash("retention-sweep:" + os.Getenv("JWT_SECRET")), s3Endpoint: os.Getenv("GOCHAT_S3_ENDPOINT"), s3Bucket: os.Getenv("GOCHAT_S3_BUCKET"), s3AccessKey: os.Getenv("GOCHAT_S3_ACCESS_KEY_ID"), s3SecretKey: os.Getenv("GOCHAT_S3_SECRET_ACCESS_KEY"), s3Region: env("GOCHAT_S3_REGION", "us-east-1"), smtpHost: os.Getenv("GOCHAT_SMTP_HOST"), smtpPort: env("GOCHAT_SMTP_PORT", "587"), smtpUsername: os.Getenv("GOCHAT_SMTP_USERNAME"), smtpPassword: os.Getenv("GOCHAT_SMTP_PASSWORD"), emailFrom: os.Getenv("GOCHAT_EMAIL_FROM"), publicURL: os.Getenv("GOCHAT_PUBLIC_URL"), allowPreviewEmbedding: env("GOCHAT_ALLOW_EMBEDDED_PREVIEW", "") == "1"}
	ctx := context.Background()
	cfg.postgresURL = strings.ReplaceAll(cfg.postgresURL, `\u0026`, "&")
	pool, redisClient, err := connectDependencies(ctx, cfg, log)
	if err != nil {
		log.Error("dependency initialization failed", "error", err)
		os.Exit(1)
	}
	defer pool.Close()
	defer redisClient.Close()
	requests := prometheus.NewCounterVec(prometheus.CounterOpts{Namespace: "gochat", Subsystem: "http", Name: "requests_total", Help: "HTTP requests handled by Go Chat."}, []string{"method", "path", "status"})
	prometheus.MustRegister(requests)
	s3Client, err := connectStorage(cfg)
	if err != nil {
		log.Error("storage initialization failed", "error", err)
		os.Exit(1)
	}
	app := &server{cfg: cfg, db: pool, queries: sqlc.New(pool), redis: redisClient, s3: s3Client, s3Bucket: cfg.s3Bucket, log: log, requests: requests, clients: make(map[string]map[*wsClient]struct{}), authLimits: make(map[string]authRateLimitFallback), instanceID: ulid.Make().String()}
	app.startTypingFanout(ctx)
	app.startMessageFanout(ctx)
	app.startUserEventFanout(ctx)
	// Server-wide read/write deadlines would terminate upgraded WebSocket connections.
	httpServer := &http.Server{Addr: ":" + cfg.port, Handler: app.handler(), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
	errCh := make(chan error, 1)
	go func() {
		fmt.Printf("Server running on http://localhost:%s\n", cfg.port)
		errCh <- httpServer.ListenAndServe()
	}()
	signal := make(chan os.Signal, 1)
	notifyShutdown(signal)
	select {
	case <-signal:
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Error("server stopped", "error", err)
			os.Exit(1)
		}
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdown)
}

func connectDependencies(ctx context.Context, cfg config, log *slog.Logger) (*pgxpool.Pool, *redis.Client, error) {
	if cfg.postgresURL == "" || cfg.redisURL == "" {
		return nil, nil, errors.New("GOCHAT_POSTGRES_URL and GOCHAT_REDIS_URL are required")
	}
	pool, err := pgxpool.New(ctx, cfg.postgresURL)
	if err != nil {
		return nil, nil, fmt.Errorf("postgres pool: %w", err)
	}
	postgresCtx, postgresSpan := otel.Tracer("go-chat/dependencies").Start(ctx, "postgres.ping")
	err = pingPostgres(postgresCtx, pool)
	postgresSpan.End()
	if err != nil {
		pool.Close()
		return nil, nil, fmt.Errorf("ping PostgreSQL: %w", err)
	}
	redisOptions, err := redis.ParseURL(cfg.redisURL)
	if err != nil {
		pool.Close()
		return nil, nil, fmt.Errorf("redis url: %w", err)
	}
	redisClient := redis.NewClient(redisOptions)
	redisCtx, redisSpan := otel.Tracer("go-chat/dependencies").Start(ctx, "redis.ping")
	err = pingRedis(redisCtx, redisClient)
	redisSpan.End()
	if err != nil {
		log.Warn("Redis is temporarily unavailable; starting in degraded mode", "error", err)
		return pool, redisClient, nil
	}
	log.Info("external services ready", "postgres", true, "redis", true)
	return pool, redisClient, nil
}

func (s *server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/realtime", s.realtime)
	mux.HandleFunc("GET /healthz", s.liveness)
	mux.HandleFunc("GET /api/v1/health", s.health)
	mux.HandleFunc("GET /api/v1/storage/health", s.storageHealth)
	mux.HandleFunc("GET /metrics", promhttp.Handler().ServeHTTP)
	mux.HandleFunc("POST /api/v1/identity/bootstrap", s.bootstrap)
	mux.HandleFunc("POST /api/v1/identity/logout", s.identityLogout)
	mux.HandleFunc("POST /api/v1/account", s.accountRoute)
	mux.HandleFunc("GET /api/v1/account", s.accountRoute)
	mux.HandleFunc("POST /api/v1/account/login", s.accountLogin)
	mux.HandleFunc("POST /api/v1/account/logout", s.accountLogout)
	mux.HandleFunc("GET /api/v1/account/sessions", s.accountSessionRoute)
	mux.HandleFunc("DELETE /api/v1/account/sessions", s.accountSessionRoute)
	mux.HandleFunc("DELETE /api/v1/account/sessions/{sessionID}", s.revokeAccountSessionRoute)
	mux.HandleFunc("POST /api/v1/account/email/verification", s.sendEmailVerification)
	mux.HandleFunc("POST /api/v1/account/email/verification/confirm", s.confirmEmailVerification)
	mux.HandleFunc("POST /api/v1/account/password/reset", s.requestPasswordReset)
	mux.HandleFunc("POST /api/v1/account/password/reset/confirm", s.confirmPasswordReset)
	mux.HandleFunc("GET /api/v1/requests", s.messageRequestRoute)
	mux.HandleFunc("POST /api/v1/requests", s.messageRequestRoute)
	mux.HandleFunc("POST /api/v1/requests/", s.resolveMessageRequestRoute)
	mux.HandleFunc("GET /api/v1/identity/username/availability", s.usernameAvailability)
	mux.HandleFunc("POST /api/v1/onboarding/lock", s.lockUsername)
	mux.HandleFunc("GET /api/v1/onboarding/resume", s.resumeOnboarding)
	mux.HandleFunc("GET /api/v1/search", s.search)
	mux.HandleFunc("GET /api/v1/settings", s.settingsRoute)
	mux.HandleFunc("PATCH /api/v1/settings", s.settingsRoute)
	mux.HandleFunc("GET /api/v1/profile", s.profileRoute)
	mux.HandleFunc("PATCH /api/v1/profile", s.profileRoute)
	mux.HandleFunc("POST /api/v1/profile/avatar", s.profileAvatar)
	mux.HandleFunc("DELETE /api/v1/profile/avatar", s.removeProfileAvatar)
	mux.HandleFunc("GET /api/v1/storage/usage", s.storageUsage)
	mux.HandleFunc("GET /api/v1/data/export", s.dataExport)
	mux.HandleFunc("GET /api/v1/data/deletion-requests", s.dataRightsRoute)
	mux.HandleFunc("POST /api/v1/data/deletion-requests", s.dataRightsRoute)
	mux.HandleFunc("POST /api/scheduled/retention-sweep", s.scheduledRetentionSweep)
	mux.HandleFunc("GET /api/v1/sessions", s.listSessions)
	mux.HandleFunc("POST /api/v1/sessions/discover", s.discoverSession)
	mux.HandleFunc("/api/v1/sessions/", s.sessionRoute)
	mux.Handle("/", s.staticHandler())
	baseHandler := s.security(s.withMetrics(mux))
	tracedHandler := otelhttp.NewHandler(baseHandler, "go-chat")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/realtime" {
			baseHandler.ServeHTTP(w, r)
			return
		}
		tracedHandler.ServeHTTP(w, r)
	})
}

func (s *server) realtime(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Sign in anonymously first")
		return
	}
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	browserSessionID, ok := s.authenticatedBrowserSessionID(r)
	if !ok {
		_ = conn.Close(websocket.StatusPolicyViolation, "browser session unavailable")
		return
	}
	client := &wsClient{userID: userID, browserSessionID: browserSessionID, conn: conn}
	s.registerClient(client)
	defer s.unregisterClient(client)
	_ = s.redis.Set(r.Context(), "gochat:presence:"+userID, "online", 45*time.Second).Err()
	defer s.redis.Del(r.Context(), "gochat:presence:"+userID)
	defer conn.Close(websocket.StatusNormalClosure, "")
	ctx := r.Context()
	_ = conn.Write(ctx, websocket.MessageText, []byte(`{"type":"connection.ready","state":"connected"}`))
	for {
		_, payload, readErr := conn.Read(ctx)
		if readErr != nil {
			return
		}
		var event typingEvent
		if json.Unmarshal(payload, &event) == nil && (event.Type == "typing.start" || event.Type == "typing.stop") {
			if s.isParticipant(ctx, event.SessionID, userID) {
				event.SenderID = userID
				s.broadcastTyping(event)
				encoded, _ := json.Marshal(event)
				if publishErr := s.redis.Publish(ctx, "gochat:typing:"+event.SessionID, encoded).Err(); publishErr != nil {
					s.log.Warn("Redis typing fan-out unavailable after local delivery", "error", publishErr)
				}
			}
			continue
		}
		client.write(ctx, append([]byte(`{"type":"event.ack","payload":`), append(payload, '}')...))
	}
}

func (s *server) startTypingFanout(ctx context.Context) {
	pubsub := s.redis.PSubscribe(ctx, "gochat:typing:*")
	go func() {
		defer pubsub.Close()
		for message := range pubsub.Channel() {
			var event typingEvent
			if json.Unmarshal([]byte(message.Payload), &event) != nil || event.SessionID == "" || event.SenderID == "" {
				continue
			}
			s.broadcastTyping(event)
		}
	}()
}

type messageFanoutEvent struct {
	Origin  string          `json:"origin"`
	Message messageResponse `json:"message"`
}

func (s *server) startMessageFanout(ctx context.Context) {
	if s.redis == nil {
		return
	}
	pubsub := s.redis.Subscribe(ctx, messageFanoutChannel)
	go func() {
		defer pubsub.Close()
		for event := range pubsub.Channel() {
			var fanout messageFanoutEvent
			if json.Unmarshal([]byte(event.Payload), &fanout) != nil || fanout.Message.ID == "" || fanout.Message.SessionID == "" || fanout.Origin == s.instanceID {
				continue
			}
			s.broadcastMessageLocal(fanout.Message)
		}
	}()
}

type userEventFanout struct {
	Origin  string          `json:"origin"`
	UserID  string          `json:"userId"`
	Payload json.RawMessage `json:"payload"`
}

func (s *server) startUserEventFanout(ctx context.Context) {
	if s.redis == nil {
		return
	}
	pubsub := s.redis.Subscribe(ctx, userEventFanoutChannel)
	go func() {
		defer pubsub.Close()
		for event := range pubsub.Channel() {
			var fanout userEventFanout
			if json.Unmarshal([]byte(event.Payload), &fanout) != nil ||
				fanout.Origin == s.instanceID ||
				fanout.UserID == "" ||
				!json.Valid(fanout.Payload) {
				continue
			}
			var payload struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(fanout.Payload, &payload) != nil ||
				(payload.Type != "request.created" && payload.Type != "request.resolved") {
				continue
			}
			s.broadcastUserEventLocal(fanout.UserID, fanout.Payload)
		}
	}()
}

func (s *server) registerClient(client *wsClient) {
	s.wsMu.Lock()
	defer s.wsMu.Unlock()
	if s.clients[client.userID] == nil {
		s.clients[client.userID] = make(map[*wsClient]struct{})
	}
	s.clients[client.userID][client] = struct{}{}
}

func (s *server) unregisterClient(client *wsClient) {
	s.wsMu.Lock()
	defer s.wsMu.Unlock()
	delete(s.clients[client.userID], client)
	if len(s.clients[client.userID]) == 0 {
		delete(s.clients, client.userID)
	}
}

func (s *server) disconnectBrowserSession(sessionID string) {
	s.wsMu.RLock()
	var clients []*wsClient
	for _, userClients := range s.clients {
		for client := range userClients {
			if client.browserSessionID == sessionID {
				clients = append(clients, client)
			}
		}
	}
	s.wsMu.RUnlock()
	for _, client := range clients {
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		client.write(ctx, []byte(`{"type":"session.revoked"}`))
		cancel()
		_ = client.conn.Close(websocket.StatusPolicyViolation, "browser session revoked")
	}
}

func (s *server) disconnectUserSessions(userID string) {
	s.wsMu.RLock()
	clients := make([]*wsClient, 0, len(s.clients[userID]))
	for client := range s.clients[userID] {
		clients = append(clients, client)
	}
	s.wsMu.RUnlock()
	for _, client := range clients {
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		client.write(ctx, []byte(`{"type":"session.revoked"}`))
		cancel()
		_ = client.conn.Close(websocket.StatusPolicyViolation, "identity sessions revoked")
	}
}

func (client *wsClient) write(ctx context.Context, payload []byte) {
	client.writeMu.Lock()
	defer client.writeMu.Unlock()
	_ = client.conn.Write(ctx, websocket.MessageText, payload)
}

func (s *server) broadcastTyping(event typingEvent) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	recipientIDs, err := s.queries.ListSessionParticipants(ctx, event.SessionID)
	if err != nil {
		return
	}
	payload, _ := json.Marshal(event)
	for _, recipientID := range recipientIDs {
		if recipientID == event.SenderID {
			continue
		}
		s.wsMu.RLock()
		clients := make([]*wsClient, 0, len(s.clients[recipientID]))
		for client := range s.clients[recipientID] {
			clients = append(clients, client)
		}
		s.wsMu.RUnlock()
		for _, client := range clients {
			client.write(ctx, payload)
		}
	}
}

func (s *server) isParticipant(ctx context.Context, sessionID, userID string) bool {
	if sessionID == "" {
		return false
	}
	participant, err := s.queries.IsParticipant(ctx, sqlc.IsParticipantParams{SessionID: sessionID, UserID: userID})
	return err == nil && participant
}

func (s *server) staticHandler() http.Handler {
	if _, err := os.Stat("out"); err == nil {
		return http.FileServer(http.Dir("out"))
	}
	public, err := fs.Sub(publicFS, "public")
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "frontend export unavailable", http.StatusServiceUnavailable)
		})
	}
	return http.FileServer(http.FS(public))
}

func (s *server) liveness(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *server) health(w http.ResponseWriter, r *http.Request) {
	postgresCh := make(chan bool, 1)
	redisCh := make(chan bool, 1)
	go func() {
		probeCtx, probeCancel := context.WithTimeout(r.Context(), dependencyHealthProbeTimeout)
		defer probeCancel()
		postgresCh <- s.db.Ping(probeCtx) == nil
	}()
	go func() {
		probeCtx, probeCancel := context.WithTimeout(r.Context(), dependencyHealthProbeTimeout)
		defer probeCancel()
		redisCh <- s.redis.Ping(probeCtx).Err() == nil
	}()
	deadline := time.NewTimer(dependencyHealthProbeTimeout)
	defer deadline.Stop()
	postgres, redisOK := false, false
	postgresDone, redisDone := false, false
	for !postgresDone || !redisDone {
		select {
		case postgres = <-postgresCh:
			postgresDone = true
		case redisOK = <-redisCh:
			redisDone = true
		case <-deadline.C:
			postgresDone = true
			redisDone = true
		}
	}
	status := http.StatusOK
	if !postgres || !redisOK {
		status = http.StatusServiceUnavailable
	}
	writeJSON(w, status, map[string]any{"status": map[bool]string{true: "ok", false: "degraded"}[status == http.StatusOK], "postgres": postgres, "redis": redisOK})
}
func (s *server) bootstrap(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	username := suggestedUsername()
	userID := ulid.Make().String()
	rawToken := randomToken(32)
	tokenHash := hash(rawToken)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		writeError(w, 500, "bootstrap_failed", "Could not start identity bootstrap")
		return
	}
	defer tx.Rollback(ctx)
	txQueries := sqlc.New(tx)
	if _, err = txQueries.CreateUser(ctx, userID); err != nil {
		writeError(w, 500, "bootstrap_failed", "Could not create anonymous identity")
		return
	}
	if _, err = txQueries.CreateProfile(ctx, sqlc.CreateProfileParams{UserID: userID, Username: username, UsernameNormalized: normalize(username), IdentitySeed: randomToken(18)}); err != nil {
		writeError(w, 500, "bootstrap_failed", "Could not create anonymous profile")
		return
	}
	sessionID := ulid.Make().String()
	if err = txQueries.CreateBrowserSession(ctx, sqlc.CreateBrowserSessionParams{ID: sessionID, UserID: userID, TokenHash: tokenHash, CsrfHash: hash(randomToken(24))}); err != nil {
		writeError(w, 500, "bootstrap_failed", "Could not create browser session")
		return
	}
	if _, err = txQueries.UpsertCheckpoint(ctx, sqlc.UpsertCheckpointParams{UserID: userID, Step: "username", CandidateUsername: pgtype.Text{String: username, Valid: true}}); err != nil {
		writeError(w, 500, "bootstrap_failed", "Could not persist onboarding checkpoint")
		return
	}
	if err = txQueries.CreateUserSettings(ctx, userID); err != nil {
		writeError(w, 500, "bootstrap_failed", "Could not create settings")
		return
	}
	if err = tx.Commit(ctx); err != nil {
		writeError(w, 500, "bootstrap_failed", "Could not commit identity bootstrap")
		return
	}
	s.setSessionCookie(w, r, rawToken)
	writeJSON(w, 201, identityResponse{UserID: userID, Username: username, SessionID: sessionID, OnboardingStep: "username"})
}
func (s *server) usernameAvailability(w http.ResponseWriter, r *http.Request) {
	value := normalize(r.URL.Query().Get("username"))
	if len(value) < 3 {
		writeJSON(w, 200, map[string]any{"available": false, "reason": "too_short"})
		return
	}
	currentUser, _ := s.authenticatedUser(r)
	exists, err := s.queries.IsUsernameTaken(r.Context(), sqlc.IsUsernameTakenParams{UsernameNormalized: value, Column2: currentUser})
	if err != nil {
		writeError(w, 500, "availability_failed", "Could not check username availability")
		return
	}
	writeJSON(w, 200, map[string]any{"available": !exists, "username": value})
}
func (s *server) resumeOnboarding(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Start an anonymous identity first")
		return
	}
	row, err := s.queries.GetOnboardingResume(r.Context(), userID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusOK, map[string]any{"step": "none"})
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "resume_failed", "Could not restore onboarding checkpoint")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"userId": userID, "step": row.Step, "candidateUsername": row.CandidateUsername, "username": row.Username, "locked": row.UsernameLockedAt.Valid, "completed": row.OnboardingCompletedAt.Valid})
}

func (s *server) lockUsername(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, 401, "unauthorized", "Start an anonymous identity first")
		return
	}
	var input struct {
		Username string `json:"username"`
	}
	if !decodeJSON(r, &input) || len(normalize(input.Username)) < 3 {
		writeError(w, 400, "invalid_username", "Choose a valid username")
		return
	}
	username := strings.TrimSpace(input.Username)
	normalized := normalize(username)
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeError(w, 500, "lock_failed", "Could not start username lock")
		return
	}
	defer tx.Rollback(r.Context())
	txQueries := sqlc.New(tx)
	taken, err := txQueries.IsUsernameTaken(r.Context(), sqlc.IsUsernameTakenParams{UsernameNormalized: normalized, Column2: userID})
	if err != nil || taken {
		writeError(w, 409, "username_taken", "That username is already taken")
		return
	}
	if err = txQueries.LockUsername(r.Context(), sqlc.LockUsernameParams{Username: username, UsernameNormalized: normalized, UserID: userID}); err != nil {
		writeError(w, 500, "lock_failed", "Could not lock username")
		return
	}
	if err = txQueries.CompleteOnboardingCheckpoint(r.Context(), sqlc.CompleteOnboardingCheckpointParams{CandidateUsername: pgtype.Text{String: username, Valid: true}, UserID: userID}); err != nil {
		writeError(w, 500, "lock_failed", "Could not complete onboarding")
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		writeError(w, 500, "lock_failed", "Could not commit username lock")
		return
	}
	writeJSON(w, 200, map[string]any{"locked": true, "username": username, "userId": userID, "onboardingStep": "complete"})
}
func (s *server) listSessions(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, 401, "unauthorized", "Sign in anonymously first")
		return
	}
	rows, err := s.queries.ListSessions(r.Context(), userID)
	if err != nil {
		writeError(w, 500, "sessions_failed", "Could not load conversations")
		return
	}
	sessions := make([]sessionResponse, 0, len(rows))
	for _, row := range rows {
		localLocked, _ := row.LocalLocked.(bool)
		sessions = append(sessions, sessionResponse{ID: row.ID, Username: row.Username, LastActivity: row.LastActivityAt.Time, RetentionPolicy: row.RetentionPolicy, LocalLocked: localLocked})
	}
	writeJSON(w, 200, sessions)
}
func (s *server) search(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Sign in anonymously first")
		return
	}
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	searchType := r.URL.Query().Get("type")
	if searchType == "" {
		searchType = "users"
	}
	if searchType == "users" {
		query = normalizeUsernameLookup(query)
	}
	if len([]rune(query)) < 2 || len([]rune(query)) > 80 {
		writeError(w, http.StatusBadRequest, "invalid_search", "Use a search query between 2 and 80 characters")
		return
	}
	pattern := "%" + strings.ReplaceAll(query, "%", "\\%") + "%"
	results := []searchResult{}
	switch searchType {
	case "users":
		rows, err := s.queries.SearchProfiles(r.Context(), sqlc.SearchProfilesParams{UserID: userID, UsernameNormalized: pattern, Limit: 20})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "search_failed", "Could not search users")
			return
		}
		for _, row := range rows {
			results = append(results, searchResult{Kind: "user", UserID: row.UserID, Username: row.Username})
		}
	case "messages":
		rows, err := s.queries.SearchMessages(r.Context(), sqlc.SearchMessagesParams{UserID: userID, Body: pgtype.Text{String: pattern, Valid: true}, Limit: 20})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "search_failed", "Could not search messages")
			return
		}
		for _, row := range rows {
			body := row.Body.String
			results = append(results, searchResult{Kind: "message", MessageID: row.ID, SessionID: row.SessionID, Body: body, Cursor: row.Cursor, Username: row.Username})
		}
	default:
		writeError(w, http.StatusBadRequest, "invalid_search_type", "Search type must be users or messages")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": results})
}

func (s *server) discoverSession(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, 401, "unauthorized", "Sign in anonymously first")
		return
	}
	var input struct {
		Username string `json:"username"`
	}
	if !decodeJSON(r, &input) {
		writeError(w, 400, "invalid_request", "Username is required")
		return
	}
	profile, err := s.queries.GetProfileByUsername(r.Context(), normalizeUsernameLookup(input.Username))
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 404, "peer_unavailable", "That peer is unavailable")
		return
	}
	if err != nil {
		writeError(w, 500, "discovery_failed", "Could not discover peer")
		return
	}
	completed, err := s.queries.IsProfileCompleted(r.Context(), profile.UserID)
	if err != nil || !completed {
		writeError(w, 404, "peer_unavailable", "That peer is unavailable")
		return
	}
	otherID, username := profile.UserID, profile.Username
	blocked, err := s.queries.IsBlocked(r.Context(), sqlc.IsBlockedParams{BlockerID: userID, BlockedUserID: otherID})
	if err != nil {
		writeError(w, 500, "discovery_failed", "Could not evaluate peer availability")
		return
	}
	if blocked {
		writeError(w, http.StatusForbidden, "peer_unavailable", "That peer is unavailable")
		return
	}
	ids := []string{userID, otherID}
	sort.Strings(ids)
	pair := ids[0] + ":" + ids[1]
	if session, lookupErr := s.queries.GetDirectSessionByPair(r.Context(), pair); lookupErr == nil {
		participant, participantErr := s.queries.IsParticipant(r.Context(), sqlc.IsParticipantParams{SessionID: session.ID, UserID: userID})
		if participantErr != nil || !participant {
			writeError(w, http.StatusForbidden, "session_unavailable", "That private line is unavailable")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"id": session.ID, "username": username})
		return
	} else if !errors.Is(lookupErr, pgx.ErrNoRows) {
		writeError(w, http.StatusInternalServerError, "discovery_failed", "Could not check that private line")
		return
	}

	if existing, lookupErr := s.queries.GetMessageRequestBetween(r.Context(), sqlc.GetMessageRequestBetweenParams{SenderUserID: userID, RecipientUserID: otherID}); lookupErr == nil && existing.Status == "pending" {
		if existing.SenderUserID == userID {
			writeJSON(w, http.StatusAccepted, map[string]any{"requestId": existing.ID, "username": username, "status": "pending"})
			return
		}
		writeError(w, http.StatusConflict, "incoming_request_pending", "This person has already asked to open a private line. Review the request in Chats.")
		return
	} else if lookupErr != nil && !errors.Is(lookupErr, pgx.ErrNoRows) {
		writeError(w, http.StatusInternalServerError, "discovery_failed", "Could not check direct-line requests")
		return
	}

	request, err := s.queries.CreateMessageRequest(r.Context(), sqlc.CreateMessageRequestParams{ID: ulid.Make().String(), SenderUserID: userID, RecipientUserID: otherID})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "request_failed", "Could not create a private-line request")
		return
	}
	s.broadcastUserEvent(otherID, map[string]any{"type": "request.created", "requestId": request.ID})
	writeJSON(w, http.StatusAccepted, map[string]any{"requestId": request.ID, "username": username, "status": "pending", "createdAt": request.CreatedAt.Time})
}
func (s *server) sessionRoute(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/sessions/")
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) == 2 && (r.Method == http.MethodPost || r.Method == http.MethodGet || r.Method == http.MethodPatch) {
		switch parts[1] {
		case "media":
			s.uploadMedia(w, r, parts[0])
			return
		case "mute":
			s.muteSession(w, r, parts[0])
			return
		case "archive":
			s.archiveSession(w, r, parts[0])
			return
		case "block":
			s.blockPeer(w, r, parts[0])
			return
		case "report":
			s.reportPeer(w, r, parts[0])
			return
		case "notifications":
			s.setSessionNotifications(w, r, parts[0])
			return
		case "search":
			s.searchSessionMessages(w, r, parts[0])
			return
		case "shared":
			if r.Method != http.MethodGet {
				writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Shared items are read-only")
				return
			}
			s.sharedSession(w, r, parts[0])
			return
		case "retention":
			s.retentionRoute(w, r, parts[0])
			return
		case "lock":
			s.sessionLockRoute(w, r, parts[0], "lock")
			return
		case "unlock":
			s.sessionLockRoute(w, r, parts[0], "unlock")
			return
		}
	}
	if len(parts) >= 2 && parts[1] == "messages" {
		switch {
		case len(parts) == 2 && r.Method == http.MethodGet:
			s.listMessages(w, r, parts[0])
			return
		case len(parts) == 2 && r.Method == http.MethodPost:
			s.sendMessage(w, r, parts[0])
			return
		case len(parts) == 3 && r.Method == http.MethodPatch:
			s.editMessage(w, r, parts[0], parts[2])
			return
		case len(parts) == 3 && r.Method == http.MethodDelete:
			s.deleteMessage(w, r, parts[0], parts[2])
			return
		case len(parts) == 4 && parts[3] == "read" && r.Method == http.MethodPost:
			s.markRead(w, r, parts[0], parts[2])
			return
		}
	}
	writeError(w, 404, "not_found", "Route not found")
}
func (s *server) sharedSession(w http.ResponseWriter, r *http.Request, sessionID string) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Sign in anonymously first")
		return
	}
	allowed, err := s.queries.IsParticipant(r.Context(), sqlc.IsParticipantParams{SessionID: sessionID, UserID: userID})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "shared_items_failed", "Could not verify this conversation")
		return
	}
	if !allowed {
		writeError(w, http.StatusForbidden, "forbidden", "You are not in this conversation")
		return
	}
	category := r.URL.Query().Get("category")
	if category == "" {
		category = "media"
	}
	if category != "media" && category != "documents" && category != "links" {
		writeError(w, http.StatusBadRequest, "invalid_category", "Category must be media, documents, or links")
		return
	}
	limit := int32(24)
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if parsed, parseErr := strconv.Atoi(raw); parseErr == nil && parsed > 0 && parsed <= 60 {
			limit = int32(parsed)
		}
	}
	offset := int32(0)
	if raw := r.URL.Query().Get("offset"); raw != "" {
		parsed, parseErr := strconv.Atoi(raw)
		if parseErr != nil || parsed < 0 || parsed > 100000 {
			writeError(w, http.StatusBadRequest, "invalid_offset", "Offset must be between 0 and 100000")
			return
		}
		offset = int32(parsed)
	}
	items := make([]map[string]any, 0, limit)
	sharedCtx, cancelShared := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelShared()
	if category == "links" {
		rows, queryErr := s.queries.ListSessionSharedLinks(sharedCtx, sqlc.ListSessionSharedLinksParams{UserID: userID, SessionID: sessionID, Limit: limit, Offset: offset})
		if queryErr != nil {
			s.log.Error("shared links query failed", "error", queryErr, "session_id", sessionID, "user_id", userID)
			writeError(w, http.StatusInternalServerError, "shared_items_failed", "Could not load shared links")
			return
		}
		for _, row := range rows {
			items = append(items, map[string]any{"id": row.ID, "sessionId": row.SessionID, "senderId": row.SenderID, "body": row.Body.String, "createdAt": row.CreatedAt.Time, "kind": "link"})
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": items, "category": category, "offset": offset, "limit": limit, "hasMore": len(items) == int(limit)})
		return
	}
	rows, queryErr := s.queries.ListSessionSharedAssets(sharedCtx, sqlc.ListSessionSharedAssetsParams{UserID: userID, SessionID: sessionID, Column3: category, Limit: limit, Offset: offset})
	if queryErr != nil {
		s.log.Error("shared assets query failed", "error", queryErr, "session_id", sessionID, "user_id", userID, "category", category)
		writeError(w, http.StatusInternalServerError, "shared_items_failed", "Could not load shared files")
		return
	}
	for _, row := range rows {
		item := map[string]any{"id": row.ID, "sessionId": row.SessionID, "senderId": row.SenderID, "body": row.Body.String, "createdAt": row.CreatedAt.Time, "kind": category, "fileName": row.FileName, "mimeType": row.ContentType, "byteSize": row.ByteSize}
		if signed, signErr := s.s3.PresignedGetObject(sharedCtx, s.s3Bucket, row.StorageKey, 24*time.Hour, nil); signErr == nil {
			item["mediaUrl"] = signed.String()
		}
		items = append(items, item)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "category": category, "offset": offset, "limit": limit, "hasMore": len(items) == int(limit)})
}

func (s *server) searchSessionMessages(w http.ResponseWriter, r *http.Request, sessionID string) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Sign in anonymously first")
		return
	}
	allowed, err := s.queries.IsParticipant(r.Context(), sqlc.IsParticipantParams{SessionID: sessionID, UserID: userID})
	if err != nil || !allowed {
		writeError(w, http.StatusForbidden, "forbidden", "You are not in this conversation")
		return
	}
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	fromDate, toDate := r.URL.Query().Get("from"), r.URL.Query().Get("to")
	if query == "" && fromDate == "" && toDate == "" {
		writeError(w, http.StatusBadRequest, "invalid_search", "Provide a keyword or date range")
		return
	}
	limit := int32(50)
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if parsed, parseErr := strconv.Atoi(raw); parseErr == nil && parsed > 0 && parsed <= 100 {
			limit = int32(parsed)
		}
	}
	offset := int32(0)
	if raw := r.URL.Query().Get("offset"); raw != "" {
		if parsed, parseErr := strconv.Atoi(raw); parseErr == nil && parsed >= 0 {
			offset = int32(parsed)
		}
	}
	bodyPattern := "%" + query + "%"
	rows, err := s.queries.SearchSessionMessages(r.Context(), sqlc.SearchSessionMessagesParams{SessionID: sessionID, Body: pgtype.Text{String: bodyPattern, Valid: true}, Column3: fromDate, Column4: toDate, Limit: limit, Offset: offset})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "search_failed", "Could not search this conversation")
		return
	}
	items := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		items = append(items, map[string]any{"id": row.ID, "sessionId": row.SessionID, "senderId": row.SenderID, "body": row.Body.String, "cursor": row.Cursor, "state": row.State, "createdAt": row.CreatedAt.Time})
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "query": query, "from": fromDate, "to": toDate, "limit": limit, "offset": offset, "hasMore": len(items) == int(limit)})
}

func (s *server) listMessages(w http.ResponseWriter, r *http.Request, sessionID string) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, 401, "unauthorized", "Sign in anonymously first")
		return
	}
	allowed, err := s.queries.IsParticipant(r.Context(), sqlc.IsParticipantParams{SessionID: sessionID, UserID: userID})
	if err != nil || !allowed {
		writeError(w, 403, "forbidden", "You are not in this conversation")
		return
	}
	if err := s.queries.MarkDeliveredMessages(r.Context(), sqlc.MarkDeliveredMessagesParams{SessionID: sessionID, SenderID: userID}); err != nil {
		writeError(w, http.StatusInternalServerError, "delivery_failed", "Could not reconcile message delivery")
		return
	}
	cursor := int64(0)
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		parsed, parseErr := strconv.ParseInt(raw, 10, 64)
		if parseErr != nil || parsed < 1 {
			writeError(w, http.StatusBadRequest, "invalid_cursor", "Cursor must be a positive integer")
			return
		}
		cursor = parsed
	}
	rows, err := s.queries.ListMessagesWithMedia(r.Context(), sqlc.ListMessagesWithMediaParams{SessionID: sessionID, Column2: cursor, UserID: userID})
	if err != nil {
		writeError(w, 500, "messages_failed", "Could not load messages")
		return
	}
	messages := make([]messageResponse, 0, len(rows))
	for _, row := range rows {
		m := messageResponse{ID: row.ID, SessionID: row.SessionID, SenderID: row.SenderID, ClientOperationID: row.ClientOperationID, Cursor: row.Cursor, Kind: row.Kind, Body: row.Body, State: row.State, CreatedAt: row.CreatedAt.Time, Read: row.Read}
		if row.EditedAt.Valid {
			editedAt := row.EditedAt.Time
			m.EditedAt = &editedAt
		}
		if row.DeletedAt.Valid {
			deletedAt := row.DeletedAt.Time
			m.DeletedAt = &deletedAt
		}
		if row.ExpiresAt.Valid {
			expiresAt := row.ExpiresAt.Time
			m.ExpiresAt = &expiresAt
		}
		if row.StorageKey.Valid {
			if signed, signErr := s.s3.PresignedGetObject(r.Context(), s.s3Bucket, row.StorageKey.String, 24*time.Hour, nil); signErr == nil {
				m.MediaURL = signed.String()
			}
		}
		if row.FileName.Valid {
			m.FileName = row.FileName.String
		}
		if row.ContentType.Valid {
			m.MimeType = row.ContentType.String
		}
		if row.ByteSize.Valid {
			m.ByteSize = row.ByteSize.Int64
		}
		messages = append(messages, m)
	}
	nextCursor := (*int64)(nil)
	if len(messages) > 50 {
		next := messages[50].Cursor
		nextCursor = &next
		messages = messages[:50]
	}
	writeJSON(w, 200, map[string]any{"items": messages, "nextCursor": nextCursor})
}
func (s *server) sendMessage(w http.ResponseWriter, r *http.Request, sessionID string) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, 401, "unauthorized", "Sign in anonymously first")
		return
	}
	var input struct {
		ClientOperationID string `json:"clientOperationId"`
		Body              string `json:"body"`
		Kind              string `json:"kind"`
	}
	if !decodeJSON(r, &input) || strings.TrimSpace(input.Body) == "" {
		writeError(w, 400, "invalid_message", "Message body is required")
		return
	}
	if input.Kind == "" {
		input.Kind = "text"
	}
	participant, err := s.queries.IsParticipant(r.Context(), sqlc.IsParticipantParams{SessionID: sessionID, UserID: userID})
	if err != nil || !participant {
		writeError(w, 403, "forbidden", "You are not in this conversation")
		return
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		s.log.Error("message transaction start failed", "error", err, "session_id", sessionID, "user_id", userID)
		writeError(w, 500, "message_failed", "Could not prepare this message")
		return
	}
	defer tx.Rollback(r.Context())
	txQueries := sqlc.New(tx)
	cursor, err := txQueries.NextMessageCursor(r.Context(), sessionID)
	if err != nil {
		s.log.Error("message cursor reservation failed", "error", err, "session_id", sessionID, "user_id", userID)
		writeError(w, 500, "message_failed", "Could not reserve message cursor")
		return
	}
	if input.ClientOperationID == "" {
		input.ClientOperationID = ulid.Make().String()
	}
	row, err := txQueries.CreateMessage(r.Context(), sqlc.CreateMessageParams{ID: ulid.Make().String(), SessionID: sessionID, SenderID: userID, ClientOperationID: input.ClientOperationID, Cursor: cursor, Kind: input.Kind, Body: pgtype.Text{String: strings.TrimSpace(input.Body), Valid: true}})
	if err != nil {
		s.log.Error("message persistence failed", "error", err, "session_id", sessionID, "user_id", userID, "cursor", cursor)
		writeError(w, 500, "message_failed", "Could not persist message")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		s.log.Error("message transaction commit failed", "error", err, "session_id", sessionID, "user_id", userID, "cursor", cursor)
		writeError(w, 500, "message_failed", "Could not finalize this message")
		return
	}
	m := messageResponse{ID: row.ID, SessionID: row.SessionID, SenderID: row.SenderID, ClientOperationID: row.ClientOperationID, Cursor: row.Cursor, Kind: row.Kind, Body: row.Body.String, State: row.State, CreatedAt: row.CreatedAt.Time}
	if row.ExpiresAt.Valid {
		expiresAt := row.ExpiresAt.Time
		m.ExpiresAt = &expiresAt
	}
	writeJSON(w, 201, m)
	s.broadcastMessage(m)
}

func (s *server) authenticatedUser(r *http.Request) (string, bool) {
	cookie, err := r.Cookie(sessionCookie)
	if err != nil {
		return "", false
	}
	userID, err := s.queries.GetBrowserSessionUser(r.Context(), hash(cookie.Value))
	return userID, err == nil
}

func (s *server) identityLogout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(sessionCookie); err == nil {
		if err := s.queries.RevokeBrowserSession(r.Context(), hash(cookie.Value)); err != nil {
			s.log.Warn("browser session revoke failed", "error", err)
		}
	}
	if cookie, err := r.Cookie(accountCookie); err == nil {
		if err := s.queries.RevokeAccountSession(r.Context(), hash(cookie.Value)); err != nil {
			s.log.Warn("account session revoke during identity logout failed", "error", err)
		}
	}
	s.clearSessionCookie(w, r)
	s.clearAccountCookie(w, r)
	writeJSON(w, http.StatusOK, map[string]any{"signedOut": "identity", "accountSessionCleared": true, "dataDeleted": false})
}
func (s *server) security(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(self)")
		if s.cfg.allowPreviewEmbedding {
			w.Header().Set("Content-Security-Policy", previewContentSecurityPolicy)
		} else {
			w.Header().Set("X-Frame-Options", "DENY")
			w.Header().Set("Content-Security-Policy", contentSecurityPolicy)
		}
		next.ServeHTTP(w, r)
	})
}
func (s *server) withMetrics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		start := time.Now()
		next.ServeHTTP(rec, r)
		s.requests.WithLabelValues(r.Method, r.URL.Path, http.StatusText(rec.status)).Inc()
		s.log.Info("http request", "method", r.Method, "path", r.URL.Path, "status", rec.status, "duration_ms", time.Since(start).Milliseconds())
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) { r.status = code; r.ResponseWriter.WriteHeader(code) }
func (r *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := r.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("response writer does not support hijacking")
	}
	return hijacker.Hijack()
}
func (r *statusRecorder) Flush() {
	if flusher, ok := r.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func requestUsesHTTPS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	forwarded := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0])
	return strings.EqualFold(forwarded, "https")
}

func (s *server) cookieSameSite(r *http.Request) http.SameSite {
	if s.cfg.allowPreviewEmbedding && requestUsesHTTPS(r) {
		return http.SameSiteNoneMode
	}
	return http.SameSiteLaxMode
}

func (s *server) setSessionCookie(w http.ResponseWriter, r *http.Request, value string) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: value, Path: "/", HttpOnly: true, Secure: requestUsesHTTPS(r), SameSite: s.cookieSameSite(r), MaxAge: 30 * 24 * 60 * 60})
}

func (s *server) clearSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", HttpOnly: true, Secure: requestUsesHTTPS(r), SameSite: s.cookieSameSite(r), MaxAge: -1})
}

func randomToken(size int) string {
	buf := make([]byte, size)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return hex.EncodeToString(buf)
}
func hash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
func normalize(value string) string { return strings.ToLower(strings.TrimSpace(value)) }
func normalizeUsernameLookup(value string) string {
	return normalize(strings.TrimPrefix(strings.TrimSpace(value), "@"))
}
func suggestedUsername() string { return "quiet-" + randomToken(3) }
func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
func decodeJSON(r *http.Request, target any) bool {
	defer r.Body.Close()
	decoder := json.NewDecoder(io.LimitReader(r.Body, maxJSONBodyBytes+1))
	decoder.DisallowUnknownFields()
	if decoder.Decode(target) != nil {
		return false
	}
	return decoder.Decode(&struct{}{}) == io.EOF
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"code": code, "message": message})
}
func notifyShutdown(ch chan<- os.Signal) { signal.Notify(ch, os.Interrupt, syscall.SIGTERM) }

func (s *server) editMessage(w http.ResponseWriter, r *http.Request, sessionID, messageID string) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, 401, "unauthorized", "Sign in anonymously first")
		return
	}
	var input struct {
		Body string `json:"body"`
	}
	if !decodeJSON(r, &input) || strings.TrimSpace(input.Body) == "" {
		writeError(w, 400, "invalid_message", "Message body is required")
		return
	}
	row, err := s.queries.UpdateMessageBody(r.Context(), sqlc.UpdateMessageBodyParams{Body: pgtype.Text{String: strings.TrimSpace(input.Body), Valid: true}, ID: messageID, SessionID: sessionID, SenderID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 403, "edit_forbidden", "Only the sender can edit this available message")
		return
	}
	if err != nil {
		writeError(w, 500, "edit_failed", "Could not edit message")
		return
	}
	m := messageResponse{ID: row.ID, SessionID: row.SessionID, SenderID: row.SenderID, ClientOperationID: row.ClientOperationID, Cursor: row.Cursor, Kind: row.Kind, Body: row.Body.String, State: row.State, CreatedAt: row.CreatedAt.Time}
	if row.EditedAt.Valid {
		editedAt := row.EditedAt.Time
		m.EditedAt = &editedAt
	}
	if row.DeletedAt.Valid {
		deletedAt := row.DeletedAt.Time
		m.DeletedAt = &deletedAt
	}
	writeJSON(w, 200, m)
}
func (s *server) deleteMessage(w http.ResponseWriter, r *http.Request, sessionID, messageID string) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, 401, "unauthorized", "Sign in anonymously first")
		return
	}
	_, err := s.queries.DeleteMessage(r.Context(), sqlc.DeleteMessageParams{ID: messageID, SessionID: sessionID, SenderID: userID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, 403, "delete_forbidden", "Only the sender can delete this available message")
			return
		}
		writeError(w, 500, "delete_failed", "Could not delete message")
		return
	}
	writeJSON(w, 200, map[string]any{"id": messageID, "state": "deleted"})
}
func (s *server) markRead(w http.ResponseWriter, r *http.Request, sessionID, messageID string) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, 401, "unauthorized", "Sign in anonymously first")
		return
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read_failed", "Could not start read receipt")
		return
	}
	defer tx.Rollback(r.Context())
	var cursor int64
	txQueries := sqlc.New(tx)
	cursor, err = txQueries.MarkParticipantRead(r.Context(), sqlc.MarkParticipantReadParams{SessionID: sessionID, UserID: userID, ID: messageID})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 403, "read_forbidden", "You are not in this conversation")
		return
	}
	if err != nil {
		writeError(w, 500, "read_failed", "Could not update read receipt")
		return
	}
	if err := txQueries.MarkReadMessages(r.Context(), sqlc.MarkReadMessagesParams{SessionID: sessionID, SenderID: userID, Cursor: cursor}); err != nil {
		writeError(w, http.StatusInternalServerError, "read_failed", "Could not record message read state")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "read_failed", "Could not commit read receipt")
		return
	}
	s.broadcastReadReceipt(sessionID, messageID, userID)
	writeJSON(w, 200, map[string]any{"messageId": messageID, "state": "read"})
}

func (s *server) muteSession(w http.ResponseWriter, r *http.Request, sessionID string) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Sign in anonymously first")
		return
	}
	var input struct {
		DurationMinutes int `json:"durationMinutes"`
	}
	if !decodeJSON(r, &input) {
		input.DurationMinutes = 60
	}
	if input.DurationMinutes < 1 || input.DurationMinutes > 43200 {
		writeError(w, http.StatusBadRequest, "invalid_mute", "Mute duration must be between 1 minute and 30 days")
		return
	}
	participant, err := s.queries.IsParticipant(r.Context(), sqlc.IsParticipantParams{SessionID: sessionID, UserID: userID})
	if err != nil || !participant {
		writeError(w, http.StatusForbidden, "mute_forbidden", "You are not in this conversation")
		return
	}
	if err := s.queries.MuteSession(r.Context(), sqlc.MuteSessionParams{Column1: input.DurationMinutes, SessionID: sessionID, UserID: userID}); err != nil {
		writeError(w, http.StatusInternalServerError, "mute_failed", "Could not mute this conversation")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessionId": sessionID, "muted": true, "durationMinutes": input.DurationMinutes})
}

func (s *server) archiveSession(w http.ResponseWriter, r *http.Request, sessionID string) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Sign in anonymously first")
		return
	}
	participant, err := s.queries.IsParticipant(r.Context(), sqlc.IsParticipantParams{SessionID: sessionID, UserID: userID})
	if err != nil || !participant {
		writeError(w, http.StatusForbidden, "archive_forbidden", "You are not in this conversation or it is already archived")
		return
	}
	if err := s.queries.ArchiveSession(r.Context(), sqlc.ArchiveSessionParams{SessionID: sessionID, UserID: userID}); err != nil {
		writeError(w, http.StatusInternalServerError, "archive_failed", "Could not archive this conversation")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessionId": sessionID, "archived": true})
}

func (s *server) blockPeer(w http.ResponseWriter, r *http.Request, sessionID string) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Sign in anonymously first")
		return
	}
	peerID, err := s.peerInSession(r.Context(), sessionID, userID)
	if err != nil {
		writeError(w, http.StatusForbidden, "block_forbidden", "You are not in this conversation")
		return
	}
	if err := s.queries.CreateBlock(r.Context(), sqlc.CreateBlockParams{BlockerID: userID, BlockedUserID: peerID}); err != nil {
		writeError(w, http.StatusInternalServerError, "block_failed", "Could not block this peer")
		return
	}
	_ = s.queries.ArchiveSession(r.Context(), sqlc.ArchiveSessionParams{SessionID: sessionID, UserID: userID})
	writeJSON(w, http.StatusOK, map[string]any{"sessionId": sessionID, "blocked": true})
}

func (s *server) reportPeer(w http.ResponseWriter, r *http.Request, sessionID string) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Sign in anonymously first")
		return
	}
	var input struct {
		Reason string `json:"reason"`
	}
	if !decodeJSON(r, &input) || len(strings.TrimSpace(input.Reason)) < 3 || len(input.Reason) > 1000 {
		writeError(w, http.StatusBadRequest, "invalid_report", "Provide a report reason between 3 and 1000 characters")
		return
	}
	peerID, err := s.peerInSession(r.Context(), sessionID, userID)
	if err != nil {
		writeError(w, http.StatusForbidden, "report_forbidden", "You are not in this conversation")
		return
	}
	receipt, err := s.queries.CreateReportReceipt(r.Context(), sqlc.CreateReportReceiptParams{ID: ulid.Make().String(), ReporterID: userID, ReportedUserID: peerID, SessionID: sessionID, Reason: strings.TrimSpace(input.Reason), ReferenceCode: "RPT-" + strings.ToUpper(ulid.Make().String()[:10])})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "report_failed", "Could not submit this report")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"sessionId": sessionID, "reported": true, "referenceCode": receipt.ReferenceCode, "status": receipt.Status, "createdAt": receipt.CreatedAt.Time})
}

func (s *server) peerInSession(ctx context.Context, sessionID, userID string) (string, error) {
	return s.queries.GetPeerUserID(ctx, sqlc.GetPeerUserIDParams{SessionID: sessionID, UserID: userID})
}

func connectStorage(cfg config) (*minio.Client, error) {
	if cfg.s3Endpoint == "" || cfg.s3Bucket == "" || cfg.s3AccessKey == "" || cfg.s3SecretKey == "" {
		return nil, errors.New("GOCHAT_S3_ENDPOINT, GOCHAT_S3_BUCKET, GOCHAT_S3_ACCESS_KEY_ID, and GOCHAT_S3_SECRET_ACCESS_KEY are required")
	}
	parsed, err := url.Parse(cfg.s3Endpoint)
	if err != nil || parsed.Host == "" {
		return nil, fmt.Errorf("invalid S3 endpoint: %w", err)
	}
	client, err := minio.New(parsed.Host, &minio.Options{Creds: credentials.NewStaticV4(cfg.s3AccessKey, cfg.s3SecretKey, ""), Secure: parsed.Scheme == "https", Region: cfg.s3Region})
	if err != nil {
		return nil, fmt.Errorf("create S3 client: %w", err)
	}
	return client, nil
}

func (s *server) storageHealth(w http.ResponseWriter, r *http.Request) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
		exists, err := s.s3.BucketExists(ctx, s.s3Bucket)
		cancel()
		if err == nil && exists {
			writeJSON(w, http.StatusOK, map[string]any{"storage": true, "bucket": s.s3Bucket})
			return
		}
		lastErr = err
		time.Sleep(250 * time.Millisecond)
	}
	if lastErr != nil {
		s.log.Warn("object storage health probe failed", "error", lastErr)
	}
	writeError(w, http.StatusServiceUnavailable, "storage_unavailable", "Object storage is unavailable")
}

func pingPostgres(ctx context.Context, pool *pgxpool.Pool) error {
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		probe, cancel := context.WithTimeout(ctx, 10*time.Second)
		err = pool.Ping(probe)
		cancel()
		if err == nil {
			return nil
		}
		time.Sleep(time.Second)
	}
	return err
}

func pingRedis(ctx context.Context, client *redis.Client) error {
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		probe, cancel := context.WithTimeout(ctx, 10*time.Second)
		err = client.Ping(probe).Err()
		cancel()
		if err == nil {
			return nil
		}
		time.Sleep(time.Second)
	}
	return err
}

func inspectMediaUpload(prefix []byte, declaredType string) (string, string, error) {
	declaredType = strings.ToLower(strings.TrimSpace(strings.Split(declaredType, ";")[0]))
	if len(prefix) == 0 {
		return "", "", errors.New("empty upload")
	}
	canonical := func(contentType, extension string, accepted ...string) (string, string, error) {
		for _, candidate := range accepted {
			if declaredType == candidate {
				return contentType, extension, nil
			}
		}
		return "", "", fmt.Errorf("declared %q does not match detected content", declaredType)
	}
	switch {
	case bytes.HasPrefix(prefix, []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}):
		return canonical("image/png", ".png", "image/png")
	case bytes.HasPrefix(prefix, []byte{0xff, 0xd8, 0xff}):
		return canonical("image/jpeg", ".jpg", "image/jpeg")
	case bytes.HasPrefix(prefix, []byte("GIF87a")) || bytes.HasPrefix(prefix, []byte("GIF89a")):
		return canonical("image/gif", ".gif", "image/gif")
	case len(prefix) >= 12 && bytes.Equal(prefix[:4], []byte("RIFF")) && bytes.Equal(prefix[8:12], []byte("WEBP")):
		return canonical("image/webp", ".webp", "image/webp")
	case bytes.HasPrefix(prefix, []byte("%PDF-")):
		return canonical("application/pdf", ".pdf", "application/pdf")
	case len(prefix) >= 12 && bytes.Equal(prefix[:4], []byte("RIFF")) && bytes.Equal(prefix[8:12], []byte("WAVE")):
		return canonical("audio/wav", ".wav", "audio/wav", "audio/x-wav")
	case bytes.HasPrefix(prefix, []byte("OggS")):
		return canonical("audio/ogg", ".ogg", "audio/ogg")
	case bytes.HasPrefix(prefix, []byte{0x1a, 0x45, 0xdf, 0xa3}):
		return canonical(declaredType, ".webm", "audio/webm", "video/webm")
	case len(prefix) >= 12 && bytes.Equal(prefix[4:8], []byte("ftyp")):
		return canonical(declaredType, map[bool]string{true: ".m4a", false: ".mp4"}[declaredType == "audio/mp4"], "audio/mp4", "video/mp4")
	case declaredType == "text/plain" && utf8.Valid(prefix) && !bytes.Contains(prefix, []byte{0}):
		return "text/plain", ".txt", nil
	default:
		return "", "", errors.New("unsupported or unrecognized media signature")
	}
}

func normalizedMediaFileName(name, extension string) string {
	name = filepath.Base(strings.TrimSpace(name))
	if name == "." || name == "" {
		name = "upload"
	}
	stem := strings.TrimSuffix(name, filepath.Ext(name))
	stem = strings.Map(func(r rune) rune {
		if r < 32 || r == 127 || r == '/' || r == '\\' {
			return -1
		}
		return r
	}, stem)
	stem = strings.TrimSpace(stem)
	if stem == "" {
		stem = "upload"
	}
	if len(stem) > 120 {
		stem = stem[:120]
	}
	return stem + extension
}

func canStoreOwnedMedia(usedBytes, incomingBytes int64) bool {
	return usedBytes >= 0 && incomingBytes > 0 && incomingBytes <= maxMediaBytes && usedBytes <= maxOwnedMediaBytes-incomingBytes
}

func shouldCleanupUploadedMedia(persistErr error, persistedKey, uploadedKey string) bool {
	return persistErr != nil || persistedKey != uploadedKey
}

func cleanupUploadedMedia(key string, remove func(context.Context, string) error) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return remove(ctx, key)
}

func (s *server) uploadMedia(w http.ResponseWriter, r *http.Request, sessionID string) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Sign in anonymously first")
		return
	}
	participant, err := s.queries.IsParticipant(r.Context(), sqlc.IsParticipantParams{SessionID: sessionID, UserID: userID})
	if err != nil || !participant {
		writeError(w, http.StatusForbidden, "forbidden", "You are not in this conversation")
		return
	}
	clientOperationID := strings.TrimSpace(r.Header.Get("X-Client-Operation-Id"))
	if len(clientOperationID) > 128 {
		writeError(w, http.StatusBadRequest, "invalid_upload", "Invalid upload operation")
		return
	}
	if clientOperationID == "" {
		clientOperationID = ulid.Make().String()
	} else if existing, lookupErr := s.queries.GetMediaMessageByOperation(r.Context(), sqlc.GetMediaMessageByOperationParams{SenderID: userID, ClientOperationID: clientOperationID}); lookupErr == nil {
		if existing.SessionID != sessionID {
			writeError(w, http.StatusConflict, "invalid_upload_operation", "This upload operation belongs to a different conversation")
			return
		}
		mediaURL, signErr := s.s3.PresignedGetObject(r.Context(), s.s3Bucket, existing.StorageKey, 24*time.Hour, nil)
		if signErr != nil {
			writeError(w, http.StatusInternalServerError, "media_url_failed", "Could not prepare the media preview")
			return
		}
		message := messageResponse{ID: existing.ID, SessionID: existing.SessionID, SenderID: existing.SenderID, ClientOperationID: existing.ClientOperationID, Cursor: existing.Cursor, Kind: existing.Kind, Body: existing.Body, State: existing.State, CreatedAt: existing.CreatedAt.Time, MediaURL: mediaURL.String(), FileName: existing.FileName, MimeType: existing.ContentType, ByteSize: existing.ByteSize}
		writeJSON(w, http.StatusCreated, message)
		return
	} else if !errors.Is(lookupErr, pgx.ErrNoRows) {
		s.log.Error("media idempotency lookup failed", "error", lookupErr, "session_id", sessionID, "user_id", userID)
		writeError(w, http.StatusInternalServerError, "media_message_failed", "Could not prepare the media message")
		return
	}
	if !s.allowMediaUpload(r, userID) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many uploads. Try again later")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, mediaMultipartRequestBytes)
	var file io.ReadCloser = r.Body
	var mediaReader io.Reader = file
	name := r.Header.Get("X-File-Name")
	contentType := r.Header.Get("Content-Type")
	contentLength := r.ContentLength
	if strings.HasPrefix(contentType, "multipart/form-data") {
		if err := r.ParseMultipartForm(maxMediaBytes); err != nil {
			var maxBytesErr *http.MaxBytesError
			if errors.As(err, &maxBytesErr) {
				writeError(w, http.StatusRequestEntityTooLarge, "file_too_large", "Files must be between 1 byte and 50 MB")
			} else {
				writeError(w, http.StatusBadRequest, "invalid_upload", "Could not read the upload")
			}
			return
		}
		multipartFile, header, err := r.FormFile("file")
		if err != nil {
			writeError(w, http.StatusBadRequest, "missing_file", "Attach a file field")
			return
		}
		file = multipartFile
		name = header.Filename
		contentType = header.Header.Get("Content-Type")
		contentLength = header.Size
	}
	defer file.Close()
	if contentLength <= 0 || contentLength > maxMediaBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "file_too_large", "Files must be between 1 byte and 50 MB")
		return
	}
	if decodedName, decodeErr := url.PathUnescape(name); decodeErr == nil {
		name = decodedName
	}
	buffered := bufio.NewReaderSize(file, mediaSignatureProbeBytes)
	prefix, probeErr := buffered.Peek(mediaSignatureProbeBytes)
	if probeErr != nil && !errors.Is(probeErr, bufio.ErrBufferFull) && !errors.Is(probeErr, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid_upload", "Could not inspect the upload")
		return
	}
	canonicalType, extension, inspectErr := inspectMediaUpload(prefix, contentType)
	if inspectErr != nil {
		writeError(w, http.StatusUnsupportedMediaType, "unsupported_media", "Upload a supported file whose content matches its type")
		return
	}
	if strings.HasPrefix(canonicalType, "audio/") && contentLength > maxVoiceNoteBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "voice_note_too_large", "Voice notes must be 8 MB or smaller")
		return
	}
	name = normalizedMediaFileName(name, extension)
	contentType = canonicalType
	mediaReader = buffered
	usage, usageErr := s.queries.GetStorageUsage(r.Context(), userID)
	if usageErr != nil {
		writeError(w, http.StatusInternalServerError, "storage_usage_failed", "Could not verify storage usage")
		return
	}
	if !canStoreOwnedMedia(usage.Column1, contentLength) {
		writeError(w, http.StatusRequestEntityTooLarge, "storage_quota_exceeded", "Your uploaded media storage limit is 500 MB")
		return
	}
	key := fmt.Sprintf("sessions/%s/%s/%s-%s", sessionID, userID, ulid.Make().String(), name)
	if _, err := s.s3.PutObject(r.Context(), s.s3Bucket, key, mediaReader, contentLength, minio.PutObjectOptions{ContentType: contentType}); err != nil {
		writeError(w, http.StatusBadGateway, "upload_failed", "Could not store the file")
		return
	}
	cleanupObject := func() {
		if err := cleanupUploadedMedia(key, func(ctx context.Context, storageKey string) error {
			return s.s3.RemoveObject(ctx, s.s3Bucket, storageKey, minio.RemoveObjectOptions{})
		}); err != nil {
			s.log.Warn("orphaned media cleanup failed", "key", key, "error", err)
		}
	}
	messageID := ulid.Make().String()
	assetID := ulid.Make().String()
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		cleanupObject()
		writeError(w, http.StatusInternalServerError, "media_message_failed", "Could not persist the media message")
		return
	}
	defer tx.Rollback(r.Context())
	txQueries := sqlc.New(tx)
	if _, err := txQueries.LockMediaUsageOwner(r.Context(), userID); err != nil {
		cleanupObject()
		writeError(w, http.StatusInternalServerError, "storage_usage_failed", "Could not verify storage usage")
		return
	}
	transactionUsage, usageErr := txQueries.GetStorageUsage(r.Context(), userID)
	if usageErr != nil {
		cleanupObject()
		writeError(w, http.StatusInternalServerError, "storage_usage_failed", "Could not verify storage usage")
		return
	}
	if !canStoreOwnedMedia(transactionUsage.Column1, contentLength) {
		cleanupObject()
		writeError(w, http.StatusRequestEntityTooLarge, "storage_quota_exceeded", "Your uploaded media storage limit is 500 MB")
		return
	}
	cursor, err := txQueries.NextMessageCursor(r.Context(), sessionID)
	if err != nil {
		cleanupObject()
		writeError(w, http.StatusInternalServerError, "media_message_failed", "Could not reserve a message cursor")
		return
	}
	mediaRow, err := txQueries.AddMediaMessage(r.Context(), sqlc.AddMediaMessageParams{ID: messageID, SessionID: sessionID, SenderID: userID, ClientOperationID: clientOperationID, Cursor: cursor})
	var mediaAsset sqlc.UpsertMediaAssetRow
	if err == nil {
		mediaAsset, err = txQueries.UpsertMediaAsset(r.Context(), sqlc.UpsertMediaAssetParams{ID: assetID, MessageID: mediaRow.ID, StorageKey: key, FileName: name, ContentType: contentType, ByteSize: contentLength})
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		cleanupObject()
		writeError(w, http.StatusInternalServerError, "media_message_failed", "Could not persist the media message")
		return
	}
	if shouldCleanupUploadedMedia(nil, mediaAsset.StorageKey, key) {
		cleanupObject()
	}
	message := messageResponse{ID: mediaRow.ID, SessionID: mediaRow.SessionID, SenderID: mediaRow.SenderID, ClientOperationID: mediaRow.ClientOperationID, Cursor: mediaRow.Cursor, Kind: mediaRow.Kind, Body: mediaRow.Body.String, State: mediaRow.State, CreatedAt: mediaRow.CreatedAt.Time}
	if mediaRow.ExpiresAt.Valid {
		expiresAt := mediaRow.ExpiresAt.Time
		message.ExpiresAt = &expiresAt
	}
	if mediaRow.EditedAt.Valid {
		editedAt := mediaRow.EditedAt.Time
		message.EditedAt = &editedAt
	}
	if mediaRow.DeletedAt.Valid {
		deletedAt := mediaRow.DeletedAt.Time
		message.DeletedAt = &deletedAt
	}
	mediaURL, err := s.s3.PresignedGetObject(r.Context(), s.s3Bucket, mediaAsset.StorageKey, 24*time.Hour, nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "media_url_failed", "Could not prepare the media preview")
		return
	}
	message.MediaURL = mediaURL.String()
	message.FileName = mediaAsset.FileName
	message.MimeType = mediaAsset.ContentType
	message.ByteSize = mediaAsset.ByteSize
	writeJSON(w, http.StatusCreated, message)
	s.broadcastMessage(message)
}

func (s *server) settingsRoute(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Sign in anonymously first")
		return
	}
	if r.Method == http.MethodPatch {
		var input struct {
			Theme                  string  `json:"theme"`
			ReducedMotion          *bool   `json:"reducedMotion"`
			SendOnEnter            *bool   `json:"sendOnEnter"`
			PresenceVisibility     string  `json:"presenceVisibility"`
			ReadReceipts           *bool   `json:"readReceipts"`
			Notifications          *bool   `json:"notifications"`
			AvatarVisibility       string  `json:"avatarVisibility"`
			StatusVisibility       string  `json:"statusVisibility"`
			NotificationPreview    string  `json:"notificationPreview"`
			NotificationSound      *bool   `json:"notificationSound"`
			QuietHoursEnabled      *bool   `json:"quietHoursEnabled"`
			QuietHoursStart        *string `json:"quietHoursStart"`
			QuietHoursEnd          *string `json:"quietHoursEnd"`
			MediaAutoDownload      string  `json:"mediaAutoDownload"`
			LinkPreviewsEnabled    *bool   `json:"linkPreviewsEnabled"`
			PrivacyCheckupComplete *bool   `json:"privacyCheckupComplete"`
		}
		if !decodeJSON(r, &input) {
			writeError(w, http.StatusBadRequest, "invalid_settings", "Invalid settings payload")
			return
		}
		if input.Theme != "" && input.Theme != "system" && input.Theme != "light" && input.Theme != "dark" {
			writeError(w, http.StatusBadRequest, "invalid_theme", "Theme must be system, light, or dark")
			return
		}
		if input.PresenceVisibility != "" && !validVisibility(input.PresenceVisibility) {
			writeError(w, http.StatusBadRequest, "invalid_presence", "Visibility must be everyone, direct_contacts, or nobody")
			return
		}
		if input.AvatarVisibility != "" && !validVisibility(input.AvatarVisibility) || input.StatusVisibility != "" && !validVisibility(input.StatusVisibility) {
			writeError(w, http.StatusBadRequest, "invalid_visibility", "Visibility must be everyone, direct_contacts, or nobody")
			return
		}
		if input.NotificationPreview != "" && input.NotificationPreview != "full" && input.NotificationPreview != "sender" && input.NotificationPreview != "none" {
			writeError(w, http.StatusBadRequest, "invalid_notification_preview", "Notification preview must be full, sender, or none")
			return
		}
		if input.MediaAutoDownload != "" && input.MediaAutoDownload != "always" && input.MediaAutoDownload != "manual" && input.MediaAutoDownload != "never" {
			writeError(w, http.StatusBadRequest, "invalid_media_policy", "Media auto-download must be always, manual, or never")
			return
		}
		quietHoursStart, err := parseQuietHour(input.QuietHoursStart)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_quiet_hours", "Quiet hours must use HH:MM time")
			return
		}
		quietHoursEnd, err := parseQuietHour(input.QuietHoursEnd)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_quiet_hours", "Quiet hours must use HH:MM time")
			return
		}
		if input.QuietHoursEnabled != nil && *input.QuietHoursEnabled && (input.QuietHoursStart == nil || input.QuietHoursEnd == nil) {
			writeError(w, http.StatusBadRequest, "quiet_hours_required", "Choose a start and end time before enabling quiet hours")
			return
		}
		err = s.queries.UpdateSettings(r.Context(), sqlc.UpdateSettingsParams{UserID: userID, Theme: stringSetting(input.Theme), ReducedMotion: nullableBool(input.ReducedMotion), SendOnEnter: nullableBool(input.SendOnEnter), PresenceVisibility: stringSetting(input.PresenceVisibility), ReadReceipts: nullableBool(input.ReadReceipts), Notifications: nullableBool(input.Notifications), AvatarVisibility: stringSetting(input.AvatarVisibility), StatusVisibility: stringSetting(input.StatusVisibility), NotificationPreview: stringSetting(input.NotificationPreview), NotificationSound: nullableBool(input.NotificationSound), QuietHoursEnabled: nullableBool(input.QuietHoursEnabled), QuietHoursStart: quietHoursStart, QuietHoursEnd: quietHoursEnd, MediaAutoDownload: stringSetting(input.MediaAutoDownload), LinkPreviewsEnabled: nullableBool(input.LinkPreviewsEnabled), PrivacyCheckupComplete: nullableBool(input.PrivacyCheckupComplete)})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "settings_failed", "Could not save settings")
			return
		}
	}
	row, err := s.queries.GetSettings(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "settings_failed", "Could not load settings")
		return
	}
	writeJSON(w, http.StatusOK, settingsFromRow(row))
}

func validVisibility(value string) bool {
	return value == "everyone" || value == "direct_contacts" || value == "nobody"
}

func stringSetting(value string) interface{} {
	if value == "" {
		return nil
	}
	return value
}

func parseQuietHour(value *string) (pgtype.Time, error) {
	if value == nil {
		return pgtype.Time{}, nil
	}
	parsed, err := time.Parse("15:04", *value)
	if err != nil {
		return pgtype.Time{}, err
	}
	return pgtype.Time{Microseconds: int64(parsed.Hour())*int64(time.Hour/time.Microsecond) + int64(parsed.Minute())*int64(time.Minute/time.Microsecond), Valid: true}, nil
}

func quietHourString(value pgtype.Time) string {
	if !value.Valid {
		return ""
	}
	hour := value.Microseconds / int64(time.Hour/time.Microsecond)
	minute := (value.Microseconds % int64(time.Hour/time.Microsecond)) / int64(time.Minute/time.Microsecond)
	return fmt.Sprintf("%02d:%02d", hour, minute)
}

func settingsFromRow(row sqlc.GetSettingsRow) settingsResponse {
	return settingsResponse{Theme: row.Theme, ReducedMotion: row.ReducedMotion, SendOnEnter: row.SendOnEnter, PresenceVisibility: row.PresenceVisibility, ReadReceipts: row.ReadReceipts, Notifications: row.Notifications, AvatarVisibility: row.AvatarVisibility, StatusVisibility: row.StatusVisibility, NotificationPreview: row.NotificationPreview, NotificationSound: row.NotificationSound, QuietHoursEnabled: row.QuietHoursEnabled, QuietHoursStart: quietHourString(row.QuietHoursStart), QuietHoursEnd: quietHourString(row.QuietHoursEnd), MediaAutoDownload: row.MediaAutoDownload, LinkPreviewsEnabled: row.LinkPreviewsEnabled, PrivacyCheckupCompleted: row.PrivacyCheckupCompletedAt.Valid}
}

func (s *server) profileRoute(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Sign in anonymously first")
		return
	}
	if r.Method == http.MethodPatch {
		var input struct {
			StatusMessage *string `json:"statusMessage"`
		}
		if !decodeJSON(r, &input) || input.StatusMessage == nil || len([]rune(*input.StatusMessage)) > 140 {
			writeError(w, http.StatusBadRequest, "invalid_status", "Status messages must be 140 characters or fewer")
			return
		}
		row, err := s.queries.UpdateOwnProfile(r.Context(), sqlc.UpdateOwnProfileParams{UserID: userID, StatusMessage: pgtype.Text{String: strings.TrimSpace(*input.StatusMessage), Valid: true}})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "profile_failed", "Could not save profile")
			return
		}
		writeJSON(w, http.StatusOK, s.profileResponse(r.Context(), row.UserID, row.Username, row.StatusMessage, row.AvatarStorageKey))
		return
	}
	row, err := s.queries.GetOwnProfile(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "profile_failed", "Could not load profile")
		return
	}
	writeJSON(w, http.StatusOK, s.profileResponse(r.Context(), row.UserID, row.Username, row.StatusMessage, row.AvatarStorageKey))
}

func (s *server) removeProfileAvatar(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Sign in anonymously first")
		return
	}
	current, err := s.queries.GetOwnProfile(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "profile_failed", "Could not load profile")
		return
	}
	row, err := s.queries.ClearOwnProfileAvatar(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "profile_failed", "Could not remove avatar")
		return
	}
	if current.AvatarStorageKey.Valid {
		_ = s.s3.RemoveObject(r.Context(), s.s3Bucket, current.AvatarStorageKey.String, minio.RemoveObjectOptions{})
	}
	writeJSON(w, http.StatusOK, s.profileResponse(r.Context(), row.UserID, row.Username, row.StatusMessage, row.AvatarStorageKey))
}

func (s *server) profileAvatar(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Sign in anonymously first")
		return
	}
	contentType := r.Header.Get("Content-Type")
	if !strings.HasPrefix(contentType, "image/") {
		writeError(w, http.StatusUnsupportedMediaType, "invalid_avatar", "Avatar uploads must be images")
		return
	}
	const maxAvatarBytes int64 = 5 * 1024 * 1024
	if r.ContentLength > maxAvatarBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "avatar_too_large", "Avatar must be 5 MB or smaller")
		return
	}
	key := "avatars/" + userID + "/" + ulid.Make().String()
	reader := io.LimitReader(r.Body, maxAvatarBytes+1)
	if _, err := s.s3.PutObject(r.Context(), s.s3Bucket, key, reader, r.ContentLength, minio.PutObjectOptions{ContentType: contentType}); err != nil {
		writeError(w, http.StatusInternalServerError, "avatar_upload_failed", "Could not upload avatar")
		return
	}
	row, err := s.queries.UpdateOwnProfile(r.Context(), sqlc.UpdateOwnProfileParams{UserID: userID, AvatarStorageKey: pgtype.Text{String: key, Valid: true}})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "profile_failed", "Could not save avatar")
		return
	}
	writeJSON(w, http.StatusOK, s.profileResponse(r.Context(), row.UserID, row.Username, row.StatusMessage, row.AvatarStorageKey))
}

func (s *server) profileResponse(ctx context.Context, userID, username, statusMessage string, avatarKey pgtype.Text) map[string]any {
	response := map[string]any{"userId": userID, "username": username, "statusMessage": statusMessage, "avatarUrl": ""}
	if avatarKey.Valid {
		if signed, err := s.s3.PresignedGetObject(ctx, s.s3Bucket, avatarKey.String, 24*time.Hour, nil); err == nil {
			response["avatarUrl"] = signed.String()
		}
	}
	return response
}

func nullableBool(value *bool) pgtype.Bool {
	if value == nil {
		return pgtype.Bool{}
	}
	return pgtype.Bool{Bool: *value, Valid: true}
}

func (s *server) storageUsage(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Sign in anonymously first")
		return
	}
	usage, err := s.queries.GetStorageUsage(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "storage_usage_failed", "Could not load storage usage")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"usedBytes": usage.Column1, "fileCount": usage.Column2, "maxBytes": int64(500 * 1024 * 1024)})
}

func (s *server) broadcastReadReceipt(sessionID, messageID, readBy string) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	recipientIDs, err := s.queries.ListSessionParticipants(ctx, sessionID)
	if err != nil {
		return
	}
	payload, _ := json.Marshal(map[string]any{"type": "message.read", "sessionId": sessionID, "messageId": messageID, "readBy": readBy})
	for _, recipientID := range recipientIDs {
		s.wsMu.RLock()
		clients := make([]*wsClient, 0, len(s.clients[recipientID]))
		for client := range s.clients[recipientID] {
			clients = append(clients, client)
		}
		s.wsMu.RUnlock()
		for _, client := range clients {
			client.write(ctx, payload)
		}
	}
}

func (s *server) broadcastMessage(message messageResponse) {
	s.broadcastMessageLocal(message)
	if s.redis == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	payload, err := json.Marshal(messageFanoutEvent{Origin: s.instanceID, Message: message})
	if err != nil {
		return
	}
	if err := s.redis.Publish(ctx, messageFanoutChannel, payload).Err(); err != nil {
		s.log.Warn("Redis message fan-out unavailable after local delivery", "error", err)
	}
}

func (s *server) broadcastMessageLocal(message messageResponse) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	recipientIDs, err := s.queries.ListSessionParticipants(ctx, message.SessionID)
	if err != nil {
		return
	}
	payload, _ := json.Marshal(map[string]any{"type": "message.created", "sessionId": message.SessionID, "message": message})
	for _, recipientID := range recipientIDs {
		s.wsMu.RLock()
		clients := make([]*wsClient, 0, len(s.clients[recipientID]))
		for client := range s.clients[recipientID] {
			clients = append(clients, client)
		}
		s.wsMu.RUnlock()
		for _, client := range clients {
			client.write(ctx, payload)
		}
	}
}

func (s *server) broadcastUserEvent(userID string, event map[string]any) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	payload, err := json.Marshal(event)
	if err != nil {
		s.log.Warn("could not encode user event", "error", err)
		return
	}
	s.broadcastUserEventLocal(userID, payload)
	if s.redis == nil {
		return
	}
	fanoutPayload, err := json.Marshal(userEventFanout{Origin: s.instanceID, UserID: userID, Payload: payload})
	if err != nil {
		s.log.Warn("could not encode user event fan-out", "error", err)
		return
	}
	if err := s.redis.Publish(ctx, userEventFanoutChannel, fanoutPayload).Err(); err != nil {
		s.log.Warn("Redis user event fan-out unavailable after local delivery", "error", err, "user_id", userID)
	}
}

func (s *server) broadcastUserEventLocal(userID string, payload []byte) {
	s.wsMu.RLock()
	clients := make([]*wsClient, 0, len(s.clients[userID]))
	for client := range s.clients[userID] {
		clients = append(clients, client)
	}
	s.wsMu.RUnlock()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	for _, client := range clients {
		client.write(ctx, payload)
	}
}

func (s *server) setSessionNotifications(w http.ResponseWriter, r *http.Request, sessionID string) {
	userID, ok := s.authenticatedUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Sign in anonymously first")
		return
	}
	if r.Method == http.MethodGet {
		enabled, err := s.queries.GetNotificationPreference(r.Context(), sqlc.GetNotificationPreferenceParams{SessionID: sessionID, UserID: userID})
		if err != nil {
			writeError(w, http.StatusForbidden, "notifications_forbidden", "You are not in this conversation")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"sessionId": sessionID, "notificationsEnabled": enabled})
		return
	}
	var input struct {
		Enabled *bool `json:"enabled"`
	}
	if !decodeJSON(r, &input) || input.Enabled == nil {
		writeError(w, http.StatusBadRequest, "invalid_notifications", "Provide an enabled boolean")
		return
	}
	participant, err := s.queries.IsParticipant(r.Context(), sqlc.IsParticipantParams{SessionID: sessionID, UserID: userID})
	if err != nil || !participant {
		writeError(w, http.StatusForbidden, "notifications_forbidden", "You are not in this conversation")
		return
	}
	if err := s.queries.SetNotificationPreference(r.Context(), sqlc.SetNotificationPreferenceParams{NotificationsEnabled: *input.Enabled, SessionID: sessionID, UserID: userID}); err != nil {
		writeError(w, http.StatusInternalServerError, "notifications_failed", "Could not save conversation notifications")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessionId": sessionID, "notificationsEnabled": *input.Enabled})
}
