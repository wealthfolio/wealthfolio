import { act, fireEvent, render, screen } from "@/test/render";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { expect, it, vi } from "vitest";
import enCommon from "@/i18n/locales/en/common.json";
import zhCommon from "@/i18n/locales/zh/common.json";
import enAsset from "@/i18n/locales/en/asset.json";
import zhAsset from "@/i18n/locales/zh/asset.json";
import { UpdateValuationModal } from "./update-valuation-modal";

const mutateAsync = vi.hoisted(() => vi.fn());
vi.mock("../hooks/use-alternative-asset-mutations", () => ({
  useAlternativeAssetMutations: () => ({
    updateValuationMutation: { mutateAsync, isPending: false },
  }),
}));

it("retranslates an already displayed valuation error without resubmitting or clearing notes", async () => {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    resources: {
      en: { common: enCommon, asset: enAsset },
      zh: { common: zhCommon, asset: zhAsset },
    },
  });
  render(
    <I18nextProvider i18n={i18n}>
      <UpdateValuationModal
        open
        onOpenChange={vi.fn()}
        assetId="asset-1"
        assetName="My asset"
        currentValue="100"
        lastUpdatedDate="2026-09-06"
        currency="USD"
      />
    </I18nextProvider>,
  );
  const notes = "x".repeat(501);
  fireEvent.change(screen.getByPlaceholderText(enAsset.updateValuation.notes_placeholder), {
    target: { value: notes },
  });
  fireEvent.click(screen.getByRole("button", { name: enAsset.updateValuation.update_value }));
  expect(await screen.findByText(enAsset.updateValuation.validation.notes)).toBeVisible();
  await act(() => i18n.changeLanguage("zh"));
  expect(screen.getByText(zhAsset.updateValuation.validation.notes)).toBeVisible();
  expect(screen.queryByText(enAsset.updateValuation.validation.notes)).not.toBeInTheDocument();
  expect(screen.getByDisplayValue(notes)).toBeInTheDocument();
  expect(mutateAsync).not.toHaveBeenCalled();
});
