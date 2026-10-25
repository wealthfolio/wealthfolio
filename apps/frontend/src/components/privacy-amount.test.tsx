import { act, render, screen } from "@testing-library/react";
import { PrivacyAmount, useBalancePrivacy } from "@wealthfolio/ui";
import { Activity, useState } from "react";
import { afterEach, expect, it } from "vitest";

afterEach(() => localStorage.removeItem("privacy-settings"));

it("hides an amount whose phone screen was out of sight when balances were hidden", () => {
  // A phone screen kept under another one, or in a tab left for another, is a
  // hidden <Activity>: its listeners are gone until it is shown again.
  let toggle: () => void = () => undefined;
  let setHidden: (hidden: boolean) => void = () => undefined;
  function EyeButton() {
    toggle = useBalancePrivacy().toggleBalanceVisibility;
    return null;
  }
  function Screens() {
    const [hidden, setHiddenState] = useState(false);
    setHidden = setHiddenState;
    return (
      <>
        <Activity mode={hidden ? "hidden" : "visible"}>
          <p data-testid="kept-amount">
            <PrivacyAmount value={1234} currency="USD" />
          </p>
        </Activity>
        <EyeButton />
      </>
    );
  }
  render(<Screens />);
  expect(screen.getByTestId("kept-amount")).toHaveTextContent("1,234");

  act(() => setHidden(true));
  act(() => toggle());
  act(() => setHidden(false));

  expect(screen.getByTestId("kept-amount")).not.toHaveTextContent("1,234");
});
