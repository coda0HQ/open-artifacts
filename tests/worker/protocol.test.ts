import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import createSchema from "../../protocol/v1/create-request.schema.json";
import errorSchema from "../../protocol/v1/error.schema.json";
import liveCheckpointSchema from "../../protocol/v1/live-checkpoint.schema.json";
import checkpointResponseSchema from "../../protocol/v1/live-checkpoint-response.schema.json";
import liveDraftSchema from "../../protocol/v1/live-draft.schema.json";
import draftResponseSchema from "../../protocol/v1/live-draft-response.schema.json";
import liveErrorSchema from "../../protocol/v1/live-error.schema.json";
import manifestSchema from "../../protocol/v1/manifest.schema.json";
import updateSchema from "../../protocol/v1/update-request.schema.json";
import { validateProtocolValue } from "../../protocol/validate.mjs";
import { createApp } from "../../src/app";
import { validateCreate, validateUpdate } from "../../src/domain";
import { PROTOCOL_HEADER } from "../../src/protocol";
import createFixture from "../fixtures/protocol/v1/create.json";
import errorFixture from "../fixtures/protocol/v1/error.json";
import liveCheckpointFixture from "../fixtures/protocol/v1/live-checkpoint.json";
import checkpointResponseFixture from "../fixtures/protocol/v1/live-checkpoint-response.json";
import liveDraftFixture from "../fixtures/protocol/v1/live-draft.json";
import draftResponseFixture from "../fixtures/protocol/v1/live-draft-response.json";
import liveErrorFixture from "../fixtures/protocol/v1/live-error.json";
import manifestFixture from "../fixtures/protocol/v1/manifest.json";
import updateFixture from "../fixtures/protocol/v1/update.json";

const fixtures = [
  ["create", createFixture, createSchema],
  ["update", updateFixture, updateSchema],
  ["manifest", manifestFixture, manifestSchema],
  ["error", errorFixture, errorSchema],
  ["live draft", liveDraftFixture, liveDraftSchema],
  ["live checkpoint", liveCheckpointFixture, liveCheckpointSchema],
  ["live error", liveErrorFixture, liveErrorSchema],
  ["live draft response", draftResponseFixture, draftResponseSchema],
  [
    "live checkpoint response",
    checkpointResponseFixture,
    checkpointResponseSchema,
  ],
] as const;

describe("v1 protocol Golden Fixtures", () => {
  for (const [name, fixture, schema] of fixtures) {
    it(`validates the shared ${name} fixture`, () => {
      expect(validateProtocolValue(fixture, schema)).toEqual({
        ok: true,
        errors: [],
      });
      expect(schema.$id).toContain("/protocol/v1/");
    });
  }

  it("rejects unversioned shape drift in closed contracts", () => {
    expect(
      validateProtocolValue(
        { ...createFixture, unversionedField: true },
        createSchema,
      ),
    ).toMatchObject({ ok: false });
    expect(
      validateProtocolValue(
        {
          ...draftResponseFixture,
          draft: { ...draftResponseFixture.draft, protocolVersion: 2 },
        },
        draftResponseSchema,
      ),
    ).toMatchObject({ ok: false });
  });

  it("is accepted by the Worker domain validators", () => {
    expect(validateCreate(createFixture, 4 * 1024 * 1024)).toMatchObject({
      ok: true,
    });
    expect(validateUpdate(updateFixture, 4 * 1024 * 1024)).toMatchObject({
      ok: true,
    });
  });
});

describe("HTTP protocol negotiation", () => {
  const app = createApp();

  async function request(headers?: HeadersInit): Promise<Response> {
    const context = createExecutionContext();
    const response = await app.fetch(
      new Request("http://artifacts.test/api/not-a-route", { headers }),
      env,
      context,
    );
    await waitOnExecutionContext(context);
    return response;
  }

  it("defaults legacy clients to v1 and advertises the selected version", async () => {
    const response = await request();
    expect(response.status).toBe(404);
    expect(response.headers.get(PROTOCOL_HEADER)).toBe("1");
  });

  it("fails closed for an unsupported explicit version", async () => {
    const response = await request({ [PROTOCOL_HEADER]: "2" });
    expect(response.status).toBe(426);
    expect(response.headers.get(PROTOCOL_HEADER)).toBe("1");
    expect(await response.json()).toEqual({
      error: "protocol version 2 is not supported",
      code: "LIVE_PROTOCOL_UPGRADE_REQUIRED",
      requestedVersion: "2",
      supportedVersions: [1],
    });
  });
});
