import { act, cleanup, render, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import en from "@/i18n/locales/en/common.json";
import fr from "@/i18n/locales/fr/common.json";
import ar from "@/i18n/locales/ar/common.json";
import { backendError } from "@/lib/backend-error";
import AiProvidersPage from "./ai-providers-page";

const mocks = vi.hoisted(() => ({ error: undefined as unknown }));
vi.mock("@/features/ai-assistant", () => ({
  ProviderSettingsCard: ({ fetchModelsError }: { fetchModelsError?: string }) => (
    <p role="alert">{fetchModelsError}</p>
  ),
  useAiProviders: () => ({
    data: {
      providers: [
        { id: "google", priority: 0, supportsModelListing: true, hasApiKey: true, type: "api" },
      ],
    },
  }),
  useUpdateAiProviderSettings: () => ({ mutate: vi.fn() }),
  useSetDefaultAiProvider: () => ({ mutate: vi.fn() }),
  useAiProviderApiKey: () => ({
    setApiKey: { mutate: vi.fn() },
    deleteApiKey: { mutate: vi.fn() },
    revealApiKey: vi.fn(),
  }),
  useListAiModels: () => ({ error: mocks.error }),
}));

afterEach(cleanup);

it.each(["web", "desktop"])(
  "translates retained %s model-list errors when language changes",
  async (runtime) => {
    const i18n = createInstance();
    await i18n.init({
      lng: "en",
      fallbackLng: "en",
      resources: { en: { common: en }, fr: { common: fr }, ar: { common: ar } },
    });
    const payload = {
      errorCode: "provider_unavailable",
      message: "FAKE-KEY-2531 /private/portfolio.db",
    };
    mocks.error = backendError(runtime === "web" ? { code: 400, ...payload } : payload);
    render(
      <MemoryRouter>
        <I18nextProvider i18n={i18n}>
          <AiProvidersPage />
        </I18nextProvider>
      </MemoryRouter>,
    );
    expect(screen.getByRole("alert").textContent).toBe(en.backendErrors.providerUnavailable);
    await act(() => i18n.changeLanguage("fr"));
    expect(screen.getByRole("alert").textContent).toBe(fr.backendErrors.providerUnavailable);
    await act(() => i18n.changeLanguage("ar"));
    expect(screen.getByRole("alert").textContent).toBe(ar.backendErrors.providerUnavailable);
    expect(document.body.textContent).not.toContain("FAKE-KEY");
    expect(document.body.textContent).not.toContain("/private");
  },
);
