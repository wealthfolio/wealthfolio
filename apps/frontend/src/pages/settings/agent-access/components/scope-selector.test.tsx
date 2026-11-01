import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ScopeKey } from "../scopes";
import { ScopeSelector } from "./scope-selector";

function renderSelector(selectedScopes: ScopeKey[]) {
  render(
    <ScopeSelector selectedScopes={selectedScopes} onToggle={vi.fn()} onSelectPreset={vi.fn()} />,
  );
}

function scopeButton(label: string) {
  return screen.getByRole("checkbox", { name: new RegExp(`^${label}:`) });
}

it("names the scope that locks each prerequisite", () => {
  renderSelector([
    "activities:draft",
    "activities:write",
    "classification:suggest",
    "classification:write",
    "holdings:read",
    "market-data:write",
    "spending:read",
    "spending:write",
  ]);

  const locks: [string, string][] = [
    ["Activities — draft", "Required by Activities — commit/write"],
    ["Asset classification — suggest", "Required by Asset classification — apply/write"],
    ["Holdings & value \\(read\\)", "Required by Market data — write"],
    ["View spending", "Required by Organize spending or Manage budgets"],
  ];
  for (const [label, title] of locks) {
    const button = scopeButton(label);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", title);
  }
});
