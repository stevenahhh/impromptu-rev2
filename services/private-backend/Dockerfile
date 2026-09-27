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

# whisper.cpp commit 371b5a7561823ab2bb32142d2751e35e7534727b (WHISPER_CPP_TAG b4938 in
# src/model-adapters/stt-whisper-cpp.ts). BuildKit verifies the pinned tarball hash before
# it enters the build; the runtime verifies the pinned model hash at boot.
FROM debian:bookworm-slim AS whisper-build
ARG WHISPER_CPP_COMMIT=371b5a7561823ab2bb32142d2751e35e7534727b
ARG WHISPER_CPP_TARBALL_SHA256=89051d8fca516a3ad1f5c2f8f9d2fccb089afbaec338fca3f8731999babc6f81
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates cmake g++ make \
    && rm -rf /var/lib/apt/lists/*
ADD --checksum=sha256:${WHISPER_CPP_TARBALL_SHA256} \
  https://github.com/ggml-org/whisper.cpp/archive/${WHISPER_CPP_COMMIT}.tar.gz \
  /tmp/whisper.tar.gz
RUN tar -xzf /tmp/whisper.tar.gz -C /tmp \
    && mv "/tmp/whisper.cpp-${WHISPER_CPP_COMMIT}" /src
WORKDIR /src
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF \
    && cmake --build build --config Release -j --target whisper-cli

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
    SOFFICE_PATH=/usr/bin/soffice \
    TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      ca-certificates \
      ffmpeg \
      fonts-dejavu-core \
      libgomp1 \
      libreoffice-impress \
      tesseract-ocr \
      tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --create-home --shell /usr/sbin/nologin app

# tessdata_fast commit 87416418657359cb625c412a48b6e1d6d41c29bd.
# BuildKit verifies the pinned hashes before these files enter the runtime image.
ADD --checksum=sha256:6b85e11d9bbf07863b97b3523b1b112844c43e713df8b66418a081fd1060b3b2 \
  https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd/kor.traineddata \
  /usr/share/tesseract-ocr/5/tessdata/kor.traineddata
ADD --checksum=sha256:7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2 \
  https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd/eng.traineddata \
  /usr/share/tesseract-ocr/5/tessdata/eng.traineddata
RUN test "$(wc -c < /usr/share/tesseract-ocr/5/tessdata/kor.traineddata)" = 1677415 \
    && test "$(wc -c < /usr/share/tesseract-ocr/5/tessdata/eng.traineddata)" = 4113088 \
    && chmod 0644 /usr/share/tesseract-ocr/5/tessdata/kor.traineddata \
      /usr/share/tesseract-ocr/5/tessdata/eng.traineddata

COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun-runtime /usr/local/bin/bunx /usr/local/bin/bunx
COPY --from=uv /uv /uvx /usr/local/bin/
COPY --from=ingestion-dependencies /usr/local/bin/python /usr/local/bin/python3 /usr/local/bin/python3.14 /usr/local/bin/
COPY --from=ingestion-dependencies /usr/local/lib/libpython3.14.so* /usr/local/lib/
COPY --from=ingestion-dependencies /usr/local/lib/python3.14 /usr/local/lib/python3.14
COPY --from=ingestion-dependencies /opt/ingestion-venv /opt/ingestion-venv

# Pinned local STT assets: the adapter checks the binary is executable and the model matches
# this exact byte size and SHA-256 before audio routes open.
ADD --checksum=sha256:ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin \
  /opt/whisper/ggml-small-q5_1.bin
COPY --from=whisper-build /src/build/bin/whisper-cli /opt/whisper/whisper-cli
RUN chmod 0755 /opt/whisper/whisper-cli && chmod 0644 /opt/whisper/ggml-small-q5_1.bin

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
