import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { useTaxonomy } from "@/hooks/use-taxonomies";
import enCommon from "@/i18n/locales/en/common.json";
import enCommonTaxonomies from "@/i18n/locales/en/taxonomies.json";
import zhCommon from "@/i18n/locales/zh/common.json";
import zhCommonTaxonomies from "@/i18n/locales/zh/taxonomies.json";
import enSpending from "@/i18n/locales/en/spending.json";
import zhSpending from "@/i18n/locales/zh/spending.json";
import { act, render, screen, waitFor } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createActivity, updateActivity } from "@/adapters";
import type { Activity } from "@/lib/types";
import { CashActivityForm } from "./cash-activity-form";

// jsdom has neither; the phone layout's lists use both.
if (typeof ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
}
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => undefined;
}

async function chooseAccount(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(screen.getByRole("combobox", { name: "Account" }));
  await user.click(await screen.findByRole("option", { name }));
}

vi.mock("@/adapters", () => ({
  createActivity: vi.fn(),
  updateActivity: vi.fn((payload: unknown) => Promise.resolve(payload)),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
// Each factory builds its value ONCE and hands back the same reference. The
// real hooks are React Query-backed and stable; a mock that returns a fresh
// array every render makes `spendingAccounts` a new identity each pass, which
// re-fires the reset effect that depends on it and never settles.
vi.mock("@/hooks/use-accounts", () => {
  const accounts = [
    {
      id: "card",
      name: "WS Visa Infinite",
      currency: "CAD",
      accountType: "CREDIT_CARD",
      isActive: true,
    },
    { id: "euro", name: "Spending Euro", currency: "EUR", accountType: "CASH", isActive: true },
    { id: "chequing", name: "WS Chequing", currency: "CAD", accountType: "CASH", isActive: true },
  ];
  return { useAccounts: () => ({ accounts }) };
});
vi.mock("@/hooks/use-settings", () => {
  const data = { baseCurrency: "CAD" };
  return { useSettings: () => ({ data }) };
});
const platform = vi.hoisted(() => ({ isMobile: false, isIOS: false }));
vi.mock("@/hooks/use-platform", () => ({
  useIsMobileViewport: () => platform.isMobile,
  usePlatform: () => ({ isIOS: platform.isIOS }),
}));
vi.mock("@/hooks/use-taxonomies", () => {
  const result = { data: null };
  return { useTaxonomy: vi.fn(() => result) };
});
vi.mock("../hooks/use-spending-settings", () => {
  const settings = { accountIds: ["card", "euro", "chequing"] };
  return { useSpendingSettings: () => ({ settings }) };
});
vi.mock("../hooks/use-spending-events", () => {
  const empty = { data: [] };
  return { useSpendingEvents: () => empty, useEventTypes: () => empty };
});
vi.mock("./event-dialog-provider", () => ({
  useEventDialog: () => ({ openEventDialog: vi.fn(), openEventTypeDialog: vi.fn() }),
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

/** A charge made abroad: booked in USD on a card denominated in CAD. */
const foreignCharge = {
  id: "act-1",
  accountId: "card",
  activityType: "WITHDRAWAL",
  activityDate: "2026-07-13T12:00:00.000Z",
  amount: "9.59",
  currency: "USD",
  fxRate: "1.37",
  notes: "Sq *Morning Owl",
} as unknown as Activity;

describe("CashActivityForm currency", () => {
  it("directs split category changes to the explicit split editor", () => {
    render(
      <CashActivityForm
        open
        onOpenChange={vi.fn()}
        activity={{ ...foreignCharge, splits: [{ id: "split-1" } as never] }}
      />,
      { wrapper },
    );
    expect(
      screen.getByText(
        "Split allocations are protected. Edit or explicitly replace them in the split editor.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pick a category" })).not.toBeInTheDocument();
  });

  beforeEach(() => vi.clearAllMocks());

  it("keeps the neutral-transfer label for an existing transfer", () => {
    render(
      <CashActivityForm
        open
        onOpenChange={vi.fn()}
        activity={
          {
            ...foreignCharge,
            accountId: "chequing",
            activityType: "TRANSFER_IN",
            sourceGroupId: "linked-transfer",
            cashFlowBucket: "neutral",
          } as Activity
        }
      />,
      { wrapper },
    );
    expect(screen.getByText("Neutral transfer")).toBeInTheDocument();
  });

  it.each([null, "ADJUSTMENT", "BONUS"])(
    "labels an existing CREDIT/%s accurately and preserves its meaning on save",
    async (subtype) => {
      const user = userEvent.setup();
      render(
        <CashActivityForm
          open
          onOpenChange={vi.fn()}
          activity={
            {
              ...foreignCharge,
              accountId: "chequing",
              activityType: "CREDIT",
              subtype,
              cashFlowBucket: subtype === "BONUS" ? "income" : "neutral",
              metadata: { flow: { is_external: false } },
            } as Activity
          }
        />,
        { wrapper },
      );

      expect(screen.getByRole("combobox", { name: "Type" })).toHaveTextContent("Credit");
      expect(screen.queryByText("Reimbursement / refund")).not.toBeInTheDocument();
      expect(screen.queryByText("Neutral transfer")).not.toBeInTheDocument();
      if (subtype !== "BONUS") expect(screen.getByText("Neutral")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /update/i }));
      await waitFor(() => expect(updateActivity).toHaveBeenCalled());
      expect(vi.mocked(updateActivity).mock.calls[0][0]).toMatchObject({
        activityType: "CREDIT",
        subtype,
        metadata: { flow: { is_external: false } },
      });
    },
  );

  /**
   * The currency used to be recomputed from the account on every save. Saving
   * an untouched foreign charge therefore rewrote it to the account's own
   * currency — the amount stayed 9.59 while its meaning changed from USD to
   * CAD, with nothing on screen to show it had happened.
   */
  it("keeps an existing activity's own currency when nothing was edited", async () => {
    const user = userEvent.setup();
    render(<CashActivityForm open onOpenChange={vi.fn()} activity={foreignCharge} />, { wrapper });

    await user.click(await screen.findByRole("button", { name: /update/i }));

    await waitFor(() => expect(updateActivity).toHaveBeenCalled());
    expect(vi.mocked(updateActivity).mock.calls[0][0]).toMatchObject({
      id: "act-1",
      currency: "USD",
    });
  });

  it("carries the activity's FX rate through an untouched save", async () => {
    const user = userEvent.setup();
    render(<CashActivityForm open onOpenChange={vi.fn()} activity={foreignCharge} />, { wrapper });

    await user.click(await screen.findByRole("button", { name: /update/i }));

    await waitFor(() => expect(updateActivity).toHaveBeenCalled());
    expect(vi.mocked(updateActivity).mock.calls[0][0]).toMatchObject({ fxRate: 1.37 });
  });

  it("clears the FX rate when the activity currency changes", async () => {
    const user = userEvent.setup();
    render(
      <CashActivityForm
        open
        onOpenChange={vi.fn()}
        activity={{ ...foreignCharge, accountId: "euro" } as unknown as Activity}
      />,
      { wrapper },
    );

    await user.click(screen.getByTestId("advanced-options-button"));
    await user.click(screen.getByRole("button", { name: "CAD" }));
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() => expect(updateActivity).toHaveBeenCalled());
    expect(vi.mocked(updateActivity).mock.calls[0][0]).toMatchObject({
      accountId: "euro",
      currency: "CAD",
      fxRate: null,
    });
  });

  /**
   * An FX rate converts the activity's currency into the ACCOUNT's. Moving the
   * activity to an account with a different denomination leaves the rate
   * describing a pair that no longer exists — and the field is collapsed by
   * default, so a USD->CAD rate would be silently reread as USD->EUR.
   */
  it("clears the FX rate when the activity moves to a differently-denominated account", async () => {
    const user = userEvent.setup();
    render(<CashActivityForm open onOpenChange={vi.fn()} activity={foreignCharge} />, { wrapper });

    await chooseAccount(user, /Spending Euro/);
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() => expect(updateActivity).toHaveBeenCalled());
    expect(vi.mocked(updateActivity).mock.calls[0][0]).toMatchObject({
      accountId: "euro",
      currency: "USD",
      fxRate: null,
    });
  });

  /** The opposite case: same denomination, so the rate still describes the pair. */
  it("keeps the FX rate when the new account has the same currency", async () => {
    const user = userEvent.setup();
    render(<CashActivityForm open onOpenChange={vi.fn()} activity={foreignCharge} />, { wrapper });

    await chooseAccount(user, /WS Chequing/);
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() => expect(updateActivity).toHaveBeenCalled());
    expect(vi.mocked(updateActivity).mock.calls[0][0]).toMatchObject({
      accountId: "chequing",
      currency: "USD",
      fxRate: 1.37,
    });
  });

  /**
   * The rate only describes a conversion when one happened. Keeping a stale one
   * on a same-currency row would have the server multiply by it.
   */
  it("drops the FX rate when the activity is in the account's own currency", async () => {
    const user = userEvent.setup();
    render(
      <CashActivityForm
        open
        onOpenChange={vi.fn()}
        activity={{ ...foreignCharge, currency: "CAD" } as unknown as Activity}
      />,
      { wrapper },
    );

    await user.click(await screen.findByRole("button", { name: /update/i }));

    await waitFor(() => expect(updateActivity).toHaveBeenCalled());
    expect(vi.mocked(updateActivity).mock.calls[0][0]).toMatchObject({
      currency: "CAD",
      fxRate: null,
    });
  });
});

