import { fireEvent, render, screen, waitFor } from "@/test/render";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyIconButton } from "./client-setup";

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock("@wealthfolio/ui/components/ui/use-toast", () => ({ toast: toastMock }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ children }: { children?: unknown }) => children,
}));

describe("CopyIconButton on a plain-HTTP page", () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
    Reflect.deleteProperty(document, "execCommand");
    toastMock.mockClear();
  });

  it("copies without the Clipboard API", async () => {
    // A self-hosted server opened at http://<network address>: no Clipboard API.
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    let copied = "";
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => {
        copied = (document.activeElement as HTMLTextAreaElement).value;
        return true;
      }),
    });

    render(<CopyIconButton value="wf_pat_123" label="Token" />);
    fireEvent.click(screen.getByRole("button", { name: "settings:agentAccess.copy_aria" }));

    await waitFor(() => expect(copied).toBe("wf_pat_123"));
    expect(toastMock).not.toHaveBeenCalled();
  });
});
