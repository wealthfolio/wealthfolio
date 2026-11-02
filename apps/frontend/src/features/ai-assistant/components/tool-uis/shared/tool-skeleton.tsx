import { Skeleton } from "@wealthfolio/ui";

interface TableSkeletonProps {
  rows?: number;
}

export function TableSkeleton({ rows = 5 }: TableSkeletonProps) {
  return (
    <div className="flex flex-col gap-2">
      {/* Header row */}
      <div className="flex gap-4 border-b pb-2">
        <Skeleton className="h-4 w-1/4" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-1/5" />
        <Skeleton className="h-4 w-1/6" />
      </div>
      {/* Data rows */}
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex gap-4 py-1.5">
          <Skeleton className="h-4" style={{ width: `${20 + (i % 3) * 5}%` }} />
          <Skeleton className="h-4" style={{ width: `${25 + (i % 2) * 10}%` }} />
          <Skeleton className="h-4" style={{ width: `${15 + (i % 4) * 3}%` }} />
          <Skeleton className="h-4" style={{ width: `${12 + (i % 3) * 4}%` }} />
        </div>
      ))}
    </div>
  );
}

export function ChartSkeleton() {
  return (
    <div className="flex h-50 w-full flex-col justify-end gap-1">
      {/* Chart area shape */}
      <div className="relative flex h-full items-end gap-0.5">
        {/* Simulate area chart with varying heights */}
        <Skeleton className="h-[30%] flex-1 rounded-t-sm" />
        <Skeleton className="h-[45%] flex-1 rounded-t-sm" />
        <Skeleton className="h-[40%] flex-1 rounded-t-sm" />
        <Skeleton className="h-[60%] flex-1 rounded-t-sm" />
        <Skeleton className="h-[55%] flex-1 rounded-t-sm" />
        <Skeleton className="h-[70%] flex-1 rounded-t-sm" />
        <Skeleton className="h-[65%] flex-1 rounded-t-sm" />
        <Skeleton className="h-[80%] flex-1 rounded-t-sm" />
        <Skeleton className="h-[75%] flex-1 rounded-t-sm" />
        <Skeleton className="h-[85%] flex-1 rounded-t-sm" />
        <Skeleton className="h-[90%] flex-1 rounded-t-sm" />
        <Skeleton className="h-[88%] flex-1 rounded-t-sm" />
      </div>
      {/* X-axis labels */}
      <div className="flex justify-between pt-2">
        <Skeleton className="h-3 w-12" />
        <Skeleton className="h-3 w-12" />
        <Skeleton className="h-3 w-12" />
        <Skeleton className="h-3 w-12" />
      </div>
    </div>
  );
}

interface CardListSkeletonProps {
  count?: number;
}

export function CardListSkeleton({ count = 3 }: CardListSkeletonProps) {
  return (
    <div className="flex gap-3 overflow-x-auto">
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="bg-background/60 flex min-w-45 flex-col gap-2 rounded-lg border p-4"
        >
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}
