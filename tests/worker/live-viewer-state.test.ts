import { describe, expect, it } from "vitest";
import {
  initialLivePublicationState,
  livePublicationReducer,
  livePublicationView,
} from "../../src/viewer/live/state";

describe("Live viewer publication state", () => {
  it("distinguishes Published, Saving, Unsaved Draft, Checkpointing, and Conflict", () => {
    const published = initialLivePublicationState(10);
    expect(livePublicationView(published)).toMatchObject({
      label: "Published v10",
      busy: false,
      canCheckpoint: false,
      tone: "published",
    });

    const saving = livePublicationReducer(published, { type: "save-started" });
    expect(livePublicationView(saving)).toMatchObject({
      label: "Saving Draft…",
      busy: true,
      canCheckpoint: false,
    });

    const unsaved = livePublicationReducer(saving, {
      type: "draft-loaded",
      revision: 3,
      baseVersion: 10,
      state: "active",
      checkpointVersion: null,
    });
    expect(livePublicationView(unsaved)).toMatchObject({
      label: "Unsaved Draft r3",
      detail: "Based on published v10",
      busy: false,
      canCheckpoint: true,
      tone: "draft",
    });

    const checkpointing = livePublicationReducer(unsaved, {
      type: "checkpoint-started",
    });
    expect(livePublicationView(checkpointing)).toMatchObject({
      label: "Checkpointing Draft r3…",
      busy: true,
      canCheckpoint: false,
    });

    const conflict = livePublicationReducer(checkpointing, {
      type: "checkpoint-conflict",
      currentVersion: 11,
    });
    expect(livePublicationView(conflict)).toMatchObject({
      label: "Conflict — Draft r3 preserved",
      detail: "Draft base v10; published v11",
      busy: false,
      canCheckpoint: false,
      tone: "conflict",
    });
  });

  it("marks checkpoint success as the new immutable published version", () => {
    const draft = livePublicationReducer(initialLivePublicationState(4), {
      type: "draft-loaded",
      revision: 8,
      baseVersion: 4,
      state: "active",
      checkpointVersion: null,
    });
    const next = livePublicationReducer(
      livePublicationReducer(draft, { type: "checkpoint-started" }),
      { type: "checkpoint-succeeded", version: 5 },
    );

    expect(next).toEqual({ phase: "published", publishedVersion: 5 });
    expect(livePublicationView(next).label).toBe("Published v5");
  });

  it("restores a persisted conflict and treats a checkpointed draft as published", () => {
    const base = initialLivePublicationState(6);
    const conflict = livePublicationReducer(base, {
      type: "draft-loaded",
      revision: 2,
      baseVersion: 5,
      state: "conflict",
      checkpointVersion: null,
    });
    expect(conflict.phase).toBe("conflict");

    const checkpointed = livePublicationReducer(conflict, {
      type: "draft-loaded",
      revision: 2,
      baseVersion: 5,
      state: "checkpointed",
      checkpointVersion: 6,
    });
    expect(checkpointed).toEqual({
      phase: "published",
      publishedVersion: 6,
    });
  });

  it("surfaces an active draft whose base is no longer published as a conflict", () => {
    const state = livePublicationReducer(initialLivePublicationState(9), {
      type: "draft-loaded",
      revision: 4,
      baseVersion: 8,
      state: "active",
      checkpointVersion: null,
    });

    expect(state).toMatchObject({
      phase: "conflict",
      publishedVersion: 9,
      revision: 4,
      baseVersion: 8,
      reason: "stale-base",
    });
  });

  it("ignores checkpoint transitions when no draft is available", () => {
    const published = initialLivePublicationState(3);
    expect(
      livePublicationReducer(published, { type: "checkpoint-started" }),
    ).toBe(published);
  });
});
