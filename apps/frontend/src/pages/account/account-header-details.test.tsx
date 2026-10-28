import { fireEvent, render, screen, waitFor } from "@/test/render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountHeaderDetails } from "./account-header-details";

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock("@wealthfolio/ui/components/ui/use-toast", () => ({ toast: toastMock }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const IBAN = "DE89 3704 0044 0532 0130 00";
const copyButton = () => screen.queryByRole("button", { name: "account:copy_account_number" });

describe("AccountHeaderDetails", () => {
  const writeText = vi.fn();
  beforeEach(() => {
    toastMock.mockClear();
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("shows the currency and the end of the number for an account without a group", () => {
    render(<AccountHeaderDetails account={{ currency: "EUR", accountNumber: IBAN }} />);
    expect(screen.getByText("EUR")).toBeInTheDocument();
    expect(screen.getByTestId("account-header-number")).toHaveTextContent("··3000");
    expect(screen.queryByText(IBAN)).not.toBeInTheDocument();
    expect(copyButton()).toBeInTheDocument();
  });

  it("shows only the end of the number when the group sits beside the name", () => {
    render(
      <AccountHeaderDetails account={{ group: "Banks", currency: "EUR", accountNumber: IBAN }} />,
    );
    expect(screen.queryByText("EUR")).not.toBeInTheDocument();
    expect(screen.getByTestId("account-header-number")).toHaveTextContent("··3000");
  });

  it("keeps the currency line as it was for an account without a number", () => {
    render(<AccountHeaderDetails account={{ currency: "EUR" }} />);
    expect(screen.getByText("EUR")).toBeInTheDocument();
    expect(screen.queryByTestId("account-header-number")).not.toBeInTheDocument();
    expect(copyButton()).not.toBeInTheDocument();
  });

  it("shows nothing for a grouped account without a number", () => {
    const { container } = render(
      <AccountHeaderDetails account={{ group: "Banks", currency: "EUR" }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("copies the whole number and says so", async () => {
    render(<AccountHeaderDetails account={{ currency: "EUR", accountNumber: ` ${IBAN} ` }} />);
    fireEvent.click(copyButton()!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(IBAN));
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: "account:account_number_copied", variant: "success" }),
      ),
    );
  });

  it("says when the number could not be copied", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    render(<AccountHeaderDetails account={{ currency: "EUR", accountNumber: IBAN }} />);
    fireEvent.click(copyButton()!);
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" })),
    );
  });
});
