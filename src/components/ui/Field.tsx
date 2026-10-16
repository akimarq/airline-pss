"use client";

import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

const control =
  "block w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-200 disabled:bg-slate-100 disabled:text-slate-500";

interface FieldShellProps {
  label?: string;
  hint?: string;
  error?: string;
  htmlFor: string;
  children: ReactNode;
  className?: string;
}

function FieldShell({ label, hint, error, htmlFor, children, className = "" }: FieldShellProps) {
  return (
    <div className={className}>
      {label && (
        <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium text-slate-700">
          {label}
        </label>
      )}
      {children}
      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

interface CommonProps {
  label?: string;
  hint?: string;
  error?: string;
  /** Applied to the wrapper (use for grid spans / widths). */
  wrapperClassName?: string;
}

export function Input({ label, hint, error, wrapperClassName, className = "", id, ...rest }: CommonProps & InputHTMLAttributes<HTMLInputElement>) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <FieldShell label={label} hint={hint} error={error} htmlFor={inputId} className={wrapperClassName}>
      <input id={inputId} className={`${control} ${error ? "border-red-400" : "border-slate-300"} ${className}`} {...rest} />
    </FieldShell>
  );
}

export function Select({ label, hint, error, wrapperClassName, className = "", id, children, ...rest }: CommonProps & SelectHTMLAttributes<HTMLSelectElement>) {
  const auto = useId();
  const selectId = id ?? auto;
  return (
    <FieldShell label={label} hint={hint} error={error} htmlFor={selectId} className={wrapperClassName}>
      <select id={selectId} className={`${control} ${error ? "border-red-400" : "border-slate-300"} ${className}`} {...rest}>
        {children}
      </select>
    </FieldShell>
  );
}

export function Textarea({ label, hint, error, wrapperClassName, className = "", id, ...rest }: CommonProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const auto = useId();
  const areaId = id ?? auto;
  return (
    <FieldShell label={label} hint={hint} error={error} htmlFor={areaId} className={wrapperClassName}>
      <textarea id={areaId} className={`${control} ${error ? "border-red-400" : "border-slate-300"} ${className}`} {...rest} />
    </FieldShell>
  );
}

export function Checkbox({ label, className = "", ...rest }: { label: ReactNode } & Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return (
    <label className={`inline-flex items-center gap-2 text-sm text-slate-700 ${className}`}>
      <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-sky-700 focus:ring-sky-500" {...rest} />
      {label}
    </label>
  );
}
