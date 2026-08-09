import { Hono } from "hono";
import { D1MetadataStore } from "./adapters/cloudflare/d1-metadata-store";
import { R2BlobStore } from "./adapters/cloudflare/r2-blob-store";
import { type AppContext, bearerToken, storeFrom } from "./api";
import { SystemClock } from "./ports/clock";
import type {
  ReconcileCursor,
  ReconcileFinding,
} from "./publication/reconcile";
import { PublicationReconciler } from "./publication/reconcile";
import { generateId, timingSafeEqual } from "./tokens";

export const reconcileApi = new Hono<AppContext>();

function parseCursor(value: unknown): ReconcileCursor | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") {
    throw new Error("cursor must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.publications !== undefined &&
      typeof candidate.publications !== "string") ||
    (candidate.blobs !== undefined && typeof candidate.blobs !== "string")
  ) {
    throw new Error("cursor values must be strings");
  }
  return {
    ...(typeof candidate.publications === "string"
      ? { publications: candidate.publications }
      : {}),
    ...(typeof candidate.blobs === "string" ? { blobs: candidate.blobs } : {}),
  };
}

function parseKinds(value: unknown): ReconcileFinding["kind"][] | undefined {
  if (value === undefined) return undefined;
  const allowed = new Set(["stale_publication", "missing_blob", "orphan_blob"]);
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((kind) => typeof kind !== "string" || !allowed.has(kind))
  ) {
    throw new Error("kinds must contain supported reconciliation findings");
  }
  return [...new Set(value)] as ReconcileFinding["kind"][];
}

reconcileApi.post("/internal/reconcile", async (c) => {
  const configured = c.env.REPAIR_TOKEN;
  const presented = bearerToken(c);
  if (!configured || !presented || !timingSafeEqual(presented, configured)) {
    return c.text("not found", 404);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "request body must be JSON" }, 400);
  }
  const auditId =
    typeof body.auditId === "string"
      ? body.auditId
      : `reconcile_${generateId()}`;
  const dryRun = body.dryRun !== false;
  if (!dryRun && c.req.header("x-open-artifacts-confirm") !== auditId) {
    return c.json(
      {
        error:
          "execution requires X-Open-Artifacts-Confirm to equal the auditId",
        code: "RECONCILE_CONFIRMATION_REQUIRED",
      },
      400,
    );
  }

  try {
    // This call performs only compatibility validation in production. It
    // intentionally runs before constructing raw adapters so the operator
    // endpoint cannot bypass the no-DDL request-path policy.
    await storeFrom(c).get("__reconcile_schema_probe__");
    const reconciler = new PublicationReconciler(
      new D1MetadataStore(c.env.DB),
      new R2BlobStore(c.env.CONTENT),
      new SystemClock(),
      c.get("telemetry"),
    );
    const report = await reconciler.run({
      auditId,
      dryRun,
      limit: typeof body.limit === "number" ? body.limit : 100,
      staleAfterMs:
        typeof body.staleAfterMs === "number"
          ? body.staleAfterMs
          : 30 * 60 * 1000,
      cursor: parseCursor(body.cursor),
      kinds: parseKinds(body.kinds),
    });
    return c.json(report);
  } catch (error) {
    if (error instanceof Error && /must be|cursor/.test(error.message)) {
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }
});
