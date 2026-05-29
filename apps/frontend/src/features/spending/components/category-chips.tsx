import { cn } from "@/lib/utils";
import { Icons } from "@wealthfolio/ui";

import { resolveCategoryIcon } from "../lib/category-icons";

export type CategoryMeta = {
  name: string;
  color: string | null;
  icon: string | null;
  parentId: string | null;
};

export type CategoryMetaMap = Map<string, CategoryMeta>;

export function CategoryIcon({
  icon,
  fallback: _fallback,
  className,
}: {
  icon: string | null;
  /** Reserved for future title/aria — currently unused. */
  fallback?: string;
  className?: string;
}) {
  const IconCmp = resolveCategoryIcon(icon);
  return <IconCmp weight="duotone" className={cn("h-4 w-4", className)} />;
}

export function CategoryBadge({
  name,
  color,
  icon,
}: {
  name: string;
  color: string | null;
  icon: string | null;
}) {
  const accent = color ?? "var(--muted-foreground)";
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
      style={{
        backgroundColor: color ? `${color}1F` : "var(--muted)",
        color: accent,
      }}
      title={name}
    >
      <CategoryIcon icon={icon} fallback={name} className="h-3 w-3" />
      <span className="max-w-[110px] truncate">{name}</span>
    </span>
  );
}

export function ReviewPill({ label }: { label: string }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
      style={{
        backgroundColor: "hsl(28 65% 55% / 0.10)",
        borderColor: "hsl(28 65% 55% / 0.35)",
        color: "#C28B47",
      }}
    >
      <Icons.AlertCircle className="h-2.5 w-2.5" />
      {label}
    </span>
  );
}
