import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { analyzeMappedNumericColumns } from "../utils/numeric-format";
import { NumericFormatAlert } from "./numeric-format-alert";

describe("number format guidance", () => {
  it.each(["ltr", "rtl"])("names unresolved columns and the existing setting in %s", (dir) => {
    const fieldMappings = { amount: "Amount", quantity: "Shares" };
    const columns = analyzeMappedNumericColumns(
      ["Amount", "Shares"],
      [
        ["1,000", "1,5"],
        ["2,000", "25.50"],
      ],
      fieldMappings,
      "auto",
      "auto",
    );
    render(
      <div dir={dir}>
        <NumericFormatAlert columns={columns} fieldMappings={fieldMappings} />
      </div>,
    );
    expect(screen.getByText("Check number formats")).toBeInTheDocument();
    expect(screen.getByText(/ambiguous or conflicting/)).toHaveTextContent("Amount, Shares");
    expect(screen.getByText(/ambiguous or conflicting/)).toHaveTextContent("Parse Settings");
  });

  it("hides the warning when column evidence or an explicit choice resolves the format", () => {
    const fieldMappings = { amount: "Amount" };
    for (const [values, decimal] of [
      [["1,000", "25.50"], "auto"],
      [["1,000", "2,000"], "."],
    ] as const) {
      const columns = analyzeMappedNumericColumns(
        ["Amount"],
        values.map((value) => [value]),
        fieldMappings,
        decimal,
        "auto",
      );
      const { container, unmount } = render(
        <NumericFormatAlert columns={columns} fieldMappings={fieldMappings} />,
      );
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });
});
