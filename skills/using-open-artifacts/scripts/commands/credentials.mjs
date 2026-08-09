/**
 * @typedef {{status: number, json: Record<string, any>}} RequestResult
 * @typedef {(method: string, url: string, body: unknown, token?: string | null) => Promise<RequestResult>} RequestFn
 */

/**
 * @param {{
 *   action: "rotate" | "revoke" | "status" | "recover",
 *   artifactId: string,
 *   credentialId?: string,
 *   apiUrl: string,
 *   writeToken?: string | null,
 *   authToken?: string | null,
 *   graceSeconds: number,
 *   request: RequestFn,
 *   onToken: (token: string | null) => void,
 *   write?: (line: string) => void
 * }} input
 */
export async function executeCredentialsCommand(input) {
  const write = input.write ?? ((line) => process.stdout.write(line));
  const base = `${input.apiUrl}/api/artifacts/${encodeURIComponent(input.artifactId)}/credentials`;
  const capability = input.writeToken ?? input.authToken;

  if (input.action === "rotate") {
    if (!capability)
      throw new Error(
        "credential rotation requires a write token or manager login",
      );
    const response = await input.request(
      "POST",
      `${base}/rotate`,
      { graceSeconds: input.graceSeconds },
      capability,
    );
    if (response.status !== 200) {
      throw new Error(
        `credential rotation failed (${response.status}): ${response.json.error ?? "unknown error"}`,
      );
    }
    if (typeof response.json.writeToken !== "string") {
      throw new Error("credential rotation response omitted writeToken");
    }
    input.onToken(response.json.writeToken);
    write(
      `${JSON.stringify({
        artifactId: input.artifactId,
        credentialId: response.json.credentialId,
        graceUntil: response.json.graceUntil ?? null,
        status: "rotated",
      })}\n`,
    );
    return;
  }

  if (input.action === "status") {
    if (!capability)
      throw new Error(
        "credential status requires a write token or manager login",
      );
    const response = await input.request("GET", base, undefined, capability);
    if (response.status !== 200) {
      throw new Error(
        `credential status failed (${response.status}): ${response.json.error ?? "unknown error"}`,
      );
    }
    write(`${JSON.stringify(response.json, null, 2)}\n`);
    return;
  }

  if (input.action === "revoke") {
    if (!input.credentialId)
      throw new Error("credentials revoke requires a credential id");
    if (!capability)
      throw new Error(
        "credential revocation requires a write token or manager login",
      );
    const response = await input.request(
      "POST",
      `${base}/revoke`,
      { credentialId: input.credentialId },
      capability,
    );
    if (response.status !== 200) {
      throw new Error(
        `credential revocation failed (${response.status}): ${response.json.error ?? "unknown error"}`,
      );
    }
    if (response.json.revokedPrimary === true) input.onToken(null);
    write(
      `${JSON.stringify({
        artifactId: input.artifactId,
        credentialId: input.credentialId,
        status: "revoked",
      })}\n`,
    );
    return;
  }

  if (!input.authToken) {
    throw new Error(
      "credential recovery requires an authenticated manager login",
    );
  }
  const response = await input.request(
    "POST",
    `${base}/recover`,
    {},
    input.authToken,
  );
  if (response.status !== 200) {
    throw new Error(
      `credential recovery failed (${response.status}): ${response.json.error ?? "unknown error"}`,
    );
  }
  if (typeof response.json.writeToken !== "string") {
    throw new Error("credential recovery response omitted writeToken");
  }
  input.onToken(response.json.writeToken);
  write(
    `${JSON.stringify({
      artifactId: input.artifactId,
      credentialId: response.json.credentialId,
      status: "recovered",
    })}\n`,
  );
}

/**
 * Composition wrapper used by the CLI dispatcher. Keeping it here makes the
 * command independently executable in tests while the low-level lifecycle
 * function remains dependency-injectable.
 * @param {string[]} arguments_
 * @param {Record<string, any>} flags
 * @param {{loadConfig: (flags: Record<string, any>) => Record<string, any>, loadCredentials: () => Record<string, any>, mutateCredentials: (mutate: (credentials: Record<string, any>) => void) => void, request: RequestFn}} dependencies
 */
export async function commandCredentials(arguments_, flags, dependencies) {
  const [action, artifactId, credentialId] = arguments_;
  if (!action || !["rotate", "revoke", "status", "recover"].includes(action)) {
    throw new Error("credentials requires rotate, revoke, status, or recover");
  }
  if (!artifactId) {
    throw new Error(`credentials ${action} requires an artifact id`);
  }
  const normalizedAction =
    /** @type {"rotate" | "revoke" | "status" | "recover"} */ (action);
  const config = dependencies.loadConfig(flags);
  const credentials = dependencies.loadCredentials();
  await executeCredentialsCommand({
    action: normalizedAction,
    artifactId,
    credentialId,
    apiUrl: config.apiUrl,
    writeToken: credentials.tokens[artifactId] ?? null,
    authToken: config.authToken,
    graceSeconds: Number(flags.grace ?? "0"),
    request: dependencies.request,
    onToken: (token) => {
      dependencies.mutateCredentials((latest) => {
        if (token === null) delete latest.tokens[artifactId];
        else latest.tokens[artifactId] = token;
      });
    },
  });
}
