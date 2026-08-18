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
      CONTROLLER_ACTOR_ID: "actor_presenter",
      CONTROLLER_AUTHORIZATION_CODE: "demo-2026",
      DECK_ARTIFACT_ROOT: "/tmp",
      DECK_STAGING_ROOT: "/tmp",
      PRIVATE_SNAPSHOT_PATH: `/tmp/impromptu-private-dev-${runId}.json`,
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
      PROJECTION_DATABASE_PATH: `/tmp/impromptu-projection-dev-${runId}.json`,
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
