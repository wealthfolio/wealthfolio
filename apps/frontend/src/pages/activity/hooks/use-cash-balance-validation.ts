import { useEffect, useState } from "react";
import { useFormContext } from "react-hook-form";
import { useLatestValuations } from "@/hooks/use-latest-valuations";
import { ActivityType } from "@/lib/constants";
import { NewActivityFormValues } from "../components/forms/schemas";

export interface CashBalanceValidationResult {
  isValid: boolean;
  currentBalance: number;
  requiredAmount: number;
  shortfall: number;
  isLoading: boolean;
  warning?: string;
  accountCurrency?: string;
  hasAccount: boolean;
  hasValues: boolean;
}

export function useCashBalanceValidation(): CashBalanceValidationResult {
  const { watch } = useFormContext<NewActivityFormValues>();
  const [validationResult, setValidationResult] = useState<CashBalanceValidationResult>({
    isValid: true,
    currentBalance: 0,
    requiredAmount: 0,
    shortfall: 0,
    isLoading: false,
    hasAccount: false,
    hasValues: false,
  });

  // Watch form values that affect the calculation
  const activityType = watch("activityType");
  const accountId = watch("accountId");
  const quantity = watch("quantity");
  const unitPrice = watch("unitPrice");
  const fee = watch("fee") || 0;
  const tax = watch("tax") || 0;

  // Get account cash balance
  const { latestValuations, isLoading } = useLatestValuations(accountId ? [accountId] : []);

  useEffect(() => {
    const hasAccount = Boolean(accountId);
    const hasValues = Boolean(quantity && unitPrice && quantity > 0 && unitPrice > 0);

    // Only validate for BUY activities
    if (activityType !== ActivityType.BUY) {
      setValidationResult({
        isValid: true,
        currentBalance: 0,
        requiredAmount: 0,
        shortfall: 0,
        isLoading: false,
        hasAccount,
        hasValues: false,
      });
      return;
    }

    if (!hasAccount) {
      setValidationResult({
        isValid: true,
        currentBalance: 0,
        requiredAmount: 0,
        shortfall: 0,
        isLoading: false,
        hasAccount: false,
        hasValues: false,
      });
      return;
    }

    if (!hasValues) {
      setValidationResult({
        isValid: true,
        currentBalance: 0,
        requiredAmount: 0,
        shortfall: 0,
        isLoading: false,
        hasAccount,
        hasValues: false,
      });
      return;
    }

    if (isLoading) {
      setValidationResult((prev) => ({
        ...prev,
        isLoading: true,
        hasAccount,
        hasValues,
      }));
      return;
    }

    const accountValuation = latestValuations?.find((val) => val.accountId === accountId);
    if (!accountValuation) {
      setValidationResult({
        isValid: true,
        currentBalance: 0,
        requiredAmount: 0,
        shortfall: 0,
        isLoading: false,
        hasAccount,
        hasValues,
      });
      return;
    }

    const currentBalance = accountValuation.cashBalance;
    const numQuantity = Number(quantity) || 0;
    const numUnitPrice = Number(unitPrice) || 0;
    const numFee = Number(fee) || 0;
    const numTax = Number(tax) || 0;
    const requiredAmount = numQuantity * numUnitPrice + numFee + numTax;
    const shortfall = Math.max(0, requiredAmount - currentBalance);
    const isValid = shortfall === 0;

    let warning: string | undefined;
    if (!isValid) {
      const formatter = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: accountValuation.accountCurrency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

      warning = `Insufficient cash balance. Required: ${formatter.format(requiredAmount)}, Available: ${formatter.format(currentBalance)}, Shortfall: ${formatter.format(shortfall)}`;
    }

    setValidationResult({
      isValid,
      currentBalance,
      requiredAmount,
      shortfall,
      isLoading: false,
      warning,
      accountCurrency: accountValuation.accountCurrency,
      hasAccount,
      hasValues,
    });
  }, [activityType, accountId, quantity, unitPrice, fee, tax, latestValuations, isLoading]);

  return validationResult;
}
