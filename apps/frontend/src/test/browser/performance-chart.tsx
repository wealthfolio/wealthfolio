import { PerformanceChart } from "@/components/performance-chart";

// Two years of synthetic daily returns: an account and a dashed benchmark, wavy
// enough that the benchmark is a long path with thousands of dashes, as in #2436.
function returns(seed: number) {
  const start = Date.UTC(2024, 0, 1);
  return Array.from({ length: 730 }, (_, day) => ({
    date: new Date(start + day * 86_400_000).toISOString().slice(0, 10),
    value: 0.0002 * day + 0.04 * Math.sin(day / (9 + seed)) + 0.01 * Math.sin(day * seed),
  }));
}

const series = [
  { id: "account", name: "Synthetic account", returns: returns(1) },
  { id: "benchmark", name: "Synthetic benchmark", returns: returns(2), isReference: true },
];

export function PerformanceChartFixture() {
  return (
    <main className="h-screen p-6">
      <PerformanceChart data={series} />
    </main>
  );
}