describe("CashActivityForm category display", () => {
  it.each([
    { parentName: "Food & Dining", name: "Groceries" },
    { parentName: "My food", name: "My groceries" },
  ])(
    "localizes only unchanged seed names ($name) and retains raw save inputs",
    async ({ parentName, name }) => {
      vi.clearAllMocks();
      const categories = [
        {
          id: "cat_food",
          taxonomyId: "spending_categories",
          name: parentName,
          parentId: null,
          color: "#123456",
        },
        {
          id: "cat_groceries",
          taxonomyId: "spending_categories",
          name,
          parentId: "cat_food",
          color: "#123456",
        },
      ];
      const original = structuredClone(categories);
      const data = { data: { categories } } as ReturnType<typeof useTaxonomy>;
      const empty = { data: null } as unknown as ReturnType<typeof useTaxonomy>;
      vi.mocked(useTaxonomy).mockImplementation((id) =>
        id === "spending_categories" ? data : empty,
      );
      const i18n = createInstance();
      await i18n.use(initReactI18next).init({
        lng: "zh",
        fallbackLng: "en",
        interpolation: { escapeValue: false },
        resources: {
          en: { common: enCommon, taxonomies: enCommonTaxonomies, spending: enSpending },
          zh: { common: zhCommon, taxonomies: zhCommonTaxonomies, spending: zhSpending },
        },
      });
      const activity = {
        ...foreignCharge,
        categoryTaxonomyId: "spending_categories",
        categoryId: "cat_groceries",
        categoryAssignmentId: "assignment-1",
      };
      const user = userEvent.setup();
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={client}>
          <I18nextProvider i18n={i18n}>
            <CashActivityForm open onOpenChange={vi.fn()} activity={activity} />
          </I18nextProvider>
        </QueryClientProvider>,
      );
      const displayParent =
        parentName === "Food & Dining"
          ? zhCommonTaxonomies.categoryNames.spending_categories.cat_food
          : parentName;
      const displayName =
        name === "Groceries"
          ? zhCommonTaxonomies.categoryNames.spending_categories.cat_groceries
          : name;
      expect(screen.getByText(`${displayParent} / ${displayName}`)).toBeInTheDocument();
      expect(
        screen.getByRole("button", {
          name: i18n.t("spending:transactions.changeCategory", { name: displayName }),
        }),
      ).toBeInTheDocument();
      await act(() => i18n.changeLanguage("en"));
      expect(screen.getByText(`${parentName} / ${name}`)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /update/i }));
      await waitFor(() => expect(updateActivity).toHaveBeenCalled());
      expect(vi.mocked(updateActivity).mock.lastCall?.[0]).toMatchObject({
        id: activity.id,
        amount: 9.59,
        currency: "USD",
        fxRate: 1.37,
      });
      expect(categories).toEqual(original);
      vi.mocked(useTaxonomy).mockReturnValue(empty);
    },
  );
});

