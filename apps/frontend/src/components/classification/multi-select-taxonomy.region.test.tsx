import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FormattingProvider } from "@wealthfolio/ui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MultiSelectTaxonomy } from "./multi-select-taxonomy";

const { save } = vi.hoisted(() => ({ save: vi.fn().mockResolvedValue({}) }));
vi.mock("@/hooks/use-taxonomies", () => ({
  useTaxonomy: () => ({
    data: {
      categories: [
        { id: "equity", name: "Equity", color: "red", sortOrder: 0 },
        { id: "bonds", name: "Bonds", color: "blue", sortOrder: 1 },
      ],
    },
    isLoading: false,
  }),
  useAssetTaxonomyAssignments: () => ({
    data: [{ id: "assignment", taxonomyId: "custom", categoryId: "equity", weight: 3330 }],
    isLoading: false,
  }),
  useAssignAssetToCategory: () => ({ mutateAsync: save, isPending: false }),
  useRemoveAssetTaxonomyAssignment: () => ({ isPending: false }),
}));

it("round-trips classification weights through Spain's decimal format", async () => {
  render(
    <FormattingProvider locale="ES">
      <MultiSelectTaxonomy taxonomyId="custom" assetId="asset" label="Classes" />
    </FormattingProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /33,30\s%/ }));
  const input = screen.getByRole("textbox", { name: "Weight" });
  expect(input).toHaveValue("33,3");
  fireEvent.change(input, { target: { value: "34,5" } });
  fireEvent.blur(input);
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ weight: 3450 })));
});

beforeEach(() => {
  save.mockClear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  ["US", /33.30%/, "34.5%"],
  ["ES", /33,30\s%/, "34,5 %"],
  ["tr-TR", /%33,30/, "%34,5"],
])("accepts a pasted percent suffix in %s", async (locale, label, value) => {
  render(
    <FormattingProvider locale={locale}>
      <MultiSelectTaxonomy taxonomyId="custom" assetId="asset" label="Classes" />
    </FormattingProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: label }));
  const input = screen.getByRole("textbox", { name: "Weight" });
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ weight: 3450 })));
});

it.each(["101%", "-1%", "34bad%", "34%%", "%34%", ""])(
  "does not save invalid weight %s",
  (value) => {
    render(
      <FormattingProvider locale="US">
        <MultiSelectTaxonomy taxonomyId="custom" assetId="asset" label="Classes" />
      </FormattingProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /33.30%/ }));
    const input = screen.getByRole("textbox", { name: "Weight" });
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
    expect(save).not.toHaveBeenCalled();
  },
);

it("accepts a pasted localized percentage when adding a classification", async () => {
  render(
    <FormattingProvider locale="ES">
      <MultiSelectTaxonomy taxonomyId="custom" assetId="asset" label="Classes" />
    </FormattingProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(await screen.findByRole("option", { name: "Bonds" }));
  const input = screen
    .getAllByRole("textbox")
    .find((element) => (element as HTMLInputElement).value === "100")!;
  fireEvent.change(input, { target: { value: "34,5 %" } });
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ categoryId: "bonds", weight: 3450 }),
    ),
  );
});

it("restores the default weight when a new classification draft is empty", async () => {
  render(
    <FormattingProvider locale="ES">
      <MultiSelectTaxonomy taxonomyId="custom" assetId="asset" label="Classes" />
    </FormattingProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(await screen.findByRole("option", { name: "Bonds" }));
  const input = screen
    .getAllByRole("textbox")
    .find((element) => (element as HTMLInputElement).value === "100")!;
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(input).toHaveValue("100");
  expect(save).not.toHaveBeenCalled();
});

it("retains an edited classification draft while its save is pending", async () => {
  let complete!: (value: object) => void;
  save.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  render(
    <FormattingProvider locale="ES">
      <MultiSelectTaxonomy taxonomyId="custom" assetId="asset" label="Classes" />
    </FormattingProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /33,3/ }));
  const input = screen.getByRole("textbox", { name: "Weight" });
  fireEvent.change(input, { target: { value: "34,5" } });
  fireEvent.blur(input);
  expect(input).toHaveValue("34,5");
  complete({});
  await waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Weight" })).not.toBeInTheDocument(),
  );
});
