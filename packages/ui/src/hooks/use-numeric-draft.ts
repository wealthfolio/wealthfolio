import { useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { useLocalizationSettings, useNumberFormatting } from "../components/formatting-provider";
import {
  parseLocalizedDecimalString,
  stripBidiControls,
  type NumberFormatting,
} from "../lib/formatting";
import { isKeyboardEventComposing } from "../lib/utils";

export type NumericDraftResult =
  | { status: "empty" }
  | { status: "invalid" }
  | { status: "valid"; value: number };

export type NumericDraftCommit = NumericDraftResult | { status: "unchanged" };

export interface NumericDraftOptions {
  /** Values are in display units: a percentage value of 2.5 means 2.5%. */
  acceptPercent?: boolean;
  /** Preserve the legacy ungrouped rate fields that accept either decimal mark. */
  decimalAliases?: boolean;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  formatValue?: (value: number) => string;
  onEnter?: () => void;
  onEscape?: () => void;
}

interface Draft {
  text: string;
  numbers: NumberFormatting;
  locale: string;
}

/**
 * Localized editing only. Callers decide what empty/invalid values mean,
 * when to commit, and how to convert display units to domain values.
 */
export function useNumericDraft(value: number | undefined, options: NumericDraftOptions = {}) {
  const numbers = useNumberFormatting();
  const { locale } = useLocalizationSettings();
  const [draft, setDraft] = useState<Draft | null>(null);
  // Event handlers must see a change/cancel before React's next render (e.g. Escape + blur).
  const draftRef = useRef<Draft | null>(null);

  const format = (next: number, minimumFractionDigits = options.minimumFractionDigits) =>
    stripBidiControls(
      numbers.formatDecimal(next, {
        useGrouping: false,
        minimumFractionDigits,
        maximumFractionDigits: Math.max(
          minimumFractionDigits ?? 0,
          options.maximumFractionDigits ?? 20,
        ),
      }),
    );

  const decimalText = (text: string, source: NumberFormatting) =>
    options.decimalAliases ? text.replace(/[.,]/g, source.decimalSeparator) : text;

  const parse = (current: Draft | null): NumericDraftResult => {
    if (current === null)
      return value === undefined ? { status: "empty" } : { status: "valid", value };
    if (!current.text.trim()) return { status: "empty" };
    const parsed = current.numbers.parseNumber(decimalText(current.text, current.numbers));
    return parsed === undefined ? { status: "invalid" } : { status: "valid", value: parsed };
  };

  const result = parse(draft);
  let text =
    draft?.text ??
    (value === undefined ? "" : stripBidiControls(options.formatValue?.(value) ?? format(value)));
  if (draft && draft.numbers !== numbers && result.status === "valid") {
    const sourceText = decimalText(draft.text.trim(), draft.numbers);
    // Use the parser's localized/grouped/invariant interpretation, not separator guesses.
    const decimal = parseLocalizedDecimalString(sourceText, draft.locale);
    if (decimal !== undefined) {
      // Translate the exact text so active drafts never inherit display rounding limits.
      text = decimal.replace(/[0-9.]/g, (character) =>
        character === "."
          ? numbers.decimalSeparator
          : stripBidiControls(
              numbers.formatDecimal(Number(character), {
                useGrouping: false,
                maximumFractionDigits: 0,
              }),
            ),
      );
      const normalizedSource = sourceText.normalize("NFKC");
      if (
        normalizedSource.endsWith(draft.numbers.decimalSeparator) ||
        normalizedSource.endsWith(".")
      ) {
        text += numbers.decimalSeparator;
      }
    }
    // Some numbering systems are accepted by parseNumber but not the exact-string
    // parser. Keep those drafts verbatim rather than round or reinterpret them.
  }

  const setText = (raw: string): NumericDraftResult => {
    let next = stripBidiControls(raw);
    if (options.acceptPercent) {
      const trimmed = next.trim();
      // Accept exactly one affix; duplicate/interior percent signs remain invalid.
      if (/^[%٪]|[%٪]$/u.test(trimmed)) {
        const withoutAffix = trimmed.replace(/^[%٪]|[%٪]$/u, "");
        if (withoutAffix.trim() && !/[%٪]/u.test(withoutAffix)) next = withoutAffix;
      }
    }
    const current = { text: next, numbers, locale };
    draftRef.current = current;
    setDraft(current);
    return parse(current);
  };

  const reset = () => {
    draftRef.current = null;
    setDraft(null);
  };

  const read = () => parse(draftRef.current);
  const commit = (): NumericDraftCommit => {
    if (draftRef.current === null) return { status: "unchanged" };
    const next = read();
    reset();
    return next;
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>) => setText(event.currentTarget.value);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isKeyboardEventComposing(event.nativeEvent)) return;
    if (event.key === "Enter") {
      if (options.onEnter) options.onEnter();
      else event.currentTarget.blur();
    }
    if (event.key === "Escape") {
      reset();
      options.onEscape?.();
      event.currentTarget.blur();
    }
  };

  return {
    result,
    setText,
    read,
    commit,
    reset,
    inputProps: { value: text, onChange, onKeyDown },
  };
}
