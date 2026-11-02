import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installLockdown } from "./lockdown";

function rightClick(target: Element) {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe("installLockdown", () => {
  beforeAll(() => {
    installLockdown();
  });

  beforeEach(() => {
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
  });

  it("blocks the context menu on page content", () => {
    document.body.innerHTML = "<p>Holdings</p>";

    expect(rightClick(document.querySelector("p")!).defaultPrevented).toBe(true);
  });

  it("keeps the context menu in text fields", () => {
    document.body.innerHTML = "<input>";

    expect(rightClick(document.querySelector("input")!).defaultPrevented).toBe(false);
  });

  it.each(["allow-select", "select-all"])(
    "keeps the context menu in %s text only for a selection",
    (className) => {
      document.body.innerHTML = `<table class="${className}"><tbody><tr><td>INF03VN01AH4</td></tr></tbody></table>`;
      const cell = document.querySelector("td")!;

      // Without a selection the menu would be the page menu (Back, Reload).
      expect(rightClick(cell).defaultPrevented).toBe(true);

      window.getSelection()!.selectAllChildren(cell);
      expect(rightClick(cell).defaultPrevented).toBe(false);
    },
  );
});
