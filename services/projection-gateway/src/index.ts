export type { ExactOrigin, ProjectionGatewayConfig } from "./config.ts";
export { parseProjectionGatewayConfig } from "./config.ts";
export {
  createDeckAssetReader,
  createProjectionGatewayHandler,
  type DeckAssetReader,
  type ProjectionGatewayHandler,
  type ProjectionGatewayHttpDependencies,
} from "./http.ts";
export type {
  DisplayReceiptWriter,
  PublicProjectionReader,
  PublicProjectionSnapshot,
  PublicSlideProjection,
  StageAppliedReceipt,
} from "./ports/public-projection.ts";
export * from "./prepared-evidence.ts";
export * from "./realtime.ts";
