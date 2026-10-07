import { fireEvent, render, screen, waitFor, within } from "@/test/render";
import { Dialog, DialogContent } from "@wealthfolio/ui/components/ui/dialog";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountForm } from "./account-form";

const mutations = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
}));
vi.mock("./use-account-mutations", () => ({
  useAccountMutations: () => ({
    createAccountMutation: { mutate: mutations.create },
    updateAccountMutation: { mutate: mutations.update, mutateAsync: mutations.update },
  }),
}));
vi.mock("@/hooks/use-taxonomies", () => ({ useTaxonomy: () => ({ data: undefined }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@wealthfolio/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@wealthfolio/ui")>()),
  ResponsiveSelect: ({
    value,
    onValueChange,
    options,
    "aria-label": label,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    options: { value: string; label: string }[];
    "aria-label"?: string;
  }) => (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

if (typeof ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  } as unknown as typeof ResizeObserver;
}

const METHOD_LABEL = "settings:accounts.form_cost_basis_method_label";

function renderForm(overrides: Partial<Parameters<typeof AccountForm>[0]["defaultValues"]> = {}) {
  const defaultValues = {
    id: "8f14e45f-ceea-4e7a-9b5e-3c1d2a6b7f90",
    name: "Brokerage",
    accountType: "SECURITIES" as const,
    currency: "USD",
    isActive: true,
    isArchived: false,
    trackingMode: "TRANSACTIONS" as const,
    ...overrides,
  };
  render(
    <Dialog open>
      <DialogContent>
        <AccountForm defaultValues={defaultValues} />
      </DialogContent>
    </Dialog>,
  );
}

// The cost basis section's toggle: its label, and its value while collapsed.
const toggle = () => screen.getByRole("button", { name: new RegExp(METHOD_LABEL) });

function expand() {
  fireEvent.click(toggle());
}

describe("AccountForm cost basis method", () => {
  beforeEach(() => mutations.update.mockClear());

  it("stores the chosen method and keeps the rest of the account's meta", async () => {
    renderForm({
      meta: JSON.stringify({
        accounting: { cost_basis_method: "FIFO", costBasisProfile: "GENERIC" },
        broker: { note: "kept" },
      }),
    });
    expand();
    const select = screen.getByLabelText(METHOD_LABEL);
    expect(select).toHaveValue("FIFO");

    fireEvent.change(select, { target: { value: "WAC" } });
    fireEvent.click(screen.getByTestId("account-submit-button"));

    await waitFor(() => expect(mutations.update).toHaveBeenCalledTimes(1));
    const submitted = mutations.update.mock.calls[0][0] as { meta: string };
    expect(JSON.parse(submitted.meta)).toEqual({
      accounting: { costBasisProfile: "GENERIC", costBasisMethod: "WAC" },
      broker: { note: "kept" },
    });
  });

  it("offers every method the engine computes, FIFO first", () => {
    renderForm({ meta: undefined });
    expand();
    const options = within(screen.getByLabelText(METHOD_LABEL))
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value);
    expect(options).toEqual(["FIFO", "LIFO", "HIFO", "WAC"]);
  });

  it.each([["LIFO"], ["HIFO"]])("stores %s", async (method) => {
    renderForm({ meta: undefined });
    expand();
    fireEvent.change(screen.getByLabelText(METHOD_LABEL), { target: { value: method } });
    fireEvent.click(screen.getByTestId("account-submit-button"));

    await waitFor(() => expect(mutations.update).toHaveBeenCalledTimes(1));
    const submitted = mutations.update.mock.calls[0][0] as { meta: string };
    expect(JSON.parse(submitted.meta)).toEqual({ accounting: { costBasisMethod: method } });
  });

  it("stays collapsed on FIFO, the default, showing the method", () => {
    renderForm({ meta: undefined });
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(toggle()).toHaveTextContent("FIFO");
    expect(screen.queryByLabelText(METHOD_LABEL)).not.toBeInTheDocument();

    expand();
    expect(screen.getByLabelText(METHOD_LABEL)).toHaveValue("FIFO");
  });

  it("opens on its own for an account on another method", () => {
    renderForm({ meta: JSON.stringify({ accounting: { costBasisMethod: "WAC" } }) });
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText(METHOD_LABEL)).toHaveValue("WAC");
  });

  it("says saving recalculates history only once the method changes", () => {
    renderForm({ meta: undefined });
    expand();
    const note = "settings:accounts.form_cost_basis_method_changed";
    expect(screen.queryByText(note)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(METHOD_LABEL), { target: { value: "WAC" } });
    expect(screen.getByText(note)).toBeInTheDocument();
  });

  it("shows a stored method the engine does not compute as unsupported", () => {
    // Core reads codes exactly: "wac" is not WAC, and the account is refused.
    renderForm({ meta: JSON.stringify({ accounting: { costBasisMethod: "wac" } }) });
    const select = screen.getByLabelText(METHOD_LABEL);
    expect(select).toHaveValue("wac");
    expect(
      screen.getByRole("option", { name: "settings:accounts.form_cost_basis_method_unsupported" }),
    ).toBeInTheDocument();
  });

  it.each([["null"], ["[1]"], ["7"], ["not json"]])(
    "stores the method when the meta is %s",
    async (meta) => {
      renderForm({ meta });
      expand();
      fireEvent.change(screen.getByLabelText(METHOD_LABEL), { target: { value: "WAC" } });
      fireEvent.click(screen.getByTestId("account-submit-button"));

      await waitFor(() => expect(mutations.update).toHaveBeenCalledTimes(1));
      const submitted = mutations.update.mock.calls[0][0] as { meta: string };
      expect(JSON.parse(submitted.meta)).toEqual({ accounting: { costBasisMethod: "WAC" } });
    },
  );

  it("offers no method where the account keeps no lots", () => {
    renderForm({ trackingMode: "HOLDINGS" });
    expect(
      screen.queryByRole("button", { name: new RegExp(METHOD_LABEL) }),
    ).not.toBeInTheDocument();
  });
});

describe("AccountForm archive", () => {
  beforeEach(() => mutations.update.mockClear());

  const archiveSwitch = () =>
    screen.getByRole("switch", { name: /settings:accounts\.form_archive_label/ });

  it("asks before archiving, then saves", async () => {
    renderForm();
    fireEvent.click(archiveSwitch());
    fireEvent.click(screen.getByTestId("account-submit-button"));

    expect(await screen.findByText("settings:accounts.archive_title")).toBeInTheDocument();
    expect(mutations.update).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "settings:accounts.operations_archive" }));
    await waitFor(() => expect(mutations.update).toHaveBeenCalledTimes(1));
    expect(mutations.update.mock.calls[0][0]).toMatchObject({ isArchived: true });
  });

  it("keeps the account as it was when archiving is cancelled", async () => {
    renderForm();
    fireEvent.click(archiveSwitch());
    fireEvent.click(screen.getByTestId("account-submit-button"));
    await screen.findByText("settings:accounts.archive_title");

    fireEvent.click(screen.getByRole("button", { name: "settings:accounts_cancel_button" }));
    await waitFor(() => expect(archiveSwitch()).not.toBeChecked());
    expect(mutations.update).not.toHaveBeenCalled();
  });

  it("saves other edits to an archived account without asking", async () => {
    renderForm({ isArchived: true });
    fireEvent.click(screen.getByTestId("account-submit-button"));
    await waitFor(() => expect(mutations.update).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("settings:accounts.archive_title")).not.toBeInTheDocument();
  });
});
