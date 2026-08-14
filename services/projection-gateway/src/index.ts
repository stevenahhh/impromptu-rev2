export type { ExactOrigin, ProjectionGatewayConfig } from "./config.ts";
export { parseProjectionGatewayConfig } from "./config.ts";
export {
  createProjectionGatewayHandler,
  type ProjectionGatewayHandler,
  type ProjectionGatewayHttpDependencies,
} from "./http.ts";
export type {
  DisplayReceiptWriter,
  PublicProjectionReader,
  PublicProjectionSnapshot,
  PublicSlideProjection,
  PublishedAudienceCard,
  StageAppliedReceipt,
} from "./ports/public-projection.ts";
export * from "./prepared-evidence.ts";
