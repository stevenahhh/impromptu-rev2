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
ARG STAGE_PUBLIC_API_ORIGIN=https://projection-gateway.invalid
ENV NODE_ENV=production \
    IMPROMPTU_RELEASE_COHORT=${IMPROMPTU_RELEASE_COHORT} \
    STAGE_PUBLIC_API_ORIGIN=${STAGE_PUBLIC_API_ORIGIN}
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
server {
  listen 8080;
  server_name _;
  root /usr/share/nginx/html;

  location = /health {
    access_log off;
    add_header Content-Type text/plain;
    try_files /health =503;
  }

  location / {
    try_files $uri $uri/ /index.html;
  }
}
EOF
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["wget", "--quiet", "--output-document=-", "http://127.0.0.1:8080/health"]
