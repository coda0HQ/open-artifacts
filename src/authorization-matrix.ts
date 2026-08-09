export type AuthorizationRequirement =
  | "public"
  | "view"
  | "create"
  | "write"
  | "manage"
  | "comment-or-write"
  | "repair";

export interface AuthorizationRule {
  method: string;
  route: string;
  requirement: AuthorizationRequirement;
  concealDenied: boolean;
}

/**
 * Auditable route policy. Tests require every security-sensitive surface to
 * appear here; an unknown combination resolves to null (default deny).
 */
export const AUTHORIZATION_MATRIX: readonly AuthorizationRule[] = [
  {
    method: "POST",
    route: "/api/artifacts",
    requirement: "create",
    concealDenied: false,
  },
  {
    method: "GET",
    route: "/api/artifacts/:id",
    requirement: "view",
    concealDenied: true,
  },
  {
    method: "GET",
    route: "/api/artifacts/:id/raw",
    requirement: "view",
    concealDenied: true,
  },
  {
    method: "PUT",
    route: "/api/artifacts/:id",
    requirement: "write",
    concealDenied: false,
  },
  {
    method: "DELETE",
    route: "/api/artifacts/:id",
    requirement: "write",
    concealDenied: false,
  },
  {
    method: "PATCH",
    route: "/api/artifacts/:id",
    requirement: "manage",
    concealDenied: true,
  },
  {
    method: "GET",
    route: "/api/artifacts/:id/comments",
    requirement: "view",
    concealDenied: true,
  },
  {
    method: "POST",
    route: "/api/artifacts/:id/comments",
    requirement: "comment-or-write",
    concealDenied: false,
  },
  {
    method: "PATCH",
    route: "/api/artifacts/:id/comments/:commentId",
    requirement: "comment-or-write",
    concealDenied: false,
  },
  {
    method: "DELETE",
    route: "/api/artifacts/:id/comments/:commentId",
    requirement: "comment-or-write",
    concealDenied: false,
  },
  {
    method: "GET",
    route: "/api/artifacts/:id/live",
    requirement: "view",
    concealDenied: true,
  },
  {
    method: "PUT",
    route: "/api/artifacts/:id/live",
    requirement: "write",
    concealDenied: false,
  },
  {
    method: "POST",
    route: "/api/artifacts/:id/live/*",
    requirement: "write",
    concealDenied: false,
  },
  {
    method: "DELETE",
    route: "/api/artifacts/:id/live/*",
    requirement: "write",
    concealDenied: false,
  },
  {
    method: "GET",
    route: "/api/artifacts/:id/handoffs*",
    requirement: "view",
    concealDenied: true,
  },
  {
    method: "POST",
    route: "/api/artifacts/:id/handoffs",
    requirement: "write",
    concealDenied: false,
  },
  {
    method: "DELETE",
    route: "/api/artifacts/:id/handoffs/:handoffId",
    requirement: "comment-or-write",
    concealDenied: false,
  },
  {
    method: "GET",
    route: "/api/artifacts/:id/credentials",
    requirement: "write",
    concealDenied: false,
  },
  {
    method: "POST",
    route: "/api/artifacts/:id/credentials/*",
    requirement: "write",
    concealDenied: false,
  },
  {
    method: "POST",
    route: "/api/internal/reconcile",
    requirement: "repair",
    concealDenied: true,
  },
] as const;

export function authorizationRuleFor(
  method: string,
  route: string,
): AuthorizationRule | null {
  return (
    AUTHORIZATION_MATRIX.find(
      (rule) => rule.method === method.toUpperCase() && rule.route === route,
    ) ?? null
  );
}
