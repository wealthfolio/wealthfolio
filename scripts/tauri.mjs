import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function withDevelopmentConfig(args) {
  const command = args.find((arg) => arg !== "--verbose" && !/^-v+$/.test(arg));
  if (command !== "dev") return args;

  // Apply identity last so unrelated custom configs cannot restore the production
  // data directory. Keep the option before arguments forwarded to Cargo/the app.
  const separator = args.indexOf("--");
  const end = separator === -1 ? args.length : separator;
  return [
    ...args.slice(0, end),
    "--config",
    resolve("apps/tauri/tauri.dev.conf.json"),
    ...args.slice(end),
  ];
}

export function withAndroidEnvironment(args, env = process.env, platform = process.platform) {
  const command = args.find((arg) => arg !== "--verbose" && !/^-v+$/.test(arg));
  if (command !== "android" || !env.NDK_HOME || env.TARGET_RANLIB || env.RANLIB) return env;

  const host = { darwin: "darwin-x86_64", linux: "linux-x86_64", win32: "windows-x86_64" }[
    platform
  ];
  if (!host) return env;

  const ranlib = resolve(
    env.NDK_HOME,
    "toolchains/llvm/prebuilt",
    host,
    "bin",
    platform === "win32" ? "llvm-ranlib.exe" : "llvm-ranlib",
  );
  if (!existsSync(ranlib)) return env;

  // OpenSSL otherwise selects the GNU-prefixed ranlib removed from modern NDKs.
  // TARGET_ leaves host builds alone; explicit per-target overrides take priority.
  return { ...env, TARGET_RANLIB: ranlib };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const require = createRequire(import.meta.url);
  const args = process.argv.slice(2);
  const child = spawn(
    process.execPath,
    [require.resolve("@tauri-apps/cli/tauri.js"), ...withDevelopmentConfig(args)],
    { env: withAndroidEnvironment(args), stdio: "inherit" },
  );

  child.on("error", (error) => {
    console.error(`Failed to start Tauri CLI: ${error.message}`);
    process.exitCode = 1;
  });

  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}
