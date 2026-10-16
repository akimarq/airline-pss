"use client";

import { QRCodeSVG } from "qrcode.react";
import { CABIN_NAMES, fmtDate, fmtTime } from "@/lib/client/format";
import type { BoardingPass } from "@/lib/client/types";

function Field({ label, value, big = false }: { label: string; value: string | number; big?: boolean }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</div>
      <div className={`font-semibold text-slate-900 ${big ? "text-2xl" : "text-base"}`}>{value}</div>
    </div>
  );
}

/** Printable boarding pass; the QR code encodes the BCBP barcode payload. */
export function BoardingPassCard({ pass }: { pass: BoardingPass }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-md">
      <div className="flex items-center justify-between bg-sky-800 px-5 py-3 text-white">
        <span className="text-sm font-bold tracking-wide">✈ SkyPSS · BOARDING PASS</span>
        <span className="text-sm">{CABIN_NAMES[pass.cabin]}</span>
      </div>
      <div className="flex flex-col gap-6 p-5 sm:flex-row">
        <div className="flex-1 space-y-4">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Passenger</div>
            <div className="text-xl font-bold text-slate-900">{pass.passengerName}</div>
          </div>
          <div className="flex items-center gap-4">
            <Field label="From" value={pass.origin} big />
            <span className="text-slate-300">→</span>
            <Field label="To" value={pass.destination} big />
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Field label="Flight" value={pass.flightNumber} />
            <Field label="Date" value={fmtDate(pass.departure)} />
            <Field label="Departs" value={fmtTime(pass.departure)} />
            <Field label="Boarding" value={fmtTime(pass.boardingTime)} />
            <Field label="Seat" value={pass.seat} big />
            <Field label="Gate" value={pass.gate ?? "TBA"} />
            <Field label="Seq." value={pass.boardingSequence} />
            <Field label="PNR" value={pass.pnrLocator} />
          </div>
        </div>
        <div className="flex flex-col items-center justify-center gap-2 border-t border-dashed border-slate-300 pt-4 sm:border-l sm:border-t-0 sm:pl-6 sm:pt-0">
          <QRCodeSVG value={pass.barcode} size={168} level="M" marginSize={1} />
          <code className="max-w-[11rem] break-all text-center text-[9px] text-slate-400">{pass.barcode}</code>
        </div>
      </div>
    </div>
  );
}
