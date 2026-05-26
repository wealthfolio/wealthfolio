/**
 * Focus-aware decimal-amount input used across the budget editor. Defers commit
 * until blur (or Enter) and reconciles with externally-changed `value` only
 * while not focused, so a parent refetch doesn't clobber in-progress typing.
 */
import { useState } from "react";

import { cn } from "@/lib/utils";

export interface AmountInputProps {
  value: number;
  onCommit: (value: string) => void;
  variant?: "default" | "dashed";
}

export function AmountInput({ value, onCommit, variant = "default" }: AmountInputProps) {
  const [draft, setDraft] = useState(String(value || ""));
  const [focused, setFocused] = useState(false);
  const [lastValue, setLastValue] = useState(value);
  const isEmpty = !focused && (!draft || Number.parseFloat(draft) === 0);

  // Adjust draft when the parent commits a new value externally — but only while
  // the user isn't actively editing. Done during render per React docs guidance
  // (avoids the extra mount-time render of an Effect).
  if (!focused && value !== lastValue) {
    setLastValue(value);
    setDraft(String(value || ""));
  }

  return (
    <div
      className={cn(
        "bg-background focus-within:ring-ring/40 focus-within:border-ring hover:border-foreground/30 flex h-7 w-full items-center rounded-md border px-2 transition-shadow focus-within:ring-2",
        variant === "dashed"
          ? "border-muted-foreground/30 border-dashed"
          : isEmpty
            ? "border-border/70 border-dashed"
            : "border-input",
      )}
    >
      <input
        type="text"
        inputMode="decimal"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => {
          setFocused(true);
          event.currentTarget.select();
        }}
        onBlur={() => {
          setFocused(false);
          const next = Number.parseFloat(draft || "0");
          if (Number.isFinite(next) && Math.abs(next - value) > 0.000001) {
            onCommit(String(next));
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        placeholder="0"
        className="text-foreground placeholder:text-muted-foreground/70 min-w-0 flex-1 bg-transparent text-right text-xs tabular-nums outline-none"
      />
    </div>
  );
}
