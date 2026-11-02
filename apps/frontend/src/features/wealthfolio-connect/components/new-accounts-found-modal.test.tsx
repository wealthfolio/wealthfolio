import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Activity } from "react";
import { expect, it, vi } from "vitest";
import type { Account } from "@/lib/types";
import { NewAccountsFoundModal } from "./new-accounts-found-modal";

const mocks = vi.hoisted(() => ({ updateAccount: vi.fn() }));
vi.mock("@/adapters", () => ({ updateAccount: mocks.updateAccount }));
vi.mock("../services/broker-service", () => ({ syncBrokerData: vi.fn() }));

const account = {
  id: "account-1",
  name: "Broker cash",
  accountType: "SECURITIES",
  currency: "USD",
  isDefault: false,
  isActive: true,
  isArchived: false,
} as Account;

it("saves the tracking mode chosen before its phone screen was hidden", async () => {
  // A phone screen kept under another one is a hidden <Activity>, whose
  // effects run again when it is shown.
  mocks.updateAccount.mockResolvedValue(undefined);
  const client = new QueryClient();
  const accounts = [account];
  const view = (hidden: boolean) => (
    <QueryClientProvider client={client}>
      <Activity mode={hidden ? "hidden" : "visible"}>
        <NewAccountsFoundModal open onOpenChange={vi.fn()} accounts={accounts} />
      </Activity>
    </QueryClientProvider>
  );
  const { rerender } = render(view(false));
  fireEvent.click(await screen.findByRole("radio", { name: /Holdings/ }));
  fireEvent.change(screen.getByLabelText("Account name"), { target: { value: "IBKR" } });

  rerender(view(true));
  rerender(view(false));
  fireEvent.click(screen.getByRole("button", { name: "Save and sync" }));

  await waitFor(() => expect(mocks.updateAccount).toHaveBeenCalledOnce());
  expect(mocks.updateAccount).toHaveBeenCalledWith(
    expect.objectContaining({ id: "account-1", name: "IBKR", trackingMode: "HOLDINGS" }),
  );
});
