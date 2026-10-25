import { act, fireEvent, render, screen } from "@testing-library/react";
import { Activity, StrictMode, useState } from "react";
import { expect, it, vi } from "vitest";
import { usePersistentState } from "@wealthfolio/ui";

it("synchronizes functional updates without updating another component during render", () => {
  const key = "persistent-state-render-test";
  localStorage.removeItem(key);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  function Editor() {
    const [value, setValue] = usePersistentState(key, 0);
    return (
      <button
        onClick={() => {
          setValue((previous) => previous + 1);
          setValue((previous) => previous + 1);
        }}
      >
        Count {value}
      </button>
    );
  }
  function Observer() {
    const [value] = usePersistentState(key, 0);
    return <output>{value}</output>;
  }
  try {
    render(
      <StrictMode>
        <Editor />
        <Observer />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveTextContent("Count 2");
    expect(screen.getByRole("status")).toHaveTextContent("2");
    expect(localStorage.getItem(key)).toBe("2");
    expect(errors).not.toHaveBeenCalled();
  } finally {
    errors.mockRestore();
    localStorage.removeItem(key);
  }
});

it("shows a value changed while its phone screen was out of sight", () => {
  // A phone screen kept under another one, or in a tab left for another, is a
  // hidden <Activity>: its listeners are gone until it is shown again.
  const key = "persistent-state-kept-screen-test";
  localStorage.removeItem(key);
  let setPeriod: (value: string) => void = () => undefined;
  let setHidden: (hidden: boolean) => void = () => undefined;
  function KeptScreen() {
    const [period] = usePersistentState(key, "MTD");
    return <output>{period}</output>;
  }
  function OtherScreen() {
    setPeriod = usePersistentState(key, "MTD")[1];
    return null;
  }
  function Screens() {
    const [hidden, setHiddenState] = useState(false);
    setHidden = setHiddenState;
    return (
      <>
        <Activity mode={hidden ? "hidden" : "visible"}>
          <KeptScreen />
        </Activity>
        <OtherScreen />
      </>
    );
  }
  try {
    render(<Screens />);
    act(() => setHidden(true));
    act(() => setPeriod("YTD"));
    act(() => setHidden(false));
    expect(screen.getByRole("status")).toHaveTextContent("YTD");
  } finally {
    localStorage.removeItem(key);
  }
});
