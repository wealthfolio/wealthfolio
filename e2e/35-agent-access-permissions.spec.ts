import { expect, test } from "@playwright/test";
import { BASE_URL, loginIfNeeded } from "./helpers";

for (const direction of ["ltr", "rtl"]) {
  test(`edit token permissions without replacing the credential (${direction})`, async ({
    page,
  }) => {
    if (direction === "rtl") await page.setViewportSize({ width: 390, height: 844 });
    await loginIfNeeded(page);
    await page.goto(`${BASE_URL}/settings/agent-access?dir=${direction}`);
    const name = `Permission test ${direction}`;
    await page.getByRole("button", { name: "Create token", exact: true }).click();
    const create = page.getByRole("dialog");
    await create.getByLabel("Name", { exact: true }).fill(name);
    const createdResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url().endsWith("/agent-access/tokens"),
    );
    await create.getByRole("button", { name: "Create token", exact: true }).click();
    const createdMetadata = await (await createdResponse).json();
    await expect(create.getByRole("heading", { name: "Token created", exact: true })).toBeVisible();
    await create.getByRole("button", { name: "Done", exact: true }).click();
    const row = page
      .locator("div.grid")
      .filter({ has: page.getByText(name, { exact: true }) })
      .filter({ has: page.getByRole("button", { name: "Edit permissions", exact: true }) })
      .last();
    await row.getByRole("button", { name: "Edit permissions", exact: true }).click();
    const edit = page.getByRole("dialog");
    const scope = edit.getByRole("checkbox", { name: /^Activities — draft/ });
    await expect(scope).toHaveAttribute("aria-checked", "false");
    await scope.focus();
    await page.keyboard.press("Space");
    await expect(scope).toHaveAttribute("aria-checked", "true");
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" && response.url().includes("/agent-access/tokens/"),
    );
    await edit.getByRole("button", { name: "Save", exact: true }).click();
    const response = await saved;
    expect(response.ok()).toBeTruthy();
    const metadata = await response.json();
    expect(metadata.scopes).toContain("activities:draft");
    for (const field of ["id", "name", "tokenPrefix", "createdAt", "expiresAt"]) {
      expect(metadata[field]).toEqual(createdMetadata[field]);
    }
    expect(metadata.token).toBeUndefined();
    expect(metadata.tokenHash).toBeUndefined();
    await expect(edit).not.toBeVisible();
    await row.getByRole("button", { name: "Edit permissions", exact: true }).click();
    await expect(
      page.getByRole("dialog").getByRole("checkbox", { name: /^Activities — draft/ }),
    ).toHaveAttribute("aria-checked", "true");
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  });
}
