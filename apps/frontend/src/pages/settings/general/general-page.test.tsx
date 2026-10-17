import { render, screen } from "@/test/render";
import { expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import GeneralSettingsPage from "./general-page";

const runtime = vi.hoisted(() => ({ source: undefined as unknown }));
vi.mock("@/hooks/use-platform", () => ({ usePlatform: () => ({ isMobile: false }) }));
vi.mock("@/hooks/use-updater", () => ({
  useExternalUpdateSource: () => ({ data: runtime.source }),
}));
vi.mock("./auto-update-settings", () => ({ AutoUpdateSettings: () => <p>auto-update toggle</p> }));
vi.mock("./currency-settings", () => ({ BaseCurrencySettings: () => null }));
vi.mock("./database-encryption-settings", () => ({ DatabaseEncryptionSettings: () => null }));
vi.mock("./exchange-rates/exchange-rates-settings", () => ({ ExchangeRatesSettings: () => null }));
vi.mock("./language-region-settings", () => ({ LanguageRegionSettings: () => null }));

it.each([
  [null, true],
  [undefined, false],
  [{ kind: "flatpak" }, false],
  [{ kind: "packager", explanation: "Use pacman." }, false],
])("external update source %o shows the auto-update toggle: %s", (source, shown) => {
  runtime.source = source;
  render(
    <MemoryRouter>
      <GeneralSettingsPage />
    </MemoryRouter>,
  );
  expect(screen.queryByText("auto-update toggle") !== null).toBe(shown);
});
