#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, basename } from "node:path";

function loadDotenvFile(file) {
  const p = resolve(process.cwd(), file);
  if (!existsSync(p)) return;
  const content = readFileSync(p, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

// Load .env.web if present
loadDotenvFile(".env.web");
// Mask the desktop .env value when Rust loads dotenv; shell/.env.web values win.
process.env.WF_DATA_DIR ??= "";

// Set build target for web mode
process.env.BUILD_TARGET = "web";

const fileLog = process.argv.includes("--file-log");
let logStream = null;

if (fileLog) {
  const dbUrl = process.env.WF_DB_PATH || process.env.DATABASE_URL || "app.db";
  const dbName = basename(dbUrl, ".db");
  mkdirSync("logs", { recursive: true });
  logStream = createWriteStream(`logs/${dbName}.log`);
}

const children = new Map();
let exiting = false;

function spawnNamed(name, cmd, args, opts = {}) {
  const stdio = logStream ? ["inherit", "pipe", "pipe"] : "inherit";
  const child = spawn(cmd, args, { stdio, shell: false, ...opts });

  if (logStream) {
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      logStream.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      logStream.write(chunk);
    });
  }

  children.set(name, child);
  child.on("exit", (code, signal) => {
    if (exiting) return;
    exiting = true;
    // Terminate others
    for (const [n, c] of children.entries()) {
      if (c.pid && n !== name) {
        try {
          process.kill(c.pid, "SIGTERM");
        } catch (e) {
          // ignore process kill errors during shutdown
          void e;
        }
      }
    }
    // Give them a moment to exit, then force kill
    setTimeout(() => {
      for (const [n, c] of children.entries()) {
        if (c.pid && n !== name) {
          try {
            process.kill(c.pid, "SIGKILL");
          } catch (e) {
            // ignore force kill errors
            void e;
          }
        }
      }
      process.exit(code === null ? (signal ? 128 : 1) : code);
    }, 500);
  });
  return child;
}

function shutdownAndExit(code = 0) {
  if (exiting) return;
  exiting = true;
  for (const [, c] of children.entries()) {
    if (c.pid) {
      try {
        process.kill(c.pid, "SIGTERM");
      } catch (e) {
        // ignore process kill errors during shutdown
        void e;
      }
    }
  }
  setTimeout(() => {
    for (const [, c] of children.entries()) {
      if (c.pid) {
        try {
          process.kill(c.pid, "SIGKILL");
        } catch (e) {
          // ignore force kill errors
          void e;
        }
      }
    }
    process.exit(code);
  }, 500);
}

process.on("SIGINT", () => shutdownAndExit(130));
process.on("SIGTERM", () => shutdownAndExit(143));

// Start backend and Vite
process.env.WF_ENABLE_VITE_PROXY = "true";
spawnNamed("server", "cargo", ["run", "--manifest-path", "apps/server/Cargo.toml"]);
spawnNamed("vite", "pnpm", ["--filter", "frontend", "dev"]);
