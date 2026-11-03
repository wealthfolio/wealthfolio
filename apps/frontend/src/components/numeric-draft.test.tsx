import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  FormattingProvider,
  useNumericDraft,
  type NumericDraftOptions,
  type NumericDraftCommit,
} from "@wealthfolio/ui";
import { DirectionProvider } from "@wealthfolio/ui/components/ui/direction";
import { expect, it, vi } from "vitest";

interface EditorProps {
  value?: number;
  options?: NumericDraftOptions;
  onCommit?: (result: NumericDraftCommit) => void;
}
function Editor({ value = 12.345678, options, onCommit }: EditorProps) {
  const draft = useNumericDraft(value, options);
  return (
    <>
      <input aria-label="Number" {...draft.inputProps} onBlur={() => onCommit?.(draft.commit())} />
      <output data-testid="result">{JSON.stringify(draft.result)}</output>
    </>
  );
}
function view(locale: string, props: EditorProps = {}, direction: "ltr" | "rtl" = "ltr") {
  return (
    <DirectionProvider direction={direction}>
      <FormattingProvider locale={locale}>
        <Editor {...props} />
      </FormattingProvider>
    </DirectionProvider>
  );
}
function result() {
  return JSON.parse(screen.getByTestId("result").textContent!);
}

it.each([
  ["", { status: "empty" }],
  [" ", { status: "empty" }],
  ["0", { status: "valid", value: 0 }],
  ["12abc", { status: "invalid" }],
  ["-", { status: "invalid" }],
])("distinguishes the draft %j without choosing a field's empty policy", (text, expected) => {
  render(view("US"));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
  expect(result()).toEqual(expected);
  expect(screen.getByRole("textbox")).toHaveValue(text);
});

it("does not round an untouched value to its displayed precision on blur", () => {
  const onCommit = vi.fn();
  render(view("US", { options: { maximumFractionDigits: 1 }, onCommit }));
  const input = screen.getByRole("textbox");
  expect(input).toHaveValue("12.3");
  expect(result()).toEqual({ status: "valid", value: 12.345678 });
  fireEvent.focus(input);
  fireEvent.blur(input);
  expect(onCommit).toHaveBeenCalledWith({ status: "unchanged" });
});

it("cancels synchronously before the Escape-triggered blur", async () => {
  const onCommit = vi.fn();
  render(view("ES", { onCommit }, "rtl"));
  const user = userEvent.setup();
  const input = screen.getByRole("textbox");
  await user.click(input);
  fireEvent.change(input, { target: { value: "9,5" } });
  await user.keyboard("{Escape}");
  expect(onCommit).toHaveBeenCalledOnce();
  expect(onCommit).toHaveBeenCalledWith({ status: "unchanged" });
  expect(input).toHaveValue("12,345678");
});

it.each([
  ["US", "12.", "ES", "12,"],
  ["US", "12.00", "ES", "12,00"],
  ["ES", "12,", "US", "12."],
  ["ES", "1,234", "US", "1.234"],
  ["US", "-", "ES", "-"],
  ["US", " ", "ES", " "],
  ["ES", "12,3,4", "US", "12,3,4"],
])(
  "preserves meaning and editing intent for %s %j after switching to %s",
  (from, text, to, expected) => {
    const { rerender } = render(view(from));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: text } });
    const before = result();
    rerender(view(to));
    expect(input).toHaveValue(expected);
    expect(result()).toEqual(before);
  },
);

it("accepts further typing using the new region after preserving a partial decimal", async () => {
  const onCommit = vi.fn();
  const { rerender } = render(view("ES", { onCommit }));
  const user = userEvent.setup();
  const input = screen.getByRole("textbox");
  await user.click(input);
  fireEvent.change(input, { target: { value: "12," } });
  rerender(view("US", { onCommit }));
  await user.keyboard("{End}5{Enter}");
  expect(onCommit).toHaveBeenCalledWith({ status: "valid", value: 12.5 });
});

it.each(["12%", "%12", "12 %", "12٪"])(
  "accepts one percent affix in %j without changing units",
  (text) => {
    render(view("US", { options: { acceptPercent: true } }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
    expect(result()).toEqual({ status: "valid", value: 12 });
  },
);

it.each(["12%%", "%12%", "1%2", "%", "٪"])("rejects malformed percent text %j", (text) => {
  render(view("US", { options: { acceptPercent: true } }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
  expect(result()).toEqual({ status: "invalid" });
  expect(screen.getByRole("textbox")).toHaveValue(text);
});

it("normalizes pasted Arabic digits and bidi-only empty drafts", () => {
  render(view("ar-EG", {}, "rtl"));
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "\u2068٩٫٥\u2069" } });
  expect(result()).toEqual({ status: "valid", value: 9.5 });
  fireEvent.change(input, { target: { value: "\u2068 \u2069" } });
  expect(result()).toEqual({ status: "empty" });
  expect(input).toHaveValue(" ");
});

it.each([
  { key: "Enter", isComposing: true },
  { key: "Escape", isComposing: true },
  { key: "Enter", keyCode: 229 },
])("leaves the draft and focus intact during IME composition ($key)", async (event) => {
  const onCommit = vi.fn();
  render(view("US", { onCommit }));
  const user = userEvent.setup();
  const input = screen.getByRole("textbox");
  await user.click(input);
  fireEvent.change(input, { target: { value: "12." } });
  fireEvent.keyDown(input, event);
  expect(input).toHaveFocus();
  expect(input).toHaveValue("12.");
  expect(onCommit).not.toHaveBeenCalled();
});
