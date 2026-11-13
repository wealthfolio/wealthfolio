import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import {
  FormattingProvider,
  MoneyInput,
  QuantityInput,
  DirectionProvider,
  useDataGrid,
  parseLocalizedNumber,
  parseLocalizedDecimalString,
} from "@wealthfolio/ui";
import { NumberCell } from "@wealthfolio/ui/components/data-grid/data-grid-cell-variants";
import type { Cell, ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const pointLocales = [
  "en-US",
  "en-CA",
  "en-GB",
  "en-IN",
  "de-CH",
  "es-MX",
  "zh-CN",
  "zh-TW",
  "ja-JP",
  "ko-KR",
];
const malformed = ["0,125", "00,125", "-0,125", "01,234", "0,125.5"];
type Row = { a: string | number | null; b: string | number | null };

function Wrapper({
  locale,
  dir = "ltr",
  children,
}: {
  locale: string;
  dir?: "ltr" | "rtl";
  children: React.ReactNode;
}) {
  return (
    <DirectionProvider direction={dir}>
      <FormattingProvider locale={locale}>{children}</FormattingProvider>
    </DirectionProvider>
  );
}

function Grid({
  type,
  onDataChange,
  initial = "1.125",
  initialB,
}: {
  type: "string" | "number";
  onDataChange: (data: Row[]) => void;
  initial?: string;
  initialB?: string;
}) {
  const columns = useMemo<ColumnDef<Row>[]>(
    () =>
      ["a", "b"].map((accessorKey) => ({
        accessorKey,
        meta: { cell: { variant: "number", valueType: type } },
      })),
    [type],
  );
  const data = useMemo(
    () => [
      {
        a: type === "string" ? initial : Number(initial),
        b: initialB === undefined ? null : type === "string" ? initialB : Number(initialB),
      },
    ],
    [type, initial, initialB],
  );
  const grid = useDataGrid({ data, columns, enablePaste: true, onDataChange });
  return (
    <>
      <button onClick={() => grid.tableMeta?.onCellClick?.(0, "a")}>Source</button>
      <button onClick={() => grid.tableMeta?.onCellClick?.(0, "b")}>Destination</button>
      <div ref={grid.dataGridRef} data-testid="grid" />
    </>
  );
}

function clipboard(text = "") {
  let content = text;
  const writeText = vi.fn(async (value: string) => {
    content = value;
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText, readText: vi.fn(async () => content) },
  });
  return writeText;
}

function cell(
  type: "string" | "number",
  locale: string,
  initial = "1.125",
  dir: "ltr" | "rtl" = "ltr",
) {
  const initialValue =
    type === "string" ? (initial === "1e-7" ? "0.0000001" : initial) : Number(initial);
  const onDataUpdate = vi.fn();
  const mockCell = {
    getValue: () => initialValue,
    column: { columnDef: { meta: { cell: { variant: "number", valueType: type } } } },
    row: { original: { a: initialValue } },
  } as unknown as Cell<Row, unknown>;
  render(
    <Wrapper locale={locale} dir={dir}>
      <NumberCell
        cell={mockCell}
        tableMeta={{ onDataUpdate }}
        rowIndex={0}
        columnId="a"
        rowHeight="short"
        isEditing
        isFocused
        isSelected={false}
        isSearchMatch={false}
        isActiveSearchMatch={false}
        readOnly={false}
      />
    </Wrapper>,
  );
  return onDataUpdate;
}

