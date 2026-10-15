import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TickerAvatar as SharedTickerAvatar } from "@wealthfolio/ui";
import { getAssetLogo } from "@/adapters";
import { assetLogoRegistry } from "@/lib/asset-logo-registry";
import type { AssetLogoSummary } from "@/lib/types";
import { TickerAvatar } from "./ticker-avatar";

vi.mock("@/adapters", () => ({ getAssetLogo: vi.fn().mockResolvedValue(null) }));

/**
 * The avatar primitive probes `src` with `new Image()` and waits for load or
 * error, through `onload`/`onerror` or listeners; jsdom never fires either, so
 * drive both from the URL here.
 */
const failingSources = new Set<string>();

class FakeImage {
  private listeners = new Map<string, Set<() => void>>();
  private currentSrc = "";
  complete = false;
  naturalWidth = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  get src() {
    return this.currentSrc;
  }

  set src(value: string) {
    this.currentSrc = value;
    queueMicrotask(() => {
      if (this.currentSrc !== value) return;
      this.emit(failingSources.has(value) ? "error" : "load");
    });
  }

  addEventListener(type: string, listener: () => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }

  private emit(type: "load" | "error") {
    (type === "load" ? this.onload : this.onerror)?.();
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

function summary(assetId: string, displayCode: string): AssetLogoSummary {
  return {
    assetId,
    displayCode,
    sha256: `sha-${assetId}`,
    updatedAt: "2026-09-02T00:00:00Z",
  };
}

const dataUriFor = (assetId: string) => `data:image/png;base64,${assetId}`;

function primeOverride(assetId: string, displayCode: string) {
  assetLogoRegistry.prime(`sha-${assetId}`, dataUriFor(assetId));
  return summary(assetId, displayCode);
}

describe("TickerAvatar", () => {
  beforeEach(() => {
    vi.stubGlobal("Image", FakeImage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    failingSources.clear();
    assetLogoRegistry.reset();
  });

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

  it("shows the bundled logo when no override exists", async () => {
    const view = render(<TickerAvatar symbol="AAPL" />);

    await waitFor(() =>
      expect(view.container.querySelector("img")).toHaveAttribute("src", "/ticker-logos/AAPL.png"),
    );
    expect(view.container.querySelector("img")).toHaveClass("object-cover", "p-0");
    expect(view.container.querySelector("[data-logo-source]")).toHaveAttribute(
      "data-logo-source",
      "bundled",
    );
  });

  it("prefers the custom override and reports it as the visible source", async () => {
    assetLogoRegistry.setIndex([primeOverride("a1", "AAPL")]);

    const view = render(<TickerAvatar symbol="AAPL" assetId="a1" />);

    await waitFor(() =>
      expect(view.container.querySelector('img[src^="data:"]')).toHaveAttribute(
        "src",
        dataUriFor("a1"),
      ),
    );
    expect(view.container.querySelector("[data-logo-source]")).toHaveAttribute(
      "data-logo-source",
      "custom",
    );
  });

  it("falls back to the bundled logo when the custom image fails to load", async () => {
    assetLogoRegistry.setIndex([primeOverride("a1", "AAPL")]);
    failingSources.add(dataUriFor("a1"));

    const view = render(<TickerAvatar symbol="AAPL" assetId="a1" />);

    await waitFor(() =>
      expect(view.container.querySelector("img")).toHaveAttribute("src", "/ticker-logos/AAPL.png"),
    );
    expect(view.container.querySelector("[data-logo-source]")).toHaveAttribute(
      "data-logo-source",
      "bundled",
    );
  });

  it("falls back to initials when every candidate fails", async () => {
    failingSources.add("/ticker-logos/SHOP-XTSE.png");
    failingSources.add("/ticker-logos/SHOP.png");

    const view = render(<TickerAvatar symbol="SHOP" exchangeMic="XTSE" />);

    await waitFor(() =>
      expect(view.container.querySelector("[data-logo-source]")).toHaveAttribute(
        "data-logo-source",
        "initials",
      ),
    );
    expect(view.container.querySelector("img")).toBeNull();
    expect(screen.getByTitle("SHOP")).toHaveTextContent("SHOP");
  });

  it("uses the exchange MIC with a canonical base symbol", async () => {
    const view = render(<TickerAvatar symbol="SHOP" exchangeMic="XTSE" />);

    await waitFor(() =>
      expect(view.container.querySelector("img")).toHaveAttribute(
        "src",
        "/ticker-logos/SHOP-XTSE.png",
      ),
    );
  });

  it("falls back from the exact market logo to the unsuffixed logo", async () => {
    failingSources.add("/ticker-logos/SHOP-XTSE.png");

    const view = render(<TickerAvatar symbol="SHOP" exchangeMic="XTSE" />);

    await waitFor(() =>
      expect(view.container.querySelector("img")).toHaveAttribute("src", "/ticker-logos/SHOP.png"),
    );
  });

  it("uses the crypto namespace without falling back to an equity logo", async () => {
    failingSources.add("/ticker-logos/crypto/ACT.png");

    const view = render(<TickerAvatar symbol="ACT" instrumentType="CRYPTO" />);

    await waitFor(() =>
      expect(view.container.querySelector("[data-logo-source]")).toHaveAttribute(
        "data-logo-source",
        "initials",
      ),
    );
    expect(view.container.querySelector("img")).toBeNull();
    expect(screen.getByTitle("ACT")).toHaveTextContent("ACT");
  });

  it("lets the asset id win over a symbol-only match", async () => {
    assetLogoRegistry.setIndex([primeOverride("a1", "AAPL"), primeOverride("a2", "MSFT")]);

    const view = render(<TickerAvatar symbol="AAPL" assetId="a2" />);

    await waitFor(() =>
      expect(view.container.querySelector("img")).toHaveAttribute("src", dataUriFor("a2")),
    );
  });

  it("does not use another asset's custom logo when the asset id has no override", async () => {
    assetLogoRegistry.setIndex([primeOverride("a1", "AAPL")]);

    const view = render(<TickerAvatar symbol="AAPL" assetId="a2" />);

    await waitFor(() =>
      expect(view.container.querySelector("img")).toHaveAttribute("src", "/ticker-logos/AAPL.png"),
    );
  });

  it("uses an explicit src before any override", async () => {
    assetLogoRegistry.setIndex([primeOverride("a1", "AAPL")]);

    const view = render(
      <TickerAvatar symbol="AAPL" assetId="a1" src="data:image/png;base64,preview" />,
    );

    await waitFor(() =>
      expect(view.container.querySelector("img")).toHaveAttribute(
        "src",
        "data:image/png;base64,preview",
      ),
    );
    expect(view.container.querySelector("[data-logo-source]")).toHaveAttribute(
      "data-logo-source",
      "custom",
    );
  });
});

describe.each([
  ["app", TickerAvatar],
  ["shared", SharedTickerAvatar],
] as const)("%s cash avatar", (_name, AvatarComponent) => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["$CASH", "$"],
    ["CASH:CAD", "C$"],
    ["$cash-eur", "EUR"],
  ])("renders %s without probing an image", (symbol, label) => {
    const image = vi.fn();
    vi.stubGlobal("Image", image);
    const view = render(<AvatarComponent symbol={symbol} />);

    expect(view.getByTitle(symbol.toUpperCase())).toHaveTextContent(label);
    expect(view.container.querySelector("img")).toBeNull();
    expect(image).not.toHaveBeenCalled();
  });

  it("keeps ordinary cash-named securities on the image path across cash transitions", async () => {
    vi.stubGlobal("Image", FakeImage);
    const view = render(<AvatarComponent symbol="CASH.TO" />);
    await waitFor(() =>
      expect(view.container.querySelector("img")).toHaveAttribute(
        "src",
        "/ticker-logos/CASH-TO.png",
      ),
    );

    view.rerender(<AvatarComponent symbol="$CASH" />);
    expect(view.getByTitle("$CASH")).toHaveTextContent("$");
    expect(view.container.querySelector("img")).toBeNull();

    view.rerender(<AvatarComponent symbol="AAPL" />);
    await waitFor(() =>
      expect(view.container.querySelector("img")).toHaveAttribute("src", "/ticker-logos/AAPL.png"),
    );
  });
});

it("does not fetch a custom override for the app cash avatar", () => {
  vi.mocked(getAssetLogo).mockClear();
  assetLogoRegistry.setIndex([summary("cash", "$CASH")]);
  try {
    const view = render(<TickerAvatar symbol="$CASH" assetId="cash" src="preview.png" />);
    expect(view.getByTitle("$CASH")).toHaveTextContent("$");
    expect(view.container.querySelector("img")).toBeNull();
    expect(getAssetLogo).not.toHaveBeenCalled();
  } finally {
    assetLogoRegistry.reset();
  }
});
