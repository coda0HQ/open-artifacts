import type {
  ArtifactRecord,
  ArtifactStore,
  PublicationContext,
  PublicationResult,
} from "../store";

export type RollbackResult =
  | { ok: true; publication: Exclude<PublicationResult, { conflict: true }> }
  | {
      ok: false;
      code: "VERSION_NOT_FOUND" | "VERSION_CONFLICT";
      currentVersion: number;
      publicationId?: string;
    };

/** Rollback copies historical bytes into a new immutable version. */
export async function rollbackAsCheckpoint(
  store: ArtifactStore,
  record: ArtifactRecord,
  selectedVersion: number,
  publication?: PublicationContext,
): Promise<RollbackResult> {
  const [content, versions] = await Promise.all([
    store.getContent(record.id, selectedVersion),
    store.listVersions(record.id),
  ]);
  const selected = versions.find(
    (version) => version.version === selectedVersion,
  );
  if (!content || !selected) {
    return {
      ok: false,
      code: "VERSION_NOT_FOUND",
      currentVersion: record.currentVersion,
    };
  }
  const result = await store.update(
    record,
    {
      content: content.body,
      format: selected.format,
      title: selected.title,
      description: selected.description,
      favicon: selected.favicon,
      label: `rollback-v${selectedVersion}`,
      encrypted: content.encrypted,
      baseVersion: record.currentVersion,
      force: false,
    },
    publication,
  );
  if ("conflict" in result) {
    return {
      ok: false,
      code: "VERSION_CONFLICT",
      currentVersion: result.currentVersion,
      publicationId: result.publicationId,
    };
  }
  return { ok: true, publication: result };
}
