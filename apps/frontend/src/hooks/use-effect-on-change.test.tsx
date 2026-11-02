import { act, fireEvent, render, screen } from "@testing-library/react";
import { Activity, useState } from "react";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import { useEffectOnChange } from "./use-effect-on-change";

let setHidden: (hidden: boolean) => void = () => undefined;
let setRecord: (record: string) => void = () => undefined;

/** A form reset when its record changes, as the app's edit forms do. */
function RecordForm({ onReset }: { onReset: () => void }) {
  const [record, setRecordState] = useState("Groceries");
  setRecord = setRecordState;
  const form = useForm({ defaultValues: { name: record } });
  useEffectOnChange(() => {
    onReset();
    form.reset({ name: record });
  }, [record, form, onReset]);
  return <input aria-label="Name" {...form.register("name")} />;
}

function KeptScreen({ onReset }: { onReset: () => void }) {
  const [hidden, setHiddenState] = useState(false);
  setHidden = setHiddenState;
  return (
    <Activity mode={hidden ? "hidden" : "visible"}>
      <RecordForm onReset={onReset} />
    </Activity>
  );
}

describe("useEffectOnChange", () => {
  it("keeps what was typed when a kept screen is hidden and shown again", () => {
    const onReset = vi.fn();
    render(<KeptScreen onReset={onReset} />);
    expect(onReset).toHaveBeenCalledTimes(1);

    fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Groceries and more" } });
    act(() => setHidden(true));
    act(() => setHidden(false));

    expect(onReset).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Groceries and more");
  });

  it("runs again when its dependencies change", () => {
    const onReset = vi.fn();
    render(<KeptScreen onReset={onReset} />);
    act(() => setRecord("Rent"));
    expect(onReset).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Rent");
  });
});
