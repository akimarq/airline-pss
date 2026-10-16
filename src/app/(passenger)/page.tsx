import { FlightSearchForm } from "@/components/flights/FlightSearchForm";
import { Card } from "@/components/ui";

const FEATURES = [
  { title: "Live availability", text: "Fares come straight from open inventory buckets, so what you see can be booked." },
  { title: "Hold, then pay", text: "Seats are held for 15 minutes while you complete a (simulated) payment." },
  { title: "Check in online", text: "Pick your seat, get a QR boarding pass and track your bags." },
];

export default function HomePage() {
  return (
    <div className="space-y-10">
      <section className="rounded-2xl bg-gradient-to-br from-sky-800 to-sky-600 px-6 py-10 text-white shadow-lg sm:px-10 sm:py-14">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Where to next?</h1>
        <p className="mt-2 max-w-xl text-sky-100">Search flights, book in minutes and check in online with SkyPSS.</p>
        <div className="mt-8 rounded-xl bg-white p-4 text-slate-900 shadow-md sm:p-5">
          <FlightSearchForm />
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {FEATURES.map((f) => (
          <Card key={f.title}>
            <h3 className="font-semibold text-slate-900">{f.title}</h3>
            <p className="mt-1 text-sm text-slate-600">{f.text}</p>
          </Card>
        ))}
      </section>
    </div>
  );
}
