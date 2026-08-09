import type {
  LiveDraft,
  RealtimeSessionStore,
} from "../../ports/realtime-session-store";

export class MemoryRealtimeSessionStore implements RealtimeSessionStore {
  private readonly drafts = new Map<string, LiveDraft>();

  async getDraft(artifactId: string): Promise<LiveDraft | null> {
    const draft = this.drafts.get(artifactId);
    return draft ? structuredClone(draft) : null;
  }

  async compareAndSetDraft(
    expectedRevision: number | null,
    draft: LiveDraft,
  ): Promise<boolean> {
    const current = this.drafts.get(draft.artifactId);
    if (expectedRevision === null) {
      if (current) return false;
    } else if (!current || current.revision !== expectedRevision) {
      return false;
    }
    this.drafts.set(draft.artifactId, structuredClone(draft));
    return true;
  }
}
