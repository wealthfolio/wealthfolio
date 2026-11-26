import { render, screen, waitFor } from "@/test/render";
import { Icons } from "@wealthfolio/ui";
import { TagIcon } from "lucide-react";
import { describe, expect, it } from "vitest";

import {
  getInheritedCategoryIcon,
  getLucideCategoryIconName,
  resolveCategoryIcon,
} from "../lib/category-icons";
import { CategoryIcon } from "./category-chips";

describe("category icons", () => {
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
