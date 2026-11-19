import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { readdirSync, readFileSync } from "node:fs";

// Lines of "pid ppid" from Linux's procfs, for when `ps` is missing or fails.
const procTable = () =>
  readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .map((pid) => {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        // The command name in parentheses can hold spaces; the parent PID is the
        // second field after it.
        return `${pid} ${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]}`;
      } catch {
        return ""; // It exited, or its stat file is unreadable.
      }
    })
    .join("\n");

const descendantsOf = (pid) => {
  let table;
  try {
    table = execFileSync("ps", ["-A", "-o", "pid=", "-o", "ppid="], { encoding: "utf8" });
  } catch {
    try {
      table = procTable();
    } catch {
      // Without `ps` or procfs, stop only the direct child, as before.
      return [];
    }
  }
  const childrenOf = new Map();
  for (const line of table.split("\n")) {
    if (!line.trim()) continue;
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), child]);
  }
  const descendants = [];
  const queue = [pid];
  while (queue.length > 0) {
    for (const child of childrenOf.get(queue.shift()) ?? []) {
      descendants.push(child);
      queue.push(child);
    }
  }
  return descendants;
};

// Signals the server and, on Linux and macOS, every process under it.
// Signalling only the direct child can leave the runner waiting forever: a pnpm
// that hands off to the `packageManager` version waits for it synchronously and
// doesn't pass the signal on (pnpm/pnpm#9948).
export const stopServer = async (server, signal) => {
  if (server.exitCode !== null || server.signalCode !== null) {
    return;
  }
  const exited = once(server, "exit");
  const descendants = process.platform === "win32" ? [] : descendantsOf(server.pid);
  server.kill(signal);
  for (const pid of descendants) {
    try {
      process.kill(pid, signal);
    } catch {
      // It exited after `ps` listed it.
    }
  }
  await exited;
};