vi.mock("@/features/spending/components/activity-split-review-provider", () => ({
  useActivitySplitReview: () => async (updates: unknown[]) => updates,
  isActivityEditCancelled: () => false,
}));

describe("CashActivityForm direct entry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createActivity).mockResolvedValue({ id: "quick-created" } as Activity);
  });

  it("requires an explicit expense account and places the amount first", async () => {
    const user = userEvent.setup();
    render(<CashActivityForm open onOpenChange={vi.fn()} intent="expense" />, { wrapper });
    const account = screen.getByRole("combobox", { name: "Account" });
    expect(account).toHaveTextContent("Select an account");
    expect(screen.queryByRole("combobox", { name: "Type" })).not.toBeInTheDocument();
    const amount = screen.getByRole("textbox", { name: "Amount" });
    expect(amount.compareDocumentPosition(account) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("Please select an account.")).toBeVisible();
    expect(createActivity).not.toHaveBeenCalled();
    await chooseAccount(user, /WS Visa Infinite/);
    await user.clear(amount);
    await user.type(amount, "12.50");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(createActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "card",
          activityType: "WITHDRAWAL",
          amount: 12.5,
          currency: "CAD",
        }),
      ),
    );
  });

  it("asks before discarding a changed type on an existing transaction", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<CashActivityForm open onOpenChange={onOpenChange} activity={foreignCharge} />, {
      wrapper,
    });
    await user.click(screen.getByRole("combobox", { name: "Type" }));
    const options = await screen.findAllByRole("option");
    const other = options.find((option) => option.getAttribute("aria-selected") !== "true");
    await user.click(other!);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("reopens on the form, not on the screen it was closed on", async () => {
    const user = userEvent.setup();
    platform.isMobile = true;
    const innerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    try {
      const { rerender } = render(
        <CashActivityForm open onOpenChange={vi.fn()} activity={foreignCharge} />,
        { wrapper },
      );
      // Matched loosely: the label may still be its key while translations load.
      await user.click(await screen.findByRole("button", { name: /advanced/i }));
      expect(await screen.findByRole("dialog", { name: /advanced/i })).toBeInTheDocument();

      rerender(<CashActivityForm open={false} onOpenChange={vi.fn()} activity={foreignCharge} />);
      rerender(<CashActivityForm open onOpenChange={vi.fn()} activity={foreignCharge} />);
      await screen.findByRole("dialog", { name: /edit/i });
      expect(screen.queryByRole("dialog", { name: /advanced/i })).not.toBeInTheDocument();
    } finally {
      platform.isMobile = false;
      Object.defineProperty(window, "innerWidth", { value: innerWidth, configurable: true });
    }
  });

  describe("amount caret on a phone", () => {
    const innerWidth = window.innerWidth;
    beforeEach(() => {
      platform.isMobile = true;
      Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    });
    afterEach(() => {
      platform.isMobile = false;
      platform.isIOS = false;
      Object.defineProperty(window, "innerWidth", { value: innerWidth, configurable: true });
    });

    it("opens a new entry on the amount, using the real caret", async () => {
      const { container } = render(
        <CashActivityForm open onOpenChange={vi.fn()} intent="expense" />,
        { wrapper },
      );
      const amount = await screen.findByRole("textbox", { name: "Amount" });
      await waitFor(() => expect(amount).toHaveFocus());
      expect(amount).toHaveAttribute("placeholder", "");
      expect(container.ownerDocument.querySelector("[data-amount-caret]")).toBeNull();
    });

    it("draws a caret on iOS until the amount is tapped", async () => {
      platform.isIOS = true;
      const user = userEvent.setup();
      render(<CashActivityForm open onOpenChange={vi.fn()} intent="expense" />, { wrapper });
      const amount = await screen.findByRole("textbox", { name: "Amount" });
      await waitFor(() => expect(document.querySelector("[data-amount-caret]")).not.toBeNull());
      await user.click(amount);
      expect(document.querySelector("[data-amount-caret]")).toBeNull();
    });

    it("drops the iOS caret once another field takes focus", async () => {
      platform.isIOS = true;
      const user = userEvent.setup();
      render(<CashActivityForm open onOpenChange={vi.fn()} intent="expense" />, { wrapper });
      const amount = await screen.findByRole("textbox", { name: "Amount" });
      await user.click(amount);
      await user.click(screen.getByRole("textbox", { name: /notes/i }));
      expect(amount).not.toHaveFocus();
      expect(document.querySelector("[data-amount-caret]")).toBeNull();
    });

    it("focuses the amount on moving on from the type step", async () => {
      const user = userEvent.setup();
      render(<CashActivityForm open onOpenChange={vi.fn()} />, { wrapper });
      expect(screen.queryByRole("textbox", { name: "Amount" })).not.toBeInTheDocument();
      await chooseAccount(user, /WS Visa Infinite/);
      await user.click(screen.getAllByRole("radio")[0]);
      await user.click(screen.getByRole("button", { name: "Next" }));
      const amount = await screen.findByRole("textbox", { name: "Amount" });
      await waitFor(() => expect(amount).toHaveFocus());
    });
  });

  it("still asks before discarding after a save fails", async () => {
    const user = userEvent.setup();
    vi.mocked(createActivity).mockRejectedValue(new Error("offline"));
    const onOpenChange = vi.fn();
    render(<CashActivityForm open onOpenChange={onOpenChange} intent="expense" />, { wrapper });
    await chooseAccount(user, /WS Visa Infinite/);
    const amount = screen.getByRole("textbox", { name: "Amount" });
    await user.clear(amount);
    await user.type(amount, "12.50");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(createActivity).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("records income only in an eligible bank account", async () => {
    const user = userEvent.setup();
    render(<CashActivityForm open onOpenChange={vi.fn()} intent="income" />, { wrapper });
    await user.click(screen.getByRole("combobox", { name: "Account" }));
    expect(screen.queryByRole("option", { name: /WS Visa/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: /WS Chequing/ }));
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(createActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "chequing",
          activityType: "DEPOSIT",
          currency: "CAD",
        }),
      ),
    );
  });

  it("keeps an existing transaction's type when an intent is also supplied", () => {
    render(
      <CashActivityForm open onOpenChange={vi.fn()} intent="income" activity={foreignCharge} />,
      { wrapper },
    );
    expect(screen.getByRole("combobox", { name: "Type" })).toHaveTextContent("Charge");
    expect(screen.getByRole("combobox", { name: "Account" })).toHaveTextContent("WS Visa Infinite");
  });
});
