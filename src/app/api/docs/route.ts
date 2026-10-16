import { NextResponse } from "next/server";
import { buildOpenApiSpec } from "@/lib/openapi";

// Public: the OpenAPI 3.0 document (see src/lib/openapi.ts). Swagger UI lives at /api/docs/ui.
export async function GET() {
  return NextResponse.json(buildOpenApiSpec(), { headers: { "Cache-Control": "public, max-age=300" } });
}
