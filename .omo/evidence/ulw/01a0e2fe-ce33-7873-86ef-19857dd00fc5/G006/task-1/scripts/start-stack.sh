#!/usr/bin/env bash
# Task-1 baseline dev topology on alternate ports (3401/3402/4473/4474).
# The documented 3001/3002/4173/4174 ports are held by the pre-existing g003 Compose
# stack's SSH forwards; this stack mirrors scripts/dev-services.ts env verbatim.
set -u
ROOT="/Users/gahn/projects/impromptu-rev2"
EV="$ROOT/.omo/evidence/ulw/01a0e2fe-ce33-7873-86ef-19857dd00fc5/G006/task-1"
PGPORT=32771

env_shared() {
  export SERVICE_AUTH_TOKEN=local-development-token
  export DECK_ARTIFACT_ROOT=/tmp
  export DECK_STAGING_ROOT=/tmp
}

cd "$ROOT/services/private-backend" || exit 1
env_shared
CONSOLE_ORIGIN="http://localhost:4473" \
CONTROLLER_ACCOUNT_ID="account_local_demo" \
CONTROLLER_USERNAME="localdemo" \
CONTROLLER_PASSWORD="demo-2026-password" \
FFMPEG_BINARY_PATH="${FFMPEG_BINARY_PATH:-/opt/homebrew/bin/ffmpeg}" \
TESSDATA_PREFIX="${TESSDATA_PREFIX:-/opt/homebrew/share/tessdata}" \
WHISPER_CPP_BINARY_PATH="${WHISPER_CPP_BINARY_PATH:-/opt/homebrew/bin/whisper-cli}" \
WHISPER_CPP_MODEL_PATH="${WHISPER_CPP_MODEL_PATH:-/Users/gahn/.cache/whisper.cpp/ggml-small-q5_1.bin}" \
CHAT_MODEL_API_KEY="${OPENCODE_ZEN_API_KEY:-local-chat-model-key-required}" \
CHAT_MODEL_BASE_URL="https://opencode.ai/zen/go/v1" \
EMBEDDING_MODEL_API_KEY="local-embedding-token" \
EMBEDDING_MODEL_BASE_URL="https://127.0.0.1:8443/v1" \
EMBEDDING_MODEL="embeddinggemma" \
NODE_EXTRA_CA_CERTS="/Users/gahn/Library/Application Support/mkcert/rootCA.pem" \
RERANK_MODEL="deepseek-v4-flash" \
LLM_MODEL="deepseek-v4-flash" \
VERIFIER_MODEL="deepseek-v4-flash" \
PRIVATE_DATABASE_URL="postgresql://private_app@127.0.0.1:$PGPORT/impromptu_private" \
PRIVATE_PREPARED_EVIDENCE_STATE_KEY="task1-private-$$" \
PROJECTION_GATEWAY_ORIGIN="http://127.0.0.1:3402" \
PRIVATE_BACKEND_PORT=3401 \
nohup bun run src/main.ts > "$EV/services/private-backend.log" 2>&1 &
echo "backend $!"

cd "$ROOT/services/projection-gateway" || exit 1
env_shared
PRIVATE_BACKEND_ORIGIN="http://127.0.0.1:3401" \
PROJECTION_DATABASE_URL="postgresql://projection_app@127.0.0.1:$PGPORT/impromptu_projection" \
PROJECTION_GATEWAY_STATE_KEY="task1-projection-$$" \
PROJECTION_GATEWAY_PORT=3402 \
STAGE_ORIGIN="http://localhost:4474" \
nohup bun run src/main.ts > "$EV/services/projection-gateway.log" 2>&1 &
echo "gateway $!"

cd "$ROOT/apps/console" || exit 1
CONSOLE_PRIVATE_API_ORIGIN="http://127.0.0.1:3401" \
STAGE_ORIGIN="http://localhost:4474" \
nohup ./node_modules/.bin/next dev --port 4473 > "$EV/services/console.log" 2>&1 &
echo "console $!"

cd "$ROOT/apps/stage" || exit 1
PROJECTION_GATEWAY_ORIGIN="http://127.0.0.1:3402" \
nohup ./node_modules/.bin/vite --port 4474 --strictPort > "$EV/services/stage.log" 2>&1 &
echo "stage $!"
