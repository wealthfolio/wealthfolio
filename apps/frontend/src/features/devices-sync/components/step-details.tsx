// StepDetails
// A short list of what a working step does. Rows with a state follow real
// progress; rows without one only explain, and never pretend to progress.
// =========================================================================

import { cn } from "@/lib/utils";
import { Icons } from "@wealthfolio/ui";
import type { ReactNode } from "react";

export type StepDetailState = "done" | "active" | "pending";

export interface StepDetail {
  label: string;
  /** Real progress, when the app knows it. */
  state?: StepDetailState;
  /** Shown when the row has no state. */
  icon?: ReactNode;
}

function RowMarker({ detail }: { detail: StepDetail }) {
  switch (detail.state) {
    case "done":
      return <Icons.Check className="text-success size-4" aria-hidden />;
    case "active":
      return <span className="bg-primary size-2 rounded-full" aria-hidden />;
    case "pending":
      return <span className="border-muted-foreground/40 size-2 rounded-full border" aria-hidden />;
    default:
      return <span className="text-muted-foreground [&_svg]:size-4">{detail.icon}</span>;
  }
}

export function StepDetails({ details }: { details: StepDetail[] }) {
  return (
    <ul className="bg-muted/40 flex flex-col gap-3 rounded-xl p-4 text-left text-sm">
      {details.map((detail) => (
        <li
          key={detail.label}
          className="flex items-center gap-3"
          data-state={detail.state}
          aria-current={detail.state === "active" ? "step" : undefined}
        >
          <span className="flex size-4 shrink-0 items-center justify-center">
            <RowMarker detail={detail} />
          </span>
          <span
            className={cn(
              detail.state === "active" && "text-foreground font-medium",
              detail.state === "pending" && "text-muted-foreground",
              detail.state === "done" && "text-muted-foreground",
            )}
          >
            {detail.label}
          </span>
        </li>
      ))}
    </ul>
  );
}
