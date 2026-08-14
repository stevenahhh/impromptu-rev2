export interface PublishedProjection {
  readonly projectionId: string;
  readonly publicCardRevision: number;
  readonly title: string;
  readonly body: string;
  readonly expiresAt: string | null;
}

export interface ProjectionTombstone {
  readonly projectionId: string;
  readonly publicCardRevision: number;
  readonly reason: "retracted" | "expired";
}

export interface PublicProjectionWriter {
  publish(projection: PublishedProjection): Promise<void>;
  tombstone(tombstone: ProjectionTombstone): Promise<void>;
}
