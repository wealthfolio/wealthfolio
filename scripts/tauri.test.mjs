import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { withAndroidEnvironment, withDevelopmentConfig } from "./tauri.mjs";

const config = resolve("apps/tauri/tauri.dev.conf.json");

test("Android builds select NDK LLVM ranlib without shell RANLIB exports", (t) => {
  const ndk = mkdtempSync(resolve(tmpdir(), "wealthfolio-ndk-"));
  t.after(() => rmSync(ndk, { recursive: true, force: true }));
  for (const [platform, host, executable] of [
    ["darwin", "darwin-x86_64", "llvm-ranlib"],
    ["linux", "linux-x86_64", "llvm-ranlib"],
    ["win32", "windows-x86_64", "llvm-ranlib.exe"],
  ]) {
    const bin = resolve(ndk, "toolchains/llvm/prebuilt", host, "bin");
    mkdirSync(bin, { recursive: true });
    const ranlib = resolve(bin, executable);
    writeFileSync(ranlib, "");
    const env = { NDK_HOME: ndk };
    for (const args of [
      ["android", "dev"],
      ["-vv", "android", "build"],
    ]) {
      assert.equal(withAndroidEnvironment(args, env, platform).TARGET_RANLIB, ranlib);
    }
    assert.deepEqual(env, { NDK_HOME: ndk });
    for (const args of [["dev"], ["build"], ["ios", "dev"]]) {
      assert.equal(withAndroidEnvironment(args, env, platform), env);
    }
    for (const override of [{ TARGET_RANLIB: "custom-ranlib" }, { RANLIB: "custom-ranlib" }]) {
      const custom = { ...env, ...override };
      assert.equal(withAndroidEnvironment(["android", "dev"], custom, platform), custom);
    }
    const customTarget = { ...env, RANLIB_aarch64_linux_android: "custom-arm64-ranlib" };
    assert.equal(
      withAndroidEnvironment(["android", "dev"], customTarget, platform)
        .RANLIB_aarch64_linux_android,
      "custom-arm64-ranlib",
    );
  }
  const missingNdk = { NDK_HOME: resolve(ndk, "missing") };
  assert.equal(withAndroidEnvironment(["android", "dev"], missingNdk), missingNdk);
  assert.deepEqual(withAndroidEnvironment(["android", "dev"], {}), {});
});

test("development identity is applied after custom configs, including release-mode dev", () => {
  for (const args of [
    ["dev"],
    ["-v", "dev"],
    ["--verbose", "dev"],
    ["-vv", "--verbose", "dev"],
    ["dev", "--release"],
    ["dev", "--config", '{"identifier":"com.teymz.wealthfolio"}'],
    ["dev", "--config=custom.json"],
    ["dev", "-c", "custom.json", "--config", "another.json"],
  ]) {
    assert.deepEqual(withDevelopmentConfig(args), [...args, "--config", config]);
  }
});

test("development config is not forwarded to Cargo or the application", () => {
  assert.deepEqual(withDevelopmentConfig(["dev", "--", "--", "--config", "app.json"]), [
    "dev",
    "--config",
    config,
    "--",
    "--",
    "--config",
    "app.json",
  ]);
});

test("builds and mobile commands retain their explicitly selected identity", () => {
  for (const args of [
    ["build"],
    ["build", "--debug"],
    ["build", "--debug", "--config", config],
    ["ios", "dev"],
    ["android", "dev"],
    ["--help"],
  ]) {
    assert.deepEqual(withDevelopmentConfig(args), args);
  }
});
