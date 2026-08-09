import { describe, expect, it } from "vitest";
import {
  parseLiveCheckpointResponse,
  parseLiveDraftResponse,
  parseProtocolError,
} from "../../src/viewer/protocol";
import checkpointResponseFixture from "../fixtures/protocol/v1/live-checkpoint-response.json";
import draftResponseFixture from "../fixtures/protocol/v1/live-draft-response.json";
import liveErrorFixture from "../fixtures/protocol/v1/live-error.json";

describe("Viewer protocol parsers", () => {
  it("parses the same Live draft fixture used by Worker and CLI", () => {
    expect(parseLiveDraftResponse(draftResponseFixture)).toMatchObject({
      draft: {
        protocolVersion: 1,
        revision: 2,
        baseVersion: 3,
        payload: { content: "<p>draft</p>" },
      },
    });
  });

  it("parses checkpoint and structured error fixtures", () => {
    expect(parseLiveCheckpointResponse(checkpointResponseFixture)).toEqual(
      checkpointResponseFixture,
    );
    expect(parseProtocolError(liveErrorFixture)).toEqual(liveErrorFixture);
  });

  it("rejects malformed or future-version inputs before state mutation", () => {
    expect(
      parseLiveDraftResponse({
        ...draftResponseFixture,
        draft: { ...draftResponseFixture.draft, protocolVersion: 2 },
      }),
    ).toBeNull();
    expect(
      parseLiveCheckpointResponse({ ...checkpointResponseFixture, version: 0 }),
    ).toBeNull();
    expect(
      parseProtocolError({ error: "bad", currentRevision: -1 }),
    ).toBeNull();
  });
});
