export type DevelopmentService = Readonly<{
  name: "private-backend" | "projection-gateway" | "console" | "stage";
  port: 3001 | 3002 | 4173 | 4174;
  cwd: string;
  command: readonly string[];
  env: Readonly<Record<string, string>>;
}>;

const runId = process.pid.toString();

export const developmentServices = [
  {
    name: "private-backend",
    port: 3001,
    cwd: "services/private-backend",
    command: ["bun", "run", "dev"],
    env: {
      CONSOLE_ORIGIN: "http://localhost:4173",
      CONTROLLER_ACCOUNT_ID: "account_local_demo",
      CONTROLLER_USERNAME: "localdemo",
      CONTROLLER_PASSWORD: "demo-2026-password",
      DECK_ARTIFACT_ROOT: "/tmp",
      DECK_STAGING_ROOT: "/tmp",
      FFMPEG_BINARY_PATH: process.env.FFMPEG_BINARY_PATH ?? "/opt/homebrew/bin/ffmpeg",
      // Scanned decks reach the ingestion CLI's OCR path, which refuses to run until a pinned
      // tessdata directory exists. Without this the whole upload fails with error[ocr_unavailable].
      TESSDATA_PREFIX: process.env.TESSDATA_PREFIX ?? "/opt/homebrew/share/tessdata",
      WHISPER_CPP_BINARY_PATH:
        process.env.WHISPER_CPP_BINARY_PATH ?? "/opt/homebrew/bin/whisper-cli",
      WHISPER_CPP_MODEL_PATH:
        process.env.WHISPER_CPP_MODEL_PATH ?? "/Users/gahn/.cache/whisper.cpp/ggml-small-q5_1.bin",
      CHAT_MODEL_API_KEY: process.env.OPENCODE_ZEN_API_KEY ?? "local-chat-model-key-required",
      CHAT_MODEL_BASE_URL: "https://opencode.ai/zen/go/v1",
      EMBEDDING_MODEL_API_KEY: "local-embedding-token",
      EMBEDDING_MODEL_BASE_URL: "https://127.0.0.1:8443/v1",
      EMBEDDING_MODEL: "embeddinggemma",
      NODE_EXTRA_CA_CERTS: "/Users/gahn/Library/Application Support/mkcert/rootCA.pem",
      RERANK_MODEL: "deepseek-v4-flash",
      LLM_MODEL: "deepseek-v4-flash",
      VERIFIER_MODEL: "deepseek-v4-flash",
      PRIVATE_DATABASE_URL: "postgresql://private_app@127.0.0.1:5432/impromptu_private",
      PRIVATE_PREPARED_EVIDENCE_STATE_KEY: `development-private-${runId}`,
      PROJECTION_GATEWAY_ORIGIN: "http://127.0.0.1:3002",
      SERVICE_AUTH_TOKEN: "local-development-token",
    },
  },
  {
    name: "projection-gateway",
    port: 3002,
    cwd: "services/projection-gateway",
    command: ["bun", "run", "dev"],
    env: {
      DECK_ARTIFACT_ROOT: "/tmp",
      PRIVATE_BACKEND_ORIGIN: "http://127.0.0.1:3001",
      PROJECTION_DATABASE_URL: "postgresql://projection_app@127.0.0.1:5432/impromptu_projection",
      PROJECTION_GATEWAY_STATE_KEY: `development-projection-${runId}`,
      SERVICE_AUTH_TOKEN: "local-development-token",
      STAGE_ORIGIN: "http://localhost:4174",
    },
  },
  {
    name: "console",
    port: 4173,
    cwd: "apps/console",
    command: ["bun", "run", "dev"],
    env: {
      CONSOLE_PRIVATE_API_ORIGIN: "http://127.0.0.1:3001",
    },
  },
  {
    name: "stage",
    port: 4174,
    cwd: "apps/stage",
    command: ["bun", "run", "dev"],
    env: {},
  },
] as const satisfies readonly DevelopmentService[];
