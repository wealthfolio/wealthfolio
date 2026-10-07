import { act, renderHook } from "@/test/render";
import { useForm } from "react-hook-form";
import { describe, expect, it } from "vitest";
import {
  getCalculationRate,
  getTransferRate,
  useInternalTransferCurrencies,
} from "./use-internal-transfer-currencies";

interface Values {
  accountId: string;
  fromAccountId: string;
  toAccountId: string;
  sourceCurrency?: string;
  destinationCurrency?: string;
  sourceAmount?: number;
  destinationAmount?: number | null;
  transferRate?: number | null;
  currency?: string;
  fxRate?: number;
}
const accounts = [
  { value: "a", label: "A", currency: "USD" },
  { value: "b", label: "B", currency: "EUR" },
  { value: "c", label: "C", currency: "GBP" },
];
const defaults: Values = {
  accountId: "a",
  fromAccountId: "a",
  toAccountId: "b",
  sourceAmount: 780,
};

describe("getCalculationRate", () => {
  it("calculates with the exact ratio while the field shows the rounded one", () => {
    const rate = getCalculationRate(
      getTransferRate(78_000_000, 10_000_000),
      78_000_000,
      10_000_000,
    );
    expect(rate).toBe(10_000_000 / 78_000_000);
    expect(Number((156_000_000 * rate!).toFixed(6))).toBe(20_000_000);
  });

  it("uses a typed rate as typed and ignores invalid ones", () => {
    expect(getCalculationRate(0.13, 78_000_000, 10_000_000)).toBe(0.13);
    expect(getCalculationRate(0.13, undefined, undefined)).toBe(0.13);
    expect(getCalculationRate(null, 780, 100)).toBeUndefined();
    expect(getCalculationRate(0, 780, 100)).toBeUndefined();
  });
});

describe("getTransferRate", () => {
  it("derives a display rate without making valid amounts fail positive-rate validation", () => {
    expect(getTransferRate(780, 100)).toBe(0.12820513);
    expect(getTransferRate(1_000_000_000, 1)).toBeUndefined();
    expect(getTransferRate(0, 100)).toBeUndefined();
    expect(getTransferRate(1, Infinity)).toBeUndefined();
  });
});

describe.each(["accountId", "fromAccountId"] as const)(
  "transfer currencies via %s",
  (sourceAccountField) => {
    function useTestForm({ options = accounts, editing = false, values = defaults } = {}) {
      const form = useForm<Values>({ defaultValues: values });
      useInternalTransferCurrencies(form, options, {
        enabled: true,
        isEditing: editing,
        sourceAccountField,
      });
      return form;
    }

    it("defaults each side independently and follows account changes only until overridden", () => {
      const { result } = renderHook(() => useTestForm());
      expect(result.current.getValues()).toMatchObject({
        sourceCurrency: "USD",
        destinationCurrency: "EUR",
      });
      act(() => result.current.setValue("toAccountId", "c", { shouldDirty: true }));
      expect(result.current.getValues("destinationCurrency")).toBe("GBP");
      act(() => result.current.setValue("sourceCurrency", "HKD", { shouldDirty: true }));
      act(() => result.current.setValue(sourceAccountField, "c", { shouldDirty: true }));
      expect(result.current.getValues("sourceCurrency")).toBe("HKD");
    });

    it("invalidates execution rate and received amount but not source amount or valuation rate", () => {
      const { result } = renderHook(() =>
        useTestForm({
          values: {
            ...defaults,
            sourceCurrency: "HKD",
            destinationCurrency: "USD",
            destinationAmount: 100,
            transferRate: 0.12820513,
            fxRate: 0.13,
          },
        }),
      );
      act(() => result.current.setValue("destinationCurrency", "EUR", { shouldDirty: true }));
      expect(result.current.getValues()).toMatchObject({
        sourceAmount: 780,
        destinationAmount: null,
        transferRate: null,
        fxRate: 0.13,
      });
      act(() => result.current.setValue("destinationCurrency", "HKD", { shouldDirty: true }));
      expect(result.current.getValues("destinationAmount")).toBe(780);
    });

    it("preserves loaded currencies through late options, rerenders, account edits and reset", () => {
      const values = {
        ...defaults,
        sourceCurrency: "HKD",
        destinationCurrency: "USD",
        destinationAmount: 100,
      };
      const { result, rerender } = renderHook(useTestForm, {
        initialProps: { options: [] as typeof accounts, editing: true, values },
      });
      rerender({ options: accounts, editing: true, values });
      act(() => result.current.setValue(sourceAccountField, "c"));
      expect(result.current.getValues()).toMatchObject({
        sourceCurrency: "HKD",
        destinationCurrency: "USD",
        destinationAmount: 100,
        transferRate: getTransferRate(780, 100),
      });
      act(() => result.current.reset({ ...values, sourceCurrency: "EUR", destinationAmount: 123 }));
      expect(result.current.getValues()).toMatchObject({
        sourceCurrency: "EUR",
        destinationAmount: 123,
        transferRate: getTransferRate(780, 123),
      });
    });
  },
);
