import { describe, expect, it } from "vitest";
import { hostMessage } from "../../src/viewer/frame/bridge";
import { frameMessage } from "../../src/viewer/host/bridge";
import {
  emptyCommentsMessage,
  openCommentsCount,
  visibleComments,
} from "../../src/viewer/host/comments";
import { handoffCanYield, handoffReducer } from "../../src/viewer/host/handoff";
import {
  initialPasswordState,
  passwordReducer,
} from "../../src/viewer/host/password";
import { nextToolbarIndex } from "../../src/viewer/host/toolbar";
import {
  selectedVersionTarget,
  versionOptions,
} from "../../src/viewer/host/version";

describe("Viewer directly importable modules", () => {
  it("builds deterministic version targets and refuses unknown selections", () => {
    const options = versionOptions(
      [
        {
          version: 1,
          label: "first",
          title: "One",
          description: "",
          favicon: "1️⃣",
          format: "html",
          encrypted: false,
          size: 10,
          createdAt: "2026-08-04T00:00:00Z",
        },
        {
          version: 2,
          label: null,
          title: "Two",
          description: "",
          favicon: "2️⃣",
          format: "html",
          encrypted: false,
          size: 20,
          createdAt: "2026-08-04T00:01:00Z",
        },
      ],
      2,
      "https://example.test/a/item?mode=review",
    );
    expect(options).toEqual([
      expect.objectContaining({ label: "v1", selected: false, title: "first" }),
      expect.objectContaining({ label: "v2", selected: true, title: null }),
    ]);
    expect(selectedVersionTarget(options, "1")).toBe("/a/item?mode=review&v=1");
    expect(selectedVersionTarget(options, "99")).toBeNull();
  });

  it("filters comments and keeps badges aligned with the open view", () => {
    const comments = [
      { id: "open", done: false },
      { id: "done", done: true },
    ] as unknown as Parameters<typeof openCommentsCount>[0];
    expect(openCommentsCount(comments)).toBe(1);
    expect(
      visibleComments(comments, "done").map((comment) => comment.id),
    ).toEqual(["done"]);
    expect(emptyCommentsMessage("open")).toBe("No open comments.");
  });

  it("uses a wrapping, disabled-aware toolbar focus model", () => {
    const enabled = [true, false, true];
    expect(nextToolbarIndex(0, enabled, "ArrowRight")).toBe(2);
    expect(nextToolbarIndex(2, enabled, "ArrowRight")).toBe(0);
    expect(nextToolbarIndex(0, enabled, "End")).toBe(2);
    expect(nextToolbarIndex(1, [false, false], "Home")).toBe(-1);
  });

  it("keeps password failure and success transitions explicit", () => {
    const empty = passwordReducer(initialPasswordState(), {
      type: "submit",
      password: "",
    });
    expect(empty).toEqual({ phase: "error", error: "Enter a password" });
    const decrypting = passwordReducer(empty, {
      type: "submit",
      password: "secret",
    });
    expect(passwordReducer(decrypting, { type: "succeeded" })).toEqual({
      phase: "unlocked",
      error: null,
    });
  });

  it("only accepts messages from the exact host/frame window", () => {
    const expected = {};
    const other = {};
    expect(
      hostMessage(expected, expected, { type: "oa:theme", theme: "dark" }),
    ).toMatchObject({
      type: "oa:theme",
    });
    expect(hostMessage(other, expected, { type: "oa:theme" })).toBeNull();
    expect(
      frameMessage(expected, expected, {
        type: "oa:ready",
        url: "https://attacker.invalid",
      }),
    ).toBeNull();
    expect(
      frameMessage(expected, expected, { type: "oa:ready" }),
    ).toMatchObject({
      type: "oa:ready",
    });
  });

  it("refuses dock handoff while recording, uploading, or playing", () => {
    const recording = handoffReducer(
      handoffReducer("idle", "start"),
      "countdown-complete",
    );
    expect(recording).toBe("recording");
    expect(handoffCanYield(recording)).toBe(false);
    expect(handoffCanYield(handoffReducer(recording, "cancel"))).toBe(true);
  });
});
