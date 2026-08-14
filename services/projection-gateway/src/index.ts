export type { ExactOrigin, ProjectionGatewayConfig } from "./config.ts";
export { parseProjectionGatewayConfig } from "./config.ts";
export { createProjectionGatewayHandler } from "./http.ts";
export type {
  DisplayReceiptWriter,
  PublicProjectionReader,
  PublicProjectionSnapshot,
  PublicSlideProjection,
  PublishedAudienceCard,
  StageAppliedReceipt,
} from "./ports/public-projection.ts";
