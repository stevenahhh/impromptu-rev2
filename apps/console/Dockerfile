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
RUN bun install --frozen-lockfile

FROM dependencies AS builder
ARG CONSOLE_PRIVATE_API_ORIGIN=https://private-backend.invalid
ARG NEXT_PUBLIC_STAGE_ORIGIN=https://stage.invalid
ARG NEXT_PUBLIC_SW_COHORT=stable
ARG NEXT_PUBLIC_CO_RESIDENT_CONSOLE=false
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    CONSOLE_PRIVATE_API_ORIGIN=${CONSOLE_PRIVATE_API_ORIGIN} \
    NEXT_PUBLIC_STAGE_ORIGIN=${NEXT_PUBLIC_STAGE_ORIGIN} \
    NEXT_PUBLIC_SW_COHORT=${NEXT_PUBLIC_SW_COHORT} \
    NEXT_PUBLIC_CO_RESIDENT_CONSOLE=${NEXT_PUBLIC_CO_RESIDENT_CONSOLE}

COPY apps/console apps/console
COPY packages/contracts packages/contracts
COPY packages/state packages/state
COPY packages/ui packages/ui
RUN sed -i '/const config: NextConfig = {/a\  output: "standalone",' apps/console/next.config.ts \
    && printf 'ok\n' > apps/console/public/health \
    && bun run --cwd apps/console build

FROM node:26.0.0-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    CONSOLE_DECK_ASSET_ORIGIN=http://projection-gateway:3002 \
    HOSTNAME=0.0.0.0 \
    PORT=4173
WORKDIR /app

RUN groupadd --gid 10001 nextjs \
    && useradd --uid 10001 --gid nextjs --create-home --shell /usr/sbin/nologin nextjs
COPY --from=builder --chown=nextjs:nextjs /app/apps/console/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/apps/console/.next/static ./apps/console/.next/static
COPY --from=builder --chown=nextjs:nextjs /app/apps/console/public ./apps/console/public
WORKDIR /app/apps/console

USER nextjs
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4173/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
