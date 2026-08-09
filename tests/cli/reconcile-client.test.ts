import { describe, expect, it, vi } from "vitest";
import {
  parseReconcileArgs,
  runReconcile,
} from "../../scripts/lib/reconcile-client.mjs";

describe("repair-publications client", () => {
  it("defaults to dry-run and never prints the repair token", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.headers).toMatchObject({
          authorization: "Bearer super-secret-repair-token",
        });
        expect(JSON.parse(String(init?.body))).toMatchObject({
          auditId: "audit-cli",
          dryRun: true,
        });
        return new Response(
          JSON.stringify({ auditId: "audit-cli", dryRun: true, findings: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    let output = "";
    await runReconcile({
      options: parseReconcileArgs(["--audit-id", "audit-cli"]),
      environment: {
        OPEN_ARTIFACTS_URL: "https://staging.example.test/",
        OPEN_ARTIFACTS_REPAIR_TOKEN: "super-secret-repair-token",
      },
      fetchImpl: fetchMock,
      write: (chunk: string) => {
        output += chunk;
      },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(output).toContain('"dryRun": true');
    expect(output).not.toContain("super-secret-repair-token");
  });

  it("requires an exact second confirmation for execution", () => {
    expect(() =>
      parseReconcileArgs(["--execute", "--audit-id", "audit-cli"]),
    ).toThrow("--confirm audit-cli");
    expect(
      parseReconcileArgs([
        "--execute",
        "--audit-id",
        "audit-cli",
        "--confirm",
        "audit-cli",
      ]),
    ).toMatchObject({ dryRun: false, auditId: "audit-cli" });
  });
});
