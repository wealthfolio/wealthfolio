import { render, screen, act } from "@/test/render";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import i18n from "i18next";
import zhCommon from "@/i18n/locales/zh/common.json";
import zhAi from "@/i18n/locales/zh/ai.json";
import { AccountsToolUIContentImpl } from "./accounts-tool-ui";

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD" } }),
}));
afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("AI account card labels", () => {
  it("translates built-in account types on language change, preserving names and currencies", async () => {
    i18n.addResourceBundle("zh", "common", zhCommon, true, true);
    i18n.addResourceBundle("zh", "ai", zhAi, true, true);
    type Props = ComponentProps<typeof AccountsToolUIContentImpl>;
    render(
      <AccountsToolUIContentImpl
        args={{}}
        argsText=""
        status={{ type: "complete" }}
        result={
          {
            accounts: [
              {
                id: "a",
                name: "My USD Account",
                accountType: "CREDIT_CARD",
                currency: "USD",
                isActive: true,
              },
            ],
            count: 1,
          } as Props["result"]
        }
        toolName="get_accounts"
        toolCallId="call"
        type="tool-call"
        addResult={vi.fn()}
        resume={vi.fn()}
      />,
    );
    expect(screen.getByText("Credit Card Accounts")).toBeInTheDocument();
    await act(async () => {
      await i18n.changeLanguage("zh");
    });
    expect(screen.getByText(zhCommon.component.account_type_credit_card)).toBeInTheDocument();
    expect(screen.getByText("My USD Account")).toBeInTheDocument();
    expect(screen.getByText("USD")).toBeInTheDocument();
  });
});
