import { fireEvent, render, screen, waitFor, within } from "@/test/render";
import { Dialog, DialogContent } from "@wealthfolio/ui/components/ui/dialog";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountForm } from "./account-form";
import enCommon from "@/i18n/locales/en/common.json";

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
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key === "common:validation.accountNumberMax" ? enCommon.validation.accountNumberMax : key,
    i18n: { resolvedLanguage: "en", language: "en" },
  }),
}));
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

function renderForm(
  overrides: Partial<Parameters<typeof AccountForm>[0]["defaultValues"]> = {},
  { isSynced = false }: { isSynced?: boolean } = {},
) {
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
        <AccountForm defaultValues={defaultValues} isSynced={isSynced} />
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

    fireEvent.click(screen.getByRole("button", { name: "common:cancel" }));
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

describe("AccountForm account number", () => {
  beforeEach(() => {
    mutations.create.mockClear();
    mutations.update.mockClear();
  });

  const NUMBER_LABEL = "settings:accounts.form_account_number_label";
  const numberInput = () => screen.getByLabelText(new RegExp(NUMBER_LABEL));
  const OPTIONAL = "settings:accounts.form_optional";
  const submit = () => fireEvent.click(screen.getByTestId("account-submit-button"));

  it("sends the number typed for a manual account, trimmed", async () => {
    renderForm({ accountNumber: "NL91ABNA0417164300" });
    expect(numberInput()).toHaveValue("NL91ABNA0417164300");
    expect(numberInput()).toBeEnabled();
    expect(screen.getByText("settings:accounts.form_account_number_hint")).toBeInTheDocument();
    // Group and number are the identity fields an account can leave out.
    expect(numberInput()).toHaveAccessibleName(`${NUMBER_LABEL}${OPTIONAL}`);
    expect(screen.getByLabelText(/settings:accounts_form_group_label/)).toHaveAccessibleName(
      `settings:accounts_form_group_label${OPTIONAL}`,
    );

    fireEvent.change(numberInput(), { target: { value: "  DE89 3704 0044 0532 0130 00 " } });
    submit();

    await waitFor(() => expect(mutations.update).toHaveBeenCalledTimes(1));
    expect(mutations.update.mock.calls[0][0]).toMatchObject({
      accountNumber: "DE89 3704 0044 0532 0130 00",
    });
  });

  it("sends an empty number when the field is cleared, so the stored one is removed", async () => {
    renderForm({ accountNumber: "4100" });
    fireEvent.change(numberInput(), { target: { value: "" } });
    submit();

    await waitFor(() => expect(mutations.update).toHaveBeenCalledTimes(1));
    expect(mutations.update.mock.calls[0][0]).toMatchObject({ accountNumber: "" });
  });

  it("sends the number when creating an account", async () => {
    renderForm({ id: undefined, accountNumber: "" });
    fireEvent.change(numberInput(), { target: { value: "4100" } });
    submit();

    await waitFor(() => expect(mutations.create).toHaveBeenCalledTimes(1));
    expect(mutations.create.mock.calls[0][0]).toMatchObject({ accountNumber: "4100" });
  });

  it("refuses a number longer than 64 characters", async () => {
    renderForm({ accountNumber: "" });
    fireEvent.change(numberInput(), { target: { value: "9".repeat(65) } });
    submit();

    expect(
      await screen.findByText("Account number must not be longer than 64 characters."),
    ).toBeInTheDocument();
    expect(mutations.update).not.toHaveBeenCalled();
  });

  it("shows a synced account's number read-only and never sends it", async () => {
    // Longer than a manual number may be: the broker's value must not block saving.
    const brokerNumber = `BRK-${"0".repeat(70)}`;
    renderForm({ accountNumber: brokerNumber }, { isSynced: true });
    expect(numberInput()).toHaveValue(brokerNumber);
    expect(numberInput()).toBeDisabled();
    expect(numberInput()).toHaveAccessibleName(NUMBER_LABEL);
    expect(screen.getByText("settings:accounts.form_account_number_synced")).toBeInTheDocument();

    submit();
    await waitFor(() => expect(mutations.update).toHaveBeenCalledTimes(1));
    // Both runtimes send JSON, which leaves an undefined number out.
    const submitted = mutations.update.mock.calls[0][0] as Record<string, unknown>;
    expect(JSON.parse(JSON.stringify(submitted))).not.toHaveProperty("accountNumber");
  });
});

describe("AccountForm layout", () => {
  it("puts Visibility after Tracking mode, so it stays last on phones", () => {
    renderForm();
    const trackingMode = screen.getByText("settings:accounts.form_tracking_mode_label");
    const visibility = screen.getByText("settings:accounts.form_visibility");
    expect(
      trackingMode.compareDocumentPosition(visibility) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
