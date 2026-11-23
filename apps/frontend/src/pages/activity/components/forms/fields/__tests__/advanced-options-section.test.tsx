import { ACTIVITY_SUBTYPES, ActivityType } from "@/lib/constants";
import { render, screen } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { SheetNavigation } from "@wealthfolio/ui";
import { FormProvider, useForm } from "react-hook-form";
import { expect, it } from "vitest";

import { AdvancedOptionsSection } from "../advanced-options-section";

if (typeof ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
}
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => undefined;
}

interface Values {
  subtype: string | null;
}

let current: Values | undefined;

function PhoneForm() {
  const form = useForm<Values>({ defaultValues: { subtype: null } });
  current = form.watch();
  return (
    <SheetNavigation>
      <FormProvider {...form}>
        <AdvancedOptionsSection<Values>
          subtypeName="subtype"
          activityType={ActivityType.DIVIDEND}
          showCurrency={false}
          showFxRate={false}
          variant="mobile"
          defaultOpen
        />
      </FormProvider>
    </SheetNavigation>
  );
}

it("opens the subtype list as a screen of a phone form's sheet", async () => {
  const user = userEvent.setup();
  render(<PhoneForm />);
  const trigger = screen.getByTestId("subtype-select");
  expect(trigger).toHaveTextContent("None");

  await user.click(trigger);

  // The Select opens its screen from its own open handler, a beat after the click.
  expect(await screen.findByRole("dialog", { name: "Subtype" })).toBeInTheDocument();
  await user.click(screen.getByRole("option", { name: /DRIP/ }));
  expect(current?.subtype).toBe(ACTIVITY_SUBTYPES.DRIP);
  expect(screen.queryByRole("dialog", { name: "Subtype" })).not.toBeInTheDocument();
  expect(screen.getByTestId("subtype-select")).toHaveTextContent("DRIP");
});
