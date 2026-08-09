import type { Context } from "hono";
import { resolveRuntimePolicy } from "./config";
import type { ArtifactRecord } from "./store";
import { sha256Hex, timingSafeEqual } from "./tokens";

export type Visibility = "private" | "org" | "public";

export type OwnershipGrant = {
  ownerId: string;
  orgId: string | null;
  visibility: Visibility;
};

export interface Authorizer {
  authorizeCreate(c: Context): Promise<OwnershipGrant | null>;
  authorizeView(c: Context, record: ArtifactRecord): Promise<boolean>;
  authorizeWrite(c: Context, record: ArtifactRecord): Promise<boolean>;
  canManage(c: Context, record: ArtifactRecord): Promise<boolean>;
}

export function validateVisibility(raw: unknown): Visibility | null {
  if (raw === "private" || raw === "org" || raw === "public") return raw;
  return null;
}

function bearerToken(c: Context): string | null {
  const header = c.req.header("authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

export const defaultAuthorizer: Authorizer = {
  async authorizeCreate(c) {
    const policy = resolveRuntimePolicy(
      c.env as unknown as Record<string, unknown>,
    );
    if (policy.publicCreate === "disabled") return null;
    const createToken = (c.env as { CREATE_TOKEN?: string }).CREATE_TOKEN;
    if (policy.publicCreate === "token" || createToken) {
      if (!createToken) return null;
      const token = bearerToken(c);
      const presented = token === null ? "" : token;
      if (
        token === null ||
        !timingSafeEqual(
          await sha256Hex(presented),
          await sha256Hex(createToken),
        )
      ) {
        return null;
      }
    }
    return { ownerId: "", orgId: null, visibility: "public" };
  },

  async authorizeView() {
    return true;
  },

  async authorizeWrite() {
    return false;
  },

  async canManage() {
    return false;
  },
};
