import { render, screen } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { IncompleteValuationNote } from "./incomplete-valuation-note";

function renderNote(props: Partial<Parameters<typeof IncompleteValuationNote>[0]> = {}) {
  render(
    <MemoryRouter>
      <IncompleteValuationNote {...props}>N/A</IncompleteValuationNote>
    </MemoryRouter>,
  );
}

describe("IncompleteValuationNote", () => {
  it("opens on tap with the reason and a link to the Health Center", async () => {
    const user = userEvent.setup();
    renderNote();

    await user.click(screen.getByRole("button", { name: "N/A" }));

    expect(
      await screen.findByText("Total unavailable: some prices or exchange rates are missing."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View in Health Center" })).toHaveAttribute(
      "href",
      "/health",
    );
  });

  it("opens from the keyboard", async () => {
    const user = userEvent.setup();
    renderNote();

    await user.tab();
    expect(screen.getByRole("button", { name: "N/A" })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("link", { name: "View in Health Center" })).toBeInTheDocument();
  });

  it("names the missing exchange rates", async () => {
    const user = userEvent.setup();
    renderNote({
      missingFx: [
        { itemId: "a", fromCurrency: "GBP", toCurrency: "EUR" },
        { itemId: "b", fromCurrency: "GBP", toCurrency: "EUR" },
        { itemId: "c", fromCurrency: "JPY", toCurrency: "EUR" },
      ],
    });

    await user.click(screen.getByRole("button", { name: "N/A" }));

    const reason = await screen.findByText(/no exchange rates for/);
    expect(reason).toHaveTextContent(
      "Total unavailable: no exchange rates for GBP → EUR, JPY → EUR",
    );
    expect(
      screen.queryByText("Total unavailable: some prices or exchange rates are missing."),
    ).not.toBeInTheDocument();
  });

  it("does not follow or toggle the card around it", async () => {
    const user = userEvent.setup();
    const onCardClick = vi.fn();
    render(
      <MemoryRouter>
        <div onClick={onCardClick}>
          <IncompleteValuationNote>N/A</IncompleteValuationNote>
        </div>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "N/A" }));
    await user.click(await screen.findByText(/some prices or exchange rates/));

    expect(onCardClick).not.toHaveBeenCalled();
  });
});
