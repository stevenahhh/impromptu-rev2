# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.14 AS dependencies
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
RUN bun install --frozen-lockfile --production --filter @impromptu/projection-gateway

FROM oven/bun:1.3.14 AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json bun.lock ./
COPY --chown=bun:bun services/projection-gateway services/projection-gateway
COPY --chown=bun:bun packages/contracts packages/contracts
COPY --from=dependencies --chown=bun:bun /app/services/projection-gateway/node_modules services/projection-gateway/node_modules
COPY --from=dependencies --chown=bun:bun /app/packages/contracts/node_modules packages/contracts/node_modules
RUN mkdir -p /var/lib/impromptu/projection /var/lib/impromptu/decks \
    && chown -R bun:bun /var/lib/impromptu

USER bun
EXPOSE 3002
CMD ["bun", "run", "services/projection-gateway/src/main.ts"]
