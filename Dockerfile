FROM golang:1.24-alpine AS go-builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY backend ./backend
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/gochat ./backend/cmd/server
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/migrate ./backend/cmd/migrate

FROM node:22-slim AS frontend-builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g corepack@latest && corepack pnpm install --frozen-lockfile
COPY . .
RUN NODE_ENV=production corepack pnpm run build:frontend

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=go-builder /out/gochat ./gochat
COPY --from=go-builder /out/migrate ./migrate
COPY --from=go-builder /src/backend/migrations ./backend/migrations
COPY --from=frontend-builder /app/out ./out
USER 65532:65532
EXPOSE 3000
CMD ["/app/gochat"]
