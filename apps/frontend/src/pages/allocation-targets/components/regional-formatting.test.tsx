import { fireEvent, render, screen } from "@testing-library/react";
import { DirectionProvider } from "@wealthfolio/ui/components/ui/direction";
import { createNumberFormatting, FormattingProvider } from "@wealthfolio/ui";
import type { TaxonomyCategory } from "@/lib/types";
import { describe, expect, it, vi } from "vitest";
import { formatPp, formatTolerance } from "./drift-copy";
import { TargetWeightEditor } from "./target-weight-editor";

const categories: TaxonomyCategory[] = ["Equity", "Bonds"].map((name, index) => ({
  id: name,
  key: name,
  name,
  taxonomyId: "custom",
  color: "#123456",
  sortOrder: index,
  createdAt: "",
  updatedAt: "",
}));

describe("allocation regional formatting", () => {
  it("formats signed drift and tolerance with the selected decimal mark and percent spacing", () => {
    const es = createNumberFormatting("ES");
    expect(formatPp(125, es)).toBe("+1,3 %");
    expect(formatPp(-125, es)).toBe("-1,3 %");
    expect(formatTolerance(150, es)).toBe("±1,5 %");
  });

  it("displays and edits target weights without truncating decimal commas", () => {
    const onChange = vi.fn();
    render(
      <FormattingProvider locale="ES">
        <TargetWeightEditor
          categories={categories}
          weights={[
            { categoryId: "Equity", targetBps: 3330, isLocked: false },
            { categoryId: "Bonds", targetBps: 6670, isLocked: false },
          ]}
          currentAllocation={{ Equity: 33.3, Bonds: 66.7 }}
          colorByCategory={new Map()}
          bandType="absolute"
          driftBandBps={100}
          relativeFactorBps={2000}
          onChange={onChange}
        />
      </FormattingProvider>,
    );
    expect(screen.getByText("33,3 %")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "33,3" }));
    const input = screen.getByRole("textbox", { name: "Equity Target" });
    expect(input).toHaveValue("33,3");
    fireEvent.change(input, { target: { value: "34,5" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ categoryId: "Equity", targetBps: 3450 }),
      expect.objectContaining({ categoryId: "Bonds", targetBps: 6550 }),
    ]);
  });
});

function renderEditableWeights(locale = "US", direction: "ltr" | "rtl" = "ltr") {
  const onChange = vi.fn();
  render(
    <DirectionProvider direction={direction}>
      <FormattingProvider locale={locale}>
        <TargetWeightEditor
          categories={categories}
          weights={[
            { categoryId: "Equity", targetBps: 3330, isLocked: false },
            { categoryId: "Bonds", targetBps: 6670, isLocked: false },
          ]}
          currentAllocation={{ Equity: 33.3, Bonds: 66.7 }}
          colorByCategory={new Map()}
          bandType="absolute"
          driftBandBps={100}
          relativeFactorBps={2000}
          onChange={onChange}
        />
      </FormattingProvider>
    </DirectionProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: locale === "US" ? /33\.3/ : /33,3/ }));
  return { onChange, input: screen.getByRole("textbox", { name: "Equity Target" }) };
}

it.each([
  { locale: "US", direction: "ltr" as const, invalid: "12%%", commit: "blur" },
  { locale: "US", direction: "ltr" as const, invalid: "12,5", commit: "Enter" },
  { locale: "ES", direction: "rtl" as const, invalid: "12abc", commit: "blur" },
  { locale: "ES", direction: "rtl" as const, invalid: "abc", commit: "Enter" },
])(
  "preserves target weights for unreadable $invalid in $locale on $commit",
  ({ locale, direction, invalid, commit }) => {
    const { input, onChange } = renderEditableWeights(locale, direction);
    // An invalid replacement must discard any preceding valid live preview too.
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.change(input, { target: { value: invalid } });
    if (commit === "blur") fireEvent.blur(input);
    else fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: locale === "US" ? /33\.3/ : /33,3/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: locale === "US" ? "66.7" : /66,7/ }),
    ).toBeInTheDocument();
  },
);

it("still commits an explicit zero target weight", () => {
  const { input, onChange } = renderEditableWeights();
  fireEvent.change(input, { target: { value: "0" } });
  fireEvent.blur(input);
  expect(onChange).toHaveBeenCalledWith([
    expect.objectContaining({ categoryId: "Equity", targetBps: 0 }),
    expect.objectContaining({ categoryId: "Bonds", targetBps: 10000 }),
  ]);
});

it.each([
  { locale: "US", direction: "ltr" as const, blank: "", commit: "blur" },
  { locale: "US", direction: "rtl" as const, blank: " ", commit: "Enter" },
  { locale: "ES", direction: "ltr" as const, blank: "", commit: "Enter" },
  { locale: "ES", direction: "rtl" as const, blank: "\u2068 \u2069", commit: "blur" },
])(
  "commits a cleared target weight as zero in $locale $direction on $commit",
  ({ locale, direction, blank, commit }) => {
    const { input, onChange } = renderEditableWeights(locale, direction);
    fireEvent.change(input, { target: { value: blank } });
    if (commit === "blur") fireEvent.blur(input);
    else fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ categoryId: "Equity", targetBps: 0 }),
      expect.objectContaining({ categoryId: "Bonds", targetBps: 10000 }),
    ]);
  },
);

it("accepts a percent affix when editing a target weight", () => {
  const { input, onChange } = renderEditableWeights("ES", "rtl");
  fireEvent.change(input, { target: { value: "12,5 %" } });
  fireEvent.blur(input);
  expect(onChange).toHaveBeenCalledWith([
    expect.objectContaining({ categoryId: "Equity", targetBps: 1250 }),
    expect.objectContaining({ categoryId: "Bonds", targetBps: 8750 }),
  ]);
});

it("shows zero when editing a category without a stored target weight", () => {
  render(
    <FormattingProvider locale="ES">
      <TargetWeightEditor
        categories={categories}
        weights={[{ categoryId: "Equity", targetBps: 10000, isLocked: false }]}
        currentAllocation={{ Equity: 100 }}
        colorByCategory={new Map()}
        bandType="absolute"
        driftBandBps={100}
        relativeFactorBps={2000}
        onChange={vi.fn()}
      />
    </FormattingProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "0,0" }));
  expect(screen.getByRole("textbox", { name: "Bonds Target" })).toHaveValue("0,0");
});
