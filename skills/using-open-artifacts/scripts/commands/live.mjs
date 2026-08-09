/**
 * @typedef {{status: number, json: Record<string, any>}} RequestResult
 * @typedef {(method: string, url: string, body: unknown, token?: string | null, headers?: Record<string, string>) => Promise<RequestResult>} RequestFn
 */

const endpointFor = (apiUrl, artifactId, suffix) =>
  `${apiUrl.replace(/\/+$/, "")}/api/artifacts/${encodeURIComponent(artifactId)}/live/${suffix}`;

function responseError(action, response) {
  if (response.status === 426) {
    return new Error(
      `${action} requires Live protocol v1; upgrade the CLI or server`,
    );
  }
  if (response.status === 409) {
    const current =
      response.json.currentRevision === undefined
        ? ""
        : ` (current revision ${response.json.currentRevision})`;
    return new Error(
      `${response.json.error ?? `${action} conflict`}${current}`,
    );
  }
  return new Error(
    `${action} failed (${response.status}): ${response.json.error ?? "unknown error"}`,
  );
}

async function readDraft(input) {
  const endpoint = endpointFor(input.apiUrl, input.artifactId, "draft");
  const response = await input.request(
    "GET",
    endpoint,
    undefined,
    input.capability,
  );
  if (response.status === 404) return { endpoint, draft: null };
  if (response.status !== 200) throw responseError("read Live draft", response);
  const draft = response.json.draft;
  if (
    !draft ||
    !Number.isInteger(draft.revision) ||
    draft.revision < 1 ||
    !Number.isInteger(draft.baseVersion) ||
    draft.baseVersion < 1
  ) {
    throw new Error("Live draft response is missing valid revision metadata");
  }
  return { endpoint, draft };
}

/**
 * Save composed artifact bytes as a Live draft. This never publishes a version.
 *
 * @param {{
 *   artifactId: string,
 *   apiUrl: string,
 *   baseVersion: number,
 *   payload: Record<string, unknown>,
 *   capability: string,
 *   request: RequestFn,
 * }} input
 */
export async function saveLiveDraft(input) {
  const current = await readDraft(input);
  const response = await input.request(
    "PUT",
    current.endpoint,
    {
      protocolVersion: 1,
      expectedRevision: current.draft?.revision ?? 0,
      baseVersion: input.baseVersion,
      ...input.payload,
    },
    input.capability,
  );
  if (response.status !== 200) throw responseError("save Live draft", response);
  const draft = response.json.draft;
  if (!draft || !Number.isInteger(draft.revision) || draft.revision < 1) {
    throw new Error("save Live draft response omitted its revision");
  }
  return draft;
}

/**
 * Publish the current Live draft as one immutable version.
 *
 * @param {{
 *   artifactId: string,
 *   apiUrl: string,
 *   capability: string,
 *   request: RequestFn,
 * }} input
 */
export async function checkpointLiveDraft(input) {
  const current = await readDraft(input);
  if (!current.draft) {
    throw new Error(
      `no Live draft exists for ${input.artifactId}; save one with update --live first`,
    );
  }
  const response = await input.request(
    "POST",
    endpointFor(input.apiUrl, input.artifactId, "checkpoint"),
    { protocolVersion: 1, expectedRevision: current.draft.revision },
    input.capability,
    {
      "idempotency-key":
        `cli-live-checkpoint:${input.artifactId}:` +
        `r${current.draft.revision}:b${current.draft.baseVersion}`,
    },
  );
  if (response.status !== 200) {
    throw responseError("checkpoint Live draft", response);
  }
  if (!Number.isInteger(response.json.version) || response.json.version < 1) {
    throw new Error("checkpoint Live draft response omitted its version");
  }
  return response.json;
}
