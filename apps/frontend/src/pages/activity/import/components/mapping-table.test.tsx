import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ActivityType, ImportFormat, ImportType } from "@/lib/types";
import type { CsvRowData, ImportMappingData } from "@/lib/types";
import { MappingTable } from "./mapping-table";

vi.mock("@/components/account-selector", () => ({
  AccountSelector: () => <div data-testid="account-selector" />,
}));

vi.mock("@/components/ticker-search", () => ({
  default: () => <input placeholder="Map symbol" />,
}));

describe("MappingTable symbol mappings", () => {
  it("uses trimmed CSV symbols when displaying saved symbol mappings", () => {
    const mapping: ImportMappingData = {
      accountId: "account-1",
      importType: ImportType.ACTIVITY,
      name: "",
      fieldMappings: {
        [ImportFormat.DATE]: "Date",
        [ImportFormat.ACTIVITY_TYPE]: "Type",
        [ImportFormat.SYMBOL]: "Security",
        [ImportFormat.QUANTITY]: "Quantity",
      },
      activityMappings: {
        [ActivityType.BUY]: ["BUY"],
      },
      symbolMappings: {
        "Long Fund Name": "VTI",
      },
      accountMappings: {},
      symbolMappingMeta: {},
    };
    const row: CsvRowData = {
      lineNumber: "1",
      Date: "2026-01-15",
      Type: "BUY",
      Security: "  Long Fund Name  ",
      Quantity: "1",
    };
    const getMappedValue = (csvRow: CsvRowData, field: ImportFormat) => {
      const mappedHeader = mapping.fieldMappings[field];
      if (!mappedHeader) return "";
      if (Array.isArray(mappedHeader)) {
        for (const header of mappedHeader) {
          const value = csvRow[header]?.trim();
          if (value) return value;
        }
        return "";
      }
      return csvRow[mappedHeader] || "";
    };

    render(
      <MappingTable
        mapping={mapping}
        headers={["Date", "Type", "Security", "Quantity"]}
        data={[row]}
        accounts={[]}
        handleColumnMapping={vi.fn()}
        handleActivityTypeMapping={vi.fn()}
        handleSymbolMapping={vi.fn()}
        handleAccountIdMapping={vi.fn()}
        getMappedValue={getMappedValue}
        invalidSymbols={["Long Fund Name"]}
        invalidAccounts={[]}
      />,
    );

    expect(screen.getByText("VTI")).toBeInTheDocument();
  });
});

describe("MappingTable comment columns", () => {
  beforeAll(() => {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("selects several comment columns in CSV column order", async () => {
    const user = userEvent.setup();
    const handleColumnMapping = vi.fn();
    const mapping: ImportMappingData = {
      accountId: "account-1",
      importType: ImportType.ACTIVITY,
      name: "",
      fieldMappings: { [ImportFormat.COMMENT]: "Purpose" },
      activityMappings: {},
      symbolMappings: {},
      accountMappings: {},
      symbolMappingMeta: {},
    };

    render(
      <MappingTable
        mapping={mapping}
        headers={["Payee", "Purpose"]}
        data={[]}
        accounts={[]}
        handleColumnMapping={handleColumnMapping}
        handleActivityTypeMapping={vi.fn()}
        handleSymbolMapping={vi.fn()}
        handleAccountIdMapping={vi.fn()}
        getMappedValue={() => ""}
        invalidSymbols={[]}
        invalidAccounts={[]}
        visibleFields={[ImportFormat.COMMENT]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Purpose" }));
    await user.click(await screen.findByRole("option", { name: "Payee" }));

    expect(handleColumnMapping).toHaveBeenCalledWith(ImportFormat.COMMENT, ["Payee", "Purpose"]);
  });
});
