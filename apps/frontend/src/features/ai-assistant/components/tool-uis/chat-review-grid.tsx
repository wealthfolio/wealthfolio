import { memo, useCallback, useState } from "react";

import { Button } from "@wealthfolio/ui";

import type { DraftActivity } from "@/pages/activity/import/context";
import { ImportReviewGrid } from "@/pages/activity/import/components/import-review-grid";
import type { ActivityImportProfile } from "@/pages/activity/import/utils/activity-import-profile";

import type { ChatImportFilter, ChatImportStats } from "../../hooks/use-chat-import-session";

// ─────────────────────────────────────────────────────────────────────────────
// Filter Pills
// ─────────────────────────────────────────────────────────────────────────────

const FILTER_CONFIG: {
  key: ChatImportFilter;
  label: string;
  accentClass: string;
  countKey: keyof ChatImportStats;
}[] = [
  { key: "all", label: "All", accentClass: "", countKey: "total" },
  { key: "valid", label: "Valid", accentClass: "text-success", countKey: "valid" },
  { key: "warning", label: "Warnings", accentClass: "text-warning", countKey: "warning" },
  { key: "error", label: "Errors", accentClass: "text-destructive", countKey: "errors" },
  { key: "duplicate", label: "Duplicates", accentClass: "text-blue-500", countKey: "duplicates" },
  { key: "skipped", label: "Skipped", accentClass: "text-muted-foreground", countKey: "skipped" },
];

function FilterPills({
  filter,
  onFilterChange,
  stats,
}: {
  filter: ChatImportFilter;
  onFilterChange: (f: ChatImportFilter) => void;
  stats: ChatImportStats;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {FILTER_CONFIG.map((f) => {
        const count = stats[f.countKey] as number;
        if (count === 0 && f.key !== "all") return null;
        const active = filter === f.key;
        return (
          <Button
            key={f.key}
            type="button"
            variant={active ? "secondary" : "ghost"}
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={() => onFilterChange(f.key)}
          >
            <span className={active ? undefined : f.accentClass}>{f.label}</span>
            <span className="text-muted-foreground tabular-nums">{count}</span>
          </Button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Wrapper
// ─────────────────────────────────────────────────────────────────────────────

export interface ChatReviewGridProps {
  filteredDrafts: DraftActivity[];
  stats: ChatImportStats;
  filter: ChatImportFilter;
  onFilterChange: (filter: ChatImportFilter) => void;
  onDraftUpdate: (rowIndex: number, updates: Partial<DraftActivity>) => void;
  onBulkSkip: (rowIndexes: number[]) => void;
  onBulkUnskip: (rowIndexes: number[]) => void;
  onBulkForceImport: (rowIndexes: number[]) => void;
  importProfile?: ActivityImportProfile;
}

export const ChatReviewGrid = memo(function ChatReviewGrid({
  filteredDrafts,
  stats,
  filter,
  onFilterChange,
  onDraftUpdate,
  onBulkSkip,
  onBulkUnskip,
  onBulkForceImport,
  importProfile,
}: ChatReviewGridProps) {
  const [selectedRows, setSelectedRows] = useState<number[]>([]);

  const handleSelectionChange = useCallback((rows: number[]) => {
    setSelectedRows(rows);
  }, []);

  const handleBulkSkip = useCallback(
    (rowIndexes: number[]) => {
      onBulkSkip(rowIndexes);
      setSelectedRows([]);
    },
    [onBulkSkip],
  );

  const handleBulkUnskip = useCallback(
    (rowIndexes: number[]) => {
      onBulkUnskip(rowIndexes);
      setSelectedRows([]);
    },
    [onBulkUnskip],
  );

  const handleBulkForceImport = useCallback(
    (rowIndexes: number[]) => {
      onBulkForceImport(rowIndexes);
      setSelectedRows([]);
    },
    [onBulkForceImport],
  );

  return (
    <div className="space-y-2">
      <FilterPills filter={filter} onFilterChange={onFilterChange} stats={stats} />
      <div className="[&_*]:scrollbar-thin flex min-w-0 flex-col overflow-hidden">
        <ImportReviewGrid
          drafts={filteredDrafts}
          selectedRows={selectedRows}
          onSelectionChange={handleSelectionChange}
          onDraftUpdate={onDraftUpdate}
          onBulkSkip={handleBulkSkip}
          onBulkUnskip={handleBulkUnskip}
          onBulkForceImport={handleBulkForceImport}
          importProfile={importProfile}
          gridHeight={400}
        />
      </div>
    </div>
  );
});
