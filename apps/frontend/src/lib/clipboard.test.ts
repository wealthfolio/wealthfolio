import { copyText } from "@wealthfolio/ui/lib/clipboard";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What the copy command saw: the selected text and where the field sat.
interface CopyCall {
  selected: string;
  parent: Element | null;
}

describe("copyText", () => {
  let calls: CopyCall[];
  let copyResult: boolean;

  beforeEach(() => {
    calls = [];
    copyResult = true;
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn((command: string) => {
        const field = document.activeElement as HTMLTextAreaElement;
        expect(command).toBe("copy");
        calls.push({
          selected: field.value.slice(field.selectionStart, field.selectionEnd),
          parent: field.parentElement,
        });
        return copyResult;
      }),
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
    Reflect.deleteProperty(document, "execCommand");
    document.body.innerHTML = "";
  });

  function withoutClipboardApi() {
    // A plain-HTTP page on a network address: not a secure context.
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  }

  function focusedButton(container: Element = document.body) {
    const button = document.createElement("button");
    container.appendChild(button);
    button.focus();
    return button;
  }

  it("uses the Clipboard API where the page has it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    await copyText("DE89 3704 0044 0532 0130 00");

    expect(writeText).toHaveBeenCalledWith("DE89 3704 0044 0532 0130 00");
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it("keeps the Clipboard API's refusal, without a second try", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    await expect(copyText("x")).rejects.toThrow("denied");
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it("copies through a hidden text field without the Clipboard API", async () => {
    withoutClipboardApi();
    const button = focusedButton();

    await copyText("wealthfolio --stdio");

    expect(calls).toEqual([{ selected: "wealthfolio --stdio", parent: document.body }]);
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("puts the field inside an open dialog, where its focus trap allows it", async () => {
    withoutClipboardApi();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    const button = focusedButton(dialog);

    await copyText("token");

    expect(calls[0].parent).toBe(dialog);
    expect(document.activeElement).toBe(button);
  });

  it("rejects when the browser refuses to copy, and still cleans up", async () => {
    withoutClipboardApi();
    copyResult = false;
    const button = focusedButton();

    await expect(copyText("x")).rejects.toThrow();
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});
