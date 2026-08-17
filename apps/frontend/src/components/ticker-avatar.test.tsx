import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { getTickerLogoImageClassName, TickerAvatar } from "./ticker-avatar";

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
});

describe("getTickerLogoImageClassName", () => {
  it("renders a custom logo edge-to-edge, with no padding", () => {
    expect(getTickerLogoImageClassName(true, "p-1")).toBe("object-contain");
    expect(getTickerLogoImageClassName(true, "p-2")).toBe("object-contain");
  });

  it("keeps the caller-specific padding for the bundled ticker-logo fallback", () => {
    expect(getTickerLogoImageClassName(false, "p-1")).toBe("object-contain p-1");
    expect(getTickerLogoImageClassName(false, "p-2")).toBe("object-contain p-2");
  });
});
