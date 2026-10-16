import { NextRequest, NextResponse } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as register } from "@/app/api/auth/register/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as me } from "@/app/api/auth/me/route";
import { POST as createStaff } from "@/app/api/auth/staff/route";
import { signToken, verifyToken } from "@/lib/auth";
import { assertOwnerOrStaff, withAuth } from "@/lib/withAuth";
import { createUser } from "@/modules/auth/service";
import { clearTestDB, startTestDB, stopTestDB } from "./helpers/db";

const URL_BASE = "http://localhost";
const noParams = { params: Promise.resolve({}) } as never;

function jsonReq(path: string, body: unknown, init: { token?: string; cookie?: string } = {}) {
  return new NextRequest(`${URL_BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.cookie ? { cookie: `pss_token=${init.cookie}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function getReq(path: string, init: { token?: string; cookie?: string } = {}) {
  return new NextRequest(`${URL_BASE}${path}`, {
    headers: {
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.cookie ? { cookie: `pss_token=${init.cookie}` } : {}),
    },
  });
}

async function loginAs(email: string, password: string) {
  const res = await login(jsonReq("/api/auth/login", { email, password }));
  return { res, body: await res.json() };
}

const newUser = { email: "Jane@Example.com", password: "Passw0rd!", name: "Jane" };

beforeAll(startTestDB);
afterAll(stopTestDB);
beforeEach(clearTestDB);

describe("register", () => {
  it("creates a passenger and ignores a requested role", async () => {
    const res = await register(jsonReq("/api/auth/register", { ...newUser, role: "staff" }));
    expect(res.status).toBe(201);
    const { user } = await res.json();
    expect(user).toMatchObject({ email: "jane@example.com", role: "passenger" });
    expect(user.passwordHash).toBeUndefined();
  });

  it("rejects duplicates (409) and invalid input (400)", async () => {
    await register(jsonReq("/api/auth/register", newUser));
    expect((await register(jsonReq("/api/auth/register", newUser))).status).toBe(409);

    const bad = await register(jsonReq("/api/auth/register", { email: "nope", password: "x", name: "" }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("VALIDATION_ERROR");
  });
});

describe("login", () => {
  it("returns a token and sets the httpOnly cookie", async () => {
    await register(jsonReq("/api/auth/register", newUser));
    const { res, body } = await loginAs("jane@example.com", newUser.password);
    expect(res.status).toBe(200);
    expect(body.user.role).toBe("passenger");
    expect(await verifyToken(body.token)).toMatchObject({ role: "passenger", email: "jane@example.com" });

    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`pss_token=${body.token}`);
    expect(cookie.toLowerCase()).toContain("httponly");
  });

  it("rejects bad credentials with 401", async () => {
    await register(jsonReq("/api/auth/register", newUser));
    expect((await loginAs("jane@example.com", "wrong-password")).res.status).toBe(401);
    expect((await loginAs("ghost@example.com", "whatever1")).res.status).toBe(401);
  });

  it("logout clears the cookie", async () => {
    const res = await logout();
    expect(res.headers.get("set-cookie")).toMatch(/pss_token=;/);
  });
});

describe("/me and role guard", () => {
  it("requires a valid token (bearer or cookie)", async () => {
    expect((await me(getReq("/api/auth/me"), noParams)).status).toBe(401);
    expect((await me(getReq("/api/auth/me", { token: "garbage" }), noParams)).status).toBe(401);

    await register(jsonReq("/api/auth/register", newUser));
    const { body } = await loginAs("jane@example.com", newUser.password);

    const viaBearer = await me(getReq("/api/auth/me", { token: body.token }), noParams);
    expect(viaBearer.status).toBe(200);
    expect((await viaBearer.json()).user.email).toBe("jane@example.com");

    const viaCookie = await me(getReq("/api/auth/me", { cookie: body.token }), noParams);
    expect(viaCookie.status).toBe(200);
  });

  it("only lets staff create staff accounts", async () => {
    await createUser({ email: "boss@airline.test", password: "Staff123!", name: "Boss", role: "staff" });
    await register(jsonReq("/api/auth/register", newUser));
    const passenger = (await loginAs("jane@example.com", newUser.password)).body.token;
    const staff = (await loginAs("boss@airline.test", "Staff123!")).body.token;
    const payload = { email: "new.staff@airline.test", password: "Staff456!", name: "New Staff" };

    expect((await createStaff(jsonReq("/api/auth/staff", payload), noParams)).status).toBe(401);
    const forbidden = await createStaff(jsonReq("/api/auth/staff", payload, { token: passenger }), noParams);
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).error.code).toBe("FORBIDDEN");

    const created = await createStaff(jsonReq("/api/auth/staff", payload, { token: staff }), noParams);
    expect(created.status).toBe(201);
    expect((await created.json()).user.role).toBe("staff");
  });

  it("withAuth injects user and awaited dynamic params; assertOwnerOrStaff enforces ownership", async () => {
    const handler = withAuth<{ id: string }>("any", async (_req, { user, params }) => {
      const { id } = await params;
      assertOwnerOrStaff(user, "owner-1");
      return NextResponse.json({ id, user });
    });
    const ctx = { params: Promise.resolve({ id: "abc" }) };

    const owner = await signToken({ sub: "owner-1", role: "passenger", email: "o@x.com" });
    const other = await signToken({ sub: "someone-else", role: "passenger", email: "s@x.com" });
    const staff = await signToken({ sub: "staff-1", role: "staff", email: "st@x.com" });

    const ok = await handler(getReq("/x", { token: owner }), ctx);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ id: "abc", user: { id: "owner-1", role: "passenger", email: "o@x.com" } });
    expect((await handler(getReq("/x", { token: staff }), ctx)).status).toBe(200);
    expect((await handler(getReq("/x", { token: other }), ctx)).status).toBe(403);
  });
});
