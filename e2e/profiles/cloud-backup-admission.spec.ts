import { expect, test } from "@playwright/test";

test("backup capture requires an unlocked profile and never uploads without local opt-in", async ({
  context,
}) => {
  const create = await context.request.post("/api/v1/profiles/create_profile", {
    data: { name: "Backup admission", avatarId: "clay-bot-animated" },
  });
  expect(create.ok()).toBeTruthy();
  const profile = await create.json();
  const unlock = await context.request.post("/api/v1/profiles/unlock_profile", {
    data: { profileId: profile.id },
  });
  expect(unlock.ok()).toBeTruthy();
  const session = await unlock.json();
  const headers = { "x-wf-profile-scope": session.scopeId };
  const capture = await context.request.post("/api/v1/cloud-backups/capture", { headers });
  expect(capture.status()).toBe(200);
  expect(await capture.json()).toBeNull();
  for (const secretKey of [
    "cloud_backup_local_consent_v1",
    "cloud_backup_master_v1:owner",
    "cloud_backup_pending_master_v1:owner",
    "cloud_backup_source_v1:owner",
  ]) {
    const result = await context.request.post("/api/v1/secrets", {
      headers,
      data: { secretKey, secret: "synthetic" },
    });
    expect(result.status()).toBe(400);
  }
  const lock = await context.request.post("/api/v1/profiles/lock_profile", { headers, data: {} });
  expect(lock.ok()).toBeTruthy();
  const denied = await context.request.post("/api/v1/cloud-backups/capture", { headers });
  expect([401, 403, 423]).toContain(denied.status());
});