describe("decimal-integrity regressions", () => {
  it.each(["number", "string"] as const)(
    "#2216 %s copy/paste preserves stored value",
    async (type) => {
      const write = clipboard();
      const change = vi.fn();
      render(
        <Wrapper locale="de-DE">
          <Grid type={type} onDataChange={change} />
        </Wrapper>,
      );
      fireEvent.click(screen.getByText("Source"));
      fireEvent.keyDown(screen.getByTestId("grid"), { key: "c", ctrlKey: true });
      await waitFor(() => expect(write).toHaveBeenCalled());
      fireEvent.click(screen.getByText("Destination"));
      fireEvent.keyDown(screen.getByTestId("grid"), { key: "v", ctrlKey: true });
      await waitFor(() => expect(change).toHaveBeenCalled());
      expect(Number(change.mock.lastCall?.[0][0].b)).toBe(1.125);
    },
  );
  it.each(["number", "string"] as const)(
    "#2216 %s last digit editor change preserves decimal",
    (type) => {
      const update = cell(type, "de-DE");
      const input = screen.getByRole<HTMLInputElement>("textbox");
      fireEvent.change(input, { target: { value: input.value.replace(/5$/, "6") } });
      fireEvent.blur(screen.getByRole("textbox"));
      expect(Number(update.mock.lastCall?.[0].value)).toBe(1.126);
    },
  );
  for (const [locale, values] of [
    ["ar-EG", ["٠,١٢٥", ".١٢٥", "+.١٢٥", "-.١٢٥", "+ 0.125", "+ 0,125", "+ 1,234.56"]],
    ["fa-IR", ["٠,١٢٥", ".١٢٥"]],
  ] as const) {
    it.each(values)(`#2634 ${locale} %s agrees or both reject`, (text) => {
      const number = parseLocalizedNumber(text, locale);
      const decimal = parseLocalizedDecimalString(text, locale);
      expect(number).toBe(decimal === undefined ? undefined : Number(decimal));
    });
  }
});

describe("regional parser parity", () => {
  for (const locale of [
    "en-US",
    "en-CA",
    "en-GB",
    "en-IN",
    "de-CH",
    "es-MX",
    "zh-CN",
    "zh-TW",
    "ja-JP",
    "ko-KR",
  ]) {
    it.each(["٠.١٢٥", ".١٢٥", "-.١٢٥"])(`${locale} %s agrees or both reject`, (text) => {
      const number = parseLocalizedNumber(text, locale);
      const decimal = parseLocalizedDecimalString(text, locale);
      expect(number).toBe(decimal === undefined ? undefined : Number(decimal));
    });
  }
  it.each(["- 0.125", "1 234.56"])("en-US %s whitespace agrees or both reject", (text) => {
    const number = parseLocalizedNumber(text, "en-US");
    const decimal = parseLocalizedDecimalString(text, "en-US");
    expect(number).toBe(decimal === undefined ? undefined : Number(decimal));
  });
});

for (const type of ["number", "string"] as const)
  for (const dir of ["ltr", "rtl"] as const) {
    describe(`${type} clipboard in ${dir}`, () => {
      for (const action of ["c", "x"] as const) {
        it.each(["1.125", "12.345", "1.085", "-1.125", "1e-7"])(
          `${action === "c" ? "copy" : "cut"} preserves %s`,
          async (initial) => {
            const write = clipboard();
            const change = vi.fn();
            render(
              <Wrapper locale="de-DE" dir={dir}>
                <Grid type={type} initial={initial} onDataChange={change} />
              </Wrapper>,
            );
            fireEvent.click(screen.getByText("Source"));
            fireEvent.keyDown(screen.getByTestId("grid"), { key: action, ctrlKey: true });
            await waitFor(() =>
              expect(write).toHaveBeenLastCalledWith(
                initial === "1e-7" ? "0,0000001" : initial.replace(".", ","),
              ),
            );
            fireEvent.click(screen.getByText("Destination"));
            fireEvent.keyDown(screen.getByTestId("grid"), { key: "v", ctrlKey: true });
            await waitFor(() => expect(change).toHaveBeenCalled());
            expect(change.mock.lastCall?.[0][0].b).toBe(
              type === "string" ? (initial === "1e-7" ? "0.0000001" : initial) : Number(initial),
            );
          },
        );
      }
      it("copies and pastes multi-cell TSV without changing values", async () => {
        const write = clipboard();
        const change = vi.fn();
        render(
          <Wrapper locale="de-DE" dir={dir}>
            <Grid type={type} initialB="12.345" onDataChange={change} />
          </Wrapper>,
        );
        fireEvent.click(screen.getByText("Source"));
        fireEvent.keyDown(screen.getByTestId("grid"), { key: "a", ctrlKey: true });
        fireEvent.keyDown(screen.getByTestId("grid"), { key: "c", ctrlKey: true });
        await waitFor(() => expect(write).toHaveBeenLastCalledWith("1,125\t12,345"));
        fireEvent.keyDown(screen.getByTestId("grid"), { key: "v", ctrlKey: true });
        await waitFor(() => expect(change).toHaveBeenCalled());
        expect(change.mock.lastCall?.[0][0]).toEqual(
          type === "string" ? { a: "1.125", b: "12.345" } : { a: 1.125, b: 12.345 },
        );
      });
      it("fills selected cells with a single regional decimal", async () => {
        clipboard("1,125");
        const change = vi.fn();
        render(
          <Wrapper locale="de-DE" dir={dir}>
            <Grid type={type} onDataChange={change} />
          </Wrapper>,
        );
        fireEvent.click(screen.getByText("Source"));
        fireEvent.keyDown(screen.getByTestId("grid"), { key: "a", ctrlKey: true });
        fireEvent.keyDown(screen.getByTestId("grid"), { key: "v", ctrlKey: true });
        await waitFor(() => expect(change).toHaveBeenCalled());
        const expected = type === "string" ? "1.125" : 1.125;
        expect(change.mock.lastCall?.[0][0]).toEqual({ a: expected, b: expected });
      });
      it("rejects an ambiguous Arabic paste without changing cells", async () => {
        const read = vi.fn().mockResolvedValue(".١٢٥");
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { readText: read },
        });
        const change = vi.fn();
        render(
          <Wrapper locale="ar-EG" dir={dir}>
            <Grid type={type} onDataChange={change} />
          </Wrapper>,
        );
        fireEvent.click(screen.getByText("Destination"));
        fireEvent.keyDown(screen.getByTestId("grid"), { key: "v", ctrlKey: true });
        await act(async () => {
          await Promise.resolve();
        });
        expect(read).toHaveBeenCalled();
        expect(change).not.toHaveBeenCalled();
      });
    });
  }
