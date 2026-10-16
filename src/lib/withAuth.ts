import type { NextRequest } from "next/server";
import { AUTH_COOKIE, verifyToken } from "@/lib/auth";
import { AppError, handleError } from "@/lib/errors";
import type { Role } from "@/lib/roles";

export type { Role } from "@/lib/roles";

export interface AuthUser {
  id: string;
  role: Role;
  email: string;
}

/** Context passed to handlers. `params` is a Promise (Next.js 15+); `await ctx.params`. */
export interface AuthContext<P = Record<string, never>> {
  user: AuthUser;
  params: Promise<P>;
}

export type AuthedHandler<P> = (req: NextRequest, ctx: AuthContext<P>) => Response | Promise<Response>;

function extractToken(req: NextRequest): string | null {
  const header = req.headers.get("authorization");
  if (header) {
    const [scheme, token] = header.split(" ");
    if (scheme?.toLowerCase() === "bearer" && token) return token;
  }
  return req.cookies.get(AUTH_COOKIE)?.value ?? null;
}

/**
 * Wrap a route handler with authentication and role checks.
 * Reads `Authorization: Bearer <token>` first, then the `pss_token` cookie.
 *
 * @example
 *   export const GET = withAuth<{ id: string }>("any", async (req, { user, params }) => {
 *     const { id } = await params;
 *     ...
 *   });
 */
export function withAuth<P = Record<string, never>>(roles: Role[] | "any", handler: AuthedHandler<P>) {
  return async (req: NextRequest, ctx: { params: Promise<P> }): Promise<Response> => {
    try {
      const token = extractToken(req);
      if (!token) throw AppError.unauthorized();

      const payload = await verifyToken(token);
      const user: AuthUser = { id: payload.sub, role: payload.role, email: payload.email };

      if (roles !== "any" && !roles.includes(user.role)) {
        throw AppError.forbidden("Insufficient role for this action");
      }
      return await handler(req, { user, params: ctx.params });
    } catch (err) {
      return handleError(err);
    }
  };
}

/** Passengers may only touch their own resources; staff may touch anything. Throws 403 otherwise. */
export function assertOwnerOrStaff(user: AuthUser, ownerId: { toString(): string } | string): void {
  if (user.role === "staff") return;
  if (user.id !== ownerId.toString()) throw AppError.forbidden();
}
