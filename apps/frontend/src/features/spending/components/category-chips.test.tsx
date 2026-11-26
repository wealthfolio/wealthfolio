import { render, screen, waitFor } from "@/test/render";
import { Icons } from "@wealthfolio/ui";
import { TagIcon } from "lucide-react";
import { iconNames } from "lucide-react/dynamic";
import { describe, expect, it } from "vitest";

import {
  getInheritedCategoryIcon,
  getLucideCategoryIconName,
  LUCIDE_CATEGORY_ICON_NAMES,
  resolveCategoryIcon,
} from "../lib/category-icons";
import { CategoryIcon } from "./category-chips";

describe("category icons", () => {
  it("lists the 56 preferred icons first without changing the remaining order", () => {
    const preferred = [
      "wallet",
      "banknote",
      "coins",
      "credit-card",
      "landmark",
      "piggy-bank",
      "receipt",
      "badge-dollar-sign",
      "briefcase",
      "building-2",
      "chart-no-axes-combined",
      "trending-up",
      "hand-coins",
      "circle-dollar-sign",
      "percent",
      "arrow-left-right",
      "house",
      "shopping-cart",
      "shopping-bag",
      "utensils-crossed",
      "coffee",
      "pizza",
      "apple",
      "wine",
      "car",
      "fuel",
      "train-front",
      "bus",
      "bike",
      "plane",
      "circle-parking",
      "wrench",
      "zap",
      "droplet",
      "flame",
      "wifi",
      "smartphone",
      "laptop",
      "tv",
      "lightbulb",
      "heart-pulse",
      "stethoscope",
      "pill",
      "dumbbell",
      "graduation-cap",
      "book-open",
      "baby",
      "paw-print",
      "gift",
      "shirt",
      "scissors",
      "sofa",
      "gamepad-2",
      "film",
      "music",
      "shield-check",
    ];
    const preferredSet = new Set<string>(preferred);
    expect(preferred).toHaveLength(56);
    expect(preferredSet.size).toBe(56);
    expect(LUCIDE_CATEGORY_ICON_NAMES).toEqual([
      ...preferred,
      ...[...iconNames].sort().filter((name) => !preferredSet.has(name)),
    ]);
    expect(new Set(LUCIDE_CATEGORY_ICON_NAMES)).toEqual(new Set(iconNames));
  });

  it("preserves legacy icon mappings and uses Lucide Tag for unknown values", () => {
    expect(resolveCategoryIcon("Home")).toBe(Icons.House);
    expect(resolveCategoryIcon("Tag")).toBe(Icons.Tag);
    expect(resolveCategoryIcon(null)).toBe(TagIcon);
    expect(resolveCategoryIcon("unknown")).toBe(TagIcon);
    expect(resolveCategoryIcon("constructor")).toBe(TagIcon);
  });

  it("only accepts known prefixed Lucide names", () => {
    expect(getLucideCategoryIconName("lucide:house")).toBe("house");
    expect(getLucideCategoryIconName("Home")).toBeNull();
    expect(getLucideCategoryIconName("lucide:unknown")).toBeNull();
    expect(getLucideCategoryIconName("lucide:constructor")).toBeNull();
  });

  it("converts known inherited icons without changing existing values", () => {
    expect(getInheritedCategoryIcon("Home")).toBe("lucide:house");
    expect(getInheritedCategoryIcon("ShoppingCart")).toBe("lucide:shopping-cart");
    expect(getInheritedCategoryIcon("lucide:house")).toBe("lucide:house");
    expect(getInheritedCategoryIcon("unknown")).toBeNull();
  });

  it("loads Lucide icons and falls back for unknown or missing values", async () => {
    const { container, rerender } = render(<CategoryIcon icon="lucide:house" />);
    await waitFor(() => expect(container.querySelector(".lucide-house")).toBeInTheDocument());

    rerender(<CategoryIcon icon="lucide:not-an-icon" />);
    expect(container.querySelector(".lucide-tag")).toBeInTheDocument();

    rerender(<CategoryIcon icon={null} />);
    expect(container.querySelector(".lucide-tag")).toBeInTheDocument();
    expect(screen.queryByText("lucide:not-an-icon")).not.toBeInTheDocument();
  });
});
