# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.14 AS dependencies
WORKDIR /app

COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY apps/console/package.json apps/console/package.json
COPY apps/stage/package.json apps/stage/package.json
COPY services/model-router/package.json services/model-router/package.json
COPY services/private-backend/package.json services/private-backend/package.json
COPY services/projection-gateway/package.json services/projection-gateway/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/slide-runtime/package.json packages/slide-runtime/package.json
COPY packages/state/package.json packages/state/package.json
COPY packages/test-harness/package.json packages/test-harness/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN bun install --frozen-lockfile --filter @impromptu/stage

FROM dependencies AS builder
ARG IMPROMPTU_RELEASE_COHORT=stable
# Deliberately no STAGE_PUBLIC_API_ORIGIN: the bundle addresses the origin it was served from and
# the runtime stage below proxies /v1 to the gateway. The audience session arrives as a
# SameSite=Strict cookie, which a browser discards when it comes back on a cross-SITE response, so
# any deployment that puts the gateway on a different registrable domain than Stage would lose the
# session on arrival. Serving both from one origin removes that dependency on deployment DNS, and
# collapses the CSP, WebSocket-origin and deck-asset URL configuration along with it.
ENV NODE_ENV=production \
    IMPROMPTU_RELEASE_COHORT=${IMPROMPTU_RELEASE_COHORT}
COPY apps/stage apps/stage
COPY packages/contracts packages/contracts
COPY packages/slide-runtime packages/slide-runtime
COPY packages/state packages/state
COPY packages/ui packages/ui
RUN bun run --cwd apps/stage build \
    && find apps/stage/dist -type f -name '*.map' -delete \
    && printf 'ok\n' > apps/stage/dist/health

FROM nginxinc/nginx-unprivileged:1.29.5-alpine AS runtime
COPY --from=builder --chown=nginx:nginx /app/apps/stage/dist /usr/share/nginx/html
USER root
RUN cat > /etc/nginx/conf.d/default.conf <<'EOF'
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  listen 8080;
  server_name _;
  root /usr/share/nginx/html;

  # The invitation token lives in the URL fragment, invisible to this server, so every Stage
  # document is served as if it could be the invitation landing: no referrer may leak and the
  # page is never stored. Same-origin /v1 mutations pin their own referrerPolicy client-side.
  add_header Referrer-Policy "no-referrer" always;

  location = /health {
    access_log off;
    add_header Content-Type text/plain;
    try_files /health =503;
  }

  # Serving the gateway from the Stage origin is what keeps the audience session cookie same-site.
  # The upstream name is the compose service; it resolves at startup because Stage waits for the
  # gateway to report healthy.
  location /v1/ {
    proxy_pass http://projection-gateway:3002;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # /v1/realtime is a WebSocket upgrade and /v1/events is an event stream. Buffering would hold
    # slide changes back until a buffer filled, which on a projector reads as a frozen screen.
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
  }

  location / {
    try_files $uri $uri/ /index.html;
  }

  # SPA fallback and direct document hits land here; add_header directives do not inherit into
  # a location that declares its own, so Referrer-Policy is repeated. Hashed assets keep their
  # default cacheability.
  location = /index.html {
    add_header Referrer-Policy "no-referrer" always;
    add_header Cache-Control "no-store" always;
  }
}
EOF
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["wget", "--quiet", "--output-document=-", "http://127.0.0.1:8080/health"]
