import { describe, expect, it, vi } from "vitest";
import { executeCredentialsCommand } from "../../skills/using-open-artifacts/scripts/commands/credentials.mjs";

describe("credentials CLI command", () => {
  it("stores a rotated token without printing it", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      json: {
        credentialId: "cred_rotated",
        writeToken: "wt_raw-secret",
        graceUntil: null,
      },
    }));
    const onToken = vi.fn();
    let output = "";
    await executeCredentialsCommand({
      action: "rotate",
      artifactId: "artifact-1",
      apiUrl: "https://artifacts.test",
      writeToken: "wt_old-secret",
      authToken: null,
      graceSeconds: 0,
      request,
      onToken,
      write: (line: string) => {
        output += line;
      },
    });

    expect(onToken).toHaveBeenCalledWith("wt_raw-secret");
    expect(output).toContain("cred_rotated");
    expect(output).not.toContain("wt_raw-secret");
    expect(output).not.toContain("wt_old-secret");
  });

  it("removes the local token only when the primary credential is revoked", async () => {
    const onToken = vi.fn();
    await executeCredentialsCommand({
      action: "revoke",
      artifactId: "artifact-1",
      credentialId: "cred_primary",
      apiUrl: "https://artifacts.test",
      writeToken: "wt_current",
      authToken: null,
      graceSeconds: 0,
      request: async () => ({
        status: 200,
        json: { ok: true, revokedPrimary: true },
      }),
      onToken,
      write: () => {},
    });
    expect(onToken).toHaveBeenCalledWith(null);
  });
});
