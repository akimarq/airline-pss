import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { GET as docsRoute } from "@/app/api/docs/route";
import { GET as uiRoute } from "@/app/api/docs/ui/route";
import { buildOpenApiSpec, fromZod, listOperations, type OpenApiDocument } from "@/lib/openapi";
import { createPnrSchema, flightSearchQuery } from "@/modules/reservations/schemas";

const API_DIR = join(process.cwd(), "src", "app", "api");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === "route.ts" ? [full] : [];
  });
}

/** `METHOD /api/x/{param}` for every exported handler of every route.ts. */
function actualOperations(): string[] {
  return routeFiles(API_DIR).flatMap((file) => {
    const urlPath = "/api/" + relative(API_DIR, file).split(sep).slice(0, -1).join("/").replace(/\[([^\]]+)\]/g, "{$1}");
    const normalized = urlPath.replace(/\/$/, "");
    const source = readFileSync(file, "utf8");
    return METHODS.filter((m) => new RegExp(`export\\s+(const|async\\s+function|function)\\s+${m}\\b`).test(source)).map((m) => `${m} ${normalized}`);
  });
}

const spec = buildOpenApiSpec();

describe("OpenAPI spec", () => {
  it("documents every route.ts handler (path + method) and nothing else", () => {
    const actual = actualOperations().sort();
    expect(actual.length).toBeGreaterThan(50); // sanity: the scan finds the routes
    const documented = listOperations(spec).sort();
    expect(documented).toEqual(actual);
  });

  it("declares auth for every non-public operation, with the standard error responses", () => {
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        const label = `${method.toUpperCase()} ${path}`;
        expect(op.summary, label).toBeTruthy();
        expect(Object.keys(op.responses).some((s) => s.startsWith("2")), label).toBe(true);
        if (op["x-roles"].length === 0) {
          expect(op.security, label).toEqual([]);
        } else if (op["x-roles"].includes("cron")) {
          // scheduler endpoint: guarded by the CRON_SECRET bearer, not a user token (no role check, so no 403)
          expect(op.security, label).toEqual([{ cronSecret: [] }]);
          expect(op.responses["401"], label).toBeDefined();
        } else {
          expect(op.security, label).toEqual([{ bearerAuth: [] }, { cookieAuth: [] }]);
          expect(op.responses["401"], label).toBeDefined();
          expect(op.responses["403"], label).toBeDefined();
        }
        // every {param} in the path is declared
        const declared = (op.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name).sort();
        const inPath = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        expect(declared, label).toEqual(inPath);
      }
    }
  });

  it("has valid $refs, security schemes and the error schema", () => {
    const text = JSON.stringify(spec);
    for (const m of text.matchAll(/"#\/components\/(schemas|responses)\/(\w+)"/g)) {
      expect((spec.components as unknown as Record<string, Record<string, unknown>>)[m[1]][m[2]], m[0]).toBeDefined();
    }
    expect(spec.openapi).toMatch(/^3\.0\./);
    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    expect(spec.components.securitySchemes.cookieAuth).toMatchObject({ type: "apiKey", in: "cookie", name: "pss_token" });
    expect(spec.components.schemas.ErrorBody).toMatchObject({ required: ["error"] });
  });

  it("derives request schemas from the real zod schemas", () => {
    const body = spec.paths["/api/pnrs"].post!.requestBody!.content["application/json"].schema;
    expect(body).toEqual(fromZod(createPnrSchema));
    const props = (body as { properties: Record<string, unknown>; required: string[] }).properties;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(["passengers", "segments", "contact", "ownerUserId"]));
    expect((body as { required: string[] }).required).toEqual(expect.arrayContaining(["passengers", "segments", "contact"]));

    const search = spec.paths["/api/flights/search"].get!.parameters!;
    expect(search.map((p) => p.name).sort()).toEqual(Object.keys((fromZod(flightSearchQuery) as { properties: object }).properties).sort());
    expect(search.find((p) => p.name === "from")?.required).toBe(true);
    expect(search.find((p) => p.name === "passengers")?.required).toBe(false);

    // dates are rendered as date-time strings
    const flightBody = spec.paths["/api/flights"].post!.requestBody!.content["application/json"].schema as { properties: Record<string, { type?: string; format?: string }> };
    expect(flightBody.properties.departure).toMatchObject({ type: "string", format: "date-time" });
  });

  it("serves the spec publicly at GET /api/docs and the Swagger UI page at /api/docs/ui", async () => {
    const res = await docsRoute();
    expect(res.status).toBe(200);
    const served = (await res.json()) as OpenApiDocument;
    expect(served.info.title).toMatch(/Passenger Service System/);
    expect(Object.keys(served.paths).length).toBe(Object.keys(spec.paths).length);

    const ui = await uiRoute();
    expect(ui.headers.get("content-type")).toContain("text/html");
    const html = await ui.text();
    expect(html).toContain("SwaggerUIBundle");
    expect(html).toContain('url: "/api/docs"');
  });
});
