import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    await page.screenshot({ path: info.outputPath("failure.png"), fullPage: true });
  }
});

async function command(context: BrowserContext, name: string, data = {}, scope?: string) {
  const response = await context.request.post(`/api/v1/profiles/${name}`, {
    data,
    headers: scope ? { "x-wf-profile-scope": scope } : {},
  });
  expect(response.ok(), `${name}: ${response.status()} ${await response.text()}`).toBeTruthy();
  return response.json();
}

async function createProfile(context: BrowserContext, name: string) {
  const profile = await command(context, "create_profile", { name, avatarId: "clay-bot-animated" });
  const session = await command(context, "unlock_profile", { profileId: profile.id });
  const headers = { "x-wf-profile-scope": session.scopeId };
  const settings = await context.request.put("/api/v1/settings", {
    headers,
    data: {
      onboardingCompleted: true,
      theme: "light",
      language: "en",
      timezone: "UTC",
      baseCurrency: "USD",
      syncEnabled: false,
      autoUpdateCheckEnabled: false,
    },
  });
  expect(settings.ok()).toBeTruthy();
  return { ...profile, scope: session.scopeId };
}

test("reserved Unicode credential aliases cannot read, overwrite, or delete protection", async ({
  context,
}) => {
  const profile = await createProfile(context, "Credential isolation");
  await command(
    context,
    "set_profile_password",
    { proof: null, password: "keep this password" },
    profile.scope,
  );
  const session = await command(context, "unlock_profile", {
    profileId: profile.id,
    proof: "keep this password",
  });
  const headers = { "x-wf-profile-scope": session.scopeId };
  for (const secretKey of ["profile_locK", "database_encryption_Key", "PROFILE_LOCK"]) {
    const query = `/api/v1/secrets?${new URLSearchParams({ secretKey })}`;
    const read = await context.request.get(query, { headers });
    expect(read.status(), `GET ${secretKey}`).toBe(400);
    const write = await context.request.post("/api/v1/secrets", {
      headers,
      data: {
        secretKey,
        secret: JSON.stringify({ password_hash: null, recovery_hash: null, auto_lock_minutes: 0 }),
      },
    });
    expect(write.status(), `POST ${secretKey}`).toBe(400);
    const remove = await context.request.delete(query, { headers });
    expect(remove.status(), `DELETE ${secretKey}`).toBe(400);
  }
  await command(context, "lock_profile", { preserveAuth: false });
  for (const proof of [undefined, "wrong password"]) {
    const denied = await context.request.post("/api/v1/profiles/unlock_profile", {
      data: { profileId: profile.id, proof },
    });
    expect(denied.ok()).toBe(false);
  }
  await command(context, "unlock_profile", { profileId: profile.id, proof: "keep this password" });
});

async function seedHistory(context: BrowserContext, scope: string) {
  const headers = { "x-wf-profile-scope": scope };
  const account = await context.request.post("/api/v1/accounts", {
    headers,
    data: {
      name: "Interval cash",
      accountType: "SECURITIES",
      trackingMode: "TRANSACTIONS",
      currency: "USD",
      isDefault: false,
      isActive: true,
    },
  });
  expect(account.ok(), await account.text()).toBeTruthy();
  const { id } = await account.json();
  const activityDate = new Date();
  activityDate.setUTCDate(activityDate.getUTCDate() - 730);
  const deposit = await context.request.post("/api/v1/activities", {
    headers,
    data: {
      accountId: id,
      activityType: "DEPOSIT",
      activityDate: activityDate.toISOString(),
      currency: "USD",
      amount: "1000",
    },
  });
  expect(deposit.ok(), await deposit.text()).toBeTruthy();
  // Seed only the disposable installation. This isolates interval rendering from
  // external market-data jobs; requests and chart data still use the real server.
  const info = await context.request.get("/api/v1/app/info", { headers });
  expect(info.ok()).toBeTruthy();
  const { dbPath } = await info.json();
  expect(dbPath).toMatch(/wealthfolio-profile-e2e-[^/]+\/profiles\/[^/]+\/app\.db$/);
  const db = new DatabaseSync(dbPath);
  const insert = db.prepare(`INSERT INTO daily_account_valuation
    (id, account_id, valuation_date, account_currency, base_currency, fx_rate_to_base,
     cash_balance, investment_market_value, total_value, cost_basis, net_contribution,
     cash_balance_base, total_value_base, net_contribution_base)
    VALUES (?, ?, ?, 'USD', 'USD', '1', '1000', '0', '1000', '0', '1000', '1000', '1000', '1000')`);
  try {
    db.exec("BEGIN");
    for (let offset = 730; offset >= 0; offset--) {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() - offset);
      const day = date.toISOString().slice(0, 10);
      insert.run(`${id}_${day}`, id, day);
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  await expect
    .poll(
      async () => {
        const response = await context.request.post("/api/v1/valuations/history/query", {
          headers,
          data: { filter: { type: "all" } },
        });
        return response.ok() ? (await response.json()).length : 0;
      },
      { timeout: 30000 },
    )
    .toBeGreaterThan(1);
}

async function switchProfile(page: Page, current: string, next: string) {
  await page.getByRole("button", { name: `Profile menu for ${current}` }).click();
  await page.getByRole("menuitem", { name: "Switch profile", exact: true }).click();
  await page.getByRole("button", { name: next, exact: true }).click();
  await expect(page.getByRole("button", { name: `Profile menu for ${next}` })).toBeVisible();
}

for (const tab of ["investments", "net-worth"]) {
  test(`${tab} interval and history query agree after reload and A/B/A switching`, async ({
    page,
    context,
  }) => {
    test.setTimeout(120000);
    const a = await createProfile(context, `${tab} A`);
    await seedHistory(context, a.scope);
    const b = await createProfile(context, `${tab} B`);
    await seedHistory(context, b.scope);
    await command(context, "unlock_profile", { profileId: a.id });
    const requests: { startDate?: string; endDate?: string }[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (tab === "investments" && url.pathname === "/api/v1/valuations/history/query")
        requests.push(request.postDataJSON());
      if (tab === "net-worth" && url.pathname === "/api/v1/net-worth/history")
        requests.push(Object.fromEntries(url.searchParams));
    });
    const go = async () => {
      requests.length = 0;
      await page.goto(`/dashboard?tab=${tab}`);
    };
    const verify = async (period: string, days: number) => {
      await expect(page.getByRole("button", { name: period, exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect
        .poll(() =>
          requests.some((range) => {
            if (!range.startDate || !range.endDate) return false;
            const difference = (Date.parse(range.endDate) - Date.parse(range.startDate)) / 86400000;
            return Math.abs(difference - days) <= 2;
          }),
        )
        .toBe(true);
    };
    await go();
    requests.length = 0;
    await page.getByRole("button", { name: "1Y", exact: true }).click();
    await verify("1Y", 365);
    requests.length = 0;
    await page.reload();
    await verify("1Y", 365);
    await switchProfile(page, a.name, b.name);
    await go();
    await expect(
      page.getByRole("button", { name: tab === "investments" ? "3M" : "ALL", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    requests.length = 0;
    await page.getByRole("button", { name: "1M", exact: true }).click();
    await verify("1M", 30);
    await switchProfile(page, b.name, a.name);
    await go();
    await verify("1Y", 365);
    await switchProfile(page, a.name, b.name);
    await go();
    await verify("1M", 30);
    await page.screenshot({ path: `/tmp/wealthfolio-${tab}-interval-fixed.png` });
  });
}
