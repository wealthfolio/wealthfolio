import { render, screen } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { PeriodNavigation } from "./period-navigation";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import frSpending from "@/i18n/locales/fr/spending.json";

afterEach(() => vi.unstubAllGlobals());

it("renders French month actions without an unelided article", async () => {
  const i18n = createInstance();
  await i18n.init({
    lng: "fr",
    defaultNS: "spending",
    resources: { fr: { spending: frSpending } },
  });
  render(
    <I18nextProvider i18n={i18n}>
      <PeriodNavigation
        navigation={{
          label: "Période actuelle",
          step: "month",
          previousDisabled: false,
          nextDisabled: true,
          onStep: vi.fn(),
        }}
      />
    </I18nextProvider>,
  );
  expect(screen.getByRole("button", { name: "Précédent : mois" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Suivant : mois" })).toBeDisabled();
});

it("keeps full spoken interval labels on a phone and exposes a one-click return", async () => {
  vi.stubGlobal("innerWidth", 390);
  const onReset = vi.fn();
  render(
    <PeriodNavigation
      navigation={{
        label: "Historical range",
        step: "3M",
        previousDisabled: false,
        nextDisabled: false,
        onStep: vi.fn(),
        onReset,
      }}
    />,
  );
  expect(screen.getByRole("button", { name: "Previous 3 months" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Next 3 months" })).toBeVisible();
  await userEvent.setup().click(screen.getByRole("button", { name: "Back to latest" }));
  expect(onReset).toHaveBeenCalledOnce();
});

it.each([null, "ALL"] as const)("omits navigation when %s has no stepping unit", (step) => {
  render(
    <PeriodNavigation
      navigation={{
        label: "Custom range",
        step,
        previousDisabled: true,
        nextDisabled: true,
        onStep: vi.fn(),
      }}
    />,
  );
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Custom range");
});

it("keeps the announcement region mounted when switching between fixed ranges and presets", () => {
  const navigation = {
    label: "Custom range",
    step: null,
    previousDisabled: true,
    nextDisabled: true,
    onStep: vi.fn(),
  };
  const { rerender } = render(<PeriodNavigation navigation={navigation} />);
  const status = screen.getByRole("status");
  rerender(
    <PeriodNavigation
      navigation={{ ...navigation, step: "6M", label: "Past 6 months", previousDisabled: false }}
    />,
  );
  expect(screen.getByRole("status")).toBe(status);
  expect(status).toHaveTextContent("Past 6 months");
});

it("announces the updated period while focus can stay on an arrow", () => {
  const navigation = {
    label: "Past 6 months",
    step: "6M" as const,
    previousDisabled: false,
    nextDisabled: true,
    onStep: vi.fn(),
  };
  const { rerender } = render(<PeriodNavigation navigation={navigation} />);
  expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  rerender(
    <PeriodNavigation navigation={{ ...navigation, label: "Sep 15, 2025 – Mar 15, 2026" }} />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Sep 15, 2025 – Mar 15, 2026");
});

it("exposes header navigation for the current preset and keeps Next disabled", async () => {
  const onStep = vi.fn();
  render(
    <PeriodNavigation
      navigation={{
        label: "Past 6 months",
        step: "6M" as const,
        previousDisabled: false,
        nextDisabled: true,
        onStep,
      }}
    />,
  );
  expect(screen.getByRole("group", { name: "Past 6 months" })).toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole("button", { name: "Previous 6 months" }));
  expect(onStep).toHaveBeenCalledWith(-1);
  expect(screen.getByRole("button", { name: "Next 6 months" })).toBeDisabled();
});

it("allows returning to a newer historical window and mirrors the arrow icons in RTL", async () => {
  const onStep = vi.fn();
  render(
    <PeriodNavigation
      navigation={{
        label: "2024",
        step: "year",
        previousDisabled: true,
        nextDisabled: false,
        onStep,
      }}
    />,
  );
  expect(screen.getByRole("button", { name: "Previous year" })).toBeDisabled();
  const next = screen.getByRole("button", { name: "Next year" });
  expect(next.querySelector("svg")).toHaveClass("rtl:rotate-180");
  await userEvent.setup().click(next);
  expect(onStep).toHaveBeenCalledWith(1);
});
