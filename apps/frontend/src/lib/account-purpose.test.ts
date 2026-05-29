import {
  AccountPurpose,
  AccountType,
  accountCapabilities,
  accountPurposeAccountTypes,
  accountSupportsPurpose,
  isReportAccountType,
} from "./constants";

describe("account purpose policy", () => {
  it("keeps credit cards in spending and net worth but out of investment reports", () => {
    expect(accountSupportsPurpose(AccountType.CREDIT_CARD, AccountPurpose.SPENDING)).toBe(true);
    expect(accountSupportsPurpose(AccountType.CREDIT_CARD, AccountPurpose.NET_WORTH)).toBe(true);
    expect(accountSupportsPurpose(AccountType.CREDIT_CARD, AccountPurpose.PERFORMANCE)).toBe(false);
    expect(accountSupportsPurpose(AccountType.CREDIT_CARD, AccountPurpose.HOLDINGS)).toBe(false);
    expect(accountSupportsPurpose(AccountType.CREDIT_CARD, AccountPurpose.INCOME)).toBe(false);
    expect(accountSupportsPurpose(AccountType.CREDIT_CARD, AccountPurpose.GOAL_FUNDING)).toBe(
      false,
    );
    expect(
      accountSupportsPurpose(AccountType.CREDIT_CARD, AccountPurpose.CONTRIBUTION_LIMITS),
    ).toBe(false);
    expect(isReportAccountType(AccountType.CREDIT_CARD)).toBe(false);

    expect(accountCapabilities(AccountType.CREDIT_CARD)).toMatchObject({
      spending: true,
      performance: false,
      holdings: false,
      income: false,
      goalFunding: false,
      contributionLimits: false,
      netWorth: true,
      liability: true,
    });
  });

  it("keeps report account types eligible for investment surfaces", () => {
    for (const accountType of [
      AccountType.SECURITIES,
      AccountType.CASH,
      AccountType.CRYPTOCURRENCY,
    ]) {
      expect(accountSupportsPurpose(accountType, AccountPurpose.PERFORMANCE)).toBe(true);
      expect(accountSupportsPurpose(accountType, AccountPurpose.HOLDINGS)).toBe(true);
      expect(accountSupportsPurpose(accountType, AccountPurpose.INCOME)).toBe(true);
      expect(accountSupportsPurpose(accountType, AccountPurpose.GOAL_FUNDING)).toBe(true);
      expect(accountSupportsPurpose(accountType, AccountPurpose.CONTRIBUTION_LIMITS)).toBe(true);
      expect(accountSupportsPurpose(accountType, AccountPurpose.NET_WORTH)).toBe(true);
      expect(isReportAccountType(accountType)).toBe(true);
    }
  });

  it("exposes account type membership for selectors without duplicating arrays", () => {
    expect(accountPurposeAccountTypes(AccountPurpose.SPENDING)).toEqual([
      AccountType.CASH,
      AccountType.CREDIT_CARD,
    ]);
    expect(accountPurposeAccountTypes(AccountPurpose.PERFORMANCE)).not.toContain(
      AccountType.CREDIT_CARD,
    );
  });
});
