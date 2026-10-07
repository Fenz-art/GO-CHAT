# Go-Chat

Go-Chat is a private, one-to-one messaging application. People start with a
browser-based identity and discoverable username, request a private line with
another username, and can optionally attach a password-protected account to
preserve access to that same identity across sign-ins.

The application is a single-origin deployment: a statically exported Next.js
frontend and a Go HTTP/WebSocket backend are served together. PostgreSQL stores
identities, conversations, messages, settings, and account data; Redis supports
realtime fan-out across backend instances; and S3-compatible object storage
(including Backblaze B2) stores uploaded media.

**Production:** [go-chat-livid.vercel.app](https://go-chat-livid.vercel.app)

## Contents

- [Features](#features)
- [How identity and private lines work](#how-identity-and-private-lines-work)
- [Technology](#technology)
- [Repository layout](#repository-layout)
- [Requirements](#requirements)
- [Local development](#local-development)
- [Configuration](#configuration)
- [Database migrations](#database-migrations)
- [Build and run](#build-and-run)
- [Tests](#tests)
- [Deployment](#deployment)
- [HTTP API overview](#http-api-overview)
- [Security and privacy notes](#security-and-privacy-notes)
- [Troubleshooting](#troubleshooting)

## Features

### Private one-to-one conversations

- Search for a username and send a request to open a private line.
- The recipient can accept, decline, or block the request.
- A conversation is opened only after the recipient accepts.
- Messages, delivery/read receipts, typing status, and request events use
  WebSockets for realtime updates. Redis Pub/Sub carries relevant events across
  backend instances.
- Conversation controls include notification preferences, archive/block/report,
  local chat locking for linked accounts, and configurable message retention.

### Messaging and media

- Send text and supported file attachments.
- Record voice notes, pause/resume recordings, review them, and queue them to
  send with other attachments.
- Share images, video, audio, PDFs, and plain text files within configured
  upload limits.
- Choose whether media previews download automatically.
- Search conversation history and browse shared items.

### Identity, accounts, and recovery

- Start with an anonymous browser identity and choose a discoverable username.
- Optionally create a private account to attach sign-in credentials to the
  existing identity. The account username is for sign-in; it does not replace
  the discoverable chat username.
- Sign in with an account username or email and password to resume its linked
  identity.
- Verify the recovery email, request a password reset, and manage/revoke
  account sessions.
- Export account data and submit a data-deletion request.

### Profile, privacy, and accessibility

- Customize profile details and avatar.
- Configure presence, avatar, and status visibility.
- Adjust notification previews, quiet hours, notification sounds, read
  receipts, and reduced motion.
- Choose message-send and media-download preferences.
- Responsive interface with keyboard-accessible controls and reduced-motion
  support.

## How identity and private lines work

1. **Create or resume a browser identity.** Go-Chat assigns an identity that
   exists independently of a password-protected account.
2. **Choose a discoverable username.** Other users can look up this handle
   according to the application’s discovery rules.
3. **Optionally secure the identity.** Creating an account attaches an account
   username, recovery email, and password to the identity currently active in
   the browser. It does not create another chat identity or move existing
   conversations.
4. **Request a line.** A user sends a private-line request to another
   discoverable username.
5. **The recipient decides.** Accepting creates the one-to-one conversation;
   declining or blocking does not open it.

Keep access to the browser identity or create an account if you need to resume
it after losing browser data. A private account is an account-continuity feature;
it is distinct from the discoverable username shown to other Go-Chat users.

## Technology

| Area             | Technology                                                  |
| ---------------- | ----------------------------------------------------------- |
| Frontend         | Next.js, React, TypeScript, Tailwind CSS                    |
| Backend          | Go `net/http`, WebSockets                                   |
| Database         | PostgreSQL, `pgx`, Goose migrations, sqlc-generated queries |
| Realtime fan-out | Redis Pub/Sub                                               |
| Object storage   | S3-compatible API via MinIO Go SDK                          |
| Hosting          | Vercel container deployment                                 |
| Frontend tests   | Vitest, Testing Library                                     |

## Repository layout

```text
app/                         Next.js app entry points and global styles
components/                  UI, onboarding, chat, settings, and account panels
shared/                      Shared presentation and state helpers
backend/cmd/server/          Go HTTP server and WebSocket handlers
backend/cmd/migrate/         PostgreSQL migration command
backend/internal/sqlc/       Generated database query code
backend/migrations/          Versioned Goose SQL migrations
backend/sql/                 SQL query definitions used by sqlc
tests/                       Frontend, backend-integration, and realtime tests
Dockerfile                   General production container
Dockerfile.vercel            Vercel frontend-export + Go container build
```

## Requirements

- Node.js 22 or newer and [pnpm](https://pnpm.io/) (the project pins pnpm
  `10.4.1` in `package.json`).
- Go 1.24 or newer for the backend and migration tool.
- PostgreSQL.
- Redis.
- An S3-compatible bucket and credentials (Backblaze B2 is supported).
- SMTP credentials if account-verification and password-reset emails should be
  delivered.

PostgreSQL, Redis, and S3-compatible storage are required for the Go service to
start. SMTP settings are optional for running chat locally, but email-dependent
account recovery and verification need a working SMTP configuration.

## Local development

1. Install dependencies:

   ```sh
   pnpm install
   go mod download
   ```

2. Copy the configuration template and edit it:

   ```sh
   cp .env.example .env
   ```

   Set the variables described in [Configuration](#configuration). Go does not
   automatically load `.env`; export its values into the environment (or
   configure them in your IDE/run environment) before starting commands. For a
   shell-compatible `.env`, load it with:

   ```sh
   set -a
   . ./.env
   set +a
   ```

3. Apply database migrations:

   ```sh
   pnpm db:migrate
   ```

4. Start Go-Chat:

   ```sh
   pnpm dev
   ```

   The development command builds the statically exported frontend and starts
   the Go server. Open `http://localhost:3000` unless `PORT` is set to another
   value.

The app is served from the Go process; the static export and API share the same
origin. This also lets the browser connect to the backend WebSocket without a
separate frontend proxy.

## Configuration

See [.env.example](./.env.example) for the variable names and sample values.
Never put real credentials in source control or paste them into issue reports.

| Variable                        | Required               | Purpose                                                                                                        |
| ------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `PORT`                          | No                     | HTTP listen port; defaults to `3000` locally. Vercel container deployment uses `8080`.                         |
| `GOCHAT_POSTGRES_URL`           | Yes                    | PostgreSQL connection URL used by the server and migration command.                                            |
| `GOCHAT_REDIS_URL`              | Yes                    | Redis URL (`redis://` or TLS-enabled `rediss://`) for service health and cross-instance realtime fan-out.      |
| `GOCHAT_S3_ENDPOINT`            | Yes                    | S3-compatible endpoint URL, such as the endpoint for your Backblaze B2 region.                                 |
| `GOCHAT_S3_BUCKET`              | Yes                    | Existing bucket used for media and avatars.                                                                    |
| `GOCHAT_S3_ACCESS_KEY_ID`       | Yes                    | S3-compatible access key.                                                                                      |
| `GOCHAT_S3_SECRET_ACCESS_KEY`   | Yes                    | S3-compatible secret key.                                                                                      |
| `GOCHAT_S3_REGION`              | Recommended            | Storage region used for S3 signing; defaults to `us-east-1`. Use the region for the bucket.                    |
| `JWT_SECRET`                    | Recommended            | Secret input used to derive the scheduled retention-sweep token. Set a long random value in every environment. |
| `GOCHAT_SMTP_HOST`              | For email              | SMTP server hostname for verification and password-reset messages.                                             |
| `GOCHAT_SMTP_PORT`              | For email              | SMTP port; defaults to `587`.                                                                                  |
| `GOCHAT_SMTP_USERNAME`          | For authenticated SMTP | SMTP username.                                                                                                 |
| `GOCHAT_SMTP_PASSWORD`          | For authenticated SMTP | SMTP password.                                                                                                 |
| `GOCHAT_EMAIL_FROM`             | For email              | Sender address displayed on account emails.                                                                    |
| `GOCHAT_PUBLIC_URL`             | Recommended for email  | Public application origin used to construct links in email messages.                                           |
| `GOCHAT_ALLOW_EMBEDDED_PREVIEW` | No                     | Enables the embedded preview policy when set to `1`; leave unset in production unless required.                |

For Backblaze B2, provide the bucket’s S3-compatible endpoint, bucket name,
application key ID, application key, and region. The configured key needs the
permissions required by the application to read/write objects and check bucket
availability. Do not confuse the B2 account credentials with an S3 application
key.

## Database migrations

Migrations are versioned SQL files in `backend/migrations/` and are applied by
Goose through:

```sh
pnpm db:migrate
```

The migration command requires `GOCHAT_POSTGRES_URL`. Apply migrations once
before deploying a new backend version that depends on them. Do not run schema
migrations automatically from each serverless/container instance at startup;
multiple instances may start concurrently.

## Build and run

Build the frontend:

```sh
pnpm build:frontend
```

Build the frontend and compile the Go server:

```sh
pnpm build
```

Run the compiled server (after setting the runtime environment variables):

```sh
pnpm start
```

Build the general container from the repository root:

```sh
docker build -t go-chat .
```

The Vercel deployment uses `Dockerfile.vercel`, which builds the frontend
static export and Go server into one non-root runtime image.

## Tests

Run frontend unit/component tests:

```sh
pnpm test
```

Run TypeScript validation:

```sh
pnpm check
```

Run Go tests:

```sh
pnpm go:test
```

Some tests are integration checks and are skipped unless explicitly enabled.
They need reachable services or running application instances:

```sh
GOCHAT_INTEGRATION=1 \
GOCHAT_RUNTIME_URL=http://localhost:3000 \
pnpm exec vitest run tests/session-integration.test.ts
```

Cross-instance realtime tests require two reachable Go-Chat instances that
share PostgreSQL and Redis:

```sh
GOCHAT_CROSS_INSTANCE_INTEGRATION=1 \
GOCHAT_RUNTIME_URL=http://localhost:3000 \
GOCHAT_SECOND_RUNTIME_URL=http://localhost:3001 \
pnpm exec vitest run tests/cross-instance-realtime.integration.test.ts
```

Storage checks can be enabled with
`GOCHAT_STORAGE_INTEGRATION=1` and `GOCHAT_RUNTIME_URL`. The runtime health test
also requires `GOCHAT_POSTGRES_URL`, `GOCHAT_REDIS_URL`, and a live health
endpoint; it is not a self-contained unit test.

## Deployment

The production deployment runs on Vercel as a container built from
`Dockerfile.vercel`. The Go server serves the statically exported Next.js site,
API routes, and WebSocket endpoint from the same origin.

For a new Vercel project:

1. Link the repository/project with the Vercel CLI or dashboard.
2. Configure the required production variables from
   [Configuration](#configuration). Add optional SMTP variables if account
   verification and recovery emails should work.
3. Make sure production PostgreSQL, Redis, and the S3-compatible bucket are
   reachable from the deployment.
4. Apply PostgreSQL migrations once using the production environment:

   ```sh
   pnpm dlx vercel env run --environment=production -- pnpm db:migrate
   ```

5. Deploy:

   ```sh
   pnpm dlx vercel deploy --prod
   ```

Set `PORT=8080` for the Vercel container runtime. Keep environment-variable
values out of command history where possible; use Vercel’s environment-variable
prompts or dashboard, and mark credentials sensitive. Production health
endpoints are available at `/api/v1/health` and `/api/v1/storage/health`.

## HTTP API overview

All application endpoints are served by the Go backend. Most `/api/v1`
endpoints require the browser identity session cookie established during
onboarding. Account endpoints additionally use the account session where
applicable. See `backend/cmd/server/` for request/response schemas and
authorization checks.

| Area                        | Routes                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health and realtime         | `GET /healthz`, `GET /api/v1/health`, `GET /api/v1/storage/health`, `GET /api/v1/realtime` (WebSocket)                                                                                      |
| Identity and onboarding     | `POST /api/v1/identity/bootstrap`, `POST /api/v1/identity/logout`, `GET /api/v1/onboarding/resume`, `POST /api/v1/onboarding/lock`, `GET /api/v1/identity/username/availability`            |
| Discovery and conversations | `GET /api/v1/search`, `GET /api/v1/sessions`, `POST /api/v1/sessions/discover`, session-specific routes under `/api/v1/sessions/{sessionID}`                                                |
| Private-line requests       | `GET /api/v1/requests`, `POST /api/v1/requests`, `POST /api/v1/requests/{requestID}`                                                                                                        |
| Accounts and recovery       | `POST/GET /api/v1/account`, `POST /api/v1/account/login`, `POST /api/v1/account/logout`, `/api/v1/account/sessions`, `/api/v1/account/email/verification`, `/api/v1/account/password/reset` |
| Profile and preferences     | `GET/PATCH /api/v1/profile`, avatar routes under `/api/v1/profile/avatar`, `GET/PATCH /api/v1/settings`                                                                                     |
| Data and operations         | `GET /api/v1/data/export`, `/api/v1/data/deletion-requests`, `POST /api/scheduled/retention-sweep`, `GET /metrics`                                                                          |

Session-specific routes include messaging, media uploads, read receipts,
conversation notifications, retention policy, local lock/unlock, archive,
block, report, and shared-item operations.

## Security and privacy notes

- Private lines require recipient acceptance, and backend handlers verify
  identity and conversation participation before performing protected actions.
- Account passwords are stored as password hashes, not plaintext. Keep account
  recovery email access current and use a unique password.
- Keep PostgreSQL, Redis, SMTP, and object-storage credentials secret. Use
  TLS-enabled service URLs where supported.
- Media is stored in a private S3-compatible bucket and accessed through
  time-limited signed URLs.
- **Private conversation access does not mean end-to-end encryption.** This
  project should not be described as E2EE unless a separately reviewed
  end-to-end encryption protocol is implemented.
- Vercel container/WebSocket lifetimes are bounded by the platform; clients
  reconnect and reload durable state after reconnecting.
- Do not commit `.env` files or production secrets.

## Troubleshooting

### The server exits before it starts

Check that PostgreSQL and Redis are reachable and that `GOCHAT_POSTGRES_URL`
and `GOCHAT_REDIS_URL` are present. The server also requires valid S3 endpoint,
bucket, access key, and secret key configuration.

### Health is degraded

`GET /api/v1/health` reports the PostgreSQL and Redis checks. Confirm service
availability, connection URLs, credentials, network access, and TLS settings.
Use `/api/v1/storage/health` to check the configured bucket separately.

### Media upload fails

Check bucket access, endpoint/region correctness, and that the upload MIME type
matches its content. Voice notes are limited to 8 MiB and five minutes;
attachments have server-side size/type limits.

### Verification or password-reset email does not arrive

Configure SMTP host, port, username/password as needed, sender address, and
public URL. Check application logs for email delivery errors and check spam or
mail-provider suppression.

### A request or message appears only after refresh

The browser needs an active WebSocket connection. Check the connection-status
indicator, confirm Redis is healthy for cross-instance fan-out, and inspect
`GET /api/v1/health`. Reconnects reload durable requests and conversation
state, but production realtime delivery depends on Redis and WebSocket
availability.

## Contributing

Keep changes focused, add or update tests for behavior changes, run the relevant
frontend and Go checks, and never include real credentials or private user data
in commits, tests, screenshots, or logs.
