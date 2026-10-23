import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { Activity, useState } from "react";
import { describe, expect, it } from "vitest";

// A phone screen kept under another one (or in a tab left for another) is a
// hidden <Activity>: its subscriptions pause until it is shown again. A save
// that finishes meanwhile must still show as finished when the user returns.
// React Query reattaches a mutation's observer when it subscribes again from
// 5.102 (TanStack/query#11172); before, the save stayed pending for good.

let setHidden: (hidden: boolean) => void = () => undefined;
let finish: (value: string) => void = () => undefined;

function SaveButton() {
  const save = useMutation({
    mutationFn: () => new Promise<string>((resolve) => (finish = resolve)),
  });
  return (
    <button disabled={save.isPending} onClick={() => save.mutate()}>
      {save.status}
    </button>
  );
}

function KeptScreen() {
  const [hidden, setHiddenState] = useState(false);
  setHidden = setHiddenState;
  return (
    <Activity mode={hidden ? "hidden" : "visible"}>
      <SaveButton />
    </Activity>
  );
}

describe("a save on a kept screen", () => {
  it("shows as finished when it settled while the screen was hidden", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <KeptScreen />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(screen.getByRole("button")).toHaveTextContent("pending"));

    act(() => setHidden(true));
    await act(async () => finish("saved"));
    act(() => setHidden(false));

    await waitFor(() => expect(screen.getByRole("button")).toHaveTextContent("success"));
    expect(screen.getByRole("button")).toBeEnabled();
  });
});
