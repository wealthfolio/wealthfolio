import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createActivity, updateActivity } from "@/adapters";
import type { Activity, TaxonomyCategory } from "@/lib/types";
import { render, screen, waitFor } from "@/test/render";

import { assignActivityCategory, setActivityEvent } from "../adapters/cash-activities";
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
vi.mock("../adapters/cash-activities", () => ({
  assignActivityCategory: vi.fn(),
  unassignActivityCategory: vi.fn(),
  setActivityEvent: vi.fn(),
}));
// An edit is reviewed for its splits first; these activities have none.
vi.mock("./activity-split-review-provider", () => ({
  useActivitySplitReview: () => (edits: unknown[]) => Promise.resolve(edits),
  isActivityEditCancelled: () => false,
}));
// The category and event pickers, reduced to the picks these tests make.
vi.mock("./quick-categorize-popover", () => ({
  QuickCategorizePopover: ({ onSelect }: { onSelect: (tax: string, id: string) => void }) => (
    <>
      {["a", "b"].map((id) => (
        <button key={id} type="button" onClick={() => onSelect("spending_categories", id)}>
          Category {id}
        </button>
      ))}
    </>
  ),
}));
vi.mock("./quick-event-popover", () => ({
  QuickEventPopover: (props: { onSelect: (id: string) => void; onClear: () => void }) => (
    <>
      <button type="button" onClick={() => props.onSelect("trip")}>
        Event trip
      </button>
      <button type="button" onClick={props.onClear}>
        No event
      </button>
    </>
  ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/adapters", () => ({
  createActivity: vi.fn(),
  findTransferMatchCandidates: vi.fn(() => Promise.resolve([])),
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

  it("creates a new transaction after a save failed in a form closed since", async () => {
    const user = userEvent.setup();
    let finish: (activity: Activity) => void = () => undefined;
    vi.mocked(createActivity).mockReturnValueOnce(
      new Promise<Activity>((resolve) => (finish = resolve)),
    );
    vi.mocked(setActivityPayee).mockRejectedValueOnce(new Error("offline"));
    const form = (open: boolean) => (
      <CashActivityForm open={open} onOpenChange={vi.fn()} intent="expense" />
    );
    const view = render(form(true), { wrapper });
    await pickPayee(user, "Corner Bakery");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(createActivity).toHaveBeenCalledTimes(1));

    // Closed and opened again while the first save is on its way; it then
    // creates its transaction and fails on the payee.
    view.rerender(form(false));
    view.rerender(form(true));
    finish({ id: "first" } as Activity);
    await waitFor(() => expect(setActivityPayee).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Create" }));

    // The new form's save is a new transaction, not an update of the old one.
    await waitFor(() => expect(createActivity).toHaveBeenCalledTimes(2));
    expect(updateActivity).not.toHaveBeenCalled();
  });

  it("leaves a form opened since open when an earlier save succeeds", async () => {
    const user = userEvent.setup();
    let finish: (activity: Activity) => void = () => undefined;
    vi.mocked(createActivity).mockReturnValueOnce(
      new Promise<Activity>((resolve) => (finish = resolve)),
    );
    const onOpenChange = vi.fn();
    const form = (open: boolean) => (
      <CashActivityForm open={open} onOpenChange={onOpenChange} intent="expense" />
    );
    const view = render(form(true), { wrapper });
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(createActivity).toHaveBeenCalledTimes(1));

    view.rerender(form(false));
    view.rerender(form(true));
    finish({ id: "first" } as Activity);

    await waitFor(() => expect(screen.getByRole("button", { name: "Create" })).toBeEnabled());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("saves the final category and event of an edit retried after a later write failed", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    vi.mocked(setActivityPayee).mockRejectedValueOnce(new Error("offline"));
    const filed = { ...charge, categoryTaxonomyId: "spending_categories", categoryId: "a" };
    render(<CashActivityForm open onOpenChange={onOpenChange} activity={filed} />, { wrapper });
    await user.click(screen.getByRole("button", { name: "Category b" }));
    await user.click(screen.getByRole("button", { name: "Event trip" }));
    await pickPayee(user, "Corner Bakery");

    // The category and the event are saved; the payee after them fails.
    await user.click(screen.getByRole("button", { name: /update/i }));
    await waitFor(() => expect(setActivityPayee).toHaveBeenCalledTimes(1));
    expect(assignActivityCategory).toHaveBeenLastCalledWith("act-1", "spending_categories", "b");
    expect(setActivityEvent).toHaveBeenLastCalledWith("act-1", "trip");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    // Back to what the form opened with, which is no longer what is on file.
    await user.click(screen.getByRole("button", { name: "Category a" }));
    await user.click(screen.getByRole("button", { name: "No event" }));
    await user.click(screen.getByRole("button", { name: /update/i }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(assignActivityCategory).toHaveBeenLastCalledWith("act-1", "spending_categories", "a");
    expect(setActivityEvent).toHaveBeenLastCalledWith("act-1", null);
  });

  it("does not close again once dismissed, when a save still running then succeeds", async () => {
    const user = userEvent.setup();
    let finish: (activity: Activity) => void = () => undefined;
    vi.mocked(createActivity).mockReturnValueOnce(
      new Promise<Activity>((resolve) => (finish = resolve)),
    );
    // The page's close also navigates: a second call would pull the user back.
    const onOpenChange = vi.fn();
    const view = render(<CashActivityForm open onOpenChange={onOpenChange} intent="expense" />, {
      wrapper,
    });
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(createActivity).toHaveBeenCalledTimes(1));

    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    view.unmount();
    finish({ id: "first" } as Activity);

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });

  it("reports an earlier edit as updated when it ends under a new entry", async () => {
    const user = userEvent.setup();
    let finish: (activity: Activity) => void = () => undefined;
    vi.mocked(updateActivity).mockReturnValueOnce(
      new Promise<Activity>((resolve) => (finish = resolve)),
    );
    const view = render(<CashActivityForm open onOpenChange={vi.fn()} activity={charge} />, {
      wrapper,
    });
    await user.click(screen.getByRole("button", { name: /update/i }));
    await waitFor(() => expect(updateActivity).toHaveBeenCalledTimes(1));

    view.rerender(<CashActivityForm open onOpenChange={vi.fn()} intent="expense" />);
    finish(charge);

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Activity updated."));
  });

  it("asks before closing an edit left different from what a failed save wrote", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const client = new QueryClient();
    const refreshed = vi.spyOn(client, "invalidateQueries");
    vi.mocked(setActivityPayee).mockRejectedValueOnce(new Error("offline"));
    const filed = { ...charge, categoryTaxonomyId: "spending_categories", categoryId: "a" };
    render(
      <QueryClientProvider client={client}>
        <CashActivityForm open onOpenChange={onOpenChange} activity={filed} />
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Category b" }));
    await pickPayee(user, "Corner Bakery");
    await user.click(screen.getByRole("button", { name: /update/i }));
    await waitFor(() => expect(setActivityPayee).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled());

    // Category b is on file now. Back to a, with the payee cleared, the form
    // shows what it opened with, which is not what closing would leave saved.
    await user.click(screen.getByRole("button", { name: "Category a" }));
    await user.click(screen.getByTestId("payee-field"));
    await user.click(await screen.findByText("No payee"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    // Not refreshed while the form is open: that would reset what is being retried.
    expect(refreshed).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Discard" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    // The lists still show category a: they are told once the form is gone.
    expect(refreshed).toHaveBeenCalled();
  });

  it("asks before leaving to link a transfer with a payee picked and not saved", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onLinkTransfer = vi.fn();
    render(
      <CashActivityForm
        open
        onOpenChange={onOpenChange}
        onLinkTransfer={onLinkTransfer}
        activity={{ ...charge, activityType: "TRANSFER_IN" } as Activity}
      />,
      { wrapper },
    );
    await pickPayee(user, "Corner Bakery");

    await user.click(screen.getByRole("button", { name: /An account I don't track/ }));

    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(onLinkTransfer).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Discard" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onLinkTransfer).toHaveBeenCalledTimes(1);
  });

  it("refreshes the lists when an edit closed since is saved in part", async () => {
    const user = userEvent.setup();
    const client = new QueryClient();
    const refreshed = vi.spyOn(client, "invalidateQueries");
    let finish: (activity: Activity) => void = () => undefined;
    vi.mocked(updateActivity).mockReturnValueOnce(
      new Promise<Activity>((resolve) => (finish = resolve)),
    );
    vi.mocked(setActivityPayee).mockRejectedValueOnce(new Error("offline"));
    const form = (open: boolean) => (
      <QueryClientProvider client={client}>
        <CashActivityForm open={open} onOpenChange={vi.fn()} activity={charge} />
      </QueryClientProvider>
    );
    const view = render(form(true));
    await pickPayee(user, "Corner Bakery");
    await user.click(screen.getByRole("button", { name: /update/i }));
    await waitFor(() => expect(updateActivity).toHaveBeenCalledTimes(1));

    // Closed while the update is on its way: it then lands, and the payee fails.
    view.rerender(form(false));
    finish(charge);

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    // No form is left to refresh them when it closes.
    expect(refreshed).toHaveBeenCalled();
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