it("round trips every digit and trailing zero of a decimal-string cell", async () => {
  const initial = "123456789012345678.123456780000";
  const write = clipboard();
  const change = vi.fn();
  render(
    <Wrapper locale="de-DE">
      <Grid type="string" initial={initial} onDataChange={change} />
    </Wrapper>,
  );
  fireEvent.click(screen.getByText("Source"));
  fireEvent.keyDown(screen.getByTestId("grid"), { key: "c", ctrlKey: true });
  await waitFor(() => expect(write).toHaveBeenLastCalledWith(initial.replace(".", ",")));
  fireEvent.click(screen.getByText("Destination"));
  fireEvent.keyDown(screen.getByTestId("grid"), { key: "v", ctrlKey: true });
  await waitFor(() => expect(change).toHaveBeenCalled());
  expect(change.mock.lastCall?.[0][0].b).toBe(initial);
});
it.each(["money", "quantity"])("rejects ambiguous native-dot whole-value paste in %s", (kind) => {
  const onValueChange = vi.fn();
  render(
    <Wrapper locale="ar-EG" dir="rtl">
      {kind === "money" ? (
        <MoneyInput onValueChange={onValueChange} />
      ) : (
        <QuantityInput onValueChange={onValueChange} />
      )}
    </Wrapper>,
  );
  fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { getData: () => ".١٢٥" } });
  expect(onValueChange).not.toHaveBeenCalled();
});

it.each(pointLocales)(
  "%s rejects malformed/ambiguous text and preserves canonical native digits",
  (locale) => {
    for (const text of [...malformed, "٠.١٢٥", ".١٢٥", "-.١٢٥", "- 0.125", "1 234.56"]) {
      expect(parseLocalizedNumber(text, locale), text).toBeUndefined();
      expect(parseLocalizedDecimalString(text, locale), text).toBeUndefined();
    }
    expect(parseLocalizedNumber("١٢٫٣٤٠٠", locale)).toBe(12.34);
    expect(parseLocalizedDecimalString("١٢٫٣٤٠٠", locale)).toBe("12.3400");
  },
);
it("preserves valid space grouping and rejects whitespace in ungrouped regions", () => {
  expect(parseLocalizedNumber("1 234,56", "fr-FR")).toBe(1234.56);
  expect(parseLocalizedDecimalString("1 234,56", "fr-FR")).toBe("1234.56");
  for (const text of ["+ 0.125", "− 0.125", "+\u00a00.125", "1 234.56"]) {
    expect(parseLocalizedNumber(text, "en-US")).toBeUndefined();
    expect(parseLocalizedDecimalString(text, "en-US")).toBeUndefined();
  }
});
