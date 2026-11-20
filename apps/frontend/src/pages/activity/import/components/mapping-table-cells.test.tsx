import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ImportFormat, ImportType } from "@/lib/types";
import type { ImportMappingData } from "@/lib/types";
import { MappingHeaderCell } from "./mapping-table-cells";

const mapping: ImportMappingData = {
  accountId: "account-1",
  importType: ImportType.ACTIVITY,
  name: "",
  fieldMappings: {},
  activityMappings: {},
  symbolMappings: {},
  accountMappings: {},
  symbolMappingMeta: {},
};

describe("MappingHeaderCell", () => {
  it("shows the select-column placeholder for an unmapped required field", () => {
    render(
      <MappingHeaderCell
        field={ImportFormat.DATE}
        mapping={mapping}
        headers={["Date", "Amount"]}
        requiredFields={[ImportFormat.DATE]}
        handleColumnMapping={vi.fn()}
      />,
    );

    expect(screen.getByRole("combobox")).toHaveTextContent("Select column");
  });

  it("names the other fields that use a column, keeping it selectable", async () => {
    const user = userEvent.setup();
    const handleColumnMapping = vi.fn();
    render(
      <MappingHeaderCell
        field={ImportFormat.SYMBOL}
        mapping={{ ...mapping, fieldMappings: { [ImportFormat.SYMBOL]: "isin" } }}
        headers={["isin", "trade_id", "symbol"]}
        requiredFields={[]}
        headerFields={
          new Map([
            ["isin", [ImportFormat.SYMBOL, ImportFormat.ISIN]],
            ["trade_id", [ImportFormat.COMMENT, ImportFormat.SUBTYPE]],
          ])
        }
        handleColumnMapping={handleColumnMapping}
      />,
    );

    // A mapped field shows its column as a button until clicked
    await user.click(screen.getByRole("button", { name: "isin" }));
    // The trigger shows the chosen column alone, without its note
    const trigger = screen.getByRole("combobox", { name: ImportFormat.SYMBOL });
    await user.click(trigger);

    // The field's own column names only the other field that reads it
    expect(await screen.findByRole("option", { name: "isin (used by isin)" })).toBeVisible();
    expect(screen.getByRole("option", { name: "symbol" })).toBeVisible();
    // The trigger shows the chosen column alone, without its note
    expect(trigger).toHaveTextContent(/^isin$/);

    await user.click(
      screen.getByRole("option", { name: "trade_id (used by comment and subtype)" }),
    );
    expect(handleColumnMapping).toHaveBeenCalledWith(ImportFormat.SYMBOL, "trade_id");
  });
});
