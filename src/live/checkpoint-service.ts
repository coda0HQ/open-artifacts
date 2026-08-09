import type { LiveDraft } from "../ports/realtime-session-store";
import type {
  ArtifactRecord,
  ArtifactStore,
  PublicationContext,
  PublicationResult,
} from "../store";

export type CheckpointResult =
  | { ok: true; publication: Exclude<PublicationResult, { conflict: true }> }
  | { ok: false; currentVersion: number; publicationId: string | null };

export class CheckpointService {
  constructor(private readonly store: ArtifactStore) {}

  async checkpoint(
    record: ArtifactRecord,
    draft: LiveDraft,
    publication?: PublicationContext,
  ): Promise<CheckpointResult> {
    if (record.currentVersion !== draft.baseVersion) {
      return {
        ok: false,
        currentVersion: record.currentVersion,
        publicationId: null,
      };
    }
    const result = await this.store.update(
      record,
      {
        content: draft.payload.content,
        format: draft.payload.format ?? null,
        title: draft.payload.title ?? null,
        description: draft.payload.description ?? null,
        favicon: draft.payload.favicon ?? null,
        label: draft.payload.label ?? null,
        encrypted: draft.payload.encrypted ?? null,
        baseVersion: draft.baseVersion,
        force: false,
      },
      publication,
    );
    if ("conflict" in result) {
      return {
        ok: false,
        currentVersion: result.currentVersion,
        publicationId: result.publicationId,
      };
    }
    return { ok: true, publication: result };
  }
}
