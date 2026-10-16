import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { Error as MongooseError } from "mongoose";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }

  static badRequest(message: string, details?: unknown) {
    return new AppError(400, "BAD_REQUEST", message, details);
  }
  static unauthorized(message = "Authentication required") {
    return new AppError(401, "UNAUTHORIZED", message);
  }
  static forbidden(message = "You do not have access to this resource") {
    return new AppError(403, "FORBIDDEN", message);
  }
  static notFound(message = "Resource not found") {
    return new AppError(404, "NOT_FOUND", message);
  }
  static conflict(message: string, details?: unknown) {
    return new AppError(409, "CONFLICT", message, details);
  }
}

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

function respond(status: number, code: string, message: string, details?: unknown) {
  const body: ErrorBody = { error: { code, message, details } };
  return NextResponse.json(body, { status });
}

interface DuplicateKeyError {
  code: number;
  keyValue?: Record<string, unknown>;
}

function isDuplicateKeyError(err: unknown): err is DuplicateKeyError {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === 11000;
}

/** Convert any thrown value into the standard `{ error: { code, message, details } }` response. */
export function handleError(err: unknown): NextResponse<ErrorBody> {
  if (err instanceof AppError) {
    return respond(err.status, err.code, err.message, err.details);
  }
  if (err instanceof ZodError) {
    return respond(400, "VALIDATION_ERROR", "Request validation failed", err.issues);
  }
  if (err instanceof MongooseError.ValidationError) {
    const details = Object.values(err.errors).map((e) => ({ path: e.path, message: e.message }));
    return respond(400, "VALIDATION_ERROR", "Validation failed", details);
  }
  if (err instanceof MongooseError.CastError) {
    return respond(400, "BAD_REQUEST", `Invalid value for '${err.path}'`);
  }
  if (isDuplicateKeyError(err)) {
    return respond(409, "DUPLICATE_KEY", "A record with the same unique value already exists", err.keyValue);
  }
  if (err instanceof SyntaxError) {
    return respond(400, "BAD_REQUEST", "Malformed JSON body");
  }

  console.error("Unhandled error:", err);
  return respond(500, "INTERNAL_ERROR", "Internal server error");
}
