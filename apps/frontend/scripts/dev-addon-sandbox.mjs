import { spawn } from "node:child_process";
import { once } from "node:events";

const forwardedViteArgs = process.argv.slice(2);
const children = new Set();
let stopping = false;

function spawnPnpm(args) {
  const child = spawn("pnpm", args, { stdio: "inherit", shell: true });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

async function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    child.kill("SIGTERM");
  }
  await Promise.all(Array.from(children, (child) => once(child, "exit").catch(() => undefined)));
  process.exitCode = code;
}

process.once("SIGINT", () => void stop(130));
process.once("SIGTERM", () => void stop(143));

const initialBuild = spawnPnpm([
  "exec",
  "vite",
  "build",
  "--config",
  "vite.addon-sandbox.config.ts",
]);
const [initialCode] = await once(initialBuild, "exit");
if (initialCode !== 0) {
  process.exitCode = typeof initialCode === "number" ? initialCode : 1;
} else {
  const runtimeWatcher = spawnPnpm([
    "exec",
    "vite",
    "build",
    "--config",
    "vite.addon-sandbox.config.ts",
    "--watch",
  ]);
  const vite = spawnPnpm(["exec", "vite", ...forwardedViteArgs]);

  runtimeWatcher.once("exit", (code) => void stop(typeof code === "number" ? code : 1));
  vite.once("exit", (code) => void stop(typeof code === "number" ? code : 1));
}
