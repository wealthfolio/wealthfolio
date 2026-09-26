import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { prepareE2eEnvContent } from "./prep-e2e.mjs";

test("isolates the database, profile registry, vault, and addons between runs", () => {
  const original = [
    "WF_DATA_DIR=./old-data",
    "WF_DB_PATH=./db/old.db",
    "WF_SECRET_FILE=./db/vault.bin",
    "WF_ADDONS_DIR=./addons",
    "WF_LISTEN_ADDR=127.0.0.1:8088",
    "WF_AUTH_REQUIRED=true",
    "WF_AUTH_PASSWORD_HASH=old-test-hash",
  ].join("\n");
  const first = prepareE2eEnvContent(original, "/tmp/e2e-first");
  const second = prepareE2eEnvContent(first, "/tmp/e2e-second");
  const values = Object.fromEntries(
    second
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
  assert.equal(values.WF_DB_PATH, join("/tmp/e2e-second", "app.db"));
  assert.equal(values.WF_DATA_DIR, "/tmp/e2e-second");
  assert.equal(values.WF_SECRET_FILE, join("/tmp/e2e-second", "vault.bin"));
  assert.equal(values.WF_ADDONS_DIR, join("/tmp/e2e-second", "addons"));
  assert.equal(values.WF_LISTEN_ADDR, "127.0.0.1:8088");
  assert.equal(values.WF_AUTH_REQUIRED, "false");
  assert.equal(values.WF_AUTH_PASSWORD_HASH, "");
  assert.ok(!second.includes("e2e-first"));
  assert.equal(second.match(/^WF_DB_PATH=/gm).length, 1);
  assert.equal(second.match(/^WF_DATA_DIR=/gm).length, 1);
});
