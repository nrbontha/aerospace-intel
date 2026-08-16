import type { Role } from "@asi/contracts";

const VALID_ROLES = new Set<Role>(["admin", "analyst", "viewer"]);

export class AuthorizationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AuthorizationError";
    this.status = status;
    this.code = code;
  }
}

export function assertRole(
  role: unknown,
  allowedRoles: readonly Role[],
): asserts role is Role {
  if (
    typeof role !== "string" ||
    !VALID_ROLES.has(role as Role) ||
    allowedRoles.length === 0 ||
    !allowedRoles.includes(role as Role)
  ) {
    throw new AuthorizationError(
      403,
      "FORBIDDEN",
      "You do not have permission to perform this action",
    );
  }
}
