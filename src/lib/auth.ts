import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify, decodeJwt } from "jose";
import type { NextResponse } from "next/server";
import { ROLES, type Role } from "@/lib/roles";
import { AppError } from "@/lib/errors";

export const AUTH_COOKIE = "pss_token";

export interface TokenPayload {
  sub: string; // user id
  role: Role;
  email: string;
}

const BCRYPT_ROUNDS = 10;

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set. Copy .env.example to .env.local.");
  return new TextEncoder().encode(secret);
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function signToken(payload: TokenPayload): Promise<string> {
  return new SignJWT({ role: payload.role, email: payload.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(process.env.JWT_EXPIRES_IN || "7d")
    .sign(getSecret());
}

/** Verifies signature and expiry. Throws a 401 `AppError` if the token is invalid. */
export async function verifyToken(token: string): Promise<TokenPayload> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ["HS256"] });
    const { sub, role, email } = payload;
    if (typeof sub !== "string" || typeof email !== "string" || !ROLES.includes(role as Role)) {
      throw new Error("Malformed token payload");
    }
    return { sub, role: role as Role, email };
  } catch {
    throw AppError.unauthorized("Invalid or expired token");
  }
}

/** Attach the `pss_token` httpOnly cookie to a response; its lifetime matches the token's `exp`. */
export function setAuthCookie(res: NextResponse, token: string): void {
  const { exp } = decodeJwt(token);
  res.cookies.set(AUTH_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    ...(exp ? { maxAge: Math.max(0, exp - Math.floor(Date.now() / 1000)) } : {}),
  });
}

export function clearAuthCookie(res: NextResponse): void {
  res.cookies.set(AUTH_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
}
