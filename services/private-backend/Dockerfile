# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.14 AS bun-dependencies
WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
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
RUN bun install --frozen-lockfile --production --filter @impromptu/private-backend

FROM ghcr.io/astral-sh/uv:0.9.24 AS uv

FROM python:3.14.0-slim-bookworm AS ingestion-dependencies
COPY --from=uv /uv /uvx /usr/local/bin/
WORKDIR /app
COPY services/ingestion/pyproject.toml services/ingestion/uv.lock services/ingestion/
COPY services/ingestion/src services/ingestion/src
ENV UV_PROJECT_ENVIRONMENT=/opt/ingestion-venv \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy
RUN uv sync --project services/ingestion --frozen --no-dev

FROM oven/bun:1.3.14 AS bun-runtime

FROM node:26.0.0-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PYTHONUNBUFFERED=1 \
    UV_PROJECT_ENVIRONMENT=/opt/ingestion-venv \
    UV_NO_SYNC=1 \
    INGESTION_PROJECT_PATH=/app/services/ingestion \
    SOFFICE_PATH=/usr/bin/soffice

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      ca-certificates \
      fonts-dejavu-core \
      libreoffice-impress \
      tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --create-home --shell /usr/sbin/nologin app

COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun-runtime /usr/local/bin/bunx /usr/local/bin/bunx
COPY --from=uv /uv /uvx /usr/local/bin/
COPY --from=ingestion-dependencies /usr/local/bin/python /usr/local/bin/python3 /usr/local/bin/python3.14 /usr/local/bin/
COPY --from=ingestion-dependencies /usr/local/lib/libpython3.14.so* /usr/local/lib/
COPY --from=ingestion-dependencies /usr/local/lib/python3.14 /usr/local/lib/python3.14
COPY --from=ingestion-dependencies /opt/ingestion-venv /opt/ingestion-venv

WORKDIR /app
COPY --from=bun-dependencies --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json bun.lock ./
COPY --chown=app:app services/model-router services/model-router
COPY --chown=app:app services/private-backend services/private-backend
COPY --chown=app:app packages/contracts packages/contracts
COPY --chown=app:app packages/state packages/state
COPY --chown=app:app services/ingestion services/ingestion
COPY --from=bun-dependencies --chown=app:app /app/services/private-backend/node_modules services/private-backend/node_modules
COPY --from=bun-dependencies --chown=app:app /app/services/model-router/node_modules services/model-router/node_modules
COPY --from=bun-dependencies --chown=app:app /app/packages/contracts/node_modules packages/contracts/node_modules
COPY --from=bun-dependencies --chown=app:app /app/packages/state/node_modules packages/state/node_modules
RUN ldconfig \
    && mkdir -p /var/lib/impromptu/private /var/lib/impromptu/decks /var/lib/impromptu/staging \
    && chown -R app:app /var/lib/impromptu /opt/ingestion-venv /app/services/ingestion

USER app
EXPOSE 3001
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "services/private-backend/src/main.ts"]
