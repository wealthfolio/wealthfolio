import { spawn } from "node:child_process";
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

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const require = createRequire(import.meta.url);
  const child = spawn(
    process.execPath,
    [require.resolve("@tauri-apps/cli/tauri.js"), ...withDevelopmentConfig(process.argv.slice(2))],
    { env: process.env, stdio: "inherit" },
  );

  child.on("error", (error) => {
    console.error(`Failed to start Tauri CLI: ${error.message}`);
    process.exitCode = 1;
  });

  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}
