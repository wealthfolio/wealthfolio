import { expect, test } from "@playwright/test";
import { BASE_URL, gotoAppPath } from "./helpers";

test("manual exchange rates display and save Spain's decimal commas in LTR and RTL", async ({
  page,
}) => {
  const api = `${BASE_URL}/api/v1`;
  const state = await (
    await page.request.post(`${api}/profiles/get_profile_state`, { data: {} })
  ).json();
  const session =
    state.session ??
    (await (
      await page.request.post(`${api}/profiles/unlock_profile`, {
        data: { profileId: state.profiles[0].id },
      })
    ).json());
  const headers = { "x-wf-profile-scope": session.scopeId };
  const previous = await (await page.request.get(`${api}/settings`, { headers })).json();
  const settings = await page.request.put(`${api}/settings`, {
    headers,
    data: {
      language: "en",
      formattingRegion: "ES",
      onboardingCompleted: true,
      autoUpdateCheckEnabled: false,
    },
  });
  expect(settings.ok()).toBeTruthy();
  const created = await page.request.post(`${api}/exchange-rates`, {
    headers,
    data: { fromCurrency: "USD", toCurrency: "EUR", source: "MANUAL", rate: 1.2345 },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const rate = await created.json();
  try {
    for (const dir of ["ltr", "rtl"]) {
      await gotoAppPath(page, `/settings/general?dir=${dir}`);
      await expect(page.locator("html")).toHaveAttribute("dir", dir);
      const row = page
        .getByRole("row")
        .filter({ hasText: "USD" })
        .filter({ hasText: "EUR" })
        .first();
      await expect(row).toContainText(dir === "ltr" ? "1,2345" : "1,5678");
      await row.getByRole("button", { name: "Edit", exact: true }).click();
      const input = row.getByRole("textbox", { name: "Rate", exact: true });
      await expect(input).toHaveValue(dir === "ltr" ? /1,2345/ : /1,5678/);
      const next = dir === "ltr" ? "1,5678" : "1,6789";
      await input.fill(next);
      const saving = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          new URL(response.url()).pathname.endsWith("/exchange-rates"),
      );
      await row.getByRole("button", { name: "Save", exact: true }).click();
      const saved = await saving;
      expect(saved.ok()).toBeTruthy();
      expect(saved.request().postDataJSON().rate).toBeCloseTo(dir === "ltr" ? 1.5678 : 1.6789);
      await expect(row).toContainText(next);
    }
  } finally {
    await page.request.delete(`${api}/exchange-rates/${rate.id}`, { headers });
    await page.request.put(`${api}/settings`, { headers, data: previous });
  }
});
