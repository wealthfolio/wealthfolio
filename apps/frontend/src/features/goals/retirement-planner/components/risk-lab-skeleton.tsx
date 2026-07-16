import { Card, CardContent, CardHeader, Skeleton } from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useTranslation } from "react-i18next";

export function RiskLabSkeleton() {
  return (
    <div className="space-y-12">
      <CalculatingBanner />

      {/* Base case hero */}
      <Card className="overflow-hidden shadow-sm">
        <CardContent className="space-y-4 p-5 md:p-6">
          <div className="flex gap-4">
            <div className="bg-muted/60 mt-2 h-14 w-1.5 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-3">
              <div className="space-y-3">
                <Skeleton className="h-2.5 w-24 rounded" />
                <Skeleton className="h-7 w-[70%] rounded" />
                <div className="space-y-2 pt-1">
                  <Skeleton className="h-3 w-full max-w-[580px] rounded" />
                  <Skeleton className="h-3 w-4/5 max-w-[480px] rounded" />
                </div>
              </div>
            </div>
          </div>

          <div className="bg-muted/25 grid overflow-hidden rounded-lg border md:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <HeroMetricSkeleton key={i} />
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Market paths (Monte Carlo) */}
      <Card className="overflow-hidden">
        <CardHeader className="border-b p-0">
          <div className="flex flex-col gap-5 p-5 md:p-6">
            <div className="min-w-0 flex-1 space-y-3">
              <Skeleton className="h-2.5 w-20 rounded" />
              <Skeleton className="h-7 w-[55%] rounded" />
              <div className="space-y-2 pt-1">
                <Skeleton className="h-3 w-full max-w-[820px] rounded" />
                <Skeleton className="h-3 w-3/4 max-w-[640px] rounded" />
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-0 p-0">
          <div className="bg-muted/10 grid border-b md:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <SimMetricSkeleton key={i} />
            ))}
          </div>
          <div className="p-5 md:p-6">
            <Skeleton className="h-64 w-full rounded-md" />
            <div className="mt-4 flex flex-wrap gap-5">
              <Skeleton className="h-3 w-24 rounded" />
              <Skeleton className="h-3 w-24 rounded" />
              <Skeleton className="h-3 w-32 rounded" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Stress tests */}
      <section className="space-y-4">
        <div className="space-y-2">
          <Skeleton className="h-2.5 w-48 rounded" />
          <Skeleton className="h-7 w-[45%] max-w-[360px] rounded" />
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <StressCardSkeleton key={i} />
          ))}
        </div>
      </section>

      {/* What moves the plan (heat maps) */}
      <section className="space-y-4">
        <div className="space-y-2">
          <Skeleton className="h-2.5 w-40 rounded" />
          <Skeleton className="h-7 w-[40%] max-w-[320px] rounded" />
          <div className="space-y-2 pt-1">
            <Skeleton className="h-3 w-full max-w-[680px] rounded" />
          </div>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <HeatmapCardSkeleton key={i} />
          ))}
        </div>
      </section>
    </div>
  );
}

function CalculatingBanner() {
  const { t } = useTranslation();
  return (
    <div className="bg-muted/20 flex items-start gap-4 rounded-xl border px-5 py-4 md:px-6">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[hsl(91,34%,29%)]/10 text-[hsl(91,34%,29%)]">
        <Icons.Spinner className="size-5 animate-spin" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{t("goals:skeleton.calculating_title")}</p>
        <p className="text-muted-foreground mt-1 max-w-[720px] text-sm leading-relaxed">
          {t("goals:skeleton.calculating_desc")}
        </p>
      </div>
    </div>
  );
}

function HeroMetricSkeleton() {
  return (
    <div className="space-y-2 border-t p-4 first:border-t-0 md:border-l md:border-t-0 md:first:border-l-0">
      <Skeleton className="h-2.5 w-20 rounded" />
      <Skeleton className="h-6 w-24 rounded" />
      <Skeleton className="h-2.5 w-16 rounded" />
    </div>
  );
}

function SimMetricSkeleton() {
  return (
    <div className="space-y-2 border-t p-4 first:border-t-0 md:border-l md:border-t-0 md:first:border-l-0">
      <Skeleton className="h-2.5 w-20 rounded" />
      <Skeleton className="h-6 w-20 rounded" />
      <Skeleton className="h-2.5 w-24 rounded" />
    </div>
  );
}

export function StressCardSkeleton() {
  return (
    <div className="bg-card relative overflow-hidden rounded-xl border shadow-sm">
      <div className="bg-muted/60 absolute inset-y-5 left-0 w-0.5 rounded-r-full" />
      <div className="space-y-5 p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 space-y-3">
            <div className="flex items-center gap-2">
              <Skeleton className="size-4 rounded" />
              <Skeleton className="h-4 w-40 rounded" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-3 w-full rounded" />
              <Skeleton className="h-3 w-4/5 rounded" />
            </div>
          </div>
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
        <div className="grid grid-cols-3 gap-4 border-t pt-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-2.5 w-16 rounded" />
              <Skeleton className="h-5 w-14 rounded" />
              <Skeleton className="h-2.5 w-12 rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function HeatmapCardSkeleton() {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <Skeleton className="h-4 w-40 rounded" />
            <Skeleton className="h-3 w-56 rounded" />
          </div>
          <Icons.Spinner className="text-muted-foreground mt-1 size-4 animate-spin" />
        </div>
      </CardHeader>
      <CardContent className="p-5">
        <div className="grid grid-cols-5 gap-1.5">
          {Array.from({ length: 25 }).map((_, i) => (
            <div
              key={i}
              className="bg-muted/50 h-10 animate-pulse rounded-md"
              style={{ animationDelay: `${(i % 5) * 45}ms` }}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
