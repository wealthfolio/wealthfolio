import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TickerAvatar } from "./ticker-avatar";

vi.mock("@/hooks/use-ticker-logo-suffix", () => ({
  useTickerLogoSuffix: vi.fn((mic?: string | null) => {
    if (mic?.toUpperCase() === "XPAR") return "PA";
    if (mic?.toUpperCase() === "XTSE") return "TO";
    return undefined;
  }),
}));

describe("TickerAvatar", () => {
  it("renders cash symbols with a painted avatar background", () => {
    render(<TickerAvatar symbol="CASH:USD" />);

    const label = screen.getByTitle("CASH:USD");
    const avatarFallback = label.parentElement;

    expect(label).toHaveTextContent("$");
    expect(avatarFallback).toHaveClass("bg-primary/80", "dark:bg-primary/20", "text-white");
  });

  it("uses currency-specific cash labels", () => {
    render(<TickerAvatar symbol="CASH:CAD" />);

    expect(screen.getByTitle("CASH:CAD")).toHaveTextContent("C$");
  });

  it("preserves four-character non-cash fallback labels", () => {
    render(<TickerAvatar symbol="TEST" />);

    expect(screen.getByTitle("TEST")).toHaveTextContent("TEST");
  });

  it("limits longer non-cash fallback labels to four characters", () => {
    render(<TickerAvatar symbol="ABCDE" />);

    expect(screen.getByTitle("ABCDE")).toHaveTextContent("ABCD");
  });

  it("handles exchangeMic suffix resolution for symbols without existing suffix", () => {
    const { container } = render(<TickerAvatar symbol="DG" exchangeMic="XPAR" />);
    // Avatar rendered with fallback title DG
    expect(screen.getByTitle("DG")).toBeInTheDocument();
    expect(container.querySelector("span[title='DG']")).toHaveTextContent("DG");
  });

  it("does not duplicate suffix when symbol already has a delimiter", () => {
    const { container } = render(<TickerAvatar symbol="DG.PA" exchangeMic="XPAR" />);
    expect(screen.getByTitle("DG.PA")).toBeInTheDocument();
    expect(container.querySelector("span[title='DG.PA']")).toHaveTextContent("DG");
  });
});
