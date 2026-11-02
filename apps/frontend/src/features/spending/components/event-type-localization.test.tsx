import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import enCommon from "@/i18n/locales/en/common.json";
import enCommonTaxonomies from "@/i18n/locales/en/taxonomies.json";
import zhCommon from "@/i18n/locales/zh/common.json";
import zhCommonTaxonomies from "@/i18n/locales/zh/taxonomies.json";
import enSpending from "@/i18n/locales/en/spending.json";
import zhSpending from "@/i18n/locales/zh/spending.json";
import { EventTypesOverviewCard } from "@/pages/settings/spending/components/event-types-overview-card";
import { EventTypeFormDialog } from "./event-type-form-dialog";

const { types, update } = vi.hoisted(() => ({
  types: [
    {
      id: "255600dc-c2a3-47e0-979d-a602c21fc337",
      name: "Travel",
      color: "#7B96C9",
      createdAt: "",
      updatedAt: "",
    },
    {
      id: "51e3eedb-5484-45ba-a525-6b88209c46ed",
      name: "My vacation",
      color: "#6B8E54",
      createdAt: "",
      updatedAt: "",
    },
    { id: "custom", name: "Travel", color: "#B89A4C", createdAt: "", updatedAt: "" },
  ],
  update: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../hooks/use-spending-events", () => ({
  useEventTypes: () => ({ data: types, isLoading: false, isError: false }),
  useEventTypeMutations: () => ({
    update: { mutateAsync: update },
    create: { mutateAsync: vi.fn() },
  }),
}));

async function setup() {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: "zh",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    resources: {
      en: { common: enCommon, taxonomies: enCommonTaxonomies, spending: enSpending },
      zh: { common: zhCommon, taxonomies: zhCommonTaxonomies, spending: zhSpending },
    },
  });
  return i18n;
}

beforeEach(() => vi.clearAllMocks());

it("refreshes seeded event-type chips while leaving renamed and custom types verbatim", async () => {
  const i18n = await setup();
  const original = structuredClone(types);
  render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <EventTypesOverviewCard />
      </I18nextProvider>
    </MemoryRouter>,
  );
  expect(screen.getByText("旅行")).toBeInTheDocument();
  expect(screen.getByText("Travel")).toBeInTheDocument();
  expect(screen.getByText("My vacation")).toBeInTheDocument();
  await act(() => i18n.changeLanguage("en"));
  expect(screen.getAllByText("Travel")).toHaveLength(2);
  expect(types).toEqual(original);
});

it("keeps the event-type editor and unchanged save raw in Chinese", async () => {
  const i18n = await setup();
  render(
    <I18nextProvider i18n={i18n}>
      <EventTypeFormDialog eventType={types[0]} open onOpenChange={vi.fn()} />
    </I18nextProvider>,
  );
  expect(screen.getByRole("textbox", { name: zhCommon.name })).toHaveValue("Travel");
  fireEvent.click(screen.getByRole("button", { name: zhSpending.common.update }));
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith({
      id: types[0].id,
      patch: { name: "Travel", color: "#7B96C9" },
    }),
  );
});
