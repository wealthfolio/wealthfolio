import { describe, expect, it } from "vitest";

import { isPastedCsvTable, pastedCsvFileName } from "./pasted-csv";

describe("isPastedCsvTable", () => {
  it("accepts rows copied from a spreadsheet", () => {
    expect(isPastedCsvTable("Date\tSymbol\tQuantity\n2024-01-15\tAAPL\t10\n")).toBe(true);
  });

  it("accepts comma and semicolon tables, with quoted delimiters", () => {
    expect(
      isPastedCsvTable(
        'Date,Security,Amount\r\n2024-01-15,"Apple Inc, Common","1,234.56"\r\n\r\n2024-01-16,MSFT,10\r\n',
      ),
    ).toBe(true);
    expect(isPastedCsvTable("Datum;Fonds;Betrag\n02.01.2024;MSCI World;100,50")).toBe(true);
  });

  it("accepts a two-column table whose rows hold values", () => {
    expect(isPastedCsvTable("Date,Amount\n2024-01-15,100.00\n2024-01-16,-25.50")).toBe(true);
    expect(isPastedCsvTable("Datum;Betrag\n15.01.2024;100,50")).toBe(true);
  });

  it("keeps quoted line breaks inside a cell", () => {
    expect(
      isPastedCsvTable(
        'Date,Merchant,Amount\n2024-01-15,"Coffee\nShop",4.50\n2024-01-16,Grocer,20.00',
      ),
    ).toBe(true);
    expect(
      isPastedCsvTable('Date\tNote\n2024-01-15\t"line one\r\nline two"\n2024-01-16\tdone'),
    ).toBe(true);
  });

  it("leaves prose, single lines and ragged text as text", () => {
    expect(isPastedCsvTable("Hello, world\nHow are you, today")).toBe(false);
    expect(isPastedCsvTable("Date,Symbol,Quantity")).toBe(false);
    expect(isPastedCsvTable("Account Statement\nDate,Symbol,Quantity\n2024-01-15,AAPL,10")).toBe(
      false,
    );
  });
});

describe("pastedCsvFileName", () => {
  it("picks a name the composer does not use yet", () => {
    expect(pastedCsvFileName([])).toBe("pasted.csv");
    expect(pastedCsvFileName(["trades.csv", "pasted.csv"])).toBe("pasted-2.csv");
    expect(pastedCsvFileName(["pasted.csv", "pasted-2.csv"])).toBe("pasted-3.csv");
  });
});
