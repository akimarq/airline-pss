import type { ReactNode } from "react";
import { ApiError } from "@/lib/client/api";

type AlertTone = "error" | "success" | "warning" | "info";

const tones: Record<AlertTone, string> = {
  error: "border-red-200 bg-red-50 text-red-800",
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  info: "border-sky-200 bg-sky-50 text-sky-900",
};

export function Alert({ tone = "info", title, children, className = "" }: { tone?: AlertTone; title?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`rounded-lg border px-4 py-3 text-sm ${tones[tone]} ${className}`}>
      {title && <div className="font-semibold">{title}</div>}
      {children && <div className={title ? "mt-1" : ""}>{children}</div>}
    </div>
  );
}

/** Renders an `ApiError` (or plain message) including validation / warning detail lines. */
export function ErrorAlert({ error, className = "" }: { error: ApiError | string | null | undefined; className?: string }) {
  if (!error) return null;
  if (typeof error === "string") return <Alert tone="error" className={className}>{error}</Alert>;
  const lines = error.detailLines;
  return (
    <Alert tone="error" className={className} title={error.message}>
      {lines.length > 0 && (
        <ul className="list-inside list-disc space-y-0.5">
          {lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
    </Alert>
  );
}
