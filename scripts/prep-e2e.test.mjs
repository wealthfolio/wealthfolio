import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hasSecretKey, prepE2eEnv, prepareE2eEnvContent } from "./prep-e2e.mjs";

const EXAMPLE_PATH = new URL("../.env.web.example", import.meta.url);

const withRepoCopy = async (callback) => {
  const root = await mkdtemp(join(tmpdir(), "wf-prep-e2e-"));
  try {
    await copyFile(EXAMPLE_PATH, join(root, ".env.web.example"));
    await callback(root, join(root, ".env.web"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const readValues = async (envPath) =>
  Object.fromEntries(
    (await readFile(envPath, "utf8"))
      .split("\n")
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );

test("isolates the database, profile registry, vault, and addons between runs", () => {
  const original = [
    "WF_DATA_DIR=./old-data",
    "WF_DB_PATH=./db/old.db",
    "WF_SECRET_FILE=./db/vault.bin",
    "WF_ADDONS_DIR=./addons",
    "WF_LISTEN_ADDR=127.0.0.1:8088",
    "WF_AUTH_REQUIRED=true",
    "WF_AUTH_PASSWORD_HASH=old-test-hash",
    "WF_MCP_ENABLED=false",
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
  assert.equal(values.WF_MCP_ENABLED, "true");
  assert.ok(!second.includes("e2e-first"));
  assert.equal(second.match(/^WF_DB_PATH=/gm).length, 1);
  assert.equal(second.match(/^WF_DATA_DIR=/gm).length, 1);
});

test("a fresh checkout gets .env.web from the example and a throwaway secret key", async () => {
  await withRepoCopy(async (root, envPath) => {
    // An empty shell value would hide the one in .env.web from dev:web.
    const env = { WF_SECRET_KEY_FILE: "" };
    await prepE2eEnv({ envPath, env });

    const values = await readValues(envPath);
    assert.equal(values.WF_SECRET_KEY, "");
    assert.equal(values.WF_LISTEN_ADDR, "127.0.0.1:8088");
    const keyFile = values.WF_SECRET_KEY_FILE;
    assert.equal(keyFile, join(values.WF_DATA_DIR, "secret.key"));
    assert.equal(env.WF_SECRET_KEY_FILE, keyFile);
    assert.ok(keyFile.startsWith(join(root, "db")));
    assert.equal(Buffer.from((await readFile(keyFile, "utf8")).trim(), "base64").length, 32);
    if (process.platform !== "win32") {
      assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
    }

    // A second run keeps no state from the first, but still has a key of its own.
    await prepE2eEnv({ envPath, env: {} });
    const next = await readValues(envPath);
    assert.notEqual(next.WF_SECRET_KEY_FILE, keyFile);
    assert.equal(next.WF_SECRET_KEY_FILE, join(next.WF_DATA_DIR, "secret.key"));
  });
});

test("a configured secret key is left alone", async () => {
  await withRepoCopy(async (_root, envPath) => {
    await writeFile(envPath, "WF_SECRET_KEY='my-key'\nWF_SECRET_KEY_FILE=\n");
    await prepE2eEnv({ envPath, env: {} });
    const values = await readValues(envPath);
    assert.equal(values.WF_SECRET_KEY, "'my-key'");
    assert.equal(values.WF_SECRET_KEY_FILE, "");
    assert.ok(values.WF_DATA_DIR, "the existing .env.web is updated, not replaced");
    assert.deepEqual(await readdir(values.WF_DATA_DIR), []);

    // dev:web trims names and values, so this is a configured key too.
    await writeFile(envPath, "  WF_SECRET_KEY = 'my-key'\n");
    await prepE2eEnv({ envPath, env: {} });
    assert.ok(!(await readFile(envPath, "utf8")).includes("WF_SECRET_KEY_FILE"));

    await writeFile(envPath, "WF_LISTEN_ADDR=127.0.0.1:9000\n");
    await prepE2eEnv({ envPath, env: { WF_SECRET_KEY_FILE: "/run/secrets/wf" } });
    const shell = await readValues(envPath);
    assert.equal(shell.WF_SECRET_KEY_FILE, undefined);
    assert.equal(shell.WF_LISTEN_ADDR, "127.0.0.1:9000");
  });
});

test("only non-empty keys count, and the shell wins over .env.web", () => {
  assert.equal(hasSecretKey("WF_SECRET_KEY=\nWF_SECRET_KEY_FILE=", {}), false);
  assert.equal(hasSecretKey('WF_SECRET_KEY=""', {}), false);
  assert.equal(hasSecretKey("WF_SECRET_KEY_FILE=/key", {}), true);
  assert.equal(hasSecretKey("WF_SECRET_KEY=abc", { WF_SECRET_KEY: "" }), false);
  assert.equal(hasSecretKey("", { WF_SECRET_KEY: "abc" }), true);
});

test("the key file setting dev:web reads is the one updated", async () => {
  await withRepoCopy(async (_root, envPath) => {
    await writeFile(envPath, "WF_SECRET_KEY_FILE = \nWF_SECRET_KEY=\n");
    await prepE2eEnv({ envPath, env: {} });
    const content = await readFile(envPath, "utf8");
    assert.equal(content.match(/WF_SECRET_KEY_FILE/g).length, 1);
    assert.match(content, /^WF_SECRET_KEY_FILE=.+secret\.key$/m);
  });
});

test("an existing .env.web doesn't need the example", async () => {
  await withRepoCopy(async (root, envPath) => {
    await rm(join(root, ".env.web.example"));
    await writeFile(envPath, "WF_SECRET_KEY=my-key\n");
    await prepE2eEnv({ envPath, env: {} });
    assert.equal((await readValues(envPath)).WF_SECRET_KEY, "my-key");
  });
});

test("a byte-order mark doesn't hide a configured key", async () => {
  await withRepoCopy(async (_root, envPath) => {
    await writeFile(envPath, "\uFEFFWF_SECRET_KEY='my-key'\r\nWF_SECRET_KEY_FILE=\r\n");
    await prepE2eEnv({ envPath, env: {} });
    assert.match(await readFile(envPath, "utf8"), /^WF_SECRET_KEY_FILE=\r?$/m);
  });
});

test("a generated key keeps the root .env key out", async () => {
  await withRepoCopy(async (_root, envPath) => {
    await writeFile(envPath, "WF_LISTEN_ADDR=127.0.0.1:8088\n");
    const env = {};
    await prepE2eEnv({ envPath, env });
    assert.equal((await readValues(envPath)).WF_SECRET_KEY, "");
    assert.equal(env.WF_SECRET_KEY, "");
    assert.ok(env.WF_SECRET_KEY_FILE);
  });
});
