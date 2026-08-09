export type LivePublicationState =
  | { phase: "published"; publishedVersion: number }
  | { phase: "saving"; publishedVersion: number }
  | {
      phase: "unsaved";
      publishedVersion: number;
      revision: number;
      baseVersion: number;
    }
  | {
      phase: "checkpointing";
      publishedVersion: number;
      revision: number;
      baseVersion: number;
    }
  | {
      phase: "conflict";
      publishedVersion: number;
      revision: number;
      baseVersion: number;
      reason: "revision" | "stale-base" | "expired";
    };

export type LivePublicationEvent =
  | { type: "save-started" }
  | {
      type: "draft-loaded";
      revision: number;
      baseVersion: number;
      state: "active" | "checkpointed" | "conflict" | "expired";
      checkpointVersion: number | null;
    }
  | {
      type: "save-conflict";
      revision: number;
      baseVersion: number;
    }
  | { type: "checkpoint-started" }
  | { type: "checkpoint-succeeded"; version: number }
  | { type: "checkpoint-conflict"; currentVersion: number }
  | { type: "draft-missing"; publishedVersion?: number };

export interface LivePublicationView {
  label: string;
  detail: string;
  busy: boolean;
  canCheckpoint: boolean;
  tone: "published" | "saving" | "draft" | "conflict";
}

export function initialLivePublicationState(
  publishedVersion: number,
): LivePublicationState {
  return { phase: "published", publishedVersion };
}

export function livePublicationReducer(
  state: LivePublicationState,
  event: LivePublicationEvent,
): LivePublicationState {
  if (event.type === "save-started") {
    return { phase: "saving", publishedVersion: state.publishedVersion };
  }
  if (event.type === "draft-missing") {
    return {
      phase: "published",
      publishedVersion: event.publishedVersion ?? state.publishedVersion,
    };
  }
  if (event.type === "draft-loaded") {
    if (event.state === "checkpointed") {
      return {
        phase: "published",
        publishedVersion: event.checkpointVersion ?? state.publishedVersion,
      };
    }
    if (event.state === "conflict" || event.state === "expired") {
      return {
        phase: "conflict",
        publishedVersion: state.publishedVersion,
        revision: event.revision,
        baseVersion: event.baseVersion,
        reason: event.state === "expired" ? "expired" : "stale-base",
      };
    }
    if (event.baseVersion !== state.publishedVersion) {
      return {
        phase: "conflict",
        publishedVersion: state.publishedVersion,
        revision: event.revision,
        baseVersion: event.baseVersion,
        reason: "stale-base",
      };
    }
    return {
      phase: "unsaved",
      publishedVersion: state.publishedVersion,
      revision: event.revision,
      baseVersion: event.baseVersion,
    };
  }
  if (event.type === "save-conflict") {
    return {
      phase: "conflict",
      publishedVersion: state.publishedVersion,
      revision: event.revision,
      baseVersion: event.baseVersion,
      reason: "revision",
    };
  }
  if (event.type === "checkpoint-started") {
    if (state.phase !== "unsaved") return state;
    return { ...state, phase: "checkpointing" };
  }
  if (event.type === "checkpoint-succeeded") {
    return { phase: "published", publishedVersion: event.version };
  }
  if (state.phase !== "checkpointing" && state.phase !== "unsaved") {
    return state;
  }
  return {
    phase: "conflict",
    publishedVersion: event.currentVersion,
    revision: state.revision,
    baseVersion: state.baseVersion,
    reason: "stale-base",
  };
}

export function livePublicationView(
  state: LivePublicationState,
): LivePublicationView {
  if (state.phase === "published") {
    return {
      label: `Published v${state.publishedVersion}`,
      detail: "Published history is immutable",
      busy: false,
      canCheckpoint: false,
      tone: "published",
    };
  }
  if (state.phase === "saving") {
    return {
      label: "Saving Draft…",
      detail: `Published v${state.publishedVersion} is unchanged`,
      busy: true,
      canCheckpoint: false,
      tone: "saving",
    };
  }
  if (state.phase === "unsaved") {
    return {
      label: `Unsaved Draft r${state.revision}`,
      detail: `Based on published v${state.baseVersion}`,
      busy: false,
      canCheckpoint: true,
      tone: "draft",
    };
  }
  if (state.phase === "checkpointing") {
    return {
      label: `Checkpointing Draft r${state.revision}…`,
      detail: `Published v${state.publishedVersion} remains readable`,
      busy: true,
      canCheckpoint: false,
      tone: "saving",
    };
  }
  return {
    label:
      state.reason === "expired"
        ? `Draft r${state.revision} expired`
        : `Conflict — Draft r${state.revision} preserved`,
    detail:
      state.reason === "revision"
        ? `A newer Draft revision exists; published v${state.publishedVersion} is unchanged`
        : `Draft base v${state.baseVersion}; published v${state.publishedVersion}`,
    busy: false,
    canCheckpoint: false,
    tone: "conflict",
  };
}
