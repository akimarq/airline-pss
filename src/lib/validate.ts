import type { z } from "zod";

/** Parse a JSON request body with a zod schema. Throws ZodError / SyntaxError, which `handleError` maps to 400. */
export async function parseBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.output<S>> {
  const json: unknown = await req.json();
  return schema.parse(json);
}

/** Parse URL query params (first value of each key) with a zod schema. */
export function parseQuery<S extends z.ZodType>(req: Request, schema: S): z.output<S> {
  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  return schema.parse(params);
}
