import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createActivity, updateActivity } from "@/adapters";
import type { Activity, TaxonomyCategory } from "@/lib/types";
import { render, screen, waitFor } from "@/test/render";

import { setActivityPayee } from "../lib/payee";
import { CashActivityForm } from "./cash-activity-form";

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

const payee = (id: string, name: string) => ({ id, name }) as TaxonomyCategory;
// What the payee hook returns; a test changes `payeeName` to stand for the
// saved assignment arriving.
const onFile = vi.hoisted(() => ({ payees: [] as unknown[], payeeName: "" }));
vi.mock("../hooks/use-activity-payee", () => ({
  useActivityPayee: () => ({ payees: onFile.payees, payeeName: onFile.payeeName }),
}));
vi.mock("../lib/payee", () => ({ PAYEES_TAXONOMY_ID: "payees", setActivityPayee: vi.fn() }));
vi.mock("@/adapters", () => ({
  createActivity: vi.fn(),
  updateActivity: vi.fn((payload: unknown) => Promise.resolve(payload)),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/hooks/use-accounts", () => {
  const accounts = [
    { id: "chequing", name: "WS Chequing", currency: "CAD", accountType: "CASH", isActive: true },
  ];
  return { useAccounts: () => ({ accounts }) };
});
vi.mock("@/hooks/use-settings", () => {
  const data = { baseCurrency: "CAD" };
  return { useSettings: () => ({ data }) };
});
vi.mock("@/hooks/use-platform", () => ({
  useIsMobileViewport: () => false,
  usePlatform: () => ({ isIOS: false }),
}));
vi.mock("@/hooks/use-taxonomies", () => {
  const result = { data: null };
  return { useTaxonomy: () => result };
});
vi.mock("../hooks/use-spending-settings", () => {
  const settings = { accountIds: ["chequing"] };
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

const charge = {
  id: "act-1",
  accountId: "chequing",
  activityType: "WITHDRAWAL",
  activityDate: "2026-07-13T12:00:00.000Z",
  amount: "9.59",
  currency: "CAD",
} as unknown as Activity;

async function pickPayee(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByTestId("payee-field"));
  await user.click(await screen.findByRole("option", { name }));
}

describe("CashActivityForm payee", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onFile.payees = [payee("p1", "Corner Bakery"), payee("p2", "City Water")];
    onFile.payeeName = "";
    vi.mocked(createActivity).mockResolvedValue({ id: "created" } as Activity);
  });

  it("shows the payee on file once it loads", () => {
    const view = render(<CashActivityForm open onOpenChange={vi.fn()} activity={charge} />, {
      wrapper,
    });
    expect(screen.getByTestId("payee-field")).toHaveTextContent("Who was this with?");

    onFile.payeeName = "City Water";
    view.rerender(<CashActivityForm open onOpenChange={vi.fn()} activity={charge} />);

    expect(screen.getByTestId("payee-field")).toHaveTextContent("City Water");
  });

  it("keeps a payee picked before the one on file loaded", async () => {
    const user = userEvent.setup();
    const view = render(<CashActivityForm open onOpenChange={vi.fn()} activity={charge} />, {
      wrapper,
    });
    await pickPayee(user, "Corner Bakery");

    onFile.payeeName = "City Water";
    view.rerender(<CashActivityForm open onOpenChange={vi.fn()} activity={charge} />);

    expect(screen.getByTestId("payee-field")).toHaveTextContent("Corner Bakery");
  });

  it("starts again from the payee on file when the form is reopened", async () => {
    const user = userEvent.setup();
    onFile.payeeName = "City Water";
    const view = render(<CashActivityForm open onOpenChange={vi.fn()} activity={charge} />, {
      wrapper,
    });
    await pickPayee(user, "Corner Bakery");

    view.rerender(<CashActivityForm open={false} onOpenChange={vi.fn()} activity={charge} />);
    view.rerender(<CashActivityForm open onOpenChange={vi.fn()} activity={charge} />);

    expect(screen.getByTestId("payee-field")).toHaveTextContent("City Water");
  });

  it("creates one transaction and closes when every write succeeds", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<CashActivityForm open onOpenChange={onOpenChange} intent="expense" />, { wrapper });
    await pickPayee(user, "Corner Bakery");

    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(createActivity).toHaveBeenCalledTimes(1);
    expect(updateActivity).not.toHaveBeenCalled();
    expect(setActivityPayee).toHaveBeenCalledWith("created", "Corner Bakery", onFile.payees);
  });

  it("does not create the transaction again when saving after its payee failed", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    vi.mocked(setActivityPayee).mockRejectedValueOnce(new Error("offline"));
    render(<CashActivityForm open onOpenChange={onOpenChange} intent="expense" />, { wrapper });
    await pickPayee(user, "Corner Bakery");

    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(setActivityPayee).toHaveBeenCalledTimes(1));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(createActivity).toHaveBeenCalledTimes(1);
    // The second save carries on with the transaction the first one created.
    expect(updateActivity).toHaveBeenCalledWith(
      expect.objectContaining({ id: "created", accountId: "chequing" }),
    );
    expect(setActivityPayee).toHaveBeenLastCalledWith("created", "Corner Bakery", onFile.payees);
  });
});
